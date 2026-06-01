// Tiny API client. Authentication is handled entirely by Cloudflare Access at
// the edge: the browser presents the Access cookie automatically (same origin
// as the SPA), and the worker rejects any request that does not carry the
// `Cf-Access-Authenticated-User-Email` header that Access injects after a
// successful login. No bearer token is involved.

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new ApiError('unauthorized', 401);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {}
    throw new ApiError(msg, res.status);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  constructor(msg: string, status: number) {
    super(msg);
    this.status = status;
  }
}

// ----------------- shapes (loose; the worker is the source of truth) ---

export interface Subscriber {
  id: number;
  email: string;
  name: string | null;
  verified: 0 | 1;
  status: 'active' | 'unsubscribed' | 'bounced' | 'complained';
  bounce_count: number;
  subscribed_at: string;
}

export interface Newsletter {
  id: string;
  name: string;
  inbound_address: string;
  enabled: 0 | 1;
  created_at: string;
  subscriber_count?: number;
  active_count?: number;
  author_count?: number;
}

export interface Campaign {
  id: string;
  newsletter_id?: string;
  newsletter_name?: string | null;
  subject: string;
  status: string;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  attachment_count: number;
  link_mode: 0 | 1;
  created_at: string;
  attachment_total_bytes?: number;
  sent_by?: string;
}

export interface CampaignDetail {
  campaign: Campaign;
  events: Array<{ type: string; n: number }>;
  attachments: Array<{
    id: number;
    filename: string;
    content_type: string;
    size: number;
    disposition: 'attachment' | 'inline';
  }>;
}

export interface Send {
  id: number;
  subscriber_id: number;
  email: string | null;
  status: 'sent' | 'failed' | 'queued';
  sent_at: string | null;
  error: string | null;
  message_id: string | null;
}

export interface BounceEvent {
  id: number;
  campaign_id: string;
  subscriber_id: number;
  email: string | null;
  status_code: string | null;
  ts: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | string | null;
}

export interface Overview {
  subscribers: Array<{ status: string; n: number }>;
  campaigns: { total: number; sent: number; sending: number } | null;
  events_last_7d: Array<{ type: string; n: number }>;
}

export interface TimeseriesRow {
  bucket: string;
  type: string;
  n: number;
}

export interface Author {
  email: string;
  name: string | null;
  created_at: string;
}

export interface Help {
  content: string;
  updated: string | null;
}

export type Quota =
  | { enabled: false; target: number }
  | {
      enabled: true;
      weekIndex: number;
      dailyCap: number;
      dailyUsed: number;
      dailyRemaining: number;
      weeklyCap: number;
      weeklyUsed: number;
      weeklyRemaining: number;
      target: number;
      windowStart: string;
      dayWindowStart: string;
    };
