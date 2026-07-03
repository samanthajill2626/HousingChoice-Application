// placementsFormat — small pure presentation helpers for the placement board +
// placement detail. Resolve a placement's tenant NAME (home) and property ADDRESS
// from the lookup maps usePlacements builds, falling back to the id (honest —
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

/** Noun labels for a placement's next-deadline clock (staff-facing). */
export const DEADLINE_TYPE_LABEL: Record<PlacementDeadlineType, string> = {
  tour_reminder: 'Tour reminder',
  rta_window: 'RTA window',
  voucher_expiration: 'Voucher expiration',
  stuck_placement: 'Stuck placement',
  follow_up: 'Follow-up',
};

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
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return { text: `due in ${minutes}m`, overdue: false };
  const hours = Math.ceil(ms / 3_600_000);
  if (hours < 48) return { text: `due in ${hours}h`, overdue: false };
  const days = Math.ceil(ms / 86_400_000);
  return { text: `due in ${days}d`, overdue: false };
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

/** A short YYYY-MM-DD date label (the tour date / a deadline date), or "". */
export function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A date-and-time label for a history row, e.g. "Jun 18, 1:02 PM", or the raw
 *  string when unparseable. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
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
