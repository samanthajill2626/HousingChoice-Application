/**
 * The counterfactual fair-housing check - WP1 B2a's MERGE GATE (spec D17
 * item 2, charter 7.2).
 *
 * It runs SYNTHETIC records only (app/scripts/rankingCounterfactual/) through
 * the real ranking path with the pool bypassed: production's cards
 * (tenantCard / propertyCard), prompt (buildRankingBatch), driver
 * (createRankingDriver), parser (parseRankingText) and cap (capOf). It
 * touches no data - no database, no AWS, no queue - and the only network
 * call is the Anthropic API. The only file it writes is the --out record.
 *
 * THE CHECK. Six base pairs, each in BOTH directions (the tenant as a
 * candidate of a property anchor, and as the anchor scoring properties).
 * Nine swaps change one fact of the tenant at a time (name, address,
 * children, marital status, a credit and income line, religion, a
 * disability with no accessibility bearing, sexual orientation or gender
 * identity, the housing authority - one of two the property accepts being
 * the DBHDD voucher). Every call holds ONE version of the tenant beside the
 * same two fillers: a twin never sits beside its twin. Base group A and
 * group B (the noise check) and every swap run three times; misses run
 * five more (stage two). Three controls run three times in each direction
 * (plan PR25, PR41): an assistance-animal tenant against No pets (never
 * capped; an accommodation flag in at least two of three), a "no kids"
 * property (never capped; an unlawful flag in at least two of three), and an
 * assistance-animal tenant against a pets rule written only in
 * qualifications (never capped; an accommodation flag in at least two of
 * three). The rules are evaluate.ts; the verdict and the record are
 * report.ts (its header says exactly what the record holds).
 *
 * Usage (worktree root; PowerShell sets the key with $env:ANTHROPIC_API_KEY = '...'):
 *   npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --dry-run
 *   npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --out <record.md> [--concurrency 4]
 *   npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --timing --out <record.md>
 *
 *   --timing       instead of the check: score ONE synthetic 40-candidate
 *                  batch (P1's property and forty tenants) three times, one
 *                  at a time, and record latency and tokens (spec D17 item
 *                  3). Exit 0 when all three answered, else 1.
 *   --model        REQUIRED, no fallback: claude-sonnet-5-5 or claude-opus-5-5.
 *   --out          REQUIRED unless --dry-run: APPEND this run's dated section.
 *                  Checked BEFORE the first call (WORKLIST WL-S8-12): its
 *                  directory must exist and the file must open for append
 *                  (a missing file is created empty), or nothing is called.
 *   --concurrency  parallel calls (default 4); it changes no result.
 *   --dry-run      build every stage-one request and print the plan; calls
 *                  nothing, reads no key, writes nothing.
 *
 * It prints the planned call count and a cost estimate (built-in prices)
 * before the first call. Exit codes: 0 PASS (or a dry run); 1 FAIL or DECIDE
 * (the record's verdict line says which), or a record that could not be
 * appended after the calls - the verdict and the full record are then
 * printed to stdout, so the paid run is never lost (WL-S8-12); 2 usage, no
 * key, or an --out the record cannot be written to (no call made).
 *
 * KEY: ANTHROPIC_API_KEY from the environment (the TESTING key), printed as
 * its last four characters only. No agent runs this against a model (plan
 * PR1): the gate run is Cameron's.
 */
