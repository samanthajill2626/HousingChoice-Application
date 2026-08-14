import type { PerformanceSelfQaFixtures } from '../../app/src/lib/seed/performance.js';
import {
  assertObservedGets,
  expectedGets,
  computeTourWindow,
  type RouteContractBranch,
  type RouteDefinition,
} from './routes.js';
import type { AggregateRankings, BlockedWrite, RequestEvidence, SampleMode, SampleResult } from './types.js';

export type SelfQaMode = 'narrow' | 'full';
export type SelfQaSurface =
  | 'contact_detail'
  | 'conversation_detail'
  | 'inbox_row'
  | 'unmatched_email'
  | 'tour_group'
  | 'placement_group'
  | 'outbox';

export interface SelfQaApi {
  get(path: string, query?: Readonly<Record<string, string>>): Promise<unknown>;
}

export interface SelfQaFixtureBindings extends PerformanceSelfQaFixtures {
  tour_id: string;
  placement_id: string;
  unmatched_row_index: number;
}

export type SelfQaSnapshot = ReadonlyMap<SelfQaSurface, number | boolean>;

export interface SelfQaStateCheck {
  surface: SelfQaSurface;
  unchanged: boolean;
}

export interface SelfQaAttempt {
  surface: Exclude<SelfQaSurface, 'outbox'>;
  mode: SampleMode | 'supplemental';
  method: BlockedWrite['method'];
  endpointTemplate: string;
  phase: BlockedWrite['phase'];
}

export interface SelfQaBranchObservation {
  surfaceId: string;
  mode: SampleMode;
  repeat: number;
  branch: RouteContractBranch;
}

export interface SelfQaReportProof {
  privacyScanRequired: boolean;
  countManifest: boolean;
  rankings: AggregateRankings;
}

export interface EvaluateSelfQaInput {
  mode: SelfQaMode;
  routes: readonly RouteDefinition[];
  samples: readonly SampleResult[];
  requests: readonly RequestEvidence[];
  branches: readonly SelfQaBranchObservation[];
  attempts: readonly SelfQaAttempt[];
  outOfSampleWrites?: readonly BlockedWrite[];
  stateChecks: readonly SelfQaStateCheck[];
  relayDomCheck: { expectedCount: number; renderedCount: number; shortfall: boolean } | null;
  supplementalSampleCount: number;
  reportProof: SelfQaReportProof;
}

export interface SelfQaResult {
  mode: SelfQaMode;
  status: 'pass' | 'fail';
  routeCount: number;
  sampleCount: number;
  coldOk: number;
  warmOk: number;
  stateChecks: SelfQaStateCheck[];
  outboxUnchanged: boolean;
  endpointSubset: boolean;
  noUnmatchedApi: boolean;
  relayCountMatches: boolean;
  sampleCardinalityMatches: boolean;
  supplementalExcluded: boolean;
  privacyScanRequired: boolean;
  countManifest: boolean;
  coldRanking: boolean;
  warmRanking: boolean;
  writeTuplesMatch: boolean;
  outOfSampleWritesAbsent: boolean;
  inboxSurfaceSetMatches: boolean;
  inboxRequestClassesMatch: boolean;
  inboxNoCursor: boolean;
  inboxPassiveWritesAbsent: boolean;
}

const NARROW_KEYS = Object.freeze([
  '/contacts/tenants',
  '/contacts/:contactId',
  'inbox-all',
  '/conversations/:conversationId',
] as const);

const SURFACE_ORDER: readonly SelfQaSurface[] = Object.freeze([
  'contact_detail',
  'conversation_detail',
  'inbox_row',
  'unmatched_email',
  'tour_group',
  'placement_group',
  'outbox',
]);

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const candidate = object(value)[key];
  return Array.isArray(candidate) ? candidate.map(object) : [];
}

