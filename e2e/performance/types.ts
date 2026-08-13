export const PERFORMANCE_SCHEMA_VERSION = 2 as const;
export const PERFORMANCE_REGISTRY_VERSION = 2 as const;
export const PERFORMANCE_WORKLOAD_VERSION = 2 as const;
export const INTERCEPTION_SCOPE_VERSION = 3 as const;

export type TargetKind = 'hermetic' | 'local' | 'hosted-dev';
export type SampleMode = 'cold' | 'warm';
export type SampleStatus =
  | 'ok'
  | 'timeout'
  | 'failed'
  | 'blocked_write_dependency'
  | 'skipped_no_fixture'
  | 'skipped_fixture_not_navigable'
  | 'skipped_required_action_missing'
  | 'skipped_source_not_ready'
  | 'skipped_unresolved_branch';
export type FailureReasonCode =
  | 'ready_timeout'
  | 'source_timeout'
  | 'browser_failure'
  | 'target_proof_failed'
  | 'blocked_write_prevented_ready'
  | 'fixture_absent'
  | 'fixture_not_navigable'
  | 'required_action_missing'
  | 'source_not_ready'
  | 'unresolved_branch'
  | 'cleanup_failed'
  | 'privacy_scan_failed'
  | 'comparison_failed'
  | 'uncataloged_write_escaped_firewall'
  | 'unexpected_failure';

export type ReportRunStatus = 'complete' | 'partial';

export type ReportWarningCode =
  | 'background_noise'
  | 'client_truncated'
  | 'comparison_failed'
  | 'partial_run'
  | 'target_version_unverified'
  | 'out_of_sample_write'
  | 'unmatched_api';

export interface BrowserMetadata {
  name: 'chromium';
  channel: 'chromium' | 'chrome';
  version: string;
  major: number;
  httpCache: 'not_disabled_by_interception';
  viewport: { width: number; height: number };
}

export interface RuntimeMetadata {
  os: string;
  node: string;
}

export interface BlockedWrite {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  endpointTemplate: string;
  phase: 'source_click' | 'destination_mount' | 'out_of_sample';
}

export type ResourceClass = 'document' | 'script' | 'style' | 'font' | 'image' | 'api' | 'other';

export type SurfaceEvidence =
  | {
      kind: 'inbox';
      filter: 'all' | 'unread' | 'unknown' | 'groups';
      renderedRowCount: number;
      groupsTruncated: boolean;
      initialInboxPageRequestCount: number;
    }
  | { kind: 'conversation_detail'; initialRenderedMessageCount: number | null }
  | null;

export interface RequestEvidence {
  surfaceId: string;
  mode: SampleMode;
  repeat: number;
  method: string;
  resourceClass: ResourceClass;
  originClass: 'first_party' | 'third_party';
  endpointTemplate: string;
  queryKeys: string[];
  inboxRequestClass?: import('./routes.js').InboxRequestClass;
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
  surfaceId: string;
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
  terminalState: 'populated' | 'empty' | 'error' | 'contradictory_terminal' | 'unknown';
  surfaceEvidence: SurfaceEvidence;
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
  surfaceId: string;
  surfaceScaleBearing: boolean;
  loadScaleBearing: boolean;
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
  surfaceId: string;
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
  surfaceId: string;
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
