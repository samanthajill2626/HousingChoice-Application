// WP1 B2a S3.1 (spec D2.1, D2.4; charter 6.1; plan PR3, WI4): classification
// as code. Fails when a stored attribute of a tenant contact or a unit is
// neither included nor excluded, read from the three sources spec D2.4 names:
// 1. the TYPE level - cardFields.ts writes each registry literal
//    `satisfies Record<declared keys + untyped keys, CardFieldUse>`, so a new
//    declared attribute fails `npm run typecheck` (S3.12 Step 2). No runtime
//    test can see that, and this file holds no type pin (one would be a
//    tautology: the registry key types contain the declared keys by
//    construction);
// 2. the WRITERS' keys - none of the writers exports its list, so each is read
//    by a source-text scan (the tenantMatchingInputsReaders idiom); every key
//    found must be classified, and each scan must find a known minimum so a
//    pattern that silently matches nothing fails;
// 3. the SEED WORLDS - every tenant and unit attribute of the lean and full
//    profiles.
// Pure: it reads source files and builds the seed rows in memory.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REQUIREMENT_LANDLORD_KEYS, REQUIREMENT_UNIT_KEYS } from '../src/lib/requirements.js';
import { castItems } from '../src/lib/seed/cast.js';
import { SEED } from '../src/lib/seed/lean.js';
import { buildLiveStaticItems } from '../src/lib/seed/live.js';
import { matrixItems } from '../src/lib/seed/matrix.js';
import { TENANT_MATCHING_INPUTS } from '../src/lib/tenantMatchingInputs.js';
import { PROVENANCE_FIELDS } from '../src/services/extraction/schema.js';
import {
  EXCLUDED_REQUIREMENT_KEYS,
  LANDLORD_DEFAULT_KEYS,
  LANDLORD_FIELD_PREFIX,
  PROPERTY_CARD_FIELDS,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
  TENANT_CARD_FIELDS,
  UNCLASSIFIED_REASON,
  flagFieldLabel,
  includedFields,
  landlordTwin,
  matchingInputCardFields,
  requirementItemOfField,
  unclassifiedKeys,
  type CardFieldUse,
} from '../src/services/ranking/cardFields.js';

type Row = Record<string, unknown>;
type Tables = Readonly<Record<string, readonly Row[]>>;

// matrix and live are now-relative; a fixed instant makes them deterministic
// (the seedTenantMatchingInputs.test.ts idiom).
const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');
const LEAN: readonly Tables[] = [SEED];
const FULL: readonly Tables[] = [SEED, castItems(), matrixItems(FIXED_NOW), buildLiveStaticItems(FIXED_NOW)];

const TENANT: Readonly<Record<string, CardFieldUse>> = TENANT_CARD_FIELDS;
const PROPERTY: Readonly<Record<string, CardFieldUse>> = PROPERTY_CARD_FIELDS;

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const KEY = '[A-Za-z_][A-Za-z0-9_]*';

function source(...parts: string[]): string {
  return readFileSync(path.join(SRC, ...parts), 'utf8');
}

/** The text from `start` up to (not including) the first `end` after it. */
function slice(text: string, start: string, end: string | RegExp): string {
  const from = text.indexOf(start);
  if (from === -1) throw new Error(`anchor not found: ${start}`);
  const rest = text.slice(from + start.length);
  const to = typeof end === 'string' ? rest.indexOf(end) : rest.search(end);
  if (to === -1) throw new Error(`end anchor not found after: ${start}`);
  return text.slice(from, from + start.length + to);
}

function captures(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[1] as string);
}

