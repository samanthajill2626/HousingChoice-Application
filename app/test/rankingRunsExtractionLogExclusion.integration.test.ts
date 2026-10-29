// WP1 B2a spec D11 (plan WI2): the extraction run log never sees a ranking
// record. Every ranking family is written into the SAME ai_runs table as an
// extraction run, then the extraction readers are asked: the repository's
// listByEntity in every extraction scope, GET /api/ai-runs, and
// GET /api/ai-runs/:runId (which answers 404 for a ranking run - it reads
// run#<id> and a ranking run is rrun#<id>; no kind check is involved).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { createLogger } from '../src/lib/logger.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createAiRunsRepo } from '../src/repos/aiRunsRepo.js';
import { gzipBase64, rankingExpiresAt } from '../src/repos/matchesRepo.js';
import { createRankingRunsRepo } from '../src/repos/rankingRunsRepo.js';
import { TEST_ADMIN_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET } from './helpers/twilioWebhookHarness.js';

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
  console.warn(`[rankingRunsExtractionLogExclusion.integration] DynamoDB Local is required at ${endpoint}`);
}

describe.skipIf(!reachable)('the extraction run log never returns a ranking record (spec D11; WI2)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const aiRuns = createAiRunsRepo({ doc, env: testEnv, logger });
  const rankings = createRankingRunsRepo({ doc, env: testEnv, logger });
  const table = tableName('ai_runs', testEnv);
  const extractionRunId = `run-${randomUUID().slice(0, 8)}`;
  const rankingRunId = `rank-${randomUUID().slice(0, 8)}`;
  const startedAt = '2026-10-28T11:00:00.000Z';

  const admin = (path: string) => {
    const world = createFakeWorld();
    world.aiRuns = aiRuns;
    const { app } = makeWebhookHarness({ world });
    return request(app).get(path).set('x-origin-verify', ORIGIN_SECRET).set('cookie', TEST_ADMIN_COOKIE);
  };

  beforeAll(async () => {
    await ensureTable(client, getTableSpec('ai_runs'), table);
    await aiRuns.putRun({
      runId: extractionRunId,
      startedAt: '2026-10-28T10:00:00.000Z',
      finishedAt: '2026-10-28T10:00:01.000Z',
      durationMs: 1_000,
      conversationId: 'conv-x',
      contactId: 'contact-x',
      trigger: 'sms',
      outcome: 'applied',
      driver: 'fake',
      decisions: {},
      notedLines: 0,
    });
    // Every ranking family, written into the same table.
    await rankings.putRun({
      runId: rankingRunId,
      anchorKind: 'tenant',
      anchorId: 'contact-x',
      direction: 'properties_for_tenant',
      jobGeneration: 'gen-x',
      batchIndex: 0,
      candidateCount: 1,
      driver: 'fake',
      model: 'fake',
      rubricVersion: 'r1',
      examplesVersion: 'e1',
      promptFingerprint: 'f'.repeat(64),
      usage: { inputTokens: 10, outputTokens: 5 },
      costUsd: 0,
      latencyMs: 3,
      startedAt,
      finishedAt: '2026-10-28T11:00:01.000Z',
      outcome: 'scored',
      rawText: '{"candidates":[]}',
      inputGzip: gzipBase64('{}'),
      handles: [{ handle: 'c1', candidateId: 'unit-x', display: '12 Oak St' }],
      results: [],
      droppedUnlawfulFlags: 0,
      environment: 'local',
      expires_at: rankingExpiresAt(startedAt, 180),
    });
    await rankings.putJobClaim({
      anchorKind: 'tenant',
      anchorId: 'contact-x',
      generation: 'gen-x',
      includeOlder: false,
      requestedBy: 'user-admin',
      requestedAt: startedAt,
      requestId: 'req-x',
      queuedExpiresAt: '2026-10-28T11:10:00.000Z',
      expiresAt: rankingExpiresAt(startedAt, 180),
    });
    await rankings.putFlagIfAbsentOrClosed({
      unitId: 'unit-x',
      field: 'qualifications',
      textHash: 'h'.repeat(64),
      reason: 'flagged as a requirement fair housing does not allow',
      runId: rankingRunId,
      raisedAt: startedAt,
    });
  }, 120_000);

  afterAll(async () => {
    await deleteTableIfExists(client, table);
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('aiRunsRepo.listByEntity answers only the extraction run, in every extraction scope', async () => {
    for (const scope of ['global', 'outcome#applied', 'conversations#conv-x', 'contacts#contact-x']) {
      const page = await aiRuns.listByEntity(scope);
      expect(page.entries.map((e) => e.runId), scope).toEqual([extractionRunId]);
      expect(page.entries.every((e) => !e.expired), scope).toBe(true);
    }
    for (const scope of ['outcome#failed', 'outcome#skipped', 'outcome#no_op']) {
      expect((await aiRuns.listByEntity(scope)).entries, scope).toEqual([]);
    }
  });

  it('aiRunsRepo.getRun does not find the ranking run', async () => {
    expect(await aiRuns.getRun(rankingRunId)).toBeUndefined();
    expect(await aiRuns.getRun(extractionRunId)).toBeDefined();
  });

  it('GET /api/ai-runs lists only the extraction run', async () => {
    const res = await admin('/api/ai-runs').expect(200);
    expect((res.body.runs as Array<{ runId: string }>).map((r) => r.runId)).toEqual([extractionRunId]);
  });

  it('GET /api/ai-runs/:runId answers 404 run_not_found for the ranking run (and 200 for the extraction run)', async () => {
    const res = await admin(`/api/ai-runs/${rankingRunId}`).expect(404);
    expect(res.body).toEqual({ error: 'run_not_found' });
    await admin(`/api/ai-runs/${extractionRunId}`).expect(200);
  });

  it('the ranking index partitions are not extraction scopes: 400 invalid_scope', async () => {
    for (const scope of ['rankings#global', 'rankings#tenant#contact-x', 'rankjobs#queued', 'uflags#unit-x']) {
      const res = await admin(`/api/ai-runs?scope=${encodeURIComponent(scope)}`).expect(400);
      expect(res.body, scope).toEqual({ error: 'invalid_scope' });
    }
  });
});
