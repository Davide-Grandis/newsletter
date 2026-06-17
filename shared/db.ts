import type { CampaignRow, AttachmentRow } from './types';
import type { WarmupState } from './warmup';

/**
 * Fetch a single campaign row by id.
 *
 * Returns the columns the consumer worker needs to render and send: subject,
 * html, text, sender, status, and the `link_mode` flag (set by the ingest
 * worker when total attachment size exceeds the threshold and files should be
 * served as signed download links instead of being attached).
 *
 * @returns the campaign row, or `null` if no campaign with that id exists.
 */
export async function getCampaign(db: D1Database, id: string): Promise<CampaignRow | null> {
  return await db
    .prepare(
      'SELECT c.id, c.subject, c.html, c.text, c.sent_by, c.status, c.link_mode, ' +
        'c.newsletter_id AS newsletter_id, ' +
        'n.from_address AS from_address, n.name AS newsletter_name, ' +
        'n.footer_html AS footer_html, n.footer_text AS footer_text ' +
        'FROM campaigns c LEFT JOIN newsletters n ON n.id = c.newsletter_id WHERE c.id = ?',
    )
    .bind(id)
    .first<CampaignRow>();
}

/**
 * List all attachments associated with a campaign.
 *
 * Used by the consumer worker to load each attachment's R2 key and metadata
 * once per batch (the bytes themselves are then pulled from R2 and cached
 * in-memory for the lifetime of the queue batch). Includes both `attachment`
 * and `inline` dispositions; the consumer decides which to attach vs. embed.
 *
 * @returns the attachment rows for the campaign, or an empty array.
 */
export async function getCampaignAttachments(
  db: D1Database,
  campaignId: string,
): Promise<AttachmentRow[]> {
  const { results } = await db
    .prepare(
      'SELECT id, campaign_id, r2_key, filename, content_type, size, sha256, content_id, disposition ' +
        'FROM attachments WHERE campaign_id = ?',
    )
    .bind(campaignId)
    .all<AttachmentRow>();
  return results ?? [];
}

/**
 * Async generator that yields every active subscriber, paginated by id.
 *
 * Used by the ingest worker to stream the recipient list without loading the
 * whole table into memory. Pagination uses keyset (`id > lastId ORDER BY id`)
 * which is stable under concurrent inserts and avoids the cost of `OFFSET`.
 * Only `status='active'` rows are yielded; unsubscribed/bounced/complained
 * subscribers are skipped automatically. Rows still pending double opt-in
 * confirmation (a non-null `confirm_token`, set by the public signup flow) are
 * also skipped so an unconfirmed signup never receives mail.
 *
 * @param newsletterId only yield subscribers belonging to this newsletter.
 * @param pageSize how many rows to fetch per D1 round-trip (default 1000).
 */
export async function* iterateActiveSubscribers(
  db: D1Database,
  newsletterId: string,
  pageSize = 1000,
): AsyncGenerator<{ id: number; email: string; name: string | null; token: string }> {
  let lastId = 0;
  while (true) {
    const { results } = await db
      .prepare(
        "SELECT id, email, name, token FROM subscribers " +
          "WHERE newsletter_id = ? AND status='active' AND confirm_token IS NULL AND id > ? ORDER BY id ASC LIMIT ?",
      )
      .bind(newsletterId, lastId, pageSize)
      .all<{ id: number; email: string; name: string | null; token: string }>();
    if (!results || results.length === 0) return;
    for (const row of results) {
      yield row;
      lastId = row.id;
    }
    if (results.length < pageSize) return;
  }
}

/**
 * Mark a (campaign, subscriber) send as successful and bump the campaign
 * counter, atomically via `db.batch`.
 *
 * Idempotent: relies on the `UNIQUE(campaign_id, subscriber_id)` constraint on
 * `sends` and an `ON CONFLICT` upsert, so retries from the queue don't create
 * duplicate rows. Any prior `error` is cleared and the new `message_id` is
 * recorded for later correlation with bounce reports.
 */
export async function recordSendSuccess(
  db: D1Database,
  campaignId: string,
  subscriberId: number,
  messageId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO sends (campaign_id, subscriber_id, status, sent_at, message_id) " +
          "VALUES (?, ?, 'sent', datetime('now'), ?) " +
          "ON CONFLICT(campaign_id, subscriber_id) DO UPDATE SET " +
          "status='sent', sent_at=datetime('now'), message_id=excluded.message_id, error=NULL",
      )
      .bind(campaignId, subscriberId, messageId),
    db
      .prepare('UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?')
      .bind(campaignId),
  ]);
}

/**
 * Mark a (campaign, subscriber) send as failed and bump the campaign
 * `failed_count`, atomically via `db.batch`.
 *
 * Like {@link recordSendSuccess}, this upserts on the unique
 * `(campaign_id, subscriber_id)` key so it is safe to call repeatedly. The
 * caller passes a short error string (e.g. the SEND_EMAIL exception message)
 * which is stored on the `sends` row for diagnostics.
 */
