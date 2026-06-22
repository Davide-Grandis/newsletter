# Newsletter Distribution on Cloudflare

Serverless newsletter pipeline: an author emails `newsletter@yourdomain.com`
(optionally with attachments). Cloudflare Email Routing triggers an Ingest
Worker, which stores attachments in R2, persists the campaign in D1, and
fans out recipient batches via Cloudflare Queues. A Consumer Worker builds
the per-recipient MIME (with attachments + tracking pixel + signed click
links) and sends it through the `SEND_EMAIL` Email Sending (beta) binding.
Bounces, opens, clicks, downloads and unsubscribes are logged to D1, with
raw archives in R2.

## Table of Contents

- [Features](#features)
- [Components](#components)
- [Layout](#layout)
- [Admin GUI](#admin-gui)
- [Prerequisites](#prerequisites)
- [Provisioning](#provisioning)
  - [Worker configuration (wrangler.toml)](#worker-configuration-wranglertoml)
- [Deploy](#deploy)
  - [Admin worker deploy script](#admin-worker-deploy-script)
- [Initialization](#initialization)
- [Configuration knobs](#configuration-knobs)
- [Notes](#notes)
- [Consolidated Design Plan](#consolidated-design-plan)
  - [1. Architecture Overview](#1-architecture-overview)
  - [2. Cloudflare Account Setup](#2-cloudflare-account-setup)
  - [3. D1 Schema](#3-d1-schema--newsletter_db)
  - [4. Queue](#4-queue--newsletter-queue)
  - [5. R2](#5-r2--newsletter-archive)
  - [6. Workers](#6-workers)
  - [7. Repo Layout](#7-repo-layout)
  - [8. Configuration](#8-configuration-settings--secrets)
  - [9. Key Flows](#9-key-flows)
  - [9b. Warmup Schedule](#9b-warmup-schedule)
  - [10. Operational Concerns](#10-operational-concerns)
  - [11. Implementation Milestones](#11-implementation-milestones)
- [Further Reading](#further-reading)

## Features

- **Multi-tenant newsletters** — each newsletter is an independent list with its
  own inbound address, sender, footer, author allow-list and subscribers.
- **Inbound-by-email authoring** — authors send an issue by emailing the
  newsletter's address; only allow-listed senders are accepted (edge SPF/DKIM/
  DMARC enforced by Email Routing).
- **Attachments** — validation (count/size/MIME/extension caps), SHA-256
  dedupe, R2 storage, and automatic **link mode** (signed download links) for
  large attachments. Inline `cid:` images are preserved. See
  [`docs/attachments.md`](docs/attachments.md).
- **Open & click tracking** — invisible pixel + HMAC-signed click redirects,
  logged to the `events` table. Toggle off with `TRACKING_ENABLED`. See
  [`docs/tracking.md`](docs/tracking.md).
- **Subscribe / unsubscribe** — manual add, CSV import/export, and a hosted
  **public signup page** with **double opt-in** protected by Cloudflare
  Turnstile; one-click (RFC 8058) and `mailto:` unsubscribe. See
  [`docs/subscribe-unsubscribe.md`](docs/subscribe-unsubscribe.md).
- **Per-newsletter footers & senders** — override the global default footer and
  `From:` address per newsletter, with token substitution and a guaranteed
  unsubscribe link.
- **Demand-driven warmup** — weekly stepped cap plus the account's live daily
  Cloudflare quota gate outbound volume to protect reputation. See
  [`docs/warmup.md`](docs/warmup.md).
- **Bounce handling** — Cloudflare GraphQL delivery-failure sync updates
  subscriber status past configurable thresholds.
- **Retention** — a nightly cron purges campaigns (and their R2 bytes) older
  than `RETENTION_DAYS`. See [`docs/retention.md`](docs/retention.md).
- **Admin console** — React SPA behind Cloudflare Access with role-based
  access (super admins + per-newsletter admins with read-only/edit
  capability), analytics, logs, and runtime settings.

## Components

| Worker      | Type           | Purpose                                                        |
| ----------- | -------------- | -------------------------------------------------------------- |
| `ingest`    | Email handler  | Parse inbound mail, store attachments to R2, enqueue batches   |
| `consumer`  | Queue consumer | Build MIME per recipient, send via `SEND_EMAIL`, log to D1     |
| `tracker`   | HTTP           | Pixel, signed click redirect, unsubscribe, attachment download |
| `bounce`    | Email+Cron     | One-click email unsubscribe; GraphQL delivery-failure sync     |
| `cleanup`   | Cron Trigger   | Retention: prune R2 + D1                                       |
| `admin`     | HTTP + SPA     | JSON API + GUI: newsletters, subscribers, authors, campaigns, bounces |

## Layout

```
workers/{ingest,consumer,tracker,bounce,cleanup,admin}/
shared/{mime,attachments,tracking,db,settings,footer,quota,warmup,types}.ts
web/                       # Vite + React admin SPA
db/{schema.sql,reset.sql,migrations/}
docs/                      # workers, warmup, attachments, tracking,
                           # retention, subscribe-unsubscribe, help, deploy
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

- **Dashboard** — subscriber/campaign/event totals, last-7-day rollup.
- **Newsletters** — create/rename/delete newsletters (each with its own inbound
  address, subscribers and authors); sortable, searchable list. Email Routing
  rules are kept in sync automatically. Each newsletter has tabs for:
  - **Subscribers** — paginated, sortable search; add manually; CSV import
    (position-based, with duplicate detection) and CSV export; tracks a
    `verified` flag and delivery `status`.
  - **Authors** — manage the allow-list of inbound senders.
  - **Admins** — assign per-newsletter admins and their read-only/edit capability.
  - **Signup** — enable the hosted public subscribe page (double opt-in via
    Turnstile), set the URL slug, and copy the embed snippet.
  - **Email footer** — per-newsletter HTML/text footer with live preview.
- **Campaigns** — list and per-campaign drill-down with stacked event chart and per-recipient `sends` table.
- **Bounces** — last 7 days, status code colour-coded.
- **Analytics** (Logs) — merged pipeline log + engagement event stream, filterable by source/level.
- **Settings** (super admin) — runtime configuration grouped by tab (Access,
  Email sending, Tracking & signup, Attachments, Retention, etc.), the
  **Super admins** tab, and a live **Sending usage** panel (daily quota, emails
  sent, warmup week and weekly progression).
- **Help** — the rendered help document (`help.md`, served from R2).

**Roles:** *super admins* have full access including Settings; *admins* are
scoped to their assigned newsletters with either *read-only* or *edit*
capability. Identity comes from Cloudflare Access; the first user to sign in to
an empty `admins` table is bootstrapped as super admin.

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

### Worker configuration (`wrangler.toml`)

The real `workers/*/wrangler.toml` files are **not** committed — they hold
deployment-specific IDs and your custom hostnames. Each worker ships a
`wrangler.toml.example` template instead. Copy each one and fill in your values:

```bash
for w in ingest consumer tracker bounce cleanup admin; do
  cp "workers/$w/wrangler.toml.example" "workers/$w/wrangler.toml"
done
```

Then, in every copied file:

- Replace `REPLACE_WITH_D1_ID` with the `database_id` returned by
  `wrangler d1 create newsletter_db` (the same id goes in all six files).
- In `workers/admin/wrangler.toml` and `workers/tracker/wrangler.toml`, replace
  the `routes` hostnames (`console.yourdomain.com`, `track.yourdomain.com`) with
  your own custom domains. The `custom_domain = true` route creates the DNS
  record on first deploy — do **not** pre-create it manually.

What each worker's `wrangler.toml` declares:

| Worker | Bindings & config |
| ------ | ----------------- |
| **ingest** | `nodejs_compat`; `DB` (D1); `ARCHIVE` (R2 `newsletter-archive`); `QUEUE` producer (`newsletter-queue`). Receives the newsletter inbound address via an Email Routing rule. |
| **consumer** | `nodejs_compat`; `DB`; `ARCHIVE`; `SEND_EMAIL`; `QUEUE` producer (re-enqueue overflow); queue **consumer** on `newsletter-queue` (`max_batch_size`/`max_concurrency`/`max_retries`, DLQ `newsletter-dlq`). Optional secret `CF_READ_API_TOKEN`; signing-key secrets must match the tracker. |
| **tracker** | `DB`; `ARCHIVE`; `SEND_EMAIL`; custom-domain `routes` (`track.*`). Secrets `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY` (match the consumer) and optional `TURNSTILE_SECRET_KEY`. |
| **bounce** | `nodejs_compat`; `DB`. Receives one-click unsubscribes via a catch-all Email Routing rule; cron syncs delivery failures via the Cloudflare GraphQL API. |
| **cleanup** | `DB`; `ARCHIVE`; `[triggers] crons` (daily at 04:00 UTC). |
| **admin** | `DB`; `SEND_EMAIL`; `ASSETS_R2` (R2 `newsletter-admin`, `jurisdiction = "eu"`); `[assets]` SPA from `./public` (SPA fallback); custom-domain `routes` (`console.*`). No auth secret — sits behind Cloudflare Access. Optional secrets `CF_API_TOKEN`, `CF_READ_API_TOKEN`, `CF_ZT_API_TOKEN`. |

All tunable `[vars]` were removed from these files — runtime configuration lives
in the D1 `settings` table (see [*Initialization*](#initialization)). Only
bindings, routes, queue/cron config and the database id live in `wrangler.toml`.

With the files in place:

```bash
# Email Routing rules
#   newsletter@yourdomain.com    -> Worker `ingest`
#   catch-all                    -> Worker `bounce`  (unsubscribes + cron bounce sync)

# Secrets
wrangler secret put LINK_SIGNING_KEY        --name tracker
wrangler secret put ATTACHMENT_SIGNING_KEY  --name tracker
# Admin worker: protect it with Cloudflare Access (no auth secret of its own).
# Optional — lets it auto-manage Email Routing rules for newsletter inbound
# addresses (token needs Zone → Email Routing Rules → Edit):
(cd workers/admin && wrangler secret put CF_API_TOKEN)
# Optional — lets it auto-resolve the Email Routing zone ID from the sending
# domain when you save it on the Settings page (token needs Zone → Read):
(cd workers/admin && wrangler secret put CF_READ_API_TOKEN)
```

The admin worker uses three optional Cloudflare API tokens, all stored as
encrypted Wrangler **secrets** on the `newsletter-admin` worker (visible in the
dashboard under **Settings → Variables and Secrets**, not under *Bindings*):

| Secret | Permission | Purpose |
| ------ | ---------- | ------- |
| `CF_API_TOKEN` | Zone → Email Routing Rules → Edit | Create/move/delete the Email Routing rule for each newsletter's inbound address. |
| `CF_READ_API_TOKEN` | Read all resources (account-scoped) | Look up the Email Routing zone ID from `BASE_DOMAIN` when the sending domain is saved, and read each domain's Email Routing status for the Settings pick-list. (Zone → Read alone resolves the zone ID but cannot read Email Routing status.) |
| `CF_ZT_API_TOKEN` | Account → Zero Trust → Edit | Keep the Cloudflare Access "Emails" list in sync as console users are added/removed. |

All three are best-effort: if a token is unset (or lacks scope) the related
action still succeeds and the console surfaces a warning instead of failing.

## Deploy

```bash
npm install
for w in ingest consumer tracker bounce cleanup admin; do
  (cd workers/$w && wrangler deploy)
done
```

### Admin worker deploy script

`scripts/deploy-admin.sh` is a convenience wrapper that builds the SPA,
deploys only the admin worker, then commits any pending changes and pushes to GitHub.

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
| `BASE_DOMAIN` | Sending domain — the Cloudflare zone newsletters send from and receive inbound mail on. Saving it auto-resolves `EMAIL_ROUTING_ZONE_ID`. |
| `TRACKING_BASE_URL` | Base URL of the tracker worker (opens, clicks, unsubscribe, downloads). |
| `INGEST_WORKER_NAME` | Worker script the auto-managed Email Routing rules target. |
| `DEFAULT_FOOTER_HTML` / `DEFAULT_FOOTER_TEXT` | Global default email footer appended to every message, unless a newsletter sets its own footer. Supports `{{unsubscribe_url}}`, `{{newsletter_name}}`, `{{email}}` tokens; an unsubscribe link is always added. HTML is sanitized to an allow-list on save. |

`BASE_DOMAIN` and `EMAIL_ROUTING_ZONE_ID` have **no built-in defaults** — they
live only in the D1 `settings` table and must be set per deployment. The other
values above ship with defaults you can change.

**Why `EMAIL_ROUTING_ZONE_ID` (and how it's set)?** When a newsletter is
created, renamed or deleted, the admin worker automatically creates/moves/deletes
the matching Email Routing rule (newsletter inbound address → ingest worker).
Cloudflare's Email Routing API is scoped per zone, so this automation needs the
zone ID to know which zone's routing table to edit — together with the
`CF_API_TOKEN` secret (Zone → Email Routing Rules → Edit) for permission and
`INGEST_WORKER_NAME` as the rule's target.

You no longer enter the zone ID by hand. It is **derived from `BASE_DOMAIN`**:
when you save the sending domain on the Settings page, the worker calls the
Cloudflare API (`GET /zones?name=<domain>`) using the `CF_READ_API_TOKEN` secret
(Zone → Read) and stores the resolved id in D1 — so the field is hidden from the
UI. If `CF_READ_API_TOKEN` is unset, the domain isn't a zone in the account, or
the token lacks scope, the domain still saves and the console shows a warning;
you can then add the routing rules manually in the Cloudflare dashboard. Routing
automation is **not** needed for sending.

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
  - catch-all → Bounce Worker (one-click email unsubscribes)
- **D1**: `newsletter_db`
- **Queues**: `newsletter-queue` (+ DLQ `newsletter-dlq`)
- **R2**: `newsletter-archive` (raw inbound + attachments + raw event logs)

## 3. D1 Schema — `newsletter_db`

The system is **multi-tenant**: a `newsletters` row is the parent of its own
authors, subscribers and campaigns (all scoped by `newsletter_id`).

- `newsletters(id, name, inbound_address UNIQUE, from_address NULL, footer_html NULL, footer_text NULL, slug UNIQUE NULL, allow_public_signup, enabled, created_at)` — `footer_*` override the global `DEFAULT_FOOTER_*` per newsletter; `slug` + `allow_public_signup` back the public subscribe page (`/subscribe/<slug>`).
- `authors(newsletter_id, email, name, created_at, PRIMARY KEY(newsletter_id, email))` — per-newsletter inbound-sender allow-list.
- `subscribers(id, newsletter_id, email, name, verified, status, subscribed_at, unsubscribed_at, bounce_count, last_bounce_at, token, confirm_token NULL, UNIQUE(newsletter_id, email))` — `token` authenticates unsubscribe links; `confirm_token` is the pending double opt-in flag (cleared on confirmation).
- `campaigns(id, newsletter_id, subject, html, text, sent_by, created_at, status, total_recipients, sent_count, failed_count, attachment_count, attachment_total_bytes, link_mode)`
- `attachments(id, campaign_id, r2_key, filename, content_type, size, sha256, content_id NULL, disposition ['attachment'|'inline'], created_at)`
- `sends(id, campaign_id, subscriber_id, status, queued_at, sent_at, error, message_id, UNIQUE(campaign_id, subscriber_id))`
- `events(id, campaign_id, subscriber_id, type ['open'|'click'|'bounce'|'complaint'|'unsubscribe'|'download'], attachment_id NULL, url, ts, ua, ip)`
- `admins(email PK, role ['super_admin'|'admin'], capability ['read_only'|'edit'], theme ['light'|'dark'], created_at, updated_at)` — console operators' role and saved UI preferences; identity itself comes from Cloudflare Access.
- `admins_newsletters(email, newsletter_id, PRIMARY KEY(email, newsletter_id))` — which newsletters each (non-super) admin may manage.
- `logs(id, ts, level, source, event, campaign_id, newsletter_id, message, detail)` — pipeline activity log surfaced on the Analytics page.
- `settings(key PK, value, updated_at)` — runtime configuration overrides edited from the Settings page.
- `warmup_state(id=1, level, week_started_at, daily_cap, daily_cap_date, updated_at)` — singleton demand-driven warmup progression + cached daily quota.
- Indexes: `subscribers(status)`, `subscribers(newsletter_id)`, `campaigns(newsletter_id)`, `sends(campaign_id, status)`, `events(campaign_id, type)`, `attachments(campaign_id)`, `logs(ts)`, `logs(campaign_id)`.
- Cascades: deleting a newsletter removes its authors/subscribers/campaigns; deleting a campaign removes its attachments/sends/events (`ON DELETE CASCADE`).

## 4. Queue — `newsletter-queue`
- Message: `{ campaignId, batch: [{subscriberId, email, name, token}] }` — recipients only; attachments referenced by `campaignId` (avoids 128 KB message limit).
- Consumer: `max_batch_size: 10`, `max_concurrency: 5`, `max_retries: 3`, DLQ → `newsletter-dlq`.

## 5. R2 — `newsletter-archive`
- `campaigns/<id>/raw.eml` — original inbound MIME.
- `campaigns/<id>/attachments/<sha256>` — deduped attachment bytes (metadata: filename, contentType, size, contentId).
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
  - Headers: `From`, `To`, `Subject`, `Message-ID`, `List-Unsubscribe`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- Pre-flight size guard: reject batch early if total MIME (×1.34 base64 overhead) exceeds `MAX_RAW_BYTES`.
- `await env.SEND_EMAIL.send(new EmailMessage(from, to, raw))`.
- On success → update `sends`, increment `campaigns.sent_count`.
- On error → log to `sends`; `msg.ack()` for permanent failures, `msg.retry()` for transient; exhausted retries flow to DLQ.
- Bindings: `DB`, `ARCHIVE`, `SEND_EMAIL`, vars `FROM_ADDRESS`, `TRACKING_BASE_URL`, `BASE_DOMAIN`.

### c) `tracker-worker` (HTTP Worker)
- `GET /o/:campaign/:sub.gif` → log open, return 1×1 GIF.
- `GET /c/:campaign/:sub?u=<encoded>&sig=...` → verify HMAC, log click, 302.
- `GET /u/:sub?t=<token>` → unsubscribe page; `POST /u/:sub` → one-click unsubscribe (`List-Unsubscribe-Post`).
- `GET /a/:campaign/:sub/:attId?sig=...` → verify HMAC, stream attachment from R2 (link-mode), log `events(type='download', attachment_id)`.
- `GET|POST /subscribe/:slug` → hosted double opt-in signup form (Turnstile-protected); sends the confirmation email via `SEND_EMAIL`.
- `GET /verify/:sub?t=<confirm_token>` → confirm a pending public signup.
- Bindings: `DB`, `ARCHIVE`, optional `SEND_EMAIL`, secrets `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`, optional `TURNSTILE_SECRET_KEY`.

### d) `bounce-worker` (Email + Cron Worker)
- `email` handler: processes `List-Unsubscribe` mailto replies (`unsubscribe+<id>@`) — marks subscriber unsubscribed and inserts an unsubscribe event.
- `scheduled` handler: queries the Cloudflare Email Sending GraphQL API for delivery failures in the last 25 hours; classifies hard/soft; updates subscriber bounce counters; marks `bounced` after threshold; inserts `events(type='bounce')`.

### e) `cleanup-worker` (Cron Trigger)
- Daily: delete R2 attachments and `attachments`/`campaigns` rows older than `RETENTION_DAYS` (cascade prunes `sends`/`events`).

### f) `admin-worker` (HTTP + SPA)
- Serves the React admin GUI and a JSON API under `/api/*`.
- **Auth via Cloudflare Access** (no bearer token): trusts the
  `Cf-Access-Authenticated-User-Email` header injected at the edge; any
  `/api/*` request without it gets 401.
- Endpoints: newsletter CRUD (with Email Routing rule sync), per-newsletter
  subscriber CRUD + CSV import/export, author allow-list CRUD, campaign list +
  stats, bounces, Email Sending usage + warmup (`/api/email-sending-stats`),
  identity (`/api/me`) and the operator's theme preference
  (`PUT /api/preferences`).

## 7. Repo Layout

```
newsletter/
├── README.md
├── package.json
├── tsconfig.json
├── workers/
│   ├── ingest/      (src/index.ts, wrangler.toml.example)
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
│   ├── settings.ts               # runtime config keys + defaults + resolver
│   ├── footer.ts                 # footer tokens + HTML sanitizer
│   ├── quota.ts                  # Cloudflare daily sending quota fetch
│   ├── warmup.ts                 # demand-driven warmup state machine
│   └── types.ts
└── db/
    ├── schema.sql
    └── reset.sql
```

(`workers/*/wrangler.toml` and `db/migrations/` are git-ignored — copy each
`wrangler.toml.example` to `wrangler.toml` and fill in your IDs; `schema.sql` is
the authoritative database schema.)

## 8. Configuration (settings / secrets)
- Settings (resolved from the D1 `settings` table → built-in defaults in `shared/settings.ts`, editable on the console's **Settings** page; see [*Initialization*](#initialization)): `EMAIL_ROUTING_ZONE_ID`, `INGEST_WORKER_NAME`, `BASE_DOMAIN`, `ACCESS_ACCOUNT_ID`, `ACCESS_LIST_ID`, `ALLOW_ADMIN_NEWSLETTER_CRUD`, `FROM_ADDRESS`, `TRACKING_BASE_URL`, `DEFAULT_FOOTER_HTML`, `DEFAULT_FOOTER_TEXT`, `TRACKING_ENABLED`, `TURNSTILE_SITE_KEY`, `BATCH_SIZE`, `MAX_ATTACHMENT_BYTES`, `MAX_TOTAL_ATTACHMENT_BYTES`, `MAX_ATTACHMENT_COUNT`, `ALLOWED_MIME`, `BLOCKED_EXTENSIONS`, `ATTACHMENT_LINK_THRESHOLD_BYTES`, `MAX_RAW_BYTES`, `RETENTION_DAYS`, `HARD_BOUNCE_THRESHOLD`, `SOFT_BOUNCE_THRESHOLD`, and the `WARMUP_*` keys (`WARMUP_TARGET_WEEKLY`, `WARMUP_SCHEDULE`, `WARMUP_FALLBACK_DAILY_CAP`).
- Secrets (`wrangler secret put`): `LINK_SIGNING_KEY`, `ATTACHMENT_SIGNING_KEY`. The admin worker has no auth secret — front it with a Cloudflare Access application; it optionally takes three Cloudflare API tokens: `CF_API_TOKEN` (Zone → Email Routing Rules → Edit) to auto-manage Email Routing rules, `CF_READ_API_TOKEN` (Zone → Read, plus Account → Email → Read to also show the daily quota) to auto-resolve the Email Routing zone ID from the sending domain, and `CF_ZT_API_TOKEN` (Account → Zero Trust → Edit) to sync the Cloudflare Access "Emails" list. The **consumer** worker also takes `CF_READ_API_TOKEN` (Account → Email → Read) to read the daily sending quota for warmup.

## 9. Key Flows

**Send**: Author email → Ingest verifies/parses, stores attachments in R2, writes D1 → batches enqueued → Consumer loads attachments once, builds MIME per recipient, sends via `SEND_EMAIL` → `sends` updated.

**Open / click / download**: Tracker Worker logs to `events`; downloads stream from R2 with HMAC-signed URLs.

**Bounce**: Bounce Worker cron queries Cloudflare GraphQL API → subscriber + `events` updated.

**Public signup**: `GET /subscribe/<slug>` (Turnstile) → pending subscriber +
confirmation email → `GET /verify/<id>?t=` confirms (double opt-in) before any
mail is sent.

**Unsubscribe**: One-click `POST /u/:sub` (HMAC token) or `mailto:unsubscribe+<id>@` → `subscribers.status='unsubscribed'`.

**Retention**: Cleanup Worker (cron) prunes R2 + D1 per `RETENTION_DAYS`.

## 9b. Warmup Schedule

To preserve sending reputation, the consumer worker throttles sending against
two caps (the smaller binds). Warmup is **always on** and **demand-driven** —
there is no start date.

- **Weekly cap** — a stepped schedule, the active step being the warmup
  `level`: `[500, 1500, 5000, 12000, 25000, 40000]` then `WARMUP_TARGET_WEEKLY`
  (50,000) steady state.
- **Daily cap** — the account's resolved daily quota, read live from the
  Cloudflare Email Sending API (`GET /accounts/{id}/email/sending/limits`) once
  per UTC day by the consumer and cached in `warmup_state`. Falls back to
  `WARMUP_FALLBACK_DAILY_CAP` when the API can't be read.

**Demand-driven progression** (state in the `warmup_state` table):

- Warmup enters **week 0** the first time *demand* exceeds 499, where demand =
  emails still to send across active campaigns
  (`Σ max(total_recipients − sent_count − failed_count, 0)`).
- Each 7-day window it advances **at most one level**, and **only when demand
  has grown to the next level's weekly cap** (the threshold to enter week _N_
  is `schedule[N]`). Otherwise it stays put. Levels never decrease. This avoids
  the old calendar model's idle weeks and never ramps faster than real volume.

Example (continuous 100K backlog): week0 500 → week1 1,500 → … → week5 40,000 →
week6 50,000/wk, climbing one step per week. A small 3K campaign starts at
week 0, advances to week 1 (1,500), then stays because demand never reaches the
week-2 threshold (5,000).

**Enforcement**: at the start of each `queue()` invocation the consumer reads
the warmup state, refreshes the daily cap (once per UTC day), computes demand
and the progression, then counts `sends` since the daily (UTC midnight) and
weekly (`week_started_at`) window starts. Each message sends in full, sends a
partial slice and re-enqueues the overflow with `delaySeconds`, or `msg.retry`s
when the cap is exhausted. Cloudflare Queues caps `delaySeconds` at 12 h, so
longer waits are achieved by repeated retries.

**Configuration** (settings resolved from the D1 `settings` table → built-in
defaults in `shared/settings.ts`; edit on the console's **Settings** page):

| Var                          | Default                              | Meaning                                                       |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| `WARMUP_TARGET_WEEKLY`       | `50000`                              | Steady-state weekly cap once the schedule is exhausted.       |
| `WARMUP_SCHEDULE`            | `[500,1500,5000,12000,25000,40000]`  | Per-level weekly caps; each value is also the entry threshold.|
| `WARMUP_FALLBACK_DAILY_CAP`  | `1000`                               | Daily cap used only when the live API quota can't be read.    |

The consumer needs the `CF_READ_API_TOKEN` secret (account **Email: Read**) and
the `ACCESS_ACCOUNT_ID` setting to read the live daily quota.

**Visibility**: the console's **Settings → Email sending → Sending usage** panel
shows the live daily quota, emails sent, the current warmup week, and the full
weekly progression (read-only), backed by `GET /api/email-sending-stats`.

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
7. `bounce-worker` (GraphQL delivery-failure sync + mailto unsubscribe).
8. `cleanup-worker` cron + retention.
9. `admin-worker` + dashboard queries.
10. Load test with synthetic subscriber list and large attachments; tune batch/concurrency.

---

## Further Reading

- [`docs/workers.md`](docs/workers.md) — per-worker deep dives (purpose, step-by-step walkthrough, design rationale, extension points for ingest, consumer, tracker, bounce, cleanup, admin).
- [`docs/attachments.md`](docs/attachments.md) — attachment validation, storage, link mode and signed downloads.
- [`docs/tracking.md`](docs/tracking.md) — open/click tracking mechanics, HMAC signing, and disabling tracking.
- [`docs/subscribe-unsubscribe.md`](docs/subscribe-unsubscribe.md) — every subscribe/unsubscribe path, double opt-in and the deliverability gate.
- [`docs/warmup.md`](docs/warmup.md) — demand-driven warmup model, caps, progression and configuration.
- [`docs/retention.md`](docs/retention.md) — what ages out, the cleanup cron, and cascades.
- [`docs/deploy.md`](docs/deploy.md) — end-to-end deployment runbook.
- [`docs/help.md`](docs/help.md) — the in-console help document (served from R2).
