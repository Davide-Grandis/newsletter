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
    let details: Record<string, string> | undefined;
    try {
      const body = (await res.json()) as { error?: string; errors?: Record<string, string> };
      if (body?.error) msg = body.error;
      if (body?.errors) details = body.errors;
    } catch {}
    throw new ApiError(msg, res.status, details);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  status: number;
  // Optional per-field error map (e.g. validation failures keyed by field).
  details?: Record<string, string>;
  constructor(msg: string, status: number, details?: Record<string, string>) {
    super(msg);
    this.status = status;
    this.details = details;
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
  hard_bounce_count?: number;
  soft_bounce_count?: number;
  last_bounce_type?: 'hard' | 'soft' | 'block' | null;
  last_bounce_code?: string | null;
  last_bounce_at?: string | null;
  subscribed_at: string;
}

export interface Newsletter {
  id: string;
  name: string;
  inbound_address: string;
  // Optional per-newsletter sender. null => falls back to global FROM_ADDRESS.
  from_address: string | null;
  // Optional per-newsletter footer. null/empty => inherits the global
  // DEFAULT_FOOTER_HTML / DEFAULT_FOOTER_TEXT settings. Only returned by the
  // single-newsletter GET (not the list).
  footer_html?: string | null;
  footer_text?: string | null;
  // Public subscribe slug (used in /subscribe/<slug>) and the per-newsletter
  // switch that enables the public signup page. slug may be null on legacy rows.
  slug?: string | null;
  allow_public_signup?: 0 | 1;
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
  bounce_count: number;
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
  campaign_subject: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: number | string | null;
  total?: number;
}

export interface LogRow {
  kind: 'log' | 'event';
  id: number;
  ts: string;
  level: string;
  source: string;
  event: string;
  campaign_id: string | null;
  campaign_subject: string | null;
  newsletter_id: string | null;
  newsletter_name: string | null;
  subscriber_id: number | null;
  email: string | null;
  message: string | null;
  detail: string | null;
}

export interface Overview {
  subscribers: Array<{ status: string; n: number }>;
  campaigns: { total: number; sent: number; sending: number } | null;
  events_last_7d: Array<{ type: string; n: number }>;
  newsletters: Array<{
    id: string;
    name: string;
    enabled: 0 | 1;
    subscribers: number;
    active: number;
    campaigns: number;
  }>;
}

export interface TimeseriesRow {
  bucket: string;
  type: string;
  n: number;
}

// Real Email Sending usage read from Cloudflare (not the app's own sends table):
// the account daily quota plus per-status sent counts for the sending domain's
// zone over the last 30 days. Each section can independently carry an error.
export interface EmailSendingStats {
  configured: boolean;
  domain: string | null;
  zoneId: string | null;
  quota: { unit: string; value: number } | null;
  quota_error?: string;
  windowStart: string | null;
  windowEnd: string | null;
  total: number;
  today: number;
  byStatus: Record<string, number>;
  stats_error?: string;
  // Demand-driven warmup progression (read from D1, always present).
  warmup: {
    day: number | null;
    started: boolean;
    dayStartedAt: string | null;
    warmupDailyCap: number;
    minDaily: number;
    maxDaily: number;
    totalDays: number;
    dailyCap: number | null;
    dailyCapDate: string | null;
    sentToday: number;
    demand: number;
  };
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

export interface Setting {
  key: string;
  // Effective value in use (db override -> worker env -> built-in default).
  value: string;
  // The stored override, or null when none is set (i.e. falling back).
  stored: string | null;
  // What the value reverts to when the override is cleared (env or default).
  fallback: string;
  source: 'db' | 'env' | 'default';
}
