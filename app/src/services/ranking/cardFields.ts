// WP1 B2a (spec D2.1, D2.4; charter 6.1; plan PR3, WI4, WI8): classification as
// code. TENANT_CARD_FIELDS and PROPERTY_CARD_FIELDS name EVERY stored attribute
// of a tenant contact and of a unit, each `include` (with a label) or `exclude`
// (with a short charter citation). cards.ts copies only `include` keys, so an
// attribute nobody classified never reaches the model: an allowlist at runtime
// (charter 6.1). app/test/rankingCardFields.test.ts fails when a declared
// attribute, a writer's key or a seed-world attribute is in neither list.
//
// The tenant matching inputs (B1) are added by MAPPING over
// TENANT_MATCHING_INPUTS - this file never spells their keys (B1's reader test
// scans services/ranking) - and are keyed on the card by their list label.
// The property card is keyed by attribute name, because the output schema's
// requirement and flag-field enums name those attributes (spec D5).
import { REQUIREMENT_UNIT_KEYS, itemOfUnitKey, type RequirementItemId } from '../../lib/requirements.js';
import {
  TENANT_MATCHING_INPUTS,
  type TenantMatchingInput,
  type TenantMatchingInputKey,
} from '../../lib/tenantMatchingInputs.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';

/** The declared keys of a type that carries an index signature (the signature stripped). */
export type KnownKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

export type CardFieldUse =
  | { readonly use: 'include'; readonly label: string; readonly cardKey?: string }
  | { readonly use: 'exclude'; readonly reason: string };

export type IncludedField = Extract<CardFieldUse, { use: 'include' }>;

/** Spec D2.1: the reason on an attribute no decision names; listed in the handback. */
export const UNCLASSIFIED_REASON = 'unclassified at B2a';

const REASON = {
  ids: 'ids and references (charter 6.1)',
  contactPoints: 'phone numbers and email addresses (charter 6.1)',
  income: 'income (A1; charter 6.1)',
  creditIncome: 'credit and income (A1; charter 6.1)',
  people: "other people's data (charter 6.1)",
  consent: 'consent and reachability fields (charter 6.1)',
  plumbing: 'internal plumbing (charter 6.1)',
  imports: 'import bookkeeping (charter 6.1)',
  provenance: 'provenance (charter 6.1)',
  inNotes: 'kept in the Notes box, which the card already carries (spec D2.1)',
  timestamp: 'a timestamp; only created reaches a card (charter 6.1)',
  recency: 'replaced by the last heard from bucket (charter 9.1)',
  disability: 'can stand in for a disability (spec D2.1)',
  signup: 'public sign-up bookkeeping; a flyer sign-up reaches the card through properties seen (spec D2.1)',
  landlordOnly: 'a landlord or partner attribute (spec D2.1)',
  priority: 'priority is never a model input (charter 9.2)',
  lif: 'off the cards until Sam says what LIF is (spec Q4)',
  media: 'media and links (charter 6.1)',
  derived: 'read through a derived card field (spec D2.1)',
  legacy: 'a legacy or tombstoned attribute (charter 6.1)',
  authority:
    'the pool fences on housing authority; the model gets the per-pair authority fact (matched or unconfirmed) instead (charter 20 item 18)',
  nameAddress:
    "the tenant's name and current address are off the card: a candidate is named by its handle and area fit comes from Area preference (charter 20 item 19)",
} as const;

function include(label: string): CardFieldUse {
  return { use: 'include', label };
}

function exclude(reason: string): CardFieldUse {
  return { use: 'exclude', reason };
}

/** Tenant attributes the stores carry that ContactItem does not declare (it has an index signature). */
type UntypedTenantKey =
  | 'firstName'
  | 'lastName'
  | 'voucherSize'
  | 'housingAuthority'
  | 'address'
  | 'customFields'
  | 'notes'
  | 'preferences_notes'
  | 'rta_expiration_date'
  | 'relationships'
  | 'agency'
  | 'voucher_program'
  | 'caseworker'
  | 'quo_contact_ids'
  | 'imported_from'
  | 'imported_at'
  | 'display_name'
  | 'unit_of_interest'
  | 'housing_fair_welcomed'
  | 'housing_fair_signup_v2'
  | 'ai_mode'
  | 'lead_status'
  | 'company'
  | 'role'
  | 'expected_rent'
  | 'accepts_programs'
  | 'lease_terms'
  | 'pet_policy'
  | 'firstName_source'
  | 'lastName_source'
  | 'voucherSize_source'
  | 'housingAuthority_source'
  | 'pets_source'
  | 'evictions_source'
  | 'tenure_source'
  | 'porting_source'
  | 'address_source'
  | 'move_in_date';

