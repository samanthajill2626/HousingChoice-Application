// app/test/inboxInactive.test.ts
//
// unknown-inactive spec D9 / plan ruling AR5 (tracker #30, 2026-10-23): a
// contact row whose contact's status is `inactive` - any type, any filter -
// carries `inactive: true` and never the Needs triage chip (`needsTriage:
// false`). A Needs review unknown, an Active team member and a contactless
// number keep today's chip and carry NO `inactive` field. The deps are copied
// from test/inboxUnknownParity.test.ts, plus the empty getDisplaysByIds that
// test/inboxUnreadParity.test.ts carries for the roster-name batch.
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface World {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  latestMessage?: Record<string, Partial<MessageItem>>;
}

function conv(
  over: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  return {
    status: 'open',
    type: 'unknown_1to1',
    ai_mode: 'auto',
    created_at: '2026-06-01T00:00:00.000Z',
    ...unreadFlagFor(over),
    ...over,
  };
}

function makeDeps(world: World): InboxRouterDeps {
  return {
    conversationsRepo: {
      async getById(id: string) {
        return world.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        return queryUnreadPageFromItems(world.conversations, opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        const open = world.conversations
          .filter((c) => c.status === 'open')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        return world.conversations.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return world.conversations.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: string) {
        return {
          items: world.conversations.filter((c) => c.type === 'relay_group' && c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts() {
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return world.contacts.find((c) => c.phone === phone);
      },
      async findByEmail(email: string) {
        return world.contacts.find((c) => c.email === email);
      },
      async getById(contactId: string) {
        return world.contacts.find((c) => c.contactId === contactId);
      },
      async listByType(type: string, opts = {}) {
        return listByTypeFromContacts(world.contacts, type, opts);
      },
      async getDisplaysByIds() {
        return new Map();
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        const latest = world.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

const inactiveUnknownWorld = (): World => ({
  contacts: [{ contactId: 'c-off', type: 'unknown', status: 'inactive', phone: '+15550004001' }],
  conversations: [
    conv({ conversationId: 'cv-off', participant_phone: '+15550004001', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
  ],
  latestMessage: {
    'cv-off': { type: 'sms', direction: 'inbound', body: 'still looking', created_at: '2026-06-12T10:00:00.000Z' },
  },
});

describe('unknown-inactive D9 / AR5: Inactive contact rows', () => {
  it.each(['all', 'unread', 'unknown'] as const)(
    'RED: an Inactive unknown contact\'s unread inbound shows on filter=%s, unread, with needsTriage false and inactive true',
    async (filter) => {
      const page = await aggregateInbox({ filter, limit: 25 }, makeDeps(inactiveUnknownWorld()));
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({
        kind: 'contact',
        contactId: 'c-off',
        role: 'unknown',
        unreadCount: 1,
        needsTriage: false,
        inactive: true,
      });
    },
  );

  it('RED: inactive is true for an Inactive TENANT and an Inactive CASEWORKER too (any type), with no triage chip', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-ten-off', type: 'tenant', status: 'inactive', phone: '+15550004002' },
        { contactId: 'c-cw-off', type: 'partner', status: 'inactive', phone: '+15550004003' },
      ],
      conversations: [
        conv({ conversationId: 'cv-ten-off', type: 'tenant_1to1', participant_phone: '+15550004002', last_activity_at: '2026-06-12T09:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-cw-off', type: 'partner_1to1', participant_phone: '+15550004003', last_activity_at: '2026-06-12T08:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-ten-off')).toMatchObject({ kind: 'contact', role: 'tenant', needsTriage: false, inactive: true });
    expect(byId.get('c-cw-off')).toMatchObject({ kind: 'contact', role: 'partner', needsTriage: false, inactive: true });
  });

  it('RED: an Inactive team member (role falls through to unknown) loses the chip and carries the tag; PIN: an Active team member keeps today\'s chip and no tag', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-tm-off', type: 'team_member', status: 'inactive', phone: '+15550004004' },
        { contactId: 'c-tm-on', type: 'team_member', status: 'active', phone: '+15550004005' },
      ],
      conversations: [
        conv({ conversationId: 'cv-tm-off', participant_phone: '+15550004004', last_activity_at: '2026-06-12T07:00:00.000Z' }),
        conv({ conversationId: 'cv-tm-on', participant_phone: '+15550004005', last_activity_at: '2026-06-12T06:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-tm-off')).toMatchObject({ role: 'unknown', needsTriage: false, inactive: true });
    expect(byId.get('c-tm-on')).toMatchObject({ role: 'unknown', needsTriage: true });
    expect(byId.get('c-tm-on')).not.toHaveProperty('inactive');
  });

  it('PIN: a Needs review unknown keeps needsTriage true and carries NO inactive field; a Parked landlord carries none either', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-nr', type: 'unknown', status: 'needs_review', phone: '+15550004006' },
        { contactId: 'c-ll-parked', type: 'landlord', status: 'parked', phone: '+15550004007' },
      ],
      conversations: [
        conv({ conversationId: 'cv-nr', participant_phone: '+15550004006', last_activity_at: '2026-06-12T05:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-ll-parked', type: 'landlord_1to1', participant_phone: '+15550004007', last_activity_at: '2026-06-12T04:00:00.000Z' }),
      ],
    }));
    const byId = new Map(page.rows.map((r) => [r.contactId, r]));
    expect(byId.get('c-nr')).toMatchObject({ role: 'unknown', needsTriage: true });
    expect(byId.get('c-nr')).not.toHaveProperty('inactive');
    expect(byId.get('c-ll-parked')).toMatchObject({ role: 'landlord', needsTriage: false });
    expect(byId.get('c-ll-parked')).not.toHaveProperty('inactive');
  });

  it.each(['all', 'unread'] as const)(
    'PIN: a CONTACTLESS unknown number keeps needsTriage true and never carries inactive (filter=%s)',
    async (filter) => {
      const page = await aggregateInbox({ filter, limit: 25 }, makeDeps({
        contacts: [],
        conversations: [
          conv({ conversationId: 'cv-noc', participant_phone: '+14049824979', last_activity_at: '2026-06-12T03:00:00.000Z', unread_count: 1 }),
        ],
      }));
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toMatchObject({ kind: 'unknown', phone: '+14049824979', needsTriage: true });
      expect(page.rows[0]).not.toHaveProperty('inactive');
    },
  );
});
