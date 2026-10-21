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
  // flyer-leads D2 (spec 2026-10-21): every Pets and Deposit field is Staff
  // only - Sam talks them through with each tenant instead of publishing them,
  // and lib/unitFields.ts toUnitFlyer no longer carries them (D1).
  defineItem('pets', 'Pets', 'Pets', [
    defineField('no_pets', 'No pets', 'checkbox', 'staff_only'),
    // The EXISTING unit key. A legacy bare boolean is read (and, on the unit
    // write only, accepted) per D1 - see unitItemValue below.
    defineField('pets', 'Pets (details)', 'text', 'staff_only'),
    defineField('pet_fee', 'Pet fee', 'text', 'staff_only'),
  ]),
  defineItem('deposit', 'Deposit', 'Move-in costs', [
    // "One month's rent" and a fixed amount are ALTERNATIVES (hasDepositConflict).
    defineField('deposit_one_month', "One month's rent", 'checkbox', 'staff_only'),
    defineField('deposit', 'Fixed amount', 'money', 'staff_only'),
    defineField('deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'staff_only'),
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

// --- Where each value came from (D5) and own values (D6) ------------------------

export type RequirementSource = 'copied' | 'set_here';
export type RequirementSources = Partial<Record<RequirementItemId, RequirementSource>>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Defensive read of the stored `requirement_sources` map: non-object -> {}; unknown ids / values dropped. */
export function readRequirementSources(raw: unknown): RequirementSources {
  const sources: RequirementSources = {};
  if (!isPlainObject(raw)) return sources;
  for (const id of REQUIREMENT_ITEM_IDS) {
    if (!Object.hasOwn(raw, id)) continue;
    const source = raw[id];
    if (source === 'copied' || source === 'set_here') sources[id] = source;
  }
  return sources;
}

/**
 * D6 OWN VALUE: the item's record is `set_here`, or the item was never
 * touched and the property's value is not blank - whatever the landlord holds.
 */
export function isOwnValue(sources: RequirementSources, id: RequirementItemId, unitValue: ItemValue): boolean {
  const source = sources[id];
  if (source === 'set_here') return true;
  if (source === 'copied') return false;
  return !isItemBlank(unitValue);
}

/** D5 create snapshot, as parsed from the wire (plan 2.4). */
export interface RequirementsSnapshot {
  landlordId: string;
  /** Keys are UNIT keys; a missing key is blank. */
  items: Partial<Record<RequirementItemId, ItemValue>>;
}

const SNAPSHOT_SHAPE_ERROR = 'requirements_snapshot must be an object with a landlordId';

/**
 * D5: parse `requirements_snapshot` from a POST /api/units body. The values
 * are TRUSTED, not verified: each is read through its field's kind, and a
 * value that fails the kind counts as blank. Unknown item ids and unknown
 * keys inside an item are ignored. The landlordId match against the body's
 * landlordId is the route's check (it needs the body).
 */
export function parseRequirementsSnapshot(
  raw: unknown,
): { ok: true; snapshot: RequirementsSnapshot } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: SNAPSHOT_SHAPE_ERROR };
  const landlordId = raw['landlordId'];
  if (typeof landlordId !== 'string' || landlordId.length === 0) {
    return { ok: false, error: SNAPSHOT_SHAPE_ERROR };
  }
  const items: Partial<Record<RequirementItemId, ItemValue>> = {};
  for (const item of REQUIREMENT_ITEMS) {
    if (!Object.hasOwn(raw, item.id)) continue;
    const rawItem = raw[item.id];
    if (rawItem === undefined) continue;
    if (!isPlainObject(rawItem)) {
      return { ok: false, error: `requirements_snapshot.${item.id} must be an object` };
    }
    const value: ItemValue = {};
    for (const field of item.fields) {
      const rawValue = rawItem[field.key];
      const read = rawValue === undefined ? undefined : normalizeRequirementValue(field, rawValue, field.key);
      value[field.key] = read !== undefined && read.ok ? read.value : null;
    }
    items[item.id] = value;
  }
  return { ok: true, snapshot: { landlordId, items } };
}

/**
 * D5 classification - the ONE rule for create and PATCH.
 * changed = items whose interpreted value differs between `before` and
 * `after` (null in `after` reads as blank, so a caller may pass the stored
 * record merged with the validated fields); classified = changed, plus
 * (create with a snapshot) every item the snapshot names. Target per
 * classified item: the snapshot's item when named, else
 * landlordItemValue(landlord, id); no landlord -> 'set_here'. Equal ->
 * 'copied', different -> 'set_here'. Returns the WHOLE next map: `current`
 * with the classified items overwritten (pass {} on create and after a
 * landlord-change reset).
 */
export function nextRequirementSources(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  current: RequirementSources;
  landlord: Record<string, unknown> | undefined;
  snapshot?: RequirementsSnapshot;
}): RequirementSources {
  const next: RequirementSources = { ...input.current };
  for (const item of REQUIREMENT_ITEMS) {
    const after = unitItemValue(input.after, item.id);
    const changed = !itemValuesEqual(unitItemValue(input.before, item.id), after);
    const fromSnapshot = input.snapshot?.items[item.id];
    if (!changed && fromSnapshot === undefined) continue;
    const target =
      fromSnapshot ?? (input.landlord === undefined ? undefined : landlordItemValue(input.landlord, item.id));
    next[item.id] = target !== undefined && itemValuesEqual(after, target) ? 'copied' : 'set_here';
  }
  return next;
}

