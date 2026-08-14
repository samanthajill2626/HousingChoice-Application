import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_REFRESH_GETS,
  NetworkCollector,
  classifyInboxRequest,
  classifyConsoleMessage,
  collectColdSample,
  collectRunSamples,
  collectWarmSample,
  createEmptyResourceCounts,
  deterministicRouteOrder,
  summarizePageMetrics,
  validateObservedRequestRoles,
  type SampleBrowser,
  type SampleBrowserContext,
  type SampleInstrumentation,
  type SamplePage,
} from './collect.js';
import {
  ROUTES,
  type EndpointContract,
  type ExactBrowserTarget,
  type ResolverResult,
  type RouteContractBranch,
  type RouteDefinition,
} from './routes.js';
import type { InMemoryStorageState } from './auth.js';
import type { BlockedWrite, SampleResult, TargetKind } from './types.js';

const REQUIRED_CONTACTS: EndpointContract[] = [{
  endpointTemplate: '/api/contacts', queryKeys: ['limit', 'type'], requirement: 'required',
}];

function collector(mode: 'cold' | 'warm' = 'cold', expectedGets: readonly EndpointContract[] = REQUIRED_CONTACTS): NetworkCollector {
  const value = new NetworkCollector({
    firstPartyOrigin: 'http://127.0.0.1:9111', surfaceId: '/contacts/tenants', mode, repeat: 0, expectedGets,
  });
  value.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
  return value;
}

function start(
  value: NetworkCollector,
  requestId: string,
  timestamp: number,
  url: string,
  type = 'Fetch',
): void {
  value.requestWillBeSent('sample-1', {
    requestId, timestamp, type, request: { method: 'GET', url },
  });
}

