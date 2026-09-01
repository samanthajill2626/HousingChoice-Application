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
  GroupParticipantFailure,
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
      projectedAddress: string,
    ) {
      calls.finalizes += 1;
      const item = row.current;
      if (!item || item.conversationId !== id) return undefined;
      if (item.rail_creating?.token !== token) return undefined;
      const next = {
        ...item,
        twilio_conversation_sid: sid,
        twilio_participant_map: map,
        twilio_projected_address: projectedAddress,
      };
      delete next.rail_creating;
      delete next.rail_failed;
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

const BUSINESS = '+15550000000';

/**
 * The FAITHFUL rail shape: the business number is its OWN projected-address
 * participant, and each member is an address-only participant. (An earlier
 * version of this helper put a projected address on every member - a shape
 * Twilio refuses with 50407 - which is how a fixture can hide the very
 * participant the rail cannot post without.)
 */
function participantsFor(
  members: ConversationParticipant[],
  // `null` = NO projected participant at all (the 132). Not `undefined`, which
  // would select the default.
  projected: string | null = BUSINESS,
): GroupParticipantRef[] {
  return [
    ...(projected !== null ? [{ participantSid: 'MBbiz', projectedAddress: projected }] : []),
    ...members.map((m, i) => ({ participantSid: `MB${i}`, address: m.phone })),
  ];
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
    // THROWS BY DEFAULT ON PURPOSE - this is the negative control for the
    // closed-rail heal. Deleting a rail is destructive, so every test that does
    // NOT expect one fails loudly if the service ever reaches for it (an ACTIVE
    // adoptee, in particular, must never be deleted).
    async removeConversation() {
      throw new Error('removeConversation: override it in the test that needs it');
    },
    // Same negative-control posture: a test that expects NO author repair fails
    // loudly if the service reaches for one.
    async addProjectedParticipant() {
      throw new Error('addProjectedParticipant: override it in the test that needs it');
    },
    async removeParticipant() {
      throw new Error('removeParticipant: override it in the test that needs it');
    },
    ...over,
  };
  return { port, created };
}

