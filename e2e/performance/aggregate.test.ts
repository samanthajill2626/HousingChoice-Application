import { describe, expect, it } from 'vitest';
import { aggregateSamples, buildRankings } from './aggregate.js';
import type { ResourceClass, SampleResult } from './types.js';

const RESOURCE_CLASSES: readonly ResourceClass[] = [
  'document',
  'script',
  'style',
  'font',
  'image',
  'api',
  'other',
];

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
  surfaceId: string,
  mode: 'cold' | 'warm',
  repeat: number,
  overrides: Partial<SampleResult> = {},
): SampleResult {
  return {
    surfaceId,
    mode,
    repeat,
    status: 'ok',
    readyMs: repeat + 1,
    navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    paint: { fcpMs: null, lcpMs: null },
    longTasks: { totalMs: repeat + 10, maxMs: repeat + 5, count: 1 },
    domElements: repeat + 100,
    apiRequestCount: repeat + 2,
    apiTransferBytes: repeat + 200,
    resourceRequestCount: repeat + 3,
    resourceTransferBytes: repeat + 300,
    resourceCountsByClass: resourceCounts(repeat + 4, repeat + 5),
    backgroundRequestCount: repeat + 6,
    backgroundTransferBytes: repeat + 600,
    blockedWrites: [],
    consoleCategories: {},
    clientTruncated: false,
    terminalState: 'populated',
    reason: null,
    ...overrides,
    surfaceEvidence: overrides.surfaceEvidence ?? null,
  };
}

describe('aggregateSamples', () => {
  it('keeps shared-path surface samples in separate aggregates', () => {
    const rows = aggregateSamples([
      sample('/inbox-all', 'warm', 0, { readyMs: 10 }),
      sample('/inbox-unread', 'warm', 0, { readyMs: 20 }),
    ]);

    expect(rows.map((row) => [row.surfaceId, row.metrics.readyMs.median])).toEqual([
      ['/inbox-all', 10],
      ['/inbox-unread', 20],
    ]);
  });

  it('computes odd and even medians with min and max', () => {
    const odd = [9, 1, 5].map((readyMs, repeat) =>
      sample('/odd', 'cold', repeat, { readyMs }),
    );
    const even = [8, 2, 6, 4].map((readyMs, repeat) =>
      sample('/even', 'cold', repeat, { readyMs }),
    );

    const rows = aggregateSamples([...odd, ...even]);

    expect(rows.find((row) => row.surfaceId === '/odd')?.metrics.readyMs).toEqual({
      median: 5,
      min: 1,
      max: 9,
      p95: null,
    });
    expect(rows.find((row) => row.surfaceId === '/even')?.metrics.readyMs).toEqual({
      median: 5,
      min: 2,
      max: 8,
      p95: null,
    });
  });

  it('emits p95 only at 20 successful samples using deterministic nearest rank', () => {
    const nineteen = Array.from({ length: 19 }, (_, repeat) =>
      sample('/nineteen', 'warm', repeat, { readyMs: repeat + 1 }),
    );
    const twenty = Array.from({ length: 20 }, (_, repeat) =>
      sample('/twenty', 'warm', repeat, { readyMs: repeat + 1 }),
    );

    const rows = aggregateSamples([...nineteen, ...twenty]);

    expect(rows.find((row) => row.surfaceId === '/nineteen')?.metrics.readyMs.p95).toBeNull();
    expect(rows.find((row) => row.surfaceId === '/twenty')?.metrics.readyMs.p95).toBe(19);
  });

  it('preserves unavailable metrics and excludes failed samples from statistics', () => {
    const rows = aggregateSamples([
      sample('/nullable', 'cold', 0, { readyMs: null, domElements: null }),
      sample('/nullable', 'cold', 1, { readyMs: 12, domElements: 120 }),
      sample('/nullable', 'cold', 2, {
        status: 'failed',
        readyMs: 999,
        domElements: 999,
        apiRequestCount: 999,
        reason: 'browser_failure',
      }),
      sample('/all-null', 'cold', 0, { readyMs: null, domElements: null }),
    ]);

    const nullable = rows.find((row) => row.surfaceId === '/nullable');
    expect(nullable?.successCount).toBe(2);
    expect(nullable?.metrics.readyMs).toEqual({ median: 12, min: 12, max: 12, p95: null });
    expect(nullable?.metrics.domElements).toEqual({ median: 120, min: 120, max: 120, p95: null });
    expect(nullable?.metrics.apiRequestCount.max).not.toBe(999);
    expect(rows.find((row) => row.surfaceId === '/all-null')?.metrics.readyMs).toEqual({
      median: null,
      min: null,
      max: null,
      p95: null,
    });
  });

  it('flags fewer than three successes and retains status counts', () => {
    const [row] = aggregateSamples([
      sample('/few', 'warm', 0),
      sample('/few', 'warm', 1, { status: 'timeout', reason: 'ready_timeout' }),
    ]);

    expect(row?.lowSampleCount).toBe(true);
    expect(row?.warnings).toEqual(['low_sample_count']);
    expect(row?.statusCounts).toMatchObject({ ok: 1, timeout: 1, failed: 0, skipped_required_action_missing: 0 });
  });

  it('counts a missing required action without treating it as a successful sample', () => {
    const [row] = aggregateSamples([
      sample('/inbox', 'warm', 0, { status: 'skipped_required_action_missing', reason: 'required_action_missing' }),
    ]);

    expect(row).toMatchObject({ successCount: 0, statusCounts: { skipped_required_action_missing: 1 } });
  });

  it('keeps resource classes and background noise separate from primary API metrics', () => {
    const [row] = aggregateSamples([
      sample('/noise', 'warm', 0, {
        apiRequestCount: 2,
        apiTransferBytes: 200,
        resourceCountsByClass: resourceCounts(7, 3),
        backgroundRequestCount: 11,
        backgroundTransferBytes: 1_100,
        clientTruncated: true,
      }),
      sample('/noise', 'warm', 1, {
        apiRequestCount: 4,
        apiTransferBytes: 400,
        resourceCountsByClass: resourceCounts(9, 5),
        backgroundRequestCount: 13,
        backgroundTransferBytes: 1_300,
      }),
      sample('/noise', 'warm', 2, {
        apiRequestCount: 6,
        apiTransferBytes: 600,
        resourceCountsByClass: resourceCounts(11, 7),
        backgroundRequestCount: 15,
        backgroundTransferBytes: 1_500,
      }),
    ], [{ surfaceId: '/noise', surfaceScaleBearing: false, loadScaleBearing: true }]);

    expect(row).toMatchObject({
      surfaceScaleBearing: false,
      loadScaleBearing: true,
      clientTruncated: true,
    });
    expect(row?.metrics.apiRequestCount.median).toBe(4);
    expect(row?.metrics.resourceCountsByClass.api.median).toBe(9);
    expect(row?.metrics.resourceCountsByClass.script.median).toBe(5);
    expect(row?.noise.backgroundRequestCount.median).toBe(13);
    expect(row?.noise.backgroundTransferBytes.median).toBe(1_300);
    expect(RESOURCE_CLASSES.every((resourceClass) => row?.metrics.resourceCountsByClass[resourceClass])).toBe(true);
  });
});

