// heardFrom - the ONE "last heard from" vocabulary for the dashboard (spec
// docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md
// sections 5.1, 5.3, 5.7 and 14.5 F7/F8/F10). Pure. The Tenants tab, the
// contact header, the roster cards, Review recipients and the Follow up tab
// all label and order through these four functions; the two row shapes
// (Contact's snake `last_heard_from_at`, the wire rows' camel
// `lastHeardFromAt`) share ONE comparator through accessor functions.
//
// The label is a thin wrapper over the inbox tiers (routes/inbox/inboxTime.ts,
// left unchanged - the inbox still shows a bare "2:14 PM"): today gains a
// "Today " prefix so "Last heard from 2:14 PM" never reads as a schedule.
// (This is the first lib -> routes runtime import; inboxTime is pure and has
// no route dependencies of its own.)
import { formatInboxTime, formatInboxTimeFull } from '../routes/inbox/inboxTime.js';
import { formatPhoneDisplay } from './phone.js';
import { isoOf } from './time.js';

/** The fields the name order reads. `Contact` satisfies it structurally. */
export interface NameLike {
  firstName?: string;
  lastName?: string;
  phone?: string;
  contactId: string;
}

/** A rendered label plus its hover title. An EMPTY title = render no title. */
export interface HeardFromLabel {
  label: string;
  title: string;
}

const DAY_MS = 86_400_000;

/** Epoch ms of a parseable instant (a `<ISO>#<suffix>` key reads as its ISO),
 *  else undefined. Absent, empty and unparseable are all "never". */
function instantOf(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined;
  const ms = Date.parse(isoOf(iso));
  return Number.isNaN(ms) ? undefined : ms;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today 2:14 PM" / "Yesterday" / "Sep 12" / "Sep 12, 2025", with the full
 *  stamp as the title; "Never" (no title) for an absent OR unparseable value. */
export function formatHeardFrom(iso: string | undefined, now: Date): HeardFromLabel {
  const ms = instantOf(iso);
  if (ms === undefined || iso === undefined) return { label: 'Never', title: '' };
  const tier = formatInboxTime(iso, now);
  if (tier === '') return { label: 'Never', title: '' };
  return {
    label: sameLocalDay(new Date(ms), now) ? `Today ${tier}` : tier,
    title: formatInboxTimeFull(iso),
  };
}

function cmpText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'accent' });
}

/** Last name, first name, formatted phone, then contactId as the stable key
 *  (spec 14.5 F10). Case-insensitive; an absent last name sorts first. */
export function compareByName(a: NameLike, b: NameLike): number {
  return (
    cmpText((a.lastName ?? '').trim(), (b.lastName ?? '').trim()) ||
    cmpText((a.firstName ?? '').trim(), (b.firstName ?? '').trim()) ||
    cmpText(formatPhoneDisplay(a.phone), formatPhoneDisplay(b.phone)) ||
    (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0)
  );
}

/** Most recent first; absent (or unparseable) last; ties by compareByName.
 *  Returns a NEW array - the input is never reordered. */
export function sortByHeardFrom<T>(
  rows: readonly T[],
  acc: { heardAt: (r: T) => string | undefined; name: (r: T) => NameLike },
): T[] {
  const keyed = rows.map((row) => ({ row, at: instantOf(acc.heardAt(row)) }));
  keyed.sort((x, y) => {
    if (x.at !== undefined && y.at !== undefined && x.at !== y.at) return y.at - x.at;
    if (x.at === undefined && y.at !== undefined) return 1;
    if (x.at !== undefined && y.at === undefined) return -1;
    return compareByName(acc.name(x.row), acc.name(y.row));
  });
  return keyed.map((k) => k.row);
}

/** Whole days since `iso` on the given clock: floor(ms / 86400000), clamped at
 *  0 (clock skew never reads "-1 days"); an unparseable value reads 0. */
export function daysSince(iso: string, now: Date): number {
  const ms = instantOf(iso);
  if (ms === undefined) return 0;
  return Math.max(0, Math.floor((now.getTime() - ms) / DAY_MS));
}
