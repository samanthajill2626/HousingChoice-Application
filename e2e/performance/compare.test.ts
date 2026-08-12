import { describe, expect, it } from 'vitest';
import { aggregateSamples } from './aggregate.js';
import { compareRuns } from './compare.js';
import type {
  ComparisonEnvironment,
  ComparisonRun,
  EnvironmentMismatchField,
  ResourceClass,
  SampleResult,
} from './types.js';

function resourceCounts(api = 0, script = 0): Record<ResourceClass, number> {
  return {
    document: 0,
    script,
    style: 0,
    font: 0,
    image: 0,
    api,
    other: 0,
  };
}

function sample(
  routeKey: string,
  mode: 'cold' | 'warm',
  repeat: number,
  overrides: Partial<SampleResult> = {},
): SampleResult {
  return {
    routeKey,
    mode,
    repeat,
    status: 'ok',
    readyMs: 100,
    navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    paint: { fcpMs: null, lcpMs: null },
    longTasks: { totalMs: 10, maxMs: 10, count: 1 },
    domElements: 100,
    apiRequestCount: 10,
    apiTransferBytes: 1_000,
    resourceRequestCount: 10,
    resourceTransferBytes: 1_000,
    resourceCountsByClass: resourceCounts(4, 3),
    backgroundRequestCount: 2,
    backgroundTransferBytes: 200,
    blockedWrites: [],
    consoleCategories: {},
    clientTruncated: false,
    terminalState: 'populated',
    reason: null,
    ...overrides,
  };
}

const ENVIRONMENT: ComparisonEnvironment = {
  target: 'hermetic',
  scaleManifest: {
    anchor: '2026-08-11T00:00:00.000Z',
    scale: 1,
    contacts: 100,
  },
  routeSet: ['/shared'],
  browserMajor: 140,
  browserChannel: 'chromium',
  viewport: { width: 1280, height: 720 },
  coldRepeats: 3,
  warmRepeats: 3,
  routeOrderSeed: 42,
  interceptionScopeVersion: 1,
  settleMs: 500,
  pollMs: 100,
};

function run(
  samples: SampleResult[],
  overrides: Partial<ComparisonRun> = {},
): ComparisonRun {
  return {
    schemaVersion: 1,
    environment: ENVIRONMENT,
    revisions: {
      profilerCommit: 'abcdef1',
      targetAppCommit: '1234567',
    },
    aggregates: aggregateSamples(samples),
    ...overrides,
  };
}

