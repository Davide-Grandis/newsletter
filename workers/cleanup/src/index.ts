import { loadSettings } from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  // Overlaid by loadSettings from D1/defaults at runtime:
  RETENTION_DAYS: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runRetention(env).catch(console.error));
  },
};

async function runRetention(rawEnv: Env): Promise<void> {
  const env = await loadSettings(rawEnv.DB, rawEnv);
  const days = Math.max(1, Number(env.RETENTION_DAYS));
  const cutoff = `datetime('now', '-${days} days')`;

  // Find expired campaigns + their attachments
  const { results: expired } = await env.DB
    .prepare(`SELECT id FROM campaigns WHERE created_at < ${cutoff}`)
    .all<{ id: string }>();

  for (const c of expired ?? []) {
    const { results: atts } = await env.DB
      .prepare('SELECT r2_key FROM attachments WHERE campaign_id = ?')
      .bind(c.id)
      .all<{ r2_key: string }>();
    for (const a of atts ?? []) {
      await env.ARCHIVE.delete(a.r2_key).catch(() => {});
    }
    await env.ARCHIVE.delete(`campaigns/${c.id}/raw.eml`).catch(() => {});
    // ON DELETE CASCADE handles attachments + sends + events
    await env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(c.id).run();
  }
}
