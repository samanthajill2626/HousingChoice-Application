// Unit field validation + the public flyer projection (M1.5). Kept in lib so
// BOTH the authenticated /api/units router and the public /public flyer route
// share ONE definition of "what a unit field is" and "what is safe to share" —
// the public-vs-internal split must never drift between the two surfaces.
//
// The allowlist is strict by design: a unit is a flexible document at rest, but
// the WRITE surface only accepts known fields with the right types, so a
// caller can never inject `tour_process` through an unexpected key or set a GSI
// key (status) to a non-string that would poison the index.
import { type Address, validateAddress } from './address.js';
import {
  REQUIREMENT_ITEMS,
  VOUCHER_SIZE_MAX,
  WASHER_DRYER_VALUES,
  normalizeRequirementValue,
  unitItemValue,
  type RequirementField,
} from './requirements.js';
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
  // spec 2026-10-20 D1: a requirement key, validated through its registry
  // kind (lib/requirements.ts normalizeRequirementValue).
  | 'requirement'
  // D3: trimmed text where '' or null REMOVEs (subzone).
  | 'clearable_string'
  // D3: one of WASHER_DRYER_VALUES; '' or null REMOVEs.
  | 'washer_dryer'
  // D4: the voucher sizes a property accepts, a list of integers 0..12.
  | 'voucher_sizes';