function positiveUnread(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function requireProof(ok: boolean): void {
  if (!ok) throw new Error('self_qa_fixture_proof_failed');
}

export async function proveSelfQaFixtures(
  fixtures: Readonly<PerformanceSelfQaFixtures>,
  api: SelfQaApi,
): Promise<Readonly<SelfQaFixtureBindings>> {
  const fixtureValues = Object.values(fixtures);
  requireProof(fixtureValues.length === 6 && new Set(fixtureValues).size === 6);

  const contact = object((object(await api.get(`/api/contacts/${fixtures.contact_detail}`)))['contact']);
  const contactSource = rows(await api.get('/api/contacts', { type: 'tenant', limit: '100' }), 'contacts');
  const inboxRows = rows(await api.get('/api/inbox', { filter: 'all', limit: '30' }), 'rows');
  const contactRow = inboxRows.find((row) => row.kind === 'contact' && row.contactId === fixtures.contact_detail);
  const inboxRow = inboxRows.find((row) => row.kind === 'contact' && row.contactId === fixtures.inbox_row);
  requireProof(contact.contactId === fixtures.contact_detail && contact.type === 'tenant');
  requireProof(contactSource.some((row) => row.contactId === fixtures.contact_detail && row.type === 'tenant'));
  requireProof(contactRow !== undefined && positiveUnread(contactRow.unreadCount));
  requireProof(inboxRow !== undefined && positiveUnread(inboxRow.unreadCount));

  const conversationRows = await Promise.all([
    fixtures.conversation_detail,
    fixtures.tour_group,
    fixtures.placement_group,
  ].map(async (conversationId) => ({
    conversationId,
    value: object(object(await api.get(`/api/conversations/${conversationId}`)).conversation),
    source: inboxRows.find((row) => row.kind === 'relay_group' && row.conversationId === conversationId),
  })));
  for (const row of conversationRows) {
    requireProof(row.value.conversationId === row.conversationId && row.value.type === 'relay_group');
    requireProof(positiveUnread(row.value.unread_count));
    requireProof(row.source !== undefined && positiveUnread(row.source.unreadCount));
  }

  const tourOwner = object(conversationRows[1]!.value.owner);
  const placementOwner = object(conversationRows[2]!.value.owner);
  requireProof(tourOwner.type === 'tour' && typeof tourOwner.id === 'string' && tourOwner.id.length > 0);
  requireProof(placementOwner.type === 'placement' && typeof placementOwner.id === 'string' && placementOwner.id.length > 0);
  const tourId = tourOwner.id as string;
  const placementId = placementOwner.id as string;
  const tour = object(object(await api.get(`/api/tours/${tourId}`)).tour);
  const placement = object(object(await api.get(`/api/placements/${placementId}`)).placement);
  const tourSource = rows(await api.get('/api/tours', computeTourWindow(new Date())), 'tours');
  const placementSource = rows(await api.get('/api/placements'), 'placements');
  requireProof(tour.tourId === tourId && tour.groupThreadId === fixtures.tour_group);
  requireProof(placement.placementId === placementId && placement.group_thread === fixtures.placement_group);
  requireProof(tourSource.some((row) => row.tourId === tourId));
  requireProof(placementSource.some((row) => row.placementId === placementId));

  const unmatchedRows = rows(await api.get('/api/unmatched-email', { filter: 'unmatched' }), 'rows');
  const unmatchedIndex = unmatchedRows.findIndex((row) => row.unmatchedId === fixtures.unmatched_email);
  requireProof(unmatchedIndex >= 0 && unmatchedRows[unmatchedIndex]?.read === false);

  return Object.freeze({
    contact_detail: fixtures.contact_detail,
    conversation_detail: fixtures.conversation_detail,
    inbox_row: fixtures.inbox_row,
    unmatched_email: fixtures.unmatched_email,
    tour_group: fixtures.tour_group,
    placement_group: fixtures.placement_group,
    tour_id: tourId,
    placement_id: placementId,
    unmatched_row_index: unmatchedIndex,
  });
}

function unreadFromInbox(value: unknown, field: 'contactId' | 'conversationId', id: string): number {
  const row = rows(value, 'rows').find((candidate) => candidate[field] === id);
  if (row === undefined || !positiveUnread(row.unreadCount)) throw new Error('self_qa_snapshot_failed');
  return row.unreadCount as number;
}

function conversationUnread(value: unknown, id: string): number {
  const conversation = object(object(value).conversation);
  if (conversation.conversationId !== id || !positiveUnread(conversation.unread_count)) {
    throw new Error('self_qa_snapshot_failed');
  }
  return conversation.unread_count as number;
}

export async function reduceSelfQaSnapshot(
  bindings: Readonly<SelfQaFixtureBindings>,
  api: SelfQaApi,
): Promise<SelfQaSnapshot> {
  const [inboxPage, contactConversation, conversation, unmatchedPage, tourGroup, placementGroup, outbox] =
    await Promise.all([
      api.get('/api/inbox', { filter: 'all', limit: '30' }),
      api.get(`/api/conversations/${bindings.conversation_detail}`),
      api.get(`/api/conversations/${bindings.conversation_detail}`),
      api.get('/api/unmatched-email', { filter: 'unmatched' }),
      api.get(`/api/conversations/${bindings.tour_group}`),
      api.get(`/api/conversations/${bindings.placement_group}`),
      api.get('/__dev/outbox'),
    ]);
  const unmatched = rows(unmatchedPage, 'rows').find((row) => row.unmatchedId === bindings.unmatched_email);
  const messages = object(outbox).messages;
  if (unmatched === undefined || typeof unmatched.read !== 'boolean' || !Array.isArray(messages)) {
    throw new Error('self_qa_snapshot_failed');
  }
  return new Map<SelfQaSurface, number | boolean>([
    ['contact_detail', unreadFromInbox(inboxPage, 'contactId', bindings.contact_detail)],
    ['conversation_detail', conversationUnread(contactConversation, bindings.conversation_detail)],
    ['inbox_row', unreadFromInbox(inboxPage, 'contactId', bindings.inbox_row)],
    ['unmatched_email', unmatched.read],
    ['tour_group', conversationUnread(tourGroup, bindings.tour_group)],
    ['placement_group', conversationUnread(placementGroup, bindings.placement_group)],
    ['outbox', messages.length],
  ]);
}

export function compareSelfQaSnapshots(
  before: SelfQaSnapshot,
  after: SelfQaSnapshot,
): SelfQaStateCheck[] {
  return SURFACE_ORDER.map((surface) => ({ surface, unchanged: before.get(surface) === after.get(surface) }));
}

export function routesForSelfQa(
  mode: SelfQaMode,
  registry: readonly RouteDefinition[],
): readonly RouteDefinition[] {
  if (mode === 'full') return Object.freeze([...registry]);
  return Object.freeze(NARROW_KEYS.map((key) => {
    const route = registry.find((candidate) => candidate.surfaceId === key);
    if (route === undefined) throw new Error('self_qa_route_missing');
    return route;
  }));
}

function attemptKey(attempt: SelfQaAttempt): string {
  return [attempt.surface, attempt.mode, attempt.method, attempt.endpointTemplate, attempt.phase].join('|');
}

function expectedAttempts(mode: SelfQaMode): SelfQaAttempt[] {
  const attempts: SelfQaAttempt[] = [
    { surface: 'contact_detail', mode: 'cold', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'contact_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'conversation_detail', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'conversation_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'source_click' },
    { surface: 'conversation_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
  ];
  if (mode === 'full') attempts.push(
    { surface: 'tour_group', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'tour_group', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'placement_group', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'placement_group', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'inbox_row', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'source_click' },
    { surface: 'inbox_row', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'unmatched_email', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/unmatched-email/:unmatchedId/read', phase: 'source_click' },
  );
  return attempts;
}

function endpointSubset(input: EvaluateSelfQaInput): boolean {
  for (const sample of input.samples) {
    const route = input.routes.find((candidate) => candidate.surfaceId === sample.surfaceId);
    const branch = input.branches.find((candidate) =>
      candidate.surfaceId === sample.surfaceId && candidate.mode === sample.mode && candidate.repeat === sample.repeat);
    if (route === undefined || branch === undefined) return false;
    const observed = input.requests
      .filter((request) => request.surfaceId === sample.surfaceId && request.mode === sample.mode
        && request.repeat === sample.repeat && request.resourceClass === 'api')
      .map((request) => ({
        endpointTemplate: request.endpointTemplate as never,
        queryKeys: request.queryKeys,
        ...(request.inboxRequestClass !== undefined && { inboxRequestClass: request.inboxRequestClass }),
        requirement: 'required' as const,
        outcome: request.outcome,
      }));
    const endpointResult = assertObservedGets(expectedGets(route, sample.mode, branch.branch), observed);
    if (endpointResult.undeclared.length > 0) return false;
    if (route.behaviorFamily === 'inbox' && endpointResult.missingRequired.length > 0) return false;
  }
  return true;
}

const INBOX_PAGE_CLASSES = Object.freeze({
  'inbox-all': 'inbox_page_all',
  'inbox-unread': 'inbox_page_unread',
  'inbox-unknown': 'inbox_page_unknown',
  'inbox-groups': 'inbox_page_groups',
} as const);

function inboxProof(input: EvaluateSelfQaInput): {
  surfaceSetMatches: boolean;
  requestClassesMatch: boolean;
  noCursor: boolean;
  passiveWritesAbsent: boolean;
} {
  const measured = input.routes.filter((route) => route.behaviorFamily === 'inbox');
  const ids = measured.map((route) => route.surfaceId);
  const expectedIds = Object.keys(INBOX_PAGE_CLASSES);
  const surfaceSetMatches = input.mode === 'full'
    ? ids.length === expectedIds.length && expectedIds.every((id) => ids.includes(id))
    : ids.length === 1 && ids[0] === 'inbox-all';
  const requestClassesMatch = measured.every((route) => input.requests.some((request) =>
    request.surfaceId === route.surfaceId
    && request.inboxRequestClass === INBOX_PAGE_CLASSES[route.surfaceId as keyof typeof INBOX_PAGE_CLASSES],
  ));
  const noCursor = input.requests
    .filter((request) => ids.includes(request.surfaceId))
    .every((request) => !request.queryKeys.includes('cursor'));
  const passiveWritesAbsent = input.samples
    .filter((sample) => ids.includes(sample.surfaceId))
    .every((sample) => sample.blockedWrites.length === 0);
  return { surfaceSetMatches, requestClassesMatch, noCursor, passiveWritesAbsent };
}

function sampleTuple(sample: Pick<SampleResult, 'surfaceId' | 'mode' | 'repeat'>): string {
  return [sample.surfaceId, sample.mode, sample.repeat].join('|');
}

function exactSampleCoverage(input: EvaluateSelfQaInput): boolean {
  const expected = new Set(input.routes.flatMap((route) => [
    sampleTuple({ surfaceId: route.surfaceId, mode: 'cold', repeat: 0 }),
    sampleTuple({ surfaceId: route.surfaceId, mode: 'warm', repeat: 0 }),
  ]));
  const actual = input.samples.map(sampleTuple);
  return actual.length === expected.size
    && new Set(actual).size === expected.size
    && actual.every((tuple) => expected.has(tuple));
}

function inboxRanked(input: EvaluateSelfQaInput, mode: SampleMode): boolean {
  const inboxIds = input.routes
    .filter((route) => route.behaviorFamily === 'inbox')
    .map((route) => route.surfaceId);
  return inboxIds.length > 0 && inboxIds.every((surfaceId) =>
    input.reportProof.rankings[mode].readyMs.some((row) => row.surfaceId === surfaceId && row.successCount > 0));
}

export function attemptsFromSamples(samples: readonly SampleResult[]): SelfQaAttempt[] {
  return samples.flatMap((sample) => {
    const surface: SelfQaAttempt['surface'] | null = sample.surfaceId === '/contacts/:contactId'
      ? 'contact_detail'
      : sample.surfaceId === '/conversations/:conversationId'
        ? 'conversation_detail'
        : sample.surfaceId === '/tours/:tourId'
          ? 'tour_group'
          : sample.surfaceId === '/placements/:placementId'
            ? 'placement_group'
            : null;
    if (surface === null) return [];
    return sample.blockedWrites
      .filter((write) => write.phase !== 'out_of_sample')
      .map((write) => ({ surface, mode: sample.mode, ...write }));
  });
}

export function supplementalAttempts(
  surface: 'inbox_row' | 'unmatched_email',
  writes: readonly BlockedWrite[],
): SelfQaAttempt[] {
  return writes.map((write) => ({
    surface,
    mode: 'supplemental',
    ...write,
  }));
}

export function evaluateSelfQa(input: EvaluateSelfQaInput): SelfQaResult {
  const expected = new Set(expectedAttempts(input.mode).map(attemptKey));
  const actual = new Set(input.attempts.map(attemptKey));
  const writeTuplesMatch = expected.size === actual.size && [...expected].every((key) => actual.has(key));
  const coldOk = input.samples.filter((sample) => sample.mode === 'cold' && sample.status === 'ok').length;
  const warmOk = input.samples.filter((sample) => sample.mode === 'warm' && sample.status === 'ok').length;
  const expectedRoutes = input.mode === 'full' ? 31 : 4;
  const sampleCardinalityMatches = input.routes.length === expectedRoutes
    && input.samples.length === expectedRoutes * 2
    && coldOk === expectedRoutes
    && warmOk === expectedRoutes
    && exactSampleCoverage(input);
  const endpointSubsetValue = endpointSubset(input);
  const inbox = inboxProof(input);
  const noUnmatchedApi = !input.requests.some((request) => request.unmatchedApi);
  const relayCountMatches = input.mode === 'narrow' || (
    input.relayDomCheck !== null
    && !input.relayDomCheck.shortfall
    && input.relayDomCheck.expectedCount === input.relayDomCheck.renderedCount
  );
  const outboxUnchanged = input.stateChecks.find((check) => check.surface === 'outbox')?.unchanged ?? false;
  const stateChecks = input.stateChecks
    .filter((check) => SURFACE_ORDER.includes(check.surface))
    .map((check) => ({ surface: check.surface, unchanged: check.unchanged === true }));
  const stateMatches = stateChecks.length === SURFACE_ORDER.length && stateChecks.every((check) => check.unchanged);
  const supplementalExcluded = input.supplementalSampleCount === 0;
  const outOfSampleWritesAbsent = (input.outOfSampleWrites ?? []).length === 0;
  const coldRanking = inboxRanked(input, 'cold');
  const warmRanking = inboxRanked(input, 'warm');
  const pass = writeTuplesMatch && sampleCardinalityMatches && endpointSubsetValue && noUnmatchedApi
    && relayCountMatches && stateMatches && supplementalExcluded && outOfSampleWritesAbsent
    && inbox.surfaceSetMatches && inbox.requestClassesMatch && inbox.noCursor && inbox.passiveWritesAbsent
    && input.reportProof.privacyScanRequired
    && input.reportProof.countManifest && coldRanking && warmRanking;
  return {
    mode: input.mode,
    status: pass ? 'pass' : 'fail',
    routeCount: input.routes.length,
    sampleCount: input.samples.length,
    coldOk,
    warmOk,
    stateChecks,
    outboxUnchanged,
    endpointSubset: endpointSubsetValue,
    noUnmatchedApi,
    relayCountMatches,
    sampleCardinalityMatches,
    supplementalExcluded,
    privacyScanRequired: input.reportProof.privacyScanRequired,
    countManifest: input.reportProof.countManifest,
    coldRanking,
    warmRanking,
    writeTuplesMatch,
    outOfSampleWritesAbsent,
    inboxSurfaceSetMatches: inbox.surfaceSetMatches,
    inboxRequestClassesMatch: inbox.requestClassesMatch,
    inboxNoCursor: inbox.noCursor,
    inboxPassiveWritesAbsent: inbox.passiveWritesAbsent,
  };
}

export function serializeSelfQaResult(result: SelfQaResult): SelfQaResult {
  return {
    mode: result.mode === 'full' ? 'full' : 'narrow',
    status: result.status === 'pass' ? 'pass' : 'fail',
    routeCount: Number.isSafeInteger(result.routeCount) ? result.routeCount : 0,
    sampleCount: Number.isSafeInteger(result.sampleCount) ? result.sampleCount : 0,
    coldOk: Number.isSafeInteger(result.coldOk) ? result.coldOk : 0,
    warmOk: Number.isSafeInteger(result.warmOk) ? result.warmOk : 0,
    stateChecks: result.stateChecks
      .filter((check) => SURFACE_ORDER.includes(check.surface))
      .map((check) => ({ surface: check.surface, unchanged: check.unchanged === true })),
    outboxUnchanged: result.outboxUnchanged === true,
    endpointSubset: result.endpointSubset === true,
    noUnmatchedApi: result.noUnmatchedApi === true,
    relayCountMatches: result.relayCountMatches === true,
    sampleCardinalityMatches: result.sampleCardinalityMatches === true,
    supplementalExcluded: result.supplementalExcluded === true,
    privacyScanRequired: result.privacyScanRequired === true,
    countManifest: result.countManifest === true,
    coldRanking: result.coldRanking === true,
    warmRanking: result.warmRanking === true,
    writeTuplesMatch: result.writeTuplesMatch === true,
    outOfSampleWritesAbsent: result.outOfSampleWritesAbsent === true,
    inboxSurfaceSetMatches: result.inboxSurfaceSetMatches === true,
    inboxRequestClassesMatch: result.inboxRequestClassesMatch === true,
    inboxNoCursor: result.inboxNoCursor === true,
    inboxPassiveWritesAbsent: result.inboxPassiveWritesAbsent === true,
  };
}
