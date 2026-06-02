import PostalMime from 'postal-mime';
import {
  validateAttachments,
  sanitizeFilename,
  sha256Hex,
  putAttachment,
  r2KeyForAttachment,
  type AttachmentInput,
  type AttachmentLimits,
} from '../../../shared/attachments';
import { estimateRawSize } from '../../../shared/mime';
import { iterateActiveSubscribers, writeLog } from '../../../shared/db';
import { loadSettings } from '../../../shared/settings';
import type { QueueMessage, Recipient } from '../../../shared/types';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  QUEUE: Queue<QueueMessage>;
  BATCH_SIZE: string;
  MAX_ATTACHMENT_BYTES: string;
  MAX_TOTAL_ATTACHMENT_BYTES: string;
  MAX_ATTACHMENT_COUNT: string;
  ALLOWED_MIME: string;
  BLOCKED_EXTENSIONS: string;
  ATTACHMENT_LINK_THRESHOLD_BYTES: string;
  MAX_RAW_BYTES: string;
}

export default {
  async email(message: ForwardableEmailMessage, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    // Resolve tunables (batch size, attachment limits) against the D1
    // `settings` table, falling back to env vars then built-in defaults.
    const env = await loadSettings(rawEnv.DB, rawEnv);

    // 1. Resolve the target newsletter from the recipient address.
    //    Email Routing points one address per newsletter at this worker; the
    //    recipient (`message.to`) is matched against `newsletters.inbound_address`
    //    (case-insensitive). A disabled or unknown newsletter is rejected.
    const recipient = (message.to ?? '').toLowerCase();
    const sender = (message.from ?? '').toLowerCase();
    await writeLog(env.DB, {
      source: 'ingest',
      event: 'ingest.received',
      message: `Inbound email from ${sender || '(unknown)'} to ${recipient || '(unknown)'}`,
      detail: { from: sender, to: recipient },
    });
    const newsletter = await env.DB
      .prepare('SELECT id, enabled FROM newsletters WHERE inbound_address = ? LIMIT 1')
      .bind(recipient)
      .first<{ id: string; enabled: number }>();
    if (!newsletter) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'ingest',
        event: 'ingest.rejected',
        message: `Rejected: unknown newsletter address ${recipient}`,
        detail: { reason: 'unknown_newsletter', to: recipient },
      });
      message.setReject('Unknown newsletter address');
      return;
    }
    if (!newsletter.enabled) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'ingest',
        event: 'ingest.rejected',
        newsletterId: newsletter.id,
        message: `Rejected: newsletter ${recipient} is disabled`,
        detail: { reason: 'newsletter_disabled', to: recipient },
      });
      message.setReject('Newsletter is disabled');
      return;
    }
    const newsletterId = newsletter.id;

    // 2. Author allow-list + auth check, scoped to this newsletter.
    //    The allow-list lives in the D1 `authors` table and is managed via the
    //    admin worker (CRUD endpoints / GUI). The lookup is case-insensitive.
    const from = sender;
    const authorRow = await env.DB
      .prepare('SELECT 1 AS ok FROM authors WHERE newsletter_id = ? AND email = ? LIMIT 1')
      .bind(newsletterId, from)
      .first<{ ok: number }>();
    if (!authorRow) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'ingest',
        event: 'ingest.rejected',
        newsletterId,
        message: `Rejected: ${from} not authorized for this newsletter`,
        detail: { reason: 'sender_not_authorized', from },
      });
      message.setReject('Sender not authorized for this newsletter');
      return;
    }

    // Sender authentication is enforced by Cloudflare Email Routing at the edge:
    // since 2025-07-03 inbound mail must pass SPF or DKIM (and the sender's
    // DMARC policy is honoured) before this worker is ever invoked. We therefore
    // do NOT re-derive a verdict from the `Authentication-Results` header — that
    // header is not a reliable carrier of the edge verdict and a strict
    // spf=pass+dkim=pass match rejected legitimately-authenticated mail. The
    // author allow-list above, combined with edge SPF/DKIM/DMARC enforcement,
    // is the spoofing boundary.

    // 3. Read raw MIME (also archived to R2)
    const raw = new Uint8Array(await streamToArrayBuffer(message.raw));
    const parsed = await PostalMime.parse(raw);

    const subject = parsed.subject ?? '(no subject)';
    const html = parsed.html ?? '';
    const text = parsed.text ?? htmlToText(html);

    // 4. Validate attachments
    const limits: AttachmentLimits = {
      maxBytes: Number(env.MAX_ATTACHMENT_BYTES),
      maxTotalBytes: Number(env.MAX_TOTAL_ATTACHMENT_BYTES),
      maxCount: Number(env.MAX_ATTACHMENT_COUNT),
      allowedMime: env.ALLOWED_MIME.split(',').map((s) => s.trim()),
      blockedExt: env.BLOCKED_EXTENSIONS.split(',').map((s) => s.trim().toLowerCase()),
    };
    const inputs: AttachmentInput[] = (parsed.attachments ?? []).map((a) => ({
      filename: sanitizeFilename(a.filename ?? 'file'),
      contentType: a.mimeType ?? 'application/octet-stream',
      bytes: toUint8(a.content),
      contentId: a.contentId?.replace(/[<>]/g, ''),
      disposition: (a.disposition === 'inline' ? 'inline' : 'attachment') as 'inline' | 'attachment',
    }));
    try {
      validateAttachments(inputs, limits);
    } catch (e) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'ingest',
        event: 'ingest.rejected',
        newsletterId,
        message: `Rejected: attachment validation failed — ${(e as Error).message}`,
        detail: { reason: 'attachment_rejected', error: (e as Error).message },
      });
      message.setReject(`Attachment rejected: ${(e as Error).message}`);
      return;
    }

    // 5. Persist campaign + archive raw
    const campaignId = crypto.randomUUID();
    const totalAttBytes = inputs.reduce((s, a) => s + a.bytes.byteLength, 0);
    const linkMode = totalAttBytes > Number(env.ATTACHMENT_LINK_THRESHOLD_BYTES);

    // Primary message-size guard. The final MIME size is a campaign-level
    // property (the per-recipient tracking/unsubscribe delta is negligible), so
    // we estimate it once here — before persisting the campaign or fanning out
    // to the queue — and reject oversize mail back to the author. In link mode
    // large attachments are served as links, so they don't count toward the raw
    // size; only inline parts (and html/text) do.
    const sizeParts = inputs.filter((a) => !linkMode || a.disposition === 'inline');
    const estimate = estimateRawSize(text.length, html.length, sizeParts);
    if (estimate > Number(env.MAX_RAW_BYTES)) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'ingest',
        event: 'ingest.rejected',
        newsletterId,
        message: `Rejected: message too large (~${estimate} bytes; limit ${env.MAX_RAW_BYTES})`,
        detail: { reason: 'message_too_large', estimate, limit: Number(env.MAX_RAW_BYTES), linkMode },
      });
      message.setReject(
        `Message too large: estimated ${estimate} bytes exceeds the ${env.MAX_RAW_BYTES}-byte limit. ` +
          'Reduce the content or attachment size and resend.',
      );
      return;
    }

    await env.ARCHIVE.put(`campaigns/${campaignId}/raw.eml`, raw);
    await env.DB
      .prepare(
        'INSERT INTO campaigns (id, newsletter_id, subject, html, text, sent_by, status, attachment_count, attachment_total_bytes, link_mode) ' +
          "VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)",
      )
      .bind(campaignId, newsletterId, subject, html, text, from, inputs.length, totalAttBytes, linkMode ? 1 : 0)
      .run();
    await writeLog(env.DB, {
      source: 'ingest',
      event: 'ingest.campaign_created',
      campaignId,
      newsletterId,
      message: `Campaign created: "${subject}" (${inputs.length} attachment(s)${linkMode ? ', link mode' : ''})`,
      detail: { subject, from, attachments: inputs.length, attachmentBytes: totalAttBytes, linkMode },
    });

    // 6. Store attachments in R2 + D1 (deduped by sha256 within this campaign)
    const seen = new Set<string>();
    for (const a of inputs) {
      const sha = await sha256Hex(a.bytes);
      const key = r2KeyForAttachment(campaignId, sha);
      if (!seen.has(sha)) {
        await putAttachment(env.ARCHIVE, key, a.bytes, {
          filename: a.filename,
          contentType: a.contentType,
          contentId: a.contentId,
        });
        seen.add(sha);
      }
      await env.DB
        .prepare(
          'INSERT INTO attachments (campaign_id, r2_key, filename, content_type, size, sha256, content_id, disposition) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(
          campaignId,
          key,
          a.filename,
          a.contentType,
          a.bytes.byteLength,
          sha,
          a.contentId ?? null,
          a.disposition,
        )
        .run();
    }

    // 7. Enqueue subscriber batches
    const batchSize = Math.max(1, Number(env.BATCH_SIZE));
    let total = 0;
    let batches = 0;
    let buf: Recipient[] = [];
    const flush = async () => {
      if (buf.length === 0) return;
      await env.QUEUE.send({ campaignId, batch: buf });
      total += buf.length;
      batches += 1;
      await writeLog(env.DB, {
        source: 'ingest',
        event: 'queue.enqueued',
        campaignId,
        newsletterId,
        message: `Enqueued batch ${batches} (${buf.length} recipients)`,
        detail: { batch: batches, size: buf.length, batchSize },
      });
      buf = [];
    };
    for await (const s of iterateActiveSubscribers(env.DB, newsletterId)) {
      buf.push({ subscriberId: s.id, email: s.email, name: s.name ?? undefined, token: s.token });
      if (buf.length >= batchSize) await flush();
    }
    await flush();

    await env.DB
      .prepare('UPDATE campaigns SET total_recipients = ? WHERE id = ?')
      .bind(total, campaignId)
      .run();
    await writeLog(env.DB, {
      source: 'ingest',
      event: 'ingest.queued',
      campaignId,
      newsletterId,
      message: total === 0
        ? 'No active subscribers — nothing enqueued'
        : `Queued ${total} recipient(s) across ${batches} batch(es) of ${batchSize}`,
      detail: { total, batches, batchSize },
    });
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

function toUint8(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

function htmlToText(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim();
}
