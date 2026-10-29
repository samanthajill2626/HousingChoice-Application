// Real-engine coverage for the ranking job's conditional writes (WP1 B2a
// spec D7). The unit suites drive an in-memory fake that models the
// conditions; this file lets DynamoDB Local decide them through S2's
// repositories, because a fake that agrees with the job is exactly where a
// wrong condition expression hides.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createMatchesRepo } from '../src/repos/matchesRepo.js';
import { createRankingRunsRepo } from '../src/repos/rankingRunsRepo.js';
import {
  claimRanking,
  createRankingSlots,
  MSG_NOT_PICKED_UP,
  MSG_STOPPED,
  runDueRankings,
  type ClaimResult,
  type RankingJobDeps,
} from '../src/services/ranking/job.js';
import type { AnchorRef } from '../src/services/ranking/types.js';
import { createLogCapture } from './helpers/logCapture.js';
import { assembled, stubBuildPrompt, stubDriver, tenantCandidate, unitAnchor } from './helpers/rankingJobFixtures.js';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';

async function endpointReachable(): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return true;
  } catch {
    return false;
  }
}

const reachable = await endpointReachable();
if (!reachable) {
  console.warn(`[rankingJob.integration] DynamoDB Local is required at ${endpoint}`);
}

function claimed(result: ClaimResult) {
  if (result.status !== 202) throw new Error(`expected 202, got ${result.status}`);
  return result;
}

describe.skipIf(!reachable)('the ranking job against DynamoDB Local', () => {
  // WL-S5-7: an hc-test- prefix, so globalTeardown's residue sweep covers an interrupted run.
  const testEnv = { TABLE_PREFIX: `hc-test-rankjob-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const jobs = createRankingRunsRepo({ doc, env: testEnv, logger });
  const matches = createMatchesRepo({ doc, env: testEnv, logger });
  const tables = ['ai_runs', 'matches'] as const;

  beforeAll(async () => {
    for (const base of tables) await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
  }, 120_000);

  afterAll(async () => {
    for (const base of tables) await deleteTableIfExists(client, tableName(base, testEnv));
    doc.destroy();
    client.destroy();
  }, 120_000);

  const press = { includeOlder: false, requestedBy: 'usr-int', requestId: 'req-int-1' };
  const claimDeps = {
    jobs,
    anchorExists: async () => true,
    config: { rankingQueueExpiryMs: 600_000, rankingPairTtlDays: 180 },
    now: () => new Date().toISOString(),
  };

  function jobDeps(): RankingJobDeps & { driver: ReturnType<typeof stubDriver> } {
    return {
      jobs,
      matches,
      driver: stubDriver(),
      assemble: async () => assembled(unitAnchor(), [tenantCandidate('t-int-1'), tenantCandidate('t-int-2')]),
      buildPrompt: stubBuildPrompt,
      events: { emit: () => undefined },
      slots: createRankingSlots(2),
      config: {
        rankingBatchSize: 40,
        rankingBatchConcurrency: 4,
        rankingLeaseMs: 90_000,
        rankingPairTtlDays: 180,
        rankingLandlordCard: false,
        aiPriceTable: {},
        appEnv: 'local',
      },
      logger,
      now: () => new Date().toISOString(),
      timers: { setInterval: () => 0, clearInterval: () => undefined },
    };
  }

  const anchor = (): AnchorRef => ({ kind: 'unit', id: `unit-int-${randomUUID().slice(0, 8)}` });

  it('two concurrent presses: exactly one claims, the other joins the same generation', async () => {
    const a = anchor();
    const results = (await Promise.all([claimRanking(a, press, claimDeps), claimRanking(a, press, claimDeps)])).map(claimed);
    const claims = results.filter((r) => !r.joined);
    const joins = results.filter((r) => r.joined);
    expect(claims).toHaveLength(1);
    expect(joins).toHaveLength(1);
    expect(joins[0]!.job.generation).toBe(claims[0]!.job.generation);
  });

  it('two pollers racing one queued record: one run, matches readable by key; a later press claims afresh', async () => {
    const a = anchor();
    claimed(await claimRanking(a, press, claimDeps));
    const nowIso = new Date().toISOString();
    await Promise.all([runDueRankings(nowIso, jobDeps()), runDueRankings(nowIso, jobDeps())]);
    // Other cases' records share the index; this anchor's record is what is checked.
    const record = await jobs.getJob(a.kind, a.id, { consistent: true });
    expect(record?.status).toBe('done');
    const pairs = await matches.getPairs(
      [
        { tenantId: 't-int-1', unitId: 'unit-anchor' },
        { tenantId: 't-int-2', unitId: 'unit-anchor' },
      ],
      { requireComplete: true },
    );
    expect(pairs.size).toBe(2);
    const again = claimed(await claimRanking(a, press, claimDeps));
    expect(again.joined).toBe(false);
    expect(again.job.generation).not.toBe(record?.generation);
  });

  it('a queued record past its expiry is failed by the poll with the not-picked-up message', async () => {
    const a = anchor();
    const past = new Date(Date.now() - 700_000).toISOString();
    claimed(await claimRanking(a, press, { ...claimDeps, now: () => past }));
    await runDueRankings(new Date().toISOString(), jobDeps());
    expect(await jobs.getJob(a.kind, a.id, { consistent: true })).toMatchObject({ status: 'failed', message: MSG_NOT_PICKED_UP });
  });

  it('an expired lease is taken over once, then a second expiry fails the job', async () => {
    const a = anchor();
    const past = new Date(Date.now() - 1_000).toISOString();
    const first = claimed(await claimRanking(a, press, claimDeps)).job;
    expect((await jobs.claimQueued(first, { nowIso: new Date().toISOString(), leaseExpiresAt: past }))?.status).toBe('running');

    await runDueRankings(new Date().toISOString(), jobDeps());
    const afterTakeover = await jobs.getJob(a.kind, a.id, { consistent: true });
    expect(afterTakeover).toMatchObject({ status: 'done', attempts: 1 });
    expect(afterTakeover?.generation).not.toBe(first.generation);

    const second = claimed(await claimRanking(a, press, claimDeps)).job;
    const secondRunning = await jobs.claimQueued(second, { nowIso: new Date().toISOString(), leaseExpiresAt: past });
    const taken = await jobs.takeOver(secondRunning!, { nowIso: new Date().toISOString(), newGeneration: 'gen-int-take', leaseExpiresAt: past });
    expect(taken?.attempts).toBe(1);
    await runDueRankings(new Date().toISOString(), jobDeps());
    expect(await jobs.getJob(a.kind, a.id, { consistent: true })).toMatchObject({ status: 'failed', message: MSG_STOPPED });
  });
});