// --- Apply to properties: the per-unit decision (D8) ---------------------------

export type ApplySkipReason =
  | 'not_found'
  | 'deleted'
  | 'landlord_changed'
  | 'changed_since_opened'
  | 'already_matches'
  | 'changed_during_apply';

/** True when writing `next` (null = REMOVE) changes the STORED value of `key`. */
function storedValueChanges(unit: Record<string, unknown>, key: string, next: StoredValue): boolean {
  const stored = Object.hasOwn(unit, key) ? unit[key] : undefined;
  if (next === null) return stored !== undefined;
  return stored !== next;
}

/**
 * D8 per-unit Apply decision (pure). `landlordValues` = landlordItemValue for
 * every listed item (the route already checked them equal to `expected`).
 * Check order: not found, deleted, landlord changed, then the changing items
 * by INTERPRETED value (D1); nothing changing -> already_matches; a changing
 * item that is an own value (D6) -> changed_since_opened unless it is in
 * `ownItems` AND its value now equals (itemValuesEqual) its `seen` value, the
 * property's value as the dialog showed it (planner ruling PR-1, code review
 * PA-1: staff accepted replacing THAT value, never one a colleague saved
 * since).
 * A write sets EVERY key of each changing item to the landlord's value (null =
 * REMOVE), so a legacy boolean `pets` is rewritten into the new shape with the
 * Pets item; `requirement_sources` is the stored map (read defensively) with
 * each changing item 'copied' - a listed item that already equaled the
 * landlord keeps its record. `changedKeys` lists the unit keys whose STORED
 * value the write changes (the D13 audit), never `requirement_sources`. The
 * route's conditional write turns a race into changed_during_apply - or, by
 * one re-read planned here again, landlord_changed / deleted / not_found
 * (planner ruling PR-5).
 */
export function planUnitApply(input: {
  unit: Record<string, unknown> | undefined;
  landlordId: string;
  items: readonly RequirementItemId[];
  landlordValues: Partial<Record<RequirementItemId, ItemValue>>;
  ownItems: readonly RequirementItemId[];
  /** Per `ownItems` item, the unit's value as the dialog read it (unit keys; null = blank). */
  seen: Partial<Record<RequirementItemId, ItemValue>>;
}):
  | { kind: 'skip'; reason: Exclude<ApplySkipReason, 'changed_during_apply'> }
  | { kind: 'write'; patch: Record<string, unknown>; changedKeys: string[]; changedItems: RequirementItemId[] } {
  const { unit } = input;
  if (unit === undefined) return { kind: 'skip', reason: 'not_found' };
  const deletedAt = unit['deleted_at'];
  if (typeof deletedAt === 'string' && deletedAt.length > 0) return { kind: 'skip', reason: 'deleted' };
  if (unit['landlordId'] !== input.landlordId) return { kind: 'skip', reason: 'landlord_changed' };

  const listed = new Set<RequirementItemId>(input.items);
  const changing: Array<{ item: RequirementItem; target: ItemValue }> = [];
  for (const item of REQUIREMENT_ITEMS) {
    if (!listed.has(item.id)) continue;
    const target = input.landlordValues[item.id];
    if (target === undefined) throw new Error(`planUnitApply: no landlord value for item ${item.id}`);
    if (!itemValuesEqual(unitItemValue(unit, item.id), target)) changing.push({ item, target });
  }
  if (changing.length === 0) return { kind: 'skip', reason: 'already_matches' };

  const sources = readRequirementSources(unit['requirement_sources']);
  const own = new Set<RequirementItemId>(input.ownItems);
  for (const { item } of changing) {
    const current = unitItemValue(unit, item.id);
    if (!isOwnValue(sources, item.id, current)) continue;
    const shown = input.seen[item.id];
    if (!own.has(item.id) || shown === undefined || !itemValuesEqual(current, shown)) {
      return { kind: 'skip', reason: 'changed_since_opened' };
    }
  }

  const patch: Record<string, unknown> = {};
  const changedKeys: string[] = [];
  const nextSources: RequirementSources = { ...sources };
  for (const { item, target } of changing) {
    for (const field of item.fields) {
      const next = canonical(target[field.key]);
      patch[field.key] = next;
      if (storedValueChanges(unit, field.key, next)) changedKeys.push(field.key);
    }
    nextSources[item.id] = 'copied';
  }
  patch['requirement_sources'] = Object.keys(nextSources).length > 0 ? nextSources : null;
  return { kind: 'write', patch, changedKeys, changedItems: changing.map(({ item }) => item.id) };
}

