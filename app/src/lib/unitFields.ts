// Unit field validation + the public flyer projection (M1.5). Kept in lib so
// BOTH the authenticated /api/units router and the public /public flyer route
// share ONE definition of "what a unit field is" and "what is safe to share" —
// the public-vs-internal split must never drift between the two surfaces.
//
// The allowlist is strict by design: a unit is a flexible document at rest, but
// the WRITE surface only accepts known fields with the right types, so a
// caller can never inject `tour_process` through an unexpected key or set a GSI
// key (status/jurisdiction) to a non-string that would poison the index.
import { type Address, validateAddress } from './address.js';
import { isTourType } from './toursModel.js';
import { type UnitItem } from '../repos/unitsRepo.js';

/** Result of validating a units request body. */
export type UnitValidation =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string };

type FieldKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'string[]'
  | 'pets'
  | 'address'
  | 'tour_type';

/**
 * The writable unit fields and their kinds. `jurisdiction` is a GSI partition
 * key (validated as a string here). `landlordId` is required on create only
 * (checked by the caller). NOTE: unitId/created_at/updated_at are NOT writable
 * (repo-owned).
 *
 * `status` is DELIBERATELY not here (§8: every property-status change routes
 * through the ONE transition service so status_source provenance is stamped —
 * use PATCH /api/units/:unitId/listing-status). `final_rent` (the accepted
 * contract rent) IS writable here (Approval & Move-in): the team can record it
 * in place at rent acceptance rather than being forced to enter it only on the
 * acceptance move — which still also writes it (§4). The unit-CREATE path stamps the initial
 * `status` + `status_source` separately (routes/units.ts), since create is not
 * a transition but still needs the denormalized provenance initialized.
 */
