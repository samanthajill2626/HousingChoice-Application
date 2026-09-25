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
    // The client the script writes through signs with THAT identity - not one
    // it built beside it (e.g. from the machine's default chain).
    const creds = await stage.doc.config.credentials();
    expect(creds.accessKeyId).toBe('AKIAFAKE');
    stage.doc.destroy();
  });

  it.each(['AWS_ENDPOINT_URL_DYNAMODB', 'AWS_ENDPOINT_URL'])(
    'dev/prod: REFUSE to start when %s is set (it would redirect the client while the target line says AWS), before the guard; local is unaffected',
    async (name) => {
      const saved = process.env[name];
      let guardCalls = 0;
      const assertAccount = async () => {
        guardCalls += 1;
        return { Account: '938565869261' };
      };
      try {
        process.env[name] = 'http://127.0.0.1:8000';
        for (const target of ['dev', 'prod'] as const) {
          await expect(resolveStageClient(target, { assertAccount })).rejects.toThrow(new RegExp(`${name}\\b`));
        }
        expect(guardCalls).toBe(0);
        const local = await resolveStageClient('local', { assertAccount }, { lane: 3 });
        expect(local.endpoint).toBe('http://localhost:8000');
        expect(guardCalls).toBe(0);
        local.doc.destroy();
      } finally {
        if (saved === undefined) delete process.env[name];
        else process.env[name] = saved;
      }
    },
  );
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
    // A repeated argument never silently takes the last value: dev and prod
    // share one account, so the account guard cannot catch a dev/prod swap.
    { label: 'a repeated --env (--env dev ... --env prod)', argv: ['--env', 'dev', '--apply', '--env', 'prod'] },
    { label: 'a repeated --conversation', argv: ['--env', 'dev', '--conversation', 'a', '--conversation', 'b'] },
    { label: 'a repeated flag', argv: ['--env', 'dev', '--apply', '--apply'] },
    // --lane is local-only: with dev/prod it is a usage error, before any AWS call.
    { label: '--lane with --env dev', argv: ['--env', 'dev', '--lane', '3'] },
    { label: '--lane with --env prod (in either order)', argv: ['--lane', '1', '--env', 'prod'] },
  ])('refuses $label as a usage error', ({ argv }) => {
    expect(parseStageArgs(argv, FIX_SCRIPT)).toEqual({ usage: true });
  });
});