type TenantBaseKey = Exclude<KnownKeys<ContactItem>, TenantMatchingInputKey> | UntypedTenantKey;
export type TenantCardKey = TenantBaseKey | TenantMatchingInputKey | `${TenantMatchingInputKey}_source`;

/** Unit attributes the stores carry that UnitItem does not declare. */
type UntypedUnitKey = 'bedrooms' | 'bathrooms' | 'imported_from' | 'imported_at' | 'imported_landlord_name';
export type PropertyCardKey = KnownKeys<UnitItem> | UntypedUnitKey;

const TENANT_BASE_FIELDS = {
  // Included (spec D2.1), in card order.
  firstName: exclude(REASON.nameAddress),
  lastName: exclude(REASON.nameAddress),
  status: include('Status'),
  voucherSize: include('Voucher size'),
  housingAuthority: exclude(REASON.authority),
  voucher_expiration_date: include('Voucher expiration'),
  rta_expiration_date: include('RTA expiration'),
  porting: include('Porting'),
  address: exclude(REASON.nameAddress),
  tenure: include('Time at current address'),
  pets: include('Pets'),
  evictions: include('Evictions'),
  preferences_notes: include('Preferences notes'),
  customFields: include('Custom fields'),
  created_at: include('Created'),
  staff_notes: include('Staff notes'),
  notes: include('Notes'),
  // Excluded (spec D2.1).
  contactId: exclude(REASON.ids),
  phone_ref: exclude(REASON.ids),
  phone_ref_owner: exclude(REASON.ids),
  email_ref: exclude(REASON.ids),
  email_ref_owner: exclude(REASON.ids),
  quo_contact_ids: exclude(REASON.ids),
  phone: exclude(REASON.contactPoints),
  phones: exclude(REASON.contactPoints),
  email: exclude(REASON.contactPoints),
  emails: exclude(REASON.contactPoints),
  lifEligible: exclude(REASON.income),
  relationships: exclude(REASON.people),
  organization: exclude(REASON.people),
  caseworker: exclude(REASON.people),
  caseworker_review: exclude(REASON.people),
  caseworker_conversion: exclude(REASON.people),
  consent_method: exclude(REASON.consent),
  consent_at: exclude(REASON.consent),
  consent_version: exclude(REASON.consent),
  consent_note: exclude(REASON.consent),
  consent_captured_by: exclude(REASON.consent),
  group_participation_at: exclude(REASON.consent),
  sms_opt_out: exclude(REASON.consent),
  sms_unreachable: exclude(REASON.consent),
  email_opt_out: exclude(REASON.consent),
  email_unreachable: exclude(REASON.consent),
  voice_opt_out: exclude(REASON.consent),
  type: exclude(REASON.plumbing),
  classification_revision: exclude(REASON.plumbing),
  deleted_at: exclude(REASON.plumbing),
  capture_source: exclude(REASON.plumbing),
  captured_at: exclude(REASON.plumbing),
  origin: exclude(REASON.plumbing),
  ai_mode: exclude(REASON.plumbing),
  lead_status: exclude(REASON.plumbing),
  imported_from: exclude(REASON.imports),
  imported_at: exclude(REASON.imports),
  display_name: exclude(REASON.imports),
  import_retract_started_at: exclude(REASON.imports),
  status_source: exclude(REASON.provenance),
  type_source: exclude(REASON.provenance),
  firstName_source: exclude(REASON.nameAddress),
  lastName_source: exclude(REASON.nameAddress),
  voucherSize_source: exclude(REASON.provenance),
  housingAuthority_source: exclude(REASON.provenance),
  pets_source: exclude(REASON.provenance),
  evictions_source: exclude(REASON.provenance),
  tenure_source: exclude(REASON.provenance),
  porting_source: exclude(REASON.provenance),
  address_source: exclude(REASON.nameAddress),
  last_heard_from_at: exclude(REASON.recency),
  last_reached_out_at: exclude(REASON.timestamp),
  staff_notes_updated_at: exclude(REASON.timestamp),
  notes_updated_at: exclude(REASON.timestamp),
  agency: exclude(REASON.disability),
  voucher_program: exclude(REASON.disability),
  unit_of_interest: exclude(REASON.signup),
  housing_fair_welcomed: exclude(REASON.signup),
  housing_fair_signup_v2: exclude(REASON.signup),
  park_reason: exclude(REASON.landlordOnly),
  contract_status: exclude(REASON.landlordOnly),
  registered_landlord: exclude(REASON.landlordOnly),
  rta_within_48h: exclude(REASON.landlordOnly),
  pass_inspection_first_try: exclude(REASON.landlordOnly),
  income_includes_voucher: exclude(REASON.landlordOnly),
  company: exclude(REASON.landlordOnly),
  role: exclude(REASON.landlordOnly),
  expected_rent: exclude(REASON.landlordOnly),
  accepts_programs: exclude(REASON.landlordOnly),
  lease_terms: exclude(REASON.landlordOnly),
  pet_policy: exclude(REASON.landlordOnly),
  req_no_evictions_on_program: exclude(REASON.landlordOnly),
  req_evictions_notes: exclude(REASON.landlordOnly),
  req_credit_requirements: exclude(REASON.landlordOnly),
  req_income_requirements: exclude(REASON.landlordOnly),
  req_qualifications: exclude(REASON.landlordOnly),
  req_no_pets: exclude(REASON.landlordOnly),
  req_pets: exclude(REASON.landlordOnly),
  req_pet_fee: exclude(REASON.landlordOnly),
  req_deposit_one_month: exclude(REASON.landlordOnly),
  req_deposit: exclude(REASON.landlordOnly),
  req_deposit_flexible: exclude(REASON.landlordOnly),
  req_deposit_notes: exclude(REASON.landlordOnly),
  req_application_fee: exclude(REASON.landlordOnly),
  req_tour_type: exclude(REASON.landlordOnly),
  req_tour_process: exclude(REASON.landlordOnly),
  // Seen in the seed worlds, named by no decision (spec D2.1 default).
  move_in_date: exclude(UNCLASSIFIED_REASON),
} satisfies Record<TenantBaseKey, CardFieldUse>;

