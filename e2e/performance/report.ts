import { randomBytes } from 'node:crypto';
import { access, mkdir, open, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import type { PerformanceSeedManifest } from '../../app/src/lib/seed/performance.js';
import { aggregateSamples, buildRankings } from './aggregate.js';
import { validateObservedRequestRoles } from './collect.js';
import { compareRuns } from './compare.js';
import type { SafeRunConfig } from './config.js';
import { serializeSelfQaResult, type SelfQaResult } from './selfQa.js';
import { scanArtifactFiles, type PrivacyViolationCode } from './redact.js';
import {
  ROUTES,
  assertObservedGets,
  expectedBlockedWrites,
  expectedGets,
  type InboxRequestClass,
  type RouteContractBranch,
  type RouteDefinition,
} from './routes.js';
import { allEndpointTemplates } from './templates.js';
import {
  INTERCEPTION_SCOPE_VERSION,
  PERFORMANCE_SCHEMA_VERSION,
  type AggregateRankings,
  type BlockedWrite,
  type BrowserMetadata,
  type ComparisonEnvironment,
  type ComparisonResult,
  type ComparisonRun,
  type FailureReasonCode,
  type RequestEvidence,
  type ResourceClass,
  type RouteModeAggregate,
  type RuntimeMetadata,
  type SampleMode,
  type SampleResult,
  type SampleStatus,
  type TargetMetadata,
} from './types.js';

const RESOURCE_CLASSES: readonly ResourceClass[] = [
  'document', 'script', 'style', 'font', 'image', 'api', 'other',
];
const SAMPLE_STATUSES: readonly SampleStatus[] = [
  'ok',
  'timeout',
  'failed',
  'blocked_write_dependency',
  'skipped_no_fixture',
  'skipped_fixture_not_navigable',
  'skipped_required_action_missing',
  'skipped_source_not_ready',
  'skipped_unresolved_branch',
];
const FAILURE_REASONS: readonly FailureReasonCode[] = [
  'ready_timeout',
  'source_timeout',
  'browser_failure',
  'target_proof_failed',
  'blocked_write_prevented_ready',
  'fixture_absent',
  'fixture_not_navigable',
  'required_action_missing',
  'source_not_ready',
  'unresolved_branch',
  'cleanup_failed',
  'privacy_scan_failed',
  'comparison_failed',
  'uncataloged_write_escaped_firewall',
  'unexpected_failure',
];
const ENDPOINT_TEMPLATES: ReadonlySet<string> = new Set([
  ...allEndpointTemplates(),
  'unmatched_api',
  'document',
  'script',
  'style',
  'font',
  'image',
  'other',
  'third_party',
  'invalid_url',
]);
const SAFE_SURFACE_ID = /^(?:\/(?:[a-z0-9-]+|:[A-Za-z][A-Za-z0-9]*)(?:\/(?:[a-z0-9-]+|:[A-Za-z][A-Za-z0-9]*))*|inbox-[a-z][a-z0-9-]*)$/u;
const SURFACE_IDS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.surfaceId));
const SAFE_QUERY_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const SAFE_BROWSER_VERSION = /^\d+(?:\.\d+){0,4}$/u;
const SAFE_RUN_ID = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/u;
const INBOX_REQUEST_CLASSES: readonly InboxRequestClass[] = [
  'inbox_page_all',
  'inbox_page_unread',
  'inbox_page_unknown',
  'inbox_page_groups',
  'inbox_badge',
  'inbox_endpoint_contract_failure',
];

export interface ReportBrowserInput {
  version: string;
  viewport: { width: number; height: number };
}

export interface ReportRouteOrder {
  mode: SampleMode;
  repeat: number;
  surfaceIds: string[];
}

export interface ReportWarmup {
  performed: boolean;
  surfaceId: string | null;
}

export interface ReportRelayDomCheck {
  expectedCount: number;
  renderedCount: number;
  shortfall: boolean;
}

export interface WritePerformanceReportInput {
  outputRoot: string;
  runId?: string;
  config: SafeRunConfig;
  target: TargetMetadata;
  samples: readonly SampleResult[];
  requests: readonly RequestEvidence[];
  outOfSampleWrites?: readonly BlockedWrite[];
  routeOrders: readonly ReportRouteOrder[];
  browser: ReportBrowserInput;
  warmup: ReportWarmup;
  relayDomCheck: ReportRelayDomCheck | null;
  baselineJson?: string;
  partialReason?: FailureReasonCode;
  safetyFailure?: ReportSafetyFailure;
  checkpointBranches?: readonly ContractCheckpointBranch[];
  selfQa?: SelfQaResult;
  signal?: AbortSignal;
}

export interface ReportSafetyFailure {
  reason: 'uncataloged_write_escaped_firewall';
  method: BlockedWrite['method'];
  endpointTemplate: string;
}

interface WrittenReportResult {
  status: 'written' | 'partial' | 'comparison_failure' | 'checkpoint_mismatch' | 'self_qa_mismatch';
  exitCode: 0 | 1;
  runId: string;
  directoryName: string;
  files: string[];
  reason?: 'comparison_failed';
}

interface PrivacyFailureResult {
  status: 'privacy_failure';
  exitCode: 1;
  runId: string;
  directoryName: string;
  files: string[];
  reason: 'privacy_scan_failed';
  reasonCategories: PrivacyViolationCode[];
}

export type WritePerformanceReportResult = WrittenReportResult | PrivacyFailureResult;

export interface ContractCheckpointBranch {
  surfaceId: string;
  mode: SampleMode;
  repeat: number;
  branch: RouteContractBranch;
}

export type ContractCheckpointMismatchCode =
  | 'missing_sample'
  | 'sample_failure'
  | 'unresolved_branch'
  | 'unresolved_terminal'
  | 'missing_required_endpoint'
  | 'unexpected_endpoint'
  | 'unmatched_api'
  | 'undeclared_background'
  | 'missing_blocked_write'
  | 'out_of_sample_blocked_write'
  | 'wrong_blocked_write_tuple';

export interface ContractEndpointObservation {
  endpointTemplate: string;
  queryKeys: string[];
  inboxRequestClass?: InboxRequestClass;
  multiplicity: number;
  outcome: RequestEvidence['outcome'];
  role: RequestEvidence['requestRole'];
}

export interface ContractCheckpointObservation {
  surfaceId: string;
  mode: SampleMode;
  selectedBranch: string;
  terminal: SampleResult['terminalState'];
  endpoints: ContractEndpointObservation[];
  backgroundRoles: Array<{
    endpointTemplate: string;
    queryKeys: string[];
    role: 'background_refresh' | 'background_shell';
  }>;
  blockedWrites: string[];
  mismatches: ContractCheckpointMismatchCode[];
}

