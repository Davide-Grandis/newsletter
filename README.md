# Newsletter Distribution on Cloudflare

Serverless newsletter pipeline: an author emails `newsletter@yourdomain.com`
(optionally with attachments). Cloudflare Email Routing triggers an Ingest
Worker, which stores attachments in R2, persists the campaign in D1, and
fans out recipient batches via Cloudflare Queues. A Consumer Worker builds
the per-recipient MIME (with attachments + tracking pixel + signed click
links) and sends it through the `SEND_EMAIL` Email Sending (beta) binding.
Bounces, opens, clicks, downloads and unsubscribes are logged to D1, with
raw archives in R2.

## Components

| Worker      | Type           | Purpose                                                        |
| ----------- | -------------- | -------------------------------------------------------------- |
| `ingest`    | Email handler  | Parse inbound mail, store attachments to R2, enqueue batches   |
| `consumer`  | Queue consumer | Build MIME per recipient, send via `SEND_EMAIL`, log to D1     |
| `tracker`   | HTTP           | Pixel, signed click redirect, unsubscribe, attachment download |
| `bounce`    | Email handler  | Parse DSN/ARF on `bounce+*@`, update subscriber + events       |
| `cleanup`   | Cron Trigger   | Retention: prune R2 + D1                                       |
| `admin`     | HTTP + SPA     | JSON API + browser GUI for subscribers, campaigns, bounces     |

## Layout

```
workers/{ingest,consumer,tracker,bounce,cleanup,admin}/
shared/{mime,attachments,tracking,db}.ts
web/                       # Vite + React admin SPA
db/{schema.sql,migrations/}
docs/workers.md            # per-worker deep dives
```

## Admin GUI

The `admin` worker exposes a JSON API under `/api/*` (bearer-token auth via
`ADMIN_TOKEN`) and serves a Vite + React SPA from the same origin via the
`[assets]` binding. Sign in by pasting the token; the SPA stores it in
`localStorage` and sends it as `Authorization: Bearer …` on every request.

Pages:

- **Dashboard** — subscriber/campaign/event totals, last-7-day rollup.
- **Subscribers** — paginated search, add/unsubscribe, CSV import.
- **Campaigns** — list and per-campaign drill-down with stacked event chart and per-recipient `sends` table.
- **Bounces** — last 7 days, status code colour-coded.

Build the SPA before deploying the admin worker:

```bash
cd web && npm install            # one-time
cd ..
npm run deploy:admin             # builds web/ then wrangler deploy
```

During development, run `cd web && npm run dev` (Vite proxies `/api/*` to
`localhost:8787`, so run `wrangler dev` in `workers/admin/` in parallel).

## Prerequisites

- Cloudflare zone with Email Routing enabled (MX/SPF set up).
- Email Sending (beta) enabled on the zone, DKIM published, the
  `SEND_EMAIL` binding allow-listed for `newsletter@yourdomain.com`.
- `wrangler` >= 3, Node 20+.

## Provisioning

```bash
# D1
wrangler d1 create newsletter_db
wrangler d1 execute newsletter_db --file=db/schema.sql

# Queues
wrangler queues create newsletter-queue
wrangler queues create newsletter-dlq

# R2
wrangler r2 bucket create newsletter-archive
```

Update each `workers/*/wrangler.toml` with the IDs that come back, then:

```bash
# Email Routing rules
#   newsletter@yourdomain.com    -> Worker `ingest`
#   bounce+*@yourdomain.com      -> Worker `bounce`  (catch-all w/ VERP)

# Secrets
wrangler secret put LINK_SIGNING_KEY        --name tracker
wrangler secret put ATTACHMENT_SIGNING_KEY  --name tracker
wrangler secret put ADMIN_TOKEN             --name admin
```

## Deploy

```bash
npm install
for w in ingest consumer tracker bounce cleanup admin; do
  (cd workers/$w && wrangler deploy)
done
```

## Configuration knobs

See each `wrangler.toml`. Defaults are conservative; tune
`BATCH_SIZE`, `max_concurrency`, attachment limits, and
`ATTACHMENT_LINK_THRESHOLD_BYTES` to your Email Sending quota.

## Notes

- Queue messages carry recipient batches only; attachments are
  referenced by `campaignId` and pulled once per batch from R2 to stay
  under the 128 KB queue message limit.
- If total raw size exceeds `ATTACHMENT_LINK_THRESHOLD_BYTES`, the
  ingest worker switches to **link mode** and rewrites the HTML to use
  signed download URLs served by the tracker worker.
- VERP `bounce+<sendId>@` lets the bounce worker attribute DSNs to
  specific sends.

---

# Consolidated Design Plan

