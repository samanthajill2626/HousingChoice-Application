// Relay-group management API (M1.7) — POST /api/relay-groups, the member
// CRUD, and PATCH close/reopen. Runs on the shared in-memory world + a FAKE
// poolNumbers service (no Twilio, no real number), with the jobs machinery
// wired so the intro enqueue resolves. Authed via the real sealed session
// cookie next to the origin secret (every /api route is behind requireAuth).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
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

/** The relay.group_closed catalog default (spec 4.5) - sent to every member on close. */
const CLOSED_COPY =
  'This group chat is now closed. You can still text this number and a Housing Choice ' +
  'team member will see your message and follow up.';
const CLOSE_NAG_INTERVAL_MS = 28 * 24 * 60 * 60 * 1000;

/** A fake pool-numbers service: hands out deterministic numbers, tracks provisions + close notes. */
function makeFakePoolNumbers(): PoolNumbersService & {
  provisioned: string[];
  closed: string[];
  records: Map<string, PoolNumberItem>;
} {
  let counter = 0;
  const provisioned: string[] = [];
  const closed: string[] = [];
  const records = new Map<string, PoolNumberItem>();
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    provisioned,
    closed,
    records,
    async provisionForGroup() {
      counter += 1;
      const poolNumber = `+1555030${String(counter).padStart(4, '0')}`;
      provisioned.push(poolNumber);
      const record = rec(poolNumber);
      records.set(poolNumber, record);
      return { poolNumber, record, provisioned: true };
    },
    async noteGroupClosed(poolNumber) {
      closed.push(poolNumber);
    },
    // Default fake: always allow the add-member burn (existing add tests). The
    // burn-faithful reuse/refusal path is exercised by makeBurnFaithfulPool below.
    async burnMember() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    // AF-3: the reopen route reads the pool record. Default active; a test flips
    // records.get(n)!.lifecycle_state = 'released' to prove the reopen refusal.
    async getRecord(poolNumber) {
      return records.get(poolNumber) ?? rec(poolNumber);
    },
  };
}

/**
 * A pool service emulating the M1.7 kill-switch OFF: provisionForGroup
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
    async provisionForGroup() {
      provisionAttempts += 1;
      throw new RelayProvisioningDisabledError(DISABLED_MESSAGE);
    },
    async noteGroupClosed() {},
    async burnMember() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async getRecord() {
      return undefined;
    },
  };
}

/**
 * A BURN-FAITHFUL pool service (W1): models burned_phones per number so
 * provisionForGroup reuses only non-overlapping numbers and burnMember refuses a
 * phone already burned on a number. Lets a route test drive the real
 * multiplexing/refusal behavior (the default fake always hands out fresh numbers
 * and always allows the add). `burned` is exposed for atomicity assertions.
 */
