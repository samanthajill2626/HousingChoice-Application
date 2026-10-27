// extraction-prompt-probe (WP1 B1 spec D7, plan tasks S6.2-S6.5): the CLI's
// argument contract and exit codes, the never-written scoring and record,
// and the default-suite comparison against a baseline - all through a STUB
// driver. No test here reaches the network, constructs the anthropic driver
// or reads ANTHROPIC_API_KEY from process.env (WI16): every key below is a
// fake string handed in through the injected env.
import { createHash } from 'node:crypto';
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
  compareDefaultSuites,
  keyTail,
  main,
  parseProbeArgs,
  type BaseModules,
  type BranchModules,
  type ProbeCliDeps,
  type SideScore,
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

/** nth = how many calls this side already made for this case (0-based). */
type Answer = (caseId: string, nth: number, root: string) => ExtractionCall;

interface Harness {
  deps: Partial<ProbeCliDeps>;
  printed: string[];
  errors: string[];
  records: Array<{ file: string; text: string }>;
  inputs: ExtractionInput[];
  driversCreated: string[];
}

function harness(answer: Answer, env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: KEY }): Harness {
  const h: Harness = { deps: {}, printed: [], errors: [], records: [], inputs: [], driversCreated: [] };
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
          const key = `${opts.root}|${id}`;
          const nth = counts.get(key) ?? 0;
          counts.set(key, nth + 1);
          return answer(id, nth, opts.root);
        },
      };
      return driver;
    },
    gitInfo: (root) => ({ commit: (root.endsWith('main') ? 'b' : 'a').repeat(40), dirty: false }),
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
    await main(['--model', 'claude-sonnet-5-5', '--runs', '1'], h.deps);
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
    const c = { ...caseById('control-plain-fact'), profile: { notes: 'Works nights downtown' } };
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
    const gradedControls = NEVER_WRITTEN_CASES.filter((x) => x.role === 'control' && x.expect.kind !== 'no-address-op').length;
    expect(h.graderRequests.filter((r) => r.user.startsWith('PLANTED FACT: none\n'))).toHaveLength(gradedControls * GATE_RUNS);
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

function side(okByCase: Record<string, number>, truncations = 0): SideScore {
  const totalOk = Object.values(okByCase).reduce((n, x) => n + x, 0);
  return { okByCase, totalOk, truncations, totals: { ok: totalOk, missed: 0, wrong: 0, failed: truncations }, inputTokens: 0, outputTokens: 0 };
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

const CMP = ['--model', 'claude-sonnet-5-5', '--baseline', BASELINE_ROOT, '--out', 'rec.md'];
const isBaseline = (root: string) => root.endsWith('main');

describe('main --baseline', () => {
  it('runs every default case 3 times on each side, interleaved, and passes (exit 0)', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(CMP, h.deps)).toBe(0);
    expect(h.driversCreated).toHaveLength(2);
    expect(h.inputs).toHaveLength(DEFAULT_CASES.length * GATE_RUNS * 2);
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

  it('the baseline naming the measured checkout is a usage error', async () => {
    const h = harness((id) => defaultCorrect(id));
    expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BRANCH_ROOT, '--out', 'rec.md'], h.deps)).toBe(2);
    expect(h.driversCreated).toEqual([]);
  });

  it('a dry run calls nothing and writes nothing', async () => {
    const h = harness(() => ok({}), {});
    expect(await main(['--model', 'claude-sonnet-5-5', '--baseline', BASELINE_ROOT, '--dry-run'], h.deps)).toBe(0);
    expect(h.driversCreated).toEqual([]);
    expect(h.records).toEqual([]);
  });
});