function svc(repo: unknown, port: GroupConversationsPort, over: Partial<GroupRailServiceDeps> = {}) {
  return createGroupRailService({
    conversationsRepo: repo as GroupRailServiceDeps['conversationsRepo'],
    groupConversations: port,
    businessNumber: BUSINESS,
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
        twilio_projected_address: BUSINESS,
      }),
    );
    const { port, created } = makePort();
    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('existing');
    expect(result.twilioConversationSid).toBe('CHold');
    expect(created).toHaveLength(0);
    expect(calls.claims).toBe(0);
  });

  // THE DEFECT THESE PIN (prod incident 2026-08-17). `ensureGroupRail` proved a
  // stored rail COVERED THE ROSTER and never that it could be POSTED TO: the
  // business number's projected-address participant was dropped from the stored
  // map by design, `created.failures` was never read, and the fast path trusted
  // any stamped sid. So 132 imported rails whose business add had been refused,
  // and 3 rails built for the pre-port number, all read as healthy - and every
  // staff reply to them failed with Twilio 50513, forever, while inbound kept
  // flowing through the SMS webhook. A rail is verified for ONE author, and that
  // author is now stored and compared against the current business number.
  describe('AUTHOR VERIFICATION - a rail is only "existing" for the business number it carries', () => {
    const STORED_MAP = { MB0: 'phone#+15551110001', MB1: 'phone#+15551110002' };

    it('a stored rail with NO verified author is re-read from Twilio, REPAIRED and re-finalized', async () => {
      // The 132: sid + full map, no business participant, nothing recorded.
      const { repo, row, calls } = makeRepo(
        threadRow({ twilio_conversation_sid: 'CHold', twilio_participant_map: STORED_MAP }),
      );
      const attached: string[] = [];
      let participants = participantsFor(MEMBERS, null);
      const { port, created } = makePort({
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CHold', uniqueName, state: 'active' };
        },
        async fetchParticipants() {
          return participants;
        },
        async addProjectedParticipant(_sid, businessNumber) {
          attached.push(businessNumber);
          const ref = { participantSid: 'MBbizNew', projectedAddress: businessNumber };
          participants = [...participants, ref];
          return ref;
        },
      });

      const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

      expect(attached).toEqual([BUSINESS]);
      // Same rail, same members - no second Conversation, no member churn.
      expect(created).toEqual([]);
      expect(result.status).toBe('created');
      expect(result.twilioConversationSid).toBe('CHold');
      expect(result.participantMap).toEqual(STORED_MAP);
      expect(calls.finalizes).toBe(1);
      expect(row.current?.twilio_projected_address).toBe(BUSINESS);
      expect(row.current?.rail_failed).toBeUndefined();
      expect(row.current?.rail_creating).toBeUndefined();
    });

    it('a rail whose Twilio state ALREADY carries the author is verified without a repair', async () => {
      // Sam's thread after the hand repair: Twilio is right, the row is not
      // stamped yet. One read, no add (the default add THROWS), then stamped.
      const { repo, row } = makeRepo(
        threadRow({ twilio_conversation_sid: 'CHold', twilio_participant_map: STORED_MAP }),
      );
      const { port } = makePort({
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CHold', uniqueName, state: 'active' };
        },
        async fetchParticipants() {
          return participantsFor(MEMBERS);
        },
      });

      const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

      expect(result.status).toBe('created');
      expect(row.current?.twilio_projected_address).toBe(BUSINESS);
    });

    it('a rail built for a PREVIOUS business number has the stale participant removed and the current one attached', async () => {
      // The 3: BUSINESS_PHONE_NUMBER changed under a rail that carried the old
      // (since released) number. Posting as the old number is impossible and
      // posting as the new one is 50513 - the rail has to be re-pointed.
      const { repo, row } = makeRepo(
        threadRow({
          twilio_conversation_sid: 'CHold',
          twilio_participant_map: STORED_MAP,
          twilio_projected_address: '+19999999999',
        }),
      );
      const removed: string[] = [];
      const attached: string[] = [];
      let participants: GroupParticipantRef[] = participantsFor(MEMBERS, '+19999999999');
      const { port } = makePort({
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CHold', uniqueName, state: 'active' };
        },
        async fetchParticipants() {
          return participants;
        },
        async removeParticipant(_sid, participantSid) {
          removed.push(participantSid);
          participants = participants.filter((p) => p.participantSid !== participantSid);
          return true;
        },
        async addProjectedParticipant(_sid, businessNumber) {
          attached.push(businessNumber);
          const ref = { participantSid: 'MBbizNew', projectedAddress: businessNumber };
          participants = [...participants, ref];
          return ref;
        },
      });

      const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

      expect(removed).toEqual(['MBbiz']);
      expect(attached).toEqual([BUSINESS]);
      expect(result.status).toBe('created');
      expect(row.current?.twilio_projected_address).toBe(BUSINESS);
    });

    it('a REFUSED author attach is a recorded rail failure - never a stamped rail that cannot post', async () => {
      const { repo, row, calls } = makeRepo(
        threadRow({ twilio_conversation_sid: 'CHold', twilio_participant_map: STORED_MAP }),
      );
      const { port } = makePort({
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CHold', uniqueName, state: 'active' };
        },
        async fetchParticipants() {
          return participantsFor(MEMBERS, null);
        },
        async addProjectedParticipant() {
          throw Object.assign(new Error('not owned'), { code: 50407, status: 400 });
        },
      });

      const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('50407');
      expect(calls.finalizes).toBe(0);
      expect(row.current?.rail_failed?.reason).toContain('50407');
      expect(row.current?.twilio_projected_address).toBeUndefined();
      // The claim is released so the next run can retry immediately.
      expect(row.current?.rail_creating).toBeUndefined();
    });

    it('a FRESH create whose fallback could not attach the business number is repaired or failed, never silently stamped', async () => {
      // The 8/15 shape exactly: bulk create refused, individual adds attached
      // every member, the business add was refused and reported in `failures`.
      const { repo, row, calls } = makeRepo();
      const attached: string[] = [];
      const { port } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: participantsFor(MEMBERS, null),
            failures: [{ address: input.businessNumber, message: 'not owned', errorCode: '50407' }],
          };
        },
        async addProjectedParticipant(_sid, businessNumber) {
          attached.push(businessNumber);
          return { participantSid: 'MBbizNew', projectedAddress: businessNumber };
        },
      });

      const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

      // The service noticed the refused business add and repaired it inline.
      expect(attached).toEqual([BUSINESS]);
      expect(result.status).toBe('created');
      expect(calls.finalizes).toBe(1);
      expect(row.current?.twilio_projected_address).toBe(BUSINESS);
    });

    it('a stored rail verified for the CURRENT number is trusted; one verified for ANOTHER number is not', async () => {
      const verified = makeRepo(
        threadRow({
          twilio_conversation_sid: 'CHold',
          twilio_participant_map: STORED_MAP,
          twilio_projected_address: BUSINESS,
        }),
      );
      const other = makeRepo(
        threadRow({
          twilio_conversation_sid: 'CHold',
          twilio_participant_map: STORED_MAP,
          twilio_projected_address: '+19999999999',
        }),
      );
      const { port } = makePort({
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CHold', uniqueName, state: 'active' };
        },
        async fetchParticipants() {
          return participantsFor(MEMBERS);
        },
      });

      expect((await svc(verified.repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS })).status).toBe(
        'existing',
      );
      expect(verified.calls.claims).toBe(0);
      // Twilio turns out to already carry the current number (a hand repair);
      // the row is re-verified and re-stamped rather than trusted.
      expect((await svc(other.repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS })).status).toBe(
        'created',
      );
      expect(other.calls.claims).toBe(1);
      expect(other.row.current?.twilio_projected_address).toBe(BUSINESS);
    });
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
    const late = await repo.setTwilioConversation(CONV, 'CHorphan', {}, 'dead-claimant', BUSINESS);
    expect(late).toBeUndefined();
    expect(row.current?.twilio_conversation_sid).toBe('CH1');
  });

  // THE DEFECT THIS PINS (fix wave 4, H1) - the reason the closed-rail recovery
  // shipped in wave 2 could not actually recover anything.
  //
  // A Twilio Conversation that CLOSES (its own auto-close timer, or an operator
  // in the console) keeps its UniqueName. Our UniqueName IS the conversationId.
  // So `groupSend`'s healRail cleared the stored sid, called back in here, the
  // adopt half found that same closed Conversation, the state check recorded
  // `rail_failed` - and the next send did all of it again. The thread was
  // permanently inbound-only, and the ONLY escape was a 20404, i.e. a human
  // deleting the Conversation in the Twilio console by hand.
  it('CLOSED ADOPTEE: the dead conversation is DELETED and a fresh rail takes the same UniqueName', async () => {
    const { repo, row, calls } = makeRepo();
    const removed: string[] = [];
    let live: GroupConversationRef | undefined = {
      conversationSid: 'CHclosed',
      uniqueName: CONV,
      state: 'closed',
    };
    const { port, created } = makePort({
      async fetchByUniqueName() {
        return live;
      },
      async removeConversation(sid) {
        removed.push(sid);
        live = undefined;
        return true;
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    // The dead resource was deleted, and exactly one fresh rail was created
    // under the SAME deterministic UniqueName.
    expect(removed).toEqual(['CHclosed']);
    expect(created).toHaveLength(1);
    expect(created[0]?.uniqueName).toBe(CONV);
    expect(result.status).toBe('created');
    expect(result.twilioConversationSid).toBe('CH1');
    expect(row.current?.twilio_conversation_sid).toBe('CH1');
    // Nothing is rail-failed: this thread can send again.
    expect(calls.failures).toBe(0);
    expect(row.current?.rail_failed).toBeUndefined();
    expect(row.current?.rail_creating).toBeUndefined();
  });

  it('an ACTIVE adoptee is NEVER deleted - the heal is scoped to a dead rail', async () => {
    // `makePort`'s default `removeConversation` throws, so an unwanted delete
    // surfaces as a rail failure rather than passing quietly.
    const { repo, row } = makeRepo();
    const { port, created } = makePort({
      async fetchByUniqueName(uniqueName) {
        return { conversationSid: 'CHalive', uniqueName, state: 'active' };
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('created');
    expect(result.twilioConversationSid).toBe('CHalive');
    expect(created).toEqual([]);
    expect(row.current?.rail_failed).toBeUndefined();
  });

  it('a DELETE that fails for an unknown reason is a rail failure, not a create that will collide', async () => {
    // Swallowing it would be followed by a create under a UniqueName that is
    // still taken - a 50353 reported as a participant problem, on a retry that
    // can never succeed. Reporting the delete failure is retryable and true.
    const { repo, row } = makeRepo();
    const { port, created } = makePort({
      async fetchByUniqueName(uniqueName) {
        return { conversationSid: 'CHclosed', uniqueName, state: 'closed' };
      },
      async removeConversation() {
        throw Object.assign(new Error('service unavailable'), { status: 503 });
      },
    });

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: MEMBERS });

    expect(result.status).toBe('failed');
    expect(created).toEqual([]);
    expect(row.current?.rail_failed?.reason).toContain('503');
    expect(row.current?.twilio_conversation_sid).toBeUndefined();
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

  // THE DEFECT THESE PIN (rail-binding-propagation-retry; migration 2026-08-13).
  // Twilio populates a participant's messaging BINDING asynchronously, and
  // `buildParticipantMap` drops any participant whose binding has no address
  // yet. A rail read milliseconds after its own create therefore reads SHORT of
  // its roster and the code concluded damage: 81 incomplete-roster warnings, 178
  // "participant already exists" refusals, and 2 `rail_failed` records for rails
  // a later read showed fully bound. The ladder waits that window out at BOTH
  // reads that can conclude damage (D14), for the three opted-in callers only
  // (D16), and never on an ADOPTED rail, whose read-back is the only source of
  // roster truth (D17).
  describe('BINDING PROPAGATION LADDER (awaitBindingPropagation)', () => {
    const FULL_MAP = { MB0: 'phone#+15551110001', MB1: 'phone#+15551110002' };

    /**
     * A rail whose SECOND member's binding lands only on the Nth participant
     * read the service itself makes. The create returns the SHORT list, which is
     * the whole point: a fixture that returns the full list immediately passes
     * against no ladder at all.
     */
    function bindingFixture(boundOnRead: number, over: Partial<GroupConversationsPort> = {}) {
      const short = participantsFor([MEMBERS[0]!]);
      const full = participantsFor(MEMBERS);
      let reads = 0;
      const waits: number[] = [];
      const addParticipants = vi.fn(async (): Promise<GroupParticipantFailure[]> => []);
      const { port, created } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: short,
            failures: [],
          };
        },
        async fetchParticipants() {
          reads += 1;
          return reads >= boundOnRead ? full : short;
        },
        addParticipants,
        ...over,
      });
      const sleep = async (ms: number): Promise<void> => {
        waits.push(ms);
      };
      return { port, created, addParticipants, waits, sleep, readCount: () => reads };
    }

    it('a fresh create whose bindings have not propagated resolves with NO repair and no rail_failed', async () => {
      const { repo, row, calls } = makeRepo();
      // The first laddered re-read sees the second binding.
      const f = bindingFixture(1);

      const result = await svc(repo, f.port, { sleep: f.sleep }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      expect(result.status).toBe('created');
      expect(result.participantMap).toEqual(FULL_MAP);
      // Asserted DIRECTLY, not by relying on makePort's throwing default: a
      // ladder that emptied `missing` for the wrong reason would still pass a
      // throw-based negative control.
      expect(f.addParticipants).not.toHaveBeenCalled();
      expect(calls.failures).toBe(0);
      expect(row.current?.rail_failed).toBeUndefined();
      expect(row.current?.twilio_participant_map).toEqual(FULL_MAP);
      expect(row.current?.rail_creating).toBeUndefined();
      // One rung was enough - the ladder stops as soon as `missing` empties.
      expect(f.waits).toEqual([500]);
    });

    it('a GENUINELY unbound member still repairs once the ladder runs out of rungs', async () => {
      const { repo, row, calls } = makeRepo();
      let attached = participantsFor([MEMBERS[0]!]);
      const waits: number[] = [];
      const repairs: string[][] = [];
      const { port } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: attached,
            failures: [],
          };
        },
        async fetchParticipants() {
          return attached;
        },
        async addParticipants(_sid, addresses) {
          repairs.push([...addresses]);
          attached = [
            ...attached,
            ...addresses.map((address, i) => ({ participantSid: `MB${i + 1}`, address })),
          ];
          return [];
        },
      });

      const result = await svc(repo, port, {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      // Both rungs spent, and then the repair the ladder exists to AVOID when it
      // is not needed - never to replace.
      expect(waits).toEqual([500, 1500]);
      expect(repairs).toEqual([[MEMBERS[1]!.phone]]);
      expect(result.status).toBe('created');
      expect(result.participantMap).toEqual(FULL_MAP);
      expect(calls.failures).toBe(0);
      expect(row.current?.rail_failed).toBeUndefined();
    });

    it('the POST-REPAIR read ladders too - the two false rail_failed records were written after it', async () => {
      const { repo, row, calls } = makeRepo();
      // Reads 1-2 are the validation ladder; read 3 is the post-repair read,
      // still unbound; read 4 is the post-repair ladder's first rung.
      const f = bindingFixture(4);

      const result = await svc(repo, f.port, { sleep: f.sleep }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      expect(f.addParticipants).toHaveBeenCalledTimes(1);
      expect(f.readCount()).toBe(4);
      expect(f.waits).toEqual([500, 1500, 500]);
      expect(result.status).toBe('created');
      expect(result.participantMap).toEqual(FULL_MAP);
      expect(calls.failures).toBe(0);
      expect(row.current?.rail_failed).toBeUndefined();
    });

    it('an ADOPTED rail ladders on NEITHER read - its read-back is the only roster truth there is', async () => {
      const { repo, row, calls } = makeRepo();
      // Never binds inside this run: if the adopt path laddered, the rail would
      // resolve instead of failing, and the wait list would not be empty.
      const f = bindingFixture(99, {
        async fetchByUniqueName(uniqueName) {
          return { conversationSid: 'CH1', uniqueName, state: 'active' };
        },
      });

      const result = await svc(repo, f.port, { sleep: f.sleep }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      expect(f.waits).toEqual([]);
      // Read 1 is the adopt path's own participant read, read 2 the post-repair
      // read. A ladder at either point would add reads around them.
      expect(f.readCount()).toBe(2);
      expect(f.addParticipants).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(calls.failures).toBe(1);
      expect(row.current?.rail_failed).toBeDefined();
    });

    it('with the flag ABSENT neither read ladders, on the very create path the flag changes', async () => {
      const { repo, row, calls } = makeRepo();
      const f = bindingFixture(99);

      // No flag: this is what the two groupSend callers still get (D16).
      const result = await svc(repo, f.port, { sleep: f.sleep }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
      });

      expect(f.waits).toEqual([]);
      // Exactly one read - the post-repair one. This is a CREATE (wasAdopted is
      // false), so only the flag can be suppressing the ladder.
      expect(f.readCount()).toBe(1);
      expect(f.addParticipants).toHaveBeenCalledTimes(1);
      expect(result.status).toBe('failed');
      expect(calls.failures).toBe(1);
      expect(row.current?.rail_failed).toBeDefined();
    });

    it('a laddered re-read that THROWS is a recorded rail failure that RELEASES the claim, never an escaped throw', async () => {
      const { repo, row, calls } = makeRepo();
      const waits: number[] = [];
      const addParticipants = vi.fn(async (): Promise<GroupParticipantFailure[]> => []);
      const { port } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: participantsFor([MEMBERS[0]!]),
            failures: [],
          };
        },
        async fetchParticipants() {
          throw Object.assign(new Error('service unavailable'), { status: 503 });
        },
        addParticipants,
      });

      const ensure = svc(repo, port, {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      // The ladder point sits inside NO existing try: an escaped throw would
      // strand `rail_creating` for its full 5-minute expiry and take the thread
      // with it. It resolves, and the claim is gone.
      await expect(ensure).resolves.toMatchObject({ status: 'failed' });
      expect((await ensure).reason).toContain('503');
      expect(row.current?.rail_failed?.reason).toContain('503');
      expect(row.current?.rail_creating).toBeUndefined();
      expect(row.current?.twilio_conversation_sid).toBeUndefined();
      expect(calls.failures).toBe(1);
      // A failed read is never a reason to continue on the stale list, so the
      // repair is not attempted on it either.
      expect(addParticipants).not.toHaveBeenCalled();
      expect(waits).toEqual([500]);
    });

    it('a THROWING post-repair read is still the repair catch - the ladder added no new escape', async () => {
      const { repo, row, calls } = makeRepo();
      const short = participantsFor([MEMBERS[0]!]);
      const waits: number[] = [];
      let reads = 0;
      const { port } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: short,
            failures: [],
          };
        },
        async fetchParticipants() {
          reads += 1;
          // Reads 1-2 are the validation ladder; read 3 is the post-repair read.
          if (reads >= 3) throw Object.assign(new Error('service unavailable'), { status: 503 });
          return short;
        },
        async addParticipants() {
          return [];
        },
      });

      const ensure = svc(repo, port, {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      await expect(ensure).resolves.toMatchObject({ status: 'failed' });
      expect((await ensure).reason).toContain('503');
      expect(row.current?.rail_failed?.reason).toContain('503');
      expect(row.current?.rail_creating).toBeUndefined();
      expect(calls.failures).toBe(1);
      expect(waits).toEqual([500, 1500]);
    });

    it('a re-read that reveals a STALE author participant still drives the author repair', async () => {
      // The ladder reassigns the participant list the AUTHOR block reads, so a
      // projected participant that only becomes visible on a re-read is checked
      // exactly like one the first read carried. (`authorPresent` cannot change
      // here: on the create path its `!wasAdopted` arm short-circuits.)
      const { repo, row, calls } = makeRepo();
      const removed: string[] = [];
      const waits: number[] = [];
      const bound = [
        ...participantsFor(MEMBERS),
        { participantSid: 'MBold', projectedAddress: '+15559998888' },
      ];
      const { port } = makePort({
        async createConversationWithParticipants(input) {
          return {
            conversation: { conversationSid: 'CH1', uniqueName: input.uniqueName, state: 'active' },
            participants: participantsFor([MEMBERS[0]!]),
            failures: [],
          };
        },
        async fetchParticipants() {
          return bound;
        },
        async removeParticipant(_sid, participantSid) {
          removed.push(participantSid);
          return true;
        },
      });

      const result = await svc(repo, port, {
        sleep: async (ms: number) => {
          waits.push(ms);
        },
      }).ensureGroupRail({
        conversationId: CONV,
        members: MEMBERS,
        awaitBindingPropagation: true,
      });

      expect(waits).toEqual([500]);
      expect(removed).toEqual(['MBold']);
      // `addProjectedParticipant` throws by default, so an author ATTACH the
      // create path must never need would surface as a rail failure here.
      expect(result.status).toBe('created');
      expect(result.participantMap).toEqual(FULL_MAP);
      expect(calls.failures).toBe(0);
      expect(row.current?.rail_failed).toBeUndefined();
    });
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

  // THE DEFECT THIS PINS (fix wave 5, adversarial 19). There was an upper bound
  // on the roster and no lower one, and EVERY rail validation is vacuous on the
  // empty set - `missingFromMap([], anything)` is `[]`. So an empty roster
  // sailed through validation, `setTwilioConversation` stamped a sid with an
  // EMPTY participant map, and `hasActiveGroupRail` then reported `true` for a
  // rail that can reach nobody - which suppresses the `rail_missing` re-enqueue
  // that would otherwise heal it.
  it('refuses an EMPTY roster loudly, before any Twilio call - a rail to nobody is not a rail', async () => {
    const { repo, calls } = makeRepo(threadRow({ participants: [] }));
    const { port, created } = makePort();

    const result = await svc(repo, port).ensureGroupRail({ conversationId: CONV, members: [] });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/EMPTY roster/);
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
