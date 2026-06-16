import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, Newsletter } from '../api';
import { useIdentity, canEditNewsletter } from '../auth';
import Subscribers from './Subscribers';
import Authors from './Authors';
import NewsletterAdmins from './NewsletterAdmins';
import { LocalPartInput, localPart } from './Newsletters';

type Tab = 'subscribers' | 'authors' | 'admins' | 'footer' | 'signup';

export default function NewsletterDetail() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('admins');
  const [warn, setWarn] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ['newsletter', id],
    queryFn: () => api<Newsletter>(`/api/newsletters/${id}`),
  });

  // Fixed sending domain + default sender come from the identity payload
  // (admins cannot read the super_admin-only settings endpoint). Deleting a
  // newsletter is gated like creation: super admins, or admins with the toggle.
  const me = useIdentity();
  const domain = me.data?.base_domain ?? '';
  const defaultSenderLocal = localPart(me.data?.from_address ?? '');
  // Read-only admins may view but not change the newsletter; super admins and
  // edit-admins may edit. Deleting also requires the create/delete toggle.
  const canEdit = canEditNewsletter(me.data, id);
  const canDelete = canEdit && (me.data?.role === 'super_admin' || !!me.data?.allow_admin_newsletter_crud);

  // Admin count for the tab label. Shares the same query key that
  // NewsletterAdmins invalidates on add/remove, so it updates immediately.
  const adminsList = useQuery({
    queryKey: ['newsletter-admins', id],
    queryFn: () => api<{ items: { email: string; capability: string }[] }>(`/api/newsletters/${id}/admins`),
    enabled: !!id,
  });
  const adminCount = adminsList.data?.items.length;

  const patch = useMutation({
    mutationFn: (
      body: Partial<
        Pick<Newsletter, 'name' | 'inbound_address' | 'from_address' | 'footer_html' | 'footer_text' | 'slug'>
      > & { enabled?: boolean; allow_public_signup?: boolean },
    ) => api<{ routing_warning?: string }>(`/api/newsletters/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (res) => {
      setWarn(res.routing_warning ?? null);
      qc.invalidateQueries({ queryKey: ['newsletter', id] });
      qc.invalidateQueries({ queryKey: ['newsletters'] });
    },
  });
  const saveSettings = (body: { name?: string; inbound_address?: string; from_address?: string | null }) =>
    patch.mutateAsync(body);
  const saveFooter = (body: { footer_html?: string | null; footer_text?: string | null }) =>
    patch.mutateAsync(body);
  const saveSignup = (body: { slug?: string; allow_public_signup?: boolean }) => patch.mutateAsync(body);

  const del = useMutation({
    mutationFn: () => api(`/api/newsletters/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['newsletters'] });
      navigate('/newsletters');
    },
    onError: (e) => setDelErr((e as Error).message),
  });

  if (detail.isLoading) return <div className="text-sm text-slate-500 dark:text-slate-400">Loading…</div>;
  if (detail.error) return <div className="text-sm text-red-600">{(detail.error as Error).message}</div>;
  if (!detail.data) return null;
  const n = detail.data;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/newsletters" className="text-sm text-slate-500 hover:underline dark:text-slate-400">← Newsletters</Link>
        <h1 className="text-xl font-semibold mt-1">{n.name}</h1>
      </div>

      {warn && (
        <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 dark:text-amber-300 dark:bg-amber-900/30 dark:border-amber-800/60">
          <span className="flex-1">{warn}</span>
          <button onClick={() => setWarn(null)} className="text-amber-600 hover:underline dark:text-amber-400">dismiss</button>
        </div>
      )}

      <Settings
        n={n}
        domain={domain}
        defaultSenderLocal={defaultSenderLocal}
        canEdit={canEdit}
        canDelete={canDelete}
        onSave={saveSettings}
        saving={patch.isPending}
        onDelete={() => {
          setDelErr(null);
          setConfirmDelete(true);
        }}
      />

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm bg-white rounded-lg shadow-lg p-5 dark:bg-slate-900 dark:border dark:border-slate-700">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">Delete newsletter?</h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              This permanently deletes <span className="font-medium">{n.name}</span>, its subscribers, authors and
              Email Routing rule. This cannot be undone.
            </p>
            {delErr && <p className="mt-2 text-sm text-red-600">{delErr}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => setConfirmDelete(false)}
                className="text-sm rounded px-3 py-1.5 border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={del.isPending}
                onClick={() => del.mutate()}
                className="text-sm rounded px-3 py-1.5 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
              >
                {del.isPending ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div>
        <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-4">
          <TabButton active={tab === 'admins'} onClick={() => setTab('admins')}>
            Admins {typeof adminCount === 'number' ? `(${adminCount})` : ''}
          </TabButton>
          <TabButton active={tab === 'authors'} onClick={() => setTab('authors')}>
            Authors {typeof n.author_count === 'number' ? `(${n.author_count})` : ''}
          </TabButton>
          <TabButton active={tab === 'subscribers'} onClick={() => setTab('subscribers')}>
            Subscribers {typeof n.subscriber_count === 'number' ? `(${n.subscriber_count})` : ''}
          </TabButton>
          <TabButton active={tab === 'footer'} onClick={() => setTab('footer')}>
            Footer
          </TabButton>
          <TabButton active={tab === 'signup'} onClick={() => setTab('signup')}>
            Signup
          </TabButton>
        </div>
        {tab === 'subscribers' ? (
          <Subscribers newsletterId={id} canEdit={canEdit} />
        ) : tab === 'authors' ? (
          <Authors newsletterId={id} canEdit={canEdit} />
        ) : tab === 'footer' ? (
          <FooterEditor
            n={n}
            canEdit={canEdit}
            onSave={saveFooter}
            saving={patch.isPending}
            defaultHtml={me.data?.default_footer_html ?? ''}
            defaultText={me.data?.default_footer_text ?? ''}
          />
        ) : tab === 'signup' ? (
          <SignupEditor
            n={n}
            canEdit={canEdit}
            onSave={saveSignup}
            saving={patch.isPending}
            subscribeBase={me.data?.tracking_base_url ?? ''}
          />
        ) : (
          <NewsletterAdmins newsletterId={id} canManage={canEdit} />
        )}
      </div>
    </div>
  );
}