/**
 * Spec D2.1 (FB3): the matching-input entries of the tenant registry, from a
 * list. An entry whose source is `field` is included under its list label;
 * any other source keeps the fact in the Notes box, which the card already
 * carries, so its stored attribute is excluded. Every `<key>_source`
 * provenance key is excluded. Exported so the test can feed a list holding a
 * `notes` entry.
 */
export function matchingInputCardFields(
  inputs: readonly Pick<TenantMatchingInput, 'key' | 'label' | 'source'>[],
): Record<string, CardFieldUse> {
  return Object.fromEntries(
    inputs.flatMap((input): [string, CardFieldUse][] => [
      [
        input.key,
        input.source === 'field' ? { use: 'include', label: input.label, cardKey: input.label } : exclude(REASON.inNotes),
      ],
      [`${input.key}_source`, exclude(REASON.provenance)],
    ]),
  );
}

const TENANT_MATCHING_INPUT_FIELDS = matchingInputCardFields(TENANT_MATCHING_INPUTS) as Record<
  TenantMatchingInputKey | `${TenantMatchingInputKey}_source`,
  CardFieldUse
>;

export const TENANT_CARD_FIELDS: Readonly<Record<TenantCardKey, CardFieldUse>> = Object.freeze({
  ...TENANT_BASE_FIELDS,
  ...TENANT_MATCHING_INPUT_FIELDS,
});

export const PROPERTY_CARD_FIELDS: Readonly<Record<PropertyCardKey, CardFieldUse>> = Object.freeze({
  // Included (spec D2.1), in card order.
  address: include('Address'),
  status: include('Status'),
  beds: include('Bedrooms'),
  baths: include('Bathrooms'),
  area: include('Area'),
  subzone: include('Subzone'),
  rent_min: include('Rent minimum'),
  rent_max: include('Rent maximum'),
  final_rent: include('Final rent'),
  payment_standard: include('Payment standard'),
  utilities: include('Tenant-paid utilities'),
  accessibility: include('Accessibility'),
  washer_dryer: include('Washer / dryer'),
  same_day_rta: include('Same-day RTA'),
  application_fee: include('Application fee'),
  deposit: include('Deposit'),
  deposit_one_month: include("One month's rent"),
  deposit_flexible: include('Deposit flexible'),
  deposit_notes: include('Deposit notes'),
  no_pets: include('No pets'),
  pets: include('Pets (details)'),
  pet_fee: include('Pet fee'),
  no_evictions_on_program: include('No evictions while on the program'),
  evictions_notes: include('Evictions (details)'),
  qualifications: include('Qualifications'),
  lease_terms: include('Lease terms'),
  tour_type: include('Tour type'),
  tour_process: include('Tour process'),
  application_process: include('Application process'),
  notes: include('Notes'),
  created_at: include('Created'),
  // Excluded (spec D2.1).
  unitId: exclude(REASON.ids),
  landlordId: exclude(REASON.ids),
  propertyId: exclude(REASON.ids),
  priority: exclude(REASON.priority),
  credit_requirements: exclude(REASON.creditIncome),
  income_requirements: exclude(REASON.creditIncome),
  lif: exclude(REASON.lif),
  contacts: exclude(REASON.people),
  primary_contact: exclude(REASON.people),
  media: exclude(REASON.media),
  listing_link: exclude(REASON.media),
  video_url: exclude(REASON.media),
  status_source: exclude(REASON.provenance),
  requirement_sources: exclude(REASON.provenance),
  jurisdiction: exclude(REASON.legacy),
  accepted_programs: exclude(REASON.legacy),
  bedrooms: exclude(REASON.legacy),
  bathrooms: exclude(REASON.legacy),
  imported_from: exclude(REASON.imports),
  imported_at: exclude(REASON.imports),
  imported_landlord_name: exclude(REASON.imports),
  deleted_at: exclude(REASON.plumbing),
  updated_at: exclude(REASON.timestamp),
  voucher_size_accepted: exclude(REASON.derived),
  accepted_authorities: exclude(REASON.authority),
} satisfies Record<PropertyCardKey, CardFieldUse>);

