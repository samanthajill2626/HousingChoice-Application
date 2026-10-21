// requirementForm.ts - the property forms' plumbing for the Requirements
// section and the voucher sizes (spec 2026-10-20 D1, D4, D5, D7, D10a; plan
// 2.6). Pure: no React, no I/O.
//
// RequirementFormValues is keyed by UNIT key (plan 2.6): a checkbox holds a
// boolean, every other field the string its control shows (an amount as typed,
// '' = blank). The Edit form diffs two of them (buildRequirementPatch), the New
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
 *  null when cleared (D1: clearable); the tour type sends the select value. */
export function buildRequirementPatch(
  initial: RequirementFormValues,
  current: RequirementFormValues,
): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  const patch: Record<string, unknown> = {};
  for (const f of REQUIREMENT_FIELDS) {
    const after = current[f.key];
    if (initial[f.key] === after) continue;
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
    const v = values[f.key];
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
