// Admin Worker
//
// Serves a static SPA from the [assets] binding for the GUI, and exposes a
// JSON API under /api/* for it (and curl/scripts) to call. Anything that is
// not /api/* falls through to the static assets.
//
// Authentication: this worker MUST be deployed behind a Cloudflare Access
// application. Access authenticates the user at the edge and injects the
// `Cf-Access-Authenticated-User-Email` header on every request that reaches
// the worker. We treat the presence of that header as proof of authentication;
// requests without it are rejected with 401. No bearer token, no shared
// secret — Access is the only gate.

import { readWarmupConfig, currentWindow } from '../../../shared/warmup';
import {
  loadSettings,
  readStoredSettings,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  isSettingKey,
} from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // R2 bucket holding GUI media (logos, header images). Served read-only
  // under /media/*. The whole worker sits behind Cloudflare Access, so
  // these objects are only reachable by authenticated operators.
  ASSETS_R2: R2Bucket;
  // Warmup vars — kept in sync with the consumer worker so the admin GUI can
  // show the current daily/weekly caps and how much has been used.
  WARMUP_START_DATE?: string;
  WARMUP_TARGET_WEEKLY?: string;
  WARMUP_SCHEDULE?: string;
  WARMUP_DAILY_CAP_EARLY?: string;
  WARMUP_DAILY_CAP_LATE?: string;
  WARMUP_LATE_START_WEEK?: string;
  // Email Routing automation. When a newsletter is created/renamed/deleted the
  // admin worker keeps a matching Email Routing rule in sync so its
  // `inbound_address` is forwarded to the ingest worker. Best-effort: if these
  // are unset, newsletter CRUD still works and the API returns a warning.
  CF_API_TOKEN?: string; // secret — token with "Email Routing Rules: Edit"
  EMAIL_ROUTING_ZONE_ID?: string; // zone id for the newsletter domain
  INGEST_WORKER_NAME?: string; // worker script the rule forwards to
  BASE_DOMAIN?: string; // newsletter domain, e.g. for inbound-address hints
}

interface SubscriberPatch {
  name?: string | null;
  status?: 'active' | 'unsubscribed' | 'bounced' | 'complained';
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Public API health probe (no auth) so the SPA can detect a misconfigured
    // bearer token vs. a wrong URL.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    // Identity probe: reflects the Cloudflare Access headers the edge injects
    // when the worker is published behind an Access application. No bearer
    // token required — Access already authenticated the request.
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const email = req.headers.get('cf-access-authenticated-user-email');
      const name = req.headers.get('cf-access-authenticated-user-name');
      // Stored UI preference (null when no admin row exists yet — the client
      // then seeds it via PUT /api/preferences with its detected OS theme).
      let theme: string | null = null;
      if (email) {
        const row = await env.DB
          .prepare('SELECT theme FROM admins WHERE email = ?')
          .bind(email.toLowerCase())
          .first<{ theme: string }>();
        theme = row?.theme ?? null;
      }
      return Response.json({
        email: email ?? null,
        name: name ?? null,
        theme,
        protected_by_access: Boolean(email),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      // Cloudflare Access injects this header at the edge after authenticating
      // the user. If it is missing the request did not transit Access, so we
      // refuse to serve API data.
      if (!req.headers.get('cf-access-authenticated-user-email')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return await handleApi(req, env, url);
    }

    // GUI media served from the R2 bucket (logos, header images). Uses /media/
    // rather than /assets/ to avoid colliding with the Vite-built SPA bundle
    // that lives under /assets/.
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      return await serveMedia(req, env, url);
    }

    // SPA static assets (with SPA fallback configured in wrangler.toml).
    return env.ASSETS.fetch(req);
  },
};

// Settings that must be non-negative integers (stored as strings).
const NUMERIC_SETTINGS = new Set<string>([
  'MAX_ATTACHMENT_BYTES',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'MAX_ATTACHMENT_COUNT',
  'ATTACHMENT_LINK_THRESHOLD_BYTES',
  'BATCH_SIZE',
  'MAX_RAW_BYTES',
  'RETENTION_DAYS',
  'HARD_BOUNCE_THRESHOLD',
  'SOFT_BOUNCE_THRESHOLD',
  'WARMUP_TARGET_WEEKLY',
  'WARMUP_DAILY_CAP_EARLY',
  'WARMUP_DAILY_CAP_LATE',
  'WARMUP_LATE_START_WEEK',
]);

