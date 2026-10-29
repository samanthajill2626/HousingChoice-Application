// The rankings API (WP1 B2a spec D12): rank, read and the job poll for admin
// AND va (plain requireAuth via the /api mount - WI17), the rank POST alone
// rate limited per user by RATE_LIMIT_RANK_PER_MIN (429 rate_limited with
// Retry-After), 404 / 409 / 400 / 503 mapped, and the press carrying the
// request's requestId and a traceparent into the claim. Through buildApp, so
// the mount and the locked chain are exercised for real.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { isValidTraceparent } from '../src/lib/context.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { RankingsRouterDeps } from '../src/routes/rankings.js';
import type { ClaimResult, RankingPress } from '../src/services/ranking/job.js';
import type { RankingRead } from '../src/services/ranking/readRanking.js';
import type { AnchorRef } from '../src/services/ranking/types.js';
import {
  adminUserItem,
  makeFakeUsersRepo,
  TEST_ADMIN_COOKIE,
  TEST_ADMIN_USER,
  TEST_SESSION_COOKIE,
  TEST_SESSION_USER,
  testUserItem,
} from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { ANCHOR_UNIT, isoAt, PRESS_TRACEPARENT, queuedJob, T0 } from './helpers/rankingJobFixtures.js';

const SECRET = 'test-origin-secret';
const ANCHOR_BLOCK = { kind: 'unit' as const, id: ANCHOR_UNIT, display: '12 Oak St, Atlanta', anchorNotes: [], missing: [], cardChanged: false };

function makeApp(over: Partial<Omit<RankingsRouterDeps, 'config' | 'logger'>> = {}, perMin = '2') {
  const presses: Array<{ anchor: AnchorRef; press: RankingPress }> = [];
  const reads: Array<{ anchor: AnchorRef; includeOlder: boolean }> = [];
  let claimResult: ClaimResult = { status: 202, job: queuedJob(), joined: false };
  let readResult: RankingRead = { kind: 'ok', anchor: ANCHOR_BLOCK, job: null, rows: [], flags: [], poolWindowDays: 90 };
  const app = buildApp({
    config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET, RATE_LIMIT_RANK_PER_MIN: perMin }),
    logger: createLogger({ destination: createLogCapture().stream }),
    auth: { usersRepo: makeFakeUsersRepo([testUserItem(), adminUserItem()]).repo },
    api: {
      rankings: {
        claim: async (anchor, press) => {
          presses.push({ anchor, press });
          return claimResult;
        },
        read: async (anchor, opts) => {
          reads.push({ anchor, includeOlder: opts.includeOlder });
          return readResult;
        },
        getJob: async () => queuedJob({ requestedAt: isoAt(-700_000) }),
        now: () => new Date(T0),
        ...over,
      },
    },
  });
  return {
    app,
    presses,
    reads,
    setClaim: (r: ClaimResult) => { claimResult = r; },
    setRead: (r: RankingRead) => { readResult = r; },
  };
}

const post = (app: ReturnType<typeof makeApp>['app'], path: string, cookie = TEST_SESSION_COOKIE) =>
  request(app).post(path).set('x-origin-verify', SECRET).set('cookie', cookie);
const get = (app: ReturnType<typeof makeApp>['app'], path: string, cookie = TEST_SESSION_COOKIE) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', cookie);

