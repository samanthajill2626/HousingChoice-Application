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
}

function world(row?: ConversationItem, contactIds: string[] = []): World {
  const conversations = new Map<string, ConversationItem>();
  if (row) conversations.set(row.conversationId, row);
  const contacts = new Map<string, ContactItem>();
  for (const contactId of contactIds) {
    contacts.set(contactId, { contactId, type: 'unknown' } as ContactItem);
  }
  const stamps: { contactId: string; at: string }[] = [];

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
    async stampGroupParticipation(contactId: string, at: string) {
      stamps.push({ contactId, at });
      const contact = contacts.get(contactId);
      if (!contact) return 'missing' as const;
      if (typeof contact.group_participation_at === 'string') return 'already' as const;
      contact.group_participation_at = at;
      return 'stamped' as const;
    },
  } as unknown as ContactsRepo;

  return { conversations, contacts, stamps, opts: { conversationsRepo, contactsRepo, at: AT } };
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

  it('reports members with no contact record instead of creating them', async () => {
    const w = world(importedGroupRow(), [contactIdForPhone(MEMBER_A)]);
    const result = await convertConnectingRelayGroupToGroupText(GROUP_ID, w.opts);

    expect(result.membersStamped).toBe(1);
    expect(result.membersMissing).toEqual([contactIdForPhone(MEMBER_B)]);
    expect(w.contacts.has(contactIdForPhone(MEMBER_B))).toBe(false);
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
