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
- **Settings** — global runtime configuration (sending identity, domains, limits). See *Initial setup*.
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
- **Subscribers** — recipients, scoped to the newsletter. Add individually
  (verified defaults to **False**), import from CSV, or export the current list
  to CSV. See *Subscriber CSV import* and *Subscriber statuses* below.

## Subscriber CSV import

Import is **position-based** and the **header row is always ignored** (the first
line is skipped, whatever it contains). Each remaining row maps by column order:

| Position | Field | Notes |
| --- | --- | --- |
| 1 | **email** | Required. Rows with an empty email are skipped. |
| 2 | **verified** | `True`/`False` (also accepts `1`/`0`, `yes`/`no`). Anything else is treated as False. |
| 3 | **date subscribed** | Optional. If blank, the current date/time is used. |

Notes:

- The **name** field is *not* imported — imported subscribers have no name.
- **Duplicates are skipped, not updated.** An email already present in the list
  (case-insensitive), or repeated within the file, is counted as a duplicate. A
  popup reports `Subscribers added: X` and `Duplicated: Y` when the import finishes.

Example file:

```csv
email,verified,date subscribed
alice@example.com,True,2026-05-01 09:00:00
bob@example.com,False,
carol@example.com,1,2026-05-03
```

**Export** produces a CSV with a header row using the UI field names
(`Email,Name,Verified,Status,Bounces,Date subscribed`) and honours the current
status/search filters. Note the export column order differs from the import
order, so an exported file is not a drop-in re-import.

## Subscriber statuses

Each subscriber has a **status** that controls deliverability. Only **active**
subscribers receive a campaign.

| Status | Meaning |
| --- | --- |
| **active** | Normal subscriber; included in every send. |
| **unsubscribed** | Opted out (via the unsubscribe link in an email). Excluded from sends. |
| **bounced** | The address hard-bounced; set automatically by the bounce handler. Excluded from sends. |
| **complained** | Marked a message as spam; set automatically from complaint feedback. Excluded from sends. |

The separate **verified** flag indicates whether the address has been confirmed;
it is independent of status and defaults to False for newly added subscribers.

## Email tracking & content transformation

Before each copy is sent, the consumer worker **transforms the HTML body** of the
campaign so engagement can be measured and large files delivered. The original
issue the author sent is archived untouched; only the per-recipient outgoing copy
is rewritten. The transformations are:

- **Link rewriting (click tracking).** Every `http(s)` link in the HTML
  (`<a href="…">`) is replaced with a *signed* redirect through the tracker
  worker: `https://<tracking-base>/c/<campaign>/<subscriber>?u=<destination>&sig=…`.
  When the recipient clicks, the tracker verifies the signature, records a
  **click** event, then `302`-redirects to the original destination. The
  plain-text alternative and non-`http(s)` links (e.g. `mailto:`) are left
  unchanged.
- **Open pixel (open tracking).** A transparent 1×1 GIF is appended to the HTML:
  `<img src="https://<tracking-base>/o/<campaign>/<subscriber>.gif">`. When the
  mail client loads remote images, that request records an **open**. This is an
  approximate signal — clients that block images undercount, and privacy proxies
  (e.g. Apple Mail Privacy Protection) can prefetch it and overcount.
- **Large attachments (link mode).** When a campaign's combined attachment size
  exceeds the *Link-mode threshold*, the files are **not** attached to the email.
  Instead an **Attachments** list of signed download links is appended
  (`…/a/<campaign>/<subscriber>/<attachmentId>?sig=…`); the tracker verifies the
  signature, streams the file from R2, and records a **download**. Smaller
  attachments (and inline images) are embedded in the message as normal.
- **Unsubscribe.** A `List-Unsubscribe` header (with one-click `POST` support)
  pointing at `…/u/<subscriber>?t=<token>` is added so mail clients can offer a
  native unsubscribe button.

### Turning tracking off

