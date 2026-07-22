// Queued fire-and-forget messages on a CONNECTING relay group (relay number
// buying strategy T7). A connecting group has no pool number yet (its dedicated
// number is still warming/registering), so a team compose CANNOT send. Instead
// it is PERSISTED as delivery_status 'queued_pending' and held; relay.numberReady
// (once the number registers) opens the group, enqueues the DEFERRED intro, then
// flushes the held messages - in created_at order, AFTER the intro - via the
// normal relay fan-out. A queued message must never be lost, and the intro must
// always land first.
//
// Two harnesses:
//   - the real express app (makeWebhookHarness) drives the compose intercept and
//     asserts the persisted state + that NOTHING is sent while connecting;
//   - a recording job queue (records envelopes WITHOUT dispatching) drives the
//     relay.numberReady handler and asserts the exact enqueue ORDER (intro first,
//     then a fan-out per queued message in creation order).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import {
  InMemorySchedulerAdapter,
  InProcessOutboundQueueAdapter,
  type OutboundQueueAdapter,
} from '../src/adapters/scheduler.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  configureScheduler,
  dispatchJob,
} from '../src/jobs/jobs.js';
import {
  RELAY_FANOUT_JOB,
  RELAY_INTRO_JOB,
  TEAM_SENDER_KEY,
  TEAM_SENDER_LABEL,
  registerRelayFanOutJobHandler,
} from '../src/jobs/relayFanOut.js';
import { registerRelayNumberReadyJobHandler } from '../src/jobs/relayNumberReady.js';
import { RELAY_NUMBER_READY_JOB, type PoolNumbersService } from '../src/services/poolNumbers.js';
import { createLogger } from '../src/lib/logger.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import { TEST_SESSION_COOKIE } from './helpers/authSession.js';
import { createLogCapture } from './helpers/logCapture.js';
import {
  createFakeWorld,
  makeWebhookHarness,
  ORIGIN_SECRET,
  type FakeWorld,
} from './helpers/twilioWebhookHarness.js';

const ALICE = '+15550100001';
const BOB = '+15550100002';
const READY_NUMBER = '+15550002222';
const logger = createLogger({ destination: createLogCapture().stream });

/** Records enqueued envelopes WITHOUT dispatching them (assert order + args). */
function makeRecordingQueue(): OutboundQueueAdapter & { envelopes: JobEnvelope[] } {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope) {
      envelopes.push(envelope);
    },
  };
}

/** A pool service that always allows the roster burn (G1 on the ready open). */
function makeReadyPool(): PoolNumbersService {
  return {
    async burnGroupRoster() {
      return true;
    },
  } as unknown as PoolNumbersService;
}

/** A fake pool for the express relay routes: hands out one deterministic number. */
function makeFakePoolNumbers(): PoolNumbersService {
  let counter = 0;
  return {
    async provisionForGroup() {
      counter += 1;
      const poolNumber = `+1555030${String(counter).padStart(4, '0')}`;
      return {
        kind: 'assigned',
        poolNumber,
        record: {
          poolNumber,
          lifecycle_state: 'active',
          quarantine_until: '0000-00-00T00:00:00.000Z',
          voice_capable: true,
          sms_capable: true,
          provisioned_at: new Date().toISOString(),
        },
        provisioned: true,
      };
    },
    async burnGroupRoster() {
      return true;
    },
    async noteGroupClosed() {},
    async burnMember() {
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
  } as unknown as PoolNumbersService;
}

async function composeTeam(app: import('express').Express, conversationId: string, body: string) {
  return request(app)
    .post(`/api/conversations/${conversationId}/messages`)
    .set('x-origin-verify', ORIGIN_SECRET)
    .set('cookie', TEST_SESSION_COOKIE)
    .send({ body });
}

describe('T7 - compose intercept on a CONNECTING relay group', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
    // In-process fan-out so an OPEN group REALLY sends and a CONNECTING group's
    // silence (no fan-out enqueued) shows up as an empty adapter outbox.
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

  it('composing on a connecting group PERSISTS queued_pending, sends nothing, returns 201 (not 409)', async () => {
    const { app } = makeWebhookHarness({ world, poolNumbersService: makeFakePoolNumbers() });
    // A connect-when-ready group: created with NO pool number -> connecting.
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [
        { phone: ALICE, contactId: 'c-alice', name: 'Alice' },
        { phone: BOB, contactId: 'c-bob', name: 'Bob' },
      ],
    });
    expect(connecting.status).toBe('connecting');

    const res = await composeTeam(app, connecting.conversationId, 'Showing is at 4pm');

    // Success, NOT a 409 relay_closed - the message is accepted + held.
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued_pending');
    expect(typeof res.body.tsMsgId).toBe('string');

    // Persisted ONCE as an outbound queued_pending team message.
    const rows = world.messages.filter((m) => m.conversationId === connecting.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery_status).toBe('queued_pending');
    expect(rows[0]!.direction).toBe('outbound');
    expect(rows[0]!.author).toBe('teammate');
    expect(rows[0]!.relay_sender_key).toBe(TEAM_SENDER_KEY);

    // NOTHING was sent - no adapter leg (the fan-out was never enqueued).
    expect(world.sent).toHaveLength(0);
  });

  it('a queued message on a group that NEVER opens stays queued_pending (not lost, not sent)', async () => {
    const { app } = makeWebhookHarness({ world, poolNumbersService: makeFakePoolNumbers() });
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [{ phone: ALICE, contactId: 'c-alice', name: 'Alice' }],
    });

    await composeTeam(app, connecting.conversationId, 'Still connecting...');
    // No relay.numberReady is ever fired - the message must simply wait.
    const rows = world.messages.filter((m) => m.conversationId === connecting.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.delivery_status).toBe('queued_pending');
    expect(world.sent).toHaveLength(0);
  });

  it('a normal OPEN group is unaffected - a compose sends immediately (as today)', async () => {
    const { app } = makeWebhookHarness({ world, poolNumbersService: makeFakePoolNumbers() });
    const created = await request(app)
      .post('/api/relay-groups')
      .set('x-origin-verify', ORIGIN_SECRET)
      .set('cookie', TEST_SESSION_COOKIE)
      .send({ members: [{ phone: ALICE, name: 'Alice' }, { phone: BOB, name: 'Bob' }] });
    const id = created.body.conversation.conversationId as string;
    const poolNumber = created.body.conversation.pool_number as string;
    world.sent.length = 0; // drop the intro sends - assert only the team send

    const res = await composeTeam(app, id, 'Open group send');
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued'); // the open path is unchanged
    // Fanned out to BOTH members immediately FROM the pool number.
    expect(world.sent.map((s) => s.to).sort()).toEqual([ALICE, BOB].sort());
    expect(world.sent.every((s) => s.from === poolNumber)).toBe(true);
    const row = world.messages.find((m) => m.conversationId === id && m.relay_sender_key === TEAM_SENDER_KEY);
    expect(row!.delivery_status).toBe('queued'); // never queued_pending on an open group
  });
});