function makeBurnFaithfulPool(): PoolNumbersService & { burned: Map<string, Set<string>> } {
  let counter = 0;
  const burned = new Map<string, Set<string>>();
  const rec = (poolNumber: string): PoolNumberItem => ({
    poolNumber,
    lifecycle_state: 'active',
    quarantine_until: '0000-00-00T00:00:00.000Z',
    voice_capable: true,
    sms_capable: true,
    provisioned_at: new Date().toISOString(),
  });
  return {
    burned,
    async provisionForGroup(rosterPhones: string[]) {
      // Reuse the first number whose burn does not overlap the roster; else buy.
      for (const [pn, set] of burned) {
        if (!rosterPhones.some((p) => set.has(p))) {
          for (const p of rosterPhones) set.add(p);
          return { poolNumber: pn, record: rec(pn), provisioned: false };
        }
      }
      counter += 1;
      const pn = `+1555070${String(counter).padStart(4, '0')}`;
      burned.set(pn, new Set(rosterPhones));
      return { poolNumber: pn, record: rec(pn), provisioned: true };
    },
    async noteGroupClosed() {},
    async burnMember(poolNumber: string, phone: string) {
      const set = burned.get(poolNumber) ?? new Set<string>();
      burned.set(poolNumber, set);
      if (set.has(phone)) return false; // already burned here -> conflict
      set.add(phone);
      return true;
    },
    async retireEligible() {
      return [];
    },
    async getRecord(poolNumber: string) {
      return rec(poolNumber);
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
    expect(pool.closed).toEqual([firstPool]); // close noted for retirement (not released)

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
    expect(pool.closed).toEqual([oldPool]); // close noted for retirement (not released)
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
    // noteGroupClosed fired exactly ONCE - the idempotent second close no-oped
    // before it (the number is never released; burn-multiplexing keeps it).
    expect(pool.closed).toHaveLength(1);
  });

  it('reopen is REFUSED (409 pool_number_released) when the number was retired; status stays closed (AF-3)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number as string;
    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    // D7 retirement RELEASED the number after 180 idle days.
    pool.records.get(poolNumber)!.lifecycle_state = 'released';

    const reopen = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('pool_number_released');
    // No zombie: the group STAYS closed and the refusal is audited.
    expect((await world.conversationsRepo.getById(id))!.status).toBe('closed');
    expect(world.auditEvents.some((a) => a.event_type === 'relay_group_reopen_refused')).toBe(true);
  });

  it('reopen still works when the pool number is still active (AF-3 control)', async () => {
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
    // The number is still active (default fake state) - reopen succeeds.
    const reopen = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });
    expect(reopen.status).toBe(200);
    expect(reopen.body.conversation.status).toBe('open');
  });

  it('a concurrent-close loser returns the re-fetched CLOSED conversation, not a stale open body (AF-8)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    // Real DynamoDB reads return SNAPSHOTS - the pre-announce read and the
    // re-fetch are DISTINCT objects. Make the fake do the same (it otherwise
    // hands back the live reference, which would alias the two and mask the bug).
    const realGetById = world.conversationsRepo.getById.bind(world.conversationsRepo);
    world.conversationsRepo.getById = async (cid) => {
      const conv = await realGetById(cid);
      return conv ? { ...conv } : undefined;
    };
    // Simulate LOSING a concurrent close: a racing winner closes the group
    // out-of-band, then THIS request's conditional flip hits ConditionalCheckFailed.
    world.conversationsRepo.setRelayStatus = async (cid) => {
      const conv = world.conversations.get(cid)!;
      conv.status = 'closed';
      conv.relay_status = 'relay_group#closed';
      throw new ConditionalCheckFailedException({ message: 'lost the close race', $metadata: {} });
    };

    const res = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(res.status).toBe(200);
    // AF-8: the response reflects the ACTUAL closed status (re-fetched), never
    // the stale pre-announce 'open' read.
    expect(res.body.conversation.status).toBe('closed');
  });

  // --- close lifecycle: final announcement, nag clear, defer (Task 5) -------
  it('close sends the relay.group_closed final message to every member FIRST, then flips to closed', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    world.sent.length = 0; // drop the intro sends - assert only the close message

    const closed = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.status).toBe('closed');

    // The final message went to BOTH members FROM the pool number, verbatim copy.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    expect(world.sent.every((s) => s.body === CLOSED_COPY)).toBe(true);
    // Persisted ONCE on the (was-open) group thread as a system announcement.
    const systemRows = world.messages.filter(
      (m) => m.conversationId === id && m.relay_sender_key === 'system' && m.body === CLOSED_COPY,
    );
    expect(systemRows).toHaveLength(1);
  });

  it('a second close does NOT re-announce (idempotent, no second final message)', async () => {
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

    world.sent.length = 0;
    const rowsBefore = world.messages.filter((m) => m.conversationId === id).length;
    const second = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(second.status).toBe(200);
    // No second announcement: no new legs, no new persisted rows.
    expect(world.sent).toHaveLength(0);
    expect(world.messages.filter((m) => m.conversationId === id).length).toBe(rowsBefore);
  });

  it('close clears close_nag_next_at (the Today nag stops)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    // Simulate a pending close-nag on the open group (defer set it earlier).
    world.conversations.get(id)!.close_nag_next_at = new Date().toISOString();

    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(world.conversations.get(id)!.close_nag_next_at).toBeUndefined();
  });

  it('close still succeeds when the final announcement fails (logged, not fatal)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    // Force the announcement PERSIST to throw (the only propagating failure in
    // sendRelayAnnouncement). Close must proceed regardless (spec 4.4).
    world.messagesRepo.append = async () => {
      throw new Error('append boom');
    };

    const closed = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.status).toBe('closed');
    expect(closed.body.conversation.pool_number).toBe(poolNumber);
    expect(pool.closed).toEqual([poolNumber]); // still noted for retirement
  });

  it('POST /close-nag/defer sets close_nag_next_at ~= now + 28d and audits the deferral', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId;

    const before = Date.now();
    const res = await request(app)
      .post(`/api/conversations/${id}/close-nag/defer`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(200);
    const nextAt = Date.parse(res.body.conversation.close_nag_next_at as string);
    // Within a minute of now + 28d (the fixed server-side interval).
    expect(Math.abs(nextAt - (before + CLOSE_NAG_INTERVAL_MS))).toBeLessThan(60_000);

    const deferAudit = world.auditEvents.find((a) => a.event_type === 'relay_close_nag_deferred');
    expect(deferAudit).toBeDefined();
    expect(deferAudit?.actorId).toBe(SESSION_USER_ID);
  });

  it('POST /close-nag/defer 404s a non-relay conversation', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    world.conversations.set('conv-1to1-defer', {
      conversationId: 'conv-1to1-defer',
      participant_phone: ALICE,
      status: 'open',
      last_activity_at: new Date().toISOString(),
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: new Date().toISOString(),
    });
    const res = await request(app)
      .post('/api/conversations/conv-1to1-defer/close-nag/defer')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('relay_group_not_found');
  });

  it('POST /close-nag/defer on a CLOSED group is a 200 no-op (no nag write, no audit) (AF-9)', async () => {
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
    world.auditEvents.length = 0; // drop the close audit so the defer assertion is clean

    const res = await request(app)
      .post(`/api/conversations/${id}/close-nag/defer`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send();
    expect(res.status).toBe(200);
    // No nag armed on the closed group, and no defer audit was written.
    expect(world.conversations.get(id)!.close_nag_next_at).toBeUndefined();
    expect(world.auditEvents.some((a) => a.event_type === 'relay_close_nag_deferred')).toBe(false);
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

  // --- W1: add-member burn gap (ever_member_phones provenance) --------------
  describe('W1 add-member burn gap', () => {
    const CAROL = '+15550100003';
    const DAVE = '+15550100004';
    const ERIN = '+15550100005';

    it('adding a person already rostered on ANOTHER group sharing the number is refused (409 phone_conflict_on_number); roster + burn unchanged', async () => {
      const pool = makeBurnFaithfulPool();
      const { app } = authedHarness(world, pool);
      // g1 {ALICE,BOB} -> N; g2 {CAROL,DAVE} REUSES N (disjoint rosters).
      const g1 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE }, { phone: BOB }] });
      const id1 = g1.body.conversation.conversationId as string;
      const n = g1.body.conversation.pool_number as string;
      const g2 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: CAROL }, { phone: DAVE }] });
      expect(g2.body.conversation.pool_number).toBe(n); // multiplexed on ONE number
      const burnBefore = [...(pool.burned.get(n) ?? [])].sort();

      // Add CAROL (burned by g2 on N) to g1 -> refused, ATOMIC.
      const add = await request(app)
        .post(`/api/conversations/${id1}/members`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: CAROL });
      expect(add.status).toBe(409);
      expect(add.body.error).toBe('phone_conflict_on_number');
      expect(add.body.message).toMatch(/new group text/i);
      // Roster unchanged (CAROL not added); burn set unchanged (no partial add).
      const g1After = await world.conversationsRepo.getById(id1);
      expect((g1After!.participants ?? []).map((p) => p.phone)).toEqual([ALICE, BOB]);
      expect([...(pool.burned.get(n) ?? [])].sort()).toEqual(burnBefore);
      // Audited with actor + reason, and NO phone (PII).
      const refusal = world.auditEvents.find((a) => a.event_type === 'relay_member_add_refused');
      expect(refusal?.actorId).toBe(SESSION_USER_ID);
      expect(refusal?.payload?.['reason']).toBe('phone_conflict_on_number');
      expect(JSON.stringify(refusal)).not.toContain(CAROL);
    });

    it('via-reuse regression: a phone added to a group is BURNED, so a later group with that phone lands on a DIFFERENT number (variant b)', async () => {
      const pool = makeBurnFaithfulPool();
      const { app } = authedHarness(world, pool);
      // g1 {ALICE} -> N.
      const g1 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE }] });
      const id1 = g1.body.conversation.conversationId as string;
      const n = g1.body.conversation.pool_number as string;
      // Add CAROL to g1 -> CAROL is burned onto N (the W1 fix).
      const add = await request(app)
        .post(`/api/conversations/${id1}/members`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: CAROL });
      expect(add.status).toBe(200);
      expect([...(pool.burned.get(n) ?? [])]).toContain(CAROL);

      // A NEW group containing CAROL must NOT reuse N (CAROL now overlaps its
      // burn). WITHOUT the burn-on-add fix this lands back on N (the bug).
      const g2 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: CAROL }, { phone: ERIN }] });
      expect(g2.status).toBe(201);
      expect(g2.body.conversation.pool_number).not.toBe(n);
    });

    it('remove then re-add the SAME member succeeds without a 409 (a burn is forever)', async () => {
      const pool = makeBurnFaithfulPool();
      const { app } = authedHarness(world, pool);
      const g1 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE }, { phone: BOB }] });
      const id = g1.body.conversation.conversationId as string;
      const del = await request(app)
        .delete(`/api/conversations/${id}/members/${encodeURIComponent(BOB)}`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE);
      expect(del.status).toBe(200);
      expect((del.body.members as Array<{ phone: string }>).map((m) => m.phone)).not.toContain(BOB);
      // Re-add BOB: rule 2 (still in ever_member_phones) -> no fresh burnClaim, no
      // 409 (a burn-faithful pool WOULD 409 if burnMember were wrongly called).
      const readd = await request(app)
        .post(`/api/conversations/${id}/members`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: BOB });
      expect(readd.status).toBe(200);
      expect((readd.body.members as Array<{ phone: string }>).map((m) => m.phone)).toContain(BOB);
    });

    it('a legacy group (no ever_member_phones) initializes it from the roster on first add and behaves', async () => {
      const pool = makeBurnFaithfulPool();
      const { app } = authedHarness(world, pool);
      const g1 = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE }] });
      const id = g1.body.conversation.conversationId as string;
      // Model a PRE-W1 row: strip the attribute the new code seeds.
      delete world.conversations.get(id)!.ever_member_phones;

      const add = await request(app)
        .post(`/api/conversations/${id}/members`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ phone: BOB });
      expect(add.status).toBe(200);
      // Initialized from the post-add roster {ALICE, BOB}.
      const raw = world.conversations.get(id)!.ever_member_phones;
      const ever = raw instanceof Set ? raw : new Set(raw as string[]);
      expect([...ever].sort()).toEqual([ALICE, BOB].sort());
    });
  });

  // --- W2: reopen is fenced while the number is mid-release ------------------
  it('reopen is REFUSED (409) while the number is mid-release (releasing) - W2 fence', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }] });
    const id = created.body.conversation.conversationId as string;
    const poolNumber = created.body.conversation.pool_number as string;
    await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    // The retirement sweep CLAIMED the number mid-window (active -> releasing).
    pool.records.get(poolNumber)!.lifecycle_state = 'releasing';

    const reopen = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: false });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error).toBe('pool_number_released');
    // No zombie: the group stays closed.
    expect((await world.conversationsRepo.getById(id))!.status).toBe('closed');
  });

  // --- W3: close-announce dedup claim ---------------------------------------
  describe('W3 close-announce dedup', () => {
    it('two concurrent closes announce the final message EXACTLY once', async () => {
      const pool = makeFakePoolNumbers();
      const { app } = authedHarness(world, pool);
      const created = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
      const id = created.body.conversation.conversationId as string;
      world.sent.length = 0; // drop the intro sends

      // Fire both closes concurrently: the atomic claim admits exactly one announce.
      const [a, b] = await Promise.all([
        request(app)
          .patch(`/api/conversations/${id}/close`)
          .set('x-origin-verify', SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send({ closed: true }),
        request(app)
          .patch(`/api/conversations/${id}/close`)
          .set('x-origin-verify', SECRET)
          .set('cookie', TEST_SESSION_COOKIE)
          .send({ closed: true }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      // Exactly ONE relay.group_closed announcement persisted; one leg per member.
      const systemRows = world.messages.filter(
        (m) => m.conversationId === id && m.relay_sender_key === 'system' && m.body === CLOSED_COPY,
      );
      expect(systemRows).toHaveLength(1);
      expect(world.sent.filter((s) => s.body === CLOSED_COPY)).toHaveLength(2);
    });

    it('a close retry after a crash between announce and flip announces NOTHING and still flips to closed', async () => {
      const pool = makeFakePoolNumbers();
      const { app } = authedHarness(world, pool);
      const created = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE, name: 'Alice' }] });
      const id = created.body.conversation.conversationId as string;
      // Crash state: the announce was claimed but the flip never ran (marker set,
      // group STILL open).
      world.conversations.get(id)!.close_announced_at = new Date().toISOString();
      world.sent.length = 0;
      const rowsBefore = world.messages.filter((m) => m.conversationId === id).length;

      const res = await request(app)
        .patch(`/api/conversations/${id}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: true });
      expect(res.status).toBe(200);
      expect(res.body.conversation.status).toBe('closed'); // flip completed
      // No re-announcement: no new legs, no new persisted rows.
      expect(world.sent).toHaveLength(0);
      expect(world.messages.filter((m) => m.conversationId === id).length).toBe(rowsBefore);
    });

    it('reopen clears the announce marker, so a subsequent close announces again (exactly once)', async () => {
      const pool = makeFakePoolNumbers();
      const { app } = authedHarness(world, pool);
      const created = await request(app)
        .post('/api/relay-groups')
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ members: [{ phone: ALICE, name: 'Alice' }] });
      const id = created.body.conversation.conversationId as string;
      await request(app)
        .patch(`/api/conversations/${id}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: true });
      expect(world.conversations.get(id)!.close_announced_at).toBeDefined();
      // Reopen CLEARS the marker (folded into the status flip).
      await request(app)
        .patch(`/api/conversations/${id}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: false });
      expect(world.conversations.get(id)!.close_announced_at).toBeUndefined();
      // A subsequent close announces AGAIN, exactly once.
      world.sent.length = 0;
      await request(app)
        .patch(`/api/conversations/${id}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: true });
      expect(world.sent.filter((s) => s.body === CLOSED_COPY)).toHaveLength(1);
    });
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
