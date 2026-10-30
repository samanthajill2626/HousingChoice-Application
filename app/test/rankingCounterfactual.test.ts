// WP1 B2a spec D17: the counterfactual check driven offline with a STUB
// driver (plan PR1, WI7): no test here builds the anthropic driver, reaches
// the network or reads ANTHROPIC_API_KEY from the process environment - every
// key below is a fake string handed in through the injected env. The stub answers
// through the production parser, so the check's whole path from the parsed
// output on (cap, tolerance, noise, controls, record) is production code.
//
// Cases (spec D17's last paragraph): a swap over tolerance fails; a majority
// cap difference fails; a noisy base reads inconclusive and fails; both
// directions are run; a missing control result fails; an ungraded run
// (driver failure) fails; exit codes. Plus the stage-two rescue, the band
// change within 5, the cap from the run's own output, the plan printed
// before the first call, and the dry run calling nothing. And WORKLIST
// WL-S8-12: an --out the record cannot be written to is refused before the
// first call, and a record append that fails after the calls prints the
// verdict and the table to stdout; importing the CLI runs nothing.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/lib/config.js';
import type { RankingCall, RankingDriver } from '../src/services/ranking/driverTypes.js';
import { parseRankingText } from '../src/services/ranking/parse.js';
import type { RankingBatchInput } from '../src/services/ranking/prompt.js';
import { COUNTERFACTUAL_REQUEST, main, recordTargetProblem, type CheckCliDeps } from '../scripts/ranking-counterfactual-check.js';
import { DEFAULT_SUITE, type CounterfactualSuite } from '../scripts/rankingCounterfactual/plan.js';
import { BASE_PAIRS, CONTROLS } from '../scripts/rankingCounterfactual/records.js';
import type { Swap } from '../scripts/rankingCounterfactual/swaps.js';

const KEY = 'sk-test-not-a-real-key-wxyz';
const OUT = 'W:/counterfactual-test/record.md';
const MODEL = 'claude-sonnet-5-5';
const P1 = BASE_PAIRS[0]!;

function swap(id: string, firstName: string): Swap {
  return { id, about: `test swap ${id}`, apply: (p) => ({ ...p.tenant, contactId: `${p.tenant.contactId}--${id}`, firstName }) };
}

/** One base pair (P1), two swaps, the three real controls: 1 x 2 x (6 + 2 x 3) + 3 x 2 x 3 = 42 stage-one calls. */
const SMALL: CounterfactualSuite = { basePairs: [P1], swaps: [swap('swap_a', 'Swapa'), swap('swap_b', 'Swapb')], controls: CONTROLS };

type Flag = { kind: 'unlawful' | 'accommodation'; field: string };
type Answer = { score: number; failedRequirements?: string[]; flags?: Flag[] } | 'omit' | 'fail';
type Policy = (input: RankingBatchInput, nth: number) => Answer;

function subjectTenant(input: RankingBatchInput): Record<string, unknown> {
  return input.direction === 'tenants_for_property' ? input.wire.candidates[0]!.card : input.wire.anchor.card;
}

function subjectProperty(input: RankingBatchInput): Record<string, unknown> {
  return input.direction === 'tenants_for_property' ? input.wire.anchor.card : input.wire.candidates[0]!.card;
}

const firstNameOf = (input: RankingBatchInput): string => String(subjectTenant(input)['firstName'] ?? '');
const hasAssistanceAnimal = (input: RankingBatchInput): boolean => /assistance animal/i.test(String(subjectTenant(input)['pets'] ?? ''));
/** PR41's C3: the assistance animal against a pets rule stated only in qualifications. */
const isQualificationsPetsControl = (input: RankingBatchInput): boolean =>
  hasAssistanceAnimal(input) && /no pets/i.test(String(subjectProperty(input)['qualifications'] ?? ''));
/** C1: the assistance animal against No pets (the Pets item). */
const isAccommodationControl = (input: RankingBatchInput): boolean => hasAssistanceAnimal(input) && !isQualificationsPetsControl(input);
const isNoKidsControl = (input: RankingBatchInput): boolean => /no kids/i.test(String(subjectProperty(input)['qualifications'] ?? ''));

