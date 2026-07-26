// provisionRelayGroup branch behavior (relay number buying strategy T6): the
// shared provisioning primitive switches on the three-tier ProvisionResult -
//   - `assigned`  -> today's OPEN group + intro enqueue (unchanged).
//   - `needs_connecting` -> a CONNECTING group (no pool number) + a relay.warmNumber
//     job TAGGED with the conversationId, and the intro is DEFERRED (not enqueued).
// Focused unit test: minimal in-memory fakes + a recording job queue (records
// enqueued envelopes without dispatching), so we assert exactly which jobs fire.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus } from '../src/lib/events.js';
import { createLogger } from '../src/lib/logger.js';
import {
  _resetForTests,
  configureJobsLogger,
  configureOutboundQueue,
  dispatchJob,
} from '../src/jobs/jobs.js';
import { RELAY_FANOUT_JOB, RELAY_INTRO_JOB } from '../src/jobs/relayFanOut.js';
import {
  RELAY_NUMBER_READY_JOB,
  RELAY_WARM_JOB,
  type PoolNumbersService,
  type ProvisionResult,
} from '../src/services/poolNumbers.js';
import { registerRelayNumberReadyJobHandler } from '../src/jobs/relayNumberReady.js';
import { provisionRelayGroup } from '../src/services/relayProvisioning.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
import type { MessagesRepo } from '../src/repos/messagesRepo.js';
import type { AuditRepo } from '../src/repos/auditRepo.js';
import type { OutboundQueueAdapter } from '../src/adapters/scheduler.js';
import type { JobEnvelope } from '../src/jobs/types.js';
import { createLogCapture } from './helpers/logCapture.js';

const logger = createLogger({ destination: createLogCapture().stream });
const T1 = '+15551110001';
const L1 = '+15551110002';

/** Records enqueued envelopes without dispatching (assert intro vs warm). */
function makeRecordingQueue(): OutboundQueueAdapter & { envelopes: JobEnvelope[] } {
  const envelopes: JobEnvelope[] = [];
  return {
    envelopes,
    async enqueue(envelope: JobEnvelope) {
      envelopes.push(envelope);
    },
  };
}

/** Minimal conversationsRepo: records createRelayGroup inputs, returns a stub item. */
function makeConversationsRepo(): {
  repo: ConversationsRepo;
  createCalls: { poolNumber?: string; members: ConversationParticipant[] }[];
} {
  const createCalls: { poolNumber?: string; members: ConversationParticipant[] }[] = [];
  let counter = 0;
  const repo = {
    async createRelayGroup(input: {
      poolNumber?: string;
      members: ConversationParticipant[];
    }): Promise<ConversationItem> {
      createCalls.push({ poolNumber: input.poolNumber, members: input.members });
      counter += 1;
      const connecting = input.poolNumber === undefined;
      const now = new Date().toISOString();
      return {
        conversationId: `conv-${counter}`,
        ...(input.poolNumber !== undefined && {
          participant_phone: input.poolNumber,
          pool_number: input.poolNumber,
        }),
        status: connecting ? 'connecting' : 'open',
        relay_status: `relay_group#${connecting ? 'connecting' : 'open'}`,
        last_activity_at: now,
        type: 'relay_group',
        ai_mode: 'manual',
        participants: input.members,
        created_at: now,
      };
    },
  };
  return { repo: repo as unknown as ConversationsRepo, createCalls };
}

/** A pool service whose provisionForGroup returns a fixed ProvisionResult. */
function makePool(result: ProvisionResult): PoolNumbersService {
  return {
    async provisionForGroup() {
      return result;
    },
  } as unknown as PoolNumbersService;
}

function makeAudit(): {
  repo: AuditRepo;
  calls: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[];
} {
  const calls: { entityKey: string; eventType: string; payload?: Record<string, unknown> }[] = [];
  const repo = {
    async append(entityKey: string, eventType: string, payload?: Record<string, unknown>) {
      calls.push({ entityKey, eventType, ...(payload !== undefined && { payload }) });
    },
  };
  return { repo: repo as unknown as AuditRepo, calls };
}

