import { EmailMessage } from 'cloudflare:email';
import { buildEmail, estimateRawSize, type AttachmentPart } from '../../../shared/mime';
import { getAttachmentBytes } from '../../../shared/attachments';
import { getCampaign, getCampaignAttachments, recordSendSuccess, recordSendFailure, markCampaignCompleteIfDone, writeLog } from '../../../shared/db';
import { instrumentHtml, unsubscribeUrl, signDownloadUrl } from '../../../shared/tracking';
import type { QueueMessage } from '../../../shared/types';
import { readWarmupConfig, currentWindow, delayUntilNextWindow } from '../../../shared/warmup';
import { loadSettings } from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SEND_EMAIL: SendEmail;
  QUEUE: Queue<QueueMessage>;
  FROM_ADDRESS: string;
  TRACKING_BASE_URL: string;
  BOUNCE_DOMAIN: string;
  MAX_RAW_BYTES: string;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
  // Warmup vars (all optional; if WARMUP_START_DATE is unset, no caps apply)
  WARMUP_START_DATE?: string;
  WARMUP_TARGET_WEEKLY?: string;
  WARMUP_SCHEDULE?: string;
  WARMUP_DAILY_CAP_EARLY?: string;
  WARMUP_DAILY_CAP_LATE?: string;
  WARMUP_LATE_START_WEEK?: string;
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    // Resolve tunables (sending identity, size cap, warmup) against the D1
    // `settings` table once per invocation; env vars / defaults are the
    // fallback. Bindings and secrets on `rawEnv` are preserved.
    const env = await loadSettings(rawEnv.DB, rawEnv);

    // Cache campaign + attachments per batch lifetime.
    const cache = new Map<string, { campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>; parts: AttachmentPart[] }>();

    // Warmup: compute caps once per invocation and track local consumption so
    // multiple messages in the same MessageBatch respect the same budget.
    const cfg = readWarmupConfig(env as unknown as Record<string, string | undefined>);
    const win = currentWindow(cfg, new Date());
    let dailyRemaining = Number.POSITIVE_INFINITY;
    let weeklyRemaining = Number.POSITIVE_INFINITY;
    if (win) {
      const [dayCount, weekCount] = await Promise.all([
        countSendsSince(env.DB, win.dayStartSql),
        countSendsSince(env.DB, win.weekStartSql),
      ]);
      dailyRemaining = Math.max(0, win.dailyCap - dayCount);
      weeklyRemaining = Math.max(0, win.weeklyCap - weekCount);
    }

    for (const msg of batch.messages) {
      const { campaignId, batch: recipients } = msg.body;

      await writeLog(env.DB, {
        source: 'consumer',
        event: 'consumer.batch_received',
        campaignId,
        message: `Processing batch of ${recipients.length} recipient(s)`,
        detail: { recipients: recipients.length },
      });

      // Warmup gate: if no capacity, re-queue with delay until next window.
      if (win) {
        const remaining = Math.min(dailyRemaining, weeklyRemaining);
        if (remaining <= 0) {
          const delaySeconds = delayUntilNextWindow(win, dailyRemaining, weeklyRemaining);
          await writeLog(env.DB, {
            level: 'warn',
            source: 'consumer',
            event: 'consumer.throttled',
            campaignId,
            message: `Warmup cap reached — batch re-queued for ${delaySeconds}s`,
            detail: { delaySeconds, dailyRemaining, weeklyRemaining },
          });
          msg.retry({ delaySeconds });
          continue;
        }
        // Partial capacity: split this message and re-enqueue the remainder.
        if (recipients.length > remaining) {
          const overflow = recipients.splice(remaining);
          const delaySeconds = delayUntilNextWindow(win, 0, weeklyRemaining - remaining);
          await env.QUEUE.send(
            { campaignId, batch: overflow },
            { delaySeconds },
          );
          await writeLog(env.DB, {
            source: 'consumer',
            event: 'consumer.split',
            campaignId,
            message: `Partial warmup capacity — sending ${recipients.length}, deferred ${overflow.length} for ${delaySeconds}s`,
            detail: { sending: recipients.length, deferred: overflow.length, delaySeconds },
          });
        }
      }

      try {
        let entry = cache.get(campaignId);
        if (!entry) {
          const campaign = await getCampaign(env.DB, campaignId);
          if (!campaign) throw new Error(`campaign ${campaignId} not found`);
          const atts = await getCampaignAttachments(env.DB, campaignId);
          const parts: AttachmentPart[] = [];
          // Skip attaching files in link mode; only inline images stay attached.
          for (const a of atts) {
            if (campaign.link_mode && a.disposition === 'attachment') continue;
            const bytes = await getAttachmentBytes(env.ARCHIVE, a.r2_key);
            parts.push({
              filename: a.filename,
              contentType: a.content_type,
              bytes,
              contentId: a.content_id ?? undefined,
              disposition: a.disposition,
            });
          }
          entry = { campaign, parts };
          cache.set(campaignId, entry);
        }
        const { campaign, parts } = entry;
        const allAtts = await getCampaignAttachments(env.DB, campaignId); // for link-mode link rendering

        // Pre-flight size guard (estimate; per-recipient adds tracking)
        const estimate = estimateRawSize(
          (campaign.text ?? '').length,
          (campaign.html ?? '').length,
          parts,
        );
        if (estimate > Number(env.MAX_RAW_BYTES)) {
          // Oversize is a permanent, campaign-level condition (normally caught
          // at ingest). Retrying can never succeed, so record the recipients as
          // failed and ack the batch instead of looping into the DLQ.
          const reason = `message too large (${estimate} bytes; limit ${env.MAX_RAW_BYTES})`;
          for (const r of recipients) {
            await recordSendFailure(env.DB, campaignId, r.subscriberId, reason);
          }
          await writeLog(env.DB, {
            level: 'error',
            source: 'consumer',
            event: 'consumer.batch_too_large',
            campaignId,
            message: `Batch dropped — ${reason}`,
            detail: { estimate, limit: Number(env.MAX_RAW_BYTES), recipients: recipients.length },
          });
          await markCampaignCompleteIfDone(env.DB, campaignId);
          msg.ack();
          continue;
        }

        let sentInBatch = 0;
        let failedInBatch = 0;
        for (const r of recipients) {
          try {
            const html = await renderRecipientHtml(env, campaign, allAtts, r.subscriberId);
            const text = campaign.text ?? '';
            const unsubUrl = unsubscribeUrl(env.TRACKING_BASE_URL, r.subscriberId, r.token);
            const messageId = `${crypto.randomUUID()}@${env.BOUNCE_DOMAIN}`;
            // Per-newsletter sender if set, otherwise the global default.
            const fromHeader = campaign.from_address || env.FROM_ADDRESS;
            const fromAddr = extractAddr(fromHeader);
            const returnPath = `bounce+${campaignId}.${r.subscriberId}@${env.BOUNCE_DOMAIN}`;

            const raw = buildEmail({
              from: fromHeader,
              to: r.name ? `${quoteName(r.name)} <${r.email}>` : r.email,
              subject: campaign.subject,
              messageId,
              text,
              html,
              attachments: parts,
              headers: {
                'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe+${r.subscriberId}@${env.BOUNCE_DOMAIN}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'Return-Path': `<${returnPath}>`,
                'X-Campaign-ID': campaignId,
              },
            });

            const email = new EmailMessage(fromAddr, r.email, raw);
            await env.SEND_EMAIL.send(email);
            await recordSendSuccess(env.DB, campaignId, r.subscriberId, messageId);
            sentInBatch++;
            await writeLog(env.DB, {
              source: 'consumer',
              event: 'consumer.send_success',
              campaignId,
              message: `Sent to ${r.email}`,
              detail: { email: r.email, subscriberId: r.subscriberId, messageId },
            });
            // Track warmup consumption for subsequent messages in this batch.
            dailyRemaining--;
            weeklyRemaining--;
          } catch (err) {
            await recordSendFailure(env.DB, campaignId, r.subscriberId, (err as Error).message);
            failedInBatch++;
            await writeLog(env.DB, {
              level: 'error',
              source: 'consumer',
              event: 'consumer.send_failed',
              campaignId,
              message: `Failed to send to ${r.email}: ${(err as Error).message}`,
              detail: { email: r.email, subscriberId: r.subscriberId, error: (err as Error).message },
            });
          }
        }
        await writeLog(env.DB, {
          level: failedInBatch > 0 ? 'warn' : 'info',
          source: 'consumer',
          event: 'consumer.batch_done',
          campaignId,
          message: `Batch complete: ${sentInBatch} sent, ${failedInBatch} failed`,
          detail: { sent: sentInBatch, failed: failedInBatch },
        });
        // Once every recipient has been processed, mark the campaign sent.
        const completed = await markCampaignCompleteIfDone(env.DB, campaignId);
        if (completed) {
          await writeLog(env.DB, {
            source: 'consumer',
            event: 'consumer.campaign_complete',
            campaignId,
            message: 'All recipients processed — campaign marked done',
          });
        }
        msg.ack();
      } catch (err) {
        console.error('batch error', err);
        await writeLog(env.DB, {
          level: 'error',
          source: 'consumer',
          event: 'consumer.batch_error',
          campaignId,
          message: `Batch error — retrying: ${(err as Error).message}`,
          detail: { error: (err as Error).message },
        });
        msg.retry();
      }
    }
  },
};

