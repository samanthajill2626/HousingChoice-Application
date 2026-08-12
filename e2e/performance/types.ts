export const PERFORMANCE_SCHEMA_VERSION = 1 as const;
export const INTERCEPTION_SCOPE_VERSION = 2 as const;

export type TargetKind = 'hermetic' | 'local' | 'hosted-dev';
export type SampleMode = 'cold' | 'warm';
export type SampleStatus =
  | 'ok'
  | 'timeout'
  | 'failed'
  | 'blocked_write_dependency'
  | 'skipped_no_fixture'
  | 'skipped_fixture_not_navigable'
  | 'skipped_source_not_ready';
export type FailureReasonCode =
  | 'ready_timeout'
  | 'source_timeout'
  | 'browser_failure'
  | 'target_proof_failed'
  | 'blocked_write_prevented_ready'
  | 'fixture_absent'
  | 'fixture_not_navigable'
  | 'source_not_ready'
  | 'cleanup_failed'
  | 'privacy_scan_failed'
  | 'comparison_failed'
  | 'unexpected_failure';

export type ReportRunStatus = 'complete' | 'partial';

export type ReportWarningCode =
  | 'background_noise'
  | 'client_truncated'
  | 'comparison_failed'
  | 'partial_run'
  | 'target_version_unverified'
  | 'unmatched_api';

export interface BrowserMetadata {
  name: 'chromium';
  channel: 'chromium' | 'chrome';
  version: string;
  major: number;
  httpCache: 'preserved';
  viewport: { width: number; height: number };
}

export interface RuntimeMetadata {
  os: string;
  node: string;
}

export interface BlockedWrite {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpointTemplate: string;
  phase: 'source_click' | 'destination_mount';
}

export type ResourceClass = 'document' | 'script' | 'style' | 'font' | 'image' | 'api' | 'other';

export interface RequestEvidence {
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  method: string;
  resourceClass: ResourceClass;
  originClass: 'first_party' | 'third_party';
  endpointTemplate: string;
  queryKeys: string[];
  startOffsetMs: number;
  durationMs: number | null;
  ttfbMs: number | null;
  status: number | null;
  transferBytes: number | null;
  outcome: 'finished' | 'failed' | 'aborted';
  requestRole: 'required' | 'background_refresh' | 'background_shell';
  unmatchedApi: boolean;
}

export interface SampleResult {
  routeKey: string;
  mode: SampleMode;
  repeat: number;
  status: SampleStatus;
  readyMs: number | null;
  navigation: {
    ttfbMs: number | null;
    domContentLoadedMs: number | null;
    loadMs: number | null;
  };
  paint: { fcpMs: number | null; lcpMs: number | null };
  longTasks: { totalMs: number; maxMs: number; count: number };
  domElements: number | null;
  apiRequestCount: number;
  apiTransferBytes: number;
  resourceRequestCount: number;
  resourceTransferBytes: number;
  resourceCountsByClass: Record<ResourceClass, number>;
  backgroundRequestCount: number;
  backgroundTransferBytes: number;
  blockedWrites: BlockedWrite[];
  consoleCategories: Record<string, number>;
  clientTruncated: boolean;
  terminalState: 'populated' | 'empty' | 'error' | 'unknown';
  reason: FailureReasonCode | null;
}

export interface TargetMetadata {
  target: TargetKind;
  proof: 'hermetic_lane' | 'local_stack' | 'hosted_dev';
  profilerCommit: string | null;
  targetAppCommit: string | null;
  targetVersionStatus: 'verified' | 'unverified';
}

export interface NumericSummary {
  median: number | null;
  min: number | null;
  max: number | null;
  p95: number | null;
}

export type SampleStatusCounts = Record<SampleStatus, number>;

export interface RouteScaleMetadata {
  key: string;
  surfaceScaleBearing: boolean;
  sourceLoadScaleBearing: boolean;
}

export interface AggregateMetrics {
  readyMs: NumericSummary;
  apiRequestCount: NumericSummary;
  apiTransferBytes: NumericSummary;
  longTaskTotalMs: NumericSummary;
  domElements: NumericSummary;
  resourceCountsByClass: Record<ResourceClass, NumericSummary>;
}

export interface AggregateNoise {
  backgroundRequestCount: NumericSummary;
  backgroundTransferBytes: NumericSummary;
}

export interface RouteModeAggregate {
  routeKey: string;
  mode: SampleMode;
  sampleCount: number;
  successCount: number;
  statusCounts: SampleStatusCounts;
  lowSampleCount: boolean;
  warnings: Array<'low_sample_count'>;
  surfaceScaleBearing: boolean;
  loadScaleBearing: boolean;
  clientTruncated: boolean;
  metrics: AggregateMetrics;
  noise: AggregateNoise;
}

export interface ModeRankings {
  readyMs: RouteModeAggregate[];
  apiTransferBytes: RouteModeAggregate[];
  apiRequestCount: RouteModeAggregate[];
  longTaskTotalMs: RouteModeAggregate[];
  domElements: RouteModeAggregate[];
  resourceCountsByClass: Record<ResourceClass, RouteModeAggregate[]>;
}

export type AggregateRankings = Record<SampleMode, ModeRankings>;

export interface ComparisonEnvironment {
  target: TargetKind;
  scaleManifest: object | null;
  routeSet: string[];
  browserMajor: number;
  browserChannel: string;
  viewport: { width: number; height: number };
  coldRepeats: number;
  warmRepeats: number;
  routeOrderSeed: number;
  interceptionScopeVersion: number;
  settleMs: number;
  pollMs: number;
}

export interface RevisionPairInput {
  profilerCommit: string | null;
  targetAppCommit: string | null;
}

export interface RevisionPair {
  profilerCommit: string | null;
  targetAppCommit: string | null;
}

export interface ComparisonRun {
  schemaVersion: number;
  environment: ComparisonEnvironment;
  revisions: RevisionPairInput;
  aggregates: RouteModeAggregate[];
}

export type EnvironmentMismatchField =
  | 'target'
  | 'scale_manifest'
  | 'route_set'
  | 'browser_major'
  | 'browser_channel'
  | 'viewport'
  | 'cold_repeats'
  | 'warm_repeats'
  | 'route_order_seed'
  | 'interception_scope_version'
  | 'settle_ms'
  | 'poll_ms';

export interface MetricDelta {
  absolute: number | null;
  percent: number | null;
}

export interface ComparisonEntryRef {
  routeKey: string;
  mode: SampleMode;
}

export interface ComparisonMetricDeltas {
  readyMs: MetricDelta;
  apiRequestCount: MetricDelta;
  apiTransferBytes: MetricDelta;
  longTaskTotalMs: MetricDelta;
  domElements: MetricDelta;
  resourceCountsByClass: Record<ResourceClass, MetricDelta>;
}

export interface MatchedComparison extends ComparisonEntryRef {
  metrics: ComparisonMetricDeltas;
}

export interface ComparisonResult {
  control: 'controlled' | 'uncontrolled';
  mismatches: EnvironmentMismatchField[];
  warnings: Array<'target_version_unverified'>;
  revisions: {
    baseline: RevisionPair;
    current: RevisionPair;
    targetAppCommitChanged: boolean;
  };
  matched: MatchedComparison[];
  added: ComparisonEntryRef[];
  removed: ComparisonEntryRef[];
  skipped: ComparisonEntryRef[];
  timedOut: ComparisonEntryRef[];
  failed: ComparisonEntryRef[];
  performanceExitCode: 0;
}
