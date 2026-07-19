// JSON output schema + parser/clamp for conversation fact extraction.
//
// The schema is consumed by the Anthropic driver's structured-outputs call
// (adapters/extraction.ts). Structured outputs impose two constraints we honor
// here: EVERY object level must set `additionalProperties: false`, and the
// numeric/length keywords (minimum/maximum/minLength) are unsupported - so we
// carry NO size bounds in the schema and instead CLAMP in parseExtractionText.
import type {
  ExtractableField,
  ExtractionFieldOp,
  ExtractionResult,
} from '../../adapters/extraction.js';

/** The eight client-profile fields the model may operate on. */
export const EXTRACTABLE_FIELDS: readonly ExtractableField[] = [
  'firstName',
  'lastName',
  'voucherSize',
  'housingAuthority',
  'pets',
  'evictions',
  'tenure',
  'porting',
];

/**
 * Controlled vocabulary of housing-authority values - EXACT strings as stored
 * in our data. housingAuthority extractions must match one of these or be
 * omitted (enforced by the prompt; apply-layer re-validates).
 */
export const HOUSING_AUTHORITY_VOCAB: string[] = [
  'Jonesboro (JHA)',
  'Fulton County',
  'Atlanta (AHA)',
  'Clayton County',
  'College Park',
  'Georgia Housing Voucher (GHV)',
  'Step Up',
  'Claratel',
  'Hope Atlanta',
  'HUD VASH',
  'DCA',
  'McDonough',
  'East Point',
];

const fieldOpSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['none', 'write', 'suggest'] },
    value: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['op'],
} as const;

/** Draft-07 subset compatible with structured outputs (json_schema format). */
export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fields: {
      type: 'object',
      additionalProperties: false,
      properties: {
        firstName: fieldOpSchema,
        lastName: fieldOpSchema,
        voucherSize: fieldOpSchema,
        housingAuthority: fieldOpSchema,
        pets: fieldOpSchema,
        evictions: fieldOpSchema,
        tenure: fieldOpSchema,
        porting: fieldOpSchema,
      },
    },
    statusAdvance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        suggest: { type: 'boolean' },
        reason: { type: 'string' },
      },
      required: ['suggest'],
    },
    typeSuggestion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        value: { type: 'string', enum: ['tenant', 'landlord'] },
        reason: { type: 'string' },
      },
      required: ['value'],
    },
    phoneAddition: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phone: { type: 'string' },
        label: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['phone'],
    },
    noteLines: {
      type: 'array',
      items: { type: 'string' },
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
  },
  required: ['fields'],
};

const MAX_REASON_CHARS = 200;
const MAX_NOTE_CHARS = 200;
const MAX_NOTE_LINES = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
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

  const rawFields = isRecord(root.fields) ? root.fields : {};
  const fields: Partial<Record<ExtractableField, ExtractionFieldOp>> = {};
  for (const field of EXTRACTABLE_FIELDS) {
    const rawOp = rawFields[field];
    if (!isRecord(rawOp)) continue;
    const op = rawOp.op;
    if (op !== 'none' && op !== 'write' && op !== 'suggest') continue;
    const fieldOp: ExtractionFieldOp = { op };
    if (typeof rawOp.value === 'string') fieldOp.value = rawOp.value;
    if (typeof rawOp.reason === 'string') fieldOp.reason = clamp(rawOp.reason, MAX_REASON_CHARS);
    fields[field] = fieldOp;
  }
  result.fields = fields;

  const statusAdvance = root.statusAdvance;
  if (isRecord(statusAdvance) && typeof statusAdvance.suggest === 'boolean') {
    const value: { suggest: boolean; reason?: string } = { suggest: statusAdvance.suggest };
    if (typeof statusAdvance.reason === 'string') value.reason = clamp(statusAdvance.reason, MAX_REASON_CHARS);
    result.statusAdvance = value;
  }

  const typeSuggestion = root.typeSuggestion;
  if (isRecord(typeSuggestion) && (typeSuggestion.value === 'tenant' || typeSuggestion.value === 'landlord')) {
    const value: { value: 'tenant' | 'landlord'; reason?: string } = { value: typeSuggestion.value };
    if (typeof typeSuggestion.reason === 'string') value.reason = clamp(typeSuggestion.reason, MAX_REASON_CHARS);
    result.typeSuggestion = value;
  }

  const phoneAddition = root.phoneAddition;
  if (isRecord(phoneAddition) && typeof phoneAddition.phone === 'string') {
    const value: { phone: string; label?: string; reason?: string } = { phone: phoneAddition.phone };
    if (typeof phoneAddition.label === 'string') value.label = clamp(phoneAddition.label, MAX_REASON_CHARS);
    if (typeof phoneAddition.reason === 'string') value.reason = clamp(phoneAddition.reason, MAX_REASON_CHARS);
    result.phoneAddition = value;
  }

  if (Array.isArray(root.noteLines)) {
    const lines = root.noteLines
      .filter((line): line is string => typeof line === 'string')
      .slice(0, MAX_NOTE_LINES)
      .map((line) => clamp(line, MAX_NOTE_CHARS));
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
