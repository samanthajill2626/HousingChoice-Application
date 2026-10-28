// Extraction schema compile check (WP1 B1, after the first never-written gate
// run): every extraction call on the branch failed 400 "The compiled grammar is
// too large" - the structured-output schema grew past the API's compile limit,
// which no offline test can see. This script sends ONE tiny request per schema
// variant, through the production structured-output client (same model, same
// thinking setting, same output_config), and prints which variants compile.
// It measures the API's grammar compiler, not the prompt: the system prompt and
// the user turn are a few words.
//
// Usage (repo root or the worktree; PowerShell):
//   $env:ANTHROPIC_API_KEY = '<the TESTING key>'
//   npx tsx app/scripts/extraction-schema-compile-check.ts --model claude-sonnet-5-5
//   Remove-Item Env:ANTHROPIC_API_KEY
//
// Cost: one call per variant (eight), each a few hundred output tokens at most;
// a variant that fails to compile is rejected before the model runs.
import { pathToFileURL } from 'node:url';
import { createStructuredOutputClient, type StructuredOutputCall } from '../src/adapters/extraction.js';
import { EXTRACTABLE_FIELDS, EXTRACTION_SCHEMA } from '../src/services/extraction/schema.js';
import { GRADER_SCHEMA } from './extractionProbeNeverWritten.js';

type Schema = Record<string, unknown>;

/** The eight fields main's schema carries (before the tenant matching inputs). */
const MAIN_FIELDS = EXTRACTABLE_FIELDS.slice(0, 8);

const FIELD_OP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', enum: ['none', 'write', 'suggest'] },
    value: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['op', 'value', 'reason'],
};

function clone(schema: Schema): Schema {
  return JSON.parse(JSON.stringify(schema)) as Schema;
}

function props(schema: Schema): Record<string, Schema> {
  return schema['properties'] as Record<string, Schema>;
}

/** The schema with its `fields` object narrowed to `fields`. */
function withFields(schema: Schema, fields: readonly string[]): Schema {
  const out = clone(schema);
  props(out)['fields'] = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(fields.map((f) => [f, FIELD_OP])),
    required: [...fields],
  };
  return out;
}

/** The schema with noteLines as plain strings (main's shape). */
function withStringNotes(schema: Schema): Schema {
  const out = clone(schema);
  props(out)['noteLines'] = { type: 'array', items: { type: 'string' } };
  return out;
}

/** The schema with each note line's confidence an integer (0-100) instead of a number. */
function withIntegerConfidence(schema: Schema): Schema {
  const out = clone(schema);
  const items = props(out)['noteLines']!['items'] as Schema;
  props(items)['confidence'] = { type: 'integer' };
  return out;
}

/** The schema with `fields` as ONE list of { field, op, value, reason } entries. */
function withFieldList(schema: Schema): Schema {
  const out = clone(schema);
  props(out)['fields'] = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        field: { type: 'string', enum: [...EXTRACTABLE_FIELDS] },
        op: { type: 'string', enum: ['none', 'write', 'suggest'] },
        value: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['field', 'op', 'value', 'reason'],
    },
  };
  return out;
}

export const VARIANTS: ReadonlyArray<{ name: string; about: string; schema: Schema }> = [
  { name: 'main', about: "main's shape: 8 fields, string note lines (control - should compile)", schema: withStringNotes(withFields(EXTRACTION_SCHEMA, MAIN_FIELDS)) },
  { name: 'branch', about: 'the branch as built: 12 fields, { text, confidence } note lines (the gate run failed here)', schema: EXTRACTION_SCHEMA },
  { name: 'branch-string-notes', about: '12 fields, string note lines', schema: withStringNotes(EXTRACTION_SCHEMA) },
  { name: 'branch-8-fields', about: '8 fields, { text, confidence } note lines', schema: withFields(EXTRACTION_SCHEMA, MAIN_FIELDS) },
  { name: 'branch-integer-confidence', about: '12 fields, confidence an integer', schema: withIntegerConfidence(EXTRACTION_SCHEMA) },
  { name: 'field-list', about: 'fields as one list of { field, op, value, reason }, number confidence', schema: withFieldList(EXTRACTION_SCHEMA) },
  { name: 'field-list-integer', about: 'fields as one list, integer confidence', schema: withIntegerConfidence(withFieldList(EXTRACTION_SCHEMA)) },
  { name: 'grader', about: "the never-written grader's schema", schema: GRADER_SCHEMA },
];

function outcome(call: StructuredOutputCall): string {
  if (call.ok) return 'COMPILES (answered)';
  // A refusal or a truncation still means the grammar compiled and the model ran.
  if (call.failure !== 'driver') return `COMPILES (model ran; ${call.failure})`;
  return `FAILS: ${call.message.slice(0, 240)}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const i = argv.indexOf('--model');
  const model = i >= 0 ? argv[i + 1] : undefined;
  if (!model) {
    console.error('usage: npx tsx app/scripts/extraction-schema-compile-check.ts --model <model id>');
    return 2;
  }
  const apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set (use the TESTING key).');
    return 2;
  }
  console.log(`Extraction schema compile check - model ${model}, key ...${apiKey.slice(-4)}, ${VARIANTS.length} call(s)`);
  const client = createStructuredOutputClient({ model, apiKey });
  for (const v of VARIANTS) {
    const call = await client.call({
      system: 'Return the empty result: every op "none", every string "", every list empty.',
      user: 'No conversation.',
      schema: v.schema,
    });
    console.log(`  ${v.name.padEnd(26)} ${outcome(call)}`);
    console.log(`  ${' '.repeat(26)} ${v.about}`);
  }
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { console.error(err); process.exitCode = 1; },
  );
}
