export interface QueueMessage {
  campaignId: string;
  batch: Recipient[];
}

export interface Recipient {
  subscriberId: number;
  email: string;
  name?: string;
  token: string;
}

export interface CampaignRow {
  id: string;
  subject: string;
  html: string | null;
  text: string | null;
  sent_by: string;
  status: string;
  link_mode: number;
  // Per-newsletter sender resolved via the campaign's newsletter. NULL means
  // fall back to the global FROM_ADDRESS setting.
  from_address: string | null;
  // The campaign's newsletter, used to resolve and personalise the footer.
  newsletter_id: string;
  newsletter_name: string | null;
  // Per-newsletter footer; NULL/empty falls back to the DEFAULT_FOOTER_* settings.
  footer_html: string | null;
  footer_text: string | null;
}

export interface AttachmentRow {
  id: number;
  campaign_id: string;
  r2_key: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  content_id: string | null;
  disposition: 'attachment' | 'inline';
}
