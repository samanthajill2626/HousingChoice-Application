// JSON output schema + parser/clamp for conversation fact extraction.
//
// The schema is consumed by the Anthropic driver's structured-outputs call
// (adapters/extraction.ts). Structured outputs impose three constraints we
// honor here: EVERY object level must set `additionalProperties: false`; the
// numeric/length keywords (minimum/maximum/minLength) are unsupported - so we
// carry NO size bounds in the schema and instead CLAMP in parseExtractionText;
// and the grammar compiler caps OPTIONAL parameters at 24 schema-wide (dev 400
// on 2026-07-20: our original shape had 33). So the WIRE shape is ALL-REQUIRED:
// every key is always present and "nothing" is spelled with sentinels
// (op:"none", empty strings, value:"none", empty arrays). parseExtractionText
// normalizes the sentinels away so the internal ExtractionResult - and
// everything downstream of it - stays sparse and unchanged.
import type {
  ExtractableField,
  ExtractionFieldOp,
  ExtractionNoteLine,
  ExtractionResult,
  SuggestedContactKind,
} from '../../adapters/extraction.js';
import { cleanAddressParts, normalizeAddressForCompare } from './address.js';
import { DECISION_TARGETS, type DecisionTarget, type ProposedOp } from './runTypes.js';
import { TENANT_MATCHING_INPUTS } from '../../lib/tenantMatchingInputs.js';

/**
 * The twelve client-profile fields the model may operate on: the eight
 * original scalars, then the tenant matching inputs from their one list, in
 * list order (B1 spec D1/D3). No reader names the four.
 */
export const EXTRACTABLE_FIELDS: readonly ExtractableField[] = [
  'firstName',
  'lastName',
  'voucherSize',
  'housingAuthority',
  'pets',
  'evictions',
  'tenure',
  'porting',
  ...TENANT_MATCHING_INPUTS.map((input) => input.key),
];

/**
 * Fields carrying `<field>_source` AI provenance a human PATCH must clear:
 * every scalar extractable (twelve) plus the compound `address`. ONE shared
 * const so the apply layer and the contacts PATCH provenance-clear gate
 * (routes/contacts.ts) always agree - which is how the four tenant matching
 * inputs get their staff-edit clear (B1 spec D2).
 */
export const PROVENANCE_FIELDS: readonly string[] = [...EXTRACTABLE_FIELDS, 'address'];

const SUGGESTED_CONTACT_KINDS = [
  'tenant',
  'landlord',
  'property_manager',
  'partner',
] as const satisfies readonly SuggestedContactKind[];

function isSuggestedContactKind(value: unknown): value is SuggestedContactKind {
  return typeof value === 'string'
    && (SUGGESTED_CONTACT_KINDS as readonly string[]).includes(value);
}

/**
 * One field's op on the wire: `{ field, op, value, reason }`, the field named
 * by an enum. `fields` is a LIST of these, never an object with one key per
 * field: twelve named field objects exceed the structured-output compiler's
 * grammar size limit (400 "The compiled grammar is too large", WP1 B1's first
 * never-written gate run; eight compiled). Measured with
 * app/scripts/extraction-schema-compile-check.ts - re-run it after any schema
 * change, because no offline test can see this limit.
 */
const fieldEntrySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    field: { type: 'string', enum: [...EXTRACTABLE_FIELDS] },
    op: { type: 'string', enum: ['none', 'write', 'suggest'] },
    value: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['field', 'op', 'value', 'reason'],
} as const;

