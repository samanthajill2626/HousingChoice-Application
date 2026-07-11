// Task 1 (Contract C8) unit tests: the inbox read model's aggregator,
// `aggregateInbox`, driven DIRECTLY (no Express) against hand-built in-memory
// fakes that mirror the contractual repo semantics the aggregator relies on:
//   - conversationsRepo.listByLastActivity — newest-activity-first, honoring
//     limit + exclusiveStartKey, returning a raw lastEvaluatedKey (the cursor's
//     opaque payload) when the stream has more.
//   - conversationsRepo.findByParticipantPhone — every conversation on a number.
//   - contactsRepo.findByPhone — pointer-aware phone → contact resolution.
//   - contactsRepo.getById / messagesRepo.listByConversation (latest message) /
//     placementsRepo.getById - best-effort hydration.
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
  placements?: Record<string, { stage: string }>;
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
      // Mirrors the real repo: one relay status partition, newest-activity-first.
      // The in-memory walk never pages, so `truncated` is always false here.
      async listRelayGroups(status: 'open' | 'closed') {
        const items = seed.conversations
          .filter((c) => c.type === 'relay_group' && c.status === status)
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items, truncated: false };
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
    placementsRepo: {
      async getById(placementId: string) {
        const c = seed.placements?.[placementId];
        return c ? ({ placementId, stage: c.stage } as unknown) : undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
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

/**
 * A relay_group conversation, shaped like the well-formed live seed group
 * `conv-live-relay-group` (participants carry `name`; pool number fronts the
 * thread; owner is a tour/placement). NOT the malformed cast.ts fixtures.
 */
function relayConv(
  overrides: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  const poolNumber = overrides.pool_number ?? overrides.participant_phone ?? '+15550160001';
  return {
    status: 'open',
    type: 'relay_group',
    ai_mode: 'manual',
    participant_phone: poolNumber,
    pool_number: poolNumber,
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

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);

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

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);

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

  it('a type="unknown" CONTACT (untriaged inbound WITH a record) → needsTriage:true and appears under the "unknown" filter', async () => {
    // Regression: the seed models untriaged inbound as a type=unknown contact, so
    // findByPhone resolves it (needsTriage was hardcoded false for contact rows) →
    // it was excluded from the "unknown" filter even though it needs triage.
    const contact: ContactItem = {
      contactId: 'c-unk',
      type: 'unknown',
      firstName: 'Alexis',
      lastName: 'Monroe',
      phone: '+15550009999',
      phones: [{ phone: '+15550009999', primary: true }],
    };
    const deps = makeDeps({
      contacts: [contact],
      conversations: [
        conv({ conversationId: 'conv-u', participant_phone: '+15550009999', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1, type: 'unknown_1to1' }),
      ],
    });

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(all.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-unk', role: 'unknown', needsTriage: true });

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(unknown.rows).toHaveLength(1);
    expect(unknown.rows[0]!.contactId).toBe('c-unk');
  });

  it('relay_group conversations now surface as a kind:"relay_group" row alongside 1:1 rows', async () => {
    const deps = makeDeps({
      contacts: [],
      conversations: [
        relayConv({
          conversationId: 'conv-live-relay-group',
          pool_number: '+15550160001',
          last_activity_at: '2026-06-12T10:00:00.000Z',
          participants: [
            { contactId: 'c-a', phone: '+15550000101', name: 'Diana Osei' },
            { contactId: 'c-b', phone: '+15550000102', name: 'Gloria Mensah' },
          ],
          owner: { type: 'tour', id: 'tour-1' },
          last_message_preview: '[AUTO] Tour group opened.',
          unread_count: 2,
        }),
        conv({ conversationId: 'conv-y', participant_phone: '+14049824978', last_activity_at: '2026-06-11T10:00:00.000Z', type: 'unknown_1to1' }),
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);

    expect(page.rows).toHaveLength(2);
    const relay = page.rows.find((r) => r.kind === 'relay_group')!;
    expect(relay).toMatchObject({
      kind: 'relay_group',
      conversationId: 'conv-live-relay-group',
      name: 'With Diana Osei & Gloria Mensah', // member names win the label
      unreadCount: 2,
      preview: '[AUTO] Tour group opened.',
      status: 'open',
      owner: { type: 'tour', id: 'tour-1' },
      needsTriage: false,
    });
    // Relay rows carry NO phone / channel / direction.
    expect(relay.phone).toBeUndefined();
    expect(relay.channel).toBeUndefined();
    expect(relay.direction).toBeUndefined();
  });

  it('relay label precedence: member names → placement_tag → formatted pool number → "Group text"', async () => {
    const base = { last_activity_at: '2026-06-12T10:00:00.000Z' };
    const tagOnly = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [],
      conversations: [relayConv({ conversationId: 'r-tag', pool_number: '+15550160001', placement_tag: '123 Maple tour', ...base })],
    }));
    expect(tagOnly.rows[0]!.name).toBe('123 Maple tour');

    const poolOnly = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [],
      conversations: [relayConv({ conversationId: 'r-pool', pool_number: '+15550160001', ...base })],
    }));
    // formatPhoneForDisplay renders the pool number.
    expect(poolOnly.rows[0]!.name).toBe('(555) 016-0001');

    const emptyGroup = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps({
      contacts: [],
      // No members, no tag, no pool number → the "Group text" fallback.
      conversations: [relayConv({ conversationId: 'r-bare', pool_number: '', participant_phone: 'x', ...base })],
    }));
    expect(emptyGroup.rows[0]!.name).toBe('Group text');
  });

  it('relay rows merge-sort with contact/unknown rows by last_activity_at (newest first)', async () => {
    const deps = makeDeps({
      contacts: [
        { contactId: 'c-1', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-2', type: 'tenant', phone: '+15550000002' },
      ],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: '2026-06-14T10:00:00.000Z' }), // newest
        relayConv({ conversationId: 'r-mid', pool_number: '+15550160001', last_activity_at: '2026-06-13T10:00:00.000Z',
          participants: [{ contactId: 'c-x', phone: '+15550000201', name: 'Keisha' }] }),
        conv({ conversationId: 'conv-2', participant_phone: '+15550000002', last_activity_at: '2026-06-12T10:00:00.000Z' }), // oldest
      ],
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows.map((r) => r.contactId ?? r.conversationId)).toEqual(['c-1', 'r-mid', 'c-2']);
  });

  it('relay filter matrix: in "all"+"unread" (when unread>0); NEVER in "unknown"', async () => {
    const seed: Seed = {
      contacts: [{ contactId: 'c-unk', type: 'unknown', phone: '+14049824978' }],
      conversations: [
        relayConv({ conversationId: 'r-unread', pool_number: '+15550160001', last_activity_at: '2026-06-14T10:00:00.000Z', unread_count: 3,
          participants: [{ contactId: 'c-x', phone: '+15550000201', name: 'Keisha' }] }),
        relayConv({ conversationId: 'r-read', pool_number: '+15550160002', last_activity_at: '2026-06-13T10:00:00.000Z',
          participants: [{ contactId: 'c-y', phone: '+15550000202', name: 'Lars' }] }),
        conv({ conversationId: 'conv-unk', participant_phone: '+14049824978', last_activity_at: '2026-06-12T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 }),
      ],
    };

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(seed));
    expect(all.rows.filter((r) => r.kind === 'relay_group').map((r) => r.conversationId).sort())
      .toEqual(['r-read', 'r-unread']);

    const unread = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(seed));
    // r-unread (unread 3) qualifies; r-read (unread 0) does not.
    expect(unread.rows.filter((r) => r.kind === 'relay_group').map((r) => r.conversationId)).toEqual(['r-unread']);

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    // NO relay row ever appears under "unknown" - only the untriaged 1:1.
    expect(unknown.rows.every((r) => r.kind !== 'relay_group')).toBe(true);
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']);
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

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);

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

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    const byId = Object.fromEntries(page.rows.map((r) => [r.contactId, r]));

    expect(byId['c-sms']).toMatchObject({ channel: 'sms', direction: 'inbound', preview: 'hi there' });
    expect(byId['c-mms']).toMatchObject({ channel: 'mms', direction: 'outbound' });
    expect(byId['c-call']).toMatchObject({ channel: 'call', direction: 'inbound' });
  });

  it('filter "unread" keeps only unreadCount>0; "unknown" keeps only needsTriage', async () => {
    const baseSeed: Seed = {
      contacts: [
        { contactId: 'c-read', type: 'tenant', phone: '+15550000001' },
        { contactId: 'c-unread', type: 'tenant', phone: '+15550000002' },
      ],
      conversations: [
        conv({ conversationId: 'conv-read', participant_phone: '+15550000001', last_activity_at: '2026-06-10T10:00:00.000Z', unread_count: 0 }),
        conv({ conversationId: 'conv-unread', participant_phone: '+15550000002', last_activity_at: '2026-06-11T10:00:00.000Z', unread_count: 4 }),
        conv({ conversationId: 'conv-unk', participant_phone: '+14049824978', last_activity_at: '2026-06-09T10:00:00.000Z', type: 'unknown_1to1', unread_count: 1 }),
      ],
    };

    const unread = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(baseSeed));
    expect(unread.rows.every((r) => r.unreadCount > 0)).toBe(true);
    expect(unread.rows.map((r) => r.contactId ?? r.phone).sort()).toEqual(
      ['+14049824978', 'c-unread'].sort(),
    );

    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(baseSeed));
    expect(unknown.rows.every((r) => r.needsTriage)).toBe(true);
    expect(unknown.rows.map((r) => r.phone)).toEqual(['+14049824978']);
  });

  it('placementContext present {placementId,label} when the representative conversation has a placementId', async () => {
    const deps = makeDeps({
      contacts: [{ contactId: 'c-1', type: 'tenant', phone: '+15550000001' }],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: '2026-06-12T10:00:00.000Z', placementId: 'placement-9' }),
      ],
      placements: { 'placement-9': { stage: 'awaiting_inspection' } },
    });

    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows[0]!.placementContext).toEqual({ placementId: 'placement-9', label: 'Awaiting inspection' });
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
    const p1 = await aggregateInbox({ filter: 'all', limit: 3 }, makeDeps(splitSeed()));
    const p2 = await aggregateInbox({ filter: 'all', limit: 3, cursor: p1.nextCursor! }, makeDeps(splitSeed()));
    const ids = [...p1.rows, ...p2.rows].map((r) => r.contactId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate contact across pages
    expect(ids).toContain('c-1');
    // c-1 surfaces on page 1 at its NEWEST conversation, never again.
    expect(p1.rows.map((r) => r.contactId)).toContain('c-1');
  });

  it('nextCursor is null when the conversation stream is exhausted', async () => {
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(splitSeed()));
    expect(page.nextCursor).toBeNull();
  });

  it('paging yields every contact exactly once across all pages', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    // Bounded loop guard.
    for (let i = 0; i < 20; i++) {
      const page = await aggregateInbox(
        { filter: 'all', limit: 2, ...(cursor !== undefined && { cursor }) },
        makeDeps(splitSeed()),
      );
      for (const r of page.rows) seen.push(r.contactId!);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen.sort()).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'c-5']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('relay rows are paging-safe: emitted ONCE (first page only), never dropped, never double-served', async () => {
    // Four single-number contacts + two relay groups; page through at limit=2.
    // Relay rows are additive on page 1 only, so across all pages each relay
    // group and each contact must appear EXACTLY once (no split / no duplicate /
    // no drop).
    function mixedSeed(): Seed {
      return {
        contacts: [
          { contactId: 'c-1', type: 'tenant', phone: '+15550000001' },
          { contactId: 'c-2', type: 'tenant', phone: '+15550000002' },
          { contactId: 'c-3', type: 'tenant', phone: '+15550000003' },
          { contactId: 'c-4', type: 'tenant', phone: '+15550000004' },
        ],
        conversations: [
          conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: '2026-06-14T10:00:00.000Z' }), // T10
          relayConv({ conversationId: 'r-1', pool_number: '+15550160001', last_activity_at: '2026-06-13T22:00:00.000Z', // T9.5
            participants: [{ contactId: 'c-x', phone: '+15550000201', name: 'Keisha' }] }),
          conv({ conversationId: 'conv-2', participant_phone: '+15550000002', last_activity_at: '2026-06-13T10:00:00.000Z' }), // T9
          conv({ conversationId: 'conv-3', participant_phone: '+15550000003', last_activity_at: '2026-06-12T10:00:00.000Z' }), // T8
          conv({ conversationId: 'conv-4', participant_phone: '+15550000004', last_activity_at: '2026-06-11T10:00:00.000Z' }), // T7
          relayConv({ conversationId: 'r-2', pool_number: '+15550160002', last_activity_at: '2026-06-10T22:00:00.000Z', // T6.5
            participants: [{ contactId: 'c-y', phone: '+15550000202', name: 'Lars' }] }),
        ],
      };
    }

    const seen: string[] = [];
    const relayIdsByPage: string[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await aggregateInbox(
        { filter: 'all', limit: 2, ...(cursor !== undefined && { cursor }) },
        makeDeps(mixedSeed()),
      );
      for (const r of page.rows) seen.push((r.contactId ?? r.conversationId)!);
      relayIdsByPage.push(page.rows.filter((r) => r.kind === 'relay_group').map((r) => r.conversationId!));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }

    // Every contact AND every relay group appears exactly once — no drop, no dup.
    expect(seen.slice().sort()).toEqual(['c-1', 'c-2', 'c-3', 'c-4', 'r-1', 'r-2']);
    expect(new Set(seen).size).toBe(seen.length);
    // Relay rows are confined to the FIRST page; every later page has none.
    expect(relayIdsByPage[0]!.slice().sort()).toEqual(['r-1', 'r-2']);
    for (const relayIds of relayIdsByPage.slice(1)) expect(relayIds).toEqual([]);
  });

  it('a malformed cursor is rejected (the route maps it to 400, never a 500)', async () => {
    await expect(
      aggregateInbox({ filter: 'all', limit: 25, cursor: 'not-base64-json!!!' }, makeDeps(splitSeed())),
    ).rejects.toMatchObject({ name: 'InboxBadRequestError' });
  });
});
