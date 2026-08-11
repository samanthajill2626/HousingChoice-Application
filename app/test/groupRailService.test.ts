// T6.1 - ensureGroupRail, THE ONE authoritative rail path.
//
// Every consumer (the detection job, the migration bulk runner, the send-time
// backstop) routes through this service; nothing calls the Conversations
// adapter's create directly. What is proven here is the claim/fence protocol,
// because that is what makes "three callers, one rail" true:
//
//   - a conditional `rail_creating` claim carrying an OWNER TOKEN is taken
//     BEFORE any Twilio call, so a concurrent second caller cannot double-create;
//   - a claim older than the expiry window is RE-CLAIMABLE, so a crashed
//     claimant can never strand a thread rail-less against the hardened cutover
//     gate;
//   - the finalize is CONDITIONAL on still owning that claim, so an expired
//     claimant waking up late cannot overwrite the new claimant's rail;
//   - a crash between the Twilio create and the local persist is healed by
//     fetch-by-UniqueName adopt-or-create, because UniqueName is our own
//     conversationId and is therefore deterministic.
import { describe, it, expect, vi } from 'vitest';
import type {
  ConversationItem,
  ConversationParticipant,
} from '../src/repos/conversationsRepo.js';
import type {
  CreateGroupConversationInput,
  GroupConversationRef,
  GroupConversationsPort,
  GroupParticipantRef,
} from '../src/adapters/groupConversations.js';
import { GroupConversationsUnavailableError } from '../src/adapters/groupConversations.js';
import {
  createGroupRailService,
  RAIL_CLAIM_EXPIRY_MS,
  type GroupRailServiceDeps,
} from '../src/services/groupRail.js';

const CONV = 'convGroup:abc';
const MEMBERS: ConversationParticipant[] = [
  { contactId: 'c1', phone: '+15551110001' },
  { contactId: 'c2', phone: '+15551110002' },
];

function threadRow(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: CONV,
    type: 'group_text',
    status: 'group_open',
    participants: MEMBERS,
    last_activity_at: '2026-08-11T00:00:00.000Z',
    ...over,
  } as ConversationItem;
}

/** A repo fake that models the two conditional writes for real. */
function makeRepo(initial: ConversationItem = threadRow()) {
  const row: { current: ConversationItem | undefined } = { current: { ...initial } };
  const calls = { claims: 0, finalizes: 0, failures: 0 };
  const repo = {
    async getById(id: string) {
      return row.current !== undefined && row.current.conversationId === id
        ? { ...row.current }
        : undefined;
    },
    async claimRailCreation(id: string, claim: { token: string; at: string }, expiredBefore: string) {
      calls.claims += 1;
      const item = row.current;
      if (!item || item.conversationId !== id) return { claimed: false };
      const held = item.rail_creating;
      const free = held === undefined || held.at <= expiredBefore;
      if (!free) return { claimed: false, item: { ...item } };
      row.current = { ...item, rail_creating: { ...claim } };
      return { claimed: true, item: { ...row.current } };
    },
    async setTwilioConversation(
      id: string,
      sid: string,
      map: Record<string, string>,
      token: string,
    ) {
      calls.finalizes += 1;
      const item = row.current;
      if (!item || item.conversationId !== id) return undefined;
      if (item.rail_creating?.token !== token) return undefined;
      const next = { ...item, twilio_conversation_sid: sid, twilio_participant_map: map };
      delete next.rail_creating;
      row.current = next;
      return { ...next };
    },
    async recordRailFailure(id: string, reason: string, at: string, token: string) {
      calls.failures += 1;
      const item = row.current;
      if (!item || item.conversationId !== id) return;
      if (item.rail_creating?.token !== token) return;
      const next = { ...item, rail_failed: { at, reason } };
      delete next.rail_creating;
      row.current = next;
    },
  };
  return { repo, row, calls };
}

function participantsFor(members: ConversationParticipant[]): GroupParticipantRef[] {
  return members.map((m, i) => ({
    participantSid: `MB${i}`,
    address: m.phone,
    projectedAddress: '+15550000000',
  }));
}

function makePort(over: Partial<GroupConversationsPort> = {}) {
  const created: CreateGroupConversationInput[] = [];
  const port: GroupConversationsPort = {
    async createConversationWithParticipants(input) {
      created.push(input);
      return {
        conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
        participants: participantsFor(MEMBERS),
        failures: [],
      };
    },
    async fetchByUniqueName() {
      return undefined;
    },
    async postGroupMessage() {
      throw new Error('not used');
    },
    async fetchParticipants() {
      return participantsFor(MEMBERS);
    },
    async addParticipants() {
      throw new Error('addParticipants: override it in the test that needs it');
    },
    ...over,
  };
  return { port, created };
}

