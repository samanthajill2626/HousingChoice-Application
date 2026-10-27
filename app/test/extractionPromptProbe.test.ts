// extraction-prompt-probe (WP1 B1 spec D7, plan tasks S6.2-S6.5): the CLI's
// argument contract and exit codes, the never-written scoring and record,
// and the default-suite comparison against a baseline - all through a STUB
// driver. No test here reaches the network, constructs the anthropic driver
// or reads ANTHROPIC_API_KEY from process.env (WI16): every key below is a
// fake string handed in through the injected env.
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
  keyTail,
  main,
  parseProbeArgs,
  type BaseModules,
  type BranchModules,
  type ProbeCliDeps,
} from '../scripts/extraction-prompt-probe.js';

const base: BaseModules = { extraction, prompt, orgList, starting, logger, sentBlock };
const branch: BranchModules = { ...base, sentBlock, apply, label, inputs, config };
const KEY = 'sk-test-not-a-real-key-wxyz';
const BRANCH_ROOT = 'W:/probe-test/branch';

function ok(result: Partial<ExtractionResult>): ExtractionCall {
  return {
    ok: true,
    meta: { driver: 'fake', usage: { inputTokens: 1000, outputTokens: 100 } },
    result: { fields: {}, ...result },
  };
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