/**
 * The writable unit fields and their kinds. `accepted_authorities` is the
 * unit's accepted-authorities LIST (spec section 8); the retired `jurisdiction`
 * and `accepted_programs` keys it replaces are tombstoned below.
 * `landlordId` is required on create only
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
  address: 'address',
  // The decided model (spec section 8): the unit's accepted-authorities LIST -
  // one or more authorities whose vouchers the landlord takes. Replaces BOTH the
  // single `jurisdiction` string and the dissolved `accepted_programs` concept.
  accepted_authorities: 'string[]',
  beds: 'number',
  baths: 'number',
  area: 'string',
  // Staff-only sub-market code (Sam's codes, e.g. E8 or SE11; spec 2026-10-20
  // D3). NEVER on the flyer projection below; feeds the similar-properties score.
  subzone: 'clearable_string',
  // The asking rent range. Staff only since flyer-leads D1 (spec 2026-10-21):
  // NEVER on the flyer projection below. Still read by the [Rent] merge field
  // and the similar-properties rent score.
  rent_min: 'number',
  rent_max: 'number',
  // The accepted contract rent (Approval & Move-in). Writable in place at rent
  // acceptance; the acceptance move still writes it too. The 'number' kind
  // enforces finite & >= 0.
  final_rent: 'number',
  payment_standard: 'number',
  // Security deposit: the Deposit item's fixed amount in dollars (spec
  // 2026-10-20 D1: clearable money, null REMOVEs). Staff only since
  // flyer-leads D1 (spec 2026-10-21): NEVER on the flyer projection below.
  deposit: 'requirement',
  lif: 'number',
  // TENANT-PAID utilities (which utilities the tenant must pay) — free-form.
  utilities: 'string',
  // Accessibility notes. Staff only since flyer-leads D1 (spec 2026-10-21):
  // NEVER on the flyer projection below.
  accessibility: 'string',
  // Internal staff notes ("In-unit washer/dryer", "No dishwasher"). NEVER on
  // the flyer projection below - internal only.
  notes: 'string',
  // Lease terms - free-form per-unit fact ("12-month minimum, month-to-month
  // after"). Moved OFF the landlord contact 2026-07-10 (with pet policy /
  // accepted programs / expected rent - see GLOSSARY). Staff only since
  // flyer-leads D1 (spec 2026-10-21): NEVER on the flyer projection below.
  lease_terms: 'string',
  // The Pets item's details text (spec 2026-10-20 D1; trimmed, ''/null
  // REMOVE). A raw caller may still send a legacy bare boolean: it is stored
  // in the new shape at once (the 'pets' case below). Staff only since
  // flyer-leads D1 (spec 2026-10-21), like the whole Pets item.
  pets: 'pets',
  // WP1 B1 (spec 2026-10-26 D6): an on/off switch, the same_day_rta template
  // - true or false; a string (the retired free-form kind) is a 400. Off and
  // absent read the same: `unit.priority === true` is the only on test, so a
  // stored legacy string reads as off (production held none). Staff only:
  // NEVER on the flyer projection below, never a model input.
  priority: 'boolean',
  media: 'string[]',
  listing_link: 'string',
  // Public flyer fields (flyer-full-info): tenant-useful facts shown upfront on
  // the flyer projection. video_url is a tour video link; application_fee is a
  // requirement key (spec 2026-10-20 D1: clearable money in dollars, 0 = "No
  // application fee"); same_day_rta is a boolean badge ("same-day RTA
  // available") and keeps its strict boolean kind.
  video_url: 'string',
  application_fee: 'requirement',
  same_day_rta: 'boolean',
  // Landlord-onboarding: the voucher sizes the unit ACCEPTS - a stored LIST of
  // integer sizes 0..12 (spec 2026-10-20 D4), DISTINCT from `beds` (a 3bd unit
  // may accept only a 2BR voucher). Read it through `acceptedVoucherSizes`,
  // which reads a list or an older single number and falls back to `beds`.
  // The KEY never reaches the flyer; its VALUE drives the flyer's derived
  // `voucher_sizes` / `voucher_size`. null or [] REMOVEs it, so the unit falls
  // back to its beds again.
  voucher_size_accepted: 'voucher_sizes',
  // The Touring item (spec 2026-10-20 D1): tour process is trimmed text
  // (''/null REMOVE); tour type keeps its enum (self_guided / landlord_led /
  // pm_team; ''/null REMOVE, so no stray empty-string enum is stored). Both
  // INTERNAL - not on the flyer projections below.
  tour_process: 'requirement',
  tour_type: 'requirement',
  application_process: 'string',
  // The other requirement keys of the eight items (spec 2026-10-20 D1/D2;
  // deposit, pets, application_fee, tour_type and tour_process above are
  // requirement keys too). Kinds and flyer visibility live in the registry,
  // lib/requirements.ts: a checkbox stores true or REMOVEs on false/null, text
  // is trimmed and REMOVEs on ''/null.
  no_evictions_on_program: 'requirement',
  evictions_notes: 'requirement',
  credit_requirements: 'requirement',
  income_requirements: 'requirement',
  qualifications: 'requirement',
  no_pets: 'requirement',
  pet_fee: 'requirement',
  deposit_one_month: 'requirement',
  deposit_flexible: 'requirement',
  deposit_notes: 'requirement',
  // D3: hookups / included / none; '' or null REMOVEs (absent = Not recorded).
  // PUBLIC on the flyer.
  washer_dryer: 'washer_dryer',
  // primary_contact is deliberately NOT writable (primary-contact-integrity
  // spec 4.5, P2b): only the roster writes (unitsRepo addContact /
  // removeContact / restoreWithLandlord / handOffPrimaryFrom) set the scalar,
  // so a body carrying it is refused as an unknown field on create and PATCH.
  // BE3/C3: the PARENT property/building group id (byProperty GSI hash). WRITABLE
  // so the related-units `same_property` branch is reachable through the API
  // (create/PATCH), not only via seeded fakes — without this it'd be permanently
  // empty in production. A plain string id; the sparse GSI only indexes units
  // that carry it.
  propertyId: 'string',
};

/**
 * Retired writable keys: ACCEPTED and DISCARDED for one transition (spec section
 * 8). A hard removal would 400 through the unknown-key rejection below, and a
 * stale cached dashboard bundle must not fail its save. `jurisdiction` (the old
 * single string) and `accepted_programs` (the dissolved "program" concept, whose
 * HCV / Section 8 / VASH values are program-type labels, NOT authorities) are
 * both superseded by `accepted_authorities`. Stored values stay on the document
 * untouched and simply stop rendering; the tombstones themselves die with
 * docs/issues/retire-humanize-authority.md.
 */
const TOMBSTONED_FIELDS = new Set(['jurisdiction', 'accepted_programs']);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}

/** D4: one voucher size a property can record - an integer 0..VOUCHER_SIZE_MAX. */
function isVoucherSize(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VOUCHER_SIZE_MAX;
}

/** D3: a recorded washer / dryer value. */
function isWasherDryer(v: unknown): v is (typeof WASHER_DRYER_VALUES)[number] {
  return typeof v === 'string' && (WASHER_DRYER_VALUES as readonly string[]).includes(v);
}