export interface EvaluateContractCheckpointInput {
  routes: readonly RouteDefinition[];
  samples: readonly SampleResult[];
  requests: readonly RequestEvidence[];
  branches: readonly ContractCheckpointBranch[];
  outOfSampleWrites?: readonly BlockedWrite[];
  requireCompleteRegistry?: boolean;
}

export interface ContractCheckpointEvaluation {
  status: 'pass' | 'mismatch';
  mismatchCodes: ContractCheckpointMismatchCode[];
  observations: ContractCheckpointObservation[];
  outOfSampleWrites: BlockedWrite[];
}

function sampleKey(surfaceIdValue: string, mode: SampleMode, repeat: number): string {
  return `${surfaceIdValue}|${mode}|${repeat}`;
}

function symbolicBranch(branch: RouteContractBranch): string {
  if (branch.kind === 'none') return 'none';
  if (branch.kind === 'contact_detail') {
    if (branch.contactType === 'landlord') {
      return branch.landlordUnitCount > 0
        ? 'contact_detail_landlord_with_units'
        : 'contact_detail_landlord_without_units';
    }
    return `contact_detail_${branch.contactType}`;
  }
  if (branch.kind === 'unit_detail') {
    return branch.hasLandlord ? 'unit_detail_with_landlord' : 'unit_detail_without_landlord';
  }
  return `${branch.thread}_${branch.expectsMountWrite ? 'unread' : 'read'}`;
}

function endpointShape(value: { endpointTemplate: string; queryKeys: readonly string[] }): string {
  return `${value.endpointTemplate}?${[...value.queryKeys].sort().join('&')}`;
}

function blockedShape(value: BlockedWrite): string {
  return `${value.method}|${value.endpointTemplate}|${value.phase}`;
}

function inboxRequestClass(value: unknown): InboxRequestClass | undefined {
  return INBOX_REQUEST_CLASSES.includes(value as InboxRequestClass) ? value as InboxRequestClass : undefined;
}

function observedEndpoints(requests: readonly RequestEvidence[]): ContractEndpointObservation[] {
  const rows = new Map<string, ContractEndpointObservation>();
  for (const request of requests.filter((row) => row.originClass === 'first_party' && row.resourceClass === 'api')) {
    const queryKeys = [...request.queryKeys].sort();
    const requestClass = inboxRequestClass(request.inboxRequestClass);
    const key = `${request.endpointTemplate}?${queryKeys.join('&')}|${requestClass ?? 'none'}|${request.outcome}|${request.requestRole}`;
    const prior = rows.get(key);
    rows.set(key, {
      endpointTemplate: endpointTemplate(request.endpointTemplate),
      queryKeys,
      ...(requestClass !== undefined && { inboxRequestClass: requestClass }),
      multiplicity: (prior?.multiplicity ?? 0) + 1,
      outcome: request.outcome,
      role: request.requestRole,
    });
  }
  return [...rows.values()].sort((left, right) =>
    `${endpointShape(left)}|${left.inboxRequestClass ?? 'none'}|${left.role}|${left.outcome}`
      .localeCompare(`${endpointShape(right)}|${right.inboxRequestClass ?? 'none'}|${right.role}|${right.outcome}`),
  );
}

export function evaluateContractCheckpoint(
  input: EvaluateContractCheckpointInput,
): ContractCheckpointEvaluation {
  const routeBySurfaceId = new Map(input.routes.map((route) => [route.surfaceId, route]));
  const branches = new Map(input.branches.map((row) => [
    sampleKey(row.surfaceId, row.mode, row.repeat),
    row.branch,
  ]));
  const samples = new Map(input.samples.map((sample) => [
    sampleKey(sample.surfaceId, sample.mode, sample.repeat),
    sample,
  ]));
  const keys = new Set([...samples.keys(), ...branches.keys()]);
  if (input.requireCompleteRegistry === true) {
    for (const route of input.routes) {
      for (const mode of ['cold', 'warm'] as const) keys.add(sampleKey(route.surfaceId, mode, 0));
    }
  }

  const observations: ContractCheckpointObservation[] = [];
  for (const key of [...keys].sort()) {
    const [surfaceIdValue, rawMode, rawRepeat] = key.split('|');
    const mode = rawMode === 'warm' ? 'warm' : 'cold';
    const repeat = Number.parseInt(rawRepeat ?? '0', 10);
    const route = routeBySurfaceId.get(surfaceIdValue ?? '');
    if (route === undefined) continue;
    const sample = samples.get(key);
    const branch = branches.get(key);
    const requests = input.requests.filter((request) =>
      request.surfaceId === route.surfaceId && request.mode === mode && request.repeat === repeat,
    );
    const mismatches = new Set<ContractCheckpointMismatchCode>();
    if (sample === undefined) mismatches.add('missing_sample');
    if (sample !== undefined && sample.status !== 'ok') mismatches.add('sample_failure');
    if (branch === undefined) mismatches.add('unresolved_branch');
    if (sample === undefined || sample.terminalState === 'unknown') mismatches.add('unresolved_terminal');
    if (requests.some((request) => request.unmatchedApi)) mismatches.add('unmatched_api');
    if (validateObservedRequestRoles(requests).length > 0) mismatches.add('undeclared_background');

    if (branch !== undefined) {
      const declared = expectedGets(route, mode, branch);
      const requiredObserved = requests
        .filter((request) =>
          request.originClass === 'first_party'
          && request.resourceClass === 'api'
          && request.method === 'GET'
          && request.requestRole === 'required',
        )
        .map((request) => ({
          endpointTemplate: endpointTemplate(request.endpointTemplate) as never,
          queryKeys: [...request.queryKeys],
          ...(request.inboxRequestClass !== undefined && { inboxRequestClass: request.inboxRequestClass }),
          requirement: 'required' as const,
          outcome: request.outcome,
          status: request.status,
        }));
      const endpointResult = assertObservedGets(declared, requiredObserved);
      if (endpointResult.missingRequired.length > 0) mismatches.add('missing_required_endpoint');
      if (endpointResult.undeclared.length > 0) mismatches.add('unexpected_endpoint');

      const expectedWrites = new Set<string>(expectedBlockedWrites(route, mode, branch));
      const blockedSurface = branch.kind === 'thread_detail'
        ? branch.thread === 'group_thread' ? 'group_thread' : 'person_thread'
        : route.blockedSurface ?? 'unexpected_surface';
      const actualWrites = new Set((sample?.blockedWrites ?? []).map((write) =>
        `${blockedSurface}|${blockedShape(write)}`,
      ));
      if ([...expectedWrites].some((tuple) => !actualWrites.has(tuple))) {
        mismatches.add('missing_blocked_write');
      }
      if ([...actualWrites].some((tuple) => !expectedWrites.has(tuple))) {
        mismatches.add('wrong_blocked_write_tuple');
      }
    }

    const endpoints = observedEndpoints(requests);
    observations.push({
      surfaceId: route.surfaceId,
      mode,
      selectedBranch: branch === undefined ? 'unresolved' : symbolicBranch(branch),
      terminal: sample?.terminalState ?? 'unknown',
      endpoints,
      backgroundRoles: endpoints
        .filter((row): row is ContractEndpointObservation & {
          role: 'background_refresh' | 'background_shell';
        } => row.role !== 'required')
        .map((row) => ({
          endpointTemplate: row.endpointTemplate,
          queryKeys: [...row.queryKeys],
          role: row.role,
        })),
      blockedWrites: [...new Set((sample?.blockedWrites ?? []).map(blockedShape))].sort(),
      mismatches: [...mismatches].sort(),
    });
  }
  const outOfSampleWrites = (input.outOfSampleWrites ?? []).map(cloneBlockedWrite);
  const mismatchCodes = [...new Set([
    ...observations.flatMap((row) => row.mismatches),
    ...(outOfSampleWrites.length > 0 ? ['out_of_sample_blocked_write' as const] : []),
  ])].sort();
  return {
    status: mismatchCodes.length === 0 ? 'pass' : 'mismatch',
    mismatchCodes,
    observations,
    outOfSampleWrites,
  };
}

