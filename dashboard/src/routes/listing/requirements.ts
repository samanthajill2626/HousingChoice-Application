// requirements.ts - the dashboard's HAND MIRROR of app/src/lib/requirements.ts,
// the landlord-requirements registry (spec 2026-10-20 D1, D5, D6, D10a; plan
// 2.1, 2.6). No shared package exists between app and dashboard, so the READ
// side is copied by hand - the acceptedVoucherSizes pattern (listingFormat.ts):
// the eight items, how a stored value reads (the legacy boolean `pets`
// included), item equality, the stored `requirement_sources` map, OWN VALUE,
// and the D10a table of property-form fields. The app's server-only parsers
// and classifiers (normalizeRequirementValue, parseLandlordRequirementPatch,
// hasDepositConflict, parseRequirementsSnapshot, nextRequirementSources,
// planUnitApply) are deliberately NOT mirrored: no dashboard code runs them.
//
// Drift guard: requirementsMirror.test.ts imports BOTH copies and compares
// their answers; requirements.test.ts carries the app suite's cases. When the
// two disagree, the APP module is the source of truth. Like the app's, the
// registry is frozen, and a tour type reads only when it is one of the known
// tour types (the app's isTourType, app/src/lib/toursModel.ts:125-127; here
// the keys of TOUR_TYPE_LABELS, api/types.ts:907-911 - the dashboard has no
// tour-type guard, and ScheduleTourForm.tsx:79 lists the types the same way).
import {
  TOUR_TYPE_LABELS,
  type RequirementItemId,
  type RequirementSource,
  type WasherDryer,
} from '../../api/index.js';

export type { RequirementItemId, RequirementSource } from '../../api/index.js';

/** The known tour types (exact match, as the app's isTourType). */
const TOUR_TYPE_SET: ReadonlySet<string> = new Set(Object.keys(TOUR_TYPE_LABELS));

export type RequirementGroup = 'Screening' | 'Pets' | 'Move-in costs' | 'Touring';
export type RequirementFieldKind = 'checkbox' | 'text' | 'long_text' | 'money' | 'tour_type';
export type FlyerVisibility = 'on_flyer' | 'staff_only';

export interface RequirementField {
  /** The unit key, e.g. 'no_pets'. */
  key: string;
  /** 'req_' + key: the landlord contact's key. */
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

function field(key: string, label: string, kind: RequirementFieldKind, flyer: FlyerVisibility): RequirementField {
  return Object.freeze({ key, landlordKey: `req_${key}`, label, kind, flyer });
}

function freezeItem(item: RequirementItem): RequirementItem {
  return Object.freeze({ ...item, fields: Object.freeze([...item.fields]) });
}

/** D1, in display order (frozen below as REQUIREMENT_ITEMS). */
const ITEM_LIST: RequirementItem[] = [
  {
    id: 'evictions',
    label: 'Evictions',
    group: 'Screening',
    fields: [
      field('no_evictions_on_program', 'No evictions while on the program', 'checkbox', 'staff_only'),
      field('evictions_notes', 'Evictions (details)', 'text', 'staff_only'),
    ],
  },
  {
    id: 'credit_requirements',
    label: 'Credit score',
    group: 'Screening',
    fields: [field('credit_requirements', 'Credit score', 'text', 'staff_only')],
  },
  {
    id: 'income_requirements',
    label: 'Income requirements',
    group: 'Screening',
    fields: [field('income_requirements', 'Income requirements', 'text', 'staff_only')],
  },
  {
    id: 'qualifications',
    label: 'Qualifications',
    group: 'Screening',
    fields: [field('qualifications', 'Qualifications', 'long_text', 'staff_only')],
  },
  {
    id: 'pets',
    label: 'Pets',
    group: 'Pets',
    fields: [
      field('no_pets', 'No pets', 'checkbox', 'on_flyer'),
      field('pets', 'Pets (details)', 'text', 'on_flyer'),
      field('pet_fee', 'Pet fee', 'text', 'on_flyer'),
    ],
  },
  {
    id: 'deposit',
    label: 'Deposit',
    group: 'Move-in costs',
    fields: [
      field('deposit_one_month', "One month's rent", 'checkbox', 'on_flyer'),
      field('deposit', 'Fixed amount', 'money', 'on_flyer'),
      field('deposit_flexible', 'Flexible / payment terms available', 'checkbox', 'on_flyer'),
      field('deposit_notes', 'Deposit notes', 'text', 'staff_only'),
    ],
  },
  {
    id: 'application_fee',
    label: 'Application fee',
    group: 'Move-in costs',
    fields: [field('application_fee', 'Application fee', 'money', 'on_flyer')],
  },
  {
    id: 'touring',
    label: 'Touring',
    group: 'Touring',
    fields: [
      field('tour_type', 'Tour type', 'tour_type', 'staff_only'),
      field('tour_process', 'Tour process', 'text', 'staff_only'),
    ],
  },
];

/** D1, in display order - frozen, as the app's: no caller can edit the registry. */
export const REQUIREMENT_ITEMS: readonly RequirementItem[] = Object.freeze(ITEM_LIST.map(freezeItem));

export const REQUIREMENT_ITEM_IDS: readonly RequirementItemId[] = Object.freeze(REQUIREMENT_ITEMS.map((item) => item.id));
/** The 15 unit keys, item order then field order. */
export const REQUIREMENT_UNIT_KEYS: readonly string[] = Object.freeze(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((f) => f.key)),
);
/** The 15 'req_' landlord keys, same order. */
export const REQUIREMENT_LANDLORD_KEYS: readonly string[] = Object.freeze(
  REQUIREMENT_ITEMS.flatMap((item) => item.fields.map((f) => f.landlordKey)),
);

