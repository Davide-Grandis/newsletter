// Admin Worker
//
// Serves a static SPA from the [assets] binding for the GUI, and exposes a
// JSON API under /api/* for it (and curl/scripts) to call. Anything that is
// not /api/* falls through to the static assets.
//
// Authentication: this worker MUST be deployed behind a Cloudflare Access
// application. Access authenticates the user at the edge and injects the
// `Cf-Access-Authenticated-User-Email` header on every request that reaches
// the worker. We treat the presence of that header as proof of authentication;
// requests without it are rejected with 401. No bearer token, no shared
// secret — Access is the only gate.

import { EmailMessage } from 'cloudflare:email';
import {
  readWarmupConfig,
  weeklyCapForLevel,
  maxLevel,
  dayStartSql,
  type WarmupState,
} from '../../../shared/warmup';
import { buildEmail } from '../../../shared/mime';
import { sanitizeFooterHtml } from '../../../shared/footer';
import {
  loadSettings,
  readStoredSettings,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  isSettingKey,
} from '../../../shared/settings';
import { countSentSince, computeDemand, loadWarmupState } from '../../../shared/db';

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  // R2 bucket holding GUI media (logos, header images). Served read-only
  // under /media/*. The whole worker sits behind Cloudflare Access, so
  // these objects are only reachable by authenticated operators.
  ASSETS_R2: R2Bucket;
  // Warmup settings — kept in sync with the consumer worker so the admin GUI
  // can show the weekly schedule and current progression.
  WARMUP_SCHEDULE?: string;
  DAILY_CAP_FALLBACK?: string;
  // Email Routing automation. When a newsletter is created/renamed/deleted the
  // admin worker keeps a matching Email Routing rule in sync so its
  // `inbound_address` is forwarded to the ingest worker. Best-effort: if these
  // are unset, newsletter CRUD still works and the API returns a warning.
  CF_API_TOKEN?: string; // secret — token with "Email Routing Rules: Edit"
  // secret — account-scoped token with "Zone: Read", used only to look up the
  // Email Routing zone id from BASE_DOMAIN when the sending domain is saved.
  CF_READ_API_TOKEN?: string;
  EMAIL_ROUTING_ZONE_ID?: string; // zone id for the newsletter domain (auto-resolved from BASE_DOMAIN)
  INGEST_WORKER_NAME?: string; // worker script the rule forwards to
  BASE_DOMAIN?: string; // newsletter domain, e.g. for inbound-address hints
  // Console user management. The worker keeps the Cloudflare Access Emails list
  // (ACCESS_LIST_ID) in sync as console users are added/removed. Best-effort:
  // if the token is unset, user CRUD still works and the API returns a warning.
  CF_ZT_API_TOKEN?: string; // secret — account token with "Zero Trust: Edit"
  ACCESS_ACCOUNT_ID?: string; // resolved from settings (Zero Trust lists are account-scoped)
  ACCESS_LIST_ID?: string; // resolved from settings (Zero Trust Emails list id)
  ALLOW_ADMIN_NEWSLETTER_CRUD?: string; // 'true' | 'false' (settings toggle)
  // Used to email a newly added console user a heads-up. Best-effort: if the
  // binding or sender is missing, user creation still succeeds with a warning.
  SEND_EMAIL?: SendEmail; // Cloudflare Email Sending binding
  FROM_ADDRESS?: string; // resolved from settings — global sender identity
}

interface SubscriberPatch {
  name?: string | null;
  status?: 'active' | 'unsubscribed' | 'bounced' | 'complained';
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Public API health probe (no auth) so the SPA can detect a misconfigured
    // bearer token vs. a wrong URL.
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }

    // Identity probe: reflects the Cloudflare Access headers the edge injects
    // when the worker is published behind an Access application. No bearer
    // token required — Access already authenticated the request.
    if (req.method === 'GET' && url.pathname === '/api/me') {
      const rawEmail = req.headers.get('cf-access-authenticated-user-email');
      const name = req.headers.get('cf-access-authenticated-user-name');
      const email = rawEmail ? rawEmail.toLowerCase() : '';
      // Resolve role + scope (this also performs the empty-table super_admin
      // bootstrap). `null` means authenticated by Access but not provisioned.
      const auth = email ? await resolveUser(env.DB, email) : null;
      // Stored UI preference (null when no admin row exists yet — the client
      // then seeds it via PUT /api/preferences with its detected OS theme).
      let theme: string | null = null;
      // Each assigned newsletter carries the admin's capability (read_only/edit).
      // Capability is per-admin, so every entry shares the same value; the SPA
      // uses it to hide mutating controls for read-only admins.
      let newsletters: Array<{ id: string; name: string; capability: Capability }> = [];
      if (auth) {
        const row = await env.DB
          .prepare('SELECT theme FROM admins WHERE email = ?')
          .bind(email)
          .first<{ theme: string }>();
        theme = row?.theme ?? null;
        if (auth.role === 'admin') {
          const { results } = await env.DB
            .prepare(
              'SELECT n.id, n.name FROM admins_newsletters an ' +
                'JOIN newsletters n ON n.id = an.newsletter_id ' +
                'WHERE an.email = ? ORDER BY n.name COLLATE NOCASE',
            )
            .bind(email)
            .all<{ id: string; name: string }>();
          newsletters = (results ?? []).map((n) => ({ ...n, capability: auth.capability }));
        }
      }
      const cfg = await loadSettings(env.DB, env);
      // Startup self-heal: silently reconcile the Access login list with the
      // admins table (D1 authoritative) on every sign-in. Runs in the
      // background so it never delays the response, and is best-effort — any
      // API failure is swallowed (the list simply stays as-is until next load).
      if (email && listSyncReady(cfg)) {
        ctx.waitUntil(reconcileAccessList(cfg).catch(() => {}));
      }
      return Response.json({
        email: rawEmail ?? null,
        name: name ?? null,
        theme,
        role: auth?.role ?? null,
        newsletters,
        // Authenticated via Access but no role yet (system already bootstrapped).
        no_access: Boolean(email) && !auth,
        allow_admin_newsletter_crud: cfg.ALLOW_ADMIN_NEWSLETTER_CRUD === 'true',
        // Non-sensitive deployment values the SPA needs even for admins (who
        // cannot read the super_admin-only /api/settings): the sending domain
        // and the default sender, used by the newsletter create/edit forms.
        base_domain: cfg.BASE_DOMAIN ?? '',
        from_address: (cfg as unknown as Record<string, string | undefined>).FROM_ADDRESS ?? '',
        // The resolved global default footer, so the newsletter footer editor
        // can show what an empty (inherited) footer will actually send. The
        // stored HTML is already sanitized on save; sanitize again defensively.
        default_footer_html: sanitizeFooterHtml(
          (cfg as unknown as Record<string, string | undefined>).DEFAULT_FOOTER_HTML ?? '',
        ),
        default_footer_text: (cfg as unknown as Record<string, string | undefined>).DEFAULT_FOOTER_TEXT ?? '',
        // Public base URL of the tracker worker (hosts the subscribe/verify
        // pages). Not sensitive — it already appears in every email's links.
        // Used by the console to show each newsletter's public subscribe URL.
        tracking_base_url: (cfg as unknown as Record<string, string | undefined>).TRACKING_BASE_URL ?? '',
        protected_by_access: Boolean(rawEmail),
        // Whether the Cloudflare Access login settings (account + list IDs) are
        // configured. Used by the SPA to nudge a super_admin to finish setup.
        access_configured: Boolean(cfg.ACCESS_ACCOUNT_ID && cfg.ACCESS_LIST_ID),
      });
    }

    if (url.pathname.startsWith('/api/')) {
      // Cloudflare Access injects this header at the edge after authenticating
      // the user. If it is missing the request did not transit Access, so we
      // refuse to serve API data.
      if (!req.headers.get('cf-access-authenticated-user-email')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return await handleApi(req, env, url);
    }

    // GUI media served from the R2 bucket (logos, header images). Uses /media/
    // rather than /assets/ to avoid colliding with the Vite-built SPA bundle
    // that lives under /assets/.
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      return await serveMedia(req, env, url);
    }

    // SPA static assets (with SPA fallback configured in wrangler.toml).
    return env.ASSETS.fetch(req);
  },
};

// Settings that must be non-negative integers (stored as strings).
const NUMERIC_SETTINGS = new Set<string>([
  'MAX_ATTACHMENT_BYTES',
  'MAX_TOTAL_ATTACHMENT_BYTES',
  'MAX_ATTACHMENT_COUNT',
  'ATTACHMENT_LINK_THRESHOLD_BYTES',
  'BATCH_SIZE',
  'MAX_RAW_BYTES',
  'RETENTION_DAYS',
  'HARD_BOUNCE_THRESHOLD',
  'SOFT_BOUNCE_THRESHOLD',
  'DAILY_CAP_FALLBACK',
]);

// Settings that must be the string 'true' or 'false'.
const BOOLEAN_SETTINGS = new Set<string>([
  'TRACKING_ENABLED',
  'ALLOW_ADMIN_NEWSLETTER_CRUD',
]);

// Returns an error message if `val` is invalid for `key`, else null.
function validateSetting(key: string, val: string): string | null {
  if (NUMERIC_SETTINGS.has(key)) {
    return /^\d+$/.test(val.trim()) ? null : 'must be a non-negative integer';
  }
  if (BOOLEAN_SETTINGS.has(key)) {
    return val === 'true' || val === 'false' ? null : "must be 'true' or 'false'";
  }
  if (key === 'WARMUP_SCHEDULE') {
    try {
      const arr = JSON.parse(val);
      if (!Array.isArray(arr) || !arr.every((n) => typeof n === 'number' && n >= 0)) {
        return 'must be a JSON array of non-negative numbers';
      }
    } catch {
      return 'must be valid JSON (e.g. [500, 1500, 5000])';
    }
    return null;
  }
  if (key === 'BASE_DOMAIN') {
    // The sending domain is required and must look like a hostname. Existence
    // as a Cloudflare zone is verified separately (async) before it is stored.
    const v = val.trim().toLowerCase();
    if (v === '') return 'sending domain is required';
    return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v)
      ? null
      : 'must be a valid domain, e.g. example.com';
  }
  if (key === 'ACCESS_ACCOUNT_ID') {
    // Cloudflare account IDs are 32 hex characters. Empty disables list sync.
    return val === '' || /^[0-9a-f]{32}$/i.test(val)
      ? null
      : 'must be a 32-character hexadecimal Cloudflare account ID (or empty to disable sync)';
  }
  if (key === 'ACCESS_LIST_ID') {
    // Zero Trust list IDs are UUIDs. Empty disables list sync.
    return val === '' ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)
      ? null
      : 'must be a UUID, e.g. 9fb38537-341d-4c22-a62f-e868f47b9736 (or empty to disable sync)';
  }
  return null; // free-form string keys
}

// Validates a per-newsletter sender. Accepts either "local@domain" or a
// display-name form 'Name <local@domain>'. The mailbox domain must match the
// configured sending domain (`BASE_DOMAIN`) so SPF/DKIM/DMARC stays aligned.
// Returns the normalized header string, or an error message.
function validateFromAddress(
  raw: string,
  baseDomain: string | undefined,
): { value: string } | { error: string } {
  const input = raw.trim();
  const m = /<([^>]+)>\s*$/.exec(input);
  const addr = (m ? m[1]! : input).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
    return { error: 'valid from_address required' };
  }
  const domain = addr.slice(addr.indexOf('@') + 1);
  if (baseDomain && domain !== baseDomain.toLowerCase()) {
    return { error: `from_address must be on @${baseDomain}` };
  }
  // Preserve a display name if provided (e.g. 'News <news@domain>').
  if (m) {
    const name = input.slice(0, input.lastIndexOf('<')).trim();
    return { value: name ? `${name} <${addr}>` : addr };
  }
  return { value: addr };
}

// Per-newsletter footer limits. Generous, but bounded so a runaway value can't
// bloat every outgoing message.
const FOOTER_HTML_MAX = 20000;
const FOOTER_TEXT_MAX = 5000;

// Normalizes a footer_html input from the API: null/empty clears it (inherits
// the global default); a string is length-checked and sanitized to the
// allow-list. Returns the value to store or an error.
function normalizeFooterHtml(v: unknown): { value: string | null } | { error: string } {
  if (v === undefined) return { value: null };
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: 'footer_html must be a string' };
  if (v.length > FOOTER_HTML_MAX) return { error: `footer_html too long (max ${FOOTER_HTML_MAX} chars)` };
  return { value: sanitizeFooterHtml(v) };
}

function normalizeFooterText(v: unknown): { value: string | null } | { error: string } {
  if (v === undefined) return { value: null };
  if (v === null || v === '') return { value: null };
  if (typeof v !== 'string') return { error: 'footer_text must be a string' };
  if (v.length > FOOTER_TEXT_MAX) return { error: `footer_text too long (max ${FOOTER_TEXT_MAX} chars)` };
  return { value: v };
}