function withoutLineComments(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function unique(keys: readonly string[]): string[] {
  return [...new Set(keys)].sort();
}

/** Keys a writer's source names that are not stored attributes. */
const NOT_ATTRIBUTES = new Set([
  // address sub-keys (the parser walks line1..zip inside `address`)
  'line1',
  'line2',
  'city',
  'state',
  'zip',
  // the "First Last - N Bed" convenience string, parsed into names
  'contactName',
  // stale-save guards, never stored (spec 3.9; D14.3)
  'staff_notes_expected_updated_at',
  'notes_expected_updated_at',
]);

function unclassifiedIn(keys: readonly string[], registry: Readonly<Record<string, CardFieldUse>>): string[] {
  return keys.filter((key) => !NOT_ATTRIBUTES.has(key) && !Object.hasOwn(registry, key));
}

function attributesOf(layers: readonly Tables[], table: string, keep: (row: Row) => boolean): string[] {
  const keys = new Set<string>();
  for (const tables of layers) {
    for (const row of tables[table] ?? []) {
      if (!keep(row)) continue;
      for (const key of Object.keys(row)) keys.add(key);
    }
  }
  return [...keys].sort();
}

const isTenantRow = (row: Row): boolean => row['type'] === 'tenant';
const anyRow = (): boolean => true;

describe('the registries (spec D2.1)', () => {
  it('every entry is an include with a label or an exclude with a reason, in ASCII', () => {
    for (const [name, registry] of [
      ['tenant', TENANT],
      ['property', PROPERTY],
    ] as const) {
      for (const [key, entry] of Object.entries(registry)) {
        const text = entry.use === 'include' ? entry.label : entry.reason;
        expect(text.trim().length, `${name}.${key}`).toBeGreaterThan(0);
        expect(text, `${name}.${key}`).toMatch(/^[\x20-\x7e]+$/);
      }
    }
  });

  it('the tenant card includes exactly the spec D2.1 fields, the matching inputs keyed by their list label', () => {
    expect(includedFields(TENANT).map(([key, field]) => [key, field.cardKey ?? key])).toEqual([
      ['firstName', 'firstName'],
      ['lastName', 'lastName'],
      ['status', 'status'],
      ['voucherSize', 'voucherSize'],
      ['housingAuthority', 'housingAuthority'],
      ['voucher_expiration_date', 'voucher_expiration_date'],
      ['rta_expiration_date', 'rta_expiration_date'],
      ['porting', 'porting'],
      ['address', 'address'],
      ['tenure', 'tenure'],
      ['pets', 'pets'],
      ['evictions', 'evictions'],
      ['preferences_notes', 'preferences_notes'],
      ['customFields', 'customFields'],
      ['created_at', 'created_at'],
      ['staff_notes', 'staff_notes'],
      ['notes', 'notes'],
      ...TENANT_MATCHING_INPUTS.filter((input) => input.source === 'field').map((input) => [input.key, input.label]),
    ]);
  });

  it('the matching inputs are mapped from the list by source, each with its excluded provenance key', () => {
    for (const input of TENANT_MATCHING_INPUTS) {
      expect(TENANT[input.key]?.use, input.key).toBe(input.source === 'field' ? 'include' : 'exclude');
      expect(TENANT[`${input.key}_source`]?.use).toBe('exclude');
    }
  });

  it('only an input whose source is `field` is included; one kept in Notes is excluded (spec D2.1)', () => {
    expect(
      matchingInputCardFields([
        { key: 'a_field', label: 'A field', source: 'field' },
        { key: 'a_note', label: 'A note', source: 'notes' },
      ]),
    ).toEqual({
      a_field: { use: 'include', label: 'A field', cardKey: 'A field' },
      a_field_source: { use: 'exclude', reason: 'provenance (charter 6.1)' },
      a_note: { use: 'exclude', reason: 'kept in the Notes box, which the card already carries (spec D2.1)' },
      a_note_source: { use: 'exclude', reason: 'provenance (charter 6.1)' },
    });
  });

  it('excludes every tenant attribute spec D2.1 names (WI4: notes_updated_at among them)', () => {
    const excluded = [
      'contactId', 'phone_ref', 'phone_ref_owner', 'email_ref', 'email_ref_owner', 'quo_contact_ids',
      'phone', 'phones', 'email', 'emails', 'lifEligible', 'relationships',
      'consent_method', 'consent_at', 'consent_version', 'consent_note', 'consent_captured_by', 'group_participation_at',
      'sms_opt_out', 'sms_unreachable', 'email_opt_out', 'email_unreachable', 'voice_opt_out',
      'status_source', 'park_reason', 'deleted_at', 'capture_source', 'captured_at', 'origin',
      'imported_from', 'imported_at', 'display_name', 'import_retract_started_at',
      'classification_revision', 'type', 'type_source', 'organization',
      'caseworker', 'caseworker_review', 'caseworker_conversion', 'agency', 'voucher_program',
      'ai_mode', 'lead_status', 'last_heard_from_at', 'last_reached_out_at',
      'staff_notes_updated_at', 'notes_updated_at',
      'unit_of_interest', 'housing_fair_welcomed', 'housing_fair_signup_v2',
      'contract_status', 'registered_landlord', 'rta_within_48h', 'pass_inspection_first_try',
      'income_includes_voucher', 'company', 'role', 'expected_rent', 'accepts_programs', 'lease_terms', 'pet_policy',
      ...REQUIREMENT_LANDLORD_KEYS,
    ];
    const wrong = excluded.filter((key) => TENANT[key]?.use !== 'exclude');
    expect(wrong).toEqual([]);
    expect(TENANT['notes_updated_at']?.use).toBe('exclude');
  });

  it('excludes every provenance key: each PROVENANCE_FIELDS `<field>_source`, status, type and capture source', () => {
    const keys = [...PROVENANCE_FIELDS.map((field) => `${field}_source`), 'status_source', 'type_source', 'capture_source'];
    expect(keys.filter((key) => TENANT[key]?.use !== 'exclude')).toEqual([]);
  });

  it('the property card includes exactly the spec D2.1 fields, keyed by attribute name', () => {
    expect(includedFields(PROPERTY).map(([key, field]) => [key, field.cardKey ?? key])).toEqual(
      [
        'address', 'status', 'beds', 'baths', 'area', 'subzone', 'rent_min', 'rent_max', 'final_rent',
        'payment_standard', 'utilities', 'accessibility', 'washer_dryer', 'same_day_rta', 'application_fee',
        'deposit', 'deposit_one_month', 'deposit_flexible', 'deposit_notes', 'no_pets', 'pets', 'pet_fee',
        'no_evictions_on_program', 'evictions_notes', 'qualifications', 'lease_terms', 'tour_type',
        'tour_process', 'application_process', 'notes', 'created_at',
      ].map((key) => [key, key]),
    );
  });

  it('excludes every property attribute spec D2.1 names: priority, credit, income, lif, ids, people, media, tombstones, legacy', () => {
    const excluded = [
      'priority', 'credit_requirements', 'income_requirements', 'lif', 'unitId', 'landlordId', 'propertyId',
      'contacts', 'primary_contact', 'media', 'listing_link', 'video_url', 'requirement_sources', 'status_source',
      'jurisdiction', 'accepted_programs', 'imported_from', 'imported_at', 'imported_landlord_name',
      'bedrooms', 'bathrooms', 'deleted_at', 'updated_at', 'voucher_size_accepted', 'accepted_authorities',
    ];
    expect(excluded.filter((key) => PROPERTY[key]?.use !== 'exclude')).toEqual([]);
  });

  it('names the requirement keys a card may carry and the free-text fields a flag may name (spec D5)', () => {
    expect(EXCLUDED_REQUIREMENT_KEYS).toEqual(['credit_requirements', 'income_requirements']);
    expect(RANKED_REQUIREMENT_KEYS).toEqual(REQUIREMENT_UNIT_KEYS.filter((key) => !EXCLUDED_REQUIREMENT_KEYS.includes(key)));
    expect(PROPERTY_FREE_TEXT_FIELDS).toEqual([
      'notes', 'lease_terms', 'application_process', 'qualifications', 'evictions_notes', 'pets', 'pet_fee',
      'deposit_notes', 'tour_process', 'utilities', 'accessibility',
    ]);
    for (const field of PROPERTY_FREE_TEXT_FIELDS) expect(PROPERTY[field]?.use, field).toBe('include');
    expect(LANDLORD_FIELD_PREFIX).toBe('landlord:');
    expect(landlordTwin('qualifications')).toBe('landlord:qualifications');
    expect(LANDLORD_DEFAULT_KEYS).toEqual([...RANKED_REQUIREMENT_KEYS, 'notes']);
  });

  it('PR29 / PR33: groups a card field by its requirement item, a landlord twin included; credit, income and non-requirement fields have none', () => {
    expect(['no_pets', 'pets', 'pet_fee', 'landlord:pet_fee'].map(requirementItemOfField)).toEqual(['pets', 'pets', 'pets', 'pets']);
    expect(['no_evictions_on_program', 'evictions_notes'].map(requirementItemOfField)).toEqual(['evictions', 'evictions']);
    expect(['deposit_one_month', 'deposit', 'tour_type', 'qualifications'].map(requirementItemOfField)).toEqual([
      'deposit',
      'deposit',
      'touring',
      'qualifications',
    ]);
    expect(['credit_requirements', 'income_requirements', 'notes', 'landlord:notes', 'lease_terms'].map(requirementItemOfField)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('writer keys are classified (spec D2.4 source 2)', () => {
  it('the contacts PATCH and create parsers', () => {
    const contacts = source('routes', 'contacts.ts');
    const parsers = slice(contacts, 'function refuseServerOwnedFields(', 'export function createContactsRouter(');
    const keys = unique([
      ...captures(parsers, new RegExp(`'(${KEY})' in b\\b`, 'g')),
      ...captures(parsers, /for \(const key of \[([^\]]+)\]/g).flatMap((list) => captures(list, new RegExp(`'(${KEY})'`, 'g'))),
      ...captures(slice(contacts, 'const LANDLORD_BOOLEAN_FIELDS = [', ']'), new RegExp(`'(${KEY})'`, 'g')),
    ]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'firstName', 'lastName', 'voucherSize', 'notes', 'staff_notes', 'housingAuthority', 'agency', 'address',
        'customFields', 'relationships', 'pets', 'evictions', 'tenure', 'lifEligible', 'company', 'role',
        'consent_method', 'voucher_expiration_date', 'rta_within_48h',
      ]),
    );
    expect(unclassifiedIn(keys, TENANT)).toEqual([]);
  });

  it("the importer's contact writes", () => {
    const upsert = slice(source('lib', 'import', 'apply.ts'), 'async function upsertContact(', 'function pruneBindings<');
    const keys = unique([
      ...captures(upsert, new RegExp(`'(${KEY}) = `, 'g')),
      ...captures(upsert, new RegExp(`'#[A-Za-z_]+'\\] = '(${KEY})'`, 'g')),
      ...captures(upsert, new RegExp(`'#[A-Za-z_]+': '(${KEY})'`, 'g')),
    ]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'firstName', 'lastName', 'voucherSize', 'notes', 'housingAuthority', 'agency',
        'imported_from', 'imported_at', 'quo_contact_ids', 'type', 'status',
      ]),
    );
    expect(unclassifiedIn(keys, TENANT)).toEqual([]);
  });

  it("the importer's unit writes, the legacy bedrooms / bathrooms it removes included", () => {
    const upsert = slice(source('lib', 'import', 'apply.ts'), 'async function upsertUnit(', /\n(?:export )?(?:async )?function /);
    const keys = unique([
      ...captures(upsert, new RegExp(`'(${KEY}) = `, 'g')),
      ...captures(upsert, new RegExp(`'#[A-Za-z_]+'\\] = '(${KEY})'`, 'g')),
      ...captures(upsert, new RegExp(`'#[A-Za-z_]+': '(${KEY})'`, 'g')),
      ...captures(upsert, new RegExp(`fact\\('(${KEY})'`, 'g')),
      ...captures(upsert, new RegExp(`removes\\.push\\('(${KEY})'\\)`, 'g')),
    ]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'address', 'beds', 'baths', 'accepted_authorities', 'notes', 'landlordId', 'imported_landlord_name',
        'bedrooms', 'bathrooms', 'imported_from', 'imported_at', 'status',
      ]),
    );
    expect(unclassifiedIn(keys, PROPERTY)).toEqual([]);
  });

  it('public sign-up', () => {
    const pub = source('routes', 'public.ts');
    const create = withoutLineComments(slice(pub, 'contact = await contacts.create({', '\n      });'));
    const keys = unique([
      ...create.split('\n').flatMap((line) => captures(line, new RegExp(`^\\s*(${KEY})\\s*[:,]`, 'g'))),
      ...captures(create, new RegExp(`&& \\{ (${KEY})\\s*[:}]`, 'g')),
      ...captures(pub, new RegExp(`contacts\\.update\\([^,()]+, \\{ (${KEY}):`, 'g')),
    ]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'firstName', 'lastName', 'voucherSize', 'housingAuthority', 'capture_source', 'captured_at',
        'unit_of_interest', 'housing_fair_welcomed', 'housing_fair_signup_v2', 'consent_version',
      ]),
    );
    expect(unclassifiedIn(keys, TENANT)).toEqual([]);
  });

  it('the units PATCH WRITABLE_FIELDS and its tombstones (lib/unitFields.ts)', () => {
    const fields = source('lib', 'unitFields.ts');
    const writable = slice(fields, 'const WRITABLE_FIELDS: Record<string, FieldKind> = {', '\n};');
    const keys = unique([
      ...writable.split('\n').flatMap((line) => captures(line, new RegExp(`^\\s*(${KEY}): '`, 'g'))),
      ...captures(slice(fields, 'const TOMBSTONED_FIELDS = new Set([', '])'), new RegExp(`'(${KEY})'`, 'g')),
    ]);
    expect(keys).toEqual(
      expect.arrayContaining(['address', 'beds', 'lif', 'priority', 'media', 'propertyId', 'washer_dryer', 'jurisdiction', 'accepted_programs']),
    );
    expect(unclassifiedIn(keys, PROPERTY)).toEqual([]);
  });
});