/** The registry field behind a 'requirement' / 'pets' key (lib/requirements.ts). */
const REQUIREMENT_FIELD_BY_KEY: ReadonlyMap<string, RequirementField> = new Map(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((field) => [field.key, field] as const)),
);

function requirementField(key: string): RequirementField {
  const field = REQUIREMENT_FIELD_BY_KEY.get(key);
  if (field === undefined) throw new Error(`unitFields: ${key} is not a requirement key`);
  return field;
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
  // A tombstoned key COUNTS as supplied. Without this signal a body carrying only
  // retired keys would fall through to the no-updatable-fields 400 below, which is
  // exactly the stale-bundle save the tombstones exist to keep working. The route
  // answers the resulting ok-but-EMPTY field set with a 200 no-op instead.
  let sawTombstone = false;

  for (const [key, value] of Object.entries(b)) {
    if (TOMBSTONED_FIELDS.has(key)) {
      sawTombstone = true;
      continue;
    }
    // An OWN key of the allowlist only (code review RA-3): a bare
    // WRITABLE_FIELDS[key] is an inherited lookup, so `__proto__`, `toString`,
    // `constructor` ... would read as known fields - and assigning
    // fields['__proto__'] would set the PROTOTYPE of the validated fields.
    const kind = Object.hasOwn(WRITABLE_FIELDS, key) ? WRITABLE_FIELDS[key] : undefined;
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
      case 'voucher_sizes': {
        // spec 2026-10-20 D4: null or [] -> a null patch value (update REMOVEs,
        // create drops it), so the unit falls back to its beds; a bare integer
        // (a raw caller or an older dashboard bundle) is stored as a one-item
        // list; a list is stored de-duplicated and ascending. Anything else - a
        // non-integer, a size above 12, a string, a mixed or nested list - is a
        // 400 (which also stops the non-integer sizes the old number kind took).
        if (value === null) {
          fields[key] = null;
          continue;
        }
        const sizes: number[] = [];
        for (const size of Array.isArray(value) ? value : [value]) {
          if (!isVoucherSize(size)) {
            return { ok: false, error: `${key} must be an integer 0..${VOUCHER_SIZE_MAX} or a list of them` };
          }
          sizes.push(size);
        }
        const unique = [...new Set(sizes)].sort((x, y) => x - y);
        fields[key] = unique.length > 0 ? unique : null;
        continue;
      }
      case 'boolean':
        if (typeof value !== 'boolean') return { ok: false, error: `${key} must be a boolean` };
        break;
      case 'string[]':
        if (!isStringArray(value)) return { ok: false, error: `${key} must be an array of strings` };
        break;
      case 'pets': {
        // spec 2026-10-20 D1. A string (or null) is the Pets item's details
        // text. A LEGACY bare boolean (raw API callers only) MEANS what the read
        // interpretation says (lib/requirements.ts unitItemValue) and is stored
        // in the new shape at once: false -> no_pets true + details REMOVEd;
        // true -> no_pets REMOVEd + details "Allowed". Beside an explicit
        // no_pets the two could disagree, so that is a 400.
        if (typeof value === 'boolean') {
          if (b['no_pets'] !== undefined) {
            return { ok: false, error: 'pets: a boolean pets cannot be combined with no_pets' };
          }
          const meaning = unitItemValue({ pets: value }, 'pets');
          fields['no_pets'] = meaning['no_pets'] ?? null;
          fields['pets'] = meaning['pets'] ?? null;
          continue;
        }
        if (value !== null && typeof value !== 'string') {
          return { ok: false, error: 'pets must be a string, a boolean or null' };
        }
        const result = normalizeRequirementValue(requirementField(key), value, key);
        if (!result.ok) return result;
        fields[key] = result.value;
        continue;
      }
      case 'requirement': {
        // spec 2026-10-20 D1: the registry kind - a checkbox stores true or
        // REMOVEs on false/null; text is trimmed and REMOVEs on ''/null; money
        // is a finite number >= 0 or null (REMOVE); tour_type is the enum
        // (''/null REMOVE). The deposit conflict needs the stored record, so
        // the route checks it, not this pure validator.
        const result = normalizeRequirementValue(requirementField(key), value, key);
        if (!result.ok) return result;
        fields[key] = result.value;
        continue;
      }
      case 'clearable_string': {
        // spec 2026-10-20 D3 (subzone): trimmed text; '' or null REMOVEs.
        if (value === null) {
          fields[key] = null;
          continue;
        }
        if (typeof value !== 'string') return { ok: false, error: `${key} must be a string or null` };
        const trimmed = value.trim();
        fields[key] = trimmed.length > 0 ? trimmed : null;
        continue;
      }
      case 'washer_dryer':
        // spec 2026-10-20 D3: a recorded value; '' or null REMOVEs.
        if (value === '' || value === null) {
          fields[key] = null;
          continue;
        }
        if (!isWasherDryer(value)) {
          return { ok: false, error: `${key} must be one of: ${WASHER_DRYER_VALUES.join(', ')}` };
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
  } else if (Object.keys(fields).length === 0 && !sawTombstone) {
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
 * primary_contact, notes, internal status/status_source, payment_standard,
 * lif, priority, propertyId, final_rent, voucher_size_accepted, subzone (staff
 * only since spec 2026-10-20 D3), requirement_sources (server-owned, D5), or
 * the staff-only requirement keys no_evictions_on_program, evictions_notes,
 * credit_requirements, income_requirements, qualifications and deposit_notes.
 * Since flyer-leads D1 (spec 2026-10-21) also NEVER rent_min, rent_max,
 * lease_terms, accessibility, or any key of the Pets item (pets, no_pets,
 * pet_fee) or the Deposit item (deposit, deposit_one_month, deposit_flexible) -
 * see "Removed keys" below.
 * lib/requirements.ts records each requirement field's flyer visibility, and
 * the D10a parity walk (app/test/propertyFormFlyerParity.test.ts) fails when a
 * property-form tag disagrees with this projection.
 *
 * `jurisdiction` is DELIBERATELY off that never-list now (spec section 8). The
 * KEY is still absent, but on a legacy unit its VALUE ships as the single entry
 * of the synthesized `accepted_authorities` list below - it is that unit's only
 * authority datum, and walling it off would blank the public "Accepts:" line for
 * every pre-feature unit. Published on purpose: the line answers the tenant's
 * actual question ("will this home take MY voucher"). Do NOT "fix" this by
 * dropping the synthesis.
 *
 * `voucher_size_accepted` follows the same pattern: the KEY stays on the
 * never-list, but its VALUE ships as the derived `voucher_sizes` (and its
 * first size as `voucher_size`; see `acceptedVoucherSizes`), because the
 * flyer's "Fits a ... voucher" line must state the sizes the property actually
 * takes, not its bedroom count.
 *
 * Older bundles (spec 2026-10-20 D11): a flyer page loaded before #12 reads
 * `voucher_size` and `application_fee`, so the projection keeps those keys.
 *
 * Removed keys (flyer-leads D1, spec 2026-10-21). The projection used to only
 * ADD keys. It now deliberately REMOVES ten: rent_min, rent_max, lease_terms,
 * accessibility, pets, no_pets, pet_fee, deposit, deposit_one_month and
 * deposit_flexible - Sam talks rent, lease terms, accessibility, pets and the
 * deposit through with each tenant instead of publishing them. The keys are
 * ABSENT, never null: "off the flyer" means the public endpoint never returns
 * them. This is safe for old flyer pages: an old bundle fed the new payload
 * would crash on render (its textOrNull(undefined).trim() throws - a white
 * page, never a stray value), but it is never fed it - the page fetches once
 * on load and nothing caches the bundle (the app container serves the
 * dashboard and CloudFront does not cache the default behavior), so the load
 * that fetches the new payload also brings the new bundle. Add no
 * compatibility code for the old page. Removing any OTHER key needs the same
 * argument recorded here.
 */
export interface UnitFlyer {
  unitId: string;
  media: string[];
  beds: number | null;
  baths: number | null;
  area: string | null;
  /** The FIRST of `voucher_sizes`, or null. Kept for a flyer page loaded
   *  before #12 (spec 2026-10-20 D11), which reads this one size. */
  voucher_size: number | null;
  /** Every voucher size the unit takes, ascending (spec 2026-10-20 D11): its
   *  recorded sizes, else its beds (see acceptedVoucherSizes). On the public flyer. */
  voucher_sizes: number[];
  /** The authorities whose vouchers this unit accepts (synthesized - see authoritiesOf). */
  accepted_authorities: string[];
  listing_link: string | null;
  /** The structured postal address (allowlisted sub-fields only). */
  address: Address;
  /** Tenant-paid utilities (which utilities the tenant pays). */
  utilities: string | null;
  /** Tour video link. */
  video_url: string | null;
  /** Application fee in dollars; 0 = "No application fee" (spec D11). */
  application_fee: number | null;
  /** Same-day RTA available. */
  same_day_rta: boolean | null;
  /** Washer / dryer (spec D3): hookups, included or none; null when not recorded. */
  washer_dryer: (typeof WASHER_DRYER_VALUES)[number] | null;
}

/**
 * Read-time synthesis of a unit's accepted authorities (spec section 8) - there
 * is NO backfill, so every stored legacy unit keeps working. The new
 * `accepted_authorities` list wins whenever it is stored, INCLUDING when it is
 * empty (an empty stored list means "cleared"; falling back there would resurrect
 * the old jurisdiction value the operator just removed). Otherwise a legacy
 * non-empty `jurisdiction` string synthesizes a one-item list; otherwise [].
 *
 * Hand-mirrored on the dashboard side (dashboard/src/routes/listing/listingFormat.ts)
 * because no cross-workspace import exists - keep the two in step by hand.
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
 * THE voucher (bedroom) sizes a unit takes (Cameron, 2026-10-04 - see
 * documentation/GLOSSARY.md "voucher size of a property"):
 *
 *   1. its RECORDED `voucher_size_accepted`, when that holds at least one size -
 *      a LIST since tracker #12 (spec 2026-10-20 D4), or ONE number stored
 *      before it (never backfilled). A recorded size always wins: a 3-bed unit
 *      may take only a 2-BR voucher;
 *   2. otherwise its bedroom count (`beds`) - the import never writes the
 *      field, and a unit usually takes the voucher that matches its bedrooms;
 *   3. otherwise nothing (`[]`).
 *
 * Only finite numbers count; anything else - absent, NaN, a string, an empty or
 * junk list - records nothing at that step. Server code reads a unit's voucher
 * size ONLY through this function.
 *
 * Hand-mirrored as `acceptedVoucherSizes` in
 * dashboard/src/routes/listing/listingFormat.ts (no cross-workspace import
 * exists); this copy is the source of truth and both suites carry the same cases.
 */
export function acceptedVoucherSizes(unit: { voucher_size_accepted?: unknown; beds?: unknown }): number[] {
  const raw = unit.voucher_size_accepted;
  const recorded = Array.isArray(raw) ? raw.filter(isFiniteNumber) : isFiniteNumber(raw) ? [raw] : [];
  if (recorded.length > 0) return recorded;
  return isFiniteNumber(unit.beds) ? [unit.beds] : [];
}

export function toUnitFlyer(unit: UnitItem): UnitFlyer {
  // The address is re-validated through the SAME write-surface validator so the
  // projection carries ONLY allowlisted sub-fields, never a legacy string blob.
  const addr = validateAddress(unit.address, 'address');
  // spec 2026-10-20 D11: every size, ascending and de-duplicated (a legacy
  // stored list may be neither); voucher_size keeps the first for old pages.
  const voucherSizes = [...new Set(acceptedVoucherSizes(unit))].sort((x, y) => x - y);
  // The Application fee item through the D1 read interpretation (a negative or
  // non-number amount reads blank). Since flyer-leads D1 it is the only
  // requirement item on the flyer.
  const fee = unitItemValue(unit, 'application_fee')['application_fee'];
  return {
    unitId: unit.unitId,
    media: isStringArray(unit.media) ? unit.media : [],
    beds: isFiniteNumber(unit.beds) ? unit.beds : null,
    baths: isFiniteNumber(unit.baths) ? unit.baths : null,
    area: typeof unit.area === 'string' ? unit.area : null,
    voucher_size: voucherSizes[0] ?? null,
    voucher_sizes: voucherSizes,
    accepted_authorities: authoritiesOf(unit),
    listing_link: typeof unit.listing_link === 'string' ? unit.listing_link : null,
    address: addr.ok ? addr.address : {},
    utilities: typeof unit.utilities === 'string' ? unit.utilities : null,
    video_url: typeof unit.video_url === 'string' ? unit.video_url : null,
    application_fee: typeof fee === 'number' ? fee : null,
    same_day_rta: typeof unit.same_day_rta === 'boolean' ? unit.same_day_rta : null,
    washer_dryer: isWasherDryer(unit.washer_dryer) ? unit.washer_dryer : null,
  };
}