function integer(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function nullableFinite(value: unknown): number | null {
  return value === null ? null : finite(value);
}

function surfaceId(value: unknown): string {
  if (value === '/' && SURFACE_IDS.has('/')) return '/';
  return typeof value === 'string' && SAFE_SURFACE_ID.test(value) && SURFACE_IDS.has(value)
    ? value
    : 'invalid_route';
}

function endpointTemplate(value: unknown): string {
  return typeof value === 'string' && ENDPOINT_TEMPLATES.has(value) ? value : 'unmatched_api';
}

function normalizedRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/u.test(normalized) ? normalized : null;
}

function cloneManifest(manifest: PerformanceSeedManifest | null): PerformanceSeedManifest | null {
  if (manifest === null) return null;
  return {
    workloadModelVersion: integer(manifest.workloadModelVersion),
    anchor: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(manifest.anchor)
      ? manifest.anchor
      : '1970-01-01T00:00:00.000Z',
    scale: integer(manifest.scale),
    contacts: integer(manifest.contacts),
    units: integer(manifest.units),
    placements: integer(manifest.placements),
    tours: integer(manifest.tours),
    conversations: integer(manifest.conversations),
    requestedNativeGroups: integer(manifest.requestedNativeGroups),
    nativeGroups: integer(manifest.nativeGroups),
    nativeGroupCapacity: integer(manifest.nativeGroupCapacity),
    nativeGroupRosterSizes: Array.isArray(manifest.nativeGroupRosterSizes)
      ? manifest.nativeGroupRosterSizes.map((size) => integer(size))
      : [],
    nativeGroupMemberSlotCount: integer(manifest.nativeGroupMemberSlotCount),
    totalConversations: integer(manifest.totalConversations),
    tenantCount: integer(manifest.tenantCount),
    landlordCount: integer(manifest.landlordCount),
    unknownCount: integer(manifest.unknownCount),
    activeTenantCount: integer(manifest.activeTenantCount),
    activeLandlordCount: integer(manifest.activeLandlordCount),
    activeUnknownCount: integer(manifest.activeUnknownCount),
    activeContactCount: integer(manifest.activeContactCount),
    deletedContactCount: integer(manifest.deletedContactCount),
    messagesPerConversation: integer(manifest.messagesPerConversation),
    requestedLongConversationMessages: integer(manifest.requestedLongConversationMessages),
    resolvedLongConversationMessages: integer(manifest.resolvedLongConversationMessages),
    longConversationFixturePresent: manifest.longConversationFixturePresent === true,
    ordinaryMessageCount: integer(manifest.ordinaryMessageCount),
    tailMessageCount: integer(manifest.tailMessageCount),
    totalMessageCount: integer(manifest.totalMessageCount),
    broadcasts: integer(manifest.broadcasts),
    recipientsPerBroadcast: integer(manifest.recipientsPerBroadcast),
    requestedLargeBroadcastRecipients: integer(manifest.requestedLargeBroadcastRecipients),
    resolvedLargeBroadcastRecipients: integer(manifest.resolvedLargeBroadcastRecipients),
    clippedLargeBroadcastRecipients: integer(manifest.clippedLargeBroadcastRecipients),
    largeBroadcastFixturePresent: manifest.largeBroadcastFixturePresent === true,
    recipientPoolSize: integer(manifest.recipientPoolSize),
    recipientPoolSource: manifest.recipientPoolSource === 'generated_tenants'
      ? 'generated_tenants'
      : 'lean_tenant',
    messageCount: integer(manifest.messageCount),
    requestedRecipientCount: integer(manifest.requestedRecipientCount),
    resolvedRecipientsPerBroadcast: integer(manifest.resolvedRecipientsPerBroadcast),
    requestedOrdinaryRecipientCount: integer(manifest.requestedOrdinaryRecipientCount),
    resolvedOrdinaryRecipientCount: integer(manifest.resolvedOrdinaryRecipientCount),
    clippedOrdinaryRecipientCount: integer(manifest.clippedOrdinaryRecipientCount),
    resolvedRecipientCount: integer(manifest.resolvedRecipientCount),
    totalRecipientCount: integer(manifest.totalRecipientCount),
    requestedRelayGroupCount: integer(manifest.requestedRelayGroupCount),
    relayGroupCount: integer(manifest.relayGroupCount),
    clippedRelayGroupCount: integer(manifest.clippedRelayGroupCount),
    fixedUnmatchedEmailCount: 4,
    physicalItemCount: integer(manifest.physicalItemCount),
    totalItemCount: integer(manifest.totalItemCount),
    fallbacks: { tenant: 'lean_tenant', landlord: 'lean_landlord', unit: 'lean_unit' },
  };
}