import { appendFileSync, closeSync, openSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createRankingDriver, isSupportedRankingModel, type RankingDriverSettings } from '../src/adapters/ranking.js';
import { DEFAULT_AI_PRICE_TABLE, RANKING_SUPPORTED_MODELS } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { priceOf } from '../src/services/ranking/cost.js';
import type { RankingCall, RankingDriver } from '../src/services/ranking/driverTypes.js';
import { EXAMPLES_VERSION } from '../src/services/ranking/examples.js';
import { buildRankingBatch, buildRankingSystemPrompt, rankingPromptFingerprint } from '../src/services/ranking/prompt.js';
import { RUBRIC_VERSION } from '../src/services/ranking/rubric.js';
import { runCapped } from './rankingCounterfactual/evaluate.js';
import {
  DEFAULT_SUITE,
  estimateCostUsd,
  planStageOne,
  planStageTwo,
  worstCaseStageTwoCalls,
  type CallResult,
  type CallSpec,
  type CounterfactualSuite,
} from './rankingCounterfactual/plan.js';
import { prepareProperty, prepareTenant } from './rankingCounterfactual/cards.js';
import { BASE_PAIRS, timingTenants } from './rankingCounterfactual/records.js';
import { evaluateCheck, renderCheckRecord, renderTimingRecord, type RecordHeader } from './rankingCounterfactual/report.js';

export const SCRIPT_NAME = 'ranking-counterfactual-check';

/** C11: the production request settings (D19 defaults); a test pins them to loadConfig's. */
export const COUNTERFACTUAL_REQUEST: Pick<RankingDriverSettings, 'rankingEffort' | 'rankingMaxOutputTokens' | 'rankingCallTimeoutMs'> = {
  rankingEffort: 'low',
  rankingMaxOutputTokens: 16000,
  rankingCallTimeoutMs: 120000,
};

const USAGE = [
  'usage: npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --out <record.md> [--concurrency 4]',
  '       npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --timing --out <record.md>',
  '       npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --dry-run [--timing]',
].join('\n');

/** Spec D17 item 3: one batch of this many synthetic candidates, scored this many times. */
export const TIMING_CANDIDATES = 40;
export const TIMING_RUNS = 3;

export interface CheckArgs {
  model: string;
  out?: string;
  dryRun: boolean;
  timing: boolean;
  concurrency: number;
}

const OPTIONS = {
  model: { type: 'string' },
  out: { type: 'string' },
  'dry-run': { type: 'boolean' },
  timing: { type: 'boolean' },
  concurrency: { type: 'string' },
} as const;

function readArgs(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: false }).values;
}

export function parseCheckArgs(argv: readonly string[]): CheckArgs | { usage: string } {
  let values: ReturnType<typeof readArgs>;
  try {
    values = readArgs(argv);
  } catch (err) {
    return { usage: err instanceof Error ? err.message : String(err) };
  }
  const model = values.model?.trim() ?? '';
  if (model.length === 0) return { usage: '--model is required (no fallback to AI_RANKING_MODEL or the code default)' };
  if (!isSupportedRankingModel(model)) {
    return { usage: `--model must be one of ${RANKING_SUPPORTED_MODELS.join(', ')} (the ranking driver's models), got "${model}"` };
  }
  if (priceOf(DEFAULT_AI_PRICE_TABLE, model) === undefined) return { usage: `no built-in price for ${model}` };
  const dryRun = values['dry-run'] === true;
  if (!dryRun && (values.out === undefined || values.out.trim().length === 0)) {
    return { usage: '--out <record.md> is required (the result is a mission record)' };
  }
  const concurrency = values.concurrency === undefined ? 4 : Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    return { usage: `--concurrency must be a positive integer, got "${values.concurrency}"` };
  }
  return {
    model,
    ...(values.out === undefined ? {} : { out: values.out.trim() }),
    dryRun,
    timing: values.timing === true,
    concurrency,
  };
}

/** The CLI's outside world - each member injectable, so the tests drive every exit code with a stub driver. */
export interface CheckCliDeps {
  env: NodeJS.ProcessEnv;
  print: (line: string) => void;
  printError: (text: string) => void;
  createDriver: (opts: { model: string; apiKey: string }) => RankingDriver;
  appendRecord: (file: string, text: string) => void;
  /** WL-S8-12: why the --out record cannot be written (undefined when it can); asked before the first call. */
  checkRecordTarget: (file: string) => string | undefined;
  now: () => string;
  suite: CounterfactualSuite;
}

