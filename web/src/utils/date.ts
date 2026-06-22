/** Normalise SQLite "YYYY-MM-DD HH:MM:SS" or ISO 8601 string to a Date. */
function toDate(s: string): Date | null {
  const iso = s.replace(' ', 'T').endsWith('Z') ? s.replace(' ', 'T') : s.replace(' ', 'T') + 'Z';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Formats a SQLite datetime string (UTC) into the local-timezone display
 * format: "YYYY-MM-DD HH:MM TZ" where TZ is the browser's timezone
 * abbreviation (e.g. "CEST", "EST"). Returns an empty string for null/undefined.
 */
export function fmtDate(s: string | null | undefined): string {
  if (!s) return '';
  const d = toDate(s);
  if (!d) return s;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}${tz ? ` ${tz}` : ''}`;
}

/**
 * Returns the UTC equivalent of a datetime string in "YYYY-MM-DD HH:MM UTC"
 * format, for use in tooltips alongside the local-time display.
 */
export function fmtUtc(s: string | null | undefined): string {
  if (!s) return '';
  const d = toDate(s);
  if (!d) return s;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi} UTC`;
}
