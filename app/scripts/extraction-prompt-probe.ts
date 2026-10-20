/**
 * Runs made-up conversations through the REAL extraction model, using the exact
 * production request (the anthropic driver, the system prompt, the output
 * schema), and scores what the model did with one field in each case.
 *
 * WHY: the prompt-text tests in test/extractionSchema.test.ts pin what the
 * prompt SAYS; only the model can show what it DOES with it. Tracker #32 - the
 * model recorded the bedrooms a tenant asked for as their voucher size - was a
 * prompt bug that no unit test could see.
 *
 * IT TOUCHES NO DATA. No database, no AWS, no queue, no stored contact: every
 * conversation below is invented, and the only network call is the Anthropic
 * API. It DOES spend money - one extraction-sized call per case per run, the
 * same as one real extraction run each.
 *
 * Usage (repo root; PowerShell sets the key with $env:ANTHROPIC_API_KEY = '...'):
 *   npx tsx app/scripts/extraction-prompt-probe.ts --model <id>
 *     [--runs 5] [--concurrency 4] [--case <id>] [--repo <checkout root>] [--dry-run]
 *
 *   --model    defaults to AI_EXTRACTION_MODEL. Use the model the deployed env runs.
 *   --repo     run ANOTHER checkout's driver and prompt instead of this one's.
 *              Point it at a checkout of main to measure the deployed prompt
 *              before a change, then run without it to measure the change.
 *   --case     run only the case with this id.
 *   --dry-run  build every input and print the plan; calls nothing, needs no key.
 *
 * Verdicts, per run:
 *   ok      the model proposed what the conversation supports, or nothing when
 *           it supports nothing new.
 *   missed  the conversation states a new value and the model recorded nothing.
 *           Harmless, but worth reading.
 *   wrong   the model proposed a value the conversation does not support - the
 *           class of bug this probe exists to catch.
 *   failed  the call itself failed (refusal, truncation, parse, transport).
 * Exits 1 if any run was wrong or failed, 2 on a usage error.
 *
 * The cases are worded DIFFERENTLY from the prompt's own examples on purpose:
 * a case that repeats an example only proves the model can echo it.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type {
  ExtractableField,
  ExtractionCall,
  ExtractionFieldOp,
  ExtractionInput,
  ExtractionProfileSnapshot,
  TranscriptUtterance,
} from '../src/adapters/extraction.js';

type ExtractionModule = typeof import('../src/adapters/extraction.js');
type PromptModule = typeof import('../src/services/extraction/prompt.js');
type OrgListModule = typeof import('../src/services/extraction/orgListBlock.js');
type StartingListModule = typeof import('../src/lib/orgStartingList.js');
type LoggerModule = typeof import('../src/lib/logger.js');

interface ProbeCase {
  id: string;
  about: string;
  field: ExtractableField;
  /** The field's value on the profile before this conversation; absent = blank. */
  recorded?: string;
  /** The value the conversation supports; absent = it states nothing new. */
  supports?: string;
  lines: Array<[TranscriptUtterance['speaker'], TranscriptUtterance['channel'], string]>;
}

const CASES: readonly ProbeCase[] = [
  {
    id: 'states-voucher',
    about: 'Voucher size stated, profile blank',
    field: 'voucherSize',
    supports: '3',
    lines: [['client', 'sms', 'Hi, I saw your number from a friend. I have a Section 8 voucher for 3 bedrooms.']],
  },
  {
    id: 'states-voucher-wants-bigger',
    about: 'Voucher size stated alongside a bigger home wanted',
    field: 'voucherSize',
    supports: '1',
    lines: [['client', 'sms', 'I have a 1 bedroom voucher but I am really hoping to find a 2 bedroom.']],
  },
  {
    id: 'asks-bigger-recorded',
    about: 'Size recorded, client asks about bigger homes (Sam, tracker #32)',
    field: 'voucherSize',
    recorded: '1',
    lines: [
      ['client', 'sms', 'Do you have any 2 bedroom places? We really need the extra space.'],
      ['staff', 'sms', 'Let me check what we have and get back to you.'],
    ],
  },
  {
    id: 'asks-size-blank',
    about: 'Client asks about a home size, profile blank',
    field: 'voucherSize',
    lines: [['client', 'sms', 'Looking for something with 3 bedrooms near Decatur, what do you have?']],
  },
  {
    id: 'household-need-blank',
    about: 'Household need stated, no voucher size',
    field: 'voucherSize',
    lines: [['client', 'sms', 'It is me and my three kids so we need at least 3 bedrooms.']],
  },
  {
    id: 'toured-bigger-recorded',
    about: 'Size recorded, client toured a bigger home and wants to apply',
    field: 'voucherSize',
    recorded: '2',
    lines: [
      ['staff', 'sms', 'How did the tour of the 3 bedroom on Elm St go?'],
      ['client', 'sms', 'We loved it! Can we apply for the 3 bedroom?'],
    ],
  },
  {
    id: 'staff-offer-blank',
    about: 'Staff offers a home, client says yes',
    field: 'voucherSize',
    lines: [
      ['staff', 'sms', 'We have a 2 bedroom in Decatur for $1,400. Are you interested?'],
      ['client', 'sms', 'Yes please send me the info!'],
    ],
  },
  {
    id: 'answers-staff-question',
    about: 'Client answers the voucher question, then wants bigger',
    field: 'voucherSize',
    supports: '2',
    lines: [
      ['staff', 'sms', 'What bedroom size is your voucher?'],
      ['client', 'sms', '2'],
      ['client', 'sms', 'But I would love a 3 bedroom if you have one.'],
    ],
  },
  {
    id: 'voucher-reissued',
    about: 'Size recorded, voucher reissued at a bigger size',
    field: 'voucherSize',
    recorded: '1',
    supports: '2',
    lines: [
      ['client', 'sms', 'Good news, the housing authority reissued my voucher as a 2 bedroom since my mom moved in with us.'],
    ],
  },
  {
    id: 'voicemail-wants-bigger',
    about: 'Voicemail: voucher size plus a bigger home wanted',
    field: 'voucherSize',
    supports: '1',
    lines: [
      ['client', 'voice', 'Hi, this is Jordan. I have a one bedroom voucher with Atlanta Housing and I am looking for a two bedroom apartment. Please call me back.'],
    ],
  },
];