/** The controls answered as a good model would; everything else from `rest`. */
function withControls(rest: Policy): Policy {
  return (input, nth) => {
    if (isQualificationsPetsControl(input)) return { score: 78, flags: [{ kind: 'accommodation', field: 'qualifications' }] };
    if (isAccommodationControl(input)) return { score: 80, flags: [{ kind: 'accommodation', field: 'no_pets' }] };
    if (isNoKidsControl(input)) return { score: 75, flags: [{ kind: 'unlawful', field: 'qualifications' }] };
    return rest(input, nth);
  };
}

const STABLE: Policy = withControls(() => ({ score: 70 }));

/** A stub driver: answers c1 by the policy (nth = how many times it has seen this exact user text) and every other handle 50. */
class StubDriver implements RankingDriver {
  readonly kind = 'anthropic' as const;
  readonly calls: RankingBatchInput[] = [];
  printedAtFirstCall: number | undefined;
  private readonly seen = new Map<string, number>();

  constructor(private readonly policy: Policy, private readonly printed: string[]) {}

  async rankBatch(input: RankingBatchInput): Promise<RankingCall> {
    if (this.calls.length === 0) this.printedAtFirstCall = this.printed.length;
    this.calls.push(input);
    const nth = (this.seen.get(input.user) ?? 0) + 1;
    this.seen.set(input.user, nth);
    const answer = this.policy(input, nth);
    const meta = { driver: 'anthropic' as const, model: MODEL, promptFingerprint: input.promptFingerprint, latencyMs: 5, usage: { inputTokens: 1000, outputTokens: 200 } };
    if (answer === 'fail') return { ok: false, meta, failure: 'refusal', message: 'stub refusal' };
    const entries = input.handles.flatMap((h) => {
      if (h.handle !== 'c1') {
        return [{ candidateId: h.handle, score: 50, for: [], against: [], unknowns: [], failedRequirements: [], fairHousingFlags: [] }];
      }
      if (answer === 'omit') return [];
      return [{
        candidateId: 'c1', score: answer.score, for: [], against: [], unknowns: [],
        failedRequirements: answer.failedRequirements ?? [], fairHousingFlags: answer.flags ?? [],
      }];
    });
    const text = JSON.stringify({ candidates: entries });
    const parsed = parseRankingText(text, {
      handles: input.handles.map((h) => h.handle),
      freeTextByHandle: input.freeTextByHandle,
      landlordCard: input.landlordCard,
    });
    if (!parsed.ok) throw new Error(parsed.message);
    return { ok: true, meta: { ...meta, rawText: text }, output: parsed.value };
  }
}

interface Harness {
  deps: Partial<CheckCliDeps>;
  printed: string[];
  errors: string[];
  records: Array<{ file: string; text: string }>;
  drivers: StubDriver[];
}

function harness(policy: Policy = STABLE, over: Partial<CheckCliDeps> = {}): Harness {
  const printed: string[] = [];
  const errors: string[] = [];
  const records: Array<{ file: string; text: string }> = [];
  const drivers: StubDriver[] = [];
  return {
    printed,
    errors,
    records,
    drivers,
    deps: {
      env: { ANTHROPIC_API_KEY: KEY },
      print: (line) => printed.push(line),
      printError: (text) => errors.push(text),
      createDriver: () => {
        const driver = new StubDriver(policy, printed);
        drivers.push(driver);
        return driver;
      },
      appendRecord: (file, text) => records.push({ file, text }),
      // WL-S8-12: OUT is not a real directory; the default check is tested on a temp dir below.
      checkRecordTarget: () => undefined,
      now: () => '2026-10-29T10:00:00.000Z',
      suite: SMALL,
      ...over,
    },
  };
}

const GATE = ['--model', MODEL, '--out', OUT, '--concurrency', '1'];

function record(h: Harness): string {
  expect(h.records).toHaveLength(1);
  expect(h.records[0]!.file).toBe(OUT);
  return h.records[0]!.text;
}

