// WP1 B2a spec D9 (charter 7.4): the Weak cap, computed in code from the
// model's own report. THE one cap function (plan PR7, WI13): the read, the
// run's cappedAtRun and the counterfactual check all call capOf; none
// re-implements it. Pure.
//
// A pair is capped when its failedRequirements holds a CAP-ELIGIBLE key that
// (a) is recorded on that property's current card (a landlord default counts
// when the landlord card switch is on - the caller passes plain keys),
// (b) whose requirement ITEM carries none of the same pair's accommodation
//     flags (PR29: no_pets, pets and pet_fee are the one Pets item, so an
//     accommodation on no_pets covers a failed pets; PR45: for accommodation
//     only, qualifications joins every cap-eligible item, so an accommodation
//     on a Pets or Evictions key covers a failed qualifications and one on
//     qualifications covers a failed key of either item - the same rule is
//     often written both as a checkbox and in the qualifications text), and
// (c) whose own FIELD has no open unlawful flag on that property (PR40: an
//     unlawful flag on pets text does not lift the lawful No pets checkbox;
//     spec D9 / D10 "that field caps no pair").
// A flag on `landlord:<key>` counts as a flag on `<key>` (spec D2.1). An
// accommodation on a field of no item (notes, lease_terms, ...) suppresses
// nothing. Credit, income, move-in costs and touring never cap: they are not
// cap-eligible keys.
import { LANDLORD_FIELD_PREFIX, requirementItemOfField } from './cardFields.js';

export const CAP_ELIGIBLE_KEYS = Object.freeze([
  'no_evictions_on_program',
  'evictions_notes',
  'qualifications',
  'no_pets',
  'pets',
] as const);

export const CAP_REASON = 'requirement not met' as const;

const CAP_ELIGIBLE: ReadonlySet<string> = new Set(CAP_ELIGIBLE_KEYS);

/** `landlord:<key>` -> `<key>`; any other field unchanged. */
export function baseField(field: string): string {
  return field.startsWith(LANDLORD_FIELD_PREFIX) ? field.slice(LANDLORD_FIELD_PREFIX.length) : field;
}

/** The fields of one flag kind, in the order given. */
export function flagFieldsOfKind(
  flags: readonly { kind: string; field: string }[],
  kind: 'unlawful' | 'accommodation',
): string[] {
  return flags.filter((flag) => flag.kind === kind).map((flag) => flag.field);
}

export interface CapInput {
  failedRequirements: readonly string[];
  accommodationFields: readonly string[];
  recordedRequirementKeys: readonly string[];
  openUnlawfulFields: readonly string[];
}

export interface CapResult {
  capped: boolean;
  capReason: typeof CAP_REASON | null;
}

/** The requirement items the given (plain or landlord:) fields belong to (S3's requirementItemOfField, PR29); a field of no item adds nothing. */
function itemsOf(fields: readonly string[]): Set<string> {
  const items = new Set<string>();
  for (const field of fields) {
    const item = requirementItemOfField(field);
    if (item !== undefined) items.add(item);
  }
  return items;
}

/** The items of the cap-eligible keys (Evictions, qualifications, Pets). */
const CAP_ELIGIBLE_ITEMS: ReadonlySet<string> = itemsOf(CAP_ELIGIBLE_KEYS);
const QUALIFICATIONS_ITEM = 'qualifications';

/** PR29 + PR45: does an accommodation on `accommodated` items cover a failure of `item`? */
function accommodationCovers(item: string, accommodated: ReadonlySet<string>): boolean {
  if (accommodated.has(item)) return true;
  if (!CAP_ELIGIBLE_ITEMS.has(item)) return false;
  if (item === QUALIFICATIONS_ITEM) return [...accommodated].some((a) => CAP_ELIGIBLE_ITEMS.has(a));
  return accommodated.has(QUALIFICATIONS_ITEM);
}

export function capOf(input: CapInput): CapResult {
  const recorded = new Set(input.recordedRequirementKeys.map(baseField));
  const accommodatedItems = itemsOf(input.accommodationFields);
  const unlawfulFields = new Set(input.openUnlawfulFields.map(baseField));
  for (const raw of input.failedRequirements) {
    const key = baseField(raw);
    if (!CAP_ELIGIBLE.has(key)) continue;
    if (!recorded.has(key)) continue;
    const item = requirementItemOfField(key);
    if (item !== undefined && accommodationCovers(item, accommodatedItems)) continue;
    if (unlawfulFields.has(key)) continue;
    return { capped: true, capReason: CAP_REASON };
  }
  return { capped: false, capReason: null };
}
