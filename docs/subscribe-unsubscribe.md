# Subscribe & Unsubscribe — Complete Reference

This document describes **everything** the app does to manage subscribing and
unsubscribing: every entry point, the exact data it writes, the workers and
code paths involved, and the safeguards in between. It is implementation-level
and cross-references the source files.

Subscriptions are always **scoped to a single newsletter**. The `subscribers`
table has a `UNIQUE (newsletter_id, email)` constraint, so the same address can
independently subscribe to different newsletters.

---

## 1. Data model

All state lives in the D1 `subscribers` table (`db/schema.sql`):

| Column | Purpose |
| --- | --- |
| `id` | Auto-increment primary key. Used in unsubscribe / verify URLs. |
| `newsletter_id` | Owning newsletter (`ON DELETE CASCADE`). |
| `email` | Address; unique per newsletter (case stored as given, matched case-insensitively on import/lookup). |
| `name` | Optional display name. |
| `verified` | `0/1`. Confirmed via double opt-in. Defaults to `0`. |
| `status` | One of `active`, `unsubscribed`, `bounced`, `complained`. Defaults to `active`. |
| `subscribed_at` | Timestamp of (re)subscription. |
| `unsubscribed_at` | Set when status becomes `unsubscribed`. |
| `bounce_count` / `last_bounce_at` | Maintained by the bounce worker. |
| `token` | **Unsubscribe token** — random UUID, proves ownership of unsubscribe links. |
| `confirm_token` | **Double opt-in token** — random UUID, non-null only while a public signup is *pending*; cleared on confirmation. |

Two distinct tokens exist on purpose:

- `token` authenticates the **unsubscribe** link (`/u/<id>?t=<token>`).
- `confirm_token` authenticates the **double opt-in confirmation** link
  (`/verify/<id>?t=<confirm_token>`) and acts as the "pending" flag.

### The deliverability gate

Only subscribers that satisfy **both** conditions receive a campaign:

```sql
status = 'active' AND confirm_token IS NULL
```

This is enforced in `shared/db.ts → iterateActiveSubscribers()`, the generator
the ingest worker uses to stream recipients. Consequences:

- A **pending** public signup (`confirm_token` set) never receives mail, even
  though its `status` is `active`.
- Manually-added and CSV-imported subscribers have `confirm_token = NULL`, so
  they receive mail immediately (backward compatible).

The newsletter list/detail API also reports `active_count` as
`COUNT(*) WHERE status='active'`; note this count currently includes pending
public signups (they are `active` but gated out of sends by `confirm_token`).

---

## 2. Ways to SUBSCRIBE

There are three entry points. Two are operator-driven (console), one is
self-service (public page).

### 2.1 Manual add (console)

- **UI:** Newsletter → **Subscribers** tab → add.
- **API:** `POST /api/newsletters/:id/subscribers` with `{ email, name? }`
  (`workers/admin/src/index.ts`).
- **SQL:**

  ```sql
  INSERT INTO subscribers (newsletter_id, email, name, token)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(newsletter_id, email)
  DO UPDATE SET status='active', name=COALESCE(excluded.name, subscribers.name)
  ```

- **Result:** `verified` defaults to `0`, `status='active'`, `confirm_token`
  stays `NULL` → **receives mail immediately** (no confirmation). Re-adding an
  existing address **reactivates** it (sets `status='active'`) and fills in a
  name if one wasn't set. A fresh unsubscribe `token` is generated.
- Requires edit capability on the newsletter (read-only admins are blocked at
  the mutation choke point).

### 2.2 CSV import (console)

- **UI:** Subscribers tab → import.
- **API:** `POST /api/newsletters/:id/subscribers/import` (CSV text or JSON).
- **Behaviour:**
  - **Position-based**, header row always skipped.
  - Columns by order: `email`, `verified` (`True/False/1/0/yes/no`),
    `subscribed_at` (optional). **Name is not imported.**
  - **Duplicates are skipped, not updated** — both against existing rows and
    within the file (case-insensitive on email).
  - **SQL:**

    ```sql
    INSERT INTO subscribers (newsletter_id, email, name, verified, subscribed_at, token)
    VALUES (?, ?, NULL, ?, COALESCE(NULLIF(?, ''), datetime('now')), ?)
    ON CONFLICT(newsletter_id, email) DO NOTHING
    ```

  - Returns `{ added, duplicated }`, surfaced in a popup.
