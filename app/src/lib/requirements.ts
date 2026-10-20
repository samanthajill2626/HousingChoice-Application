// Landlord requirements and property fields: THE requirement registry and its
// pure rules (spec docs/superpowers/specs/2026-10-20-property-requirements-design.md,
// tracker #11 + #12).
//
// ONE module defines the eight requirement ITEMS (D1) - id, label, group, the
// unit key of each field, its kind and its flyer visibility - shared by
// validation (lib/unitFields.ts, the contacts PATCH), copying (Apply, D8),
// comparing (where each value came from, D5) and the dashboard. An item is the
// unit of copying, comparing and tagging: a checkbox or choice and the free
// text that details it are ONE item (Cameron, 2026-10-20).
//
// Pure: no I/O and no repo imports. Vocabulary: a `unit` in code is a
// "property" in staff copy (documentation/GLOSSARY.md).
//
// Hand-mirrored in dashboard/src/routes/listing/requirements.ts (no
// cross-workspace import exists - the acceptedVoucherSizes pattern). This copy
// is the source of truth, and both suites carry the same cases.
import { isTourType } from './toursModel.js';

export type RequirementItemId =
  | 'evictions'
  | 'credit_requirements'
  | 'income_requirements'
  | 'qualifications'
  | 'pets'
  | 'deposit'
  | 'application_fee'
  | 'touring';
export type RequirementGroup = 'Screening' | 'Pets' | 'Move-in costs' | 'Touring';
export type RequirementFieldKind = 'checkbox' | 'text' | 'long_text' | 'money' | 'tour_type';
export type FlyerVisibility = 'on_flyer' | 'staff_only';

export interface RequirementField {
  /** The unit key, e.g. 'no_pets'. */
  key: string;
  /** The landlord contact key: 'req_' + key (D2). */
  landlordKey: string;
  /** The form label (plan 1.0 "Field label"). */
  label: string;
  kind: RequirementFieldKind;
  flyer: FlyerVisibility;
}

export interface RequirementItem {
  id: RequirementItemId;
  label: string;
  group: RequirementGroup;
  fields: readonly RequirementField[];
}

function defineField(
  key: string,
  label: string,
  kind: RequirementFieldKind,
  flyer: FlyerVisibility,
): RequirementField {
  return Object.freeze({ key, landlordKey: `req_${key}`, label, kind, flyer });
}

function defineItem(
  id: RequirementItemId,
  label: string,
  group: RequirementGroup,
  fields: RequirementField[],
): RequirementItem {
  return Object.freeze({ id, label, group, fields: Object.freeze(fields) });
}

/** D1, in display order (the order and grouping every surface shows). */
export const REQUIREMENT_ITEMS: readonly RequirementItem[] = Object.freeze([
  defineItem('evictions', 'Evictions', 'Screening', [
    defineField('no_evictions_on_program', 'No evictions while on the program', 'checkbox', 'staff_only'),
    defineField('evictions_notes', 'Evictions (details)', 'text', 'staff_only'),
  ]),
  defineItem('credit_requirements', 'Credit score', 'Screening', [
    defineField('credit_requirements', 'Credit score', 'text', 'staff_only'),
  ]),
  defineItem('income_requirements', 'Income requirements', 'Screening', [
    defineField('income_requirements', 'Income requirements', 'text', 'staff_only'),
  ]),
  defineItem('qualifications', 'Qualifications', 'Screening', [
    defineField('qualifications', 'Qualifications', 'long_text', 'staff_only'),
  ]),
  defineItem('pets', 'Pets', 'Pets', [
    defineField('no_pets', 'No pets', 'checkbox', 'on_flyer'),
    // The EXISTING unit key. A legacy bare boolean is read (and, on the unit
    // write only, accepted) per D1 - see unitItemValue below.
    defineField('pets', 'Pets (details)', 'text', 'on_flyer'),
    defineField('pet_fee', 'Pet fee', 'text', 'on_flyer'),
  ]),
  defineItem('deposit', 'Deposit', 'Move-in costs', [
    // "One month's rent" and a fixed amount are ALTERNATIVES (hasDepositConflict).
    defineField('deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'),
    defineField('deposit', 'Fixed amount', 'money', 'on_flyer'),
    defineField('deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'),
    defineField('deposit_notes', 'Deposit notes', 'text', 'staff_only'),
  ]),
  defineItem('application_fee', 'Application fee', 'Move-in costs', [
    // 0 = "No application fee"; absent = no fee recorded.
    defineField('application_fee', 'Application fee', 'money', 'on_flyer'),
  ]),
  defineItem('touring', 'Touring', 'Touring', [
    defineField('tour_type', 'Tour type', 'tour_type', 'staff_only'),
    defineField('tour_process', 'Tour process', 'text', 'staff_only'),
  ]),
]);

