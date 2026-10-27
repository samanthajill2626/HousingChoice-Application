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
 *                  production code, not a copy. Then ONE grader call per run
 *                  that wrote a line or proposed a field value (the same
 *                  --model and key, structured output, through
 *                  createStructuredOutputClient in adapters/extraction.ts)
 *                  judges each item against plain descriptions of the
 *                  excluded kinds; it never sees the conversation. A line
 *                  judged excluded fails its case; a field value judged
 *                  excluded is reported only. There are no banned-word
 *                  lists. Cases and the grader prompt live in
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
 * each, plus (never-written only) one small grader call per run that wrote
 * something.
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
 *               of main) and compare: FAIL when any case is not measured on
 *               either side (fewer than 2 of its 3 calls returned a result - a
 *               refused, truncated, unparsed or failed call is no measurement),
 *               any case's ok count is 2 or more below the baseline's, the
 *               total is more than 2 below it, or the measured side truncates.
 *               A failing comparison re-runs both sides once; the second
 *               result counts.
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
import { createHash } from 'node:crypto';
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
  ExtractionResult,
  StructuredOutputCall,
  StructuredOutputClient,
  StructuredOutputRequest,
  TranscriptUtterance,
} from '../src/adapters/extraction.js';
import type { ListingSendItem } from '../src/repos/listingSendsRepo.js';
import type { UnitDisplayItem } from '../src/repos/unitsRepo.js';
import type { SentPropertyEntry } from '../src/services/extraction/sentPropertiesBlock.js';
import {
  CONTROL_MIN_PASSES,
  EXCLUDED_KINDS,
  EXCLUDED_KIND_DESCRIPTIONS,
  GATE_RUNS,
  GRADER_SCHEMA,
  GRADER_SYSTEM_PROMPT,
  MIN_GRADED_RUNS,
  NEVER_WRITTEN_CASES,
  PRICE_TABLE,
  SENT_PROPERTIES,
  buildGraderUserContent,
  type GraderItem,
  type NeverWrittenCase,
  type SentProperty,
} from './extractionProbeNeverWritten.js';

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

/**
 * The fixed `[Auto - <MMM D>]` prefix the probe hands filterNoteLines (PR30).
 * filterNoteLines requires one: its retry guard looks for `<prefix> <line>`
 * in the existing notes. The value only matters when a case's profile carries
 * notes; it is the autoPrefix of the never-written transcript's date
 * (2026-10-20, buildNeverWrittenInput).
 */
export const PROBE_NOTE_PREFIX = '[Auto - Oct 20]';

/**
 * S4.2: the lines production would append - its PURE filter (clamp, floor,
 * postal filter, retry guard, cap; spec D4) with no system lines and no
 * demotion. The model lines are `append.slice(0, modelCount)` (with no
 * system lines that is all of `append`). The probe never filters a line
 * itself (plan PR4).
 */
export function writtenLines(
  m: BranchModules,
  result: ExtractionResult,
  existingNotes: string,
  floor: number,
): { lines: string[]; belowFloor: number } {
  const out = m.apply.filterNoteLines({
    modelLines: result.noteLines,
    systemLines: [],
    floor,
    existingNotes,
    prefix: PROBE_NOTE_PREFIX,
    demoted: false,
  });
  return { lines: out.append.slice(0, out.modelCount), belowFloor: out.belowFloor };
}

/**
 * S4.1 (PR35): the floor, parsed by PRODUCTION's own pure parser
 * (`parseExtractionFactMinConfidence`: blank or absent = 0.7, otherwise a
 * finite 0 < x <= 1, else it throws) - never a full loadConfig.
 */
export function factFloor(m: BranchModules, env: NodeJS.ProcessEnv): number {
  return m.config.parseExtractionFactMinConfidence(env.EXTRACTION_FACT_MIN_CONFIDENCE);
}

/** Every sent property's production label, by unitId (a property production leaves out has none). */
export function sentLabels(m: BranchModules): Map<string, string> {
  const labels = new Map<string, string>();
  for (const p of SENT_PROPERTIES) {
    const l = labelOf(m, p);
    if (l !== undefined) labels.set(p.unitId, l);
  }
  return labels;
}

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
// The default suite, branch vs baseline (spec D7).
// ---------------------------------------------------------------------------

export interface SideScore {
  okByCase: Record<string, number>;
  /** FW-1: per case, the runs whose call returned a result (any verdict but `failed`). */
  measuredByCase: Record<string, number>;
  totalOk: number;
  truncations: number;
  totals: Record<Verdict, number>;
  inputTokens: number;
  outputTokens: number;
}

export interface Comparison {
  pass: boolean;
  reasons: string[];
  caseDrops: Array<{ id: string; branch: number; baseline: number }>;
  totalDelta: number;
}

/**
 * FW-1 (code review R1 ADV-1): a comparison case needs at least this many of
 * its GATE_RUNS runs MEASURED - the call returned a result, so a refusal, a
 * truncation, a parse or a driver failure is not one - on EACH side, or it is
 * "not measured" and the comparison FAILS. The never-written suite's bar
 * (MIN_GRADED_RUNS): a side that measured nothing must never read as a pass.
 */
export const MIN_MEASURED_RUNS = MIN_GRADED_RUNS;

