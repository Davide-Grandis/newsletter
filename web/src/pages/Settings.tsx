import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Setting } from '../api';
import SuperAdmins from './SuperAdmins';
import { localPart, LocalPartInput } from './Newsletters';

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
  // Display-only: hides Edit and Reset buttons so the value cannot be changed
  // from the UI. Useful for limits derived from platform constraints.
  readOnly?: boolean;
  // Show as [local-part][@domain] split input; domain is taken from the BASE_DOMAIN setting.
  splitAt?: boolean;
  // Show as [https://][subdomain][.domain] split input; domain is taken from BASE_DOMAIN.
  splitUrl?: boolean;
  // Placeholder shown inside the variable part of a splitUrl input.
  placeholder?: string;
  // Show DEFAULT badge when source is default, but hide the OVERRIDDEN badge, override text, and Reset.
  hideOverride?: boolean;
  // When set to another setting key, the Edit button is disabled when that key's effective value is 'false'.
  enabledBy?: string;
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
  topContent?: React.ReactNode;
  sections: Section[];
}

// Client-side presentation metadata. The server's allow-list (shared/settings.ts)
// remains the source of truth for which keys are valid and how they're validated.
// Sections are grouped into a small number of tabs to keep the page scannable.
const TABS: Tab[] = [
  {
    id: 'login',
    label: 'Account details',
    sections: [
  {
    title: 'Console access',
    description:
      'Access to this application is enforced by Cloudflare Access at the edge.',
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
  {
    title: 'Sending identity',
    description:
      'The domain and address used for all outgoing emails.',
    fields: [
      { key: 'BASE_DOMAIN', label: 'Sending domain', help: 'The Cloudflare domain name for the Email Sending service. It represents the domain for used for sending and receiving emails.', hideKey: true, hideSource: true, optionsFrom: 'sending-domains' },
      { key: 'FROM_ADDRESS', label: 'Sender address', help: 'The From: address used for outgoing emails (console notifications and newsletters without a per-newsletter sender). Must be a local part on the sending domain above.', hideKey: true, hideSource: true, splitAt: true },
    ],
  },
    ],
  },
  {
    // Super admins management and admin permission.
    id: 'users',
    label: 'Users',
    topContent: (
      <div className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden">
        <SuperAdmins />
      </div>
    ),
    sections: [
  {
    title: 'Admin permissions',
    description:
      'Optional permission for newsletter admins (with edit capability) to be able to also create and delete newsletters. Off by default; only super admins can create and delete newsletters.',
    fields: [
      { key: 'ALLOW_ADMIN_NEWSLETTER_CRUD', label: 'Admins can create/delete newsletters', help: 'When on, edit-capable admins, in addition to super admins, may create and delete newsletters they are assigned to.', type: 'boolean', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'attachments',
    label: 'Email ingestion',
    sections: [
  {
    title: 'Ingest worker',
    description: 'Worker script that Email Routing rules forward inbound mail to.',
    fields: [
      { key: 'INGEST_WORKER_NAME', label: 'Ingest worker name', help: 'Worker script that Email Routing rules forward inbound mail to. Pick from the Workers in this account.', hideKey: true, hideSource: true, optionsFrom: 'workers' },
    ],
  },
  {
    title: 'Max message size',
    description: 'Fan-out and message-size guards used by the ingest and consumer workers.',
    fields: [
      { key: 'MAX_RAW_BYTES', label: 'Max raw message (bytes)', help: 'Hard cap on the fully assembled MIME message sent via Cloudflare Email Sending. Set to the platform\u2019s 5 MiB limit. Emails exceeding this are rejected at ingest with an SMTP 5xx.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
    ],
  },
  {
    title: 'Attachments',
    description: 'Limits enforced by the ingest worker when a campaign email arrives. Link mode: when total attachment size exceeds the threshold below, attachments are stored in R2 and replaced with signed download links in the email body instead of being embedded — keeping the message within the Cloudflare Email Sending 5 MiB limit. Exceeding any other limit causes the email to be rejected with an SMTP 5xx back to the author and the campaign is never created.',
    fields: [
      { key: 'MAX_ATTACHMENT_BYTES', label: 'Max attachment size (bytes)', help: 'Maximum size of a single attachment. Files above this are rejected at ingest.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'MAX_TOTAL_ATTACHMENT_BYTES', label: 'Max total attachment size (bytes)', help: 'Maximum combined size of all attachments per campaign. This caps R2 storage per campaign; in link mode, attachments are stored in R2 and served as download links, so they do not count toward the 5 MiB email limit.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'MAX_ATTACHMENT_COUNT', label: 'Max attachment count', help: 'Maximum number of attachments per campaign. Campaigns with more files are rejected at ingest.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
      { key: 'ALLOWED_MIME', label: 'Allowed MIME types', help: 'Comma-separated allow-list of permitted MIME types. Globs supported (e.g. image/*). Attachments with a type not on this list are rejected.', readOnly: true, hideKey: true, hideSource: true },
      { key: 'BLOCKED_EXTENSIONS', label: 'Blocked extensions', help: 'Comma-separated file extensions always rejected regardless of MIME type (e.g. exe, js, bat). Checked after the MIME allow-list.', readOnly: true, hideKey: true, hideSource: true },
      { key: 'ATTACHMENT_LINK_THRESHOLD_BYTES', label: 'Link-mode threshold (bytes)', help: 'When total attachment size exceeds this, link mode activates: all attachments are stored in R2 and replaced with signed download links in the email body. This keeps the assembled message well within the Cloudflare Email Sending 5 MiB limit.', type: 'number', readOnly: true, hideKey: true, hideSource: true },
    ],
  },
    ],
  },
  {
    id: 'footer',
    label: 'Email footer',
    sections: [
  {
    title: 'Default footer (template)',
    description:
      'Appended to every outgoing email unless a newsletter defines its own footer (set on the newsletter’s page). The HTML is sanitized to a safe allow-list when saved.',
    note:
      'Tokens you can use: {{unsubscribe_url}}, {{newsletter_name}}, {{email}}. An unsubscribe link is always included even if you omit the token.',
    fields: [
      { key: 'DEFAULT_FOOTER_HTML', label: 'HTML footer', help: 'HTML appended to the end of every email body.', type: 'textarea', hideKey: true, rows: 6, compact: true },
      { key: 'DEFAULT_FOOTER_TEXT', label: 'Plain-text footer', help: 'Footer appended to the plain-text part of every email.', type: 'textarea', hideKey: true, rows: 6, compact: true },
    ],
  },
    ],
  },
  {
    id: 'tracking',
    label: 'Tracking & bounce',
    sections: [
  {
    title: 'Tracking',
    description:
      'Tracking transforms outgoing HTML. Disable to send the emails unmodified, no tracking analytics will be available.',
    fields: [
      { key: 'TRACKING_ENABLED', label: 'Open & click tracking', help: 'When on, links are rewritten through the tracker and an open pixel is added.', type: 'boolean', hideKey: true, hideOverride: true },
      { key: 'TRACKING_BASE_URL', label: 'Tracking base URL', help: 'Base URL of the tracker worker for opens, clicks, unsubscribe and downloads.', hideKey: true, hideSource: true, splitUrl: true, placeholder: 'track' },
    ],
  },
  {
    title: 'Bounce handling',
    description: 'When the bounce worker marks a subscriber as bounced.',
    fields: [
      { key: 'HARD_BOUNCE_THRESHOLD', label: 'Hard bounce threshold', help: 'Hard bounces (permanent, e.g. mailbox not found) before a subscriber is disabled. 1 = disable on first hard bounce.', type: 'number', hideKey: true },
      { key: 'SOFT_BOUNCE_THRESHOLD', label: 'Soft bounce threshold', help: 'Soft bounces (transient, e.g. full mailbox) within the window before a subscriber is disabled.', type: 'number', hideKey: true },
      { key: 'SOFT_BOUNCE_WINDOW_DAYS', label: 'Soft bounce window (days)', help: 'Soft bounces older than this no longer count, so transient failures self-heal.', type: 'number', hideKey: true },
    ],
  },
    ],
  },
  {
    id: 'delivery',
    label: 'Subscribe',
    sections: [
  {
    title: 'Public signup',
    description:
      'Cloudflare Turnstile protects the public subscribe page (enabled per newsletter on its Signup tab) from bots. Create a Turnstile widget for this domain, paste its site key here, and set the matching secret on the tracker worker (wrangler secret put TURNSTILE_SECRET_KEY). Empty disables the public signup page.',
    fields: [
      { key: 'TURNSTILE_ENABLED', label: 'Turnstile bot protection', help: 'When on, the public signup form requires a Turnstile challenge. When off, the form is available without bot protection (site key and secret are not required).', type: 'boolean', hideKey: true, hideOverride: true },
      { key: 'TURNSTILE_SITE_KEY', label: 'Turnstile site key', help: 'Public site key of the Turnstile widget. The secret key is a tracker-worker secret, not a setting.', hideKey: true, hideSource: true, enabledBy: 'TURNSTILE_ENABLED' },
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
      { key: 'RETENTION_DAYS', label: 'Retention (days)', help: 'Days to keep campaigns, attachments and raw archives before permanent deletion. Lower values free storage sooner but make older attachment links and analytics unavailable.', type: 'number', hideKey: true },
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
  const allFields = TABS.flatMap((t) => t.sections.flatMap((s) => s.fields));
  const editFieldMeta = editKey ? allFields.find((f) => f.key === editKey) : null;
  const changed =
    editKey !== null &&
    draft !== (editFieldMeta?.splitAt
      ? localPart(effective(editKey))
      : editFieldMeta?.splitUrl
        ? urlSubdomain(effective(editKey), effective('BASE_DOMAIN'))
        : effective(editKey));

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
    const meta = allFields.find((f) => f.key === key);
    setDraft(meta?.splitAt
      ? localPart(effective(key))
      : meta?.splitUrl
        ? urlSubdomain(effective(key), effective('BASE_DOMAIN'))
        : effective(key));
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
    const meta = allFields.find((f) => f.key === key);
    const value = meta?.splitAt
      ? `${draft}@${effective('BASE_DOMAIN')}`
      : meta?.splitUrl
        ? `https://${draft}.${effective('BASE_DOMAIN')}`
        : draft;
    const fallback = byKey.get(key)?.fallback ?? '';
    save.mutate({ [key]: value === fallback && fallback !== '' ? null : value });
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
      </div>

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-6">
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


      {activeTab.topContent}

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
                <Fragment key={f.key}>
                <div
                  className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_6rem] gap-2 sm:gap-4 items-start"
                >
                  <div className="min-w-0">
                    <label htmlFor={f.key} className="text-sm font-medium flex items-center gap-2 flex-wrap">
                      {f.label}
                    </label>
                    <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{f.help}</p>
                    {!f.hideKey && (
                      <p className="text-[11px] text-slate-400 mt-0.5 font-mono dark:text-slate-500">{f.key}</p>
                    )}
                  </div>

                  <div className={f.type === 'boolean' ? 'sm:col-span-2 min-w-0' : 'min-w-0'}>
                    {f.type === 'boolean' ? (
                      <div className="flex items-center justify-end gap-3">
                        {!f.readOnly && s && s.source === 'db' && (
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
                        <Toggle
                          checked={shownValue === 'true'}
                          disabled={save.isPending || editKey !== null}
                          onChange={(next) => save.mutate({ [f.key]: next ? 'true' : 'false' })}
                        />
                        {s && !f.hideSource && (!f.hideOverride || s.source === 'default') && <SourceBadge source={s.source} editing={false} />}
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
                    ) : f.splitUrl ? (
                      <SubdomainInput
                        value={editing ? draft : urlSubdomain(shownValue, effective('BASE_DOMAIN'))}
                        onChange={setDraft}
                        domain={effective('BASE_DOMAIN')}
                        disabled={locked}
                        placeholder={f.placeholder}
                      />
                    ) : f.splitAt ? (
                      <LocalPartInput
                        value={editing ? draft : localPart(shownValue)}
                        onChange={setDraft}
                        domain={effective('BASE_DOMAIN')}
                        disabled={locked}
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
                      {s && !f.hideSource && f.type !== 'boolean' && (
                        <SourceBadge source={s.source} editing={editing} />
                      )}
                      {s && s.source === 'db' && f.type !== 'boolean' && !f.hideSource && !f.hideOverride && (
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
                    {f.key === 'DEFAULT_FOOTER_HTML' && (
                      <div className="mt-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400">Preview</span>
                        <iframe
                          title="Footer HTML preview"
                          sandbox=""
                          srcDoc={buildHtmlPreview(shownValue)}
                          className="mt-0.5 w-full h-[160px] border border-slate-200 rounded bg-white dark:border-slate-700"
                        />
                      </div>
                    )}
                    {f.key === 'DEFAULT_FOOTER_TEXT' && (
                      <div className="mt-2">
                        <span className="text-xs text-slate-500 dark:text-slate-400">Preview</span>
                        <pre className="mt-0.5 w-full h-[120px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
                          {buildPlainPreview(shownValue)}
                        </pre>
                      </div>
                    )}
                  </div>

                  {f.type !== 'boolean' && <div className="flex flex-col gap-1.5">
                    {f.readOnly ? null : editing ? (
                      <>
                        <button
                          type="button"
                          onClick={() => saveField(f.key)}
                          disabled={!changed || save.isPending}
                          className="w-full bg-slate-900 text-white text-xs rounded px-3 py-1.5 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                        >
                          {save.isPending ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={save.isPending}
                          className="w-full text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => startEdit(f.key)}
                          disabled={editKey !== null || (!!f.enabledBy && effective(f.enabledBy) === 'false')}
                          className="w-full text-xs rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          Edit
                        </button>
                        {s && s.source === 'db' && !f.readOnly && !f.hideSource && !f.hideOverride && (
                          <button
                            type="button"
                            onClick={() => resetField(f.key)}
                            disabled={editKey !== null || save.isPending}
                            title="Clear the override and revert to the default value"
                            className="w-full text-xs rounded px-3 py-1.5 text-slate-500 hover:text-red-600 disabled:opacity-40 dark:text-slate-400"
                          >
                            Reset
                          </button>
                        )}
                      </>
                    )}
                  </div>}
                </div>
                </Fragment>
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

// ---------------------------------------------------------------------------
// Footer preview helpers (mirror the consumer's token substitution so what
// operators see in Settings matches what subscribers receive).
// ---------------------------------------------------------------------------

const FOOTER_SAMPLE_VARS: Record<string, string> = {
  unsubscribe_url: 'https://track.example.com/u/123?t=sample-token',
  newsletter_name: 'Newsletter name',
  email: 'subscriber@example.com',
};
const FOOTER_TOKEN_RE = /\{\{\s*(unsubscribe_url|newsletter_name|email)\s*\}\}/g;

function buildHtmlPreview(template: string): string {
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => FOOTER_SAMPLE_VARS[k] ?? '');
  if (!hadUnsub) {
    body +=
      `\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0">` +
      `<a href="${FOOTER_SAMPLE_VARS.unsubscribe_url}" style="color:#64748b">Unsubscribe</a></p>`;
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;color:#0f172a;margin:12px;background:#fff}a{color:#2563eb}</style></head>` +
    `<body>${body}</body></html>`
  );
}

function buildPlainPreview(template: string): string {
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => FOOTER_SAMPLE_VARS[k] ?? '');
  if (!hadUnsub) body += `\nUnsubscribe: ${FOOTER_SAMPLE_VARS.unsubscribe_url}`;
  return body;
}

function urlSubdomain(url: string, domain: string): string {
  if (!url) return '';
  const withoutScheme = url.replace(/^https?:\/\//, '');
  const suffix = '.' + domain;
  if (domain && withoutScheme.endsWith(suffix)) return withoutScheme.slice(0, -suffix.length);
  return withoutScheme.split('.')[0] ?? '';
}

function SubdomainInput({
  value,
  onChange,
  domain,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  domain: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div
      className={`flex items-stretch rounded border overflow-hidden mt-0.5 ${
        disabled
          ? 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/40'
          : 'border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-800'
      }`}
    >
      <span className="flex items-center px-2 text-sm text-slate-400 bg-slate-50 border-r border-slate-200 select-none dark:bg-slate-800/60 dark:border-slate-700 dark:text-slate-500">
        https://
      </span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(/[/\s.]/g, '').trimStart())}
        className="flex-[3] min-w-0 px-2 py-1 text-sm bg-transparent text-slate-900 outline-none disabled:cursor-not-allowed disabled:text-slate-500 placeholder:text-slate-400 dark:text-slate-100 dark:disabled:text-slate-400 dark:placeholder:text-slate-600"
      />
      {domain && (
        <span className="flex-[4] min-w-0 flex items-center px-2 text-sm text-slate-400 bg-slate-50 border-l border-slate-200 select-none dark:bg-slate-800/60 dark:border-slate-700 dark:text-slate-500">
          .{domain}
        </span>
      )}
    </div>
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
