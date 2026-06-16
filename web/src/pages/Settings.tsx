import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Setting, EmailSendingStats } from '../api';
import { useIdentity } from '../auth';
import SuperAdmins from './SuperAdmins';

type FieldType = 'text' | 'number' | 'textarea' | 'boolean';

interface FieldMeta {
  key: string;
  label: string;
  help: string;
  type?: FieldType;
  // Hide the default/overridden/editing source badge (e.g. settings that have
  // no built-in default, like the Access IDs).
  hideSource?: boolean;
  // Render the source badge below the input instead of beside the label.
  sourceBelow?: boolean;
  // Populate the field from a dynamic option source (a pick-list) rather than
  // free text. 'sending-domains' = the account's Cloudflare zones (Email
  // Routing-enabled only); 'workers' = the account's Worker scripts.
  optionsFrom?: 'sending-domains' | 'workers';
  // Hide the raw setting key shown under the help text (user-facing settings
  // where the internal variable name is just noise).
  hideKey?: boolean;
  // Rows for a 'textarea' field (defaults to 2).
  rows?: number;
  // Render the input one step smaller (text-xs instead of text-sm).
  compact?: boolean;
}

interface Section {
  title: string;
  description: string;
  // Optional longer-form guidance rendered as a callout above the fields.
  // Newlines are preserved, so it can hold multi-step instructions.
  note?: string;
  fields: FieldMeta[];
}

interface Tab {
  id: string;
  label: string;
  sections: Section[];
}

