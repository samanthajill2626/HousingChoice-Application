// The server-clock estimate (retry-send-window spec D8). The one-to-one retry
// promise is judged on the SERVER's clock, so a skewed browser clock cannot
// change how long it shows. The estimate is the latest API response's `Date`
// header against the browser instant that response arrived.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request } from './client.js';
import { noteServerDate, resetServerClockForTests, serverNowMs } from './serverClock.js';

/** A whole second, so a header built from it parses back to exactly it. */
const BROWSER_NOW = Date.parse('2026-09-25T20:42:07.000Z');
const TEN_MINUTES = 10 * 60 * 1000;

/** An IMF-fixdate, the exact shape Node writes into a response's `Date`. */
const httpDate = (ms: number): string => new Date(ms).toUTCString();

beforeEach(() => {
  vi.setSystemTime(BROWSER_NOW);
  resetServerClockForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetServerClockForTests();
});

describe('serverClock - the estimate', () => {
  it('reads the browser clock before any response has been seen', () => {
    expect(serverNowMs()).toBe(BROWSER_NOW);
  });

  it('corrects a browser clock running 10 minutes FAST, and keeps correcting as time passes', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
    vi.setSystemTime(BROWSER_NOW + 5_000);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES + 5_000);
  });

  it('corrects a browser clock running 10 minutes SLOW', () => {
    noteServerDate(httpDate(BROWSER_NOW + TEN_MINUTES), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES);
    vi.setSystemTime(BROWSER_NOW + 5_000);
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES + 5_000);
  });

  it('takes the receipt instant from the browser clock when none is passed', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES));
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('measures the offset from the receipt instant it is GIVEN, not from the browser clock at the call', () => {
    // The response arrived 5 seconds BEFORE this call on the browser's clock,
    // and its header says the server read BROWSER_NOW then - so the server
    // runs 5 seconds ahead. An estimate that ignored the receipt instant and
    // read the clock at the call would say the two clocks agree.
    noteServerDate(httpDate(BROWSER_NOW), BROWSER_NOW - 5_000);
    expect(serverNowMs()).toBe(BROWSER_NOW + 5_000);
  });

  it('lets the LATEST response win', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(httpDate(BROWSER_NOW + 30_000), BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW + 30_000);
  });

  it('reads an in-step server at most one second BEHIND and never ahead - the header drops the milliseconds', () => {
    // The server stamped 20:42:07.900 as "20:42:07"; the browser, in step,
    // received it at .900. The estimate lags by the lost fraction only.
    const receivedAt = BROWSER_NOW + 900;
    vi.setSystemTime(receivedAt);
    expect(httpDate(receivedAt)).toBe(httpDate(BROWSER_NOW));
    noteServerDate(httpDate(receivedAt), receivedAt);
    expect(serverNowMs()).toBe(BROWSER_NOW);
    expect(receivedAt - serverNowMs()).toBeGreaterThanOrEqual(0);
    expect(receivedAt - serverNowMs()).toBeLessThan(1000);
  });

  it('ignores a MISSING header - the previous estimate stands', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(null, BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it.each(['', 'not a date'])('ignores a GARBAGE header %j - the previous estimate stands', (garbage) => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    noteServerDate(garbage, BROWSER_NOW);
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('resets to the browser clock', () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    resetServerClockForTests();
    expect(serverNowMs()).toBe(BROWSER_NOW);
  });
});

describe('requestWithStatus notes the server clock on EVERY response', () => {
  it('a successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json', date: httpDate(BROWSER_NOW - TEN_MINUTES) },
      }),
    );
    await expect(request('/api/clock-contract')).resolves.toEqual({ ok: true });
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('a REFUSED response too - the estimate is taken before the ApiError is thrown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'retry_pending' }), {
        status: 409,
        headers: { 'content-type': 'application/json', date: httpDate(BROWSER_NOW + TEN_MINUTES) },
      }),
    );
    const err: unknown = await request('/api/clock-contract', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'retry_pending' });
    expect(serverNowMs()).toBe(BROWSER_NOW + TEN_MINUTES);
  });

  it('BEFORE the body is parsed, so the items a response carries are judged against the clock it brought', async () => {
    let seenWhileParsing: number | undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json', date: httpDate(BROWSER_NOW - TEN_MINUTES) }),
      json: async () => {
        seenWhileParsing = serverNowMs();
        return { ok: true };
      },
    } as unknown as Response);
    await request('/api/clock-contract');
    expect(seenWhileParsing).toBe(BROWSER_NOW - TEN_MINUTES);
  });

  it('a response with NO Date header leaves the estimate alone', async () => {
    noteServerDate(httpDate(BROWSER_NOW - TEN_MINUTES), BROWSER_NOW);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await request('/api/clock-contract');
    expect(serverNowMs()).toBe(BROWSER_NOW - TEN_MINUTES);
  });
});