The **Settings → Tracking** toggle (`TRACKING_ENABLED`) controls only the first
two transformations. When **off**:

- Links are sent **unmodified** (recipients see and click your real URLs), and
- the open pixel is **omitted**.

As a result, **opens and clicks are no longer recorded** and the Analytics page
shows none for sends made while tracking is off. Large-attachment **download
links are unaffected** — they are a delivery mechanism, not tracking, so they
remain (and a download may still be logged). The toggle takes effect on the next
campaign sent.

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
| `admins` | Console operators and their saved UI preferences (currently `theme`). Keyed by `email`; a row is created on first login, seeded with the detected OS theme. |

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

## Data retention & cleanup

A daily cleanup cron enforces the **Retention (days)** setting
(`RETENTION_DAYS`). Once a campaign is older than the retention window it is
**permanently deleted**, and the deletion is comprehensive:

- The campaign row is removed; `ON DELETE CASCADE` also removes its
  **attachments**, **sends** and **engagement events** from the database.
- The stored files in R2 are deleted: every attachment blob **and** the archived
  raw inbound email (`campaigns/<id>/raw.eml`).

**Is the content still available afterwards? No.** After cleanup runs:

- **Attachment download links return “not found” (404)** — both the database row
  and the R2 object are gone, so previously sent link-mode download links stop
  working.
- The campaign **no longer appears** in the Campaigns or Analytics pages, and its
  history (opens, clicks, downloads, per-recipient sends) is gone.
- **Click links still redirect** to their original destination — the signed
  redirect is stateless and doesn't depend on stored data — but the click is
  **no longer recorded**. The open pixel likewise still returns an image but is
  no longer tied to a live campaign.

Subscribers, authors and newsletters are **not** affected by retention; only
campaign-scoped data is purged. Set a longer retention window if you need
attachment links or analytics to remain available for longer.

## Initial setup

Before the first campaign, an operator must configure the global **Settings** so
they match the Cloudflare zone described under *Requirements*. Open the
**Settings** page and set at least the sending identity and domains:

- **Default from address** — the `From:` header for outbound mail (a newsletter
  can override this with its own sender).
- **Base domain** — the domain newsletters receive inbound mail on.
- **Bounce domain** and **Tracking base URL** — the VERP return-path domain and
  the tracker worker's base URL.
- **Email Routing zone ID** and **Ingest worker name** — let the console keep
  Email Routing rules in sync automatically (see *Requirements*).

Each field is **locked until you click Edit**. A saved value is stored in the
database and overrides the built-in default (defined in `shared/settings.ts`);
**Reset** reverts a field to that default. Values left unset fall back to the
built-in default.

### Why the Email Routing zone ID is needed

When you create, rename or delete a newsletter, the console automatically
creates/moves/deletes the matching **Email Routing rule** that forwards the
newsletter's inbound address to the ingest worker — so authors can email a new
newsletter without anyone touching the Cloudflare dashboard. Cloudflare's Email
Routing API is **scoped per zone**, so this automation needs the **Email Routing
zone ID** to know which zone's routing table to edit (together with the
`CF_API_TOKEN` secret for permission, and **Ingest worker name** as the rule's
target).

It is only needed for that automation, not for sending. If you leave it unset
(or omit the token), newsletter management still works, but routing rules are
**not** synced: the console shows a warning and you must add each newsletter's
Email Routing rule manually in the Cloudflare dashboard.

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

  The zone and target worker are configured by the **Email Routing zone ID** and
  **Ingest worker name** settings (Settings page; defaults in
  `shared/settings.ts`) — see *Initial setup*. Without the token, newsletter
  management still works but routing rules are **not** updated — the console
  shows a warning and you must add the Email Routing rule manually.
- **Signing keys** — the consumer and tracker workers share `LINK_SIGNING_KEY`
  and `ATTACHMENT_SIGNING_KEY` secrets (identical on both) for signed tracking
  and attachment links.