export function scoreSide(cases: readonly ProbeCase[], runs: number, outcomes: readonly RunOutcome[]): SideScore {
  const okByCase: Record<string, number> = {};
  const measuredByCase: Record<string, number> = {};
  const totals: Record<Verdict, number> = { ok: 0, missed: 0, wrong: 0, failed: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let truncations = 0;
  cases.forEach((c, ci) => {
    const mine = outcomes.slice(ci * runs, (ci + 1) * runs);
    okByCase[c.id] = mine.filter((o) => o.verdict === 'ok').length;
    measuredByCase[c.id] = mine.filter((o) => o.verdict !== 'failed').length;
    for (const o of mine) {
      totals[o.verdict] += 1;
      inputTokens += o.inputTokens;
      outputTokens += o.outputTokens;
      if (o.verdict === 'failed' && o.said === 'truncated') truncations += 1;
    }
  });
  return { okByCase, measuredByCase, totalOk: totals.ok, truncations, totals, inputTokens, outputTokens };
}

/**
 * FAIL when a case is not measured on either side (FW-1: fewer than
 * MIN_MEASURED_RUNS of its GATE_RUNS runs returned a result), a case's ok
 * count is 2 or more below the baseline's, the total is MORE than 2 below, or
 * the branch truncated.
 */
export function compareDefaultSuites(branch: SideScore, baseline: SideScore): Comparison {
  const reasons: string[] = [];
  const ids = [...new Set([...Object.keys(branch.okByCase), ...Object.keys(baseline.okByCase)])];
  for (const id of ids) {
    for (const [where, s] of [['branch', branch], ['baseline', baseline]] as const) {
      const measured = s.measuredByCase[id] ?? 0;
      if (measured < MIN_MEASURED_RUNS) {
        reasons.push(`${id}: not measured on the ${where} (${measured} of ${GATE_RUNS} runs returned a result; needs ${MIN_MEASURED_RUNS})`);
      }
    }
  }
  const caseDrops = Object.keys(baseline.okByCase)
    .map((id) => ({ id, branch: branch.okByCase[id] ?? 0, baseline: baseline.okByCase[id] ?? 0 }))
    .filter((d) => d.baseline - d.branch >= 2);
  for (const d of caseDrops) reasons.push(`${d.id}: ok ${d.branch} on the branch vs ${d.baseline} on the baseline (2 or more below)`);
  const totalDelta = branch.totalOk - baseline.totalOk;
  if (totalDelta < -2) reasons.push(`total ok ${branch.totalOk} on the branch vs ${baseline.totalOk} on the baseline (more than 2 below)`);
  if (branch.truncations > 0) reasons.push(`${branch.truncations} truncated call(s) on the branch`);
  return { pass: reasons.length === 0, reasons, caseDrops, totalDelta };
}

interface ComparisonSide {
  root: string;
  m: BaseModules;
  commit: string;
  dirty: boolean;
  fingerprint: string;
  orgListBlock: string;
  sentBlock: string;
}

interface ComparisonAttempt {
  branch: SideScore;
  baseline: SideScore;
  comparison: Comparison;
  outcomes: [RunOutcome[], RunOutcome[]];
}

function notOkLines(cases: readonly ProbeCase[], outcomes: readonly RunOutcome[]): string[] {
  const lines: string[] = [];
  cases.forEach((c, ci) => {
    const mine = outcomes.slice(ci * GATE_RUNS, (ci + 1) * GATE_RUNS).filter((o) => o.verdict !== 'ok');
    const seen = new Map<string, number>();
    for (const o of mine) seen.set(`${o.verdict}: ${o.said}`, (seen.get(`${o.verdict}: ${o.said}`) ?? 0) + 1);
    for (const [said, n] of seen) lines.push(`  - ${c.id} ${asciiSafe(said)} x${n}`);
  });
  return lines;
}

export function renderComparisonRecord(r: {
  startedAt: string;
  model: string;
  keyTail: string;
  cases: readonly ProbeCase[];
  sides: readonly [ComparisonSide, ComparisonSide];
  attempts: readonly ComparisonAttempt[];
}): string {
  const final = r.attempts[r.attempts.length - 1]!;
  const out: string[] = [];
  out.push(`## Default suite, branch vs baseline - ${r.startedAt}`, '');
  out.push(`- Verdict: ${final.comparison.pass ? 'PASS' : 'FAIL'} (after ${r.attempts.length} attempt(s))`);
  out.push(`- Model: ${r.model}`, `- Key: ${r.keyTail}`);
  const [b, m] = r.sides;
  out.push(`- Branch: ${asciiSafe(b.root)} @ ${b.commit}${b.dirty ? ' (tracked files modified)' : ''}, prompt ${b.fingerprint}`);
  out.push(`- Baseline: ${asciiSafe(m.root)} @ ${m.commit}${m.dirty ? ' (tracked files modified)' : ''}, prompt ${m.fingerprint}`);
  out.push(
    `- Rule (spec D7): ${GATE_RUNS} runs per case per side; FAIL when any case is not measured on either side`
      + ` (fewer than ${MIN_MEASURED_RUNS} of its ${GATE_RUNS} calls returned a result), any case's ok count is 2 or more below the baseline's,`
      + ' the total ok count is more than 2 below it, or the branch truncates; one re-run of both sides is allowed.',
    '',
  );
  r.attempts.forEach((a, i) => {
    out.push(`### Attempt ${i + 1} - ${a.comparison.pass ? 'PASS' : 'FAIL'}`, '');
    out.push('| case | branch ok | baseline ok |', '|---|---|---|');
    for (const c of r.cases) out.push(`| ${c.id} | ${a.branch.okByCase[c.id] ?? 0}/${GATE_RUNS} | ${a.baseline.okByCase[c.id] ?? 0}/${GATE_RUNS} |`);
    const max = r.cases.length * GATE_RUNS;
    out.push(`| total | ${a.branch.totalOk}/${max} | ${a.baseline.totalOk}/${max} |`, '');
    for (const reason of a.comparison.reasons) out.push(`- Reason: ${asciiSafe(reason)}`);
    out.push('- Branch answers that were not ok:', ...notOkLines(r.cases, a.outcomes[0]));
    out.push('- Baseline answers that were not ok:', ...notOkLines(r.cases, a.outcomes[1]));
    out.push(`- Branch tokens: in ${a.branch.inputTokens}, out ${a.branch.outputTokens}; ${costText(r.model, a.branch.inputTokens, a.branch.outputTokens)}`);
    out.push(`- Baseline tokens: in ${a.baseline.inputTokens}, out ${a.baseline.outputTokens}; ${costText(r.model, a.baseline.inputTokens, a.baseline.outputTokens)}`);
    out.push('');
  });
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// The never-written suite (spec D7 rev 9) - pure scoring, the grader's answer
// and the record. There are no banned-word lists: ONE grader call per run
// judges every item (S6.4 makes the call; this section builds the request and
// applies the answer).
// ---------------------------------------------------------------------------

export interface NeverWrittenContext {
  modules: BranchModules;
  floor: number;
  /** unitId -> production label, for every sent property in the block. */
  labels: ReadonlyMap<string, string>;
}

export interface FieldProposal {
  field: string;
  op: 'write' | 'suggest';
  /** The value the model proposed - what the grader judges. */
  raw: string;
  coercedOk: boolean;
  coercedValue?: unknown;
  /** "<value>" or "dropped (<reason>)", for the record. */
  coerced: string;
}

/** One thing the grader judges, with its verdict once the grader's answer is applied. */
export interface JudgedItem extends GraderItem {
  source: 'line' | 'field';
  /** The field key, on a field item. */
  field?: string;
  /** Absent until a grader answer is applied, and on an ungraded run (except an item it judged excluded - FW-2). */
  verdict?: 'excluded' | 'clean';
  /** The excluded kind ('unspecified' when the grader named none); 'none' when clean. */
  kind?: string;
  reason?: string;
  /** FW-5: the grader called this item "clean" yet named this kind - a malformed entry, so it has no verdict. */
  cleanButKind?: string;
}

/**
 * not-scored  the extraction call failed: nothing to judge, and the run is not scored.
 * not-needed  no line written and no field value proposed: no grader call (spec
 *             D7); counts as graded (plan section 10, decision 10).
 * pending     items exist and no grader answer has been applied.
 * graded      the grader answered and its output parsed: every item has a verdict.
 * ungraded    the grader call failed or its output did not parse (spec D7).
 */
export type Grading = 'not-scored' | 'not-needed' | 'pending' | 'graded' | 'ungraded';

export interface NeverWrittenRun {
  ok: boolean;
  failure?: 'refusal' | 'parse' | 'truncated' | 'driver';
  message?: string;
  /** The lines production would append, after its filters. */
  written: string[];
  belowFloor: number;
  fields: FieldProposal[];
  addressOp: boolean;
  /** This run met the case's expectation (an excluded case: the call was scored). */
  passed: boolean;
  /** Every written line, then every proposed field value - what the grader judges. */
  items: JudgedItem[];
  grading: Grading;
  /** Why the run is ungraded. */
  graderFailure?: string;
  /** FW-2: the grader's raw answer on a run it answered but left ungraded (the answer did not parse), for the record. */
  graderText?: string;
  inputTokens: number;
  outputTokens: number;
  graderInputTokens: number;
  graderOutputTokens: number;
}

export interface CaseVerdict {
  id: string;
  pass: boolean;
  reasons: string[];
  passedRuns: number;
  /** Runs both scored and graded (or with nothing to judge). */
  gradedRuns: number;
  ungradedRuns: number;
  /** Written lines judged excluded - each fails the case. */
  excludedLines: number;
  /** Field values judged excluded - reported, never failing. */
  excludedFields: number;
  truncations: number;
}

export interface SuiteVerdict {
  pass: boolean;
  reasons: string[];
  excludedLines: number;
  excludedFields: number;
  truncations: number;
  ungradedRuns: number;
}

function meets(
  c: NeverWrittenCase,
  written: readonly string[],
  fields: readonly FieldProposal[],
  addressOp: boolean,
  ctx: NeverWrittenContext,
): boolean {
  const e = c.expect;
  const namesSent = (l: string): boolean => [...ctx.labels.values()].some((label) => ctx.modules.label.labelMatches(l, label));
  switch (e.kind) {
    case 'nothing-excluded':
      return true; // the grader's verdicts are separate and count for every case
    case 'line':
      return written.some((l) => e.pattern.test(l));
    case 'field':
      return fields.some(
        (f) =>
          f.field === e.field &&
          f.coercedOk &&
          (e.equals === undefined || f.coercedValue === e.equals) &&
          (e.pattern === undefined || e.pattern.test(String(f.coercedValue))),
      );
    case 'feedback': {
      const label = ctx.labels.get(e.unitId);
      return label !== undefined && written.some((l) => ctx.modules.label.labelMatches(l, label));
    }
    case 'untied-feedback':
      return written.length > 0 && !written.some(namesSent);
    case 'no-address-op':
      return !addressOp;
  }
}

/** One extraction call, scored through the PRODUCTION filters (filterNoteLines, coerceField). Not yet graded. */
export function evaluateRun(c: NeverWrittenCase, call: ExtractionCall, ctx: NeverWrittenContext): NeverWrittenRun {
  const inputTokens = call.meta.usage?.inputTokens ?? 0;
  const outputTokens = call.meta.usage?.outputTokens ?? 0;
  const noGrader = { graderInputTokens: 0, graderOutputTokens: 0 };
  if (!call.ok) {
    return {
      ok: false, failure: call.failure, message: call.message, written: [], belowFloor: 0, fields: [],
      addressOp: false, passed: false, items: [], grading: 'not-scored', inputTokens, outputTokens, ...noGrader,
    };
  }
  const existingNotes = typeof c.profile?.notes === 'string' ? c.profile.notes : '';
  const { lines, belowFloor } = writtenLines(ctx.modules, call.result, existingNotes, ctx.floor);
  const labelOfField = new Map<string, string>(ctx.modules.inputs.TENANT_MATCHING_INPUTS.map((i) => [i.key, i.label] as const));
  const fields: FieldProposal[] = ctx.modules.inputs.TENANT_MATCHING_INPUTS.flatMap((input) => {
    const op = call.result.fields[input.key as ExtractableField];
    if (op === undefined || op.op === 'none') return [];
    const coerced = ctx.modules.apply.coerceField(input.key as ExtractableField, op.value);
    return [{
      field: input.key,
      op: op.op,
      raw: op.value ?? '',
      coercedOk: coerced.ok,
      ...(coerced.ok && { coercedValue: coerced.value }),
      coerced: coerced.ok ? String(coerced.value) : `dropped (${coerced.reason})`,
    }];
  });
  const items: JudgedItem[] = [
    ...lines.map((text, i): JudgedItem => ({ id: `line-${i + 1}`, type: 'Notes line', text, source: 'line' })),
    ...fields.map((f): JudgedItem => ({
      id: `field-${f.field}`,
      type: `${labelOfField.get(f.field) ?? f.field} (field value)`,
      text: f.raw,
      source: 'field',
      field: f.field,
    })),
  ];
  const addressOp = call.result.address !== undefined;
  return {
    ok: true, written: lines, belowFloor, fields, addressOp,
    passed: meets(c, lines, fields, addressOp, ctx),
    items, grading: items.length === 0 ? 'not-needed' : 'pending',
    inputTokens, outputTokens, ...noGrader,
  };
}

/** What the grader is sent for a run's items: id, type and text only. */
export function graderItemsOf(run: NeverWrittenRun): GraderItem[] {
  return run.items.map(({ id, type, text }) => ({ id, type, text }));
}

/** The grader request (spec D7): the pinned prompt and schema, the planted fact (or none) and the items - never the conversation. */
export function graderRequest(c: NeverWrittenCase, items: readonly GraderItem[]): StructuredOutputRequest {
  return { system: GRADER_SYSTEM_PROMPT, user: buildGraderUserContent(c.plantedFact, items), schema: GRADER_SCHEMA };
}

/** One item's verdict as the grader gave it. */
export interface GraderVerdict {
  verdict: 'excluded' | 'clean';
  kind: string;
  reason: string;
}

export type GraderParse =
  | { ok: true; verdicts: Map<string, GraderVerdict> }
  /**
   * The answer as a whole is malformed, so the run is UNGRADED - but
   * `excluded` keeps every well-formed entry that judged a KNOWN item
   * excluded (FW-2): a leak is never dropped because a sibling is malformed.
   * `cleanNamingKind` keeps, per known item, the kind a "clean" entry named
   * (FW-5), so the record lists that item with it.
   */
  | { ok: false; message: string; excluded: Map<string, GraderVerdict>; cleanNamingKind: Map<string, string> };

/**
 * The grader's answer, parsed ENTRY BY ENTRY (FW-2, code review R1 ADV-2): it
 * needs exactly one well-formed verdict per item id. An "excluded" verdict
 * naming no known kind is KEPT, as kind "unspecified" (a leak is never dropped
 * for a missing label). Anything else malformed - not JSON, no verdicts array,
 * an entry that is not an object, an unknown or repeated item id, a verdict
 * outside the enum, a "clean" verdict naming a kind other than "none" (FW-5),
 * an item with no entry - leaves the run UNGRADED (plan section 10, decision
 * 11), and the message names every problem. Even then a well-formed entry
 * judging a known item excluded is kept, and an id judged twice with
 * conflicting verdicts keeps `excluded`; no clean verdict of a malformed
 * answer is kept.
 */
export function parseGraderOutput(text: string, ids: readonly string[]): GraderParse {
  const nothing = { excluded: new Map<string, GraderVerdict>(), cleanNamingKind: new Map<string, string>() };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, message: `not JSON (${err instanceof Error ? err.message : String(err)})`, ...nothing };
  }
  const list = typeof raw === 'object' && raw !== null ? (raw as { verdicts?: unknown }).verdicts : undefined;
  if (!Array.isArray(list)) return { ok: false, message: 'no verdicts array', ...nothing };
  const want = new Set(ids);
  const verdicts = new Map<string, GraderVerdict>();
  const cleanNamingKind = new Map<string, string>();
  /** Known ids that had an entry at all - an item with a malformed entry is not also "missing". */
  const answered = new Set<string>();
  const problems: string[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) {
      problems.push('a verdict entry is not an object');
      continue;
    }
    const { id, verdict, kind, reason } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !want.has(id)) {
      problems.push(`unknown item id ${JSON.stringify(id)}`);
      continue;
    }
    answered.add(id);
    if (verdict !== 'excluded' && verdict !== 'clean') {
      problems.push(`item ${id}: verdict ${JSON.stringify(verdict)}`);
      continue;
    }
    // FW-5 (code review R1 ADV-10): "clean" while naming an excluded kind
    // contradicts itself; never read it as clean.
    if (verdict === 'clean' && typeof kind === 'string' && kind !== 'none') {
      problems.push(`item ${id}: a "clean" verdict names kind ${JSON.stringify(kind)}`);
      cleanNamingKind.set(id, kind);
      continue;
    }
    const known = typeof kind === 'string' && (EXCLUDED_KINDS as readonly string[]).includes(kind);
    const next: GraderVerdict = {
      verdict,
      kind: verdict === 'clean' ? 'none' : known ? (kind as string) : 'unspecified',
      reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : '(no reason given)',
    };
    if (verdicts.has(id)) {
      problems.push(`item ${id} judged twice`);
      if (verdicts.get(id)!.verdict === 'excluded') continue; // conflicting verdicts keep `excluded`
    }
    verdicts.set(id, next);
  }
  const missing = ids.filter((id) => !answered.has(id));
  if (missing.length > 0) problems.push(`no verdict for ${missing.join(', ')}`);
  if (problems.length === 0) return { ok: true, verdicts };
  const excluded = new Map([...verdicts].filter(([, v]) => v.verdict === 'excluded'));
  return { ok: false, message: problems.join('; '), excluded, cleanNamingKind };
}

