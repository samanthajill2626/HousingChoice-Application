// Task 1 (Contract C8) unit tests: the inbox read model's aggregator,
// `aggregateInbox`, driven DIRECTLY (no Express) against hand-built in-memory
// fakes that mirror the contractual repo semantics the aggregator relies on:
//   - conversationsRepo.listByLastActivity — newest-activity-first, honoring
//     limit + exclusiveStartKey, returning a raw lastEvaluatedKey (the cursor's
//     opaque payload) when the stream has more.
//   - conversationsRepo.findByParticipantPhone — every conversation on a number.
//   - contactsRepo.findByPhone — pointer-aware phone → contact resolution.
//   - contactsRepo.getById / messagesRepo.listByConversation (latest message) /
//     casesRepo.getById / usersRepo.findById — best-effort hydration.
//
// The aggregator emits ONE row per contact at its NEWEST conversation (the
// newest-conversation rule) so paging is split-proof: a contact represented on
// page 1 by its newest conversation never reappears on page 2 via an older one.
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps } from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';

interface Seed {
  conversations: ConversationItem[];
  contacts: ContactItem[];
  /** Latest message per conversationId (drives channel/direction/preview). */
  latestMessage?: Record<string, Partial<MessageItem>>;
  users?: Record<string, { name?: string; email?: string }>;
  cases?: Record<string, { stage: string }>;
}

/**
 * A minimal deps object backed by in-memory arrays/maps mirroring the real
 * repos' contractual semantics. listByLastActivity encodes its paging position
 * as a `{ idx }` key (the raw LastEvaluatedKey the route base64s into a cursor).
 */
