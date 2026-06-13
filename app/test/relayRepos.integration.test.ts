// M1.7 integration tests against DynamoDB Local — the relay repos' real GSI
// behavior: the conversations byPoolNumber GSI (sparse; relay routing key) and
// the pool_numbers byLifecycleState GSI (findAvailable + quarantine reclaim).
//
// Self-skipping like the other integration suites: when nothing answers at
// DYNAMODB_ENDPOINT (default http://localhost:8000) the suite is skipped so
// `npm test` stays green without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import { createConversationsRepo } from '../src/repos/conversationsRepo.js';
import { createPoolNumbersRepo, QUARANTINE_WINDOW_MS } from '../src/repos/poolNumbersRepo.js';
import { createLogCapture } from './helpers/logCapture.js';

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
  console.warn(
    `[relayRepos.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('relay repos against DynamoDB Local (throwaway prefix)', () => {
  const testEnv = { TABLE_PREFIX: `hc-test-${randomUUID().slice(0, 8)}-` };
  const client = createDynamoClient({ endpoint });
  const doc = createDocumentClient({ endpoint });
  const logger = createLogger({ destination: createLogCapture().stream });
  const repoDeps = { doc, env: testEnv, logger };

  const conversations = createConversationsRepo(repoDeps);
  const poolNumbers = createPoolNumbersRepo(repoDeps);

  const bases = ['conversations', 'pool_numbers'] as const;

  beforeAll(async () => {
    for (const base of bases) {
      await ensureTable(client, getTableSpec(base), tableName(base, testEnv));
    }
  }, 120_000);

  afterAll(async () => {
    for (const base of bases) {
      await deleteTableIfExists(client, tableName(base, testEnv));
    }
    doc.destroy();
    client.destroy();
  }, 120_000);

  it('conversations.getByPoolNumber resolves the relay via the byPoolNumber GSI', async () => {
    const pool = `+1555040${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100001', name: 'A' }],
      tag: 'fair',
    });
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(created.conversationId);
    expect(found?.type).toBe('relay_group');
  });

  it('byPoolNumber is sparse: a 1:1 conversation never indexes there', async () => {
    await conversations.createOrGetByParticipantPhone('+15550100099', 'unknown_1to1');
    // A pool-number lookup for a non-relay phone returns nothing.
    const found = await conversations.getByPoolNumber('+15550100099');
    expect(found).toBeUndefined();
  });

  it('setRelayStatus close clears pool_number → leaves the byPoolNumber GSI', async () => {
    const pool = `+1555041${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100002' }],
    });
    await conversations.setRelayStatus(created.conversationId, 'closed', null);
    const found = await conversations.getByPoolNumber(pool);
    expect(found).toBeUndefined(); // pool_number removed → no longer in the GSI
  });

  it('addMember/removeMember are idempotent on phone', async () => {
    const pool = `+1555042${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100003' }],
    });
    await conversations.addMember(created.conversationId, { contactId: 'c2', phone: '+15550100004' });
    const dup = await conversations.addMember(created.conversationId, {
      contactId: 'c2',
      phone: '+15550100004',
    });
    expect(dup.participants).toHaveLength(2); // idempotent on phone
    const removed = await conversations.removeMember(created.conversationId, '+15550100004');
    expect(removed.participants).toHaveLength(1);
    const removedAgain = await conversations.removeMember(created.conversationId, '+15550100004');
    expect(removedAgain.participants).toHaveLength(1); // idempotent
  });

  it('FIX 3: concurrent addMember calls both land (optimistic-concurrency version guard, no silent clobber)', async () => {
    const pool = `+1555044${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100010' }],
    });
    // Two DIFFERENT members added concurrently. Without the version guard the
    // read-modify-write would clobber: one add would be silently lost. With it,
    // the loser fails its conditional, re-reads, and retries — so BOTH land.
    await Promise.all([
      conversations.addMember(created.conversationId, { contactId: 'c2', phone: '+15550100011' }),
      conversations.addMember(created.conversationId, { contactId: 'c3', phone: '+15550100012' }),
    ]);
    const after = await conversations.getById(created.conversationId);
    expect(after?.participants).toHaveLength(3); // original + both concurrent adds
    expect(typeof after?.participants_version).toBe('number');
    expect((after?.participants_version ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('FIX 3: a concurrent add + remove of different phones both take effect', async () => {
    const pool = `+1555045${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [
        { contactId: 'c1', phone: '+15550100020' },
        { contactId: 'c2', phone: '+15550100021' },
      ],
    });
    await Promise.all([
      conversations.addMember(created.conversationId, { contactId: 'c3', phone: '+15550100022' }),
      conversations.removeMember(created.conversationId, '+15550100021'),
    ]);
    const after = await conversations.getById(created.conversationId);
    const phones = (after?.participants ?? []).map((p) => p.phone).sort();
    expect(phones).toEqual(['+15550100020', '+15550100022']); // c2 removed, c3 added
  });

  it('FIX 1: setRelayStatus is conditional on expectedStatus (idempotent concurrent close)', async () => {
    const pool = `+1555046${Math.floor(Math.random() * 9000 + 1000)}`;
    const created = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c1', phone: '+15550100030' }],
    });
    // First close from 'open' succeeds.
    await conversations.setRelayStatus(created.conversationId, 'closed', null, 'open');
    // A second close conditioned on 'open' fails (already closed) — the caller
    // treats this as an idempotent no-op (no double release).
    const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    await expect(
      conversations.setRelayStatus(created.conversationId, 'closed', null, 'open'),
    ).rejects.toBeInstanceOf(ConditionalCheckFailedException);
  });

  it('pool_numbers: findAvailable + claim (race-safe) + quarantine reclaim', async () => {
    const pn = `+1555043${Math.floor(Math.random() * 9000 + 1000)}`;
    await poolNumbers.create({ poolNumber: pn, voiceCapable: true, smsCapable: true });

    // findAvailable surfaces it; claim flips it to assigned (race-safe).
    const available = await poolNumbers.findAvailable();
    expect(available).toBeDefined();
    const claimed = await poolNumbers.claim(pn, 'conv-x', 'fair');
    expect(claimed?.lifecycle_state).toBe('assigned');
    // A second claim of the same number fails (already assigned).
    const second = await poolNumbers.claim(pn, 'conv-y');
    expect(second).toBeUndefined();

    // Release → quarantined; NOT reclaimed before the window.
    await poolNumbers.release(pn);
    const reclaimedEarly = await poolNumbers.reclaimExpired(new Date());
    const stillQuarantined = await poolNumbers.get(pn);
    expect(stillQuarantined?.lifecycle_state).toBe('quarantined');
    expect(reclaimedEarly).toBe(0);

    // After the window → reclaimed back to available.
    const future = new Date(Date.now() + QUARANTINE_WINDOW_MS + 60_000);
    const reclaimed = await poolNumbers.reclaimExpired(future);
    expect(reclaimed).toBeGreaterThanOrEqual(1);
    const back = await poolNumbers.get(pn);
    expect(back?.lifecycle_state).toBe('available');
  });
});