// Client-side presentation metadata. The server's allow-list (shared/settings.ts)
// remains the source of truth for which keys are valid and how they're validated.
// Sections are grouped into a small number of tabs to keep the page scannable.
const TABS: Tab[] = [
  {
    id: 'access',
    label: 'Access',
    sections: [
  {
    title: 'Console access (Cloudflare Access)',
    description:
      'Who can sign in to this console is enforced by Cloudflare Access at the edge, using a Zero Trust Emails list.',
    note:
      'Required one-time setup in the Zero Trust dashboard (the worker never creates these; it only edits list membership):\n\n' +
      '1. Emails list — under My Team \u2192 Lists, create a list of type "Emails". The account that owns it is the Account ID below; the list\u2019s own ID is the List ID below. Do not edit its members by hand — the Users page drives them.\n\n' +
      '2. Access application — a self-hosted application protecting this console\u2019s hostname.\n\n' +
      '3. Access policy — on that application, a single policy with action Allow and exactly one Include rule of type "Emails list" pointing at the list above. No other rules are needed; membership is controlled entirely from the Users page.\n\n' +
      'API token — stored as the Worker secret CF_ZT_API_TOKEN (not shown here). Least privilege: Account \u2192 Zero Trust \u2192 Edit, restricted to this account only. It must be an account-owned token whose account matches the Account ID below.\n\n' +
      'The two parameters below are mandatory — please check them with your Cloudflare admin team.',
    fields: [
      { key: 'ACCESS_ACCOUNT_ID', label: 'Account ID', help: 'Cloudflare account that owns the Zero Trust Emails list (lists are account-scoped). Must match the account the CF_ZT_API_TOKEN secret is scoped to.', hideSource: true, hideKey: true },
      { key: 'ACCESS_LIST_ID', label: 'Emails list ID', help: 'ID of the Zero Trust "Emails" list referenced by the Access policy. The worker appends/removes member emails as console users are added or removed. Leave empty to disable automatic sync (you then maintain the list by hand).', hideSource: true, hideKey: true },
    ],
  },
    ],
  },
  {
    // Rendered by a dedicated component (no settings fields). See render below.
    id: 'superadmins',
    label: 'Super admins',
    sections: [],
  },
  {
    id: 'permissions',
    label: 'Admin permissions',
    sections: [
  {
    title: 'Admin permissions',
    description:
      'Optional permission for regular admins (super admins always have it). Off by default. Whether an admin can change things is otherwise controlled per-admin by their read-only/edit access, set on each newsletter\u2019s Admins tab.',
    fields: [
      { key: 'ALLOW_ADMIN_NEWSLETTER_CRUD', label: 'Admins can create/delete newsletters', help: 'When on, edit-capable admins (not just super admins) may create newsletters (they are auto-assigned to ones they create) and delete newsletters they are assigned to.', type: 'boolean', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'sending',
    label: 'Email sending',
    sections: [
  {
    title: 'Deployment & routing',
    description:
      'Identifiers the admin worker uses to keep Email Routing rules in sync. Changing these takes effect immediately for new newsletter operations.',
    note:
      'One-time setup: enable Email Routing “Subaddressing” for the sending domain in the Cloudflare dashboard (Compute → Email Service → Email Routing → Settings). It cannot be toggled via API. It lets the auto-created bounce@<domain> rule capture VERP bounce addresses (bounce+<id>@<domain>); without it, bounce handling will not work.',
    fields: [
      { key: 'BASE_DOMAIN', label: 'Sending domain', help: 'The Cloudflare domain name for the Email Sending service. It represents the domain for used for sending and receiving emails.', hideKey: true, hideSource: true, optionsFrom: 'sending-domains' },
      { key: 'INGEST_WORKER_NAME', label: 'Ingest worker name', help: 'Worker script that Email Routing rules forward inbound mail to. Pick from the Workers in this account.', hideKey: true, sourceBelow: true, optionsFrom: 'workers' },
    ],
  },
  {
    title: 'Default footer',
    description:
      'Appended to every outgoing email unless a newsletter defines its own footer (set on the newsletter\u2019s page). The HTML is sanitized to a safe allow-list when saved.',
    note:
      'Tokens you can use: {{unsubscribe_url}}, {{newsletter_name}}, {{email}}. An unsubscribe link is always included even if you omit the token.',
    fields: [
      { key: 'DEFAULT_FOOTER_HTML', label: 'HTML footer', help: 'HTML appended to the end of every email body (after tracking instrumentation, so its links are not click-tracked).', type: 'textarea', hideKey: true, rows: 6, compact: true },
      { key: 'DEFAULT_FOOTER_TEXT', label: 'Plain-text footer', help: 'Footer appended to the plain-text part of every email.', type: 'textarea', hideKey: true, rows: 6, compact: true },
    ],
  },
    ],
  },
  {
    id: 'attachments',
    label: 'Attachments',
    sections: [
  {
    title: 'Attachments',
    description: 'Limits enforced by the ingest worker when a campaign email arrives.',
    fields: [
      { key: 'MAX_ATTACHMENT_BYTES', label: 'Max attachment size (bytes)', help: 'Maximum size of a single attachment.', type: 'number' },
      { key: 'MAX_TOTAL_ATTACHMENT_BYTES', label: 'Max total size (bytes)', help: 'Maximum combined attachment size per campaign.', type: 'number' },
      { key: 'MAX_ATTACHMENT_COUNT', label: 'Max attachment count', help: 'Maximum number of attachments per campaign.', type: 'number' },
      { key: 'ALLOWED_MIME', label: 'Allowed MIME types', help: 'Comma-separated allow-list. Globs allowed, e.g. image/*.' },
      { key: 'BLOCKED_EXTENSIONS', label: 'Blocked extensions', help: 'Comma-separated file extensions to reject (without dots).' },
      { key: 'ATTACHMENT_LINK_THRESHOLD_BYTES', label: 'Link-mode threshold (bytes)', help: 'Above this combined size, attachments are sent as signed download links instead of being attached.', type: 'number' },
    ],
  },
  {
    title: 'Batching & size limits',
    description: 'Fan-out and message-size guards used by the ingest and consumer workers.',
    fields: [
      { key: 'BATCH_SIZE', label: 'Queue batch size', help: 'Number of subscribers per queue message.', type: 'number' },
      { key: 'MAX_RAW_BYTES', label: 'Max raw message (bytes)', help: 'Hard cap on a fully built MIME message before sending.', type: 'number' },
    ],
  },
    ],
  },
  {
    id: 'tracking',
    label: 'Tracking & signup',
    sections: [
  {
    title: 'Tracking',
    description:
      'Open and click tracking transforms outgoing HTML: every link is rewritten to a signed redirect through the tracker worker, and an invisible 1×1 pixel is appended to detect opens. Disable to send links unmodified and omit the pixel — opens and clicks will then not be recorded. Large-attachment download links are unaffected, since they deliver the files themselves.',
    fields: [
      { key: 'TRACKING_ENABLED', label: 'Open & click tracking', help: 'When on, links are rewritten through the tracker and an open pixel is added. When off, recipients get your original links and no pixel; the Analytics page will show no opens/clicks for new sends.', type: 'boolean' },
      { key: 'TRACKING_BASE_URL', label: 'Tracking base URL', help: 'Base URL of the tracker worker for opens, clicks, unsubscribe and downloads.', hideKey: true },
    ],
  },
  {
    title: 'Public signup',
    description:
      'Cloudflare Turnstile protects the public subscribe page (enabled per newsletter on its Signup tab) from bots. Create a Turnstile widget for this domain, paste its site key here, and set the matching secret on the tracker worker (wrangler secret put TURNSTILE_SECRET_KEY). Empty disables the public signup page.',
    fields: [
      { key: 'TURNSTILE_SITE_KEY', label: 'Turnstile site key', help: 'Public site key of the Turnstile widget. The secret key is a tracker-worker secret, not a setting.', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'delivery',
    label: 'Delivery',
    sections: [
  {
    title: 'Bounce handling',
    description: 'When the bounce worker marks a subscriber as bounced.',
    fields: [
      { key: 'HARD_BOUNCE_THRESHOLD', label: 'Hard bounce threshold', help: 'Hard bounces before a subscriber is marked bounced.', type: 'number' },
      { key: 'SOFT_BOUNCE_THRESHOLD', label: 'Soft bounce threshold', help: 'Soft bounces before a subscriber is marked bounced.', type: 'number' },
    ],
  },
  {
    title: 'Warmup',
    description:
      'IP/domain warmup is always on and demand-driven (no start date). The sender enters week 0 the first time there are more than 499 emails to send, then advances one weekly step at a time, only when the backlog grows to the next step. The daily cap is read live from the Cloudflare API; the values below are informative and shown under "Sending usage" above.',
    fields: [
      { key: 'WARMUP_TARGET_WEEKLY', label: 'Target weekly volume', help: 'Steady-state weekly send ceiling once the schedule is exhausted.', type: 'number' },
      { key: 'WARMUP_SCHEDULE', label: 'Weekly schedule (JSON)', help: 'JSON array of weekly caps stepped through during warmup, e.g. [500, 1500, 5000, 12000, 25000, 40000]. Each value is also the demand threshold to enter that week.', type: 'textarea' },
      { key: 'WARMUP_FALLBACK_DAILY_CAP', label: 'Fallback daily cap', help: 'Daily cap used only when the live Cloudflare daily quota cannot be read.', type: 'number' },
    ],
  },
    ],
  },
  {
    id: 'retention',
    label: 'Retention',
    sections: [
  {
    title: 'Retention',
    description:
      'A daily cron permanently deletes campaigns older than this, together with their stored attachments and archived raw email (from R2) and their send/engagement history (from the database). After deletion the data is gone: attachment download links return \u201cnot found\u201d, the campaign disappears from Analytics, and open/click redirects no longer record anything (the click redirect itself still forwards to the destination).',
    fields: [
      { key: 'RETENTION_DAYS', label: 'Retention (days)', help: 'Days to keep campaigns, attachments and raw archives before permanent deletion. Lower values free storage sooner but make older attachment links and analytics unavailable.', type: 'number' },
    ],
  },
    ],
  },
];

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100';

function formatBytes(v: string): string | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1024) return null;
  const mb = n / (1024 * 1024);
  if (mb >= 1) return `≈ ${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `≈ ${(n / 1024).toFixed(0)} KB`;
}

export default function Settings() {
  const qc = useQueryClient();
  // The single field currently unlocked for editing (one at a time keeps the
  // surface for accidental changes minimal). `draft` is its working value.
  const [editKey, setEditKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  // Best-effort warning returned after saving the sending domain (e.g. the
  // bounce Email Routing rule could not be created automatically).
  const [saveWarn, setSaveWarn] = useState<string | null>(null);
  const [tab, setTab] = useState<string>(TABS[0]!.id);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const me = useIdentity();
  const isSuper = me.data?.role === 'super_admin';

  // Real Email Sending usage for the configured Sending domain, read live from
  // Cloudflare (daily quota + emails sent). Only fetched on the Email sending
  // tab; super-admin only (the endpoint is gated too).
  const sending = useQuery({
    queryKey: ['email-sending-stats'],
    queryFn: () => api<EmailSendingStats>('/api/email-sending-stats'),
    enabled: isSuper && activeTab.id === 'sending',
    staleTime: 60_000,
  });

  const query = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Setting[] }>('/api/settings'),
  });

  // Account domains (Cloudflare zones) backing the sending-domain pick-list,
  // each annotated with its Email Routing status when the read token allows it.
  const domains = useQuery({
    queryKey: ['sending-domains'],
    queryFn: () =>
      api<{
        items: { name: string; routing: 'enabled' | 'disabled' | 'unknown' }[];
        error?: string;
        routing_checkable?: boolean;
      }>('/api/sending-domains'),
    staleTime: 5 * 60_000,
  });

  // Account Worker scripts backing the ingest-worker pick-list.
  const workers = useQuery({
    queryKey: ['account-workers'],
    queryFn: () => api<{ items: string[]; error?: string }>('/api/workers'),
    staleTime: 5 * 60_000,
  });

  // Effective values keyed by setting key, from the server.
  const byKey = useMemo(() => {
    const m = new Map<string, Setting>();
    for (const s of query.data?.settings ?? []) m.set(s.key, s);
    return m;
  }, [query.data]);

  const effective = (key: string) => byKey.get(key)?.value ?? '';
  const changed = editKey !== null && draft !== effective(editKey);

  const save = useMutation({
    mutationFn: (updates: Record<string, string | null>) =>
      api<{ routing_warning?: string }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ updates }),
      }),
    onSuccess: async (data, updates) => {
      const key = Object.keys(updates)[0] ?? null;
      setEditKey(null);
      setFieldError(null);
      setSavedKey(key);
      // Domain-level bounce-rule sync warning (best-effort), if any.
      setSaveWarn(data?.routing_warning ?? null);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2500);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      // Warmup display depends on these settings; refresh it too.
      await qc.invalidateQueries({ queryKey: ['email-sending-stats'] });
    },
    onError: (e, updates) => {
      const key = Object.keys(updates)[0] ?? '';
      const apiErr = e as ApiError;
      setFieldError(apiErr.details?.[key] ?? apiErr.message);
    },
  });

  function startEdit(key: string) {
    setEditKey(key);
    setDraft(effective(key));
    setFieldError(null);
    setSavedKey(null);
  }

  function cancelEdit() {
    setEditKey(null);
    setFieldError(null);
  }

  function saveField(key: string) {
    if (!changed) return cancelEdit();
    // Selecting/typing the built-in default is not an override: clear the stored
    // value (same as Reset) so the source reverts to “default” instead of “db”.
    const fallback = byKey.get(key)?.fallback ?? '';
    save.mutate({ [key]: draft === fallback && fallback !== '' ? null : draft });
  }

  function resetField(key: string) {
    // Clear the stored override; value reverts to env/default.
    setFieldError(null);
    save.mutate({ [key]: null });
  }

  if (query.isLoading) return <div className="text-sm text-slate-500">Loading settings…</div>;
  if (query.error)
    return <div className="text-sm text-red-600">{(query.error as Error).message}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500 mt-2 dark:text-slate-400 max-w-3xl">
          Global runtime configuration.
          <br />
          Saved values are stored in the database and override the built-in default located in{' '}
          <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">shared/settings.ts</code>.
        </p>
      </div>

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={t.id === activeTab.id}
            onClick={() => {
              cancelEdit();
              setTab(t.id);
            }}
          >
            {t.label}
          </TabButton>
        ))}
      </div>

      {activeTab.id === 'superadmins' && <SuperAdmins />}

      {saveWarn && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-900/20 dark:text-amber-200">
          <span className="flex-1">{saveWarn}</span>
          <button
            type="button"
            onClick={() => setSaveWarn(null)}
            className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {activeTab.id === 'sending' && <EmailSendingUsage q={sending} />}

      {activeTab.sections.map((section) => (
        <section
          key={section.title}
          className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden"
        >
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
            <h2 className="text-base font-medium">{section.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{section.description}</p>
            {section.note && (
              <div className="mt-2 rounded border border-sky-200 bg-sky-50 p-2.5 text-xs leading-relaxed text-sky-900 whitespace-pre-line dark:border-sky-900/60 dark:bg-sky-900/20 dark:text-sky-200">
                {section.note}
              </div>
            )}
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.fields.map((f) => {
              const s = byKey.get(f.key);
              const editing = editKey === f.key;
              const shownValue = editing ? draft : effective(f.key);
              const bytes =
                f.type === 'number' && f.key.endsWith('_BYTES') ? formatBytes(shownValue) : null;
              const locked = !editing;
              const inputClass = `${f.compact ? inputCls.replace('text-sm', 'text-xs') : inputCls}${
                f.type === 'textarea' ? ' font-mono' : ''
              } ${
                locked
                  ? 'bg-slate-50 text-slate-500 cursor-not-allowed dark:bg-slate-800/40 dark:text-slate-400'
                  : ''
              }`;
              return (
                <div
                  key={f.key}
                  className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-2 sm:gap-4 items-start"
                >
                  <div className="min-w-0">
                    <label htmlFor={f.key} className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {f.label}
                      {/* Booleans show the badge beside their value instead; some
                          fields (no default) hide it entirely. */}
                      {s && !f.hideSource && !f.sourceBelow && f.type !== 'boolean' && (
                        <SourceBadge source={s.source} editing={editing} />
                      )}
                    </label>
                    <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{f.help}</p>
                    {!f.hideKey && (
                      <p className="text-[11px] text-slate-400 mt-0.5 font-mono dark:text-slate-500">{f.key}</p>
                    )}
                  </div>

                  <div className="min-w-0">
                    {f.type === 'boolean' ? (
                      <div className="flex items-center gap-2">
                        <Toggle
                          checked={shownValue === 'true'}
                          disabled={save.isPending || editKey !== null}
                          onChange={(next) => save.mutate({ [f.key]: next ? 'true' : 'false' })}
                        />
                        {s && !f.hideSource && <SourceBadge source={s.source} editing={false} />}
                      </div>
                    ) : f.type === 'textarea' ? (
                      <textarea
                        id={f.key}
                        rows={f.rows ?? 2}
                        value={shownValue}
                        readOnly={locked}
                        onChange={(e) => setDraft(e.target.value)}
                        className={inputClass}
                      />
                    ) : f.optionsFrom ? (
                      locked ? (
                        // When not editing, show the value as a read-only input so
                        // it matches every other setting (same font colour); a
                        // disabled <select> would render washed-out.
                        <input
                          id={f.key}
                          type="text"
                          value={shownValue}
                          readOnly
                          className={inputClass}
                        />
                      ) : (
                        (() => {
                          const isDomains = f.optionsFrom === 'sending-domains';
                          // Domains: only Email Routing-enabled zones. Workers: all
                          // account Worker scripts.
                          const names = isDomains
                            ? (domains.data?.items ?? [])
                                .filter((i) => i.routing === 'enabled')
                                .map((i) => i.name)
                            : workers.data?.items ?? [];
                          return (
                            <select
                              id={f.key}
                              value={shownValue}
                              onChange={(e) => {
                                setDraft(e.target.value);
                                setFieldError(null);
                              }}
                              className={inputClass}
                            >
                              {/* Domains use an unselectable placeholder for the
                                  not-yet-set case; workers always have a value. */}
                              {isDomains && (
                                <option value="" disabled>
                                  Select a domain…
                                </option>
                              )}
                              {names.map((n) => (
                                <option key={n} value={n}>
                                  {n}
                                </option>
                              ))}
                              {/* Keep the current value selectable if it isn't in the
                                  fetched list (still loading, or no longer present). */}
                              {shownValue !== '' && !names.includes(shownValue) && (
                                <option value={shownValue}>{shownValue}</option>
                              )}
                            </select>
                          );
                        })()
                      )
                    ) : (
                      <input
                        id={f.key}
                        type={f.type === 'number' ? 'number' : 'text'}
                        value={shownValue}
                        readOnly={locked}
                        onChange={(e) => setDraft(e.target.value)}
                        className={inputClass}
                      />
                    )}
                    <div className="flex items-center gap-3 mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                      {bytes && <span>{bytes}</span>}
                      {s && !f.hideSource && f.sourceBelow && f.type !== 'boolean' && (
                        <SourceBadge source={s.source} editing={editing} />
                      )}
                      {s && s.source === 'db' && f.type !== 'boolean' && !f.hideSource && (
                        <span>overrides default “{s.fallback || '∅'}”</span>
                      )}
                      {(editing || f.type === 'boolean') && fieldError && (
                        <span className="text-red-600">{fieldError}</span>
                      )}
                      {savedKey === f.key && (
                        <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>
                      )}
                    </div>
                    {editing &&
                      f.optionsFrom &&
                      (() => {
                        const loading =
                          f.optionsFrom === 'sending-domains' ? domains.isLoading : workers.isLoading;
                        if (loading) {
                          return (
                            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                              {f.optionsFrom === 'workers' ? 'Loading workers…' : 'Loading domains…'}
                            </p>
                          );
                        }
                        let msg: string | null = null;
                        if (f.optionsFrom === 'sending-domains') {
                          const enabled = (domains.data?.items ?? []).filter(
                            (i) => i.routing === 'enabled',
                          );
                          if (enabled.length === 0) {
                            msg = domains.data?.error
                              ? `Couldn’t load domains: ${domains.data.error}.`
                              : domains.data?.routing_checkable === false
                                ? 'Couldn’t read Email Routing status — the read API token needs account “Read all resources” scope.'
                                : 'No domains have Email Routing enabled. Enable Email Routing on a domain in the Cloudflare dashboard, then reopen this field.';
                          }
                        } else {
                          const items = workers.data?.items ?? [];
                          if (items.length === 0) {
                            msg = workers.data?.error
                              ? `Couldn’t load workers: ${workers.data.error}.`
                              : 'No Workers found in this account.';
                          }
                        }
                        return msg ? (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-red-600 dark:text-red-400">
                            {msg}
                          </p>
                        ) : null;
                      })()}
                  </div>

                  <div className="flex items-center gap-2 justify-start sm:justify-end">
                    {f.type === 'boolean' ? (
                      s && s.source === 'db' && (
                        <button
                          type="button"
                          onClick={() => resetField(f.key)}
                          disabled={editKey !== null || save.isPending}
                          title="Clear the override and revert to the default value"
                          className="text-xs rounded px-3 py-1.5 text-slate-500 hover:text-red-600 disabled:opacity-40 dark:text-slate-400"
                        >
                          Reset
                        </button>
                      )
                    ) : editing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveField(f.key)}
                          disabled={!changed || save.isPending}
                          className="bg-slate-900 text-white text-xs rounded px-3 py-1.5 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                        >
                          {save.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={save.isPending}
                          className="text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(f.key)}
                          disabled={editKey !== null}
                          className="text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        {s && s.source === 'db' && !f.hideSource && (
                          <button
                            type="button"
                            onClick={() => resetField(f.key)}
                            disabled={editKey !== null || save.isPending}
                            title="Clear the override and revert to the default value"
                            className="text-xs rounded px-3 py-1.5 text-slate-500 hover:text-red-600 disabled:opacity-40 dark:text-slate-400"
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm -mb-px border-b-2 ${
        active
          ? 'border-slate-900 text-slate-900 font-medium dark:border-slate-100 dark:text-slate-100'
          : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
      }`}
    >
      {children}
    </button>
  );
}

// Live Email Sending usage for the configured Sending domain, read from
// Cloudflare: the account daily quota and the emails sent (last 30 days, this
// zone). Read-only; degrades gracefully when a token scope or the domain is
// missing.
function EmailSendingUsage({
  q,
}: {
  q: {
    data?: EmailSendingStats;
    isLoading: boolean;
    isFetching: boolean;
    error: unknown;
    refetch: () => void;
  };
}) {
  const s = q.data;
  return (
    <section className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between dark:bg-slate-800/60 dark:border-slate-700">
        <div>
          <h2 className="text-base font-medium">Sending usage</h2>
          <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">
            Live from Cloudflare for the Sending domain
            {s?.domain ? (
              <>
                {' '}
                (<code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{s.domain}</code>)
              </>
            ) : null}
            .
          </p>
        </div>
        <button
          type="button"
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {q.isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      <div className="p-4">
        {q.isLoading ? (
          <div className="text-sm text-slate-500 dark:text-slate-400">Loading usage…</div>
        ) : q.error ? (
          <div className="text-sm text-red-600">{(q.error as Error).message}</div>
        ) : !s ? null : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <UsageStat
                label="Daily sending quota"
                value={s.quota ? s.quota.value.toLocaleString() : '—'}
                sub={
                  s.quota
                    ? `emails per ${s.quota.unit} (live from API)`
                    : s.quota_error
                      ? 'unavailable'
                      : 'not yet assigned by Cloudflare'
                }
              />
              <UsageStat
                label="Emails sent (last 30 days)"
                value={s.total.toLocaleString()}
                sub={
                  s.stats_error
                    ? 'unavailable'
                    : `${s.today.toLocaleString()} today · ${s.windowStart ?? ''} → ${s.windowEnd ?? ''}`
                }
              />
              <UsageStat
                label="Warmup week"
                value={s.warmup.started ? `Week ${s.warmup.level}` : 'Not started'}
                sub={
                  s.warmup.started
                    ? `weekly cap ${s.warmup.weeklyCap.toLocaleString()} · ${s.warmup.sentThisWeek.toLocaleString()} sent this week`
                    : `starts when demand > 499 · backlog ${s.warmup.demand.toLocaleString()}`
                }
              />
            </div>

            <WarmupProgression w={s.warmup} apiDailyCap={s.quota?.value ?? null} />

            {(s.quota_error || s.stats_error) && (
              <div className="mt-3 text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                {s.stats_error && <div>Sent counts unavailable: {s.stats_error}</div>}
                {s.quota_error && <div>Quota unavailable: {s.quota_error}</div>}
                <div className="text-slate-400 dark:text-slate-500">
                  The read token (CF_READ_API_TOKEN) needs <strong>Analytics: Read</strong> for the
                  sent counts and an account <strong>Email</strong> read scope for the quota.
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function UsageStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 dark:bg-slate-900 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-2xl font-semibold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 dark:text-slate-500">{sub}</div>}
    </div>
  );
}

// Read-only view of the demand-driven warmup ramp: each weekly step, the live
// daily cap from the API, and a marker on the week the sender is currently in.
function WarmupProgression({
  w,
  apiDailyCap,
}: {
  w: EmailSendingStats['warmup'];
  apiDailyCap: number | null;
}) {
  // Rows: each scheduled week, then the steady-state row (level === schedule
  // length). The current row is highlighted.
  const rows = [
    ...w.schedule.map((cap, i) => ({ week: i, cap, steady: false })),
    { week: w.schedule.length, cap: w.targetWeekly, steady: true },
  ];
  const dailyText = apiDailyCap != null ? apiDailyCap.toLocaleString() : '—';
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between mb-1.5">
        <h3 className="text-sm font-medium">Weekly progression</h3>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          Backlog to send: <strong className="tabular-nums">{w.demand.toLocaleString()}</strong>
        </span>
      </div>
      <div className="bg-white border border-slate-200 rounded overflow-hidden dark:bg-slate-900 dark:border-slate-800">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
            <tr>
              <th className="text-left p-2 w-10"></th>
              <th className="text-left p-2">Week</th>
              <th className="text-right p-2">Weekly cap</th>
              <th className="text-right p-2">Daily cap (API)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const current = w.started && w.level === r.week;
              return (
                <tr
                  key={r.week}
                  className={`border-t border-slate-100 dark:border-slate-800 ${
                    current ? 'bg-orange-50 dark:bg-orange-500/10' : ''
                  }`}
                >
                  <td className="p-2">
                    {current && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                        Now
                      </span>
                    )}
                  </td>
                  <td className="p-2">
                    Week {r.week}
                    {r.steady && <span className="text-slate-400 dark:text-slate-500"> + (steady)</span>}
                  </td>
                  <td className="p-2 text-right tabular-nums">{r.cap.toLocaleString()}</td>
                  <td className="p-2 text-right tabular-nums">{dailyText}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-400 mt-1.5 dark:text-slate-500">
        Warmup advances one week at a time, and only when the backlog reaches the next week&rsquo;s
        cap. The effective send rate each day is the smaller of the weekly cap and the daily cap.
      </p>
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
        checked ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

function SourceBadge({ source, editing }: { source: Setting['source']; editing: boolean }) {
  if (editing) {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
        editing
      </span>
    );
  }
  if (source === 'db') {
    return (
      <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
        overridden
      </span>
    );
  }
  return (
    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300">
      default
    </span>
  );
}
