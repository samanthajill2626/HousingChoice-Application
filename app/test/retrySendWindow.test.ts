// The 15-minute send window for AUTOMATIC retries of a carrier-30003 failure
// (retry-send-window spec D1-D5, D10; test intention 1). Pure helpers: every
// case injects its own clock (D13).
import { describe, expect, it } from 'vitest';
import {
  RETRY_JOB_GRACE_MS,
  RETRY_PROMISE_GRACE_MS,
  RETRY_PROMISE_WITHDRAWN_AT,
  RETRY_SEND_WINDOW_MS,
  isRetryPromiseLive,
  oneToOneRetryWindowOrigin,
  parseRetryWindowOrigin,
  retryFitsSendWindow,
  retrySendDeadlineMs,
  withinRetrySendWindow,
} from '../src/lib/retrySendWindow.js';

const MIN = 60_000;
/** A fixed origin: the original send, Friday 2026-09-25 12:00:00 UTC. */
const ORIGIN_ISO = '2026-09-25T12:00:00.000Z';
const ORIGIN = Date.parse(ORIGIN_ISO);

describe('retrySendWindow constants (spec D1, D3, D7, D10)', () => {
  it('pins the window, the scheduling grace, the promise grace and the withdrawn stamp', () => {
    expect(RETRY_SEND_WINDOW_MS).toBe(15 * MIN);
    expect(RETRY_JOB_GRACE_MS).toBe(1 * MIN);
    expect(RETRY_PROMISE_GRACE_MS).toBe(2 * MIN);
    expect(RETRY_PROMISE_WITHDRAWN_AT).toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(RETRY_PROMISE_WITHDRAWN_AT)).toBe(0);
  });
});

describe('parseRetryWindowOrigin (spec D2, D5)', () => {
  it('parses an ISO 8601 origin', () => {
    expect(parseRetryWindowOrigin(ORIGIN_ISO)).toBe(ORIGIN);
  });

  it('parses an RFC 2822 origin to the same instant, offsets included', () => {
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 12:00:00 +0000')).toBe(ORIGIN);
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 12:00:00 GMT')).toBe(ORIGIN);
    expect(parseRetryWindowOrigin('Fri, 25 Sep 2026 08:00:00 -0400')).toBe(ORIGIN);
  });

  // undefined is the FAIL-OPEN signal (D5): the caller skips the window check
  // and logs a WARN naming the gap. It never throws.
  it.each<[string, unknown]>([
    ['an absent', undefined],
    ['an empty', ''],
    ['a whitespace-only', '   '],
    ['a garbage', 'not-a-date'],
    ['an impossible-date', '2026-13-45T00:00:00Z'],
  ])('returns undefined for %s origin', (_label, value) => {
    expect(parseRetryWindowOrigin(value)).toBeUndefined();
  });

  it.each<[string, unknown]>([
    ['a number (epoch ms)', ORIGIN],
    ['null', null],
    ['a Date object', new Date(ORIGIN)],
    ['a plain object', { at: ORIGIN_ISO }],
    ['a boolean', true],
  ])('returns undefined for a non-string origin: %s', (_label, value) => {
    expect(parseRetryWindowOrigin(value)).toBeUndefined();
  });
});

// The ONE-TO-ONE origin rule (spec D2), shared by the 30003 decision and the
// retry job so the two cannot drift. It returns the RAW stored value: the job
// carries it onto the retry row as retryWindowStart, and the caller parses it.
describe('oneToOneRetryWindowOrigin (spec D2): retry_window_start ?? provider_ts, raw', () => {
  const CHAIN_FIRST_SEND = '2026-09-25T11:50:00.000Z';
  const OWN_SEND = '2026-09-25T11:59:30.000Z';

  it('a retry row: retry_window_start (the chain FIRST send) wins over the row own provider_ts', () => {
    expect(
      oneToOneRetryWindowOrigin({ retry_window_start: CHAIN_FIRST_SEND, provider_ts: OWN_SEND }),
    ).toBe(CHAIN_FIRST_SEND);
  });

  it('a first send (no retry_window_start): the row own provider_ts', () => {
    expect(oneToOneRetryWindowOrigin({ provider_ts: OWN_SEND })).toBe(OWN_SEND);
  });

  it('both absent: undefined, which the caller treats as no usable origin (D5 fail-open)', () => {
    expect(oneToOneRetryWindowOrigin({})).toBeUndefined();
    expect(parseRetryWindowOrigin(oneToOneRetryWindowOrigin({}))).toBeUndefined();
  });

  it('returns the value RAW, never normalized: an RFC 2822 origin comes back as stored', () => {
    const rfc = 'Fri, 25 Sep 2026 11:50:00 GMT';
    expect(oneToOneRetryWindowOrigin({ retry_window_start: rfc, provider_ts: OWN_SEND })).toBe(rfc);
  });

  // The `??` edge: only an ABSENT retry_window_start falls through. A present
  // but empty or unparseable one is returned as is, so the window check fails
  // OPEN on it (D5) instead of silently measuring from this row's own send.
  it.each<[string, string]>([
    ['an empty', ''],
    ['an unparseable', 'not-a-date'],
  ])('%s retry_window_start does NOT fall back to provider_ts', (_label, value) => {
    expect(oneToOneRetryWindowOrigin({ retry_window_start: value, provider_ts: OWN_SEND })).toBe(value);
    expect(
      parseRetryWindowOrigin(oneToOneRetryWindowOrigin({ retry_window_start: value, provider_ts: OWN_SEND })),
    ).toBeUndefined();
  });

  it('a stored NULL retry_window_start falls through to provider_ts, exactly like an absent one', () => {
    const stored = { retry_window_start: null as unknown as string, provider_ts: OWN_SEND };
    expect(oneToOneRetryWindowOrigin(stored)).toBe(OWN_SEND);
  });
});

