// Reads the account's resolved daily sending quota from the Cloudflare Email
// Sending REST API. Shared by the admin worker (to display it) and the consumer
// worker (which caches it once per UTC day to drive the warmup daily cap).

const CF_API = 'https://api.cloudflare.com/client/v4';

export interface SendingQuota {
  /** 'day' | 'hour' — the period the value applies to. */
  unit: string;
  /** The quota limit for that period. */
  value: number;
}

/**
 * Fetch the resolved daily sending quota for an account. Returns `null` when
 * Cloudflare has not assigned a quota yet (the API reports it as null), and
 * throws on transport/permission errors so the caller can fall back.
 */
export async function fetchAccountSendingQuota(
  token: string,
  accountId: string,
): Promise<SendingQuota | null> {
  const res = await fetch(`${CF_API}/accounts/${accountId}/email/sending/limits`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const msg =
      (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const q = body?.result?.quota;
  return q && typeof q.value === 'number' ? { unit: String(q.unit), value: q.value } : null;
}