- **Result:** imported rows have `confirm_token = NULL` → receive mail
  immediately. `verified` is whatever the file says.

### 2.3 Public signup page (self-service, double opt-in)

This is the only path where the *subscriber* initiates, and it is the one with
the most machinery. It is **opt-in per newsletter** and **off by default**.

#### Configuration (operator, one-time + per-newsletter)

- **Per newsletter:** Newsletter → **Signup** tab
  (`web/src/pages/NewsletterDetail.tsx → SignupEditor`):
  - `allow_public_signup` toggle (off by default).
  - `slug` — the public identifier in `/subscribe/<slug>`.
    - **What a slug is:** the short, URL-friendly "address" of a newsletter's
      public signup page — a human-readable, lowercase-hyphenated version of its
      name (e.g. *"Weekly Product Digest"* → `weekly-product-digest`, giving
      `…/subscribe/weekly-product-digest`). It is used instead of the internal
      newsletter UUID so the link is clean and shareable, and it is unique
      across newsletters so `/subscribe/<slug>` resolves to exactly one. (The
      term comes from publishing/CMS jargon, e.g. WordPress.)
    - Auto-derived from the name at creation via `uniqueSlug()` /`slugify()`
      (lowercase, accent-stripped, hyphenated, deduped with `-2`, `-3`, …).
    - Editable; validated against `^[a-z0-9]+(?:-[a-z0-9]+)*$`, max 64 chars,
      unique across newsletters. Submitting an **empty** slug re-derives one
      from the current name.
  - Shows the live **subscribe URL** and an **`<iframe>` embed snippet** (the
    iframe is the recommended embed because it carries the Turnstile widget).
  - Persisted via `PATCH /api/newsletters/:id` (`slug`, `allow_public_signup`).
- **Global, one-time (super admin):**
  - Create a **Cloudflare Turnstile** widget for the domain.
  - Set its **site key** under **Settings → Tracking → Public signup**
    (`TURNSTILE_SITE_KEY`, a value in the D1 `settings` table).
  - Set the matching **secret** on the tracker worker:
    `wrangler secret put TURNSTILE_SECRET_KEY`.
  - Email Sending (DKIM) must be enabled on the domain (the tracker uses a
    `send_email` binding to deliver the confirmation).

#### The hosted page & flow

All served by the **tracker worker** (`workers/tracker/src/index.ts`) at
`https://track.<domain>`:

**`GET /subscribe/<slug>`**

1. `loadSettings()` resolves config (site key, base URL, from address, etc.).
2. `findSignupNewsletter(slug)` looks up the newsletter and returns it only if
   it **exists, is `enabled=1`, and `allow_public_signup=1`** — otherwise a
   generic **404** (so disabled/non-existent slugs are indistinguishable).
3. If Turnstile isn't fully configured (`TURNSTILE_SITE_KEY` +
   `TURNSTILE_SECRET_KEY` + `SEND_EMAIL` binding) → **503 "Signup unavailable"**.
4. Otherwise renders a branded, mobile-friendly form (`subscribeForm()`): email,
   optional name, and the Cloudflare Turnstile widget. Light/dark via CSS.

**`POST /subscribe/<slug>`**

1. Re-runs the eligibility + configuration checks above.
2. Parses `email`, `name`, `cf-turnstile-response`.
3. **Validates email** with a basic regex; invalid → re-render form with error
   (HTTP 400).
4. **Verifies Turnstile** (`verifyTurnstile()`): server-to-server POST to
   `https://challenges.cloudflare.com/turnstile/v0/siteverify` with the secret,
   token and client IP. Any non-success → re-render form with error (400).
