# Attachments — Complete Reference

This document describes how the newsletter pipeline handles email attachments:
the validation rules applied at ingest, how files are stored, how they reach
recipients (directly or as download links), the security model, and every
configuration knob involved.

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Attachment** | A file attached to an outbound campaign email (PDF, image, etc.). |
| **Inline attachment** | An attachment with `Content-Disposition: inline` — typically an image embedded directly in the HTML body via a `cid:` `<img src>` reference. |
| **Regular (outer) attachment** | An attachment with `Content-Disposition: attachment` — shown as a downloadable file by the mail client. |
| **Link mode** | When total attachment bytes exceed `ATTACHMENT_LINK_THRESHOLD_BYTES`, regular attachments are served as signed download links rather than being embedded in every copy of the email. |
| **R2** | Cloudflare R2 object storage. All attachment bytes (and the original raw `.eml`) are stored here in the `newsletter-archive` bucket. |
| **D1** | Cloudflare D1 SQLite database. Metadata (filename, MIME type, size, SHA-256, R2 key) is stored in the `attachments` table. |
| **SHA-256** | The hexadecimal SHA-256 hash of an attachment's bytes, used to deduplicate identical files within the same campaign. |
| **MIME type** | The file type declaration embedded in the email part (`Content-Type` header), e.g. `application/pdf`, `image/jpeg`. |
| **Content-ID (`cid:`)** | An identifier in the MIME envelope that links an inline attachment to its `<img src="cid:…">` reference in the HTML body. |
| **HMAC signature** | A keyed-hash message authentication code (HMAC-SHA-256) embedded in download URLs to prevent forgery or enumeration. |
| **Signed download URL** | A time-independent URL that encodes the campaign, subscriber, and attachment ID, authenticated by an HMAC over those values. |
| **`raw.eml`** | The original inbound email stored verbatim in R2 as a debugging aid; never sent to subscribers. |
| **Ingest worker** | `workers/ingest` — receives inbound email, validates attachments, archives them, and enqueues subscriber batches. |
| **Consumer worker** | `workers/consumer` — dequeues batches, builds per-recipient MIME, fetches attachment bytes from R2, and sends via Email Sending. |
| **Tracker worker** | `workers/tracker` — authenticates and serves signed download requests; logs a `download` event per access. |

---

## 1. Data model

Attachment metadata lives in the D1 `attachments` table (`db/schema.sql`):

| Column | Purpose |
| --- | --- |
| `id` | Auto-increment primary key. Used in signed download URLs. |
| `campaign_id` | Owning campaign (`ON DELETE CASCADE` — deleted when the campaign is purged by retention). |
| `r2_key` | Object key in the R2 bucket: `campaigns/<campaign_id>/attachments/<sha256>`. |
| `filename` | Sanitized filename (path separators and quotes stripped, max 200 chars). |
| `content_type` | MIME type from the inbound email part. |
| `size` | Byte count of the raw attachment data. |
| `sha256` | Hex SHA-256 of the bytes. Used to deduplicate attachments in the same campaign. |
| `content_id` | `Content-ID` value (stripped of angle brackets), or `NULL`. Used to re-link inline images. |
| `disposition` | `attachment` or `inline`. Governs link-mode exclusion (see §3). |

The raw `.eml` is stored at `campaigns/<campaign_id>/raw.eml` in R2 but has no
D1 row.

---

## 2. Validation at ingest

When a campaign email arrives at the **ingest worker**, attachments are parsed
from the MIME message by PostalMime and then checked in `shared/attachments.ts →
validateAttachments()`. **Any failure causes the inbound message to be rejected
back to the author's mail server** (SMTP 5xx) and logged as `ingest.rejected`.

The checks, in order:

### 2.1 Count cap

```
attachments.length > MAX_ATTACHMENT_COUNT
```

Default: 10. Counting includes both inline and regular attachments.

### 2.2 Per-file size cap

```
attachment.byteLength > MAX_ATTACHMENT_BYTES
```

Default: 10 MiB (10,485,760 bytes). Each file is checked independently.

### 2.3 Blocked extensions

The file extension (last `.`-delimited segment, lowercased) is matched against
`BLOCKED_EXTENSIONS`. Default blocked list: `exe, js, bat, cmd, scr, com, vbs, ps1`.

### 2.4 MIME type allow-list

The `Content-Type` (without parameters) is matched against `ALLOWED_MIME`.
The list supports glob patterns:

- `image/*` — any image subtype.
- `application/pdf` — exact match.

Default: `image/*, application/pdf, text/plain, text/csv, application/zip`.

### 2.5 Total size cap

```
sum(all attachment bytes) > MAX_TOTAL_ATTACHMENT_BYTES
```

Default: 20 MiB (20,971,520 bytes).

### 2.6 Message size estimate

After attachment validation, the ingest worker estimates the final MIME size of
the outgoing message (`shared/mime.ts → estimateRawSize()`). In **link mode**,
regular attachments are counted as zero bytes (they are sent as URLs, not
inline). If the estimate exceeds `MAX_RAW_BYTES` (default 39 MB), the message is
rejected — not an attachment-specific check, but it is the final guard before
archiving.

---

## 3. Link mode

When the **total attachment bytes** (`sum(size)` over all attachments, inline and
regular) exceeds `ATTACHMENT_LINK_THRESHOLD_BYTES` (default 8 MiB), the campaign
is stored with `link_mode = 1`.

In link mode:

- **Inline attachments** — images embedded via `cid:` — are still fetched from
  R2 and attached directly to each email (they are part of the visual body and
  cannot become links).