export const REQUIREMENT_ITEM_IDS: readonly RequirementItemId[] = Object.freeze(
  REQUIREMENT_ITEMS.map((item) => item.id),
);
/** The 15 unit keys, item order then field order. */
export const REQUIREMENT_UNIT_KEYS: readonly string[] = Object.freeze(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((field) => field.key)),
);
/** The 15 landlord keys ('req_' + the unit key), in the same order. */
export const REQUIREMENT_LANDLORD_KEYS: readonly string[] = Object.freeze(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((field) => field.landlordKey)),
);

/** D3: the recorded washer / dryer values ('' or null REMOVEs; absent = Not recorded). */
export const WASHER_DRYER_VALUES = Object.freeze(['hookups', 'included', 'none'] as const);
/** D4: the largest voucher (bedroom) size a property can record. */
export const VOUCHER_SIZE_MAX = 12;

const ITEM_BY_ID: ReadonlyMap<string, RequirementItem> = new Map(
  REQUIREMENT_ITEMS.map((item) => [item.id, item] as const),
);
const ITEM_BY_UNIT_KEY: ReadonlyMap<string, RequirementItem> = new Map(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((field) => [field.key, item] as const)),
);

export function isRequirementItemId(v: unknown): v is RequirementItemId {
  return typeof v === 'string' && ITEM_BY_ID.has(v);
}

/** The item a unit key belongs to; undefined for any other key. */
export function itemOfUnitKey(key: string): RequirementItem | undefined {
  return ITEM_BY_UNIT_KEY.get(key);
}

function itemById(id: RequirementItemId): RequirementItem {
  const item = ITEM_BY_ID.get(id);
  if (item === undefined) throw new Error(`requirements: unknown item id ${String(id)}`);
  return item;
}

// --- Values (D1) --------------------------------------------------------------

/** One item's value: every key of the item -> its interpreted value; null = blank. */
export type ItemValue = Record<string, string | number | true | null>;
type StoredValue = string | number | true | null;

/** D1 legacy pets: the details text a legacy `pets: true` reads as. */
const LEGACY_PETS_ALLOWED = 'Allowed';

/**
 * The D1 canonical form used by equality: absent, null, false and blank text
 * are all blank (null); text is trimmed (case kept); a finite number is itself.
 */