function cloneConfig(config: SafeRunConfig): SafeRunConfig {
  return {
    target: config.target,
    browserChannel: config.browserChannel,
    headed: config.headed === true,
    coldRepeats: integer(config.coldRepeats),
    warmRepeats: integer(config.warmRepeats),
    readyTimeoutMs: integer(config.readyTimeoutMs),
    sourceTimeoutMs: integer(config.sourceTimeoutMs),
    loginTimeoutMs: integer(config.loginTimeoutMs),
    settleMs: integer(config.settleMs),
    pollMs: integer(config.pollMs),
    routeOrderSeed: integer(config.routeOrderSeed),
    contractCheckpoint: config.contractCheckpoint === true,
    selfQa: config.selfQa === 'narrow' || config.selfQa === 'full' ? config.selfQa : null,
    seed: cloneManifest(config.seed),
  };
}

function cloneTarget(target: TargetMetadata): TargetMetadata {
  const targetKind = ['hermetic', 'local', 'hosted-dev'].includes(target.target)
    ? target.target
    : 'hermetic';
  const expectedProof = targetKind === 'hermetic'
    ? 'hermetic_lane'
    : targetKind === 'local'
      ? 'local_stack'
      : 'hosted_dev';
  const profilerCommit = normalizedRevision(target.profilerCommit);
  const targetAppCommit = normalizedRevision(target.targetAppCommit);
  return {
    target: targetKind,
    proof: expectedProof,
    profilerCommit,
    targetAppCommit,
    targetVersionStatus:
      target.targetVersionStatus === 'verified' && targetAppCommit !== null ? 'verified' : 'unverified',
  };
}

function cloneBlockedWrite(write: BlockedWrite): BlockedWrite {
  return {
    method: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(write.method) ? write.method : 'POST',
    endpointTemplate: endpointTemplate(write.endpointTemplate),
    phase: write.phase === 'source_click'
      ? 'source_click'
      : write.phase === 'destination_mount'
        ? 'destination_mount'
        : 'out_of_sample',
  };
}

function cloneSafetyFailure(value: ReportSafetyFailure | undefined): ReportSafetyFailure | null {
  if (value?.reason !== 'uncataloged_write_escaped_firewall') return null;
  return {
    reason: 'uncataloged_write_escaped_firewall',
    method: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(value.method) ? value.method : 'POST',
    endpointTemplate: endpointTemplate(value.endpointTemplate),
  };
}

function cloneResourceCounts(value: Record<ResourceClass, number>): Record<ResourceClass, number> {
  return Object.fromEntries(RESOURCE_CLASSES.map((resourceClass) => [
    resourceClass,
    integer(value[resourceClass]),
  ])) as Record<ResourceClass, number>;
}

function cloneSurfaceEvidence(value: SampleResult['surfaceEvidence']): SampleResult['surfaceEvidence'] {
  if (value?.kind === 'inbox') {
    return {
      kind: 'inbox',
      filter: ['all', 'unread', 'unknown', 'groups'].includes(value.filter) ? value.filter : 'all',
      renderedRowCount: integer(value.renderedRowCount),
      groupsTruncated: value.groupsTruncated === true,
      initialInboxPageRequestCount: integer(value.initialInboxPageRequestCount),
    };
  }
  if (value?.kind === 'conversation_detail') {
    return { kind: 'conversation_detail', initialRenderedMessageCount: nullableFinite(value.initialRenderedMessageCount) };
  }
  return null;
}

function cloneSample(sample: SampleResult): SampleResult {
  const status = SAMPLE_STATUSES.includes(sample.status) ? sample.status : 'failed';
  const reason = sample.reason !== null && FAILURE_REASONS.includes(sample.reason)
    ? sample.reason
    : null;
  return {
    surfaceId: surfaceId(sample.surfaceId),
    mode: sample.mode === 'warm' ? 'warm' : 'cold',
    repeat: integer(sample.repeat),
    status,
    readyMs: nullableFinite(sample.readyMs),
    navigation: {
      ttfbMs: nullableFinite(sample.navigation?.ttfbMs),
      domContentLoadedMs: nullableFinite(sample.navigation?.domContentLoadedMs),
      loadMs: nullableFinite(sample.navigation?.loadMs),
    },
    paint: {
      fcpMs: nullableFinite(sample.paint?.fcpMs),
      lcpMs: nullableFinite(sample.paint?.lcpMs),
    },
    longTasks: {
      totalMs: finite(sample.longTasks?.totalMs),
      maxMs: finite(sample.longTasks?.maxMs),
      count: integer(sample.longTasks?.count),
    },
    domElements: nullableFinite(sample.domElements),
    apiRequestCount: integer(sample.apiRequestCount),
    apiTransferBytes: finite(sample.apiTransferBytes),
    resourceRequestCount: integer(sample.resourceRequestCount),
    resourceTransferBytes: finite(sample.resourceTransferBytes),
    resourceCountsByClass: cloneResourceCounts(sample.resourceCountsByClass),
    backgroundRequestCount: integer(sample.backgroundRequestCount),
    backgroundTransferBytes: finite(sample.backgroundTransferBytes),
    blockedWrites: sample.blockedWrites.map(cloneBlockedWrite),
    consoleCategories: {
      ...(integer(sample.consoleCategories.client_truncated) > 0 && {
        client_truncated: integer(sample.consoleCategories.client_truncated),
      }),
      ...(integer(sample.consoleCategories.warning_other) > 0 && {
        warning_other: integer(sample.consoleCategories.warning_other),
      }),
      ...(integer(sample.consoleCategories.error_other) > 0 && {
        error_other: integer(sample.consoleCategories.error_other),
      }),
    },
    clientTruncated: sample.clientTruncated === true,
    terminalState: ['populated', 'empty', 'error', 'contradictory_terminal', 'unknown'].includes(sample.terminalState)
      ? sample.terminalState
      : 'unknown',
    surfaceEvidence: cloneSurfaceEvidence(sample.surfaceEvidence),
    reason,
  };
}

