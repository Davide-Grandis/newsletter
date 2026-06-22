# Worker Deep Dives

Detailed walkthrough of every worker: what it does, why, and how it
interacts with the rest of the system.

## Ingest Worker

`workers/ingest/src/index.ts`

### Purpose

The entry point of the whole pipeline. The author writes an email to
`newsletter@yourdomain.com` and Cloudflare Email Routing hands the message
to this worker's `email()` handler. Its job is to: authenticate the sender,
parse the MIME, validate and persist any attachments, and fan the recipient
list out to the queue. Anything it accepts becomes a campaign that *will*
be sent — so this is the security boundary of the system.

### Step by step

**1. Authenticate the author.**

```ts
const from = (message.from ?? '').toLowerCase();
const row = await env.DB
  .prepare('SELECT 1 AS ok FROM authors WHERE email = ? LIMIT 1')
  .bind(from)
  .first();
if (!row) { message.setReject('Sender not authorized'); return; }
const authResults = (message.headers.get('authentication-results') ?? '').toLowerCase();
if (!/spf=pass/.test(authResults) || !/dkim=pass/.test(authResults)) {
  message.setReject('SPF/DKIM verification failed');
  return;
}
```

Two gates: the From header must match a row in the D1 `authors` table
(case-insensitive — managed via the admin worker's `/api/authors` CRUD or
the GUI's *Authors* page), **and** Cloudflare's own `Authentication-Results`
header must show `spf=pass` and `dkim=pass`. The allow-list alone is not
enough because From is forgeable; SPF + DKIM prove the message really
originated from the claimed domain.

**2. Read and parse the raw MIME** with `postal-mime` to get subject, html,
text, and `attachments[]` (each with filename, mimeType, bytes,
contentId, and `disposition: 'attachment' | 'inline'`).

**3. Validate attachments** against `AttachmentLimits` from env vars:
per-file size, total size, count, allowed MIME, blocked extensions. If
anything fails, the message is rejected with a bounce-back to the author —
no campaign is created.

**4. Decide attach-mode vs. link-mode.**

```ts
const linkMode = totalAttBytes > Number(env.ATTACHMENT_LINK_THRESHOLD_BYTES);
```

If total attachment bytes exceed `ATTACHMENT_LINK_THRESHOLD_BYTES` (default
8 MB), the campaign is flagged `link_mode = 1`. The consumer will then
*not* attach the files but render signed download URLs in the HTML
instead, served by the tracker worker. This keeps the per-recipient MIME
under Email Sending size limits.

**5. Persist + archive.** Inserts `campaigns(status='sending', ...)`,
uploads the raw `.eml` to R2 at `campaigns/<id>/raw.eml`, and inserts one
`attachments` row per file. Bytes are deduped per campaign by SHA-256 (so
the same image embedded twice only stores once in R2).

**6. Fan-out via queue.** Streams active subscribers using the keyset-
paginated `iterateActiveSubscribers` generator (no full-table loads),
buffers them into chunks of `BATCH_SIZE`, and `env.QUEUE.send(...)` each
batch as `{ campaignId, batch: Recipient[] }`. Attachments are **never**
embedded in the queue message — only the `campaignId` — because Queue
messages are capped at 128 KB. The consumer pulls attachment bytes from R2
once per batch.

**7. Finalize** by writing `total_recipients` so the admin dashboard has a
denominator for `sent_count` and `failed_count`.

### Failure modes

- **Unauthorized sender or auth fail** → `message.setReject(...)`, sender
  gets an NDR, no DB writes happen.
- **Bad attachment** → same: rejected before any DB or R2 writes.
- **Partial failure mid-fan-out** (e.g. queue write fails after some
  batches enqueued): the campaign is left in `status='sending'` with
  partial recipients. The consumer keeps draining what was enqueued; an
  operator can re-enqueue the missing tail using the admin worker.

### Why these decisions

- **Reject early, write late**: validation runs before any R2 or D1
  writes, so a malformed email leaves no garbage state.
- **Streaming subscribers**: a list of 500k subscribers would never fit in
  Worker memory, and `OFFSET` pagination degrades quadratically — keyset
  is O(n).
- **Link-mode toggle in ingest, not consumer**: the decision is recorded
  once on the campaign row, so every queue message for that campaign
  agrees, and consumer retries are deterministic.

---

## Consumer Worker

`workers/consumer/src/index.ts`

### Purpose

The send engine. It pulls recipient batches off the queue, materializes a
full per-recipient MIME message (with personalized tracking links and any
attachments), and hands it to the `SEND_EMAIL` Email Sending (beta)
binding. It is also where idempotency is enforced — retries must not
double-send.

### Step by step

**1. Cache campaign + attachments per batch.**

```ts
const cache = new Map<string, { campaign, parts: AttachmentPart[] }>();
```

A queue invocation can deliver up to `max_batch_size: 10` messages, often
all for the same `campaignId`. The worker loads the campaign row + all
attachments + all R2 bytes **once** and reuses them across every recipient
in the invocation. R2 reads are the most expensive thing in the hot path,
so this caching matters.

In `link_mode`, `disposition='attachment'` files are *not* loaded into the
parts array — they'll be linked, not embedded — but `inline` files (e.g.
images referenced by `cid:`) are still loaded and attached so the HTML
renders correctly.

