import { verifyHmac } from '../../../shared/tracking';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
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
      ctx.waitUntil(logEvent(env, 'open', campaignId, sub, req, null));
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
      const target = url.searchParams.get('u');
      const sig = url.searchParams.get('sig');
      if (!target || !sig) return new Response('bad request', { status: 400 });
      const ok = await verifyHmac(env.LINK_SIGNING_KEY, `c|${campaignId}|${sub}|${target}`, sig);
      if (!ok) return new Response('forbidden', { status: 403 });
      ctx.waitUntil(logEvent(env, 'click', campaignId, sub, req, decodeURIComponent(target)));
      return Response.redirect(decodeURIComponent(target), 302);
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
      ctx.waitUntil(logEvent(env, 'download', campaignId, sub, req, row.filename, attId));
      return new Response(obj.body, {
        headers: {
          'Content-Type': row.content_type,
          'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
        },
      });
    }

    // /u/:sub  GET (page) or POST (one-click)
    if (parts[0] === 'u' && parts.length === 2) {
      const sub = Number(parts[1]!);
      const token = url.searchParams.get('t');
      if (req.method === 'GET') {
        if (!token) return new Response('bad request', { status: 400 });
        const ok = await checkUnsubToken(env, sub, token);
        if (!ok) return new Response('forbidden', { status: 403 });
        return new Response(unsubPage(sub, token), { headers: { 'Content-Type': 'text/html' } });
      }
      if (req.method === 'POST') {
        const form = await req.formData().catch(() => null);
        const t = token ?? (form ? String(form.get('t') ?? '') : '');
        const ok = await checkUnsubToken(env, sub, t);
        if (!ok) return new Response('forbidden', { status: 403 });
        await env.DB
          .prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id = ?")
          .bind(sub)
          .run();
        ctx.waitUntil(logEvent(env, 'unsubscribe', null, sub, req, null));
        return new Response('Unsubscribed.', { status: 200 });
      }
    }

    return new Response('not found', { status: 404 });
  },
};

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

function unsubPage(sub: number, token: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Unsubscribe</title>
<form method="post"><input type="hidden" name="t" value="${escapeAttr(token)}">
<p>Click to unsubscribe subscriber #${sub}.</p>
<button type="submit">Unsubscribe</button></form>`;
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
