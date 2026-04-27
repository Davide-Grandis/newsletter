import { EmailMessage } from 'cloudflare:email';
import { buildEmail, estimateRawSize, type AttachmentPart } from '../../../shared/mime';
import { getAttachmentBytes } from '../../../shared/attachments';
import { getCampaign, getCampaignAttachments, recordSendSuccess, recordSendFailure } from '../../../shared/db';
import { instrumentHtml, unsubscribeUrl, signDownloadUrl } from '../../../shared/tracking';
import type { QueueMessage } from '../../../shared/types';

export interface Env {
  DB: D1Database;
  ARCHIVE: R2Bucket;
  SEND_EMAIL: SendEmail;
  FROM_ADDRESS: string;
  TRACKING_BASE_URL: string;
  BOUNCE_DOMAIN: string;
  MAX_RAW_BYTES: string;
  LINK_SIGNING_KEY: string;
  ATTACHMENT_SIGNING_KEY: string;
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    // Cache campaign + attachments per campaignId for the lifetime of this batch.
    const cache = new Map<string, { campaign: NonNullable<Awaited<ReturnType<typeof getCampaign>>>; parts: AttachmentPart[] }>();

    for (const msg of batch.messages) {
      const { campaignId, batch: recipients } = msg.body;
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
          throw new Error(`message too large (${estimate} bytes)`);
        }

        for (const r of recipients) {
          try {
            const html = await renderRecipientHtml(env, campaign, allAtts, r.subscriberId);
            const text = campaign.text ?? '';
            const unsubUrl = unsubscribeUrl(env.TRACKING_BASE_URL, r.subscriberId, r.token);
            const messageId = `${crypto.randomUUID()}@${env.BOUNCE_DOMAIN}`;
            const fromHeader = env.FROM_ADDRESS;
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
          } catch (err) {
            await recordSendFailure(env.DB, campaignId, r.subscriberId, (err as Error).message);
          }
        }
        msg.ack();
      } catch (err) {
        console.error('batch error', err);
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