/** Draft-07 subset compatible with structured outputs (json_schema format). */
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // One entry per extractable field (the prompt asks for all of them, in
    // EXTRACTABLE_FIELDS order); every entry key is REQUIRED, so the schema
    // stays at zero optional parameters - the 24-optional grammar cap
    // tripwire. The field enum is built from EXTRACTABLE_FIELDS so the two
    // cannot drift.
    fields: {
      type: 'array',
      items: fieldEntrySchema,
    },
    statusAdvance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suggest: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['suggest', 'reason'],
    },
    typeSuggestion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // "none" is the required-key sentinel for "no suggestion".
        value: { type: 'string', enum: ['tenant', 'landlord', 'property_manager', 'partner', 'none'] },
        reason: { type: 'string' },
      },
      required: ['value', 'reason'],
    },
    phoneAddition: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // "" phone is the required-key sentinel for "no phone mentioned".
        phone: { type: 'string' },
        label: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['phone', 'label', 'reason'],
    },
    // B1 spec D4: each line carries the model's confidence; both keys required
    // (zero optional parameters). The floor is applied in apply.ts.
    noteLines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['text', 'confidence'],
      },
    },
    // Layer-2 role attribution for `Speaker N` (unknown) call lines. Modeled as
    // an ARRAY OF PAIRS, not a dynamic-key map: structured outputs require
    // additionalProperties:false on every object, which a `{ "Speaker 1": role }`
    // map cannot satisfy. parseExtractionText folds this to a Record.
    speakerRoles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          speaker: { type: 'string' },
          role: { type: 'string', enum: ['client', 'staff', 'uncertain'] },
        },
        required: ['speaker', 'role'],
      },
    },
    // The ninth target: the client's CURRENT address as structured PARTS. All
    // keys required (sentinels for "nothing") so the schema-wide optional count
    // stays 0 - the 24-optional grammar cap tripwire.
    address: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // op "none" (with every part "") is the sentinel for "no address to
        // record"; an empty string in a part means that part was not mentioned.
        op: { type: 'string', enum: ['none', 'write', 'suggest'] },
        line1: { type: 'string' },
        line2: { type: 'string' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['op', 'line1', 'line2', 'city', 'state', 'zip', 'reason'],
    },
  },
  required: ['fields', 'statusAdvance', 'typeSuggestion', 'phoneAddition', 'noteLines', 'speakerRoles', 'address'],
};

const MAX_REASON_CHARS = 200;
/** B1 spec D4: the parser keeps at most this many noteLines; it filters no value. */
const MAX_PARSED_NOTE_LINES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * The model's `fields` output keyed by field name. The wire shape is a LIST of
 * `{ field, op, value, reason }` (EXTRACTION_SCHEMA); a field listed twice
 * keeps its first entry whose op is "write" or "suggest" - so a "none"
 * placeholder never hides a real op listed after it - else its first entry
 * (code review PA-S-2). An entry naming no extractable field is ignored.
 * The older object shape (`{ <field>: { op, value, reason } }`) is still read:
 * the AI run log stores each run's raw response text, and parseExtractionOps
 * re-reads runs recorded before the list shape.
 */
function rawFieldOps(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  const byField: Record<string, unknown> = {};
  if (!Array.isArray(raw)) return byField;
  const acts = (entry: unknown): boolean => isRecord(entry) && (entry.op === 'write' || entry.op === 'suggest');
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.field !== 'string') continue;
    if (!(EXTRACTABLE_FIELDS as readonly string[]).includes(entry.field)) continue;
    const kept = byField[entry.field];
    if (kept === undefined || (!acts(kept) && acts(entry))) byField[entry.field] = entry;
  }
  return byField;
}

/**
 * JSON.parse + structural validation + clamp. Throws SyntaxError on
 * unparseable text (the job layer treats that as a failure); NEVER throws on
 * structurally-valid JSON - unknown/ill-typed pieces are simply dropped.
 */
