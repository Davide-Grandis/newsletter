import PostalMime from 'postal-mime';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  HARD_BOUNCE_THRESHOLD: string;
  SOFT_BOUNCE_THRESHOLD: string;
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    // VERP: bounce+<campaignId>.<subscriberId>@domain
    const to = (message.to ?? '').toLowerCase();
    const verp = /bounce\+([^.@]+)\.(\d+)@/.exec(to);
    const campaignId = verp?.[1] ?? null;
    const subscriberId = verp ? Number(verp[2]) : null;

    const raw = new Uint8Array(await streamToArrayBuffer(message.raw));
    const archiveKey = `bounces/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
    await env.ARCHIVE.put(archiveKey, raw);

    const parsed = await PostalMime.parse(raw);
    const body = (parsed.text ?? '') + '\n' + (parsed.html ?? '');
    const status = /Status:\s*(\d\.\d+\.\d+)/i.exec(body)?.[1] ?? '';
    const hard = /^5\./.test(status) || /user unknown|no such user|mailbox.*not.*found/i.test(body);

    if (subscriberId !== null) {
      await env.DB
        .prepare(
          "UPDATE subscribers SET bounce_count = bounce_count + 1, last_bounce_at = datetime('now') WHERE id = ?",
        )
        .bind(subscriberId)
        .run();

      const threshold = hard
        ? Number(env.HARD_BOUNCE_THRESHOLD)
        : Number(env.SOFT_BOUNCE_THRESHOLD);
      await env.DB
        .prepare(
          "UPDATE subscribers SET status='bounced' WHERE id = ? AND status='active' AND bounce_count >= ?",
        )
        .bind(subscriberId, threshold)
        .run();

      await env.DB
        .prepare(
          "INSERT INTO events (campaign_id, subscriber_id, type, url) VALUES (?, ?, 'bounce', ?)",
        )
        .bind(campaignId, subscriberId, status || (hard ? 'hard' : 'soft'))
        .run();
    }
  },
};

async function streamToArrayBuffer(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}
