// convertConnectingRelayGroupToGroupText (S7 / spec section 9) over in-memory
// repo fakes. The concurrency and crash claims that need REAL conditional
// writes live in groupConvert.integration.test.ts.
import { describe, expect, it } from 'vitest';
import {
  convertConnectingRelayGroupToGroupText,
  type GroupConvertOptions,
} from '../src/services/groupConvert.js';
import { contactIdForPhone, conversationIdForGroup } from '../src/lib/import/ids.js';
import type { ContactItem, ContactsRepo } from '../src/repos/contactsRepo.js';
import type {
  ConversationItem,
  ConversationParticipant,
  ConversationsRepo,
} from '../src/repos/conversationsRepo.js';

const MEMBER_A = '+15550100008';
const MEMBER_B = '+15550100004';
const GROUP_ID = conversationIdForGroup([MEMBER_A, MEMBER_B]);
const AT = '2026-08-17T12:00:00.000Z';

/** The exact shape the importer leaves behind: connecting, empty contactIds. */
function importedGroupRow(over: Partial<ConversationItem> = {}): ConversationItem {
  return {
    conversationId: GROUP_ID,
    type: 'relay_group',
    status: 'connecting',
    relay_status: 'relay_group#connecting',
    last_activity_at: '2026-07-26T10:00:00.000Z',
    created_at: '2026-07-25T10:00:00.000Z',
    ai_mode: 'manual',
    participants: [
      { contactId: '', phone: MEMBER_A },
      { contactId: '', phone: MEMBER_B },
    ],
    imported_from: 'quo-airtable-import',
    imported_at: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

interface World {
  conversations: Map<string, ConversationItem>;
  contacts: Map<string, ContactItem>;
  opts: GroupConvertOptions;
  /** Every stampGroupParticipation call, in order. */
  stamps: { contactId: string; at: string }[];
  /** Every createIfAbsent call, in order (the re-mint path). */
  creates: ContactItem[];
}

function world(
  row?: ConversationItem,
  contactIds: string[] = [],
  opts: { createFails?: boolean } = {},
): World {
  const conversations = new Map<string, ConversationItem>();
  if (row) conversations.set(row.conversationId, row);
  const contacts = new Map<string, ContactItem>();
  for (const contactId of contactIds) {
    contacts.set(contactId, { contactId, type: 'unknown' } as ContactItem);
  }
  const stamps: { contactId: string; at: string }[] = [];
  const creates: ContactItem[] = [];

  const conversationsRepo = {
    async getById(id: string) {
      return conversations.get(id);
    },
    async convertRelayGroupToGroupText(id: string, members: ConversationParticipant[]) {
      const conv = conversations.get(id);
      if (
        !conv ||
        conv.type !== 'relay_group' ||
        conv.status !== 'connecting' ||
        typeof conv.pool_number === 'string'
      ) {
        return undefined;
      }
      const next: ConversationItem = { ...conv, type: 'group_text', status: 'group_open' };
      next.participants = members;
      delete next.relay_status;
      delete next.pool_number;
      conversations.set(id, next);
      return next;
    },
    async backfillGroupTextRoster(id: string, members: ConversationParticipant[]) {
      const conv = conversations.get(id);
      if (!conv || conv.type !== 'group_text') return undefined;
      const next = { ...conv, participants: members };
      conversations.set(id, next);
      return next;
    },
  } as unknown as ConversationsRepo;

  const contactsRepo = {
    // The pointer-aware lookup the re-mint consults FIRST (adversarial 4): a
    // member may already exist under a hand-made id, and minting the derived id
    // anyway would duplicate a real person. Mirrors the real repo: soft-deleted
    // rows are returned (routing ignores `deleted_at`).
    async findByPhone(phone: string) {
      return [...contacts.values()].find((c) => c.phone === phone);
    },
    async stampGroupParticipation(contactId: string, at: string) {
      stamps.push({ contactId, at });
      const contact = contacts.get(contactId);
      if (!contact) return 'missing' as const;
      if (typeof contact.group_participation_at === 'string') return 'already' as const;
      contact.group_participation_at = at;
      return 'stamped' as const;
    },
    async createIfAbsent(item: ContactItem) {
      creates.push(item);
      if (opts.createFails) throw new Error('ProvisionedThroughputExceededException');
      if (contacts.has(item.contactId)) return false;
      contacts.set(item.contactId, { ...item });
      return true;
    },
  } as unknown as ContactsRepo;

  return {
    conversations,
    contacts,
    stamps,
    creates,
    opts: { conversationsRepo, contactsRepo, at: AT },
  };
}

const bothMembers = [contactIdForPhone(MEMBER_A), contactIdForPhone(MEMBER_B)];

describe('convertConnectingRelayGroupToGroupText', () => {
  it('rewrites an imported connecting relay group onto the native group_text shape', async () => {
    const w = world(importedGroupRow(), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('converted');
    const stored = w.conversations.get(GROUP_ID)!;
    expect(stored.type).toBe('group_text');
    expect(stored.status).toBe('group_open');
    expect(stored.relay_status).toBeUndefined();
    // The conversationId is UNCHANGED, so the message history stays attached.
    expect(stored.conversationId).toBe(GROUP_ID);
  });

  it('backfills every empty contactId with the same derivation the importer uses', async () => {
    const w = world(importedGroupRow(), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.contactIdsBackfilled).toBe(2);
    expect(w.conversations.get(GROUP_ID)!.participants).toEqual([
      { contactId: contactIdForPhone(MEMBER_A), phone: MEMBER_A },
      { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
    ]);
  });

  it('keeps a contactId the roster already carries', async () => {
    const row = importedGroupRow();
    row.participants = [
      { contactId: 'contact-set-by-a-human', phone: MEMBER_A },
      { contactId: '', phone: MEMBER_B },
    ];
    const w = world(row, bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.contactIdsBackfilled).toBe(1);
    expect(w.conversations.get(GROUP_ID)!.participants![0]!.contactId).toBe(
      'contact-set-by-a-human',
    );
  });

  it('stamps group_participation_at on every member that carries none', async () => {
    const w = world(importedGroupRow(), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.membersStamped).toBe(2);
    for (const contactId of bothMembers) {
      expect(w.contacts.get(contactId)!.group_participation_at).toBe(AT);
    }
  });

  it('NEVER touches consent_method', async () => {
    // Being added to a carrier group by someone else is participation, not
    // consent - stamping consent_method would hand every silent member SMS
    // consent through hasSmsConsent.
    const w = world(importedGroupRow(), bothMembers);
    await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);
    for (const contactId of bothMembers) {
      expect(w.contacts.get(contactId)!.consent_method).toBeUndefined();
      expect(w.contacts.get(contactId)!.consent_at).toBeUndefined();
    }
  });

  it('RE-MINTS a group-scoped stub for a roster slot whose contact record is absent', async () => {
    // A workbook `drop` on a group member leaves the roster slot in place with
    // NO contact row behind it, and groupSend's consent fence then refuses EVERY
    // outbound on that thread forever (nothing re-resolves an existing thread's
    // roster). The migration is the last place that can heal it.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.membersStamped).toBe(1);
    expect(result.membersReminted).toBe(1);
    expect(result.membersMissing).toEqual([]);

    const reminted = w.contacts.get(contactIdForPhone(MEMBER_B))!;
    expect(reminted).toBeDefined();
    expect(reminted.phone).toBe(MEMBER_B);
    expect(reminted.origin).toBe('group_detection');
    expect(reminted.group_participation_at).toBe(AT);
    expect(reminted.type).toBe('unknown');
    expect(reminted.status).toBe('needs_review');
  });

  it('grants the re-minted stub NO SMS consent of any kind', async () => {
    // The drop still holds for 1:1 purposes. `consent_method` is the single
    // predicate hasSmsConsent reads, and `capture_source` maps back to one - a
    // stub carrying either would make a silently-added group member proactively
    // sendable, which is exactly what the drop denied.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(w.creates).toHaveLength(1);
    const stub = w.creates[0]!;
    expect(stub.consent_method).toBeUndefined();
    expect(stub.consent_at).toBeUndefined();
    expect(stub.capture_source).toBeUndefined();
    expect(stub.sms_opt_out).toBeUndefined();
    const stored = w.contacts.get(contactIdForPhone(MEMBER_B))!;
    expect(stored.consent_method).toBeUndefined();
    expect(stored.consent_at).toBeUndefined();
  });

  it('reports the member as MISSING when the re-mint itself fails', async () => {
    // A residual `missing` is the one signal the cutover gate must not swallow:
    // the thread can receive and can never reply.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)], { createFails: true });
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.membersReminted).toBe(0);
    expect(result.membersMissing).toEqual([contactIdForPhone(MEMBER_B)]);
    expect(w.contacts.has(contactIdForPhone(MEMBER_B))).toBe(false);
  });

  it('NEVER mints a duplicate for a phone that already has a contact under another id', async () => {
    // adversarial 4. `stubFor` was copied from groupMembers.ts without the
    // `findByPhone` that precedes it there, and `createIfAbsent` conditions on
    // the contactId alone - so a member who exists under a hand-made id got a
    // SECOND row carrying their phone. groupSend resolves members BY PHONE and
    // findByPhone returns whichever row the index yields first, so the duplicate
    // can hand the send path the fresh stub instead of the staff-deleted real
    // contact and silently bypass the soft-delete fence.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    const handMadeId = 'contact-hand-made-1';
    w.contacts.set(handMadeId, {
      contactId: handMadeId,
      type: 'tenant',
      status: 'active',
      phone: MEMBER_B,
      deleted_at: '2026-08-01T00:00:00.000Z',
    } as ContactItem);

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    // Nothing was minted, and the derived id still has no row of its own.
    expect(w.creates).toHaveLength(0);
    expect(result.membersReminted).toBe(0);
    expect(result.membersMissing).toEqual([]);
    expect(w.contacts.has(contactIdForPhone(MEMBER_B))).toBe(false);
    // The person we already had got the group consent basis instead.
    expect(w.contacts.get(handMadeId)!.group_participation_at).toBe(AT);
    // THE SOFT-DELETE FENCE STILL SEES THEM: exactly one row carries the phone,
    // and it is the deleted one, so groupSend's findByPhone cannot be handed a
    // fresh stub in its place.
    const byPhone = [...w.contacts.values()].filter((c) => c.phone === MEMBER_B);
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0]!.deleted_at).toBe('2026-08-01T00:00:00.000Z');
  });

  it('refuses to mint when the pointer-aware lookup itself fails', async () => {
    // A read failure is not evidence that the phone is unknown, and minting on
    // it is how a duplicate gets created.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    w.opts.contactsRepo.findByPhone = async () => {
      throw new Error('ProvisionedThroughputExceededException');
    };

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(w.creates).toHaveLength(0);
    expect(result.membersReminted).toBe(0);
    expect(result.membersMissing).toEqual([contactIdForPhone(MEMBER_B)]);
  });

  it('stamps rather than re-mints when the row reappears mid-convergence', async () => {
    // createIfAbsent losing its condition means live detection minted the stub
    // between our stamp and our create; the only thing left is the basis stamp.
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    const missingId = contactIdForPhone(MEMBER_B);
    const stampFirst = w.opts.contactsRepo.stampGroupParticipation.bind(w.opts.contactsRepo);
    let firstCall = true;
    w.opts.contactsRepo.stampGroupParticipation = async (contactId: string, at: string) => {
      if (contactId === missingId && firstCall) {
        firstCall = false;
        // Detection wins the race right after our read comes back empty.
        w.contacts.set(missingId, {
          contactId: missingId,
          type: 'unknown',
          phone: MEMBER_B,
        } as ContactItem);
        return 'missing' as const;
      }
      return stampFirst(contactId, at);
    };

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);
    expect(result.membersReminted).toBe(0);
    expect(result.membersStamped).toBe(2);
    expect(result.membersMissing).toEqual([]);
    expect(w.contacts.get(missingId)!.group_participation_at).toBe(AT);
  });

  it('short-circuits the TRANSITION on a re-run but still converges', async () => {
    const w = world(importedGroupRow(), bothMembers);
    await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);
    const again = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(again.outcome).toBe('already_converted');
    // Convergence still ran: every member was re-checked.
    expect(again.membersAlreadyStamped).toBe(2);
    expect(w.stamps).toHaveLength(4);
  });

  it('finishes a conversion that crashed before the stamps (spec 15.4)', async () => {
    // Durable step 1 succeeded, the process died before step 2. The re-run must
    // complete the rest rather than reporting the thread as done.
    const w = world(importedGroupRow(), bothMembers);
    const converted = {
      ...importedGroupRow(),
      type: 'group_text' as const,
      status: 'group_open',
      participants: [
        { contactId: contactIdForPhone(MEMBER_A), phone: MEMBER_A },
        { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
      ],
    };
    delete converted.relay_status;
    w.conversations.set(GROUP_ID, converted);

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);
    expect(result.outcome).toBe('already_converted');
    expect(result.membersStamped).toBe(2);
  });

  it('backfills a converted roster that still carries empty contactIds', async () => {
    // Crash between the transition and the roster write is impossible (they are
    // one write), but a thread converted by an older build could still be here.
    const w = world(
      { ...importedGroupRow(), type: 'group_text', status: 'group_open' },
      bothMembers,
    );
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('already_converted');
    expect(result.contactIdsBackfilled).toBe(2);
    expect(w.conversations.get(GROUP_ID)!.participants).toEqual([
      { contactId: contactIdForPhone(MEMBER_A), phone: MEMBER_A },
      { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
    ]);
  });

  it('REFUSES an ALREADY-CONVERTED row whose roster does not hash back to its id', async () => {
    // The roster/id invariant is a property of the ROW, not of the type
    // TRANSITION. Checked only in `precondition`, it was skipped entirely by the
    // already-converted early return - so a corrupt `group_text` converged
    // happily, was counted `already_converted`, warned nothing, and let the
    // migration report (the hard cutover gate) say COMPLETE over it.
    const w = world(
      {
        ...importedGroupRow(),
        type: 'group_text',
        status: 'group_open',
        // The id is uuidv5 over [MEMBER_A, MEMBER_B]; this roster is short.
        participants: [{ contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B }],
      },
      bothMembers,
    );

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('roster_id_mismatch');
    // Convergence wrote NOTHING for it: no stamps, no roster rewrite.
    expect(w.stamps).toHaveLength(0);
    expect(w.conversations.get(GROUP_ID)!.participants).toEqual([
      { contactId: contactIdForPhone(MEMBER_B), phone: MEMBER_B },
    ]);
  });

  it('REPORTS import_connect_requested rather than refusing on it', async () => {
    const w = world(importedGroupRow({ import_connect_requested: true }), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('converted');
    expect(result.importConnectRequested).toBe(true);
  });

  it('refuses an OPEN relay group and writes nothing', async () => {
    const row = importedGroupRow({ status: 'open', relay_status: 'relay_group#open' });
    const w = world(row, bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('not_connecting');
    expect(result.refusedReason).toContain('NOT converted');
    expect(w.conversations.get(GROUP_ID)!.type).toBe('relay_group');
    expect(w.stamps).toHaveLength(0);
  });

  it('refuses a relay group that already fronts a pool number', async () => {
    const w = world(importedGroupRow({ pool_number: '+15550199999' }), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('has_pool_number');
    expect(w.stamps).toHaveLength(0);
  });

  it('refuses a 1:1 thread', async () => {
    const w = world(importedGroupRow({ type: 'unknown_1to1', status: 'open' }), bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('not_a_relay_group');
  });

  it('refuses an id with no conversation behind it', async () => {
    const w = world(undefined, bothMembers);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.outcome).toBe('refused');
    expect(result.refusal).toBe('not_found');
  });

  it('re-reads and adopts the winner when it loses the conditional transition', async () => {
    // The bulk runner and inbound auto-convert can hit the same thread at the
    // same instant. The loser must converge, not report a refusal.
    const w = world(importedGroupRow(), bothMembers);
    const repo = w.opts.conversationsRepo as unknown as {
      convertRelayGroupToGroupText: (
        id: string,
        m: ConversationParticipant[],
      ) => Promise<ConversationItem | undefined>;
    };
    const real = repo.convertRelayGroupToGroupText.bind(repo);
    repo.convertRelayGroupToGroupText = async (id, members) => {
      // The other converter got there first.
      await real(id, members);
      return undefined;
    };

    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);
    expect(result.outcome).toBe('already_converted');
    expect(result.membersStamped).toBe(2);
  });
});
