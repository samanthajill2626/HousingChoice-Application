// WP1 B2a spec D5 (charter 7.4): the ranking call's structured-output
// schema and its enums. Extraction's schema discipline: every key required
// (zero optional parameters), additionalProperties:false on every object,
// sentinels for none (empty arrays), no numeric or length bounds (the parser
// clamps and cuts in code, parse.ts).
//
// GRAMMAR SIZE: the API compiles the schema into a grammar with a size limit
// no offline test can see (WP1 B1: eight named objects compiled, twelve
// failed). This schema has five object nodes - the root, the candidate, the
// reason (inlined twice, for and against) and the flag - and
// test/rankingSchema.test.ts pins that. After ANY change here, Cameron runs
// app/scripts/extraction-schema-compile-check.ts (both `ranking` variants;
// RUNBOOK "Changing a structured-output schema").
// PR33: the free-text field list, the reportable requirement keys and the
// landlord prefix have ONE home, S3's cardFields.ts; this file derives the
// enums from them and defines none of its own.
import {
  LANDLORD_DEFAULT_KEYS,
  LANDLORD_FIELD_PREFIX,
  PROPERTY_FREE_TEXT_FIELDS,
  RANKED_REQUIREMENT_KEYS,
} from './cardFields.js';

/** Where a reason came from (spec D5). */
export const RANKING_SOURCES = Object.freeze([
  'voucher_size',
  'authority',
  'rent',
  'area',
  'pets',
  'evictions',
  'accessibility',
  'requirements',
  'preferences',
  'notes',
  'staff_notes',
  'feedback',
  'history',
  'recency',
  'property_details',
  'other',
] as const);

export type RankingSource = (typeof RANKING_SOURCES)[number];

const FLAG_FIELDS_OFF: readonly string[] = Object.freeze([
  ...RANKED_REQUIREMENT_KEYS,
  ...PROPERTY_FREE_TEXT_FIELDS.filter((field) => !RANKED_REQUIREMENT_KEYS.includes(field)),
]);
const FLAG_FIELDS_ON: readonly string[] = Object.freeze([
  ...FLAG_FIELDS_OFF,
  ...LANDLORD_DEFAULT_KEYS.map((field) => `${LANDLORD_FIELD_PREFIX}${field}`),
]);
const UNLAWFUL_FIELDS_OFF: readonly string[] = Object.freeze([...PROPERTY_FREE_TEXT_FIELDS]);
const UNLAWFUL_FIELDS_ON: readonly string[] = Object.freeze([
  ...PROPERTY_FREE_TEXT_FIELDS,
  ...LANDLORD_DEFAULT_KEYS.filter((field) => PROPERTY_FREE_TEXT_FIELDS.includes(field)).map(
    (field) => `${LANDLORD_FIELD_PREFIX}${field}`,
  ),
]);

/** Every property card field a flag can name, for one state of RANKING_LANDLORD_CARD. */
export function flagFieldsFor(landlordCard: boolean): readonly string[] {
  return landlordCard ? FLAG_FIELDS_ON : FLAG_FIELDS_OFF;
}

/** The fields an `unlawful` flag may name, for one state of RANKING_LANDLORD_CARD. */
export function unlawfulFieldsFor(landlordCard: boolean): readonly string[] {
  return landlordCard ? UNLAWFUL_FIELDS_ON : UNLAWFUL_FIELDS_OFF;
}

function reasonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string' },
      source: { type: 'string', enum: [...RANKING_SOURCES] },
    },
    required: ['text', 'source'],
  };
}

function buildSchema(landlordCard: boolean): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // The per-call handle (c1, c2, ...); ids are never on the cards.
            candidateId: { type: 'string' },
            // 0-100; clamped and rounded in parse.ts (no bounds here).
            score: { type: 'integer' },
            for: { type: 'array', items: reasonSchema() },
            against: { type: 'array', items: reasonSchema() },
            unknowns: { type: 'array', items: { type: 'string' } },
            failedRequirements: { type: 'array', items: { type: 'string', enum: [...RANKED_REQUIREMENT_KEYS] } },
            // The schema cannot tie `field` to `kind` without another named
            // object, so code enforces "unlawful names a free-text field"
            // (parse.ts).
            fairHousingFlags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['unlawful', 'accommodation'] },
                  field: { type: 'string', enum: [...flagFieldsFor(landlordCard)] },
                },
                required: ['kind', 'field'],
              },
            },
          },
          required: ['candidateId', 'score', 'for', 'against', 'unknowns', 'failedRequirements', 'fairHousingFlags'],
        },
      },
    },
    required: ['candidates'],
  };
}

const SCHEMA_OFF = buildSchema(false);
const SCHEMA_ON = buildSchema(true);

/** The schema for one state of RANKING_LANDLORD_CARD (the same object every call). */
export function rankingSchema(opts: { landlordCard: boolean }): Record<string, unknown> {
  return opts.landlordCard ? SCHEMA_ON : SCHEMA_OFF;
}