A serverless newsletter pipeline on Cloudflare: author emails
`newsletter@yourdomain.com` (with optional attachments) → Email Worker fans
out via Queues → Consumer Worker sends via Email Sending (beta) → analytics
in D1/R2.

## 1. Architecture Overview

```
Author ──▶ Email Routing ──▶ Ingest Worker (Email handler)
                                  │
                                  ├── Auth check (allowed sender, SPF/DKIM)
                                  ├── Parse MIME (postal-mime): subject, html, text, attachments
                                  ├── Validate + store attachments in R2
                                  ├── Insert campaign + attachment rows in D1
                                  └── Enqueue subscriber batches ──▶ Cloudflare Queue
                                                                          │
                                                                          ▼
                                                                    Consumer Worker
                                                                          │
                                                                ┌─────────┼──────────┐
                                                                ▼         ▼          ▼
                                                          SEND_EMAIL   D1 logs   Tracking
                                                          (MIME w/     (sends)   pixel/links
                                                           attachments)              │
                                                                                     ▼
                                                                              Tracker Worker
                                                                              (HTTP) → D1/R2
                                  ▲
                                  │
                       Bounces ───┘ (Email Routing → Bounce Worker → D1)

                       Cron ─────▶ Cleanup Worker (R2 + D1 retention)
```

## 2. Cloudflare Account Setup
- **Zone** added; Email Routing enabled (MX/SPF).
- **Email Sending (beta)** enabled; DKIM published; `SEND_EMAIL` binding allow-listed for `newsletter@yourdomain.com`.
- **Routes**:
  - `newsletter@yourdomain.com` → Ingest Worker
  - `bounce+*@yourdomain.com` (VERP) → Bounce Worker
- **D1**: `newsletter_db`
- **Queues**: `newsletter-queue` (+ DLQ `newsletter-dlq`)
- **R2**: `newsletter-archive` (raw inbound + attachments + raw event logs)

## 3. D1 Schema — `newsletter_db`
- `subscribers(id, email UNIQUE, name, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token)`
- `campaigns(id, subject, html, text, sent_by, created_at, status, total_recipients, sent_count, failed_count, attachment_count, attachment_total_bytes, link_mode)`
- `attachments(id, campaign_id, r2_key, filename, content_type, size, sha256, content_id NULL, disposition ['attachment'|'inline'], created_at)`
- `sends(id, campaign_id, subscriber_id, status, queued_at, sent_at, error, message_id, UNIQUE(campaign_id, subscriber_id))`
- `events(id, campaign_id, subscriber_id, type ['open'|'click'|'bounce'|'complaint'|'unsubscribe'|'download'], attachment_id NULL, url, ts, ua, ip)`
- Indexes: `subscribers(status)`, `sends(campaign_id, status)`, `events(campaign_id, type)`, `attachments(campaign_id)`.

## 4. Queue — `newsletter-queue`
- Message: `{ campaignId, batch: [{subscriberId, email, name, token}] }` — recipients only; attachments referenced by `campaignId` (avoids 128 KB message limit).
- Consumer: `max_batch_size: 10`, `max_concurrency: 5`, `max_retries: 3`, DLQ → `newsletter-dlq`.

## 5. R2 — `newsletter-archive`
- `campaigns/<id>/raw.eml` — original inbound MIME.
- `campaigns/<id>/attachments/<sha256>` — deduped attachment bytes (metadata: filename, contentType, size, contentId).
- `bounces/<yyyy-mm-dd>/<msgid>.eml` — raw DSN/ARF reports.
- `events/<yyyy-mm-dd>.ndjson` — long-term raw event log.

## 6. Workers

### a) `ingest-worker` (Email Worker)
- `email(message, env, ctx)` handler.
- Verify sender exists in the D1 `authors` table (managed via the admin worker); require `Authentication-Results` SPF=pass, DKIM=pass.
- Parse with `postal-mime` → subject, html, text, `attachments[]`.
- **Attachment handling**:
  - Validate count ≤ `MAX_ATTACHMENT_COUNT`, per-file ≤ `MAX_ATTACHMENT_BYTES`, total ≤ `MAX_TOTAL_ATTACHMENT_BYTES`.
  - Enforce `ALLOWED_MIME`; reject `BLOCKED_EXTENSIONS` and dangerous magic bytes.
  - Sanitize filenames; compute `sha256`; dedupe by hash.
  - Upload to R2 `campaigns/<id>/attachments/<sha256>` with metadata.
  - If total raw size > `ATTACHMENT_LINK_THRESHOLD_BYTES`, switch to **link mode**: rewrite HTML to signed download URLs served by Tracker Worker; do not attach.
