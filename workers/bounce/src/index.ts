import { loadSettings } from '../../../shared/settings';
import { writeLog } from '../../../shared/db';

export interface Env {
  DB: D1Database;
  CF_API_TOKEN: string;
  // Overlaid by loadSettings from D1/defaults at runtime:
  EMAIL_ROUTING_ZONE_ID: string;
  HARD_BOUNCE_THRESHOLD: string;
  SOFT_BOUNCE_THRESHOLD: string;
  SOFT_BOUNCE_WINDOW_DAYS: string;
}

// Cron period in minutes. Must match the schedule in wrangler.toml.
const CRON_PERIOD_MINUTES = 10;
// Post-send delivery-failure syncs to run after a campaign sends.
// 18 checks x 10 min ~= 3 hours of fast bounce coverage.
const MAX_CHECKS = 18;
// A send completing within this window (minutes) tops the counter back up to
// MAX_CHECKS. Slightly wider than the cron period so no completed send is
// missed between ticks.
const RECENT_SEND_WINDOW_MINUTES = CRON_PERIOD_MINUTES + 5;


export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runCron(env).catch(console.error));
  },

  async email(message: ForwardableEmailMessage, rawEnv: Env, _ctx: ExecutionContext): Promise<void> {
    const env = await loadSettings(rawEnv.DB, rawEnv);
    const to = (message.to ?? '').toLowerCase();

    // RFC 8058 mailto unsubscribe: unsubscribe+<subscriberId>@<domain>. The
    // consumer advertises this in List-Unsubscribe; it lands here because the
    // bounce worker is the catch-all inbound route. The sender's own mail
    // provider is the proof of intent (a mailto carries no token), matching
    // standard one-click-by-email behaviour.
    const unsub = /unsubscribe\+(\d+)@/.exec(to);
    if (unsub) {
      const sub = Number(unsub[1]);
      const res = await env.DB
        .prepare(
          "UPDATE subscribers SET status='unsubscribed', verified=0, unsubscribed_at=datetime('now') " +
            "WHERE id = ? AND status='active'",
        )
        .bind(sub)
        .run();
      if (res.meta?.changes) {
        await env.DB
          .prepare("INSERT INTO events (campaign_id, subscriber_id, type) VALUES (NULL, ?, 'unsubscribe')")
          .bind(sub)
          .run();
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Scheduled: GraphQL delivery-failure sync
// ---------------------------------------------------------------------------

// The cron fires every CRON_PERIOD_MINUTES (10). The GraphQL delivery-failure
// query is zone-wide (covers all campaigns at once), so a single global
// counter — not a per-campaign schedule — decides whether to sync. Each tick:
//   1. Top up the counter to MAX_CHECKS if any campaign sent recently.
//   2. Run one zone-wide sync if the counter is > 0, or during the daily window.
//   3. Decrement the counter by 1 when a post-send check was consumed.
async function runCron(rawEnv: Env): Promise<void> {
  const env = await loadSettings(rawEnv.DB, rawEnv);
  const now = new Date();
  const isDailyWindow = now.getUTCHours() === 4 && now.getUTCMinutes() < CRON_PERIOD_MINUTES;

  await topUpChecks(env);
  const checksToGo = await readChecksToGo(env);

  if (checksToGo > 0 || isDailyWindow) {
    await syncDeliveryEvents(env);
  }

  if (checksToGo > 0) {
    await env.DB
      .prepare(
        "UPDATE bounce_check_state SET checks_to_go = checks_to_go - 1, updated_at = datetime('now') " +
        'WHERE id = 1 AND checks_to_go > 0',
      )
      .run();
  }
}

// If any campaign finished sending within the recent-send window, reset the
// global counter to MAX_CHECKS (capped — never higher). A still-sending or
// freshly-completed campaign therefore keeps the counter topped up; the
// 3-hour countdown only begins once sending activity stops.
async function topUpChecks(env: Env): Promise<void> {
  await env.DB
    .prepare(
      "UPDATE bounce_check_state SET checks_to_go = ?, updated_at = datetime('now') " +
      'WHERE id = 1 AND EXISTS (' +
      "SELECT 1 FROM sends WHERE status IN ('sent','bounced') " +
      "AND sent_at > datetime('now', '-' || ? || ' minutes'))",
    )
    .bind(MAX_CHECKS, RECENT_SEND_WINDOW_MINUTES)
    .run();
}

async function readChecksToGo(env: Env): Promise<number> {
  const row = await env.DB
    .prepare('SELECT checks_to_go FROM bounce_check_state WHERE id = 1')
    .first<{ checks_to_go: number }>();
  return row?.checks_to_go ?? 0;
}

type GqlEmailEvent = {
  datetime: string;
  to: string;
  messageId: string;
  status: string;
  errorCause: string | null;
  errorDetail: string | null;
};

const GQL_QUERY = `
query DeliveryFailures($zoneTag: string!, $start: Time!, $end: Time!) {
  viewer {
    zones(filter: { zoneTag: $zoneTag }) {
      emailSendingAdaptive(
        filter: { datetime_geq: $start, datetime_leq: $end, status: "deliveryFailed" }
        limit: 10000
        orderBy: [datetime_DESC]
      ) {
        datetime
        to
        messageId
        status
        errorCause
        errorDetail
      }
    }
  }
}`;

async function syncDeliveryEvents(env: Env): Promise<void> {
  const token = env.CF_API_TOKEN;
  const zoneTag = env.EMAIL_ROUTING_ZONE_ID;
  if (!token || !zoneTag) {
    await writeLog(env.DB, {
      level: 'warn',
      source: 'bounce',
      event: 'bounce.sync_skipped',
      message: 'CF_API_TOKEN or EMAIL_ROUTING_ZONE_ID not configured — delivery sync skipped',
    });
    return;
  }

  const end = new Date();
  const start = new Date(end.getTime() - 25 * 60 * 60 * 1000);

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: GQL_QUERY,
      variables: { zoneTag, start: start.toISOString(), end: end.toISOString() },
    }),
  });

  if (!res.ok) {
    await writeLog(env.DB, {
      level: 'error',
      source: 'bounce',
      event: 'bounce.sync_error',
      message: `GraphQL request failed: HTTP ${res.status}`,
    });
    return;
  }

  const body = (await res.json()) as {
    data?: { viewer?: { zones?: Array<{ emailSendingAdaptive: GqlEmailEvent[] }> } };
    errors?: Array<{ message: string }>;
  };

  if (body.errors?.length) {
    await writeLog(env.DB, {
      level: 'error',
      source: 'bounce',
      event: 'bounce.sync_error',
      message: `GraphQL error: ${body.errors?.[0]?.message ?? 'unknown'}`,
      detail: { errors: body.errors },
    });
    return;
  }

  const events = body.data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? [];
  let processed = 0;

  if (events.length > 0) {
    await writeLog(env.DB, {
      level: 'debug',
      source: 'bounce',
      event: 'bounce.graphql_events',
      message: `GraphQL events (${events.length} total)`,
      detail: events,
    });
  }

  for (const ev of events) {
    const rawTo = ev.to ?? '';
    const toEmail = (rawTo.match(/<([^>]+)>/)?.[1] ?? rawTo).toLowerCase().trim();
    if (!toEmail) continue;

    const send = await env.DB
      .prepare(
        'SELECT s.campaign_id, s.subscriber_id FROM sends s ' +
        'JOIN subscribers sub ON sub.id = s.subscriber_id ' +
        "WHERE lower(sub.email) = ? AND s.status = 'sent' " +
        'ORDER BY s.sent_at DESC LIMIT 1',
      )
      .bind(toEmail)
      .first<{ campaign_id: string; subscriber_id: number }>();
    if (!send) {
      await writeLog(env.DB, {
        level: 'debug',
        source: 'bounce',
        event: 'bounce.event',
        message: `Skipped (no matching send): ${ev.to}`,
        detail: { outcome: 'no_send', to: ev.to, datetime: ev.datetime },
      });
      continue;
    }

    const alreadyBounced = await env.DB
      .prepare(
        "SELECT 1 FROM events WHERE subscriber_id = ? AND type = 'bounce' AND ts > datetime('now', '-25 hours') LIMIT 1",
      )
      .bind(send.subscriber_id)
      .first();
    if (alreadyBounced) {
      await writeLog(env.DB, {
        level: 'debug',
        source: 'bounce',
        event: 'bounce.event',
        campaignId: send.campaign_id,
        message: `Skipped (already bounced within 25h): ${ev.to}`,
        detail: { outcome: 'already_bounced', to: ev.to, datetime: ev.datetime },
      });
      continue;
    }

    const errorCause = ev.errorCause?.trim() ?? null;
    const errorDetail = ev.errorDetail?.trim() ?? null;
    const smtpCode = errorDetail?.match(/\b([45]\d{2})\b/)?.[1];
    const enhancedCode = errorDetail?.match(/\b([45]\.\d+\.\d+)\b/)?.[1];
    let isHard: boolean;
    if (smtpCode) {
      isHard = smtpCode.startsWith('5');
    } else {
      const isSoft = !!errorCause && /temp|timeout|quota|full|over.*limit|too.*many|slow.*down|defer|try.*again/i.test(errorCause);
      isHard = !isSoft;
    }
    const bounceType: 'hard' | 'soft' = isHard ? 'hard' : 'soft';
    const bounceCode = errorDetail ?? errorCause ?? null;

    await env.DB.batch([
      env.DB
        .prepare(
          'UPDATE subscribers SET ' +
          'bounce_count = bounce_count + 1, ' +
          'hard_bounce_count = hard_bounce_count + ?, ' +
          "soft_bounce_count = CASE WHEN ? = 'soft' THEN soft_bounce_count + 1 ELSE soft_bounce_count END, " +
          "last_bounce_type = ?, last_bounce_code = ?, last_bounce_at = datetime('now') " +
          'WHERE id = ?',
        )
        .bind(isHard ? 1 : 0, bounceType, bounceType, bounceCode, send.subscriber_id),
      env.DB
        .prepare(
          "UPDATE subscribers SET status = 'bounced' WHERE id = ? AND status = 'active' AND hard_bounce_count >= ?",
        )
        .bind(send.subscriber_id, Number(env.HARD_BOUNCE_THRESHOLD) || 1),
      env.DB
        .prepare(
          "UPDATE sends SET status = 'bounced', error = ? WHERE campaign_id = ? AND subscriber_id = ? AND status = 'sent'",
        )
        .bind(bounceCode ?? bounceType, send.campaign_id, send.subscriber_id),
      env.DB
        .prepare("INSERT INTO events (campaign_id, subscriber_id, type, url) VALUES (?, ?, 'bounce', ?)")
        .bind(send.campaign_id, send.subscriber_id, bounceCode ? `${bounceType}:${bounceCode}` : bounceType),
    ]);
    processed++;
    await writeLog(env.DB, {
      level: 'warn',
      source: 'bounce',
      event: 'bounce.event',
      campaignId: send.campaign_id,
      message: `Bounce recorded as ${bounceType} for ${ev.to}`,
      detail: {
        outcome: 'bounce_recorded',
        to: ev.to,
        datetime: ev.datetime,
        classification: bounceType,
        smtpCode: smtpCode ?? null,
        enhancedCode: enhancedCode ?? null,
        errorCause,
        errorDetail,
      },
    });
  }

  await writeLog(env.DB, {
    source: 'bounce',
    level: 'debug',
    event: 'bounce.sync_done',
    message: `Delivery sync complete: ${events.length} failure event(s) checked, ${processed} bounce(s) recorded`,
    detail: { eventsChecked: events.length, processed },
  });
}
