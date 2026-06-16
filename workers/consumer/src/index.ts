import { EmailMessage } from 'cloudflare:email';
import { buildEmail, estimateRawSize, type AttachmentPart } from '../../../shared/mime';
import { getAttachmentBytes } from '../../../shared/attachments';
import {
  getCampaign,
  getCampaignAttachments,
  recordSendSuccess,
  recordSendFailure,
  markCampaignCompleteIfDone,
  writeLog,
  countSentSince,
  computeDemand,
  loadWarmupState,
  advanceWarmupState,
  saveDailyCap,
} from '../../../shared/db';
import { instrumentHtml, unsubscribeUrl, signDownloadUrl } from '../../../shared/tracking';
import { resolveFooter, renderFooterHtml, renderFooterText } from '../../../shared/footer';
import type { QueueMessage } from '../../../shared/types';
import {
  readWarmupConfig,
  progressWarmup,
  weeklyCapForLevel,
  normalizeDailyCap,
  dayStartSql,
  delayUntilNextWindow,
  type WarmupConfig,
  type WarmupState,
} from '../../../shared/warmup';
import { fetchAccountSendingQuota } from '../../../shared/quota';
import { loadSettings } from '../../../shared/settings';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SEND_EMAIL: SendEmail;
  QUEUE: Queue<QueueMessage>;
  FROM_ADDRESS: string;
  TRACKING_BASE_URL: string;
  TRACKING_ENABLED: string;
  // Global default email footer (used when a newsletter has no footer of its
  // own). Already sanitized when stored via the Settings page.
  DEFAULT_FOOTER_HTML: string;
  DEFAULT_FOOTER_TEXT: string;
  // Bounce/return-path, unsubscribe-by-email and Message-IDs all use the
  // sending domain (formerly a separate BOUNCE_DOMAIN setting).
  BASE_DOMAIN: string;
  MAX_RAW_BYTES: string;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
  // Warmup tunables (settings, with built-in defaults). Warmup is always on.
  WARMUP_TARGET_WEEKLY?: string;
  WARMUP_SCHEDULE?: string;
  WARMUP_FALLBACK_DAILY_CAP?: string;
  // Used to read the account's daily sending quota from the Cloudflare API
  // once per UTC day. ACCESS_ACCOUNT_ID is a setting (resolved from D1);
  // CF_READ_API_TOKEN is a Worker secret. If either is missing, the warmup
  // daily cap falls back to WARMUP_FALLBACK_DAILY_CAP.
  ACCESS_ACCOUNT_ID?: string;
  CF_READ_API_TOKEN?: string;
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    // Resolve tunables (sending identity, size cap, warmup) against the D1
    // `settings` table once per invocation; env vars / defaults are the
    // fallback. Bindings and secrets on `rawEnv` are preserved.
    const env = await loadSettings(rawEnv.DB, rawEnv);

    // Cache campaign + attachments per batch lifetime.
    const cache = new Map<string, { campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>; parts: AttachmentPart[] }>();

    // Warmup is always on. Compute caps once per invocation and track local
    // consumption so multiple messages in the same MessageBatch share the
    // same budget.
    const cfg = readWarmupConfig(env as unknown as Record<string, string | undefined>);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Daily cap: read the account quota from the Cloudflare API once per UTC
    // day (cached in warmup_state), before processing the queue.
    let state = await loadWarmupState(env.DB);
    const dailyCap = await ensureDailyCap(env, state, todayStr, cfg);

    // Demand-driven progression: advance at most one level per 7-day window,
    // and only when the backlog has grown to the next level's threshold.
    const demand = await computeDemand(env.DB);
    const prog = progressWarmup(state, demand, now, cfg);
    if (prog.changed) {
      const won = await advanceWarmupState(
        env.DB,
        { level: prog.level, weekStartedAt: prog.weekStartedAt },
        state.weekStartedAt,
      );
      state = won
        ? { ...state, level: prog.level, weekStartedAt: prog.weekStartedAt }
        : await loadWarmupState(env.DB);
    }

    const weeklyCap = weeklyCapForLevel(cfg, state.level);
    const dayStart = dayStartSql(now);
    const weekStart = state.weekStartedAt ?? dayStart;
    const weekStartMs = Date.parse(weekStart.replace(' ', 'T') + 'Z');
    const [sentToday, sentThisWeek] = await Promise.all([
      countSentSince(env.DB, dayStart),
      countSentSince(env.DB, weekStart),
    ]);
    let dailyRemaining = Math.max(0, dailyCap - sentToday);
    let weeklyRemaining = Math.max(0, weeklyCap - sentThisWeek);

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
      const remaining = Math.min(dailyRemaining, weeklyRemaining);
      if (remaining <= 0) {
        const delaySeconds = delayUntilNextWindow(weekStartMs, weeklyRemaining, now);
        await writeLog(env.DB, {
          level: 'warn',
          source: 'consumer',
          event: 'consumer.throttled',
          campaignId,
          message: `Warmup cap reached — batch re-queued for ${delaySeconds}s`,
          detail: { delaySeconds, dailyRemaining, weeklyRemaining, level: state.level, weeklyCap, dailyCap },
        });
        msg.retry({ delaySeconds });
        continue;
      }
      // Partial capacity: split this message and re-enqueue the remainder.
      if (recipients.length > remaining) {
        const overflow = recipients.splice(remaining);
        const delaySeconds = delayUntilNextWindow(weekStartMs, weeklyRemaining - remaining, now);
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
            let html = await renderRecipientHtml(env, campaign, allAtts, r.subscriberId);
            let text = campaign.text ?? '';
            const unsubUrl = unsubscribeUrl(env.TRACKING_BASE_URL, r.subscriberId, r.token);
            // Append the footer AFTER tracking instrumentation so its
            // unsubscribe/author links are never click-rewritten. The footer is
            // per-newsletter, falling back to the global default; the renderers
            // guarantee an unsubscribe link even if the {{unsubscribe_url}}
            // token is omitted. Stored footers are already sanitized.
            const footerVars = {
              unsubscribe_url: unsubUrl,
              newsletter_name: campaign.newsletter_name ?? '',
              email: r.email,
            };
            const footerHtmlTpl = resolveFooter(campaign.footer_html, env.DEFAULT_FOOTER_HTML);
            if (footerHtmlTpl.trim() !== '') {
              html += '\n' + renderFooterHtml(footerHtmlTpl, footerVars);
            }
            const footerTextTpl = resolveFooter(campaign.footer_text, env.DEFAULT_FOOTER_TEXT);
            if (footerTextTpl.trim() !== '') {
              text += (text && !text.endsWith('\n') ? '\n\n' : '') + renderFooterText(footerTextTpl, footerVars);
            }
            const messageId = `${crypto.randomUUID()}@${env.BASE_DOMAIN}`;
            // Per-newsletter sender if set, otherwise the global default.
            const fromHeader = campaign.from_address || env.FROM_ADDRESS;
            const fromAddr = extractAddr(fromHeader);
            const returnPath = `bounce+${campaignId}.${r.subscriberId}@${env.BASE_DOMAIN}`;

            const raw = buildEmail({
              from: fromHeader,
              to: r.name ? `${quoteName(r.name)} <${r.email}>` : r.email,
              subject: campaign.subject,
              messageId,
              text,
              html,
              attachments: parts,
              headers: {
                'List-Unsubscribe': `<${unsubUrl}>, <mailto:unsubscribe+${r.subscriberId}@${env.BASE_DOMAIN}>`,
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
  // Open/click tracking is optional. When disabled, links are left pointing at
  // their original destinations and no open pixel is added. Link-mode download
  // links above are unaffected — they deliver the attachments themselves.
  if (env.TRACKING_ENABLED === 'false') return html;
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

/**
 * Returns the warmup daily cap, reading the account's quota from the Cloudflare
 * API at most once per UTC day (cached in `warmup_state`). On a fresh read the
 * passed `state` is mutated so the rest of the invocation sees the new value.
 * Falls back to the last cached value or the configured fallback when the token
 * or account is missing, or the API call fails.
 */
async function ensureDailyCap(
  env: Env,
  state: WarmupState,
  todayStr: string,
  cfg: WarmupConfig,
): Promise<number> {
  if (state.dailyCap != null && state.dailyCapDate === todayStr) return state.dailyCap;
  const token = env.CF_READ_API_TOKEN;
  const account = env.ACCESS_ACCOUNT_ID;
  if (token && account) {
    try {
      const quota = await fetchAccountSendingQuota(token, account);
      const cap = normalizeDailyCap(quota, cfg.fallbackDailyCap);
      await saveDailyCap(env.DB, cap, todayStr);
      state.dailyCap = cap;
      state.dailyCapDate = todayStr;
      return cap;
    } catch (err) {
      await writeLog(env.DB, {
        level: 'warn',
        source: 'consumer',
        event: 'consumer.quota_fetch_failed',
        message: `Daily quota fetch failed: ${(err as Error).message}`,
        detail: { error: (err as Error).message },
      });
    }
  }
  return state.dailyCap ?? cfg.fallbackDailyCap;
}