- Insert `campaigns` (status=`sending`) and `attachments` rows.
- Stream active subscribers in pages, chunk into batches of `BATCH_SIZE`, `env.QUEUE.send(...)`.
- Reply NDR via `message.setReject` if unauthorized or oversized.
- Bindings: `DB`, `QUEUE`, `ARCHIVE`, vars `BATCH_SIZE`, attachment limits.

### b) `consumer-worker` (Queue consumer)
- `queue(batch, env)` handler.
- On batch start: load campaign + `attachments` rows; pull bytes from R2 once into an in-memory `Map<sha256, Uint8Array>` (cached for the batch lifetime).
- For each recipient build MIME with the in-house builder (`shared/mime.ts`):
  - `multipart/mixed`
    - `multipart/related` (HTML + inline images via `cid:<content_id>`)
      - `multipart/alternative` (text + html with tracking pixel + signed click links)
    - One `attachment` part per non-inline file: base64, `Content-Disposition: attachment; filename="..."`, correct `Content-Type`.
  - Headers: `From`, `To`, `Subject`, `Message-ID`, `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, VERP `Return-Path: bounce+<campaignId>.<subscriberId>@...`.
- Pre-flight size guard: reject batch early if total MIME (×1.34 base64 overhead) exceeds `MAX_RAW_BYTES`.
- `await env.SEND_EMAIL.send(new EmailMessage(from, to, raw))`.
- On success → update `sends`, increment `campaigns.sent_count`.
- On error → log to `sends`; `msg.ack()` for permanent failures, `msg.retry()` for transient; exhausted retries flow to DLQ.
- Bindings: `DB`, `ARCHIVE`, `SEND_EMAIL`, vars `FROM_ADDRESS`, `TRACKING_BASE_URL`, `BOUNCE_DOMAIN`.

### c) `tracker-worker` (HTTP Worker)
- `GET /o/:campaign/:sub.gif` → log open, return 1×1 GIF.
- `GET /c/:campaign/:sub?u=<encoded>&sig=...` → verify HMAC, log click, 302.
- `GET /u/:sub?t=<token>` → unsubscribe page; `POST /u/:sub` → one-click unsubscribe (`List-Unsubscribe-Post`).
- `GET /a/:campaign/:sub/:attId?sig=...` → verify HMAC, stream attachment from R2 (link-mode), log `events(type='download', attachment_id)`.
- Bindings: `DB`, `ARCHIVE`, secrets `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`.

### d) `bounce-worker` (Email Worker)
- Receives DSN/ARF at `bounce+<campaignId>.<subscriberId>@`; map back via VERP.
- Parse `Status:`; classify hard (5.x.x) vs soft; update `subscribers.bounce_count`; mark `bounced` after threshold.
- Insert `events(type='bounce')`; archive raw to R2.

### e) `cleanup-worker` (Cron Trigger)
- Daily: delete R2 attachments and `attachments`/`campaigns` rows older than `RETENTION_DAYS` (cascade prunes `sends`/`events`).

### f) `admin-worker` (HTTP, optional)
- Bearer-token guarded endpoints: subscriber CRUD, campaign list, campaign stats.

## 7. Repo Layout

```
newsletter/
├── README.md
├── package.json
├── tsconfig.json
├── workers/
│   ├── ingest/      (src/index.ts, wrangler.toml)
│   ├── consumer/
│   ├── tracker/
│   ├── bounce/
│   ├── cleanup/
│   └── admin/
├── shared/
│   ├── mime.ts                   # multipart/mixed+related builder w/ attachments
│   ├── attachments.ts            # validation, hashing, R2 helpers
│   ├── tracking.ts               # HMAC link signing + pixel/link rewriting
│   ├── db.ts                     # D1 helpers
│   └── types.ts
└── db/
    ├── schema.sql
    └── migrations/