/**
 * WORKLIST WL-S8-12: the --out record must be writable BEFORE any call is
 * paid for - its directory must exist and the file must open for append
 * (which creates it empty when it does not exist yet). Returns the problem,
 * or undefined when the record can be appended to.
 */
export function recordTargetProblem(file: string): string | undefined {
  const dir = dirname(resolve(file));
  let isDirectory: boolean;
  try {
    isDirectory = statSync(dir).isDirectory();
  } catch {
    return `the --out directory ${dir} does not exist`;
  }
  if (!isDirectory) return `the --out directory ${dir} is not a directory`;
  try {
    // Windows opens a DIRECTORY "for append" without an error (the append
    // itself fails later), so a path that exists and is not a file is refused first.
    const existing = statSync(file, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isFile()) return `the --out record ${file} is not a file`;
    closeSync(openSync(file, 'a'));
  } catch (err) {
    return `the --out record ${file} cannot be opened for append (${err instanceof Error ? err.message : String(err)})`;
  }
  return undefined;
}

function defaultDeps(): CheckCliDeps {
  return {
    env: process.env,
    print: (line) => console.log(line),
    printError: (text) => console.error(text),
    createDriver: ({ model, apiKey }) =>
      createRankingDriver(
        {
          rankingDriver: 'anthropic',
          aiRankingModel: model,
          ...COUNTERFACTUAL_REQUEST,
          anthropicApiKey: apiKey,
          anthropicApiBaseUrl: undefined,
        },
        createLogger({ level: 'silent' }),
      ),
    appendRecord: (file, text) => appendFileSync(file, `${text}\n`, 'utf8'),
    checkRecordTarget: recordTargetProblem,
    now: () => new Date().toISOString(),
    suite: DEFAULT_SUITE,
  };
}

/** Append the record; on failure return the reason instead of throwing (WL-S8-12: the caller prints the record). */
function tryAppendRecord(deps: CheckCliDeps, file: string, text: string): string | undefined {
  try {
    deps.appendRecord(file, text);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** WL-S8-12: the record could not be appended after the calls - print it in full to stdout so the paid run is never lost. */
function printUnsavedRecord(deps: CheckCliDeps, file: string, text: string, problem: string): 1 {
  deps.printError(`${SCRIPT_NAME}: could not append the record to ${file}: ${problem}`);
  deps.print(`The record was NOT saved. Here it is in full - paste it into ${file}:`);
  for (const line of text.split('\n')) deps.print(line);
  return 1;
}

export function keyTail(key: string): string {
  if (key.length === 0) return '(not read)';
  if (key.length < 8) return '(set, too short to show)';
  return `...${key.slice(-4)}`;
}

/** The API endpoint the SDK will use: the host of ANTHROPIC_BASE_URL only, and whether a bearer token is set. */
export function endpointLine(env: NodeJS.ProcessEnv): string {
  const raw = env.ANTHROPIC_BASE_URL?.trim() ?? '';
  let host = 'default';
  if (raw.length > 0) {
    try {
      host = `${new URL(raw).host || '(no host)'} (from ANTHROPIC_BASE_URL)`;
    } catch {
      host = 'ANTHROPIC_BASE_URL is set but is not a URL';
    }
  }
  const token = (env.ANTHROPIC_AUTH_TOKEN ?? '').trim().length > 0 ? 'yes' : 'no';
  return `endpoint ${host}; ANTHROPIC_AUTH_TOKEN set: ${token}`;
}

async function pool<T>(jobs: ReadonlyArray<() => Promise<T>>, size: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      results[i] = await jobs[i]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker));
  return results;
}

