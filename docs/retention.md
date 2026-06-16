# Retention — Complete Reference

This document describes how the newsletter pipeline enforces data retention:
which data ages out, when, how it is purged, what cascades automatically, and
how to tune the retention window.

---

## Glossary

| Term | Meaning |
| --- | --- |
| **Retention window** | The number of days a campaign and all its derived data are kept. Controlled by `RETENTION_DAYS`. |
| **Campaign** | A single send triggered by an inbound email. Identified by a UUID. Parent record for sends, attachments and events. |
| **Sends** | Per-recipient delivery records in the `sends` table (`pending`, `sent`, or `failed`). |
| **Events** | Engagement records (`open`, `click`, `download`, `bounce`, `complaint`, `unsubscribe`) in the `events` table. |
| **Attachments** | File metadata in the D1 `attachments` table, plus the corresponding bytes in R2. |
| **R2** | Cloudflare R2 object storage. Stores the raw `.eml` and attachment bytes. Both are deleted on campaign purge. |
| **D1** | Cloudflare D1 SQLite database. All relational data (campaigns, sends, events, attachments) lives here. |
| **`ON DELETE CASCADE`** | A foreign-key constraint: when a parent row is deleted, child rows referencing it are automatically deleted by SQLite. |
| **Cleanup worker** | `workers/cleanup` — a scheduled Cloudflare Worker that runs nightly and deletes expired campaigns. |
| **Cron trigger** | Cloudflare cron that fires the cleanup worker every day at 04:00 UTC (`0 4 * * *`). |
| **`raw.eml`** | The verbatim original inbound email stored in R2 (`campaigns/<campaign_id>/raw.eml`). Deleted with the campaign. |

---

## 1. What is retained and for how long

The retention window is a single setting (`RETENTION_DAYS`, default **90 days**),
measured from `campaigns.created_at` (when the ingest worker created the
campaign). Anything with `created_at < now − RETENTION_DAYS` is considered
expired.

**Data that ages out with the campaign:**

| Data | Where | How deleted |
| --- | --- | --- |
| Campaign metadata | D1 `campaigns` row | `DELETE FROM campaigns WHERE id = ?` |
| Per-recipient delivery records | D1 `sends` rows | `ON DELETE CASCADE` from campaigns |
| Engagement events | D1 `events` rows | `ON DELETE CASCADE` from campaigns |
| Attachment metadata | D1 `attachments` rows | `ON DELETE CASCADE` from campaigns |
| Attachment bytes | R2 per `r2_key` | Explicitly deleted by the cleanup worker |
| Raw inbound email | R2 `campaigns/<id>/raw.eml` | Explicitly deleted by the cleanup worker |

**Data that is never purged by retention:**

| Data | Why |
| --- | --- |
| Subscriber list | Subscribers exist independently of campaigns; their status is a permanent record of consent. |
| Newsletter configuration | Not campaign-derived. |
| Admin users and settings | Permanent operational data. |
| `logs` table entries | Pipeline activity log; not cascade-linked to campaigns. Purge manually or add a separate cleanup if needed. |
| `warmup_state` | Single global row; not campaign-derived. |

---

## 2. The cleanup worker

`workers/cleanup/src/index.ts` is a **scheduled** Cloudflare Worker (no HTTP
interface). It runs once per day at 04:00 UTC.

### Algorithm

```
days = max(1, RETENTION_DAYS)
cutoff = datetime('now', '-<days> days')

SELECT id FROM campaigns WHERE created_at < cutoff
→ for each campaign:
    SELECT r2_key FROM attachments WHERE campaign_id = ?
    → for each r2_key: ARCHIVE.delete(r2_key)   // R2 attachment bytes
    ARCHIVE.delete('campaigns/<id>/raw.eml')     // R2 raw email
    DELETE FROM campaigns WHERE id = ?           // D1 cascade
```

Key properties:

- **Sequential per campaign** — each campaign is processed completely before
  moving to the next, so a partial failure (e.g. one R2 delete timing out)
  affects only that campaign.
- **R2 failures are silenced** (`.catch(() => {})`) — the D1 delete still runs.
  Orphaned R2 objects are benign storage overhead; the next run will not
  re-attempt them because the campaign row is already gone from D1.
- **D1 cascade is authoritative** — deleting the `campaigns` row automatically
  removes `sends`, `events`, and `attachments` rows via `ON DELETE CASCADE`.
  The explicit R2 deletes happen *before* the D1 delete so the attachment keys
  are still queryable.
- **`RETENTION_DAYS` is floored at 1** — prevents an accidental zero or negative
  value from wiping all data.

### Invocation

The worker has no HTTP handler; it only exports `scheduled()`. The cron trigger
is defined in `workers/cleanup/wrangler.toml`:

```toml
[triggers]
crons = ["0 4 * * *"]
```

---

## 3. Events table and subscriber FK

The `events` table has two foreign keys:

```sql
campaign_id   TEXT REFERENCES campaigns(id) ON DELETE CASCADE
subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE SET NULL
```

- When a **campaign** is purged, its events are cascade-deleted.
- When a **subscriber** is hard-deleted (rare — the UI soft-deletes), their
  `subscriber_id` in remaining events is set to `NULL` (preserving the event row
  but breaking the link to the person).

---

## 4. Logs table

The `logs` table (pipeline activity: ingest, queue, send decisions) is **not**
linked to campaigns by a foreign key. Entries for expired campaigns therefore
survive the cleanup. This is intentional — operational logs may be useful for
auditing after a campaign's content and sends are gone.

If you want to prune old log entries, add a manual SQL query or extend the
cleanup worker. No automated log retention is implemented.

---

## 5. Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `RETENTION_DAYS` | `90` | Number of days to keep a campaign and all its derived data. Minimum 1. |

Edit from the console's **Settings → Retention** tab, or directly in the D1
`settings` table.

The cleanup worker reads this setting at runtime (via `loadSettings()`), so
changing it takes effect on the next scheduled run without redeploying the
worker.

---

## 6. Operational notes

- **No manual trigger.** The cleanup worker is scheduled only; there is no
  API endpoint to trigger it on demand. To run it immediately, use:
  ```bash
  wrangler dev workers/cleanup/src/index.ts  # then trigger scheduled event
  # or
  wrangler tail newsletter-cleanup           # watch the next nightly run
  ```
- **Short windows and active campaigns.** If `RETENTION_DAYS` is set very short
  (e.g. 7), campaigns that are still in `sending` status (e.g. throttled by
  warmup for a week) could be purged before delivery is complete. The cleanup
  worker does not check campaign status; it deletes on age alone.
- **R2 storage costs.** Large attachments accumulate until the retention window
  expires. Monitor R2 usage in the Cloudflare dashboard if sending campaigns
  with large files frequently.

---

## 7. Source map

| Concern | File |
| --- | --- |
| Cleanup logic (cron, deletion loop) | `workers/cleanup/src/index.ts` |
| Schema: campaigns, sends, events, attachments | `db/schema.sql` |
| Cron trigger declaration | `workers/cleanup/wrangler.toml` |
| `RETENTION_DAYS` default and resolution | `shared/settings.ts` |
| Settings UI | `web/src/pages/Settings.tsx` |