**2. Pre-flight size guard.**

```ts
const estimate = estimateRawSize((campaign.text??'').length, (campaign.html??'').length, parts);
if (estimate > Number(env.MAX_RAW_BYTES)) throw new Error(`message too large`);
```

`estimateRawSize` accounts for the ~33 % base64 overhead of attachments.
Failing fast here is cheaper than letting `SEND_EMAIL` reject every
recipient individually.

**3. Per recipient: render personalized HTML.** `renderRecipientHtml`:
- if `link_mode`, appends an `<ul>` of `<a>` links to signed download
  URLs (`/a/:campaign/:sub/:attId?sig=...`) — each URL is HMAC-signed
  with `ATTACHMENT_SIGNING_KEY` so subscriber A cannot fetch subscriber
  B's URL;
- runs `instrumentHtml` to rewrite every `href="..."` into a signed click
  URL and append the open pixel.

**4. Per recipient: build MIME** with `shared/mime.ts` which produces:

```
multipart/mixed
├── multipart/related
│   ├── multipart/alternative
│   │   ├── text/plain (quoted-printable)
│   │   └── text/html  (quoted-printable, instrumented)
│   └── inline images (base64, Content-ID: <cid>)
└── attachments (base64, Content-Disposition: attachment)
```

Plus headers: `Message-ID`, `List-Unsubscribe` (with both URL and mailto),
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058 — required
by Gmail/Yahoo bulk-sender rules).

**5. Send.**

```ts
await env.SEND_EMAIL.send(new EmailMessage(fromAddr, r.email, raw));
await recordSendSuccess(env.DB, campaignId, r.subscriberId, messageId);
```

`recordSendSuccess` is an idempotent upsert keyed on `UNIQUE(campaign_id,
subscriber_id)` — so even if the queue redelivers the same batch, we
don't double-count `sent_count`.

**6. Error handling per recipient vs. per batch.**

```ts
try { /* per recipient */ }
catch (err) { await recordSendFailure(env.DB, campaignId, r.subscriberId, msg); }
// after all recipients in the message:
msg.ack();
// only on outer / setup error:
msg.retry();
```

A recipient-level error (one bad address, one quota error) is logged to
`sends` and **does not** cause a queue retry — otherwise the other 99
recipients in the batch would be re-sent. Only a setup-level failure
(can't load campaign, can't reach D1, size guard tripped) causes
`msg.retry()`. After `max_retries: 3`, the batch flows to `newsletter-dlq`
for manual replay.

### Why these decisions

- **Caching campaign and attachments per batch**: amortizes D1 + R2 cost.
- **Idempotent upserts on `sends`**: queue redelivery is a fact of life
  ("at-least-once"); the DB schema makes it safe.
- **Per-recipient try/catch + outer try/catch**: distinguishes "this
  recipient is bad" (don't retry) from "this batch can't run yet"
  (retry).
- **Pre-flight size estimate**: a 40 MB MIME would just be rejected by
  Email Sending anyway; failing in our code lets us mark the campaign
  failed cleanly and surface a useful error.

---

## Tracker Worker

`workers/tracker/src/index.ts`

### Purpose

A public HTTP endpoint reachable from email clients. Every personalized
URL the consumer embeds — open pixel, click redirect, attachment download
in link-mode, unsubscribe — comes back here. It logs the event to D1 and
returns the appropriate response (image, redirect, file, or HTML page).

### Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/o/:campaign/:sub.gif` | open tracking pixel |
| GET | `/c/:campaign/:sub?u=<url>&sig=...` | signed click redirect |
| GET | `/a/:campaign/:sub/:attId?sig=...` | signed attachment download (link-mode) |
| GET | `/u/:sub?t=<token>` | unsubscribe confirmation page |
| POST | `/u/:sub` | one-click unsubscribe (RFC 8058) |

