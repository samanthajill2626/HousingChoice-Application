import type {
  AggregateRankings,
  ModeRankings,
  NumericSummary,
  ResourceClass,
  RouteModeAggregate,
  RouteScaleMetadata,
  SampleMode,
  SampleResult,
  SampleStatus,
  SampleStatusCounts,
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

const SAMPLE_STATUSES: readonly SampleStatus[] = [
  'ok',
  'timeout',
  'failed',
  'blocked_write_dependency',
  'skipped_no_fixture',
  'skipped_fixture_not_navigable',
  'skipped_source_not_ready',
  'skipped_unresolved_branch',
];

function statusCounts(samples: readonly SampleResult[]): SampleStatusCounts {
  const counts = Object.fromEntries(SAMPLE_STATUSES.map((status) => [status, 0])) as SampleStatusCounts;
  for (const sample of samples) counts[sample.status] += 1;
  return counts;
}

function numericSummary(
  values: readonly (number | null)[],
  successfulSampleCount: number,
): NumericSummary {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((left, right) => left - right);
  if (sorted.length === 0) return { median: null, min: null, max: null, p95: null };

  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  const p95 = successfulSampleCount < 20
    ? null
    : sorted[Math.ceil(0.95 * sorted.length) - 1]!;
  return {
    median,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p95,
  };
}

function resourceSummaries(
  samples: readonly SampleResult[],
  successCount: number,
): Record<ResourceClass, NumericSummary> {
  return Object.fromEntries(RESOURCE_CLASSES.map((resourceClass) => [
    resourceClass,
    numericSummary(samples.map((sample) => sample.resourceCountsByClass[resourceClass]), successCount),
  ])) as Record<ResourceClass, NumericSummary>;
}

function groupKey(surfaceId: string, mode: SampleMode): string {
  return `${mode}\u0000${surfaceId}`;
}

export function aggregateSamples(
  samples: readonly SampleResult[],
  routeMetadata: readonly RouteScaleMetadata[] = [],
): RouteModeAggregate[] {
  const groups = new Map<string, SampleResult[]>();
  for (const sample of samples) {
    const key = groupKey(sample.surfaceId, sample.mode);
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  const metadataByRoute = new Map(routeMetadata.map((metadata) => [metadata.surfaceId, metadata]));

  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const successful = group.filter((sample) => sample.status === 'ok');
    const successCount = successful.length;
    const lowSampleCount = successCount < 3;
    const metadata = metadataByRoute.get(first.surfaceId);
    return {
      surfaceId: first.surfaceId,
      mode: first.mode,
      sampleCount: group.length,
      successCount,
      statusCounts: statusCounts(group),
      lowSampleCount,
      warnings: lowSampleCount ? ['low_sample_count'] : [],
      surfaceScaleBearing: metadata?.surfaceScaleBearing ?? false,
      loadScaleBearing: metadata?.loadScaleBearing ?? false,
      clientTruncated: group.some((sample) => sample.clientTruncated),
      metrics: {
        readyMs: numericSummary(successful.map((sample) => sample.readyMs), successCount),
        apiRequestCount: numericSummary(successful.map((sample) => sample.apiRequestCount), successCount),
        apiTransferBytes: numericSummary(successful.map((sample) => sample.apiTransferBytes), successCount),
        longTaskTotalMs: numericSummary(successful.map((sample) => sample.longTasks.totalMs), successCount),
        domElements: numericSummary(successful.map((sample) => sample.domElements), successCount),
        resourceCountsByClass: resourceSummaries(successful, successCount),
      },
      noise: {
        backgroundRequestCount: numericSummary(
          successful.map((sample) => sample.backgroundRequestCount),
          successCount,
        ),
        backgroundTransferBytes: numericSummary(
          successful.map((sample) => sample.backgroundTransferBytes),
          successCount,
        ),
      },
    };
  });
}

function descendingStable(
  rows: readonly RouteModeAggregate[],
  metric: (row: RouteModeAggregate) => number | null,
): RouteModeAggregate[] {
  return [...rows].sort((left, right) => {
    const leftValue = metric(left);
    const rightValue = metric(right);
    if (leftValue === null) return rightValue === null ? 0 : 1;
    if (rightValue === null) return -1;
    return rightValue - leftValue;
  });
}

function rankingsForMode(
  aggregates: readonly RouteModeAggregate[],
  mode: SampleMode,
): ModeRankings {
  const rows = aggregates.filter((aggregate) => aggregate.mode === mode);
  return {
    readyMs: descendingStable(rows, (row) => row.metrics.readyMs.median),
    apiTransferBytes: descendingStable(rows, (row) => row.metrics.apiTransferBytes.median),
    apiRequestCount: descendingStable(rows, (row) => row.metrics.apiRequestCount.median),
    longTaskTotalMs: descendingStable(rows, (row) => row.metrics.longTaskTotalMs.median),
    domElements: descendingStable(rows, (row) => row.metrics.domElements.median),
    resourceCountsByClass: Object.fromEntries(RESOURCE_CLASSES.map((resourceClass) => [
      resourceClass,
      descendingStable(rows, (row) => row.metrics.resourceCountsByClass[resourceClass].median),
    ])) as Record<ResourceClass, RouteModeAggregate[]>,
  };
}

export function buildRankings(aggregates: readonly RouteModeAggregate[]): AggregateRankings {
  return {
    cold: rankingsForMode(aggregates, 'cold'),
    warm: rankingsForMode(aggregates, 'warm'),
  };
}
