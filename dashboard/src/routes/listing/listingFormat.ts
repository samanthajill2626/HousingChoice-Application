// listingFormat — small pure presentation helpers for the property detail page.
// Tested in isolation so the component stays declarative.
import {
  LISTING_STATUS_LABELS,
  type ListingStatus,
  type UnitActivityEvent,
  type UnitItem,
} from '../../api/index.js';
import { formatAddress, humanize } from '../contact/format.js';
import { ROLE_LABEL } from './buildListingFile.js';

/** A whole-dollar money label, e.g. 1550 → "$1,550". Undefined → "". */
export function formatMoney(amount: number | undefined): string {
  if (amount === undefined || Number.isNaN(amount)) return '';
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** A rent label from rent_min/rent_max: "$1,400-1,600", "$1,400", or "" when
 *  neither is set. The high end drops the "$" (it shares the low end's). */
export function formatRent(min: number | undefined, max: number | undefined): string {
  const lo = formatMoney(min);
  const hi = max !== undefined && !Number.isNaN(max) ? Math.round(max).toLocaleString('en-US') : '';
  if (lo && hi && min !== max) return `${lo}-${hi}`;
  if (lo) return lo;
  if (hi) return `$${hi}`;
  return '';
}

/** A beds/baths label, e.g. "2 / 1", "2 / —", or "" when both are absent. */
export function formatBedsBaths(beds: number | undefined, baths: number | undefined): string {
  if (beds === undefined && baths === undefined) return '';
  const b = beds === undefined ? '—' : String(beds);
  const ba = baths === undefined ? '—' : String(baths);
  return `${b} / ${ba}`;
}

/** The header status badge label, e.g. 'under_application' → "Under application".
 *  Uses the property-status label map; an unknown status falls back to a humanized
 *  form (underscores → spaces, capitalized) so the badge never renders blank. */
export function statusLabel(status: string): string {
  return LISTING_STATUS_LABELS[status as ListingStatus] ?? humanize(status);
}

/**
 * Read-time synthesis of a unit's accepted authorities (spec section 8) - there
 * is NO backfill, so every stored legacy unit keeps working. The new
 * `accepted_authorities` list wins whenever it is stored, INCLUDING when it is
 * empty (an empty stored list means "cleared"; falling back there would resurrect
 * the old jurisdiction value the operator just removed). Otherwise a legacy
 * non-empty `jurisdiction` string synthesizes a one-item list; otherwise [].
 *
 * SOURCE OF TRUTH: app/src/lib/unitFields.ts `authoritiesOf`. This is a HAND
 * mirror - no cross-workspace import exists, so nothing guards the two
 * mechanically (accepted, recorded in docs/issues/housing-authority-free-text-drift.md).
 * Change one, change the other, and keep both test suites in step.
 *
 * The parameter is typed with `unknown` fields, exactly as the app helper is: a
 * `UnitItem` is a flexible wire document (`[key: string]: unknown`), so a stored
 * value can be malformed regardless of what the interface declares.
 */
export function authoritiesOf(unit: {
  accepted_authorities?: unknown;
  jurisdiction?: unknown;
}): string[] {
  const list = unit.accepted_authorities;
  if (Array.isArray(list)) return list.filter((a): a is string => typeof a === 'string');
  const legacy = unit.jurisdiction;
  return typeof legacy === 'string' && legacy.length > 0 ? [legacy] : [];
}

/**
 * THE voucher (bedroom) sizes a property takes. Every place that needs a
 * property's voucher size reads it through this ONE function - never by
 * re-deriving the rule at a call site (Cameron, 2026-10-04):
 *
 *   1. its RECORDED `voucher_size_accepted`, when that holds at least one size -
 *      ONE number today, or a LIST once tracker #12 makes the field a
 *      multi-select (the `full` demo seed already stores `[2, 3]`). A recorded
 *      size always wins: a 3-bed property may take only a 2-BR voucher;
 *   2. otherwise its bedroom count (`beds`) - most properties never had the
 *      field filled in (the import does not write it), and a property usually
 *      takes the voucher that matches its bedrooms;
 *   3. otherwise nothing (`[]`): the property shows as "Not recorded".
 *
 * Only finite numbers count; anything else - absent, NaN, a string, an empty or
 * junk list - records nothing at that step.
 *
 * NOT for the property page's "Voucher size accepted" row or the New/Edit forms:
 * those show and edit what was RECORDED, which is a different question.
 *
 * Server side: no shared package exists between app and dashboard, and server
 * code has no copy of this rule yet - the public flyer's projection
 * (`toUnitFlyer`, app/src/lib/unitFields.ts) still derives its own size from
 * `beds` alone, as Matching's pre-fill does here
 * (docs/issues/unit-voucher-size-readers-diverge.md). Server code that needs the
 * rule (the flyer, the Matching audience, WP1 matching) gets this function's twin
 * in app/src/lib/unitFields.ts as the source of truth, with this one becoming its
 * hand mirror, exactly as `authoritiesOf` does - same test cases in both suites.
 *
 * Typed with `unknown` fields for the same reason as `authoritiesOf`: the wire
 * document is flexible, so a stored value can be any shape.
 */
export function acceptedVoucherSizes(unit: { voucher_size_accepted?: unknown; beds?: unknown }): number[] {
  const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const raw = unit.voucher_size_accepted;
  const recorded = Array.isArray(raw) ? raw.filter(isSize) : isSize(raw) ? [raw] : [];
  if (recorded.length > 0) return recorded;
  return isSize(unit.beds) ? [unit.beds] : [];
}

/** The header facts subline: "2 BR - 1 BA - $1,400-1,600/mo - West End
 *  - Porter Properties". Only present parts are joined. `landlordName` is the
 *  resolved landlord/company, appended last when known. The AREA slot carries
 *  `unit.area` alone: the legacy `jurisdiction` was an issuer name in an area
 *  slot and dropped out with the accepted-authorities consolidation (spec
 *  section 8). */
export function buildListingFacts(unit: UnitItem, landlordName?: string): string {
  const parts: string[] = [];
  if (typeof unit.beds === 'number') parts.push(`${unit.beds} BR`);
  if (typeof unit.baths === 'number') parts.push(`${unit.baths} BA`);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  if (rent) parts.push(`${rent}/mo`);
  if (typeof unit.area === 'string' && unit.area) parts.push(unit.area);
  if (landlordName) parts.push(landlordName);
  return parts.join(' - ');
}

/** True when a media entry looks like a resolvable URL (http/https/blob or a
 *  root-relative path) we can put in <img src>; false for a bare S3 key. `data:`
 *  is deliberately NOT accepted — property media is never a data URI, and keeping
 *  it out avoids ever placing operator-supplied `data:` content in the DOM. */
export function isMediaUrl(media: string): boolean {
  return /^(https?:|blob:|\/)/.test(media);
}

/** A short address label for a related/similar row (or the unitId fallback). */
export function shortAddress(
  address: UnitItem['address'],
  unitId: string,
): string {
  return formatAddress(address) || unitId;
}

/** What an Activity row renders: the event line, an optional detail sub-line,
 *  and an optional contact link (the row links out when the event references a
 *  contact). */
export interface UnitActivityDescription {
  label: string;
  sub?: string;
  to?: string;
}

/** Human labels for the tour-lifecycle audit kinds surfaced on a property.
 *  Listing a kind here is also what keeps its /tours/<id> link (an unknown
 *  type humanizes with no link). */
const TOUR_LABELS: Record<string, string> = {
  tour_scheduled: 'Tour scheduled',
  tour_rescheduled: 'Tour rescheduled',
  tour_took_place: 'Tour took place',
  tour_no_show: 'Tour no-show',
  tour_canceled: 'Tour canceled',
  tour_outcome: 'Tour outcome',
  // Spec 9.5: the auto-close sweep and the reopen route.
  tour_auto_closed: 'Tour closed automatically: no outcome recorded after two weeks',
  tour_reopened: 'Tour reopened',
};

/** Staff copy per activity event (GLOSSARY: "property", never "listing"/"unit").
 *  `type` is an OPEN set — an unknown event humanizes (never a blank row). */
export function describeUnitActivity(e: UnitActivityEvent): UnitActivityDescription {
  // The contact an event references, by best display form: resolved name → id.
  const who = e.contactName ?? e.contactId;
  const contactLink =
    e.contactId !== undefined ? { to: `/contacts/${encodeURIComponent(e.contactId)}` } : {};
  if (e.type === 'broadcast_sent') {
    // share-sent-outcome D5: the app recounts tenantCount as the share's
    // REACHED recipients at read time; none reached says so (the link to the
    // share, whose page explains why, stays either way).
    const n = typeof e.tenantCount === 'number' ? e.tenantCount : 0;
    return {
      label: n === 0 ? 'No tenants reached' : `Sent to ${n} ${n === 1 ? 'tenant' : 'tenants'}`,
      ...(e.broadcastId ? { to: `/broadcasts/${e.broadcastId}` } : {}),
    };
  }
  const tourLabel = TOUR_LABELS[e.type];
  if (tourLabel !== undefined) {
    return { label: tourLabel, ...(e.tourId ? { to: `/tours/${e.tourId}` } : {}) };
  }
  switch (e.type) {
    case 'unit_created':
      return { label: 'Property created' };
    case 'unit_updated': {
      const fields = (e.fields ?? []).map((f) => humanize(f)).join(', ');
      return { label: 'Property updated', ...(fields && { sub: fields }) };
    }
    case 'unit_contact_added': {
      const role =
        e.role !== undefined ? (ROLE_LABEL[e.role as keyof typeof ROLE_LABEL] ?? humanize(e.role)) : undefined;
      const sub = [who, role].filter(Boolean).join(' - ');
      return { label: 'Contact added', ...(sub && { sub }), ...contactLink };
    }
    case 'unit_contact_removed':
      return { label: 'Contact removed', ...(who !== undefined && { sub: who }), ...contactLink };
    case 'listing_status_changed': {
      const to = e.to !== undefined ? statusLabel(e.to) : undefined;
      const from = e.from !== undefined ? statusLabel(e.from) : undefined;
      const auto = e.source === 'derived' ? ' - automatic' : '';
      return {
        label: to !== undefined ? `Status changed to ${to}` : 'Status changed',
        ...(from !== undefined && { sub: `from ${from}${auto}` }),
      };
    }
    case 'unit_deleted':
      return { label: 'Property deleted' };
    case 'unit_restored':
      return { label: 'Property restored' };
    default:
      return { label: humanize(e.type) };
  }
}
