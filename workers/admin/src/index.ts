export interface Env {
  DB: D1Database;
  ADMIN_TOKEN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.headers.get('authorization') !== `Bearer ${env.ADMIN_TOKEN}`) {
      return new Response('unauthorized', { status: 401 });
    }
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === 'POST' && p === '/subscribers') {
      const { email, name } = await req.json<{ email: string; name?: string }>();
      const token = crypto.randomUUID();
      await env.DB
        .prepare("INSERT INTO subscribers (email, name, token) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET status='active'")
        .bind(email, name ?? null, token)
        .run();
      return Response.json({ ok: true });
    }

    if (req.method === 'GET' && p === '/subscribers') {
      const { results } = await env.DB
        .prepare('SELECT id, email, name, status, bounce_count FROM subscribers ORDER BY id DESC LIMIT 1000')
        .all();
      return Response.json(results);
    }

    if (req.method === 'GET' && p.startsWith('/campaigns/')) {
      const id = p.split('/')[2];
      const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(id).first();
      const stats = await env.DB
        .prepare(
          "SELECT type, COUNT(*) as n FROM events WHERE campaign_id = ? GROUP BY type",
        )
        .bind(id)
        .all();
      return Response.json({ campaign, events: stats.results });
    }

    if (req.method === 'GET' && p === '/campaigns') {
      const { results } = await env.DB
        .prepare('SELECT id, subject, status, total_recipients, sent_count, failed_count, created_at FROM campaigns ORDER BY created_at DESC LIMIT 100')
        .all();
      return Response.json(results);
    }

    return new Response('not found', { status: 404 });
  },
};