function Settings({
  n,
  domain,
  defaultSenderLocal,
  canEdit,
  canDelete,
  onSave,
  saving,
  onDelete,
}: {
  n: Newsletter;
  domain: string;
  defaultSenderLocal: string;
  canEdit: boolean;
  canDelete: boolean;
  onSave: (body: { name?: string; inbound_address?: string; from_address?: string | null }) => Promise<unknown>;
  saving: boolean;
  onDelete: () => void;
}) {
  // Fields are locked until the user clicks Edit (mirrors the Settings page),
  // limiting the chance of accidental changes.
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(n.name);
  const [inbound, setInbound] = useState(localPart(n.inbound_address));
  const [sender, setSender] = useState(localPart(n.from_address ?? ''));
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName(n.name);
    setInbound(localPart(n.inbound_address));
    setSender(localPart(n.from_address ?? ''));
    setError(null);
  }

  const dirty =
    name.trim() !== n.name ||
    inbound.trim() !== localPart(n.inbound_address) ||
    sender.trim() !== localPart(n.from_address ?? '');

  async function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        inbound_address: `${inbound.trim()}@${domain}`,
        // Empty string clears the override (falls back to the global sender).
        from_address: sender.trim() ? `${sender.trim()}@${domain}` : '',
      });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[160px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Name</label>
          <input
            value={name}
            disabled={!editing}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
          />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">Inbound address</label>
          <LocalPartInput value={inbound} onChange={setInbound} domain={domain} disabled={!editing} />
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Sender <span className="normal-case tracking-normal text-slate-400">(optional)</span>
          </label>
          <LocalPartInput
            value={sender}
            onChange={setSender}
            domain={domain}
            disabled={!editing}
            placeholder={defaultSenderLocal || 'default'}
          />
        </div>
        {editing ? (
          <>
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={save}
              className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                reset();
                setEditing(false);
              }}
              className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
          </>
        ) : (
          canEdit && (
            <button
              type="button"
              onClick={() => {
                reset();
                setEditing(true);
              }}
              className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Edit
            </button>
          )
        )}
        {canDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="bg-red-600 text-white text-sm rounded px-3 py-1.5 hover:bg-red-700"
          >
            Delete
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
      <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
        Inbound mail to <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{n.inbound_address}</code> is routed to the ingest worker automatically via an Email Routing rule.
        The <strong>Sender</strong> is the outgoing <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">From:</code> for this newsletter; leave empty to use the global default.
      </p>
    </section>
  );
}

