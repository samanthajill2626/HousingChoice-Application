// Per-user sliding-window rate limiter (2026-07-02 hardening,
// docs/superpowers/specs/2026-07-02-api-rate-limiting-design.md) — three layers:
//
//   1. createUserRateLimit UNIT tests (direct middleware invocation, fake
//      Date): sliding-window roll-over, per-user + per-route isolation,
//      Retry-After math, missing-user → 401, the IDs-only WARN.
//   2. Config plumbing: the five RATE_LIMIT_* env vars parse with defaults,
//      honor overrides, and fail fast on bad values.
//   3. ROUTE-LEVEL coverage through the real app (buildApp / the webhook
//      harness): each of the four wired send/call-cost routes 429s past its
//      ceiling with the LOCKED contract (429 + { error: 'rate_limited' } +
//      Retry-After) and recovers after the window — and a 429'd request
//      performs NO side effect (no SMS, no call, no state touched).
//
// Fake timers fake ONLY Date (the limiter's clock) — timer functions stay real
// so supertest's sockets keep working.
import type { Request, RequestHandler, Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { createUserRateLimit } from '../src/middleware/rateLimit.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { ConversationsRepo } from '../src/repos/conversationsRepo.js';
import type { MessagesRepo } from '../src/repos/messagesRepo.js';
import type { SendMessageInput } from '../src/services/sendMessage.js';
import {
  makeFakeUsersRepo,
  testUserItem,
  TEST_ADMIN_COOKIE,
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
} from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
} from './helpers/twilioWebhookHarness.js';

// ---------------------------------------------------------------------------
// Direct-invocation harness: the limiter is synchronous, so a plain fake
// req/res/next triple gives exact control over Retry-After assertions.
// ---------------------------------------------------------------------------

interface CapturedResponse {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
}

function invoke(
  mw: RequestHandler,
  userId?: string,
): { nexted: boolean } & CapturedResponse {
  const captured: CapturedResponse = { headers: {} };
  const req = (
    userId === undefined ? {} : { user: { userId, email: 'x@example.com', role: 'va' } }
  ) as unknown as Request;
  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
      return res;
    },
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
  } as unknown as Response;
  let nexted = false;
  void mw(req, res, () => {
    nexted = true;
  });
  return { nexted, ...captured };
}