describe('buildRankings', () => {
  it('ranks cold and warm independently and preserves stable ties', () => {
    const rows = aggregateSamples([
      sample('/first', 'cold', 0, { readyMs: 10 }),
      sample('/first', 'cold', 1, { readyMs: 10 }),
      sample('/first', 'cold', 2, { readyMs: 10 }),
      sample('/second', 'cold', 0, { readyMs: 10 }),
      sample('/second', 'cold', 1, { readyMs: 10 }),
      sample('/second', 'cold', 2, { readyMs: 10 }),
      sample('/fast', 'cold', 0, { readyMs: 1 }),
      sample('/fast', 'cold', 1, { readyMs: 1 }),
      sample('/fast', 'cold', 2, { readyMs: 1 }),
      sample('/warm-worst', 'warm', 0, { readyMs: 30 }),
      sample('/warm-worst', 'warm', 1, { readyMs: 30 }),
      sample('/warm-worst', 'warm', 2, { readyMs: 30 }),
    ]);

    const rankings = buildRankings(rows);

    expect(rankings.cold.readyMs.map((row) => row.surfaceId)).toEqual([
      '/first',
      '/second',
      '/fast',
    ]);
    expect(rankings.warm.readyMs.map((row) => row.surfaceId)).toEqual(['/warm-worst']);
  });

  it('provides every secondary ranking including each resource class', () => {
    const rows = aggregateSamples([
      sample('/row', 'cold', 0),
      sample('/row', 'cold', 1),
      sample('/row', 'cold', 2),
    ]);

    const rankings = buildRankings(rows).cold;

    expect(rankings.apiTransferBytes).toHaveLength(1);
    expect(rankings.apiRequestCount).toHaveLength(1);
    expect(rankings.longTaskTotalMs).toHaveLength(1);
    expect(rankings.domElements).toHaveLength(1);
    for (const resourceClass of RESOURCE_CLASSES) {
      expect(rankings.resourceCountsByClass[resourceClass]).toHaveLength(1);
    }
  });
});
