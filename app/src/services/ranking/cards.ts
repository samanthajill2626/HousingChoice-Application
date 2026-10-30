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
import type { ContactItem } from '../../repos/contactsRepo.js';
import type { UnitItem } from '../../repos/unitsRepo.js';
import {
  EXCLUDED_REQUIREMENT_KEYS,
  PROPERTY_CARD_FIELDS,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
  TENANT_CARD_FIELDS,
  includedFields,
  landlordTwin,
} from './cardFields.js';
import { DAY_MS, daysSince, instantMs } from './pairHistory.js';
import { recordedVoucherSizes, unitVoucherSizes } from './pool.js';
import { attachFeedback } from './seenFeedback.js';
import type { SeenHome } from './seenSet.js';
import type { Card, SendFact, TourProjection } from './types.js';

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

/**
 * Spec D2.1: the property card - included attributes, then voucher sizes and
 * (switch on) the landlord defaults. The accepted authorities are OFF the
 * card (charter section 20 item 18): each pair carries pairAuthorityFact.
 */
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

// --- The tenant card (spec D2.1-D2.3) ----------------------------------------

export interface TenantCardCtx {
  now: Date;
  /** RANKING_SEEN_MAX: how many properties-seen entries the card lists, in all. */
  seenMax: number;
  /** The UNBOUNDED seen set (seenSet.ts buildSeenSet). */
  seen: readonly SeenHome[];
}

/** One listed properties-seen entry (spec D2.3). */
export interface PropertiesSeenEntry {
  /** The home's unitId - a REFERENCE the prompt replaces with the home's handle; never sent as is. */
  home: string;
  label: string;
  sends: SendFact[];
  daysSinceLastSend: number | null;
  declined: { by: string; at: string } | null;
  tours: TourProjection[];
  /** The Notes lines that name this home. */
  feedback: string[];
}

export type RecencyBucket = 'this week' | 'this month' | 'one to three months' | 'older' | 'never';

export const TENANT_NOTES_KEY = 'notes';
export const LAST_HEARD_FROM_KEY = 'lastHeardFrom';
export const PROPERTIES_SEEN_KEY = 'propertiesSeen';

/** Charter 9.1: this week (under 7 days), this month (under 30), one to three months (under 90), older, never. */
export function recencyBucket(lastHeardFromAt: unknown, now: Date): RecencyBucket {
  const at = instantMs(lastHeardFromAt);
  if (at === undefined) return 'never';
  const days = (now.getTime() - at) / DAY_MS;
  if (days < 7) return 'this week';
  if (days < 30) return 'this month';
  if (days < 90) return 'one to three months';
  return 'older';
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first; an entry with no instant last. */
function compareNewestFirst(a: string | null, b: string | null): number {
  const left = instantMs(a);
  const right = instantMs(b);
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

interface ArrangedSeen {
  notes: string | undefined;
  entries: PropertiesSeenEntry[];
}

/**
 * Spec D2.3: the attach step over the whole seen set, then the bound. Entries
 * carrying an outcome (a decline, a tour, a feedback line) come first, newest
 * activity first; bare sends fill the remaining slots, newest send first. A
 * line naming a LISTED entry leaves the notes; a line naming only unlisted
 * entries stays, so no feedback is lost to the bound.
 */
function arrangePropertiesSeen(notes: unknown, ctx: TenantCardCtx): ArrangedSeen {
  const lines = attachFeedback(
    notes,
    ctx.seen.map((home) => ({ unitId: home.unitId, label: home.attachLabel })),
  );
  const feedbackByUnit = new Map<string, string[]>();
  for (const line of lines) {
    for (const unitId of line.unitIds) {
      const list = feedbackByUnit.get(unitId) ?? [];
      list.push(line.text);
      feedbackByUnit.set(unitId, list);
    }
  }
  const rows = ctx.seen.map((home) => ({ home, feedback: feedbackByUnit.get(home.unitId) ?? [] }));
  const hasOutcome = (row: { home: SeenHome; feedback: string[] }): boolean =>
    row.home.declined !== null || row.home.tours.length > 0 || row.feedback.length > 0;
  const withOutcome = rows
    .filter(hasOutcome)
    .sort((a, b) => compareNewestFirst(a.home.activityAt, b.home.activityAt) || compareText(a.home.unitId, b.home.unitId));
  const bare = rows
    .filter((row) => !hasOutcome(row))
    .sort((a, b) => compareNewestFirst(a.home.lastSendAt, b.home.lastSendAt) || compareText(a.home.unitId, b.home.unitId));
  const listed = [...withOutcome, ...bare].slice(0, Math.max(0, Math.floor(ctx.seenMax)));
  const listedIds = new Set(listed.map((row) => row.home.unitId));
  const moved = lines.some((line) => line.unitIds.some((unitId) => listedIds.has(unitId)));
  const general = lines.filter((line) => !line.unitIds.some((unitId) => listedIds.has(unitId))).map((line) => line.text);
  // FB21: when no line moves, the Notes text stays as stored (trimmed), its
  // line breaks and blank lines kept; only a box that lost lines is rebuilt.
  const stored = typeof notes === 'string' ? notes.trim() : '';
  return {
    notes: moved ? (general.length > 0 ? general.join('\n') : undefined) : stored.length > 0 ? stored : undefined,
    entries: listed.map(({ home, feedback }) => ({
      home: home.unitId,
      label: home.label,
      sends: home.sends.map((send) => ({ ...send })),
      daysSinceLastSend: daysSince(home.lastSendAt, ctx.now),
      declined: home.declined === null ? null : { ...home.declined },
      tours: home.tours.map((tour) => ({ ...tour })),
      feedback: [...feedback],
    })),
  };
}

/** Spec D2.1-D2.3: the tenant card - included attributes, the matching inputs by label, the recency bucket, properties seen. */
export function tenantCard(contact: ContactItem, ctx: TenantCardCtx): Card {
  const arranged = arrangePropertiesSeen(contact[TENANT_NOTES_KEY], ctx);
  const card: Card = {};
  for (const [key, field] of includedFields(TENANT_CARD_FIELDS)) {
    const value = key === TENANT_NOTES_KEY ? arranged.notes : storedValue(key, contact[key]);
    if (value !== undefined) card[field.cardKey ?? key] = value;
  }
  card[LAST_HEARD_FROM_KEY] = recencyBucket(contact.last_heard_from_at, ctx.now);
  card[PROPERTIES_SEEN_KEY] = arranged.entries;
  return card;
}

/** The unitIds of a tenant card's listed properties-seen entries, in card order. */
export function listedHomeIds(card: Card): string[] {
  const listed = card[PROPERTIES_SEEN_KEY];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown) =>
    entry !== null && typeof entry === 'object' && typeof (entry as PropertiesSeenEntry).home === 'string'
      ? [(entry as PropertiesSeenEntry).home]
      : [],
  );
}
