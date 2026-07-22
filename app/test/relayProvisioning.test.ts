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
} from '../src/jobs/jobs.js';
import { RELAY_INTRO_JOB } from '../src/jobs/relayFanOut.js';
import {
  RELAY_WARM_JOB,
  type PoolNumbersService,
  type ProvisionResult,
} from '../src/services/poolNumbers.js';
import { provisionRelayGroup } from '../src/services/relayProvisioning.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import type { PoolNumberItem } from '../src/repos/poolNumbersRepo.js';
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