type Verdict = 'ok' | 'missed' | 'wrong' | 'failed';

interface RunOutcome {
  verdict: Verdict;
  /** "none", or `<op> "<value>"`; the failure kind on a failed call. */
  said: string;
  reason?: string;
  inputTokens: number;
  outputTokens: number;
}

const USAGE = 'Usage: npx tsx app/scripts/extraction-prompt-probe.ts --model <id> '
  + '[--runs 5] [--concurrency 4] [--case <id>] [--repo <checkout root>] [--dry-run]';

function fail(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function positiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) fail(`${flag} must be a positive integer, got "${raw}"`);
  return n;
}

function norm(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}

/** Place a recorded value on the profile in the type the job's toProfile gives it. */
function withRecorded(profile: ExtractionProfileSnapshot, field: ExtractableField, recorded: string): void {
  if (field === 'voucherSize') profile.voucherSize = Number(recorded);
  else if (field === 'porting') profile.porting = recorded === 'true';
  else profile[field] = recorded;
}

function buildInput(c: ProbeCase, orgListBlock: string): ExtractionInput {
  const profile: ExtractionProfileSnapshot = { contactType: 'tenant', phones: ['+15555550123'] };
  if (c.recorded !== undefined) withRecorded(profile, c.field, c.recorded);
  const start = Date.parse('2026-10-01T15:00:00.000Z');
  const transcript = c.lines.map(([speaker, channel, text], i): TranscriptUtterance => ({
    tsMsgId: `probe-${i}`,
    speaker,
    channel,
    text,
    at: new Date(start + i * 60_000).toISOString(),
  }));
  return { transcript, profile, orgListBlock };
}

function judge(c: ProbeCase, op: ExtractionFieldOp | undefined): Verdict {
  // parseExtractionText already downgrades a write/suggest with no value to none.
  const proposed = op !== undefined && op.op !== 'none' ? norm(op.value) : undefined;
  if (proposed === undefined) {
    return c.supports !== undefined && norm(c.supports) !== norm(c.recorded) ? 'missed' : 'ok';
  }
  const target = c.supports ?? c.recorded;
  return target !== undefined && proposed === norm(target) ? 'ok' : 'wrong';
}

function outcomeOf(c: ProbeCase, call: ExtractionCall): RunOutcome {
  const inputTokens = call.meta.usage?.inputTokens ?? 0;
  const outputTokens = call.meta.usage?.outputTokens ?? 0;
  if (!call.ok) return { verdict: 'failed', said: call.failure, reason: call.message, inputTokens, outputTokens };
  const op = call.result.fields[c.field];
  const said = op === undefined || op.op === 'none' ? 'none' : `${op.op} "${op.value ?? ''}"`;
  return {
    verdict: judge(c, op),
    said,
    ...(op?.reason !== undefined && { reason: op.reason }),
    inputTokens,
    outputTokens,
  };
}

async function pool<T>(jobs: ReadonlyArray<() => Promise<T>>, size: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  return results;
}