/** Never on a card and never reported failed (A1, charter 7.2). */
export const EXCLUDED_REQUIREMENT_KEYS: readonly string[] = Object.freeze(['credit_requirements', 'income_requirements']);

/** The requirement keys a card may carry, in registry order (spec D5's requirement enum). */
export const RANKED_REQUIREMENT_KEYS: readonly string[] = Object.freeze(
  REQUIREMENT_UNIT_KEYS.filter((key) => !EXCLUDED_REQUIREMENT_KEYS.includes(key)),
);

/** Spec D5: the free-text property fields - the only fields an unlawful flag may name. */
export const PROPERTY_FREE_TEXT_FIELDS: readonly string[] = Object.freeze([
  'notes',
  'lease_terms',
  'application_process',
  'qualifications',
  'evictions_notes',
  'pets',
  'pet_fee',
  'deposit_notes',
  'tour_process',
  'utilities',
  'accessibility',
]);

/** Spec D5: a landlord default's field is named `landlord:<key>` (switch on). */
export const LANDLORD_FIELD_PREFIX = 'landlord:';

/** PR33: a key's landlord-default twin, `landlord:<key>`. */
export function landlordTwin(key: string): string {
  return `${LANDLORD_FIELD_PREFIX}${key}`;
}

/**
 * Spec D10 rev 7 (charter item 16): an unlawful flag's field in staff copy,
 * for the property page's notice - its property card label from
 * PROPERTY_CARD_FIELDS; a `landlord:<key>` flag names the landlord default,
 * "<label> (from the landlord)". A key the registry does not include reads
 * as its words (never expected: parse admits only the free-text fields).
 */
export function flagFieldLabel(field: string): string {
  const fromLandlord = field.startsWith(LANDLORD_FIELD_PREFIX);
  const key = fromLandlord ? field.slice(LANDLORD_FIELD_PREFIX.length) : field;
  const entry = (PROPERTY_CARD_FIELDS as Readonly<Record<string, CardFieldUse | undefined>>)[key];
  const label = entry?.use === 'include' ? entry.label : key.replace(/_/g, ' ');
  return fromLandlord ? `${label} (from the landlord)` : label;
}

/** PR33: the keys a card's landlord defaults may carry - the ranked requirement keys and the landlord contact's notes. */
export const LANDLORD_DEFAULT_KEYS: readonly string[] = Object.freeze([...RANKED_REQUIREMENT_KEYS, 'notes']);

/**
 * PR29 / PR33: the requirement ITEM a card field belongs to - a ranked unit
 * requirement key, or its `landlord:` twin - from the requirements registry
 * (lib/requirements.ts itemOfUnitKey). The keys of one item (no_pets, pets,
 * pet_fee) group together, which is how capOf matches an ACCOMMODATION flag on
 * any key of the item (PR29 as amended by PR40, PR45). An unlawful flag is
 * never grouped: it matches only its own field, `landlord:<key>` read as
 * `<key>` (PR40). Undefined for credit, income and every non-requirement
 * field.
 */
export function requirementItemOfField(field: string): RequirementItemId | undefined {
  const key = field.startsWith(LANDLORD_FIELD_PREFIX) ? field.slice(LANDLORD_FIELD_PREFIX.length) : field;
  if (!RANKED_REQUIREMENT_KEYS.includes(key)) return undefined;
  return itemOfUnitKey(key)?.id;
}

/** The included entries, in registry order. */
export function includedFields(registry: Readonly<Record<string, CardFieldUse>>): [string, IncludedField][] {
  const out: [string, IncludedField][] = [];
  for (const [key, entry] of Object.entries(registry)) {
    if (entry.use === 'include') out.push([key, entry]);
  }
  return out;
}

/** The attributes excluded only because no decision names them (spec D2.1: listed in the handback). */
export function unclassifiedKeys(registry: Readonly<Record<string, CardFieldUse>>): string[] {
  return Object.entries(registry)
    .filter(([, entry]) => entry.use === 'exclude' && entry.reason === UNCLASSIFIED_REASON)
    .map(([key]) => key);
}
