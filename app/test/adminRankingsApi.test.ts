// The admin Rankings API (WP1 B2a spec D12, D18 data): admin only on the
// server (requireRole('admin'); WI17). The runs list reads rankingRunsRepo's
// own pointers (rankings#global or rankings#<kind>#<id>) and always names the
// anchor; the run detail renders the run's OWN results[] in S7's names and
// links each pair to its current match's run (a tenant-anchor run's pairs
// drop their unlawful flags, spec D10 rev 7); the cost totals by ISO week
// and environment.
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import type { ContactDisplayItem } from '../src/repos/contactsRepo.js';
import type { RankingRunRecord, RankingRunsRepo } from '../src/repos/rankingRunsRepo.js';
import type { UnitDisplayItem } from '../src/repos/unitsRepo.js';
import { costRange, defaultCostRange, isoWeekOf, type AdminRankingsRouterDeps } from '../src/routes/adminRankings.js';
import { textHashOf } from '../src/services/ranking/flags.js';
import {
  adminUserItem,
  makeFakeUsersRepo,
  TEST_ADMIN_COOKIE,
  TEST_SESSION_COOKIE,
  testUserItem,
} from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { ANCHOR_UNIT, facts, flagRecord, matchRow, rankingRun, T0 } from './helpers/rankingJobFixtures.js';
import { createMatchesFake } from './helpers/rankingRunsFake.js';

const SECRET = 'test-origin-secret';
const config = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET, ...env });

type ListRuns = RankingRunsRepo['listRuns'];

function makeApp(opts: {
  runs?: RankingRunRecord[];
  listRuns?: ListRuns;
  seedMatches?: ReturnType<typeof matchRow>[];
  namelessContacts?: boolean;
  now?: () => Date;
  /** WORKLIST WL-S6-4: each property's flag read; the anchor unit's open + closed pair otherwise. */
  flagsFor?: RankingRunsRepo['getOpenCandidateFlags'];
  /** Extra config env (e.g. RANKING_READ_CONCURRENCY). */
  configEnv?: Record<string, string>;
} = {}) {
  const runs = opts.runs ?? [rankingRun()];
  const listRuns = vi.fn<ListRuns>(
    opts.listRuns ??
      (async () => ({
        entries: runs.map((run) => ({ runId: run.runId, sortKey: `${run.startedAt}#${run.runId}`, expired: false as const, run })),
      })),
  );
  const open = flagRecord({ unitId: ANCHOR_UNIT, field: 'qualifications', textHash: textHashOf('No kids.'), reason: 'no kids', runId: 'run-1', raisedAt: T0 });
  const closed = flagRecord({ unitId: ANCHOR_UNIT, field: 'notes', textHash: textHashOf('Old text.'), reason: 'r', runId: 'run-1', raisedAt: T0 });
  const matches = createMatchesFake(opts.seedMatches ?? []);
  const adminRankings: Partial<Omit<AdminRankingsRouterDeps, 'config' | 'logger'>> = {
    runsRepo: {
      listRuns,
      getRun: async (runId) => runs.find((run) => run.runId === runId),
      getOpenCandidateFlags: opts.flagsFor ?? (async (unitId) => (unitId === ANCHOR_UNIT ? [open, closed] : [])),
    },
    matchesRepo: matches.repo,
    contactsRepo: {
      getDisplaysByIds: async (ids) =>
        new Map(
          ids.map((id) => [
            id,
            (opts.namelessContacts === true ? { contactId: id } : { contactId: id, firstName: 'Ada', lastName: 'Example' }) as ContactDisplayItem,
          ]),
        ),
    },
    unitsRepo: {
      getDisplaysByIds: async (ids) =>
        new Map(ids.map((id) => [id, { unitId: id, address: { line1: '12 Oak St', city: 'Atlanta' } } as UnitDisplayItem])),
    },
    propertyFacts: async (unitIds) =>
      new Map(unitIds.map((id) => [id, facts({ freeTextByField: { qualifications: 'No kids.', notes: 'New text.' } })])),
    ...(opts.now !== undefined && { now: opts.now }),
  };
  const app = buildApp({
    config: config(opts.configEnv),
    logger: createLogger({ destination: createLogCapture().stream }),
    auth: { usersRepo: makeFakeUsersRepo([testUserItem(), adminUserItem()]).repo },
    api: { adminRankings },
  });
  return { app, listRuns, matches };
}

const admin = (app: ReturnType<typeof makeApp>['app'], path: string) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_ADMIN_COOKIE);
const va = (app: ReturnType<typeof makeApp>['app'], path: string) =>
  request(app).get(path).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);

