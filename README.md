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
| `admin`     | HTTP + SPA     | JSON API + GUI: newsletters, subscribers, authors, campaigns, bounces |

## Layout

```
workers/{ingest,consumer,tracker,bounce,cleanup,admin}/
shared/{mime,attachments,tracking,db}.ts
web/                       # Vite + React admin SPA
db/{schema.sql,migrations/}
docs/workers.md            # per-worker deep dives
```

## Admin GUI

The `admin` worker exposes a JSON API under `/api/*` and serves a Vite +
React SPA from the same origin via the `[assets]` binding. Authentication
is delegated entirely to **Cloudflare Access**: deploy the worker behind
an Access application and the SPA picks up the user's identity from the
`Cf-Access-Authenticated-User-Email` header that the edge injects. The
worker rejects any `/api/*` request that is missing that header. There is
no shared bearer token.

Static media (logos, header images) lives in the `newsletter-admin` R2
bucket, bound as `ASSETS_R2` and served read-only under `/media/*` (e.g.
`/media/logoenea1.png`, rendered in the header). The `/media/` prefix is
used instead of `/assets/` to avoid colliding with the Vite-built SPA
bundle. Because the whole worker sits behind Access, these objects are
only reachable by authenticated operators. The bucket is EU-jurisdiction,
so its binding in `workers/admin/wrangler.toml` declares
`jurisdiction = "eu"`. Upload a file with:

```bash
wrangler r2 object put newsletter-admin/logoenea1.png \
  --jurisdiction eu --file ./logoenea1.png --content-type image/png
```

Pages:

- **Dashboard** — subscriber/campaign/event totals, warmup quota, last-7-day rollup.
- **Newsletters** — create/rename/delete newsletters (each with its own inbound
  address, subscribers and authors); sortable, searchable list. Email Routing
  rules are kept in sync automatically.
- **Subscribers** (per newsletter) — paginated, sortable search; add manually;
  CSV import (position-based, with duplicate detection) and CSV export; tracks a
  `verified` flag and delivery `status`.
- **Authors** (per newsletter) — manage the allow-list of inbound senders.
- **Campaigns** — list and per-campaign drill-down with stacked event chart and per-recipient `sends` table.
- **Bounces** — last 7 days, status code colour-coded.