function canonical(v: unknown): StoredValue {
  if (v === true) return true;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** One STORED value read through its field's kind; a value that fails the kind reads as blank. */
function readField(field: RequirementField, raw: unknown): StoredValue {
  if (field.kind === 'checkbox') return raw === true ? true : null;
  if (field.kind === 'money') {
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (field.kind === 'tour_type') return isTourType(raw) ? raw : null;
  return typeof raw === 'string' ? canonical(raw) : null;
}

/**
 * D1 read interpretation of one item on a UNIT record. A legacy bare boolean
 * `pets` decides BOTH Pets keys: false = No pets checked + details blank;
 * true = No pets unchecked + details "Allowed". Free text is never parsed.
 */
export function unitItemValue(unit: Record<string, unknown>, id: RequirementItemId): ItemValue {
  const item = itemById(id);
  const value: ItemValue = {};
  for (const field of item.fields) value[field.key] = readField(field, unit[field.key]);
  const legacy = unit['pets'];
  if (id === 'pets' && typeof legacy === 'boolean') {
    value['no_pets'] = legacy ? null : true;
    value['pets'] = legacy ? LEGACY_PETS_ALLOWED : null;
  }
  return value;
}

/**
 * The same from a LANDLORD contact: reads the req_ keys (never a boolean
 * req_pets) and returns the UNIT keys, so unit and landlord values compare
 * directly.
 */
export function landlordItemValue(contact: Record<string, unknown>, id: RequirementItemId): ItemValue {
  const item = itemById(id);
  const value: ItemValue = {};
  for (const field of item.fields) value[field.key] = readField(field, contact[field.landlordKey]);
  return value;
}

/** D1 item equality: every key equal after the canonical form (a missing key is blank). */
export function itemValuesEqual(a: ItemValue, b: ItemValue): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (canonical(a[key]) !== canonical(b[key])) return false;
  }
  return true;
}

/** True when every key of the value is blank. */
export function isItemBlank(v: ItemValue): boolean {
  return Object.values(v).every((x) => canonical(x) === null);
}

/**
 * D1 write kinds, shared by the unit validator and the landlord parser.
 * ok.value is the value to store, or null = REMOVE. Callers skip `undefined`.
 */
export function normalizeRequirementValue(
  field: RequirementField,
  value: unknown,
  keyForError: string,
): { ok: true; value: string | number | true | null } | { ok: false; error: string } {
  if (field.kind === 'checkbox') {
    if (value === true) return { ok: true, value: true };
    if (value === false || value === null) return { ok: true, value: null };
    return { ok: false, error: `${keyForError} must be true, false or null` };
  }
  if (field.kind === 'money') {
    if (value === null) return { ok: true, value: null };
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, error: `${keyForError} must be a number` };
    }
    if (value < 0) return { ok: false, error: `${keyForError} must be >= 0` };
    return { ok: true, value };
  }
  if (field.kind === 'tour_type') {
    if (value === '' || value === null) return { ok: true, value: null };
    if (!isTourType(value)) {
      return { ok: false, error: `${keyForError} must be one of: self_guided, landlord_led, pm_team` };
    }
    return { ok: true, value };
  }
  // text / long_text
  if (value === null) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, error: `${keyForError} must be a string or null` };
  const trimmed = value.trim();
  return { ok: true, value: trimmed.length > 0 ? trimmed : null };
}

/**
 * D2: pick the req_ keys out of a contacts PATCH body. Unknown req_ keys are
 * ignored, like every unknown contact key; an undefined value is skipped.
 * fields maps req_ key -> value, or null (REMOVE).
 */
export function parseLandlordRequirementPatch(
  body: Record<string, unknown>,
): { ok: true; fields: Record<string, string | number | true | null> } | { ok: false; error: string } {
  const fields: Record<string, string | number | true | null> = {};
  for (const item of REQUIREMENT_ITEMS) {
    for (const field of item.fields) {
      if (!Object.hasOwn(body, field.landlordKey)) continue;
      const raw = body[field.landlordKey];
      if (raw === undefined) continue;
      const result = normalizeRequirementValue(field, raw, field.landlordKey);
      if (!result.ok) return result;
      fields[field.landlordKey] = result.value;
    }
  }
  return { ok: true, fields };
}

/**
 * D1: true when the record (unit keys, or req_ keys with side 'landlord')
 * holds both a one-month deposit and a fixed amount. null counts as absent,
 * so a caller may merge validated fields (null = REMOVE) over the stored record.
 */
export function hasDepositConflict(record: Record<string, unknown>, side: 'unit' | 'landlord'): boolean {
  const prefix = side === 'landlord' ? 'req_' : '';
  const amount = record[`${prefix}deposit`];
  return (
    record[`${prefix}deposit_one_month`] === true && typeof amount === 'number' && Number.isFinite(amount)
  );
}
