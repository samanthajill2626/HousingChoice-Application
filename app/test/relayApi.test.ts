// Relay-group management API (M1.7) — POST /api/relay-groups, the member
// CRUD, and PATCH close/reopen. Runs on the shared in-memory world + a FAKE
// poolNumbers service (no Twilio, no real number), with the jobs machinery
// wired so the intro enqueue resolves. Authed via the real sealed session
// cookie next to the origin secret (every /api route is behind requireAuth).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
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
} from '../src/jobs/jobs.js';
import { registerRelayFanOutJobHandler } from '../src/jobs/relayFanOut.js';
import { createLogger } from '../src/lib/logger.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import {
  RelayProvisioningDisabledError,
  type PoolNumbersService,
} from '../src/services/poolNumbers.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';

const ALICE = '+15550100001';
const BOB = '+15550100002';
const SESSION_USER_ID = 'usr_testva00000000000000000';

/** A fake pool-numbers service: hands out deterministic numbers, tracks releases. */
function makeFakePoolNumbers(): PoolNumbersService & { released: string[]; provisioned: string[] } {
  let counter = 0;
  const released: string[] = [];
  const provisioned: string[] = [];
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'assigned',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    released,
    provisioned,
    async provisionForPlacement() {
      counter += 1;
      const poolNumber = `+1555030${String(counter).padStart(4, '0')}`;
      provisioned.push(poolNumber);
      return { poolNumber, record: rec(poolNumber), provisioned: true };
    },
    async assignConversation() {},
    async release(poolNumber) {
      released.push(poolNumber);
      return { ...rec(poolNumber), lifecycle_state: 'quarantined' };
    },
  };
}

/**
 * A pool service emulating the M1.7 kill-switch OFF: provisionForPlacement
 * always refuses (as the real service does on the deployed twilio driver
 * pre-A2P). NO number is ever handed out — the route must surface 503
 * relay_provisioning_disabled.
 */
function makeDisabledPoolNumbers(): PoolNumbersService & { provisionAttempts: number } {
  const DISABLED_MESSAGE =
    'relay number provisioning is disabled in this environment — set ' +
    'RELAY_LIVE_PROVISIONING=true after A2P approval to enable buying a pool number';
  let provisionAttempts = 0;
  return {
    get provisionAttempts() {
      return provisionAttempts;
    },
    async provisionForPlacement() {
      provisionAttempts += 1;
      throw new RelayProvisioningDisabledError(DISABLED_MESSAGE);
    },
    async assignConversation() {},
    async release(poolNumber) {
      return {
        poolNumber,
        lifecycle_state: 'quarantined',
        quarantine_until: '0000-00-00T00:00:00.000Z',
        voice_capable: true,
        sms_capable: true,
        provisioned_at: new Date().toISOString(),
      };
    },
  };
}

function authedHarness(world: FakeWorld, pool: PoolNumbersService) {
  return makeWebhookHarness({ world, poolNumbersService: pool });
}

const SECRET = ORIGIN_SECRET;