async function renderRecipientHtml(
  env: Env,
  campaign: { id: string; html: string | null; link_mode: number },
  attachments: Awaited<ReturnType<typeof getCampaignAttachments>>,
  subscriberId: number,
): Promise<string> {
  let html = campaign.html ?? '';
  if (campaign.link_mode) {
    const links: string[] = [];
    for (const a of attachments) {
      if (a.disposition === 'inline') continue;
      const url = await signDownloadUrl(
        env.TRACKING_BASE_URL,
        env.ATTACHMENT_SIGNING_KEY,
        campaign.id,
        subscriberId,
        a.id,
      );
      links.push(`<li><a href="${url}">${escapeHtml(a.filename)}</a> (${a.size} bytes)</li>`);
    }
    if (links.length) {
      html += `<hr><p><strong>Attachments:</strong></p><ul>${links.join('')}</ul>`;
    }
  }
  return await instrumentHtml(html, env.TRACKING_BASE_URL, env.LINK_SIGNING_KEY, campaign.id, subscriberId);
}

function extractAddr(header: string): string {
  const m = header.match(/<([^>]+)>/);
  return m?.[1] ?? header.trim();
}

function quoteName(name: string): string {
  return /[",<>]/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function countSendsSince(db: D1Database, sinceUtc: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?")
    .bind(sinceUtc)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
