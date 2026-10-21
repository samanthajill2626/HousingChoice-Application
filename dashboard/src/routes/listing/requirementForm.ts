// requirementForm.ts - the property forms' plumbing for the Requirements
// section and the voucher sizes (spec 2026-10-20 D1, D4, D5, D7, D10a; plan
// 2.6). Pure: no React, no I/O.
//
// RequirementFormValues is keyed by UNIT key (plan 2.6): a checkbox holds a
// boolean, every other field the string its control shows (an amount as typed,
// '' = blank) - plus one form-only flag, NO_APPLICATION_FEE_FLAG (code review
// R2D-5), which is never sent. The Edit form diffs two of them (buildRequirementPatch), the New
// form sends the non-blank fields (buildRequirementCreateFields) plus the
// landlord snapshot (requirementsSnapshotOf), and the landlord form maps req_
// keys in (requirementFormValuesFromLandlord) and out (toLandlordPatch).
import type { Contact, RequirementsSnapshotWire } from '../../api/index.js';
import {
  PROPERTY_FORM_FIELDS,
  REQUIREMENT_ITEMS,
  REQUIREMENT_ITEM_IDS,
  VOUCHER_SIZE_MAX,
  landlordItemValue,
  unitItemValue,
  type FlyerVisibility,
  type ItemValue,
  type RequirementField,
  type RequirementItemId,
} from './requirements.js';

export type RequirementFormValues = Record<string, string | boolean>;

/** Every requirement field, in display order (item order, then field order). */
export const REQUIREMENT_FIELDS: readonly RequirementField[] = REQUIREMENT_ITEMS.flatMap((item) => item.fields);

function asText(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v : '';
}

export function emptyRequirementFormValues(): RequirementFormValues {
  const out: RequirementFormValues = {};
  for (const f of REQUIREMENT_FIELDS) out[f.key] = f.kind === 'checkbox' ? false : '';
  return out;
}

function formValuesFrom(read: (id: RequirementItemId) => ItemValue): RequirementFormValues {
  const out: RequirementFormValues = {};
  for (const item of REQUIREMENT_ITEMS) {
    const value = read(item.id);
    for (const f of item.fields) {
      const v = value[f.key] ?? null;
      out[f.key] = f.kind === 'checkbox' ? v === true : typeof v === 'string' || typeof v === 'number' ? String(v) : '';
    }
  }
  return out;
}

/** The Edit form's starting values: the unit's items through the D1 read
 *  interpretation (a legacy boolean `pets` included). */
export function requirementFormValuesFromUnit(unit: Record<string, unknown>): RequirementFormValues {
  return formValuesFrom((id) => unitItemValue(unit, id));
}

/** A landlord's requirements as form values (the New form's prefill, D7; the
 *  landlord form's starting values, D9). */
export function requirementFormValuesFromLandlord(contact: Record<string, unknown>): RequirementFormValues {
  return formValuesFrom((id) => landlordItemValue(contact, id));
}

/** D1 / D10: "No application fee" is a recorded 0. */
export function isNoApplicationFee(values: RequirementFormValues): boolean {
  const v = asText(values['application_fee']).trim();
  return v !== '' && Number(v) === 0;
}

/** Code review R2D-5: "No application fee" is its OWN form flag, kept in the
 *  values under this key - a form-only key, never a unit or contact key, and
 *  never sent (the builders below read REQUIREMENT_FIELDS only). The starting
 *  values never carry it; RequirementsFields sets it from the checkbox, and
 *  pins it as it stands whenever the amount is edited. */
export const NO_APPLICATION_FEE_FLAG = 'form:no_application_fee';

/** Whether "No application fee" is checked: the flag once the form has set it;
 *  before that, the stored / prefilled value (a recorded 0). So a typed amount
 *  that reads 0 ("0.50" half typed, the 4 of "40" deleted) never ticks it -
 *  only the checkbox does. */
export function noApplicationFeeChecked(values: RequirementFormValues): boolean {
  const flag = values[NO_APPLICATION_FEE_FLAG];
  return typeof flag === 'boolean' ? flag : isNoApplicationFee(values);
}

/** The text a field records: as its control holds it, except the application
 *  fee - checked "No application fee" records 0, unchecked the typed amount
 *  (blank = none) (D10, R2D-5). */
function recordedText(values: RequirementFormValues, f: RequirementField): string | boolean | undefined {
  if (f.key === 'application_fee') return noApplicationFeeChecked(values) ? '0' : asText(values[f.key]);
  return values[f.key];
}

function parseMoney(text: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const v = text.trim();
  if (v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `${label} must be a number 0 or greater.` };
  return { ok: true, value: n };
}

/** The Edit form's requirement keys to PATCH: only keys whose value changed.
 *  A checkbox sends true or null; text sends the string as typed ('' when
 *  cleared - the server trims and REMOVEs ''); an amount sends a number or
 *  null when cleared (D1: clearable); the tour type sends the select value.
 *  The application fee compares and sends what it records (recordedText). */
export function buildRequirementPatch(
  initial: RequirementFormValues,
  current: RequirementFormValues,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {};
  for (const f of REQUIREMENT_FIELDS) {
    const after = recordedText(current, f);
    if (recordedText(initial, f) === after) continue;
    if (f.kind === 'checkbox') {
      patch[f.key] = after === true ? true : null;
    } else if (f.kind === 'money') {
      const parsed = parseMoney(asText(after), f.label);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      patch[f.key] = parsed.value;
    } else {
      patch[f.key] = asText(after);
    }
  }
  // D1: the save that CHECKS "One month's rent" sends the amount as null in the
  // same save, even when the amount looked unchanged - a colleague may have set
  // one since this form opened, and a record never holds both (400 deposit_conflict).
  if (current['deposit_one_month'] === true && initial['deposit_one_month'] !== true) patch['deposit'] = null;
  return { ok: true, patch };
}

