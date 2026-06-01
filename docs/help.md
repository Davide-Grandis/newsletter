# Newsletter Admin Console — Help

This console manages one or more **newsletters**. Each newsletter is an
independent mailing list with its own inbound email address, author allow-list
and subscriber list. Authors send an issue by emailing the newsletter's inbound
address; the pipeline validates, archives and fans it out to subscribers.

## Pages

- **Dashboard** — subscriber/campaign/event overview and the current warmup quota.
- **Newsletters** — create newsletters and manage each one's subscribers and authors.
- **Campaigns** — every issue that has been ingested, with delivery stats.
- **Bounces** — recent hard/soft bounces.
- **Help** — this document.

## Newsletters

A newsletter has a **name**, a unique **inbound address**, an **enabled** toggle,
and its own subscribers and authors.

- **Inbound address** — mail sent here is routed to the ingest worker. The
  console creates/updates/deletes the matching Email Routing rule automatically
  (see *Requirements*). Disabling a newsletter makes the ingest worker reject
  incoming mail for it.
- **Authors** — only addresses on this list may send the newsletter. Inbound
  mail from anyone else is rejected. Lookup is case-insensitive.
- **Subscribers** — recipients, scoped to the newsletter. Add individually or
  import a CSV (`email,name`).

## Database schema

A single Cloudflare D1 database (`newsletter_db`) backs everything. Core tables:

| Table | Purpose |
| --- | --- |
| `newsletters` | One row per newsletter: `id`, `name`, `inbound_address` (unique), `enabled`, `created_at`. |
| `authors` | Per-newsletter send allow-list. Primary key `(newsletter_id, email)`. |
| `subscribers` | Per-newsletter recipients with `status` (active / unsubscribed / bounced / complained), bounce counters and an unsubscribe `token`. Unique on `(newsletter_id, email)`. |
| `campaigns` | One row per ingested issue, scoped by `newsletter_id`, with subject, body, status and delivery counters. |
| `attachments` | Files for a campaign, deduplicated by SHA-256 and stored in R2 (`r2_key`). |
| `sends` | Per-recipient delivery record for each campaign (status, message id, error). |
| `events` | Engagement/lifecycle events: open, click, bounce, complaint, unsubscribe, download. |

Authors, subscribers, attachments, sends and events are removed automatically
when their parent newsletter or campaign is deleted (`ON DELETE CASCADE`).

## R2 buckets

The system uses two R2 buckets:

- **`newsletter-admin`** (EU jurisdiction) — assets for this console. Holds GUI
  media such as logos and header images (served read-only under `/media/`) and
  the Help document (`help.md`) you are reading now. Bound to the admin worker
  as `ASSETS_R2`.
- **`newsletter-archive`** — pipeline storage. Holds the raw inbound email MIME
  (`campaigns/<id>/raw.eml`), validated attachments (deduplicated by content
  hash) and archived bounce messages. Bound to the ingest, consumer, bounce and
  cleanup workers as `ARCHIVE`; the cleanup worker purges it on the retention
  schedule.

## Requirements

- **Cloudflare Access** — the console must sit behind an Access application. It
  trusts the `Cf-Access-Authenticated-User-Email` header injected at the edge
  and has no other authentication; every `/api/*` call without it returns 401.
- **API token for newsletter email addresses** — to manage Email Routing rules
  automatically (create/update/delete a rule whenever a newsletter's inbound
  address changes), the admin worker needs a Cloudflare API token with
  **Zone → Email Routing Rules → Edit** on the newsletter domain. Store it as
  the `CF_API_TOKEN` secret:

  ```bash
  cd workers/admin && npx wrangler secret put CF_API_TOKEN
  ```

  The zone and target worker are configured via `EMAIL_ROUTING_ZONE_ID` and
  `INGEST_WORKER_NAME` in `workers/admin/wrangler.toml`. Without the token,
  newsletter management still works but routing rules are **not** updated — the
  console shows a warning and you must add the Email Routing rule manually.
- **Signing keys** — the consumer and tracker workers share `LINK_SIGNING_KEY`
  and `ATTACHMENT_SIGNING_KEY` secrets (identical on both) for signed tracking
  and attachment links.
