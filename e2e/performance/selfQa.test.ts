import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PerformanceSelfQaFixtures } from '../../app/src/lib/seed/performance.js';
import type { RequestEvidence, SampleResult } from './types.js';
import { aggregateSamples, buildRankings } from './aggregate.js';
import { expectedGets, resolveBoundSelfQaDetail, ROUTES } from './routes.js';
import { writePerformanceReport } from './report.js';
import {
  compareSelfQaSnapshots,
  attemptsFromSamples,
  supplementalAttempts,
  evaluateSelfQa,
  proveSelfQaFixtures,
  reduceSelfQaSnapshot,
  routesForSelfQa,
  serializeSelfQaResult,
  type SelfQaApi,
  type SelfQaAttempt,
  type SelfQaFixtureBindings,
} from './selfQa.js';

const RAW: PerformanceSelfQaFixtures = Object.freeze({
  contact_detail: 'raw-contact-a',
  conversation_detail: 'raw-conversation-a',
  inbox_row: 'raw-contact-b',
  unmatched_email: 'raw-unmatched-a',
  tour_group: 'raw-conversation-b',
  placement_group: 'raw-conversation-c',
});

const bindings: SelfQaFixtureBindings = Object.freeze({
  ...RAW,
  tour_id: 'raw-tour-a',
  placement_id: 'raw-placement-a',
  unmatched_row_index: 0,
});

function api(values: Readonly<Record<string, unknown>>): SelfQaApi {
  return { get: async (path) => values[path] ?? {} };
}

const inbox = {
  rows: [
    { kind: 'contact', contactId: RAW.contact_detail, unreadCount: 2 },
    { kind: 'contact', contactId: RAW.inbox_row, unreadCount: 2 },
    { kind: 'relay_group', conversationId: RAW.conversation_detail, unreadCount: 2 },
    { kind: 'relay_group', conversationId: RAW.tour_group, unreadCount: 2 },
    { kind: 'relay_group', conversationId: RAW.placement_group, unreadCount: 2 },
  ],
};

function fixtureApi(overrides: Readonly<Record<string, unknown>> = {}): SelfQaApi {
  return api({
    [`/api/contacts/${RAW.contact_detail}`]: { contact: { contactId: RAW.contact_detail, type: 'tenant' } },
    '/api/contacts': { contacts: [{ contactId: RAW.contact_detail, type: 'tenant' }] },
    '/api/inbox': inbox,
    [`/api/conversations/${RAW.conversation_detail}`]: {
      conversation: { conversationId: RAW.conversation_detail, type: 'relay_group', unread_count: 2, owner: { type: null } },
    },
    [`/api/conversations/${RAW.tour_group}`]: {
      conversation: { conversationId: RAW.tour_group, type: 'relay_group', unread_count: 2, owner: { type: 'tour', id: 'raw-tour-a' } },
    },
    [`/api/conversations/${RAW.placement_group}`]: {
      conversation: { conversationId: RAW.placement_group, type: 'relay_group', unread_count: 2, owner: { type: 'placement', id: 'raw-placement-a' } },
    },
    '/api/tours/raw-tour-a': { tour: { tourId: 'raw-tour-a', groupThreadId: RAW.tour_group } },
    '/api/placements/raw-placement-a': { placement: { placementId: 'raw-placement-a', group_thread: RAW.placement_group } },
    '/api/tours': { tours: [{ tourId: 'raw-tour-a' }] },
    '/api/placements': { placements: [{ placementId: 'raw-placement-a' }] },
    '/api/unmatched-email': { rows: [{ unmatchedId: RAW.unmatched_email, read: false }] },
    '/__dev/outbox': { messages: [] },
    ...overrides,
  });
}

function sample(surfaceId: string, mode: 'cold' | 'warm', blockedWrites: SampleResult['blockedWrites'] = []): SampleResult {
  return {
    surfaceId, mode, repeat: 0, status: 'ok', readyMs: 1,
    navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    paint: { fcpMs: null, lcpMs: null }, longTasks: { totalMs: 0, maxMs: 0, count: 0 },
    domElements: 1, apiRequestCount: 0, apiTransferBytes: 0, resourceRequestCount: 0,
    resourceTransferBytes: 0,
    resourceCountsByClass: { document: 0, script: 0, style: 0, font: 0, image: 0, api: 0, other: 0 },
    backgroundRequestCount: 0, backgroundTransferBytes: 0, blockedWrites,
    consoleCategories: {}, clientTruncated: false, terminalState: 'populated', surfaceEvidence: null, reason: null,
  };
}

