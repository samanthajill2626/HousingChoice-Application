/**
 * Runs made-up conversations through the REAL extraction model, using the exact
 * production request (the anthropic driver, the system prompt, the output
 * schema), and scores what the model did.
 *
 * TWO SUITES.
 *   default        scores one field per case (tracker #32): ok / missed /
 *                  wrong / failed. With --baseline it runs on THIS checkout
 *                  AND on the baseline checkout (main), 3 runs per case on
 *                  the same model, and compares them: half of WP1 B1's merge
 *                  gate, because B1 changes every production prompt (spec
 *                  2026-10-26-wp1-b1-ranking-inputs D7).
 *   never-written  proves the never-written list holds (spec D7): each case
 *                  states one excluded fact, or one fact that MUST be written
 *                  (a control), and runs 3 times. It builds each request with
 *                  the production PROPERTIES SENT renderer and runs the
 *                  production driver, prompt and schema, then the production
 *                  pure filters (filterNoteLines, coerceField) - it certifies
 *                  production code, not a copy. Cases live in
 *                  extractionProbeNeverWritten.ts.
 *
 * WHY: the prompt-text tests in test/extractionSchema.test.ts pin what the
 * prompt SAYS; only the model can show what it DOES with it. Tracker #32 - the
 * model recorded the bedrooms a tenant asked for as their voucher size - was a
 * prompt bug that no unit test could see.
 *
 * IT TOUCHES NO DATA. No database, no AWS, no queue, no stored contact: every
 * conversation is invented, and the only network call is the Anthropic API.
 * The only file it writes is the --out record. It DOES spend money - one
 * extraction-sized call per case per run, the same as one real extraction run
 * each.
 *
 * Usage (repo root; PowerShell sets the key with $env:ANTHROPIC_API_KEY = '...'):
 *   npx tsx app/scripts/extraction-prompt-probe.ts --model <id>
 *     [--runs 5] [--concurrency 4] [--case <id>] [--repo <checkout root>] [--dry-run]
 *   npx tsx app/scripts/extraction-prompt-probe.ts --model <id> --baseline <checkout root>
 *     --out <record.md> [--repo <checkout root>] [--concurrency 4] [--case <id>] [--dry-run]
 *   npx tsx app/scripts/extraction-prompt-probe.ts --suite never-written --model <id>
 *     --out <record.md> [--concurrency 4] [--case <id>] [--dry-run]
 *
 *   --model     REQUIRED with --suite never-written and with --baseline: no
 *               fallback to AI_EXTRACTION_MODEL or the code default. The plain
 *               default suite still falls back to AI_EXTRACTION_MODEL. The
 *               driver cannot run claude-opus-5-5 (thinking cannot be turned
 *               off there - adapters/extraction.ts).
 *   --repo      measure ANOTHER checkout's driver and prompt instead of this one's.
 *   --baseline  ALSO run the default suite on this checkout (normally a checkout
 *               of main) and compare: FAIL when any case's ok count is 2 or more
 *               below the baseline's, the total is more than 2 below it, or the
 *               measured side truncates. A failing comparison re-runs both sides
 *               once; the second result counts.
 *   --out       APPEND this run's record (Markdown) to the file, creating it.
 *               With --baseline or --suite never-written only (refused on the
 *               plain default suite, which writes no record).
 *   --runs      plain default suite only (default 5); FIXED at 3 otherwise.
 *   --case      run only the case with this id (a never-written record is then
 *               marked PARTIAL - not a gate run).
 *   --dry-run   build every request and print the plan; calls nothing, needs no key.
 *
 * KEY: ANTHROPIC_API_KEY from the environment, printed as its last four
 * characters only. No agent runs this against a real model (WP1 B1 plan
 * PR1): the gate run is Cameron's, on the TESTING key.
 *
 * Verdicts, default suite, per run:
 *   ok      the model proposed what the conversation supports, or nothing when
 *           it supports nothing new.
 *   missed  the conversation states a new value and the model recorded nothing.
 *   wrong   the model proposed a value the conversation does not support.
 *   failed  the call itself failed (refusal, truncation, parse, transport).
 *
 * Exit codes: 0 the run passed (plain default suite: no run wrong or failed;
 * --baseline: the comparison passed; never-written: every automatic check
 * passed - the record still needs Cameron's sign-off); 1 a check failed, or
 * the run or the record write failed; 2 a usage error (nothing was called).
 *
 * The cases are worded DIFFERENTLY from the prompt's own examples on purpose:
 * a case that repeats an example only proves the model can echo it.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import type {
  ExtractableField,
  ExtractionCall,
  ExtractionDriver,
  ExtractionFieldOp,
  ExtractionInput,
  ExtractionProfileSnapshot,
  TranscriptUtterance,
} from '../src/adapters/extraction.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { UnitDisplayItem } from '../src/repos/unitsRepo.js';
import type { SentPropertyEntry } from '../src/services/extraction/sentPropertiesBlock.js';
import { GATE_RUNS, type SentProperty } from './extractionProbeNeverWritten.js';

export const SCRIPT_NAME = 'extraction-prompt-probe';

type ExtractionModule = typeof import('../src/adapters/extraction.js');
type PromptModule = typeof import('../src/services/extraction/prompt.js');
type OrgListModule = typeof import('../src/services/extraction/orgListBlock.js');
type StartingListModule = typeof import('../src/lib/orgStartingList.js');
type LoggerModule = typeof import('../src/lib/logger.js');
// S5.3's PROPERTIES SENT module (PR30).
type SentBlockModule = typeof import('../src/services/extraction/sentPropertiesBlock.js');
type ApplyModule = typeof import('../src/services/extraction/apply.js');
type LabelModule = typeof import('../src/lib/propertyLabel.js');
type InputsModule = typeof import('../src/lib/tenantMatchingInputs.js');
type ConfigModule = typeof import('../src/lib/config.js');

/**
 * The production code a default-suite side drives. `sentBlock` is absent on
 * a checkout from before WP1 B1 (a baseline of main): that side sends no
 * PROPERTIES SENT block, exactly as its production does.
 */