describe('seed-world attributes are classified (spec D2.4 source 3)', () => {
  it.each([
    ['lean', LEAN],
    ['full', FULL],
  ] as const)('%s: every tenant attribute', (_name, layers) => {
    expect(unclassifiedIn(attributesOf(layers, 'contacts', isTenantRow), TENANT)).toEqual([]);
  });

  it.each([
    ['lean', LEAN],
    ['full', FULL],
  ] as const)('%s: every unit attribute', (_name, layers) => {
    expect(unclassifiedIn(attributesOf(layers, 'units', anyRow), PROPERTY)).toEqual([]);
  });

  it('an attribute no decision names is excluded as unclassified and listed for the handback (spec D2.1)', () => {
    expect(attributesOf(FULL, 'contacts', isTenantRow)).toContain('move_in_date');
    expect(TENANT['move_in_date']).toEqual({ use: 'exclude', reason: UNCLASSIFIED_REASON });
    expect(unclassifiedKeys(TENANT)).toEqual(['move_in_date']);
    expect(unclassifiedKeys(PROPERTY)).toEqual([]);
  });
});

// Spec D10 rev 7 (charter item 16): the property page's fair-housing notice
// names an unlawful flag's field by its human label from this registry.
describe('flagFieldLabel', () => {
  it('names every free-text field an unlawful flag may name by its property card label', () => {
    for (const field of PROPERTY_FREE_TEXT_FIELDS) {
      const entry = PROPERTY_CARD_FIELDS[field as keyof typeof PROPERTY_CARD_FIELDS];
      expect(entry.use).toBe('include');
      expect(flagFieldLabel(field)).toBe((entry as Extract<CardFieldUse, { use: 'include' }>).label);
    }
    expect(flagFieldLabel('qualifications')).toBe('Qualifications');
    expect(flagFieldLabel('lease_terms')).toBe('Lease terms');
  });

  it('a landlord: flag names the landlord default in plain copy', () => {
    expect(flagFieldLabel(landlordTwin('qualifications'))).toBe('Qualifications (from the landlord)');
    expect(flagFieldLabel(landlordTwin('notes'))).toBe('Notes (from the landlord)');
  });

  it('a key the registry does not include reads as its words', () => {
    expect(flagFieldLabel('some_new_field')).toBe('some new field');
  });
});