// Returns an error message if `val` is invalid for `key`, else null.
function validateSetting(key: string, val: string): string | null {
  if (NUMERIC_SETTINGS.has(key)) {
    return /^\d+$/.test(val.trim()) ? null : 'must be a non-negative integer';
  }
  if (key === 'WARMUP_SCHEDULE') {
    try {
      const arr = JSON.parse(val);
      if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number' && n >= 0)) {
        return 'must be a JSON array of non-negative numbers';
      }
    } catch {
      return 'must be valid JSON (e.g. [500, 1500, 5000])';
    }
    return null;
  }
  if (key === 'WARMUP_START_DATE') {
    return val === '' || /^\d{4}-\d{2}-\d{2}$/.test(val) ? null : 'must be empty or YYYY-MM-DD';
  }
  return null; // free-form string keys
}

// Validates a per-newsletter sender. Accepts either "local@domain" or a
// display-name form 'Name <local@domain>'. The mailbox domain must match the
// configured sending domain (`BASE_DOMAIN`) so SPF/DKIM/DMARC stays aligned.
// Returns the normalized header string, or an error message.
function validateFromAddress(
  raw: string,
  baseDomain: string | undefined,
): { value: string } | { error: string } {
  const input = raw.trim();
  const m = /<([^>]+)>\s*$/.exec(input);
  const addr = (m ? m[1]! : input).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return { error: 'valid from_address required' };
  }
  const domain = addr.slice(addr.indexOf('@') + 1);
  if (baseDomain && domain !== baseDomain.toLowerCase()) {
    return { error: `from_address must be on @${baseDomain}` };
  }
  // Preserve a display name if provided (e.g. 'News <news@domain>').
  if (m) {
    const name = input.slice(0, input.lastIndexOf('<')).trim();
    return { value: name ? `${name} <${addr}>` : addr };
  }
  return { value: addr };
}