### How URLs are signed

Click and download URLs carry an HMAC over the tuple
`(kind | campaignId | subscriberId | target)` using `LINK_SIGNING_KEY` or
`ATTACHMENT_SIGNING_KEY` respectively. The tracker recomputes the HMAC
and compares with constant-time-ish equality (`shared/tracking.ts:18-24`).

Why HMAC instead of just an opaque ID? Two reasons:
1. **Stateless**: no DB lookup needed to validate a URL — the worker can
   accept or reject solely from the request itself, so it scales
   linearly with traffic.
2. **Tamper-proof**: a recipient can't swap `subscriberId=42` to
   `subscriberId=43` and download someone else's attachment.

The unsubscribe endpoint uses the simpler `subscribers.token` (random per
subscriber) instead of HMAC because we need to look up the row anyway.

### Open pixel

Returns a hard-coded 43-byte transparent GIF and logs `events(type='open')`
via `ctx.waitUntil` so the response itself isn't blocked on D1. Many mail
clients pre-fetch images to "warm" the cache, which inflates open
counts — a known limitation of pixel tracking.

### Click redirect

Verifies the signature, logs `events(type='click', url=<target>)`, then
issues a 302 to the original URL. If the signature is bad, returns 403
with no logging — so probing the endpoint costs an attacker a wasted
request.

### Attachment download (link-mode only)

Verifies the HMAC, looks up the attachment by `(id, campaign_id)` (the
composite is important — prevents id enumeration across campaigns),
streams the bytes from R2 with the original `Content-Type` and
`Content-Disposition: attachment; filename=...`, and logs
`events(type='download', attachment_id=...)`.

### Unsubscribe

`GET /u/:sub?t=<token>` renders a tiny confirmation form. `POST /u/:sub`
either takes the token from the query or the form body, validates it
against `subscribers.token`, sets `status='unsubscribed'`, and logs an
event. The `POST` shape is required by RFC 8058 / Gmail's
`List-Unsubscribe-Post: List-Unsubscribe=One-Click` — Gmail sends a POST
with body `List-Unsubscribe=One-Click` directly when the user clicks the
"Unsubscribe" UI in the inbox.

---

## Bounce Worker

`workers/bounce/src/index.ts`

### Purpose

Two responsibilities: (1) process `List-Unsubscribe` mailto replies from
subscribers, and (2) periodically query the Cloudflare Email Sending
GraphQL API for delivery failures and record them as bounces.

### Email handler — mailto unsubscribes

The bounce worker is the catch-all inbound route. Inbound mail addressed
to `unsubscribe+<subscriberId>@<domain>` (advertised in `List-Unsubscribe`
headers by the consumer) is handled here:

1. Match `unsubscribe+(⧘+)@` in `message.to`.
2. `UPDATE subscribers SET status='unsubscribed'` where `id = <sub> AND status = 'active'`.
3. If a row changed, insert `events(type='unsubscribe')`.

All other inbound mail is silently dropped (no state mutation).

### Scheduled handler — GraphQL delivery-failure sync

The `emailSendingAdaptive` GraphQL query is **zone-wide** (it returns delivery
failures for every campaign at once), so the worker uses a single global
counter — `bounce_check_state.checks_to_go` — rather than a per-campaign
schedule. The cron fires every **10 minutes**. Each tick:

1. **Top up**: if any campaign sent within the last ~15 min, reset
   `checks_to_go` to **18** (capped — never higher). A still-sending campaign
   keeps the counter topped up; the 3-hour countdown begins once sending stops.
2. **Sync**: if `checks_to_go > 0`, or once daily at 04:00 UTC, call
   `syncDeliveryEvents` (one zone-wide sync covers all campaigns).
3. **Decrement**: if `checks_to_go > 0`, subtract 1. 18 checks × 10 min ≈ 3 h.

`syncDeliveryEvents` queries `emailSendingAdaptive` (GraphQL) for
`deliveryFailed` events in the last 25 hours, matches each to a `sends`
row by recipient email, classifies hard vs soft from the SMTP error code,
then:

- Increments `bounce_count` / `hard_bounce_count` / `soft_bounce_count`.
- Flips `status='bounced'` once `hard_bounce_count >= HARD_BOUNCE_THRESHOLD`.
- Updates the `sends` row to `status='bounced'`.
- Inserts `events(type='bounce')`.

