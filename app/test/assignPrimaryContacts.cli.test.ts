// assign-primary-contacts (plan C12, task S5.4): the CLI. Dry run by default,
// --apply writes, --lane is local only, anything else is a usage error (exit
// 2, nothing resolved); the target resolves BEFORE any read and a refusal
// there exits 1 with nothing run; a run that throws exits 1; a completed run
// exits by reportAssignRun (1 when a unit could not be decided or a write
// failed); once resolved, the stage client is destroyed whatever happens.
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/lib/logger.js';
import type { StageClient, StageClientOpts, StageTarget } from '../scripts/lib/stageClient.js';
import {
  main,
  USAGE,
  type AssignCliDeps,
  type AssignOptions,
  type AssignResult,
} from '../scripts/assign-primary-contacts.js';
import { createLogCapture } from './helpers/logCapture.js';

const CLEAN: AssignResult = {
  unitsScanned: 2,
  deletedUnits: 0,
  targets: 0,
  targetsOnDeletedUnits: 0,
  assigned: 0,
  scalarAligned: 0,
  skippedOnCondition: 0,
  writeFailed: 0,
  noHeir: 0,
  noEligible: 0,
  unknown: 0,
  unchanged: 2,
  auditFailed: 0,
  targetUnitIds: [],
  alignedUnitIds: [],
  noEligibleUnitIds: [],
  unknownUnitIds: [],
  skippedUnitIds: [],
  failedUnitIds: [],
};

function cli(opts: { resolveFails?: boolean; runFails?: boolean; result?: AssignResult } = {}) {
  const resolved: Array<{ target: StageTarget; opts: StageClientOpts }> = [];
  const runs: AssignOptions[] = [];
  const printed: string[] = [];
  const errors: string[] = [];
  let destroyed = 0;
  const stage: StageClient = {
    doc: {
      destroy: () => {
        destroyed += 1;
      },
    } as unknown as DynamoDBDocumentClient,
    env: { TABLE_PREFIX: 'hc-test-' },
    endpoint: 'http://fake-stage',
    prefix: 'hc-test-',
    accessKeyId: undefined,
    describe: 'fake stage',
  };
  const capture = createLogCapture();
  const deps: AssignCliDeps = {
    async resolveStage(target, stageOpts) {
      resolved.push({ target, opts: stageOpts });
      if (opts.resolveFails === true) throw new Error('ACCOUNT GUARD: wrong account');
      return stage;
    },
    async run(_stage, runOpts) {
      runs.push(runOpts);
      if (opts.runFails === true) throw new Error('scan failed');
      return opts.result ?? CLEAN;
    },
    print: (line) => {
      printed.push(line);
    },
    printError: (text) => {
      errors.push(text);
    },
    logger: createLogger({ level: 'info', destination: capture.stream }),
  };
  return { deps, resolved, runs, printed, errors, capture, destroyed: () => destroyed };
}

describe('assign-primary-contacts CLI', () => {
  it.each<[string[]]>([
    [[]],
    [['--apply']],
    [['--env', 'staging']],
    [['--env', 'dev', '--dry-run']],
    [['--env', 'dev', '--lane', '2']],
    [['--env', 'dev', '--apply', '--apply']],
  ])('exits 2 on the usage error %j: nothing resolved, nothing run', async (argv) => {
    const c = cli();
    expect(await main(argv, c.deps)).toBe(2);
    expect(c.errors).toEqual([USAGE]);
    expect(c.resolved).toEqual([]);
    expect(c.runs).toEqual([]);
  });

  it('dry run by default, against the resolved stage; the summary is printed and the client destroyed', async () => {
    const c = cli();
    expect(await main(['--env', 'prod'], c.deps)).toBe(0);
    expect(c.resolved).toEqual([{ target: 'prod', opts: {} }]);
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toMatchObject({ apply: false });
    expect(c.printed[0]).toBe('Primary contacts - DRY RUN, nothing written:');
    expect(c.destroyed()).toBe(1);
  });

  it('--apply writes; --lane reaches a local stage', async () => {
    const c = cli();
    expect(await main(['--env', 'local', '--lane', '4', '--apply'], c.deps)).toBe(0);
    expect(c.resolved).toEqual([{ target: 'local', opts: { lane: 4 } }]);
    expect(c.runs[0]).toMatchObject({ apply: true });
    expect(c.printed[0]).toBe('Primary contacts - APPLIED:');
  });

  it('exits 1 with nothing run when the target cannot be resolved', async () => {
    const c = cli({ resolveFails: true });
    expect(await main(['--env', 'dev'], c.deps)).toBe(1);
    expect(c.runs).toEqual([]);
    expect(c.destroyed()).toBe(0);
    expect(c.capture.atLevel(50).some((l) => String(l['msg']).includes('FAILED before the run started'))).toBe(true);
  });

  it('exits 1 when the run throws, naming the failure, and still destroys the client', async () => {
    const c = cli({ runFails: true });
    expect(await main(['--env', 'dev', '--apply'], c.deps)).toBe(1);
    expect(c.destroyed()).toBe(1);
    expect(
      c.capture.atLevel(50).some((l) => String(l['msg']) === 'assign-primary-contacts - FAILED: scan failed'),
    ).toBe(true);
  });

  it('exits 1 when the run completed with failures, 0 when it completed clean', async () => {
    const failed = cli({ result: { ...CLEAN, unknown: 1, unknownUnitIds: ['u-1'] } });
    expect(await main(['--env', 'dev'], failed.deps)).toBe(1);
    const clean = cli();
    expect(await main(['--env', 'dev'], clean.deps)).toBe(0);
  });
});
