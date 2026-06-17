// listingFormat — small pure presentation helpers for the listing detail page.
// Tested in isolation so the component stays declarative.
import type { UnitItem } from '../../api/index.js';
import { formatAddress } from '../contact/format.js';

/** A whole-dollar money label, e.g. 1550 → "$1,550". Undefined → "". */
export function formatMoney(amount: number | undefined): string {
  if (amount === undefined || Number.isNaN(amount)) return '';
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** A rent label from rent_min/rent_max: "$1,400–1,600", "$1,400", or "" when
 *  neither is set. The high end drops the "$" (it shares the low end's). */
export function formatRent(min: number | undefined, max: number | undefined): string {
  const lo = formatMoney(min);
  const hi = max !== undefined && !Number.isNaN(max) ? Math.round(max).toLocaleString('en-US') : '';
  if (lo && hi && min !== max) return `${lo}–${hi}`;
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

/** The header status badge label, e.g. 'available' → "Available". */
export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/** The header facts subline: "2 BR · 1 BA · $1,400–1,600/mo · West End, Atlanta
 *  · Porter Properties". Only present parts are joined. `landlordName` is the
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
  return parts.join(' · ');
}

/** True when a media entry looks like a resolvable URL (http/https/blob or a
 *  root-relative path) we can put in <img src>; false for a bare S3 key. `data:`
 *  is deliberately NOT accepted — listing media is never a data URI, and keeping
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