// -------- public signup: slugs --------

// Public subscribe slugs: lowercase, URL-safe, used in /subscribe/<slug>.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_MAX = 64;

// Derives a URL-safe slug from arbitrary text (e.g. a newsletter name):
// lowercases, strips accents, replaces runs of non-alphanumerics with a single
// hyphen and trims hyphens. May return '' if the input has no usable chars.
function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

// Returns a slug derived from `base` that is unique across newsletters,
// appending -2, -3, … on collision. `excludeId` skips the newsletter being
// updated. Falls back to a random suffix if `base` slugifies to empty.
async function uniqueSlug(env: Env, base: string, excludeId?: string): Promise<string> {
  let root = slugify(base);
  if (!root) root = `nl-${crypto.randomUUID().slice(0, 8)}`;
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? root : `${root}-${i}`;
    const clash = await env.DB
      .prepare('SELECT 1 FROM newsletters WHERE slug = ? AND id <> ? LIMIT 1')
      .bind(candidate, excludeId ?? '')
      .first();
    if (!clash) return candidate;
  }
  return `${root}-${crypto.randomUUID().slice(0, 8)}`;
}

// -------- authorization (roles + per-newsletter scope) --------
//
// Cloudflare Access authenticates the user (the edge injects the email header,
// verified in fetch()). This layer adds authorization: it resolves the email
// to a role and, for admins, the set of newsletters they may manage.
//
//   * super_admin: full access to the app and global settings.
//   * admin:       confined to the newsletters in `admins_newsletters`.
//
// Bootstrap guardrail: if the `admins` table is empty, the first authenticated
// user is promoted to super_admin. Once any admin exists, an authenticated but
// unprovisioned email gets no access (403).

type Role = 'super_admin' | 'admin';

type Capability = 'read_only' | 'edit';

interface Auth {
  email: string;
  role: Role;
  // For role='admin': read_only vs edit (see migration 0010). super_admins are
  // always treated as 'edit'. Per-admin, so it applies to all their newsletters.
  capability: Capability;
  // Newsletter ids an admin may manage. Empty for super_admin (sees all).
  newsletterIds: string[];
}

async function resolveUser(db: D1Database, email: string): Promise<Auth | null> {
  if (!email) return null;
  const row = await db
    .prepare('SELECT role, capability FROM admins WHERE email = ?')
    .bind(email)
    .first<{ role: Role; capability: Capability | null }>();
  if (row) {
    if (row.role === 'super_admin')
      return { email, role: 'super_admin', capability: 'edit', newsletterIds: [] };
    const { results } = await db
      .prepare('SELECT newsletter_id FROM admins_newsletters WHERE email = ?')
      .bind(email)
      .all<{ newsletter_id: string }>();
    return {
      email,
      role: 'admin',
      capability: row.capability === 'edit' ? 'edit' : 'read_only',
      newsletterIds: (results ?? []).map((r) => r.newsletter_id),
    };
  }
  // Unprovisioned email: only auto-create a super_admin when no admin exists.
  const cnt = await db.prepare('SELECT COUNT(*) AS n FROM admins').first<{ n: number }>();
  if ((cnt?.n ?? 0) === 0) {
    await db
      .prepare(
        "INSERT INTO admins (email, role) VALUES (?, 'super_admin') " +
          "ON CONFLICT(email) DO UPDATE SET role = 'super_admin', updated_at = datetime('now')",
      )
      .bind(email)
      .run();
    return { email, role: 'super_admin', capability: 'edit', newsletterIds: [] };
  }
  return null;
}

function forbidden(): Response {
  return Response.json({ error: 'forbidden' }, { status: 403 });
}

// Comma-separated '?' placeholders for an `IN (...)` clause.
function inPlaceholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

// Enforces "each newsletter must keep >= 1 admin". Given an email whose
// assignments are being removed (all of them, or all except those in `keep`),
// returns the ids of newsletters that would be left with no assigned admin.
// super_admins are intentionally not counted: the invariant is about explicit
// per-newsletter admin assignments.
async function newslettersWithSoleAdmin(
  db: D1Database,
  email: string,
  keep: Set<string> = new Set(),
): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT newsletter_id FROM admins_newsletters WHERE email = ?')
    .bind(email)
    .all<{ newsletter_id: string }>();
  const out: string[] = [];
  for (const r of results ?? []) {
    if (keep.has(r.newsletter_id)) continue; // assignment is being retained
    const cnt = await db
      .prepare('SELECT COUNT(*) AS n FROM admins_newsletters WHERE newsletter_id = ?')
      .bind(r.newsletter_id)
      .first<{ n: number }>();
    if ((cnt?.n ?? 0) <= 1) out.push(r.newsletter_id);
  }
  return out;
}