describe('compareRuns', () => {
  it('computes matching route and mode deltas for every primary metric', () => {
    const baseline = run([
      sample('/shared', 'cold', 0),
      sample('/shared', 'cold', 1),
      sample('/shared', 'cold', 2),
    ]);
    const current = run([
      sample('/shared', 'cold', 0, {
        readyMs: 125,
        apiRequestCount: 15,
        apiTransferBytes: 1_500,
        longTasks: { totalMs: 15, maxMs: 15, count: 1 },
        domElements: 125,
        resourceCountsByClass: resourceCounts(6, 6),
      }),
      sample('/shared', 'cold', 1, {
        readyMs: 125,
        apiRequestCount: 15,
        apiTransferBytes: 1_500,
        longTasks: { totalMs: 15, maxMs: 15, count: 1 },
        domElements: 125,
        resourceCountsByClass: resourceCounts(6, 6),
      }),
      sample('/shared', 'cold', 2, {
        readyMs: 125,
        apiRequestCount: 15,
        apiTransferBytes: 1_500,
        longTasks: { totalMs: 15, maxMs: 15, count: 1 },
        domElements: 125,
        resourceCountsByClass: resourceCounts(6, 6),
      }),
    ]);

    const comparison = compareRuns(baseline, current);
    const metrics = comparison.matched[0]?.metrics;

    expect(comparison.control).toBe('controlled');
    expect(metrics?.readyMs).toEqual({ absolute: 25, percent: 25 });
    expect(metrics?.apiRequestCount).toEqual({ absolute: 5, percent: 50 });
    expect(metrics?.apiTransferBytes).toEqual({ absolute: 500, percent: 50 });
    expect(metrics?.longTaskTotalMs).toEqual({ absolute: 5, percent: 50 });
    expect(metrics?.domElements).toEqual({ absolute: 25, percent: 25 });
    expect(metrics?.resourceCountsByClass.api).toEqual({ absolute: 2, percent: 50 });
    expect(metrics?.resourceCountsByClass.script).toEqual({ absolute: 3, percent: 100 });
  });

  it('uses null percent at a zero baseline without changing exit semantics for slowness', () => {
    const baseline = run([
      sample('/shared', 'warm', 0, { readyMs: 0 }),
      sample('/shared', 'warm', 1, { readyMs: 0 }),
      sample('/shared', 'warm', 2, { readyMs: 0 }),
    ]);
    const current = run([
      sample('/shared', 'warm', 0, { readyMs: 10 }),
      sample('/shared', 'warm', 1, { readyMs: 10 }),
      sample('/shared', 'warm', 2, { readyMs: 10 }),
    ]);

    const comparison = compareRuns(baseline, current);

    expect(comparison.matched[0]?.metrics.readyMs).toEqual({ absolute: 10, percent: null });
    expect(comparison.performanceExitCode).toBe(0);
  });

  it('lists added and removed route-mode entries', () => {
    const baseline = run([
      sample('/shared', 'cold', 0),
      sample('/removed', 'warm', 0),
    ], { environment: { ...ENVIRONMENT, routeSet: ['/shared', '/removed'] } });
    const current = run([
      sample('/shared', 'cold', 0),
      sample('/added', 'warm', 0),
    ], { environment: { ...ENVIRONMENT, routeSet: ['/shared', '/added'] } });

    const comparison = compareRuns(baseline, current);

    expect(comparison.added).toEqual([{ routeKey: '/added', mode: 'warm' }]);
    expect(comparison.removed).toEqual([{ routeKey: '/removed', mode: 'warm' }]);
  });

  it('lists skipped, timed-out, and failed current entries separately', () => {
    const baseline = run([sample('/shared', 'cold', 0)]);
    const current = run([
      sample('/shared', 'cold', 0),
      sample('/skip', 'cold', 0, { status: 'skipped_no_fixture', reason: 'fixture_absent' }),
      sample('/timeout', 'warm', 0, { status: 'timeout', reason: 'ready_timeout' }),
      sample('/failed', 'cold', 0, { status: 'failed', reason: 'browser_failure' }),
      sample('/blocked', 'warm', 0, {
        status: 'blocked_write_dependency',
        reason: 'blocked_write_prevented_ready',
      }),
    ], { environment: { ...ENVIRONMENT, routeSet: ['/shared', '/skip', '/timeout', '/failed', '/blocked'] } });

    const comparison = compareRuns(baseline, current);

    expect(comparison.skipped).toEqual([{ routeKey: '/skip', mode: 'cold' }]);
    expect(comparison.timedOut).toEqual([{ routeKey: '/timeout', mode: 'warm' }]);
    expect(comparison.failed).toEqual([
      { routeKey: '/failed', mode: 'cold' },
      { routeKey: '/blocked', mode: 'warm' },
    ]);
  });

  it.each([
    ['target', { target: 'local' }],
    ['scale_manifest', { scaleManifest: { ...ENVIRONMENT.scaleManifest, contacts: 101 } }],
    ['route_set', { routeSet: ['/other'] }],
    ['browser_major', { browserMajor: 141 }],
    ['browser_channel', { browserChannel: 'chrome' }],
    ['viewport', { viewport: { width: 1024, height: 768 } }],
    ['cold_repeats', { coldRepeats: 4 }],
    ['warm_repeats', { warmRepeats: 4 }],
    ['route_order_seed', { routeOrderSeed: 43 }],
    ['interception_scope_version', { interceptionScopeVersion: 2 }],
    ['settle_ms', { settleMs: 600 }],
    ['poll_ms', { pollMs: 50 }],
  ] as const)('labels %s as the exact environment mismatch field', (field, changed) => {
    const baseline = run([sample('/shared', 'cold', 0)]);
    const current = run([sample('/shared', 'cold', 0)], {
      environment: { ...ENVIRONMENT, ...changed } as ComparisonEnvironment,
    });

    const comparison = compareRuns(baseline, current);

    expect(comparison.control).toBe('uncontrolled');
    expect(comparison.mismatches).toEqual([field as EnvironmentMismatchField]);
    expect(comparison.matched).toHaveLength(1);
  });

  it('excludes only the seed anchor and treats route sets as order-independent', () => {
    const baseline = run([sample('/shared', 'cold', 0)], {
      environment: {
        ...ENVIRONMENT,
        routeSet: ['/b', '/a'],
        scaleManifest: { anchor: '2026-08-11T00:00:00.000Z', scale: 1, contacts: 100 },
      },
    });
    const current = run([sample('/shared', 'cold', 0)], {
      environment: {
        ...ENVIRONMENT,
        routeSet: ['/a', '/b'],
        scaleManifest: { anchor: '2027-01-01T00:00:00.000Z', scale: 1, contacts: 100 },
      },
    });

    expect(compareRuns(baseline, current).mismatches).toEqual([]);
  });

  it('normalizes revision pairs and treats target revision difference as the experiment', () => {
    const baseline = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: ' ABCDEF1 ', targetAppCommit: '1234567' },
    });
    const current = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: 'abcdef2', targetAppCommit: '7654321' },
    });

    const comparison = compareRuns(baseline, current);

    expect(comparison.revisions).toEqual({
      baseline: { profilerCommit: 'abcdef1', targetAppCommit: '1234567' },
      current: { profilerCommit: 'abcdef2', targetAppCommit: '7654321' },
      targetAppCommitChanged: true,
    });
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.warnings).toEqual([]);
  });

  it('normalizes missing, empty, and invalid revisions to null with one warning', () => {
    const baseline = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: '', targetAppCommit: null },
    });
    const current = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: 'not-a-revision', targetAppCommit: '   ' },
    });

    const comparison = compareRuns(baseline, current);

    expect(comparison.revisions).toEqual({
      baseline: { profilerCommit: null, targetAppCommit: null },
      current: { profilerCommit: null, targetAppCommit: null },
      targetAppCommitChanged: false,
    });
    expect(comparison.warnings).toEqual(['target_version_unverified']);
  });

  it('scopes target-version warnings to missing target revisions', () => {
    const baseline = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: null, targetAppCommit: '1234567' },
    });
    const current = run([sample('/shared', 'cold', 0)], {
      revisions: { profilerCommit: null, targetAppCommit: '1234567' },
    });

    expect(compareRuns(baseline, current).warnings).toEqual([]);
  });

  it('rejects schema differences instead of calling them an environment mismatch', () => {
    const baseline = run([sample('/shared', 'cold', 0)]);
    const current = run([sample('/shared', 'cold', 0)], { schemaVersion: 2 });

    expect(() => compareRuns(baseline, current)).toThrowError('schema_version_mismatch');
  });
});