describe('createUserRateLimit — sliding window per user (unit)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-02T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('admits up to max, 429s with the LOCKED contract, and slides (no boundary reset)', () => {
    const capture = createLogCapture();
    const mw = createUserRateLimit({
      routeKey: 'test_route',
      max: 2,
      windowMs: 60_000,
      logger: createLogger({ destination: capture.stream }),
    });

    // t=0s and t=30s: both admitted.
    expect(invoke(mw, 'u1').nexted).toBe(true);
    vi.setSystemTime(Date.now() + 30_000);
    expect(invoke(mw, 'u1').nexted).toBe(true);

    // Still t=30s: third request → 429 + { error } + Retry-After until the
    // OLDEST stamp (t=0) ages out at t=60 → 30 seconds.
    const third = invoke(mw, 'u1');
    expect(third.nexted).toBe(false);
    expect(third.statusCode).toBe(429);
    expect(third.body).toEqual({ error: 'rate_limited' });
    expect(third.headers['retry-after']).toBe('30');

    // t=61s: the t=0 stamp expired → ONE slot freed → admitted.
    vi.setSystemTime(Date.now() + 31_000);
    expect(invoke(mw, 'u1').nexted).toBe(true);

    // Immediately again → 429: the t=30 stamp is STILL in the window. A fixed
    // window would have fully reset at the boundary — sliding must not.
    const fifth = invoke(mw, 'u1');
    expect(fifth.statusCode).toBe(429);
    // Oldest in-window stamp is t=30 → expires at t=90; now t=61 → 29s.
    expect(fifth.headers['retry-after']).toBe('29');

    // t=91s: the t=30 stamp expired too → admitted again.
    vi.setSystemTime(Date.now() + 30_000);
    expect(invoke(mw, 'u1').nexted).toBe(true);
  });

  it('isolates per USER: user A at the cap never 429s user B', () => {
    const mw = createUserRateLimit({
      routeKey: 'test_route',
      max: 1,
      windowMs: 60_000,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    expect(invoke(mw, 'user-a').nexted).toBe(true);
    expect(invoke(mw, 'user-a').statusCode).toBe(429); // A is capped…
    expect(invoke(mw, 'user-b').nexted).toBe(true); // …B is untouched.
  });

  it('isolates per ROUTE: maxing one limiter instance never touches another', () => {
    const logger = createLogger({ destination: createLogCapture().stream });
    const manualSend = createUserRateLimit({ routeKey: 'manual_send', max: 1, windowMs: 60_000, logger });
    const originate = createUserRateLimit({ routeKey: 'originate', max: 1, windowMs: 60_000, logger });
    expect(invoke(manualSend, 'u1').nexted).toBe(true);
    expect(invoke(manualSend, 'u1').statusCode).toBe(429); // manual_send capped…
    expect(invoke(originate, 'u1').nexted).toBe(true); // …originate unaffected.
  });

  it('Retry-After is a ceil to at least 1 second (never 0)', () => {
    const mw = createUserRateLimit({
      routeKey: 'test_route',
      max: 1,
      windowMs: 60_000,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    expect(invoke(mw, 'u1').nexted).toBe(true);
    // 200ms before the stamp expires: ceil(0.2s) = 1 — the header must never
    // tell a client "retry in 0 seconds" while the request would still 429.
    vi.setSystemTime(Date.now() + 59_800);
    const limited = invoke(mw, 'u1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('1');
  });

  it('missing session user → 401 unauthorized, no quota consumed, never a shared bucket', () => {
    const mw = createUserRateLimit({
      routeKey: 'test_route',
      max: 1,
      windowMs: 60_000,
      logger: createLogger({ destination: createLogCapture().stream }),
    });
    const anon = invoke(mw); // no req.user (unreachable behind requireAuth)
    expect(anon.nexted).toBe(false);
    expect(anon.statusCode).toBe(401);
    expect(anon.body).toEqual({ error: 'unauthorized' });
    // The refusal consumed nobody's quota (no IP/shared-bucket fallback).
    expect(invoke(mw, 'u1').nexted).toBe(true);
  });

  it('on-limit WARN carries IDs/counts only — routeKey, userId, max, windowMs', () => {
    const capture = createLogCapture();
    const mw = createUserRateLimit({
      routeKey: 'verify_start',
      max: 1,
      windowMs: 180_000,
      logger: createLogger({ destination: capture.stream }),
    });
    invoke(mw, 'usr_abc');
    invoke(mw, 'usr_abc'); // → 429 + WARN
    const warns = capture.atLevel(40);
    expect(warns).toHaveLength(1);
    const line = warns[0]!;
    expect(line['msg']).toBe('per-user rate limit exceeded');
    expect(line['routeKey']).toBe('verify_start');
    expect(line['userId']).toBe('usr_abc');
    expect(line['max']).toBe(1);
    expect(line['windowMs']).toBe(180_000);
  });
});

// ---------------------------------------------------------------------------
// Config plumbing — the exact PUBLIC_RATE_LIMIT_MAX idiom: code defaults when
// unset, env override honored, fail-fast on anything not a positive integer.
// ---------------------------------------------------------------------------

describe('RATE_LIMIT_* config parsing', () => {
  const BASE = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;

  it('defaults: 30/min manual send, 5/min broadcast, 10/min originate, 3 per 180000ms verify-start', () => {
    const config = loadConfig(BASE);
    expect(config.rateLimitManualSendPerMin).toBe(30);
    expect(config.rateLimitBroadcastSendPerMin).toBe(5);
    expect(config.rateLimitOriginatePerMin).toBe(10);
    expect(config.rateLimitVerifyStartMax).toBe(3);
    expect(config.rateLimitVerifyStartWindowMs).toBe(180_000);
  });

  it('env overrides are honored', () => {
    const config = loadConfig({
      ...BASE,
      RATE_LIMIT_MANUAL_SEND_PER_MIN: '2',
      RATE_LIMIT_BROADCAST_SEND_PER_MIN: '1',
      RATE_LIMIT_ORIGINATE_PER_MIN: '100000',
      RATE_LIMIT_VERIFY_START_MAX: '7',
      RATE_LIMIT_VERIFY_START_WINDOW_MS: '5000',
    });
    expect(config.rateLimitManualSendPerMin).toBe(2);
    expect(config.rateLimitBroadcastSendPerMin).toBe(1);
    expect(config.rateLimitOriginatePerMin).toBe(100_000);
    expect(config.rateLimitVerifyStartMax).toBe(7);
    expect(config.rateLimitVerifyStartWindowMs).toBe(5000);
  });

  it('fails fast on non-positive-integer values (a typo must never mean "unlimited")', () => {
    const vars = [
      'RATE_LIMIT_MANUAL_SEND_PER_MIN',
      'RATE_LIMIT_BROADCAST_SEND_PER_MIN',
      'RATE_LIMIT_ORIGINATE_PER_MIN',
      'RATE_LIMIT_VERIFY_START_MAX',
      'RATE_LIMIT_VERIFY_START_WINDOW_MS',
    ];
    for (const name of vars) {
      for (const bad of ['0', '-1', 'abc', '1.5']) {
        expect(() => loadConfig({ ...BASE, [name]: bad } as NodeJS.ProcessEnv), `${name}=${bad}`).toThrow(
          new RegExp(`${name} must be a positive integer`),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Route-level — the four wirings through the real app. The limiter fronts the
// handler, so it meters REQUESTS (even ones the handler would refuse) and a
// 429 performs no side effect.
// ---------------------------------------------------------------------------

describe('route-level per-user rate limits (the four send/call-cost routes)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const NAV_CELL = '+15550140000';
  const TARGET = '+15550188888';

  it('manual 1:1 send: 429 past the ceiling never reaches the send service, recovers after the window', async () => {
    // The stub-service pattern of apiRoutes.test.ts: the harness's default api
    // send service builds a REAL contacts repo (no seam), so the 1:1 send path
    // is driven through buildApp with an injected service — which is also the
    // sharpest side-effect probe: a 429'd request must never CALL it.
    const calls: SendMessageInput[] = [];
    const app = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: ORIGIN_SECRET,
        RATE_LIMIT_MANUAL_SEND_PER_MIN: '2',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: {
          async getById() {
            return undefined; // not a relay group — fall through to the 1:1 path
          },
        } as unknown as ConversationsRepo,
        sendMessageService: async (input) => {
          calls.push(input);
          return {
            conversationId: input.conversationId,
            providerSid: `SMfake-${calls.length}`,
            tsMsgId: `2026-07-02T10:00:00.000Z#SMfake-${calls.length}`,
            status: 'queued',
          };
        },
      },
    });
    const send = () =>
      request(app)
        .post('/api/conversations/conv-1/messages')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ body: 'hello' });

    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);

    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
    // No side effect: the send service saw exactly the two admitted requests.
    expect(calls).toHaveLength(2);

    // Past the window the route admits again.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await send()).status).toBe(201);
    expect(calls).toHaveLength(3);
  });

  it('retry SHARES the manual-send budget: a send + a retry exhaust the ceiling → the next 429s', async () => {
    // The retry POST fires a real SMS and escapes the breaker, so it MUST draw on
    // the SAME per-user manual-send window as the send route (not a second budget,
    // which would let a client machine-gun 30 sends + 30 retries/min — spec §1).
    const calls: SendMessageInput[] = [];
    const app = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: ORIGIN_SECRET,
        RATE_LIMIT_MANUAL_SEND_PER_MIN: '2',
      } as NodeJS.ProcessEnv),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem()]).repo },
      api: {
        conversationsRepo: {
          async getById() {
            return undefined; // not a relay group — the 1:1 path
          },
        } as unknown as ConversationsRepo,
        messagesRepo: {
          async getByProviderSid() {
            return undefined; // no original → the retry handler 404s AFTER the limiter admits
          },
        } as unknown as MessagesRepo,
        sendMessageService: async (input) => {
          calls.push(input);
          return {
            conversationId: input.conversationId,
            providerSid: `SMfake-${calls.length}`,
            tsMsgId: `2026-07-02T10:00:00.000Z#SMfake-${calls.length}`,
            status: 'queued',
          };
        },
      },
    });
    const send = () =>
      request(app)
        .post('/api/conversations/conv-1/messages')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ body: 'hi' });
    const retry = () =>
      request(app)
        .post('/api/conversations/conv-1/messages/SMorig/retry')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});

    // Ceiling is 2, SHARED across send + retry.
    expect((await send()).status).toBe(201); // slot 1 — a real send
    expect((await retry()).status).toBe(404); // slot 2 — limiter admits (shared), handler 404s (no original)
    const limited = await retry(); // slot 3 — the SHARED budget is spent
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // The 429'd retry never reached the handler; the 404 retry never sent. Only the
    // one real send fired — proving retry consumes the manual-send window.
    expect(calls).toHaveLength(1);
  });

  it('broadcast send: the limiter fronts the handler (429 past the ceiling, recovers)', async () => {
    const harness = makeWebhookHarness({ env: { RATE_LIMIT_BROADCAST_SEND_PER_MIN: '2' } });
    // A nonexistent broadcast: the handler answers 404 — but the limiter runs
    // FIRST and meters the requests, so the third answers 429, not 404.
    const send = () =>
      request(harness.app)
        .post('/api/broadcasts/no-such-broadcast/send')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});

    expect((await send()).status).toBe(404);
    expect((await send()).status).toBe(404);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    vi.setSystemTime(Date.now() + 61_000);
    expect((await send()).status).toBe(404); // window rolled — back to the handler
  });

  it('call originate: 429 past the ceiling places NO call, recovers after the window', async () => {
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-target',
      type: 'tenant',
      phone: TARGET,
      firstName: 'Jane',
      lastName: 'Doe',
    } as ContactItem);
    const harness = makeWebhookHarness({
      world,
      env: { RATE_LIMIT_ORIGINATE_PER_MIN: '2' },
    });
    const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    nav.cell = NAV_CELL;
    nav.cell_verified_at = '2026-07-01T00:00:00.000Z';
    const call = () =>
      request(harness.app)
        .post('/api/contacts/c-target/call')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(world.initiatedCalls).toHaveLength(2);

    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    // No side effect: no third call initiated, no third call entry persisted.
    expect(world.initiatedCalls).toHaveLength(2);
    expect(world.messages.filter((m) => m.type === 'call')).toHaveLength(2);

    vi.setSystemTime(Date.now() + 61_000);
    expect((await call()).status).toBe(200);
    expect(world.initiatedCalls).toHaveLength(3);
  });

  it('cell verify-start (DEFAULT ceilings): 4th start in the window → 429, NO SMS, pending state untouched; per-user isolated; recovers', async () => {
    const world = createFakeWorld();
    const harness = makeWebhookHarness({ world }); // defaults: 3 per 180000ms
    const start = (cookie = TEST_SESSION_COOKIE) =>
      request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', cookie)
        .send({ cell: '(404) 982-4978' });

    for (let i = 0; i < 3; i += 1) expect((await start()).status).toBe(200);
    expect(world.sent).toHaveLength(3); // one code SMS per admitted start

    // Freeze the pending-verification state after the 3rd start; poison the
    // attempt counter so an (incorrect) reset by the 4th request would show.
    const user = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    const pendingHash = user.cell_verify_code_hash;
    const pendingExpiry = user.cell_verify_expires_at;
    expect(typeof pendingHash).toBe('string');
    user.cell_verify_attempts = 4;

    const limited = await start();
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(180);
    // NO SMS dispatched, and the pending verification (hash / expiry /
    // attempt budget) is EXACTLY as the 3rd start left it — a 429'd resend
    // must not hand out a fresh code or a fresh guess budget.
    expect(world.sent).toHaveLength(3);
    expect(user.cell_verify_code_hash).toBe(pendingHash);
    expect(user.cell_verify_expires_at).toBe(pendingExpiry);
    expect(user.cell_verify_attempts).toBe(4);

    // Per-user isolation: the admin's quota is their own.
    expect((await start(TEST_ADMIN_COOKIE)).status).toBe(200);
    expect(world.sent).toHaveLength(4);

    // Past the 3-minute window the va's starts admit again.
    vi.setSystemTime(Date.now() + 181_000);
    expect((await start()).status).toBe(200);
    expect(world.sent).toHaveLength(5);
  });

  it('per-ROUTE isolation end-to-end: maxing verify_start leaves originate unmetered', async () => {
    const world = createFakeWorld();
    world.contacts.push({
      contactId: 'c-target',
      type: 'tenant',
      phone: TARGET,
      firstName: 'Jane',
      lastName: 'Doe',
    } as ContactItem);
    const harness = makeWebhookHarness({
      world,
      env: { RATE_LIMIT_VERIFY_START_MAX: '1', RATE_LIMIT_ORIGINATE_PER_MIN: '5' },
    });
    const nav = harness.fakeUsers.users.get(TEST_SESSION_USER.userId)!;
    nav.cell = NAV_CELL;
    nav.cell_verified_at = '2026-07-01T00:00:00.000Z';
    const start = () =>
      request(harness.app)
        .post('/api/users/me/cell/verify-start')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ cell: '(404) 982-4978' });

    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(429); // verify_start capped for this user…
    const call = await request(harness.app)
      .post('/api/contacts/c-target/call')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({});
    expect(call.status).toBe(200); // …originate is a separate bucket.
  });

  it('429 responses carry the on-limit WARN with IDs only (no phone, no body text)', async () => {
    const harness = makeWebhookHarness({ env: { RATE_LIMIT_BROADCAST_SEND_PER_MIN: '1' } });
    const send = () =>
      request(harness.app)
        .post('/api/broadcasts/no-such-broadcast/send')
        .set('x-origin-verify', ORIGIN_SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({});
    await send();
    expect((await send()).status).toBe(429);
    const warns = harness.capture
      .atLevel(40)
      .filter((l) => l['msg'] === 'per-user rate limit exceeded');
    expect(warns).toHaveLength(1);
    expect(warns[0]!['routeKey']).toBe('broadcast_send');
    expect(warns[0]!['userId']).toBe(TEST_SESSION_USER.userId);
  });
});