function request(surfaceId: string, mode: 'cold' | 'warm', endpointTemplate: string): RequestEvidence {
  return {
    surfaceId, mode, repeat: 0, method: 'GET', resourceClass: 'api', originClass: 'first_party',
    endpointTemplate, queryKeys: [], startOffsetMs: 0, durationMs: 1, ttfbMs: 1, status: 200,
    transferBytes: 1, outcome: 'finished', requestRole: 'required', unmatchedApi: false,
  };
}

const branches = ROUTES.flatMap((route) => (['cold', 'warm'] as const).map((mode) => ({
  surfaceId: route.surfaceId,
  mode,
  repeat: 0,
  branch: route.surfaceId === '/contacts/:contactId'
    ? ({ kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 } as const)
    : route.surfaceId === '/listings/:unitId'
      ? ({ kind: 'unit_detail', hasLandlord: true } as const)
      : route.surfaceId === '/tours/:tourId' || route.surfaceId === '/placements/:placementId'
        ? ({ kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true } as const)
        : ({ kind: 'none' } as const),
})));

function expectedAttempts(mode: 'narrow' | 'full'): SelfQaAttempt[] {
  const rows: SelfQaAttempt[] = [
    { surface: 'contact_detail', mode: 'cold', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'contact_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'conversation_detail', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'conversation_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'source_click' },
    { surface: 'conversation_detail', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
  ];
  if (mode === 'full') rows.push(
    { surface: 'tour_group', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'tour_group', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'placement_group', mode: 'cold', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'placement_group', mode: 'warm', method: 'POST', endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' },
    { surface: 'inbox_row', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'source_click' },
    { surface: 'inbox_row', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' },
    { surface: 'unmatched_email', mode: 'supplemental', method: 'POST', endpointTemplate: '/api/unmatched-email/:unmatchedId/read', phase: 'source_click' },
  );
  return rows;
}

function reportProof(samples: readonly SampleResult[]) {
  return {
    privacyScanRequired: true,
    countManifest: true,
    rankings: buildRankings(aggregateSamples(samples)),
  };
}

function evaluateFullEndpointRoles(extraRequests: readonly RequestEvidence[]) {
  const samples = ROUTES.flatMap((route) =>
    (['cold', 'warm'] as const).map((mode) => sample(route.surfaceId, mode)));
  const requiredRequests = branches.flatMap((observation) => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === observation.surfaceId)!;
    return expectedGets(route, observation.mode, observation.branch).map((contract) => ({
      ...request(route.surfaceId, observation.mode, contract.endpointTemplate),
      queryKeys: [...contract.queryKeys],
      ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
    }));
  });
  return evaluateSelfQa({
    mode: 'full', routes: ROUTES, samples, requests: [...requiredRequests, ...extraRequests], branches,
    attempts: expectedAttempts('full'),
    stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox']
      .map((surface) => ({ surface, unchanged: true })) as never,
    relayDomCheck: { expectedCount: 20, renderedCount: 20, shortfall: false },
    supplementalSampleCount: 0, reportProof: reportProof(samples),
  });
}

describe('self-QA fixture and state guardian', () => {
  it('proves all six private fixtures, source links, owners, backrefs, unread state, and separation', async () => {
    await expect(proveSelfQaFixtures(RAW, fixtureApi())).resolves.toEqual(bindings);
  });

  it.each([
    ['missing link', { '/api/contacts': { contacts: [] } }],
    ['wrong owner', { [`/api/conversations/${RAW.tour_group}`]: { conversation: { conversationId: RAW.tour_group, type: 'relay_group', unread_count: 2, owner: { type: 'placement', id: 'raw-tour-a' } } } }],
    ['read fixture', { '/api/unmatched-email': { rows: [{ unmatchedId: RAW.unmatched_email, read: true }] } }],
  ])('rejects fixture proof when %s differs', async (_name, overrides) => {
    await expect(proveSelfQaFixtures(RAW, fixtureApi(overrides))).rejects.toThrow('self_qa_fixture_proof_failed');
  });

  it('rejects pairwise fixture aliasing', async () => {
    await expect(proveSelfQaFixtures({ ...RAW, inbox_row: RAW.contact_detail }, fixtureApi())).rejects.toThrow(
      'self_qa_fixture_proof_failed',
    );
  });

  it('reduces only the named six scalars and outbox count, then reports safe unchanged booleans', async () => {
    const before = await reduceSelfQaSnapshot(bindings, fixtureApi());
    expect([...before.values()]).toEqual([2, 2, 2, false, 2, 2, 0]);
    const safe = compareSelfQaSnapshots(before, new Map(before));
    expect(safe.every((row) => row.unchanged)).toBe(true);
    const serialized = JSON.stringify(safe);
    for (const raw of Object.values(bindings).filter((value) => typeof value === 'string')) {
      expect(serialized).not.toContain(raw);
    }
  });

  it('reports a before/after mismatch without either value', async () => {
    const before = await reduceSelfQaSnapshot(bindings, fixtureApi());
    const after = new Map(before);
    after.set('inbox_row', 0);
    expect(compareSelfQaSnapshots(before, after)).toContainEqual({ surface: 'inbox_row', unchanged: false });
    expect(JSON.stringify(compareSelfQaSnapshots(before, after))).not.toContain('2');
  });

  it('binds the four self-QA detail resolvers to the private fixture paths', async () => {
    const dom = { hasExactLink: async () => true, browserNow: async () => new Date() };
    await expect(resolveBoundSelfQaDetail('/contacts/:contactId', bindings, dom)).resolves.toMatchObject({
      kind: 'resolved', coldPath: `/contacts/${bindings.contact_detail}`,
      branch: { kind: 'contact_detail', contactType: 'tenant' },
    });
    await expect(resolveBoundSelfQaDetail('/conversations/:conversationId', bindings, dom)).resolves.toMatchObject({
      kind: 'resolved', coldPath: `/conversations/${bindings.conversation_detail}`,
    });
    await expect(resolveBoundSelfQaDetail('/tours/:tourId', bindings, dom)).resolves.toMatchObject({
      kind: 'resolved', coldPath: `/tours/${bindings.tour_id}`, branch: { kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true },
    });
    await expect(resolveBoundSelfQaDetail('/placements/:placementId', bindings, dom)).resolves.toMatchObject({
      kind: 'resolved', coldPath: `/placements/${bindings.placement_id}`, branch: { kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true },
    });
  });
});

describe('self-QA closed proof evaluator', () => {
  it('selects the exact narrow subset and the full 31-route registry', () => {
    expect(routesForSelfQa('narrow', ROUTES).map((route) => route.surfaceId)).toEqual([
      '/contacts/tenants', '/contacts/:contactId', 'inbox-all', '/conversations/:conversationId',
    ]);
    expect(routesForSelfQa('full', ROUTES)).toHaveLength(31);
  });

  it('accepts exact tuple sets, including both legitimate warm conversation phases and duplicates', () => {
    const attempts = [...expectedAttempts('full'), expectedAttempts('full')[4]!];
    const samples = ROUTES.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm')));
    const requests = ROUTES.filter((route) => route.behaviorFamily === 'inbox').flatMap((route) =>
      (['cold', 'warm'] as const).flatMap((mode) => expectedGets(route, mode, { kind: 'none' }).map((contract) => ({
        ...request(route.surfaceId, mode, contract.endpointTemplate), queryKeys: [...contract.queryKeys],
        ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
      }))));
    const result = evaluateSelfQa({
      mode: 'full', routes: ROUTES, samples, requests, branches,
      attempts, stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox'].map((surface) => ({ surface, unchanged: true })) as never,
      relayDomCheck: { expectedCount: 20, renderedCount: 20, shortfall: false },
      supplementalSampleCount: 0, reportProof: reportProof(samples),
    });
    expect(result.status).toBe('pass');
    expect(result.writeTuplesMatch).toBe(true);
    expect(result.sampleCount).toBe(62);
  });

  it('rejects a missing inbox-unknown pair even when duplicate inbox-all samples preserve 62 total samples', () => {
    const exact = ROUTES.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm')));
    const removed = exact.filter((entry) => entry.surfaceId !== 'inbox-unknown');
    const duplicate = exact.filter((entry) => entry.surfaceId === 'inbox-all');
    const samples = [...removed, ...duplicate];
    const requests = ROUTES.filter((route) => route.behaviorFamily === 'inbox').flatMap((route) =>
      (['cold', 'warm'] as const).flatMap((mode) => expectedGets(route, mode, { kind: 'none' }).map((contract) => ({
        ...request(route.surfaceId, mode, contract.endpointTemplate), queryKeys: [...contract.queryKeys],
        ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
      }))));
    const result = evaluateSelfQa({
      mode: 'full', routes: ROUTES, samples, requests, branches, attempts: expectedAttempts('full'),
      stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox'].map((surface) => ({ surface, unchanged: true })) as never,
      relayDomCheck: { expectedCount: 20, renderedCount: 20, shortfall: false },
      supplementalSampleCount: 0, reportProof: reportProof(samples),
    });

    expect(result).toMatchObject({
      status: 'fail', sampleCount: 62, coldOk: 31, warmOk: 31,
      sampleCardinalityMatches: false, coldRanking: false, warmRanking: false,
    });
  });

  it('keeps shared-path self-QA samples and requests joined by surface identity', () => {
    const inbox = ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
    const routes = ['/inbox-all', '/inbox-unread', '/inbox-recent', '/inbox-assigned'].map((surfaceId) => ({ ...inbox, surfaceId }));
    const samples = routes.flatMap((route) => (['cold', 'warm'] as const).map((mode) => sample(route.surfaceId, mode)));
    const branches = routes.flatMap((route) => (['cold', 'warm'] as const).map((mode) => ({
      surfaceId: route.surfaceId, mode, repeat: 0, branch: { kind: 'none' as const },
    })));
    const requests = routes.flatMap((route) => (['cold', 'warm'] as const).flatMap((mode) =>
      expectedGets(route, mode, { kind: 'none' }).map((contract) => ({
        ...request(route.surfaceId, mode, contract.endpointTemplate), queryKeys: [...contract.queryKeys],
        ...(contract.inboxRequestClass !== undefined && { inboxRequestClass: contract.inboxRequestClass }),
      }))));
    const result = evaluateSelfQa({
      mode: 'narrow', routes, samples, requests, branches, attempts: expectedAttempts('narrow'),
      stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox'].map((surface) => ({ surface, unchanged: true })) as never,
      relayDomCheck: null, supplementalSampleCount: 0,
      reportProof: reportProof(samples),
    });

    expect(result).toMatchObject({ endpointSubset: true, sampleCardinalityMatches: true, inboxSurfaceSetMatches: false, status: 'fail' });
    const missingPage = evaluateSelfQa({
      mode: 'narrow', routes, samples,
      requests: requests.filter((entry) => entry.inboxRequestClass !== 'inbox_page_all'),
      branches, attempts: expectedAttempts('narrow'),
      stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox'].map((surface) => ({ surface, unchanged: true })) as never,
      relayDomCheck: null, supplementalSampleCount: 0,
      reportProof: reportProof(samples),
    });
    expect(missingPage.endpointSubset).toBe(false);
  });

  it('accepts declared background refresh while retaining all required endpoint proof', () => {
    const backgroundRefresh = {
      ...request('/contacts/tenants', 'warm', '/api/conversations'),
      requestRole: 'background_refresh' as const,
    };
    expect(evaluateFullEndpointRoles([backgroundRefresh])).toMatchObject({
      endpointSubset: true,
      status: 'pass',
    });
  });

  it('rejects an undeclared required endpoint shape', () => {
    const undeclaredRequired = request('/contacts/tenants', 'warm', '/api/settings');
    expect(evaluateFullEndpointRoles([undeclaredRequired])).toMatchObject({
      endpointSubset: false,
      status: 'fail',
    });
  });

  it.each([
    ['background_refresh', '/api/settings'],
    ['background_shell', '/api/tours'],
  ] as const)('fails closed on an undeclared %s endpoint shape', (requestRole, endpointTemplate) => {
    const undeclaredBackground = {
      ...request('/contacts/tenants', 'warm', endpointTemplate),
      requestRole,
    };
    expect(evaluateFullEndpointRoles([undeclaredBackground])).toMatchObject({
      endpointSubset: false,
      status: 'fail',
    });
  });

  it('preserves observed warm phases instead of manufacturing a source-click attempt', () => {
    const writes = [
      { method: 'POST' as const, endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' as const },
      { method: 'POST' as const, endpointTemplate: '/api/conversations/:conversationId/read', phase: 'destination_mount' as const },
    ];
    expect(attemptsFromSamples([sample('/conversations/:conversationId', 'warm', writes)])).toEqual([
      { surface: 'conversation_detail', mode: 'warm', ...writes[0] },
      { surface: 'conversation_detail', mode: 'warm', ...writes[1] },
    ]);
  });

  it('keeps out-of-sample writes out of surface tuples and fails their dedicated proof', () => {
    const writes = [{
      method: 'POST' as const,
      endpointTemplate: '/api/inbox/:contactId/read',
      phase: 'out_of_sample' as const,
    }];
    expect(attemptsFromSamples([sample('/contacts/:contactId', 'warm', writes)])).toEqual([]);
    const samples = ROUTES.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm')));
    const result = evaluateSelfQa({
      mode: 'full', routes: ROUTES, samples, requests: [], branches,
      attempts: expectedAttempts('full'),
      outOfSampleWrites: writes,
      stateChecks: ['contact_detail', 'conversation_detail', 'inbox_row', 'unmatched_email', 'tour_group', 'placement_group', 'outbox'].map((surface) => ({ surface, unchanged: true })) as never,
      relayDomCheck: { expectedCount: 20, renderedCount: 20, shortfall: false },
      supplementalSampleCount: 0,
      reportProof: reportProof(samples),
    });
    expect(result.status).toBe('fail');
    expect(result.outOfSampleWritesAbsent).toBe(false);
    expect(result.writeTuplesMatch).toBe(true);
  });

  it('preserves supplemental phases while keeping unmatched source-only', () => {
    const duplicateDestination = [
      { method: 'POST' as const, endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' as const },
      { method: 'POST' as const, endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' as const },
    ];
    expect(supplementalAttempts('inbox_row', duplicateDestination).map((row) => row.phase)).toEqual([
      'destination_mount', 'destination_mount',
    ]);
    expect(supplementalAttempts('unmatched_email', [{
      method: 'POST', endpointTemplate: '/api/unmatched-email/:unmatchedId/read', phase: 'source_click',
    }])).toHaveLength(1);
  });

  it.each([
    ['missing', (rows: SelfQaAttempt[]) => rows.slice(1)],
    ['wrong', (rows: SelfQaAttempt[]) => rows.map((row, index) => index === 0 ? { ...row, phase: 'source_click' as const } : row)],
    ['unexpected', (rows: SelfQaAttempt[]) => [...rows, { surface: 'contact_detail' as const, mode: 'cold' as const, method: 'POST' as const, endpointTemplate: '/api/inbox/read', phase: 'destination_mount' as const }]],
  ])('rejects %s blocked attempt sets', (_name, mutate) => {
    const selected = routesForSelfQa('narrow', ROUTES);
    const samples = selected.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm')));
    const result = evaluateSelfQa({
      mode: 'narrow', routes: selected, samples, requests: [], branches: branches.filter((row) => selected.some((route) => route.surfaceId === row.surfaceId)),
      attempts: mutate(expectedAttempts('narrow')), stateChecks: [], relayDomCheck: null, supplementalSampleCount: 0,
      reportProof: reportProof(samples),
    });
    expect(result.status).toBe('fail');
    expect(result.writeTuplesMatch).toBe(false);
  });

  it('rejects endpoint mismatch, unmatched API, relay mismatch, outbox delta, non-ok full samples, and supplemental ranking leakage', () => {
    const samples = ROUTES.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm')));
    samples[0] = { ...samples[0]!, status: 'timeout', reason: 'ready_timeout' };
    const badRequest = request('/', 'cold', '/api/not-declared');
    badRequest.unmatchedApi = true;
    const result = evaluateSelfQa({
      mode: 'full', routes: ROUTES, samples, requests: [badRequest], branches, attempts: expectedAttempts('full'),
      stateChecks: [{ surface: 'outbox', unchanged: false }],
      relayDomCheck: { expectedCount: 20, renderedCount: 19, shortfall: true }, supplementalSampleCount: 1,
      reportProof: { ...reportProof(samples), countManifest: false },
    });
    expect(result).toMatchObject({
      status: 'fail', endpointSubset: false, noUnmatchedApi: false, relayCountMatches: false,
      outboxUnchanged: false, sampleCardinalityMatches: false, supplementalExcluded: false,
      countManifest: false, coldRanking: true, warmRanking: true,
    });
  });

  it('requires exact 62 full samples and serializes only allowlisted self-QA status', () => {
    const samples = ROUTES.flatMap((route) => ['cold', 'warm'].map((mode) => sample(route.surfaceId, mode as 'cold' | 'warm'))).slice(0, 55);
    const result = evaluateSelfQa({
      mode: 'full', routes: ROUTES, samples, requests: [], branches, attempts: expectedAttempts('full'),
      stateChecks: [], relayDomCheck: null, supplementalSampleCount: 0,
      reportProof: reportProof(samples),
    });
    expect(result.sampleCardinalityMatches).toBe(false);
    const safe = serializeSelfQaResult({ ...result, injectedRaw: 'raw-contact-a' } as never);
    expect(JSON.stringify(safe)).not.toContain('raw-contact-a');
    expect(Object.keys(safe).sort()).toEqual([
      'coldOk', 'coldRanking', 'countManifest', 'endpointSubset',
      'inboxNoCursor', 'inboxPassiveWritesAbsent', 'inboxRequestClassesMatch', 'inboxSurfaceSetMatches',
      'mode', 'noUnmatchedApi',
      'outOfSampleWritesAbsent', 'outboxUnchanged', 'privacyScanRequired', 'relayCountMatches', 'routeCount',
      'sampleCardinalityMatches', 'sampleCount', 'stateChecks', 'status', 'supplementalExcluded', 'warmOk', 'warmRanking', 'writeTuplesMatch',
    ]);
  });

  it('writes the allowlisted self-QA proof and exits nonzero on a failed proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hc-self-qa-report-'));
    try {
      const base = {
        outputRoot: root,
        config: {
          target: 'hermetic', browserChannel: 'chromium', headed: false, coldRepeats: 1, warmRepeats: 1,
          readyTimeoutMs: 1, sourceTimeoutMs: 1, loginTimeoutMs: 1, settleMs: 1, pollMs: 1,
          routeOrderSeed: 1, contractCheckpoint: false, selfQa: 'narrow', seed: null,
        },
        target: { target: 'hermetic', proof: 'hermetic_lane', profilerCommit: 'abcdef1', targetAppCommit: '1234567', targetVersionStatus: 'verified' },
        samples: [], requests: [], routeOrders: [], browser: { version: '1', viewport: { width: 1280, height: 720 } },
        warmup: { performed: true, surfaceId: '/' }, relayDomCheck: null,
      } as const;
      const proof = serializeSelfQaResult({
        mode: 'narrow', status: 'pass', routeCount: 4, sampleCount: 8, coldOk: 4, warmOk: 4,
        stateChecks: [], outboxUnchanged: true, endpointSubset: true, noUnmatchedApi: true,
        relayCountMatches: true, sampleCardinalityMatches: true, supplementalExcluded: true,
        privacyScanRequired: true, countManifest: true, coldRanking: true, warmRanking: true,
        writeTuplesMatch: true,
        outOfSampleWritesAbsent: true,
        inboxSurfaceSetMatches: true, inboxRequestClassesMatch: true, inboxNoCursor: true, inboxPassiveWritesAbsent: true,
      });
      const written = await writePerformanceReport({ ...base, runId: '20260812T120000000Z-12345678', selfQa: proof } as never);
      expect(written.exitCode).toBe(0);
      const summary = await readFile(join(root, written.directoryName, 'summary.json'), 'utf8');
      expect(JSON.parse(summary).selfQa).toEqual(proof);
      const failed = await writePerformanceReport({
        ...base, runId: '20260812T120000001Z-12345678', selfQa: { ...proof, status: 'fail' },
      } as never);
      expect(failed).toMatchObject({ status: 'self_qa_mismatch', exitCode: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
