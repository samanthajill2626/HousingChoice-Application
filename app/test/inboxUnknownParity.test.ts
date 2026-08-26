// app/test/inboxUnknownParity.test.ts
//
// PARITY BASELINE for the filter=unknown contact-side rewrite (design
// 2026-08-25). Captured against the PRE-REWRITE aggregateInbox (the open-
// partition pager) and committed on its own, before inbox.ts is touched.
//
// Section 3 of the design enumerates the coverage classes; each world below is
// one class. Pins marked "FLIP:" change AT the flip commit, deliberately, with
// the class letter; every other pin must survive byte-identical.
//
// The fixture fakes carry listByType (via the shared DynamoDB-faithful helper)
// and a tuple-ordered byUnread index NOW, while both are inert - so the flip
// commit changes EXPECTATIONS only, never fixtures (the unread parity file's
// unread_flag trick).
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

describe('filter=unknown parity, class by class (design section 3)', () => {
  it('a type=unknown CONTACT with an open thread is a triage row (the core case - must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550001001' }],
      conversations: [conv({ conversationId: 'cv-unk', participant_phone: '+15550001001', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 })],
    }));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-unk',
      role: 'unknown',
      needsTriage: true,
      phone: '+15550001001',
      unreadCount: 1,
      lastActivityAt: '2026-06-12T10:00:00.000Z',
    });
  });

  it('class f: a (type=unknown, status=active) contact is a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-active', type: 'unknown', status: 'active', phone: '+15550001002' }],
      conversations: [conv({ conversationId: 'cv-active', participant_phone: '+15550001002', last_activity_at: '2026-06-12T09:00:00.000Z' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-active']);
  });

  it('class a: a group-detection stub who later TEXTED is a triage row (must survive the flip - excludeOrigin must NOT be copied)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-stub', type: 'unknown', status: 'needs_review', origin: 'group_detection', phone: '+15550001003' }],
      conversations: [conv({ conversationId: 'cv-stub', participant_phone: '+15550001003', last_activity_at: '2026-06-12T08:00:00.000Z', unread_count: 2 })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-stub']);
  });

  it('class d: a soft-deleted unknown with an unread post-deletion inbound resurfaces, deleted:true (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{
        contactId: 'c-del',
        type: 'unknown',
        status: 'needs_review',
        phone: '+15550001004',
        deleted_at: '2026-06-10T00:00:00.000Z',
      }],
      conversations: [conv({ conversationId: 'cv-del', participant_phone: '+15550001004', last_activity_at: '2026-06-12T07:00:00.000Z', unread_count: 1 })],
      latestMessage: {
        'cv-del': { type: 'sms', direction: 'inbound', body: 'hello?', created_at: '2026-06-12T07:00:00.000Z' },
      },
    }));
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'c-del', deleted: true, needsTriage: true });
  });

  it('class e: a CONTACTLESS unknown number is a triage row today. FLIP: it leaves the queue (stays on All) - amend this pin at the flip commit', async () => {
    const world: World = {
      contacts: [],
      conversations: [conv({ conversationId: 'cv-noc', participant_phone: '+14049824978', last_activity_at: '2026-06-12T06:00:00.000Z', unread_count: 1 })],
    };
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(world));
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']); // FLIP: becomes []
    const all = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(world));
    expect(all.rows.map((r) => r.phone)).toEqual(['+14049824978']); // the mitigation - must survive
  });

  it('class c: a team_member with an open thread is a triage row today (the LATENT BUG). FLIP: absent, per the 2026-08-25 ruling - amend this pin at the flip commit', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-team', type: 'team_member', status: 'active', phone: '+15550001005' }],
      conversations: [conv({ conversationId: 'cv-team', participant_phone: '+15550001005', last_activity_at: '2026-06-12T05:00:00.000Z', type: 'tenant_1to1' })],
    }));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-team']); // FLIP: becomes []
  });

  it('a resolved tenant/landlord/partner is never a triage row (must survive the flip)', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [
        { contactId: 'c-t', type: 'tenant', phone: '+15550001006' },
        { contactId: 'c-p', type: 'partner', phone: '+15550001007' },
      ],
      conversations: [
        conv({ conversationId: 'cv-t', participant_phone: '+15550001006', last_activity_at: '2026-06-12T04:00:00.000Z', type: 'tenant_1to1' }),
        conv({ conversationId: 'cv-p', participant_phone: '+15550001007', last_activity_at: '2026-06-12T03:00:00.000Z', type: 'partner_1to1' }),
      ],
    }));
    expect(page.rows).toEqual([]);
  });
});
