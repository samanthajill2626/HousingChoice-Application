// Extraction schema compile check (WP1 B1, after the first never-written gate
// run): every extraction call on the branch failed 400 "The compiled grammar is
// too large" - the structured-output schema grew past the API's compile limit,
// which no offline test can see. This script sends ONE tiny request per schema,
// through the production structured-output client (same model, same thinking
// setting, same output_config), and prints which compile. Run it after ANY
// change to EXTRACTION_SCHEMA or GRADER_SCHEMA, before the code ships.
// It measures the API's grammar compiler, not the prompt: the system prompt and
// the user turn are a few words.
//
// Usage (repo root or the worktree; PowerShell):
//   $env:ANTHROPIC_API_KEY = '<the TESTING key>'
//   npx tsx app/scripts/extraction-schema-compile-check.ts --model claude-sonnet-5-5
//   Remove-Item Env:ANTHROPIC_API_KEY
//
// Cost: one call per schema (three), each a few hundred output tokens at most;
// a variant that fails to compile is rejected before the model runs.
import { pathToFileURL } from 'node:url';
import { createStructuredOutputClient, type StructuredOutputCall } from '../src/adapters/extraction.js';
import { EXTRACTABLE_FIELDS, EXTRACTION_SCHEMA } from '../src/services/extraction/schema.js';
import { GRADER_SCHEMA } from './extractionProbeNeverWritten.js';

type Schema = Record<string, unknown>;

/**
 * Main's shape before WP1 B1 (eight fields as named objects, string note
 * lines): the CONTROL. It compiled when B1 measured the limit (2026-10-28),
 * so a failure here means the key, model or API changed, not the schema.
 */
function mainControl(): Schema {
  const out = JSON.parse(JSON.stringify(EXTRACTION_SCHEMA)) as Schema;
  const props = out['properties'] as Record<string, Schema>;
  const fieldOp = {
    type: 'object',
    additionalProperties: false,
    properties: {
      op: { type: 'string', enum: ['none', 'write', 'suggest'] },
      value: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['op', 'value', 'reason'],
  };
  const eight = EXTRACTABLE_FIELDS.slice(0, 8);
  props['fields'] = {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(eight.map((f) => [f, fieldOp])),
    required: [...eight],
  };
  props['noteLines'] = { type: 'array', items: { type: 'string' } };
  return out;
}

/*
 * B1's measurement (Cameron, testing key, claude-sonnet-5-5, 2026-10-28):
 * twelve named field objects FAIL with string or { text, confidence } note
 * lines and with a number or integer confidence; eight named objects and the
 * one-list `fields` shape COMPILE. The schema now ships the list shape.
 */
export const VARIANTS: ReadonlyArray<{ name: string; about: string; schema: Schema }> = [
  { name: 'control', about: "main's shape before B1 (should compile)", schema: mainControl() },
  { name: 'extraction', about: 'EXTRACTION_SCHEMA as shipped', schema: EXTRACTION_SCHEMA },
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
  let failed = 0;
  for (const v of VARIANTS) {
    const call = await client.call({
      system: 'Return the empty result: every op "none", every string "", every list empty.',
      user: 'No conversation.',
      schema: v.schema,
    });
    if (!call.ok && call.failure === 'driver') failed += 1;
    console.log(`  ${v.name.padEnd(12)} ${outcome(call)}`);
    console.log(`  ${' '.repeat(12)} ${v.about}`);
  }
  // Exit 1 when any schema failed: a shipped one that does not compile fails every call.
  return failed === 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (err: unknown) => { console.error(err); process.exitCode = 1; },
  );
}