export function isRequirementItemId(v: unknown): v is RequirementItemId {
  return typeof v === 'string' && (REQUIREMENT_ITEM_IDS as readonly string[]).includes(v);
}

export function itemOfUnitKey(key: string): RequirementItem | undefined {
  return REQUIREMENT_ITEMS.find((item) => item.fields.some((f) => f.key === key));
}

function itemById(id: RequirementItemId): RequirementItem {
  const item = REQUIREMENT_ITEMS.find((i) => i.id === id);
  if (item === undefined) throw new Error(`unknown requirement item: ${String(id)}`);
  return item;
}

/** One item's value: every key of the item -> its interpreted value; null = blank. */
export type ItemValue = Record<string, string | number | true | null>;

/** D1 kinds, read side (the app's readField): a checkbox is true or blank;
 *  money a finite number of 0 or more; a tour type one of the known tour types,
 *  exactly (anything else - 'bogus', ' pm_team ' - reads as blank, as the app's
 *  isTourType); text a trimmed non-empty string. */
function readField(f: RequirementField, raw: unknown): string | number | true | null {
  if (f.kind === 'checkbox') return raw === true ? true : null;
  if (f.kind === 'money') return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (f.kind === 'tour_type') return typeof raw === 'string' && TOUR_TYPE_SET.has(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t === '' ? null : t;
}

/** D1 read interpretation from a UNIT record (legacy pets boolean, trim, blank -> null). */
export function unitItemValue(unit: Record<string, unknown>, id: RequirementItemId): ItemValue {
  const out: ItemValue = {};
  for (const f of itemById(id).fields) out[f.key] = readField(f, unit[f.key]);
  // D1 READ of a legacy boolean `pets`: false = No pets checked + details blank;
  // true = No pets unchecked + details "Allowed". Free text is never parsed.
  const legacy = unit['pets'];
  if (id === 'pets' && typeof legacy === 'boolean') {
    out['no_pets'] = legacy ? null : true;
    out['pets'] = legacy ? 'Allowed' : null;
  }
  return out;
}

/** The same from a LANDLORD contact (req_ keys; never a boolean pets). Keys of
 *  the returned value are the UNIT keys, so unit and landlord values compare directly. */
export function landlordItemValue(contact: Record<string, unknown>, id: RequirementItemId): ItemValue {
  const out: ItemValue = {};
  for (const f of itemById(id).fields) out[f.key] = readField(f, contact[f.landlordKey]);
  return out;
}

/** D1 blank rule for comparison: absent, null, '' and false are all blank; text trimmed. */
function norm(v: unknown): string | number | true | null {
  if (v === true) return true;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t === '' ? null : t;
  }
  return null;
}

/** D1 item equality: every key equal after interpretation; text trimmed and
 *  case-sensitive; numbers exact. */
export function itemValuesEqual(a: ItemValue, b: ItemValue): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if (norm(a[k]) !== norm(b[k])) return false;
  return true;
}

export function isItemBlank(v: ItemValue): boolean {
  return Object.values(v).every((x) => norm(x) === null);
}

export type RequirementSources = Partial<Record<RequirementItemId, RequirementSource>>;

/** Defensive read of the stored map: non-object -> {}; unknown ids / values dropped. */
export function readRequirementSources(raw: unknown): RequirementSources {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: RequirementSources = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isRequirementItemId(k) && (v === 'copied' || v === 'set_here')) out[k] = v;
  }
  return out;
}

/** D6 OWN VALUE: set_here, or never touched with a non-blank property value -
 *  whatever the landlord holds. */
export function isOwnValue(sources: RequirementSources, id: RequirementItemId, unitValue: ItemValue): boolean {
  const source = sources[id];
  return source === 'set_here' || (source === undefined && !isItemBlank(unitValue));
}

