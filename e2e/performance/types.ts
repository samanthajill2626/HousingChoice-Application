export const PERFORMANCE_SCHEMA_VERSION = 1 as const;
export const INTERCEPTION_SCOPE_VERSION = 1 as const;

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
  | 'unexpected_failure';

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
