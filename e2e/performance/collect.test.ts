import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_REFRESH_GETS,
  NetworkCollector,
  classifyConsoleMessage,
  createEmptyResourceCounts,
  summarizePageMetrics,
} from './collect.js';
import type { EndpointContract } from './routes.js';

const REQUIRED_CONTACTS: EndpointContract[] = [{
  endpointTemplate: '/api/contacts', queryKeys: ['limit', 'type'], requirement: 'required',
}];

function collector(mode: 'cold' | 'warm' = 'cold', expectedGets: readonly EndpointContract[] = REQUIRED_CONTACTS): NetworkCollector {
  const value = new NetworkCollector({
    firstPartyOrigin: 'http://127.0.0.1:9111', routeKey: '/contacts/tenants', mode, repeat: 0, expectedGets,
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
    expect(ended.satisfiedRequired).toEqual(['/api/contacts?limit&type']);
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
        const routeKey = declared.endpointTemplate === '/api/inbox'
          ? '/inbox'
          : declared.endpointTemplate === '/api/unmatched-email' ? '/email' : '/fixture';
        const expected: EndpointContract[] = [{ ...declared, requirement: 'required' }];
        const value = new NetworkCollector({
          firstPartyOrigin: 'http://127.0.0.1:9111', routeKey, mode: 'warm', repeat: index, expectedGets: expected,
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
    const gets: EndpointContract[] = [{ endpointTemplate: '/api/inbox', queryKeys: ['filter', 'limit'], requirement: 'required' }];
    const value = new NetworkCollector({
      firstPartyOrigin: 'http://127.0.0.1:9111', routeKey: '/inbox', mode: 'warm', repeat: 0, expectedGets: gets,
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

  it('leaves an undeclared exact repeat unmatched and foreground', () => {
    const settings: EndpointContract[] = [{ endpointTemplate: '/api/settings', queryKeys: [], requirement: 'required' }];
    const value = collector('warm', settings);
    const url = 'http://127.0.0.1:9111/api/settings';
    start(value, 'first', 10.1, url);
    value.loadingFinished('sample-1', { requestId: 'first', timestamp: 10.2, encodedDataLength: 1 });
    value.markTerminalVisible('sample-1');
    start(value, 'repeat', 10.3, url);
    value.loadingFinished('sample-1', { requestId: 'repeat', timestamp: 10.4, encodedDataLength: 1 });

    expect(value.endSample('sample-1').requests[1]).toMatchObject({ requestRole: 'required', unmatchedApi: true });
  });
});

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