function cloneRequest(request: RequestEvidence): RequestEvidence {
  const method = typeof request.method === 'string'
    && ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'OTHER'].includes(request.method)
    ? request.method
    : 'OTHER';
  const requestClass = inboxRequestClass(request.inboxRequestClass);
  return {
    surfaceId: surfaceId(request.surfaceId),
    mode: request.mode === 'warm' ? 'warm' : 'cold',
    repeat: integer(request.repeat),
    method,
    resourceClass: RESOURCE_CLASSES.includes(request.resourceClass) ? request.resourceClass : 'other',
    originClass: request.originClass === 'first_party' ? 'first_party' : 'third_party',
    endpointTemplate: endpointTemplate(request.endpointTemplate),
    queryKeys: request.queryKeys
      .filter((key) => typeof key === 'string' && SAFE_QUERY_KEY.test(key))
      .slice(0, 32),
    ...(requestClass !== undefined && { inboxRequestClass: requestClass }),
    startOffsetMs: finite(request.startOffsetMs),
    durationMs: nullableFinite(request.durationMs),
    ttfbMs: nullableFinite(request.ttfbMs),
    status: request.status === null ? null : integer(request.status),
    transferBytes: nullableFinite(request.transferBytes),
    outcome: ['finished', 'failed', 'aborted'].includes(request.outcome) ? request.outcome : 'failed',
    requestRole: ['required', 'background_refresh', 'background_shell'].includes(request.requestRole)
      ? request.requestRole
      : 'required',
    unmatchedApi: request.unmatchedApi === true,
  };
}

function browserMetadata(config: SafeRunConfig, browser: ReportBrowserInput): BrowserMetadata {
  const version = SAFE_BROWSER_VERSION.test(browser.version) ? browser.version : '0';
  return {
    name: 'chromium',
    channel: config.browserChannel,
    version,
    major: Number.parseInt(version.split('.')[0]!, 10),
    httpCache: 'not_disabled_by_interception',
    viewport: {
      width: integer(browser.viewport.width),
      height: integer(browser.viewport.height),
    },
  };
}

function runtimeMetadata(): RuntimeMetadata {
  return { os: `${platform()}/${arch()}`, node: process.versions.node };
}

function cloneOrders(orders: readonly ReportRouteOrder[]): ReportRouteOrder[] {
  return orders.map((order) => ({
    mode: order.mode === 'warm' ? 'warm' : 'cold',
    repeat: integer(order.repeat),
    surfaceIds: order.surfaceIds.map(surfaceId),
  }));
}

