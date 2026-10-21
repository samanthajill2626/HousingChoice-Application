// listingFormat — small pure presentation helpers for the property detail page.
// Tested in isolation so the component stays declarative.
import {
  LISTING_STATUS_LABELS,
  type ListingSendRow,
  type ListingStatus,
  type UnitActivityEvent,
  type UnitItem,
} from '../../api/index.js';
import { CONTACT_TYPE_LABEL, displayKind } from '../contact/contactProfile.js';
import { formatAddress, humanize } from '../contact/format.js';
import { ROLE_LABEL } from './buildListingFile.js';
import { WASHER_DRYER_LABELS } from './requirements.js';

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
 *      a LIST since tracker #12 (D4: the write API stores the sizes
 *      de-duplicated and ascending), or a single number stored before it (still
 *      read, never backfilled). A recorded size always wins: a 3-bed property
 *      may take only a 2-BR voucher;
 *   2. otherwise its bedroom count (`beds`) - most properties never had the
 *      field filled in (the import does not write it), and a property usually
 *      takes the voucher that matches its bedrooms;
 *   3. otherwise nothing (`[]`): the property shows as "Not recorded".
 *
 * Only finite numbers count; anything else - absent, NaN, a string, an empty or
 * junk list - records nothing at that step.
 *
 * NOT for the property page's "Voucher sizes accepted" row (recordedVoucherSizes
 * below) or the New/Edit forms (splitVoucherSizes, requirementForm.ts): those
 * show and edit what was RECORDED, which is a different question.
 *
 * Server side: no shared package exists between app and dashboard, so this is
 * the HAND MIRROR of `acceptedVoucherSizes` in app/src/lib/unitFields.ts - the
 * source of truth, which the public flyer reads - exactly as `authoritiesOf`
 * does. Keep the two in step by hand; both suites carry the same test cases.
 * Dashboard readers: the Properties list's filter and summary, and Matching's
 * voucher-size pre-fill (BroadcastComposer).
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

/**
 * D4 (property requirements spec 2026-10-20): the voucher sizes RECORDED on a
 * property - the property page's "Voucher sizes accepted" row - ascending and
 * de-duplicated. NEVER the bedrooms fallback (Cameron's 2026-10-12 decision):
 * that is `acceptedVoucherSizes`, a different question. Reads a stored list or
 * an older single number; anything else records nothing. Every finite number
 * shows, a legacy 2.5 included (the page shows what is stored); the New / Edit
 * forms split the same value with splitVoucherSizes (requirementForm.ts),
 * which flags such a value for removal on save.
 */
export function recordedVoucherSizes(unit: { voucher_size_accepted?: unknown }): number[] {
  const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const raw = unit.voucher_size_accepted;
  const list = Array.isArray(raw) ? raw.filter(isSize) : isSize(raw) ? [raw] : [];
  return [...new Set(list)].sort((a, b) => a - b);
}

/** D4 copy: "Studio, 2 BR, 3 BR" (0 is Studio); '' when nothing is recorded. */
export function formatVoucherSizes(sizes: readonly number[]): string {
  return sizes.map((n) => (n === 0 ? 'Studio' : `${n} BR`)).join(', ');
}

/** D3: the label of a stored washer / dryer value (S5's WASHER_DRYER_LABELS,
 *  requirements.ts - the one label map, ruling AR39), or null when none is
 *  recorded. */
