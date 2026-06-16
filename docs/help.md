# Newsletter Admin Console — Help

This console manages one or more **newsletters**. Each newsletter is an
independent mailing list with its own inbound email address, author allow-list
and subscriber list. Authors send an issue by emailing the newsletter's inbound
address; the pipeline validates, archives and fans it out to subscribers.

## Pages

- **Dashboard** — subscriber/campaign/event overview.
- **Newsletters** — create newsletters and manage each one's subscribers and authors.
- **Campaigns** — every issue that has been ingested, with delivery stats.
- **Bounces** — recent hard/soft bounces.
- **Settings** — global runtime configuration (sending identity, domains, limits). The **Email sending** tab also shows live **Sending usage**: the account's daily quota, emails sent, the current warmup week and the weekly progression. See *Initial setup*.
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
- **Signup** — enable a hosted **public subscribe page** for the newsletter and
  get its URL and an embed snippet. See *Public signup* below.

## Public signup

Each newsletter can expose a **hosted subscribe page** so anyone can sign up,
using **double opt-in** (the new subscriber must click a confirmation link in an
email before they are added — so they never receive mail until confirmed).

Configure it on the newsletter's **Signup** tab:

- **Enable the public subscribe page** — off by default. While off, the public
  URL returns *not found*.
- **URL slug** — the public identifier in `…/subscribe/<slug>`. Auto-generated
  from the newsletter name; editable (lowercase letters, numbers and single
  hyphens). Leave the field empty when saving to re-generate it from the name.
- **Public subscribe URL** — the live link to share.
- **Embed snippet** — an `<iframe>` you can paste into any website to embed the
  form (it includes the bot-protection widget).

How it works:

1. A visitor enters their email (and optional name) and passes a **Cloudflare
   Turnstile** bot check.
2. The pipeline records a *pending* subscriber and emails them a confirmation
   link. The response is always the same neutral "check your inbox" message, so
   it can't be used to probe who is subscribed.
3. Clicking the link confirms the subscription (and re-activates a previously
   unsubscribed/bounced address). Only then do they start receiving mail.

**Prerequisites (one-time, super admin):** create a Turnstile widget for the
domain, set its **site key** under **Settings → Tracking → Public signup**
(`TURNSTILE_SITE_KEY`), and set the matching secret on the tracker worker
(`wrangler secret put TURNSTILE_SECRET_KEY`). Until both are set, the public page
reports itself unavailable.

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
- **Unsubscribe.** A `List-Unsubscribe` header is added so mail clients can show
  a native unsubscribe button. It offers two methods: a one-click HTTPS `POST`
  to `…/u/<subscriber>?t=<token>` (RFC 8058, handled by the tracker), and a
  `mailto:unsubscribe+<id>@…` fallback (handled by the bounce worker via the
  existing catch-all inbound route — no extra routing rule needed). The same
  `…/u/<subscriber>?t=<token>` link is also used by the footer's unsubscribe
  link. Both methods mark the subscriber unsubscribed.

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

## Email footer

Every email gets a **footer** appended to both its HTML and plain-text parts.
The footer always contains an **unsubscribe link** (in addition to the
`List-Unsubscribe` header mail clients use for their native button).

- **Global default** — set under **Settings → Email sending → Default footer**
  (`DEFAULT_FOOTER_HTML` / `DEFAULT_FOOTER_TEXT`). Used for any newsletter that
  has no footer of its own.
- **Per-newsletter footer** — on a newsletter's page, the **Email footer** card
  lets you override the default with HTML and plain-text specific to that
  newsletter, with a **live preview**. Leave both fields empty to inherit the
  global default.
- **Tokens** — `{{unsubscribe_url}}`, `{{newsletter_name}}` and `{{email}}` are
  substituted per recipient. If you omit `{{unsubscribe_url}}`, an unsubscribe
  line is appended automatically, so an unsubscribe link is always present.
- **Safety** — footer HTML is sanitized to a safe allow-list of formatting tags
  when saved (scripts, event handlers and unsafe URLs are stripped). The footer
  is added *after* tracking instrumentation, so its links are **not**
  click-tracked.

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
- **Sending domain** — the Cloudflare zone newsletters send from and receive
  inbound mail on. Saving it auto-resolves the Email Routing zone (see below);
  it has no default and is stored only in the database.