function comparisonEnvironment(
  config: SafeRunConfig,
  browser: BrowserMetadata,
  samples: readonly SampleResult[],
): ComparisonEnvironment {
  return {
    target: config.target,
    scaleManifest: config.seed,
    routeSet: [...new Set(samples.map((sample) => sample.surfaceId))].sort(),
    browserMajor: browser.major,
    browserChannel: browser.channel,
    viewport: browser.viewport,
    coldRepeats: config.coldRepeats,
    warmRepeats: config.warmRepeats,
    routeOrderSeed: config.routeOrderSeed,
    interceptionScopeVersion: INTERCEPTION_SCOPE_VERSION,
    settleMs: config.settleMs,
    pollMs: config.pollMs,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function baselineSummary(value: unknown): boolean {
  const summary = record(value);
  return summary !== null && (summary['median'] === null
    || (typeof summary['median'] === 'number' && Number.isFinite(summary['median'])));
}

function baselineAggregate(value: unknown): value is RouteModeAggregate {
  const aggregate = record(value);
  const metrics = record(aggregate?.['metrics']);
  const resources = record(metrics?.['resourceCountsByClass']);
  const statuses = record(aggregate?.['statusCounts']);
  return aggregate !== null
    && surfaceId(aggregate['surfaceId']) === aggregate['surfaceId']
    && (aggregate['mode'] === 'cold' || aggregate['mode'] === 'warm')
    && metrics !== null
    && baselineSummary(metrics['readyMs'])
    && baselineSummary(metrics['apiRequestCount'])
    && baselineSummary(metrics['apiTransferBytes'])
    && baselineSummary(metrics['longTaskTotalMs'])
    && baselineSummary(metrics['domElements'])
    && resources !== null
    && RESOURCE_CLASSES.every((resourceClass) => baselineSummary(resources[resourceClass]))
    && statuses !== null
    && SAMPLE_STATUSES.every((status) => Number.isSafeInteger(statuses[status]) && Number(statuses[status]) >= 0);
}

function createComparisonRun(summary: Record<string, unknown>): ComparisonRun {
  const aggregates = summary['aggregates'];
  if (!Array.isArray(aggregates) || !aggregates.every(baselineAggregate)) {
    throw new Error('baseline_schema_invalid');
  }
  return {
    schemaVersion: summary['schemaVersion'] as number,
    environment: summary['environment'] as ComparisonEnvironment,
    revisions: summary['revisions'] as ComparisonRun['revisions'],
    aggregates,
  };
}

function parseBaselineJson(text: string): ComparisonRun {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('baseline_schema_invalid');
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== PERFORMANCE_SCHEMA_VERSION
    || typeof candidate.environment !== 'object'
    || candidate.environment === null
    || typeof candidate.revisions !== 'object'
    || candidate.revisions === null
    || !Array.isArray(candidate.aggregates)
  ) {
    throw new Error('baseline_schema_invalid');
  }
  return createComparisonRun(candidate);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function metric(value: number | null): string {
  return value === null ? 'n/a' : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function labels(row: RouteModeAggregate): string {
  return [
    `surface_scale_bearing=${row.surfaceScaleBearing}`,
    `load_scale_bearing=${row.loadScaleBearing}`,
    ...(row.clientTruncated ? ['client_truncated'] : []),
  ].join(', ');
}

function rankingTable(rows: readonly RouteModeAggregate[], field: keyof RouteModeAggregate['metrics']): string[] {
  const valueFor = (row: RouteModeAggregate): number | null => {
    const value = row.metrics[field];
    return 'median' in value ? value.median : null;
  };
  return [
    '| Route | Median | Labels |',
    '| --- | ---: | --- |',
    ...rows.map((row) => `| ${row.surfaceId} | ${metric(valueFor(row))} | ${labels(row)} |`),
  ];
}

function reportMarkdown(input: {
  runId: string;
  config: SafeRunConfig;
  target: TargetMetadata;
  samples: readonly SampleResult[];
  requests: readonly RequestEvidence[];
  aggregates: readonly RouteModeAggregate[];
  rankings: AggregateRankings;
  files: readonly string[];
  partialReason: FailureReasonCode | null;
  comparisonStatus: 'not_requested' | 'written' | 'failed';
  outOfSampleWrites: readonly BlockedWrite[];
  safetyFailure: ReportSafetyFailure | null;
}): string {
  const lines = [
    '# Page Performance Profile',
    '',
    `- Run: \`${input.runId}\``,
    `- Target: \`${input.target.target}\` (\`${input.target.proof}\`)`,
    `- Profiler revision: \`${input.target.profilerCommit ?? 'unverified'}\``,
    `- Target app revision: \`${input.target.targetAppCommit ?? 'unverified'}\``,
    `- Comparison: \`${input.comparisonStatus}\``,
  ];
  if (input.comparisonStatus === 'failed') lines.push('- Comparison reason: `comparison_failed`');
  if (input.target.targetVersionStatus === 'unverified') {
    lines.push('- WARNING: `target_version_unverified`');
  }
  if (input.outOfSampleWrites.length > 0) lines.push('- WARNING: `out_of_sample_write`');
  if (input.partialReason !== null) lines.push(`- Partial run reason: \`${input.partialReason}\``);
  if (input.safetyFailure !== null) {
    lines.push(`- Escaped write: \`${input.safetyFailure.method} ${input.safetyFailure.endpointTemplate}\``);
  }
  lines.push('', '## Count manifest', '');
  if (input.config.seed === null) {
    lines.push('No hermetic count manifest is available for this target.');
  } else {
    lines.push('| Count | Value |', '| --- | ---: |');
    for (const key of [
      'scale', 'contacts', 'units', 'placements', 'tours', 'conversations',
      'messagesPerConversation', 'broadcasts', 'recipientsPerBroadcast', 'totalItemCount',
    ] as const) {
      lines.push(`| ${key} | ${input.config.seed[key]} |`);
    }
  }
  lines.push('', '## Cold worst offenders', '', ...rankingTable(input.rankings.cold.readyMs, 'readyMs'));
  lines.push('', '## Warm worst offenders', '', ...rankingTable(input.rankings.warm.readyMs, 'readyMs'));
  lines.push('', '## Secondary rankings', '');
  for (const mode of ['cold', 'warm'] as const) {
    const rankings = input.rankings[mode];
    for (const [name, rows, field] of [
      ['API transfer bytes', rankings.apiTransferBytes, 'apiTransferBytes'],
      ['API request count', rankings.apiRequestCount, 'apiRequestCount'],
      ['Long-task total', rankings.longTaskTotalMs, 'longTaskTotalMs'],
      ['DOM elements', rankings.domElements, 'domElements'],
    ] as const) {
      lines.push(`### ${mode} ${name}`, '', ...rankingTable(rows, field), '');
    }
  }
  lines.push('## Failures and skips', '', '| Route | Mode | Status | Reason |', '| --- | --- | --- | --- |');
  const nonOk = input.samples.filter((sample) => sample.status !== 'ok');
  lines.push(...(nonOk.length === 0
    ? ['| none | - | - | - |']
    : nonOk.map((sample) => `| ${sample.surfaceId} | ${sample.mode} | ${sample.status} | ${sample.reason ?? 'none'} |`)));
  lines.push('', '## Blocked writes', '', '| Method | Endpoint | Phase | Count |', '| --- | --- | --- | ---: |');
  const blocked = new Map<string, { value: BlockedWrite; count: number }>();
  for (const write of input.samples.flatMap((sample) => sample.blockedWrites)) {
    const key = `${write.method}|${write.endpointTemplate}|${write.phase}`;
    const prior = blocked.get(key);
    blocked.set(key, { value: write, count: (prior?.count ?? 0) + 1 });
  }
  lines.push(...(blocked.size === 0
    ? ['| none | - | - | 0 |']
    : [...blocked.values()].map(({ value, count }) =>
      `| ${value.method} | ${value.endpointTemplate} | ${value.phase} | ${count} |`)));
  lines.push('', '## Out-of-sample blocked writes', '', '| Method | Endpoint | Count |', '| --- | --- | ---: |');
  const detached = new Map<string, { value: BlockedWrite; count: number }>();
  for (const write of input.outOfSampleWrites) {
    const key = `${write.method}|${write.endpointTemplate}`;
    const prior = detached.get(key);
    detached.set(key, { value: write, count: (prior?.count ?? 0) + 1 });
  }
  lines.push(...(detached.size === 0
    ? ['| none | - | 0 |']
    : [...detached.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, { value, count }]) =>
      `| ${value.method} | ${value.endpointTemplate} | ${count} |`)));
  const unmatchedCount = input.requests.filter((request) => request.unmatchedApi).length;
  lines.push('', '## Unmatched APIs', '', `- Count: ${unmatchedCount}`);
  lines.push('', '## Resource request classes', '', '| Class | Count |', '| --- | ---: |');
  for (const resourceClass of RESOURCE_CLASSES) {
    const count = input.samples.reduce(
      (total, sample) => total + sample.resourceCountsByClass[resourceClass],
      0,
    );
    lines.push(`| ${resourceClass} | ${count} |`);
  }
  const backgroundRefresh = input.requests.filter((request) => request.requestRole === 'background_refresh').length;
  const backgroundShell = input.requests.filter((request) => request.requestRole === 'background_shell').length;
  const backgroundRequests = input.samples.reduce((total, sample) => total + sample.backgroundRequestCount, 0);
  const backgroundBytes = input.samples.reduce((total, sample) => total + sample.backgroundTransferBytes, 0);
  lines.push(
    '',
    '## Background noise',
    '',
    `- background_refresh rows: ${backgroundRefresh}`,
    `- background_shell rows: ${backgroundShell}`,
    `- background request count: ${backgroundRequests}`,
    `- background transfer bytes: ${backgroundBytes}`,
    '',
    '## Artifacts',
    '',
    ...input.files.map((file) => `- \`${file}\``),
    '',
  );
  return lines.join('\n');
}

function comparisonMarkdown(comparison: ComparisonResult): string {
  const lines = [
    '# Page Performance Comparison',
    '',
    `- Control: \`${comparison.control}\``,
    `- Target app revision changed: ${comparison.revisions.targetAppCommitChanged ? 'yes' : 'no'}`,
    `- Mismatches: ${comparison.mismatches.length === 0 ? 'none' : comparison.mismatches.join(', ')}`,
    `- Warnings: ${comparison.warnings.length === 0 ? 'none' : comparison.warnings.join(', ')}`,
    '',
    '| Route | Mode | Ready absolute | Ready percent |',
    '| --- | --- | ---: | ---: |',
    ...comparison.matched.map((entry) =>
      `| ${entry.surfaceId} | ${entry.mode} | ${metric(entry.metrics.readyMs.absolute)} | ${metric(entry.metrics.readyMs.percent)} |`),
    '',
  ];
  return lines.join('\n');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const PRIVACY_SCRUB_ATTEMPTS = 4;
const PRIVACY_SCRUB_RETRY_MS = 25;

async function waitForPrivacyScrubRetry(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, PRIVACY_SCRUB_RETRY_MS));
}