async function handleApi(req: Request, rawEnv: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  // Resolve configurable settings against the D1 `settings` table so routing,
  // quota and any other reads use the operator-edited values. `rawEnv` keeps
  // the original env vars (used to show per-key defaults on the Settings page).
  const env = await loadSettings(rawEnv.DB, rawEnv);

  // -------- current user's UI preferences --------

  // Persist the signed-in admin's theme. Creates the admin row on first write
  // (seeded with the supplied theme) and updates it thereafter. The email is
  // taken from the Access header, so a user can only change their own setting.
  if (p === '/api/preferences' && m === 'PUT') {
    const email = (req.headers.get('cf-access-authenticated-user-email') ?? '').toLowerCase();
    if (!email) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const { theme } = await req.json<{ theme?: string }>();
    if (theme !== 'light' && theme !== 'dark') {
      return Response.json({ error: 'theme must be "light" or "dark"' }, { status: 400 });
    }
    await env.DB
      .prepare(
        "INSERT INTO admins (email, theme) VALUES (?, ?) " +
          "ON CONFLICT(email) DO UPDATE SET theme = excluded.theme, updated_at = datetime('now')",
      )
      .bind(email, theme)
      .run();
    return Response.json({ ok: true, theme });
  }

  // -------- global runtime settings --------

  // Returns every configurable key with its effective value and provenance so
  // the Settings page can show what is overridden vs. falling back to the
  // built-in default. Resolution is two-level: D1 `settings` row -> default.
  if (p === '/api/settings' && m === 'GET') {
    const stored = await readStoredSettings(rawEnv.DB);
    const items = SETTING_KEYS.map((key) => {
      const dbVal = stored.get(key) ?? null;
      const def = SETTINGS_DEFAULTS[key];
      return {
        key,
        value: dbVal ?? def,
        stored: dbVal,
        fallback: def,
        source: dbVal != null ? 'db' : 'default',
      };
    });
    return Response.json({ settings: items });
  }

  // Upserts (or, when a value is null, clears) settings. Clearing a key makes
  // it fall back to the built-in default again.
  if (p === '/api/settings' && m === 'PUT') {
    const body = await req.json<{ updates?: Record<string, string | null> }>();
    const updates = body.updates ?? {};
    const errors: Record<string, string> = {};
    const toSet: Array<[string, string]> = [];
    const toDelete: string[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (!isSettingKey(key)) {
        errors[key] = 'unknown setting';
        continue;
      }
      if (val === null) {
        toDelete.push(key);
        continue;
      }
      const err = validateSetting(key, val);
      if (err) {
        errors[key] = err;
        continue;
      }
      toSet.push([key, val]);
    }
    if (Object.keys(errors).length > 0) {
      return Response.json({ error: 'validation failed', errors }, { status: 400 });
    }
    const stmts: D1PreparedStatement[] = [];
    for (const [key, val] of toSet) {
      stmts.push(
        rawEnv.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        ).bind(key, val),
      );
    }
    for (const key of toDelete) {
      stmts.push(rawEnv.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key));
    }
    if (stmts.length > 0) await rawEnv.DB.batch(stmts);
    return Response.json({ ok: true, changed: toSet.length, cleared: toDelete.length });
  }

  // -------- newsletters --------

  if (m === 'GET' && p === '/api/newsletters') {
    const { results } = await env.DB
      .prepare(
        `SELECT n.id, n.name, n.inbound_address, n.from_address, n.enabled, n.created_at, ` +
          `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id) AS subscriber_count, ` +
          `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id AND s.status='active') AS active_count, ` +
          `(SELECT COUNT(*) FROM authors a WHERE a.newsletter_id = n.id) AS author_count ` +
          `FROM newsletters n ORDER BY n.created_at ASC`,
      )
      .all();
    return Response.json({ items: results ?? [] });
  }

  if (m === 'POST' && p === '/api/newsletters') {
    const { name, inbound_address, from_address } = await req.json<{
      name?: string;
      inbound_address?: string;
      from_address?: string;
    }>();
    const nm = (name ?? '').trim();
    const addr = (inbound_address ?? '').trim().toLowerCase();
    if (!nm) return Response.json({ error: 'name required' }, { status: 400 });
    if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return Response.json({ error: 'valid inbound_address required' }, { status: 400 });
    }
    // Names must be unique, case-insensitively.
    const dupe = await env.DB
      .prepare('SELECT 1 FROM newsletters WHERE name = ? COLLATE NOCASE LIMIT 1')
      .bind(nm)
      .first();
    if (dupe) return Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 });
    let from: string | null = null;
    if (typeof from_address === 'string' && from_address.trim() !== '') {
      const r = validateFromAddress(from_address, env.BASE_DOMAIN);
      if ('error' in r) return Response.json({ error: r.error }, { status: 400 });
      from = r.value;
    }
    const id = crypto.randomUUID();
    try {
      await env.DB
        .prepare('INSERT INTO newsletters (id, name, inbound_address, from_address, enabled) VALUES (?, ?, ?, ?, 1)')
        .bind(id, nm, addr, from)
        .run();
    } catch (err) {
      const msg = (err as Error).message;
      if (/UNIQUE/i.test(msg)) {
        return /name/i.test(msg)
          ? Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 })
          : Response.json({ error: 'inbound address already in use' }, { status: 409 });
      }
      throw err;
    }
    const routing_warning = await createRoutingRule(env, addr);
    return Response.json({ id, name: nm, inbound_address: addr, from_address: from, enabled: 1, routing_warning }, { status: 201 });
  }

  const nl = /^\/api\/newsletters\/([^/]+)(\/.*)?$/.exec(p);
  if (nl) {
    const nid = decodeURIComponent(nl[1]!);
    const rest = nl[2] ?? '';

    // ---- newsletter root: detail / update / delete ----
    if (rest === '') {
      if (m === 'GET') {
        const row = await env.DB
          .prepare(
            `SELECT n.id, n.name, n.inbound_address, n.from_address, n.enabled, n.created_at, ` +
              `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id) AS subscriber_count, ` +
              `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id AND s.status='active') AS active_count, ` +
              `(SELECT COUNT(*) FROM authors a WHERE a.newsletter_id = n.id) AS author_count ` +
              `FROM newsletters n WHERE n.id = ?`,
          )
          .bind(nid)
          .first();
        if (!row) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json(row);
      }
      if (m === 'PATCH') {
        const body = await req.json<{
          name?: string;
          enabled?: boolean;
          inbound_address?: string;
          from_address?: string | null;
        }>();
        const sets: string[] = [];
        const binds: unknown[] = [];
        if (typeof body.name === 'string') {
          const nm = body.name.trim();
          if (!nm) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
          // Reject a rename that collides with another newsletter's name
          // (case-insensitive); the newsletter itself is excluded.
          const dupe = await env.DB
            .prepare('SELECT 1 FROM newsletters WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1')
            .bind(nm, nid)
            .first();
          if (dupe) return Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 });
          sets.push('name = ?');
          binds.push(nm);
        }
        if (typeof body.enabled === 'boolean') {
          sets.push('enabled = ?');
          binds.push(body.enabled ? 1 : 0);
        }
        // from_address: a non-empty string sets the per-newsletter sender;
        // null or an empty string clears it (falls back to global FROM_ADDRESS).
        if (body.from_address === null || body.from_address === '') {
          sets.push('from_address = ?');
          binds.push(null);
        } else if (typeof body.from_address === 'string') {
          const r = validateFromAddress(body.from_address, env.BASE_DOMAIN);
          if ('error' in r) return Response.json({ error: r.error }, { status: 400 });
          sets.push('from_address = ?');
          binds.push(r.value);
        }
        if (typeof body.inbound_address === 'string') {
          const addr = body.inbound_address.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            return Response.json({ error: 'valid inbound_address required' }, { status: 400 });
          }
          sets.push('inbound_address = ?');
          binds.push(addr);
        }
        if (sets.length === 0) return Response.json({ error: 'no fields' }, { status: 400 });
        // Capture the current inbound address before the update so we can move
        // the matching Email Routing rule if it changed.
        let oldAddr: string | null = null;
        if (typeof body.inbound_address === 'string') {
          const cur = await env.DB
            .prepare('SELECT inbound_address FROM newsletters WHERE id = ?')
            .bind(nid)
            .first<{ inbound_address: string }>();
          oldAddr = cur?.inbound_address ?? null;
        }
        binds.push(nid);
        try {
          const res = await env.DB
            .prepare(`UPDATE newsletters SET ${sets.join(', ')} WHERE id = ?`)
            .bind(...binds)
            .run();
          if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        } catch (err) {
          if (/UNIQUE/i.test((err as Error).message)) {
            return Response.json({ error: 'inbound address already in use' }, { status: 409 });
          }
          throw err;
        }
        let routing_warning: string | undefined;
        if (typeof body.inbound_address === 'string' && oldAddr) {
          routing_warning = await moveRoutingRule(env, oldAddr, body.inbound_address.trim().toLowerCase());
        }
        return Response.json({ ok: true, routing_warning });
      }
      if (m === 'DELETE') {
        // Campaigns retain a newsletter_id with no cascade; refuse to delete a
        // newsletter that still has campaign history to avoid orphaning it.
        const camp = await env.DB
          .prepare('SELECT COUNT(*) AS n FROM campaigns WHERE newsletter_id = ?')
          .bind(nid)
          .first<{ n: number }>();
        if ((camp?.n ?? 0) > 0) {
          return Response.json(
            { error: 'newsletter has campaign history; cannot delete' },
            { status: 409 },
          );
        }
        const cur = await env.DB
          .prepare('SELECT inbound_address FROM newsletters WHERE id = ?')
          .bind(nid)
          .first<{ inbound_address: string }>();
        const res = await env.DB.prepare('DELETE FROM newsletters WHERE id = ?').bind(nid).run();
        if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        const routing_warning = cur ? await deleteRoutingRule(env, cur.inbound_address) : undefined;
        return Response.json({ ok: true, routing_warning });
      }
    }

    // ---- authors (scoped to newsletter) ----
    if (rest === '/authors') {
      if (m === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT email, name, created_at FROM authors WHERE newsletter_id = ? ORDER BY created_at DESC')
          .bind(nid)
          .all<{ email: string; name: string | null; created_at: string }>();
        return Response.json({ items: results ?? [] });
      }
      if (m === 'POST') {
        const { email, name } = await req.json<{ email: string; name?: string | null }>();
        const norm = (email ?? '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
          return Response.json({ error: 'valid email required' }, { status: 400 });
        }
        try {
          await env.DB
            .prepare('INSERT INTO authors (newsletter_id, email, name) VALUES (?, ?, ?)')
            .bind(nid, norm, name ?? null)
            .run();
        } catch (err) {
          if (/UNIQUE|PRIMARY KEY/i.test((err as Error).message)) {
            return Response.json({ error: 'author already exists' }, { status: 409 });
          }
          throw err;
        }
        return Response.json({ email: norm, name: name ?? null }, { status: 201 });
      }
    }
    const am = /^\/authors\/(.+)$/.exec(rest);
    if (am) {
      const email = decodeURIComponent(am[1]!).toLowerCase();
      if (m === 'DELETE') {
        const res = await env.DB
          .prepare('DELETE FROM authors WHERE newsletter_id = ? AND email = ?')
          .bind(nid, email)
          .run();
        if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ok: true });
      }
      if (m === 'PATCH') {
        const body = await req.json<{ name?: string | null }>();
        await env.DB
          .prepare('UPDATE authors SET name = ? WHERE newsletter_id = ? AND email = ?')
          .bind(body.name ?? null, nid, email)
          .run();
        return Response.json({ ok: true });
      }
    }

    // ---- subscribers (scoped to newsletter) ----
    if (rest === '/subscribers') {
      if (m === 'GET') {
        const status = url.searchParams.get('status');
        const q = url.searchParams.get('q');
        const cursor = Number(url.searchParams.get('cursor') ?? '0');
        const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
        const where: string[] = ['newsletter_id = ?', 'id > ?'];
        const binds: unknown[] = [nid, cursor];
        if (status) {
          where.push('status = ?');
          binds.push(status);
        }
        if (q) {
          where.push('(email LIKE ? OR name LIKE ?)');
          const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
          binds.push(like, like);
        }
        binds.push(limit);
        const sql =
          `SELECT id, email, name, verified, status, bounce_count, subscribed_at FROM subscribers ` +
          `WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
        const { results } = await env.DB.prepare(sql).bind(...binds).all();
        const last = results?.[results.length - 1] as { id: number } | undefined;
        const next = last && results.length === limit ? last.id : null;
        return Response.json({ items: results ?? [], nextCursor: next });
      }
      if (m === 'POST') {
        const { email, name } = await req.json<{ email: string; name?: string }>();
        if (!email) return Response.json({ error: 'email required' }, { status: 400 });
        const token = crypto.randomUUID();
        await env.DB
          .prepare(
            "INSERT INTO subscribers (newsletter_id, email, name, token) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(newsletter_id, email) DO UPDATE SET status='active', name=COALESCE(excluded.name, subscribers.name)",
          )
          .bind(nid, email, name ?? null, token)
          .run();
        return Response.json({ ok: true });
      }
    }
    if (rest === '/subscribers/export' && m === 'GET') {
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q');
      const where: string[] = ['newsletter_id = ?'];
      const binds: unknown[] = [nid];
      if (status) {
        where.push('status = ?');
        binds.push(status);
      }
      if (q) {
        where.push('(email LIKE ? OR name LIKE ?)');
        const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
        binds.push(like, like);
      }
      const { results } = await env.DB
        .prepare(
          `SELECT email, name, verified, status, bounce_count, subscribed_at FROM subscribers ` +
            `WHERE ${where.join(' AND ')} ORDER BY email ASC`,
        )
        .bind(...binds)
        .all<{ email: string; name: string | null; verified: number; status: string; bounce_count: number; subscribed_at: string }>();
      const header = 'Email,Name,Verified,Status,Bounces,Date subscribed';
      const lines = (results ?? []).map((r) =>
        [
          r.email,
          r.name ?? '',
          r.verified ? 'True' : 'False',
          r.status,
          String(r.bounce_count ?? 0),
          r.subscribed_at ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
      const csv = [header, ...lines].join('\r\n') + '\r\n';
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="subscribers-${stamp}.csv"`,
        },
      });
    }
    if (rest === '/subscribers/import' && m === 'POST') {
      const ct = req.headers.get('content-type') ?? '';
      const text = ct.includes('application/json')
        ? (await req.json<{ csv: string }>()).csv
        : await req.text();
      // Positional mapping (the header row is always ignored):
      //   field 1 = email, field 2 = Verified, field 3 = date subscribed.
      // Name is not present in the import and is left null.
      // Duplicates (by email, case-insensitive) are skipped, not updated —
      // both against existing rows and within the file itself.
      const existing = await env.DB
        .prepare('SELECT email FROM subscribers WHERE newsletter_id = ?')
        .bind(nid)
        .all<{ email: string }>();
      const seen = new Set((existing.results ?? []).map((r) => r.email.toLowerCase()));
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      let added = 0;
      let duplicated = 0;
      for (const line of lines.slice(1)) {
        const cols = splitCsvLine(line);
        const email = (cols[0] ?? '').trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) {
          duplicated++;
          continue;
        }
        seen.add(key);
        const verified = parseBool(cols[1]) ? 1 : 0;
        const subscribedAt = (cols[2] ?? '').trim();
        const token = crypto.randomUUID();
        await env.DB
          .prepare(
            "INSERT INTO subscribers (newsletter_id, email, name, verified, subscribed_at, token) " +
              "VALUES (?, ?, NULL, ?, COALESCE(NULLIF(?, ''), datetime('now')), ?) " +
              "ON CONFLICT(newsletter_id, email) DO NOTHING",
          )
          .bind(nid, email, verified, subscribedAt, token)
          .run();
        added++;
      }
      return Response.json({ ok: true, added, duplicated });
    }
    const sm = /^\/subscribers\/(\d+)$/.exec(rest);
    if (sm) {
      const id = Number(sm[1]);
      if (m === 'DELETE') {
        await env.DB
          .prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id = ? AND newsletter_id = ?")
          .bind(id, nid)
          .run();
        return Response.json({ ok: true });
      }
      if (m === 'PATCH') {
        const body = await req.json<SubscriberPatch>();
        const sets: string[] = [];
        const binds: unknown[] = [];
        if ('name' in body) {
          sets.push('name = ?');
          binds.push(body.name);
        }
        if (body.status) {
          sets.push('status = ?');
          binds.push(body.status);
          if (body.status === 'unsubscribed') sets.push("unsubscribed_at = datetime('now')");
        }
        if (sets.length === 0) return Response.json({ error: 'no fields' }, { status: 400 });
        binds.push(id, nid);
        await env.DB
          .prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE id = ? AND newsletter_id = ?`)
          .bind(...binds)
          .run();
        return Response.json({ ok: true });
      }
    }
  }

  // -------- campaigns --------

  if (m === 'GET' && p === '/api/campaigns') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
    const cursor = url.searchParams.get('cursor');
    const newsletterId = url.searchParams.get('newsletter_id');
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (cursor) {
      conds.push('c.created_at < ?');
      binds.push(cursor);
    }
    if (newsletterId) {
      conds.push('c.newsletter_id = ?');
      binds.push(newsletterId);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    binds.push(limit);
    const { results } = await env.DB
      .prepare(
        `SELECT c.id, c.newsletter_id, n.name AS newsletter_name, c.subject, c.status, ` +
          `c.total_recipients, c.sent_count, c.failed_count, ` +
          `c.attachment_count, c.link_mode, c.created_at ` +
          `FROM campaigns c LEFT JOIN newsletters n ON n.id = c.newsletter_id ` +
          `${where} ORDER BY c.created_at DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<{ created_at: string }>();
    const last = results?.[results.length - 1];
    const next = last && results.length === limit ? last.created_at : null;
    return Response.json({ items: results ?? [], nextCursor: next });
  }

  const campMatch = /^\/api\/campaigns\/([^/]+)(?:\/(timeseries|sends|replay-failed))?$/.exec(p);
  if (campMatch) {
    const id = campMatch[1];
    const sub = campMatch[2];

    if (m === 'GET' && !sub) {
      const campaign = await env.DB
        .prepare(
          'SELECT c.id, c.newsletter_id, n.name AS newsletter_name, c.subject, c.status, ' +
            'c.total_recipients, c.sent_count, c.failed_count, ' +
            'c.attachment_count, c.attachment_total_bytes, c.link_mode, c.sent_by, c.created_at ' +
            'FROM campaigns c LEFT JOIN newsletters n ON n.id = c.newsletter_id WHERE c.id = ?',
        )
        .bind(id)
        .first();
      if (!campaign) return Response.json({ error: 'not found' }, { status: 404 });
      const events = await env.DB
        .prepare(
          'SELECT type, COUNT(*) AS n FROM events WHERE campaign_id = ? GROUP BY type',
        )
        .bind(id)
        .all<{ type: string; n: number }>();
      const attachments = await env.DB
        .prepare(
          'SELECT id, filename, content_type, size, disposition FROM attachments WHERE campaign_id = ?',
        )
        .bind(id)
        .all();
      return Response.json({ campaign, events: events.results ?? [], attachments: attachments.results ?? [] });
    }

    if (m === 'GET' && sub === 'timeseries') {
      const bucket = url.searchParams.get('bucket') === 'day' ? 'day' : 'hour';
      const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H:00';
      const { results } = await env.DB
        .prepare(
          `SELECT strftime(?, ts) AS bucket, type, COUNT(*) AS n ` +
            `FROM events WHERE campaign_id = ? GROUP BY bucket, type ORDER BY bucket ASC`,
        )
        .bind(fmt, id)
        .all();
      return Response.json({ items: results ?? [] });
    }

    if (m === 'GET' && sub === 'sends') {
      const status = url.searchParams.get('status');
      const cursor = Number(url.searchParams.get('cursor') ?? '0');
      const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
      const where: string[] = ['s.campaign_id = ?', 's.id > ?'];
      const binds: unknown[] = [id, cursor];
      if (status) {
        where.push('s.status = ?');
        binds.push(status);
      }
      binds.push(limit);
      const { results } = await env.DB
        .prepare(
          `SELECT s.id, s.subscriber_id, sub.email, s.status, s.sent_at, s.error, s.message_id ` +
            `FROM sends s LEFT JOIN subscribers sub ON sub.id = s.subscriber_id ` +
            `WHERE ${where.join(' AND ')} ORDER BY s.id ASC LIMIT ?`,
        )
        .bind(...binds)
        .all<{ id: number }>();
      const last = results?.[results.length - 1];
      const next = last && results.length === limit ? last.id : null;
      return Response.json({ items: results ?? [], nextCursor: next });
    }

    if (m === 'POST' && sub === 'replay-failed') {
      // Counter-only stub. Real replay needs a QUEUE binding here; the consumer
      // worker is already idempotent on (campaign_id, subscriber_id).
      const row = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND status = 'failed'")
        .bind(id)
        .first<{ n: number }>();
      return Response.json({ ok: false, would_replay: row?.n ?? 0, hint: 'attach QUEUE binding to admin worker to enable' });
    }
  }

  // -------- bounces --------

  if (m === 'GET' && p === '/api/bounces') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '100'), 1, 500);
    const since = url.searchParams.get('since') ?? "datetime('now','-7 days')";
    const { results } = await env.DB
      .prepare(
        `SELECT e.id, e.campaign_id, e.subscriber_id, sub.email, e.url AS status_code, e.ts ` +
          `FROM events e LEFT JOIN subscribers sub ON sub.id = e.subscriber_id ` +
          `WHERE e.type = 'bounce' AND e.ts > ${
            since.startsWith('datetime') ? since : '?'
          } ORDER BY e.ts DESC LIMIT ?`,
      )
      .bind(...(since.startsWith('datetime') ? [limit] : [since, limit]))
      .all();
    return Response.json({ items: results ?? [] });
  }

  // -------- warmup quota --------

  if (m === 'GET' && p === '/api/quota') {
    const cfg = readWarmupConfig(env as unknown as Record<string, string | undefined>);
    const win = currentWindow(cfg, new Date());
    if (!win) {
      return Response.json({ enabled: false, target: cfg.targetWeekly });
    }
    const dayRow = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?")
      .bind(win.dayStartSql)
      .first<{ n: number }>();
    const weekRow = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?")
      .bind(win.weekStartSql)
      .first<{ n: number }>();
    const dailyUsed = dayRow?.n ?? 0;
    const weeklyUsed = weekRow?.n ?? 0;
    return Response.json({
      enabled: true,
      weekIndex: win.weekIndex,
      dailyCap: win.dailyCap,
      dailyUsed,
      dailyRemaining: Math.max(0, win.dailyCap - dailyUsed),
      weeklyCap: win.weeklyCap,
      weeklyUsed,
      weeklyRemaining: Math.max(0, win.weeklyCap - weeklyUsed),
      target: cfg.targetWeekly,
      windowStart: win.weekStartSql,
      dayWindowStart: win.dayStartSql,
    });
  }

  // -------- help document --------

  // Renders a markdown document stored in the R2 media bucket (key
  // `help.md`). Lets operators ship docs without redeploying the worker.
  if (m === 'GET' && p === '/api/help') {
    const obj = await env.ASSETS_R2.get('help.md');
    if (!obj) {
      return Response.json({ error: 'no help document uploaded' }, { status: 404 });
    }
    const content = await obj.text();
    return Response.json({ content, updated: obj.uploaded?.toISOString() ?? null });
  }

  // -------- stats / dashboard --------

  if (m === 'GET' && p === '/api/stats/overview') {
    const subs = await env.DB
      .prepare('SELECT status, COUNT(*) AS n FROM subscribers GROUP BY status')
      .all<{ status: string; n: number }>();
    const camps = await env.DB
      .prepare(
        "SELECT COUNT(*) AS total, " +
          "SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) AS sent, " +
          "SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending " +
          'FROM campaigns',
      )
      .first();
    const last7 = await env.DB
      .prepare(
        "SELECT type, COUNT(*) AS n FROM events WHERE ts > datetime('now','-7 days') GROUP BY type",
      )
      .all();
    return Response.json({
      subscribers: subs.results ?? [],
      campaigns: camps,
      events_last_7d: last7.results ?? [],
    });
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}

