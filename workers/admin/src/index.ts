// Admin Worker
//
// Serves a static SPA from the [assets] binding for the GUI, and exposes a
// bearer-token-authenticated JSON API under /api/* for it (and curl/scripts)
// to call. Anything that is not /api/* falls through to the static assets.

import { readWarmupConfig, currentWindow } from '../../../shared/warmup';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  // Warmup vars — kept in sync with the consumer worker so the admin GUI can
  // show the current daily/weekly caps and how much has been used.
  WARMUP_START_DATE?: string;
  WARMUP_TARGET_WEEKLY?: string;
  WARMUP_SCHEDULE?: string;
  WARMUP_DAILY_CAP_EARLY?: string;
  WARMUP_DAILY_CAP_LATE?: string;
  WARMUP_LATE_START_WEEK?: string;
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
      return Response.json({
        email: email ?? null,
        name: name ?? null,
        protected_by_access: Boolean(email),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return await handleApi(req, env, url);
    }

    // SPA static assets (with SPA fallback configured in wrangler.toml).
    return env.ASSETS.fetch(req);
  },
};

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  // -------- authors (ingest allow-list) --------

  if (m === 'GET' && p === '/api/authors') {
    const { results } = await env.DB
      .prepare('SELECT email, name, created_at FROM authors ORDER BY created_at DESC')
      .all<{ email: string; name: string | null; created_at: string }>();
    return Response.json({ items: results ?? [] });
  }

  if (m === 'POST' && p === '/api/authors') {
    const { email, name } = await req.json<{ email: string; name?: string | null }>();
    const norm = (email ?? '').trim().toLowerCase();
    if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
      return Response.json({ error: 'valid email required' }, { status: 400 });
    }
    try {
      await env.DB
        .prepare('INSERT INTO authors (email, name) VALUES (?, ?)')
        .bind(norm, name ?? null)
        .run();
    } catch (err) {
      const msg = (err as Error).message;
      if (/UNIQUE|PRIMARY KEY/i.test(msg)) {
        return Response.json({ error: 'author already exists' }, { status: 409 });
      }
      throw err;
    }
    return Response.json({ email: norm, name: name ?? null }, { status: 201 });
  }

  const authorMatch = /^\/api\/authors\/(.+)$/.exec(p);
  if (authorMatch) {
    const email = decodeURIComponent(authorMatch[1]!).toLowerCase();
    if (m === 'DELETE') {
      const res = await env.DB
        .prepare('DELETE FROM authors WHERE email = ?')
        .bind(email)
        .run();
      if (!res.meta?.changes) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      return Response.json({ ok: true });
    }
    if (m === 'PATCH') {
      const body = await req.json<{ name?: string | null }>();
      await env.DB
        .prepare('UPDATE authors SET name = ? WHERE email = ?')
        .bind(body.name ?? null, email)
        .run();
      return Response.json({ ok: true });
    }
  }

  // -------- subscribers --------

  if (m === 'GET' && p === '/api/subscribers') {
    const status = url.searchParams.get('status');
    const q = url.searchParams.get('q');
    const cursor = Number(url.searchParams.get('cursor') ?? '0');
    const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);

    const where: string[] = ['id > ?'];
    const binds: unknown[] = [cursor];
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
      `SELECT id, email, name, status, bounce_count, subscribed_at FROM subscribers ` +
      `WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    const last = results?.[results.length - 1] as { id: number } | undefined;
    const next = last && results.length === limit ? last.id : null;
    return Response.json({ items: results ?? [], nextCursor: next });
  }

  if (m === 'POST' && p === '/api/subscribers') {
    const { email, name } = await req.json<{ email: string; name?: string }>();
    if (!email) return Response.json({ error: 'email required' }, { status: 400 });
    const token = crypto.randomUUID();
    await env.DB
      .prepare(
        "INSERT INTO subscribers (email, name, token) VALUES (?, ?, ?) " +
          "ON CONFLICT(email) DO UPDATE SET status='active', name=COALESCE(excluded.name, subscribers.name)",
      )
      .bind(email, name ?? null, token)
      .run();
    return Response.json({ ok: true });
  }

  const subMatch = /^\/api\/subscribers\/(\d+)$/.exec(p);
  if (subMatch) {
    const id = Number(subMatch[1]);
    if (m === 'DELETE') {
      await env.DB
        .prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id = ?")
        .bind(id)
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
      binds.push(id);
      await env.DB.prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
      return Response.json({ ok: true });
    }
  }

  if (m === 'POST' && p === '/api/subscribers/import') {
    const ct = req.headers.get('content-type') ?? '';
    const text = ct.includes('application/json')
      ? (await req.json<{ csv: string }>()).csv
      : await req.text();
    const rows = parseCsv(text);
    let inserted = 0;
    for (const row of rows) {
      const email = row.email?.trim();
      if (!email) continue;
      const token = crypto.randomUUID();
      await env.DB
        .prepare(
          "INSERT INTO subscribers (email, name, token) VALUES (?, ?, ?) " +
            "ON CONFLICT(email) DO UPDATE SET status='active'",
        )
        .bind(email, row.name ?? null, token)
        .run();
      inserted++;
    }
    return Response.json({ ok: true, inserted });
  }

  // -------- campaigns --------

  if (m === 'GET' && p === '/api/campaigns') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
    const cursor = url.searchParams.get('cursor');
    const where = cursor ? 'WHERE created_at < ?' : '';
    const binds: unknown[] = cursor ? [cursor, limit] : [limit];
    const { results } = await env.DB
      .prepare(
        `SELECT id, subject, status, total_recipients, sent_count, failed_count, ` +
          `attachment_count, link_mode, created_at ` +
          `FROM campaigns ${where} ORDER BY created_at DESC LIMIT ?`,
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
          'SELECT id, subject, status, total_recipients, sent_count, failed_count, ' +
            'attachment_count, attachment_total_bytes, link_mode, sent_by, created_at ' +
            'FROM campaigns WHERE id = ?',
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

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function parseCsv(text: string): Array<{ email?: string; name?: string }> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = lines[0]!.split(',').map((s) => s.trim().toLowerCase());
  const emailIdx = header.indexOf('email');
  const nameIdx = header.indexOf('name');
  const start = emailIdx >= 0 ? 1 : 0;
  const out: Array<{ email?: string; name?: string }> = [];
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    if (emailIdx >= 0) {
      out.push({ email: cols[emailIdx], name: nameIdx >= 0 ? cols[nameIdx] : undefined });
    } else {
      out.push({ email: cols[0] });
    }
  }
  return out;
}