- **Regular attachments** are **not** included in the MIME envelope. Instead, the
  consumer appends an HTML section listing signed download links:

  ```html
  <hr>
  <p><strong>Attachments:</strong></p>
  <ul>
    <li><a href="https://track.<domain>/a/<campaign>/<sub>/<attId>?sig=…">report.pdf</a> (1234567 bytes)</li>
  </ul>
  ```

  Each link is signed with `ATTACHMENT_SIGNING_KEY` (see §5).

This keeps per-recipient email size manageable for large attachments while
preserving access through authenticated URLs.

---

## 4. Storage in R2

After validation the ingest worker stores:

1. **Raw email**: `campaigns/<campaign_id>/raw.eml` — the full inbound MIME.
2. **Each attachment** at `campaigns/<campaign_id>/attachments/<sha256>`:
   - Object stored with `httpMetadata.contentType` and `customMetadata`
     (`filename`, `content_id`).
   - **Deduplicated within a campaign**: if two attached files have the same
     SHA-256, only one R2 object is written (the D1 rows are separate, both
     pointing to the same key).

The D1 `attachments` rows are written immediately after the R2 puts, still
within the ingest invocation.

---

## 5. Serving attachments to recipients

### 5.1 Direct embedding (non-link-mode)

The **consumer worker** loads each campaign's attachments from D1, fetches their
bytes from R2 via `getAttachmentBytes()`, and passes them to `buildEmail()` as
MIME parts. Every subscriber in the batch receives a full copy of the file.

### 5.2 Signed download links (link mode)

For regular attachments in link mode the consumer does **not** fetch the bytes.
Instead it calls `signDownloadUrl()` (`shared/tracking.ts`) for each attachment:

```
HMAC-SHA-256(ATTACHMENT_SIGNING_KEY, "a|<campaignId>|<subscriberId>|<attachmentId>")
→ https://track.<domain>/a/<campaign>/<sub>/<attId>?sig=<base64url>
```

The payload binds the campaign, subscriber, and attachment ID together — the
same link cannot be replayed for a different subscriber or attachment.

When a subscriber clicks the link:

1. The **tracker worker** verifies the HMAC.
2. Looks up the `attachments` row by `id` + `campaign_id`.
3. Fetches the bytes from R2.
4. Returns the file with the correct `Content-Type` and
   `Content-Disposition: attachment; filename="…"`.
5. Logs a `download` event (`type='download'`, `attachment_id`, `ip`, `ua`).

### 5.3 Inline images (both modes)

Inline attachments (images with a `Content-ID`) are always attached directly,
regardless of link mode. The HTML body already contains `<img src="cid:…">`
references; these are preserved and the matching MIME parts are embedded.

---

## 6. Configuration

Settings resolve from the D1 `settings` table → built-in defaults in
`shared/settings.ts`. Edit them on the console's **Settings → Attachments** tab.

| Setting | Default | Meaning |
| --- | --- | --- |
| `MAX_ATTACHMENT_BYTES` | `10485760` (10 MiB) | Per-file size cap. Files over this are rejected at ingest. |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `20971520` (20 MiB) | Sum of all attachments per campaign. |
| `MAX_ATTACHMENT_COUNT` | `10` | Maximum number of attachments per campaign. |
| `ALLOWED_MIME` | `image/*, application/pdf, text/plain, text/csv, application/zip` | Comma-separated allow-list; `*` and `type/*` wildcards are supported. |
| `BLOCKED_EXTENSIONS` | `exe, js, bat, cmd, scr, com, vbs, ps1` | Comma-separated extension block-list (checked before MIME). |
| `ATTACHMENT_LINK_THRESHOLD_BYTES` | `8388608` (8 MiB) | Total attachment size above which link mode is activated. |
| `MAX_RAW_BYTES` | `39000000` (≈37 MiB) | Final MIME size cap applied after all other checks. |

### Secrets

Two secrets must be set on the **consumer** and **tracker** workers and must be
**identical**:

```bash
(cd workers/consumer && wrangler secret put LINK_SIGNING_KEY)
(cd workers/tracker  && wrangler secret put LINK_SIGNING_KEY)
(cd workers/consumer && wrangler secret put ATTACHMENT_SIGNING_KEY)
(cd workers/tracker  && wrangler secret put ATTACHMENT_SIGNING_KEY)
```

`ATTACHMENT_SIGNING_KEY` signs download URLs; `LINK_SIGNING_KEY` signs click
tracking URLs (see `docs/tracking.md`). Generate with `openssl rand -base64 48`.

---

## 7. Lifecycle and retention

Attachment bytes in R2 and metadata in D1 follow campaign lifetime. When the
**cleanup worker** purges a campaign (see `docs/retention.md`):

1. For each `attachments` row belonging to the campaign, the R2 object at
   `r2_key` is deleted.
2. The raw `.eml` at `campaigns/<campaign_id>/raw.eml` is deleted.
3. `DELETE FROM campaigns WHERE id = ?` cascades and removes all D1
   `attachments` rows (`ON DELETE CASCADE`).

---

## 8. Source map

| Concern | File |
| --- | --- |
| Validation, hashing, R2 helpers | `shared/attachments.ts` |
| MIME size estimation | `shared/mime.ts → estimateRawSize` |
| Signed URL generation | `shared/tracking.ts → signDownloadUrl` |
| Ingest: parse, validate, store | `workers/ingest/src/index.ts` |
| Consumer: fetch, embed, or link-mode | `workers/consumer/src/index.ts → renderRecipientHtml` |
| Tracker: authenticate, serve, log | `workers/tracker/src/index.ts` |
| Schema (`attachments`, `campaigns`) | `db/schema.sql` |
| Settings | `shared/settings.ts`, `web/src/pages/Settings.tsx` |