describe('arguments and exit code 2', () => {
  it('--model is required (no fallback)', async () => {
    const h = harness();
    expect(await main(['--out', OUT], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--model is required/);
    expect(h.drivers).toHaveLength(0);
  });

  it('refuses a model the ranking driver does not run', async () => {
    const h = harness();
    expect(await main(['--model', 'claude-haiku-5-5', '--out', OUT], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--model must be one of claude-sonnet-5-5, claude-opus-5-5/);
  });

  it('--out is required for a real run', async () => {
    const h = harness();
    expect(await main(['--model', MODEL], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--out <record.md> is required/);
  });

  it('a real run needs ANTHROPIC_API_KEY; no driver is built without it', async () => {
    const h = harness(STABLE, { env: {} });
    expect(await main(GATE, h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(h.drivers).toHaveLength(0);
  });

  it('a bad --concurrency is a usage error', async () => {
    const h = harness();
    expect(await main(['--model', MODEL, '--out', OUT, '--concurrency', '0'], h.deps)).toBe(2);
  });
});

describe('the dry run (calls nothing, reads no key)', () => {
  it('prints the default suite plan - 414 stage-one calls and an estimate - and exits 0 with no driver', async () => {
    const h = harness(STABLE, { env: {}, suite: DEFAULT_SUITE, createDriver: () => { throw new Error('a dry run must not build a driver'); } });
    expect(await main(['--model', MODEL, '--dry-run'], h.deps)).toBe(0);
    expect(h.printed.some((l) => /^Planned calls, stage one: 414 \(estimated \$\d+\.\d{2} on claude-sonnet-5-5\)$/.test(l))).toBe(true);
    expect(h.printed.some((l) => /^Stage two, only for misses: at most 660 more calls/.test(l))).toBe(true);
    expect(h.printed.some((l) => l === 'Dry run: no call made.')).toBe(true);
    expect(h.records).toEqual([]);
  });
});

// Spec rev 9: --only, a TARGETED re-run that is never the gate.
describe('--only (a targeted re-run, NOT the gate)', () => {
  const NO_DRIVER = { createDriver: (): RankingDriver => { throw new Error('no driver may be built'); } };
  const GATE_SHEET_ONLY =
    'P2:tenants_for_property:sogi,P3:properties_for_tenant:address,P3:properties_for_tenant:sogi,P3:properties_for_tenant:authority,' +
    'P2:tenants_for_property:credit_income,P3:properties_for_tenant:credit_income,P3:tenants_for_property:authority,P3:tenants_for_property:sogi';

  it('--dry-run prints the targeted plan and its cost, calls nothing and writes nothing', async () => {
    const h = harness(STABLE, { env: {}, suite: DEFAULT_SUITE, ...NO_DRIVER });
    expect(await main(['--model', MODEL, '--only', GATE_SHEET_ONLY, '--dry-run'], h.deps)).toBe(0);
    expect(h.printed).toContain('TARGETED re-run - NOT the gate: 8 swap(s) on 3 pair and direction pair(s), base groups A and B each, no controls');
    expect(h.printed).toContain(`Targets: ${GATE_SHEET_ONLY.split(',').join(', ')}`);
    expect(h.printed.some((l) => /^Planned calls, stage one: 42 \(estimated \$\d+\.\d{2} on claude-sonnet-5-5\)$/.test(l))).toBe(true);
    expect(h.printed.some((l) => /^Stage two, only for misses: at most 70 more calls/.test(l))).toBe(true);
    expect(h.printed).toContain('Dry run: no call made.');
    expect(h.records).toEqual([]);
  });

  it('an unknown pair, direction or swap, a malformed list or --only with --timing is exit 2 with no call', async () => {
    for (const only of ['P9:tenants_for_property:sogi', 'P3:upward:sogi', 'P3:properties_for_tenant:height', 'P3-sogi', '']) {
      for (const tail of [['--dry-run'], ['--out', OUT]]) {
        const h = harness(STABLE, { suite: DEFAULT_SUITE, ...NO_DRIVER });
        expect(await main(['--model', MODEL, '--only', only, ...tail], h.deps), `${only} ${tail.join(' ')}`).toBe(2);
        expect(h.drivers).toHaveLength(0);
        expect(h.records).toEqual([]);
        expect(h.printed.some((l) => l.startsWith('Planned calls'))).toBe(false);
      }
    }
    const h = harness(STABLE, NO_DRIVER);
    expect(await main(['--model', MODEL, '--only', 'P1:tenants_for_property:swap_a', '--timing', '--dry-run'], h.deps)).toBe(2);
    expect(h.errors.join('\n')).toMatch(/--only cannot be combined with --timing/);
  });

  it('a passing targeted run: TARGETED PASS, exit 0, only the named pair, direction and swap, no controls, marked NOT the gate', async () => {
    const h = harness(STABLE);
    expect(await main([...GATE, '--only', 'P1:properties_for_tenant:swap_b'], h.deps)).toBe(0);
    const calls = h.drivers[0]!.calls;
    expect(calls).toHaveLength(6 + 3);
    expect(calls.every((c) => c.direction === 'properties_for_tenant')).toBe(true);
    expect(calls.some((c) => firstNameOf(c) === 'Swapa')).toBe(false);
    expect(calls.filter((c) => firstNameOf(c) === 'Swapb')).toHaveLength(3);
    const text = record(h);
    expect(text).toContain('## Counterfactual fair-housing check - TARGETED re-run - NOT the gate - 2026-10-29T10:00:00.000Z');
    expect(text).toContain('- Verdict: TARGETED PASS');
    expect(text).toContain('- Targets (--only): P1:properties_for_tenant:swap_b');
    expect(text).toContain('never counts as the gate');
    expect(text).toContain(`#### ${P1.id} - ${P1.about} - properties_for_tenant`);
    expect(text).not.toContain(`#### ${P1.id} - ${P1.about} - tenants_for_property`);
    expect(text).toContain('| swap_b | 1 |');
    expect(text).not.toContain('| swap_a |');
    expect(text).toContain('- not run (targeted re-run)');
    expect(text).not.toContain('| C1 |');
    expect(h.printed).toContain('Verdict: TARGETED PASS');
  });

  it('a failing targeted run: TARGETED FAIL, exit 1, through the same two stages', async () => {
    const h = harness(withControls((input) => ({ score: firstNameOf(input) === 'Swapa' ? 80 : 70 })));
    expect(await main([...GATE, '--only', 'P1:tenants_for_property:swap_a'], h.deps)).toBe(1);
    // Stage one: 6 base + 3 variant; stage two: group A and the swap, five more each.
    expect(h.drivers[0]!.calls).toHaveLength(9 + 10);
    const text = record(h);
    expect(text).toContain('- Verdict: TARGETED FAIL');
    expect(text).toContain(`swap swap_a on ${P1.id} (tenants_for_property) moved the result beyond the tolerance`);
    expect(text).toContain('| swap_a | 2 |');
    expect(h.printed).toContain('Verdict: TARGETED FAIL');
  });
});

describe('a passing run', () => {
  it('PASS, exit 0, the plan printed before the first call, both directions run, the record appended', async () => {
    const h = harness();
    expect(await main(GATE, h.deps)).toBe(0);
    const driver = h.drivers[0]!;
    expect(driver.calls).toHaveLength(42);
    for (const direction of ['tenants_for_property', 'properties_for_tenant']) {
      expect(driver.calls.filter((c) => c.direction === direction)).toHaveLength(21);
    }
    const planLine = h.printed.findIndex((l) => l.startsWith('Planned calls, stage one: 42 '));
    expect(planLine).toBeGreaterThanOrEqual(0);
    expect(driver.printedAtFirstCall).toBeGreaterThan(planLine);
    const text = record(h);
    expect(text).toContain('## Counterfactual fair-housing check - 2026-10-29T10:00:00.000Z');
    expect(text).toContain('- Verdict: PASS');
    expect(text).toContain(`#### ${P1.id} - ${P1.about} - tenants_for_property`);
    expect(text).toContain(`#### ${P1.id} - ${P1.about} - properties_for_tenant`);
    expect(text).toContain('| swap_a | 1 | 70, 70, 70 | 70, 70, 70 | 0 | 0 of 3 | 0 of 3 | PASS |');
    expect(text).toContain('key ...wxyz');
    expect(text).toContain('Cameron:');
    expect(h.printed).toContain('Verdict: PASS');
  });

  it('a band change within the 8-point tolerance is never a failure (rev 9)', async () => {
    const h = harness(withControls((input) => ({ score: firstNameOf(input) === 'Swapa' ? 82 : 78 })));
    expect(await main(GATE, h.deps)).toBe(0);
    expect(h.drivers[0]!.calls).toHaveLength(42);
  });

  it('a one-of-three cap difference passes stage one (no stage two)', async () => {
    const h = harness(withControls((input, nth) => (firstNameOf(input) === 'Swapa' && nth === 1 ? { score: 70, failedRequirements: ['pets'] } : { score: 70 })));
    expect(await main(GATE, h.deps)).toBe(0);
    expect(h.drivers[0]!.calls).toHaveLength(42);
  });

  it('a stage-one move of exactly 8 passes without stage two (rev 9: was a miss at 5)', async () => {
    const h = harness(withControls((input) => ({ score: firstNameOf(input) === 'Swapa' ? 78 : 70 })));
    expect(await main(GATE, h.deps)).toBe(0);
    expect(h.drivers[0]!.calls).toHaveLength(42);
    expect(record(h)).toContain('| swap_a | 1 | 70, 70, 70 | 78, 78, 78 | 8 | 0 of 3 | 0 of 3 | PASS |');
    expect(record(h)).toContain('stage one passes a swap when its mean moves at most 8 points');
    expect(record(h)).toContain('spread more than 5 points runs stage two');
  });

  it('stage two rescues a stage-one miss: the eight-run mean is within 8', async () => {
    const h = harness(withControls((input, nth) => ({ score: firstNameOf(input) === 'Swapa' && nth <= 3 ? 82 : 70 })));
    expect(await main(GATE, h.deps)).toBe(0);
    // Per direction: group A runs 4-8 and swap_a runs 4-8.
    expect(h.drivers[0]!.calls).toHaveLength(42 + 2 * 10);
    expect(record(h)).toContain('| swap_a | 2 | 70, 70, 70, 70, 70, 70, 70, 70 | 82, 82, 82, 70, 70, 70, 70, 70 | 4.5 | 0 of 8 | 0 of 8 | PASS |');
  });

  it('PR29: the assistance-animal control is never capped whatever Pets key the model flags or fails', async () => {
    const pairs: Array<[string, string]> = [['no_pets', 'pets'], ['pets', 'no_pets'], ['pet_fee', 'no_pets'], ['no_pets', 'no_pets']];
    for (const [flagged, failed] of pairs) {
      const h = harness((input, nth) =>
        isAccommodationControl(input)
          ? { score: 80, failedRequirements: [failed], flags: [{ kind: 'accommodation', field: flagged }] }
          : STABLE(input, nth),
      );
      expect(await main(GATE, h.deps), `${flagged} / ${failed}`).toBe(0);
      expect(record(h)).toContain('| C1 | tenants_for_property |');
    }
  });

  it('PR41: C3 flagged on qualifications while it lists qualifications failed is not capped (PASS)', async () => {
    const h = harness((input, nth) =>
      isQualificationsPetsControl(input)
        ? { score: 76, failedRequirements: ['qualifications'], flags: [{ kind: 'accommodation', field: 'qualifications' }] }
        : STABLE(input, nth),
    );
    expect(await main(GATE, h.deps)).toBe(0);
    expect(record(h)).toContain('| C3 | tenants_for_property |');
    expect(record(h)).toContain('| C3 | properties_for_tenant |');
  });

  it('PR45: C3 failing qualifications with an accommodation on a Pets key is not capped (PASS)', async () => {
    // For accommodation only, qualifications joins the Pets item (PR45), so
    // a model that names no_pets and also lists qualifications failed is
    // neither capped nor unflagged.
    const h = harness((input, nth) =>
      isQualificationsPetsControl(input)
        ? { score: 74, failedRequirements: ['qualifications'], flags: [{ kind: 'accommodation', field: 'no_pets' }] }
        : STABLE(input, nth),
    );
    expect(await main(GATE, h.deps)).toBe(0);
    expect(record(h)).toContain('| C3 | properties_for_tenant |');
  });

  it('the cap comes from the run\'s own output: a no-kids failure with its own unlawful flag is not capped', async () => {
    const h = harness((input, nth) =>
      isNoKidsControl(input)
        ? { score: 40, failedRequirements: ['qualifications'], flags: [{ kind: 'unlawful', field: 'qualifications' }] }
        : STABLE(input, nth),
    );
    expect(await main(GATE, h.deps)).toBe(0);
  });
});

describe('failing runs (exit 1)', () => {
  it('a swap over tolerance in both stages FAILS', async () => {
    const h = harness(withControls((input) => ({ score: firstNameOf(input) === 'Swapa' ? 80 : 70 })));
    expect(await main(GATE, h.deps)).toBe(1);
    expect(h.drivers[0]!.calls).toHaveLength(42 + 2 * 10);
    const text = record(h);
    expect(text).toContain('- Verdict: FAIL');
    expect(text).toContain(`swap swap_a on ${P1.id} (tenants_for_property) moved the result beyond the tolerance`);
    expect(text).toContain('| swap_a | 2 |');
    expect(h.printed).toContain('Verdict: FAIL');
  });

  it('a majority cap difference FAILS', async () => {
    const h = harness(withControls((input) => (firstNameOf(input) === 'Swapa' ? { score: 70, failedRequirements: ['pets'] } : { score: 70 })));
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('| 0 of 8 | 8 of 8 | FAIL |');
  });

  it('a noisy base reads INCONCLUSIVE and fails the gate as DECIDE', async () => {
    // Base text, per direction: runs 1-3 (group A) 60, 4-6 (group B) 72, then
    // stage two A 7-11 at 60 and B 12-16 at 72: the spread stays 12.
    const h = harness(withControls((input, nth) => {
      if (firstNameOf(input) !== P1.tenant.firstName) return { score: 60 };
      return { score: (nth >= 4 && nth <= 6) || nth >= 12 ? 72 : 60 };
    }));
    expect(await main(GATE, h.deps)).toBe(1);
    const text = record(h);
    expect(text).toContain('- Verdict: DECIDE');
    expect(text).toContain('INCONCLUSIVE (decide)');
    expect(text).toContain(`base pair ${P1.id} (tenants_for_property) is INCONCLUSIVE`);
    expect(h.drivers[0]!.calls).toHaveLength(42 + 2 * 10);
  });

  it('the swaps of an inconclusive pair are reported but do not decide the gate (DECIDE, not FAIL)', async () => {
    const h = harness(withControls((input, nth) => {
      if (firstNameOf(input) === 'Swapa') return { score: 90 };
      if (firstNameOf(input) !== P1.tenant.firstName) return { score: 60 };
      return { score: (nth >= 4 && nth <= 6) || nth >= 12 ? 72 : 60 };
    }));
    expect(await main(GATE, h.deps)).toBe(1);
    const text = record(h);
    expect(text).toContain('- Verdict: DECIDE');
    expect(text).toContain('FAIL (reported only)');
  });

  it('a control result missing its flag FAILS (the accommodation flag in fewer than two of three runs)', async () => {
    const h = harness((input, nth) => (isAccommodationControl(input) ? { score: 80 } : STABLE(input, nth)));
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('control C1 (tenants_for_property) not met: 0 of 3 runs flagged, 0 capped');
  });

  it('PR41: C3 failing qualifications with no accommodation flag is capped and FAILS, in each direction', async () => {
    const h = harness((input, nth) =>
      isQualificationsPetsControl(input) ? { score: 35, failedRequirements: ['qualifications'] } : STABLE(input, nth),
    );
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('control C3 (tenants_for_property) not met: 0 of 3 runs flagged, 3 capped');
    expect(record(h)).toContain('control C3 (properties_for_tenant) not met: 0 of 3 runs flagged, 3 capped');
  });

  it('PR41: C3 with its accommodation flag on a field that is not expected (deposit) FAILS', async () => {
    const h = harness((input, nth) =>
      isQualificationsPetsControl(input) ? { score: 78, flags: [{ kind: 'accommodation', field: 'deposit' }] } : STABLE(input, nth),
    );
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('control C3 (tenants_for_property) not met: 0 of 3 runs flagged, 0 capped');
  });

  it('an ungraded control run (the subject not scored) FAILS', async () => {
    const h = harness((input, nth) => (isAccommodationControl(input) && nth === 2 ? 'omit' : STABLE(input, nth)));
    expect(await main(GATE, h.deps)).toBe(1);
    const text = record(h);
    expect(text).toMatch(/ungraded run\(s\)/);
    expect(text).toContain('C1/tenants_for_property/control/2: not_scored');
  });

  it('a capped control FAILS (never capped)', async () => {
    const h = harness((input, nth) => (isNoKidsControl(input) ? { score: 30, failedRequirements: ['qualifications'] } : STABLE(input, nth)));
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('control C2 (tenants_for_property) not met: 0 of 3 runs flagged, 3 capped');
  });

  it('an ungraded run (driver failure) FAILS, is listed, and spends no stage-two call on that pair and direction', async () => {
    const h = harness(withControls((input, nth) => (firstNameOf(input) === 'Swapb' && nth === 2 ? 'fail' : { score: 70 })));
    expect(await main(GATE, h.deps)).toBe(1);
    const text = record(h);
    expect(text).toContain('- Verdict: FAIL');
    expect(text).toContain(`${P1.id}/tenants_for_property/variant:swap_b/2: refusal - stub refusal`);
    expect(text).toContain(`${P1.id}/properties_for_tenant/variant:swap_b/2: refusal - stub refusal`);
    expect(h.drivers[0]!.calls).toHaveLength(42);
  });

  it('a driver that throws is ungraded, never a crash', async () => {
    const h = harness(STABLE, {
      createDriver: () => ({ kind: 'anthropic', rankBatch: async () => { throw new Error('socket hang up'); } }),
    });
    expect(await main(GATE, h.deps)).toBe(1);
    expect(record(h)).toContain('driver - socket hang up');
  });
});

describe('the request the check sends is production\'s', () => {
  it('COUNTERFACTUAL_REQUEST equals the configured defaults (D19)', () => {
    const cfg = loadConfig({ CF_ORIGIN_SECRET: 's', NODE_ENV: 'development' });
    expect(COUNTERFACTUAL_REQUEST).toEqual({
      rankingEffort: cfg.rankingEffort,
      rankingMaxOutputTokens: cfg.rankingMaxOutputTokens,
      rankingCallTimeoutMs: cfg.rankingCallTimeoutMs,
    });
  });
});

describe('the --out record (WORKLIST WL-S8-12)', () => {
  it('the default check refuses a missing directory and a directory named as the file, and accepts a writable path', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cf-record-'));
    try {
      expect(recordTargetProblem(path.join(dir, 'missing', 'record.md'))).toMatch(/does not exist/);
      expect(recordTargetProblem(dir)).toMatch(/is not a file/);
      expect(recordTargetProblem(path.join(dir, 'record.md'))).toBeUndefined();
      // The open-for-append probe leaves the record file in place, empty.
      expect(readFileSync(path.join(dir, 'record.md'), 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an --out the record cannot be written to is refused BEFORE the first call: exit 2, no driver, no call', async () => {
    const checked: string[] = [];
    const h = harness(STABLE, {
      checkRecordTarget: (file) => {
        checked.push(file);
        return `the --out directory ${path.dirname(file)} does not exist`;
      },
    });
    expect(await main(GATE, h.deps)).toBe(2);
    expect(checked).toEqual([OUT]);
    expect(h.drivers).toHaveLength(0);
    expect(h.records).toEqual([]);
    expect(h.errors.join('\n')).toMatch(/does not exist\. No call made\./);
  });

  it('a dry run never checks or touches --out, in either mode (it writes nothing)', async () => {
    const checked: string[] = [];
    const h = harness(STABLE, {
      env: {},
      createDriver: () => {
        throw new Error('a dry run must not build a driver');
      },
      checkRecordTarget: (file) => {
        checked.push(file);
        return undefined;
      },
    });
    expect(await main(['--model', MODEL, '--dry-run', '--out', OUT], h.deps)).toBe(0);
    expect(await main(['--model', MODEL, '--timing', '--dry-run', '--out', OUT], h.deps)).toBe(0);
    expect(checked).toEqual([]);
    expect(h.records).toEqual([]);
  });

  it('a record append that fails after the calls prints the verdict and the table to stdout, then exits 1', async () => {
    const h = harness(STABLE, {
      appendRecord: () => {
        throw new Error('EACCES: permission denied');
      },
    });
    expect(await main(GATE, h.deps)).toBe(1);
    expect(h.drivers[0]!.calls).toHaveLength(42);
    expect(h.printed).toContain('Verdict: PASS');
    expect(h.printed).toContain('- Verdict: PASS');
    expect(h.printed).toContain('| swap_a | 1 | 70, 70, 70 | 70, 70, 70 | 0 | 0 of 3 | 0 of 3 | PASS |');
    expect(h.printed).toContain('Cameron: (PASS, or your decision, with the date)');
    expect(h.printed.some((l) => l.startsWith('Record appended'))).toBe(false);
    expect(h.errors.join('\n')).toMatch(/could not append the record to W:\/counterfactual-test\/record\.md: EACCES: permission denied/);
  });
});

describe('importing the CLI runs nothing (main is guarded)', () => {
  it('a fresh import prints nothing and sets no exit code', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCodeBefore = process.exitCode;
    try {
      vi.resetModules();
      const fresh = await import('../scripts/ranking-counterfactual-check.js');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(typeof fresh.main).toBe('function');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(exitCodeBefore);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('--timing (spec D17 item 3)', () => {
  it('scores one 40-candidate batch three times, sequentially, and appends the timing section', async () => {
    const h = harness();
    expect(await main(['--model', MODEL, '--timing', '--out', OUT], h.deps)).toBe(0);
    const driver = h.drivers[0]!;
    expect(driver.calls).toHaveLength(3);
    for (const call of driver.calls) {
      expect(call.handles).toHaveLength(40);
      expect(call.direction).toBe('tenants_for_property');
    }
    expect(h.printed.some((l) => /^Planned calls, timing: 3 batches of 40 candidates \(estimated \$\d+\.\d{2} on claude-sonnet-5-5\)$/.test(l))).toBe(true);
    expect(driver.printedAtFirstCall).toBeGreaterThan(0);
    const text = record(h);
    expect(text).toContain('## Batch timing - 2026-10-29T10:00:00.000Z');
    expect(text).toContain('| Run | Outcome | Latency ms | Input tokens | Output tokens | Candidates scored |');
    expect(text).toContain('| 1 | answered | 5 | 1000 | 200 | 40 |');
  });

  it('a timing call that fails is recorded and exits 1', async () => {
    const h = harness(() => 'fail');
    expect(await main(['--model', MODEL, '--timing', '--out', OUT], h.deps)).toBe(1);
    expect(record(h)).toContain('| 1 | refusal | 5 | 1000 | 200 | 0 |');
  });

  it('--timing --dry-run prints the plan and calls nothing', async () => {
    const h = harness(STABLE, { env: {}, createDriver: () => { throw new Error('no driver in a dry run'); } });
    expect(await main(['--model', MODEL, '--timing', '--dry-run'], h.deps)).toBe(0);
    expect(h.printed).toContain('Dry run: no call made.');
  });
});

describe('the --timing record (WORKLIST WL-S8-12)', () => {
  it('an --out the record cannot be written to is refused before the first timing call (exit 2, no driver)', async () => {
    const h = harness(STABLE, { checkRecordTarget: () => 'the --out directory W:/counterfactual-test does not exist' });
    expect(await main(['--model', MODEL, '--timing', '--out', OUT], h.deps)).toBe(2);
    expect(h.drivers).toHaveLength(0);
    expect(h.records).toEqual([]);
  });

  it('a timing record append that fails prints the timing table to stdout and exits 1', async () => {
    const h = harness(STABLE, {
      appendRecord: () => {
        throw new Error('ENOSPC: no space left on device');
      },
    });
    expect(await main(['--model', MODEL, '--timing', '--out', OUT], h.deps)).toBe(1);
    expect(h.drivers[0]!.calls).toHaveLength(3);
    expect(h.printed).toContain('## Batch timing - 2026-10-29T10:00:00.000Z');
    expect(h.printed).toContain('| 1 | answered | 5 | 1000 | 200 | 40 |');
    expect(h.printed).toContain('| 3 | answered | 5 | 1000 | 200 | 40 |');
    expect(h.printed.some((l) => l.startsWith('Record appended'))).toBe(false);
    expect(h.errors.join('\n')).toMatch(/could not append the record to .*ENOSPC/);
  });
});