interface StagedArtifactHandle {
  fileName: string;
  handle: FileHandle;
}

async function closeStagedArtifactHandles(artifacts: readonly StagedArtifactHandle[]): Promise<void> {
  await Promise.all(artifacts.map(({ handle }) => handle.close()));
}

async function scrubStagingArtifacts(
  stagingDirectory: string,
  files: readonly string[],
  artifacts: readonly StagedArtifactHandle[],
): Promise<void> {
  const ownedHandles = new Map(artifacts.map((artifact) => [artifact.fileName, artifact.handle]));
  const scrubbed = await Promise.all(files.map(async (fileName) => {
    for (let attempt = 0; attempt < PRIVACY_SCRUB_ATTEMPTS; attempt += 1) {
      let handle = attempt === 0 ? ownedHandles.get(fileName) : undefined;
      let reopened = false;
      try {
        if (handle === undefined) {
          handle = await open(join(stagingDirectory, fileName), 'r+');
          reopened = true;
        }
        await handle.truncate(0);
        await handle.sync();
        const stat = await handle.stat();
        if (stat.size === 0) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      } finally {
        if (reopened && handle !== undefined) await handle.close().catch(() => undefined);
      }
      if (attempt + 1 < PRIVACY_SCRUB_ATTEMPTS) await waitForPrivacyScrubRetry();
    }
    return !await pathExists(join(stagingDirectory, fileName));
  }));
  await Promise.allSettled(artifacts.map(({ handle }) => handle.close()));

  for (let attempt = 0; attempt < PRIVACY_SCRUB_ATTEMPTS; attempt += 1) {
    try {
      await rm(stagingDirectory, {
        recursive: true,
        force: false,
        maxRetries: PRIVACY_SCRUB_ATTEMPTS,
        retryDelay: PRIVACY_SCRUB_RETRY_MS,
      });
      return;
    } catch {
      if (attempt + 1 < PRIVACY_SCRUB_ATTEMPTS) await waitForPrivacyScrubRetry();
    }
  }

  if (!scrubbed.every(Boolean)) throw new ReportWriteError('privacy_scrub_failed');
}

async function writeStagedArtifacts(
  stagingDirectory: string,
  files: readonly string[],
  artifactTexts: ReadonlyMap<string, string>,
  artifacts: StagedArtifactHandle[],
): Promise<void> {
  for (const fileName of files) {
    const handle = await open(join(stagingDirectory, fileName), 'wx+', 0o600);
    artifacts.push({ fileName, handle });
    await handle.writeFile(artifactTexts.get(fileName)!, 'utf8');
    await handle.sync();
  }
}

class ReportWriteError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'ReportWriteError';
    this.reason = reason;
  }
}

function throwIfReportAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = typeof signal.reason === 'object'
    && signal.reason !== null
    && 'reason' in signal.reason
    && (signal.reason.reason === 'interrupted' || signal.reason.reason === 'crashed')
      ? signal.reason.reason
      : 'interrupted';
  throw new ReportWriteError(reason);
}

export function createPerformanceRunId(
  now: Date = new Date(),
  suffix: Uint8Array = randomBytes(4),
): string {
  const timestamp = now.toISOString().replace(/[-:.]/gu, '');
  return `${timestamp}-${Buffer.from(suffix).toString('hex').slice(0, 8)}`;
}