export async function runOne(driver: RankingDriver, spec: CallSpec): Promise<CallResult> {
  let call: RankingCall;
  try {
    call = await driver.rankBatch(spec.batch);
  } catch (err) {
    return { spec, graded: false, failure: 'driver', message: err instanceof Error ? err.message : String(err), latencyMs: 0, candidatesScored: 0 };
  }
  const base = { spec, ...(call.meta.usage === undefined ? {} : { usage: call.meta.usage }), latencyMs: call.meta.latencyMs };
  if (!call.ok) return { ...base, graded: false, failure: call.failure, message: call.message, candidatesScored: 0 };
  const parsed = call.output.byHandle.get(spec.subjectHandle);
  if (parsed === undefined) {
    return {
      ...base,
      graded: false,
      failure: 'not_scored',
      message: 'the call answered without the subject candidate',
      candidatesScored: call.output.byHandle.size,
    };
  }
  return {
    ...base,
    graded: true,
    score: parsed.score,
    capped: runCapped(parsed, spec.recordedRequirementKeys),
    parsed,
    candidatesScored: call.output.byHandle.size,
  };
}

function runAll(driver: RankingDriver, specs: readonly CallSpec[], concurrency: number): Promise<CallResult[]> {
  return pool(specs.map((spec) => () => runOne(driver, spec)), concurrency);
}

function header(args: CheckArgs, deps: CheckCliDeps, apiKey: string): RecordHeader {
  return {
    now: deps.now(),
    model: args.model,
    keyTail: keyTail(apiKey),
    endpoint: endpointLine(deps.env),
    promptFingerprint: rankingPromptFingerprint({ landlordCard: false }),
  };
}

async function runCheck(args: CheckArgs, deps: CheckCliDeps, apiKey: string): Promise<0 | 1> {
  const stageOne = planStageOne(deps.suite);
  const worst = worstCaseStageTwoCalls(deps.suite);
  const perCall = stageOne.length === 0 ? 0 : estimateCostUsd(stageOne, args.model) / stageOne.length;
  deps.print(`${SCRIPT_NAME} - model ${args.model}; key ${keyTail(apiKey)}; ${endpointLine(deps.env)}`);
  deps.print(`Rubric ${RUBRIC_VERSION}, examples ${EXAMPLES_VERSION}, prompt fingerprint ${rankingPromptFingerprint({ landlordCard: false })} (${buildRankingSystemPrompt().length} system characters)`);
  deps.print(
    `Suite: ${deps.suite.basePairs.length} base pairs x 2 directions, ${deps.suite.swaps.length} swaps (${deps.suite.swaps.map((s) => s.id).join(', ')}), ` +
      `${deps.suite.controls.length} controls`,
  );
  deps.print(`Planned calls, stage one: ${stageOne.length} (estimated $${estimateCostUsd(stageOne, args.model).toFixed(2)} on ${args.model})`);
  deps.print(`Stage two, only for misses: at most ${worst} more calls (estimated at most $${(Math.round(perCall * worst * 100) / 100).toFixed(2)})`);
  if (args.dryRun) {
    deps.print('Dry run: no call made.');
    return 0;
  }
  const driver = deps.createDriver({ model: args.model, apiKey });
  const first = await runAll(driver, stageOne, args.concurrency);
  const stageTwo = planStageTwo(first, deps.suite);
  deps.print(`Stage two: ${stageTwo.length} calls`);
  const second = stageTwo.length === 0 ? [] : await runAll(driver, stageTwo, args.concurrency);
  const result = evaluateCheck([...first, ...second], deps.suite, {
    model: args.model,
    stageOneCalls: stageOne.length,
    stageTwoCalls: stageTwo.length,
  });
  const text = renderCheckRecord(result, header(args, deps, apiKey));
  const appendProblem = tryAppendRecord(deps, args.out!, text);
  deps.print(`Verdict: ${result.verdict}`);
  for (const reason of result.reasons) deps.print(`  - ${reason}`);
  if (appendProblem !== undefined) return printUnsavedRecord(deps, args.out!, text, appendProblem);
  deps.print(`Record appended to ${args.out}`);
  return result.verdict === 'PASS' ? 0 : 1;
}

