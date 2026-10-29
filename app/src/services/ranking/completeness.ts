// WP1 B2a (spec D3; charter 7.3; plan PR6): the completeness pass. Code marks
// each card's gaps against a FIXED list, each a stable key with a staff label;
// the flags go to the model with the card (`missing: [labels]`) and come back
// on the match as missing[] (mergeMissing). Missing data never stops a
// ranking. The tenant's matching inputs are marked by the ONE list
// (TENANT_MATCHING_INPUTS, its `completeness` flag) - this file never spells
// their keys.
import { isItemBlank, unitItemValue } from '../../lib/requirements.js';
import { TENANT_MATCHING_INPUTS, type TenantMatchingInput } from '../../lib/tenantMatchingInputs.js';
import { authoritiesOf } from '../../lib/unitFields.js';
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import { landlordDefaults, type PropertyCardCtx } from './cards.js';
import { mapAuthorities, recordedVoucherSizes } from './pool.js';
import type { MissingFlag } from './types.js';

export const PROPERTY_MISSING_LABELS = {
  rent: 'Rent',
  payment_standard: 'Payment standard',
  voucher_sizes: 'Voucher sizes',
  authorities_unmapped: 'Housing authority not on the organization list',
  pets: 'Pets',
  accessibility: 'Accessibility',
} as const;

export const TENANT_MISSING_LABELS = {
  voucher_size: 'Voucher size',
  housing_authority: 'Housing authority',
} as const;

/** One item of a match's missing[] (spec D8): a code flag carries its key, a model unknown does not. */
export interface MissingEntry {
  key?: string;
  text: string;
}

const PETS_KEYS = ['no_pets', 'pets', 'pet_fee'] as const;

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Spec D3, property: rent, payment standard, recorded voucher sizes, unmapped authorities, pets, accessibility. */
export function propertyMissing(unit: UnitItem, ctx: PropertyCardCtx): MissingFlag[] {
  const flags: MissingFlag[] = [];
  const add = (key: keyof typeof PROPERTY_MISSING_LABELS): void => {
    flags.push({ key, label: PROPERTY_MISSING_LABELS[key] });
  };
  if (!isNumber(unit.rent_min) && !isNumber(unit.rent_max) && !isNumber(unit.final_rent)) add('rent');
  if (!isNumber(unit.payment_standard)) add('payment_standard');
  // Only a RECORDED size counts (a size inferred from beds is missing), read
  // through the pool's one normalizer: a stored 2.5 is no size (FB20).
  if (recordedVoucherSizes(unit).length === 0) add('voucher_sizes');
  if (mapAuthorities(ctx.orgEntries, authoritiesOf(unit)).unmapped.length > 0) add('authorities_unmapped');
  const defaults = landlordDefaults(unit, ctx) ?? {};
  const petsByDefault = PETS_KEYS.some((key) => defaults[key] !== undefined);
  if (isItemBlank(unitItemValue(unit, 'pets')) && !petsByDefault) add('pets');
  if (!hasText(unit.accessibility)) add('accessibility');
  return flags;
}

/** The list fields tenantMissing reads (a test passes its own list). */
export type CompletenessInput = Pick<TenantMatchingInput, 'key' | 'label' | 'kind' | 'source' | 'completeness'>;

/**
 * Spec D3, tenant: voucher size, housing authority, and every list input
 * marked for completeness WHOSE SOURCE IS `field` (R2F10) - the same inputs
 * the card carries (cardFields.ts matchingInputCardFields); an input kept in
 * Notes is judged by the model from the Notes box, never from a stale
 * attribute.
 */
export function tenantMissing(
  contact: ContactItem,
  inputs: readonly CompletenessInput[] = TENANT_MATCHING_INPUTS,
): MissingFlag[] {
  const flags: MissingFlag[] = [];
  const size = contact['voucherSize'];
  if (!(typeof size === 'number' && Number.isInteger(size))) {
    flags.push({ key: 'voucher_size', label: TENANT_MISSING_LABELS.voucher_size });
  }
  if (!hasText(contact['housingAuthority'])) {
    flags.push({ key: 'housing_authority', label: TENANT_MISSING_LABELS.housing_authority });
  }
  for (const input of inputs) {
    if (!input.completeness || input.source !== 'field') continue;
    const value = contact[input.key];
    const present = input.kind === 'dollars' ? isNumber(value) : hasText(value);
    if (!present) flags.push({ key: input.key, label: input.label });
  }
  return flags;
}

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Spec D3: the code flags first (with their keys), then each model unknown not equal to one, once. */
export function mergeMissing(flags: readonly MissingFlag[], unknowns: readonly string[]): MissingEntry[] {
  const out: MissingEntry[] = [];
  const seen = new Set<string>();
  for (const flag of flags) {
    const folded = fold(flag.label);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push({ key: flag.key, text: flag.label });
  }
  for (const raw of unknowns) {
    if (typeof raw !== 'string') continue;
    const text = raw.trim();
    const folded = fold(text);
    if (folded === '' || seen.has(folded)) continue;
    seen.add(folded);
    out.push({ text });
  }
  return out;
}
