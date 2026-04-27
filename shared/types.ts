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