export interface BaseModules {
  extraction: ExtractionModule;
  prompt: PromptModule;
  orgList: OrgListModule;
  starting: StartingListModule;
  logger: LoggerModule;
  sentBlock?: SentBlockModule;
}

/** What the never-written suite drives: this checkout, B1's pure filters included. */
export interface BranchModules extends BaseModules {
  sentBlock: SentBlockModule;
  apply: ApplyModule;
  label: LabelModule;
  inputs: InputsModule;
  config: ConfigModule;
}

const BASE_PATHS = {
  extraction: 'app/src/adapters/extraction.ts',
  prompt: 'app/src/services/extraction/prompt.ts',
  orgList: 'app/src/services/extraction/orgListBlock.ts',
  starting: 'app/src/lib/orgStartingList.ts',
  logger: 'app/src/lib/logger.ts',
} as const;
/** S5.3's module (PR30). Its presence is how a checkout is recognised as WP1 B1. */
const SENT_BLOCK_PATH = 'app/src/services/extraction/sentPropertiesBlock.ts';
const BRANCH_PATHS = {
  apply: 'app/src/services/extraction/apply.ts',
  label: 'app/src/lib/propertyLabel.ts',
  inputs: 'app/src/lib/tenantMatchingInputs.ts',
  config: 'app/src/lib/config.ts',
} as const;

/** Import a module from the target checkout by path, so --repo / --baseline run THAT code. */
async function load<T>(repoRoot: string, relative: string): Promise<T> {
  return (await import(pathToFileURL(path.join(repoRoot, relative)).href)) as T;
}

export async function loadBaseModules(root: string): Promise<BaseModules> {
  const m: BaseModules = {
    extraction: await load<ExtractionModule>(root, BASE_PATHS.extraction),
    prompt: await load<PromptModule>(root, BASE_PATHS.prompt),
    orgList: await load<OrgListModule>(root, BASE_PATHS.orgList),
    starting: await load<StartingListModule>(root, BASE_PATHS.starting),
    logger: await load<LoggerModule>(root, BASE_PATHS.logger),
  };
  if (existsSync(path.join(root, SENT_BLOCK_PATH))) m.sentBlock = await load<SentBlockModule>(root, SENT_BLOCK_PATH);
  return m;
}

