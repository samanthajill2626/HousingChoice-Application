// POST /__dev/ranking/tick (WP1 B2a spec D7): the hermetic lane's ONLY
// ranking runner (RANKING_WORKER_POLL=off keeps the lane's real worker from
// racing it). One POST runs one poll pass and answers when its jobs finish.
// Dev-only: absent unless the composition root mounts the dev router.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/lib/config.js';
import { createLogger } from '../src/lib/logger.js';
import { rankingJobItemId } from '../src/repos/rankingRunsRepo.js';
import { createDevRouter } from '../src/routes/dev.js';
import { createRankingSlots, type RankingJobDeps } from '../src/services/ranking/job.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  ANCHOR_UNIT,
  assembled,
  queuedJob,
  stubBuildPrompt,
  stubDriver,
  tenantCandidate,
  unitAnchor,
} from './helpers/rankingJobFixtures.js';
import { createMatchesFake, createRankingRunsFake } from './helpers/rankingRunsFake.js';

const SECRET = 'test-origin-secret';
// R2F6: the tick mounts only on a LOCAL DynamoDB target.
const cfg = (endpoint = 'http://localhost:8000') =>
  loadConfig({ NODE_ENV: 'test', DEV_AUTH_ENABLED: '1', CF_ORIGIN_SECRET: SECRET, DYNAMODB_ENDPOINT: endpoint });

function tickDeps() {
  const runs = createRankingRunsFake();
  // The tick runs on the wall clock: the record must not have expired.
  const record = queuedJob({ queuedExpiresAt: '2999-01-01T00:00:00.000Z' });
  runs.jobs.set(record.itemId, record);
  const driver = stubDriver();
  const deps: RankingJobDeps = {
    jobs: runs.repo,
    matches: createMatchesFake().repo,
    driver,
    assemble: async () => assembled(unitAnchor(), [tenantCandidate('t-1')]),
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
    logger: createLogger({ destination: createLogCapture().stream }),
    now: () => new Date().toISOString(),
    timers: { setInterval: () => 0, clearInterval: () => undefined },
  };
  return { runs, driver, deps };
}

describe('POST /__dev/ranking/tick', () => {
  it('is absent (404) when the dev router is not mounted', async () => {
    const app = buildApp({ config: loadConfig({ NODE_ENV: 'test', CF_ORIGIN_SECRET: SECRET }) });
    expect((await request(app).post('/__dev/ranking/tick').set('x-origin-verify', SECRET).send()).status).toBe(404);
  });

  it('R2F6: is absent (404) when the dev router is mounted but DYNAMODB_ENDPOINT is not a local target, even with deps injected', async () => {
    const { driver, deps } = tickDeps();
    const config = cfg('http://dynamodb-local:8000');
    const app = buildApp({ config, devRouter: createDevRouter({ config, rankingTickDeps: deps }) });
    expect((await request(app).post('/__dev/ranking/tick').send()).status).toBe(404);
    expect(driver.calls).toEqual([]);
  });

  it('runs one poll pass to completion and reports the summary', async () => {
    const { runs, driver, deps } = tickDeps();
    const config = cfg();
    const app = buildApp({ config, devRouter: createDevRouter({ config, rankingTickDeps: deps }) });
    const res = await request(app).post('/__dev/ranking/tick').send();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, expired: 0, claimed: 1, tookOver: 0, failedStale: 0 });
    expect(driver.calls).toEqual([['t-1']]);
    // Answered only after the job finished.
    expect(runs.jobs.get(rankingJobItemId('unit', ANCHOR_UNIT))?.status).toBe('done');
  });

  it('a second tick with nothing due claims nothing', async () => {
    const { deps } = tickDeps();
    const config = cfg();
    const app = buildApp({ config, devRouter: createDevRouter({ config, rankingTickDeps: deps }) });
    await request(app).post('/__dev/ranking/tick').send();
    expect((await request(app).post('/__dev/ranking/tick').send()).body).toEqual({ ok: true, expired: 0, claimed: 0, tookOver: 0, failedStale: 0 });
  });
});
