// placementsFormat -- small pure presentation helpers for the placements page +
// placement detail. Resolve a placement's tenant NAME (home) and property ADDRESS
// from the lookup maps usePlacements builds, falling back to the id (honest --
// never fabricated). Tested in isolation.
import {
  LISTING_STATUS_LABELS,
  STAGE_LABELS,
  TENANT_STATUS_LABELS,
  type Contact,
  type ListingStatus,
  type PlacementDeadlineType,
  type PlacementStage,
  type TenantStatus,
  type UnitItem,
} from '../../api/index.js';
import { contactDisplayName, formatAddress } from '../contact/format.js';
import { isoOf } from '../../lib/time.js';

/** Noun labels for a placement's next-deadline clock (staff-facing). */
export const DEADLINE_TYPE_LABEL: Record<PlacementDeadlineType, string> = {
  rta_window: 'RTA window',
  voucher_expiration: 'Voucher expiration',
  follow_up: 'Follow-up',
};

/**
 * The single coarse relative-magnitude calculator for this file: a positive
 * millisecond span rendered "Nm" (under an hour), "Nh" (under two days), else
 * "Nd". Every relative-time phrase on the placements surface -- deadlineRelative,
 * sendRelative, and the date-vocabulary formatters below -- composes from this
 * ONE bucket function, so the units never drift between them. Callers guard the
 * sign (ms > 0) themselves and add the lead/tail words ("in", "ago", "overdue").
 */
function coarseSpan(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  const days = Math.ceil(ms / 86_400_000);
  return `${days}d`;
}

/**
 * A relative phrase for a deadline instant vs now: "overdue" once it's at/past,
 * else "due in Nm/Nh/Nd". Coarse buckets mirror the Today queue's urgency badge
 * (app/src/routes/today.ts urgencyOf) so the detail page and the queue agree.
 */
export function deadlineRelative(
  iso: string,
  now: number = Date.now(),
): { text: string; overdue: boolean } {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return { text: '', overdue: false };
  const ms = at - now;
  if (ms <= 0) return { text: 'overdue', overdue: true };
  return { text: `due in ${coarseSpan(ms)}`, overdue: false };
}

/**
 * Relative fire-time phrasing for a SCHEDULED SEND (a reminder / nudge that WILL
 * be sent) vs now: "sends in Nm/Nh/Nd" while its fire time is in the future, else
 * "sending shortly" (at/past its fire time but the worker just hasn't run yet).
 * Distinct from deadlineRelative's "due in"/"overdue": a scheduled message isn't
 * "due", it sends. Single source of truth for the scheduled-send wording shared
 * by the Tour RemindersPanel chip and the contact-timeline ScheduledCard.
 */
export function sendRelative(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  if (at - now <= 0) return 'sending shortly';
  // Reuse deadlineRelative's bucket math; swap the "due " lead for "sends ".
  return `sends ${deadlineRelative(iso, now).text.replace(/^due /, '')}`;
}

/** The tenant's display name for a placement, or the tenant id when the contact
 *  isn't loaded. */
export function tenantName(contacts: Map<string, Contact>, tenantId: string): string {
  const c = contacts.get(tenantId);
  if (!c) return tenantId;
  return contactDisplayName(c.firstName, c.lastName, c.phone);
}

/** True when the placement's tenant is porting (the F1 boolean flag on the contact). */
export function isPorting(contacts: Map<string, Contact>, tenantId: string): boolean {
  return contacts.get(tenantId)?.porting === true;
}

/** The property's (unit's) address line for a placement, or the unit id when the unit
 *  isn't loaded. */
export function listingAddress(units: Map<string, UnitItem>, unitId: string): string {
  const u = units.get(unitId);
  if (!u) return unitId;
  return formatAddress(u.address) || unitId;
}

