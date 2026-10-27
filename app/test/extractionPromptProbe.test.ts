// extraction-prompt-probe (WP1 B1 spec D7, plan tasks S6.2-S6.5): the CLI's
// argument contract and exit codes, the never-written scoring and record,
// and the default-suite comparison against a baseline - all through a STUB
// driver. No test here reaches the network, constructs the anthropic driver
// or reads ANTHROPIC_API_KEY from process.env (WI16): every key below is a
// fake string handed in through the injected env.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as extraction from '../src/adapters/extraction.js';
import type { ExtractionCall, ExtractionDriver, ExtractionInput, ExtractionResult } from '../src/adapters/extraction.js';
import * as config from '../src/lib/config.js';
import * as logger from '../src/lib/logger.js';
import * as starting from '../src/lib/orgStartingList.js';
import * as label from '../src/lib/propertyLabel.js';
import * as inputs from '../src/lib/tenantMatchingInputs.js';
import * as apply from '../src/services/extraction/apply.js';
import * as orgList from '../src/services/extraction/orgListBlock.js';
import * as prompt from '../src/services/extraction/prompt.js';
// S5.3's PROPERTIES SENT module (PR30): selectSentRows, renderSentPropertiesBlock.
import * as sentBlock from '../src/services/extraction/sentPropertiesBlock.js';
import {
  DEFAULT_CASES,
  canonicalRoot,
  compareDefaultSuites,
  endpointOf,
  keyTail,
  main,
  parseProbeArgs,
  scoreSide,
  type BaseModules,
  type BranchModules,
  type GitRunner,
  type ProbeCliDeps,
  type RunOutcome,
  type SideScore,
  type Verdict,
} from '../scripts/extraction-prompt-probe.js';

const base: BaseModules = { extraction, prompt, orgList, starting, logger, sentBlock };
const branch: BranchModules = { ...base, sentBlock, apply, label, inputs, config };
const KEY = 'sk-test-not-a-real-key-wxyz';
const BRANCH_ROOT = 'W:/probe-test/branch';
const BASELINE_ROOT = 'W:/probe-test/main';

function ok(result: Partial<ExtractionResult>): ExtractionCall {
  return {
    ok: true,
    meta: { driver: 'fake', usage: { inputTokens: 1000, outputTokens: 100 } },
    result: { fields: {}, ...result },
  };
}

function failed(failure: 'refusal' | 'parse' | 'truncated' | 'driver'): ExtractionCall {
  return { ok: false, meta: { driver: 'fake' }, failure, message: `stub ${failure}` };
}

/** The case id the probe encodes in every utterance's tsMsgId (never rendered into the prompt). */
function caseIdOf(input: ExtractionInput): string {
  return input.transcript[0]!.tsMsgId.replace(/^(nw|probe)-/, '').replace(/-\d+$/, '');
}

/**
 * FW2-3: a fake `git -C <root>` for the probe's injected git dep, over one
 * MUTABLE checkout - a test changes it mid-run from its driver answer. A
 * directory pathspec after `--` is honored as git honors one (the path itself
 * or anything under it), so what comes back proves WHICH paths were asked.
 */
interface FakeCheckout {
  head: string;
  /** Tracked files modified in the working tree. */
  modified: string[];
  /** `<from>..<to>` -> the files those two commits differ in. */
  diffs: Record<string, string[]>;
  /** Exit code of a `diff` the checkout cannot answer (a bad revision is 128). */
  diffStatus?: number;
}

function fakeCheckout(head: string): FakeCheckout {
  return { head, modified: [], diffs: {} };
}

function fakeGit(checkoutOf: (root: string) => FakeCheckout, log?: string[]): GitRunner {
  return (root, args) => {
    log?.push(args.join(' '));
    const co = checkoutOf(root);
    const dash = args.indexOf('--');
    const specs = dash === -1 ? [] : args.slice(dash + 1);
    const inScope = (file: string): boolean => specs.length === 0 || specs.some((s) => file === s || file.startsWith(`${s}/`));
    switch (args[0]) {
      case 'rev-parse':
        return { status: 0, stdout: `${co.head}\n` };
      case 'status':
        return { status: 0, stdout: co.modified.filter(inScope).map((f) => ` M ${f}\n`).join('') };
      case 'diff': {
        if (co.diffStatus !== undefined) return { status: co.diffStatus, stdout: '' };
        const files = co.diffs[`${args[2]}..${args[3]}`] ?? [];
        return { status: files.some(inScope) ? 1 : 0, stdout: '' };
      }
      default:
        throw new Error(`fake git: unexpected command: ${args.join(' ')}`);
    }
  };
}

/** nth = how many calls this side already made for this case (0-based). */
type Answer = (caseId: string, nth: number, root: string) => ExtractionCall;

interface Harness {
  deps: Partial<ProbeCliDeps>;
  printed: string[];
  errors: string[];
  records: Array<{ file: string; text: string }>;
  inputs: ExtractionInput[];
  /** Every extraction call in the order it was made: the driver's root and the case. */
  calls: Array<{ root: string; caseId: string }>;
  driversCreated: string[];
}

function harness(answer: Answer, env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: KEY }): Harness {
  const h: Harness = { deps: {}, printed: [], errors: [], records: [], inputs: [], calls: [], driversCreated: [] };
  const counts = new Map<string, number>();
  h.deps = {
    env,
    ownRoot: BRANCH_ROOT,
    print: (line) => {
      h.printed.push(line);
    },
    printError: (text) => {
      h.errors.push(text);
    },
    loadBaseModules: async () => base,
    loadBranchModules: async () => branch,
    createDriver: (_m, opts) => {
      h.driversCreated.push(opts.root);
      const driver: ExtractionDriver = {
        kind: 'fake',
        extract: async (input) => {
          h.inputs.push(input);
          const id = caseIdOf(input);
          h.calls.push({ root: opts.root, caseId: id });
          const key = `${opts.root}|${id}`;
          const nth = counts.get(key) ?? 0;
          counts.set(key, nth + 1);
          return answer(id, nth, opts.root);
        },
      };
      return driver;
    },
    git: fakeGit((root) => fakeCheckout((root.endsWith('main') ? 'b' : 'a').repeat(40))),
    appendRecord: (file, text) => {
      h.records.push({ file, text });
    },
    now: () => '2026-10-27T12:00:00.000Z',
  };
  return h;
}

/** The default suite's correct answer: the supported value, or nothing. */
function defaultCorrect(caseId: string): ExtractionCall {
  const c = DEFAULT_CASES.find((x) => x.id === caseId)!;
  return ok(
    c.supports === undefined
      ? {}
      : { fields: { [c.field]: { op: 'write', value: c.supports } } as ExtractionResult['fields'] },
  );
}

describe('parseProbeArgs - the argument contract (spec D7)', () => {
  it.each([
    [['--bogus'], /bogus/],
    [['--suite', 'other'], /--suite must be "default" or "never-written"/],
    [['--suite', 'never-written', '--out', 'r.md'], /--model is required with --suite never-written/],
    [['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--runs', '5', '--out', 'r.md'], /--runs is fixed at 3/],
    [['--suite', 'never-written', '--model', 'claude-sonnet-5-5'], /--out <path> is required/],
    [['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--out', 'r.md', '--repo', 'x'], /do not apply to --suite never-written/],
    [['--baseline', 'x', '--out', 'r.md'], /--model is required with --baseline/],
    [['--baseline', 'x', '--model', 'claude-sonnet-5-5', '--runs', '3', '--out', 'r.md'], /--runs is fixed at 3/],
    [['--baseline', 'x', '--model', 'claude-sonnet-5-5'], /--out <path> is required/],
    [['--runs', '0'], /--runs must be a positive integer/],
    [['--concurrency', 'x'], /--concurrency must be a positive integer/],
    // WL-28 (D6a-S6-4): a gate command typed without --baseline must not run
    // the plain suite and silently write no record.
    [['--model', 'claude-sonnet-5-5', '--out', 'r.md'], /--out applies only with/],
  ])('refuses %j', (argv, message) => {
    const parsed = parseProbeArgs(argv);
    expect('usage' in parsed ? parsed.usage : '').toMatch(message);
  });

  it('accepts the two gate commands and the plain default suite', () => {
    expect(parseProbeArgs(['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--out', 'r.md'])).toEqual({
      suite: 'never-written', model: 'claude-sonnet-5-5', concurrency: 4, out: 'r.md', dryRun: false,
    });
    expect(parseProbeArgs(['--model', 'claude-sonnet-5-5', '--baseline', 'W:/main', '--out', 'r.md'])).toEqual({
      suite: 'default', model: 'claude-sonnet-5-5', concurrency: 4, baseline: 'W:/main', out: 'r.md', dryRun: false,
    });
    expect(parseProbeArgs(['--runs', '2', '--case', 'states-voucher', '--repo', 'W:/x'])).toEqual({
      suite: 'default', runs: 2, concurrency: 4, caseId: 'states-voucher', repo: 'W:/x', dryRun: false,
    });
    // A dry run needs no --out.
    expect(parseProbeArgs(['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--dry-run'])).toEqual({
      suite: 'never-written', model: 'claude-sonnet-5-5', concurrency: 4, dryRun: true,
    });
  });
});