function svc(repo: unknown, port: GroupConversationsPort, over: Partial<GroupRailServiceDeps> = {}) {
  return createGroupRailService({
    conversationsRepo: repo as GroupRailServiceDeps['conversationsRepo'],
    groupConversations: port,
    businessNumber: '+15550000000',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    ...over,
  });
}

describe('ensureGroupRail', () => {
  it('creates the rail under a UniqueName and finalizes with the MB map', async () => {
    const { repo, row, calls } = makeRepo();
    const { port, created } = makePort();
    const rail = svc(repo, port);

    const result = await rail.ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('created');
    expect(result.twilioConversationSid).toBe('CH1');
    expect(result.participantMap).toEqual({ MB0: 'phone#+15551110001', MB1: 'phone#+15551110002' });
    // The UniqueName is our conversationId - deterministic, non-PII, and the
    // whole basis of adopt-or-create recovery.
    expect(created[0]?.uniqueName).toBe(CONV);
    expect(calls.claims).toBe(1);
    expect(row.current?.twilio_conversation_sid).toBe('CH1');
    // The claim is cleared by the finalize.
    expect(row.current?.rail_creating).toBeUndefined();
  });

  it('returns existing without a Twilio call when a verified rail is attached', async () => {
    const { repo, calls } = makeRepo(
      threadRow({
        twilio_conversation_sid: 'CHold',
        twilio_participant_map: { MB0: 'phone#+15551110001', MB1: 'phone#+15551110002' },
      }),
    );
    const { port, created } = makePort();
    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('existing');
    expect(result.twilioConversationSid).toBe('CHold');
    expect(created).toHaveLength(0);
    expect(calls.claims).toBe(0);
  });

  it('CONCURRENT DOUBLE-CREATE: the claim loser never creates a second rail', async () => {
    const { repo, calls } = makeRepo();
    const { port, created } = makePort();
    const rail = svc(repo, port);

    const [a, b] = await Promise.all([
      rail.ensureGroupRail({ conversationId: CONV, members: MEMBERS }),
      rail.ensureGroupRail({ conversationId: CONV, members: MEMBERS }),
    ]);

    // Exactly one Twilio create, and the loser reports a real, non-created status.
    expect(created).toHaveLength(1);
    expect(calls.finalizes).toBe(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['created', 'failed']);
  });

  it('CRASH-RETRY RECOVERY: adopts the conversation the crashed attempt already made', async () => {
    const { repo } = makeRepo();
    const adopted: GroupConversationRef = {
      conversationSid: 'CHadopted',
      uniqueName: CONV,
      state: 'active',
    };
    const { port, created } = makePort({
      async fetchByUniqueName(uniqueName: string) {
        return uniqueName === CONV ? adopted : undefined;
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(created).toHaveLength(0);
    expect(result.status).toBe('created');
    expect(result.twilioConversationSid).toBe('CHadopted');
  });

  it('EXPIRED CLAIM: a stale claim is re-claimable and the late claimant is FENCED OUT', async () => {
    const stale = new Date(Date.now() - RAIL_CLAIM_EXPIRY_MS - 60_000).toISOString();
    const { repo, row } = makeRepo(
      threadRow({ rail_creating: { token: 'dead-claimant', at: stale } }),
    );
    const { port } = makePort();

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });
    expect(result.status).toBe('created');
    expect(row.current?.twilio_conversation_sid).toBe('CH1');

    // The dead claimant wakes up and tries to finalize its own orphan rail.
    const late = await repo.setTwilioConversation(CONV, 'CHorphan', {}, 'dead-claimant');
    expect(late).toBeUndefined();
    expect(row.current?.twilio_conversation_sid).toBe('CH1');
  });

  it('CLOSED RAIL: a closed/failed conversation is recorded rail-failed, never finalized', async () => {
    const { repo, row, calls } = makeRepo();
    const { port } = makePort({
      async createConversationWithParticipants(input) {
        return {
          conversation: { conversationSid: 'CHdead', uniqueName: input.uniqueName, state: 'closed' },
          participants: [],
          failures: [],
        };
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/closed/i);
    expect(calls.finalizes).toBe(0);
    expect(row.current?.twilio_conversation_sid).toBeUndefined();
    expect(row.current?.rail_failed?.reason).toMatch(/closed/i);
    // The claim is released so the next run can retry immediately.
    expect(row.current?.rail_creating).toBeUndefined();
  });

  it('MB-MAP MISMATCH: a roster the rail STILL cannot cover fails instead of enabling compose', async () => {
    const { repo, row } = makeRepo();
    const partial = [{ participantSid: 'MB0', address: MEMBERS[0]!.phone }];
    const { port } = makePort({
      async createConversationWithParticipants(input) {
        return {
          conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
          // Only ONE of the two members actually attached.
          participants: partial,
          failures: [{ address: MEMBERS[1]!.phone, message: 'landline', errorCode: '50407' }],
        };
      },
      // The repair is attempted and Twilio refuses again - a landline is a
      // PERMANENT refusal, so this thread really is rail-failed.
      async addParticipants(_sid, addresses) {
        return addresses.map((address) => ({ address, message: 'landline', errorCode: '50407' }));
      },
      async fetchParticipants() {
        return partial;
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('+15551110002');
    expect(row.current?.twilio_conversation_sid).toBeUndefined();
    expect(row.current?.rail_failed).toBeDefined();
  });

  // THE DEFECT THIS PINS (fix wave 4, C5). The individual-add fallback can
  // attach 8 of 9 when one add throws a 429 or a 5xx, and the port had NO
  // add-participant operation - so every retry adopted the same Conversation by
  // UniqueName, re-read the same incomplete list and recorded `rail_failed`
  // again, permanently. Spec 14 makes "zero UNRESOLVED rail failures" a hard
  // cutover gate over 132 real threads, and the operator's only remedy was to
  // delete the Conversation in the Twilio console.
  it('REPAIRS a partially-attached rail on the next run instead of re-failing forever', async () => {
    const { repo, row } = makeRepo();
    // The rail exists (a throttled add left it short of one member) and the
    // adopt half finds it.
    let attached: GroupParticipantRef[] = [
      { participantSid: 'MBbiz', projectedAddress: '+15550000000' },
      { participantSid: 'MB0', address: MEMBERS[0]!.phone },
    ];
    const repairs: string[][] = [];
    const { port, created } = makePort({
      async fetchByUniqueName(uniqueName) {
        return { conversationSid: 'CH1', uniqueName, state: 'active' };
      },
      async addParticipants(_sid, addresses) {
        repairs.push([...addresses]);
        attached = [
          ...attached,
          ...addresses.map((address, i) => ({ participantSid: `MBrepair${i}`, address })),
        ];
        return [];
      },
      async fetchParticipants() {
        return attached;
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    // Exactly the member the rail was short, and nothing else.
    expect(repairs).toEqual([[MEMBERS[1]!.phone]]);
    // No second Conversation was minted to work around the incomplete one.
    expect(created).toEqual([]);
    expect(result.status).toBe('created');
    expect(result.participantMap).toMatchObject({
      MB0: 'phone#+15551110001',
      MBrepair0: 'phone#+15551110002',
    });
    expect(row.current?.twilio_conversation_sid).toBe('CH1');
    expect(row.current?.rail_failed).toBeUndefined();
    expect(row.current?.rail_creating).toBeUndefined();
  });

  it('RECREATION RACE: losing the fenced finalize adopts the winner rail, never overwrites it', async () => {
    const { repo, row } = makeRepo();
    const { port } = makePort({
      async createConversationWithParticipants(input) {
        // Another claimant finalized while we were talking to Twilio.
        row.current = {
          ...(row.current as ConversationItem),
          twilio_conversation_sid: 'CHwinner',
          twilio_participant_map: { MBw: 'phone#+15551110001' },
          rail_creating: { token: 'someone-else', at: new Date().toISOString() },
        };
        return {
          conversation: { conversationSid: 'CHloser', uniqueName: input.uniqueName, state: 'active' },
          participants: participantsFor(MEMBERS),
          failures: [],
        };
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('existing');
    expect(result.twilioConversationSid).toBe('CHwinner');
    expect(row.current?.twilio_conversation_sid).toBe('CHwinner');
  });

  it('refuses a roster larger than a rail can hold, before any Twilio call', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      contactId: `c${i}`,
      phone: `+1555111000${i}`,
    }));
    const { repo, calls } = makeRepo(threadRow({ participants: many }));
    const { port, created } = makePort();

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: many });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/9/);
    expect(created).toHaveLength(0);
    expect(calls.claims).toBe(0);
  });

  it('an adapter outage is a rail-less FAILURE that releases its claim, never a throw', async () => {
    const { repo, row } = makeRepo();
    const { port } = makePort({
      async createConversationWithParticipants() {
        throw new GroupConversationsUnavailableError('group rail creation is unavailable');
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('failed');
    expect(row.current?.twilio_conversation_sid).toBeUndefined();
    expect(row.current?.rail_creating).toBeUndefined();
  });

  it('a missing thread fails rather than minting a rail for nothing', async () => {
    const { repo } = makeRepo();
    repo.getById = async () => undefined;
    const { port, created } = makePort();
    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });
    expect(result.status).toBe('failed');
    expect(created).toHaveLength(0);
  });
});
