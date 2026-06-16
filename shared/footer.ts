// Email footer support: token substitution + HTML allow-list sanitization.
//
// Footers are authored by trusted console users, but we still apply
// defense-in-depth:
//   - `sanitizeFooterHtml` reduces stored HTML to a small allow-list of
//     formatting tags/attributes (protects the console's live preview, keeps
//     the email markup well-formed, and strips scripts/handlers/bad URLs);
//   - dynamic token values are HTML-escaped at render time.
//
// The unsubscribe link is guaranteed: a footer may place `{{unsubscribe_url}}`
// wherever it likes; if the token is absent, an unsubscribe line is appended.

export interface FooterVars {
  unsubscribe_url: string;
  newsletter_name: string;
  email: string;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!),
  );
}

// Escape a URL for safe use inside a double-quoted HTML attribute.
function escapeAttrUrl(url: string): string {
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Choose the newsletter's own footer when it has non-whitespace content,
 * otherwise fall back to the supplied global default.
 */
export function resolveFooter(own: string | null | undefined, fallback: string): string {
  return own && own.trim() !== '' ? own : fallback;
}

const TOKEN_RE = /\{\{\s*(unsubscribe_url|newsletter_name|email)\s*\}\}/g;
const HAS_UNSUB_RE = /\{\{\s*unsubscribe_url\s*\}\}/;

function substitute(template: string, vars: FooterVars, htmlContext: boolean): string {
  return template.replace(TOKEN_RE, (_m, key: keyof FooterVars) => {
    const raw = vars[key] ?? '';
    if (!htmlContext) return raw;
    // unsubscribe_url is a system-generated URL; the others are data and must
    // be HTML-escaped so they can't break out of an attribute or tag.
    return key === 'unsubscribe_url' ? escapeAttrUrl(raw) : escapeHtml(raw);
  });
}

/**
 * Render the HTML footer: substitute tokens (escaping data values) and ensure
 * an unsubscribe link is present even if the author omitted the token.
 */
export function renderFooterHtml(template: string, vars: FooterVars): string {
  const hadUnsub = HAS_UNSUB_RE.test(template);
  let html = substitute(template, vars, true);
  if (!hadUnsub) {
    html +=
      `\n<p style="font-size:12px;line-height:1.5;color:#64748b;margin:8px 0 0">` +
      `<a href="${escapeAttrUrl(vars.unsubscribe_url)}" style="color:#64748b">Unsubscribe</a></p>`;
  }
  return html;
}

/**
 * Render the plain-text footer: substitute tokens and ensure the unsubscribe
 * URL is present even if the author omitted the token.
 */
export function renderFooterText(template: string, vars: FooterVars): string {
  const hadUnsub = HAS_UNSUB_RE.test(template);
  let text = substitute(template, vars, false);
  if (!hadUnsub) text += `\nUnsubscribe: ${vars.unsubscribe_url}`;
  return text;
}

// ---------------- HTML sanitizer (allow-list) ----------------

const ALLOWED_TAGS = new Set([
  'a', 'p', 'br', 'div', 'span', 'strong', 'b', 'em', 'i', 'u', 'small', 'sub', 'sup',
  'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'blockquote',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'font', 'center',
]);

// Attributes allowed on any tag.
const GLOBAL_ATTRS = new Set(['style', 'title', 'align', 'dir']);

// Per-tag attribute allow-list (in addition to GLOBAL_ATTRS).
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  table: new Set(['width', 'cellpadding', 'cellspacing', 'border', 'bgcolor']),
  td: new Set(['width', 'height', 'valign', 'colspan', 'rowspan', 'bgcolor']),
  th: new Set(['width', 'height', 'valign', 'colspan', 'rowspan', 'bgcolor']),
  tr: new Set(['valign', 'bgcolor']),
  font: new Set(['color', 'face', 'size']),
};

const URL_ATTRS = new Set(['href', 'src']);
// Acceptable URL schemes; a literal {{token}} is also allowed (resolved later).
const SAFE_URL_RE = /^(https?:|mailto:)/i;

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function sanitizeAttrs(tag: string, attrStr: string): string {
  const allowed = TAG_ATTRS[tag];
  const out: string[] = [];
  let m: RegExpExecArray | null;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(attrStr))) {
    const name = m[1]!.toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    // Never allow event handlers or unknown attributes.
    if (name.startsWith('on')) continue;
    if (!GLOBAL_ATTRS.has(name) && !(allowed && allowed.has(name))) continue;
    if (URL_ATTRS.has(name)) {
      const v = value.trim();
      if (!v.startsWith('{{') && !SAFE_URL_RE.test(v)) continue; // drop unsafe URL
    }
    if (name === 'style' && /(javascript:|expression\s*\(|url\s*\(\s*['"]?\s*javascript:)/i.test(value)) {
      continue; // drop dangerous style
    }
    out.push(value === '' ? name : `${name}="${escapeHtml(value)}"`);
  }
  return out.length ? ' ' + out.join(' ') : '';
}

/**
 * Reduce author HTML to a safe allow-list. Unknown tags are unwrapped (their
 * text content is kept); script/style/embedding elements are removed with their
 * content; disallowed/dangerous attributes are stripped. Token placeholders
 * like `{{unsubscribe_url}}` survive (they are resolved at send time).
 */
export function sanitizeFooterHtml(input: string): string {
  if (!input) return '';
  let html = input;
  // 1. Remove dangerous elements together with their content.
  html = html.replace(
    /<(script|style|iframe|object|embed|noscript|template|svg|math|title|head)\b[\s\S]*?<\/\1\s*>/gi,
    '',
  );
  // 2. Remove HTML comments and any leftover orphan dangerous open/close tags.
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  html = html.replace(
    /<\/?(script|style|iframe|object|embed|noscript|template|svg|math|link|meta|base|head|html|body)\b[^>]*>/gi,
    '',
  );
  // 3. Walk remaining tags; rebuild allowed ones, unwrap the rest.
  html = html.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (_full, slash: string, name: string, attrs: string) => {
    const tag = name.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) return ''; // unwrap unknown tag, keep its text
    if (slash === '/') return `</${tag}>`;
    return `<${tag}${sanitizeAttrs(tag, attrs)}>`;
  });
  return html;
}
