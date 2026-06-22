import { EmailMessage } from 'cloudflare:email';
import { verifyHmac } from '../../../shared/tracking';
import { buildEmail } from '../../../shared/mime';
import { loadSettings, resolveTrackingBaseUrl } from '../../../shared/settings';
import { writeLog } from '../../../shared/db';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
  // Public signup: SEND_EMAIL delivers the double opt-in confirmation;
  // TURNSTILE_SECRET_KEY validates the widget token. Both optional — without
  // them the public subscribe page reports itself unavailable.
  SEND_EMAIL?: { send(message: EmailMessage): Promise<void> };
  TURNSTILE_SECRET_KEY?: string;
  // Resolved from the D1 `settings` table at runtime (see loadSettings).
  FROM_ADDRESS?: string;
  BASE_DOMAIN?: string;
  TRACKING_BASE_URL?: string;
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
}

const TRANSPARENT_GIF = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
  0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00,
  0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02,
  0x44, 0x01, 0x00, 0x3b,
]);

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // GET /o/:campaign/:sub.gif
    if (req.method === 'GET' && parts[0] === 'o' && parts.length === 3) {
      const campaignId = parts[1]!;
      const sub = Number(parts[2]!.replace(/\.gif$/, ''));
      ctx.waitUntil(logEvent(env, 'open', campaignId, sub, req, null).catch(console.error));
      return new Response(TRANSPARENT_GIF, {
        headers: {
          'Content-Type': 'image/gif',
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    // GET /c/:campaign/:sub?u=<url>&sig=...
    if (req.method === 'GET' && parts[0] === 'c' && parts.length === 3) {
      const campaignId = parts[1]!;
      const sub = Number(parts[2]!);
      // The signature is computed over the *encoded* `u` value (see
      // signClickUrl), so verify against the raw query param rather than the
      // value decoded by URLSearchParams, then decode exactly once for use.
      const rawU = rawParam(url.search, 'u');
      const sig = url.searchParams.get('sig');
      if (!rawU || !sig) return new Response('bad request', { status: 400 });
      const ok = await verifyHmac(env.LINK_SIGNING_KEY, `c|${campaignId}|${sub}|${rawU}`, sig);
      if (!ok) return new Response('forbidden', { status: 403 });
      const target = decodeURIComponent(rawU);
      ctx.waitUntil(logEvent(env, 'click', campaignId, sub, req, target).catch(console.error));
      return Response.redirect(target, 302);
    }

    // GET /a/:campaign/:sub/:attId?sig=...
    if (req.method === 'GET' && parts[0] === 'a' && parts.length === 4) {
      const campaignId = parts[1]!;
      const sub = Number(parts[2]!);
      const attId = Number(parts[3]!);
      const sig = url.searchParams.get('sig');
      if (!sig) return new Response('bad request', { status: 400 });
      const ok = await verifyHmac(env.ATTACHMENT_SIGNING_KEY, `a|${campaignId}|${sub}|${attId}`, sig);
      if (!ok) return new Response('forbidden', { status: 403 });

      const row = await env.DB
        .prepare('SELECT r2_key, filename, content_type FROM attachments WHERE id = ? AND campaign_id = ?')
        .bind(attId, campaignId)
        .first<{ r2_key: string; filename: string; content_type: string }>();
      if (!row) return new Response('not found', { status: 404 });
      const obj = await env.ARCHIVE.get(row.r2_key);
      if (!obj) return new Response('not found', { status: 404 });
      ctx.waitUntil(logEvent(env, 'download', campaignId, sub, req, row.filename, attId).catch(console.error));
      return new Response(obj.body, {
        headers: {
          'Content-Type': row.content_type,
          'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
        },
      });
    }

    // /u/:sub  GET (page) or POST (browser form or RFC 8058 one-click)
    if (parts[0] === 'u' && parts.length === 2) {
      const sub = Number(parts[1]!);
      const token = url.searchParams.get('t');
      if (req.method === 'GET') {
        if (!token) return htmlResponse(pageShell('Invalid link', '<p>This unsubscribe link is invalid.</p>'), 400);
        const ok = await checkUnsubToken(env, sub, token);
        if (!ok) return htmlResponse(pageShell('Invalid link', '<p>This unsubscribe link is invalid or has expired.</p>'), 403);
        const cfg = await loadSettings(env.DB, env);
        const siteKey = (cfg.TURNSTILE_ENABLED ?? 'true') !== 'false' ? (cfg.TURNSTILE_SITE_KEY ?? '') : '';
        const nlRow = await env.DB
          .prepare('SELECT n.name, s.email FROM subscribers s JOIN newsletters n ON n.id = s.newsletter_id WHERE s.id = ?')
          .bind(sub)
          .first<{ name: string; email: string }>();
        const campaignId = url.searchParams.get('c') || null;
        return htmlResponse(unsubPage(sub, token, nlRow?.name ?? 'this newsletter', nlRow?.email ?? '', siteKey, null, campaignId));
      }
      if (req.method === 'POST') {
        const form = await req.formData().catch(() => null);
        const t = token ?? (form ? String(form.get('t') ?? '') : '');
        const ok = await checkUnsubToken(env, sub, t);
        if (!ok) return new Response('forbidden', { status: 403 });
        // RFC 8058 one-click: mail client posts List-Unsubscribe=One-Click — skip Turnstile.
        const isOneClick = form ? String(form.get('List-Unsubscribe') ?? '') === 'One-Click' : false;
        // Campaign ID: prefer form body (browser submit), fall back to query string (one-click).
        const unsubCampaignId = (form ? String(form.get('c') ?? '') : '') || url.searchParams.get('c') || null;
        if (!isOneClick) {
          const cfg = await loadSettings(env.DB, env);
          const turnstileEnabled = (cfg.TURNSTILE_ENABLED ?? 'true') !== 'false';
          const siteKey = cfg.TURNSTILE_SITE_KEY ?? '';
          if (turnstileEnabled && siteKey && env.TURNSTILE_SECRET_KEY) {
            const tsToken = form ? String(form.get('cf-turnstile-response') ?? '') : '';
            const human = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, tsToken, req.headers.get('cf-connecting-ip'));
            if (!human) {
              const nlRow = await env.DB
                .prepare('SELECT n.name, s.email FROM subscribers s JOIN newsletters n ON n.id = s.newsletter_id WHERE s.id = ?')
                .bind(sub)
                .first<{ name: string; email: string }>();
              return htmlResponse(unsubPage(sub, t, nlRow?.name ?? 'this newsletter', nlRow?.email ?? '', siteKey, 'Verification failed. Please try again.', unsubCampaignId), 400);
            }
          }
        }
        const nlRow = await env.DB
          .prepare('SELECT n.id AS newsletter_id, n.name, s.email FROM subscribers s JOIN newsletters n ON n.id = s.newsletter_id WHERE s.id = ?')
          .bind(sub)
          .first<{ newsletter_id: string; name: string; email: string }>();
        await env.DB
          .prepare("UPDATE subscribers SET status='unsubscribed', verified=0, unsubscribed_at=datetime('now') WHERE id = ?")
          .bind(sub)
          .run();
        ctx.waitUntil(logEvent(env, 'unsubscribe', unsubCampaignId, sub, req, null, null, nlRow?.newsletter_id ?? null).catch(console.error));
        if (isOneClick) return new Response('', { status: 200 });
        return htmlResponse(unsubSuccessPage(nlRow?.name ?? 'this newsletter', nlRow?.email ?? ''));
      }
    }

    // GET /subscribe/:slug (form)  POST /subscribe/:slug (double opt-in)
    if (parts[0] === 'subscribe' && parts.length === 2) {
      return handleSubscribe(req, env, ctx, decodeURIComponent(parts[1]!));
    }

    // GET /verify/:sub?t=<confirm_token>  (double opt-in confirmation)
    if (req.method === 'GET' && parts[0] === 'verify' && parts.length === 2) {
      return handleVerify(env, Number(parts[1]!), url.searchParams.get('t') ?? '');
    }

    return new Response('not found', { status: 404 });
  },
};

// ---- public double opt-in signup ----

interface NewsletterRow {
  id: string;
  name: string;
  from_address: string | null;
  allow_public_signup: number;
  enabled: number;
}

// Looks up a newsletter eligible for public signup (exists, enabled and
// allow_public_signup=1). Returns null when not eligible so callers render a
// generic 404 without leaking which slugs exist.
async function findSignupNewsletter(env: Env, slug: string): Promise<NewsletterRow | null> {
  if (!slug) return null;
  const row = await env.DB
    .prepare(
      'SELECT id, name, from_address, allow_public_signup, enabled FROM newsletters WHERE slug = ?',
    )
    .bind(slug)
    .first<NewsletterRow>();
  if (!row || row.allow_public_signup !== 1 || row.enabled !== 1) return null;
  return row;
}

async function handleSubscribe(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  slug: string,
): Promise<Response> {
  const cfg = await loadSettings(env.DB, env);
  cfg.TRACKING_BASE_URL = resolveTrackingBaseUrl(cfg.TRACKING_BASE_URL ?? '', cfg.BASE_DOMAIN ?? '');
  const siteKey = cfg.TURNSTILE_SITE_KEY ?? '';
  const turnstileEnabled = (cfg.TURNSTILE_ENABLED ?? 'true') !== 'false';
  const nl = await findSignupNewsletter(env, slug);
  if (!nl) return htmlResponse(pageShell('Not found', '<p>This subscription page is not available.</p>'), 404);

  // Signup requires SEND_EMAIL. When Turnstile is enabled it additionally
  // requires a configured site key and secret.
  if (!env.SEND_EMAIL || (turnstileEnabled && (!siteKey || !env.TURNSTILE_SECRET_KEY))) {
    return htmlResponse(
      pageShell(
        'Signup unavailable',
        '<p>Public signup is not configured for this newsletter yet. Please check back later.</p>',
      ),
      503,
    );
  }

  const effectiveSiteKey = turnstileEnabled ? siteKey : '';

  if (req.method === 'GET') {
    return htmlResponse(subscribeForm(slug, nl.name, effectiveSiteKey, null));
  }

  if (req.method === 'POST') {
    const form = await req.formData().catch(() => null);
    const email = String(form?.get('email') ?? '').trim().toLowerCase();
    const name = String(form?.get('name') ?? '').trim();
    const tsToken = String(form?.get('cf-turnstile-response') ?? '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return htmlResponse(subscribeForm(slug, nl.name, effectiveSiteKey, 'Please enter a valid email address.'), 400);
    }
    if (turnstileEnabled) {
      const human = await verifyTurnstile(env.TURNSTILE_SECRET_KEY!, tsToken, req.headers.get('cf-connecting-ip'));
      if (!human) {
        return htmlResponse(subscribeForm(slug, nl.name, effectiveSiteKey, 'Verification failed. Please try again.'), 400);
      }
    }

    const existing = await env.DB
      .prepare('SELECT id, status, confirm_token FROM subscribers WHERE newsletter_id = ? AND email = ?')
      .bind(nl.id, email)
      .first<{ id: number; status: string; confirm_token: string | null }>();

    // Already active and confirmed: tell the user explicitly.
    if (existing && existing.status === 'active' && existing.confirm_token === null) {
      return htmlResponse(
        pageShell(
          'Already subscribed',
          `<p>You are already subscribed to <strong>${escapeHtml(nl.name)}</strong>.</p>`,
        ),
      );
    }

    // New subscriber or unconfirmed/inactive: upsert and send confirmation.
    const confirmToken = crypto.randomUUID();
    const unsubToken = crypto.randomUUID();
    const res = await env.DB
      .prepare(
        'INSERT INTO subscribers (newsletter_id, email, name, verified, status, token, confirm_token) ' +
          "VALUES (?, ?, ?, 0, 'active', ?, ?) " +
          'ON CONFLICT(newsletter_id, email) DO UPDATE SET ' +
          'confirm_token = excluded.confirm_token, ' +
          'name = COALESCE(NULLIF(excluded.name, ?), subscribers.name), ' +
          "status = CASE WHEN subscribers.status = 'unsubscribed' THEN 'active' ELSE subscribers.status END, " +
          "verified = CASE WHEN subscribers.status = 'unsubscribed' THEN 0 ELSE subscribers.verified END",
      )
      .bind(nl.id, email, name || null, unsubToken, confirmToken, '')
      .run();
    void res;
    const row = await env.DB
      .prepare('SELECT id FROM subscribers WHERE newsletter_id = ? AND email = ?')
      .bind(nl.id, email)
      .first<{ id: number }>();
    ctx.waitUntil(writeLog(env.DB, {
      source: 'tracker',
      event: 'subscriber.signup',
      newsletterId: nl.id,
      message: `Signup pending confirmation for ${email}`,
      detail: { email, name: name || null },
    }));
    if (row) {
      const base = (cfg.TRACKING_BASE_URL ?? '').replace(/\/+$/, '');
      const verifyUrl = `${base}/verify/${row.id}?t=${encodeURIComponent(confirmToken)}`;
      ctx.waitUntil(
        sendConfirmationEmail(env, cfg, nl, email, name, verifyUrl)
          .then(() => writeLog(env.DB, {
            source: 'tracker',
            event: 'subscriber.confirmation_sent',
            newsletterId: nl.id,
            message: `Confirmation email sent to ${email}`,
            detail: { email, subscriberId: row.id },
          }))
          .catch(console.error),
      );
    }

    return htmlResponse(
      pageShell(
        'Almost there',
        `<p>Thanks! We've sent a confirmation link to <strong>${escapeHtml(email)}</strong>.</p>` +
          '<p>Please open that email and click the link to complete your subscription. ' +
          "If you don't see it, check your spam folder.</p>",
      ),
    );
  }

  return new Response('method not allowed', { status: 405 });
}

async function handleVerify(env: Env, sub: number, token: string): Promise<Response> {
  if (!Number.isFinite(sub) || !token) {
    return htmlResponse(pageShell('Invalid link', '<p>This confirmation link is invalid.</p>'), 400);
  }
  const row = await env.DB
    .prepare('SELECT confirm_token FROM subscribers WHERE id = ?')
    .bind(sub)
    .first<{ confirm_token: string | null }>();
  if (!row) {
    return htmlResponse(pageShell('Invalid link', '<p>This confirmation link is invalid.</p>'), 400);
  }
  // Already confirmed (token cleared): treat as success so a re-click is benign.
  if (row.confirm_token === null) {
    return htmlResponse(pageShell('Already confirmed', '<p>Your subscription is already confirmed. Thank you!</p>'));
  }
  if (row.confirm_token !== token) {
    return htmlResponse(pageShell('Invalid link', '<p>This confirmation link is invalid or has expired.</p>'), 403);
  }
  // Confirm: clear the pending token, mark verified and (re)activate — this also
  // handles resubscribing a previously unsubscribed/bounced address.
  const subRow = await env.DB
    .prepare('SELECT newsletter_id, email FROM subscribers WHERE id = ?')
    .bind(sub)
    .first<{ newsletter_id: string; email: string }>();
  await env.DB
    .prepare(
      "UPDATE subscribers SET verified = 1, status = 'active', confirm_token = NULL, " +
        "unsubscribed_at = NULL, subscribed_at = datetime('now') WHERE id = ?",
    )
    .bind(sub)
    .run();
  if (subRow) {
    await writeLog(env.DB, {
      source: 'tracker',
      event: 'subscriber.verified',
      newsletterId: subRow.newsletter_id,
      message: `Subscription confirmed for ${subRow.email}`,
      detail: { email: subRow.email, subscriberId: sub },
    });
  }
  return htmlResponse(
    pageShell('Subscription confirmed', '<p>You\u2019re all set \u2014 thanks for subscribing!</p>'),
  );
}

// Verifies a Turnstile token against the siteverify endpoint. Returns true only
// on an explicit success; any error or non-200 is treated as failure.
async function verifyTurnstile(secret: string, token: string, ip: string | null): Promise<boolean> {
  if (!token) return false;
  try {
    const body = new FormData();
    body.set('secret', secret);
    body.set('response', token);
    if (ip) body.set('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    const data = (await res.json().catch(() => ({}))) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}

async function sendConfirmationEmail(
  env: Env,
  cfg: Env,
  nl: NewsletterRow,
  email: string,
  name: string,
  verifyUrl: string,
): Promise<void> {
  if (!env.SEND_EMAIL) return;
  const fromHeader = nl.from_address || cfg.FROM_ADDRESS || `newsletter@${cfg.BASE_DOMAIN ?? ''}`;
  const fromAddr = extractAddr(fromHeader);
  const messageId = `${crypto.randomUUID()}@${cfg.BASE_DOMAIN ?? 'localhost'}`;
  const subject = `Confirm your subscription to ${nl.name}`;
  const safeName = escapeHtml(nl.name);
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">` +
    `<h1 style="font-size:18px">Confirm your subscription</h1>` +
    `<p>Please confirm that you want to receive <strong>${safeName}</strong> at this address.</p>` +
    `<p style="margin:24px 0"><a href="${verifyUrl}" style="background:#0f172a;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">Confirm subscription</a></p>` +
    `<p style="font-size:13px;color:#64748b">Or paste this link into your browser:<br><a href="${verifyUrl}" style="color:#2563eb">${verifyUrl}</a></p>` +
    `<p style="font-size:12px;color:#94a3b8">If you didn't request this, you can safely ignore this email \u2014 no subscription is created until you confirm.</p>` +
    `</div>`;
  const text =
    `Confirm your subscription to ${nl.name}\n\n` +
    `Please confirm you want to receive ${nl.name} at this address by opening:\n${verifyUrl}\n\n` +
    `If you didn't request this, ignore this email — no subscription is created until you confirm.`;
  const raw = buildEmail({
    from: fromHeader,
    to: name ? `${quoteName(name)} <${email}>` : email,
    subject,
    messageId,
    text,
    html,
    attachments: [],
    headers: { 'X-Entity-Ref-ID': messageId },
  });
  await env.SEND_EMAIL.send(new EmailMessage(fromAddr, email, raw));
}

function extractAddr(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return m?.[1] ?? header.trim();
}

function quoteName(name: string): string {
  return /[",<>]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Minimal branded page wrapper shared by the status/result pages.
function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>${PAGE_CSS}</head>` +
    `<body><main class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</main></body></html>`;
}

function subscribeForm(slug: string, newsletterName: string, siteKey: string, error: string | null): string {
  const name = escapeHtml(newsletterName);
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const tsScript = siteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';
  const tsWidget = siteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}"></div>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Subscribe to ${name}</title>${PAGE_CSS}${tsScript}</head>` +
    `<body><main class="card"><h1>Subscribe to ${name}</h1>` +
    `<p class="muted">Enter your details and we'll send a confirmation link.</p>${err}` +
    `<form method="post" action="/subscribe/${encodeURIComponent(slug)}">` +
    `<label>Email<input type="email" name="email" required autocomplete="email" placeholder="you@example.com"></label>` +
    `<label>Name <span class="opt">(optional)</span><input type="text" name="name" autocomplete="name"></label>` +
    `${tsWidget}` +
    `<button type="submit">Subscribe</button>` +
    `</form></main></body></html>`;
}

const PAGE_CSS =
  '<style>' +
  ':root{color-scheme:light dark}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f1f5f9;' +
  'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;padding:16px}' +
  '.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:36px;max-width:400px;width:100%;' +
  'box-shadow:0 1px 3px rgba(0,0,0,.06)}' +
  'h1{font-size:22px;margin:0 0 16px}' +
  '.muted{color:#64748b;font-size:14px;margin:0 0 28px}' +
  '.opt{color:#94a3b8;font-weight:400}' +
  'label{display:block;font-size:13px;font-weight:600;margin-bottom:20px}' +
  'input{display:block;width:100%;margin-top:6px;padding:11px 12px;border:1px solid #cbd5e1;border-radius:6px;' +
  'font-size:14px;font-weight:400}' +
  'button{width:100%;margin-top:20px;padding:13px;border:0;border-radius:6px;background:#0f172a;color:#fff;' +
  'font-size:14px;font-weight:600;cursor:pointer}' +
  '.cf-turnstile{margin:8px 0 4px}' +
  'button.danger{background:#dc2626}button.danger:hover{background:#b91c1c}' +
  '.err{color:#dc2626;font-size:13px;margin:0 0 16px}' +
  'a{color:#2563eb}' +
  '@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e2e8f0}' +
  '.card{background:#1e293b;border-color:#334155}.muted{color:#94a3b8}' +
  'input{background:#0f172a;border-color:#334155;color:#e2e8f0}button{background:#e2e8f0;color:#0f172a}}' +
  '</style>';

// Returns the raw (still URL-encoded) value of a query parameter, exactly as it
// appears in the query string. Unlike URLSearchParams.get(), this does not
// percent-decode, which is required to reproduce the signed payload.
function rawParam(search: string, name: string): string {
  const q = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of q.split('&')) {
    if (pair.startsWith(name + '=')) return pair.slice(name.length + 1);
  }
  return '';
}

async function checkUnsubToken(env: Env, sub: number, token: string): Promise<boolean> {
  const row = await env.DB
    .prepare('SELECT token FROM subscribers WHERE id = ?')
    .bind(sub)
    .first<{ token: string }>();
  return !!row && row.token === token;
}

async function logEvent(
  env: Env,
  type: 'open' | 'click' | 'unsubscribe' | 'download',
  campaignId: string | null,
  subscriberId: number,
  req: Request,
  url: string | null,
  attachmentId: number | null = null,
  newsletterId: string | null = null,
): Promise<void> {
  await env.DB
    .prepare(
      'INSERT INTO events (campaign_id, subscriber_id, type, attachment_id, url, ua, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      campaignId,
      subscriberId,
      type,
      attachmentId,
      url,
      req.headers.get('user-agent'),
      req.headers.get('cf-connecting-ip'),
    )
    .run();
}

function unsubSuccessPage(newsletterName: string, email: string): string {
  const name = escapeHtml(newsletterName);
  const safeEmail = escapeHtml(email);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribed</title>${PAGE_CSS}</head>` +
    `<body><main class="card"><h1>Unsubscribed</h1>` +
    `<p class="muted">${safeEmail ? `<strong>${safeEmail}</strong> has been ` : 'You have been '}unsubscribed from <strong>${name}</strong>.</p>` +
    `</main></body></html>`;
}

function unsubPage(sub: number, token: string, newsletterName: string, email: string, siteKey: string, error: string | null, campaignId: string | null = null): string {
  const name = escapeHtml(newsletterName);
  const safeEmail = escapeHtml(email);
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  const tsScript = siteKey
    ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : '';
  const tsWidget = siteKey
    ? `<div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}"></div>`
    : '';
  const cField = campaignId ? `<input type="hidden" name="c" value="${escapeAttr(campaignId)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Unsubscribe from ${name}</title>${PAGE_CSS}${tsScript}</head>` +
    `<body><main class="card"><h1>Unsubscribe</h1>` +
    `<p class="muted">You are about to unsubscribe${safeEmail ? ` <strong>${safeEmail}</strong>` : ''} from <strong>${name}</strong>.</p>` +
    `${err}` +
    `<form method="post" action="/u/${sub}">` +
    `<input type="hidden" name="t" value="${escapeAttr(token)}">${cField}` +
    `${tsWidget}` +
    `<button type="submit" class="danger">Unsubscribe</button>` +
    `</form></main></body></html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