/** D10a: one field on the New / Edit property forms. */
export interface FormFieldVisibility {
  /** The form label (plan 1.1). */
  label: string;
  /** The unit key(s) the field writes. */
  keys: readonly string[];
  flyer: FlyerVisibility;
}

/** D10a: every field on the New / Edit property forms, in FORM order (D10),
 *  with the unit key(s) it writes and whether it reaches the public flyer. The
 *  forms tag each field from this table by its label (requirementForm.ts
 *  formFieldVisibility). The first row, the owning landlord, is on the New
 *  form only (the Edit form has no landlord field). Frozen below as
 *  PROPERTY_FORM_FIELDS, rows and key lists included (as the app's). */
const FORM_FIELD_LIST: FormFieldVisibility[] = [
  { label: 'Owning landlord', keys: ['landlordId'], flyer: 'staff_only' },
  { label: 'Housing authorities', keys: ['accepted_authorities'], flyer: 'on_flyer' },
  { label: 'Beds', keys: ['beds'], flyer: 'on_flyer' },
  { label: 'Baths', keys: ['baths'], flyer: 'on_flyer' },
  { label: 'Voucher sizes accepted', keys: ['voucher_size_accepted'], flyer: 'on_flyer' },
  { label: 'Rent min', keys: ['rent_min'], flyer: 'on_flyer' },
  { label: 'Rent max', keys: ['rent_max'], flyer: 'on_flyer' },
  { label: 'Payment standard', keys: ['payment_standard'], flyer: 'staff_only' },
  { label: 'Address', keys: ['address'], flyer: 'on_flyer' },
  { label: 'Subzone', keys: ['subzone'], flyer: 'staff_only' },
  { label: 'Washer / dryer', keys: ['washer_dryer'], flyer: 'on_flyer' },
  { label: 'Tenant-paid utilities', keys: ['utilities'], flyer: 'on_flyer' },
  { label: 'Accessibility', keys: ['accessibility'], flyer: 'on_flyer' },
  { label: 'Lease terms', keys: ['lease_terms'], flyer: 'on_flyer' },
  { label: 'Public listing link', keys: ['listing_link'], flyer: 'on_flyer' },
  { label: 'Video URL', keys: ['video_url'], flyer: 'on_flyer' },
  { label: 'Same-day RTA', keys: ['same_day_rta'], flyer: 'on_flyer' },
  { label: 'No evictions while on the program', keys: ['no_evictions_on_program'], flyer: 'staff_only' },
  { label: 'Evictions (details)', keys: ['evictions_notes'], flyer: 'staff_only' },
  { label: 'Credit score', keys: ['credit_requirements'], flyer: 'staff_only' },
  { label: 'Income requirements', keys: ['income_requirements'], flyer: 'staff_only' },
  { label: 'Qualifications', keys: ['qualifications'], flyer: 'staff_only' },
  { label: 'No pets', keys: ['no_pets'], flyer: 'on_flyer' },
  { label: 'Pets (details)', keys: ['pets'], flyer: 'on_flyer' },
  { label: 'Pet fee', keys: ['pet_fee'], flyer: 'on_flyer' },
  { label: "One month's rent", keys: ['deposit_one_month'], flyer: 'on_flyer' },
  { label: 'Fixed amount', keys: ['deposit'], flyer: 'on_flyer' },
  { label: 'Flexible / payment terms available', keys: ['deposit_flexible'], flyer: 'on_flyer' },
  { label: 'Deposit notes', keys: ['deposit_notes'], flyer: 'staff_only' },
  { label: 'No application fee', keys: ['application_fee'], flyer: 'on_flyer' },
  { label: 'Application fee', keys: ['application_fee'], flyer: 'on_flyer' },
  { label: 'Tour type', keys: ['tour_type'], flyer: 'staff_only' },
  { label: 'Tour process', keys: ['tour_process'], flyer: 'staff_only' },
  { label: 'Application process', keys: ['application_process'], flyer: 'staff_only' },
  { label: 'Notes', keys: ['notes'], flyer: 'staff_only' },
];

export const PROPERTY_FORM_FIELDS: readonly FormFieldVisibility[] = Object.freeze(
  FORM_FIELD_LIST.map((f) => Object.freeze({ ...f, keys: Object.freeze([...f.keys]) })),
);

/** D3 washer / dryer values. */
export const WASHER_DRYER_VALUES = Object.freeze(['hookups', 'included', 'none'] as const);

/** D3 labels (dashboard only): the forms' select, and the property page / flyer rows. */
export const WASHER_DRYER_LABELS: Readonly<Record<WasherDryer, string>> = Object.freeze({
  hookups: 'Hookups',
  included: 'Washer and dryer included',
  none: 'No hookups',
});

/** D4: the largest voucher size a property records. */
export const VOUCHER_SIZE_MAX = 12 as const;
