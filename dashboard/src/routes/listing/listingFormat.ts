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

/** The header facts subline: "2 BR - 1 BA - $1,400-1,600/mo - West End, Atlanta
 *  - Porter Properties". Only present parts are joined. `landlordName` is the
 *  resolved landlord/company, appended last when known. */
export function buildListingFacts(unit: UnitItem, landlordName?: string): string {
  const parts: string[] = [];
  if (typeof unit.beds === 'number') parts.push(`${unit.beds} BR`);
  if (typeof unit.baths === 'number') parts.push(`${unit.baths} BA`);
  const rent = formatRent(unit.rent_min, unit.rent_max);
  if (rent) parts.push(`${rent}/mo`);
  const area = [unit.area, unit.jurisdiction].filter((p) => typeof p === 'string' && p).join(', ');
  if (area) parts.push(area);
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

/** Human labels for the tour-lifecycle audit kinds surfaced on a property. */
const TOUR_LABELS: Record<string, string> = {
  tour_scheduled: 'Tour scheduled',
  tour_rescheduled: 'Tour rescheduled',
  tour_took_place: 'Tour took place',
  tour_no_show: 'Tour no-show',
  tour_canceled: 'Tour canceled',
  tour_outcome: 'Tour outcome',
};

/** Staff copy per activity event (GLOSSARY: "property", never "listing"/"unit").
 *  `type` is an OPEN set — an unknown event humanizes (never a blank row). */
export function describeUnitActivity(e: UnitActivityEvent): UnitActivityDescription {
  // The contact an event references, by best display form: resolved name → id.
  const who = e.contactName ?? e.contactId;
  const contactLink =
    e.contactId !== undefined ? { to: `/contacts/${encodeURIComponent(e.contactId)}` } : {};
  if (e.type === 'broadcast_sent') {
    const n = typeof e.tenantCount === 'number' ? e.tenantCount : 0;
    return {
      label: `Broadcast to ${n} ${n === 1 ? 'tenant' : 'tenants'}`,
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
    case 'listing_response_set': {
      const response = e.response !== undefined ? humanize(e.response) : undefined;
      return {
        label: response !== undefined ? `Tenant response - ${response}` : 'Tenant response',
        ...(who !== undefined && { sub: who }),
        ...contactLink,
      };
    }
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