/** Import a module from the target checkout by path, so --repo runs THAT code. */
async function load<T>(repoRoot: string, relative: string): Promise<T> {
  return (await import(pathToFileURL(path.join(repoRoot, relative)).href)) as T;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      runs: { type: 'string', default: '5' },
      concurrency: { type: 'string', default: '4' },
      case: { type: 'string' },
      repo: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const runs = positiveInt(values.runs, '--runs');
  const concurrency = positiveInt(values.concurrency, '--concurrency');
  const dryRun = values['dry-run'];
  const model = values.model ?? process.env.AI_EXTRACTION_MODEL;
  if (model === undefined || model.length === 0) fail('--model is required (or set AI_EXTRACTION_MODEL).');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!dryRun && (apiKey === undefined || apiKey.length === 0)) fail('ANTHROPIC_API_KEY is not set.');
  const cases = values.case === undefined ? CASES : CASES.filter((c) => c.id === values.case);
  if (cases.length === 0) fail(`No case "${values.case}". Cases: ${CASES.map((c) => c.id).join(', ')}`);

  const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repoRoot = path.resolve(values.repo ?? ownRoot);
  const extraction = await load<ExtractionModule>(repoRoot, 'app/src/adapters/extraction.ts');
  const prompt = await load<PromptModule>(repoRoot, 'app/src/services/extraction/prompt.ts');
  const orgList = await load<OrgListModule>(repoRoot, 'app/src/services/extraction/orgListBlock.ts');
  const starting = await load<StartingListModule>(repoRoot, 'app/src/lib/orgStartingList.ts');
  const { createLogger } = await load<LoggerModule>(repoRoot, 'app/src/lib/logger.ts');

  // The starting organization list, rendered the way a real run renders the
  // stored list, so the request has the same shape as production's.
  let orgSeq = 0;
  const entries = starting.buildStartingEntries('2026-10-01T00:00:00.000Z', () => `probe-org-${++orgSeq}`);
  const orgListBlock = orgList.renderOrgListBlock(entries).text;

  console.log('Extraction prompt probe');
  console.log(`  checkout  ${repoRoot}`);
  console.log(`  model     ${model}`);
  console.log(`  prompt    ${prompt.extractionPromptFingerprint()}`);
  console.log(`  runs      ${runs} per case, ${cases.length} case(s), ${runs * cases.length} call(s)`);
  if (dryRun) {
    for (const c of cases) {
      const input = buildInput(c, orgListBlock);
      console.log(`\n[${c.id}] ${c.about}`);
      console.log(`  ${c.field}: recorded ${c.recorded ?? '(blank)'}, supports ${c.supports ?? '(nothing new)'}`);
      for (const u of input.transcript) console.log(`  ${prompt.renderUtteranceLine(u)}`);
    }
    console.log('\nDry run: nothing was sent.');
    return;
  }

  const driver = extraction.createExtractionDriver({
    driver: 'anthropic',
    model,
    apiKey,
    logger: createLogger({ level: 'silent' }),
  });
  const jobs = cases.flatMap((c) => {
    const input = buildInput(c, orgListBlock);
    return Array.from({ length: runs }, () => async () => outcomeOf(c, await driver.extract(input)));
  });
  const outcomes = await pool(jobs, concurrency);

  const totals: Record<Verdict, number> = { ok: 0, missed: 0, wrong: 0, failed: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  console.log('\n    ok  missed   wrong  failed  case');
  cases.forEach((c, ci) => {
    const mine = outcomes.slice(ci * runs, (ci + 1) * runs);
    const counts: Record<Verdict, number> = { ok: 0, missed: 0, wrong: 0, failed: 0 };
    for (const o of mine) {
      counts[o.verdict] += 1;
      totals[o.verdict] += 1;
      inputTokens += o.inputTokens;
      outputTokens += o.outputTokens;
    }
    const cols = (['ok', 'missed', 'wrong', 'failed'] as const).map((v) => String(counts[v]).padStart(6)).join('  ');
    console.log(`${cols}  ${c.id} - ${c.about}`);
    // Every distinct answer that was not ok, once, with the model's first reason.
    const seen = new Set<string>();
    for (const o of mine) {
      if (o.verdict === 'ok') continue;
      const key = `${o.verdict} ${o.said}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = mine.filter((m) => m.verdict === o.verdict && m.said === o.said).length;
      console.log(`          ${o.verdict}: ${o.said} x${n}${o.reason === undefined ? '' : ` - ${o.reason}`}`);
    }
  });
  console.log(
    `\nTotals: ok ${totals.ok}, missed ${totals.missed}, wrong ${totals.wrong}, failed ${totals.failed}`
    + ` | tokens in ${inputTokens}, out ${outputTokens}`,
  );
  if (totals.wrong > 0 || totals.failed > 0) process.exitCode = 1;
}

await main();