function makeDeps(seed: Seed): InboxRouterDeps {
  // Newest-activity-first total order over the OPEN conversations, the by
  // LastActivity GSI's descending sort.
  const ordered = [...seed.conversations]
    .filter((c) => c.status === 'open')
    .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));

  const contactByPhone = (phone: string): ContactItem | undefined =>
    seed.contacts.find((c) => {
      if (c.phone_ref === true) return false; // pointers resolve via their owner
      const phones = Array.isArray(c.phones) && c.phones.length > 0
        ? c.phones.map((p) => p.phone)
        : typeof c.phone === 'string'
          ? [c.phone]
          : [];
      return phones.includes(phone);
    });

  return {
    conversationsRepo: {
      async listByLastActivity({
        limit,
        exclusiveStartKey,
      }: {
        status: string;
        limit?: number;
        exclusiveStartKey?: Record<string, unknown>;
      }) {
        const start =
          typeof exclusiveStartKey?.['idx'] === 'number'
            ? (exclusiveStartKey['idx'] as number) + 1
            : 0;
        const take = limit ?? 50;
        const window = ordered.slice(start, start + take);
        const endIdx = start + window.length - 1;
        const hasMore = start + window.length < ordered.length;
        return {
          items: window,
          ...(hasMore && { lastEvaluatedKey: { idx: endIdx } as Record<string, unknown> }),
        };
      },
      async findByParticipantPhone(phone: string) {
        return seed.conversations.filter((c) => c.participant_phone === phone);
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return contactByPhone(phone);
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        const latest = seed.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    casesRepo: {
      async getById(caseId: string) {
        const c = seed.cases?.[caseId];
        return c ? ({ caseId, stage: c.stage } as unknown) : undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['casesRepo']>,
    usersRepo: {
      async findById(userId: string) {
        const u = seed.users?.[userId];
        return u ? ({ userId, ...u } as unknown) : undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['usersRepo']>,
  };
}

/** A minimal open conversation row. */
function conv(overrides: Partial<ConversationItem> & { conversationId: string; participant_phone: string; last_activity_at: string }): ConversationItem {
  return {
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: overrides.last_activity_at,
    ...overrides,
  };
}

describe('aggregateInbox — one row per contact (C8)', () => {
  it('one contact with two numbers → ONE row; unreadCount sums across numbers; newest activity wins', async () => {
    const contact: ContactItem = {
      contactId: 'c-1',
      type: 'tenant',
      firstName: 'Dana',
      lastName: 'Doe',
      phone: '+15550000001',
      phones: [
        { phone: '+15550000001', primary: true },
        { phone: '+15550000002', primary: false },
      ],
    };
    const deps = makeDeps({
      contacts: [contact],
      conversations: [
        conv({ conversationId: 'conv-a', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 2 }),
        conv({ conversationId: 'conv-b', participant_phone: '+15550000002', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 3 }),
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-1', unreadCount: 5 });
    // The newer number's activity wins.
    expect(page.rows[0]!.lastActivityAt).toBe('2026-06-12T10:00:00.000Z');
    expect(page.rows[0]!.name).toBe('Dana Doe');
  });

  it('unknown number (no contact) → kind:"unknown", needsTriage:true, name=formatted number, role:"unknown"', async () => {
    const deps = makeDeps({
      contacts: [],
      conversations: [
        conv({ conversationId: 'conv-x', participant_phone: '+14049824978', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1, type: 'unknown_1to1' }),
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'unknown',
      needsTriage: true,
      role: 'unknown',
      phone: '+14049824978',
      name: '(404) 982-4978',
    });
    expect(page.rows[0]!.contactId).toBeUndefined();
  });

  it('relay_group conversations are excluded from the feed', async () => {
    const deps = makeDeps({
      contacts: [],
      conversations: [
        conv({ conversationId: 'conv-relay', participant_phone: '+15550009000', last_activity_at: '2026-06-12T10:00:00.000Z', type: 'relay_group', pool_number: '+15550009000' }),
        conv({ conversationId: 'conv-y', participant_phone: '+14049824978', last_activity_at: '2026-06-11T10:00:00.000Z', type: 'unknown_1to1' }),
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);

    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.phone).toBe('+14049824978');
    expect(page.rows.some((r) => r.phone === '+15550009000')).toBe(false);
  });

  it('rows are newest-activity-first', async () => {
    const deps = makeDeps({
      contacts: [
        { contactId: 'c-1', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-2', type: 'landlord', phone: '+15550000002' },
        { contactId: 'c-3', type: 'tenant', phone: '+15550000003' },
      ],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z' }),
        conv({ conversationId: 'conv-2', participant_phone: '+15550000002', last_activity_at: '2026-06-12T10:00:00.000Z' }),
        conv({ conversationId: 'conv-3', participant_phone: '+15550000003', last_activity_at: '2026-06-11T10:00:00.000Z' }),
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);

    expect(page.rows.map((r) => r.contactId)).toEqual(['c-2', 'c-3', 'c-1']);
  });

  it('derives channel/direction from the latest message (mms when media; call when call record; else sms)', async () => {
    const deps = makeDeps({
      contacts: [
        { contactId: 'c-sms', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-mms', type: 'tenant', phone: '+15550000002' },
        { contactId: 'c-call', type: 'tenant', phone: '+15550000003' },
      ],
      conversations: [
        conv({ conversationId: 'conv-sms', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z' }),
        conv({ conversationId: 'conv-mms', participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z' }),
        conv({ conversationId: 'conv-call', participant_phone: '+15550000003', last_activity_at: '2026-06-12T10:00:00.000Z' }),
      ],
      latestMessage: {
        'conv-sms': { type: 'sms', direction: 'inbound', body: 'hi there' },
        'conv-mms': { type: 'mms', direction: 'outbound', body: 'see attached', mediaUrls: ['http://x/1.jpg'] },
        'conv-call': { type: 'call', direction: 'inbound', call_party_label: 'Tenant' },
      },
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);
    const byId = Object.fromEntries(page.rows.map((r) => [r.contactId, r]));

    expect(byId['c-sms']).toMatchObject({ channel: 'sms', direction: 'inbound', preview: 'hi there' });
    expect(byId['c-mms']).toMatchObject({ channel: 'mms', direction: 'outbound' });
    expect(byId['c-call']).toMatchObject({ channel: 'call', direction: 'inbound' });
  });

  it('filter "unread" keeps only unreadCount>0; "unknown" keeps only needsTriage; "mine" keeps only rows assigned to userId', async () => {
    const baseSeed: Seed = {
      contacts: [
        { contactId: 'c-read', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' },
        { contactId: 'c-mine', type: 'tenant', phone: '+15550000003' },
      ],
      conversations: [
        conv({ conversationId: 'conv-read', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 }),
        conv({ conversationId: 'conv-unread', participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 }),
        conv({ conversationId: 'conv-mine', participant_phone: '+15550000003', last_activity_at: '2026-06-12T10:00:00.000Z', assignment: 'u-1' }),
        conv({ conversationId: 'conv-unk', participant_phone: '+14049824978', last_activity_at: '2026-06-09T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 }),
      ],
    };

    const unread = await aggregateInbox({ filter: 'unread', limit: 25, userId: 'u-1' }, makeDeps(baseSeed));
    expect(unread.rows.every((r) => r.unreadCount > 0)).toBe(true);
    expect(unread.rows.map((r) => r.contactId ?? r.phone).sort()).toEqual(
      ['+14049824978', 'c-unread'].sort(),
    );

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25, userId: 'u-1' }, makeDeps(baseSeed));
    expect(unknown.rows.every((r) => r.needsTriage)).toBe(true);
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']);

    const mine = await aggregateInbox({ filter: 'mine', limit: 25, userId: 'u-1' }, makeDeps(baseSeed));
    expect(mine.rows.map((r) => r.contactId)).toEqual(['c-mine']);
  });

  it('caseContext present {caseId,label} when the representative conversation has a caseId', async () => {
    const deps = makeDeps({
      contacts: [{ contactId: 'c-1', type: 'tenant', phone: '+15550000001' }],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: '2026-06-12T10:00:00.000Z', caseId: 'case-9' }),
      ],
      cases: { 'case-9': { stage: 'touring' } },
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);
    expect(page.rows[0]!.caseContext).toEqual({ caseId: 'case-9', label: 'Touring' });
  });

  it('assignment resolves {userId,name} from the users repo when assigned; omitted when unassigned', async () => {
    const deps = makeDeps({
      contacts: [
        { contactId: 'c-assigned', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-free', type: 'tenant', phone: '+15550000002' },
      ],
      conversations: [
        conv({ conversationId: 'conv-assigned', participant_phone: '+15550000001', last_activity_at: '2026-06-12T10:00:00.000Z', assignment: 'u-9' }),
        conv({ conversationId: 'conv-free', participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z' }),
      ],
      users: { 'u-9': { name: 'Val Agent' } },
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, deps);
    const byId = Object.fromEntries(page.rows.map((r) => [r.contactId, r]));
    expect(byId['c-assigned']!.assignment).toEqual({ userId: 'u-9', name: 'Val Agent' });
    expect(byId['c-free']!.assignment).toBeUndefined();
  });
});

describe('aggregateInbox — cursor paging (split-proof)', () => {
  // Seed: contact c-1's NEWEST conversation is at T10; it ALSO has an OLDER
  // conversation at T3. Several single-conversation contacts fill T9..T4 so the
  // page-1 boundary (limit 3) falls between c-1's two conversations.
  function splitSeed(): Seed {
    return {
      contacts: [
        { contactId: 'c-1', type: 'tenant', phone: '+15550000001', phones: [
          { phone: '+15550000001', primary: true },
          { phone: '+15550000011', primary: false },
        ] },
        { contactId: 'c-2', type: 'tenant', phone: '+15550000002' },
        { contactId: 'c-3', type: 'tenant', phone: '+15550000003' },
        { contactId: 'c-4', type: 'tenant', phone: '+15550000004' },
        { contactId: 'c-5', type: 'tenant', phone: '+15550000005' },
      ],
      conversations: [
        conv({ conversationId: 'conv-1-new', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z' }), // c-1 newest (T10)
        conv({ conversationId: 'conv-2', participant_phone: '+15550000002', last_activity_at: '2026-06-09T10:00:00.000Z' }), // T9
        conv({ conversationId: 'conv-3', participant_phone: '+15550000003', last_activity_at: '2026-06-08T10:00:00.000Z' }), // T8
        conv({ conversationId: 'conv-4', participant_phone: '+15550000004', last_activity_at: '2026-06-07T10:00:00.000Z' }), // T7
        conv({ conversationId: 'conv-5', participant_phone: '+15550000005', last_activity_at: '2026-06-06T10:00:00.000Z' }), // T6
        conv({ conversationId: 'conv-1-old', participant_phone: '+15550000011', last_activity_at: '2026-06-03T10:00:00.000Z' }), // c-1 older (T3)
      ],
    };
  }

  it('a contact emitted on page 1 (its newest conv) does NOT reappear on page 2 even though it has an older conv in the page-2 window', async () => {
    const p1 = await aggregateInbox({ filter: 'all', limit: 3, userId: 'u-1' }, makeDeps(splitSeed()));
    const p2 = await aggregateInbox({ filter: 'all', limit: 3, cursor: p1.nextCursor!, userId: 'u-1' }, makeDeps(splitSeed()));
    const ids = [...p1.rows, ...p2.rows].map((r) => r.contactId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate contact across pages
    expect(ids).toContain('c-1');
    // c-1 surfaces on page 1 at its NEWEST conversation, never again.
    expect(p1.rows.map((r) => r.contactId)).toContain('c-1');
  });

  it('nextCursor is null when the conversation stream is exhausted', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25, userId: 'u-1' }, makeDeps(splitSeed()));
    expect(page.nextCursor).toBeNull();
  });

  it('paging yields every contact exactly once across all pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    // Bounded loop guard.
    for (let i = 0; i < 20; i++) {
      const page = await aggregateInbox(
        { filter: 'all', limit: 2, userId: 'u-1', ...(cursor !== undefined && { cursor }) },
        makeDeps(splitSeed()),
      );
      for (const r of page.rows) seen.push(r.contactId!);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen.sort()).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a malformed cursor is rejected (the route maps it to 400, never a 500)', async () => {
    await expect(
      aggregateInbox({ filter: 'all', limit: 25, cursor: 'not-base64-json!!!', userId: 'u-1' }, makeDeps(splitSeed())),
    ).rejects.toMatchObject({ name: 'InboxBadRequestError' });
  });
});
