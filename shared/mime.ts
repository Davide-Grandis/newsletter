// Build a multipart/mixed (+ multipart/related, + multipart/alternative) MIME message
// with attachments and inline parts. Implemented from scratch (no Node deps) so it runs
// on Workers.

export interface AttachmentPart {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  contentId?: string;
  disposition: 'attachment' | 'inline';
}

export interface BuildEmailInput {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
  attachments: AttachmentPart[];
}

const CRLF = '\r\n';

function boundary(prefix: string): string {
  const r = crypto.getRandomValues(new Uint8Array(12));
  let s = '';
  for (const b of r) s += b.toString(16).padStart(2, '0');
  return `${prefix}_${s}`;
}

function b64(bytes: Uint8Array): string {
  // chunked to stay safe with large inputs
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const out = btoa(bin);
  return out.match(/.{1,76}/g)?.join(CRLF) ?? out;
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for non-ASCII subjects/filenames.
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  const utf8 = new TextEncoder().encode(value);
  let bin = '';
  for (const b of utf8) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

function quotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let lineLen = 0;
  const push = (s: string) => {
    if (lineLen + s.length > 75) {
      out += `=${CRLF}`;
      lineLen = 0;
    }
    out += s;
    lineLen += s.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0a) {
      out += CRLF;
      lineLen = 0;
    } else if (b === 0x0d) {
      // skip; will be handled by next \n
    } else if (b === 0x3d || b < 0x20 || b > 0x7e) {
      push(`=${b.toString(16).toUpperCase().padStart(2, '0')}`);
    } else {
      push(String.fromCharCode(b));
    }
  }
  return out;
}

export function buildEmail(input: BuildEmailInput): string {
  const mixed = boundary('mixed');
  const related = boundary('related');
  const alt = boundary('alt');

  const inlineParts = input.attachments.filter((a) => a.disposition === 'inline');
  const fileParts = input.attachments.filter((a) => a.disposition === 'attachment');

  const lines: string[] = [];
  lines.push(`From: ${input.from}`);
  lines.push(`To: ${input.to}`);
  lines.push(`Subject: ${encodeHeader(input.subject)}`);
  lines.push(`Message-ID: <${input.messageId}>`);
  lines.push('MIME-Version: 1.0');
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    lines.push(`${k}: ${v}`);
  }
  lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
  lines.push('');

  // multipart/mixed -> multipart/related
  lines.push(`--${mixed}`);
  lines.push(`Content-Type: multipart/related; boundary="${related}"`);
  lines.push('');

  // multipart/related -> multipart/alternative
  lines.push(`--${related}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
  lines.push('');

  // text/plain
  lines.push(`--${alt}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: quoted-printable');
  lines.push('');
  lines.push(quotedPrintable(input.text));
  lines.push('');

  // text/html
  lines.push(`--${alt}`);
  lines.push('Content-Type: text/html; charset=UTF-8');
  lines.push('Content-Transfer-Encoding: quoted-printable');
  lines.push('');
  lines.push(quotedPrintable(input.html));
  lines.push('');

  lines.push(`--${alt}--`);
  lines.push('');

  // inline parts (referenced by cid:)
  for (const a of inlineParts) {
    lines.push(`--${related}`);
    lines.push(`Content-Type: ${a.contentType}; name="${encodeHeader(a.filename)}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: inline; filename="${encodeHeader(a.filename)}"`);
    if (a.contentId) lines.push(`Content-ID: <${a.contentId}>`);
    lines.push('');
    lines.push(b64(a.bytes));
    lines.push('');
  }
  lines.push(`--${related}--`);
  lines.push('');

  // attachments
  for (const a of fileParts) {
    lines.push(`--${mixed}`);
    lines.push(`Content-Type: ${a.contentType}; name="${encodeHeader(a.filename)}"`);
    lines.push('Content-Transfer-Encoding: base64');
    lines.push(`Content-Disposition: attachment; filename="${encodeHeader(a.filename)}"`);
    lines.push('');
    lines.push(b64(a.bytes));
    lines.push('');
  }
  lines.push(`--${mixed}--`);
  lines.push('');

  return lines.join(CRLF);
}

// Rough size estimate of the final raw MIME (base64 overhead ~+33%).
export function estimateRawSize(textBytes: number, htmlBytes: number, attachments: AttachmentPart[]): number {
  let total = textBytes + htmlBytes + 2048; // headers + boundaries fudge
  for (const a of attachments) total += Math.ceil(a.bytes.byteLength * 4 / 3) + 512;
  return total;
}
