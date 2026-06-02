import type { CampaignRow, AttachmentRow } from './types';

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
        'n.from_address AS from_address ' +
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
 * subscribers are skipped automatically.
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
          "WHERE newsletter_id = ? AND status='active' AND id > ? ORDER BY id ASC LIMIT ?",
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