export function parseExtractionText(text: string): ExtractionResult {
  const parsed = JSON.parse(text) as unknown; // SyntaxError propagates.
  const root = isRecord(parsed) ? parsed : {};

  const result: ExtractionResult = { fields: {} };

  const rawFields = rawFieldOps(root.fields);
  const fields: Partial<Record<ExtractableField, ExtractionFieldOp>> = {};
  for (const field of EXTRACTABLE_FIELDS) {
    const rawOp = rawFields[field];
    if (!isRecord(rawOp)) continue;
    const op = rawOp.op;
    if (op !== 'none' && op !== 'write' && op !== 'suggest') continue;
    const fieldOp: ExtractionFieldOp = { op };
    // All-required wire sentinels: empty strings mean "not provided" - drop
    // them so downstream sees the sparse shape it always has.
    if (typeof rawOp.value === 'string' && rawOp.value.trim().length > 0) {
      fieldOp.value = rawOp.value;
    }
    if (typeof rawOp.reason === 'string' && rawOp.reason.trim().length > 0) {
      fieldOp.reason = clamp(rawOp.reason, MAX_REASON_CHARS);
    }
    // A write/suggest without a usable value is meaningless - downgrade to none
    // (defense-in-depth; apply would skip it anyway, but a bare op keeps the
    // audit/suggestion paths from ever seeing sentinel emptiness).
    if (fieldOp.op !== 'none' && fieldOp.value === undefined) {
      fields[field] = { op: 'none' };
      continue;
    }
    fields[field] = fieldOp;
  }
  result.fields = fields;

  const statusAdvance = root.statusAdvance;
  if (isRecord(statusAdvance) && typeof statusAdvance.suggest === 'boolean') {
    const value: { suggest: boolean; reason?: string } = { suggest: statusAdvance.suggest };
    if (typeof statusAdvance.reason === 'string' && statusAdvance.reason.trim().length > 0) {
      value.reason = clamp(statusAdvance.reason, MAX_REASON_CHARS);
    }
    result.statusAdvance = value;
  }

  // "none" is the all-required wire sentinel for "no type suggestion" - any
  // unsupported value folds to absent.
  const typeSuggestion = root.typeSuggestion;
  if (isRecord(typeSuggestion) && isSuggestedContactKind(typeSuggestion.value)) {
    const value: { value: SuggestedContactKind; reason?: string } = { value: typeSuggestion.value };
    if (typeof typeSuggestion.reason === 'string' && typeSuggestion.reason.trim().length > 0) {
      value.reason = clamp(typeSuggestion.reason, MAX_REASON_CHARS);
    }
    result.typeSuggestion = value;
  }

  // An empty/whitespace phone is the all-required wire sentinel for "no phone
  // mentioned" - folds to absent.
  const phoneAddition = root.phoneAddition;
  if (isRecord(phoneAddition) && typeof phoneAddition.phone === 'string' && phoneAddition.phone.trim().length > 0) {
    const value: { phone: string; label?: string; reason?: string } = { phone: phoneAddition.phone };
    if (typeof phoneAddition.label === 'string' && phoneAddition.label.trim().length > 0) {
      value.label = clamp(phoneAddition.label, MAX_REASON_CHARS);
    }
    if (typeof phoneAddition.reason === 'string' && phoneAddition.reason.trim().length > 0) {
      value.reason = clamp(phoneAddition.reason, MAX_REASON_CHARS);
    }
    result.phoneAddition = value;
  }

  // Address target (ninth): op 'none' folds to absent; a write/suggest op with
  // ZERO usable parts downgrades to absent (mirrors the value-less field-op
  // downgrade). Parts are read flat off the raw op object - cleanAddressParts
  // takes only the known part keys and ignores the op/reason keys.
  const rawAddress = root.address;
  if (isRecord(rawAddress) && (rawAddress.op === 'write' || rawAddress.op === 'suggest')) {
    const op = rawAddress.op;
    const parts = cleanAddressParts(rawAddress);
    if (Object.keys(parts).length > 0) {
      const value: NonNullable<ExtractionResult['address']> = { op, parts };
      if (typeof rawAddress.reason === 'string' && rawAddress.reason.trim().length > 0) {
        value.reason = clamp(rawAddress.reason, MAX_REASON_CHARS);
      }
      result.address = value;
    }
  }

  // B1 spec D4: keep up to MAX_PARSED_NOTE_LINES STRUCTURALLY valid items - an
  // object with a string text and a number confidence - unmodified. No value
  // filtering here: clamping, the floor, the guard and the cap are
  // apply.ts filterNoteLines, which the fake driver's bypass also reaches.
  if (Array.isArray(root.noteLines)) {
    const lines: ExtractionNoteLine[] = [];
    for (const item of root.noteLines) {
      if (lines.length >= MAX_PARSED_NOTE_LINES) break;
      if (!isRecord(item) || typeof item.text !== 'string' || typeof item.confidence !== 'number') continue;
      lines.push({ text: item.text, confidence: item.confidence });
    }
    if (lines.length > 0) result.noteLines = lines;
  }

  // Fold the wire array of {speaker,role} pairs into a Record. Keep only items
  // with a non-empty string speaker and an in-enum role; last write wins on a
  // duplicate speaker. Assign only when non-empty so a payload WITHOUT
  // speakerRoles round-trips unchanged.
  if (Array.isArray(root.speakerRoles)) {
    const roles: Record<string, 'client' | 'staff' | 'uncertain'> = {};
    for (const item of root.speakerRoles) {
      if (!isRecord(item)) continue;
      const speaker = item.speaker;
      const role = item.role;
      if (typeof speaker !== 'string' || speaker.length === 0) continue;
      if (role !== 'client' && role !== 'staff' && role !== 'uncertain') continue;
      roles[speaker] = role;
    }
    if (Object.keys(roles).length > 0) result.speakerRoles = roles;
  }

  return result;
}

/**
 * Canonical comparison key for a suggestion value - the shape dismissal
 * tombstones store and the apply layer checks against. Address values use the
 * address-specific normalizer; everything else folds case + whitespace.
 */
