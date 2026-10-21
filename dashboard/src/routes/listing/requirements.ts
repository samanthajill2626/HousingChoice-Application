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
  type Contact,
  type RequirementItemId,
  type RequirementSource,
  type UnitItem,
  type WasherDryer,
} from '../../api/index.js';
import { humanize } from '../contact/format.js';
import { formatMoney } from './listingFormat.js';

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

// --- D6 display (property requirements spec 2026-10-20) --------------------
// Dashboard-only presentation of the registry above: what the property page
// shows for one item against the landlord's CURRENT value, and how one item
// value reads as one line. Nothing here FILLS a property value from the
// landlord (copy only, D5) - the landlord only explains the property's value.

/** D6 display of one item on a property. */
export interface RequirementDisplay {
  tag: 'set_here' | 'landlord_updated' | null;
  /** 'Landlord: <v>' | 'Landlord now: <v>' | null. */
  landlordLine: string | null;
}

/** One item value as one line: its parts joined by '; '; all blank -> 'blank'.
 *  evictions: 'No evictions while on the program', details;
 *  credit / income / qualifications: the text;
 *  pets: 'No pets', details, 'pet fee ' + fee;
 *  deposit: "One month's rent" and / or '$N' (both when both are recorded -
 *  worklist OR-31), 'flexible', notes;
 *  application_fee: 0 -> 'No application fee', else '$N';
 *  touring: the tour type's dashboard label, tour process.
 *  '$N' is the property page's money format (formatMoney). */
export function formatItemValue(id: RequirementItemId, value: ItemValue): string {
  const parts: string[] = [];
  const add = (part: string | null): void => {
    if (part !== null && part !== '') parts.push(part);
  };
  const text = (key: string): string | null => {
    const v = value[key];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  const money = (key: string): string | null => {
    const v = value[key];
    return typeof v === 'number' && Number.isFinite(v) ? formatMoney(v) : null;
  };
  const checked = (key: string): boolean => value[key] === true;
  switch (id) {
    case 'evictions':
      if (checked('no_evictions_on_program')) add('No evictions while on the program');
      add(text('evictions_notes'));
      break;
    case 'credit_requirements':
    case 'income_requirements':
    case 'qualifications':
      add(text(id));
      break;
    case 'pets': {
      if (checked('no_pets')) add('No pets');
      add(text('pets'));
      const fee = text('pet_fee');
      if (fee !== null) add(`pet fee ${fee}`);
      break;
    }
    case 'deposit':
      // "One month's rent" and a fixed amount are alternatives (D1), yet a
      // record holding BOTH (only a direct data edit can, worklist OR-30)
      // shows both: the server refuses an Apply from such a landlord (409
      // deposit_conflict), and the landlord card and the Apply dialog must show
      // what it refuses (code review RD-1, worklist OR-31).
      if (checked('deposit_one_month')) add("One month's rent");
      add(money('deposit'));
      if (checked('deposit_flexible')) add('flexible');
      add(text('deposit_notes'));
      break;
    case 'application_fee':
      add(value['application_fee'] === 0 ? 'No application fee' : money('application_fee'));
      break;
    case 'touring': {
      const type = text('tour_type');
      if (type !== null) {
        const labels = TOUR_TYPE_LABELS as Readonly<Record<string, string | undefined>>;
        add(labels[type] ?? humanize(type));
      }
      add(text('tour_process'));
      break;
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'blank';
}

/** D6, the tag table. `landlord` undefined = the property has no landlord, or
 *  its contact did not load: no tags and no landlord lines. A blank landlord
 *  value prints 'blank' and COUNTS as differing (Cameron, 2026-10-20). An item
 *  never touched (absent from requirement_sources) whose property value is not
 *  blank reads as set on this property. */
export function requirementDisplay(
  unit: UnitItem,
  landlord: Contact | undefined,
  id: RequirementItemId,
): RequirementDisplay {
  if (landlord === undefined) return { tag: null, landlordLine: null };
  const own = unitItemValue(unit, id);
  const theirs = landlordItemValue(landlord, id);
  if (itemValuesEqual(own, theirs)) return { tag: null, landlordLine: null };
  const shown = formatItemValue(id, theirs);
  const source = readRequirementSources(unit['requirement_sources'])[id];
  if (source === 'copied') return { tag: 'landlord_updated', landlordLine: `Landlord now: ${shown}` };
  if (source === 'set_here' || !isItemBlank(own)) {
    return { tag: 'set_here', landlordLine: `Landlord: ${shown}` };
  }
  return { tag: null, landlordLine: `Landlord: ${shown}` };
}

/** True when the landlord holds no requirement at all (every item blank). Reads
 *  only the req_ keys - never the tenant answers (`pets`, `evictions`) that
 *  share the contacts table. */
export function landlordHasNoRequirements(landlord: Contact): boolean {
  return REQUIREMENT_ITEMS.every((item) => isItemBlank(landlordItemValue(landlord, item.id)));
}

/** The items under their group headings, in display order (D1). */
export interface RequirementItemGroup {
  group: RequirementGroup;
  items: RequirementItem[];
}
export function requirementItemsByGroup(): RequirementItemGroup[] {
  const groups: RequirementItemGroup[] = [];
  for (const item of REQUIREMENT_ITEMS) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.group === item.group) last.items.push(item);
    else groups.push({ group: item.group, items: [item] });
  }
  return groups;
}
