import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, Setting } from '../api';

type FieldType = 'text' | 'number' | 'textarea' | 'boolean';

interface FieldMeta {
  key: string;
  label: string;
  help: string;
  type?: FieldType;
}

interface Section {
  title: string;
  description: string;
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
    id: 'sending',
    label: 'Sending',
    sections: [
  {
    title: 'Deployment & routing',
    description:
      'Identifiers the admin worker uses to keep Email Routing rules in sync. Changing these takes effect immediately for new newsletter operations.',
    fields: [
      { key: 'EMAIL_ROUTING_ZONE_ID', label: 'Email Routing zone ID', help: 'Used to auto-manage Email Routing rules (each newsletter\u2019s inbound address \u2192 ingest worker). If unset, add the routing rules manually.' },
      { key: 'INGEST_WORKER_NAME', label: 'Ingest worker name', help: 'Worker script that Email Routing rules forward inbound mail to.' },
      { key: 'BASE_DOMAIN', label: 'Base domain', help: 'Domain newsletters receive mail on (e.g. example.com). Used for inbound-address hints.' },
    ],
  },
  {
    title: 'Sending identity',
    description: 'How outbound mail is addressed and where engagement is tracked.',
    fields: [
      { key: 'BOUNCE_DOMAIN', label: 'Bounce domain', help: 'Domain used for VERP bounce return-path addresses (bounce+<id>@domain).' },
      { key: 'TRACKING_BASE_URL', label: 'Tracking base URL', help: 'Base URL of the tracker worker for opens, clicks, unsubscribe and downloads.' },
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
    label: 'Tracking',
    sections: [
  {
    title: 'Tracking',
    description:
      'Open and click tracking transforms outgoing HTML: every link is rewritten to a signed redirect through the tracker worker, and an invisible 1×1 pixel is appended to detect opens. Disable to send links unmodified and omit the pixel — opens and clicks will then not be recorded. Large-attachment download links are unaffected, since they deliver the files themselves.',
    fields: [
      { key: 'TRACKING_ENABLED', label: 'Open & click tracking', help: 'When on, links are rewritten through the tracker and an open pixel is added. When off, recipients get your original links and no pixel; the Analytics page will show no opens/clicks for new sends.', type: 'boolean' },
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
    description: 'IP/domain warmup caps applied by the consumer worker. Leave the start date empty to disable caps entirely.',
    fields: [
      { key: 'WARMUP_START_DATE', label: 'Warmup start date', help: 'YYYY-MM-DD. Empty disables all caps.' },
      { key: 'WARMUP_TARGET_WEEKLY', label: 'Target weekly volume', help: 'Steady-state weekly send ceiling once warmup completes.', type: 'number' },
      { key: 'WARMUP_SCHEDULE', label: 'Weekly schedule (JSON)', help: 'JSON array of weekly caps stepped through during warmup, e.g. [500, 1500, 5000].', type: 'textarea' },
      { key: 'WARMUP_DAILY_CAP_EARLY', label: 'Daily cap (early weeks)', help: 'Daily cap before the late-start week.', type: 'number' },
      { key: 'WARMUP_DAILY_CAP_LATE', label: 'Daily cap (late weeks)', help: 'Daily cap from the late-start week onward.', type: 'number' },
      { key: 'WARMUP_LATE_START_WEEK', label: 'Late-start week', help: 'Week index at which the late daily cap begins to apply.', type: 'number' },
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
  const [tab, setTab] = useState<string>(TABS[0]!.id);

  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  const query = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<{ settings: Setting[] }>('/api/settings'),
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
      api('/api/settings', { method: 'PUT', body: JSON.stringify({ updates }) }),
    onSuccess: async (_data, updates) => {
      const key = Object.keys(updates)[0] ?? null;
      setEditKey(null);
      setFieldError(null);
      setSavedKey(key);
      setTimeout(() => setSavedKey((k) => (k === key ? null : k)), 2500);
      await qc.invalidateQueries({ queryKey: ['settings'] });
      // Quota depends on warmup settings; refresh it too.
      await qc.invalidateQueries({ queryKey: ['quota'] });
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
    save.mutate({ [key]: draft });
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

      {activeTab.sections.map((section) => (
        <section
          key={section.title}
          className="border border-slate-200 rounded-lg dark:border-slate-700 overflow-hidden"
        >
          <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 dark:bg-slate-800/60 dark:border-slate-700">
            <h2 className="text-base font-medium">{section.title}</h2>
            <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{section.description}</p>
          </div>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.fields.map((f) => {
              const s = byKey.get(f.key);
              const editing = editKey === f.key;
              const shownValue = editing ? draft : effective(f.key);
              const bytes =
                f.type === 'number' && f.key.endsWith('_BYTES') ? formatBytes(shownValue) : null;
              const locked = !editing;
              const inputClass = `${inputCls}${f.type === 'textarea' ? ' font-mono' : ''} ${
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
                      {s && <SourceBadge source={s.source} editing={editing} />}
                    </label>
                    <p className="text-xs text-slate-500 mt-0.5 dark:text-slate-400">{f.help}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5 font-mono dark:text-slate-500">{f.key}</p>
                  </div>

                  <div className="min-w-0">
                    {f.type === 'boolean' ? (
                      <Toggle
                        checked={shownValue === 'true'}
                        disabled={save.isPending || editKey !== null}
                        onChange={(next) => save.mutate({ [f.key]: next ? 'true' : 'false' })}
                      />
                    ) : f.type === 'textarea' ? (
                      <textarea
                        id={f.key}
                        rows={2}
                        value={shownValue}
                        readOnly={locked}
                        onChange={(e) => setDraft(e.target.value)}
                        className={inputClass}
                      />
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
                      {s && s.source === 'db' && f.type !== 'boolean' && (
                        <span>overrides default “{s.fallback || '∅'}”</span>
                      )}
                      {(editing || f.type === 'boolean') && fieldError && (
                        <span className="text-red-600">{fieldError}</span>
                      )}
                      {savedKey === f.key && (
                        <span className="text-emerald-600 dark:text-emerald-400">Saved.</span>
                      )}
                    </div>
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
                        {s && s.source === 'db' && (
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
