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
import { type UnitItem } from '../repos/unitsRepo.js';

/** Result of validating a units request body. */
export type UnitValidation =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; error: string };

type FieldKind = 'string' | 'number' | 'boolean' | 'string[]' | 'pets' | 'address';

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
  deposit: 'number',
  lif: 'number',
  // TENANT-PAID utilities (which utilities the tenant must pay) — free-form.
  utilities: 'string',
  accessibility: 'string',
  // Internal staff notes ("In-unit washer/dryer", "No dishwasher"). NEVER on
  // the flyer projections below — internal only.
  notes: 'string',
  pets: 'pets',
  priority: 'string',
  media: 'string[]',
  listing_link: 'string',
  // Public flyer details (public-pages §3): the richer reveal fields a flyer's
  // post-intake "full details" exposes. video_url is a tour video link;
  // application_fee is a dollar amount (the 'number' kind already enforces >= 0);
  // same_day_rta is a boolean badge ("same-day RTA available").
  video_url: 'string',
  application_fee: 'number',
  same_day_rta: 'boolean',
  // Landlord-onboarding: the voucher size the unit ACCEPTS — a stored, writable
  // number (>= 0), DISTINCT from `beds` and from the derived read-only
  // `voucher_size` flyer projection (a 3bd unit may accept a 2BR voucher). Feeds
  // matching. INTERNAL for Phase-1 (NOT on the flyer projection).
  voucher_size_accepted: 'number',
  tour_process: 'string',
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
 * The shareable flyer view of a unit — ONLY the default-safe fields a flyer
 * link is allowed to expose. This is an allowlist (build up), never a denylist
 * (strip down): a future internal field added to UnitItem can NEVER leak,
 * because it simply won't be copied here. NEVER include tour_process,
 * application_process, primary_voice_contact, landlordId, notes, internal
 * status, deposit/LIF, or payment_standard.
 */
export interface UnitFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  subzone: string | null;
  /** Voucher size the unit is sized for — derived from beds (shareable). */
  voucher_size: number | null;
  accepted_programs: string[];
  listing_link: string | null;
  /** Asking rent range — shareable (it's on the public listing anyway). */
  rent_min: number | null;
  rent_max: number | null;
}

/**
 * The post-intake "full details" reveal projection (public-pages §4) — the
 * teaser fields PLUS the richer set a tenant sees AFTER expressing interest:
 * address, utilities, video tour, application fee, same-day RTA. Still a STRICT
 * allowlist built UP from the teaser (never strip-down): a future internal field
 * on UnitItem can NEVER leak because it is simply not copied here. NEVER include
 * landlord/contact/internal fields (landlordId, primary_voice_contact,
 * tour_process, application_process, status, status_source, notes,
 * payment_standard, deposit, lif, propertyId, jurisdiction, priority,
 * accessibility, pets).
 */
export interface UnitFlyerDetails extends UnitFlyer {
  /** The structured postal address (allowlisted sub-fields only). */
  address: Address;
  /** Tenant-paid utilities (which utilities the tenant pays, e.g. "Electric and gas"). */
  utilities: string | null;
  /** Tour video link. */
  video_url: string | null;
  /** Application fee in dollars. */
  application_fee: number | null;
  /** Same-day RTA available. */
  same_day_rta: boolean | null;
}

export function toUnitFlyer(unit: UnitItem): UnitFlyer {
  // voucher_size: a unit's bedroom count IS the voucher size it serves (the
  // share-broadcast filters tenants by bedroom size). Derived from beds; null
  // when beds is unknown. accepted_programs is shareable (it's match criteria).
  const beds = isFiniteNumber(unit.beds) ? unit.beds : null;
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
  };
}

export function toUnitFlyerDetails(unit: UnitItem): UnitFlyerDetails {
  // Build UP from the teaser, then add ONLY the 5 reveal fields — never strip
  // down. The address is re-validated through the SAME write-surface validator
  // so the projection can carry ONLY the allowlisted sub-fields (line1/line2/
  // city/state/zip), never a stray key or a legacy plain-string blob.
  const addr = validateAddress(unit.address, 'address');
  return {
    ...toUnitFlyer(unit),
    address: addr.ok ? addr.address : {},
    utilities: typeof unit.utilities === 'string' ? unit.utilities : null,
    video_url: typeof unit.video_url === 'string' ? unit.video_url : null,
    application_fee: isFiniteNumber(unit.application_fee) ? unit.application_fee : null,
    same_day_rta: typeof unit.same_day_rta === 'boolean' ? unit.same_day_rta : null,
  };
}