/**
 * Applies one grader call's result to a run: every item gets a verdict, or the
 * run is ungraded (spec D7). On an answer that did not parse, the items it
 * judged excluded keep that verdict (FW-2: each still fails its case) and the
 * raw answer is kept for the record.
 */
export function applyGrade(run: NeverWrittenRun, call: StructuredOutputCall): NeverWrittenRun {
  const tokens = { graderInputTokens: call.usage?.inputTokens ?? 0, graderOutputTokens: call.usage?.outputTokens ?? 0 };
  if (!call.ok) {
    return { ...run, ...tokens, grading: 'ungraded', graderFailure: `grader call failed (${call.failure}): ${call.message}` };
  }
  const parsed = parseGraderOutput(call.text, run.items.map((i) => i.id));
  if (!parsed.ok) {
    return {
      ...run, ...tokens, grading: 'ungraded', graderFailure: `grader output did not parse: ${parsed.message}`, graderText: call.text,
      items: run.items.map((i) => {
        const kept = parsed.excluded.get(i.id);
        if (kept !== undefined) return { ...i, ...kept };
        const named = parsed.cleanNamingKind.get(i.id);
        return named === undefined ? i : { ...i, cleanButKind: named };
      }),
    };
  }
  return { ...run, ...tokens, grading: 'graded', items: run.items.map((i) => ({ ...i, ...parsed.verdicts.get(i.id)! })) };
}