const FAKE_RECORD: PoolNumberItem = {
  poolNumber: '+15550001111',
  lifecycle_state: 'active',
  quarantine_until: '0000-00-00T00:00:00.000Z',
  voice_capable: true,
  sms_capable: true,
  provisioned_at: new Date().toISOString(),
};

describe('provisionRelayGroup - three-tier result branching (T6)', () => {
  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
  });
  afterEach(() => {
    _resetForTests();
  });

  it('assigned -> OPEN group with the pool number, intro enqueued, conversation.updated emitted', async () => {
    const { repo, createCalls } = makeConversationsRepo();
    const pool = makePool({
      kind: 'assigned',
      poolNumber: '+15550001111',
      record: FAKE_RECORD,
      provisioned: false,
    });
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    const events = createEventBus();
    const emitted: unknown[] = [];
    events.on('conversation.updated', (p) => emitted.push(p));
    const audit = makeAudit();

    const conv = await provisionRelayGroup(
      { conversationsRepo: repo, poolNumbersService: pool, auditRepo: audit.repo, events, logger },
      {
        members: [
          { phone: T1, contactId: 'c1' },
          { phone: L1, contactId: 'c2' },
        ],
      },
    );

    expect(conv.status).toBe('open');
    expect(createCalls[0]!.poolNumber).toBe('+15550001111'); // created WITH the number
    // Intro enqueued; NO warm job on the assigned path.
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB)).toHaveLength(1);
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB)).toHaveLength(0);
    expect(emitted).toHaveLength(1);
    expect(audit.calls.some((c) => c.eventType === 'relay_group_created')).toBe(true);
  });

  it('needs_connecting -> CONNECTING group (no pool number), relay.warmNumber enqueued tagged with the conversationId, NO intro', async () => {
    const { repo, createCalls } = makeConversationsRepo();
    const pool = makePool({ kind: 'needs_connecting' });
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    const events = createEventBus();
    const emitted: unknown[] = [];
    events.on('conversation.updated', (p) => emitted.push(p));
    const audit = makeAudit();

    const conv = await provisionRelayGroup(
      { conversationsRepo: repo, poolNumbersService: pool, auditRepo: audit.repo, events, logger },
      { members: [{ phone: T1, contactId: 'c1' }] },
    );

    // Connecting group, created with NO pool number.
    expect(conv.status).toBe('connecting');
    expect(conv.pool_number).toBeUndefined();
    expect(createCalls[0]!.poolNumber).toBeUndefined();
    // A relay.warmNumber job TAGGED with this conversation (D6 routing tag).
    const warm = queue.envelopes.filter((e) => e.jobName === RELAY_WARM_JOB);
    expect(warm).toHaveLength(1);
    expect((warm[0]!.payload as { conversationId?: string }).conversationId).toBe(
      conv.conversationId,
    );
    // Intro is DEFERRED to relay.numberReady - none enqueued here.
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB)).toHaveLength(0);
    // The new connecting group is surfaced live (dashboard renders + queues on it).
    expect(emitted).toHaveLength(1);
    // The create is audited with the connecting marker + the roster is recorded.
    expect(
      audit.calls.some(
        (c) => c.eventType === 'relay_group_created' && c.payload?.['connecting'] === true,
      ),
    ).toBe(true);
    expect(createCalls[0]!.members).toHaveLength(1); // roster available at assign time
  });

  it('needs_connecting still returns the created group even if the warm enqueue fails (best-effort)', async () => {
    const { repo } = makeConversationsRepo();
    const pool = makePool({ kind: 'needs_connecting' });
    // A queue that rejects the warm enqueue: the group must still be returned
    // (the stuck-connecting alert reconciles a missing warm job later).
    const events = createEventBus();
    const audit = makeAudit();
    configureOutboundQueue({
      async enqueue() {
        throw new Error('queue down');
      },
    });

    const conv = await provisionRelayGroup(
      { conversationsRepo: repo, poolNumbersService: pool, auditRepo: audit.repo, events, logger },
      { members: [{ phone: T1, contactId: 'c1' }] },
    );

    expect(conv.status).toBe('connecting'); // group created despite the enqueue failure
  });
});

