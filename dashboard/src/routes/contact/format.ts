// Small presentation helpers for the contact detail page — pure + tested in
// isolation so the components stay declarative.
import type { Address } from '../../api/index.js';

/** Format a US E.164 number as "(404) 010-0007". Non-US / unparseable numbers
 *  are returned as-is (honest — never mangle an unexpected shape). */
export function formatPhone(e164: string | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (!m) return e164;
  return `(${m[1] ?? ''}) ${m[2] ?? ''}-${m[3] ?? ''}`;
}

/** A short clock label for a message instant, e.g. "9:14a" / "1:02p". */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let h = d.getHours();
  const min = d.getMinutes();
  const mer = h < 12 ? 'a' : 'p';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min.toString().padStart(2, '0')}${mer}`;
}

/** A date-divider label for a day, e.g. "Mon Jun 8". */
export function formatDayDivider(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // "Mon Jun 8" — drop the comma toLocaleDateString puts after the weekday.
  return d
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    .replace(',', '');
}

/** A stable per-day key (YYYY-MM-DD in local time) for grouping into dividers. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A duration like "4m 12s" / "48s" from whole seconds. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Render an Address (or a pre-contract plain string) as a single line. */
export function formatAddress(address: Address | string | undefined): string {
  if (address === undefined) return '';
  if (typeof address === 'string') return address;
  const parts = [
    address.line1,
    address.line2,
    [address.city, address.state].filter(Boolean).join(', '),
    address.zip,
  ].filter((p): p is string => Boolean(p && p.trim()));
  return parts.join(', ');
}

/** Humanize a snake_case enum value for display when no proper label map covers
 *  it: replace underscores with spaces and capitalize the first letter, e.g.
 *  'on_hold' → "On hold", 'some_unknown_value' → "Some unknown value". Only a
 *  FALLBACK — prefer a real label map first. Empty stays empty. */
export function humanize(value: string): string {
  if (!value) return '';
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The display name for a contact, falling back to the phone, then "Unknown". */
export function contactDisplayName(
  firstName: string | undefined,
  lastName: string | undefined,
  phone: string | undefined,
): string {
  const name = [firstName, lastName].filter(Boolean).join(' ').trim();
  if (name) return name;
  if (phone) return formatPhone(phone);
  return 'Unknown contact';
}
