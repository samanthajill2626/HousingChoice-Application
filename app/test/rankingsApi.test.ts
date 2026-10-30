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
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { UnitItem } from '../src/repos/unitsRepo.js';
import type { RankingsRouterDeps } from '../src/routes/rankings.js';
import type { AssembleResult } from '../src/services/ranking/assemble.js';
import { DEFAULT_FLAG_REASON, textHashOf } from '../src/services/ranking/flags.js';
import type { ClaimResult, RankingPress } from '../src/services/ranking/job.js';
import { readRanking, type RankingRead, type RankingReadDeps } from '../src/services/ranking/readRanking.js';
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
import {
  ANCHOR_UNIT,
  assembled,
  facts,
  flagRecord,
  isoAt,
  PRESS_TRACEPARENT,
  propertyCandidate,
  queuedJob,
  T0,
  tenantAnchor,
  unitAnchor,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake } from './helpers/rankingRunsFake.js';

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

  // Spec D10 rev 7 (charter item 16, PFW1-2), through the REAL read: open
  // unlawful flags appear only for a property anchor. A tenant anchor still
  // reads each candidate property's flags (they suppress the cap) but its
  // answer carries flags: [].
  function readThrough(result: AssembleResult) {
    const runs = createRankingRunsFake();
    for (const unitId of [ANCHOR_UNIT, 'u-1']) {
      const flag = flagRecord({ unitId, field: 'qualifications', textHash: textHashOf('No kids.'), reason: DEFAULT_FLAG_REASON, runId: 'run-1', raisedAt: T0 });
      runs.flags.set(flag.itemId, flag);
    }
    const deps: RankingReadDeps = {
      assemble: async () => result,
      poolTooLargeMissing: async () => [],
      jobs: runs.repo,
      matches: createMatchesFake([]).repo,
      config: {
        rankingMaxAgeDays: 7,
        rankingPriorityStrength: 'within_band',
        rankingDriver: 'fake',
        aiRankingModel: 'claude-sonnet-5-5',
        rankingReadConcurrency: 4,
        rankingPoolWindowDays: 90,
      },
      logger: createLogger({ destination: createLogCapture().stream }),
    };
    return makeApp({ read: (anchor, opts) => readRanking(anchor, opts, deps) });
  }
  const noKids = facts({ freeTextByField: { qualifications: 'No kids.' } });

  it("a tenant anchor answers flags: [] although a candidate property's flag is open", async () => {
    const h = readThrough(assembled(tenantAnchor(), [propertyCandidate('u-1', { propertyFacts: noKids })]));
    const res = await get(h.app, '/api/rankings/tenant/tenant-anchor');
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r: { candidateId: string }) => r.candidateId)).toEqual(['u-1']);
    expect(res.body.flags).toEqual([]);
  });

  it("a property anchor answers its own open flags with the fixed reason", async () => {
    const h = readThrough(assembled(unitAnchor({ propertyFacts: noKids }), []));
    const res = await get(h.app, `/api/rankings/unit/${ANCHOR_UNIT}`);
    expect(res.status).toBe(200);
    expect(res.body.flags).toEqual([
      { unitId: ANCHOR_UNIT, field: 'qualifications', reason: DEFAULT_FLAG_REASON, runId: 'run-1', raisedAt: T0 },
    ]);
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

// The property page's read-only fair-housing notice (spec D10 rev 7, charter
// item 16; PFW1-3): one property's OPEN unlawful flags for admin AND va,
// through the real wiring - the consistent unit read, the landlord-card
// switch and the landlord defaults (assemble.ts propertyFactsOf) and the ONE
// open rule (flags.ts openFlags). Each flag carries its field's human label
// and the fixed reason.
describe('GET /api/rankings/unit/:unitId/flags', () => {
  const UNIT_ID = 'unit-flags-1';
  const LANDLORD_ID = 'contact-landlord-1';
  const record = (field: string, text: string, unitId = UNIT_ID) =>
    flagRecord({ unitId, field, textHash: textHashOf(text), reason: DEFAULT_FLAG_REASON, runId: 'run-1', raisedAt: T0 });

  function flagsApp(opts: {
    units: UnitItem[];
    landlords?: ContactItem[];
    records: ReturnType<typeof record>[];
    landlordCard?: boolean;
    failFlags?: boolean;
  }) {
    const unitReads: Array<{ unitId: string; consistentRead: boolean }> = [];
    const flagReads: string[] = [];
    const contacts = new Map((opts.landlords ?? []).map((c) => [c.contactId, c]));
    const rankings: Partial<Omit<RankingsRouterDeps, 'config' | 'logger'>> = {
      unitsRepo: {
        getById: async (unitId, o) => {
          unitReads.push({ unitId, consistentRead: o?.consistentRead === true });
          const unit = opts.units.find((u) => u.unitId === unitId);
          return unit === undefined ? undefined : structuredClone(unit);
        },
      },
      contactsRepo: {
        getById: async (contactId) => contacts.get(contactId),
        getManyByIds: async (ids) => new Map(ids.flatMap((id) => (contacts.has(id) ? [[id, contacts.get(id)!] as const] : []))),
      },
      flagsRepo: {
        getOpenCandidateFlags: async (unitId) => {
          flagReads.push(unitId);
          if (opts.failFlags === true) throw new Error('throttled');
          return opts.records.filter((r) => r.unitId === unitId);
        },
      },
    };
    const app = buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        CF_ORIGIN_SECRET: SECRET,
        RANKING_LANDLORD_CARD: opts.landlordCard === true ? 'true' : 'false',
      }),
      logger: createLogger({ destination: createLogCapture().stream }),
      auth: { usersRepo: makeFakeUsersRepo([testUserItem(), adminUserItem()]).repo },
      api: { rankings },
    });
    return { app, unitReads, flagReads };
  }
  const unit = (over: Partial<UnitItem> = {}): UnitItem =>
    ({ unitId: UNIT_ID, landlordId: LANDLORD_ID, status: 'available', ...over }) as UnitItem;

  it('a VA (and an admin) reads the OPEN flags only, each with its label and the fixed reason, from a consistent unit read', async () => {
    const h = flagsApp({
      units: [unit({ qualifications: 'No kids under 12.', notes: 'Edited since.' } as Partial<UnitItem>)],
      records: [record('qualifications', 'No kids under 12.'), record('notes', 'Adults only.')],
    });
    const res = await get(h.app, `/api/rankings/unit/${UNIT_ID}/flags`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      flags: [{ field: 'qualifications', label: 'Qualifications', reason: 'flagged as a requirement fair housing does not allow' }],
    });
    expect(h.unitReads).toEqual([{ unitId: UNIT_ID, consistentRead: true }]);
    expect((await get(h.app, `/api/rankings/unit/${UNIT_ID}/flags`, TEST_ADMIN_COOKIE)).body.flags).toHaveLength(1);
  });

  it('an edit to the flagged text closes the flag on the next read: no notice', async () => {
    const stored = unit({ qualifications: 'No kids under 12.' } as Partial<UnitItem>);
    const h = flagsApp({ units: [stored], records: [record('qualifications', 'No kids under 12.')] });
    expect((await get(h.app, `/api/rankings/unit/${UNIT_ID}/flags`)).body.flags).toHaveLength(1);
    (stored as Record<string, unknown>)['qualifications'] = 'Two years of rental history.';
    const res = await get(h.app, `/api/rankings/unit/${UNIT_ID}/flags`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flags: [] });
  });

  it('a landlord: flag is open while the landlord default is on the card, named in plain copy, and closes when it leaves', async () => {
    const landlord = { contactId: LANDLORD_ID, type: 'landlord', req_qualifications: 'No kids.' } as unknown as ContactItem;
    const records = [record('landlord:qualifications', 'No kids.')];
    const on = flagsApp({ units: [unit()], landlords: [landlord], records, landlordCard: true });
    expect((await get(on.app, `/api/rankings/unit/${UNIT_ID}/flags`)).body).toEqual({
      flags: [
        { field: 'landlord:qualifications', label: 'Qualifications (from the landlord)', reason: 'flagged as a requirement fair housing does not allow' },
      ],
    });
    // The switch off: the landlord default is not on the card.
    const off = flagsApp({ units: [unit()], landlords: [landlord], records, landlordCard: false });
    expect((await get(off.app, `/api/rankings/unit/${UNIT_ID}/flags`)).body).toEqual({ flags: [] });
    // The property now records its own value: the property's own wins.
    const own = flagsApp({
      units: [unit({ qualifications: 'Two years of rental history.' } as Partial<UnitItem>)],
      landlords: [landlord],
      records,
      landlordCard: true,
    });
    expect((await get(own.app, `/api/rankings/unit/${UNIT_ID}/flags`)).body).toEqual({ flags: [] });
  });

  it('400 for a tenant kind; 404 for a missing or soft-deleted property, reading no flags', async () => {
    const h = flagsApp({
      units: [unit({ unitId: 'unit-gone', deleted_at: '2026-10-01T00:00:00.000Z' } as Partial<UnitItem>)],
      records: [record('qualifications', 'No kids.', 'unit-gone')],
    });
    const tenant = await get(h.app, '/api/rankings/tenant/t-1/flags');
    expect(tenant.status).toBe(400);
    expect(tenant.body).toEqual({ error: 'invalid_anchor_kind' });
    const missing = await get(h.app, '/api/rankings/unit/nope/flags');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'anchor_not_found' });
    expect((await get(h.app, '/api/rankings/unit/unit-gone/flags')).status).toBe(404);
    expect(h.flagReads).toEqual([]);
  });

  it('a failed read answers 503 flags_unavailable', async () => {
    const h = flagsApp({ units: [unit({ qualifications: 'No kids.' } as Partial<UnitItem>)], records: [], failFlags: true });
    const res = await get(h.app, `/api/rankings/unit/${UNIT_ID}/flags`);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'flags_unavailable' });
  });

  it('401 without a session', async () => {
    const h = flagsApp({ units: [unit()], records: [] });
    expect((await request(h.app).get(`/api/rankings/unit/${UNIT_ID}/flags`).set('x-origin-verify', SECRET)).status).toBe(401);
  });
});
