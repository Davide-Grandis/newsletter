// Attachment validation, hashing, and R2 helpers.

export interface AttachmentInput {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId?: string;
  disposition: 'attachment' | 'inline';
}

export interface AttachmentLimits {
  maxBytes: number;
  maxTotalBytes: number;
  maxCount: number;
  allowedMime: string[];     // e.g. ['image/*','application/pdf']
  blockedExt: string[];      // e.g. ['exe','js','bat','cmd','scr']
}

export function validateAttachments(items: AttachmentInput[], limits: AttachmentLimits): void {
  if (items.length > limits.maxCount) {
    throw new Error(`Too many attachments (${items.length} > ${limits.maxCount})`);
  }
  let total = 0;
  for (const a of items) {
    if (a.bytes.byteLength > limits.maxBytes) {
      throw new Error(`Attachment ${a.filename} too large (${a.bytes.byteLength}B)`);
    }
    total += a.bytes.byteLength;
    const ext = (a.filename.split('.').pop() || '').toLowerCase();
    if (limits.blockedExt.includes(ext)) {
      throw new Error(`Blocked extension: .${ext}`);
    }
    if (!mimeAllowed(a.contentType, limits.allowedMime)) {
      throw new Error(`Disallowed MIME type: ${a.contentType}`);
    }
  }
  if (total > limits.maxTotalBytes) {
    throw new Error(`Total attachment size ${total}B exceeds ${limits.maxTotalBytes}B`);
  }
}

function mimeAllowed(ct: string, allowed: string[]): boolean {
  const [type] = ct.split(';');
  if (!type) return false;
  const t = type.trim().toLowerCase();
  return allowed.some((p) => {
    const pat = p.trim().toLowerCase();
    if (pat === '*' || pat === '*/*') return true;
    if (pat.endsWith('/*')) return t.startsWith(pat.slice(0, -1));
    return t === pat;
  });
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[\r\n"\\/]/g, '_').slice(0, 200);
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(buf);
  let out = '';
  for (const b of arr) out += b.toString(16).padStart(2, '0');
  return out;
}

export function r2KeyForAttachment(campaignId: string, sha256: string): string {
  return `campaigns/${campaignId}/attachments/${sha256}`;
}

export async function putAttachment(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  meta: { filename: string; contentType: string; contentId?: string },
): Promise<void> {
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: meta.contentType },
    customMetadata: {
      filename: meta.filename,
      contentId: meta.contentId ?? '',
    },
  });
}

export async function getAttachmentBytes(bucket: R2Bucket, key: string): Promise<Uint8Array> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`Attachment missing: ${key}`);
  const buf = await obj.arrayBuffer();
  return new Uint8Array(buf);
}
