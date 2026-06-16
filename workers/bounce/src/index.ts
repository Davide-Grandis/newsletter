import PostalMime from 'postal-mime';
import { loadSettings } from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  HARD_BOUNCE_THRESHOLD: string;
  SOFT_BOUNCE_THRESHOLD: string;
}

export default {
  async email(message: ForwardableEmailMessage, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    // Resolve tunables (bounce thresholds) against the D1 `settings` table.
    const env = await loadSettings(rawEnv.DB, rawEnv);
    const to = (message.to ?? '').toLowerCase();

    // RFC 8058 mailto unsubscribe: unsubscribe+<subscriberId>@<domain>. The
    // consumer advertises this in List-Unsubscribe; it lands here because the
    // bounce worker is the catch-all inbound route. The sender's own mail
    // provider is the proof of intent (a mailto carries no token), matching
    // standard one-click-by-email behaviour.
    const unsub = /unsubscribe\+(\d+)@/.exec(to);
    if (unsub) {
      const sub = Number(unsub[1]);
      const res = await env.DB
        .prepare(
          "UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') " +
            "WHERE id = ? AND status='active'",
        )
        .bind(sub)
        .run();
      if (res.meta?.changes) {
        await env.DB
          .prepare("INSERT INTO events (campaign_id, subscriber_id, type) VALUES (NULL, ?, 'unsubscribe')")
          .bind(sub)
          .run();
      }
      return;
    }

    // VERP: bounce+<campaignId>.<subscriberId>@domain
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