export async function loadBranchModules(root: string): Promise<BranchModules> {
  const m = await loadBaseModules(root);
  if (m.sentBlock === undefined) throw new Error(`${root} has no ${SENT_BLOCK_PATH} - the never-written suite needs a WP1 B1 checkout`);
  return {
    ...m,
    sentBlock: m.sentBlock,
    apply: await load<ApplyModule>(root, BRANCH_PATHS.apply),
    label: await load<LabelModule>(root, BRANCH_PATHS.label),
    inputs: await load<InputsModule>(root, BRANCH_PATHS.inputs),
    config: await load<ConfigModule>(root, BRANCH_PATHS.config),
  };
}

// ---------------------------------------------------------------------------
// SEAMS - the ONLY lines that name an S4/S5 signature (plan section 10,
// cross-slice notes 1-4; ruling PR30). Written against S4.2's
// filterNoteLines, S4.1's parseExtractionFactMinConfidence, S5.3's
// selectSentRows / renderSentPropertiesBlock / SentPropertyEntry and S5.4's
// ExtractionInput.sentPropertiesBlock as this plan defines them. If the tree
// differs, the earlier slice deviated: STOP and report it (do not bend the
// probe around it - the gate must run production code).
// ---------------------------------------------------------------------------

/** S5.4: the field ExtractionInput carries the block in (required since B1). */
function withSentBlock(input: Omit<ExtractionInput, 'sentPropertiesBlock'>, block: string): ExtractionInput {
  return { ...input, sentPropertiesBlock: block };
}

/**
 * One listing_sends row as listingSendsRepo.listByContact returns it: listed
 * (a string sentAt), its ONE share counted at sentAt and keyed `flyer` (a
 * flyer sign-up - lib/shareLedgerKeys.ts FLYER_SHARE_KEY) when signedUp, else
 * `individual`. selectSentRows - not this function - decides "signed up".
 */
function sentRow(p: SentProperty): ListingSendItem {
  const key = p.signedUp === true ? 'flyer' : 'individual';
  const attempt = p.signedUp === true ? `${p.sentAt}#flyer` : '!individual';
  return {
    unitId: p.unitId,
    contactId: 'probe-contact',
    sentAt: p.sentAt,
    via: 'individual',
    created_at: p.sentAt,
    updated_at: p.sentAt,
    counted: true,
    shares: { [key]: { attempt, state: 'counted', by: 'acceptance', countedAt: p.sentAt } },
  };
}

/** The unit display the job's getDisplaysByIds read returns for a sent property. */
function sentDisplay(p: SentProperty): UnitDisplayItem {
  return {
    unitId: p.unitId,
    address: { line1: p.line1, ...(p.line2 !== undefined && { line2: p.line2 }), city: p.city, state: 'GA' },
  };
}

/**
 * S5: the production PROPERTIES SENT block text ('' on a checkout from before
 * B1). Built EXACTLY as jobs/extraction.ts builds it (S5.6): selectSentRows
 * over the rows (newest 20 by sentAt; signed up = the latest counted share is
 * the flyer entry), then each selected row joined with its unit display into a
 * SentPropertyEntry `{ unit, sentAt, signedUp }`, a row with no display
 * skipped, then renderSentPropertiesBlock. Never build the entries straight
 * from SentProperty.signedUp: that would bypass production's row selection.
 */
export function renderSentBlock(m: BaseModules, sent: readonly SentProperty[]): string {
  if (m.sentBlock === undefined) return '';
  const displays = new Map(sent.map((p) => [p.unitId, sentDisplay(p)]));
  const entries: SentPropertyEntry[] = m.sentBlock.selectSentRows(sent.map(sentRow)).flatMap((row) => {
    const unit = displays.get(row.unitId);
    return unit === undefined ? [] : [{ unit, sentAt: row.sentAt, signedUp: row.signedUp }];
  });
  return m.sentBlock.renderSentPropertiesBlock(entries).text;
}