// Builds the live-preview HTML for the footer editor. Mirrors the consumer's
// render: substitute tokens with sample values and, if {{unsubscribe_url}} is
// absent, append an unsubscribe line so the preview matches what recipients
// get. No sanitization is needed here because the preview is shown in a
// sandboxed iframe (no scripts); the server sanitizes on save.
const SAMPLE_VARS: Record<string, string> = {
  unsubscribe_url: 'https://track.example.com/u/123?t=sample-token',
  newsletter_name: '',
  email: 'subscriber@example.com',
};
const FOOTER_TOKEN_RE = /\{\{\s*(unsubscribe_url|newsletter_name|email)\s*\}\}/g;

function buildFooterPreview(template: string, newsletterName: string): string {
  const vars: Record<string, string> = { ...SAMPLE_VARS, newsletter_name: newsletterName };
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => vars[k] ?? '');
  if (!hadUnsub) {
    body +=
      `\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0">` +
      `<a href="${vars.unsubscribe_url}" style="color:#64748b">Unsubscribe</a></p>`;
  }
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;` +
    `font-size:14px;color:#0f172a;margin:12px;background:#fff}a{color:#2563eb}</style></head>` +
    `<body>${body}</body></html>`
  );
}

// Plain-text counterpart of buildFooterPreview: substitute tokens and ensure
// an unsubscribe line is present, matching the consumer's text renderer.
function buildTextPreview(template: string, newsletterName: string): string {
  const vars: Record<string, string> = { ...SAMPLE_VARS, newsletter_name: newsletterName };
  const hadUnsub = /\{\{\s*unsubscribe_url\s*\}\}/.test(template);
  let body = template.replace(FOOTER_TOKEN_RE, (_m, k: string) => vars[k] ?? '');
  if (!hadUnsub) body += `\nUnsubscribe: ${vars.unsubscribe_url}`;
  return body;
}

