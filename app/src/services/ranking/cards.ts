// WP1 B2a (spec D2.1-D2.3; charter 6.1-6.2; plan PR3, PR7, WI12): THE two card
// builders. propertyCard and tenantCard are the ONLY functions that turn a
// record into what the model reads; the ranking job, the ranking read, the
// counterfactual check and every seen home call them (charter 6.2: one card
// per record, whichever side of the ranking it is on). Both are PURE;
// assemble.ts gathers their inputs.
//
// A card copies only the attributes cardFields.ts classifies `include` - an
// allowlist at runtime (charter 6.1) - in registry order, so the same record
// always serializes to the same bytes (spec D2.2). Free text is trimmed and
// otherwise passed as stored; an empty value is left off; nested objects are
// written with sorted keys (an address in its fixed part order). Requirement
// items are read through unitItemValue, so a legacy boolean `pets` reads as
// the No pets checkbox it means, for the card, the facts, completeness and
// the cap alike (spec D2.1).
import type { OrgEntry } from '../../lib/orgNames.js';
import { REQUIREMENT_ITEMS, isItemBlank, itemOfUnitKey, landlordItemValue, unitItemValue } from '../../lib/requirements.js';
import { authoritiesOf } from '../../lib/unitFields.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import {
  EXCLUDED_REQUIREMENT_KEYS,
  PROPERTY_CARD_FIELDS,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
  includedFields,
  landlordTwin,
} from './cardFields.js';
import { mapAuthorities, recordedVoucherSizes, unitVoucherSizes } from './pool.js';
import type { Card } from './types.js';

export interface PropertyCardCtx {
  /** The organization list read once for this ranking (spec D1). */
  orgEntries: readonly OrgEntry[];
  /** RANKING_LANDLORD_CARD (spec D2.1). Off: nothing of the landlord's is read. */
  landlordCard: boolean;
  /** The landlord of record (`landlordId`), read only while the switch is on; null or absent = none on file. */
  landlord?: ContactItem | null;
}

/** What the cap (D9) and the unlawful-flag check (D10) read of a property's CURRENT card. */
export interface PropertyFacts {
  /** Requirement keys recorded on the card (a landlord default counts, switch on), registry order. */
  recordedRequirementKeys: string[];
  /** Each free-text field's trimmed text on the card; landlord defaults as `landlord:<key>`. */
  freeTextByField: Record<string, string>;
}

export const LANDLORD_DEFAULTS_KEY = 'landlordDefaults';

const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(RANKED_REQUIREMENT_KEYS);
const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(PROPERTY_FREE_TEXT_FIELDS);
/** The requirement items a card may carry: every item but credit and income (A1). */
const RANKED_ITEMS = REQUIREMENT_ITEMS.filter((item) =>
  item.fields.every((field) => !EXCLUDED_REQUIREMENT_KEYS.includes(field.key)),
);
const ADDRESS_PARTS = ['line1', 'line2', 'city', 'state', 'zip'] as const;

/** Trimmed text, finite numbers, booleans, and arrays / objects of them; undefined = leave off. */
function cleanValue(raw: unknown): unknown {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw)) {
    const out = raw.map(cleanValue).filter((value) => value !== undefined);
    return out.length > 0 ? out : undefined;
  }
  if (raw !== null && typeof raw === 'object') {
    const source = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const value = cleanValue(source[key]);
      if (value !== undefined) out[key] = value;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

/** An address whole: the structured parts in their fixed order, or a legacy string as stored. */
function cleanAddress(raw: unknown): unknown {
  if (typeof raw === 'string') return cleanValue(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const part of ADDRESS_PARTS) {
    const value = cleanValue(source[part]);
    if (typeof value === 'string') out[part] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** `created_at` as a date (YYYY-MM-DD); any other text as stored. */
function dateOnly(raw: unknown): string | undefined {
  const value = cleanValue(raw);
  if (typeof value !== 'string') return undefined;
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
}

/** A stored attribute's card value. */
function storedValue(key: string, raw: unknown): unknown {
  if (key === 'address') return cleanAddress(raw);
  if (key === 'created_at') return dateOnly(raw);
  return cleanValue(raw);
}

/** A requirement key's value through unitItemValue; undefined when blank. */
function requirementValue(unit: UnitItem, key: string): string | number | true | undefined {
  const item = itemOfUnitKey(key);
  if (item === undefined) return undefined;
  const value = unitItemValue(unit, item.id)[key];
  return value === null || value === undefined ? undefined : value;
}

/**
 * Spec D2.1, switch on: the landlord of record's requirement values (through
 * landlordItemValue, credit and income left out) for every item the PROPERTY
 * records nothing for - the property's own value wins - plus the landlord
 * contact's notes. Undefined when the switch is off, there is no landlord, or
 * nothing is left.
 */
export function landlordDefaults(unit: UnitItem, ctx: PropertyCardCtx): Record<string, string | number | true> | undefined {
  const landlord = ctx.landlord;
  if (!ctx.landlordCard || landlord === undefined || landlord === null) return undefined;
  const out: Record<string, string | number | true> = {};
  for (const item of RANKED_ITEMS) {
    if (!isItemBlank(unitItemValue(unit, item.id))) continue;
    const value = landlordItemValue(landlord, item.id);
    for (const field of item.fields) {
      const fieldValue = value[field.key];
      if (fieldValue !== null && fieldValue !== undefined) out[field.key] = fieldValue;
    }
  }
  const notes = cleanValue(landlord['notes']);
  if (typeof notes === 'string') out['notes'] = notes;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Spec D2.1: the property card - included attributes, then voucher sizes, authorities and (switch on) the landlord defaults. */
export function propertyCard(unit: UnitItem, ctx: PropertyCardCtx): Card {
  const card: Card = {};
  for (const [key, field] of includedFields(PROPERTY_CARD_FIELDS)) {
    const value = REQUIREMENT_KEYS.has(key) ? requirementValue(unit, key) : storedValue(key, unit[key]);
    if (value !== undefined) card[field.cardKey ?? key] = value;
  }
  // FB20: the pool's one normalizer - whole sizes, clamped to 4 (4 means 4 or more).
  const sizes = unitVoucherSizes(unit);
  card['voucherSizes'] = sizes;
  card['voucherSizesInferredFromBeds'] = recordedVoucherSizes(unit).length === 0 && sizes.length > 0;
  card['authorities'] = mapAuthorities(ctx.orgEntries, authoritiesOf(unit));
  const defaults = landlordDefaults(unit, ctx);
  if (defaults !== undefined) card[LANDLORD_DEFAULTS_KEY] = defaults;
  return card;
}

/** Spec D2.1, D5, D9, D10: the recorded requirement keys and the free-text fields of the CURRENT card. */
export function propertyFacts(unit: UnitItem, ctx: PropertyCardCtx): PropertyFacts {
  const defaults = landlordDefaults(unit, ctx) ?? {};
  const recordedRequirementKeys = RANKED_REQUIREMENT_KEYS.filter(
    (key) => requirementValue(unit, key) !== undefined || defaults[key] !== undefined,
  );
  const freeTextByField: Record<string, string> = {};
  for (const field of PROPERTY_FREE_TEXT_FIELDS) {
    const value = REQUIREMENT_KEYS.has(field) ? requirementValue(unit, field) : cleanValue(unit[field]);
    if (typeof value === 'string') freeTextByField[field] = value;
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'string' && FREE_TEXT_FIELDS.has(key)) freeTextByField[landlordTwin(key)] = value;
  }
  return { recordedRequirementKeys, freeTextByField };
}