// -------- Email Routing rule sync --------
//
// Keeps one Email Routing rule per newsletter, matching the newsletter's
// `inbound_address` (literal "to") and forwarding it to the ingest worker.
// All functions are best-effort: they return a human-readable warning string
// on failure (or when unconfigured) instead of throwing, so newsletter CRUD
// always succeeds even if rule management does not.

const CF_API = 'https://api.cloudflare.com/client/v4';

function routingReady(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN && env.EMAIL_ROUTING_ZONE_ID);
}

function routingRulesPath(env: Env, suffix = ''): string {
  return `${CF_API}/zones/${env.EMAIL_ROUTING_ZONE_ID}/email/routing/rules${suffix}`;
}

async function cfJson(env: Env, urlStr: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(urlStr, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const msg =
      (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function ruleBody(env: Env, addr: string): string {
  return JSON.stringify({
    name: `newsletter:${addr}`,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: addr }],
    actions: [{ type: 'worker', value: [env.INGEST_WORKER_NAME ?? 'newsletter-ingest'] }],
  });
}

// Returns the rule id whose "to" matcher equals `addr`, or null. Paginates.
async function findRoutingRuleId(env: Env, addr: string): Promise<string | null> {
  let page = 1;
  for (;;) {
    const body = await cfJson(env, routingRulesPath(env, `?page=${page}&per_page=50`));
    for (const r of body.result ?? []) {
      const matched = (r.matchers ?? []).some(
        (mm: { field?: string; value?: string }) =>
          mm.field === 'to' && String(mm.value ?? '').toLowerCase() === addr,
      );
      if (matched) return r.id ?? r.tag ?? null;
    }
    const info = body.result_info;
    if (!info || page >= (info.total_pages ?? 1)) return null;
    page++;
  }
}

async function createRoutingRule(env: Env, addr: string): Promise<string | undefined> {
  if (!routingReady(env)) {
    return 'Email Routing not configured — add the rule manually (set CF_API_TOKEN + EMAIL_ROUTING_ZONE_ID to automate).';
  }
  try {
    if (await findRoutingRuleId(env, addr)) return undefined; // already routed
    await cfJson(env, routingRulesPath(env), { method: 'POST', body: ruleBody(env, addr) });
    return undefined;
  } catch (e) {
    return `Email Routing rule not created: ${(e as Error).message}`;
  }
}

async function moveRoutingRule(env: Env, oldAddr: string, newAddr: string): Promise<string | undefined> {
  if (oldAddr === newAddr) return undefined;
  if (!routingReady(env)) {
    return 'Email Routing not configured — update the rule manually.';
  }
  try {
    const id = await findRoutingRuleId(env, oldAddr);
    if (id) {
      await cfJson(env, routingRulesPath(env, `/${id}`), { method: 'PUT', body: ruleBody(env, newAddr) });
    } else {
      await cfJson(env, routingRulesPath(env), { method: 'POST', body: ruleBody(env, newAddr) });
    }
    return undefined;
  } catch (e) {
    return `Email Routing rule not updated: ${(e as Error).message}`;
  }
}

async function deleteRoutingRule(env: Env, addr: string): Promise<string | undefined> {
  if (!routingReady(env)) return undefined;
  try {
    const id = await findRoutingRuleId(env, addr);
    if (id) await cfJson(env, routingRulesPath(env, `/${id}`), { method: 'DELETE' });
    return undefined;
  } catch (e) {
    return `Email Routing rule not deleted: ${(e as Error).message}`;
  }
}

async function serveMedia(req: Request, env: Env, url: URL): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!key || key.includes('..')) {
    return new Response('not found', { status: 404 });
  }
  const obj = await env.ASSETS_R2.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // GUI media is small and rarely changes; let the browser cache it.
  headers.set('cache-control', 'public, max-age=3600');
  if (!headers.has('content-type')) {
    headers.set('content-type', guessContentType(key));
  }

  // Honour conditional requests so repeat loads are cheap.
  if (req.headers.get('if-none-match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Quote a CSV field if it contains a comma, quote, or newline (RFC 4180).
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Split a single CSV line into fields, honouring RFC-4180 double-quoting
// (quoted fields may contain commas; "" is an escaped quote).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parse a loose boolean ("true"/"1"/"yes"/"y" => true, everything else false).
function parseBool(value: string | undefined): boolean {
  return /^(true|1|yes|y)$/i.test((value ?? '').trim());
}