describe('POST /api/rankings/:anchorKind/:anchorId/rank', () => {
  it('a VA can rank (WI17): 202 with the job view and joined', async () => {
    const h = makeApp();
    const res = await post(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/rank`).send({ includeOlder: true });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      joined: false,
      job: {
        status: 'queued', generation: 'gen-1', includeOlder: false, requestedAt: T0, batchCount: 0,
        batchesDone: [], failedBatches: [], notScored: [],
      },
    });
    expect(h.presses[0]?.anchor).toEqual({ kind: 'unit', id: ANCHOR_UNIT });
    expect(h.presses[0]?.press).toMatchObject({ includeOlder: true, requestedBy: TEST_SESSION_USER.userId });
  });

  it('an admin can rank too', async () => {
    const h = makeApp();
    expect((await post(h.app, '/api/rankings/tenant/t-1/rank', TEST_ADMIN_COOKIE).send({})).status).toBe(202);
    expect(h.presses[0]).toMatchObject({ anchor: { kind: 'tenant', id: 't-1' }, press: { includeOlder: false, requestedBy: TEST_ADMIN_USER.userId } });
  });

  it('the press carries the request id and the inbound traceparent', async () => {
    const h = makeApp();
    const res = await post(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/rank`).set('traceparent', PRESS_TRACEPARENT).send({});
    expect(h.presses[0]?.press.requestId).toBe(res.headers['x-request-id']);
    expect(h.presses[0]?.press.traceparent).toBe(PRESS_TRACEPARENT);
  });

  it('without an inbound traceparent the press carries a fresh valid one', async () => {
    const h = makeApp();
    await post(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/rank`).send({});
    expect(isValidTraceparent(h.presses[0]?.press.traceparent ?? '')).toBe(true);
  });

  it('a joined press answers 202 joined: true', async () => {
    const h = makeApp();
    h.setClaim({ status: 202, job: queuedJob({ generation: 'gen-live' }), joined: true });
    const res = await post(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/rank`).send({});
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ joined: true, job: { generation: 'gen-live' } });
  });

  it('409 ranking_running with the plain message', async () => {
    const h = makeApp();
    h.setClaim({ status: 409, error: 'ranking_running' });
    const res = await post(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/rank`).send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'ranking_running', message: 'A ranking is running for this record. Try again when it finishes.' });
  });

  it('404 anchor_not_found', async () => {
    const h = makeApp();
    h.setClaim({ status: 404 });
    const res = await post(h.app, '/api/rankings/unit/nope/rank').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'anchor_not_found' });
  });

  it('400 on an unknown anchor kind, a blank id or a non-boolean includeOlder; the id is trimmed', async () => {
    // The limiter sits ahead of the handler and counts every POST, 400s too:
    // give this case room for its four presses.
    const h = makeApp({}, '10');
    expect((await post(h.app, '/api/rankings/landlord/x/rank').send({})).body).toEqual({ error: 'invalid_anchor_kind' });
    expect((await post(h.app, '/api/rankings/unit/%20%20/rank').send({})).body).toEqual({ error: 'invalid_anchor_id' });
    expect((await post(h.app, '/api/rankings/unit/u1/rank').send({ includeOlder: 'yes' })).body).toEqual({ error: 'invalid_include_older' });
    await post(h.app, '/api/rankings/unit/%20u1%20/rank').send({});
    expect(h.presses.at(-1)?.anchor).toEqual({ kind: 'unit', id: 'u1' });
  });

  it('rate limits the press per user (RATE_LIMIT_RANK_PER_MIN): the next press is 429 with Retry-After, no claim', async () => {
    const h = makeApp({}, '2');
    await post(h.app, '/api/rankings/unit/u1/rank').send({}).expect(202);
    await post(h.app, '/api/rankings/unit/u2/rank').send({}).expect(202);
    const limited = await post(h.app, '/api/rankings/unit/u3/rank').send({});
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(h.presses).toHaveLength(2);
    // Another user's quota is their own.
    await post(h.app, '/api/rankings/unit/u3/rank', TEST_ADMIN_COOKIE).send({}).expect(202);
  });

  it('reads and the job poll are not rate limited', async () => {
    const h = makeApp({}, '1');
    for (let i = 0; i < 4; i += 1) {
      await get(h.app, '/api/rankings/unit/u1').expect(200);
      await get(h.app, '/api/rankings/unit/u1/job').expect(200);
    }
  });

  it('401 without a session', async () => {
    const h = makeApp();
    expect((await request(h.app).get('/api/rankings/unit/u1').set('x-origin-verify', SECRET)).status).toBe(401);
  });
});

describe('GET /api/rankings/:anchorKind/:anchorId', () => {
  it('a VA reads the ranking (WI17), with the window days (PR26); includeOlder parsed from the query', async () => {
    const h = makeApp();
    const res = await get(h.app, `/api/rankings/unit/${ANCHOR_UNIT}?includeOlder=true`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ anchor: ANCHOR_BLOCK, job: null, rows: [], flags: [], poolWindowDays: 90 });
    expect(h.reads[0]).toEqual({ anchor: { kind: 'unit', id: ANCHOR_UNIT }, includeOlder: true });
    await get(h.app, `/api/rankings/unit/${ANCHOR_UNIT}`);
    expect(h.reads[1]?.includeOlder).toBe(false);
  });

  it('400 on a bad includeOlder', async () => {
    const h = makeApp();
    expect((await get(h.app, '/api/rankings/unit/u1?includeOlder=maybe')).status).toBe(400);
  });

  it('PR16: poolTooLarge answers 200 with the anchor block and no rows', async () => {
    const h = makeApp();
    h.setRead({ kind: 'ok', anchor: ANCHOR_BLOCK, job: null, rows: [], flags: [], poolWindowDays: 90, poolTooLarge: { size: 412, message: 'Pool too large to rank (412 candidates)' } });
    const res = await get(h.app, '/api/rankings/unit/u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ anchor: ANCHOR_BLOCK, job: null, rows: [], flags: [], poolWindowDays: 90, poolTooLarge: { size: 412, message: 'Pool too large to rank (412 candidates)' } });
  });

  it('404 when the anchor is not found; 503 ranking_unavailable when the ranking cannot be read', async () => {
    const h = makeApp();
    h.setRead({ kind: 'not_found' });
    expect((await get(h.app, '/api/rankings/unit/u1')).status).toBe(404);
    h.setRead({ kind: 'unavailable', message: 'This record could not be read in full. Try again.' });
    const res = await get(h.app, '/api/rankings/unit/u1');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'ranking_unavailable', message: 'This record could not be read in full. Try again.' });
  });
});

describe('GET /api/rankings/:anchorKind/:anchorId/job', () => {
  it('a VA polls the job: the view with expired derived', async () => {
    const h = makeApp();
    const res = await get(h.app, `/api/rankings/unit/${ANCHOR_UNIT}/job`);
    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ status: 'expired', message: 'The ranking was not picked up. Press Rank again.' });
  });

  it('job: null when the anchor has never been ranked', async () => {
    const h = makeApp({ getJob: async () => undefined });
    expect((await get(h.app, '/api/rankings/unit/u1/job')).body).toEqual({ job: null });
  });
});