export async function recordSendFailure(
  db: D1Database,
  campaignId: string,
  subscriberId: number,
  error: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "INSERT INTO sends (campaign_id, subscriber_id, status, error) VALUES (?, ?, 'failed', ?) " +
          "ON CONFLICT(campaign_id, subscriber_id) DO UPDATE SET status='failed', error=excluded.error",
      )
      .bind(campaignId, subscriberId, error),
    db
      .prepare('UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?')
      .bind(campaignId),
  ]);
}

/**
 * Flip a campaign from `sending` to `done` once every recipient has been
 * processed (delivered or failed). Safe to call after each queue batch: the
 * conditional, single-statement UPDATE only matches the campaign that is still
 * `sending` and whose `sent_count + failed_count` has reached
 * `total_recipients`, so the last batch to finish performs the transition and
 * concurrent/duplicate calls are no-ops.
 */
export async function markCampaignCompleteIfDone(
  db: D1Database,
  campaignId: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      "UPDATE campaigns SET status = 'done' " +
        "WHERE id = ? AND status = 'sending' AND total_recipients > 0 " +
        'AND sent_count + failed_count >= total_recipients',
    )
    .bind(campaignId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/**
 * A single application / pipeline log entry written to the D1 `logs` table.
 * `detail` is stored as JSON when an object is given, or verbatim for strings.
 */
export interface LogEntry {
  level?: 'debug' | 'info' | 'warn' | 'error';
  source: string;
  event: string;
  campaignId?: string | null;
  newsletterId?: string | null;
  message?: string | null;
  detail?: unknown;
}

/**
 * Best-effort write of a pipeline log row. Logging must never break the email
 * pipeline, so any failure here is swallowed (and echoed to the worker console
 * for Cloudflare observability).
 */
export async function writeLog(db: D1Database, e: LogEntry): Promise<void> {
  try {
    const detail =
      e.detail === undefined || e.detail === null
        ? null
        : typeof e.detail === 'string'
          ? e.detail
          : JSON.stringify(e.detail);
    await db
      .prepare(
        'INSERT INTO logs (level, source, event, campaign_id, newsletter_id, message, detail) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        e.level ?? 'info',
        e.source,
        e.event,
        e.campaignId ?? null,
        e.newsletterId ?? null,
        e.message ?? null,
        detail,
      )
      .run();
  } catch (err) {
    console.error('writeLog failed', e.event, err);
  }
}

// --------------------------------------------------------------------------
// Warmup state & metrics
// --------------------------------------------------------------------------

/** Count successfully-sent emails since a UTC 'YYYY-MM-DD HH:MM:SS' instant. */
export async function countSentSince(db: D1Database, sinceUtc: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM sends WHERE status = 'sent' AND sent_at >= ?")
    .bind(sinceUtc)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Current sending demand: the number of emails still to send across all
 * campaigns that are queued or in flight, i.e.
 * `Σ max(total_recipients − sent_count − failed_count, 0)`. Drives the
 * demand-gated warmup progression.
 */
export async function computeDemand(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(MAX(total_recipients - sent_count - failed_count, 0)), 0) AS n " +
        "FROM campaigns WHERE status IN ('queued','sending')",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Load the singleton warmup state row, tolerating a not-yet-migrated table. */
export async function loadWarmupState(db: D1Database): Promise<WarmupState> {
  try {
    const row = await db
      .prepare('SELECT day, day_started_at, daily_cap, daily_cap_date FROM warmup_state WHERE id = 1')
      .first<{
        day: number | null;
        day_started_at: string | null;
        daily_cap: number | null;
        daily_cap_date: string | null;
      }>();
    return {
      day: row?.day ?? null,
      dayStartedAt: row?.day_started_at ?? null,
      dailyCap: row?.daily_cap ?? null,
      dailyCapDate: row?.daily_cap_date ?? null,
    };
  } catch {
    return { day: null, dayStartedAt: null, dailyCap: null, dailyCapDate: null };
  }
}

/**
 * Persist a warmup progression with optimistic concurrency: the update only
 * applies if the stored `day_started_at` still matches what the caller read,
 * so two concurrent consumer invocations can't double-advance. Returns whether
 * this caller won the update.
 */
export async function advanceWarmupState(
  db: D1Database,
  next: { day: number | null; dayStartedAt: string | null },
  expectedDayStartedAt: string | null,
): Promise<boolean> {
  const stmt =
    expectedDayStartedAt === null
      ? db
          .prepare(
            "UPDATE warmup_state SET day = ?, day_started_at = ?, updated_at = datetime('now') " +
              'WHERE id = 1 AND day_started_at IS NULL',
          )
          .bind(next.day, next.dayStartedAt)
      : db
          .prepare(
            "UPDATE warmup_state SET day = ?, day_started_at = ?, updated_at = datetime('now') " +
              'WHERE id = 1 AND day_started_at = ?',
          )
          .bind(next.day, next.dayStartedAt, expectedDayStartedAt);
  const res = await stmt.run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Cache the daily sending cap read from the Cloudflare API for a UTC day. */
export async function saveDailyCap(db: D1Database, cap: number, dateUtc: string): Promise<void> {
  await db
    .prepare(
      "UPDATE warmup_state SET daily_cap = ?, daily_cap_date = ?, updated_at = datetime('now') WHERE id = 1",
    )
    .bind(cap, dateUtc)
    .run();
}