export function washerDryerLabel(value: unknown): string | null {
  return value === 'hookups' || value === 'included' || value === 'none' ? WASHER_DRYER_LABELS[value] : null;
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

/** Why a primary contact was set without anyone clicking Make primary
 *  (primary-contact-integrity spec 8, the `reason` on
 *  unit_primary_contact_assigned). A Map, so an inherited name such as
 *  `toString` never matches; an unknown reason humanizes. */
const PRIMARY_ASSIGNED_REASON: ReadonlyMap<string, string> = new Map([
  ['auto_on_add', 'the property had no primary contact'],
  ['handoff_on_remove', 'the previous primary contact was removed'],
  ['handoff_on_delete', 'the previous primary contact was deleted'],
  ['handoff_on_restore', "the property's landlord changed when it was restored"],
  ['backfill', 'set by a one-time data repair'],
]);

/** last-heard-from spec 5.4 / 14.3: the send-outcome rows the outcome route
 *  appends to the unit audit (payload { contactId, actor } + tourId on
 *  interested). Prefixed by the contact (`who`). "(auto)" never shows here -
 *  `by` is not on the Activity wire. */
const OUTCOME_LABELS: Record<string, string> = {
  listing_declined: 'not interested',
  listing_decline_cleared: 'not interested cleared',
  listing_interested: 'interested - tour requested',
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
      // Spec 2026-10-06 D20/D22: neutral words - a share may reach partners;
      // the label keeps its "Sent to " prefix.
      label: n === 0 ? 'No recipients reached' : `Sent to ${n} ${n === 1 ? 'recipient' : 'recipients'}`,
      ...(e.broadcastId ? { to: `/broadcasts/${e.broadcastId}` } : {}),
    };
  }
  const tourLabel = TOUR_LABELS[e.type];
  if (tourLabel !== undefined) {
    return { label: tourLabel, ...(e.tourId ? { to: `/tours/${e.tourId}` } : {}) };
  }
  const outcomeLabel = OUTCOME_LABELS[e.type];
  if (outcomeLabel !== undefined) {
    // `who` is always present in practice (the route writes contactId); the
    // fallback keeps the open-set rule - never a blank or "undefined" row.
    return {
      label: `${who ?? 'A recipient'} ${outcomeLabel}`,
      ...(e.type === 'listing_interested' && e.tourId ? { to: `/tours/${e.tourId}` } : contactLink),
    };
  }
  switch (e.type) {
    case 'unit_created':
      return { label: 'Property created' };
    case 'unit_updated': {
      const fields = (e.fields ?? []).map((f) => humanize(f)).join(', ');
      // D13: an Apply to properties writes unit_updated with reason
      // 'requirements_applied' (the Activity projection lifts that one value).
      const label = e.reason === 'requirements_applied' ? 'Requirements applied from the landlord' : 'Property updated';
      return { label, ...(fields && { sub: fields }) };
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
    case 'org_name_rewrite':
    case 'org_name_cleanup': {
      // Spec 2026-10-06 D11 / plan 3.8: a machine rewrite of the property's
      // housing authorities. `from` and `to` are strings (the list joined with
      // ', '; '' for a removed value).
      const label = e.type === 'org_name_rewrite' ? 'Housing authority updated' : 'Housing authority cleaned up';
      if (e.from === undefined && e.to === undefined) return { label };
      const side = (v: string | undefined): string => (v === undefined || v === '' ? '(none)' : v);
      return { label, sub: `${side(e.from)} -> ${side(e.to)}` };
    }
    case 'unit_primary_contact_assigned': {
      // primary-contact-integrity spec 8: a primary contact nobody clicked -
      // an automatic pick or the backfill script - says who and why, and
      // links to the contact. (`from` is a raw contact id; not shown.)
      const why =
        e.reason !== undefined ? (PRIMARY_ASSIGNED_REASON.get(e.reason) ?? humanize(e.reason)) : undefined;
      const sub = [who, why].filter(Boolean).join(' - ');
      return { label: 'Primary contact set automatically', ...(sub && { sub }), ...contactLink };
    }
    case 'unit_deleted':
      return { label: 'Property deleted' };
    case 'unit_restored':
      return { label: 'Property restored' };
    default:
      return { label: humanize(e.type) };
  }
}

/**
 * Spec 2026-10-06 D20/D22 (caseworkers): the label a property "Sent to" row
 * shows beside the recipient's name - the contact's displayKind (its role,
 * else the type label, e.g. "Partner") for a RESOLVED non-tenant row. A
 * tenant row stays unlabelled, and so does a row whose contact did not resolve
 * (the server omits `type`).
 */
export function sendRowKindLabel(row: Pick<ListingSendRow, 'type' | 'role'>): string | undefined {
  if (row.type === undefined || row.type === 'tenant') return undefined;
  return displayKind({ type: row.type, role: row.role }, (t) => CONTACT_TYPE_LABEL[t]);
}

/** One property "Sent to" group (last-heard-from spec 5.5): its key and the
 *  accessible name of its list (markup R1). */
export interface SendRowGroup {
  key: 'waiting' | 'interested' | 'not_interested' | 'not_eligible';
  label: 'Waiting' | 'Interested' | 'Not interested' | 'Not eligible';
  rows: ListingSendRow[];
}

/**
 * last-heard-from spec 5.5: the property "Sent to" card's four groups, ALWAYS
 * returned in this order (empty ones included; the host skips them), which
 * together cover every row, each newest sentAt first: Waiting (no_reply /
 * replied on an ELIGIBLE recipient - the eligibility half only, no
 * lookback/quiet thresholds), Interested (and, flyer-leads D8, signed_up on an
 * ELIGIBLE recipient), Not interested, Not eligible (a waiting or signed_up
 * outcome on an ineligible recipient, and EVERY row whose contact is
 * missing). `eligible` absent counts as not eligible.
 */
export function groupSendRows(rows: readonly ListingSendRow[]): SendRowGroup[] {
  const groups: SendRowGroup[] = [
    { key: 'waiting', label: 'Waiting', rows: [] },
    { key: 'interested', label: 'Interested', rows: [] },
    { key: 'not_interested', label: 'Not interested', rows: [] },
    { key: 'not_eligible', label: 'Not eligible', rows: [] },
  ];
  const indexOf = (r: ListingSendRow): number => {
    if (r.recipientMissing === true) return 3;
    if (r.outcome === 'interested') return 1;
    if (r.outcome === 'not_interested') return 2;
    // flyer-leads D8: a flyer sign-up is never waiting - the person reached
    // out - so an eligible recipient files under Interested.
    if (r.outcome === 'signed_up') return r.eligible === true ? 1 : 3;
    return r.eligible === true ? 0 : 3;
  };
  const newestFirst = [...rows].sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  for (const r of newestFirst) groups[indexOf(r)]!.rows.push(r);
  return groups;
}