/** Parse an ISO instant -- clean, a `<ISO>#<suffix>` audit sort key (normalised
 *  via isoOf), or a date-only `YYYY-MM-DD` -- into a LOCAL Date, or null when
 *  unparseable. Date-only strings have no time component, so `new Date(norm)`
 *  parses them as UTC midnight -- which renders as the PREVIOUS day in
 *  negative-offset US timezones. Build the date from its calendar parts in LOCAL
 *  time instead so it never shifts. Shared by every date label in this file. */
function toLocalDate(iso: string | undefined): Date | null {
  if (!iso) return null;
  const norm = isoOf(iso);
  const dateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(norm);
  const d = dateOnlyMatch
    ? new Date(Number(dateOnlyMatch[1]), Number(dateOnlyMatch[2]) - 1, Number(dateOnlyMatch[3]))
    : new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A short "Jun 18" date label (the tour date / a deadline date), or "". Accepts a
 *  clean ISO instant OR a `<ISO>#<suffix>` audit sort key (normalised via isoOf). */
export function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = toLocalDate(iso);
  if (!d) return isoOf(iso).slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A weekday-prefixed short date, e.g. "Thu Jul 17" (an appointment / a due day).
 *  Same LOCAL-date parsing as shortDate; falls back to shortDate when unparseable. */
function weekdayDate(iso: string): string {
  const d = toLocalDate(iso);
  if (!d) return shortDate(iso);
  // Compose the weekday onto shortDate (no comma) -> "Fri Jul 17", per the spec's
  // date vocabulary; toLocaleDateString with all three parts would insert a comma.
  return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${shortDate(iso)}`;
}

// --- Date vocabulary (spec section 6) --------------------------------------
// A date never stands alone: each kind of date rides its own verb phrase, with
// the shared coarseSpan magnitude in parens -- "(in N)" for the future, "(N ago)"
// / "(N overdue)" for the past. All compose from coarseSpan (no second relative-
// time calculator) and the LOCAL-date label helpers above. `now` is injected as
// the trailing arg, matching deadlineRelative/sendRelative.

/** " (in Nd)" when `at` is in the future vs `now`; "" once at/past. */
function futureParens(at: number, now: number): string {
  const ms = at - now;
  return ms > 0 ? ` (in ${coarseSpan(ms)})` : '';
}

/** " (Nd ago)" when `at` is in the past vs `now`; "" when future. */
function agoParens(at: number, now: number): string {
  const ms = now - at;
  return ms > 0 ? ` (${coarseSpan(ms)} ago)` : '';
}

/** " (Nd overdue)" when `at` is in the past vs `now`; "" when future. */
function overdueParens(at: number, now: number): string {
  const ms = now - at;
  return ms > 0 ? ` (${coarseSpan(ms)} overdue)` : '';
}

/** Future appointment (e.g. an inspection): "scheduled for Thu Jul 17 (in 2d)".
 *  Drops the relative parens once the appointment is at/past. */
export function scheduledFor(iso: string, now: number = Date.now()): string {
  const d = toLocalDate(iso);
  if (!d) return '';
  return `scheduled for ${weekdayDate(iso)}${futureParens(d.getTime(), now)}`;
}

/** A deadline (e.g. voucher expiration): "expires Aug 2 (in 18d)" while future,
 *  flipping to the past tense "expired Aug 2 (2d ago)" once it has passed. */
export function expiresOn(iso: string, now: number = Date.now()): string {
  const d = toLocalDate(iso);
  if (!d) return '';
  const at = d.getTime();
  return at > now
    ? `expires ${shortDate(iso)}${futureParens(at, now)}`
    : `expired ${shortDate(iso)}${agoParens(at, now)}`;
}

/** An RTA-window (or similar) close deadline: "closes at Aug 2 (in 21h)" while
 *  future, flipping to "closed at Aug 2 (2d ago)" once past. */
export function closesAt(iso: string, now: number = Date.now()): string {
  const d = toLocalDate(iso);
  if (!d) return '';
  const at = d.getTime();
  return at > now
    ? `closes at ${shortDate(iso)}${futureParens(at, now)}`
    : `closed at ${shortDate(iso)}${agoParens(at, now)}`;
}

/** Elapsed / stuck time since a past instant: "since Jul 12 (3d ago)". Drops the
 *  parens if the instant is somehow in the future. */
export function sinceWhen(iso: string, now: number = Date.now()): string {
  const d = toLocalDate(iso);
  if (!d) return '';
  return `since ${shortDate(iso)}${agoParens(d.getTime(), now)}`;
}

/** An overdue instant (e.g. a follow-up): "was due Mon Jul 13 (2d overdue)".
 *  If not yet due it reads "due Mon Jul 13 (in Nd)". */
export function wasDue(iso: string, now: number = Date.now()): string {
  const d = toLocalDate(iso);
  if (!d) return '';
  const at = d.getTime();
  return at <= now
    ? `was due ${weekdayDate(iso)}${overdueParens(at, now)}`
    : `due ${weekdayDate(iso)}${futureParens(at, now)}`;
}

/** A date-and-time label for a history row, e.g. "Jun 18, 1:02 PM". Accepts a clean
 *  ISO instant OR a `<ISO>#<suffix>` audit sort key (normalised via isoOf) so the
 *  raw key never renders; falls back to the normalised string when unparseable. */
export function dateTime(iso: string): string {
  const norm = isoOf(iso);
  const d = new Date(norm);
  if (Number.isNaN(d.getTime())) return norm;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Humanize a raw snake_case token into a Sentence-case phrase, e.g.
 *  "placement_stage_changed" → "Placement stage changed". The fallback for any
 *  event_type / status we don't have an explicit label map for — staff NEVER
 *  see a raw snake_case token. */
export function humanizeToken(token: string): string {
  if (!token) return '';
  const spaced = token.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** A readable title for a history row from its event_type, e.g.
 *  "placement_stage_changed" → "Stage changed", "tenant_status_changed" →
 *  "Tenant status changed". Falls back to a humanized event_type. */
export function historyTitle(eventType: string): string {
  switch (eventType) {
    case 'placement_stage_changed':
      return 'Stage changed';
    case 'tenant_status_changed':
      return 'Tenant status changed';
    case 'listing_status_changed':
      return 'Property status changed';
    default:
      return humanizeToken(eventType);
  }
}

/** Label a from/to value with the map that matches the event_type — stages via
 *  STAGE_LABELS, tenant statuses via TENANT_STATUS_LABELS, property statuses via
 *  LISTING_STATUS_LABELS — falling back to a humanize so a raw snake_case value
 *  is NEVER shown to staff. */
function labelFor(eventType: string, value: string): string {
  if (!value) return '';
  switch (eventType) {
    case 'placement_stage_changed':
      return STAGE_LABELS[value as PlacementStage] ?? humanizeToken(value);
    case 'tenant_status_changed':
      return TENANT_STATUS_LABELS[value as TenantStatus] ?? humanizeToken(value);
    case 'listing_status_changed':
      return LISTING_STATUS_LABELS[value as ListingStatus] ?? humanizeToken(value);
    default:
      return humanizeToken(value);
  }
}

/** A readable one-line summary of a history row's payload: a from→to move with
 *  its source, both sides LABELED with the human map for the event_type (never a
 *  raw snake_case stage/status), else falls back to the humanized event_type.
 *  Pure; only reads the bounded fields (from/to/source) — never free PII text. */
export function summarizeHistory(
  eventType: string,
  payload: Record<string, unknown> | undefined,
): string {
  const fromRaw = typeof payload?.['from'] === 'string' ? (payload['from'] as string) : '';
  const toRaw = typeof payload?.['to'] === 'string' ? (payload['to'] as string) : '';
  const source = typeof payload?.['source'] === 'string' ? (payload['source'] as string) : '';
  const from = labelFor(eventType, fromRaw);
  const to = labelFor(eventType, toRaw);
  if (from && to) {
    const suffix = source ? ` (${source})` : '';
    return `${from} → ${to}${suffix}`;
  }
  if (to) return `→ ${to}${source ? ` (${source})` : ''}`;
  return humanizeToken(eventType);
}