// --- The property-form flyer tag table (D10, D10a) ------------------------------

/** D10a: one field on the New / Edit property forms and whether tenants see it on the flyer. */
export interface FormFieldVisibility {
  /** The field's form label (plan 1.1 and the forms' existing labels). */
  label: string;
  /** The unit key(s) the field writes. */
  keys: readonly string[];
  flyer: FlyerVisibility;
}

function formField(label: string, keys: readonly string[], flyer: FlyerVisibility): FormFieldVisibility {
  return Object.freeze({ label, keys: Object.freeze([...keys]), flyer });
}

/**
 * The Requirements section's fields, item then field order. "No application
 * fee" is the checkbox above the amount (D10): checked, it records 0, so it
 * writes application_fee and shares its tag.
 */
const REQUIREMENT_FORM_FIELDS: readonly FormFieldVisibility[] = REQUIREMENT_ITEMS.flatMap((item) =>
  item.fields.flatMap((field) => {
    const own = formField(field.label, [field.key], field.flyer);
    return field.key === 'application_fee'
      ? [formField('No application fee', [field.key], field.flyer), own]
      : [own];
  }),
);

/**
 * D10a: every field on the New / Edit property forms, in D10 form order
 * (the New form's landlord picker, then Property details, then Requirements,
 * then Application process and Notes), with its tag - 35 rows. The first row,
 * "Owning landlord", is on the New form only (plan AR1); the Edit form has no
 * landlord field. The app-side parity walk
 * (app/test/propertyFormFlyerParity.test.ts) fails when a tag disagrees with
 * what lib/unitFields.ts toUnitFlyer publishes; the dashboard mirror carries
 * the same table, and its drift test imports this one and compares.
 */
export const PROPERTY_FORM_FIELDS: readonly FormFieldVisibility[] = Object.freeze([
  formField('Owning landlord', ['landlordId'], 'staff_only'),
  formField('Housing authorities', ['accepted_authorities'], 'on_flyer'),
  formField('Beds', ['beds'], 'on_flyer'),
  formField('Baths', ['baths'], 'on_flyer'),
  formField('Voucher sizes accepted', ['voucher_size_accepted'], 'on_flyer'),
  // flyer-leads D2 (spec 2026-10-21): rent, accessibility and lease terms are
  // Staff only (toUnitFlyer no longer carries them, D1).
  formField('Rent min', ['rent_min'], 'staff_only'),
  formField('Rent max', ['rent_max'], 'staff_only'),
  formField('Payment standard', ['payment_standard'], 'staff_only'),
  formField('Address', ['address'], 'on_flyer'),
  formField('Subzone', ['subzone'], 'staff_only'),
  formField('Washer / dryer', ['washer_dryer'], 'on_flyer'),
  formField('Tenant-paid utilities', ['utilities'], 'on_flyer'),
  formField('Accessibility', ['accessibility'], 'staff_only'),
  formField('Lease terms', ['lease_terms'], 'staff_only'),
  formField('Public listing link', ['listing_link'], 'on_flyer'),
  formField('Video URL', ['video_url'], 'on_flyer'),
  formField('Same-day RTA', ['same_day_rta'], 'on_flyer'),
  ...REQUIREMENT_FORM_FIELDS,
  formField('Application process', ['application_process'], 'staff_only'),
  formField('Notes', ['notes'], 'staff_only'),
]);