```

## 8. Configuration (vars / secrets)
- Vars: `FROM_ADDRESS`, `TRACKING_BASE_URL`, `BOUNCE_DOMAIN`, `BATCH_SIZE`, `MAX_ATTACHMENT_BYTES`, `MAX_TOTAL_ATTACHMENT_BYTES`, `MAX_ATTACHMENT_COUNT`, `ALLOWED_MIME`, `BLOCKED_EXTENSIONS`, `ATTACHMENT_LINK_THRESHOLD_BYTES`, `MAX_RAW_BYTES`, `RETENTION_DAYS`, `HARD_BOUNCE_THRESHOLD`, `SOFT_BOUNCE_THRESHOLD`.
- Secrets (`wrangler secret put`): `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`, `ADMIN_TOKEN`.

## 9. Key Flows

**Send**: Author email → Ingest verifies/parses, stores attachments in R2, writes D1 → batches enqueued → Consumer loads attachments once, builds MIME per recipient, sends via `SEND_EMAIL` → `sends` updated.

**Open / click / download**: Tracker Worker logs to `events`; downloads stream from R2 with HMAC-signed URLs.

**Bounce**: VERP DSN → Bounce Worker → subscriber + `events` updated; raw archived in R2.

**Unsubscribe**: One-click `POST /u/:sub` (HMAC token) → `subscribers.status='unsubscribed'`.

**Retention**: Cleanup Worker (cron) prunes R2 + D1 per `RETENTION_DAYS`.

## 9b. Warmup Schedule

To preserve sending reputation when bringing the domain online, the consumer
worker enforces a stepped weekly cap with a flat daily ceiling. Warmup is
**off by default** — set `WARMUP_START_DATE` (UTC date of week 0) on both
the consumer and admin workers to turn it on. With it disabled the consumer
behaves exactly as before (no caps).

| Week  | Weekly cap                       | Daily cap |
| ----- | -------------------------------- | --------- |
| 0     | 500                              | 5,000     |
| 1     | 1,500                            | 5,000     |
| 2     | 5,000                            | 5,000     |
| 3     | 12,000                           | 5,000     |
| 4     | 25,000                           | 5,000     |
| 5     | 40,000                           | 10,000    |
| 6+    | `WARMUP_TARGET_WEEKLY` (50,000)  | 10,000    |

Whichever cap (daily or weekly) runs out first throttles. In practice the
daily cap is non-binding for weeks 0–2 (the weekly cap is lower) and only
starts to bite from week 3 onwards.

**Enforcement**: at the start of each `queue()` invocation the consumer
counts `sends` since the current daily and weekly window starts (UTC), and
each message either sends in full, sends a partial slice and re-enqueues the
overflow with `delaySeconds` to the next window, or `msg.retry`s with a
delay if the cap is already exhausted. Cloudflare Queues caps `delaySeconds`
at 12 h, so longer waits are achieved by repeated retries.

**Configuration** (mirror these vars on `workers/consumer/wrangler.toml` and
`workers/admin/wrangler.toml`):

| Var                       | Default                                  | Meaning                                                |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `WARMUP_START_DATE`       | `""` (disabled)                          | ISO date of week 0, e.g. `2026-01-06`.                 |
| `WARMUP_TARGET_WEEKLY`    | `50000`                                  | Steady-state weekly cap from week 6 onwards.           |
| `WARMUP_SCHEDULE`         | `[500,1500,5000,12000,25000,40000]`      | Per-week weekly caps. Empty array → formula fallback.  |
| `WARMUP_DAILY_CAP_EARLY`  | `5000`                                   | Daily cap for weeks below `WARMUP_LATE_START_WEEK`.    |
| `WARMUP_DAILY_CAP_LATE`   | `10000`                                  | Daily cap from `WARMUP_LATE_START_WEEK` onwards.       |
| `WARMUP_LATE_START_WEEK`  | `5`                                      | First week using the late daily cap.                   |

If `WARMUP_SCHEDULE = "[]"` the formula `min(target, 500 * 2.5^week)` is used
as a fallback.

**Visibility**: the admin GUI's Dashboard renders two progress bars (Today /
This week) backed by `GET /api/quota`, polled every 60 s.

## 10. Operational Concerns
- **Rate limits**: tune queue concurrency to Email Sending quota; intra-batch pacing if needed.
- **Idempotency**: `UNIQUE(campaign_id, subscriber_id)` on `sends` prevents duplicates on retry.
- **Auth**: enforce author allow-list + SPF/DKIM=pass on inbound.
- **Compliance**: physical address + unsubscribe link/header in every email (CAN-SPAM/GDPR).
- **Security**: attachment MIME/extension/magic-byte validation; signed URLs; secrets via Wrangler.
- **Observability**: Workers Logs + Queues metrics + admin `/stats` reading D1.
- **DLQ**: replay tool re-enqueues failed batches after fix.

## 11. Implementation Milestones
1. Provision zone, Email Routing, Email Sending DKIM, D1, Queues, R2.
2. `db/schema.sql` + migrations + seed CLI.
3. `consumer-worker` happy path with `SEND_EMAIL` (single recipient, no attachments).
4. `ingest-worker` end-to-end batching (no attachments).
5. **Attachment pipeline**: R2 storage in ingest, MIME builder w/ attachments + inline CIDs in consumer, size-budget checks, link-mode fallback.
6. `tracker-worker` (opens, clicks, unsubscribe, attachment downloads).
7. `bounce-worker` + VERP.
8. `cleanup-worker` cron + retention.
9. `admin-worker` + dashboard queries.
10. Load test with synthetic subscriber list and large attachments; tune batch/concurrency.

---

## Further Reading

- [`docs/workers.md`](docs/workers.md) — per-worker deep dives (purpose, step-by-step walkthrough, design rationale, extension points for ingest, consumer, tracker, bounce, cleanup, admin).
