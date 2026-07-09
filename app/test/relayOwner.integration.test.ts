// Task 5 — relay-group owner generalization (TDD, DynamoDB Local).
//
// Tests:
//   1. Create a relay group owned by a TOUR — no placement.
//   2. Create an UNOWNED relay group.
//   3. rebindOwner: tour-owned → placement → same pool number + members, new owner.
//   4. REGRESSION: legacy placementId path creates/reads exactly as before.
//   5. getOwner() accessor: new `owner` field + legacy `placementId` fallback.
//   6. M2 (Task 5 fix wave): tour-owned thread relays with the MASKED pool number
//      (fan-out send seam assertion — no DynamoDB needed).
//
// Self-skipping: when nothing answers at DYNAMODB_ENDPOINT (default
// http://localhost:8000) the suite is skipped so `npm test` stays green
// without Docker (`npm run db:start` to run for real).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tableName } from '../src/lib/config.js';
import { createDocumentClient, createDynamoClient } from '../src/lib/dynamo.js';
import { deleteTableIfExists, ensureTable } from '../src/lib/dynamoAdmin.js';
import { getTableSpec } from '../src/lib/tables.js';
import { createLogger } from '../src/lib/logger.js';
import {
  createConversationsRepo,
  getOwner,
} from '../src/repos/conversationsRepo.js';
import { createPoolNumbersRepo } from '../src/repos/poolNumbersRepo.js';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
  enqueueImmediate,
} from '../src/jobs/jobs.js';
import {
  RELAY_FANOUT_JOB,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { buildTsMsgId } from '../src/repos/messagesRepo.js';
import { createFakeWorld, type FakeWorld } from './helpers/twilioWebhookHarness.js';
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
    `[relayOwner.integration] SKIPPED — no DynamoDB Local at ${endpoint}. ` +
      'Run `npm run db:start` to exercise this suite.',
  );
}