### Why these decisions

- **GraphQL API, not inbound DSN routing**: Cloudflare Email Service does
  not honour a custom `Return-Path` header (it is platform-controlled),
  so VERP-based DSN attribution is not possible. The GraphQL API is the
  authoritative source of delivery failures.
- **Hard threshold = 1**: a permanent 5.x.x failure means the address is
  bad; one strike is enough.
- **Soft threshold = 5**: gives a few campaigns of grace before declaring
  a transient-bouncer dead.
- **Post-send burst + daily fallback**: fast bounces are caught within the
  first 3 hours after each send; the daily sync catches slow/delayed ones.

---

## Cleanup Worker

`workers/cleanup/src/index.ts`

### Purpose

Bounded retention. Without it, R2 storage and D1 row counts grow forever.
Runs on a Cron Trigger (`0 4 * * *` — daily at 04:00 UTC) and prunes
campaigns older than `RETENTION_DAYS` (default 90).

### Step by step

```ts
const { results: expired } = await env.DB
  .prepare(`SELECT id FROM campaigns WHERE created_at < datetime('now','-90 days')`)
  .all();
for (const c of expired) {
  // delete R2 attachment bytes
  for (const a of attachmentsOfCampaign) await env.ARCHIVE.delete(a.r2_key).catch(()=>{});
  await env.ARCHIVE.delete(`campaigns/${c.id}/raw.eml`).catch(()=>{});
  // ON DELETE CASCADE on the schema removes attachments + sends + events
  await env.DB.prepare('DELETE FROM campaigns WHERE id = ?').bind(c.id).run();
}
```

### Why these decisions

- **R2 first, D1 second**: if R2 deletion fails partway, the next run
  will retry (we still have the keys). If we deleted the D1 rows first
  and then crashed, R2 objects would be orphaned with no way to find them.
- **`.catch(()=>{})` on R2 deletes**: best-effort; a missing object isn't
  a reason to abort the whole run.
- **Cascade on `campaigns`**: defined in `db/schema.sql`, so a single
  `DELETE FROM campaigns` cleans `attachments`, `sends`, and `events`
  atomically.
- **`ctx.waitUntil`**: a Cron Trigger has a wall-clock budget; using
  `waitUntil` lets the scheduled handler return immediately while the
  cleanup runs to completion in the background.

### Extension points

- Roll old `events` rows into `events/<yyyy-mm-dd>.ndjson` in R2 before
  deleting (long-term analytics, cheap storage).
- Different retention windows for different tables (e.g. keep
  `subscribers.bounce_count` history forever).

---

## Admin Worker

`workers/admin/src/index.ts`

### Purpose

Operator interface. Serves the React SPA from the `[assets]` binding and
exposes a JSON API under `/api/*` for managing subscribers, authors,
campaigns and warmup quota.

### Authentication

The worker has **no built-in auth**. It must be deployed behind a
Cloudflare Access application; Access authenticates the user at the edge
and adds the `Cf-Access-Authenticated-User-Email` header on every
request that reaches the worker. The handler simply checks that the
header is present:

```ts
if (!req.headers.get('cf-access-authenticated-user-email'))
  return Response.json({ error: 'unauthorized' }, { status: 401 });
```

`/api/me` reflects the Access identity back to the SPA so the header can
display the signed-in user's name.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/subscribers` | add or reactivate a subscriber (upsert) |
| GET | `/subscribers` | list latest 1000 subscribers |
| GET | `/campaigns` | list latest 100 campaigns with counters |
| GET | `/campaigns/:id` | one campaign + grouped event counts |

### Notes

- **Subscriber upsert** uses `ON CONFLICT(email) DO UPDATE SET
  status='active'` so re-subscribing a previously-unsubscribed person is
  a single round trip and idempotent.
- **Per-campaign stats** uses `GROUP BY type` on the `events` table:
  ```sql
  SELECT type, COUNT(*) as n FROM events WHERE campaign_id = ? GROUP BY type
  ```
  giving you opens / clicks / bounces / downloads / unsubscribes in one
  query. `sends`-derived counters (`sent_count`, `failed_count`,
  `total_recipients`) come from the campaigns row itself.

### Extension points

- DLQ replay endpoint that drains `newsletter-dlq` and re-enqueues to
  `newsletter-queue`.
- Per-subscriber send history (`SELECT * FROM sends WHERE subscriber_id =
  ?`).
- Resend-failed: `INSERT INTO queue ... WHERE campaign_id=? AND status='failed'`.