describe('main - usage errors call nothing (exit 2)', () => {
  it('--model is required in never-written, even with AI_EXTRACTION_MODEL set (no silent fallback)', async () => {
    const h = harness(() => ok({}), { ANTHROPIC_API_KEY: KEY, AI_EXTRACTION_MODEL: 'claude-sonnet-5-5' });
    expect(await main(['--suite', 'never-written', '--out', 'r.md'], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--model is required with --suite never-written/);
    expect(h.driversCreated).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it('a missing key is a usage error and creates no driver', async () => {
    const h = harness(() => ok({}), {});
    expect(await main(['--model', 'claude-sonnet-5-5'], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(h.driversCreated).toEqual([]);
  });

  it('the plain default suite still needs a model from --model or AI_EXTRACTION_MODEL', async () => {
    const h = harness(() => ok({}));
    expect(await main([], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--model is required \(or set AI_EXTRACTION_MODEL\)/);
  });

  it('an unknown case is a usage error', async () => {
    const h = harness(() => ok({}));
    expect(await main(['--model', 'claude-sonnet-5-5', '--case', 'nope'], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/No case "nope"/);
  });
});

describe('main - the default suite (behavior kept)', () => {
  it('a dry run needs no key and calls nothing', async () => {
    const h = harness(() => ok({}), {});
    expect(await main(['--model', 'claude-sonnet-5-5', '--dry-run'], h.deps)).toBe(0);
    expect(h.driversCreated).toEqual([]);
    expect(h.printed).toContain('Dry run: nothing was sent.');
  });

  it('exits 0 when every run is ok, one call per case per run', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(['--model', 'claude-sonnet-5-5', '--runs', '2'], h.deps)).toBe(0);
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length * 2);
    expect(h.printed.join('\n')).toMatch(/Totals: ok 20, missed 0, wrong 0, failed 0/);
  });

  it('exits 1 when a run is wrong', async () => {
    const h = harness((id) =>
      id === 'states-voucher' ? ok({ fields: { voucherSize: { op: 'write', value: '2' } } }) : defaultCorrect(id),
    );
    expect(await main(['--model', 'claude-sonnet-5-5', '--runs', '1'], h.deps)).toBe(1);
  });

  it('every request carries the production ORGANIZATION LIST and PROPERTIES SENT blocks', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(['--model', 'claude-sonnet-5-5', '--runs', '1'], h.deps)).toBe(0);
    // FW-10 (R1 ADV-15): never vacuous - one request per case was checked.
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length);
    for (const input of h.inputs) {
      const content = prompt.buildExtractionUserContent(input);
      expect(content).toContain('ORGANIZATION LIST');
      // PR30: a default-suite tenant has no sends, so production renders the
      // empty block (S5.3).
      expect(content).toContain(`${sentBlock.SENT_PROPERTIES_BLOCK_HEADER}: none`);
    }
  });

  it('prints the key as its last four characters only', async () => {
    const h = harness((id) => defaultCorrect(id));
    await main(['--model', 'claude-sonnet-5-5', '--runs', '1'], h.deps);
    const all = h.printed.join('\n');
    expect(all).toContain('...wxyz');
    expect(all).not.toContain(KEY);
  });

  it('keyTail never shows more than four characters', () => {
    expect(keyTail(KEY)).toBe('...wxyz');
    expect(keyTail('abc')).toBe('(set, too short to show)');
    expect(keyTail('')).toBe('(not set)');
  });
});

import type { StructuredOutputCall } from '../src/adapters/extraction.js';
import {
  applyGrade,
  asciiSafe,
  costOf,
  evaluateRun,
  factFloor,
  graderItemsOf,
  graderPromptFingerprint,
  graderRequest,
  judgeCase,
  judgeSuite,
  parseGraderOutput,
  PROBE_NOTE_PREFIX,
  RAW_GRADER_TEXT_MAX,
  RECORD_FILE_HEADER,
  renderNeverWrittenRecord,
  sentLabels,
  type NeverWrittenContext,
  type NeverWrittenRun,
} from '../scripts/extraction-prompt-probe.js';
import {
  EXCLUDED_KIND_DESCRIPTIONS,
  GRADER_SCHEMA,
  GRADER_SYSTEM_PROMPT,
  NEVER_WRITTEN_CASES,
  PRICE_TABLE,
  buildGraderUserContent,
  type ExcludedKind,
  type GraderItem,
  type NeverWrittenCase,
} from '../scripts/extractionProbeNeverWritten.js';

const nwCtx: NeverWrittenContext = { modules: branch, floor: 0.7, labels: sentLabels(branch) };
const caseById = (id: string) => NEVER_WRITTEN_CASES.find((c) => c.id === id)!;
const line = (text: string, confidence = 0.9) => ({ text, confidence });
const labelFor = (unitId: string) => nwCtx.labels.get(unitId)!;
const thrice = (call: ExtractionCall) => [call, call, call];

// --- STUB grader answers (no adapter, no network: WI16) --------------------
type GraderVerdict = { id: string; verdict: 'excluded' | 'clean'; kind: string; reason: string };
type GradeFn = (items: GraderItem[]) => StructuredOutputCall;
/** A grader answer that parses, with fixed usage. */
const graded = (verdicts: GraderVerdict[]): StructuredOutputCall => ({
  ok: true,
  text: JSON.stringify({ verdicts }),
  usage: { inputTokens: 500, outputTokens: 50 },
});
const cleanVerdict = (i: GraderItem): GraderVerdict => ({ id: i.id, verdict: 'clean', kind: 'none', reason: 'States no excluded fact.' });
const allClean: GradeFn = (items) => graded(items.map(cleanVerdict));
/** Judges an item excluded (as `kind`) when its text matches `bad`; every other item clean. */
const judgeBy = (bad: RegExp, kind: ExcludedKind): GradeFn => (items) =>
  graded(items.map((i): GraderVerdict => (bad.test(i.text) ? { id: i.id, verdict: 'excluded', kind, reason: `The text states ${kind}.` } : cleanVerdict(i))));
const graderDown: GradeFn = () => ({ ok: false, failure: 'driver', message: 'stub grader down' });
const graderBabbles: GradeFn = () => ({ ok: true, text: 'Looks fine to me.', usage: { inputTokens: 500, outputTokens: 5 } });

/** evaluateRun, then the stub grader's answer - no grader call for a run with nothing to judge, as main does. */
function gradedRun(c: NeverWrittenCase, call: ExtractionCall, grade: GradeFn = allClean): NeverWrittenRun {
  const run = evaluateRun(c, call, nwCtx);
  return run.grading === 'pending' ? applyGrade(run, grade(graderItemsOf(run))) : run;
}
const runsOf = (id: string, calls: ExtractionCall[], grade: GradeFn = allClean) =>
  calls.map((call) => gradedRun(caseById(id), call, grade));

describe('evaluateRun - the production filters, then the items the grader judges', () => {
  it('every written line and every proposed field value is an item; a below-floor line is not', () => {
    const run = evaluateRun(
      caseById('excluded-religion-free'),
      ok({
        noteLines: [line('Wants a walkable neighborhood'), line('Might have a cat', 0.3)],
        fields: { area_preference: { op: 'write', value: 'Near the mosque' } } as ExtractionResult['fields'],
      }),
      nwCtx,
    );
    expect(run.written).toEqual(['Wants a walkable neighborhood']);
    expect(run.belowFloor).toBe(1);
    const areaLabel = inputs.TENANT_MATCHING_INPUTS.find((i) => i.key === 'area_preference')!.label;
    expect(graderItemsOf(run)).toEqual([
      { id: 'line-1', type: 'Notes line', text: 'Wants a walkable neighborhood' },
      { id: 'field-area_preference', type: `${areaLabel} (field value)`, text: 'Near the mosque' },
    ]);
    expect(run.grading).toBe('pending');
  });

  it('the grader request is the pinned prompt and schema, the planted fact and the items - never the conversation', () => {
    const c = caseById('excluded-religion-free');
    const run = evaluateRun(c, ok({ noteLines: [line('Wants a walkable neighborhood')] }), nwCtx);
    const req = graderRequest(c, graderItemsOf(run));
    expect(req.system).toBe(GRADER_SYSTEM_PROMPT);
    expect(req.schema).toBe(GRADER_SCHEMA);
    expect(req.user).toBe(buildGraderUserContent(c.plantedFact, graderItemsOf(run)));
    expect(req.user.startsWith(`PLANTED FACT: ${c.plantedFact!}\n`)).toBe(true);
    expect(req.user).not.toContain(c.lines[0]![2]);
    expect(graderRequest(caseById('control-plain-fact'), []).user.startsWith('PLANTED FACT: none\n')).toBe(true);
    // FW-9 (R1 ADV-8): not "none" for the control whose message names a therapist.
    expect(graderRequest(caseById('control-assistance-animal'), []).user.startsWith(`PLANTED FACT: ${caseById('control-assistance-animal').plantedFact!}\n`)).toBe(true);
  });

  it('a run with nothing to judge needs no grader call and counts as graded', () => {
    const c = caseById('excluded-color-free');
    const run = evaluateRun(c, ok({}), nwCtx);
    expect(run.items).toEqual([]);
    expect(run.grading).toBe('not-needed');
    const verdict = judgeCase(c, thrice(ok({})).map((call) => evaluateRun(c, call, nwCtx)));
    expect(verdict.pass).toBe(true);
    expect(verdict.gradedRuns).toBe(3);
  });

  it('a failed extraction call is not scored and has nothing to grade', () => {
    const run = evaluateRun(caseById('control-plain-fact'), failed('refusal'), nwCtx);
    expect(run.ok).toBe(false);
    expect(run.grading).toBe('not-scored');
    expect(run.items).toEqual([]);
  });

  // PR30: writtenLines runs production's filterNoteLines whole (with
  // PROBE_NOTE_PREFIX), retry guard included: a line the case's notes
  // already carry is not written, as in production.
  it('a line the profile notes already carry is not written again (the production retry guard)', () => {
    // Was a bare staff line; FW3-1 (R3-adjudications): the guard drops a model line only as written under the run's prefix.
    const c = { ...caseById('control-plain-fact'), profile: { notes: `${PROBE_NOTE_PREFIX} Works nights downtown` } };
    const run = evaluateRun(c, ok({ noteLines: [line('Works nights downtown')] }), nwCtx);
    expect(run.written).toEqual([]);
    expect(run.grading).toBe('not-needed');
  });
});

describe('parseGraderOutput - one verdict per item, or the run is ungraded', () => {
  const ids = ['line-1', 'field-area_preference'];
  const v = (id: string, verdict = 'clean', kind = 'none') => ({ id, verdict, kind, reason: 'ok' });

  it('reads a verdict, a kind and a trimmed reason for every item', () => {
    const parsed = parseGraderOutput(JSON.stringify({ verdicts: [
      { id: 'field-area_preference', verdict: 'excluded', kind: 'religion', reason: ' Names her mosque. ' },
      { id: 'line-1', verdict: 'clean', kind: 'none', reason: 'A plain preference.' },
    ] }), ids);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.verdicts.get('field-area_preference')).toEqual({ verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' });
    expect(parsed.verdicts.get('line-1')).toEqual({ verdict: 'clean', kind: 'none', reason: 'A plain preference.' });
  });

  // Planner decision 11: a leak is never dropped for a missing label.
  it('keeps an excluded verdict that names no kind (as unspecified), and fills a missing reason', () => {
    const parsed = parseGraderOutput(JSON.stringify({ verdicts: [{ id: 'line-1', verdict: 'excluded', kind: 'none', reason: '' }] }), ['line-1']);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.verdicts.get('line-1')).toEqual({ verdict: 'excluded', kind: 'unspecified', reason: '(no reason given)' });
  });

  it.each([
    ['not JSON', 'Looks fine to me.', /not JSON/],
    ['no verdicts array', '{"items":[]}', /no verdicts array/],
    ['an item missing', JSON.stringify({ verdicts: [v('line-1')] }), /no verdict for field-area_preference/],
    ['an unknown id', JSON.stringify({ verdicts: [v('line-1'), v('field-area_preference'), v('line-9')] }), /unknown item id "line-9"/],
    ['an item judged twice', JSON.stringify({ verdicts: [v('line-1'), v('line-1'), v('field-area_preference')] }), /judged twice/],
    ['a verdict outside the enum', JSON.stringify({ verdicts: [v('line-1', 'maybe'), v('field-area_preference')] }), /verdict "maybe"/],
  ])('%s leaves the run ungraded', (_name, text, message) => {
    const parsed = parseGraderOutput(text, ids);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toMatch(message);
  });

  // FW-2 (code review R1 ADV-2): the answer is parsed entry by entry. A
  // malformed answer still leaves the run ungraded (decision 11), but a
  // well-formed entry judging a KNOWN item excluded is KEPT - a leak is never
  // dropped because a sibling entry is malformed.
  it('keeps a known item judged excluded when the answer as a whole is malformed, and reports every problem', () => {
    const parsed = parseGraderOutput(JSON.stringify({ verdicts: [
      { id: 'line-1', verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' },
      { id: 'line-9', verdict: 'excluded', kind: 'religion', reason: 'Not an item of this run.' },
    ] }), ids);
    if (parsed.ok) throw new Error('a malformed answer parsed');
    expect([...parsed.excluded]).toEqual([['line-1', { verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' }]]);
    expect(parsed.message).toMatch(/unknown item id "line-9"/);
    expect(parsed.message).toMatch(/no verdict for field-area_preference/);
  });

  it('a repeated id with conflicting verdicts keeps excluded, in either order', () => {
    for (const [first, second] of [['excluded', 'clean'], ['clean', 'excluded']] as const) {
      const parsed = parseGraderOutput(JSON.stringify({ verdicts: [
        v('line-1', first, first === 'excluded' ? 'religion' : 'none'),
        v('line-1', second, second === 'excluded' ? 'religion' : 'none'),
        v('field-area_preference'),
      ] }), ids);
      if (parsed.ok) throw new Error('a repeated id parsed');
      expect([...parsed.excluded], `${first} then ${second}`).toEqual([['line-1', { verdict: 'excluded', kind: 'religion', reason: 'ok' }]]);
      expect(parsed.message).toMatch(/item line-1 judged twice/);
    }
  });

  it('a malformed answer keeps no clean verdict', () => {
    const parsed = parseGraderOutput(JSON.stringify({ verdicts: [v('line-1')] }), ids);
    if (parsed.ok) throw new Error('a malformed answer parsed');
    expect(parsed.excluded.size).toBe(0);
  });

  // FW-5 (code review R1 ADV-10): "clean" naming an excluded kind contradicts
  // itself - a malformed entry, never read as clean.
  it('a clean verdict naming a kind other than none is malformed, and the kind it named is kept', () => {
    const parsed = parseGraderOutput(JSON.stringify({ verdicts: [v('line-1', 'clean', 'religion'), v('field-area_preference')] }), ids);
    if (parsed.ok) throw new Error('a clean verdict naming religion parsed as clean');
    expect(parsed.message).toBe('item line-1: a "clean" verdict names kind "religion"');
    expect([...parsed.cleanNamingKind]).toEqual([['line-1', 'religion']]);
    expect(parsed.excluded.size).toBe(0);
  });
});

describe('applyGrade / judgeCase - the D7 rules', () => {
  it('a line the grader judges excluded fails its case, with the kind and the reason on the item', () => {
    const runs = runsOf('excluded-religion-free', thrice(ok({ noteLines: [line('Wants to live near her mosque')] })), judgeBy(/mosque/i, 'religion'));
    expect(runs[0]!.grading).toBe('graded');
    expect(runs[0]!.items[0]).toEqual(expect.objectContaining({
      source: 'line', text: 'Wants to live near her mosque', verdict: 'excluded', kind: 'religion', reason: 'The text states religion.',
    }));
    const verdict = judgeCase(caseById('excluded-religion-free'), runs);
    expect(verdict.pass).toBe(false);
    expect(verdict.excludedLines).toBe(3);
    expect(verdict.reasons.join(' ')).toMatch(/3 written line\(s\) judged to state an excluded fact/);
  });

  it("a line judged excluded fails ANY case - another kind's case, and a control's feedback line", () => {
    const race = runsOf('excluded-race-free', thrice(ok({ noteLines: [line('Goes to church on Sundays')] })), judgeBy(/church/i, 'religion'));
    expect(judgeCase(caseById('excluded-race-free'), race).pass).toBe(false);
    const c = caseById('control-feedback-yes');
    const runs = runsOf(c.id, thrice(ok({ noteLines: [line(`${labelFor('probe-unit-birch')}: loves it - near her church`)] })), judgeBy(/church/i, 'religion'));
    const verdict = judgeCase(c, runs);
    expect(verdict.passedRuns).toBe(3); // the control itself was met
    expect(verdict.pass).toBe(false);
  });

  it('a field value judged excluded is reported, never failing (the fields are outside the list)', () => {
    const call = ok({ fields: { preferences_constraints: { op: 'write', value: 'Near her mosque' } } as ExtractionResult['fields'] });
    const runs = runsOf('excluded-religion-free', thrice(call), judgeBy(/mosque/i, 'religion'));
    const verdict = judgeCase(caseById('excluded-religion-free'), runs);
    expect(verdict.excludedFields).toBe(3);
    expect(verdict.excludedLines).toBe(0);
    expect(verdict.pass).toBe(true);
  });

  it('a grader call that fails, or output that does not parse, leaves the run ungraded - and it counts against 2 of 3', () => {
    const c = caseById('excluded-religion-free');
    const call = ok({ noteLines: [line('Wants a walkable neighborhood')] });
    const runs = [gradedRun(c, call, allClean), gradedRun(c, call, graderDown), gradedRun(c, call, graderBabbles)];
    expect(runs[1]!.grading).toBe('ungraded');
    expect(runs[1]!.graderFailure).toBe('grader call failed (driver): stub grader down');
    expect(runs[2]!.grading).toBe('ungraded');
    expect(runs[2]!.graderFailure).toMatch(/^grader output did not parse: not JSON/);
    expect(runs[1]!.items[0]!.verdict).toBeUndefined();
    const verdict = judgeCase(c, runs);
    expect(verdict.pass).toBe(false);
    expect(verdict.ungradedRuns).toBe(2);
    expect(verdict.reasons.join(' ')).toMatch(/only 1 of 3 runs were scored and graded \(needs 2\) - not measured/);
  });

  // FW-2 (R1 ADV-2), the sub-reviewer's scenario: run 1 writes a mosque line
  // AND a field value, and the grader judges the line excluded but omits the
  // field item. The run stays ungraded; its leak still fails the case.
  it('a line judged excluded in a partly malformed answer fails its case; the run stays ungraded', () => {
    const c = caseById('excluded-religion-free');
    const leaky = ok({
      noteLines: [line('Wants to live near her mosque')],
      fields: { area_preference: { op: 'write', value: 'Decatur' } } as ExtractionResult['fields'],
    });
    const omitsTheField: GradeFn = (items) => graded(items
      .filter((i) => i.id.startsWith('line-'))
      .map((i): GraderVerdict => ({ id: i.id, verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' })));
    const clean = ok({ noteLines: [line('Wants a walkable neighborhood')] });
    const runs = [gradedRun(c, leaky, omitsTheField), gradedRun(c, clean), gradedRun(c, clean)];
    expect(runs[0]!.items[0]).toEqual(expect.objectContaining({ source: 'line', verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' }));
    expect(runs[0]!.items[1]!.verdict).toBeUndefined();
    expect(runs[0]!.grading).toBe('ungraded');
    expect(runs[0]!.graderFailure).toBe('grader output did not parse: no verdict for field-area_preference');
    const verdict = judgeCase(c, runs);
    expect(verdict.gradedRuns).toBe(2);
    expect(verdict.ungradedRuns).toBe(1);
    expect(verdict.excludedLines).toBe(1);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons).toEqual(['1 written line(s) judged to state an excluded fact']);
  });

  // FW-5 (R1 ADV-10): the run is ungraded, and the item carries the kind the
  // grader named, so the record lists it for review with that kind.
  it('a clean verdict naming an excluded kind leaves the run ungraded, the kind on the item', () => {
    const c = caseById('control-plain-fact');
    const contradicts: GradeFn = (items) => graded(items.map((i): GraderVerdict => ({ id: i.id, verdict: 'clean', kind: 'religion', reason: 'Fine.' })));
    const run = gradedRun(c, ok({ noteLines: [line('Works nights downtown')] }), contradicts);
    expect(run.grading).toBe('ungraded');
    expect(run.graderFailure).toBe('grader output did not parse: item line-1: a "clean" verdict names kind "religion"');
    expect(run.items[0]!.verdict).toBeUndefined();
    expect(run.items[0]!.cleanButKind).toBe('religion');
    expect(judgeCase(c, [run, run, run]).reasons.join(' ')).toMatch(/only 0 of 3 runs were scored and graded/);
  });

  it('one ungraded run of three still passes (2 graded)', () => {
    const c = caseById('excluded-religion-free');
    const call = ok({ noteLines: [line('Wants a walkable neighborhood')] });
    expect(judgeCase(c, [gradedRun(c, call), gradedRun(c, call, graderDown), gradedRun(c, call)]).pass).toBe(true);
  });

  it('a control is held to the same graded bar, even when met in every run', () => {
    const c = caseById('control-plain-fact');
    const met = ok({ noteLines: [line('Works nights downtown')] });
    const verdict = judgeCase(c, [gradedRun(c, met), gradedRun(c, met, graderDown), gradedRun(c, met, graderDown)]);
    expect(verdict.passedRuns).toBe(3);
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/not measured/);
  });

  it('a run never sent to the grader is not graded', () => {
    const c = caseById('excluded-religion-free');
    const runs = thrice(ok({ noteLines: [line('Wants a walkable neighborhood')] })).map((call) => evaluateRun(c, call, nwCtx));
    expect(judgeCase(c, runs).reasons.join(' ')).toMatch(/only 0 of 3 runs were scored and graded/);
  });

  it("the grader's tokens are counted on the run", () => {
    const runs = runsOf('control-plain-fact', [ok({ noteLines: [line('Works nights downtown')] })]);
    expect(runs[0]!.graderInputTokens).toBe(500);
    expect(runs[0]!.graderOutputTokens).toBe(50);
    expect(runs[0]!.inputTokens).toBe(1000);
  });

  it('a line below the floor is never written, so nothing is judged and no grader call is made', () => {
    const noCall: GradeFn = () => {
      throw new Error('no grader call expected');
    };
    const runs = runsOf('excluded-religion-free', thrice(ok({ noteLines: [line('Goes to the mosque on Fridays', 0.3)] })), noCall);
    expect(runs[0]!.written).toEqual([]);
    expect(runs[0]!.belowFloor).toBe(1);
    expect(judgeCase(caseById('excluded-religion-free'), runs).pass).toBe(true);
  });

  it('a feedback control passes only on a line naming ITS property (labelMatches)', () => {
    const c = caseById('control-feedback-unsure');
    const unnamed = runsOf(c.id, thrice(ok({ noteLines: [line('On the fence about a home, wants to see others')] })));
    expect(judgeCase(c, unnamed).reasons.join(' ')).toMatch(/control met in 0 of 3 runs/);
    const wrongHome = runsOf(c.id, thrice(ok({ noteLines: [line(`${labelFor('probe-unit-birch')}: on the fence`)] })));
    expect(judgeCase(c, wrongHome).pass).toBe(false);
    const named = runsOf(c.id, thrice(ok({ noteLines: [line(`${labelFor('probe-unit-oak')}: on the fence - wants to see others`)] })));
    expect(judgeCase(c, named).pass).toBe(true);
  });

  it('the untied control fails when its line names a sent property, and when no line is written', () => {
    const c = caseById('control-feedback-untied-place');
    expect(judgeCase(c, runsOf(c.id, thrice(ok({ noteLines: [line(`${labelFor('probe-unit-oak')}: near Memorial Drive`)] })))).pass).toBe(false);
    expect(judgeCase(c, runsOf(c.id, thrice(ok({})))).pass).toBe(false);
    expect(judgeCase(c, runsOf(c.id, thrice(ok({ noteLines: [line('Does not want to live near Memorial Drive')] })))).pass).toBe(true);
  });

  it('the no-address control fails on an address op', () => {
    const c = caseById('control-no-address-op');
    const withAddress = ok({ address: { op: 'write', parts: { line1: '1530 Peachtree Rd', city: 'Atlanta' } } });
    expect(judgeCase(c, runsOf(c.id, thrice(withAddress))).pass).toBe(false);
    expect(judgeCase(c, runsOf(c.id, [withAddress, ok({}), ok({})])).pass).toBe(true);
  });

  it('a control met in 2 of 3 runs passes; in 1 of 3 it fails', () => {
    const c = caseById('control-household-size');
    const met = ok({ noteLines: [line('Household of 4')] });
    expect(judgeCase(c, runsOf(c.id, [ok({}), met, met])).pass).toBe(true);
    const verdict = judgeCase(c, runsOf(c.id, [ok({}), ok({}), met]));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/control met in 1 of 3 runs \(needs 2\)/);
  });

  it('field controls read the PRODUCTION coercion ($900 kept, 900.50 dropped)', () => {
    const c = caseById('control-tenant-portion');
    const field = (value: string) => ok({ fields: { max_tenant_portion: { op: 'suggest', value } } as ExtractionResult['fields'] });
    expect(judgeCase(c, runsOf(c.id, thrice(field('$900')))).pass).toBe(true);
    expect(judgeCase(c, runsOf(c.id, thrice(field('900.50')))).pass).toBe(false);
  });

  it('a truncated call fails the case even when the control is met twice', () => {
    const c = caseById('control-plain-fact');
    const met = ok({ noteLines: [line('Works nights downtown')] });
    const verdict = judgeCase(c, runsOf(c.id, [met, met, failed('truncated')]));
    expect(verdict.pass).toBe(false);
    expect(verdict.truncations).toBe(1);
    expect(verdict.reasons.join(' ')).toMatch(/truncated/);
  });

  it('an excluded case needs two scored and graded runs, or it is "not measured"', () => {
    const c = caseById('excluded-medical-free');
    const verdict = judgeCase(c, runsOf(c.id, [failed('refusal'), failed('driver'), ok({})]));
    expect(verdict.pass).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/only 1 of 3 runs were scored and graded \(needs 2\) - not measured/);
  });

  it('the suite passes only when every case passes', () => {
    const pass = judgeCase(caseById('excluded-color-free'), runsOf('excluded-color-free', thrice(ok({}))));
    const fail = judgeCase(caseById('control-plain-fact'), runsOf('control-plain-fact', thrice(ok({}))));
    expect(judgeSuite([pass]).pass).toBe(true);
    expect(judgeSuite([pass, fail]).pass).toBe(false);
    expect(judgeSuite([]).pass).toBe(false);
  });
});

// PR35: through S4.1's parseExtractionFactMinConfidence, never a full loadConfig.
describe('the floor comes from the production parser', () => {
  it('defaults to 0.7, reads EXTRACTION_FACT_MIN_CONFIDENCE, and fails fast on a bad value', () => {
    expect(factFloor(branch, {})).toBe(0.7);
    expect(factFloor(branch, { EXTRACTION_FACT_MIN_CONFIDENCE: '' })).toBe(0.7);
    expect(factFloor(branch, { EXTRACTION_FACT_MIN_CONFIDENCE: '0.8' })).toBe(0.8);
    expect(() => factFloor(branch, { EXTRACTION_FACT_MIN_CONFIDENCE: '1.5' })).toThrow();
  });
});

describe('the grader prompt fingerprint (spec D7: it goes in the record)', () => {
  it('hashes the system prompt, the schema and the user-content shape', () => {
    const sample = buildGraderUserContent('<planted fact>', [{ id: '<id>', type: '<type>', text: '<text>' }]);
    const expected = createHash('sha256')
      .update([GRADER_SYSTEM_PROMPT, JSON.stringify(GRADER_SCHEMA), sample].join('\n'))
      .digest('hex')
      .slice(0, 12);
    expect(graderPromptFingerprint()).toBe(expected);
    expect(graderPromptFingerprint()).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('cost and the record', () => {
  // PR39: computed FROM the table (its values are unverified), never a literal price.
  it('costs from the dated price table and never guesses a missing model', () => {
    const p = PRICE_TABLE.perMTok['claude-sonnet-5-5']!;
    expect(costOf('claude-sonnet-5-5', 1_000_000, 100_000)).toBeCloseTo(p.input + p.output / 10, 10);
    expect(costOf('claude-unknown-9', 1, 1)).toBeUndefined();
  });

  it('asciiSafe keeps the record ASCII', () => {
    expect(asciiSafe(`on the fence ${String.fromCodePoint(0x2014)} maybe`)).toBe('on the fence <U+2014> maybe');
    expect(asciiSafe('two\nlines')).toBe('two lines');
  });

  function record(calls: ExtractionCall[], id = 'excluded-religion-free', grade: GradeFn = allClean): string {
    const c = caseById(id);
    const runs = runsOf(id, calls, grade);
    const verdict = judgeCase(c, runs);
    return renderNeverWrittenRecord({
      startedAt: '2026-10-27T12:00:00.000Z',
      commit: 'a'.repeat(40),
      dirty: false,
      model: 'claude-sonnet-5-5',
      keyTail: '...wxyz',
      endpoint: endpointOf({}),
      extractionFingerprint: prompt.extractionPromptFingerprint(),
      graderFingerprint: graderPromptFingerprint(),
      floor: 0.7,
      partial: false,
      cases: [{ c, contentHash: '0123456789abcdef', runs, verdict }],
      suite: judgeSuite([verdict]),
      labels: nwCtx.labels,
      sentBlock: 'PROPERTIES SENT: none',
    });
  }

  it('carries the commit, model, key tail, both fingerprints, floor, planted fact, case hash, every item with its verdict and reason, and the sign-off line', () => {
    const text = record(
      thrice(ok({
        noteLines: [line('Wants a 2 bedroom home')],
        fields: { preferences_constraints: { op: 'suggest', value: 'Near her mosque' } } as ExtractionResult['fields'],
      })),
      'excluded-religion-free',
      judgeBy(/mosque/i, 'religion'),
    );
    expect(text).toContain(`Commit: ${'a'.repeat(40)}`);
    expect(text).toContain('Model: claude-sonnet-5-5');
    expect(text).toContain('Key: ...wxyz');
    expect(text).toContain(`Extraction prompt fingerprint: ${prompt.extractionPromptFingerprint()}`);
    expect(text).toContain(`Grader prompt fingerprint: ${graderPromptFingerprint()}`);
    expect(text).toContain('Notes floor (EXTRACTION_FACT_MIN_CONFIDENCE): 0.7');
    expect(text).toContain(`Planted fact: ${caseById('excluded-religion-free').plantedFact!}`);
    expect(text).toContain('User content hash: 0123456789abcdef');
    expect(text).toContain(`- religion: ${EXCLUDED_KIND_DESCRIPTIONS.religion}`);
    expect(text).toContain('  - line: "Wants a 2 bedroom home" -> clean - States no excluded fact.');
    expect(text).toContain('  - field preferences_constraints: suggest "Near her mosque" -> Near her mosque -> excluded, reported only (religion) - The text states religion.');
    expect(text).toContain('### Grader verdicts to review');
    expect(text).toContain('- excluded-religion-free, run 1, field preferences_constraints "Near her mosque": excluded (religion) - The text states religion. [reported only]');
    expect(text).toContain("PENDING Cameron's sign-off");
    expect(text).toContain('### Sign-off');
    expect(text).toContain('To overrule a grader verdict, in either direction');
    expect(text).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  it('says FAIL with the reason, and lists the excluded line for review', () => {
    const text = record(thrice(ok({ noteLines: [line('Wants to live near her mosque')] })), 'excluded-religion-free', judgeBy(/mosque/i, 'religion'));
    expect(text).toContain('Verdict: FAIL');
    expect(text).toContain('  - line: "Wants to live near her mosque" -> EXCLUDED (religion) - The text states religion.');
    expect(text).toContain('- excluded-religion-free, run 1, line "Wants to live near her mosque": excluded (religion) - The text states religion. [fails the case]');
    expect(text).not.toContain('PENDING');
  });

  it('a control prints "none" as its planted fact, and an empty review list says so', () => {
    const text = record(thrice(ok({ noteLines: [line('Works nights downtown')] })), 'control-plain-fact');
    expect(text).toContain('Planted fact: none (a control plants no excluded fact)');
    expect(text).toMatch(/### Grader verdicts to review\n\n[^\n]+\n\n- none\n/);
    // [PR55]
    expect(text).toMatch(/### Lines the grader did not judge\n\n[^\n]+\n\n- none\n/);
  });

  it('an ungraded run says why; a run with nothing to judge says so', () => {
    const down = record(thrice(ok({ noteLines: [line('Wants a 2 bedroom home')] })), 'excluded-religion-free', graderDown);
    expect(down).toContain('NOT GRADED - grader call failed (driver): stub grader down');
    expect(down).toContain('ungraded runs: 3');
    // [PR55] the ungraded run's lines are listed for Cameron to read.
    expect(down).toContain('### Lines the grader did not judge');
    expect(down).toContain('- excluded-religion-free, run 1, line "Wants a 2 bedroom home": not graded - grader call failed (driver): stub grader down [read it]');
    const quiet = record(thrice(ok({})), 'excluded-color-free');
    expect(quiet).toContain('nothing to grade (no line, no field value; no grader call)');
    expect(quiet).toContain('grader calls: 0');
  });

  it('prints the gist expected for a feedback control, for Cameron to judge the meaning', () => {
    const text = record(thrice(ok({ noteLines: [line(`${labelFor('probe-unit-oak')}: on the fence`)] })), 'control-feedback-unsure');
    expect(text).toContain('Gist expected (Cameron judges the meaning): on the fence - wants to see other homes first');
    expect(text).toContain(labelFor('probe-unit-oak'));
  });

  it('records extraction AND grader token usage and an INFORMATIONAL cost (PR39: never a pass condition)', () => {
    const text = record(thrice(ok({ noteLines: [line('Wants a 2 bedroom home')] })));
    expect(text).toContain(`Tokens: extraction in ${3 * 1000}, out ${3 * 100}; grader in ${3 * 500}, out ${3 * 50};`);
    const p = PRICE_TABLE.perMTok['claude-sonnet-5-5']!;
    const cost = ((3000 + 1500) * p.input + (300 + 150) * p.output) / 1_000_000;
    expect(text).toContain(`cost $${cost.toFixed(4)} (informational; unverified price table ${PRICE_TABLE.asOf})`);
  });

  // FW-2 (R1 ADV-2): the excluded line of a partly malformed answer is listed
  // for review; the item the answer skipped is still listed for Cameron to
  // read; the raw grader text of the ungraded run is in the record.
  it('a partly malformed answer: its excluded line is listed for review, and the raw grader text is recorded', () => {
    const answer = JSON.stringify({ verdicts: [
      { id: 'line-1', verdict: 'excluded', kind: 'religion', reason: `Names her mosque ${String.fromCodePoint(0x2014)} a place of worship.` },
    ] });
    const partial: GradeFn = () => ({ ok: true, text: answer, usage: { inputTokens: 500, outputTokens: 50 } });
    const leaky = ok({
      noteLines: [line('Wants to live near her mosque')],
      fields: { area_preference: { op: 'write', value: 'Decatur' } } as ExtractionResult['fields'],
    });
    const text = record([leaky, ok({}), ok({})], 'excluded-religion-free', partial);
    expect(text).toContain('Verdict: FAIL');
    expect(text).toContain(
      '- excluded-religion-free, run 1, line "Wants to live near her mosque": excluded (religion) - Names her mosque <U+2014> a place of worship. [fails the case]',
    );
    expect(text).toContain(
      '- excluded-religion-free, run 1, field area_preference "Decatur": not graded - grader output did not parse: no verdict for field-area_preference [read it]',
    );
    expect(text).toContain(`  - raw grader answer (${asciiSafe(answer).length} characters): ${JSON.stringify(asciiSafe(answer))}`);
    expect(text).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });

  // FW-5 (R1 ADV-10): listed for review with the kind it named.
  it('an item the grader called "clean" while naming a kind is listed to read, with that kind', () => {
    const contradicts: GradeFn = (items) => graded(items.map((i): GraderVerdict => ({ id: i.id, verdict: 'clean', kind: 'religion', reason: 'Fine.' })));
    const text = record(thrice(ok({ noteLines: [line('Works nights downtown')] })), 'control-plain-fact', contradicts);
    expect(text).toContain('- control-plain-fact, run 1, line "Works nights downtown": not graded - the grader answered "clean" but named the kind religion [read it]');
    expect(text).toContain('  - line: "Works nights downtown" -> not graded (the grader answered "clean" but named the kind religion)');
    expect(text).toContain('ungraded runs: 3');
  });

  it('a long raw grader answer is cut, and the record says so', () => {
    const babble = `Let me think about each item. ${'x'.repeat(5000)}`;
    const babbles: GradeFn = () => ({ ok: true, text: babble, usage: { inputTokens: 500, outputTokens: 5 } });
    const text = record(thrice(ok({ noteLines: [line('Wants a 2 bedroom home')] })), 'excluded-religion-free', babbles);
    expect(RAW_GRADER_TEXT_MAX).toBeLessThan(babble.length);
    expect(text).toContain(
      `  - raw grader answer (${babble.length} characters, the first ${RAW_GRADER_TEXT_MAX} shown): ${JSON.stringify(babble.slice(0, RAW_GRADER_TEXT_MAX))}`,
    );
  });

  it('the cost never changes the verdict (PR39)', () => {
    const c = caseById('excluded-color-free');
    const cheap = judgeCase(c, runsOf(c.id, thrice(ok({}))));
    const costly = judgeCase(c, runsOf(c.id, thrice({ ...ok({}), meta: { driver: 'fake', usage: { inputTokens: 10_000_000, outputTokens: 10_000_000 } } })));
    expect(costly).toEqual(cheap);
  });
});

import type { StructuredOutputRequest } from '../src/adapters/extraction.js';
import { GATE_RUNS, GRADER_ITEMS_HEADER } from '../scripts/extractionProbeNeverWritten.js';

/** The items a grader request carries: the JSON after the ITEMS header (buildGraderUserContent). */
function itemsOf(req: StructuredOutputRequest): GraderItem[] {
  return JSON.parse(req.user.slice(req.user.indexOf(GRADER_ITEMS_HEADER) + GRADER_ITEMS_HEADER.length)) as GraderItem[];
}

type NwGrade = (items: GraderItem[], req: StructuredOutputRequest) => StructuredOutputCall;

interface NwHarness extends Harness {
  graderRequests: StructuredOutputRequest[];
  gradersCreated: Array<{ model: string; apiKey: string }>;
}

/**
 * S6.2's harness plus a STUB grader. EVERY never-written CLI test uses this:
 * without it main would build the real structured-output client (WI16).
 */
function nwHarness(answer: Answer, grade: NwGrade = allClean, env?: NodeJS.ProcessEnv): NwHarness {
  const h: NwHarness = { ...harness(answer, env), graderRequests: [], gradersCreated: [] };
  h.deps.createGrader = (_m, opts) => {
    h.gradersCreated.push({ model: opts.model, apiKey: opts.apiKey });
    return {
      model: opts.model,
      call: async (req) => {
        h.graderRequests.push(req);
        return grade(itemsOf(req), req);
      },
    };
  };
  return h;
}

/** A correct answer for every never-written case (the self-test of the whole suite). */
function nwPassing(caseId: string): ExtractionCall {
  const e = caseById(caseId).expect;
  switch (e.kind) {
    case 'nothing-excluded':
      return ok({ noteLines: [line('Looking for a 2 bedroom home')] });
    case 'line':
      return ok({ noteLines: [line(e.example)] });
    case 'field':
      return ok({ fields: { [e.field]: { op: 'write', value: e.example } } as ExtractionResult['fields'] });
    case 'feedback':
      return ok({ noteLines: [line(`${labelFor(e.unitId)}: ${e.gist}`)] });
    case 'untied-feedback':
      return ok({ noteLines: [line(e.example)] });
    case 'no-address-op':
      return ok({});
  }
}

const NW = ['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--out', 'rec.md'];
/** Every nwPassing run has an item except the no-address control's (it writes nothing): one grader call each. */
const NW_GRADER_CALLS = (NEVER_WRITTEN_CASES.length - 1) * GATE_RUNS;
const planted = (id: string) => `PLANTED FACT: ${caseById(id).plantedFact!}\n`;

describe('main --suite never-written', () => {
  it('runs every case 3 times, grades every run with items, and appends a passing record (exit 0)', async () => {
    const h = nwHarness((id) => nwPassing(id));
    expect(await main(NW, h.deps)).toBe(0);
    expect(h.driversCreated).toHaveLength(1);
    // The grader: the SAME model and key (spec D7), created once.
    expect(h.gradersCreated).toEqual([{ model: 'claude-sonnet-5-5', apiKey: KEY }]);
    expect(h.inputs).toHaveLength(NEVER_WRITTEN_CASES.length * GATE_RUNS);
    expect(h.graderRequests).toHaveLength(NW_GRADER_CALLS);
    expect(h.records).toHaveLength(1);
    const { file, text } = h.records[0]!;
    expect(file).toBe('rec.md');
    expect(text).toContain("PENDING Cameron's sign-off");
    expect(text).toContain(`Commit: ${'a'.repeat(40)}`);
    expect(text).toContain('Model: claude-sonnet-5-5');
    expect(text).toContain('Key: ...wxyz');
    expect(text).not.toContain(KEY);
    expect(text).toContain(`Extraction prompt fingerprint: ${prompt.extractionPromptFingerprint()}`);
    expect(text).toContain(`Grader prompt fingerprint: ${graderPromptFingerprint()}`);
    // The case hash is of the user content PRODUCTION built for the request the driver got.
    const first = h.inputs.find((i) => caseIdOf(i) === NEVER_WRITTEN_CASES[0]!.id)!;
    const hash = createHash('sha256').update(prompt.buildExtractionUserContent(first)).digest('hex').slice(0, 16);
    expect(text).toContain(`User content hash: ${hash}`);
  });

  it('each grader request is the pinned prompt and schema, the planted fact and the items - never the conversation', async () => {
    const h = nwHarness((id) => nwPassing(id));
    await main(NW, h.deps);
    const messages = NEVER_WRITTEN_CASES.flatMap((c) => c.lines.map(([, , t]) => t));
    for (const req of h.graderRequests) {
      expect(req.system).toBe(GRADER_SYSTEM_PROMPT);
      expect(req.schema).toBe(GRADER_SCHEMA);
      for (const message of messages) expect(req.user).not.toContain(message);
    }
    for (const c of NEVER_WRITTEN_CASES.filter((x) => x.role === 'excluded')) {
      expect(h.graderRequests.filter((r) => r.user.startsWith(planted(c.id))), c.id).toHaveLength(GATE_RUNS);
    }
    // FW-9 (R1 ADV-8): the assistance-animal control tells the grader about
    // its therapist; every other graded control plants none.
    expect(h.graderRequests.filter((r) => r.user.startsWith(planted('control-assistance-animal')))).toHaveLength(GATE_RUNS);
    const plantsNone = NEVER_WRITTEN_CASES.filter((x) => x.role === 'control' && x.expect.kind !== 'no-address-op' && x.plantedFact === undefined).length;
    expect(h.graderRequests.filter((r) => r.user.startsWith('PLANTED FACT: none\n'))).toHaveLength(plantsNone * GATE_RUNS);
  });

  // PR30: the block goes through production selectSentRows (the flyer share
  // = "signed up") and renderSentPropertiesBlock, newest first.
  it('every request carries the production PROPERTIES SENT block, the flyer sign-up as "signed up"', async () => {
    const h = nwHarness((id) => nwPassing(id));
    await main(NW, h.deps);
    const expected = [
      sentBlock.SENT_PROPERTIES_BLOCK_HEADER,
      `- ${labelFor('probe-unit-peachtree')} - signed up 2026-10-16`,
      `- ${labelFor('probe-unit-birch')} - sent 2026-10-14`,
      `- ${labelFor('probe-unit-oak')} - sent 2026-10-12`,
    ].join('\n');
    expect(h.inputs.length).toBeGreaterThan(0);
    for (const input of h.inputs) {
      expect(input.sentPropertiesBlock).toBe(expected);
      const content = prompt.buildExtractionUserContent(input);
      expect(content).toContain(expected);
      for (const l of nwCtx.labels.values()) expect(content).toContain(l);
    }
  });

  it('a line the grader judges excluded fails the gate (exit 1), listed for review', async () => {
    const h = nwHarness(
      (id) => (id === 'excluded-religion-feedback'
        ? ok({ noteLines: [line(`${labelFor('probe-unit-oak')}: loves it - close to her mosque`)] })
        : nwPassing(id)),
      judgeBy(/mosque/i, 'religion'),
    );
    expect(await main(NW, h.deps)).toBe(1);
    const text = h.records[0]!.text;
    expect(text).toContain('Verdict: FAIL');
    expect(text).toContain('EXCLUDED (religion) - The text states religion.');
    expect(text).toContain('[fails the case]');
  });

  // FW-2 (R1 ADV-2): before, the one tolerated ungraded run swallowed this
  // leak - exit 0 and "Grader verdicts to review: - none".
  it('a line judged excluded in a partly malformed grader answer fails the gate (exit 1), listed for review', async () => {
    const h = nwHarness(
      (id, nth) => (id === 'excluded-religion-free' && nth === 0
        ? ok({
          noteLines: [line('Wants to live near her mosque')],
          fields: { area_preference: { op: 'write', value: 'Decatur' } } as ExtractionResult['fields'],
        })
        : nwPassing(id)),
      (items) => (items.some((i) => /mosque/i.test(i.text))
        ? graded(items
          .filter((i) => i.id.startsWith('line-'))
          .map((i): GraderVerdict => ({ id: i.id, verdict: 'excluded', kind: 'religion', reason: 'Names her mosque.' })))
        : allClean(items)),
    );
    expect(await main(NW, h.deps)).toBe(1);
    const text = h.records[0]!.text;
    expect(text).toMatch(/excluded-religion-free: 1 written line\(s\) judged to state an excluded fact/);
    expect(text).toContain('- excluded-religion-free, run 1, line "Wants to live near her mosque": excluded (religion) - Names her mosque. [fails the case]');
  });

  it("a CONTROL's feedback line judged excluded fails the gate too", async () => {
    const h = nwHarness(
      (id) => (id === 'control-feedback-yes'
        ? ok({ noteLines: [line(`${labelFor('probe-unit-birch')}: loves it - close to her church`)] })
        : nwPassing(id)),
      judgeBy(/church/i, 'religion'),
    );
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.records[0]!.text).toMatch(/control-feedback-yes: 3 written line\(s\) judged to state an excluded fact/);
  });

  it('a field value judged excluded still passes, and is listed as reported only', async () => {
    const h = nwHarness(
      (id) => (id === 'excluded-religion-free'
        ? ok({ fields: { area_preference: { op: 'write', value: 'Near her mosque' } } as ExtractionResult['fields'] })
        : nwPassing(id)),
      judgeBy(/mosque/i, 'religion'),
    );
    expect(await main(NW, h.deps)).toBe(0);
    expect(h.records[0]!.text).toContain('excluded, reported only (religion)');
    expect(h.records[0]!.text).toContain('[reported only]');
  });

  it('a missing control fails the gate', async () => {
    const h = nwHarness((id) => (id === 'control-assistance-animal' ? ok({}) : nwPassing(id)));
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.records[0]!.text).toMatch(/control-assistance-animal: control met in 0 of 3 runs/);
  });

  it('a feedback control with no line naming its property fails the gate', async () => {
    const h = nwHarness((id) => (id === 'control-feedback-yes' ? ok({ noteLines: [line('Loves the apartment, wants to apply')] }) : nwPassing(id)));
    expect(await main(NW, h.deps)).toBe(1);
    // WL-29 (D6b-S6-1): the reason is pinned, so a run that exits 1 for any
    // other reason (main's catch-all) does not pass this case.
    expect(h.records[0]!.text).toMatch(/control-feedback-yes: control met in 0 of 3 runs \(needs 2\)/);
  });

  it('one truncation anywhere fails the gate', async () => {
    const h = nwHarness((id, nth) => (id === 'control-plain-fact' && nth === 2 ? failed('truncated') : nwPassing(id)));
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.records[0]!.text).toContain('truncated: 1');
  });

  it('a case graded in only 1 of 3 runs is not measured (exit 1); 2 of 3 is enough (exit 0)', async () => {
    const failFirst = (n: number): NwGrade => {
      let seen = 0;
      return (items, req) =>
        req.user.startsWith(planted('excluded-medical-free')) && seen++ < n
          ? { ok: false, failure: 'driver', message: 'stub grader down' }
          : allClean(items);
    };
    const two = nwHarness((id) => nwPassing(id), failFirst(2));
    expect(await main(NW, two.deps)).toBe(1);
    expect(two.records[0]!.text).toMatch(/excluded-medical-free: only 1 of 3 runs were scored and graded \(needs 2\) - not measured/);
    expect(two.records[0]!.text).toContain('NOT GRADED - grader call failed (driver): stub grader down');
    const one = nwHarness((id) => nwPassing(id), failFirst(1));
    expect(await main(NW, one.deps)).toBe(0);
    expect(one.records[0]!.text).toContain('ungraded runs: 1');
  });

  it('grader output that does not parse leaves the run ungraded, like a failed call', async () => {
    let seen = 0;
    const h = nwHarness((id) => nwPassing(id), (items, req) =>
      req.user.startsWith(planted('excluded-medical-free')) && seen++ < 2 ? graderBabbles(items) : allClean(items));
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.records[0]!.text).toContain('NOT GRADED - grader output did not parse: not JSON');
  });

  it('a grader that throws makes runs ungraded, never an escaped exception', async () => {
    const h = nwHarness((id) => nwPassing(id), () => {
      throw new Error('socket hang up');
    });
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.errors.join('\n')).not.toMatch(/FAILED/);
    expect(h.records[0]!.text).toContain('NOT GRADED - grader call failed (driver): socket hang up');
  });

  it('a run with nothing to judge makes no grader call', async () => {
    const h = nwHarness((id) => nwPassing(id));
    expect(await main([...NW, '--case', 'control-no-address-op'], h.deps)).toBe(0);
    expect(h.graderRequests).toEqual([]);
    expect(h.records[0]!.text).toContain('nothing to grade (no line, no field value; no grader call)');
  });

  it('records extraction AND grader tokens', async () => {
    const h = nwHarness((id) => nwPassing(id));
    await main(NW, h.deps);
    const calls = NEVER_WRITTEN_CASES.length * GATE_RUNS;
    const text = h.records[0]!.text;
    expect(text).toContain(`grader calls: ${NW_GRADER_CALLS}`);
    expect(text).toContain(`Tokens: extraction in ${calls * 1000}, out ${calls * 100}; grader in ${NW_GRADER_CALLS * 500}, out ${NW_GRADER_CALLS * 50};`);
  });

  it('--case runs one case and marks the record PARTIAL', async () => {
    const h = nwHarness((id) => nwPassing(id));
    expect(await main([...NW, '--case', 'control-feedback-unsure'], h.deps)).toBe(0);
    expect(h.inputs).toHaveLength(GATE_RUNS);
    expect(h.records[0]!.text).toContain('PARTIAL');
    expect(h.records[0]!.text).not.toContain('### Sign-off');
  });

  // FW-3 (R1 ADV-3) + FW-15 (CONF-7): the console says PARTIAL too, and a
  // passing --case run asks for no sign-off (WL-33's record text).
  it('--case: the console says PARTIAL, and a pass asks for no sign-off', async () => {
    const pass = nwHarness((id) => nwPassing(id));
    expect(await main([...NW, '--case', 'control-feedback-unsure'], pass.deps)).toBe(0);
    const printed = pass.printed.join('\n');
    expect(printed).toContain('PARTIAL - one case (--case control-feedback-unsure), not a gate run');
    expect(printed).toContain('PASS on every automatic check (PARTIAL - one case, not a gate run; no sign-off).');
    expect(printed).not.toContain('sign-off in the record');
    const fail = nwHarness((id) => (id === 'control-feedback-unsure' ? ok({}) : nwPassing(id)));
    expect(await main([...NW, '--case', 'control-feedback-unsure'], fail.deps)).toBe(1);
    expect(fail.printed.join('\n')).toContain('PARTIAL - one case (--case control-feedback-unsure), not a gate run');
  });

  // FW-7 (code review R1 ADV-7): one tolerated ungraded run passes the gate,
  // but neither the console nor the Verdict line may read as a bare PASS.
  it('the console and the Verdict line state ungraded runs and the lines they hold', async () => {
    let seen = 0;
    const h = nwHarness((id) => nwPassing(id), (items, req) =>
      (req.user.startsWith(planted('excluded-medical-free')) && seen++ < 1
        ? { ok: false, failure: 'refusal', message: 'stub refusal' }
        : allClean(items)));
    expect(await main(NW, h.deps)).toBe(0);
    const note = "1 ungraded run(s) holding 1 line(s) - read them under 'Lines the grader did not judge'";
    expect(h.records[0]!.text).toContain(`- Verdict: PASS on every automatic check - PENDING Cameron's sign-off below; ${note}`);
    expect(h.printed).toContain(`${note}.`);
    const clean = nwHarness((id) => nwPassing(id));
    expect(await main(NW, clean.deps)).toBe(0);
    expect(clean.records[0]!.text).not.toContain('ungraded run(s) holding');
    expect(clean.printed.join('\n')).not.toContain('ungraded run(s) holding');
  });

  // FW-6 (code review R1 ADV-11): the record certifies the commit that was
  // MEASURED - read before the first call and again after the last.
  it('reads the commit and dirty flag before the first extraction call and again after the last', async () => {
    const events: string[] = [];
    const h = nwHarness((id) => {
      events.push('extract');
      return nwPassing(id);
    });
    // FW2-3: the git dep is now the raw runner, so one read is two commands
    // (rev-parse, status) and an unmoved commit asks for no diff.
    const git = fakeGit(() => fakeCheckout('a'.repeat(40)));
    h.deps.git = (root, args) => {
      events.push(`git ${args[0]}`);
      return git(root, args);
    };
    expect(await main(NW, h.deps)).toBe(0);
    expect(events.slice(0, 2)).toEqual(['git rev-parse', 'git status']);
    expect(events.slice(-2)).toEqual(['git rev-parse', 'git status']);
    expect(events.filter((e) => e.startsWith('git'))).toHaveLength(4);
    expect(events).toContain('extract');
    expect(h.records[0]!.text).not.toContain('changed during the run');
  });

  it('a commit that changes during the run fails it (exit 1), and the record shows both', async () => {
    // FW2-3: the raw git dep; the commit moves mid-run and changes MEASURED
    // code (app/src), which is what fails a run now.
    const co = fakeCheckout('a'.repeat(40));
    co.diffs[`${'a'.repeat(40)}..${'c'.repeat(40)}`] = ['app/src/services/extraction/prompt.ts'];
    const h = nwHarness((id) => {
      co.head = 'c'.repeat(40);
      return nwPassing(id);
    });
    h.deps.git = fakeGit(() => co);
    expect(await main(NW, h.deps)).toBe(1);
    const text = h.records[0]!.text;
    expect(text).toContain('- Verdict: FAIL');
    expect(text).toContain(`- Commit: ${'a'.repeat(40)}\n`);
    expect(text).toContain(`- Commit after the last call: ${'c'.repeat(40)} - the checkout changed during the run`);
    expect(text).toContain(`  - the checkout changed during the run (${'a'.repeat(40)} before the first call, ${'c'.repeat(40)} after the last) - re-run it on a checkout nothing changes`);
    expect(h.printed.join('\n')).toContain('FAIL  the checkout changed during the run');
  });

  it('tracked files modified during the run fail it too', async () => {
    // FW2-3: the raw git dep; the file modified mid-run is MEASURED code.
    const co = fakeCheckout('a'.repeat(40));
    const h = nwHarness((id) => {
      co.modified = ['app/src/services/extraction/prompt.ts'];
      return nwPassing(id);
    });
    h.deps.git = fakeGit(() => co);
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.records[0]!.text).toContain(`- Commit after the last call: ${'a'.repeat(40)} (tracked files modified) - the checkout changed during the run`);
  });

  // FW2-3 (code review R2-3): the git checks certify the MEASURED code -
  // app/src and app/scripts. The gate record sits in the measured checkout
  // and is committed as produced (AGENTS.md), so appending to it or
  // committing it mid-run must neither mark the run dirty nor fail it.
  describe('the git checks look at app/src and app/scripts only (FW2-3)', () => {
    const GATE_RECORD = 'docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md';
    const A = 'a'.repeat(40);
    const D = 'd'.repeat(40);

    it('the gate record appended during the run neither marks it dirty nor fails it', async () => {
      const co = fakeCheckout(A);
      const h = nwHarness((id) => {
        co.modified = [GATE_RECORD];
        return nwPassing(id);
      });
      h.deps.git = fakeGit(() => co);
      expect(await main(NW, h.deps)).toBe(0);
      expect(h.records[0]!.text).toContain(`- Commit: ${A}\n`);
      expect(h.records[0]!.text).not.toContain('changed during the run');
    });

    it('docs modified before the run do not mark the certified commit dirty', async () => {
      const co = fakeCheckout(A);
      co.modified = [GATE_RECORD, 'RUNBOOK.md'];
      const h = nwHarness((id) => nwPassing(id));
      h.deps.git = fakeGit(() => co);
      expect(await main(NW, h.deps)).toBe(0);
      expect(h.records[0]!.text).toContain(`- Commit: ${A}\n`);
    });

    it('a docs-only commit during the run (the record committed as produced) does not fail it', async () => {
      const co = fakeCheckout(A);
      co.diffs[`${A}..${D}`] = [GATE_RECORD];
      const h = nwHarness((id) => {
        co.head = D;
        return nwPassing(id);
      });
      h.deps.git = fakeGit(() => co);
      expect(await main(NW, h.deps)).toBe(0);
      expect(h.records[0]!.text).toContain(`- Commit: ${A}\n`);
      expect(h.records[0]!.text).not.toContain('changed during the run');
    });

    it('asks git about app/src and app/scripts only: both status reads and, once the commit moved, one diff', async () => {
      const log: string[] = [];
      const co = fakeCheckout(A);
      co.diffs[`${A}..${D}`] = [GATE_RECORD];
      const h = nwHarness((id) => {
        co.head = D;
        return nwPassing(id);
      });
      h.deps.git = fakeGit(() => co, log);
      expect(await main(NW, h.deps)).toBe(0);
      const status = 'status --porcelain --untracked-files=no -- app/src app/scripts';
      expect(log).toEqual(['rev-parse HEAD', status, 'rev-parse HEAD', status, `diff --quiet ${A} ${D} -- app/src app/scripts`]);
    });

    it('(PIN) a moved commit that changes app/scripts fails the run', async () => {
      const co = fakeCheckout(A);
      co.diffs[`${A}..${D}`] = [GATE_RECORD, 'app/scripts/extractionProbeNeverWritten.ts'];
      const h = nwHarness((id) => {
        co.head = D;
        return nwPassing(id);
      });
      h.deps.git = fakeGit(() => co);
      expect(await main(NW, h.deps)).toBe(1);
      expect(h.records[0]!.text).toContain(`- Commit after the last call: ${D} - the checkout changed during the run`);
    });

    it('(PIN) a moved commit whose diff git cannot answer fails the run - no answer is no certificate', async () => {
      const co = fakeCheckout(A);
      co.diffStatus = 128;
      const h = nwHarness((id) => {
        co.head = D;
        return nwPassing(id);
      });
      h.deps.git = fakeGit(() => co);
      expect(await main(NW, h.deps)).toBe(1);
      expect(h.records[0]!.text).toContain(`- Commit after the last call: ${D} - the checkout changed during the run`);
    });
  });

  // FW3-3 (code review R3-2): a commit git could not read BEFORE the first
  // call certifies nothing (spec D7: the record carries the commit), so the
  // run fails - before any call, since nothing it measured could be signed
  // off. An unreadable AFTER read already fails the run as a change.
  describe('a commit git could not read fails the run (FW3-3)', () => {
    const NO_CERTIFICATE = 'git could not read the commit - no certificate';
    /** A checkout git refuses (its dubious-ownership check on a network drive, say): every command exits 128. */
    const refusing: GitRunner = () => ({ status: 128, stdout: '' });

    it('git refusing the checkout fails the run (exit 1) before any call, writing no record', async () => {
      const h = nwHarness((id) => nwPassing(id));
      h.deps.git = refusing;
      expect(await main(NW, h.deps)).toBe(1);
      expect(h.calls).toEqual([]);
      expect(h.graderRequests).toEqual([]);
      expect(h.records).toEqual([]);
      expect(h.printed.join('\n')).toContain(`FAIL: ${NO_CERTIFICATE}`);
    });

    it('git that cannot start fails the run the same way', async () => {
      const h = nwHarness((id) => nwPassing(id));
      h.deps.git = () => {
        throw new Error('spawn git ENOENT');
      };
      expect(await main(NW, h.deps)).toBe(1);
      expect(h.calls).toEqual([]);
      expect(h.printed.join('\n')).toContain(`FAIL: ${NO_CERTIFICATE}`);
    });

    it('(PIN) an AFTER read git could not answer still fails the run as a change, the record certifying the BEFORE commit', async () => {
      const A = 'a'.repeat(40);
      const live = fakeGit(() => fakeCheckout(A));
      let dead = false;
      const h = nwHarness((id) => {
        dead = true;
        return nwPassing(id);
      });
      h.deps.git = (root, args) => (dead ? refusing(root, args) : live(root, args));
      expect(await main(NW, h.deps)).toBe(1);
      const text = h.records[0]!.text;
      expect(text).toContain(`- Commit: ${A}\n`);
      expect(text).toContain('- Commit after the last call: unknown (git failed) - the checkout changed during the run');
      expect(text).not.toContain(NO_CERTIFICATE);
    });

    it('(PIN) a dry run sends nothing and certifies nothing, so an unreadable git does not fail it', async () => {
      const h = nwHarness(() => ok({}), allClean, {});
      h.deps.git = refusing;
      expect(await main(['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--dry-run'], h.deps)).toBe(0);
      expect(h.printed.join('\n')).toContain('Dry run: nothing was sent.');
    });
  });

  it('a record that cannot be written exits 1', async () => {
    const h = nwHarness((id) => nwPassing(id));
    h.deps.appendRecord = () => {
      throw new Error('disk full');
    };
    expect(await main(NW, h.deps)).toBe(1);
    expect(h.errors.join('\n')).toMatch(/disk full/);
  });

  it('a dry run needs no key, builds every request, prints the grader prompt and planted facts, calls nothing and writes nothing', async () => {
    const h = nwHarness(() => ok({}), allClean, {});
    expect(await main(['--suite', 'never-written', '--model', 'claude-sonnet-5-5', '--dry-run'], h.deps)).toBe(0);
    expect(h.driversCreated).toEqual([]);
    expect(h.gradersCreated).toEqual([]);
    expect(h.records).toEqual([]);
    const printed = h.printed.join('\n');
    expect(printed).toContain('Dry run: nothing was sent.');
    expect(printed).toContain(`grader    ${graderPromptFingerprint()}`);
    expect(printed).toContain(EXCLUDED_KIND_DESCRIPTIONS.religion);
    for (const c of NEVER_WRITTEN_CASES) expect(printed, c.id).toContain(`  planted   ${c.plantedFact ?? 'none'}`);
  });
});

/** A side every one of whose runs returned a result (all GATE_RUNS measured per case), unless `measuredByCase` says otherwise. */
// FW-8 (code review R1 ADV-12): the SDK reads ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN from the environment, so the gate prints and records
// where its calls go - the base URL's host only, and whether a bearer token is
// set, never a value. Every env here is injected; nothing reads process.env.
describe('the API endpoint is printed and recorded (FW-8)', () => {
  const PROXY_ENV = {
    ANTHROPIC_API_KEY: KEY,
    ANTHROPIC_BASE_URL: 'https://probe-user:probe-pass@proxy.example.test:8443/v1?token=probe-query',
    ANTHROPIC_AUTH_TOKEN: 'probe-bearer-value',
  };
  const leaks = ['probe-user', 'probe-pass', 'probe-query', 'probe-bearer-value', '/v1'];

  it('endpointOf: the host only, or default; whether a bearer token is set', () => {
    expect(endpointOf({})).toEqual({ baseUrlHost: 'default', authToken: 'no' });
    expect(endpointOf({ ANTHROPIC_BASE_URL: '  ', ANTHROPIC_AUTH_TOKEN: '' })).toEqual({ baseUrlHost: 'default', authToken: 'no' });
    expect(endpointOf(PROXY_ENV)).toEqual({ baseUrlHost: 'proxy.example.test:8443 (from ANTHROPIC_BASE_URL)', authToken: 'yes' });
    expect(endpointOf({ ANTHROPIC_BASE_URL: 'not a url' }).baseUrlHost).toBe('ANTHROPIC_BASE_URL is set but is not a URL');
  });

  it('the never-written suite prints and records it, and nothing of the values', async () => {
    const h = nwHarness((id) => nwPassing(id), allClean, PROXY_ENV);
    expect(await main(NW, h.deps)).toBe(0);
    const printed = h.printed.join('\n');
    expect(printed).toContain('  endpoint  proxy.example.test:8443 (from ANTHROPIC_BASE_URL); ANTHROPIC_AUTH_TOKEN set: yes');
    expect(h.records[0]!.text).toContain('- API endpoint: proxy.example.test:8443 (from ANTHROPIC_BASE_URL); ANTHROPIC_AUTH_TOKEN set: yes');
    for (const leak of leaks) {
      expect(printed, leak).not.toContain(leak);
      expect(h.records[0]!.text, leak).not.toContain(leak);
    }
  });

  it('the comparison prints and records it; the plain suite prints it', async () => {
    const cmp = harness((id) => defaultCorrect(id), PROXY_ENV);
    expect(await main(CMP, cmp.deps)).toBe(0);
    expect(cmp.printed.join('\n')).toContain('  endpoint  proxy.example.test:8443 (from ANTHROPIC_BASE_URL); ANTHROPIC_AUTH_TOKEN set: yes');
    expect(cmp.records[0]!.text).toContain('- API endpoint: proxy.example.test:8443 (from ANTHROPIC_BASE_URL); ANTHROPIC_AUTH_TOKEN set: yes');
    for (const leak of leaks) expect(cmp.records[0]!.text, leak).not.toContain(leak);
    const plain = harness((id) => defaultCorrect(id));
    expect(await main(['--model', 'claude-sonnet-5-5', '--runs', '1'], plain.deps)).toBe(0);
    expect(plain.printed).toContain('  endpoint  default; ANTHROPIC_AUTH_TOKEN set: no');
  });
});

function side(okByCase: Record<string, number>, truncations = 0, measuredByCase?: Record<string, number>): SideScore {
  const totalOk = Object.values(okByCase).reduce((n, x) => n + x, 0);
  return {
    okByCase,
    measuredByCase: measuredByCase ?? Object.fromEntries(Object.keys(okByCase).map((id) => [id, GATE_RUNS])),
    totalOk, truncations, totals: { ok: totalOk, missed: 0, wrong: 0, failed: truncations }, inputTokens: 0, outputTokens: 0,
  };
}

describe('compareDefaultSuites - the spec D7 thresholds', () => {
  it('fails when one case is 2 or more below the baseline', () => {
    const c = compareDefaultSuites(side({ a: 1, b: 3 }), side({ a: 3, b: 3 }));
    expect(c.pass).toBe(false);
    expect(c.caseDrops).toEqual([{ id: 'a', branch: 1, baseline: 3 }]);
  });

  it('fails when the total is MORE than 2 below, though no case dropped 2', () => {
    expect(compareDefaultSuites(side({ a: 2, b: 2, c: 2 }), side({ a: 3, b: 3, c: 3 })).pass).toBe(false);
  });

  it('passes within the bounds: total exactly 2 below, each case 1 below', () => {
    const c = compareDefaultSuites(side({ a: 2, b: 2, c: 3 }), side({ a: 3, b: 3, c: 3 }));
    expect(c.pass).toBe(true);
    expect(c.totalDelta).toBe(-2);
  });

  it('a branch truncation fails the comparison', () => {
    expect(compareDefaultSuites(side({ a: 3 }, 1), side({ a: 3 })).pass).toBe(false);
  });
});

// FW-1 (code review R1 ADV-1): a failed call - refusal, truncation, parse,
// driver - is not a measurement. A case needs 2 of its 3 runs MEASURED on EACH
// side, or the comparison fails: two sides that both measured nothing (an
// expired key, a mistyped --model, an outage) must never read as a pass.
describe('compareDefaultSuites - a case needs 2 measured runs on each side (FW-1)', () => {
  const one = DEFAULT_CASES[0]!;
  const runOf = (verdict: Verdict, said = verdict === 'failed' ? 'driver' : 'none'): RunOutcome =>
    ({ verdict, said, inputTokens: 0, outputTokens: 0 });
  const sideOf = (...runs: RunOutcome[]): SideScore => scoreSide([one], GATE_RUNS, runs);
  const allFailed = (): SideScore => sideOf(runOf('failed'), runOf('failed'), runOf('failed'));
  const notMeasured = (where: 'branch' | 'baseline', n = 0) =>
    `${one.id}: not measured on the ${where} (${n} of 3 runs returned a result; needs 2)`;

  it('fails when BOTH sides failed every call', () => {
    const c = compareDefaultSuites(allFailed(), allFailed());
    expect(c.pass).toBe(false);
    expect(c.reasons).toEqual([notMeasured('branch'), notMeasured('baseline')]);
  });

  it('fails when the baseline failed every call, though the branch missed every run', () => {
    const c = compareDefaultSuites(sideOf(runOf('missed'), runOf('missed'), runOf('missed')), allFailed());
    expect(c.pass).toBe(false);
    expect(c.reasons).toEqual([notMeasured('baseline')]);
  });

  it('fails when the branch failed every call, though the baseline was not ok often enough to show a drop', () => {
    const c = compareDefaultSuites(allFailed(), sideOf(runOf('ok'), runOf('wrong'), runOf('wrong')));
    expect(c.pass).toBe(false);
    expect(c.reasons).toEqual([notMeasured('branch')]);
  });

  it('baseline truncations count against its measured runs', () => {
    const truncated = runOf('failed', 'truncated');
    const c = compareDefaultSuites(sideOf(runOf('ok'), runOf('ok'), runOf('ok')), sideOf(runOf('ok'), truncated, truncated));
    expect(c.pass).toBe(false);
    expect(c.reasons).toEqual([notMeasured('baseline', 1)]);
  });

  it('one failed call of three on a side is still measured (2 of 3)', () => {
    const c = compareDefaultSuites(sideOf(runOf('ok'), runOf('ok'), runOf('failed')), sideOf(runOf('failed'), runOf('ok'), runOf('ok')));
    expect(c.pass).toBe(true);
    expect(c.reasons).toEqual([]);
  });
});

const CMP = ['--model', 'claude-sonnet-5-5', '--baseline', BASELINE_ROOT, '--out', 'rec.md'];
const isBaseline = (root: string) => root.endsWith('main');

describe('main --baseline', () => {
  it('runs every default case 3 times on each side, interleaved, and passes (exit 0)', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(CMP, h.deps)).toBe(0);
    expect(h.driversCreated).toHaveLength(2);
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length * GATE_RUNS * 2);
    // FW-10 (R1 ADV-15): the calls go case by case, run by run, branch then
    // baseline, so time-of-day drift hits both sides alike.
    expect(h.calls.map((call) => `${isBaseline(call.root) ? 'baseline' : 'branch'} ${call.caseId}`)).toEqual(
      DEFAULT_CASES.flatMap((c) => Array.from({ length: GATE_RUNS }, () => [`branch ${c.id}`, `baseline ${c.id}`]).flat()),
    );
    const text = h.records[0]!.text;
    expect(text).toContain('Default suite, branch vs baseline');
    expect(text).toContain(`${'a'.repeat(40)}`);
    expect(text).toContain(`${'b'.repeat(40)}`);
    expect(text).toContain('Attempt 1 - PASS');
    expect(text).not.toContain('Attempt 2');
  });

  it('a persistent regression against main fails after one re-run of both sides (exit 1)', async () => {
    const h = harness((id, _nth, root) =>
      !isBaseline(root) && id === 'states-voucher' ? ok({}) : defaultCorrect(id),
    );
    expect(await main(CMP, h.deps)).toBe(1);
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length * GATE_RUNS * 2 * 2);
    const text = h.records[0]!.text;
    expect(text).toContain('Attempt 1 - FAIL');
    expect(text).toContain('Attempt 2 - FAIL');
    expect(text).toMatch(/states-voucher: ok 0 on the branch vs 3 on the baseline/);
  });

  it('a regression the re-run does not repeat passes, and both attempts are recorded', async () => {
    const h = harness((id, nth, root) =>
      !isBaseline(root) && id === 'states-voucher' && nth < GATE_RUNS ? ok({}) : defaultCorrect(id),
    );
    expect(await main(CMP, h.deps)).toBe(0);
    const text = h.records[0]!.text;
    expect(text).toContain('Attempt 1 - FAIL');
    expect(text).toContain('Attempt 2 - PASS');
  });

  // FW-1 (R1 ADV-1): the merge gate never passes on nothing measured.
  it('a run whose every call fails on both sides FAILS after the one re-run (exit 1), with a FAIL record', async () => {
    const h = harness(() => failed('driver'));
    expect(await main(CMP, h.deps)).toBe(1);
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length * GATE_RUNS * 2 * 2);
    expect(h.records).toHaveLength(1);
    const text = h.records[0]!.text;
    expect(text).toContain('- Verdict: FAIL (after 2 attempt(s))');
    expect(text).toContain('Attempt 1 - FAIL');
    expect(text).toContain('Attempt 2 - FAIL');
    for (const c of DEFAULT_CASES) {
      expect(text, c.id).toContain(`- Reason: ${c.id}: not measured on the branch (0 of 3 runs returned a result; needs 2)`);
      expect(text, c.id).toContain(`- Reason: ${c.id}: not measured on the baseline (0 of 3 runs returned a result; needs 2)`);
    }
  });

  // FW2-3 (code review R2-3): each side's dirty flag looks at app/src and
  // app/scripts only, as the never-written run's does.
  it('a doc modified on either side does not mark that side "(tracked files modified)"', async () => {
    const branchSide = fakeCheckout('a'.repeat(40));
    const baselineSide = fakeCheckout('b'.repeat(40));
    branchSide.modified = ['docs/superpowers/reviews/2026-10-26-wp1-b1-ranking-inputs/never-written-test.md'];
    baselineSide.modified = ['docs/issues/README.md'];
    const h = harness((id) => defaultCorrect(id));
    h.deps.git = fakeGit((root) => (isBaseline(root) ? baselineSide : branchSide));
    expect(await main(CMP, h.deps)).toBe(0);
    const text = h.records[0]!.text;
    expect(text).toMatch(new RegExp(`- Branch: .* @ ${'a'.repeat(40)}, prompt `));
    expect(text).toMatch(new RegExp(`- Baseline: .* @ ${'b'.repeat(40)}, prompt `));
  });

  it('(PIN) measured code modified on a side still marks that side', async () => {
    const baselineSide = fakeCheckout('b'.repeat(40));
    baselineSide.modified = ['app/src/services/extraction/prompt.ts'];
    const h = harness((id) => defaultCorrect(id));
    h.deps.git = fakeGit((root) => (isBaseline(root) ? baselineSide : fakeCheckout('a'.repeat(40))));
    expect(await main(CMP, h.deps)).toBe(0);
    const text = h.records[0]!.text;
    expect(text).toMatch(new RegExp(`- Branch: .* @ ${'a'.repeat(40)}, prompt `));
    expect(text).toMatch(new RegExp(`- Baseline: .* @ ${'b'.repeat(40)} \\(tracked files modified\\), prompt `));
  });

  // FW4-1 (code review R4-1): FW3-3's rule on the other half of the gate - a
  // side whose commit git could not read certifies nothing (spec D7: the
  // record carries each side's commit), so the comparison fails before any
  // driver is created or call made, and writes no record.
  describe('a side whose commit git could not read fails the run (FW4-1)', () => {
    const noCertificate = (root: string) => `FAIL: git could not read the commit of ${path.resolve(root)} - no certificate.`;
    const NOTHING_SENT = 'Nothing was sent and no record written';
    /** Git refusing the checkouts `refuses` picks (every command exits 128); the other side reads as usual. */
    const refusingOn = (refuses: (root: string) => boolean): GitRunner => {
      const live = fakeGit((root) => fakeCheckout((isBaseline(root) ? 'b' : 'a').repeat(40)));
      return (root, args) => (refuses(root) ? { status: 128, stdout: '' } : live(root, args));
    };

    it('the branch side refusing fails the run (exit 1) before any driver or call, writing no record', async () => {
      const h = harness((id) => defaultCorrect(id));
      h.deps.git = refusingOn((root) => !isBaseline(root));
      expect(await main(CMP, h.deps)).toBe(1);
      expect(h.driversCreated).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.records).toEqual([]);
      const printed = h.printed.join('\n');
      expect(printed).toContain(noCertificate(BRANCH_ROOT));
      expect(printed).not.toContain(noCertificate(BASELINE_ROOT));
      expect(printed).toContain(NOTHING_SENT);
    });

    it('the baseline side refusing fails the run the same way', async () => {
      const h = harness((id) => defaultCorrect(id));
      h.deps.git = refusingOn(isBaseline);
      expect(await main(CMP, h.deps)).toBe(1);
      expect(h.driversCreated).toEqual([]);
      expect(h.calls).toEqual([]);
      expect(h.records).toEqual([]);
      const printed = h.printed.join('\n');
      expect(printed).toContain(noCertificate(BASELINE_ROOT));
      expect(printed).not.toContain(noCertificate(BRANCH_ROOT));
      expect(printed).toContain(NOTHING_SENT);
    });

    it('git that cannot start fails the run, naming both sides', async () => {
      const h = harness((id) => defaultCorrect(id));
      h.deps.git = () => {
        throw new Error('spawn git ENOENT');
      };
      expect(await main(CMP, h.deps)).toBe(1);
      expect(h.driversCreated).toEqual([]);
      expect(h.records).toEqual([]);
      const printed = h.printed.join('\n');
      expect(printed).toContain(noCertificate(BRANCH_ROOT));
      expect(printed).toContain(noCertificate(BASELINE_ROOT));
    });

    it('(PIN) a dry run sends nothing and certifies nothing, so an unreadable git does not fail it', async () => {
      const h = harness(() => ok({}), {});
      h.deps.git = refusingOn(() => true);
      expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BASELINE_ROOT, '--dry-run'], h.deps)).toBe(0);
      expect(h.driversCreated).toEqual([]);
      expect(h.records).toEqual([]);
      expect(h.printed.join('\n')).toContain('Dry run: nothing was sent.');
    });
  });

  it('the baseline naming the measured checkout is a usage error', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BRANCH_ROOT, '--out', 'rec.md'], h.deps)).toBe(2);
    expect(h.driversCreated).toEqual([]);
  });

  // FW-4 (code review R1 ADV-9): Windows paths are case-insensitive, so
  // `w:/x` against `W:\X` is the same checkout - compared with itself it
  // measures only noise and nearly always passes.
  it('on win32, a baseline naming the measured checkout in another letter case is a usage error', async () => {
    const h = harness((id) => defaultCorrect(id));
    h.deps.platform = 'win32';
    expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BRANCH_ROOT.toUpperCase(), '--out', 'rec.md'], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--baseline names the same checkout as the measured side/);
    expect(h.driversCreated).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it('canonicalRoot folds case on win32 only', () => {
    expect(canonicalRoot('W:/probe-test/Branch', 'win32')).toBe(canonicalRoot('w:/PROBE-TEST/branch', 'win32'));
    expect(canonicalRoot('/probe-test/Branch', 'linux')).not.toBe(canonicalRoot('/probe-test/branch', 'linux'));
  });

  it('a dry run calls nothing and writes nothing', async () => {
    const h = harness(() => ok({}), {});
    expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BASELINE_ROOT, '--dry-run'], h.deps)).toBe(0);
    expect(h.driversCreated).toEqual([]);
    expect(h.records).toEqual([]);
  });

  // FW-3 (code review R1 ADV-3): a one-case re-run that passes on noise must
  // never append a section that reads as the gate's latest PASS.
  it('--case runs one case on each side and marks the section PARTIAL - heading, verdict and console', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main([...CMP, '--case', 'states-voucher'], h.deps)).toBe(0);
    expect(h.inputs).toHaveLength(GATE_RUNS * 2);
    const text = h.records[0]!.text;
    expect(text.split('\n')[0]).toBe('## Default suite, branch vs baseline - 2026-10-27T12:00:00.000Z (PARTIAL: one case, not a gate run)');
    expect(text).toContain('- Verdict: PASS (after 1 attempt(s)) - PARTIAL (one case, not a gate run; it never counts)');
    expect(h.printed.join('\n')).toContain('PARTIAL - one case (--case states-voucher), not a gate run');
  });

  it('a full comparison is not PARTIAL', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(CMP, h.deps)).toBe(0);
    expect(h.records[0]!.text).not.toContain('PARTIAL');
    expect(h.printed.join('\n')).not.toContain('PARTIAL');
  });

  it('the record file header says a PARTIAL section never counts', () => {
    expect(RECORD_FILE_HEADER).toContain('a PARTIAL section (one --case) never counts');
  });
});