describe('admin only (WI17)', () => {
  it.each(['/api/admin/rankings/runs', '/api/admin/rankings/runs/run-1', '/api/admin/rankings/cost'])('403s a VA on %s', async (path) => {
    const { app } = makeApp();
    await va(app, path).expect(403);
  });
});

describe('GET /api/admin/rankings/runs', () => {
  it('lists the global pointers newest first with the anchor display, direction, model, candidates, cost, latency, time and outcome', async () => {
    const { app, listRuns } = makeApp({
      runs: [
        rankingRun({ runId: 'run-2', costUsd: 0.0123 }),
        rankingRun({ runId: 'run-1', anchorKind: 'tenant', anchorId: 't-9', direction: 'properties_for_tenant' }),
      ],
    });
    const res = await admin(app, '/api/admin/rankings/runs');
    expect(res.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith({ entityKey: 'rankings#global', limit: 25 });
    expect(res.body.runs[0]).toEqual({
      runId: 'run-2', expired: false, startedAt: T0, finishedAt: rankingRun().finishedAt, anchorKind: 'unit', anchorId: ANCHOR_UNIT,
      anchorDisplay: '12 Oak St, Atlanta', direction: 'tenants_for_property', batchIndex: 0, candidateCount: 2, driver: 'fake',
      model: 'fake', costUsd: 0.0123, latencyMs: 7, outcome: 'scored', environment: 'local',
    });
    expect(res.body.runs[1]).toMatchObject({ runId: 'run-1', anchorKind: 'tenant', anchorDisplay: 'Ada Example' });
  });

  it('IR21: an anchor with no name or label falls back to its id', async () => {
    const { app } = makeApp({ runs: [rankingRun({ anchorKind: 'tenant', anchorId: 't-9' })], namelessContacts: true });
    expect((await admin(app, '/api/admin/rankings/runs')).body.runs[0]?.anchorDisplay).toBe('t-9');
  });

  it('an expired pointer reads expired; the next cursor passes through; no incomplete key on a fully read page', async () => {
    const { app } = makeApp({
      listRuns: async () => ({ entries: [{ runId: 'run-gone', sortKey: `${T0}#run-gone`, expired: true }], nextCursor: 'cursor-2' }),
    });
    expect((await admin(app, '/api/admin/rankings/runs?cursor=cursor-1')).body).toEqual({ runs: [{ runId: 'run-gone', expired: true }], nextCursor: 'cursor-2' });
  });

  it('PR34: a run S2 could not read after its retries reads expired and the page says incomplete: true', async () => {
    const { app } = makeApp({
      listRuns: async () => ({
        entries: [
          { runId: 'run-1', sortKey: `${T0}#run-1`, expired: false, run: rankingRun() },
          { runId: 'run-unread', sortKey: `${T0}#run-unread`, expired: true, unavailable: true },
        ],
        incomplete: true,
      }),
    });
    const body = (await admin(app, '/api/admin/rankings/runs')).body;
    expect(body.incomplete).toBe(true);
    expect(body.runs[1]).toEqual({ runId: 'run-unread', expired: true });
    expect(body.runs[0]).toMatchObject({ runId: 'run-1', expired: false });
  });

  it('filters by anchor (both or neither), date range and cursor; caps limit at 100', async () => {
    const { app, listRuns } = makeApp();
    await admin(app, '/api/admin/rankings/runs?anchorKind=tenant&anchorId=%20t-9%20&from=2026-10-01&to=2026-10-28&cursor=c1&limit=500').expect(200);
    expect(listRuns).toHaveBeenCalledWith({ entityKey: 'rankings#tenant#t-9', from: '2026-10-01', to: '2026-10-28', cursor: 'c1', limit: 100 });
  });

  it.each([
    ['?anchorKind=unit', 'invalid_anchor'],
    ['?anchorId=u1', 'invalid_anchor'],
    ['?anchorKind=landlord&anchorId=u1', 'invalid_anchor'],
    ['?from=2026-02-30', 'invalid_from'],
    ['?to=yesterday', 'invalid_to'],
  ])('400 on %s', async (query, error) => {
    const { app } = makeApp();
    const res = await admin(app, `/api/admin/rankings/runs${query}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error });
  });
});

describe('GET /api/admin/rankings/runs/:runId', () => {
  it('404 run_not_found', async () => {
    const { app } = makeApp();
    const res = await admin(app, '/api/admin/rankings/runs/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'run_not_found' });
  });

  it("renders the run's OWN results in S7's names: band by bandOf, cappedAtRun, missing, and currentRunId (PR14)", async () => {
    const { app } = makeApp({
      seedMatches: [
        matchRow({ tenantId: 't-1', unitId: ANCHOR_UNIT, runId: 'run-1', score: 85 }),
        matchRow({ tenantId: 't-2', unitId: ANCHOR_UNIT, runId: 'run-later', score: 40 }),
      ],
    });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.pairs).toEqual([
      {
        candidateId: 't-1', handle: 'c1', display: 'Tenant t-1', returned: true, score: 85, band: 'strong',
        cappedAtRun: false, capReason: null, for: [{ text: 'voucher size fits', source: 'voucher_size' }], against: [],
        missing: [], unknowns: [], failedRequirements: [], fairHousingFlags: [], currentRunId: 'run-1', sinceRescored: false,
      },
      {
        candidateId: 't-2', handle: 'c2', display: 'Tenant t-2', returned: true, score: 70, band: 'weak',
        cappedAtRun: true, capReason: 'requirement not met', for: [], against: [{ text: 'no pets, has a cat', source: 'pets' }],
        missing: [{ key: 'payment_standard', text: 'Payment standard' }, { text: 'move-in date' }], unknowns: ['move-in date'],
        failedRequirements: ['no_pets'], fairHousingFlags: [], currentRunId: 'run-later', sinceRescored: true,
      },
    ]);
  });

  it('a pair with no current match reads currentRunId null; a candidate not returned reads returned: false with no score', async () => {
    const run = rankingRun({ results: [{ handle: 'c1', candidateId: 't-1', display: 'Tenant t-1', returned: false }, rankingRun().results[1]!] });
    const { app } = makeApp({ runs: [run] });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.body.pairs[0]).toEqual({
      candidateId: 't-1', handle: 'c1', display: 'Tenant t-1', returned: false, cappedAtRun: false, capReason: null,
      for: [], against: [], missing: [], unknowns: [], failedRequirements: [], fairHousingFlags: [], currentRunId: null, sinceRescored: false,
    });
    expect(res.body.pairs[1]).toMatchObject({ currentRunId: null, sinceRescored: false });
  });

  it("carries the run's fields, a top-level anchorDisplay, the input decompressed, and the property's OPEN flags only", async () => {
    const { app } = makeApp();
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.body.anchorDisplay).toBe('12 Oak St, Atlanta');
    expect(res.body.run).toMatchObject({
      runId: 'run-1', anchorKind: 'unit', anchorId: ANCHOR_UNIT, direction: 'tenants_for_property', model: 'fake',
      rawText: '{"candidates":[]}', matchesWritten: { count: 2, at: rankingRun().matchesWritten!.at }, environment: 'local',
    });
    for (const key of ['inputGzip', 'itemId', 'handles', 'results', 'anchorDisplay']) expect(key in res.body.run).toBe(false);
    expect(res.body.input).toBe('the user message');
    expect(res.body.flags).toEqual([{ unitId: ANCHOR_UNIT, field: 'qualifications', reason: 'no kids', runId: 'run-1', raisedAt: T0 }]);
  });

  it('input: null when the run omitted it (350 KB guard)', async () => {
    const { inputGzip: _omit, ...rest } = rankingRun();
    const { app } = makeApp({ runs: [{ ...rest, inputOmitted: true }] });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.body.input).toBeNull();
    expect(res.body.run.inputOmitted).toBe(true);
  });

  it('an incomplete current-match read says so rather than marking nothing re-scored silently', async () => {
    const h = makeApp();
    h.matches.failGets = true;
    const res = await admin(h.app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.currentUnavailable).toBe(true);
    expect(res.body.pairs.every((p: { currentRunId: unknown }) => p.currentRunId === null)).toBe(true);
  });

  // Spec D10 rev 7 (charter item 16, PFW1-2): open flags show only for a
  // PROPERTY anchor's runs; a tenant-anchor run's candidate properties are
  // never read for flags.
  const tenantRun = (unitIds: string[]): RankingRunRecord =>
    rankingRun({
      anchorKind: 'tenant',
      anchorId: 't-9',
      direction: 'properties_for_tenant',
      results: unitIds.map((unitId, i) => ({ handle: `c${i + 1}`, candidateId: unitId, display: `${unitId} Elm St, Atlanta`, returned: false })),
    });
  const openFlagOf = (unitId: string) =>
    flagRecord({ unitId, field: 'qualifications', textHash: textHashOf('No kids.'), reason: 'no kids', runId: 'run-1', raisedAt: T0 });

  it('a tenant-anchor run reads no flag record: flags [] and no flagsUnavailable, even when a read would fail', async () => {
    const reads: string[] = [];
    const { app } = makeApp({
      runs: [tenantRun(['u-1', 'u-2', 'u-3'])],
      flagsFor: async (unitId) => {
        reads.push(unitId);
        if (unitId === 'u-2') throw new Error('throttled');
        return [openFlagOf(unitId)];
      },
    });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(reads).toEqual([]);
    expect(res.body.flags).toEqual([]);
    expect('flagsUnavailable' in res.body).toBe(false);
    // The run's own pairs are untouched.
    expect(res.body.pairs.map((p: { candidateId: string }) => p.candidateId)).toEqual(['u-1', 'u-2', 'u-3']);
  });

  it("(PIN) a property-anchor run whose property's flag read fails says flagsUnavailable and lists no flag", async () => {
    const { app } = makeApp({
      flagsFor: async () => {
        throw new Error('throttled');
      },
    });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.flagsUnavailable).toBe(true);
    expect(res.body.flags).toEqual([]);
  });

  // Spec D10 rev 7 (PFW1-6): a tenant anchor's runs carry no flag list, so a
  // pair's unlawful flag (about the property) leaves its detail; an
  // accommodation flag is about the pair and stays. A property-anchor run
  // answers both, as the run said.
  const bothKinds: NonNullable<RankingRunRecord['results'][number]['fairHousingFlags']> = [
    { kind: 'unlawful', field: 'qualifications' },
    { kind: 'accommodation', field: 'no_pets' },
  ];

  it("a tenant-anchor run's pair answers its accommodation flag and no unlawful flag", async () => {
    const run = tenantRun(['u-1']);
    const scored = {
      ...run.results[0]!,
      returned: true,
      score: 60,
      for: [],
      against: [],
      unknowns: [],
      missing: [],
      failedRequirements: [],
      fairHousingFlags: bothKinds,
      cappedAtRun: { capped: false, capReason: null },
    };
    const { app } = makeApp({ runs: [{ ...run, results: [scored] }] });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.pairs[0]).toMatchObject({ candidateId: 'u-1', returned: true, score: 60 });
    expect(res.body.pairs[0].fairHousingFlags).toEqual([{ kind: 'accommodation', field: 'no_pets' }]);
  });

  it("(PIN) a property-anchor run's pair answers both its unlawful and its accommodation flag", async () => {
    const run = rankingRun();
    const { app } = makeApp({ runs: [{ ...run, results: [{ ...run.results[0]!, fairHousingFlags: bothKinds }, run.results[1]!] }] });
    const res = await admin(app, '/api/admin/rankings/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.pairs[0].fairHousingFlags).toEqual(bothKinds);
    expect(res.body.pairs[1].fairHousingFlags).toEqual([]);
  });
});

describe('GET /api/admin/rankings/cost', () => {
  it("totals cost and tokens by ISO week and environment over every page in range, with this deployment's environment (IR20)", async () => {
    const listRuns = vi.fn<ListRuns>(async (opts) =>
      opts.cursor === undefined
        ? {
            entries: [
              { runId: 'a', sortKey: 'a', expired: false, run: rankingRun({ runId: 'a', startedAt: '2026-10-28T12:00:00.000Z', costUsd: 0.5, environment: 'local' }) },
              { runId: 'b', sortKey: 'b', expired: false, run: rankingRun({ runId: 'b', startedAt: '2026-10-26T01:00:00.000Z', costUsd: 0.25, environment: 'local' }) },
              { runId: 'gone', sortKey: 'gone', expired: true },
            ],
            nextCursor: 'c2',
          }
        : {
            entries: [
              { runId: 'c', sortKey: 'c', expired: false, run: rankingRun({ runId: 'c', startedAt: '2027-01-01T00:00:00.000Z', costUsd: 1, environment: 'dev' }) },
            ],
          },
    );
    const { app } = makeApp({ listRuns });
    const res = await admin(app, '/api/admin/rankings/cost?from=2026-10-01&to=2027-01-31');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      environment: config().appEnv,
      weeks: [
        { week: '2026-W53', environment: 'dev', runs: 1, inputTokens: 1000, outputTokens: 500, costUsd: 1 },
        { week: '2026-W44', environment: 'local', runs: 2, inputTokens: 2000, outputTokens: 1000, costUsd: 0.75 },
      ],
      totalUsd: 1.75,
      truncated: false,
    });
    expect(listRuns.mock.calls.map((c) => c[0])).toEqual([
      { entityKey: 'rankings#global', from: '2026-10-01', to: '2027-01-31', limit: 100 },
      { entityKey: 'rankings#global', from: '2026-10-01', to: '2027-01-31', limit: 100, cursor: 'c2' },
    ]);
  });

  it('400 on a bad date', async () => {
    const { app } = makeApp();
    expect((await admin(app, '/api/admin/rankings/cost?from=2026-13-01')).body).toEqual({ error: 'invalid_from' });
  });

  it('PR34: with neither from nor to, totals the last 12 ISO weeks (Monday 11 weeks back through today)', async () => {
    const { app, listRuns } = makeApp({ now: () => new Date('2026-10-28T15:00:00.000Z') });
    await admin(app, '/api/admin/rankings/cost').expect(200);
    expect(listRuns.mock.calls[0]?.[0]).toEqual({ entityKey: 'rankings#global', from: '2026-08-10', to: '2026-10-28', limit: 100 });
  });

  it('R2B6: a lone from reads through today', async () => {
    const { app, listRuns } = makeApp({ now: () => new Date('2026-10-28T15:00:00.000Z') });
    await admin(app, '/api/admin/rankings/cost?from=2026-10-01').expect(200);
    expect(listRuns.mock.calls[0]?.[0]).toEqual({ entityKey: 'rankings#global', from: '2026-10-01', to: '2026-10-28', limit: 100 });
  });

  it('R2B6: a lone to reads the 12 ISO weeks ending with its week, never all time', async () => {
    const { app, listRuns } = makeApp({ now: () => new Date('2026-10-28T15:00:00.000Z') });
    await admin(app, '/api/admin/rankings/cost?to=2026-10-04').expect(200);
    expect(listRuns.mock.calls[0]?.[0]).toEqual({ entityKey: 'rankings#global', from: '2026-07-13', to: '2026-10-04', limit: 100 });
  });

  it('PR34: a page with an unread run makes the totals incomplete: true (ORed across pages)', async () => {
    const listRuns = vi.fn<ListRuns>(async (opts) =>
      opts.cursor === undefined
        ? { entries: [{ runId: 'a', sortKey: 'a', expired: false, run: rankingRun({ runId: 'a', costUsd: 0.5 }) }], nextCursor: 'c2' }
        : { entries: [{ runId: 'x', sortKey: 'x', expired: true, unavailable: true }], incomplete: true },
    );
    const { app } = makeApp({ listRuns });
    const body = (await admin(app, '/api/admin/rankings/cost?from=2026-10-01&to=2026-10-31')).body;
    expect(body.incomplete).toBe(true);
    expect(body.totalUsd).toBe(0.5);
  });
});

describe('costRange (R2B6)', () => {
  const NOW = new Date('2026-10-28T15:00:00.000Z');
  it.each([
    [{}, { from: '2026-08-10', to: '2026-10-28' }],
    [{ from: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-28' }],
    [{ to: '2026-10-04' }, { from: '2026-07-13', to: '2026-10-04' }],
    [{ to: '2027-01-04' }, { from: '2026-10-19', to: '2027-01-04' }],
    [{ from: '2026-09-01', to: '2026-09-30' }, { from: '2026-09-01', to: '2026-09-30' }],
  ])('%j -> %j', (given, range) => {
    expect(costRange(given, NOW)).toEqual(range);
  });
});

describe('defaultCostRange', () => {
  it.each([
    ['2026-10-28T15:00:00.000Z', { from: '2026-08-10', to: '2026-10-28' }],
    ['2026-10-26T00:00:00.000Z', { from: '2026-08-10', to: '2026-10-26' }],
    ['2026-11-01T23:59:59.000Z', { from: '2026-08-10', to: '2026-11-01' }],
    ['2027-01-04T00:00:00.000Z', { from: '2026-10-19', to: '2027-01-04' }],
  ])('%s -> %j', (now, range) => {
    expect(defaultCostRange(new Date(now))).toEqual(range);
  });
});

describe('isoWeekOf', () => {
  it.each([
    ['2026-10-28T12:00:00.000Z', '2026-W44'],
    ['2026-10-26T01:00:00.000Z', '2026-W44'],
    ['2025-12-29T00:00:00.000Z', '2026-W01'],
    ['2027-01-01T00:00:00.000Z', '2026-W53'],
    ['2027-01-04T00:00:00.000Z', '2027-W01'],
  ])('%s is %s', (iso, week) => {
    expect(isoWeekOf(iso)).toBe(week);
  });
});
