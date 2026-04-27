// HMAC-signed tracking URL helpers (Web Crypto, runs on Workers).

const enc = new TextEncoder();

async function hmac(keyStr: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64url(new Uint8Array(sig));
}

export async function verifyHmac(keyStr: string, data: string, sig: string): Promise<boolean> {
  const expected = await hmac(keyStr, data);
  // constant-time-ish compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function signClickUrl(
  base: string,
  key: string,
  campaignId: string,
  subscriberId: number,
  target: string,
): Promise<string> {
  const u = encodeURIComponent(target);
  const data = `c|${campaignId}|${subscriberId}|${u}`;
  const sig = await hmac(key, data);
  return `${base}/c/${campaignId}/${subscriberId}?u=${u}&sig=${sig}`;
}

export async function signDownloadUrl(
  base: string,
  key: string,
  campaignId: string,
  subscriberId: number,
  attachmentId: number,
): Promise<string> {
  const data = `a|${campaignId}|${subscriberId}|${attachmentId}`;
  const sig = await hmac(key, data);
  return `${base}/a/${campaignId}/${subscriberId}/${attachmentId}?sig=${sig}`;
}

export function pixelUrl(base: string, campaignId: string, subscriberId: number): string {
  return `${base}/o/${campaignId}/${subscriberId}.gif`;
}

export function unsubscribeUrl(base: string, subscriberId: number, token: string): string {
  return `${base}/u/${subscriberId}?t=${encodeURIComponent(token)}`;
}

// Rewrite all <a href="..."> in HTML to signed click URLs and append the open pixel.
export async function instrumentHtml(
  html: string,
  base: string,
  key: string,
  campaignId: string,
  subscriberId: number,
): Promise<string> {
  const out: string[] = [];
  let last = 0;
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = m[1];
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const signed = await signClickUrl(base, key, campaignId, subscriberId, url);
    out.push(html.slice(last, m.index), `href="${signed}"`);
    last = m.index + m[0].length;
  }
  out.push(html.slice(last));
  const pixel = `<img src="${pixelUrl(base, campaignId, subscriberId)}" width="1" height="1" alt="" style="display:none">`;
  return out.join('') + pixel;
}