/** S5: the label production gives a sent property (undefined = production leaves it out). */
export function labelOf(m: BranchModules, p: SentProperty): string | undefined {
  return m.label.propertyLabel({ address: sentDisplay(p).address });
}

// (S6.3 adds the S4 seams writtenLines and factFloor here.)

// ---------------------------------------------------------------------------
// The default suite (tracker #32) - behavior unchanged.
// ---------------------------------------------------------------------------

export interface ProbeCase {
  id: string;
  about: string;
  field: ExtractableField;
  /** The field's value on the profile before this conversation; absent = blank. */
  recorded?: string;
  /** The value the conversation supports; absent = it states nothing new. */
  supports?: string;
  lines: Array<[TranscriptUtterance['speaker'], TranscriptUtterance['channel'], string]>;
}

export const DEFAULT_CASES: readonly ProbeCase[] = [
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

export type Verdict = 'ok' | 'missed' | 'wrong' | 'failed';

export interface RunOutcome {
  verdict: Verdict;
  /** "none", or `<op> "<value>"`; the failure kind on a failed call. */
  said: string;
  reason?: string;
  inputTokens: number;
  outputTokens: number;
}

function norm(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}

/** Place a recorded value on the profile in the type the job's toProfile gives it. */
function withRecorded(profile: ExtractionProfileSnapshot, field: ExtractableField, recorded: string): void {
  if (field === 'voucherSize') profile.voucherSize = Number(recorded);
  else if (field === 'porting') profile.porting = recorded === 'true';
  // The WP1 B1 dollars field is a number on the profile; every other field is text.
  else (profile as unknown as Record<string, unknown>)[field] = field === 'max_tenant_portion' ? Number(recorded) : recorded;
}

/** tsMsgId carries the case id (never rendered into the prompt) so a stub driver can tell cases apart. */
function transcriptOf(
  id: string,
  prefix: 'probe' | 'nw',
  startIso: string,
  lines: ReadonlyArray<readonly [TranscriptUtterance['speaker'], TranscriptUtterance['channel'], string]>,
): TranscriptUtterance[] {
  const start = Date.parse(startIso);
  return lines.map(([speaker, channel, text], i): TranscriptUtterance => ({
    tsMsgId: `${prefix}-${id}-${i}`,
    speaker,
    channel,
    text,
    at: new Date(start + i * 60_000).toISOString(),
  }));
}

export function buildInput(c: ProbeCase, orgListBlock: string, sentBlock: string): ExtractionInput {
  const profile: ExtractionProfileSnapshot = { contactType: 'tenant', phones: ['+15555550123'] };
  if (c.recorded !== undefined) withRecorded(profile, c.field, c.recorded);
  return withSentBlock({ transcript: transcriptOf(c.id, 'probe', '2026-10-01T15:00:00.000Z', c.lines), profile, orgListBlock }, sentBlock);
}

export function judge(c: ProbeCase, op: ExtractionFieldOp | undefined): Verdict {
  // parseExtractionText already downgrades a write/suggest with no value to none.
  const proposed = op !== undefined && op.op !== 'none' ? norm(op.value) : undefined;
  if (proposed === undefined) {
    return c.supports !== undefined && norm(c.supports) !== norm(c.recorded) ? 'missed' : 'ok';
  }
  const target = c.supports ?? c.recorded;
  return target !== undefined && proposed === norm(target) ? 'ok' : 'wrong';
}

export function outcomeOf(c: ProbeCase, call: ExtractionCall): RunOutcome {
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

export async function pool<T>(jobs: ReadonlyArray<() => Promise<T>>, size: number): Promise<T[]> {
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

/** A driver that throws is a failed call, never an escaped exception. */
export async function safeExtract(driver: ExtractionDriver, input: ExtractionInput): Promise<ExtractionCall> {
  try {
    return await driver.extract(input);
  } catch (err) {
    return { ok: false, meta: { driver: driver.kind }, failure: 'driver', message: err instanceof Error ? err.message : String(err) };
  }
}

/** The starting organization list, rendered the way a real run renders the stored list. */
function startingOrgListBlock(m: BaseModules): string {
  let orgSeq = 0;
  const entries = m.starting.buildStartingEntries('2026-10-01T00:00:00.000Z', () => `probe-org-${++orgSeq}`);
  return m.orgList.renderOrgListBlock(entries).text;
}

/** The key, as its last four characters only (spec D7). */
export function keyTail(key: string | undefined): string {
  if (key === undefined || key.length === 0) return '(not set)';
  if (key.length < 8) return '(set, too short to show)';
  return `...${key.slice(-4)}`;
}

function selectCases<T extends { id: string }>(all: readonly T[], id: string | undefined): readonly T[] | undefined {
  if (id === undefined) return all;
  const picked = all.filter((c) => c.id === id);
  return picked.length === 0 ? undefined : picked;
}

/** Prints the ok/missed/wrong/failed table (the old main's table loop) and returns the totals. */
function printDefaultTable(
  print: (line: string) => void,
  cases: readonly ProbeCase[],
  runs: number,
  outcomes: readonly RunOutcome[],
): { totals: Record<Verdict, number>; inputTokens: number; outputTokens: number } {
  const totals: Record<Verdict, number> = { ok: 0, missed: 0, wrong: 0, failed: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  print('\n    ok  missed   wrong  failed  case');
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
    print(`${cols}  ${c.id} - ${c.about}`);
    // Every distinct answer that was not ok, once, with the model's first reason.
    const seen = new Set<string>();
    for (const o of mine) {
      if (o.verdict === 'ok') continue;
      const key = `${o.verdict} ${o.said}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = mine.filter((m) => m.verdict === o.verdict && m.said === o.said).length;
      print(`          ${o.verdict}: ${o.said} x${n}${o.reason === undefined ? '' : ` - ${o.reason}`}`);
    }
  });
  print(
    `\nTotals: ok ${totals.ok}, missed ${totals.missed}, wrong ${totals.wrong}, failed ${totals.failed}`
    + ` | tokens in ${inputTokens}, out ${outputTokens}`,
  );
  return { totals, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// The CLI.
// ---------------------------------------------------------------------------

export const USAGE = [
  'Usage: npx tsx app/scripts/extraction-prompt-probe.ts --model <id>',
  '         [--runs 5] [--concurrency 4] [--case <id>] [--repo <checkout root>] [--dry-run]',
  '       npx tsx app/scripts/extraction-prompt-probe.ts --model <id> --baseline <checkout root> --out <record.md>',
  '         [--repo <checkout root>] [--concurrency 4] [--case <id>] [--dry-run]',
  '       npx tsx app/scripts/extraction-prompt-probe.ts --suite never-written --model <id> --out <record.md>',
  '         [--concurrency 4] [--case <id>] [--dry-run]',
].join('\n');

export interface ProbeArgs {
  suite: 'default' | 'never-written';
  model?: string;
  /** Plain default suite only; absent = 5. */
  runs?: number;
  concurrency: number;
  caseId?: string;
  repo?: string;
  baseline?: string;
  out?: string;
  dryRun: boolean;
}

const OPTIONS = {
  suite: { type: 'string' },
  model: { type: 'string' },
  runs: { type: 'string' },
  concurrency: { type: 'string' },
  case: { type: 'string' },
  repo: { type: 'string' },
  baseline: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

function readArgs(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
}

function positiveInt(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

export function parseProbeArgs(argv: readonly string[]): ProbeArgs | { usage: string } {
  let values: ReturnType<typeof readArgs>;
  try {
    values = readArgs(argv);
  } catch (err) {
    return { usage: err instanceof Error ? err.message : String(err) };
  }
  const dryRun = values['dry-run'] === true;
  const suite = values.suite ?? 'default';
  if (suite !== 'default' && suite !== 'never-written') {
    return { usage: `--suite must be "default" or "never-written", got "${suite}"` };
  }
  const runs = values.runs === undefined ? undefined : positiveInt(values.runs);
  if (values.runs !== undefined && runs === undefined) return { usage: `--runs must be a positive integer, got "${values.runs}"` };
  const concurrency = values.concurrency === undefined ? 4 : positiveInt(values.concurrency);
  if (concurrency === undefined) return { usage: `--concurrency must be a positive integer, got "${values.concurrency}"` };
  const model = values.model?.trim();
  const neverWritten = suite === 'never-written';
  const gated = neverWritten || values.baseline !== undefined;
  const where = neverWritten ? 'with --suite never-written' : 'with --baseline';
  if (neverWritten && (values.repo !== undefined || values.baseline !== undefined)) {
    return { usage: '--repo and --baseline do not apply to --suite never-written: it certifies this checkout' };
  }
  if (gated && (model === undefined || model.length === 0)) {
    return {
      usage: neverWritten
        ? '--model is required with --suite never-written (no fallback to AI_EXTRACTION_MODEL or the code default)'
        : '--model is required with --baseline (both sides run the same model; no fallback)',
    };
  }
  if (gated && values.runs !== undefined) return { usage: `--runs is fixed at ${GATE_RUNS} ${where}` };
  if (gated && values.out === undefined && !dryRun) return { usage: `--out <path> is required ${where}` };
  // WL-28 (D6a-S6-4): the plain default suite writes no record, so a gate
  // command typed without --baseline must not run and silently write nothing.
  if (!gated && values.out !== undefined) return { usage: '--out applies only with --suite never-written or --baseline' };
  return {
    suite,
    ...(model !== undefined && model.length > 0 && { model }),
    ...(runs !== undefined && { runs }),
    concurrency,
    ...(values.case !== undefined && { caseId: values.case }),
    ...(values.repo !== undefined && { repo: values.repo }),
    ...(values.baseline !== undefined && { baseline: values.baseline }),
    ...(values.out !== undefined && { out: values.out }),
    dryRun,
  };
}

/** The CLI's outside world - each member injectable, so the tests drive every exit code with a stub driver. */
export interface ProbeCliDeps {
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
  printError: (text: string) => void;
  /** This checkout's repo root. */
  ownRoot: string;
  loadBaseModules: (root: string) => Promise<BaseModules>;
  loadBranchModules: (root: string) => Promise<BranchModules>;
  createDriver: (m: BaseModules, opts: { model: string; apiKey: string; root: string }) => ExtractionDriver;
  /** The checkout's HEAD and whether TRACKED files are modified (the record file itself is untracked). */
  gitInfo: (root: string) => { commit: string; dirty: boolean };
  appendRecord: (file: string, text: string) => void;
  now: () => string;
}

function gitInfoOf(root: string): { commit: string; dirty: boolean } {
  try {
    const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: 'unknown (git failed)', dirty: false };
  }
}

export const RECORD_FILE_HEADER = [
  '# Extraction probe record',
  '',
  'Written by app/scripts/extraction-prompt-probe.ts. Synthetic conversations only - no client data.',
  'Each run APPENDS a section; the latest section of each suite is the one that counts.',
  '',
].join('\n');

function appendRecordFile(file: string, text: string): void {
  const target = path.resolve(file);
  mkdirSync(path.dirname(target), { recursive: true });
  if (!existsSync(target)) writeFileSync(target, RECORD_FILE_HEADER, 'utf8');
  appendFileSync(target, `\n${text}`, 'utf8');
}

function defaultDeps(): ProbeCliDeps {
  return {
    env: process.env,
    print: (line) => console.log(line),
    printError: (text) => console.error(text),
    ownRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
    loadBaseModules,
    loadBranchModules,
    createDriver: (m, opts) =>
      m.extraction.createExtractionDriver({
        driver: 'anthropic',
        model: opts.model,
        apiKey: opts.apiKey,
        logger: m.logger.createLogger({ level: 'silent' }),
      }),
    gitInfo: gitInfoOf,
    appendRecord: appendRecordFile,
    now: () => new Date().toISOString(),
  };
}

function usage(deps: ProbeCliDeps, message: string): 2 {
  deps.printError(`${message}\n${USAGE}`);
  return 2;
}

async function runDefault(a: ProbeArgs, deps: ProbeCliDeps, apiKey: string): Promise<0 | 1 | 2> {
  const model = a.model ?? deps.env.AI_EXTRACTION_MODEL;
  if (model === undefined || model.length === 0) return usage(deps, '--model is required (or set AI_EXTRACTION_MODEL).');
  const cases = selectCases(DEFAULT_CASES, a.caseId);
  if (cases === undefined) return usage(deps, `No case "${a.caseId}". Cases: ${DEFAULT_CASES.map((c) => c.id).join(', ')}`);
  const runs = a.runs ?? 5;
  const root = path.resolve(a.repo ?? deps.ownRoot);
  const m = await deps.loadBaseModules(root);
  const orgListBlock = startingOrgListBlock(m);
  const sentBlock = renderSentBlock(m, []); // production renders "none" for a tenant with no sends
  deps.print('Extraction prompt probe');
  deps.print(`  checkout  ${root}`);
  deps.print(`  model     ${model}`);
  deps.print(`  key       ${keyTail(apiKey)}`);
  deps.print(`  prompt    ${m.prompt.extractionPromptFingerprint()}`);
  deps.print(`  runs      ${runs} per case, ${cases.length} case(s), ${runs * cases.length} call(s)`);
  if (a.dryRun) {
    for (const c of cases) {
      const input = buildInput(c, orgListBlock, sentBlock);
      deps.print(`\n[${c.id}] ${c.about}`);
      deps.print(`  ${c.field}: recorded ${c.recorded ?? '(blank)'}, supports ${c.supports ?? '(nothing new)'}`);
      for (const u of input.transcript) deps.print(`  ${m.prompt.renderUtteranceLine(u)}`);
    }
    deps.print(''); // [PR52] its own blank line: the test matches the whole string
    deps.print('Dry run: nothing was sent.');
    return 0;
  }
  const driver = deps.createDriver(m, { model, apiKey, root });
  const jobs = cases.flatMap((c) => {
    const input = buildInput(c, orgListBlock, sentBlock);
    return Array.from({ length: runs }, () => async () => outcomeOf(c, await safeExtract(driver, input)));
  });
  const outcomes = await pool(jobs, a.concurrency);
  const { totals } = printDefaultTable(deps.print, cases, runs, outcomes);
  return totals.wrong > 0 || totals.failed > 0 ? 1 : 0;
}

// Placeholders - S6.4 and S6.5 replace these two bodies.
async function runNeverWritten(_a: ProbeArgs, deps: ProbeCliDeps, _apiKey: string): Promise<0 | 1 | 2> {
  deps.printError('--suite never-written is built in plan task S6.4');
  return 1;
}
async function runComparison(_a: ProbeArgs, deps: ProbeCliDeps, _apiKey: string): Promise<0 | 1 | 2> {
  deps.printError('--baseline is built in plan task S6.5');
  return 1;
}

/**
 * The CLI. Resolves to the exit code (see the header): 2 a usage error,
 * nothing called; 1 a failed check, run or record write; 0 a pass.
 */
export async function main(argv: readonly string[], cli: Partial<ProbeCliDeps> = {}): Promise<0 | 1 | 2> {
  const deps: ProbeCliDeps = { ...defaultDeps(), ...cli };
  const parsed = parseProbeArgs(argv);
  if ('usage' in parsed) return usage(deps, parsed.usage);
  const apiKey = deps.env.ANTHROPIC_API_KEY ?? '';
  if (!parsed.dryRun && apiKey.length === 0) return usage(deps, 'ANTHROPIC_API_KEY is not set.');
  try {
    if (parsed.suite === 'never-written') return await runNeverWritten(parsed, deps, apiKey);
    if (parsed.baseline !== undefined) return await runComparison(parsed, deps, apiKey);
    return await runDefault(parsed, deps, apiKey);
  } catch (err) {
    deps.printError(`${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith(`${SCRIPT_NAME}.ts`);
if (invokedDirectly) {
  void main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