export function normalizeSuggestionValue(target: string, value: string): string {
  if (target === 'address') return normalizeAddressForCompare(value);
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Raw per-target op view (AI run log, design 2026-08-06 section 7.1)
// ---------------------------------------------------------------------------

/** One target as the MODEL stated it, before any folding or downgrading. */
export interface ExtractionOpView {
  op: ProposedOp;
  /** Carried ONLY on write/suggest, and KEPT even when it is the empty string -
   *  an empty value on a write/suggest is exactly what parseExtractionText
   *  erases at :215-219, and it is what makes empty_value_at_parse detectable. */
  value?: string;
  /** Carried ONLY on write/suggest, and only when non-blank. */
  reason?: string;
}

export type ExtractionOpsView = Record<DecisionTarget, ExtractionOpView>;

function absentView(): ExtractionOpsView {
  const view = {} as ExtractionOpsView;
  for (const target of DECISION_TARGETS) view[target] = { op: 'absent' };
  return view;
}

/** All sixteen targets absent. Frozen - callers must never mutate it. */
export const EMPTY_OPS_VIEW: ExtractionOpsView = Object.freeze(absentView());

/** The clamped reason, when the raw value is a non-blank string. */
function readReason(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim().length > 0 ? clamp(raw, MAX_REASON_CHARS) : undefined;
}

/**
 * The RAW per-target op view of the model's response text.
 *
 * WHY NOT the parsed ExtractionResult (design 7.1): parseExtractionText folds
 * the address and type `none` sentinels to ABSENT (:233, :258-263), so a
 * decline is indistinguishable from a silence; and it REWRITES a write/suggest
 * whose value is unusable into { op: 'none' } while dropping the reason
 * (:215-219), so a parsed `none` means EITHER "the model declined" OR "the
 * model tried and supplied an unusable value" - and the second is precisely
 * what QA needs to see, because it is the model FAILING rather than abstaining.
 *
 * TOTAL BY CONTRACT - it never throws. On unparseable or non-object input every
 * target comes back `absent`, and the recorder then records every target as
 * not_addressed - never no_finding, because a decline that was never observed
 * must never be inferred.
 */
export function parseExtractionOps(rawText: string | undefined): ExtractionOpsView {
  const view = absentView();
  if (rawText === undefined) return view;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return view;
  }
  if (!isRecord(parsed)) return view;

  // The twelve scalars: each field's op, verbatim (list or older object shape).
  const rawFields = rawFieldOps(parsed.fields);
  for (const field of EXTRACTABLE_FIELDS) {
    const rawOp = rawFields[field];
    if (!isRecord(rawOp)) continue;
    const op = rawOp.op;
    if (op !== 'none' && op !== 'write' && op !== 'suggest') continue;
    if (op === 'none') {
      view[field] = { op };
      continue;
    }
    const reason = readReason(rawOp.reason);
    view[field] = {
      op,
      ...(typeof rawOp.value === 'string' && { value: rawOp.value }),
      ...(reason !== undefined && { reason }),
    };
  }

  // address: the op only - no parts folding, so a `none` stays a `none`.
  const rawAddress = parsed.address;
  if (isRecord(rawAddress)) {
    const op = rawAddress.op;
    if (op === 'none') {
      view.address = { op };
    } else if (op === 'write' || op === 'suggest') {
      const reason = readReason(rawAddress.reason);
      view.address = { op, ...(reason !== undefined && { reason }) };
    }
  }

  // status: the boolean IS the op.
  const rawStatus = parsed.statusAdvance;
  if (isRecord(rawStatus) && typeof rawStatus.suggest === 'boolean') {
    const reason = readReason(rawStatus.reason);
    view.status = rawStatus.suggest
      ? { op: 'suggest', ...(reason !== undefined && { reason }) }
      : { op: 'none' };
  }

  // type: "none" is the decline sentinel. ANY other non-empty string is the
  // model proposing something - including an off-enum value, which is a FAILED
  // ATTEMPT and must never read as a decline.
  const rawType = parsed.typeSuggestion;
  if (isRecord(rawType) && typeof rawType.value === 'string' && rawType.value.length > 0) {
    const reason = readReason(rawType.reason);
    view.type = rawType.value === 'none'
      ? { op: 'none' }
      : { op: 'suggest', value: rawType.value, ...(reason !== undefined && { reason }) };
  }

  // phone: the empty-string phone is the decline sentinel.
  const rawPhone = parsed.phoneAddition;
  if (isRecord(rawPhone) && typeof rawPhone.phone === 'string') {
    const reason = readReason(rawPhone.reason);
    view.phone = rawPhone.phone.trim().length === 0
      ? { op: 'none' }
      : { op: 'suggest', value: rawPhone.phone, ...(reason !== undefined && { reason }) };
  }

  return view;
}