async function runTiming(args: CheckArgs, deps: CheckCliDeps, apiKey: string): Promise<0 | 1> {
  const pair = BASE_PAIRS[0]!;
  const property = prepareProperty(pair.unit);
  const tenants = timingTenants().slice(0, TIMING_CANDIDATES).map(prepareTenant);
  const batch = buildRankingBatch({
    direction: 'tenants_for_property',
    batchIndex: 0,
    landlordCard: false,
    anchor: { card: property.card, missing: property.missing },
    candidates: tenants.map((t) => ({
      candidateId: t.contactId,
      unitId: pair.unit.unitId,
      card: t.card,
      missing: t.missing,
      pairHistory: { sends: [], declined: null, tours: [], daysSinceLastSend: null },
      propertyFacts: property.facts,
    })),
    homes: new Map(),
  });
  const specs: CallSpec[] = Array.from({ length: TIMING_RUNS }, (_unused, i) => ({
    id: `timing/${i + 1}`,
    group: 'timing',
    pairId: 'timing',
    direction: 'tenants_for_property',
    run: i + 1,
    batch,
    subjectHandle: 'c1',
    recordedRequirementKeys: property.facts.recordedRequirementKeys,
  }));
  deps.print(`${SCRIPT_NAME} --timing - model ${args.model}; key ${keyTail(apiKey)}; ${endpointLine(deps.env)}`);
  deps.print(
    `Planned calls, timing: ${TIMING_RUNS} batches of ${TIMING_CANDIDATES} candidates ` +
      `(estimated $${estimateCostUsd(specs, args.model).toFixed(2)} on ${args.model})`,
  );
  if (args.dryRun) {
    deps.print('Dry run: no call made.');
    return 0;
  }
  const driver = deps.createDriver({ model: args.model, apiKey });
  const results = await runAll(driver, specs, 1);
  const text = renderTimingRecord(results, header(args, deps, apiKey), TIMING_CANDIDATES);
  const appendProblem = tryAppendRecord(deps, args.out!, text);
  for (const r of results) {
    deps.print(`  run ${r.spec.run}: ${r.failure ?? 'answered'}, ${r.latencyMs} ms, tokens in ${r.usage?.inputTokens ?? '-'}, out ${r.usage?.outputTokens ?? '-'}`);
  }
  if (appendProblem !== undefined) return printUnsavedRecord(deps, args.out!, text, appendProblem);
  deps.print(`Record appended to ${args.out}`);
  return results.every((r) => r.failure === undefined || r.failure === 'not_scored') ? 0 : 1;
}

export async function main(argv: readonly string[], cli: Partial<CheckCliDeps> = {}): Promise<0 | 1 | 2> {
  const deps: CheckCliDeps = { ...defaultDeps(), ...cli };
  const parsed = parseCheckArgs(argv);
  if ('usage' in parsed) {
    deps.printError(`${SCRIPT_NAME}: ${parsed.usage}`);
    deps.printError(USAGE);
    return 2;
  }
  // A dry run never reads the key (plan PR1).
  const apiKey = parsed.dryRun ? '' : (deps.env.ANTHROPIC_API_KEY ?? '').trim();
  if (!parsed.dryRun && apiKey.length === 0) {
    deps.printError(`${SCRIPT_NAME}: ANTHROPIC_API_KEY is not set (use the TESTING key).`);
    return 2;
  }
  // WL-S8-12: a record that cannot be written is refused BEFORE the first call.
  if (!parsed.dryRun) {
    const problem = deps.checkRecordTarget(parsed.out!);
    if (problem !== undefined) {
      deps.printError(`${SCRIPT_NAME}: ${problem}. No call made.`);
      return 2;
    }
  }
  try {
    return parsed.timing ? await runTiming(parsed, deps, apiKey) : await runCheck(parsed, deps, apiKey);
  } catch (err) {
    deps.printError(`${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(`${SCRIPT_NAME} - FAILED: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