/** The New form's requirement fields: only NON-BLANK ones. A key left out
 *  counts as blank against the snapshot (D5, plan 2.4), so a pre-filled field
 *  staff cleared still classifies as set on this property. */
export function buildRequirementCreateFields(
  values: RequirementFormValues,
): { ok: true; fields: Record<string, string | number | true> } | { ok: false; error: string } {
  const fields: Record<string, string | number | true> = {};
  for (const f of REQUIREMENT_FIELDS) {
    const v = recordedText(values, f);
    if (f.kind === 'checkbox') {
      if (v === true) fields[f.key] = true;
      continue;
    }
    if (f.kind === 'money') {
      // D1: with "One month's rent" ticked there is no fixed amount.
      if (f.key === 'deposit' && values['deposit_one_month'] === true) continue;
      const parsed = parseMoney(asText(v), f.label);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.value !== null) fields[f.key] = parsed.value;
      continue;
    }
    const t = asText(v).trim();
    if (t !== '') fields[f.key] = t;
  }
  return { ok: true, fields };
}

/** A field staff left blank: an unticked box, or text that is empty or only
 *  whitespace - and for the application fee, "No application fee" unticked
 *  too (R2D-5). */
function fieldIsBlank(values: RequirementFormValues, f: RequirementField): boolean {
  if (f.kind === 'checkbox') return values[f.key] !== true;
  if (f.key === 'application_fee' && noApplicationFeeChecked(values)) return false;
  return asText(values[f.key]).trim() === '';
}

/** Code review R2D-7 (spec D7): the New form's read of the locked landlord,
 *  above all on Try again after a failed read - the fields stayed usable, so
 *  staff may have typed into them. D7 replaces typed values only for a
 *  DIFFERENT landlord pick: this fills in only what staff left blank. An ITEM
 *  is filled from the landlord only when every one of its fields is blank in
 *  `current` (D1: an item is copied whole, so a filled checkbox never
 *  contradicts a typed detail or amount - e.g. One month's rent beside a typed
 *  fixed amount); every item staff typed into keeps what they typed. On the
 *  first read every item is blank, so the section is the landlord's values. */
export function fillBlankRequirementItems(
  current: RequirementFormValues,
  landlord: RequirementFormValues,
): RequirementFormValues {
  const out: RequirementFormValues = { ...current };
  for (const item of REQUIREMENT_ITEMS) {
    if (!item.fields.every((f) => fieldIsBlank(current, f))) continue;
    for (const f of item.fields) out[f.key] = landlord[f.key] ?? (f.kind === 'checkbox' ? false : '');
    if (item.id === 'application_fee') out[NO_APPLICATION_FEE_FLAG] = noApplicationFeeChecked(landlord);
  }
  return out;
}

/** D5 / D7: the landlord's values the New form filled in - every item, every
 *  key, null for blank - naming the landlord they came from. */
export function requirementsSnapshotOf(contact: Contact): RequirementsSnapshotWire {
  const snapshot: RequirementsSnapshotWire = { landlordId: contact.contactId };
  for (const id of REQUIREMENT_ITEM_IDS) snapshot[id] = landlordItemValue(contact, id);
  return snapshot;
}

/** The landlord form (D9): a unit-keyed patch as the contact's req_ keys. */
export function toLandlordPatch(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).map(([key, value]) => [`req_${key}`, value]));
}

/** D10a: the tag of a property-form field, by its label. Throws for a label the
 *  table does not hold - every form render test catches a field without a row. */
export function formFieldVisibility(label: string): FlyerVisibility {
  const row = PROPERTY_FORM_FIELDS.find((f) => f.label === label);
  if (row === undefined) throw new Error(`"${label}" is not a property-form field in PROPERTY_FORM_FIELDS (D10a)`);
  return row.flyer;
}

/** D4: a stored voucher_size_accepted as the picker's chip sizes (integers
 *  0..12, ascending, de-duplicated) and the values it has no chip for (shown
 *  as "Not a valid size, removed when you save"). */
export function splitVoucherSizes(raw: unknown): { sizes: number[]; invalid: unknown[] } {
  if (raw === undefined || raw === null) return { sizes: [], invalid: [] };
  const sizes: number[] = [];
  const invalid: unknown[] = [];
  for (const v of Array.isArray(raw) ? raw : [raw]) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= VOUCHER_SIZE_MAX) {
      if (!sizes.includes(v)) sizes.push(v);
    } else {
      invalid.push(v);
    }
  }
  return { sizes: sizes.sort((a, b) => a - b), invalid };
}

/** D4: what the Edit form PATCHes for the voucher sizes - undefined = nothing
 *  (unchanged, and no off-chip value to drop); null = emptied (the property
 *  falls back to its bedrooms); else the list, ascending. */
export function voucherSizesPatchValue(raw: unknown, current: readonly number[]): number[] | null | undefined {
  const stored = splitVoucherSizes(raw);
  const next = [...new Set(current)].sort((a, b) => a - b);
  const same =
    stored.invalid.length === 0 &&
    stored.sizes.length === next.length &&
    stored.sizes.every((n, i) => n === next[i]);
  if (same) return undefined;
  return next.length === 0 ? null : next;
}