describe('CDP request collection', () => {
  it('derives relative TTFB, duration, encoded bytes, and finished outcome without fetching a body', () => {
    const value = collector();
    const body = vi.fn();
    start(value, 'r1', 10.25, 'http://127.0.0.1:9111/api/contacts?type=tenant&limit=100');
    value.responseReceived('sample-1', { requestId: 'r1', timestamp: 10.4, response: { status: 200, body } });
    value.loadingFinished('sample-1', { requestId: 'r1', timestamp: 10.75, encodedDataLength: 321 });

    expect(value.endSample('sample-1').requests).toEqual([expect.objectContaining({
      startOffsetMs: 250, ttfbMs: 150, durationMs: 500, transferBytes: 321,
      status: 200, outcome: 'finished', endpointTemplate: '/api/contacts',
      queryKeys: ['limit', 'type'], requestRole: 'required',
    })]);
    expect(body).not.toHaveBeenCalled();
  });

  it('clears pending on failure and distinguishes canceled from failed', () => {
    const value = collector();
    start(value, 'abort', 10.1, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
    start(value, 'fail', 10.2, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
    expect(value.snapshot('sample-1').pendingCount).toBe(2);
    value.loadingFailed('sample-1', { requestId: 'abort', timestamp: 10.3, canceled: true });
    value.loadingFailed('sample-1', { requestId: 'fail', timestamp: 10.5, canceled: false });

    const ended = value.endSample('sample-1');
    expect(ended.pendingCount).toBe(0);
    expect(ended.requests.map((row) => row.outcome)).toEqual(['aborted', 'failed']);
    expect(ended.requests.map((row) => [row.status, row.transferBytes])).toEqual([[null, null], [null, null]]);
    expect(ended.satisfiedRequired).toEqual([]);
  });

  it('retains sanitized evidence for a request still in flight at sample timeout', () => {
    const value = collector();
    start(value, 'hung', 10.25, 'http://127.0.0.1:9111/api/contacts?type=tenant&limit=100');

    const ended = value.endSample('sample-1');
    expect(ended.requestCount).toBe(1);
    expect(ended.requests).toEqual([expect.objectContaining({
      endpointTemplate: '/api/contacts',
      queryKeys: ['limit', 'type'],
      startOffsetMs: 250,
      durationMs: null,
      ttfbMs: null,
      status: null,
      transferBytes: null,
      outcome: 'failed',
      requestRole: 'required',
    })]);
  });

  it('does not flush another sample token and preserves the active request', () => {
    const value = collector();
    start(value, 'hung', 10.25, 'http://127.0.0.1:9111/api/contacts?type=tenant&limit=100');

    expect(value.endSample('stale-token')).toMatchObject({ requestCount: 0, requests: [] });
    expect(value.snapshot('sample-1').pendingCount).toBe(1);
    expect(value.endSample('sample-1')).toMatchObject({ requestCount: 1 });
  });

  it('retains both redirect hops without overwriting the first hop timing', () => {
    const value = collector();
    value.requestWillBeSent('sample-1', {
      requestId: 'redirect', timestamp: 10.1, type: 'Fetch',
      request: { method: 'GET', url: 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant' },
    });
    value.requestWillBeSent('sample-1', {
      requestId: 'redirect', timestamp: 10.3, type: 'Fetch',
      redirectResponse: { status: 302 },
      request: { method: 'GET', url: 'http://127.0.0.1:9111/api/contacts?cursor=next&limit=100&type=tenant' },
    });
    value.loadingFinished('sample-1', { requestId: 'redirect', timestamp: 10.6, encodedDataLength: 40 });

    expect(value.endSample('sample-1').requests).toEqual([
      expect.objectContaining({ startOffsetMs: 100, durationMs: 200, status: 302, outcome: 'finished' }),
      expect.objectContaining({ startOffsetMs: 300, durationMs: 300, status: null, outcome: 'finished' }),
    ]);
  });

  it('counts static, third-party, unknown API, and aborted starts by resource class but sums actual bytes only', () => {
    const value = collector();
    start(value, 'script', 10.1, 'http://127.0.0.1:9111/src/main.tsx', 'Script');
    start(value, 'third', 10.2, 'https://identity.example.test/avatar', 'Image');
    start(value, 'unknown', 10.3, 'http://127.0.0.1:9111/api/new-secret/abc', 'Fetch');
    value.loadingFailed('sample-1', { requestId: 'script', timestamp: 10.4, canceled: true });
    value.loadingFinished('sample-1', { requestId: 'third', timestamp: 10.5, encodedDataLength: 50 });
    value.loadingFinished('sample-1', { requestId: 'unknown', timestamp: 10.6, encodedDataLength: 70 });

    const ended = value.endSample('sample-1');
    expect(ended.resourceCountsByClass).toMatchObject({ script: 1, image: 1, api: 1 });
    expect(ended.resourceTransferBytes).toBe(120);
    expect(ended.requests.find((row) => row.endpointTemplate === 'unmatched_api')).toMatchObject({ unmatchedApi: true });
  });

  it('excludes the exact event stream before pending and evidence creation', () => {
    const value = collector();
    start(value, 'sse', 10.1, 'http://127.0.0.1:9111/api/events');
    expect(value.snapshot('sample-1')).toMatchObject({ pendingCount: 0, requestCount: 0 });
    expect(value.endSample('sample-1').requests).toEqual([]);
  });

  it('rejects stale tokens and CDP events before the sample-native cutoff', () => {
    const value = collector();
    start(value, 'old-clock', 9.9, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
    value.requestWillBeSent('old-token', {
      requestId: 'old-token', timestamp: 11, type: 'Fetch',
      request: { method: 'GET', url: 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant' },
    });
    expect(value.endSample('sample-1').requests).toEqual([]);
  });

  it('keeps five aborted contact-file starts visible, then satisfies only the live batch', () => {
    const value = collector();
    for (let index = 0; index < 5; index += 1) {
      start(value, `dead-${index}`, 10.1 + index / 100, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
      value.loadingFailed('sample-1', { requestId: `dead-${index}`, timestamp: 10.2 + index / 100, canceled: true });
    }
    start(value, 'live', 10.3, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
    value.responseReceived('sample-1', { requestId: 'live', timestamp: 10.4, response: { status: 200 } });
    value.loadingFinished('sample-1', { requestId: 'live', timestamp: 10.5, encodedDataLength: 40 });

    const ended = value.endSample('sample-1');
    expect(ended.requests).toHaveLength(6);
    expect(ended.requests.filter((row) => row.outcome === 'aborted')).toHaveLength(5);
    expect(ended.resourceCountsByClass.api).toBe(6);
    expect(ended.satisfiedRequired).toEqual(['/api/contacts?limit&type']);
  });

  it('atomically drops source GETs, warnings, blocked writes, pending IDs, and prior origins at beginSample', () => {
    const value = collector('warm');
    start(value, 'source-get', 10.1, 'http://127.0.0.1:9111/api/contacts?limit=100&type=tenant');
    value.noteConsole('sample-1', 'warning', 'useContacts: page cap (40) hit for type=tenant', 1_100);
    value.noteBlockedWrite('sample-1', {
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'source_click',
    });
    value.beginSample({ token: 'destination', cdpOriginSeconds: 20, nodeOriginMs: 2_000 });
    value.loadingFailed('sample-1', { requestId: 'source-get', timestamp: 20.1, canceled: true });

    expect(value.endSample('destination')).toMatchObject({
      pendingCount: 0, requests: [], consoleCategories: {}, blockedWrites: [],
      resourceRequestCount: 0, backgroundRequestCount: 0,
    });
  });
});

describe('checked-in background policy', () => {
  it('uses the class-qualified cold badge identity for completion and later shell refreshes on standard routes', () => {
    const firstPartyOrigin = 'http://127.0.0.1:9111';
    const badge = 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=100';
    const expected: EndpointContract[] = [{
      endpointTemplate: '/api/inbox',
      queryKeys: ['filter', 'limit'],
      requirement: 'required',
      inboxRequestClass: 'inbox_badge',
    }];

    const cold = new NetworkCollector({
      firstPartyOrigin,
      surfaceId: '/contacts/tenants',
      behaviorFamily: 'standard',
      mode: 'cold',
      repeat: 0,
      expectedGets: expected,
    });
    cold.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    start(cold, 'badge-first', 10.1, badge);
    cold.loadingFinished('sample-1', { requestId: 'badge-first', timestamp: 10.2, encodedDataLength: 20 });
    cold.markTerminalVisible('sample-1');
    start(cold, 'badge-refresh', 10.3, badge);
    cold.loadingFinished('sample-1', { requestId: 'badge-refresh', timestamp: 10.4, encodedDataLength: 30 });
    const ended = cold.endSample('sample-1');
    expect(ended.requests.map((request) => [
      request.inboxRequestClass,
      request.requestRole,
      request.unmatchedApi,
    ])).toEqual([
      ['inbox_badge', 'required', false],
      ['inbox_badge', 'background_shell', false],
    ]);
    expect(ended.satisfiedRequired).toEqual(['/api/inbox?filter&limit#inbox_badge']);
    expect([ended.apiRequestCount, ended.apiTransferBytes]).toEqual([1, 20]);
    expect([ended.backgroundRequestCount, ended.backgroundTransferBytes]).toEqual([1, 30]);

    const warm = new NetworkCollector({
      firstPartyOrigin,
      surfaceId: '/contacts/tenants',
      behaviorFamily: 'standard',
      mode: 'warm',
      repeat: 0,
      expectedGets: [],
    });
    warm.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    start(warm, 'badge', 10.1, badge);
    warm.loadingFinished('sample-1', { requestId: 'badge', timestamp: 10.2, encodedDataLength: 20 });
    expect(warm.endSample('sample-1').requests).toEqual([
      expect.objectContaining({
        inboxRequestClass: 'inbox_badge',
        requestRole: 'background_shell',
        unmatchedApi: false,
      }),
    ]);
  });

  it('keeps unread page traffic distinct from the standard-route badge completion identity', () => {
    const firstPartyOrigin = 'http://127.0.0.1:9111';
    const value = new NetworkCollector({
      firstPartyOrigin,
      surfaceId: '/contacts/tenants',
      behaviorFamily: 'standard',
      mode: 'cold',
      repeat: 0,
      expectedGets: [{
        endpointTemplate: '/api/inbox',
        queryKeys: ['filter', 'limit'],
        requirement: 'required',
        inboxRequestClass: 'inbox_badge',
      }],
    });
    value.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    start(value, 'unread-page', 10.1, 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=30');
    value.loadingFinished('sample-1', { requestId: 'unread-page', timestamp: 10.2, encodedDataLength: 20 });

    const ended = value.endSample('sample-1');
    expect(ended.requests).toEqual([
      expect.objectContaining({
        inboxRequestClass: 'inbox_page_unread',
        requestRole: 'required',
        unmatchedApi: true,
      }),
    ]);
    expect(ended.satisfiedRequired).toEqual([]);
  });

  it('classifies closed Inbox page and badge tuples before evidence redaction', () => {
    const firstPartyOrigin = 'http://127.0.0.1:9111';
    const unreadPage = 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=30';
    const badge = 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=100';
    expect(classifyInboxRequest(unreadPage, {
      endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], originClass: 'first_party', resourceClass: 'api', unmatchedApi: false,
    })).toBe('inbox_page_unread');
    expect(classifyInboxRequest(badge, {
      endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], originClass: 'first_party', resourceClass: 'api', unmatchedApi: false,
    })).toBe('inbox_badge');
    expect(classifyInboxRequest('http://127.0.0.1:9111/api/inbox?filter=unread&filter=all&limit=30', {
      endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], originClass: 'first_party', resourceClass: 'api', unmatchedApi: false,
    })).toBe('inbox_endpoint_contract_failure');

    const expected: EndpointContract[] = [
      { endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], requirement: 'required', inboxRequestClass: 'inbox_page_unread' },
      { endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], requirement: 'required', inboxRequestClass: 'inbox_badge' },
    ];
    const cold = new NetworkCollector({ firstPartyOrigin, surfaceId: 'inbox-unread', behaviorFamily: 'inbox', mode: 'cold', repeat: 0, expectedGets: expected });
    cold.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    start(cold, 'badge', 10.1, badge);
    cold.loadingFinished('sample-1', { requestId: 'badge', timestamp: 10.2, encodedDataLength: 20 });
    start(cold, 'page', 10.3, unreadPage);
    cold.loadingFinished('sample-1', { requestId: 'page', timestamp: 10.4, encodedDataLength: 30 });
    start(cold, 'bad', 10.5, 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=30&cursor=private-cursor');
    cold.loadingFinished('sample-1', { requestId: 'bad', timestamp: 10.6, encodedDataLength: 40 });
    const ended = cold.endSample('sample-1');
    expect(ended.requests.map((request) => [request.inboxRequestClass, request.requestRole, request.unmatchedApi])).toEqual([
      ['inbox_badge', 'required', false],
      ['inbox_page_unread', 'required', false],
      ['inbox_endpoint_contract_failure', 'required', true],
    ]);
    expect([ended.apiRequestCount, ended.apiTransferBytes]).toEqual([3, 90]);
    expect(JSON.stringify(ended)).not.toContain('private-cursor');

    const warm = new NetworkCollector({ firstPartyOrigin, surfaceId: 'inbox-unread', behaviorFamily: 'inbox', mode: 'warm', repeat: 0, expectedGets: expected });
    warm.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    start(warm, 'badge', 10.1, badge);
    warm.loadingFinished('sample-1', { requestId: 'badge', timestamp: 10.2, encodedDataLength: 20 });
    start(warm, 'page', 10.3, unreadPage);
    warm.loadingFinished('sample-1', { requestId: 'page', timestamp: 10.4, encodedDataLength: 30 });
    expect(warm.endSample('sample-1').requests.map((request) => request.requestRole)).toEqual(['background_shell', 'required']);
  });

  it('rejects undeclared background shapes without reclassifying them', () => {
    expect(validateObservedRequestRoles([{
      ...requestEvidence('/api/settings', 'background_refresh'),
    }])).toEqual([{ code: 'undeclared_background', endpointTemplate: '/api/settings', queryKeys: [] }]);
    expect(validateObservedRequestRoles([{
      ...requestEvidence('/api/system/alarms', 'background_refresh'),
    }])).toEqual([]);
  });

  it('is source-fingerprinted from every timer and SSE reader and excludes the sending poll', () => {
    expect(BACKGROUND_REFRESH_GETS.map((row) => row.sourceFingerprint)).toEqual([
      'dashboard/src/routes/settings/useSystemStatus.ts:124-132',
      'dashboard/src/routes/tours/RemindersPanel.tsx:188-208',
      'dashboard/src/routes/placements/usePlacementNudges.ts:96-116',
      'dashboard/src/app/UnreadContext.tsx:19,52-115',
      'dashboard/src/routes/today/useToday.ts:39,126-145',
      'dashboard/src/routes/inbox/useInbox.ts:49,139-155',
      'dashboard/src/routes/email/useUnmatchedEmail.ts:69,142-158',
      'dashboard/src/routes/shared/useRoster.ts:98-137',
      'dashboard/src/routes/tours/useTourChannels.ts:100,221-241',
      'dashboard/src/routes/placements/usePlacementChannels.ts:101,229-249',
      'dashboard/src/routes/contact/useContactTimeline.ts:91,320-337',
      'dashboard/src/routes/broadcasts/useBroadcastResults.ts:41,120-138',
    ]);
    expect(BACKGROUND_REFRESH_GETS.some((row) => row.sourceFingerprint.includes('140-155'))).toBe(false);
  });

  it('keeps every declared timer/SSE shape required initially and backgrounds only its later exact repeat', () => {
    for (const [index, declaration] of BACKGROUND_REFRESH_GETS.entries()) {
      for (const declared of declaration.shapes) {
        const surfaceId = declared.endpointTemplate === '/api/inbox'
          ? '/inbox'
          : declared.endpointTemplate === '/api/unmatched-email' ? '/email' : '/fixture';
        const expected: EndpointContract[] = [{ ...declared, requirement: 'required' }];
        const value = new NetworkCollector({
          firstPartyOrigin: 'http://127.0.0.1:9111', surfaceId, mode: 'warm', repeat: index, expectedGets: expected,
        });
        value.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
        const pathname = declared.endpointTemplate.replace(/:[A-Za-z][A-Za-z0-9]*/g, 'fixture-1');
        const query = declared.queryKeys.length === 0
          ? ''
          : `?${declared.queryKeys.map((key) => `${key}=${key === 'filter' ? 'all' : 'x'}`).join('&')}`;
        const url = `http://127.0.0.1:9111${pathname}${query}`;
        start(value, 'first', 10.1, url);
        value.loadingFinished('sample-1', { requestId: 'first', timestamp: 10.2, encodedDataLength: 1 });
        value.markTerminalVisible('sample-1');
        start(value, 'repeat', 10.3, url);
        value.loadingFinished('sample-1', { requestId: 'repeat', timestamp: 10.4, encodedDataLength: 2 });
        expect(value.endSample('sample-1').requests.map((row) => row.requestRole), declaration.sourceFingerprint)
          .toEqual(['required', 'background_refresh']);
      }
    }
  });

  it('keeps cold shell initial work required and later exact repeats as background_shell', () => {
    const shell: EndpointContract[] = [{ endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], requirement: 'required' }];
    const value = collector('cold', shell);
    const url = 'http://127.0.0.1:9111/api/inbox?filter=unread&limit=100';
    start(value, 'first', 10.1, url);
    value.loadingFinished('sample-1', { requestId: 'first', timestamp: 10.2, encodedDataLength: 10 });
    start(value, 'repeat', 10.3, url);
    value.loadingFinished('sample-1', { requestId: 'repeat', timestamp: 10.4, encodedDataLength: 20 });

    const ended = value.endSample('sample-1');
    expect(ended.requests.map((row) => row.requestRole)).toEqual(['required', 'background_shell']);
    expect(ended.backgroundRequestCount).toBe(1);
    expect(ended.backgroundTransferBytes).toBe(20);
    expect(ended.apiRequestCount).toBe(1);
  });

  it('classifies warm shell traffic as background_shell even when it predates destination work', () => {
    const value = collector('warm');
    start(value, 'shell', 10.1, 'http://127.0.0.1:9111/api/unmatched-email?filter=unmatched');
    value.loadingFinished('sample-1', { requestId: 'shell', timestamp: 10.2, encodedDataLength: 10 });
    expect(value.endSample('sample-1').requests[0]?.requestRole).toBe('background_shell');
  });

  it('keeps the inbox destination load required and labels its later SSE repeat background_refresh', () => {
    const gets: EndpointContract[] = [{
      endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], requirement: 'required', inboxRequestClass: 'inbox_page_all',
    }];
    const value = new NetworkCollector({
      firstPartyOrigin: 'http://127.0.0.1:9111', surfaceId: 'inbox-all', behaviorFamily: 'inbox', mode: 'warm', repeat: 0, expectedGets: gets,
    });
    value.beginSample({ token: 'sample-1', cdpOriginSeconds: 10, nodeOriginMs: 1_000 });
    const url = 'http://127.0.0.1:9111/api/inbox?filter=all&limit=30';
    start(value, 'first', 10.1, url);
    value.loadingFinished('sample-1', { requestId: 'first', timestamp: 10.2, encodedDataLength: 10 });
    value.markTerminalVisible('sample-1');
    start(value, 'repeat', 10.3, url);
    value.loadingFinished('sample-1', { requestId: 'repeat', timestamp: 10.4, encodedDataLength: 20 });
    expect(value.endSample('sample-1').requests.map((row) => row.requestRole)).toEqual(['required', 'background_refresh']);
  });

  it('classifies an exact cataloged route repeat only after required completion and terminal UI', () => {
    const reminders: EndpointContract[] = [{
      endpointTemplate: '/api/tours/:tourId/reminders', queryKeys: [], requirement: 'required',
    }];
    const value = collector('warm', reminders);
    const url = 'http://127.0.0.1:9111/api/tours/tour-0001/reminders';
    start(value, 'initial', 10.1, url);
    value.loadingFinished('sample-1', { requestId: 'initial', timestamp: 10.2, encodedDataLength: 10 });
    start(value, 'early-repeat', 10.3, url);
    value.loadingFinished('sample-1', { requestId: 'early-repeat', timestamp: 10.4, encodedDataLength: 10 });
    value.markTerminalVisible('sample-1');
    start(value, 'background', 10.5, url);
    value.loadingFinished('sample-1', { requestId: 'background', timestamp: 10.6, encodedDataLength: 30 });

    expect(value.endSample('sample-1').requests.map((row) => row.requestRole)).toEqual([
      'required', 'required', 'background_refresh',
    ]);
  });

  it('keeps repeated declared non-background work foreground without inventing drift', () => {
    const settings: EndpointContract[] = [{ endpointTemplate: '/api/settings', queryKeys: [], requirement: 'required' }];
    const value = collector('warm', settings);
    const url = 'http://127.0.0.1:9111/api/settings';
    start(value, 'first', 10.1, url);
    value.loadingFinished('sample-1', { requestId: 'first', timestamp: 10.2, encodedDataLength: 1 });
    value.markTerminalVisible('sample-1');
    start(value, 'repeat', 10.3, url);
    value.loadingFinished('sample-1', { requestId: 'repeat', timestamp: 10.4, encodedDataLength: 1 });

    expect(value.endSample('sample-1').requests[1]).toMatchObject({ requestRole: 'required', unmatchedApi: false });
  });
});

function requestEvidence(
  endpointTemplate: string,
  requestRole: 'required' | 'background_refresh' | 'background_shell',
): import('./types.js').RequestEvidence {
  return {
    surfaceId: '/fixture', mode: 'warm', repeat: 0, method: 'GET', resourceClass: 'api',
    originClass: 'first_party', endpointTemplate, queryKeys: [], startOffsetMs: 0,
    durationMs: 1, ttfbMs: 1, status: 200, transferBytes: 1, outcome: 'finished',
    requestRole, unmatchedApi: false,
  };
}

describe('numeric page and console instrumentation', () => {
  it('maps console input immediately to stable categories without retaining text', () => {
    const warnings = [
      'useContacts: page cap (40) hit for type=tenant',
      'useListings: page cap (40) hit',
      'usePlacements: getPlacements hit the 50-page cap',
      'usePlacements: getContacts hit the 50-page cap',
      'usePlacements: getUnits hit the 50-page cap',
    ];
    expect(warnings.map((message) => classifyConsoleMessage('warning', message))).toEqual([
      'client_truncated', 'client_truncated', 'client_truncated', 'client_truncated', 'client_truncated',
    ]);
    expect(classifyConsoleMessage('warning', 'anything private')).toBe('warning_other');
    expect(classifyConsoleMessage('error', 'anything private')).toBe('error_other');
  });

  it('aggregates long tasks and keeps warm navigation and paint null', () => {
    const result = summarizePageMetrics({
      mode: 'warm',
      page: {
        longTasks: { totalMs: 25, maxMs: 20, count: 2 },
        paint: { fcpMs: 7, lcpMs: 9 }, domElements: 77,
        navigation: { ttfbMs: 1, domContentLoadedMs: 2, loadMs: 3 },
      },
      consoleCategories: { client_truncated: 1 },
    });
    expect(result).toEqual({
      navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
      paint: { fcpMs: null, lcpMs: null },
      longTasks: { totalMs: 25, maxMs: 20, count: 2 }, domElements: 77,
      clientTruncated: true,
    });
    expect(createEmptyResourceCounts()).toEqual({ document: 0, script: 0, style: 0, font: 0, image: 0, api: 0, other: 0 });
  });
});

const STORAGE_STATE: InMemoryStorageState = { cookies: [], origins: [] };

function blankResult(surfaceId: string, mode: 'cold' | 'warm', repeat: number): SampleResult {
  return {
    surfaceId,
    mode,
    repeat,
    status: 'ok',
    readyMs: 12,
    navigation: { ttfbMs: null, domContentLoadedMs: null, loadMs: null },
    paint: { fcpMs: null, lcpMs: null },
    longTasks: { totalMs: 0, maxMs: 0, count: 0 },
    domElements: 1,
    apiRequestCount: 0,
    apiTransferBytes: 0,
    resourceRequestCount: 0,
    resourceTransferBytes: 0,
    resourceCountsByClass: createEmptyResourceCounts(),
    backgroundRequestCount: 0,
    backgroundTransferBytes: 0,
    blockedWrites: [],
    consoleCategories: {},
    clientTruncated: false,
    terminalState: 'populated',
    surfaceEvidence: null,
    reason: null,
  };
}

class FakeSamplingPage implements SamplePage {
  readonly events: string[];
  readonly hrefs = new Set<string>();
  readonly lifecycle?: { activeToken: string | null; listenerCount: number };
  sourceReady = true;
  relayLinks = 0;
  relayChecks = 0;
  surfaceEvidence = null as SampleResult['surfaceEvidence'];
  clickFailure: Error | null = null;

  constructor(
    events: string[],
    lifecycle?: { activeToken: string | null; listenerCount: number },
  ) {
    this.events = events;
    this.lifecycle = lifecycle;
  }

  async installNextDocumentBootstrap(token: string): Promise<void> {
    this.events.push(`bootstrap:${token}`);
  }

  async goto(path: string): Promise<void> {
    this.events.push(`goto:${path}`);
  }

  async prepareWarmSource(route: RouteDefinition): Promise<void> {
    this.events.push(`prepare:${targetPath(route.source.target)}`);
    if (this.lifecycle !== undefined) {
      this.events.push(`prepare-lifecycle:${this.lifecycle.activeToken ?? 'none'}:${this.lifecycle.listenerCount}`);
    }
  }

  async waitForSourceReady(_route: RouteDefinition, timeoutMs: number): Promise<boolean> {
    this.events.push(`source-ready:${timeoutMs}`);
    return this.sourceReady;
  }

  async activateWarmAction(_route: RouteDefinition, destinationTarget: ExactBrowserTarget): Promise<boolean> {
    const href = targetPath(destinationTarget);
    if (this.clickFailure !== null) throw this.clickFailure;
    if (!this.hrefs.has(href)) return false;
    this.events.push(`click:${href}`);
    return true;
  }

  async countRelayConversationLinks(): Promise<number> {
    this.relayChecks += 1;
    return this.relayLinks;
  }

  async captureSurfaceEvidence(_route: RouteDefinition, _initialInboxPageRequestCount: number): Promise<SampleResult['surfaceEvidence']> {
    return this.surfaceEvidence;
  }
}

class FakeSamplingContext implements SampleBrowserContext {
  readonly events: string[];
  readonly page: FakeSamplingPage;
  closed = false;
  readonly closeEvidence: BlockedWrite[];

  constructor(events: string[], closeEvidence: BlockedWrite[] = []) {
    this.events = events;
    this.page = new FakeSamplingPage(events);
    this.closeEvidence = closeEvidence;
  }

  async installBasePageStore(): Promise<void> {
    this.events.push('base-store');
  }

  async newPage(): Promise<SamplePage> {
    this.events.push('new-page');
    return this.page;
  }

  async close(): Promise<BlockedWrite[]> {
    this.closed = true;
    this.events.push('close-context');
    return this.closeEvidence.map((write) => ({ ...write }));
  }
}

class FakeSamplingBrowser implements SampleBrowser {
  readonly contexts: FakeSamplingContext[] = [];
  readonly options: unknown[] = [];
  readonly closeEvidenceByContext = new Map<number, BlockedWrite[]>();
  nextEvents: string[] | null = null;

  async newContext(options: unknown): Promise<SampleBrowserContext> {
    const events = this.nextEvents ?? [];
    this.nextEvents = null;
    const context = new FakeSamplingContext(events, this.closeEvidenceByContext.get(this.contexts.length));
    this.options.push(options);
    this.contexts.push(context);
    return context;
  }
}

class FakeInstrumentation implements SampleInstrumentation {
  readonly events: string[];
  readonly branches: RouteContractBranch[] = [];
  throwOnCollect = false;
  blockedTimeout = false;
  blockedReady = false;
  readonly lifecycle?: { activeToken: string | null; listenerCount: number };
  disposeCount = 0;

  constructor(
    events: string[],
    lifecycle?: { activeToken: string | null; listenerCount: number },
  ) {
    this.events = events;
    this.lifecycle = lifecycle;
  }

  async beginSample(input: {
    token: string;
    mode: 'cold' | 'warm';
    sourcePageUrl?: string;
    destinationPageUrl: string;
    branch: RouteContractBranch;
  }): Promise<void> {
    this.branches.push({ ...input.branch });
    this.events.push(`begin:${input.mode}:${input.token}:${input.sourcePageUrl ?? '-'}:${input.destinationPageUrl}`);
    if (this.lifecycle !== undefined) {
      this.lifecycle.activeToken = input.token;
      this.lifecycle.listenerCount += 1;
    }
  }

  async disposeSample(): Promise<void> {
    this.disposeCount += 1;
    this.events.push('dispose');
    if (this.lifecycle !== undefined) {
      this.lifecycle.activeToken = null;
      this.lifecycle.listenerCount = Math.max(0, this.lifecycle.listenerCount - 1);
    }
  }

  async collectSample(input: { route: RouteDefinition; mode: 'cold' | 'warm'; repeat: number }): Promise<SampleResult> {
    this.events.push(`collect:${input.mode}:${input.route.surfaceId}`);
    if (this.throwOnCollect) throw new Error('collector_failed');
    const result = blankResult(input.route.surfaceId, input.mode, input.repeat);
    if (this.blockedTimeout) {
      result.status = 'timeout';
      result.readyMs = null;
      result.reason = 'ready_timeout';
      result.blockedWrites = [{ method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' }];
    }
    if (this.blockedReady) {
      result.blockedWrites = [{ method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'destination_mount' }];
    }
    return result;
  }
}

function target(path: string): ExactBrowserTarget {
  const parsed = new URL(path, 'http://target.invalid');
  const filter = parsed.searchParams.get('filter');
  return filter === null
    ? { path: parsed.pathname, query: { kind: 'absent' } }
    : { path: parsed.pathname, query: { kind: 'fixed', values: { filter: filter as 'unread' | 'unknown' | 'groups' } } };
}

function targetPath(targetValue: ExactBrowserTarget): string {
  return targetValue.query.kind === 'absent'
    ? targetValue.path
    : `${targetValue.path}?${new URLSearchParams(targetValue.query.values).toString()}`;
}

function resolved(path: string, branch: RouteContractBranch = { kind: 'none' }): ResolverResult {
  return { kind: 'resolved', coldPath: path, warmTarget: target(path), branch };
}

function staticDestination(route: RouteDefinition): string {
  if (route.coldTarget.kind !== 'static') throw new Error('static destination required');
  return route.coldTarget.path;
}

describe('cold and warm sampling protocol', () => {
  it('uses one fresh blocked-service-worker Desktop context per cold sample and closes on every outcome', async () => {
    const browser = new FakeSamplingBrowser();
    const route = ROUTES[0]!;
    const firstEvents: string[] = [];
    browser.nextEvents = firstEvents;
    const firstInstrumentation = new FakeInstrumentation(firstEvents);
    const first = await collectColdSample({
      browser,
      storageState: STORAGE_STATE,
      route,
      repeat: 0,
      resolved: resolved('/'),
      instrumentation: firstInstrumentation,
      token: 'cold-a',
    });
    expect(first.status).toBe('ok');
    expect(browser.options[0]).toMatchObject({
      serviceWorkers: 'block',
      viewport: { width: 1280, height: 720 },
      storageState: STORAGE_STATE,
    });
    expect(browser.contexts[0]!.events).toEqual([
      'base-store',
      'new-page',
      'bootstrap:cold-a',
      'begin:cold:cold-a:-:/',
      'goto:/' ,
      'collect:cold:/' ,
      'close-context',
    ]);
    expect(browser.contexts[0]!.closed).toBe(true);

    const secondEvents: string[] = [];
    const secondInstrumentation = new FakeInstrumentation(secondEvents);
    secondInstrumentation.throwOnCollect = true;
    await expect(collectColdSample({
      browser,
      storageState: STORAGE_STATE,
      route,
      repeat: 1,
      resolved: resolved('/'),
      instrumentation: secondInstrumentation,
      token: 'cold-b',
    })).rejects.toThrow('collector_failed');
    expect(browser.contexts[1]!.closed).toBe(true);
    expect(browser.contexts).toHaveLength(2);
  });

  it('retains cold-context teardown writes as run-level out-of-sample evidence', async () => {
    const browser = new FakeSamplingBrowser();
    const outOfSampleWrites: BlockedWrite[] = [];
    browser.closeEvidenceByContext.set(0, [{
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'out_of_sample',
    }]);

    const result = await collectColdSample({
      browser,
      storageState: STORAGE_STATE,
      route: ROUTES[0]!,
      repeat: 0,
      resolved: resolved('/'),
      instrumentation: new FakeInstrumentation([]),
      token: 'cold-trailing',
      onOutOfSampleWrites: (writes: readonly BlockedWrite[]) => {
        outOfSampleWrites.push(...writes);
      },
    });

    expect(result.blockedWrites).toEqual([]);
    expect(outOfSampleWrites).toContainEqual({
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'out_of_sample',
    });
  });

  it('discards warm source preparation and begins every collector immediately before the exact href click', async () => {
    const events: string[] = [];
    const context = new FakeSamplingContext(events);
    const page = context.page;
    const route = ROUTES.find((candidate) => candidate.surfaceId === '/tours/:tourId')!;
    page.hrefs.add('/tours/tour-private');
    const instrumentation = new FakeInstrumentation(events);
    const branch = { kind: 'thread_detail', thread: 'group_thread', expectsMountWrite: true } as const;

    const sample = await collectWarmSample({
      page,
      route,
      repeat: 0,
      sourceTimeoutMs: 321,
      resolve: async () => {
        events.push('resolve');
        return resolved('/tours/tour-private', branch);
      },
      instrumentation,
      token: 'warm-a',
    });

    expect(sample.status).toBe('ok');
    expect(instrumentation.branches).toEqual([branch]);
    expect(events).toEqual([
      'prepare:/tours',
      'source-ready:321',
      'resolve',
      'begin:warm:warm-a:/tours:/tours/tour-private',
      'click:/tours/tour-private',
      'collect:warm:/tours/:tourId',
    ]);
  });

  it('keeps Inbox measurement passive: only the declared filter action runs and no write tuple is expected', async () => {
    const events: string[] = [];
    const page = new FakeSamplingPage(events);
    const route = ROUTES.find((candidate) => candidate.surfaceId === 'inbox-unread')!;
    const destination = staticDestination(route);
    page.hrefs.add(destination);

    const sample = await collectWarmSample({
      page,
      route,
      repeat: 0,
      sourceTimeoutMs: 100,
      resolve: async () => resolved(destination),
      instrumentation: new FakeInstrumentation(events),
      token: 'passive-inbox',
    });

    expect(sample).toMatchObject({ status: 'ok', blockedWrites: [] });
    expect(events).toEqual([
      'prepare:/inbox',
      'source-ready:100',
      'begin:warm:passive-inbox:/inbox:/inbox?filter=unread',
      'click:/inbox?filter=unread',
      'collect:warm:inbox-unread',
    ]);
    expect(events.join('|')).not.toMatch(/row|mark-read|notice|retry|load more/iu);
  });

  it('maps source, fixture, link, and blocked-readiness outcomes to stable statuses', async () => {
    const route = ROUTES.find((candidate) => candidate.surfaceId === '/contacts/:contactId')!;
    for (const [resolver, status] of [
      [{ kind: 'skip', reason: 'fixture_absent' }, 'skipped_no_fixture'],
      [{ kind: 'skip', reason: 'fixture_not_navigable' }, 'skipped_fixture_not_navigable'],
      [{ kind: 'skip', reason: 'source_not_ready' }, 'skipped_source_not_ready'],
    ] as const) {
      const events: string[] = [];
      const page = new FakeSamplingPage(events);
      const result = await collectWarmSample({
        page,
        route,
        repeat: 0,
        sourceTimeoutMs: 10,
        resolve: async () => resolver,
        instrumentation: new FakeInstrumentation(events),
        token: `skip-${status}`,
      });
      expect(result.status).toBe(status);
      expect(events.some((event) => event.startsWith('begin:'))).toBe(false);
    }

    const events: string[] = [];
    const page = new FakeSamplingPage(events);
    page.sourceReady = false;
    const sourceSkip = await collectWarmSample({
      page,
      route,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private'),
      instrumentation: new FakeInstrumentation(events),
      token: 'source-timeout',
    });
    expect(sourceSkip.status).toBe('skipped_source_not_ready');

    const blockedEvents: string[] = [];
    const blockedPage = new FakeSamplingPage(blockedEvents);
    blockedPage.hrefs.add('/contacts/private');
    const blocked = new FakeInstrumentation(blockedEvents);
    blocked.blockedTimeout = true;
    const blockedResult = await collectWarmSample({
      page: blockedPage,
      route,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private', { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 }),
      instrumentation: blocked,
      token: 'blocked',
    });
    expect(blockedResult).toMatchObject({ status: 'blocked_write_dependency', reason: 'blocked_write_prevented_ready' });

    const allowedEvents: string[] = [];
    const allowedPage = new FakeSamplingPage(allowedEvents);
    allowedPage.hrefs.add('/contacts/private');
    const allowed = new FakeInstrumentation(allowedEvents);
    allowed.blockedReady = true;
    const allowedResult = await collectWarmSample({
      page: allowedPage,
      route,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private', { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 }),
      instrumentation: allowed,
      token: 'blocked-but-ready',
    });
    expect(allowedResult).toMatchObject({ status: 'ok', reason: null });

    const missingEvents: string[] = [];
    const missingLink = await collectWarmSample({
      page: new FakeSamplingPage(missingEvents),
      route,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private', { kind: 'contact_detail', contactType: 'tenant', landlordUnitCount: 0 }),
      instrumentation: new FakeInstrumentation(missingEvents),
      token: 'missing-link',
    });
    expect(missingLink.status).toBe('skipped_fixture_not_navigable');

    const missingTab = await collectWarmSample({
      page: new FakeSamplingPage([]),
      route: ROUTES.find((candidate) => candidate.surfaceId === 'inbox-unread')!,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/inbox'),
      instrumentation: new FakeInstrumentation([]),
      token: 'missing-tab',
    });
    expect(missingTab).toMatchObject({
      status: 'skipped_required_action_missing', reason: 'required_action_missing',
    });
  });

  it('disposes a begun warm sample before the shared page prepares the next route', async () => {
    const events: string[] = [];
    const lifecycle = { activeToken: null as string | null, listenerCount: 0 };
    const page = new FakeSamplingPage(events, lifecycle);
    const firstRoute = ROUTES.find((candidate) => candidate.surfaceId === '/contacts/:contactId')!;
    const secondRoute = ROUTES.find((candidate) => candidate.surfaceId === '/tours/:tourId')!;
    const firstInstrumentation = new FakeInstrumentation(events, lifecycle);

    const first = await collectWarmSample({
      page,
      route: firstRoute,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private'),
      instrumentation: firstInstrumentation,
      token: 'route-a',
    });

    expect(first.status).toBe('skipped_fixture_not_navigable');
    expect(firstInstrumentation.disposeCount).toBe(1);
    expect(lifecycle).toEqual({ activeToken: null, listenerCount: 0 });

    const second = await collectWarmSample({
      page,
      route: secondRoute,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => ({ kind: 'skip', reason: 'fixture_absent' }),
      instrumentation: new FakeInstrumentation(events, lifecycle),
      token: 'route-b',
    });

    expect(second.status).toBe('skipped_no_fixture');
    expect(events).toContain('prepare-lifecycle:none:0');
    expect(events.indexOf('dispose')).toBeLessThan(events.lastIndexOf('prepare-lifecycle:none:0'));
  });

  it('disposes a begun warm sample without masking an exact-link click failure', async () => {
    const events: string[] = [];
    const lifecycle = { activeToken: null as string | null, listenerCount: 0 };
    const page = new FakeSamplingPage(events, lifecycle);
    const route = ROUTES.find((candidate) => candidate.surfaceId === '/contacts/:contactId')!;
    const instrumentation = new FakeInstrumentation(events, lifecycle);
    page.hrefs.add('/contacts/private');
    page.clickFailure = new Error('click_failed');

    await expect(collectWarmSample({
      page,
      route,
      repeat: 0,
      sourceTimeoutMs: 10,
      resolve: async () => resolved('/contacts/private'),
      instrumentation,
      token: 'route-throw',
    })).rejects.toThrowError('click_failed');

    expect(instrumentation.disposeCount).toBe(1);
    expect(lifecycle).toEqual({ activeToken: null, listenerCount: 0 });
  });
});

describe('run ordering and warmup policy', () => {
  it('uses a deterministic Fisher-Yates base order and repeat rotation without mutating declaration order', () => {
    const keys = ROUTES.slice(0, 6).map((route) => route.surfaceId);
    const first = deterministicRouteOrder(ROUTES.slice(0, 6), 1234).map((route) => route.surfaceId);
    const again = deterministicRouteOrder(ROUTES.slice(0, 6), 1234).map((route) => route.surfaceId);
    const different = deterministicRouteOrder(ROUTES.slice(0, 6), 1235).map((route) => route.surfaceId);
    expect(first).toEqual(again);
    expect(first).not.toEqual(different);
    expect(ROUTES.slice(0, 6).map((route) => route.surfaceId)).toEqual(keys);
  });

  it.each([
    ['hermetic', true],
    ['local', true],
    ['hosted-dev', false],
  ] as const)('records fixed declaration-order warmup and actual rotated orders for %s', async (target: TargetKind, warmup: boolean) => {
    const browser = new FakeSamplingBrowser();
    const routes = ROUTES.slice(0, 3);
    const result = await collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target,
      routes,
      coldRepeats: 2,
      warmRepeats: 2,
      routeOrderSeed: 99,
      sourceTimeoutMs: 100,
      resolveCold: async (route) => resolved(route.surfaceId),
      resolveWarm: async (route, page) => {
        const destination = staticDestination(route);
        (page as FakeSamplingPage).hrefs.add(destination);
        return resolved(destination);
      },
      instrumentationFor: () => new FakeInstrumentation([]),
      tokenFactory: (mode, repeat, route) => `${mode}-${repeat}-${route.surfaceId}`,
    });

    expect(result.warmup).toEqual(warmup ? { performed: true, surfaceId: '/' } : { performed: false, surfaceId: null });
    expect(result.orders).toHaveLength(4);
    expect(result.orders[0]!.surfaceIds).not.toEqual(result.orders[1]!.surfaceIds);
    expect(result.samples).toHaveLength(12);
    expect(result.lowSampleCount).toBe(true);
    if (warmup) expect(result.samples.every((sample) => sample.repeat >= 0)).toBe(true);
  });

  it('discards a failed unmeasured warmup and still records every measured sample', async () => {
    const browser = new FakeSamplingBrowser();
    const route = ROUTES[0]!;
    const result = await collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target: 'hermetic',
      routes: [route],
      coldRepeats: 1,
      warmRepeats: 1,
      routeOrderSeed: 7,
      sourceTimeoutMs: 100,
      resolveCold: async () => resolved('/'),
      resolveWarm: async (_route, page) => {
        (page as FakeSamplingPage).hrefs.add('/');
        return resolved('/');
      },
      instrumentationFor: (_route, _mode, repeat) => {
        const value = new FakeInstrumentation([]);
        value.throwOnCollect = repeat === -1;
        return value;
      },
    });

    expect(result.samples.map(({ mode, repeat, status }) => ({ mode, repeat, status }))).toEqual([
      { mode: 'cold', repeat: 0, status: 'ok' },
      { mode: 'warm', repeat: 0, status: 'ok' },
    ]);
    expect(browser.contexts[0]?.closed).toBe(true);
  });

  it('stops between samples after cancellation instead of driving a detached browser operation', async () => {
    const browser = new FakeSamplingBrowser();
    const controller = new AbortController();
    const routes = ROUTES.slice(0, 2);
    let cancelled = false;

    await expect(collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target: 'hermetic',
      routes,
      coldRepeats: 1,
      warmRepeats: 1,
      routeOrderSeed: 7,
      sourceTimeoutMs: 100,
      signal: controller.signal,
      resolveCold: async (route) => resolved(route.surfaceId),
      resolveWarm: async (route, page) => {
        const destination = staticDestination(route);
        (page as FakeSamplingPage).hrefs.add(destination);
        return resolved(destination);
      },
      instrumentationFor: (route, mode, repeat) => {
        const value = new FakeInstrumentation([]);
        const collect = value.collectSample.bind(value);
        value.collectSample = async (input) => {
          const result = await collect(input);
          if (mode === 'cold' && repeat === 0 && !cancelled) {
            cancelled = true;
            controller.abort({ reason: 'interrupted' });
          }
          return result;
        };
        return value;
      },
    })).rejects.toMatchObject({ reason: 'interrupted' });
  });

  it('retains warmup and warm-context teardown writes without assigning them to samples', async () => {
    const browser = new FakeSamplingBrowser();
    const evidence: BlockedWrite = {
      method: 'POST', endpointTemplate: '/api/inbox/:contactId/read', phase: 'out_of_sample',
    };
    browser.closeEvidenceByContext.set(0, [evidence]);
    browser.closeEvidenceByContext.set(2, [evidence]);
    const route = ROUTES[0]!;

    const result = await collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target: 'hermetic',
      routes: [route],
      coldRepeats: 1,
      warmRepeats: 1,
      routeOrderSeed: 7,
      sourceTimeoutMs: 100,
      resolveCold: async () => resolved('/'),
      resolveWarm: async (_route, page) => {
        (page as FakeSamplingPage).hrefs.add('/');
        return resolved('/');
      },
      instrumentationFor: (_route, mode, repeat) => new FakeInstrumentation([], undefined),
    });

    expect(result.samples.every((sample) => sample.blockedWrites.every((write) => write.phase !== 'out_of_sample'))).toBe(true);
    expect(result.outOfSampleWrites).toEqual([evidence, evidence]);
  });

  it('runs the relay proof once only for a successful inbox-all sample in shuffled hermetic order', async () => {
    const browser = new FakeSamplingBrowser();
    const inbox = ROUTES.find((route) => route.surfaceId === 'inbox-all')!;
    const unread = ROUTES.find((route) => route.surfaceId === 'inbox-unread')!;
    const result = await collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target: 'hermetic',
      routes: [unread, inbox],
      coldRepeats: 1,
      warmRepeats: 2,
      routeOrderSeed: 7,
      sourceTimeoutMs: 100,
      expectedRelayLinkCount: 4,
      resolveCold: async (route) => resolved(staticDestination(route)),
      resolveWarm: async (route, page) => {
        const fake = page as FakeSamplingPage;
        fake.hrefs.add(staticDestination(route));
        fake.relayLinks = 3;
        return resolved(staticDestination(route));
      },
      instrumentationFor: () => new FakeInstrumentation([]),
      tokenFactory: (mode, repeat) => `${mode}-${repeat}`,
    });

    expect(browser.contexts).toHaveLength(4); // discarded warmup, two cold, one reused warm context
    expect(result.relayDomCheck).toEqual({ expectedCount: 4, renderedCount: 3, shortfall: true });
    expect(Object.keys(result.relayDomCheck ?? {}).sort()).toEqual(['expectedCount', 'renderedCount', 'shortfall']);
    expect(browser.contexts.at(-1)?.page.relayChecks).toBe(1);
  });

  it('retains a sanitized failed sample and closes the warm context when destination collection throws', async () => {
    const browser = new FakeSamplingBrowser();
    const route = ROUTES[0]!;
    const result = await collectRunSamples({
      browser,
      storageState: STORAGE_STATE,
      target: 'hosted-dev',
      routes: [route],
      coldRepeats: 1,
      warmRepeats: 1,
      routeOrderSeed: 7,
      sourceTimeoutMs: 100,
      resolveCold: async () => resolved('/'),
      resolveWarm: async (_route, page) => {
        (page as FakeSamplingPage).hrefs.add('/');
        return resolved('/');
      },
      instrumentationFor: (_route, mode) => {
        const value = new FakeInstrumentation([]);
        value.throwOnCollect = mode === 'warm';
        return value;
      },
    });
    expect(result.samples.at(-1)).toMatchObject({
      surfaceId: '/', mode: 'warm', status: 'failed', reason: 'browser_failure',
    });
    expect(JSON.stringify(result)).not.toContain('collector_failed');
    expect(browser.contexts.at(-1)?.closed).toBe(true);
  });
});
