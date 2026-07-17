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
import { armTourReminders } from '../src/jobs/tourReminders.js';
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

  // (Reopen no longer provisions a number - it reuses the same one - so there is
  // no reopen kill-switch path to test. Create-time 503 is covered above.)

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

  it('PATCH close KEEPS the pool number; reopen reuses the SAME number (no re-provision)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const firstPool = created.body.conversation.pool_number;

    // Close -> status closed, pool number KEPT (burn-multiplexing), NOT released.
    const closed = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.status).toBe('closed');
    expect(closed.body.conversation.pool_number).toBe(firstPool);
    expect(pool.released).toEqual([]); // nothing released

    // Reopen -> the SAME number is reused (nothing re-provisioned).
    const reopened = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });
    expect(reopened.status).toBe(200);
    expect(reopened.body.conversation.status).toBe('open');
    expect(reopened.body.conversation.pool_number).toBe(firstPool);
    expect(pool.provisioned).toEqual([firstPool]); // only the create provisioned
  });

  // --- close/reopen keep the number; close/reopen race stays idempotent ----
  it('close KEEPS pool_number; getAllByPoolNumber still resolves the closed group (late-text interception)', async () => {
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

    // A late inbound STILL resolves the (now closed) group so it can intercept
    // to the sender's 1:1 - pool_number is never cleared.
    const all = await world.conversationsRepo.getAllByPoolNumber(oldPool);
    expect(all.map((c) => c.conversationId)).toContain(id);
    const after = await world.conversationsRepo.getById(id);
    expect(after?.status).toBe('closed');
    expect(after?.pool_number).toBe(oldPool);
    expect(pool.released).toEqual([]); // nothing released
  });

  it('reopen reuses the SAME number the group already had', async () => {
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

    expect(reopened.body.conversation.pool_number).toBe(oldPool);
    expect(pool.provisioned).toEqual([oldPool]); // no second provision
  });

  it('closing is idempotent - a second close is a no-op (no release either way)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;

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
    // The number is never released (burn-multiplexing keeps it).
    expect(pool.released).toEqual([]);
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

    // The thread carries the PERSISTED intro announcement (2026-07-14:
    // everything sent into a group text is visible in its thread) plus the
    // team message stored ONCE — never N outbound copies of the team send.
    const onThread = world.messages.filter((m) => m.conversationId === id);
    expect(onThread.filter((m) => m.relay_sender_key === 'system')).toHaveLength(1);
    const teamRows = onThread.filter((m) => m.relay_sender_key !== 'system');
    expect(teamRows).toHaveLength(1);
    expect(teamRows[0]!.direction).toBe('outbound');
    expect(teamRows[0]!.author).toBe('teammate');

    // Fanned out to BOTH members FROM the pool number — never participant_phone.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    expect(world.sent.some((s) => s.to === poolNumber)).toBe(false);
    // Neutral team label prefix (the registered A2P brand — spec §5), NEVER a phone.
    expect(world.sent.every((s) => s.body === 'Tenant Place LLC: Showing is at 4pm')).toBe(true);
  });

  // Member added to an EXISTING group (2026-07-14): announced to the whole
  // group + persisted in the thread; an idempotent re-add stays silent.
  it('adding a member announces the join to the whole group; a re-add of the same phone does NOT', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    world.sent.length = 0; // drop the intro sends — assert only the join notice

    const add = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, name: 'Bob' });
    expect(add.status).toBe(200);

    // Announced to BOTH members (Bob's welcome doubles as Alice's notice).
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    expect(world.sent[0]!.body).toContain('Bob joined this group text.');
    // Persisted in the thread: the intro row + ONE join-notice row.
    const systemRows = world.messages.filter(
      (m) => m.conversationId === id && m.relay_sender_key === 'system',
    );
    expect(systemRows).toHaveLength(2);
    expect(systemRows.some((m) => (m.body ?? '').includes('Bob joined this group text.'))).toBe(true);

    // Idempotent re-add: no new announcement, no new sends.
    world.sent.length = 0;
    const readd = await request(app)
      .post(`/api/conversations/${id}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, name: 'Bob' });
    expect(readd.status).toBe(200);
    expect(world.sent).toHaveLength(0);
    expect(
      world.messages.filter((m) => m.conversationId === id && m.relay_sender_key === 'system'),
    ).toHaveLength(2);
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

  // --- GET /conversations/:id/scheduled — the group thread's "Upcoming" bucket
  // (scheduled-message-visibility parity, 2026-07-14). Routing mirrors the
  // reminder poller: rungs show here only when they WILL route to this group.
  describe('GET /api/conversations/:conversationId/scheduled', () => {
    const logger = createLogger({ destination: createLogCapture().stream });

    /** Create a TOUR-OWNED open relay group + arm the reminder ladder. */
    async function seedTourGroup(
      app: Parameters<typeof request>[0],
      tourType: 'landlord_led' | 'self_guided',
    ) {
      const tour = await world.toursRepo.create({
        tenantId: 'c-tenant-1',
        unitId: 'unit-1',
        tourType,
        scheduledAt: '2026-08-03T18:00:00.000Z',
      });
      const created = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
      const conversationId = created.body.conversation.conversationId as string;
      await world.conversationsRepo.rebindOwner(conversationId, { type: 'tour', id: tour.tourId });
      await world.toursRepo.patch(tour.tourId, { groupThreadId: conversationId });
      await armTourReminders(tour, '2026-08-01T10:00:00.000Z', {
        tourRemindersRepo: world.tourRemindersRepo,
        logger,
      });
      return { tour, conversationId };
    }

    it('returns the group-routed upcoming rungs (dueAt order, resolved bodies); sent rungs drop out', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { tour, conversationId } = await seedTourGroup(app, 'landlord_led');

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      const scheduled = res.body.scheduled as Array<Record<string, unknown>>;
      // The full 5-rung ladder is upcoming (armed 2 days before the tour).
      expect(scheduled).toHaveLength(5);
      // dueAt ascending; each item is wire-parity TimelineScheduled.
      const ats = scheduled.map((s) => s['at'] as string);
      expect([...ats].sort()).toEqual(ats);
      const first = scheduled[0]!;
      expect(first['kind']).toBe('scheduled');
      expect(first['source']).toBe('tour_reminder');
      expect(first['reminderKind']).toBe('confirmation');
      expect(first['body']).toContain('Your tour is confirmed');
      expect(first['conversationId']).toBe(conversationId);
      expect(first['refType']).toBe('tour');
      expect(first['refId']).toBe(tour.tourId);

      // Fire one rung (claim = sent) — it must drop out of the bucket.
      const rows = await world.tourRemindersRepo.listByTour(tour.tourId);
      const confirmation = rows.find((r) => r.kind === 'confirmation')!;
      await world.tourRemindersRepo.claimSend(confirmation.reminderId, '2026-08-01T10:01:00.000Z');
      const after = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      expect(after.body.scheduled).toHaveLength(4);
      expect(
        (after.body.scheduled as Array<{ reminderKind: string }>).some(
          (s) => s.reminderKind === 'confirmation',
        ),
      ).toBe(false);
    });

    it('a self_guided owner routes 1:1 — the group bucket stays empty', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { conversationId } = await seedTourGroup(app, 'self_guided');
      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      expect(res.body.scheduled).toEqual([]);
    });

    it('a CLOSED group is unusable (rungs fall back 1:1) — empty bucket', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { conversationId } = await seedTourGroup(app, 'landlord_led');
      await request(app)
        .patch(`/api/conversations/${conversationId}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: true })
        .expect(200);
      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      expect(res.body.scheduled).toEqual([]);
    });

    it('a 1:1 conversation gets an EMPTY bucket (200, not 404 — its upcoming lives on the contact timeline)', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      world.conversations.set('conv-1to1-sched', {
        conversationId: 'conv-1to1-sched',
        participant_phone: ALICE,
        status: 'open',
        last_activity_at: new Date().toISOString(),
        type: 'tenant_1to1',
        ai_mode: 'auto',
        created_at: new Date().toISOString(),
      });
      const res = await request(app)
        .get('/api/conversations/conv-1to1-sched/scheduled')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      expect(res.body.scheduled).toEqual([]);
    });

    it('404s an unknown conversation', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      await request(app)
        .get('/api/conversations/conv-ghost/scheduled')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(404);
    });
  });
});