Each operator's **theme** (light/dark) is saved server-side in the `admins`
table and follows them across devices; new operators are seeded with their OS
colour-scheme preference on first login (`GET /api/me` returns it,
`PUT /api/preferences` updates it).

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
- Once deployed, the **default settings** must be configured to match your zone
  (sending identity, domains, Email Routing) before the first send — see
  [*Initialization*](#initialization).

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
# GUI media (logos, header images) served by the admin worker.
# Created in the EU jurisdiction, so all access must pass --jurisdiction eu.
wrangler r2 bucket create newsletter-admin --jurisdiction eu
```

Update each `workers/*/wrangler.toml` with the IDs that come back, then:

```bash
# Email Routing rules
#   newsletter@yourdomain.com    -> Worker `ingest`
#   bounce+*@yourdomain.com      -> Worker `bounce`  (catch-all w/ VERP)

# Secrets
wrangler secret put LINK_SIGNING_KEY        --name tracker
wrangler secret put ATTACHMENT_SIGNING_KEY  --name tracker
# Admin worker: protect it with Cloudflare Access (no auth secret of its own).
# Optional — lets it auto-manage Email Routing rules for newsletter inbound
# addresses (token needs Zone → Email Routing Rules → Edit):
(cd workers/admin && wrangler secret put CF_API_TOKEN)
```

## Deploy

```bash
npm install
for w in ingest consumer tracker bounce cleanup admin; do
  (cd workers/$w && wrangler deploy)
done
```

### Admin worker deploy script

`scripts/deploy-admin.sh` is a convenience wrapper that builds the SPA,
deploys only the admin worker (pinned to the ENEA PoC account so wrangler
doesn't prompt), then commits any pending changes and pushes to GitHub.

```bash
./scripts/deploy-admin.sh "optional commit message"
```

If no commit message is given a timestamped default is used; a clean tree
skips the commit. The deploy runs before the push, so a failed deploy
aborts the script before anything is pushed.

## Initialization

Before the first send you must configure the deployment-specific **settings**.
These used to be per-worker `wrangler.toml` vars; they now resolve from the D1
`settings` table, falling back to the built-in defaults in
[`shared/settings.ts`](shared/settings.ts) (`SETTINGS_DEFAULTS`). Secrets and
bindings (signing keys, API tokens, D1/R2/queue) still live in Wrangler.

There are two ways to set a value:

1. **Edit the defaults** in `shared/settings.ts` and redeploy — best for values
   that should be baked into the deployment and committed to git.
2. **Override at runtime** from the console's **Settings** page (writes to the D1
   `settings` table; no redeploy). A saved value overrides the built-in default;
   **Reset** reverts to it.

At minimum, set the **sending identity and domains** so they line up with the
Email Routing / Email Sending setup from [*Prerequisites*](#prerequisites):

| Setting | Purpose |
| ------- | ------- |
| `FROM_ADDRESS` | Default `From:` header for outbound mail (a newsletter may override its own sender). |
| `BASE_DOMAIN` | Domain newsletters receive inbound mail on. |
| `BOUNCE_DOMAIN` | Domain for VERP bounce return-path addresses (`bounce+<id>@`). |
| `TRACKING_BASE_URL` | Base URL of the tracker worker (opens, clicks, unsubscribe, downloads). |
| `EMAIL_ROUTING_ZONE_ID` | Zone whose Email Routing forwards inbound mail to the ingest worker. |
| `INGEST_WORKER_NAME` | Worker script the auto-managed Email Routing rules target. |

The defaults ship configured for `eneanewsletter.it`; change them for any other
deployment.

## Configuration knobs

The remaining tunables (batch size, attachment limits,
`ATTACHMENT_LINK_THRESHOLD_BYTES`, `MAX_RAW_BYTES`, warmup, retention, bounce
thresholds) follow the same model: D1 `settings` row → built-in default in
`shared/settings.ts`. Edit them there or in the console's **Settings** page (see
[*Initialization*](#initialization)). Queue `max_concurrency` is still set in
`workers/consumer/wrangler.toml`. Defaults are conservative; tune them to your
Email Sending quota.

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

The system is **multi-tenant**: a `newsletters` row is the parent of its own
authors, subscribers and campaigns (all scoped by `newsletter_id`).

- `newsletters(id, name, inbound_address UNIQUE, enabled, created_at)`
- `authors(newsletter_id, email, name, created_at, PRIMARY KEY(newsletter_id, email))` — per-newsletter inbound-sender allow-list.
- `subscribers(id, newsletter_id, email, name, verified, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token, UNIQUE(newsletter_id, email))`
- `campaigns(id, newsletter_id, subject, html, text, sent_by, created_at, status, total_recipients, sent_count, failed_count, attachment_count, attachment_total_bytes, link_mode)`
- `attachments(id, campaign_id, r2_key, filename, content_type, size, sha256, content_id NULL, disposition ['attachment'|'inline'], created_at)`
- `sends(id, campaign_id, subscriber_id, status, queued_at, sent_at, error, message_id, UNIQUE(campaign_id, subscriber_id))`
- `events(id, campaign_id, subscriber_id, type ['open'|'click'|'bounce'|'complaint'|'unsubscribe'|'download'], attachment_id NULL, url, ts, ua, ip)`
- `admins(email PK, theme ['light'|'dark'], created_at, updated_at)` — console operators' saved UI preferences; identity itself comes from Cloudflare Access.
- Indexes: `subscribers(status)`, `subscribers(newsletter_id)`, `campaigns(newsletter_id)`, `sends(campaign_id, status)`, `events(campaign_id, type)`, `attachments(campaign_id)`.
- Cascades: deleting a newsletter removes its authors/subscribers/campaigns; deleting a campaign removes its attachments/sends/events (`ON DELETE CASCADE`).

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

### f) `admin-worker` (HTTP + SPA)
- Serves the React admin GUI and a JSON API under `/api/*`.
- **Auth via Cloudflare Access** (no bearer token): trusts the
  `Cf-Access-Authenticated-User-Email` header injected at the edge; any
  `/api/*` request without it gets 401.
- Endpoints: newsletter CRUD (with Email Routing rule sync), per-newsletter
  subscriber CRUD + CSV import/export, author allow-list CRUD, campaign list +
  stats, bounces, warmup quota (`/api/quota`), identity (`/api/me`) and the
  operator's theme preference (`PUT /api/preferences`).

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

## 8. Configuration (settings / secrets)
- Settings (resolved from the D1 `settings` table → built-in defaults in `shared/settings.ts`, editable on the console's **Settings** page; see [*Initialization*](#initialization)): `EMAIL_ROUTING_ZONE_ID`, `INGEST_WORKER_NAME`, `BASE_DOMAIN`, `FROM_ADDRESS`, `BOUNCE_DOMAIN`, `TRACKING_BASE_URL`, `BATCH_SIZE`, `MAX_ATTACHMENT_BYTES`, `MAX_TOTAL_ATTACHMENT_BYTES`, `MAX_ATTACHMENT_COUNT`, `ALLOWED_MIME`, `BLOCKED_EXTENSIONS`, `ATTACHMENT_LINK_THRESHOLD_BYTES`, `MAX_RAW_BYTES`, `RETENTION_DAYS`, `HARD_BOUNCE_THRESHOLD`, `SOFT_BOUNCE_THRESHOLD`, and the `WARMUP_*` keys.
- Secrets (`wrangler secret put`): `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`. The admin worker has no auth secret — front it with a Cloudflare Access application; it optionally takes `CF_API_TOKEN` to auto-manage Email Routing rules.

## 9. Key Flows

**Send**: Author email → Ingest verifies/parses, stores attachments in R2, writes D1 → batches enqueued → Consumer loads attachments once, builds MIME per recipient, sends via `SEND_EMAIL` → `sends` updated.

**Open / click / download**: Tracker Worker logs to `events`; downloads stream from R2 with HMAC-signed URLs.

**Bounce**: VERP DSN → Bounce Worker → subscriber + `events` updated; raw archived in R2.

**Unsubscribe**: One-click `POST /u/:sub` (HMAC token) → `subscribers.status='unsubscribed'`.

**Retention**: Cleanup Worker (cron) prunes R2 + D1 per `RETENTION_DAYS`.

## 9b. Warmup Schedule

To preserve sending reputation when bringing the domain online, the consumer
worker enforces a stepped weekly cap with a flat daily ceiling. Warmup is
**off by default** — set `WARMUP_START_DATE` (UTC date of week 0) on the
console's **Settings** page (or in `shared/settings.ts`) to turn it on. With it
disabled the consumer behaves exactly as before (no caps).

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

**Configuration** (settings resolved from the D1 `settings` table → built-in
defaults in `shared/settings.ts`; edit on the console's **Settings** page):

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
