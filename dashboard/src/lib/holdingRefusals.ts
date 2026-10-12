// holdingRefusals - the staff copy for what a contact HOLDS that blocks a
// change of its kind (spec
// docs/superpowers/specs/2026-10-12-caseworker-integrity-design.md section 3,
// D2): an open placement or open tour as the tenant, a property it is the
// landlord of record for, a seat on a property's contact list. Keyed by
// refusal KIND and shared by the caseworker conversion dialog (its
// caseworker_* codes map onto these kinds, wording unchanged) and the generic
// type change (409 type_change_refused). The server sends codes only; every
// sentence lives here. TypeChangeRefusal mirrors the server's type in
// app/src/services/contactHoldings.ts.
import { ApiError } from '../api/index.js';

/** One refusal's staff sentence and the link to the record that blocks it. */
export interface RefusalCopy {
  sentence: string;
  linkText: string;
  to: string;
}

/** A blocking record, by kind. */
export type HoldingRefusal =
  | { code: 'open_placement'; placementId: string }
  | { code: 'open_tour'; tourId: string }
  | { code: 'landlord_of_record'; unitId: string }
  | { code: 'on_roster'; unitId: string };

/** One entry of a 409 type_change_refused - a seat never refuses a type change. */
export type TypeChangeRefusal = Exclude<HoldingRefusal, { code: 'on_roster' }>;

/**
 * The type change's own landlord-of-record sentence: no dashboard UI can
 * reassign a property's landlord yet (filed: landlord-of-record-no-reassign-ui),
 * so "change that property's landlord first" would point nowhere.
 */
export const TYPE_CHANGE_LANDLORD_SENTENCE =
  "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet.";

/** The conversion's wording, by kind (CaseworkerDialog's four sentences, verbatim). */
export function refusalCopyByKind(refusal: HoldingRefusal): RefusalCopy {
  switch (refusal.code) {
    case 'open_placement':
      return {
        sentence: "Finish or close this contact's placement first.",
        linkText: 'View placement',
        to: `/placements/${encodeURIComponent(refusal.placementId)}`,
      };
    case 'open_tour':
      return {
        sentence: "Cancel or close this contact's open tour first.",
        linkText: 'View tour',
        to: `/tours/${encodeURIComponent(refusal.tourId)}`,
      };
    case 'landlord_of_record':
      return {
        sentence: "This contact is the landlord of record for a property. Change that property's landlord first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
    case 'on_roster':
      return {
        sentence: "This contact is on a property's contact list. Remove them from it first.",
        linkText: 'View property',
        to: `/listings/${encodeURIComponent(refusal.unitId)}`,
      };
  }
}

/** The generic type change's wording: the conversion's for an open placement
 *  and an open tour, its own for a landlord of record. */
export function typeChangeRefusalCopy(refusal: TypeChangeRefusal): RefusalCopy {
  if (refusal.code === 'landlord_of_record') {
    return {
      sentence: TYPE_CHANGE_LANDLORD_SENTENCE,
      linkText: 'View property',
      to: `/listings/${encodeURIComponent(refusal.unitId)}`,
    };
  }
  return refusalCopyByKind(refusal);
}

function isTypeChangeRefusal(value: unknown): value is TypeChangeRefusal {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v['code']) {
    case 'open_placement':
      return typeof v['placementId'] === 'string';
    case 'open_tour':
      return typeof v['tourId'] === 'string';
    case 'landlord_of_record':
      return typeof v['unitId'] === 'string';
    default:
      return false;
  }
}

/** The refusals a 409 type_change_refused carries, or null for any other
 *  failure (and for a body with no well-formed refusal - the caller then
 *  shows its generic retry sentence). */
export function typeChangeRefusalsFrom(err: unknown): TypeChangeRefusal[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.code !== 'type_change_refused') return null;
  const body = typeof err.body === 'object' && err.body !== null ? (err.body as Record<string, unknown>) : {};
  const list = Array.isArray(body['refusals']) ? body['refusals'].filter(isTypeChangeRefusal) : [];
  return list.length > 0 ? list : null;
}