function FooterEditor({
  n,
  canEdit,
  onSave,
  saving,
  defaultHtml,
  defaultText,
}: {
  n: Newsletter;
  canEdit: boolean;
  onSave: (body: { footer_html?: string | null; footer_text?: string | null }) => Promise<unknown>;
  saving: boolean;
  defaultHtml: string;
  defaultText: string;
}) {
  // The editor is pre-filled with the resolved value (the newsletter's own
  // override, or the global default when it has none) so operators customize an
  // existing footer instead of starting from a blank box. Clearing a field and
  // saving re-inherits the global default.
  const baselineHtml = n.footer_html && n.footer_html.trim() !== '' ? n.footer_html : defaultHtml;
  const baselineText = n.footer_text && n.footer_text.trim() !== '' ? n.footer_text : defaultText;
  const [editing, setEditing] = useState(false);
  const [html, setHtml] = useState(baselineHtml);
  const [text, setText] = useState(baselineText);
  const [error, setError] = useState<string | null>(null);

  // Keep the (read-only) view synced with the latest props until the user
  // starts editing. Needed because the global default arrives asynchronously
  // from /api/me and may not be present on first render.
  useEffect(() => {
    if (!editing) {
      setHtml(baselineHtml);
      setText(baselineText);
    }
  }, [editing, baselineHtml, baselineText]);

  function reset() {
    setHtml(baselineHtml);
    setText(baselineText);
    setError(null);
  }

  const dirty = html !== baselineHtml || text !== baselineText;
  const effectiveHtml = html.trim() === '' ? defaultHtml : html;
  const effectiveText = text.trim() === '' ? defaultText : text;
  const previewDoc = useMemo(() => buildFooterPreview(effectiveHtml, n.name), [effectiveHtml, n.name]);

  async function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    setError(null);
    try {
      // Empty string clears the override so the newsletter inherits the global
      // default footer.
      await onSave({ footer_html: html.trim() ? html : '', footer_text: text.trim() ? text : '' });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Email footer</h2>
        {!editing &&
          canEdit && (
            <button
              type="button"
              onClick={() => {
                reset();
                setEditing(true);
              }}
              className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Edit
            </button>
          )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        Appended to every email for this newsletter. Pre-filled with the global default so you can
        customize it; clear both fields to inherit the global default again. Tokens:{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{unsubscribe_url}}'}</code>{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{newsletter_name}}'}</code>{' '}
        <code className="bg-slate-100 px-1 rounded dark:bg-slate-800">{'{{email}}'}</code>. An
        unsubscribe link is always added even if you omit the token.
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div>
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            HTML footer
          </label>
          <textarea
            value={html}
            disabled={!editing}
            onChange={(e) => setHtml(e.target.value)}
            rows={8}
            spellCheck={false}
            placeholder={defaultHtml || 'Inherits the global default footer when empty.'}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">
            Plain-text footer
          </label>
          <textarea
            value={text}
            disabled={!editing}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={defaultText || 'Inherits the global default footer when empty.'}
            className={`${inputCls} font-mono text-xs leading-relaxed`}
          />
        </div>
        <div>
          <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            HTML preview
          </span>
          <iframe
            title="Footer preview"
            sandbox=""
            srcDoc={previewDoc}
            className="mt-0.5 w-full h-[160px] border border-slate-200 rounded bg-white dark:border-slate-700"
          />
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 mt-3 block">
            Text preview
          </label>
          <pre className="mt-0.5 w-full h-[90px] overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
            {buildTextPreview(effectiveText, n.name)}
          </pre>
          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
            Preview uses sample values; links are not click-tracked in the actual footer.
          </p>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {editing && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function SignupEditor({
  n,
  canEdit,
  onSave,
  saving,
  subscribeBase,
}: {
  n: Newsletter;
  canEdit: boolean;
  onSave: (body: { slug?: string; allow_public_signup?: boolean }) => Promise<unknown>;
  saving: boolean;
  subscribeBase: string;
}) {
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(n.slug ?? '');
  const [allow, setAllow] = useState((n.allow_public_signup ?? 0) === 1);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'url' | 'embed' | null>(null);

  useEffect(() => {
    if (!editing) {
      setSlug(n.slug ?? '');
      setAllow((n.allow_public_signup ?? 0) === 1);
    }
  }, [editing, n.slug, n.allow_public_signup]);

  const dirty = slug.trim() !== (n.slug ?? '') || allow !== ((n.allow_public_signup ?? 0) === 1);
  const base = subscribeBase.replace(/\/+$/, '');
  // Use the saved slug for the live URL/snippet (the draft isn't public yet).
  const effectiveSlug = n.slug ?? '';
  const subscribeUrl = base && effectiveSlug ? `${base}/subscribe/${effectiveSlug}` : '';
  const embedSnippet = subscribeUrl
    ? `<iframe src="${subscribeUrl}" title="Subscribe to ${n.name}" ` +
      `style="width:100%;max-width:420px;height:340px;border:0" loading="lazy"></iframe>`
    : '';
  const slugValid = slug.trim() === '' || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.trim());

  function reset() {
    setSlug(n.slug ?? '');
    setAllow((n.allow_public_signup ?? 0) === 1);
    setError(null);
  }

  async function copy(kind: 'url' | 'embed', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable; ignore */
    }
  }

  async function save() {
    if (!dirty) {
      setEditing(false);
      return;
    }
    if (!slugValid) {
      setError('Slug must be lowercase letters, numbers and single hyphens.');
      return;
    }
    setError(null);
    try {
      await onSave({ slug: slug.trim(), allow_public_signup: allow });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="bg-white border border-slate-200 rounded p-3 dark:bg-slate-900 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Public signup</h2>
        {!editing && canEdit && (
          <button
            type="button"
            onClick={() => {
              reset();
              setEditing(true);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Edit
          </button>
        )}
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
        Let anyone subscribe from a hosted form using double opt-in (a confirmation email is sent
        before they are added). Bot protection is handled by Cloudflare Turnstile.
      </p>

      <div className="mt-3 space-y-3">
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input
            type="checkbox"
            checked={allow}
            disabled={!editing}
            onChange={(e) => setAllow(e.target.checked)}
            className="h-4 w-4"
          />
          Enable the public subscribe page for this newsletter
        </label>

        <div>
          <label className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            URL slug
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">
              {base ? `${base}/subscribe/` : '/subscribe/'}
            </span>
            <input
              value={slug}
              disabled={!editing}
              onChange={(e) => setSlug(e.target.value)}
              placeholder={editing ? 'leave empty to auto-generate from the name' : ''}
              spellCheck={false}
              className={`${inputCls} font-mono text-xs flex-1`}
            />
          </div>
          {editing && !slugValid && (
            <p className="text-xs text-red-600 mt-1">
              Use lowercase letters, numbers and single hyphens (e.g. <code>weekly-digest</code>).
            </p>
          )}
        </div>

        {!editing && (
          <div className="space-y-2">
            <div>
              <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Public subscribe URL
              </span>
              {subscribeUrl ? (
                <div className="flex items-center gap-2 mt-0.5">
                  <a
                    href={subscribeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-blue-600 hover:underline break-all dark:text-blue-400"
                  >
                    {subscribeUrl}
                  </a>
                  <button
                    type="button"
                    onClick={() => copy('url', subscribeUrl)}
                    className="text-xs rounded px-2 py-1 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800 shrink-0"
                  >
                    {copied === 'url' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              ) : (
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 italic">
                  Set a slug to get a public URL.
                </p>
              )}
            </div>

            {embedSnippet && (
              <div>
                <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Embed snippet
                </span>
                <pre className="mt-0.5 w-full overflow-auto border border-slate-200 rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap font-mono text-slate-700 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-200">
                  {embedSnippet}
                </pre>
                <button
                  type="button"
                  onClick={() => copy('embed', embedSnippet)}
                  className="mt-1 text-xs rounded px-2 py-1 border border-slate-300 text-slate-600 hover:bg-slate-100 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {copied === 'embed' ? 'Copied' : 'Copy embed code'}
                </button>
              </div>
            )}

            {!allow && (
              <p className="text-xs text-amber-700 dark:text-amber-400 italic">
                Public signup is currently disabled — the URL above returns “not found” until you
                enable it.
              </p>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}

      {editing && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={!dirty || saving || !slugValid}
            onClick={save}
            className="bg-slate-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              reset();
              setEditing(false);
            }}
            className="text-sm rounded px-3 py-1.5 border border-slate-300 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
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

const inputCls =
  'block w-full border border-slate-300 rounded px-2 py-1 text-sm mt-0.5 bg-white text-slate-900 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-100 disabled:bg-slate-50 disabled:text-slate-500 disabled:cursor-not-allowed disabled:border-slate-200 dark:disabled:bg-slate-800/40 dark:disabled:text-slate-400 dark:disabled:border-slate-700';