/** A store-backed connecting-group repo: getById + the conditional assign flip. */
function makeConnectingRepo(group: ConversationItem): {
  repo: ConversationsRepo;
  store: Map<string, ConversationItem>;
} {
  const store = new Map<string, ConversationItem>([[group.conversationId, group]]);
  const repo = {
    async getById(id: string) {
      return store.get(id);
    },
    async assignPoolNumberAndOpen(id: string, poolNumber: string) {
      const c = store.get(id);
      // Atomic-faithful: only a still-connecting group flips (G3). A redelivery
      // (already open) returns undefined.
      if (!c || c.status !== 'connecting' || c.relay_status !== 'relay_group#connecting') {
        return undefined;
      }
      c.pool_number = poolNumber;
      c.participant_phone = poolNumber;
      c.status = 'open';
      c.relay_status = 'relay_group#open';
      return c;
    },
  };
  return { repo: repo as unknown as ConversationsRepo, store };
}

/** A pool service that records burnGroupRoster calls (G1 assertion). */
function makeReadyPool(opts: { burnResult?: boolean } = {}): PoolNumbersService & {
  burns: { poolNumber: string; phones: string[] }[];
} {
  const burns: { poolNumber: string; phones: string[] }[] = [];
  return {
    burns,
    async burnGroupRoster(poolNumber: string, phones: string[]) {
      burns.push({ poolNumber, phones });
      return opts.burnResult ?? true;
    },
    async clearConnectingEarmarks() {},
  } as unknown as PoolNumbersService & { burns: { poolNumber: string; phones: string[] }[] };
}

/**
 * A no-message messagesRepo for the ready-handler tests: flushQueuedMessages (T7)
 * runs after the intro, so the handler needs a messagesRepo. These groups carry no
 * queued_pending composes, so listByConversation returns [] and the flush enqueues
 * nothing (the intro-only assertions below stay exact).
 */
function makeEmptyMessagesRepo(): MessagesRepo {
  return {
    async listByConversation() {
      return [];
    },
    async updateDeliveryStatus() {
      return false;
    },
  } as unknown as MessagesRepo;
}

function connectingGroup(conversationId: string, phones: string[]): ConversationItem {
  const now = new Date().toISOString();
  return {
    conversationId,
    status: 'connecting',
    relay_status: 'relay_group#connecting',
    last_activity_at: now,
    type: 'relay_group',
    ai_mode: 'manual',
    participants: phones.map((phone, i) => ({ phone, contactId: `c${i}` })),
    created_at: now,
  };
}