describe('retryFitsSendWindow - scheduling (spec D3, D3a): only with the grace to spare', () => {
  it('allows a rung whose send time plus the grace lands EXACTLY on the window end', () => {
    // 13 min in + 1 min backoff + 1 min grace = 15 min: allowed (<=).
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 13 * MIN, backoffMs: 1 * MIN }),
    ).toBe(true);
  });

  it('refuses the same rung one millisecond later', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 13 * MIN + 1, backoffMs: 1 * MIN }),
    ).toBe(false);
  });

  it('spends the grace: a rung that would go out inside the window but in its last minute is refused', () => {
    // Would send at 14:30 - inside the window - but 14:30 + 1:00 grace > 15:00.
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 12.5 * MIN, backoffMs: 2 * MIN }),
    ).toBe(false);
  });

  it('measures each rung by its own backoff: a 4-minute rung fits at 10 minutes in, not 1 ms later', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 10 * MIN, backoffMs: 4 * MIN }),
    ).toBe(true);
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 10 * MIN + 1, backoffMs: 4 * MIN }),
    ).toBe(false);
  });

  it('allows a normal early ladder (D1: first failure within a minute)', () => {
    expect(
      retryFitsSendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 1 * MIN, backoffMs: 1 * MIN }),
    ).toBe(true);
  });
});

describe('withinRetrySendWindow - job time (spec D4): strict, the grace already spent', () => {
  it('allows a send at EXACTLY 15 minutes after the origin', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 15 * MIN })).toBe(true);
  });

  it('refuses a send one millisecond past 15 minutes', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN + 15 * MIN + 1 })).toBe(false);
  });

  it('allows a send whose clock reads before the origin', () => {
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: ORIGIN - 5_000 })).toBe(true);
  });
});

describe('retrySendDeadlineMs (spec D4 - the bounded acquire deadline)', () => {
  it('is the window end, and the job-time check agrees on that last instant', () => {
    expect(retrySendDeadlineMs(ORIGIN)).toBe(ORIGIN + 15 * MIN);
    expect(withinRetrySendWindow({ originMs: ORIGIN, nowMs: retrySendDeadlineMs(ORIGIN) })).toBe(true);
  });
});

describe('isRetryPromiseLive (spec D10 - the server guard)', () => {
  const DUE_ISO = '2026-09-25T12:05:00.000Z';
  const DUE = Date.parse(DUE_ISO);

  it('is live until retry_due_at plus the 2-minute grace, strictly', () => {
    expect(isRetryPromiseLive(DUE_ISO, DUE)).toBe(true);
    expect(isRetryPromiseLive(DUE_ISO, DUE + 2 * MIN - 1)).toBe(true);
    expect(isRetryPromiseLive(DUE_ISO, DUE + 2 * MIN)).toBe(false);
  });

  it('is live before the due time too', () => {
    expect(isRetryPromiseLive(DUE_ISO, DUE - 3 * MIN)).toBe(true);
  });

  it('is false with no retry_due_at, or an unparseable one', () => {
    expect(isRetryPromiseLive(undefined, DUE)).toBe(false);
    expect(isRetryPromiseLive('', DUE)).toBe(false);
    expect(isRetryPromiseLive('not-a-date', DUE)).toBe(false);
  });

  it('is false for a WITHDRAWN promise (D7 enqueue failure) at any real time', () => {
    expect(isRetryPromiseLive(RETRY_PROMISE_WITHDRAWN_AT, DUE)).toBe(false);
    expect(isRetryPromiseLive(RETRY_PROMISE_WITHDRAWN_AT, Date.parse('2000-01-01T00:00:00.000Z'))).toBe(false);
  });

  it('parses an RFC 2822 retry_due_at', () => {
    expect(isRetryPromiseLive('Fri, 25 Sep 2026 12:05:00 GMT', DUE + 1 * MIN)).toBe(true);
  });
});