describe('relay-group API (M1.7)', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    const logger = createLogger({ destination: createLogCapture().stream });
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
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
  });

  afterEach(() => {
    _resetForTests();
  });

  it('POST /api/relay-groups provisions a pool number, creates the thread, sends the intro to each member', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);

    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }], tag: 'fair' });

    expect(res.status).toBe(201);
    const conv = res.body.conversation;
    expect(conv.type).toBe('relay_group');
    expect(conv.pool_number).toBe(pool.provisioned[0]);
    expect(conv.participants).toHaveLength(2);

    // The intro fan-out ran in-process → both members texted FROM the pool.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === pool.provisioned[0])).toBe(true);
  });

  it('rejects an empty members list', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [] });
    expect(res.status).toBe(400);
  });

  // --- M1.7 kill-switch: provisioning disabled (deployed pre-A2P) ---------
  it('POST /api/relay-groups → 503 relay_provisioning_disabled when the kill-switch is off (no number purchased)', async () => {
    const pool = makeDisabledPoolNumbers();
    const { app } = authedHarness(world, pool);

    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('relay_provisioning_disabled');
    expect(res.body.message).toMatch(/RELAY_LIVE_PROVISIONING=true/);
    // The refusal happened — and no conversation was created (no number to front it).
    expect(pool.provisionAttempts).toBe(1);
    expect([...world.conversations.values()]).toHaveLength(0);
    // The refusal is audited (actor + reason, no PII).
    const refusal = world.auditEvents.find((a) => a.event_type === 'relay_provisioning_disabled');
    expect(refusal).toBeDefined();
    expect(refusal?.actorId).toBe(SESSION_USER_ID);
  });

  it('PATCH reopen → 503 relay_provisioning_disabled when the kill-switch is off', async () => {
    // Create + close with a WORKING pool, then swap to a disabled pool for the
    // reopen so only the reopen hits the kill-switch.
    const working = makeFakePoolNumbers();
    const created = await request(authedHarness(world, working).app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    await request(authedHarness(world, working).app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });

    const disabled = makeDisabledPoolNumbers();
    const reopened = await request(authedHarness(world, disabled).app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });

    expect(reopened.status).toBe(503);
    expect(reopened.body.error).toBe('relay_provisioning_disabled');
    expect(disabled.provisionAttempts).toBe(1);
    // The thread stayed closed — the refused reopen never flipped it open.
    expect((await world.conversationsRepo.getById(id))?.status).toBe('closed');
  });

  it('member CRUD: GET roster, POST idempotent add, DELETE idempotent remove', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;

    // GET roster.
    const roster = await request(app).get(`/api/conversations/${id}/members`).set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(roster.status).toBe(200);
    expect(roster.body.members).toHaveLength(1);

    // POST add Bob.
    const add = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, name: 'Bob' });
    expect(add.status).toBe(200);
    expect(add.body.members).toHaveLength(2);

    // POST add Bob AGAIN → idempotent (still 2).
    const addAgain = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB });
    expect(addAgain.body.members).toHaveLength(2);

    // DELETE Bob.
    const del = await request(app)
      .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(200);
    expect(del.body.members).toHaveLength(1);

    // DELETE Bob AGAIN → idempotent (still 1).
    const delAgain = await request(app)
      .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(delAgain.body.members).toHaveLength(1);
  });

  // --- BE2/C2: added_to_group_text / removed_from_group_text milestones -----
  it('records added_to_group_text on a real add and removed_from_group_text on a real remove (for members with a contactId)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, contactId: 'c-alice', name: 'Alice' }] });
    const id = created.body.conversation.conversationId;

    // Add Bob (has a contactId) → one added_to_group_text for c-bob.
    await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, contactId: 'c-bob', name: 'Bob' });
    let added = world.activityEvents.filter((e) => e.type === 'added_to_group_text');
    expect(added).toHaveLength(1);
    expect(added[0]!.contactId).toBe('c-bob');
    expect(added[0]!.refType).toBe('conversation');
    expect(added[0]!.refId).toBe(id);

    // Add Bob AGAIN (idempotent) → NO second milestone.
    await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, contactId: 'c-bob' });
    added = world.activityEvents.filter((e) => e.type === 'added_to_group_text');
    expect(added).toHaveLength(1); // still 1 — no emit on a no-op

    // Remove Bob → one removed_from_group_text for c-bob.
    await request(app)
      .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    const removed = world.activityEvents.filter((e) => e.type === 'removed_from_group_text');
    expect(removed).toHaveLength(1);
    expect(removed[0]!.contactId).toBe('c-bob');

    // Remove Bob AGAIN (idempotent) → NO second milestone.
    await request(app)
      .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(world.activityEvents.filter((e) => e.type === 'removed_from_group_text')).toHaveLength(1);
  });

  // --- A2P: removing a member clears their relay_opted_out_members entry -------
  it('removing a member clears their relay_opted_out_members entry (the Today item auto-resolves)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, contactId: 'c-alice', name: 'Alice' }, { phone: BOB, contactId: 'c-bob', name: 'Bob' }] });
    const id = created.body.conversation.conversationId;

    // Simulate the fan-out having flagged Bob as opted-out on the conversation.
    const conv = world.conversations.get(id)!;
    conv.relay_opted_out_members = {
      'c-bob': { contactId: 'c-bob', phone: BOB, name: 'Bob', at: new Date().toISOString() },
    };

    // Remove Bob → his opt-out entry is cleared (keyed by his relayMemberKey).
    const del = await request(app)
      .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);
    expect(del.status).toBe(200);
    expect(world.conversations.get(id)!.relay_opted_out_members?.['c-bob']).toBeUndefined();
  });

  it('PATCH close releases the pool number to quarantine; reopen provisions a fresh one', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const firstPool = created.body.conversation.pool_number;

    // Close → status closed, pool number released + cleared.
    const closed = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.status).toBe('closed');
    expect(closed.body.conversation.pool_number).toBeUndefined();
    expect(pool.released).toEqual([firstPool]);

    // Reopen → a FRESH pool number is provisioned (the old one is quarantined).
    const reopened = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });
    expect(reopened.status).toBe(200);
    expect(reopened.body.conversation.status).toBe('open');
    expect(reopened.body.conversation.pool_number).toBe(pool.provisioned[1]);
    expect(reopened.body.conversation.pool_number).not.toBe(firstPool);
  });

  // --- FIX 1: close ordering + close/reopen race -------------------------
  it('FIX 1: close clears pool_number FIRST → getByPoolNumber(oldPool) is undefined and status=closed', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const oldPool = created.body.conversation.pool_number;

    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });

    // An inbound arriving in the window can no longer resolve the dead thread.
    expect(await world.conversationsRepo.getByPoolNumber(oldPool)).toBeUndefined();
    const after = await world.conversationsRepo.getById(id);
    expect(after?.status).toBe('closed');
    expect(after?.pool_number).toBeUndefined();
    expect(pool.released).toEqual([oldPool]);
  });

  it('FIX 1: reopen NEVER reuses the quarantined number — a fresh one is provisioned', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const oldPool = created.body.conversation.pool_number;

    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    const reopened = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });

    expect(reopened.body.conversation.pool_number).not.toBe(oldPool);
    expect(reopened.body.conversation.pool_number).toBe(pool.provisioned[1]);
  });

  it('FIX 1: closing is idempotent — a second close is a no-op (no double release)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const oldPool = created.body.conversation.pool_number;

    const first = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(first.status).toBe(200);
    const second = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(second.status).toBe(200);
    expect(second.body.conversation.status).toBe('closed');
    // Released exactly ONCE (the idempotent second close skipped the release).
    expect(pool.released).toEqual([oldPool]);
  });

  // --- FIX 2: relay-aware team send --------------------------------------
  it('FIX 2: POST a message to a relay group stores ONCE + fans out to ALL members FROM the pool (no send to participant_phone)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    world.sent.length = 0; // drop the intro sends — assert only the team send

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body: 'Showing is at 4pm' });

    expect(res.status).toBe(201);
    expect(res.body.conversationId).toBe(id);
    expect(res.body.status).toBe('queued');
    expect(typeof res.body.tsMsgId).toBe('string');

    // Stored ONCE — exactly one outbound source message on the relay thread.
    const onThread = world.messages.filter((m) => m.conversationId === id);
    expect(onThread).toHaveLength(1);
    expect(onThread[0]!.direction).toBe('outbound');
    expect(onThread[0]!.author).toBe('teammate');

    // Fanned out to BOTH members FROM the pool number — never participant_phone.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    expect(world.sent.some((s) => s.to === poolNumber)).toBe(false);
    // Neutral team label prefix (the registered A2P brand — spec §5), NEVER a phone.
    expect(world.sent.every((s) => s.body === 'Tenant Place LLC: Showing is at 4pm')).toBe(true);
  });

  it('FIX 2: POST a message to a CLOSED relay group → 409', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });

    const res = await request(app)
      .post(`/api/conversations/${id}/messages`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ body: 'too late' });
    expect(res.status).toBe(409);
  });

  // --- FIX 4: one event builder carries the relay roster -----------------
  it('FIX 4: /read on a relay group emits conversation.updated carrying members + pool_number + status', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    world.emitted.length = 0;

    await request(app)
      .post(`/api/conversations/${id}/read`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();

    const evt = world.emitted.find((e) => e.event === 'conversation.updated');
    expect(evt).toBeDefined();
    const payload = evt!.payload as Record<string, unknown>;
    expect(payload['status']).toBe('open');
    expect(payload['pool_number']).toBe(poolNumber);
    expect(payload['members']).toHaveLength(1);
  });

  // --- FIX 5: audit actor attribution ------------------------------------
  it('FIX 5: relay mutations carry the acting user as the audit actor', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, name: 'Bob' });
    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });

    const relayAudits = world.auditEvents.filter((a) =>
      ['relay_group_created', 'relay_member_added', 'relay_group_closed'].includes(a.event_type),
    );
    expect(relayAudits.length).toBeGreaterThanOrEqual(3);
    // Every relay mutation is attributable to the session user (byActor GSI key).
    expect(relayAudits.every((a) => a.actorId === SESSION_USER_ID)).toBe(true);
  });

  it('404s relay routes on a non-relay (1:1) conversation', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    world.conversations.set('conv-1to1', {
      conversationId: 'conv-1to1',
      participant_phone: ALICE,
      status: 'open',
      last_activity_at: new Date().toISOString(),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: new Date().toISOString(),
    });
    const res = await request(app).get('/api/conversations/conv-1to1/members').set('x-origin-verify', SECRET).set('cookie', TEST_SESSION_COOKIE);
    expect(res.status).toBe(404);
  });
});