describe('relay.numberReady handler (T6 - connect-when-ready open)', () => {
  const NEW_NUMBER = '+15550002222';

  beforeEach(() => {
    _resetForTests();
    configureJobsLogger(logger);
  });
  afterEach(() => {
    _resetForTests();
  });

  it('burns the roster onto the number (G1), flips the group connecting -> open with pool_number set, and enqueues the intro', async () => {
    const { repo, store } = makeConnectingRepo(connectingGroup('conv-ready', [T1, L1]));
    const pool = makeReadyPool();
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    registerRelayNumberReadyJobHandler({
      poolNumbersService: pool,
      conversationsRepo: repo,
      messagesRepo: makeEmptyMessagesRepo(),
      logger,
    });

    await dispatchJob({
      jobName: RELAY_NUMBER_READY_JOB,
      payload: { conversationId: 'conv-ready', poolNumber: NEW_NUMBER },
    });

    // G1: the WHOLE roster was burned onto the new number.
    expect(pool.burns).toHaveLength(1);
    expect(pool.burns[0]!.poolNumber).toBe(NEW_NUMBER);
    expect(pool.burns[0]!.phones.sort()).toEqual([T1, L1].sort());
    // Group opened on its dedicated number.
    const opened = store.get('conv-ready')!;
    expect(opened.status).toBe('open');
    expect(opened.pool_number).toBe(NEW_NUMBER);
    // The DEFERRED intro fired, tagged with this conversation.
    const intro = queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB);
    expect(intro).toHaveLength(1);
    expect((intro[0]!.payload as { relayConversationId?: string }).relayConversationId).toBe(
      'conv-ready',
    );
  });

  it('a SECOND relay.numberReady is a no-op (G3 exactly-once): no re-burn, no second intro', async () => {
    const { repo, store } = makeConnectingRepo(connectingGroup('conv-dup', [T1]));
    const pool = makeReadyPool();
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    registerRelayNumberReadyJobHandler({
      poolNumbersService: pool,
      conversationsRepo: repo,
      messagesRepo: makeEmptyMessagesRepo(),
      logger,
    });

    const payload = { conversationId: 'conv-dup', poolNumber: NEW_NUMBER };
    await dispatchJob({ jobName: RELAY_NUMBER_READY_JOB, payload });
    // Redelivery: the group is already open -> the read-check no-ops it.
    await dispatchJob({ jobName: RELAY_NUMBER_READY_JOB, payload });

    expect(store.get('conv-dup')!.status).toBe('open');
    expect(pool.burns).toHaveLength(1); // burned exactly once (G1 + G3)
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB)).toHaveLength(1); // intro once
  });

  it('an unknown / already-open conversation is an idempotent no-op (no burn, no intro)', async () => {
    // The group is already OPEN (not connecting) - the read-check must short-circuit.
    const openGroup: ConversationItem = {
      ...connectingGroup('conv-open', [T1]),
      status: 'open',
      relay_status: 'relay_group#open',
      pool_number: '+15550009999',
    };
    const { repo } = makeConnectingRepo(openGroup);
    const pool = makeReadyPool();
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);
    registerRelayNumberReadyJobHandler({
      poolNumbersService: pool,
      conversationsRepo: repo,
      messagesRepo: makeEmptyMessagesRepo(),
      logger,
    });

    await dispatchJob({
      jobName: RELAY_NUMBER_READY_JOB,
      payload: { conversationId: 'conv-open', poolNumber: NEW_NUMBER },
    });
    // Also an entirely unknown conversation.
    await dispatchJob({
      jobName: RELAY_NUMBER_READY_JOB,
      payload: { conversationId: 'conv-ghost', poolNumber: NEW_NUMBER },
    });

    expect(pool.burns).toHaveLength(0); // never burned onto an already-open / unknown group
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB)).toHaveLength(0);
  });

  it('a redelivery on an ALREADY-OPEN group re-enters the flush (leftover queued_pending released) without re-intro or re-burn', async () => {
    // Crash-mid-flush recovery: a prior run opened the group + flushed the intro
    // and SOME queued messages, then crashed before finishing. On redelivery the
    // group is already OPEN, so the read-check no-ops the burn + intro - but the
    // handler must STILL re-enter flushQueuedMessages so the remaining
    // queued_pending messages are not lost forever (the module's contract).
    const openGroup: ConversationItem = {
      ...connectingGroup('conv-crash', [T1, L1]),
      status: 'open',
      relay_status: 'relay_group#open',
      pool_number: NEW_NUMBER,
    };
    const { repo } = makeConnectingRepo(openGroup);
    const pool = makeReadyPool();
    const queue = makeRecordingQueue();
    configureOutboundQueue(queue);

    // One leftover queued_pending message the prior crashed run never released.
    const flipped: string[] = [];
    const messagesRepo = {
      async listByConversation() {
        return [
          {
            provider_sid: 'sid-1',
            tsMsgId: 'ts-1',
            created_at: '2026-07-21T00:00:00.000Z',
            direction: 'outbound',
            delivery_status: 'queued_pending',
          },
        ];
      },
      async updateDeliveryStatus(sid: string) {
        flipped.push(sid);
        return true;
      },
    } as unknown as MessagesRepo;
    registerRelayNumberReadyJobHandler({
      poolNumbersService: pool,
      conversationsRepo: repo,
      messagesRepo,
      logger,
    });

    await dispatchJob({
      jobName: RELAY_NUMBER_READY_JOB,
      payload: { conversationId: 'conv-crash', poolNumber: NEW_NUMBER },
    });

    // The leftover queued message was released into the fan-out (not lost).
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_FANOUT_JOB)).toHaveLength(1);
    expect(flipped).toEqual(['sid-1']);
    // One-shot on this branch: no re-burn and no re-intro.
    expect(pool.burns).toHaveLength(0);
    expect(queue.envelopes.filter((e) => e.jobName === RELAY_INTRO_JOB)).toHaveLength(0);
  });
});