5. **Decides whether to (re)send a confirmation** by looking up the existing
   row:
   - If the address is **already confirmed and active**
     (`status='active' AND confirm_token IS NULL`) → **do nothing** to the DB
     (don't reset them to pending), but still show the neutral success page.
   - Otherwise (new / unsubscribed / bounced / still-pending) → **upsert as
     pending**:

     ```sql
     INSERT INTO subscribers (newsletter_id, email, name, verified, status, token, confirm_token)
     VALUES (?, ?, ?, 0, 'active', ?, ?)
     ON CONFLICT(newsletter_id, email) DO UPDATE SET
       confirm_token = excluded.confirm_token,
       name = COALESCE(NULLIF(excluded.name, ?), subscribers.name)
     ```

     A new `confirm_token` (and, for brand-new rows, a new unsubscribe `token`)
     is generated. Because `confirm_token` is now set, the row is gated out of
     sends until confirmed.
6. Sends the **confirmation email** (`sendConfirmationEmail()`, fired via
   `ctx.waitUntil`) using `buildEmail()` and the `SEND_EMAIL` binding. From
   address = the newsletter's `from_address` or the global `FROM_ADDRESS`. The
   email contains a button + plain link to:

   ```
   https://track.<domain>/verify/<id>?t=<confirm_token>
   ```

7. Returns the **same neutral "Almost there — check your inbox" page**
   regardless of whether the address was new or already subscribed. This is an
   **anti-enumeration** measure: the response can't reveal who is already
   subscribed.

**`GET /verify/<id>?t=<confirm_token>`** (`handleVerify()`)

1. Loads the row's `confirm_token`.
2. No row, or token mismatch → **"Invalid link"** (400 / 403).
3. `confirm_token IS NULL` already → **"Already confirmed"** success page (so a
   second click is harmless / idempotent).
4. On a valid match, confirms:

   ```sql
   UPDATE subscribers
   SET verified = 1, status = 'active', confirm_token = NULL,
       unsubscribed_at = NULL, subscribed_at = datetime('now')
   WHERE id = ?
   ```

   This clears the pending flag (so they now pass the deliverability gate),
   marks them verified, and **reactivates** a previously
   unsubscribed/bounced address (double opt-in doubles as resubscribe).
5. Shows the **"Subscription confirmed"** page.

#### Why double opt-in matters here

- No mail is ever sent to an address until its owner clicks the confirmation
  link — protects against typos, malicious sign-ups of third parties, and
  list-poisoning.
- The neutral responses prevent the page from being used to probe membership.
- Turnstile blocks automated/bulk bot submissions before any DB write or email.

---

## 3. Ways to UNSUBSCRIBE

Every campaign email advertises unsubscribe options; there is also a footer link
and an operator path. All of them converge on setting
`status='unsubscribed', unsubscribed_at=now`.

### 3.1 What the consumer puts in each email

For every recipient, the **consumer worker** (`workers/consumer/src/index.ts`)
builds:

- A signed unsubscribe URL via
  `unsubscribeUrl(base, subscriberId, token)` →
  `https://track.<domain>/u/<id>?t=<token>` (`shared/tracking.ts`).
- Headers:

  ```
  List-Unsubscribe: <https://track.<domain>/u/<id>?t=<token>>, <mailto:unsubscribe+<id>@<domain>>
  List-Unsubscribe-Post: List-Unsubscribe=One-Click
  ```

- A **footer** (HTML + text) that always contains the unsubscribe link (see
  §3.4).

So mail clients can offer a native unsubscribe button (RFC 8058 one-click), and
there is a human-clickable link in the body.

### 3.2 HTTPS one-click / link (handled by the tracker)

Route `/u/<id>` in `workers/tracker/src/index.ts`:

- **`GET /u/<id>?t=<token>`** — validates the token (`checkUnsubToken()`:
  compares against the stored `token`). On success returns a tiny confirmation
  page (`unsubPage()`) with a POST form; bad/absent token → 400/403.
- **`POST /u/<id>`** (one-click, or the page's form submit) — token may come
  from the query string or the form body. On valid token:

  ```sql
  UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now')
  WHERE id = ?
  ```

  Then logs an `unsubscribe` event (`logEvent`, with UA/IP) and returns
  `"Unsubscribed."`.

The token requirement means an unsubscribe link only works for the intended
subscriber and can't be forged by guessing IDs.

### 3.3 Mailto fallback (handled by the bounce worker)

The `mailto:unsubscribe+<id>@<domain>` option is for clients that prefer email
unsubscribe. **No extra Email Routing rule is required** because the bounce
worker is already the **catch-all** inbound route (per the deploy runbook).

`workers/bounce/src/index.ts → email()`:

1. Lowercases the recipient and matches `unsubscribe\+(\d+)@`.
2. If matched:

   ```sql
   UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now')
   WHERE id = ? AND status='active'
   ```

3. If a row changed, inserts an `unsubscribe` event.

Here the sender's own mail provider is the proof of intent — a mailto carries no
token — which matches standard "unsubscribe by email" behaviour.

### 3.4 Footer link (guaranteed)

`shared/footer.ts` renders the per-newsletter footer (falling back to the global
`DEFAULT_FOOTER_*`). The `{{unsubscribe_url}}` token resolves to the same
`/u/<id>?t=<token>` URL. **If an author omits the token, an unsubscribe line is
appended automatically** (`renderFooterHtml` / `renderFooterText`), so an
unsubscribe link is always present. Footer HTML is sanitized to an allow-list on
save (`sanitizeFooterHtml`), and the footer is appended **after** tracking
instrumentation so its unsubscribe link is never click-rewritten.

### 3.5 Operator-driven (console)

- **Remove a subscriber:** `DELETE /api/newsletters/:id/subscribers/<sid>` does
  **not** hard-delete — it sets `status='unsubscribed', unsubscribed_at=now`
  (soft delete, preserves history).
- **Edit status:** `PATCH /api/newsletters/:id/subscribers/<sid>` can set
  `status` directly (and `name`); choosing `unsubscribed` also stamps
  `unsubscribed_at`.

### 3.6 Automatic (bounces & complaints)

Not user-initiated but they change deliverability the same way:

- **Bounces:** the bounce worker increments `bounce_count` and, past the
  hard/soft threshold, sets `status='bounced'` (excluded from sends).
- **Complaints:** a spam complaint sets `status='complained'`.

---

## 4. Re-subscribing after unsubscribe

- **Public page:** submitting again sends a fresh confirmation; clicking it runs
  the `verify` UPDATE which sets `status='active'` and clears
  `unsubscribed_at` — a clean, consented resubscribe.
- **Console:** re-adding (POST) or a `status` PATCH back to `active`
  reactivates immediately.

A `bounced`/`unsubscribed` address therefore is never permanently locked out; it
just won't receive mail until reactivated by one of the above.

---

## 5. End-to-end summary

| Action | Trigger | Worker | Net DB effect | Receives mail? |
| --- | --- | --- | --- | --- |
| Manual add | Console POST | admin | `status=active`, `confirm_token=NULL` | Immediately |
| CSV import | Console POST | admin | insert if new, `confirm_token=NULL` | Immediately |
| Public signup (step 1) | `POST /subscribe/<slug>` | tracker | `status=active`, `confirm_token=set` (pending) | **No** (gated) |
| Public confirm (step 2) | `GET /verify/<id>` | tracker | `verified=1`, `confirm_token=NULL`, reactivated | Yes |
| Unsubscribe (one-click/link) | `GET/POST /u/<id>?t=` | tracker | `status=unsubscribed` | No |
| Unsubscribe (mailto) | inbound `unsubscribe+<id>@` | bounce | `status=unsubscribed` | No |
| Remove (console) | `DELETE …/subscribers/<id>` | admin | `status=unsubscribed` (soft) | No |
| Bounce/complaint | inbound bounce / FBL | bounce | `status=bounced`/`complained` | No |

**Deliverability rule (the single source of truth):**
`status='active' AND confirm_token IS NULL` (`shared/db.ts`).

---

## 6. Source map

| Concern | File |
| --- | --- |
| Schema (`subscribers`, `slug`, `allow_public_signup`, `confirm_token`) | `db/schema.sql` (migration `db/migrations/0012_*`) |
| Recipient gate | `shared/db.ts → iterateActiveSubscribers` |
| Unsubscribe URL builder | `shared/tracking.ts → unsubscribeUrl` |
| Footer + guaranteed unsubscribe link | `shared/footer.ts` |
| Public subscribe/verify pages + Turnstile | `workers/tracker/src/index.ts` |
| HTTPS unsubscribe (`/u/<id>`) | `workers/tracker/src/index.ts` |
| Mailto unsubscribe + bounces | `workers/bounce/src/index.ts` |
| List-Unsubscribe headers + footer assembly | `workers/consumer/src/index.ts` |
| Manual add / import / status PATCH / slug | `workers/admin/src/index.ts` |
| Signup tab UI | `web/src/pages/NewsletterDetail.tsx → SignupEditor` |
| Turnstile site key setting | `web/src/pages/Settings.tsx`, `shared/settings.ts` |