- **Tracking base URL** — the tracker worker's base URL (opens, clicks,
  unsubscribe, downloads). VERP bounce return-path addresses reuse the sending
  domain, so there is no separate bounce-domain setting. When the sending domain
  is saved, the console auto-creates the `bounce@<domain>` Email Routing rule.
  **One-time:** enable Email Routing **Subaddressing** for the domain in the
  Cloudflare dashboard (Compute → Email Service → Email Routing → Settings) — it
  cannot be set via API, and without it the `bounce+<id>@<domain>` VERP
  addresses won't reach the bounce worker.
- **Ingest worker name** — the worker the auto-managed Email Routing rules
  forward inbound mail to.
- **Public signup (optional)** — to offer the hosted subscribe page (see *Public
  signup*), create a Cloudflare **Turnstile** widget for the domain, set its
  **site key** under *Public signup* (`TURNSTILE_SITE_KEY`), and set the secret
  on the tracker worker (`wrangler secret put TURNSTILE_SECRET_KEY`). (The
  `mailto:` unsubscribe fallback needs no extra routing — the bounce worker
  already receives it via the catch-all inbound route.)

Each field is **locked until you click Edit**. A saved value is stored in the
database and overrides the built-in default (defined in `shared/settings.ts`);
**Reset** reverts a field to that default. Fields with no built-in default (the
sending domain) have no Reset and must be set explicitly.

### Why the Email Routing zone ID is needed (and how it's set)

When you create, rename or delete a newsletter, the console automatically
creates/moves/deletes the matching **Email Routing rule** that forwards the
newsletter's inbound address to the ingest worker — so authors can email a new
newsletter without anyone touching the Cloudflare dashboard. Cloudflare's Email
Routing API is **scoped per zone**, so this automation needs the Email Routing
zone ID to know which zone's routing table to edit (together with the
`CF_API_TOKEN` secret for permission, and **Ingest worker name** as the rule's
target).

You don't enter the zone ID directly — it's **derived from the sending domain**.
When you save the **Sending domain**, the console looks it up via the Cloudflare
API using the `CF_READ_API_TOKEN` secret (Zone → Read) and stores the resolved
zone ID for you, so the field isn't shown.

It is only needed for that automation, not for sending. If `CF_READ_API_TOKEN`
is unset, the domain isn't a Cloudflare zone in this account, or a token lacks
scope, the domain still saves but the console shows a warning — and you must add
each newsletter's Email Routing rule manually in the Cloudflare dashboard.

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

  The target worker is configured by the **Ingest worker name** setting; the
  zone ID is resolved automatically from the **Sending domain** (see below).
  Without the token, newsletter management still works but routing rules are
  **not** updated — the console shows a warning and you must add the Email
  Routing rule manually.
- **API token to resolve the sending domain's zone** — saving the **Sending
  domain** looks up its Email Routing zone ID via the Cloudflare API, and the
  Settings pick-list reads each domain's Email Routing status. This uses a
  read-only Cloudflare API token stored as the `CF_READ_API_TOKEN` secret:

  ```bash
  cd workers/admin && npx wrangler secret put CF_READ_API_TOKEN
  ```

  Use an account-scoped **Read all resources** token: **Zone → Read** alone
  resolves the zone ID but cannot read Email Routing status (the pick-list would
  show every domain without an on/off indicator). Without the token, the domain
  still saves but the zone ID isn't resolved (the console warns and you
  configure Email Routing rules manually).
- **API token to sync console users** — adding/removing console users keeps the
  Cloudflare Access "Emails" list in sync. This uses an account-scoped token
  with **Zero Trust → Edit**, stored as the `CF_ZT_API_TOKEN` secret:

  ```bash
  cd workers/admin && npx wrangler secret put CF_ZT_API_TOKEN
  ```

  All three admin-worker tokens are stored as encrypted Wrangler **secrets** and
  appear in the dashboard under **Settings → Variables and Secrets** (not under
  *Bindings*).
- **Signing keys** — the consumer and tracker workers share `LINK_SIGNING_KEY`
  and `ATTACHMENT_SIGNING_KEY` secrets (identical on both) for signed tracking
  and attachment links.
