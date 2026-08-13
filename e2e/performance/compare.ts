import type {
  ComparisonEntryRef,
  ComparisonEnvironment,
  ComparisonMetricDeltas,
  ComparisonResult,
  ComparisonRun,
  EnvironmentMismatchField,
  MetricDelta,
  ResourceClass,
  RevisionPair,
  RouteModeAggregate,
} from './types.js';

const RESOURCE_CLASSES: readonly ResourceClass[] = [
  'document',
  'script',
  'style',
  'font',
  'image',
  'api',
  'other',
];

function aggregateKey(aggregate: RouteModeAggregate): string {
  return `${aggregate.mode}\u0000${aggregate.surfaceId}`;
}

function entryRef(aggregate: RouteModeAggregate): ComparisonEntryRef {
  return { surfaceId: aggregate.surfaceId, mode: aggregate.mode };
}

function normalizeRevision(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/u.test(normalized) ? normalized : null;
}

function normalizeRevisionPair(input: ComparisonRun['revisions']): RevisionPair {
  return {
    profilerCommit: normalizeRevision(input.profilerCommit),
    targetAppCommit: normalizeRevision(input.targetAppCommit),
  };
}

function normalizedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedValue(child)]);
    return Object.fromEntries(entries);
  }
  return value;
}

function normalizedScaleManifest(manifest: object | null): unknown {
  if (manifest === null) return null;
  const { anchor: _anchor, ...withoutAnchor } = manifest as Record<string, unknown>;
  return normalizedValue(withoutAnchor);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedValue(left)) === JSON.stringify(normalizedValue(right));
}

function normalizedRouteSet(routeSet: readonly string[]): string[] {
  return [...new Set(routeSet)].sort();
}

function environmentMismatches(
  baseline: ComparisonEnvironment,
  current: ComparisonEnvironment,
): EnvironmentMismatchField[] {
  const mismatches: EnvironmentMismatchField[] = [];
  if (baseline.target !== current.target) mismatches.push('target');
  if (!sameValue(normalizedScaleManifest(baseline.scaleManifest), normalizedScaleManifest(current.scaleManifest))) {
    mismatches.push('scale_manifest');
  }
  if (!sameValue(normalizedRouteSet(baseline.routeSet), normalizedRouteSet(current.routeSet))) {
    mismatches.push('route_set');
  }
  if (baseline.browserMajor !== current.browserMajor) mismatches.push('browser_major');
  if (baseline.browserChannel !== current.browserChannel) mismatches.push('browser_channel');
  if (!sameValue(baseline.viewport, current.viewport)) mismatches.push('viewport');
  if (baseline.coldRepeats !== current.coldRepeats) mismatches.push('cold_repeats');
  if (baseline.warmRepeats !== current.warmRepeats) mismatches.push('warm_repeats');
  if (baseline.routeOrderSeed !== current.routeOrderSeed) mismatches.push('route_order_seed');
  if (baseline.interceptionScopeVersion !== current.interceptionScopeVersion) {
    mismatches.push('interception_scope_version');
  }
  if (baseline.settleMs !== current.settleMs) mismatches.push('settle_ms');
  if (baseline.pollMs !== current.pollMs) mismatches.push('poll_ms');
  return mismatches;
}

function delta(baseline: number | null, current: number | null): MetricDelta {
  if (baseline === null || current === null) return { absolute: null, percent: null };
  const absolute = current - baseline;
  return {
    absolute,
    percent: baseline === 0 ? null : (absolute / baseline) * 100,
  };
}

function metricDeltas(
  baseline: RouteModeAggregate,
  current: RouteModeAggregate,
): ComparisonMetricDeltas {
  return {
    readyMs: delta(baseline.metrics.readyMs.median, current.metrics.readyMs.median),
    apiRequestCount: delta(
      baseline.metrics.apiRequestCount.median,
      current.metrics.apiRequestCount.median,
    ),
    apiTransferBytes: delta(
      baseline.metrics.apiTransferBytes.median,
      current.metrics.apiTransferBytes.median,
    ),
    longTaskTotalMs: delta(
      baseline.metrics.longTaskTotalMs.median,
      current.metrics.longTaskTotalMs.median,
    ),
    domElements: delta(baseline.metrics.domElements.median, current.metrics.domElements.median),
    resourceCountsByClass: Object.fromEntries(RESOURCE_CLASSES.map((resourceClass) => [
      resourceClass,
      delta(
        baseline.metrics.resourceCountsByClass[resourceClass].median,
        current.metrics.resourceCountsByClass[resourceClass].median,
      ),
    ])) as Record<ResourceClass, MetricDelta>,
  };
}

function hasSkippedStatus(aggregate: RouteModeAggregate): boolean {
  return aggregate.statusCounts.skipped_no_fixture > 0
    || aggregate.statusCounts.skipped_fixture_not_navigable > 0
    || aggregate.statusCounts.skipped_source_not_ready > 0
    || aggregate.statusCounts.skipped_unresolved_branch > 0;
}

function hasFailedStatus(aggregate: RouteModeAggregate): boolean {
  return aggregate.statusCounts.failed > 0 || aggregate.statusCounts.blocked_write_dependency > 0;
}

export function compareRuns(baseline: ComparisonRun, current: ComparisonRun): ComparisonResult {
  if (baseline.schemaVersion !== current.schemaVersion) throw new Error('schema_version_mismatch');

  const mismatches = environmentMismatches(baseline.environment, current.environment);
  const baselineByKey = new Map(baseline.aggregates.map((aggregate) => [aggregateKey(aggregate), aggregate]));
  const currentByKey = new Map(current.aggregates.map((aggregate) => [aggregateKey(aggregate), aggregate]));
  const matched = current.aggregates.flatMap((currentAggregate) => {
    const baselineAggregate = baselineByKey.get(aggregateKey(currentAggregate));
    if (!baselineAggregate) return [];
    return [{
      ...entryRef(currentAggregate),
      metrics: metricDeltas(baselineAggregate, currentAggregate),
    }];
  });
  const added = current.aggregates
    .filter((aggregate) => !baselineByKey.has(aggregateKey(aggregate)))
    .map(entryRef);
  const removed = baseline.aggregates
    .filter((aggregate) => !currentByKey.has(aggregateKey(aggregate)))
    .map(entryRef);
  const baselineRevisions = normalizeRevisionPair(baseline.revisions);
  const currentRevisions = normalizeRevisionPair(current.revisions);
  const targetRevisions = [
    baselineRevisions.targetAppCommit,
    currentRevisions.targetAppCommit,
  ];

  return {
    control: mismatches.length === 0 ? 'controlled' : 'uncontrolled',
    mismatches,
    warnings: targetRevisions.some((revision) => revision === null)
      ? ['target_version_unverified']
      : [],
    revisions: {
      baseline: baselineRevisions,
      current: currentRevisions,
      targetAppCommitChanged:
        baselineRevisions.targetAppCommit !== null
        && currentRevisions.targetAppCommit !== null
        && baselineRevisions.targetAppCommit !== currentRevisions.targetAppCommit,
    },
    matched,
    added,
    removed,
    skipped: current.aggregates.filter(hasSkippedStatus).map(entryRef),
    timedOut: current.aggregates
      .filter((aggregate) => aggregate.statusCounts.timeout > 0)
      .map(entryRef),
    failed: current.aggregates.filter(hasFailedStatus).map(entryRef),
    performanceExitCode: 0,
  };
}