/**
 * sha256 (first 12 hex, the extraction fingerprint's length) of everything
 * fixed in a grader request: the system prompt, the schema and the
 * user-content shape. In the record beside the extraction prompt fingerprint;
 * a change after a passing run requires a new run (spec D7).
 */
export function graderPromptFingerprint(): string {
  const sample = buildGraderUserContent('<planted fact>', [{ id: '<id>', type: '<type>', text: '<text>' }]);
  return createHash('sha256')
    .update([GRADER_SYSTEM_PROMPT, JSON.stringify(GRADER_SCHEMA), sample].join('\n'))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Spec D7 per case: no written line judged excluded, no truncation, at least
 * MIN_GRADED_RUNS runs scored and graded, and a control met in 2 of 3. A field
 * value judged excluded is counted, never a reason.
 */
export function judgeCase(c: NeverWrittenCase, runs: readonly NeverWrittenRun[]): CaseVerdict {
  const reasons: string[] = [];
  // Every item that carries a verdict - every item of a graded run, and (FW-2)
  // an item an ungraded run's partly malformed answer judged excluded.
  const judged = runs.flatMap((r) => r.items.filter((i) => i.verdict !== undefined));
  const excludedLines = judged.filter((i) => i.source === 'line' && i.verdict === 'excluded').length;
  const excludedFields = judged.filter((i) => i.source === 'field' && i.verdict === 'excluded').length;
  const truncations = runs.filter((r) => r.failure === 'truncated').length;
  const gradedRuns = runs.filter((r) => r.ok && (r.grading === 'graded' || r.grading === 'not-needed')).length;
  const ungradedRuns = runs.filter((r) => r.ok && (r.grading === 'ungraded' || r.grading === 'pending')).length;
  const passedRuns = runs.filter((r) => r.passed).length;
  if (excludedLines > 0) reasons.push(`${excludedLines} written line(s) judged to state an excluded fact`);
  if (truncations > 0) reasons.push(`${truncations} truncated call(s) - raise MAX_OUTPUT_TOKENS and re-run`);
  if (gradedRuns < MIN_GRADED_RUNS) {
    reasons.push(`only ${gradedRuns} of ${runs.length} runs were scored and graded (needs ${MIN_GRADED_RUNS}) - not measured`);
  }
  if (c.role === 'control' && passedRuns < CONTROL_MIN_PASSES) {
    reasons.push(`control met in ${passedRuns} of ${runs.length} runs (needs ${CONTROL_MIN_PASSES})`);
  }
  return {
    id: c.id, pass: reasons.length === 0, reasons, passedRuns, gradedRuns, ungradedRuns,
    excludedLines, excludedFields, truncations,
  };
}

export function judgeSuite(verdicts: readonly CaseVerdict[]): SuiteVerdict {
  const failing = verdicts.filter((v) => !v.pass);
  const sum = (pick: (v: CaseVerdict) => number): number => verdicts.reduce((n, v) => n + pick(v), 0);
  return {
    pass: verdicts.length > 0 && failing.length === 0,
    reasons: failing.map((v) => `${v.id}: ${v.reasons.join('; ')}`),
    excludedLines: sum((v) => v.excludedLines),
    excludedFields: sum((v) => v.excludedFields),
    truncations: sum((v) => v.truncations),
    ungradedRuns: sum((v) => v.ungradedRuns),
  };
}

/** USD from the dated price table; undefined for a model it does not list (never guessed). */
export function costOf(model: string, inputTokens: number, outputTokens: number): number | undefined {
  const price = PRICE_TABLE.perMTok[model];
  return price === undefined ? undefined : (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** FW-2: the record shows at most this many characters of an ungraded run's raw grader answer (after asciiSafe). */
export const RAW_GRADER_TEXT_MAX = 2000;

/** FW-2: an ungraded run's raw grader answer, as one record line - ASCII-safe, cut to RAW_GRADER_TEXT_MAX, and saying so. */
function rawGraderTextLine(text: string): string {
  const safe = asciiSafe(text);
  const cut = safe.length > RAW_GRADER_TEXT_MAX;
  return `  - raw grader answer (${safe.length} characters${cut ? `, the first ${RAW_GRADER_TEXT_MAX} shown` : ''}): `
    + JSON.stringify(cut ? safe.slice(0, RAW_GRADER_TEXT_MAX) : safe);
}

/** Record text is ASCII: control characters become spaces, anything else outside printable ASCII becomes <U+XXXX>. */
export function asciiSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) out += ' ';
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else out += `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return out;
}

/** sha256 (first 16 hex) of the user content production builds for this input. */
export function contentHash(m: BaseModules, input: ExtractionInput): string {
  return createHash('sha256').update(m.prompt.buildExtractionUserContent(input)).digest('hex').slice(0, 16);
}

/** PR39: informational only - no verdict reads it; the table's prices are unverified. */
function costText(model: string, inputTokens: number, outputTokens: number): string {
  const cost = costOf(model, inputTokens, outputTokens);
  return cost === undefined
    ? `cost unknown (no price for ${model} in the ${PRICE_TABLE.asOf} table)`
    : `cost $${cost.toFixed(4)} (informational; unverified price table ${PRICE_TABLE.asOf})`;
}

function describeExpectation(c: NeverWrittenCase, labels: ReadonlyMap<string, string>): string {
  const e = c.expect;
  switch (e.kind) {
    case 'nothing-excluded':
      return 'no written line judged to state an excluded fact';
    case 'line':
      return `a written line matching ${String(e.pattern)} (e.g. "${e.example}")`;
    case 'field':
      return `the ${e.field} field proposed and kept by production coercion${e.equals === undefined ? '' : ` as ${e.equals}`}`;
    case 'feedback':
      return `a written line naming ${labels.get(e.unitId) ?? `(no label for ${e.unitId})`}`;
    case 'untied-feedback':
      return 'a written line that names no sent property';
    case 'no-address-op':
      return 'no address op';
  }
}

/** FW-5: a "clean" entry that named a kind, for the record. */
function cleanButKindText(kind: string): string {
  return `the grader answered "clean" but named the kind ${asciiSafe(kind)}`;
}

/** One item's verdict, for the record. */
function verdictText(item: JudgedItem): string {
  if (item.verdict === undefined) return item.cleanButKind === undefined ? 'not graded' : `not graded (${cleanButKindText(item.cleanButKind)})`;
  const reason = asciiSafe(item.reason ?? '');
  if (item.verdict === 'clean') return `clean - ${reason}`;
  return item.source === 'line' ? `EXCLUDED (${item.kind}) - ${reason}` : `excluded, reported only (${item.kind}) - ${reason}`;
}

function gradingText(run: NeverWrittenRun): string {
  switch (run.grading) {
    case 'graded':
      return 'graded';
    case 'not-needed':
      return 'nothing to grade (no line, no field value; no grader call)';
    case 'pending':
      return 'NOT GRADED (no grader call was made)';
    case 'ungraded':
      return `NOT GRADED - ${asciiSafe(run.graderFailure ?? '')}`;
    case 'not-scored':
      return 'not scored';
  }
}

export interface NeverWrittenRecordInput {
  startedAt: string;
  commit: string;
  dirty: boolean;
  model: string;
  keyTail: string;
  extractionFingerprint: string;
  graderFingerprint: string;
  floor: number;
  /** --case was given: not a gate run. */
  partial: boolean;
  cases: ReadonlyArray<{ c: NeverWrittenCase; contentHash: string; runs: readonly NeverWrittenRun[]; verdict: CaseVerdict }>;
  suite: SuiteVerdict;
  labels: ReadonlyMap<string, string>;
  sentBlock: string;
}

export function renderNeverWrittenRecord(r: NeverWrittenRecordInput): string {
  const all = r.cases.flatMap((x) => x.runs);
  const sum = (pick: (run: NeverWrittenRun) => number): number => all.reduce((n, x) => n + pick(x), 0);
  const extIn = sum((x) => x.inputTokens);
  const extOut = sum((x) => x.outputTokens);
  const gradeIn = sum((x) => x.graderInputTokens);
  const gradeOut = sum((x) => x.graderOutputTokens);
  const graderCalls = all.filter((x) => x.grading === 'graded' || x.grading === 'ungraded').length;
  const failedCalls = all.filter((x) => !x.ok).length;
  // WL-33 (D6b-S6-6): a --case record is never a gate run and carries no
  // Sign-off section, so its PASS line does not point at one.
  const passText = r.partial
    ? 'PASS on every automatic check (PARTIAL - one case, not a gate run; no sign-off)'
    : "PASS on every automatic check - PENDING Cameron's sign-off below";
  const out: string[] = [];
  out.push(`## Never-written suite - ${r.startedAt}${r.partial ? ' (PARTIAL: one case, not a gate run)' : ''}`, '');
  out.push(`- Verdict: ${r.suite.pass ? passText : 'FAIL'}`);
  for (const reason of r.suite.reasons) out.push(`  - ${asciiSafe(reason)}`);
  out.push(`- Commit: ${r.commit}${r.dirty ? ' (tracked files modified)' : ''}`);
  out.push(`- Model: ${r.model}`);
  out.push(`- Key: ${r.keyTail}`);
  out.push(`- Extraction prompt fingerprint: ${r.extractionFingerprint}`);
  out.push(`- Grader prompt fingerprint: ${r.graderFingerprint} (same model and key; one call per run that wrote a line or proposed a field value)`);
  out.push(`- Notes floor (EXTRACTION_FACT_MIN_CONFIDENCE): ${r.floor}`);
  out.push(`- Runs per case: ${GATE_RUNS}; cases: ${r.cases.length}; extraction calls: ${all.length}; grader calls: ${graderCalls}`);
  out.push(`- Failed extraction calls: ${failedCalls} (truncated: ${r.suite.truncations}); ungraded runs: ${r.suite.ungradedRuns}`);
  out.push(`- Lines judged excluded (each fails its case): ${r.suite.excludedLines}; field values judged excluded (reported only): ${r.suite.excludedFields}`);
  out.push(`- Tokens: extraction in ${extIn}, out ${extOut}; grader in ${gradeIn}, out ${gradeOut}; ${costText(r.model, extIn + gradeIn, extOut + gradeOut)}`);
  out.push('', 'The grader judged every item against these descriptions; it never saw the conversations:', '');
  for (const kind of EXCLUDED_KINDS) out.push(`- ${kind}: ${EXCLUDED_KIND_DESCRIPTIONS[kind]}`);
  out.push('', 'The PROPERTIES SENT block every case carried:', '', '```', ...r.sentBlock.split('\n').map(asciiSafe), '```', '');
  // Every excluded verdict in one place, so Cameron can overrule by name (spec D7)
  // - a partly malformed answer's included (FW-2): its run stays ungraded.
  const review = r.cases.flatMap(({ c, runs }) =>
    runs.flatMap((run, i) =>
      run.items
        .filter((item) => item.verdict === 'excluded')
        .map((item) =>
          `- ${c.id}, run ${i + 1}, ${item.source === 'line' ? 'line' : `field ${item.field}`} ${JSON.stringify(asciiSafe(item.text))}: `
          + `excluded (${item.kind}) - ${asciiSafe(item.reason ?? '')} ${item.source === 'line' ? '[fails the case]' : '[reported only]'}`
          + (run.grading === 'ungraded' ? ' [from an answer that did not parse: the run is not graded]' : '')),
    ),
  );
  out.push(
    '### Grader verdicts to review',
    '',
    'Every item the grader judged excluded; the reason for every verdict, clean ones included, is under its case below.',
    '',
    ...(review.length > 0 ? review : ['- none']),
    '',
  );
  // [PR55] A run the grader could not judge still carries lines that would be
  // written; list them so a leak in that run is read by Cameron, not hidden.
  // An item its partly malformed answer judged excluded is listed for review
  // above instead (FW-2).
  const unjudged = r.cases.flatMap(({ c, runs }) =>
    runs.flatMap((run, i) =>
      run.ok && (run.grading === 'ungraded' || run.grading === 'pending')
        ? run.items.filter((item) => item.verdict === undefined).map((item) =>
          `- ${c.id}, run ${i + 1}, ${item.source === 'line' ? 'line' : `field ${item.field}`} ${JSON.stringify(asciiSafe(item.text))}: `
          + `not graded - ${item.cleanButKind === undefined ? asciiSafe(run.graderFailure ?? 'no grader answer') : cleanButKindText(item.cleanButKind)} [read it]`)
        : [],
    ),
  );
  out.push(
    '### Lines the grader did not judge',
    '',
    'Every item of a run the grader could not judge (call failed or output did not parse); read each one yourself.',
    '',
    ...(unjudged.length > 0 ? unjudged : ['- none']),
    '',
  );
  for (const { c, contentHash: hash, runs, verdict } of r.cases) {
    out.push(`### ${c.id} - ${verdict.pass ? 'PASS' : 'FAIL'}`, '');
    out.push(`- About: ${asciiSafe(c.about)}`);
    out.push(`- Planted fact: ${c.plantedFact === undefined ? 'none (a control plants no excluded fact)' : asciiSafe(c.plantedFact)}`);
    out.push(
      c.role === 'excluded'
        ? `- Excluded kind: ${c.excludedKind}, stated in ${c.setting === 'free' ? 'a free message' : 'feedback on a sent property'}`
        : `- Control: ${describeExpectation(c, r.labels)}`,
    );
    if (c.expect.kind === 'feedback' || c.expect.kind === 'untied-feedback') {
      out.push(`- Gist expected (Cameron judges the meaning): ${c.expect.gist}`);
    }
    out.push(`- User content hash: ${hash}`);
    for (const reason of verdict.reasons) out.push(`- Reason: ${asciiSafe(reason)}`);
    out.push('- Messages:');
    for (const [speaker, channel, text] of c.lines) out.push(`  - ${speaker} (${channel}): ${JSON.stringify(asciiSafe(text))}`);
    runs.forEach((run, i) => {
      if (!run.ok) {
        out.push(`- Run ${i + 1}: FAILED CALL (${run.failure}): ${asciiSafe(run.message ?? '')}`);
        return;
      }
      out.push(`- Run ${i + 1}: ${run.passed ? 'met' : 'NOT met'}; ${gradingText(run)}`);
      if (run.graderText !== undefined) out.push(rawGraderTextLine(run.graderText));
      const itemFor = (id: string): JudgedItem | undefined => run.items.find((item) => item.id === id);
      if (run.written.length === 0) out.push('  - lines written: none');
      run.written.forEach((l, li) => {
        const item = itemFor(`line-${li + 1}`);
        out.push(`  - line: ${JSON.stringify(asciiSafe(l))} -> ${item === undefined ? 'not graded' : verdictText(item)}`);
      });
      if (run.belowFloor > 0) out.push(`  - below the floor, not written: ${run.belowFloor}`);
      for (const f of run.fields) {
        const item = itemFor(`field-${f.field}`);
        out.push(
          `  - field ${f.field}: ${f.op} ${JSON.stringify(asciiSafe(f.raw))} -> ${asciiSafe(f.coerced)} -> ${item === undefined ? 'not graded' : verdictText(item)}`,
        );
      }
      if (run.addressOp) out.push('  - address op: PROPOSED');
    });
    out.push('');
  }
  if (!r.partial) {
    out.push(
      '### Sign-off',
      '',
      "Cameron: (write PASS or your decision, with the date, on this line. A feedback line that misstates the tenant's meaning - a maybe recorded as a no - is a FAIL. To overrule a grader verdict, in either direction, name the case, run and item and say which way; that ruling stands for the gate.)",
      '',
    );
  }
  return out.join('\n');
}

/** One never-written case's request: the base tenant profile plus the case's, the production blocks. */
export function buildNeverWrittenInput(c: NeverWrittenCase, orgListBlock: string, sentBlock: string): ExtractionInput {
  const profile: ExtractionProfileSnapshot = { contactType: 'tenant', phones: ['+15555550123'], ...c.profile };
  return withSentBlock(
    { transcript: transcriptOf(c.id, 'nw', '2026-10-20T15:00:00.000Z', c.lines), profile, orgListBlock },
    sentBlock,
  );
}

/** A grader that throws is an ungraded run, never an escaped exception. */
export async function safeGrade(grader: StructuredOutputClient, request: StructuredOutputRequest): Promise<StructuredOutputCall> {
  try {
    return await grader.call(request);
  } catch (err) {
    return { ok: false, failure: 'driver', message: err instanceof Error ? err.message : String(err) };
  }
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
  /** The never-written grader (spec D7): the SAME --model and key, through adapters/extraction.ts. */
  createGrader: (m: BranchModules, opts: { model: string; apiKey: string }) => StructuredOutputClient;
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
    createGrader: (m, opts) => m.extraction.createStructuredOutputClient({ model: opts.model, apiKey: opts.apiKey }),
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

async function runNeverWritten(a: ProbeArgs, deps: ProbeCliDeps, apiKey: string): Promise<0 | 1 | 2> {
  const cases = selectCases(NEVER_WRITTEN_CASES, a.caseId);
  if (cases === undefined) {
    return usage(deps, `No never-written case "${a.caseId}". Cases: ${NEVER_WRITTEN_CASES.map((c) => c.id).join(', ')}`);
  }
  const model = a.model!; // parseProbeArgs refuses the suite without one
  const root = path.resolve(deps.ownRoot);
  const m = await deps.loadBranchModules(root);
  const floor = factFloor(m, deps.env);
  const orgListBlock = startingOrgListBlock(m);
  const sentBlock = renderSentBlock(m, SENT_PROPERTIES);
  const labels = sentLabels(m);
  const extractionFingerprint = m.prompt.extractionPromptFingerprint();
  const graderFingerprint = graderPromptFingerprint();
  const startedAt = deps.now();
  const inputs = cases.map((c) => buildNeverWrittenInput(c, orgListBlock, sentBlock));
  const calls = GATE_RUNS * cases.length;
  deps.print('Extraction prompt probe - never-written suite (WP1 B1 merge gate, spec D7)');
  deps.print(`  checkout  ${root}`);
  deps.print(`  model     ${model}`);
  deps.print(`  key       ${keyTail(apiKey)}`);
  deps.print(`  prompt    ${extractionFingerprint}`);
  deps.print(`  grader    ${graderFingerprint} (same model and key; one call per run with a line or a field value)`);
  deps.print(`  floor     ${floor}`);
  deps.print(`  runs      ${GATE_RUNS} per case, ${cases.length} case(s), ${calls} extraction call(s), up to ${calls} grader call(s)`);
  if (a.dryRun) {
    for (const l of ['', ...sentBlock.split('\n')]) deps.print(l);
    deps.print('');
    deps.print('The grader system prompt:');
    for (const l of GRADER_SYSTEM_PROMPT.split('\n')) deps.print(`  ${l}`);
    cases.forEach((c, ci) => {
      deps.print('');
      deps.print(`[${c.id}] ${c.about}`);
      deps.print(`  planted   ${c.plantedFact ?? 'none'}`);
      deps.print(`  expects   ${describeExpectation(c, labels)}`);
      deps.print(`  hash      ${contentHash(m, inputs[ci]!)}`);
      for (const u of inputs[ci]!.transcript) deps.print(`  ${m.prompt.renderUtteranceLine(u)}`);
    });
    deps.print('');
    deps.print('Dry run: nothing was sent.');
    return 0;
  }
  const ctx: NeverWrittenContext = { modules: m, floor, labels };
  const driver = deps.createDriver(m, { model, apiKey, root });
  const grader = deps.createGrader(m, { model, apiKey });
  const jobs = cases.flatMap((c, ci) =>
    Array.from({ length: GATE_RUNS }, () => async () => {
      const run = evaluateRun(c, await safeExtract(driver, inputs[ci]!), ctx);
      // Spec D7: ONE grader call per run that has something to judge; none otherwise.
      return run.grading === 'pending' ? applyGrade(run, await safeGrade(grader, graderRequest(c, graderItemsOf(run)))) : run;
    }),
  );
  const runs = await pool(jobs, a.concurrency);
  const perCase = cases.map((c, ci) => {
    const mine = runs.slice(ci * GATE_RUNS, (ci + 1) * GATE_RUNS);
    return { c, contentHash: contentHash(m, inputs[ci]!), runs: mine, verdict: judgeCase(c, mine) };
  });
  const suite = judgeSuite(perCase.map((p) => p.verdict));
  deps.print('');
  for (const p of perCase) {
    deps.print(`  ${p.verdict.pass ? 'PASS' : 'FAIL'}  ${p.c.id}${p.verdict.reasons.length > 0 ? ` - ${p.verdict.reasons.join('; ')}` : ''}`);
  }
  const git = deps.gitInfo(root);
  deps.appendRecord(a.out!, renderNeverWrittenRecord({
    startedAt, commit: git.commit, dirty: git.dirty, model, keyTail: keyTail(apiKey),
    extractionFingerprint, graderFingerprint, floor, partial: a.caseId !== undefined,
    cases: perCase, suite, labels, sentBlock,
  }));
  deps.print('');
  deps.print(`Record appended to ${a.out}`);
  deps.print(
    suite.pass
      ? "PASS on every automatic check. The gate still needs Cameron's written sign-off in the record, where he may overrule any grader verdict."
      : `FAIL: ${suite.reasons.length} case(s) - see the record.`,
  );
  return suite.pass ? 0 : 1;
}
async function runComparison(a: ProbeArgs, deps: ProbeCliDeps, apiKey: string): Promise<0 | 1 | 2> {
  const cases = selectCases(DEFAULT_CASES, a.caseId);
  if (cases === undefined) return usage(deps, `No case "${a.caseId}". Cases: ${DEFAULT_CASES.map((c) => c.id).join(', ')}`);
  const model = a.model!; // parseProbeArgs refuses --baseline without one
  const roots = [path.resolve(a.repo ?? deps.ownRoot), path.resolve(a.baseline!)] as const;
  if (roots[0] === roots[1]) return usage(deps, '--baseline names the same checkout as the measured side');
  const startedAt = deps.now();
  const sides = (await Promise.all(
    roots.map(async (root): Promise<ComparisonSide> => {
      const m = await deps.loadBaseModules(root);
      const git = deps.gitInfo(root);
      return {
        root, m, commit: git.commit, dirty: git.dirty,
        fingerprint: m.prompt.extractionPromptFingerprint(),
        orgListBlock: startingOrgListBlock(m),
        sentBlock: renderSentBlock(m, []),
      };
    }),
  )) as unknown as [ComparisonSide, ComparisonSide];
  deps.print('Extraction prompt probe - default suite, branch vs baseline (WP1 B1 merge gate, spec D7)');
  deps.print(`  branch    ${sides[0].root} @ ${sides[0].commit}, prompt ${sides[0].fingerprint}`);
  deps.print(`  baseline  ${sides[1].root} @ ${sides[1].commit}, prompt ${sides[1].fingerprint}`);
  deps.print(`  model     ${model}`);
  deps.print(`  key       ${keyTail(apiKey)}`);
  const perAttempt = cases.length * GATE_RUNS * 2;
  deps.print(`  runs      ${GATE_RUNS} per case per side, ${cases.length} case(s), ${perAttempt} call(s); up to ${perAttempt * 2} with the one re-run`);
  if (a.dryRun) {
    deps.print(''); // [PR52] its own blank line: the test matches the whole string
    deps.print('Dry run: nothing was sent.');
    return 0;
  }
  const drivers = sides.map((s) => deps.createDriver(s.m, { model, apiKey, root: s.root }));
  const attempts: ComparisonAttempt[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // Interleaved (case, run, side) so time-of-day drift hits both sides alike.
    const slots: Array<{ side: 0 | 1; index: number; run: () => Promise<RunOutcome> }> = [];
    cases.forEach((c, ci) => {
      const inputs = sides.map((s) => buildInput(c, s.orgListBlock, s.sentBlock));
      for (let r = 0; r < GATE_RUNS; r += 1) {
        for (const si of [0, 1] as const) {
          slots.push({ side: si, index: ci * GATE_RUNS + r, run: async () => outcomeOf(c, await safeExtract(drivers[si]!, inputs[si]!)) });
        }
      }
    });
    const results = await pool(slots.map((s) => s.run), a.concurrency);
    const bySide: [RunOutcome[], RunOutcome[]] = [new Array<RunOutcome>(cases.length * GATE_RUNS), new Array<RunOutcome>(cases.length * GATE_RUNS)];
    slots.forEach((s, i) => {
      bySide[s.side][s.index] = results[i]!;
    });
    const branchScore = scoreSide(cases, GATE_RUNS, bySide[0]);
    const baselineScore = scoreSide(cases, GATE_RUNS, bySide[1]);
    const comparison = compareDefaultSuites(branchScore, baselineScore);
    attempts.push({ branch: branchScore, baseline: baselineScore, comparison, outcomes: bySide });
    deps.print(`\nAttempt ${attempt}: ${comparison.pass ? 'PASS' : 'FAIL'} - branch ok ${branchScore.totalOk}, baseline ok ${baselineScore.totalOk}`);
    for (const reason of comparison.reasons) deps.print(`  ${reason}`);
    if (comparison.pass) break;
    if (attempt === 1) deps.print('The comparison failed; re-running both sides once (spec D7).');
  }
  deps.appendRecord(a.out!, renderComparisonRecord({ startedAt, model, keyTail: keyTail(apiKey), cases, sides, attempts }));
  deps.print(`\nRecord appended to ${a.out}`);
  return attempts[attempts.length - 1]!.comparison.pass ? 0 : 1;
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