const WRITABLE_FIELDS: Record<string, FieldKind> = {
  landlordId: 'string',
  jurisdiction: 'string',
  address: 'address',
  accepted_programs: 'string[]',
  beds: 'number',
  baths: 'number',
  area: 'string',
  subzone: 'string',
  rent_min: 'number',
  rent_max: 'number',
  // The accepted contract rent (Approval & Move-in). Writable in place at rent
  // acceptance; the acceptance move still writes it too. The 'number' kind
  // enforces finite & >= 0.
  final_rent: 'number',
  payment_standard: 'number',
  // Security deposit in dollars. PUBLIC on the flyer projection (flyer-full-info).
  deposit: 'number',
  lif: 'number',
  // TENANT-PAID utilities (which utilities the tenant must pay) — free-form.
  utilities: 'string',
  // Accessibility notes (tenant-useful). PUBLIC on the flyer projection (flyer-full-info).
  accessibility: 'string',
  // Internal staff notes ("In-unit washer/dryer", "No dishwasher"). NEVER on
  // the flyer projection below - internal only.
  notes: 'string',
  // Lease terms - free-form per-unit fact ("12-month minimum, month-to-month
  // after"). Moved OFF the landlord contact 2026-07-10 (with pet policy /
  // accepted programs / expected rent - see GLOSSARY). PUBLIC on the flyer
  // projection below (flyer-full-info 2026-07-16).
  lease_terms: 'string',
  // Pet policy - a free-form string or a bare boolean. PUBLIC on the flyer
  // projection below (flyer-full-info 2026-07-16).
  pets: 'pets',
  priority: 'string',
  media: 'string[]',
  listing_link: 'string',
  // Public flyer fields (flyer-full-info): tenant-useful facts shown upfront on
  // the flyer projection. video_url is a tour video link; application_fee is a
  // dollar amount (the 'number' kind already enforces >= 0); same_day_rta is a
  // boolean badge ("same-day RTA available").
  video_url: 'string',
  application_fee: 'number',
  same_day_rta: 'boolean',
  // Landlord-onboarding: the voucher size the unit ACCEPTS — a stored, writable
  // number (>= 0), DISTINCT from `beds` and from the derived read-only
  // `voucher_size` flyer projection (a 3bd unit may accept a 2BR voucher). Feeds
  // matching. INTERNAL for Phase-1 (NOT on the flyer projection).
  voucher_size_accepted: 'number',
  tour_process: 'string',
  // Structured tour type (self_guided / landlord_led / pm_team). A DEDICATED
  // kind (not plain 'string') because it must clear to ABSENT: ''/null map to
  // a null patch value so the repo's null->REMOVE path fires (a plain 'string'
  // would reject null and store a stray empty-string enum). INTERNAL - not on
  // the flyer projections below.
  tour_type: 'tour_type',
  application_process: 'string',
  primary_voice_contact: 'string',
  // BE3/C3: the PARENT property/building group id (byProperty GSI hash). WRITABLE
  // so the related-units `same_property` branch is reachable through the API
  // (create/PATCH), not only via seeded fakes — without this it'd be permanently
  // empty in production. A plain string id; the sparse GSI only indexes units
  // that carry it.
  propertyId: 'string',
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/**
 * Validate a units request body against the strict field allowlist. `create`
 * additionally requires a non-empty landlordId. Unknown keys are rejected (not
 * silently dropped) so a typo'd field surfaces instead of vanishing. Returns
 * the cleaned field map (only present, valid fields) or an error message.
 */
export function validateUnitBody(body: unknown, mode: 'create' | 'update'): UnitValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const fields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(b)) {
    const kind = WRITABLE_FIELDS[key];
    if (kind === undefined) {
      return { ok: false, error: `unknown field: ${key}` };
    }
    if (value === undefined) continue;
    switch (kind) {
      case 'string':
        if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` };
        break;
      case 'number':
        if (!isFiniteNumber(value)) return { ok: false, error: `${key} must be a number` };
        if (value < 0) return { ok: false, error: `${key} must be >= 0` };
        break;
      case 'boolean':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
        break;
      case 'string[]':
        if (!isStringArray(value)) return { ok: false, error: `${key} must be an array of strings` };
        break;
      case 'pets':
        if (typeof value !== 'string' && typeof value !== 'boolean') {
          return { ok: false, error: 'pets must be a string or boolean' };
        }
        break;
      case 'tour_type': {
        // CLEAR-to-absent: '' or null -> null patch value so the repo REMOVEs
        // the attribute (no stray empty-string enum left behind). A real value
        // must be in the TourType union; anything else is a 400.
        if (value === '' || value === null) {
          fields[key] = null;
          continue;
        }
        if (!isTourType(value)) {
          return {
            ok: false,
            error: `${key} must be one of: self_guided, landlord_led, pm_team`,
          };
        }
        break;
      }
      case 'address': {
        // Structured Address object: only line1/line2/city/state/zip, each an
        // optional string within caps. Unknown keys / non-strings → 400. The
        // NORMALIZED (trimmed, empties dropped) address is what we store.
        const result = validateAddress(value, key);
        if (!result.ok) return { ok: false, error: result.error };
        fields[key] = result.address;
        continue;
      }
    }
    fields[key] = value;
  }

  if (mode === 'create') {
    const landlordId = fields['landlordId'];
    if (typeof landlordId !== 'string' || landlordId.length === 0) {
      return { ok: false, error: 'landlordId is required (the owning landlord contactId)' };
    }
  } else if (Object.keys(fields).length === 0) {
    return { ok: false, error: 'no updatable fields supplied' };
  }

  return { ok: true, fields };
}

/**
 * The public flyer projection - EVERYTHING a flyer link exposes, shown upfront
 * (flyer-full-info 2026-07-16: the teaser/reveal split is gone). This is an
 * allowlist (build up), never a denylist (strip down): a future internal field
 * added to UnitItem can NEVER leak, because it simply won't be copied here.
 * NEVER include tour_process, tour_type, application_process, landlordId,
 * primary_voice_contact, notes, internal status/status_source, payment_standard,
 * lif, priority, propertyId, jurisdiction, final_rent, voucher_size_accepted.
 */
export interface UnitFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  subzone: string | null;
  /** Voucher size the unit is sized for - derived from beds (shareable). */
  voucher_size: number | null;
  accepted_programs: string[];
  listing_link: string | null;
  rent_min: number | null;
  rent_max: number | null;
  /** The structured postal address (allowlisted sub-fields only). */
  address: Address;
  /** Tenant-paid utilities (which utilities the tenant pays). */
  utilities: string | null;
  /** Tour video link. */
  video_url: string | null;
  /** Application fee in dollars. */
  application_fee: number | null;
  /** Same-day RTA available. */
  same_day_rta: boolean | null;
  /** Pet policy - free-form string, or a bare boolean (allowed / not allowed). */
  pets: string | boolean | null;
  /** Accessibility notes (tenant-useful, staff-authored). */
  accessibility: string | null;
  /** Security deposit in dollars. */
  deposit: number | null;
  /** Lease terms - free-form ("12-month minimum, month-to-month after"). */
  lease_terms: string | null;
}

export function toUnitFlyer(unit: UnitItem): UnitFlyer {
  // voucher_size: a unit's bedroom count IS the voucher size it serves. The
  // address is re-validated through the SAME write-surface validator so the
  // projection carries ONLY allowlisted sub-fields, never a legacy string blob.
  const beds = isFiniteNumber(unit.beds) ? unit.beds : null;
  const addr = validateAddress(unit.address, 'address');
  return {
    unitId: unit.unitId,
    media: isStringArray(unit.media) ? unit.media : [],
    beds,
    baths: isFiniteNumber(unit.baths) ? unit.baths : null,
    area: typeof unit.area === 'string' ? unit.area : null,
    subzone: typeof unit.subzone === 'string' ? unit.subzone : null,
    voucher_size: beds,
    accepted_programs: isStringArray(unit.accepted_programs) ? unit.accepted_programs : [],
    listing_link: typeof unit.listing_link === 'string' ? unit.listing_link : null,
    rent_min: isFiniteNumber(unit.rent_min) ? unit.rent_min : null,
    rent_max: isFiniteNumber(unit.rent_max) ? unit.rent_max : null,
    address: addr.ok ? addr.address : {},
    utilities: typeof unit.utilities === 'string' ? unit.utilities : null,
    video_url: typeof unit.video_url === 'string' ? unit.video_url : null,
    application_fee: isFiniteNumber(unit.application_fee) ? unit.application_fee : null,
    same_day_rta: typeof unit.same_day_rta === 'boolean' ? unit.same_day_rta : null,
    pets: typeof unit.pets === 'string' || typeof unit.pets === 'boolean' ? unit.pets : null,
    accessibility: typeof unit.accessibility === 'string' ? unit.accessibility : null,
    deposit: isFiniteNumber(unit.deposit) ? unit.deposit : null,
    lease_terms: typeof unit.lease_terms === 'string' ? unit.lease_terms : null,
  };
}