describe('T7 - relay.numberReady flushes queued messages AFTER the intro, in creation order', () => {
  let world: FakeWorld;

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
    configureScheduler(new InMemorySchedulerAdapter());
    world = createFakeWorld();
  });
  afterEach(() => {
    _resetForTests();
  });

  it('intro is enqueued FIRST, then a fan-out per queued message in created_at ASC order', async () => {
    // Compose two messages on a connecting group through the real route (still an
    // in-process queue at this point; connecting composes enqueue NOTHING).
    configureOutboundQueue(new InProcessOutboundQueueAdapter({ dispatch: dispatchJob }));
    registerRelayFanOutJobHandler({
      adapter: world.adapter,
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      contactsRepo: world.contactsRepo,
      logger,
    });
    const { app } = makeWebhookHarness({ world, poolNumbersService: makeFakePoolNumbers() });
    const connecting = await world.conversationsRepo.createRelayGroup({
      members: [
        { phone: ALICE, contactId: 'c-alice', name: 'Alice' },
        { phone: BOB, contactId: 'c-bob', name: 'Bob' },
      ],
    });
    const first = await composeTeam(app, connecting.conversationId, 'First queued');
    const second = await composeTeam(app, connecting.conversationId, 'Second queued');
    const firstTs = first.body.tsMsgId as string;
    const secondTs = second.body.tsMsgId as string;
    expect(world.sent).toHaveLength(0); // nothing sent while connecting

    // Now swap to a RECORDING queue so we can assert the exact enqueue ORDER the
    // ready handler produces (recording does NOT dispatch, so nothing runs).
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    registerRelayNumberReadyJobHandler({
      poolNumbersService: makeReadyPool(),
      conversationsRepo: world.conversationsRepo,
      messagesRepo: world.messagesRepo,
      logger,
    });

    await dispatchJob({
      jobName: RELAY_NUMBER_READY_JOB,
      payload: { conversationId: connecting.conversationId, poolNumber: READY_NUMBER },
    });

    // The group opened on its dedicated number.
    const opened = await world.conversationsRepo.getById(connecting.conversationId);
    expect(opened!.status).toBe('open');
    expect(opened!.pool_number).toBe(READY_NUMBER);

    // Exactly three enqueues in order: the DEFERRED intro FIRST, then one fan-out
    // per queued message, in creation order (first-composed first).
    expect(queue.envelopes).toHaveLength(3);
    expect(queue.envelopes[0]!.jobName).toBe(RELAY_INTRO_JOB);
    expect((queue.envelopes[0]!.payload as { relayConversationId?: string }).relayConversationId).toBe(
      connecting.conversationId,
    );
    expect(queue.envelopes[1]!.jobName).toBe(RELAY_FANOUT_JOB);
    expect(queue.envelopes[2]!.jobName).toBe(RELAY_FANOUT_JOB);
    const fanoutSources = queue.envelopes
      .slice(1)
      .map((e) => (e.payload as { sourceTsMsgId?: string }).sourceTsMsgId);
    expect(fanoutSources).toEqual([firstTs, secondTs]);
    // Each fan-out carries the neutral TEAM sender identity (never a member).
    for (const e of queue.envelopes.slice(1)) {
      const p = e.payload as { senderKey?: string; senderNameOverride?: string };
      expect(p.senderKey).toBe(TEAM_SENDER_KEY);
      expect(p.senderNameOverride).toBe(TEAM_SENDER_LABEL);
    }

    // The two source messages were transitioned into the send path (queued_pending
    // -> queued) so the fan-out delivers them as normal relay sends.
    const rows = world.messages.filter((m) => m.conversationId === connecting.conversationId);
    expect(rows.every((m) => m.delivery_status === 'queued')).toBe(true);
    expect(rows.some((m) => m.delivery_status === 'queued_pending')).toBe(false);
  });
});
