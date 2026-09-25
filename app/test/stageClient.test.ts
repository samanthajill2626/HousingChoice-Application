// The shared --env stage resolver for the share-skip-fix ops scripts. The
// guard MUST bind to the client the script writes through (spec D2 "Target
// safety"): a wrong-account identity refuses BEFORE any client is built, and
// `local` never consults AWS at all. DynamoDB Local without -sharedDb keeps
// ONE DATABASE PER ACCESS KEY (e2e/support/lane.mjs:150-168), so a lane is
// selected by its key `hclane<L>` as much as by its prefix - a prefix alone
// would read (and write) the wrong database.
import { describe, expect, it } from 'vitest';
// The harness's own key format: app/tsconfig.test.json includes ../e2e/support
// with allowJs (app/test/dynamoKeyLedger.test.ts imports the same module
// statically).
import { laneAccessKeyId as harnessLaneAccessKeyId } from '../../e2e/support/lane.mjs';
import { laneAccessKeyId, parseLane, parseStageArgs, resolveStageClient } from '../scripts/lib/stageClient.js';

describe('resolveStageClient', () => {
  it('laneAccessKeyId matches the e2e harness format for every lane (a drift here reads an EMPTY database)', () => {
    for (const lane of [1, 2, 3, 12]) expect(laneAccessKeyId(lane)).toBe(harnessLaneAccessKeyId(lane));
  });

  it('local (no lane): DynamoDB Local, key local, hc-local- prefix - the live local dev stack; no account guard call', async () => {
    let guardCalls = 0;
    const stage = await resolveStageClient('local', {
      assertAccount: async () => {
        guardCalls += 1;
        return { Account: '938565869261' };
      },
    });
    expect(stage.endpoint).toBe('http://localhost:8000');
    expect(stage.prefix).toBe('hc-local-');
    expect(stage.accessKeyId).toBe('local');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-');
    expect(guardCalls).toBe(0);
    stage.doc.destroy();
  });

  it('local --lane L: the lane prefix AND the lane access key, together (never one without the other)', async () => {
    const stage = await resolveStageClient('local', {}, { lane: 3 });
    expect(stage.prefix).toBe('hc-local-3-');
    expect(stage.accessKeyId).toBe('hclane3');
    expect(stage.env.TABLE_PREFIX).toBe('hc-local-3-');
    expect(stage.env.AWS_ACCESS_KEY_ID).toBe('hclane3');
    stage.doc.destroy();
  });

  it('parseLane: a positive integer only (lane 0 is the live stack and has no key of its own)', () => {
    expect(parseLane('3')).toBe(3);
    expect(parseLane('0')).toBeUndefined();
    expect(parseLane('-1')).toBeUndefined();
    expect(parseLane('x')).toBeUndefined();
    expect(parseLane(undefined)).toBeUndefined();
  });

  it('dev/prod: REFUSE a lane before any AWS call (the stage alone picks real tables)', async () => {
    let guardCalls = 0;
    await expect(
      resolveStageClient('dev', { assertAccount: async () => { guardCalls += 1; return { Account: '938565869261' }; } }, { lane: 3 }),
    ).rejects.toThrow(/--lane/);
    expect(guardCalls).toBe(0);
  });

  it('prod: REFUSES when the profile resolves to any account but 938565869261', async () => {
    await expect(
      resolveStageClient('prod', {
        assertAccount: async () => ({ Account: '000000000000', Arn: 'arn:aws:iam::000000000000:user/x' }),
      }),
    ).rejects.toThrow(/ACCOUNT GUARD/);
  });

  it('dev: builds the client from the injected profile credentials after the guard passes', async () => {
    let credentialCalls = 0;
    const stage = await resolveStageClient('dev', {
      assertAccount: async () => ({ Account: '938565869261', Arn: 'arn:aws:iam::938565869261:user/housingchoice' }),
      credentials: () => {
        credentialCalls += 1;
        return async () => ({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' });
      },
    });
    expect(stage.prefix).toBe('hc-dev-');
    expect(stage.endpoint).toBeUndefined();
    expect(stage.accessKeyId).toBeUndefined();
    expect(credentialCalls).toBe(1);
    stage.doc.destroy();
  });
});

describe('parseStageArgs', () => {
  // The only code between the flags the operator types and a live write. An
  // unknown or malformed argument is a USAGE refusal, never ignored: a typo
  // must never turn a rehearsal into an apply, nor the reverse.
  const FIX_SCRIPT = { values: ['--conversation'], flags: ['--apply', '--include-breaker-tripped'] };

  function parsedOk(argv: string[], known: { values: string[]; flags: string[] } = FIX_SCRIPT) {
    const out = parseStageArgs(argv, known);
    if ('usage' in out) throw new Error(`expected a parse, got a usage refusal for: ${argv.join(' ')}`);
    return out;
  }

  it('--env dev --apply sets the apply flag; --env dev alone leaves it unset (dry run is the default)', () => {
    const applied = parsedOk(['--env', 'dev', '--apply'], { values: [], flags: ['--apply'] });
    expect(applied.target).toBe('dev');
    expect(applied.lane).toBeUndefined();
    expect(applied.flags.has('--apply')).toBe(true);
    const dry = parsedOk(['--env', 'dev'], { values: [], flags: ['--apply'] });
    expect(dry.flags.has('--apply')).toBe(false);
  });

  it('captures a value argument: --conversation <id>, and --lane <L> as a number', () => {
    const single = parsedOk(['--env', 'prod', '--apply', '--conversation', 'c-123']);
    expect(single.target).toBe('prod');
    expect(single.values.get('--conversation')).toBe('c-123');
    expect(single.flags.has('--apply')).toBe(true);
    expect(single.flags.has('--include-breaker-tripped')).toBe(false);
    const lane = parsedOk(['--env', 'local', '--lane', '3']);
    expect(lane.target).toBe('local');
    expect(lane.lane).toBe(3);
  });

  it.each<{ label: string; argv: string[] }>([
    { label: '--dry-run (an unknown flag here: dry run is the default)', argv: ['--env', 'dev', '--dry-run'] },
    { label: '--env=dev (the = form is not parsed)', argv: ['--env=dev'] },
    { label: 'a missing --env', argv: ['--apply'] },
    { label: 'no arguments at all', argv: [] },
    { label: 'a value flag with no value (--env at the end)', argv: ['--env'] },
    { label: 'a value flag followed by another flag', argv: ['--env', '--apply'] },
    { label: 'a --conversation with no id', argv: ['--env', 'dev', '--apply', '--conversation'] },
    { label: '--lane 0 (the live stack, not a lane)', argv: ['--env', 'local', '--lane', '0'] },
    { label: '--lane x', argv: ['--env', 'local', '--lane', 'x'] },
    { label: 'an unknown flag (a typo of --apply)', argv: ['--env', 'dev', '--aply'] },
    { label: 'an unknown --env target', argv: ['--env', 'staging'] },
  ])('refuses $label as a usage error', ({ argv }) => {
    expect(parseStageArgs(argv, FIX_SCRIPT)).toEqual({ usage: true });
  });
});