export async function writePerformanceReport(
  input: WritePerformanceReportInput,
): Promise<WritePerformanceReportResult> {
  throwIfReportAborted(input.signal);
  const runId = input.runId ?? createPerformanceRunId();
  if (!SAFE_RUN_ID.test(runId)) throw new Error('invalid_run_id');
  await mkdir(input.outputRoot, { recursive: true });
  const finalDirectory = join(input.outputRoot, runId);
  const stagingDirectory = join(input.outputRoot, `${runId}-staging`);
  const quarantineDirectory = join(input.outputRoot, `${runId}-quarantined`);
  if (await pathExists(finalDirectory)) throw new Error('run_directory_exists');
  if (await pathExists(stagingDirectory) || await pathExists(quarantineDirectory)) {
    throw new Error('run_directory_exists');
  }
  const config = cloneConfig(input.config);
  const target = cloneTarget(input.target);
  const samples = input.samples.map(cloneSample);
  const requests = input.requests.map(cloneRequest);
  const outOfSampleWrites = (input.outOfSampleWrites ?? []).map(cloneBlockedWrite);
  const checkpoint = config.contractCheckpoint
    ? evaluateContractCheckpoint({
        routes: ROUTES,
        samples,
        requests,
        branches: input.checkpointBranches ?? [],
        outOfSampleWrites,
        requireCompleteRegistry: true,
      })
    : null;
  const browser = browserMetadata(config, input.browser);
  const environment = comparisonEnvironment(config, browser, samples);
  const routeMetadata = ROUTES.map((route) => ({
    surfaceId: route.surfaceId,
    surfaceScaleBearing: route.surfaceScaleBearing,
    loadScaleBearing: route.loadScaleBearing,
  }));
  const aggregates = aggregateSamples(samples, routeMetadata);
  const rankings = buildRankings(aggregates);
  let comparison: ComparisonResult | null = null;
  let comparisonStatus: 'not_requested' | 'written' | 'failed' = 'not_requested';
  const partialReason = input.partialReason && FAILURE_REASONS.includes(input.partialReason)
    ? input.partialReason
    : null;
  const safetyFailure = cloneSafetyFailure(input.safetyFailure);

  const summary: Record<string, unknown> = {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    interceptionScopeVersion: INTERCEPTION_SCOPE_VERSION,
    run: { status: partialReason === null ? 'complete' : 'partial', reason: partialReason },
    config,
    target,
    revisions: {
      profilerCommit: target.profilerCommit,
      targetAppCommit: target.targetAppCommit,
    },
    manifest: config.seed,
    browser,
    runtime: runtimeMetadata(),
    environment,
    samples,
    outOfSampleWrites,
    aggregates,
    rankings,
    routeOrders: cloneOrders(input.routeOrders),
    warmup: {
      performed: input.warmup.performed === true,
      surfaceId: input.warmup.surfaceId === null ? null : surfaceId(input.warmup.surfaceId),
    },
    relayDomCheck: input.relayDomCheck === null ? null : {
      expectedCount: integer(input.relayDomCheck.expectedCount),
      renderedCount: integer(input.relayDomCheck.renderedCount),
      shortfall: input.relayDomCheck.shortfall === true,
    },
    ...(safetyFailure !== null && { safetyFailure }),
    ...(input.selfQa !== undefined && { selfQa: serializeSelfQaResult(input.selfQa) }),
    warnings: [] as string[],
    comparison: { status: comparisonStatus },
    artifacts: [] as string[],
  };

  if (input.baselineJson !== undefined) {
    try {
      comparison = compareRuns(parseBaselineJson(input.baselineJson), createComparisonRun(summary));
      comparisonStatus = 'written';
    } catch {
      comparisonStatus = 'failed';
    }
  }

  const files = [
    ...(comparison === null ? [] : ['comparison.json', 'comparison.md']),
    ...(checkpoint === null ? [] : ['contract-observations.json']),
    'report.md',
    'requests.jsonl',
    'summary.json',
  ].sort();
  const warnings = [
    ...(target.targetVersionStatus === 'unverified' ? ['target_version_unverified'] : []),
    ...(samples.some((sample) => sample.clientTruncated) ? ['client_truncated'] : []),
    ...(samples.some((sample) => sample.backgroundRequestCount > 0) ? ['background_noise'] : []),
    ...(requests.some((request) => request.unmatchedApi) ? ['unmatched_api'] : []),
    ...(outOfSampleWrites.length > 0 ? ['out_of_sample_write'] : []),
    ...(partialReason !== null ? ['partial_run'] : []),
    ...(comparisonStatus === 'failed' ? ['comparison_failed'] : []),
  ];
  summary.warnings = warnings;
  summary.comparison = comparisonStatus === 'failed'
    ? { status: 'failed', reason: 'comparison_failed' }
    : { status: comparisonStatus };
  summary.artifacts = files;

  const artifactTexts = new Map<string, string>();
  artifactTexts.set('summary.json', json(summary));
  artifactTexts.set('requests.jsonl', requests.map((row) => JSON.stringify(row)).join('\n') + (requests.length > 0 ? '\n' : ''));
  artifactTexts.set('report.md', reportMarkdown({
    runId,
    config,
    target,
    samples,
    requests,
    aggregates,
    rankings,
    files,
    partialReason,
    comparisonStatus,
    outOfSampleWrites,
    safetyFailure,
  }));
  if (checkpoint !== null) {
    artifactTexts.set('contract-observations.json', json({
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      status: checkpoint.status,
      mismatchCodes: checkpoint.mismatchCodes,
      observations: checkpoint.observations,
      outOfSampleWrites: checkpoint.outOfSampleWrites,
    }));
  }
  if (comparison !== null) {
    artifactTexts.set('comparison.json', json(comparison));
    artifactTexts.set('comparison.md', comparisonMarkdown(comparison));
  }

  const candidateTexts = files.map((fileName) => ({
    fileName,
    text: artifactTexts.get(fileName)!,
  }));
  const preflightPrivacyFailures = scanArtifactFiles(candidateTexts);
  if (preflightPrivacyFailures.length > 0) {
    const reasonCategories = [...new Set(preflightPrivacyFailures.flatMap((failure) => failure.reasonCategories))].sort();
    await mkdir(quarantineDirectory);
    await writeFile(join(quarantineDirectory, 'quarantine.json'), json({
      runId,
      status: 'privacy_failure',
      reason: 'privacy_scan_failed',
      files,
      reasonCategories,
    }), 'utf8');
    return {
      status: 'privacy_failure',
      exitCode: 1,
      runId,
      directoryName: `${runId}-quarantined`,
      files,
      reason: 'privacy_scan_failed',
      reasonCategories,
    };
  }

  await mkdir(stagingDirectory);
  let stagedArtifacts: StagedArtifactHandle[] = [];
  let failureReason = 'artifact_write_failed';
  try {
    await writeStagedArtifacts(stagingDirectory, files, artifactTexts, stagedArtifacts);
    failureReason = 'artifact_scan_failed';
    const stagedTexts = await Promise.all(files.map(async (fileName) => ({
      fileName,
      text: await readFile(join(stagingDirectory, fileName), 'utf8'),
    })));
    const privacyFailures = scanArtifactFiles(stagedTexts);
    if (privacyFailures.length > 0) {
      const reasonCategories = [...new Set(privacyFailures.flatMap((failure) => failure.reasonCategories))].sort();
      await scrubStagingArtifacts(stagingDirectory, files, stagedArtifacts);
      stagedArtifacts = [];
      failureReason = 'privacy_quarantine_failed';
      await mkdir(quarantineDirectory);
      await writeFile(join(quarantineDirectory, 'quarantine.json'), json({
        runId,
        status: 'privacy_failure',
        reason: 'privacy_scan_failed',
        files,
        reasonCategories,
      }), 'utf8');
      return {
        status: 'privacy_failure',
        exitCode: 1,
        runId,
        directoryName: `${runId}-quarantined`,
        files,
        reason: 'privacy_scan_failed',
        reasonCategories,
      };
    }

    await closeStagedArtifactHandles(stagedArtifacts);
    stagedArtifacts = [];
    throwIfReportAborted(input.signal);
    try {
      await rename(stagingDirectory, finalDirectory);
    } catch {
      failureReason = 'artifact_publish_failed';
      throw new ReportWriteError(failureReason);
    }
  } catch (error) {
    try {
      await scrubStagingArtifacts(stagingDirectory, files, stagedArtifacts);
    } catch {
      throw new ReportWriteError('privacy_scrub_failed');
    }
    stagedArtifacts = [];
    throw error instanceof ReportWriteError ? error : new ReportWriteError(failureReason);
  } finally {
    await Promise.allSettled(stagedArtifacts.map(({ handle }) => handle.close()));
  }
  if (partialReason !== null) {
    return { status: 'partial', exitCode: 1, runId, directoryName: runId, files };
  }
  if (comparisonStatus === 'failed') {
    return {
      status: 'comparison_failure',
      exitCode: 1,
      runId,
      directoryName: runId,
      files,
      reason: 'comparison_failed',
    };
  }
  if (checkpoint?.status === 'mismatch') {
    return {
      status: 'checkpoint_mismatch',
      exitCode: 1,
      runId,
      directoryName: runId,
      files,
    };
  }
  if (input.selfQa?.status === 'fail') {
    return {
      status: 'self_qa_mismatch',
      exitCode: 1,
      runId,
      directoryName: runId,
      files,
    };
  }
  return { status: 'written', exitCode: 0, runId, directoryName: runId, files };
}
