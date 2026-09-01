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
import { quietOffSettingsRepo } from './helpers/settingsStub.js';
import { createFakeWorld, makeWebhookHarness, ORIGIN_SECRET, type FakeWorld } from './helpers/twilioWebhookHarness.js';
import { RELAY_INTRO_MAX_CHARS } from '../src/lib/relayIntroBody.js';

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
      return { kind: 'assigned', poolNumber, record, provisioned: true };
    },
    async noteGroupClosed(poolNumber) {
      closed.push(poolNumber);
    },
    // Default fake: always allow the add-member burn (existing add tests). The
    // burn-faithful reuse/refusal path is exercised by makeBurnFaithfulPool below.
    async burnMember() {
      return true;
    },
    async burnGroupRoster() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async onNumberRegistered() {},
    async warmOneNumber() {},
    async refillBufferIfNeeded() {},
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    // AF-3: the reopen route reads the pool record. Default active; a test flips
    // records.get(n)!.lifecycle_state = 'released' to prove the reopen refusal.
    async getRecord(poolNumber) {
      return records.get(poolNumber) ?? rec(poolNumber);
    },
    async clearConnectingEarmarks() {},
  };
}

/**
 * A pool service emulating the M1.7 kill-switch OFF at a TIER-3 miss:
 * provisionForGroup throws RelayProvisioningDisabledError. This faithfully models
 * the REAL service on the deployed twilio driver pre-A2P - a fresh-pair, no-spare
 * roster (no reuse, no spare) with relayLiveProvisioning off hits tier 3, which
 * cannot warm a number and so throws (proven in poolNumbers.test.ts). The 503 test
 * below sends a single fresh member, exactly that fresh-pair/no-spare scenario. NO
 * number is ever handed out - the route must surface 503 relay_provisioning_disabled.
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
    async burnGroupRoster() {
      return true;
    },
    async retireEligible() {
      return [];
    },
    async onNumberRegistered() {},
    async warmOneNumber() {},
    async refillBufferIfNeeded() {},
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    async getRecord() {
      return undefined;
    },
    async clearConnectingEarmarks() {},
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
          return { kind: 'assigned', poolNumber: pn, record: rec(pn), provisioned: false };
        }
      }
      counter += 1;
      const pn = `+1555070${String(counter).padStart(4, '0')}`;
      burned.set(pn, new Set(rosterPhones));
      return { kind: 'assigned', poolNumber: pn, record: rec(pn), provisioned: true };
    },
    async noteGroupClosed() {},
    async burnMember(poolNumber: string, phone: string) {
      const set = burned.get(poolNumber) ?? new Set<string>();
      burned.set(poolNumber, set);
      if (set.has(phone)) return false; // already burned here -> conflict
      set.add(phone);
      return true;
    },
    async burnGroupRoster(poolNumber: string, phones: string[]) {
      const set = burned.get(poolNumber) ?? new Set<string>();
      burned.set(poolNumber, set);
      if (phones.some((p) => set.has(p))) return false; // overlap -> refuse
      for (const p of phones) set.add(p);
      return true;
    },
    async retireEligible() {
      return [];
    },
    async onNumberRegistered() {},
    async warmOneNumber() {},
    async refillBufferIfNeeded() {},
    async flagStuckWarming() {},
    async flagStuckConnecting() {},
    async getRecord(poolNumber: string) {
      return rec(poolNumber);
    },
    async clearConnectingEarmarks() {},
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

  // Operator-edited intro (2026-08-20), end to end through the real create
  // route: what the confirm dialog posts is what every member receives.
  it('POST /api/relay-groups sends an operator-edited introBody instead of the composed default', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const edited = "Hi Alice, it's Sam - putting you in with Bob about 12 Peachtree St.";

    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }],
        introBody: edited,
      });

    expect(res.status).toBe(201);
    // Persisted on the CONVERSATION - it has to outlive the request, because a
    // connecting group sends its intro only when its number registers.
    expect(res.body.conversation.intro_body).toBe(edited);
    expect(world.sent.length).toBeGreaterThan(0);
    for (const sent of world.sent) {
      expect(sent.body).toBe(edited);
    }
  });

  it('POST /api/relay-groups keeps the composed default when the preview was untouched', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });

    expect(res.status).toBe(201);
    expect(res.body.conversation.intro_body).toBeUndefined();
    for (const sent of world.sent) {
      expect(sent.body).toContain("You're now connected with");
    }
  });

  it('POST /api/relay-groups 400s an over-long introBody, creating nothing', async () => {
    const { app } = authedHarness(world, makeFakePoolNumbers());
    const res = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({
        members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }],
        introBody: 'x'.repeat(RELAY_INTRO_MAX_CHARS + 1),
      });

    expect(res.status).toBe(400);
    // Refused BEFORE provisioning: no number claimed, nobody texted.
    expect(world.sent).toHaveLength(0);
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

  it('GET roster resolves a contact name live instead of returning the creation-time snapshot', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    world.contacts.push({
      contactId: 'c-alice',
      type: 'tenant',
      status: 'active',
      phone: ALICE,
      firstName: 'Alicia',
      lastName: 'Jones',
    });
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550300999',
      members: [{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }],
    });

    const roster = await request(app)
      .get(`/api/conversations/${conversation.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(roster.status).toBe(200);
    expect(roster.body.members).toEqual([
      { contactId: 'c-alice', phone: ALICE, name: 'Alicia Jones' },
    ]);
  });

  it('GET roster drops the creation-time name when the current contact is unnamed', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    world.contacts.push({
      contactId: 'c-alice',
      type: 'tenant',
      status: 'active',
      phone: ALICE,
    });
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550300998',
      members: [{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }],
    });

    const roster = await request(app)
      .get(`/api/conversations/${conversation.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(roster.status).toBe(200);
    expect(roster.body.members).toEqual([{ contactId: 'c-alice', phone: ALICE }]);
  });

  it('GET roster falls back to the roster phone, not a stale name, when contact lookup fails', async () => {
    const originalGetById = world.contactsRepo.getById.bind(world.contactsRepo);
    world.contactsRepo.getById = async (contactId) => {
      if (contactId === 'c-alice') throw new Error('injected contact lookup failure');
      return originalGetById(contactId);
    };
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const conversation = await world.conversationsRepo.createRelayGroup({
      poolNumber: '+15550300997',
      members: [{ contactId: 'c-alice', phone: ALICE, name: 'Old roster name' }],
    });

    const roster = await request(app)
      .get(`/api/conversations/${conversation.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(roster.status).toBe(200);
    expect(roster.body.members).toEqual([{ contactId: 'c-alice', phone: ALICE }]);
  });

  it('refuses member-add on a CONNECTING group (D11): 409 group_connecting, roster unchanged (burn invariant protected)', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    // A connect-when-ready group: created with NO pool number -> connecting. A
    // member add here would SILENTLY SKIP the burn (no pool number to burn onto).
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [{ phone: ALICE, contactId: 'c-alice', name: 'Alice' }],
    });
    expect(connecting.status).toBe('connecting');

    const res = await request(app)
      .post(`/api/conversations/${connecting.conversationId}/members`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ phone: BOB, name: 'Bob' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('group_connecting');
    // Roster untouched - refused BEFORE any mutation (no unburned member added).
    const after = await world.conversationsRepo.getById(connecting.conversationId);
    expect(after?.participants).toHaveLength(1);
  });

  it('refuses member-REMOVE on a CONNECTING group (D11 parity): 409 group_connecting', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [
        { phone: ALICE, contactId: 'c-alice', name: 'Alice' },
        { phone: BOB, contactId: 'c-bob', name: 'Bob' },
      ],
    });

    const res = await request(app)
      .delete(`/api/conversations/${connecting.conversationId}/members/${encodeURIComponent(BOB)}`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('group_connecting');
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
  // FOUNDER DECISION 2026-08-18: closing a relay group no longer texts anyone.
  // RELAY_CLOSE_ANNOUNCEMENT_ENABLED (routes/relayGroups.ts) is off; the copy,
  // the catalog entry and sendRelayAnnouncement are all still in place, because
  // the message is expected back. Everything ELSE about close must keep working,
  // which is what this test now guards.
  it('close sends NO final message but still flips to closed and keeps the number', async () => {
    const pool = makeFakePoolNumbers();
    const { app } = authedHarness(world, pool);
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
    const id = created.body.conversation.conversationId;
    const poolNumber = created.body.conversation.pool_number;
    world.sent.length = 0; // drop the intro sends

    const closed = await request(app)
      .patch(`/api/conversations/${id}/close`)
      .set('x-origin-verify', SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ closed: true });
    expect(closed.status).toBe(200);
    expect(closed.body.conversation.status).toBe('closed');
    // Burn-multiplexing is unaffected: the number is KEPT so a late text still
    // resolves the closed group and intercepts to the sender's 1:1.
    expect(closed.body.conversation.pool_number).toBe(poolNumber);

    // Nobody was texted, and nothing was persisted on the thread.
    expect(world.sent).toHaveLength(0);
    expect(
      world.messages.filter((m) => m.conversationId === id && m.body === CLOSED_COPY),
    ).toHaveLength(0);
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
    // everything sent into a relay group is visible in its thread) plus the
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
    // Neutral team label prefix (the SMS-facing brand — spec §5), NEVER a phone.
    expect(world.sent.every((s) => s.body === 'HousingChoice: Showing is at 4pm')).toBe(true);
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

    // Announced to BOTH members - but with DIFFERENT copy since Phase B (spec
    // 9.4): Alice hears who joined, Bob gets the naked intro as his first
    // contact. This group is STANDALONE, so no owner and therefore no role.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    expect(world.sent.find((s) => s.to === ALICE)!.body).toBe('Hey, adding Bob to the group.');
    const bobLeg = world.sent.find((s) => s.to === BOB)!;
    expect(bobLeg.body).toContain("You're now connected with Alice and Bob");
    // Persisted in the thread: the intro row + ONE join-notice row - and spec
    // 9.6's named exception, the join row carries the NEW MEMBER's body.
    const systemRows = world.messages.filter(
      (m) => m.conversationId === id && m.relay_sender_key === 'system',
    );
    expect(systemRows).toHaveLength(2);
    expect(systemRows.some((m) => (m.body ?? '') === bobLeg.body)).toBe(true);
    expect(systemRows.some((m) => (m.body ?? '').includes('Hey, adding Bob'))).toBe(false);

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
      expect(add.body.message).toMatch(/new relay group/i);
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
      // The announcement itself is switched off (founder decision 2026-08-18),
      // so nothing is sent or persisted. The CLAIM still runs, which is the
      // point of keeping this test: the dedup/TOCTOU machinery stays exercised,
      // so turning the message back on cannot quietly resurrect a
      // double-announce. Exactly one claim was won across both concurrent calls.
      expect(world.conversations.get(id)!.close_announced_at).toBeDefined();
      expect(world.sent.filter((s) => s.body === CLOSED_COPY)).toHaveLength(0);
      expect(
        world.messages.filter((m) => m.conversationId === id && m.body === CLOSED_COPY),
      ).toHaveLength(0);
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

    it('reopen clears the announce marker, so a subsequent close re-claims it (exactly once)', async () => {
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
      // A subsequent close RE-CLAIMS the marker. No message goes out while the
      // announcement is switched off (founder decision 2026-08-18), but the
      // claim/clear cycle is what a future re-enable depends on, so it is still
      // pinned here.
      world.sent.length = 0;
      await request(app)
        .patch(`/api/conversations/${id}/close`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .send({ closed: true });
      expect(world.conversations.get(id)!.close_announced_at).toBeDefined();
      expect(world.sent.filter((s) => s.body === CLOSED_COPY)).toHaveLength(0);
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
      unitId = 'unit-1',
    ) {
      const tour = await world.toursRepo.create({
        tenantId: 'c-tenant-1',
        unitId,
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
      const { ladderId } = await armTourReminders(tour, '2026-08-01T10:00:00.000Z', {
        tourRemindersRepo: world.tourRemindersRepo,
        // Not a quiet-hours case: the window is stubbed OFF so the ladder's
        // dueAts stay exactly the raw offsets this bucket asserts on.
        settingsRepo: quietOffSettingsRepo(),
        logger,
      });
      // POINT THE TOUR AT WHAT WAS JUST ARMED, exactly as routes/tours.ts does
      // after its own arm (S3). This helper arms for REAL against a tour it
      // builds by hand, so without the pointer write its rows are STAMPED on a
      // POINTERLESS tour - the interrupted-pointer-write cell - and every rung
      // in this bucket reads `superseded` instead of upcoming.
      if (ladderId !== null) {
        await world.toursRepo.patch(tour.tourId, { currentLadderId: ladderId });
      }
      // `ladderId` is returned so a case adding a row BY HAND can stamp it into
      // the same generation. An unstamped row on a pointed tour is the
      // interrupted-pointer-write cell, which reads `superseded` - correct, but
      // not what a case about some OTHER annotation means to test.
      return { tour, conversationId, ladderId };
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
      // The full 3-rung auto ladder is upcoming (armed 2 days before the tour).
      // Two kinds are absent by design: no_show_checkin is manual-send only,
      // and confirmation stopped arming 2026-08-31 (Phase B).
      expect(scheduled).toHaveLength(3);
      // dueAt ascending; each item is wire-parity TimelineScheduled.
      const ats = scheduled.map((s) => s['at'] as string);
      expect([...ats].sort()).toEqual(ats);
      const first = scheduled[0]!;
      expect(first['kind']).toBe('scheduled');
      expect(first['source']).toBe('tour_reminder');
      // day_before is the earliest live rung now that confirmation is gone.
      expect(first['reminderKind']).toBe('day_before');
      // The flipped copy: composed by the SAME composer the send path uses, so
      // the body opens with the day_before lead-in and carries the local time
      // (zone-agnostic shape - this bucket does not pin the org zone).
      expect(first['body']).toContain('confirming your tour tomorrow at');
      expect(first['body']).toMatch(/at \d{1,2}:\d{2} (AM|PM)/);
      expect(first['conversationId']).toBe(conversationId);
      expect(first['refType']).toBe('tour');
      expect(first['refId']).toBe(tour.tourId);
      // The bucket carries the zone those bodies were composed in (spec D8), so
      // the group thread renders each card's fire time in the same zone the
      // body quotes - exactly like the contact timeline.
      expect(res.body.timezone).toBe(world.settings.timezone);

      // Fire one rung (claim = sent) — it must drop out of the bucket.
      const rows = await world.tourRemindersRepo.listByTour(tour.tourId);
      const dayBefore = rows.find((r) => r.kind === 'day_before')!;
      await world.tourRemindersRepo.claimSend(dayBefore.reminderId, '2026-08-01T10:01:00.000Z');
      const after = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      expect(after.body.scheduled).toHaveLength(2);
      expect(
        (after.body.scheduled as Array<{ reminderKind: string }>).some(
          (s) => s.reminderKind === 'day_before',
        ),
      ).toBe(false);
    });

    it('a DISCONTINUED rung carries the discontinued suppression; live rungs carry none', async () => {
      // The FIFTH read surface (Phase B spec 3.1's standing hazard: grep for
      // readers, do not reason from the writer's side). This bucket renders
      // through the SAME ScheduledCard as the contact timeline, in every relay
      // thread - so without this a pause-era confirmation would keep promising
      // "sends in Nh" here while the tour panel and the contact page both said
      // it will never go out.
      //
      // NOTE what is deliberately NOT added: no other suppression is evaluated
      // in this bucket. Member-level opt-out suppresses individual LEGS at send
      // time, never the group send itself, and the placement-nudge twin owns
      // the rest of that gap.
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { tour, conversationId, ladderId } = await seedTourGroup(app, 'landlord_led');
      // A PAUSE-ERA row, written directly: arming stopped 2026-08-31 (Phase B),
      // so `armTourReminders` above no longer produces one - and this surface
      // exists precisely for the rows that were armed BEFORE it stopped and are
      // still sitting pending until the sweep reaches them. dueAt is the old
      // arm instant, which is what those rows actually carry.
      //
      // STAMPED WITH THE CURRENT GENERATION (S6): the pointer check runs ahead
      // of the kind check, so an unstamped row on this pointed tour would read
      // `superseded` and this case would prove the wrong annotation. Its own
      // subject is the KIND, so it is pinned to the live ladder deliberately.
      await world.tourRemindersRepo.create({
        tourId: tour.tourId,
        kind: 'confirmation',
        dueAt: '2026-08-01T10:00:00.000Z',
        ...(ladderId !== null && { ladderId }),
      });

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      const scheduled = res.body.scheduled as Array<{
        reminderKind: string;
        suppression?: { reason: string };
      }>;
      const confirmation = scheduled.find((s) => s.reminderKind === 'confirmation');
      expect(confirmation?.suppression).toEqual({ reason: 'discontinued' });
      // ANTI-VACUITY: it is per-KIND, not "this bucket suppresses everything".
      for (const kind of ['day_before', 'morning_of', 'en_route']) {
        expect(
          scheduled.find((s) => s.reminderKind === kind)?.suppression,
          kind,
        ).toBeUndefined();
      }
    });

    // SUPERSEDED rungs (spec 3.3, S6 T6.3) - the SECOND exception this bucket
    // makes to "no suppression annotations here". Same argument as the first:
    // it costs no recipient IO, and this bucket renders through the same
    // ScheduledCard as the contact timeline, so without it a rescheduled tour's
    // old rungs would keep promising "sends in Nh" in the relay thread while
    // both other surfaces called them Replaced.
    it('a rung of a REPLACED ladder carries the superseded suppression; the current generation carries none', async () => {
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { tour, conversationId } = await seedTourGroup(app, 'landlord_led');
      // The tour was rescheduled: a newer arm won the pointer, and one rung of
      // the previous generation survived the sweep. LIVE kinds throughout - a
      // discontinued kind is checked ahead of the pointer and would make this
      // pass for the wrong reason.
      const rows = await world.tourRemindersRepo.listByTour(tour.tourId);
      const stale = rows.find((r) => r.kind === 'day_before')!;
      world.tourRemindersMap.get(stale.reminderId)!.ladderId = 'ladder-group-old';

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      const scheduled = res.body.scheduled as Array<{
        reminderKind: string;
        suppression?: { reason: string };
      }>;
      expect(scheduled.find((s) => s.reminderKind === 'day_before')?.suppression).toEqual({
        reason: 'superseded',
      });
      // ANTI-VACUITY: the rungs the pointer still names promise their sends.
      for (const kind of ['morning_of', 'en_route']) {
        expect(scheduled.find((s) => s.reminderKind === kind)?.suppression, kind).toBeUndefined();
      }
    });

    it('LEGACY: a pre-migration pair (no pointer, no ladderId) is NOT suppressed in this bucket', async () => {
      // Acceptance 12. The helper above points its tour, so this case builds
      // the pre-migration shape deliberately: pointer cleared, rows unstamped.
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { tour, conversationId } = await seedTourGroup(app, 'landlord_led');
      const stored = world.toursMap.get(tour.tourId)!;
      delete stored.currentLadderId;
      for (const row of await world.tourRemindersRepo.listByTour(tour.tourId)) {
        delete world.tourRemindersMap.get(row.reminderId)!.ladderId;
      }

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);
      const scheduled = res.body.scheduled as Array<{
        reminderKind: string;
        suppression?: { reason: string };
      }>;
      expect(scheduled).toHaveLength(3);
      for (const item of scheduled) {
        expect(item.suppression, item.reminderKind).toBeUndefined();
      }
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

    it('an uncomposable tour time empties the BODIES, not the bucket (read-path containment)', async () => {
      // The rung text is composed from the tour time + the unit address, and a
      // tour can lose a usable scheduledAt. On a READ path that degrades to
      // body: '' (spec F1) - the thread's Upcoming list must still render every
      // rung with its kind and due time, never 500.
      const { app } = authedHarness(world, makeFakePoolNumbers());
      const { tour, conversationId } = await seedTourGroup(app, 'landlord_led');
      // Corrupt AFTER arming - the only way to reach this state.
      await world.toursRepo.patch(tour.tourId, { scheduledAt: 'not-an-instant' });

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);

      const scheduled = res.body.scheduled as Array<Record<string, unknown>>;
      expect(scheduled).toHaveLength(3);
      expect(scheduled.every((s) => s['body'] === '')).toBe(true);
      // Everything else about each rung survives.
      expect(scheduled.map((s) => s['reminderKind'])).toEqual([
        'day_before',
        'morning_of',
        'en_route',
      ]);
      expect(scheduled.every((s) => s['refId'] === tour.tourId)).toBe(true);
      expect(scheduled.every((s) => s['conversationId'] === conversationId)).toBe(true);
    });

    it('the en_route card NAMES the property contact on a landlord-led tour', async () => {
      // THE 6.3a DRIFT PIN. This is the one preview surface that serves ONLY
      // non-self_guided tours (relayGroups.ts's early return), i.e. the exact
      // place a dropped propertyContactFirstName silently flips the preview to
      // the SELF-GUIDED entry while the group SEND says the landlord-led one.
      // The composer degrades to the self-guided wording whenever that name is
      // absent, so a preview that forgot to resolve it would look plausible and
      // still be a lie.
      //
      // The name is seeded onto world.contacts rather than injected as a repo:
      // api.ts wires the relay router's contacts from `contactsRepoForRelay`
      // FIRST and only falls back to `contactsRepo`, and makeWebhookHarness sets
      // no `contactsRepoForRelay` - so world.contactsRepo IS the repo this route
      // reads, and seeding the world cannot address the wrong one.
      const { app } = authedHarness(world, makeFakePoolNumbers());
      world.units.set('unit-dana', {
        unitId: 'unit-dana',
        landlordId: 'c-landlord-dana',
        status: 'available',
        address: { line1: '77 Dana Way NW', city: 'Atlanta', state: 'GA', zip: '30318' },
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      });
      world.contacts.push({
        contactId: 'c-landlord-dana',
        type: 'landlord',
        phone: '+15550730001',
        firstName: 'Dana',
        lastName: 'Doyle',
        created_at: '2026-08-01T00:00:00.000Z',
      } as Parameters<typeof world.contacts.push>[0]);
      const { conversationId } = await seedTourGroup(app, 'landlord_led', 'unit-dana');

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);

      const scheduled = res.body.scheduled as Array<Record<string, unknown>>;
      const enRoute = scheduled.find((s) => s['reminderKind'] === 'en_route')!;
      expect(enRoute).toBeDefined();
      expect(enRoute['body']).toContain('Dana will be headed that way');
    });

    it('WITHHOLDS the en_route card body when the property-contact read throws, and only that one', async () => {
      // Spec 6.3a/6.3b on the group bucket. A failed property read would flip
      // WHICH ENTRY the en_route rung composes (landlord-led -> self-guided),
      // so this preview renders NO body rather than text the group SEND would
      // never produce. The other rungs never touch that read, so they compose
      // normally - blanking them would be a self-inflicted outage.
      //
      // The throw is installed by MUTATING world.contactsRepo.getById, which is
      // the object api.ts hands the relay router (makeWebhookHarness sets no
      // contactsRepoForRelay), so it cannot address the wrong repo. It is
      // installed AFTER seedTourGroup because group creation reads contacts.
      const { app } = authedHarness(world, makeFakePoolNumbers());
      world.units.set('unit-boom', {
        unitId: 'unit-boom',
        landlordId: 'c-landlord-boom',
        status: 'available',
        address: { line1: '13 Boom Way NW', city: 'Atlanta', state: 'GA', zip: '30318' },
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      });
      const { conversationId } = await seedTourGroup(app, 'landlord_led', 'unit-boom');
      const realGetById = world.contactsRepo.getById.bind(world.contactsRepo);
      world.contactsRepo.getById = async (contactId: string) => {
        if (contactId === 'c-landlord-boom') throw new Error('contacts unavailable');
        return realGetById(contactId);
      };

      const res = await request(app)
        .get(`/api/conversations/${conversationId}/scheduled`)
        .set('x-origin-verify', SECRET)
        .set('cookie', TEST_SESSION_COOKIE)
        .expect(200);

      const scheduled = res.body.scheduled as Array<Record<string, unknown>>;
      const byKind = Object.fromEntries(scheduled.map((s) => [s['reminderKind'] as string, s]));
      expect(byKind['en_route']!['body']).toBe('');
      expect(byKind['day_before']!['body']).not.toBe('');
      expect(byKind['morning_of']!['body']).not.toBe('');
      // The card itself survives - only the text is withheld.
      expect(scheduled).toHaveLength(3);
    });
  });
});