async function handleApi(req: Request, rawEnv: Env, url: URL): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  // Resolve configurable settings against the D1 `settings` table so routing,
  // quota and any other reads use the operator-edited values. `rawEnv` keeps
  // the original env vars (used to show per-key defaults on the Settings page).
  const env = await loadSettings(rawEnv.DB, rawEnv);

  // Resolve the caller's role + newsletter scope. Access already proved the
  // identity; here we decide what they may do. An unprovisioned user (once the
  // system has a super_admin) is rejected.
  const email = (req.headers.get('cf-access-authenticated-user-email') ?? '').toLowerCase();
  const auth = await resolveUser(rawEnv.DB, email);
  if (!auth) return forbidden();
  const isSuper = auth.role === 'super_admin';
  // Per-admin capability: super_admins and edit-admins may mutate; read-only
  // admins may only view. Capability is global to the admin (applies to all
  // their assigned newsletters).
  const canEdit = isSuper || auth.capability === 'edit';
  // Creating/deleting newsletters additionally requires the global toggle, and
  // only edit-capable admins qualify (a read-only admin never mutates).
  const allowNlCrud = isSuper || (canEdit && env.ALLOW_ADMIN_NEWSLETTER_CRUD === 'true');
  const canSeeNl = (id: string): boolean => isSuper || auth.newsletterIds.includes(id);

  // -------- current user's UI preferences --------

  // Persist the signed-in admin's theme. Creates the admin row on first write
  // (seeded with the supplied theme) and updates it thereafter. The email is
  // taken from the Access header, so a user can only change their own setting.
  if (p === '/api/preferences' && m === 'PUT') {
    const { theme } = await req.json<{ theme?: string }>();
    if (theme !== 'light' && theme !== 'dark') {
      return Response.json({ error: 'theme must be "light" or "dark"' }, { status: 400 });
    }
    await env.DB
      .prepare(
        "INSERT INTO admins (email, theme) VALUES (?, ?) " +
          "ON CONFLICT(email) DO UPDATE SET theme = excluded.theme, updated_at = datetime('now')",
      )
      .bind(email, theme)
      .run();
    return Response.json({ ok: true, theme });
  }

  // -------- global runtime settings --------

  // Returns every configurable key with its effective value and provenance so
  // the Settings page can show what is overridden vs. falling back to the
  // built-in default. Resolution is two-level: D1 `settings` row -> default.
  if (p === '/api/settings' && m === 'GET') {
    if (!isSuper) return forbidden();
    const stored = await readStoredSettings(rawEnv.DB);
    const items = SETTING_KEYS.map((key) => {
      const dbVal = stored.get(key) ?? null;
      const def = SETTINGS_DEFAULTS[key];
      return {
        key,
        value: dbVal ?? def,
        stored: dbVal,
        fallback: def,
        source: dbVal != null ? 'db' : 'default',
      };
    });
    return Response.json({ settings: items });
  }

  // Upserts (or, when a value is null, clears) settings. Clearing a key makes
  // it fall back to the built-in default again.
  if (p === '/api/settings' && m === 'PUT') {
    if (!isSuper) return forbidden();
    const body = await req.json<{ updates?: Record<string, string | null> }>();
    const updates = body.updates ?? {};
    const errors: Record<string, string> = {};
    const toSet: Array<[string, string]> = [];
    const toDelete: string[] = [];
    for (const [key, val] of Object.entries(updates)) {
      if (!isSettingKey(key)) {
        errors[key] = 'unknown setting';
        continue;
      }
      if (val === null) {
        toDelete.push(key);
        continue;
      }
      const err = validateSetting(key, val);
      if (err) {
        errors[key] = err;
        continue;
      }
      toSet.push([key, val]);
    }
    if (Object.keys(errors).length > 0) {
      return Response.json({ error: 'validation failed', errors }, { status: 400 });
    }

    // The Email Routing zone id is never edited directly; it is derived from the
    // sending domain. Saving BASE_DOMAIN therefore requires that the domain be a
    // Cloudflare zone in this account — verify it FIRST and reject the save if it
    // can't be confirmed, so an invalid domain is never persisted.
    let resolvedZoneId: string | undefined;
    const domainEntry = toSet.find(([key]) => key === 'BASE_DOMAIN');
    if (domainEntry) {
      const { zoneId, error } = await resolveZoneIdByDomain(env, domainEntry[1].trim().toLowerCase());
      if (error || !zoneId) {
        return Response.json(
          { error: 'validation failed', errors: { BASE_DOMAIN: error ?? 'could not verify the domain' } },
          { status: 400 },
        );
      }
      resolvedZoneId = zoneId;
    }

    const stmts: D1PreparedStatement[] = [];
    for (const [key, val] of toSet) {
      // The global default footer HTML is sanitized to the allow-list before it
      // is stored, so the consumer can trust it without re-sanitizing.
      const stored = key === 'DEFAULT_FOOTER_HTML' ? sanitizeFooterHtml(val) : val;
      stmts.push(
        rawEnv.DB.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        ).bind(key, stored),
      );
    }
    for (const key of toDelete) {
      stmts.push(rawEnv.DB.prepare('DELETE FROM settings WHERE key = ?').bind(key));
    }
    // Persist the verified zone id alongside the domain (or drop it if the
    // domain is being cleared).
    if (resolvedZoneId) {
      stmts.push(
        rawEnv.DB.prepare(
          "INSERT INTO settings (key, value) VALUES ('EMAIL_ROUTING_ZONE_ID', ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        ).bind(resolvedZoneId),
      );
    } else if (toDelete.includes('BASE_DOMAIN')) {
      stmts.push(rawEnv.DB.prepare("DELETE FROM settings WHERE key = 'EMAIL_ROUTING_ZONE_ID'"));
    }
    if (stmts.length > 0) await rawEnv.DB.batch(stmts);

    // When the sending domain is (re)set, make sure the bounce catch-all rule
    // (bounce@<domain> → bounce worker) exists on its zone, so VERP bounces are
    // handled without manual dashboard setup. Best-effort: surfaced as a
    // warning, never blocks the save.
    let routing_warning: string | undefined;
    if (domainEntry && resolvedZoneId) {
      const nextEnv = {
        ...env,
        BASE_DOMAIN: domainEntry[1].trim().toLowerCase(),
        EMAIL_ROUTING_ZONE_ID: resolvedZoneId,
      } as Env;
      routing_warning = await ensureBounceRule(nextEnv);
    }

    return Response.json({ ok: true, changed: toSet.length, cleared: toDelete.length, routing_warning });
  }

  // Lists the Cloudflare zones (domains) in the account so the Settings page can
  // offer the sending domain as a pick-list instead of free text. Uses the
  // read-only token (Zone: Read); scoped to the configured account when known.
  // Returns `{ items }` always; on failure includes a non-fatal `error` so the
  // UI can fall back to manual entry.
  if (p === '/api/sending-domains' && m === 'GET') {
    if (!isSuper) return forbidden();
    const token = env.CF_READ_API_TOKEN;
    if (!token) {
      return Response.json({
        items: [],
        error: 'read API token (CF_READ_API_TOKEN, Zone: Read) not configured',
      });
    }
    try {
      const zones: { id: string; name: string }[] = [];
      let page = 1;
      for (;;) {
        const q = new URLSearchParams({ per_page: '50', page: String(page) });
        if (env.ACCESS_ACCOUNT_ID) q.set('account.id', env.ACCESS_ACCOUNT_ID);
        const res = await fetch(`${CF_API}/zones?${q.toString()}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body: any = await res.json().catch(() => ({}));
        if (!res.ok || body?.success === false) {
          const msg =
            (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
            `HTTP ${res.status}`;
          return Response.json({ items: [], error: `could not list domains: ${msg}` });
        }
        for (const z of body.result ?? []) if (z?.id && z?.name) zones.push({ id: String(z.id), name: String(z.name) });
        const info = body.result_info;
        if (!info || page >= (info.total_pages ?? 1)) break;
        page++;
      }

      // Best-effort Email Routing status per zone. Requires the read token to
      // carry an Email Routing read permission (a "Read all resources" account
      // token does; a plain Zone: Read does not). If every probe errors we
      // report routing_checkable=false so the UI can say status is unknown.
      let probeErrors = 0;
      const items = await Promise.all(
        zones.map(async (z) => {
          try {
            const rr = await fetch(`${CF_API}/zones/${z.id}/email/routing`, {
              headers: { authorization: `Bearer ${token}` },
            });
            const rb: any = await rr.json().catch(() => ({}));
            if (!rr.ok || rb?.success === false) {
              probeErrors++;
              return { name: z.name, routing: 'unknown' as const };
            }
            return { name: z.name, routing: rb?.result?.enabled ? ('enabled' as const) : ('disabled' as const) };
          } catch {
            probeErrors++;
            return { name: z.name, routing: 'unknown' as const };
          }
        }),
      );
      items.sort((a, b) => a.name.localeCompare(b.name));
      const routing_checkable = zones.length === 0 || probeErrors < zones.length;
      return Response.json({ items, routing_checkable });
    } catch (e) {
      return Response.json({ items: [], error: `could not list domains: ${(e as Error).message}` });
    }
  }

  // Lists the Worker scripts in the account so the Settings page can offer the
  // ingest worker name as a pick-list. Uses the read-only token (needs Workers
  // Scripts read; a "Read all resources" account token has it). Returns
  // `{ items }` always; on failure includes a non-fatal `error`.
  if (p === '/api/workers' && m === 'GET') {
    if (!isSuper) return forbidden();
    const token = env.CF_READ_API_TOKEN;
    if (!token) {
      return Response.json({
        items: [],
        error: 'read API token (CF_READ_API_TOKEN) not configured',
      });
    }
    if (!env.ACCESS_ACCOUNT_ID) {
      return Response.json({ items: [], error: 'account ID not configured (set it on the Access tab)' });
    }
    try {
      const names: string[] = [];
      let page = 1;
      for (;;) {
        const q = new URLSearchParams({ per_page: '100', page: String(page) });
        const res = await fetch(
          `${CF_API}/accounts/${env.ACCESS_ACCOUNT_ID}/workers/scripts?${q.toString()}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const body: any = await res.json().catch(() => ({}));
        if (!res.ok || body?.success === false) {
          const msg =
            (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
            `HTTP ${res.status}`;
          return Response.json({ items: [], error: `could not list workers: ${msg}` });
        }
        for (const s of body.result ?? []) if (s?.id) names.push(String(s.id));
        const info = body.result_info;
        if (!info || page >= (info.total_pages ?? 1)) break;
        page++;
      }
      names.sort((a, b) => a.localeCompare(b));
      return Response.json({ items: names });
    } catch (e) {
      return Response.json({ items: [], error: `could not list workers: ${(e as Error).message}` });
    }
  }

  // -------- console users (super admins) --------
  //
  // Super-admin-only API backing the Settings → "Super admins" tab. Regular
  // admins are now managed per-newsletter (/api/newsletters/:id/admins) and
  // carry a read-only/edit capability instead of a global manage-users toggle.
  // Adding/removing a user also syncs the Cloudflare Access list (best-effort,
  // surfaced as `list_warning`).
  const adminMatch = /^\/api\/admins(?:\/(.+))?$/.exec(p);
  if (adminMatch) {
    // The top-level users API now manages super_admins only and is super-only.
    // Regular admins are managed per-newsletter (/api/newsletters/:id/admins).
    if (!isSuper) return forbidden();
    const target = adminMatch[1] ? decodeURIComponent(adminMatch[1]) : '';

    // Reconcile the Access list with the admins table (super_admin only).
    if (target === 'reconcile' && m === 'POST') {
      if (!isSuper) return forbidden();
      if (!listSyncReady(env)) {
        return Response.json(
          { error: 'Access list not configured (set CF_ZT_API_TOKEN + ACCESS_ACCOUNT_ID + ACCESS_LIST_ID).' },
          { status: 400 },
        );
      }
      try {
        const { added, removed } = await reconcileAccessList(env);
        return Response.json({ ok: true, added, removed });
      } catch (e) {
        return Response.json({ error: `reconcile failed: ${(e as Error).message}` }, { status: 502 });
      }
    }

    // ---- list users ----
    if (!target && m === 'GET') {
      const rows = await env.DB
        .prepare(
          'SELECT a.email, a.role, a.theme, a.created_at, an.newsletter_id, n.name AS newsletter_name ' +
            'FROM admins a ' +
            'LEFT JOIN admins_newsletters an ON an.email = a.email ' +
            'LEFT JOIN newsletters n ON n.id = an.newsletter_id ' +
            'ORDER BY a.email',
        )
        .all<{
          email: string;
          role: Role;
          theme: string;
          created_at: string;
          newsletter_id: string | null;
          newsletter_name: string | null;
        }>();
      const byEmail = new Map<
        string,
        { email: string; role: Role; theme: string; created_at: string; newsletters: Array<{ id: string; name: string }> }
      >();
      for (const r of rows.results ?? []) {
        let u = byEmail.get(r.email);
        if (!u) {
          u = { email: r.email, role: r.role, theme: r.theme, created_at: r.created_at, newsletters: [] };
          byEmail.set(r.email, u);
        }
        if (r.newsletter_id) u.newsletters.push({ id: r.newsletter_id, name: r.newsletter_name ?? r.newsletter_id });
      }
      let items = [...byEmail.values()];
      // An admin-manager only sees users that share one of their newsletters
      // (plus themselves); super_admins see everyone.
      if (!isSuper) {
        const mine = new Set(auth.newsletterIds);
        items = items.filter((u) => u.email === auth.email || u.newsletters.some((nl) => mine.has(nl.id)));
      }
      return Response.json({ items });
    }

    // ---- create user ----
    if (!target && m === 'POST') {
      const body = await req.json<{ email?: string; role?: string; newsletter_ids?: string[] }>();
      const newEmail = (body.email ?? '').trim().toLowerCase();
      const role = (body.role ?? 'admin') as Role;
      const nlIds = Array.from(new Set((body.newsletter_ids ?? []).map((s) => String(s))));
      if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return Response.json({ error: 'valid email required' }, { status: 400 });
      }
      if (role !== 'admin' && role !== 'super_admin') {
        return Response.json({ error: "role must be 'admin' or 'super_admin'" }, { status: 400 });
      }
      // Non-super managers cannot mint super_admins and are confined to their
      // own newsletters.
      if (!isSuper) {
        if (role === 'super_admin') return forbidden();
        const mine = new Set(auth.newsletterIds);
        if (!nlIds.every((id) => mine.has(id))) return forbidden();
      }
      if (role === 'admin' && nlIds.length === 0) {
        return Response.json({ error: 'an admin must be assigned at least one newsletter' }, { status: 400 });
      }
      if (nlIds.length) {
        const found = await env.DB
          .prepare(`SELECT id FROM newsletters WHERE id IN (${inPlaceholders(nlIds.length)})`)
          .bind(...nlIds)
          .all<{ id: string }>();
        if ((found.results ?? []).length !== nlIds.length) {
          return Response.json({ error: 'one or more newsletters do not exist' }, { status: 400 });
        }
      }
      const exists = await env.DB.prepare('SELECT 1 AS x FROM admins WHERE email = ?').bind(newEmail).first();
      if (exists) return Response.json({ error: 'user already exists' }, { status: 409 });

      const stmts: D1PreparedStatement[] = [
        env.DB.prepare('INSERT INTO admins (email, role) VALUES (?, ?)').bind(newEmail, role),
      ];
      if (role === 'admin') {
        for (const id of nlIds) {
          stmts.push(
            env.DB
              .prepare('INSERT OR IGNORE INTO admins_newsletters (email, newsletter_id) VALUES (?, ?)')
              .bind(newEmail, id),
          );
        }
      }
      await env.DB.batch(stmts);
      const list_warning = await addEmailToAccessList(env, newEmail);
      const notify_warning = await notifyUser(env, newEmail, role, 'added');
      return Response.json({ ok: true, email: newEmail, role, list_warning, notify_warning }, { status: 201 });
    }

    // ---- operations on a specific user ----
    if (target && (m === 'PATCH' || m === 'DELETE')) {
      const tEmail = target.toLowerCase();
      const existing = await env.DB
        .prepare('SELECT email, role FROM admins WHERE email = ?')
        .bind(tEmail)
        .first<{ email: string; role: Role }>();
      if (!existing) return Response.json({ error: 'not found' }, { status: 404 });

      // Non-super managers can never touch a super_admin, and can only act on
      // users confined to their own newsletters.
      if (!isSuper) {
        if (existing.role === 'super_admin') return forbidden();
        const { results } = await env.DB
          .prepare('SELECT newsletter_id FROM admins_newsletters WHERE email = ?')
          .bind(tEmail)
          .all<{ newsletter_id: string }>();
        const mine = new Set(auth.newsletterIds);
        if (!(results ?? []).every((r) => mine.has(r.newsletter_id))) return forbidden();
      }

      if (m === 'DELETE') {
        if (tEmail === auth.email) {
          return Response.json({ error: 'you cannot delete your own account' }, { status: 400 });
        }
        if (existing.role === 'super_admin') {
          const cnt = await env.DB
            .prepare("SELECT COUNT(*) AS n FROM admins WHERE role = 'super_admin'")
            .first<{ n: number }>();
          if ((cnt?.n ?? 0) <= 1) {
            return Response.json({ error: 'cannot delete the only super_admin' }, { status: 409 });
          }
        }
        const orphaned = await newslettersWithSoleAdmin(env.DB, tEmail);
        if (orphaned.length) {
          return Response.json(
            { error: 'user is the only admin of one or more newsletters; assign another admin first', newsletters: orphaned },
            { status: 409 },
          );
        }
        await env.DB.batch([
          env.DB.prepare('DELETE FROM admins_newsletters WHERE email = ?').bind(tEmail),
          env.DB.prepare('DELETE FROM admins WHERE email = ?').bind(tEmail),
        ]);
        const list_warning = await removeEmailFromAccessList(env, tEmail);
        const notify_warning = await notifyUser(env, tEmail, existing.role, 'removed');
        return Response.json({ ok: true, list_warning, notify_warning });
      }

      // PATCH: update role and/or newsletter assignments.
      const body = await req.json<{ role?: string; newsletter_ids?: string[] }>();
      const nextRole = (body.role ?? existing.role) as Role;
      if (nextRole !== 'admin' && nextRole !== 'super_admin') {
        return Response.json({ error: "role must be 'admin' or 'super_admin'" }, { status: 400 });
      }
      if (!isSuper && nextRole === 'super_admin') return forbidden();

      const hasNlUpdate = Array.isArray(body.newsletter_ids);
      const nlIds = hasNlUpdate ? Array.from(new Set(body.newsletter_ids!.map((s) => String(s)))) : null;
      if (!isSuper && nlIds) {
        const mine = new Set(auth.newsletterIds);
        if (!nlIds.every((id) => mine.has(id))) return forbidden();
      }
      if (nextRole === 'admin' && hasNlUpdate && nlIds!.length === 0) {
        return Response.json({ error: 'an admin must be assigned at least one newsletter' }, { status: 400 });
      }
      if (nlIds && nlIds.length) {
        const found = await env.DB
          .prepare(`SELECT id FROM newsletters WHERE id IN (${inPlaceholders(nlIds.length)})`)
          .bind(...nlIds)
          .all<{ id: string }>();
        if ((found.results ?? []).length !== nlIds.length) {
          return Response.json({ error: 'one or more newsletters do not exist' }, { status: 400 });
        }
      }
      // Replacing assignments (or promoting to super_admin, which drops them)
      // must not strand a newsletter without an admin.
      if (hasNlUpdate || nextRole === 'super_admin') {
        const keep = new Set<string>(nextRole === 'super_admin' ? [] : nlIds ?? []);
        const stranded = await newslettersWithSoleAdmin(env.DB, tEmail, keep);
        if (stranded.length) {
          return Response.json(
            { error: 'change would leave a newsletter with no admin; assign another admin first', newsletters: stranded },
            { status: 409 },
          );
        }
      }

      const stmts: D1PreparedStatement[] = [
        env.DB.prepare("UPDATE admins SET role = ?, updated_at = datetime('now') WHERE email = ?").bind(nextRole, tEmail),
      ];
      if (nextRole === 'super_admin') {
        // super_admins see everything; drop their explicit assignments.
        stmts.push(env.DB.prepare('DELETE FROM admins_newsletters WHERE email = ?').bind(tEmail));
      } else if (hasNlUpdate) {
        stmts.push(env.DB.prepare('DELETE FROM admins_newsletters WHERE email = ?').bind(tEmail));
        for (const id of nlIds!) {
          stmts.push(
            env.DB
              .prepare('INSERT OR IGNORE INTO admins_newsletters (email, newsletter_id) VALUES (?, ?)')
              .bind(tEmail, id),
          );
        }
      }
      await env.DB.batch(stmts);
      return Response.json({ ok: true, email: tEmail, role: nextRole });
    }
  }

  // -------- newsletters --------

  if (m === 'GET' && p === '/api/newsletters') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '20'), 1, 200);
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
    // Admins only see the newsletters they are assigned to; super admins see all.
    if (!isSuper && auth.newsletterIds.length === 0) {
      return Response.json({ items: [], total: 0, nextCursor: null });
    }
    const scope = isSuper ? '' : `WHERE n.id IN (${inPlaceholders(auth.newsletterIds.length)})`;
    const scopeBinds = isSuper ? [] : auth.newsletterIds;
    const [page, count] = await Promise.all([
      env.DB
        .prepare(
          `SELECT n.id, n.name, n.inbound_address, n.from_address, n.slug, n.allow_public_signup, n.enabled, n.created_at, ` +
            `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id) AS subscriber_count, ` +
            `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id AND s.status='active') AS active_count, ` +
            `(SELECT COUNT(*) FROM authors a WHERE a.newsletter_id = n.id) AS author_count ` +
            `FROM newsletters n ${scope} ORDER BY n.created_at ASC LIMIT ? OFFSET ?`,
        )
        .bind(...scopeBinds, limit, offset)
        .all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM newsletters n ${scope}`).bind(...scopeBinds).first<{ n: number }>(),
    ]);
    const items = page.results ?? [];
    const total = count?.n ?? 0;
    return Response.json({
      items,
      total,
      nextCursor: offset + items.length < total ? offset + limit : null,
    });
  }

  if (m === 'POST' && p === '/api/newsletters') {
    // Creating newsletters is a super_admin action unless the global toggle
    // ALLOW_ADMIN_NEWSLETTER_CRUD lets admins do it too.
    if (!allowNlCrud) return forbidden();
    const { name, inbound_address, from_address, footer_html, footer_text } = await req.json<{
      name?: string;
      inbound_address?: string;
      from_address?: string;
      footer_html?: string | null;
      footer_text?: string | null;
    }>();
    const nm = (name ?? '').trim();
    const addr = (inbound_address ?? '').trim().toLowerCase();
    if (!nm) return Response.json({ error: 'name required' }, { status: 400 });
    if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
      return Response.json({ error: 'valid inbound_address required' }, { status: 400 });
    }
    // Names must be unique, case-insensitively.
    const dupe = await env.DB
      .prepare('SELECT 1 FROM newsletters WHERE name = ? COLLATE NOCASE LIMIT 1')
      .bind(nm)
      .first();
    if (dupe) return Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 });
    let from: string | null = null;
    if (typeof from_address === 'string' && from_address.trim() !== '') {
      const r = validateFromAddress(from_address, env.BASE_DOMAIN);
      if ('error' in r) return Response.json({ error: r.error }, { status: 400 });
      from = r.value;
    }
    const fh = normalizeFooterHtml(footer_html);
    if ('error' in fh) return Response.json({ error: fh.error }, { status: 400 });
    const ft = normalizeFooterText(footer_text);
    if ('error' in ft) return Response.json({ error: ft.error }, { status: 400 });
    const id = crypto.randomUUID();
    // Auto-derive a unique public slug from the name (editable later). Public
    // signup itself stays off (allow_public_signup defaults to 0).
    const slug = await uniqueSlug(env, nm);
    try {
      await env.DB
        .prepare(
          'INSERT INTO newsletters (id, name, inbound_address, from_address, footer_html, footer_text, slug, enabled) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
        )
        .bind(id, nm, addr, from, fh.value, ft.value, slug)
        .run();
    } catch (err) {
      const msg = (err as Error).message;
      if (/UNIQUE/i.test(msg)) {
        return /name/i.test(msg)
          ? Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 })
          : Response.json({ error: 'inbound address already in use' }, { status: 409 });
      }
      throw err;
    }
    // Keep the ">= 1 admin per newsletter" invariant: an admin who creates a
    // newsletter (via the toggle) is auto-assigned to it. Super admins assign
    // admins explicitly via the user-management API. TODO(step 4): require at
    // least one admin assignment when a super_admin creates a newsletter.
    if (!isSuper) {
      await env.DB
        .prepare('INSERT OR IGNORE INTO admins_newsletters (email, newsletter_id) VALUES (?, ?)')
        .bind(auth.email, id)
        .run();
    }
    const routing_warning = await createRoutingRule(env, addr);
    return Response.json({ id, name: nm, inbound_address: addr, from_address: from, enabled: 1, routing_warning }, { status: 201 });
  }

  const nl = /^\/api\/newsletters\/([^/]+)(\/.*)?$/.exec(p);
  if (nl) {
    const nid = decodeURIComponent(nl[1]!);
    const rest = nl[2] ?? '';

    // Admins may only touch newsletters they are assigned to. 404 (not 403) so
    // an admin cannot probe which newsletter ids exist. Super admins pass.
    if (!canSeeNl(nid)) return Response.json({ error: 'not found' }, { status: 404 });

    // Capability gate: any non-GET request under a newsletter is a mutation
    // (settings, subscribers, authors, admin assignments). Read-only admins may
    // view but not change anything; super_admins and edit-admins pass. This is
    // the single choke point — individual sub-routes below assume edit access.
    if (m !== 'GET' && !canEdit) return forbidden();

    // ---- admins assigned to this newsletter ----
    // Manage regular admins where they belong: on the newsletter. Listing is
    // open to anyone who can see the newsletter; mutations already required
    // edit (or super) via the gate above.
    if (rest === '/admins' && m === 'GET') {
      const { results } = await env.DB
        .prepare(
          "SELECT a.email, a.capability FROM admins a " +
            "JOIN admins_newsletters an ON an.email = a.email " +
            "WHERE an.newsletter_id = ? AND a.role = 'admin' ORDER BY a.email",
        )
        .bind(nid)
        .all<{ email: string; capability: Capability }>();
      return Response.json({ items: results ?? [] });
    }
    if (rest === '/admins' && m === 'POST') {
      const body = await req.json<{ email?: string; capability?: string }>();
      const newEmail = (body.email ?? '').trim().toLowerCase();
      const capability: Capability = body.capability === 'edit' ? 'edit' : 'read_only';
      if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
        return Response.json({ error: 'valid email required' }, { status: 400 });
      }
      const existing = await env.DB
        .prepare('SELECT role FROM admins WHERE email = ?')
        .bind(newEmail)
        .first<{ role: Role }>();
      if (existing?.role === 'super_admin') {
        return Response.json(
          { error: 'that user is a super admin and already has full access' },
          { status: 409 },
        );
      }
      // Already assigned to this newsletter?
      const already = await env.DB
        .prepare('SELECT 1 AS x FROM admins_newsletters WHERE email = ? AND newsletter_id = ?')
        .bind(newEmail, nid)
        .first();
      if (already) return Response.json({ error: 'already an admin of this newsletter' }, { status: 409 });

      let list_warning: string | undefined;
      let notify_warning: string | undefined;
      if (!existing) {
        // Brand-new console user: create the admin row with the chosen
        // capability, then sync the Access list + notify.
        await env.DB
          .prepare('INSERT INTO admins (email, role, capability) VALUES (?, ?, ?)')
          .bind(newEmail, 'admin', capability)
          .run();
        list_warning = await addEmailToAccessList(env, newEmail);
        notify_warning = await notifyUser(env, newEmail, 'admin', 'added');
      }
      // Existing admins keep their current capability (use the row toggle to
      // change it); only the assignment is added here.
      await env.DB
        .prepare('INSERT OR IGNORE INTO admins_newsletters (email, newsletter_id) VALUES (?, ?)')
        .bind(newEmail, nid)
        .run();
      return Response.json({ ok: true, email: newEmail, list_warning, notify_warning }, { status: 201 });
    }
    const nlAdminMatch = /^\/admins\/(.+)$/.exec(rest);
    if (nlAdminMatch) {
      const tEmail = decodeURIComponent(nlAdminMatch[1]!).toLowerCase();
      // The target must be an admin assigned to this newsletter.
      const target = await env.DB
        .prepare('SELECT role FROM admins WHERE email = ?')
        .bind(tEmail)
        .first<{ role: Role }>();
      if (!target || target.role !== 'admin') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const assigned = await env.DB
        .prepare('SELECT 1 AS x FROM admins_newsletters WHERE email = ? AND newsletter_id = ?')
        .bind(tEmail, nid)
        .first();
      if (!assigned) return Response.json({ error: 'not found' }, { status: 404 });

      if (m === 'PATCH') {
        const body = await req.json<{ capability?: string }>();
        if (body.capability !== 'edit' && body.capability !== 'read_only') {
          return Response.json({ error: "capability must be 'edit' or 'read_only'" }, { status: 400 });
        }
        await env.DB
          .prepare("UPDATE admins SET capability = ?, updated_at = datetime('now') WHERE email = ?")
          .bind(body.capability, tEmail)
          .run();
        return Response.json({ ok: true });
      }
      if (m === 'DELETE') {
        // Remove this assignment. If it was the admin's last newsletter, remove
        // the user entirely (sync the Access list + notify). The newsletter is
        // never stranded: super_admins always manage every newsletter.
        await env.DB
          .prepare('DELETE FROM admins_newsletters WHERE email = ? AND newsletter_id = ?')
          .bind(tEmail, nid)
          .run();
        const remaining = await env.DB
          .prepare('SELECT COUNT(*) AS n FROM admins_newsletters WHERE email = ?')
          .bind(tEmail)
          .first<{ n: number }>();
        let list_warning: string | undefined;
        let notify_warning: string | undefined;
        if ((remaining?.n ?? 0) === 0) {
          await env.DB.prepare('DELETE FROM admins WHERE email = ?').bind(tEmail).run();
          list_warning = await removeEmailFromAccessList(env, tEmail);
          notify_warning = await notifyUser(env, tEmail, 'admin', 'removed');
        }
        return Response.json({ ok: true, removed_user: (remaining?.n ?? 0) === 0, list_warning, notify_warning });
      }
    }

    // ---- newsletter root: detail / update / delete ----
    if (rest === '') {
      if (m === 'GET') {
        const row = await env.DB
          .prepare(
            `SELECT n.id, n.name, n.inbound_address, n.from_address, n.footer_html, n.footer_text, n.slug, n.allow_public_signup, n.enabled, n.created_at, ` +
              `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id) AS subscriber_count, ` +
              `(SELECT COUNT(*) FROM subscribers s WHERE s.newsletter_id = n.id AND s.status='active') AS active_count, ` +
              `(SELECT COUNT(*) FROM authors a WHERE a.newsletter_id = n.id) AS author_count ` +
              `FROM newsletters n WHERE n.id = ?`,
          )
          .bind(nid)
          .first();
        if (!row) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json(row);
      }
      if (m === 'PATCH') {
        const body = await req.json<{
          name?: string;
          enabled?: boolean;
          inbound_address?: string;
          from_address?: string | null;
          footer_html?: string | null;
          footer_text?: string | null;
          slug?: string;
          allow_public_signup?: boolean;
        }>();
        const sets: string[] = [];
        const binds: unknown[] = [];
        if (typeof body.name === 'string') {
          const nm = body.name.trim();
          if (!nm) return Response.json({ error: 'name cannot be empty' }, { status: 400 });
          // Reject a rename that collides with another newsletter's name
          // (case-insensitive); the newsletter itself is excluded.
          const dupe = await env.DB
            .prepare('SELECT 1 FROM newsletters WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1')
            .bind(nm, nid)
            .first();
          if (dupe) return Response.json({ error: 'a newsletter with this name already exists' }, { status: 409 });
          sets.push('name = ?');
          binds.push(nm);
        }
        if (typeof body.enabled === 'boolean') {
          sets.push('enabled = ?');
          binds.push(body.enabled ? 1 : 0);
        }
        // from_address: a non-empty string sets the per-newsletter sender;
        // null or an empty string clears it (falls back to global FROM_ADDRESS).
        if (body.from_address === null || body.from_address === '') {
          sets.push('from_address = ?');
          binds.push(null);
        } else if (typeof body.from_address === 'string') {
          const r = validateFromAddress(body.from_address, env.BASE_DOMAIN);
          if ('error' in r) return Response.json({ error: r.error }, { status: 400 });
          sets.push('from_address = ?');
          binds.push(r.value);
        }
        if (typeof body.inbound_address === 'string') {
          const addr = body.inbound_address.trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            return Response.json({ error: 'valid inbound_address required' }, { status: 400 });
          }
          sets.push('inbound_address = ?');
          binds.push(addr);
        }
        // footer_html / footer_text: null or empty string clears the override
        // (inherits the global default); a string is length-checked, and the
        // HTML is sanitized to the allow-list before storing.
        if ('footer_html' in body) {
          const fh = normalizeFooterHtml(body.footer_html);
          if ('error' in fh) return Response.json({ error: fh.error }, { status: 400 });
          sets.push('footer_html = ?');
          binds.push(fh.value);
        }
        if ('footer_text' in body) {
          const ft = normalizeFooterText(body.footer_text);
          if ('error' in ft) return Response.json({ error: ft.error }, { status: 400 });
          sets.push('footer_text = ?');
          binds.push(ft.value);
        }
        // slug: the public subscribe identifier. An empty value re-derives a
        // unique slug from the (possibly just-renamed) name; a provided value is
        // format-validated and checked for uniqueness.
        if (typeof body.slug === 'string') {
          const raw = body.slug.trim().toLowerCase();
          let slug: string;
          if (raw === '') {
            const baseName = typeof body.name === 'string' ? body.name : '';
            slug = await uniqueSlug(env, baseName || nid, nid);
          } else {
            if (!SLUG_RE.test(raw) || raw.length > SLUG_MAX) {
              return Response.json(
                { error: 'slug must be lowercase letters, numbers and single hyphens' },
                { status: 400 },
              );
            }
            const clash = await env.DB
              .prepare('SELECT 1 FROM newsletters WHERE slug = ? AND id <> ? LIMIT 1')
              .bind(raw, nid)
              .first();
            if (clash) return Response.json({ error: 'that slug is already in use' }, { status: 409 });
            slug = raw;
          }
          sets.push('slug = ?');
          binds.push(slug);
        }
        if (typeof body.allow_public_signup === 'boolean') {
          sets.push('allow_public_signup = ?');
          binds.push(body.allow_public_signup ? 1 : 0);
        }
        if (sets.length === 0) return Response.json({ error: 'no fields' }, { status: 400 });
        // Capture the current address + enabled state before the update so we
        // can reconcile the Email Routing rule (move on rename, enable/disable
        // on toggle) afterwards.
        const touchesRouting =
          typeof body.inbound_address === 'string' || typeof body.enabled === 'boolean';
        let cur: { inbound_address: string; enabled: number } | null = null;
        if (touchesRouting) {
          cur = await env.DB
            .prepare('SELECT inbound_address, enabled FROM newsletters WHERE id = ?')
            .bind(nid)
            .first<{ inbound_address: string; enabled: number }>();
        }
        binds.push(nid);
        try {
          const res = await env.DB
            .prepare(`UPDATE newsletters SET ${sets.join(', ')} WHERE id = ?`)
            .bind(...binds)
            .run();
          if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        } catch (err) {
          if (/UNIQUE/i.test((err as Error).message)) {
            return Response.json({ error: 'inbound address already in use' }, { status: 409 });
          }
          throw err;
        }
        let routing_warning: string | undefined;
        if (cur) {
          const newAddr =
            typeof body.inbound_address === 'string'
              ? body.inbound_address.trim().toLowerCase()
              : cur.inbound_address;
          const newEnabled =
            typeof body.enabled === 'boolean' ? body.enabled : cur.enabled === 1;
          if (newAddr !== cur.inbound_address) {
            // Rename: move the rule (preserving the resulting enabled state).
            routing_warning = await moveRoutingRule(env, cur.inbound_address, newAddr, newEnabled);
          } else if (newEnabled !== (cur.enabled === 1)) {
            // Enable/disable toggle: flip the rule's enabled flag to match.
            routing_warning = await setRoutingRuleEnabled(env, newAddr, newEnabled);
          }
        }
        return Response.json({ ok: true, routing_warning });
      }
      if (m === 'DELETE') {
        // Deleting newsletters is a super_admin action unless the toggle lets
        // admins do it too (membership already checked above).
        if (!allowNlCrud) return forbidden();
        // Campaigns retain a newsletter_id with no cascade; refuse to delete a
        // newsletter that still has campaign history to avoid orphaning it.
        const camp = await env.DB
          .prepare('SELECT COUNT(*) AS n FROM campaigns WHERE newsletter_id = ?')
          .bind(nid)
          .first<{ n: number }>();
        if ((camp?.n ?? 0) > 0) {
          return Response.json(
            { error: 'newsletter has campaign history; cannot delete' },
            { status: 409 },
          );
        }
        const cur = await env.DB
          .prepare('SELECT inbound_address FROM newsletters WHERE id = ?')
          .bind(nid)
          .first<{ inbound_address: string }>();
        const res = await env.DB.prepare('DELETE FROM newsletters WHERE id = ?').bind(nid).run();
        if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        const routing_warning = cur ? await deleteRoutingRule(env, cur.inbound_address) : undefined;
        return Response.json({ ok: true, routing_warning });
      }
    }

    // ---- authors (scoped to newsletter) ----
    if (rest === '/authors') {
      if (m === 'GET') {
        const { results } = await env.DB
          .prepare('SELECT email, name, created_at FROM authors WHERE newsletter_id = ? ORDER BY created_at DESC')
          .bind(nid)
          .all<{ email: string; name: string | null; created_at: string }>();
        return Response.json({ items: results ?? [] });
      }
      if (m === 'POST') {
        const { email, name } = await req.json<{ email: string; name?: string | null }>();
        const norm = (email ?? '').trim().toLowerCase();
        if (!norm || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) {
          return Response.json({ error: 'valid email required' }, { status: 400 });
        }
        try {
          await env.DB
            .prepare('INSERT INTO authors (newsletter_id, email, name) VALUES (?, ?, ?)')
            .bind(nid, norm, name ?? null)
            .run();
        } catch (err) {
          if (/UNIQUE|PRIMARY KEY/i.test((err as Error).message)) {
            return Response.json({ error: 'author already exists' }, { status: 409 });
          }
          throw err;
        }
        return Response.json({ email: norm, name: name ?? null }, { status: 201 });
      }
    }
    const am = /^\/authors\/(.+)$/.exec(rest);
    if (am) {
      const email = decodeURIComponent(am[1]!).toLowerCase();
      if (m === 'DELETE') {
        const res = await env.DB
          .prepare('DELETE FROM authors WHERE newsletter_id = ? AND email = ?')
          .bind(nid, email)
          .run();
        if (!res.meta?.changes) return Response.json({ error: 'not found' }, { status: 404 });
        return Response.json({ ok: true });
      }
      if (m === 'PATCH') {
        const body = await req.json<{ name?: string | null }>();
        await env.DB
          .prepare('UPDATE authors SET name = ? WHERE newsletter_id = ? AND email = ?')
          .bind(body.name ?? null, nid, email)
          .run();
        return Response.json({ ok: true });
      }
    }

    // ---- subscribers (scoped to newsletter) ----
    if (rest === '/subscribers') {
      if (m === 'GET') {
        const status = url.searchParams.get('status');
        const q = url.searchParams.get('q');
        const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
        const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
        const where: string[] = ['newsletter_id = ?'];
        const binds: unknown[] = [nid];
        if (status) {
          where.push('status = ?');
          binds.push(status);
        }
        if (q) {
          where.push('(email LIKE ? OR name LIKE ?)');
          const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
          binds.push(like, like);
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const [page, count] = await Promise.all([
          env.DB
            .prepare(
              `SELECT id, email, name, verified, status, bounce_count, subscribed_at FROM subscribers ` +
                `${whereSql} ORDER BY id ASC LIMIT ? OFFSET ?`,
            )
            .bind(...binds, limit, offset)
            .all(),
          env.DB
            .prepare(`SELECT COUNT(*) AS n FROM subscribers ${whereSql}`)
            .bind(...binds)
            .first<{ n: number }>(),
        ]);
        const items = page.results ?? [];
        const total = count?.n ?? 0;
        return Response.json({
          items,
          total,
          nextCursor: offset + items.length < total ? offset + limit : null,
        });
      }
      if (m === 'POST') {
        const { email, name } = await req.json<{ email: string; name?: string }>();
        if (!email) return Response.json({ error: 'email required' }, { status: 400 });
        const token = crypto.randomUUID();
        await env.DB
          .prepare(
            "INSERT INTO subscribers (newsletter_id, email, name, token) VALUES (?, ?, ?, ?) " +
              "ON CONFLICT(newsletter_id, email) DO UPDATE SET status='active', name=COALESCE(excluded.name, subscribers.name)",
          )
          .bind(nid, email, name ?? null, token)
          .run();
        return Response.json({ ok: true });
      }
    }
    if (rest === '/subscribers/export' && m === 'GET') {
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q');
      const where: string[] = ['newsletter_id = ?'];
      const binds: unknown[] = [nid];
      if (status) {
        where.push('status = ?');
        binds.push(status);
      }
      if (q) {
        where.push('(email LIKE ? OR name LIKE ?)');
        const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
        binds.push(like, like);
      }
      const { results } = await env.DB
        .prepare(
          `SELECT email, name, verified, status, bounce_count, subscribed_at FROM subscribers ` +
            `WHERE ${where.join(' AND ')} ORDER BY email ASC`,
        )
        .bind(...binds)
        .all<{ email: string; name: string | null; verified: number; status: string; bounce_count: number; subscribed_at: string }>();
      const header = 'Email,Name,Verified,Status,Bounces,Date subscribed';
      const lines = (results ?? []).map((r) =>
        [
          r.email,
          r.name ?? '',
          r.verified ? 'True' : 'False',
          r.status,
          String(r.bounce_count ?? 0),
          r.subscribed_at ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
      const csv = [header, ...lines].join('\r\n') + '\r\n';
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(csv, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="subscribers-${stamp}.csv"`,
        },
      });
    }
    if (rest === '/subscribers/import' && m === 'POST') {
      const ct = req.headers.get('content-type') ?? '';
      const text = ct.includes('application/json')
        ? (await req.json<{ csv: string }>()).csv
        : await req.text();
      // Positional mapping (the header row is always ignored):
      //   field 1 = email, field 2 = Verified, field 3 = date subscribed.
      // Name is not present in the import and is left null.
      // Duplicates (by email, case-insensitive) are skipped, not updated —
      // both against existing rows and within the file itself.
      const existing = await env.DB
        .prepare('SELECT email FROM subscribers WHERE newsletter_id = ?')
        .bind(nid)
        .all<{ email: string }>();
      const seen = new Set((existing.results ?? []).map((r) => r.email.toLowerCase()));
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      let added = 0;
      let duplicated = 0;
      for (const line of lines.slice(1)) {
        const cols = splitCsvLine(line);
        const email = (cols[0] ?? '').trim();
        if (!email) continue;
        const key = email.toLowerCase();
        if (seen.has(key)) {
          duplicated++;
          continue;
        }
        seen.add(key);
        const verified = parseBool(cols[1]) ? 1 : 0;
        const subscribedAt = (cols[2] ?? '').trim();
        const token = crypto.randomUUID();
        await env.DB
          .prepare(
            "INSERT INTO subscribers (newsletter_id, email, name, verified, subscribed_at, token) " +
              "VALUES (?, ?, NULL, ?, COALESCE(NULLIF(?, ''), datetime('now')), ?) " +
              "ON CONFLICT(newsletter_id, email) DO NOTHING",
          )
          .bind(nid, email, verified, subscribedAt, token)
          .run();
        added++;
      }
      return Response.json({ ok: true, added, duplicated });
    }
    const sm = /^\/subscribers\/(\d+)$/.exec(rest);
    if (sm) {
      const id = Number(sm[1]);
      if (m === 'DELETE') {
        await env.DB
          .prepare("UPDATE subscribers SET status='unsubscribed', unsubscribed_at=datetime('now') WHERE id = ? AND newsletter_id = ?")
          .bind(id, nid)
          .run();
        return Response.json({ ok: true });
      }
      if (m === 'PATCH') {
        const body = await req.json<SubscriberPatch>();
        const sets: string[] = [];
        const binds: unknown[] = [];
        if ('name' in body) {
          sets.push('name = ?');
          binds.push(body.name);
        }
        if (body.status) {
          sets.push('status = ?');
          binds.push(body.status);
          if (body.status === 'unsubscribed') sets.push("unsubscribed_at = datetime('now')");
        }
        if (sets.length === 0) return Response.json({ error: 'no fields' }, { status: 400 });
        binds.push(id, nid);
        await env.DB
          .prepare(`UPDATE subscribers SET ${sets.join(', ')} WHERE id = ? AND newsletter_id = ?`)
          .bind(...binds)
          .run();
        return Response.json({ ok: true });
      }
    }
  }

  // -------- campaigns --------

  if (m === 'GET' && p === '/api/campaigns') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
    const newsletterId = url.searchParams.get('newsletter_id');
    // Admins are confined to their newsletters: an explicit filter must be in
    // scope, and absent a filter we restrict the result set to their set.
    if (!isSuper) {
      if (auth.newsletterIds.length === 0) {
        return Response.json({ items: [], total: 0, nextCursor: null });
      }
      if (newsletterId && !auth.newsletterIds.includes(newsletterId)) return forbidden();
    }
    const conds: string[] = [];
    const binds: unknown[] = [];
    if (newsletterId) {
      conds.push('c.newsletter_id = ?');
      binds.push(newsletterId);
    } else if (!isSuper) {
      conds.push(`c.newsletter_id IN (${inPlaceholders(auth.newsletterIds.length)})`);
      binds.push(...auth.newsletterIds);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [page, count] = await Promise.all([
      env.DB
        .prepare(
          `SELECT c.id, c.newsletter_id, n.name AS newsletter_name, c.subject, c.status, ` +
            `c.total_recipients, c.sent_count, c.failed_count, ` +
            `c.attachment_count, c.link_mode, c.created_at ` +
            `FROM campaigns c LEFT JOIN newsletters n ON n.id = c.newsletter_id ` +
            `${where} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
        )
        .bind(...binds, limit, offset)
        .all(),
      env.DB
        .prepare(`SELECT COUNT(*) AS n FROM campaigns c ${where}`)
        .bind(...binds)
        .first<{ n: number }>(),
    ]);
    const items = page.results ?? [];
    const total = count?.n ?? 0;
    return Response.json({
      items,
      total,
      nextCursor: offset + items.length < total ? offset + limit : null,
    });
  }

  const campMatch = /^\/api\/campaigns\/([^/]+)(?:\/(timeseries|sends|replay-failed))?$/.exec(p);
  if (campMatch) {
    const id = campMatch[1];
    const sub = campMatch[2];

    // Confine admins to campaigns belonging to their newsletters. 404 hides
    // existence of out-of-scope campaigns. Super admins skip the check.
    if (!isSuper) {
      const owner = await env.DB
        .prepare('SELECT newsletter_id FROM campaigns WHERE id = ?')
        .bind(id)
        .first<{ newsletter_id: string }>();
      if (!owner || !auth.newsletterIds.includes(owner.newsletter_id)) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
    }
    // Campaign mutations (e.g. replay-failed) require edit; read-only admins
    // may only view campaign data.
    if (m !== 'GET' && !canEdit) return forbidden();

    if (m === 'GET' && !sub) {
      const campaign = await env.DB
        .prepare(
          'SELECT c.id, c.newsletter_id, n.name AS newsletter_name, c.subject, c.status, ' +
            'c.total_recipients, c.sent_count, c.failed_count, ' +
            'c.attachment_count, c.attachment_total_bytes, c.link_mode, c.sent_by, c.created_at ' +
            'FROM campaigns c LEFT JOIN newsletters n ON n.id = c.newsletter_id WHERE c.id = ?',
        )
        .bind(id)
        .first();
      if (!campaign) return Response.json({ error: 'not found' }, { status: 404 });
      const events = await env.DB
        .prepare(
          'SELECT type, COUNT(*) AS n FROM events WHERE campaign_id = ? GROUP BY type',
        )
        .bind(id)
        .all<{ type: string; n: number }>();
      const attachments = await env.DB
        .prepare(
          'SELECT id, filename, content_type, size, disposition FROM attachments WHERE campaign_id = ?',
        )
        .bind(id)
        .all();
      return Response.json({ campaign, events: events.results ?? [], attachments: attachments.results ?? [] });
    }

    if (m === 'GET' && sub === 'timeseries') {
      const bucket = url.searchParams.get('bucket') === 'day' ? 'day' : 'hour';
      const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m-%d %H:00';
      const { results } = await env.DB
        .prepare(
          `SELECT strftime(?, ts) AS bucket, type, COUNT(*) AS n ` +
            `FROM events WHERE campaign_id = ? GROUP BY bucket, type ORDER BY bucket ASC`,
        )
        .bind(fmt, id)
        .all();
      return Response.json({ items: results ?? [] });
    }

    if (m === 'GET' && sub === 'sends') {
      const status = url.searchParams.get('status');
      const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
      const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
      const where: string[] = ['s.campaign_id = ?'];
      const binds: unknown[] = [id];
      if (status) {
        where.push('s.status = ?');
        binds.push(status);
      }
      const whereSql = `WHERE ${where.join(' AND ')}`;
      const [page, count] = await Promise.all([
        env.DB
          .prepare(
            `SELECT s.id, s.subscriber_id, sub.email, s.status, s.sent_at, s.error, s.message_id ` +
              `FROM sends s LEFT JOIN subscribers sub ON sub.id = s.subscriber_id ` +
              `${whereSql} ORDER BY s.id ASC LIMIT ? OFFSET ?`,
          )
          .bind(...binds, limit, offset)
          .all(),
        env.DB
          .prepare(`SELECT COUNT(*) AS n FROM sends s ${whereSql}`)
          .bind(...binds)
          .first<{ n: number }>(),
      ]);
      const items = page.results ?? [];
      const total = count?.n ?? 0;
      return Response.json({
        items,
        total,
        nextCursor: offset + items.length < total ? offset + limit : null,
      });
    }

    if (m === 'POST' && sub === 'replay-failed') {
      // Counter-only stub. Real replay needs a QUEUE binding here; the consumer
      // worker is already idempotent on (campaign_id, subscriber_id).
      const row = await env.DB
        .prepare("SELECT COUNT(*) AS n FROM sends WHERE campaign_id = ? AND status = 'failed'")
        .bind(id)
        .first<{ n: number }>();
      return Response.json({ ok: false, would_replay: row?.n ?? 0, hint: 'attach QUEUE binding to admin worker to enable' });
    }
  }

  // -------- bounces --------

  if (m === 'GET' && p === '/api/bounces') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '100'), 1, 500);
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
    const since = url.searchParams.get('since') ?? "datetime('now','-7 days')";
    // `since` is either a built-in datetime() expression (inlined) or a literal
    // bound value. Build a shared WHERE so the page and count queries match.
    const sinceExpr = since.startsWith('datetime') ? since : '?';
    const sinceBind = since.startsWith('datetime') ? [] : [since];
    // Confine admins to bounces on their own newsletters' campaigns.
    let nlScope = '';
    const nlBind: string[] = [];
    if (!isSuper) {
      if (auth.newsletterIds.length === 0) {
        return Response.json({ items: [], total: 0, nextCursor: null });
      }
      nlScope = ` AND e.campaign_id IN (SELECT id FROM campaigns WHERE newsletter_id IN (${inPlaceholders(auth.newsletterIds.length)}))`;
      nlBind.push(...auth.newsletterIds);
    }
    const whereSql = `WHERE e.type = 'bounce' AND e.ts > ${sinceExpr}${nlScope}`;
    const [page, count] = await Promise.all([
      env.DB
        .prepare(
          `SELECT e.id, e.campaign_id, e.subscriber_id, sub.email, e.url AS status_code, e.ts ` +
            `FROM events e LEFT JOIN subscribers sub ON sub.id = e.subscriber_id ` +
            `${whereSql} ORDER BY e.ts DESC LIMIT ? OFFSET ?`,
        )
        .bind(...sinceBind, ...nlBind, limit, offset)
        .all(),
      env.DB
        .prepare(`SELECT COUNT(*) AS n FROM events e ${whereSql}`)
        .bind(...sinceBind, ...nlBind)
        .first<{ n: number }>(),
    ]);
    const items = page.results ?? [];
    const total = count?.n ?? 0;
    return Response.json({
      items,
      total,
      nextCursor: offset + items.length < total ? offset + limit : null,
    });
  }

  // -------- logs --------
  //
  // Unified, searchable activity feed merging the pipeline `logs` table
  // (ingest -> queue -> consumer) with recipient engagement `events`
  // (open/click/bounce/unsubscribe/download). Offset-paginated (cursor =
  // offset) and ordered newest-first.

  if (m === 'GET' && p === '/api/logs') {
    const limit = clamp(Number(url.searchParams.get('limit') ?? '50'), 1, 200);
    const offset = Math.max(0, Number(url.searchParams.get('cursor') ?? '0') || 0);
    const q = (url.searchParams.get('q') ?? '').trim();
    const source = (url.searchParams.get('source') ?? '').trim();
    const level = (url.searchParams.get('level') ?? '').trim();

    const inner =
      "SELECT 'log' AS kind, l.id AS id, l.ts AS ts, l.level AS level, l.source AS source, " +
        'l.event AS event, l.campaign_id AS campaign_id, l.newsletter_id AS newsletter_id, ' +
        'NULL AS subscriber_id, NULL AS email, l.message AS message, l.detail AS detail ' +
        'FROM logs l ' +
      'UNION ALL ' +
      "SELECT 'event' AS kind, e.id AS id, e.ts AS ts, " +
        "CASE WHEN e.type IN ('bounce','complaint') THEN 'warn' ELSE 'info' END AS level, " +
        "CASE WHEN e.type IN ('bounce','complaint') THEN 'bounce' ELSE 'tracker' END AS source, " +
        'e.type AS event, e.campaign_id AS campaign_id, NULL AS newsletter_id, ' +
        'e.subscriber_id AS subscriber_id, sub.email AS email, NULL AS message, e.url AS detail ' +
        'FROM events e LEFT JOIN subscribers sub ON sub.id = e.subscriber_id';

    const conds: string[] = [];
    const binds: unknown[] = [];
    if (source) {
      conds.push('f.source = ?');
      binds.push(source);
    }
    if (level) {
      conds.push('f.level = ?');
      binds.push(level);
    }
    if (q) {
      const like = `%${q}%`;
      conds.push(
        '(f.event LIKE ? OR f.message LIKE ? OR f.campaign_id LIKE ? OR f.email LIKE ? OR f.detail LIKE ? OR n.name LIKE ?)',
      );
      binds.push(like, like, like, like, like, like);
    }
    // Confine admins to activity on their own newsletters (resolved via the
    // log's own newsletter_id or, failing that, the campaign's).
    if (!isSuper) {
      if (auth.newsletterIds.length === 0) {
        conds.push('1 = 0');
      } else {
        conds.push(`COALESCE(f.newsletter_id, c.newsletter_id) IN (${inPlaceholders(auth.newsletterIds.length)})`);
        binds.push(...auth.newsletterIds);
      }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    // Resolve the newsletter name from the log's own newsletter_id when present
    // (ingest entries), otherwise via the campaign (consumer entries & events).
    const joined =
      `FROM (${inner}) f ` +
      'LEFT JOIN campaigns c ON c.id = f.campaign_id ' +
      'LEFT JOIN newsletters n ON n.id = COALESCE(f.newsletter_id, c.newsletter_id) ' +
      where;
    const sql =
      `SELECT f.*, n.name AS newsletter_name, c.subject AS campaign_subject ${joined} ` +
      'ORDER BY f.ts DESC, f.id DESC LIMIT ? OFFSET ?';
    const [page, count] = await Promise.all([
      env.DB.prepare(sql).bind(...binds, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n ${joined}`).bind(...binds).first<{ n: number }>(),
    ]);
    const items = page.results ?? [];
    const total = count?.n ?? 0;
    return Response.json({
      items,
      total,
      nextCursor: offset + items.length < total ? offset + limit : null,
    });
  }

  // CSV export of the (filtered) activity feed. Reuses the same merged query
  // and filters as /api/logs, but streams every matching row (capped) instead
  // of paginating.
  if (m === 'GET' && p === '/api/logs/export') {
    const q = (url.searchParams.get('q') ?? '').trim();
    const source = (url.searchParams.get('source') ?? '').trim();
    const level = (url.searchParams.get('level') ?? '').trim();
    const EXPORT_CAP = 100000;

    const inner =
      "SELECT 'log' AS kind, l.id AS id, l.ts AS ts, l.level AS level, l.source AS source, " +
        'l.event AS event, l.campaign_id AS campaign_id, l.newsletter_id AS newsletter_id, ' +
        'NULL AS subscriber_id, NULL AS email, l.message AS message, l.detail AS detail ' +
        'FROM logs l ' +
      'UNION ALL ' +
      "SELECT 'event' AS kind, e.id AS id, e.ts AS ts, " +
        "CASE WHEN e.type IN ('bounce','complaint') THEN 'warn' ELSE 'info' END AS level, " +
        "CASE WHEN e.type IN ('bounce','complaint') THEN 'bounce' ELSE 'tracker' END AS source, " +
        'e.type AS event, e.campaign_id AS campaign_id, NULL AS newsletter_id, ' +
        'e.subscriber_id AS subscriber_id, sub.email AS email, NULL AS message, e.url AS detail ' +
        'FROM events e LEFT JOIN subscribers sub ON sub.id = e.subscriber_id';

    const conds: string[] = [];
    const binds: unknown[] = [];
    if (source) {
      conds.push('f.source = ?');
      binds.push(source);
    }
    if (level) {
      conds.push('f.level = ?');
      binds.push(level);
    }
    if (q) {
      const like = `%${q}%`;
      conds.push(
        '(f.event LIKE ? OR f.message LIKE ? OR f.campaign_id LIKE ? OR f.email LIKE ? OR f.detail LIKE ? OR n.name LIKE ?)',
      );
      binds.push(like, like, like, like, like, like);
    }
    // Confine admins to activity on their own newsletters (same rule as the
    // paginated feed above).
    if (!isSuper) {
      if (auth.newsletterIds.length === 0) {
        conds.push('1 = 0');
      } else {
        conds.push(`COALESCE(f.newsletter_id, c.newsletter_id) IN (${inPlaceholders(auth.newsletterIds.length)})`);
        binds.push(...auth.newsletterIds);
      }
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const sql =
      `SELECT f.*, n.name AS newsletter_name, c.subject AS campaign_subject FROM (${inner}) f ` +
      'LEFT JOIN campaigns c ON c.id = f.campaign_id ' +
      'LEFT JOIN newsletters n ON n.id = COALESCE(f.newsletter_id, c.newsletter_id) ' +
      `${where} ORDER BY f.ts DESC, f.id DESC LIMIT ?`;
    const { results } = await env.DB
      .prepare(sql)
      .bind(...binds, EXPORT_CAP)
      .all<{
        kind: string;
        ts: string;
        level: string;
        source: string;
        event: string;
        newsletter_name: string | null;
        campaign_subject: string | null;
        campaign_id: string | null;
        email: string | null;
        message: string | null;
        detail: string | null;
      }>();
    // Mirror the table columns, with Campaign ID inserted right after the
    // campaign name. Description matches the table: the log message, or for
    // engagement events the recipient email and event detail.
    const header = 'Time (UTC),Level,Newsletter,Campaign,Campaign ID,Source,Event,Description';
    const lines = (results ?? []).map((r) => {
      const description =
        r.message ??
        (r.kind === 'event' ? [r.email, r.detail].filter(Boolean).join(' — ') : '');
      return [
        r.ts ?? '',
        r.level ?? '',
        r.newsletter_name ?? '',
        r.campaign_subject ?? '',
        r.campaign_id ?? '',
        r.source ?? '',
        r.event ?? '',
        description,
      ]
        .map(csvCell)
        .join(',');
    });
    const csv = [header, ...lines].join('\r\n') + '\r\n';
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="logs-${stamp}.csv"`,
      },
    });
  }

  // -------- Cloudflare Email Sending stats (per-domain) --------

  // Reads the sending domain's real usage from Cloudflare, not the app's own
  // `sends` table: the daily quota via the Email Service REST API and the
  // emails-sent counts via the GraphQL Analytics API (zone-scoped, 31-day
  // retention). Super-admin only. Each source degrades independently — a
  // missing token scope yields an `*_error` field rather than failing the call.
  if (m === 'GET' && p === '/api/email-sending-stats') {
    if (!isSuper) return forbidden();
    return Response.json(await emailSendingStats(env));
  }

  // -------- help document --------

  // Renders a markdown document stored in the R2 media bucket (key
  // `help.md`). Lets operators ship docs without redeploying the worker.
  if (m === 'GET' && p === '/api/help') {
    const obj = await env.ASSETS_R2.get('help.md');
    if (!obj) {
      return Response.json({ error: 'no help document uploaded' }, { status: 404 });
    }
    const content = await obj.text();
    return Response.json({ content, updated: obj.uploaded?.toISOString() ?? null });
  }

  // -------- stats / dashboard --------

  if (m === 'GET' && p === '/api/stats/overview') {
    // Admins see aggregates for their newsletters only; super admins see all.
    const scoped = !isSuper;
    if (scoped && auth.newsletterIds.length === 0) {
      return Response.json({
        subscribers: [],
        campaigns: { total: 0, sent: 0, sending: 0 },
        events_last_7d: [],
        newsletters: [],
      });
    }
    const ids = auth.newsletterIds;
    const scopeBinds = scoped ? ids : [];
    const inSql = scoped ? `(${inPlaceholders(ids.length)})` : '';

    const subs = await env.DB
      .prepare(
        `SELECT status, COUNT(*) AS n FROM subscribers ` +
          `${scoped ? `WHERE newsletter_id IN ${inSql} ` : ''}GROUP BY status`,
      )
      .bind(...scopeBinds)
      .all<{ status: string; n: number }>();
    const camps = await env.DB
      .prepare(
        "SELECT COUNT(*) AS total, " +
          "SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS sent, " +
          "SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending " +
          `FROM campaigns ${scoped ? `WHERE newsletter_id IN ${inSql}` : ''}`,
      )
      .bind(...scopeBinds)
      .first();
    const last7 = await env.DB
      .prepare(
        "SELECT type, COUNT(*) AS n FROM events WHERE ts > datetime('now','-7 days')" +
          (scoped ? ` AND campaign_id IN (SELECT id FROM campaigns WHERE newsletter_id IN ${inSql})` : '') +
          ' GROUP BY type',
      )
      .bind(...scopeBinds)
      .all();
    // Per-newsletter breakdown: the system is multi-tenant, so the dashboard
    // shows each newsletter's own subscriber/campaign counts.
    const perNl = await env.DB
      .prepare(
        'SELECT n.id, n.name, n.enabled, ' +
          "COUNT(DISTINCT s.id) AS subscribers, " +
          "COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.id END) AS active, " +
          'COUNT(DISTINCT c.id) AS campaigns ' +
          'FROM newsletters n ' +
          'LEFT JOIN subscribers s ON s.newsletter_id = n.id ' +
          'LEFT JOIN campaigns c ON c.newsletter_id = n.id ' +
          (scoped ? `WHERE n.id IN ${inSql} ` : '') +
          'GROUP BY n.id, n.name, n.enabled ' +
          'ORDER BY n.name COLLATE NOCASE',
      )
      .bind(...scopeBinds)
      .all<{ id: string; name: string; enabled: number; subscribers: number; active: number; campaigns: number }>();
    return Response.json({
      subscribers: subs.results ?? [],
      campaigns: camps,
      events_last_7d: last7.results ?? [],
      newsletters: perNl.results ?? [],
    });
  }

  return Response.json({ error: 'not found' }, { status: 404 });
}

// -------- Email Routing rule sync --------
//
// Keeps one Email Routing rule per newsletter, matching the newsletter's
// `inbound_address` (literal "to") and forwarding it to the ingest worker.
// All functions are best-effort: they return a human-readable warning string
// on failure (or when unconfigured) instead of throwing, so newsletter CRUD
// always succeeds even if rule management does not.

const CF_API = 'https://api.cloudflare.com/client/v4';

// Verifies a domain is a Cloudflare zone in this account and returns its zone id
// via the Cloudflare API (zone names are globally unique, so `?name=` returns at
// most one match). Uses the dedicated read-only token (CF_READ_API_TOKEN, Zone:
// Read). On success returns the id; otherwise returns an `error` message — the
// caller rejects the save so an unverifiable domain is never stored.
async function resolveZoneIdByDomain(
  env: Env,
  domain: string,
): Promise<{ zoneId?: string; error?: string }> {
  const token = env.CF_READ_API_TOKEN;
  if (!token) {
    return {
      error:
        'cannot verify the domain: the read API token (CF_READ_API_TOKEN, Zone: Read) is not configured on the worker',
    };
  }
  try {
    const res = await fetch(`${CF_API}/zones?name=${encodeURIComponent(domain)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || body?.success === false) {
      const msg =
        (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
        `HTTP ${res.status}`;
      return { error: `could not verify ${domain} with Cloudflare: ${msg}` };
    }
    const zone = (body.result ?? [])[0];
    if (!zone?.id) {
      return { error: `${domain} is not a Cloudflare zone in this account` };
    }
    return { zoneId: String(zone.id) };
  } catch (e) {
    return { error: `could not verify ${domain} with Cloudflare: ${(e as Error).message}` };
  }
}

// Reads the sending domain's real Email Sending usage from Cloudflare. Returns
// two independent sections so the UI can show whatever is available:
//   - `quota`     : the account's resolved daily sending limit (REST API).
//   - sent counts : emails sent over the last 30 days for this zone, broken
//                   down by status, plus today's total (GraphQL Analytics API,
//                   31-day retention). The `total` is the sum across statuses.
// Both use the read token (CF_READ_API_TOKEN); they need, respectively, an
// account Email read scope and the Analytics Read scope. Missing scopes surface
// as `quota_error` / `stats_error` rather than throwing.
async function emailSendingStats(env: Env): Promise<{
  configured: boolean;
  domain: string | null;
  zoneId: string | null;
  quota: { unit: string; value: number } | null;
  quota_error?: string;
  windowStart: string | null;
  windowEnd: string | null;
  total: number;
  today: number;
  byStatus: Record<string, number>;
  stats_error?: string;
  warmup: {
    level: number | null;
    started: boolean;
    weekStartedAt: string | null;
    weeklyCap: number;
    schedule: number[];
    targetWeekly: number;
    maxLevel: number;
    dailyCap: number | null;
    dailyCapDate: string | null;
    sentToday: number;
    sentThisWeek: number;
    demand: number;
  };
}> {
  const token = env.CF_READ_API_TOKEN;
  const zoneId = env.EMAIL_ROUTING_ZONE_ID ?? null;
  const accountId = env.ACCESS_ACCOUNT_ID ?? null;
  const domain = env.BASE_DOMAIN ?? null;
  const out = {
    configured: Boolean(token && zoneId),
    domain,
    zoneId,
    quota: null as { unit: string; value: number } | null,
    windowStart: null as string | null,
    windowEnd: null as string | null,
    total: 0,
    today: 0,
    byStatus: {} as Record<string, number>,
  } as Awaited<ReturnType<typeof emailSendingStats>>;

  // Warmup progression is read from D1 (state + config + counts), independent of
  // the Cloudflare API, so it is always populated even if the token/zone is
  // missing. The displayed daily cap comes from the live API quota above when
  // available; this `warmup.dailyCap` is the value the consumer cached.
  {
    const cfg = readWarmupConfig(env as unknown as Record<string, string | undefined>);
    const wstate: WarmupState = await loadWarmupState(env.DB);
    const now = new Date();
    const dStart = dayStartSql(now);
    const wStart = wstate.weekStartedAt ?? dStart;
    const [sentToday, sentThisWeek, demand] = await Promise.all([
      countSentSince(env.DB, dStart),
      countSentSince(env.DB, wStart),
      computeDemand(env.DB),
    ]);
    out.warmup = {
      level: wstate.level,
      started: wstate.level !== null,
      weekStartedAt: wstate.weekStartedAt,
      weeklyCap: weeklyCapForLevel(cfg, wstate.level),
      schedule: cfg.schedule,
      targetWeekly: cfg.targetWeekly,
      maxLevel: maxLevel(cfg),
      dailyCap: wstate.dailyCap,
      dailyCapDate: wstate.dailyCapDate,
      sentToday,
      sentThisWeek,
      demand,
    };
  }

  if (!token) {
    out.quota_error = 'read API token (CF_READ_API_TOKEN) not configured';
    out.stats_error = out.quota_error;
    return out;
  }

  // --- Daily quota (account-scoped REST endpoint) ---
  if (!accountId) {
    out.quota_error = 'account id not configured (save the Sending domain in Settings)';
  } else {
    try {
      const res = await fetch(`${CF_API}/accounts/${accountId}/email/sending/limits`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok || body?.success === false) {
        out.quota_error =
          (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
          `HTTP ${res.status}`;
      } else {
        const q = body?.result?.quota;
        out.quota = q && typeof q.value === 'number' ? { unit: q.unit, value: q.value } : null;
      }
    } catch (e) {
      out.quota_error = (e as Error).message;
    }
  }

  // --- Emails sent (zone-scoped GraphQL Analytics) ---
  if (!zoneId) {
    out.stats_error = 'sending domain / zone not resolved yet (save the Sending domain in Settings)';
    return out;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  out.windowStart = fmt(start);
  out.windowEnd = fmt(end);
  const query =
    'query($zoneTag:string!,$start:Date!,$end:Date!){viewer{zones(filter:{zoneTag:$zoneTag}){' +
    'emailSendingAdaptiveGroups(filter:{date_geq:$start,date_leq:$end},limit:10000,orderBy:[date_DESC]){' +
    'count dimensions{date status}}}}}';
  try {
    const res = await fetch(`${CF_API}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { zoneTag: zoneId, start: fmt(start), end: fmt(end) } }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (body?.errors?.length) {
      out.stats_error = body.errors.map((e: { message?: string }) => e.message).filter(Boolean).join('; ');
      return out;
    }
    const groups = body?.data?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups ?? [];
    const todayStr = fmt(end);
    for (const g of groups) {
      const c = Number(g.count ?? 0);
      const status = String(g.dimensions?.status ?? 'unknown');
      out.byStatus[status] = (out.byStatus[status] ?? 0) + c;
      out.total += c;
      if (g.dimensions?.date === todayStr) out.today += c;
    }
  } catch (e) {
    out.stats_error = (e as Error).message;
  }
  return out;
}

function routingReady(env: Env): boolean {
  return Boolean(env.CF_API_TOKEN && env.EMAIL_ROUTING_ZONE_ID);
}

function routingRulesPath(env: Env, suffix = ''): string {
  return `${CF_API}/zones/${env.EMAIL_ROUTING_ZONE_ID}/email/routing/rules${suffix}`;
}

async function cfJson(env: Env, urlStr: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(urlStr, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const msg =
      (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

function ruleBody(env: Env, addr: string, enabled = true): string {
  return JSON.stringify({
    name: `newsletter:${addr}`,
    enabled,
    matchers: [{ type: 'literal', field: 'to', value: addr }],
    actions: [{ type: 'worker', value: [env.INGEST_WORKER_NAME ?? 'newsletter-ingest'] }],
  });
}

// Returns the rule id whose "to" matcher equals `addr`, or null. Paginates.
async function findRoutingRuleId(env: Env, addr: string): Promise<string | null> {
  let page = 1;
  for (;;) {
    const body = await cfJson(env, routingRulesPath(env, `?page=${page}&per_page=50`));
    for (const r of body.result ?? []) {
      const matched = (r.matchers ?? []).some(
        (mm: { field?: string; value?: string }) =>
          mm.field === 'to' && String(mm.value ?? '').toLowerCase() === addr,
      );
      if (matched) return r.id ?? r.tag ?? null;
    }
    const info = body.result_info;
    if (!info || page >= (info.total_pages ?? 1)) return null;
    page++;
  }
}

async function createRoutingRule(env: Env, addr: string): Promise<string | undefined> {
  if (!routingReady(env)) {
    return 'Email Routing not configured — add the rule manually (set CF_API_TOKEN + EMAIL_ROUTING_ZONE_ID to automate).';
  }
  try {
    if (await findRoutingRuleId(env, addr)) return undefined; // already routed
    await cfJson(env, routingRulesPath(env), { method: 'POST', body: ruleBody(env, addr) });
    return undefined;
  } catch (e) {
    return `Email Routing rule not created: ${(e as Error).message}`;
  }
}

async function moveRoutingRule(
  env: Env,
  oldAddr: string,
  newAddr: string,
  enabled = true,
): Promise<string | undefined> {
  if (oldAddr === newAddr) return undefined;
  if (!routingReady(env)) {
    return 'Email Routing not configured — update the rule manually.';
  }
  try {
    const id = await findRoutingRuleId(env, oldAddr);
    if (id) {
      await cfJson(env, routingRulesPath(env, `/${id}`), { method: 'PUT', body: ruleBody(env, newAddr, enabled) });
    } else {
      await cfJson(env, routingRulesPath(env), { method: 'POST', body: ruleBody(env, newAddr, enabled) });
    }
    return undefined;
  } catch (e) {
    return `Email Routing rule not updated: ${(e as Error).message}`;
  }
}

// Flips an existing rule's `enabled` flag to match the newsletter's state.
async function setRoutingRuleEnabled(
  env: Env,
  addr: string,
  enabled: boolean,
): Promise<string | undefined> {
  if (!routingReady(env)) {
    return `Email Routing not configured — ${enabled ? 'enable' : 'disable'} the rule manually.`;
  }
  try {
    const id = await findRoutingRuleId(env, addr);
    if (id) {
      await cfJson(env, routingRulesPath(env, `/${id}`), { method: 'PUT', body: ruleBody(env, addr, enabled) });
    }
    return undefined;
  } catch (e) {
    return `Email Routing rule not ${enabled ? 'enabled' : 'disabled'}: ${(e as Error).message}`;
  }
}

async function deleteRoutingRule(env: Env, addr: string): Promise<string | undefined> {
  if (!routingReady(env)) return undefined;
  try {
    const id = await findRoutingRuleId(env, addr);
    if (id) await cfJson(env, routingRulesPath(env, `/${id}`), { method: 'DELETE' });
    return undefined;
  } catch (e) {
    return `Email Routing rule not deleted: ${(e as Error).message}`;
  }
}

// The bounce worker's script name. VERP return-paths are bounce+<id>@<domain>;
// with Email Routing subaddressing enabled they are matched by a single literal
// rule for bounce@<domain>, so we maintain exactly that rule on the sending
// domain's zone.
const BOUNCE_WORKER_NAME = 'newsletter-bounce';

function bounceRuleBody(env: Env, addr: string): string {
  return JSON.stringify({
    name: `bounce:${addr}`,
    enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: addr }],
    actions: [{ type: 'worker', value: [BOUNCE_WORKER_NAME] }],
  });
}

// Ensures the bounce catch-all rule (bounce@<BASE_DOMAIN> → bounce worker)
// exists on the sending domain's zone. Idempotent and best-effort: returns a
// human-readable warning instead of throwing. Called whenever the sending
// domain is saved so bounce handling tracks the domain automatically.
async function ensureBounceRule(env: Env): Promise<string | undefined> {
  if (!env.BASE_DOMAIN) return undefined;
  if (!routingReady(env)) {
    return `Email Routing not configured — add the bounce rule (bounce@${env.BASE_DOMAIN} → ${BOUNCE_WORKER_NAME}) manually.`;
  }
  const addr = `bounce@${env.BASE_DOMAIN}`.toLowerCase();
  try {
    if (await findRoutingRuleId(env, addr)) return undefined; // already present
    await cfJson(env, routingRulesPath(env), { method: 'POST', body: bounceRuleBody(env, addr) });
    return undefined;
  } catch (e) {
    return `Bounce Email Routing rule not created: ${(e as Error).message}`;
  }
}

// -------- Cloudflare Access "Emails" list sync --------
//
// Console users authenticate through a Cloudflare Access application whose
// policy admits an account-scoped Zero Trust list of emails. As users are
// added/removed in the console we keep that list in sync. Like the routing
// helpers above these are best-effort: they return a human-readable warning
// string on failure (or when unconfigured) rather than throwing, so user CRUD
// always succeeds even if the list update does not. The list holds every
// console user regardless of role (both admins and super_admins sign in).

function listSyncReady(env: Env): boolean {
  return Boolean(env.CF_ZT_API_TOKEN && env.ACCESS_ACCOUNT_ID && env.ACCESS_LIST_ID);
}

function listPath(env: Env, suffix = ''): string {
  return `${CF_API}/accounts/${env.ACCESS_ACCOUNT_ID}/gateway/lists/${env.ACCESS_LIST_ID}${suffix}`;
}

async function cfZtJson(env: Env, urlStr: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(urlStr, {
    ...init,
    headers: {
      authorization: `Bearer ${env.CF_ZT_API_TOKEN}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body?.success === false) {
    const msg =
      (body?.errors ?? []).map((e: { message?: string }) => e.message).filter(Boolean).join('; ') ||
      `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

async function addEmailToAccessList(env: Env, email: string): Promise<string | undefined> {
  if (!listSyncReady(env)) {
    return `Access list not configured — add ${email} to the Access list manually (set CF_ZT_API_TOKEN + ACCESS_ACCOUNT_ID + ACCESS_LIST_ID to automate).`;
  }
  try {
    await cfZtJson(env, listPath(env), {
      method: 'PATCH',
      body: JSON.stringify({ append: [{ value: email }] }),
    });
    return undefined;
  } catch (e) {
    return `Access list not updated (add ${email}): ${(e as Error).message}`;
  }
}

async function removeEmailFromAccessList(env: Env, email: string): Promise<string | undefined> {
  if (!listSyncReady(env)) {
    return `Access list not configured — remove ${email} from the Access list manually.`;
  }
  try {
    await cfZtJson(env, listPath(env), {
      method: 'PATCH',
      body: JSON.stringify({ remove: [email] }),
    });
    return undefined;
  } catch (e) {
    return `Access list not updated (remove ${email}): ${(e as Error).message}`;
  }
}

// Returns the lower-cased email values currently in the Access list. Paginates.
async function fetchAccessListEmails(env: Env): Promise<string[]> {
  const out: string[] = [];
  let page = 1;
  for (;;) {
    const body = await cfZtJson(env, listPath(env, `/items?page=${page}&per_page=1000`));
    for (const it of body.result ?? []) {
      const v = String(it.value ?? '').toLowerCase();
      if (v) out.push(v);
    }
    const info = body.result_info;
    if (!info || page >= (info.total_pages ?? 1)) break;
    page++;
  }
  return out;
}

// Makes the Access Emails list match the admins table (D1 is authoritative):
// appends provisioned users missing from the list and removes list entries that
// are no longer console users. Caller must ensure listSyncReady(env). Throws on
// API failure. Returns how many entries were added/removed.
async function reconcileAccessList(env: Env): Promise<{ added: number; removed: number }> {
  const { results } = await env.DB.prepare('SELECT email FROM admins').all<{ email: string }>();
  const desired = new Set((results ?? []).map((r) => r.email.toLowerCase()));
  const current = new Set(await fetchAccessListEmails(env));
  const append = [...desired].filter((e) => !current.has(e));
  const remove = [...current].filter((e) => !desired.has(e));
  if (append.length || remove.length) {
    await cfZtJson(env, listPath(env), {
      method: 'PATCH',
      body: JSON.stringify({ append: append.map((value) => ({ value })), remove }),
    });
  }
  return { added: append.length, removed: remove.length };
}

// Bare mailbox from a "Name <addr>" or plain "addr" From header.
function extractAddr(header: string): string {
  const m = /<([^>]+)>\s*$/.exec(header.trim());
  return (m ? m[1]! : header).trim();
}

// Best-effort notification to a console user when they are added or removed.
// Returns a warning string on failure (never throws) so user CRUD is not blocked.
async function notifyUser(
  env: Env,
  email: string,
  role: Role,
  event: 'added' | 'removed',
): Promise<string | undefined> {
  const fromHeader = env.FROM_ADDRESS;
  if (!env.SEND_EMAIL || !fromHeader) {
    return `Notification email not sent to ${email} (SEND_EMAIL binding or FROM_ADDRESS not configured).`;
  }
  try {
    const fromAddr = extractAddr(fromHeader);
    // Prefer the configured sending domain; fall back to the From address's
    // domain so the console link is still sensible if BASE_DOMAIN is unset.
    const baseDomain = env.BASE_DOMAIN || fromAddr.slice(fromAddr.indexOf('@') + 1);
    const consoleUrl = `https://console.${baseDomain}`;
    const isSuper = role === 'super_admin';
    const roleLabel = isSuper ? 'Super administrator' : 'Administrator';
    let subject: string;
    let text: string;
    let html: string;
    if (event === 'added') {
      const access = isSuper
        ? 'You have full access to the console, including all newsletters, user management and settings.'
        : 'You can manage subscribers, authors and campaigns for the newsletters you have been assigned to.';
      subject = 'You have been added to the Newsletter admin console';
      text =
        `Hello,\n\n` +
        `You have been granted access to the Newsletter admin console as: ${roleLabel}.\n\n` +
        `${access}\n\n` +
        `Sign in here: ${consoleUrl}\n` +
        `Access is via your organisation single sign-on at the link above.\n\n` +
        `If you were not expecting this, please contact the sender of this email.\n`;
      html =
        `<p>Hello,</p>` +
        `<p>You have been granted access to the <strong>Newsletter admin console</strong> as: <strong>${roleLabel}</strong>.</p>` +
        `<p>${access}</p>` +
        `<p><a href="${consoleUrl}">Sign in to the console</a> (via your organisation single sign-on).</p>` +
        `<p style="color:#64748b;font-size:12px">If you were not expecting this, please contact the sender of this email.</p>`;
    } else {
      subject = 'Your access to the Newsletter admin console has been removed';
      text =
        `Hello,\n\n` +
        `Your access to the Newsletter admin console (previously: ${roleLabel}) has been removed. ` +
        `You will no longer be able to sign in at ${consoleUrl}.\n\n` +
        `If you believe this is a mistake, please contact the sender of this email.\n`;
      html =
        `<p>Hello,</p>` +
        `<p>Your access to the <strong>Newsletter admin console</strong> (previously: <strong>${roleLabel}</strong>) has been removed. ` +
        `You will no longer be able to sign in at <a href="${consoleUrl}">${consoleUrl}</a>.</p>` +
        `<p style="color:#64748b;font-size:12px">If you believe this is a mistake, please contact the sender of this email.</p>`;
    }
    const raw = buildEmail({
      from: fromHeader,
      to: email,
      subject,
      messageId: `${crypto.randomUUID()}@${baseDomain}`,
      text,
      html,
      attachments: [],
    });
    await env.SEND_EMAIL.send(new EmailMessage(fromAddr, email, raw));
    return undefined;
  } catch (e) {
    return `Notification email to ${email} failed: ${(e as Error).message}`;
  }
}

async function serveMedia(req: Request, env: Env, url: URL): Promise<Response> {
  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!key || key.includes('..')) {
    return new Response('not found', { status: 404 });
  }
  const obj = await env.ASSETS_R2.get(key);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  // GUI media is small and rarely changes; let the browser cache it.
  headers.set('cache-control', 'public, max-age=3600');
  if (!headers.has('content-type')) {
    headers.set('content-type', guessContentType(key));
  }

  // Honour conditional requests so repeat loads are cheap.
  if (req.headers.get('if-none-match') === obj.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(obj.body, { headers });
}

function guessContentType(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    default:
      return 'application/octet-stream';
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

// Quote a CSV field if it contains a comma, quote, or newline (RFC 4180).
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Split a single CSV line into fields, honouring RFC-4180 double-quoting
// (quoted fields may contain commas; "" is an escaped quote).
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Parse a loose boolean ("true"/"1"/"yes"/"y" => true, everything else false).
function parseBool(value: string | undefined): boolean {
  return /^(true|1|yes|y)$/i.test((value ?? '').trim());
}