describe.skipIf(!reachable)('relay-group owner generalization — DynamoDB Local (Task 5)', () => {
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

  // Helper: generate a distinct pool number per test.
  function nextPool(): string {
    return `+1555060${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  // ---------------------------------------------------------------------------
  // 1. Tour-owned relay group (no placement)
  // ---------------------------------------------------------------------------
  it('creates a relay group owned by a tour (no placement) — it exists and the owner is correct', async () => {
    const pool = nextPool();
    const tourId = `tour-${randomUUID()}`;
    const members = [{ contactId: 'c1', phone: '+15550200001', name: 'Alice' }];

    const conv = await conversations.createRelayGroup({
      poolNumber: pool,
      members,
      owner: { type: 'tour', id: tourId },
    });

    // The group was created.
    expect(conv.type).toBe('relay_group');
    expect(conv.pool_number).toBe(pool);
    expect(conv.participants).toHaveLength(1);

    // The canonical owner is the tour.
    expect(conv.owner).toMatchObject({ type: 'tour', id: tourId });

    // Legacy placementId must NOT be written for a tour-owned thread.
    expect(conv.placementId).toBeUndefined();

    // getOwner accessor returns the tour.
    expect(getOwner(conv)).toEqual({ type: 'tour', id: tourId });

    // The relay resolves via the byPoolNumber GSI — routing is unaffected by owner.
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(conv.conversationId);
    expect(found?.type).toBe('relay_group');
  });

  // ---------------------------------------------------------------------------
  // 2. Unowned (standalone) relay group
  // ---------------------------------------------------------------------------
  it('creates an unowned relay group (no owner, no placementId)', async () => {
    const pool = nextPool();
    const conv = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c2', phone: '+15550200002' }],
      // No owner, no placementId → standalone.
    });

    expect(conv.type).toBe('relay_group');
    // Neither field set.
    expect(conv.owner).toBeUndefined();
    expect(conv.placementId).toBeUndefined();

    // getOwner returns null type (standalone).
    expect(getOwner(conv)).toEqual({ type: null });

    // Routing still works.
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(conv.conversationId);
  });

  // ---------------------------------------------------------------------------
  // 3. rebindOwner: tour-owned → placement; pool number + members PRESERVED
  // ---------------------------------------------------------------------------
  it('rebindOwner: tour-owned thread → placement — pool number + members unchanged, new owner written', async () => {
    const pool = nextPool();
    const tourId = `tour-${randomUUID()}`;
    const placementId = `placement-${randomUUID()}`;
    const members = [
      { contactId: 'c3', phone: '+15550200003', name: 'Alice' },
      { contactId: 'c4', phone: '+15550200004', name: 'Bob' },
    ];

    // Start as tour-owned.
    const conv = await conversations.createRelayGroup({
      poolNumber: pool,
      members,
      owner: { type: 'tour', id: tourId },
    });
    expect(getOwner(conv)).toEqual({ type: 'tour', id: tourId });
    expect(conv.placementId).toBeUndefined();

    // Rebind to a placement.
    const rebound = await conversations.rebindOwner(conv.conversationId, {
      type: 'placement',
      id: placementId,
    });

    // Owner is now the placement.
    expect(rebound.owner).toMatchObject({ type: 'placement', id: placementId });
    expect(getOwner(rebound)).toEqual({ type: 'placement', id: placementId });

    // Back-compat: placementId is also written.
    expect(rebound.placementId).toBe(placementId);

    // Pool number is PRESERVED.
    expect(rebound.pool_number).toBe(pool);

    // Members are PRESERVED (count and phones).
    const phones = (rebound.participants ?? []).map((p) => p.phone).sort();
    expect(phones).toEqual(['+15550200003', '+15550200004'].sort());

    // Routing still works with the same pool number.
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(conv.conversationId);

    // Round-trip read from DynamoDB confirms persistence.
    const read = await conversations.getById(conv.conversationId);
    expect(read?.owner).toMatchObject({ type: 'placement', id: placementId });
    expect(read?.placementId).toBe(placementId);
    expect(read?.pool_number).toBe(pool);
  });

  // ---------------------------------------------------------------------------
  // 4. rebindOwner: placement → null (unowned)
  // ---------------------------------------------------------------------------
  it('rebindOwner: placement-owned → unowned (null) — clears both owner and placementId', async () => {
    const pool = nextPool();
    const placementId = `placement-${randomUUID()}`;

    const conv = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c5', phone: '+15550200005' }],
      owner: { type: 'placement', id: placementId },
    });
    expect(getOwner(conv)).toEqual({ type: 'placement', id: placementId });

    // Rebind to null (unowned).
    const unowned = await conversations.rebindOwner(conv.conversationId, { type: null });
    expect(unowned.owner).toBeUndefined();
    expect(unowned.placementId).toBeUndefined();
    expect(getOwner(unowned)).toEqual({ type: null });

    // Routing is still intact.
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(conv.conversationId);
  });

  // ---------------------------------------------------------------------------
  // 5. getOwner() accessor: legacy placementId-only rows
  // ---------------------------------------------------------------------------
  it('getOwner() falls back to legacy placementId when owner field is absent (existing rows)', async () => {
    // Simulate a legacy row: only placementId, no owner field.
    const legacyConv = {
      conversationId: `conv-legacy-${randomUUID()}`,
      participant_phone: '+15550200099',
      pool_number: nextPool(),
      status: 'open',
      last_activity_at: new Date().toISOString(),
      type: 'relay_group' as const,
      ai_mode: 'manual' as const,
      created_at: new Date().toISOString(),
      placementId: 'placement-legacy-abc',
      // owner field deliberately absent
    };

    // getOwner falls back to placementId → placement owner.
    expect(getOwner(legacyConv)).toEqual({ type: 'placement', id: 'placement-legacy-abc' });
  });

  // ---------------------------------------------------------------------------
  // REGRESSION: legacy placementId path still works as before (Task 5)
  // ---------------------------------------------------------------------------
  it('REGRESSION: creating a relay group with the legacy placementId param still writes both placementId AND owner', async () => {
    const pool = nextPool();
    const placementId = `placement-regression-${randomUUID()}`;

    // Using the legacy placementId input (the placement-scoped route still passes this).
    const conv = await conversations.createRelayGroup({
      poolNumber: pool,
      members: [{ contactId: 'c-reg', phone: '+15550200010', name: 'Reg' }],
      tag: 'regression-tag',
      placementId,
    });

    // Back-compat: placementId is still written.
    expect(conv.placementId).toBe(placementId);

    // New: owner field is ALSO written for new rows (back-compat upgrade path).
    expect(conv.owner).toMatchObject({ type: 'placement', id: placementId });

    // getOwner works for this row via both paths.
    expect(getOwner(conv)).toEqual({ type: 'placement', id: placementId });

    // Routing still works.
    const found = await conversations.getByPoolNumber(pool);
    expect(found?.conversationId).toBe(conv.conversationId);
    expect(found?.placementId).toBe(placementId);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for getOwner() — no DynamoDB needed
// ---------------------------------------------------------------------------
describe('getOwner() — unit (no DynamoDB)', () => {
  const base = {
    conversationId: 'conv-x',
    participant_phone: '+15550000001',
    status: 'open',
    last_activity_at: '2026-07-01T00:00:00.000Z',
    type: 'relay_group' as const,
    ai_mode: 'manual' as const,
    created_at: '2026-07-01T00:00:00.000Z',
  };

  it('returns {type:null} when neither owner nor placementId is set', () => {
    expect(getOwner({ ...base })).toEqual({ type: null });
  });

  it('returns {type:"placement", id} from placementId when owner is absent (legacy)', () => {
    expect(getOwner({ ...base, placementId: 'p-abc' })).toEqual({ type: 'placement', id: 'p-abc' });
  });

  it('returns {type:"placement", id} from owner field (canonical)', () => {
    expect(getOwner({ ...base, owner: { type: 'placement', id: 'p-xyz' } })).toEqual({
      type: 'placement',
      id: 'p-xyz',
    });
  });

  it('returns {type:"tour", id} when owner.type is tour', () => {
    expect(getOwner({ ...base, owner: { type: 'tour', id: 'tour-001' } })).toEqual({
      type: 'tour',
      id: 'tour-001',
    });
  });

  it('owner field wins over placementId when both are present', () => {
    // owner field takes precedence (new canonical).
    expect(
      getOwner({ ...base, owner: { type: 'tour', id: 'tour-win' }, placementId: 'p-lose' }),
    ).toEqual({ type: 'tour', id: 'tour-win' });
  });

  it('returns {type:null} when owner.type is null', () => {
    expect(getOwner({ ...base, owner: { type: null } })).toEqual({ type: null });
  });
});

// ---------------------------------------------------------------------------
// M2 (Task 5 fix wave): tour-owned thread relays with the MASKED pool number
//
// The brief's RED bullet asks to assert that a tour-owned relay group actually
// relays with the masked pool number. This test drives a masked send through
// the relay fan-out job (same seam as relayFanOut.test.ts) and asserts that
// the fan-out sends FROM the pool number — proving tour ownership does not
// break the fan-out's pool_number-based routing (which is owner-agnostic).
// No DynamoDB is needed; the FakeWorld + in-process job machinery suffice.
// ---------------------------------------------------------------------------
describe('M2 (Task 5 fix wave): tour-owned relay thread — masked send uses the pool number', () => {
  let world: FakeWorld;
  // Immediate dispatch now DEFERS (SQS semantics) - settle() drains the run.
  let queueAdapter: InProcessOutboundQueueAdapter;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ level: 'info', destination: createLogCapture().stream });
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    queueAdapter = new InProcessOutboundQueueAdapter({ dispatch: dispatchJob });
    configureOutboundQueue(queueAdapter);
  });

  afterEach(async () => {
    await queueAdapter.settle();
    _resetForTests();
  });

  it('a tour-owned relay group fans out a masked send FROM the pool number (owner-agnostic routing)', async () => {
    const POOL = '+15550109100';
    const ALICE = '+15550200011';
    const BOB = '+15550200012';
    const TOUR_ID = `tour-${randomUUID()}`;

    // Seed a tour-owned relay group directly into the fake world.
    const now = new Date().toISOString();
    const conv = {
      conversationId: 'conv-tour-relay-m2',
      participant_phone: POOL,
      pool_number: POOL,
      status: 'open' as const,
      last_activity_at: now,
      type: 'relay_group' as const,
      ai_mode: 'manual' as const,
      participants: [
        { contactId: 'c-alice', phone: ALICE, name: 'Alice' },
        { contactId: 'c-bob', phone: BOB, name: 'Bob' },
      ],
      // Tour-owned: owner set, placementId absent.
      owner: { type: 'tour' as const, id: TOUR_ID },
      created_at: now,
    };
    world.conversations.set(conv.conversationId, conv);

    // Seed an inbound source message on the relay thread (sent by ALICE).
    const providerTs = now;
    const tsMsgId = buildTsMsgId(providerTs, 'SMtour-src-m2');
    world.messages.push({
      conversationId: conv.conversationId,
      tsMsgId,
      type: 'sms',
      direction: 'inbound',
      author: 'unknown',
      body: 'Tour starts in 10 mins!',
      provider_sid: 'SMtour-src-m2',
      provider_ts: providerTs,
      delivery_status: 'delivered',
      created_at: providerTs,
      relay_sender_key: 'c-alice',
      // Fan-out will fill in delivery recipients; seed the structure.
      deliveryRecipients: undefined,
    });

    // Enqueue the fan-out job (mirrors what the webhook does on inbound).
    // The RELAY_FANOUT_JOB payload uses relayConversationId + sourceTsMsgId.
    await enqueueImmediate(RELAY_FANOUT_JOB, {
      relayConversationId: conv.conversationId,
      sourceTsMsgId: tsMsgId,
      senderKey: 'c-alice',
    });
    await queueAdapter.settle(); // immediate dispatch is deferred - drain it

    // The fan-out ran in-process. Assert masked relay sends FROM the pool number.
    // ALICE is the sender → fan-out sends only to BOB (not back to the sender).
    expect(world.sent.length).toBeGreaterThan(0);

    // All sends are FROM the pool number (masked send assertion).
    expect(world.sent.every((s) => s.from === POOL)).toBe(true);

    // The sender (ALICE) is not re-texted (relay does not echo to sender).
    expect(world.sent.some((s) => s.to === ALICE)).toBe(false);

    // The recipient (BOB) received the relayed message FROM the masked pool.
    const toBob = world.sent.find((s) => s.to === BOB);
    expect(toBob).toBeDefined();
    expect(toBob!.from).toBe(POOL);

    // The relayed body includes the sender prefix (masked sender label).
    expect(toBob!.body).toContain('Tour starts in 10 mins!');
  });
});
