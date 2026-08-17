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
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateInbox,
  countUnreadRows,
  InboxBadRequestError,
  type InboxPage,
  type InboxRouterDeps,
  type InboxRow,
} from '../src/routes/inbox.js';
import {
  UNREAD_DELETED_PROBE_LIMIT,
  UNREAD_DELETED_PROBE_WARN,
} from '../src/lib/unreadFeed.js';
import { GROUP_TEXT_STATUS, type ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface Seed {
  /**
   * THE BASE TABLE: what `getById` and the 'open'-partition pager see, and the
   * default backing for both projections below.
   */
  conversations: ConversationItem[];
  contacts: ContactItem[];
  /** Latest message per conversationId (drives channel/direction/preview). */
  latestMessage?: Record<string, Partial<MessageItem>>;
  placements?: Record<string, { stage: string }>;
  participantConversationLookupError?: Error;
  /**
   * The `byUnread` GSI's own image, when it must DIFFER from the base table.
   * Spec section 6 makes the three read tiers independently stale, and the
   * unread page's hydration exists precisely to correct the difference: an index
   * entry can still say "unread" after the stored item has been read. Default
   * (absent) = the index agrees with the base table, which is the ordinary case.
   */
  unreadIndexProjection?: ConversationItem[];
  /**
   * The `byParticipantPhone`/`byParticipantEmail` image, when it must DIFFER
   * from the base table. These lag INDEPENDENTLY of byUnread, which is how a
   * candidate's fresh unread SUM can come back 0 and drop a row the index just
   * offered. Default (absent) = agrees with the base table.
   */
  participantProjection?: ConversationItem[];
}

interface InboxCallCounts {
  queryUnreadPage: number;
  findByPhone: number;
  findByParticipantPhone: number;
  listByConversation: number;
  getPlacementById: number;
}

function emptyCallCounts(): InboxCallCounts {
  return {
    queryUnreadPage: 0,
    findByPhone: 0,
    findByParticipantPhone: 0,
    listByConversation: 0,
    getPlacementById: 0,
  };
}

/**
 * A minimal deps object backed by in-memory arrays/maps mirroring the real
 * repos' contractual semantics. listByLastActivity encodes its paging position
 * as a `{ idx }` key (the raw LastEvaluatedKey the route base64s into a cursor).
 */
function makeDeps(
  seed: Seed,
  calls?: InboxCallCounts,
  logger?: InboxRouterDeps['logger'],
  routerOpts?: { unreadWalkLimit?: number },
): InboxRouterDeps {
  // Newest-activity-first total order over the OPEN conversations, the by
  // LastActivity GSI's descending sort.
  const ordered = [...seed.conversations]
    .filter((c) => c.status === 'open')
    .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
  /** The participant GSIs' image (see Seed.participantProjection). */
  const participantView = seed.participantProjection ?? seed.conversations;

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
    ...(logger !== undefined && { logger }),
    ...(routerOpts?.unreadWalkLimit !== undefined && {
      unreadWalkLimit: routerOpts.unreadWalkLimit,
    }),
    conversationsRepo: {
      async getById(conversationId: string) {
        return seed.conversations.find((c) => c.conversationId === conversationId);
      },
      // The sparse byUnread index. NOTE the deliberate difference from
      // listByLastActivity below: that one models paging as an opaque `{ idx }`
      // POSITION, which cannot express a resume across rows sharing one
      // last_activity_at. The unread index keys on the real
      // (last_activity_at DESC, conversationId DESC) tuple - see
      // helpers/unreadIndexFake.ts - so equal timestamps page correctly.
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        if (calls !== undefined) calls.queryUnreadPage += 1;
        return queryUnreadPageFromItems(seed.unreadIndexProjection ?? seed.conversations, opts);
      },
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
        if (calls !== undefined) calls.findByParticipantPhone += 1;
        if (seed.participantConversationLookupError !== undefined) {
          throw seed.participantConversationLookupError;
        }
        return participantView.filter((c) => c.participant_phone === phone);
      },
      // A18: the unread collector resolves by phone and THEN by email, and
      // conversationsForContact iterates a contact's emails too - so an absent
      // email finder is a RUNTIME TypeError, not a compile error, in this cast
      // fake. Modeled rather than omitted.
      async findByParticipantEmail(email: string) {
        if (seed.participantConversationLookupError !== undefined) {
          throw seed.participantConversationLookupError;
        }
        return participantView.filter((c) => c.participant_email === email);
      },
      // Mirrors the real repo: one relay status partition, newest-activity-first.
      // The in-memory walk never pages, so `truncated` is always false here.
      async listRelayGroups(status: 'open' | 'closed') {
        const items = seed.conversations
          .filter((c) => c.type === 'relay_group' && c.status === status)
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items, truncated: false };
      },
      // The group_open partition - a THIRD, disjoint source (S4). These fixtures
      // seed no group threads; the source's own behavior is covered by
      // inboxGroups.test.ts. Modeled (not omitted) so the aggregator's real call
      // runs here too: a production regression that stopped guarding the group
      // read must not pass because the fake happened to lack the method.
      async listGroupTexts({ limit }: { limit?: number; cursor?: string } = {}) {
        const items = seed.conversations
          .filter((c) => c.type === 'group_text')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1))
          .slice(0, limit ?? 50);
        return { items, truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        if (calls !== undefined) calls.findByPhone += 1;
        return contactByPhone(phone);
      },
      // A18 again: layer 2 falls through to this whenever findByPhone misses.
      async findByEmail(email: string) {
        return seed.contacts.find((c) => {
          if (c.phone_ref === true) return false;
          const emails = Array.isArray(c.emails) && c.emails.length > 0
            ? c.emails.map((e) => e.email)
            : typeof c.email === 'string'
              ? [c.email]
              : [];
          return emails.includes(email);
        });
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        if (calls !== undefined) calls.listByConversation += 1;
        const latest = seed.latestMessage?.[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById(placementId: string) {
        if (calls !== undefined) calls.getPlacementById += 1;
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
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts): the
    // sparse byUnread index keys on `unread_flag`, so a fixture with unread and
    // no flag is invisible to this file's own queryUnreadPage. Overridable below.
    ...unreadFlagFor(overrides),
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
    // FLAG IFF COUNT>0 - same derivation as conv() above.
    ...unreadFlagFor(overrides),
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

  it('a partner CONTACT -> kind:"contact", role:"partner", needsTriage:false (A2 parity)', async () => {
    const contact: ContactItem = {
      contactId: 'c-partner',
      type: 'partner',
      firstName: 'Casey',
      lastName: 'Worker',
      phone: '+15550008888',
      phones: [{ phone: '+15550008888', primary: true }],
    };
    const deps = makeDeps({
      contacts: [contact],
      conversations: [
        conv({ conversationId: 'conv-p', participant_phone: '+15550008888', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1, type: 'partner_1to1' }),
      ],
    });

    const all = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(all.rows[0]).toMatchObject({ kind: 'contact', contactId: 'c-partner', role: 'partner', needsTriage: false });

    // A resolved partner is NOT an untriaged unknown -> excluded from "unknown".
    const unknown = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(unknown.rows).toHaveLength(0);
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

  it('relay label precedence: member names -> placement_tag -> formatted pool number -> "Relay group"', async () => {
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
      // No members, no tag, no pool number -> the "Relay group" fallback.
      conversations: [relayConv({ conversationId: 'r-bare', pool_number: '', participant_phone: 'x', ...base })],
    }));
    expect(emptyGroup.rows[0]!.name).toBe('Relay group');
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

  // The four tests below used to pin the RETIRED contract: `filter=unread`
  // walked the 'open' partition and rejected read rows one by one, so the
  // cheapness being asserted was "how early the walk gave up". Spec 4.5 makes
  // unread INDEX-FED, so the same fixtures now assert a stronger property - a
  // read row is not in the sparse index at all, so nothing downstream is even
  // asked about it - with the SAME exhaustive whole-object call assertion.
  it('a read no-contact row is not in the unread index: no contact resolution, no message hydration', async () => {
    const calls = emptyCallCounts();
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps({
        contacts: [],
        conversations: [
          conv({
            conversationId: 'conv-read-unknown',
            participant_phone: '+14045550101',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            type: 'unknown_1to1',
            unread_count: 0,
          }),
        ],
        latestMessage: {
          'conv-read-unknown': { type: 'sms', direction: 'inbound', body: 'already read' },
        },
      }, calls),
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // THE ZERO-UNREAD COST CONTRACT (spec 4.4/4.5): exactly ONE index query and
    // no hydration read of any kind. Whole-object toEqual, so a future read
    // cannot slip in unnoticed.
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 0,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
  });

  it('NEWEST-CONVERSATION GUARD REMOVED: an unread OLDER thread renders the row at the newest (read) thread', async () => {
    const calls = emptyCallCounts();
    const contact: ContactItem = {
      contactId: 'contact-multi',
      type: 'tenant',
      phone: '+14045550102',
      phones: [
        { phone: '+14045550102', primary: true },
        { phone: '+14045550103', primary: false },
      ],
    };
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps({
        contacts: [contact],
        conversations: [
          conv({
            conversationId: 'conv-new-read',
            participant_phone: '+14045550102',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 0,
          }),
          conv({
            conversationId: 'conv-old-unread',
            participant_phone: '+14045550103',
            last_activity_at: '2026-06-11T10:00:00.000Z',
            unread_count: 2,
          }),
        ],
      }, calls),
    );

    // The index offers only the OLDER thread (the newer one is read, so it is
    // not in the sparse index). Under the pager's newest-conversation identity
    // guard that candidate would have been dropped - "this is not the contact's
    // newest conversation" - and the contact would vanish from Unread entirely.
    // Row identity is the seen-set now, so the row renders...
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'contact-multi', unreadCount: 2 });
    // ...and `newestOf` still picks the REPRESENTATION: the displayed activity
    // is the NEWEST overall thread's, not the unread one's.
    expect(page.rows[0]!.lastActivityAt).toBe('2026-06-12T10:00:00.000Z');
    // Hydration is bounded: both of the contact's numbers resolved once, and
    // exactly one latest-message read (the representative conversation).
    expect(calls.findByParticipantPhone).toBe(2);
    expect(calls.listByConversation).toBe(1);
  });

  it('a fully-read contact is not in the unread index: no contact, conversation, message or placement read', async () => {
    const calls = emptyCallCounts();
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps({
        contacts: [{ contactId: 'contact-read', type: 'tenant', phone: '+14045550104' }],
        conversations: [
          conv({
            conversationId: 'conv-read',
            participant_phone: '+14045550104',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 0,
            placementId: 'placement-read',
          }),
        ],
        latestMessage: {
          'conv-read': { type: 'sms', direction: 'inbound', body: 'already read' },
        },
        placements: { 'placement-read': { stage: 'searching' } },
      }, calls),
    );

    expect(page.rows).toEqual([]);
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 0,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
  });

  it('rejects a resolved non-unknown contact before conversation and message hydration', async () => {
    const calls = emptyCallCounts();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({
        contacts: [{ contactId: 'contact-tenant', type: 'tenant', phone: '+14045550105' }],
        conversations: [
          conv({
            conversationId: 'conv-tenant',
            participant_phone: '+14045550105',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 1,
            placementId: 'placement-tenant',
          }),
        ],
        latestMessage: {
          'conv-tenant': { type: 'sms', direction: 'inbound', body: 'known tenant' },
        },
        placements: { 'placement-tenant': { stage: 'searching' } },
      }, calls),
    );

    expect(page.rows).toEqual([]);
    expect(calls).toEqual({
      queryUnreadPage: 0,
      findByPhone: 1,
      findByParticipantPhone: 0,
      listByConversation: 0,
      getPlacementById: 0,
    });
  });

  it('keeps a failed contact-conversation lookup excluded from unread without downstream hydration', async () => {
    const calls = emptyCallCounts();
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps({
        contacts: [{ contactId: 'contact-degraded', type: 'tenant', phone: '+14045550106' }],
        conversations: [
          conv({
            conversationId: 'conv-degraded',
            participant_phone: '+14045550106',
            last_activity_at: '2026-06-12T10:00:00.000Z',
            unread_count: 3,
          }),
        ],
        latestMessage: {
          'conv-degraded': { type: 'sms', direction: 'inbound', body: 'not trustworthy' },
        },
        participantConversationLookupError: new Error('lookup unavailable'),
      }, calls),
    );

    // The index offers the thread and the contact resolves, but hydration's
    // contact-conversation read fails, degrades to an empty thread set, and the
    // fresh unread SUM is therefore 0 - so the row DROPS rather than rendering
    // an unread row whose count nobody could compute.
    expect(page.rows).toEqual([]);
    // ...and the page says so. A failed read is a LAG-shaped drop (the fresh
    // set does not contain the thread the index just offered), so it gets the
    // one end-of-request retry - hence TWO participant reads - and, still
    // unresolved, ends the page `truncated` instead of claiming a natural end
    // while the badge counts the row (adversarial r2 finding 4).
    expect(page.truncated).toBe(true);
    expect(calls).toEqual({
      queryUnreadPage: 1,
      findByPhone: 1,
      findByParticipantPhone: 2,
      // Still NO downstream hydration: the drop happens before any of it.
      listByConversation: 0,
      getPlacementById: 0,
    });
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

describe('aggregateInbox — deleted-contact resurfacing (2026-08-03 spec)', () => {
  const DELETED_AT = '2026-08-01T00:00:00.000Z';
  const BEFORE = '2026-07-30T00:00:00.000Z';
  const AFTER = '2026-08-02T00:00:00.000Z';

  /** Newest of all: used as the empty-conversation last_activity_at. */
  const LATER = '2026-08-03T00:00:00.000Z';

  const deletedContact = (over: Partial<ContactItem> = {}): ContactItem => ({
    contactId: 'c-del',
    type: 'tenant',
    firstName: 'Dana',
    lastName: 'Doe',
    phone: '+15550000001',
    deleted_at: DELETED_AT,
    ...over,
  });

  /**
   * The same stub with the deletion stamp REMOVED — a properly-built live
   * contact (never an `undefined as unknown as string` cast, which would type a
   * value the repo can never produce: `deleted_at` is optional, not nullable).
   */
  const liveContact = (over: Partial<ContactItem> = {}): ContactItem => {
    const c = deletedContact(over);
    delete c.deleted_at;
    return c;
  };

  it('surfaces a deleted contact with an unread inbound newer than deleted_at (deleted: true)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-del',
      deleted: true,
      unreadCount: 1,
      preview: 'im back',
    });
  });

  it('hides a deleted contact with zero unread (post-deletion inbound already read)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 0 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('hides a deleted contact whose unread inbound PREDATES the deletion', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: BEFORE, unread_count: 2 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'old unread', created_at: BEFORE },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('hides a deleted contact whose latest message is OUTBOUND (even post-deletion, even with unread)', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'outbound', body: 'scheduled nudge', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it('a surfaced deleted row passes the unread filter', async () => {
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ contactId: 'c-del', deleted: true });
  });

  it('a live (restored) contact row never carries the deleted field', async () => {
    const deps = makeDeps({
      contacts: [liveContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).not.toHaveProperty('deleted');
  });

  // --- Multi-conversation contacts (the rule is PER CONVERSATION) -------------
  // A contact owns one conversation per participant key, so "unread" and
  // "newest post-deletion inbound" can live on DIFFERENT threads. Mixing a
  // cross-thread unread SUM with a newest-thread-only freshness probe breaks the
  // spec rule both ways — these three pin the per-conversation predicate.

  it('STUCK ROW: pre-deletion unread on an older thread does NOT keep the row up once the fresh inbound is read', async () => {
    // Staff read the post-deletion inbound from a placement/tour pane, which
    // marks only THAT conversation read. The older thread still carries
    // pre-deletion unread, so a cross-thread unreadSum stays > 0 forever.
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-old', participant_phone: '+15550000001', last_activity_at: BEFORE, unread_count: 2 }),
        conv({ conversationId: 'conv-new', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 0 }),
      ],
      latestMessage: {
        'conv-old': { type: 'sms', direction: 'inbound', body: 'old unread', created_at: BEFORE },
        'conv-new': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });

  it("EMPTY NEWEST: a brand-new empty conversation does not bury an older thread's unread post-deletion inbound", async () => {
    // conv-empty has the freshest last_activity_at but no messages, so it wins
    // the newest-conversation race for PRESENTATION while carrying no recency
    // signal of its own. The unread fresh inbound on conv-old must still surface.
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-old', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
        conv({ conversationId: 'conv-empty', participant_phone: '+15550000001', last_activity_at: LATER, unread_count: 0 }),
      ],
      latestMessage: {
        'conv-old': { type: 'sms', direction: 'inbound', body: 'im back', created_at: AFTER },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      kind: 'contact',
      contactId: 'c-del',
      deleted: true,
      unreadCount: 1,
      // Presentation still derives from the NEWEST conversation (the empty one):
      // fallback preview, its last_activity_at.
      preview: '',
      lastActivityAt: LATER,
    });
  });

  it('ABSENT created_at on the probed conversation never counts as new (stays hidden)', async () => {
    // The message row is readable but carries no created_at, so the freshness
    // comparison is unknowable — treat it as NOT new (this is the branch
    // contactSoftDelete.test.ts relies on for its message-less world).
    const deps = makeDeps({
      contacts: [deletedContact()],
      conversations: [
        conv({ conversationId: 'conv-1', participant_phone: '+15550000001', last_activity_at: AFTER, unread_count: 1 }),
      ],
      latestMessage: {
        'conv-1': { type: 'sms', direction: 'inbound', body: 'no timestamp' },
      },
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The INDEX-BACKED unread page (design 2026-08-16, spec 4.5).
//
// `filter=unread` no longer walks the 'open' partition rejecting read rows: it
// walks the sparse `byUnread` index, groups the stream into row candidates,
// hydrates them, and refills the page when hydration drops one. Paging is an
// exact scan position plus a SEEN-SET of already-emitted contactIds, both
// carried in a cursor of its own namespace.
// ---------------------------------------------------------------------------
describe('aggregateInbox - filter=unread over the byUnread index', () => {
  const T = (n: number): string => `2026-06-12T${String(n).padStart(2, '0')}:00:00.000Z`;

  /** A single-thread unread contact at activity `at`. */
  function unreadContact(id: string, phone: string, at: string): {
    contact: ContactItem;
    conversation: ConversationItem;
  } {
    return {
      contact: { contactId: id, type: 'tenant', phone },
      conversation: conv({
        conversationId: `conv-${id}`,
        participant_phone: phone,
        last_activity_at: at,
        unread_count: 1,
      }),
    };
  }

  /** N single-thread unread contacts in descending activity (index) order. */
  function unreadWorld(n: number): Seed {
    const contacts: ContactItem[] = [];
    const conversations: ConversationItem[] = [];
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.parse(T(12)) - i * 60_000).toISOString();
      const made = unreadContact(
        `c-${String(i).padStart(3, '0')}`,
        `+1404555${String(1000 + i)}`,
        at,
      );
      contacts.push(made.contact);
      conversations.push(made.conversation);
    }
    return { contacts, conversations };
  }

  const rowKeys = (page: { rows: InboxRow[] }): string[] =>
    page.rows.map((r) => r.contactId ?? r.phone ?? r.conversationId ?? '');

  /** A native group thread on the group_open partition. */
  function groupText(id: string, at: string, unread: number): ConversationItem {
    return {
      ...conv({
        conversationId: id,
        participant_phone: `+1404555${id.length}999`,
        last_activity_at: at,
        unread_count: unread,
      }),
      type: 'group_text',
      status: GROUP_TEXT_STATUS,
      participants: [
        { contactId: 'c-a', phone: '+14045551001', name: 'Ann Tenant' },
        { contactId: 'c-b', phone: '+14045551002', name: 'Bo Tenant' },
      ],
    };
  }

  it('is ONE unified newest-first stream: contacts, groups and relay interleave and page together', async () => {
    const seed: Seed = {
      contacts: [
        { contactId: 'c-a', type: 'tenant', phone: '+14045551001' },
        { contactId: 'c-b', type: 'tenant', phone: '+14045551002' },
      ],
      // Deliberately alternating kinds, so "the newest 3" can only be produced
      // by ONE merged stream - never by the old per-source additive merge.
      conversations: [
        groupText('gt-1', T(9), 1),
        conv({
          conversationId: 'conv-c-a',
          participant_phone: '+14045551001',
          last_activity_at: T(8),
          unread_count: 1,
        }),
        relayConv({ conversationId: 'relay-1', last_activity_at: T(7), unread_count: 2 }),
        groupText('gt-2', T(6), 3),
        conv({
          conversationId: 'conv-c-b',
          participant_phone: '+14045551002',
          last_activity_at: T(5),
          unread_count: 1,
        }),
      ],
    };

    const page1 = await aggregateInbox({ filter: 'unread', limit: 3 }, makeDeps(seed));
    expect(rowKeys(page1)).toEqual(['gt-1', 'c-a', 'relay-1']);
    expect(page1.rows.map((r) => r.kind)).toEqual(['group_text', 'contact', 'relay_group']);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.truncated).toBeUndefined();
    expect(page1.groupsTruncated).toBeUndefined();

    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 3, cursor: page1.nextCursor! },
      makeDeps(seed),
    );
    expect(rowKeys(page2)).toEqual(['gt-2', 'c-b']);
    expect(page2.nextCursor).toBeNull();

    // The union across the two pages is exact and duplicate-free.
    const union = [...rowKeys(page1), ...rowKeys(page2)];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual(['c-a', 'c-b', 'gt-1', 'gt-2', 'relay-1']);
  });

  it('a FULL page still mints a cursor (40 unread, limit 30 -> 30 + cursor, then 10 + null)', async () => {
    // The round-3 blocking case: an under-budget dataset must not report page
    // one with a null cursor merely because the raw scan had not exhausted.
    const seed = unreadWorld(40);
    const page1 = await aggregateInbox({ filter: 'unread', limit: 30 }, makeDeps(seed));
    expect(page1.rows).toHaveLength(30);
    expect(page1.nextCursor).not.toBeNull();
    expect(page1.truncated).toBeUndefined();

    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 30, cursor: page1.nextCursor! },
      makeDeps(seed),
    );
    expect(page2.rows).toHaveLength(10);
    expect(page2.nextCursor).toBeNull();

    const union = [...rowKeys(page1), ...rowKeys(page2)];
    expect(new Set(union).size).toBe(40);
  });

  it('FILL-OR-EXHAUST: a candidate whose fresh unread SUM is 0 is dropped and REPLACED', async () => {
    const calls = emptyCallCounts();
    const drop = unreadContact('c-drop', '+14045552001', T(10));
    const keep = unreadContact('c-keep', '+14045552002', T(9));
    const page = await aggregateInbox(
      { filter: 'unread', limit: 1 },
      makeDeps(
        {
          contacts: [drop.contact, keep.contact],
          // THE ORDINARY MARK-READ RACE, in its authoritative shape (fix wave 3,
          // adversarial r3 finding 1): the BASE TABLE says c-drop is read and
          // only the byUnread index is still behind. The fresh sum is 0, the row
          // drops, and the base-table discriminator confirms the drop is an
          // ANSWER - so nothing is retried and nothing is truncated.
          conversations: [
            { ...drop.conversation, unread_count: 0, unread_flag: undefined },
            keep.conversation,
          ],
          unreadIndexProjection: [drop.conversation, keep.conversation],
        },
        calls,
      ),
    );

    // The page comes back FULL, with the replacement - not one short.
    expect(rowKeys(page)).toEqual(['c-keep']);
    expect(page.nextCursor).not.toBeNull();
    // TWO collects: the first capped at maxRows 1 and then lost its only
    // candidate to hydration, so the loop went around for a refill.
    expect(calls.queryUnreadPage).toBe(2);
  });

  it('FILL-OR-EXHAUST: when every candidate drops and the supply exhausts -> [] and a null cursor', async () => {
    const a = unreadContact('c-x', '+14045552011', T(10));
    const b = unreadContact('c-y', '+14045552012', T(9));
    const page = await aggregateInbox(
      { filter: 'unread', limit: 25 },
      makeDeps({
        contacts: [a.contact, b.contact],
        // Both were genuinely READ (base table), with only the index behind -
        // the authoritative shape of the mark-read race (fix wave 3). This is
        // the fixture that keeps the lag rule NARROW: were every zero-sum drop
        // treated as lag, the end of an ordinary triage session would render the
        // inbox ERROR state, which is the C2 regression.
        conversations: [
          { ...a.conversation, unread_count: 0, unread_flag: undefined },
          { ...b.conversation, unread_count: 0, unread_flag: undefined },
        ],
        unreadIndexProjection: [a.conversation, b.conversation],
      }),
    );

    expect(page.rows).toEqual([]);
    // The empty-page invariant: no cursor, so the dashboard renders its
    // all-caught-up state rather than a Load more that returns nothing.
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBeUndefined();
  });

  it('the EXCLUDE SET accumulates ACROSS loop iterations: a re-met contact emits exactly one row', async () => {
    // c-multi owns two unread threads. Iteration 1 caps before reaching the
    // older one; iteration 2 meets it and must NOT emit a second row.
    const multi: ContactItem = {
      contactId: 'c-multi',
      type: 'tenant',
      phone: '+14045553001',
      phones: [
        { phone: '+14045553001', primary: true },
        { phone: '+14045553002', primary: false },
      ],
    };
    const dropped = unreadContact('c-drop', '+14045553003', T(9));
    const tail = unreadContact('c-tail', '+14045553004', T(7));
    const newer = conv({
      conversationId: 'conv-multi-new',
      participant_phone: '+14045553001',
      last_activity_at: T(10),
      unread_count: 1,
    });
    const older = conv({
      conversationId: 'conv-multi-old',
      participant_phone: '+14045553002',
      last_activity_at: T(8),
      unread_count: 1,
    });

    const seed: Seed = {
      contacts: [multi, dropped.contact, tail.contact],
      conversations: [newer, dropped.conversation, older, tail.conversation],
      // c-drop reads as already-read through the participant GSI, so iteration 1
      // keeps only ONE row and the loop has to go around - which is what walks
      // the stream onto c-multi's OLDER thread.
      participantProjection: [
        newer,
        { ...dropped.conversation, unread_count: 0 },
        older,
        tail.conversation,
      ],
    };

    const page = await aggregateInbox({ filter: 'unread', limit: 2 }, makeDeps(seed));

    expect(rowKeys(page)).toEqual(['c-multi', 'c-tail']);
    // The concrete failure this guards: two rows with the same React key on one
    // page, from one contact met in two different loop iterations.
    const keys = rowKeys(page);
    expect(new Set(keys).size).toBe(keys.length);
    // The single row still carries the contact-wide sum over BOTH threads.
    expect(page.rows.find((r) => r.contactId === 'c-multi')!.unreadCount).toBe(2);
  });

  /** Walk `filter=unread` with the dashboard's page size until the cursor dies. */
  async function pageThroughUnread(seed: Seed, pages: number): Promise<InboxPage[]> {
    const out: InboxPage[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < pages; i++) {
      const page: InboxPage = await aggregateInbox(
        { filter: 'unread', limit: 30, ...(cursor !== null && { cursor }) },
        makeDeps(seed),
      );
      out.push(page);
      cursor = page.nextCursor;
    }
    return out;
  }

  // CONFORMANCE FINDING 1. `truncated` names a NON-NATURAL end (spec 4.5 step 3):
  // rows were WITHHELD. The depth cap used to be evaluated ahead of consumedAll,
  // so it also fired on the natural last page of any unread feed past
  // SEEN_SET_MAX ids - and this test asserted that false positive. The pair below
  // is the discriminating one: identical mechanics, opposite supply, opposite
  // answer.
  it('DEPTH CAP: past SEEN_SET_MAX ids on a page that EXHAUSTED the supply is a natural end, NOT truncated', async () => {
    const seed = unreadWorld(101);
    const pages = await pageThroughUnread(seed, 4);

    expect(pages.map((p) => p.rows.length)).toEqual([30, 30, 30, 11]);
    // Pages 1-3 stay inside the cap (30/60/90 ids) and page normally.
    expect(pages.slice(0, 3).every((p) => p.nextCursor !== null)).toBe(true);
    expect(pages.slice(0, 3).every((p) => p.truncated === undefined)).toBe(true);
    // Page 4 pushes the seen-set to 101 - past SEEN_SET_MAX - so no cursor can be
    // minted. But it also CONSUMED THE WHOLE INDEX: nothing is behind it, so the
    // feed ended naturally and must not claim otherwise. Under the old ordering
    // this page said truncated, and an empty one (every candidate dropped in
    // hydration) rendered "We couldn't load your inbox." on a caught-up tab.
    expect(pages[3]!.nextCursor).toBeNull();
    expect(pages[3]!.truncated).toBeUndefined();
    // All 101 really were handed down - the natural-end claim is not a cover for
    // lost rows.
    expect(new Set(pages.flatMap((p) => rowKeys(p))).size).toBe(101);
  });

  it('DEPTH CAP: past SEEN_SET_MAX ids with supply REMAINING withholds rows and says truncated', async () => {
    // 130 unread contacts at limit 30: page 4 fills completely and takes the
    // seen-set to 120, past the cap - so the server can mint no cursor it would
    // itself accept while 10 contacts are still unreached. THAT is a truncation.
    const seed = unreadWorld(130);
    const pages = await pageThroughUnread(seed, 4);

    expect(pages.map((p) => p.rows.length)).toEqual([30, 30, 30, 30]);
    expect(pages.slice(0, 3).every((p) => p.truncated === undefined)).toBe(true);
    expect(pages[3]!.nextCursor).toBeNull();
    expect(pages[3]!.truncated).toBe(true);
    // The signal is load-bearing: 10 of the 130 are unreachable through the API,
    // which is exactly why the feed must not end silently.
    expect(new Set(pages.flatMap((p) => rowKeys(p))).size).toBe(120);
  });

  it('BUDGET: a spent raw-scan budget underfills the page, sets truncated AND still mints a cursor', async () => {
    const seed = unreadWorld(5);
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps(seed, undefined, undefined, { unreadWalkLimit: 2 }),
    );

    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    // CONFORMANCE C1 (planner ruling as spec author; spec 4.5 step 2 amended).
    // Returning null here DISCARDED a scanPosition the server had already paid
    // for, leaving Retry as the only affordance - and Retry re-runs the
    // identical prefix with a fresh budget, so it truncates identically. A
    // guaranteed non-recovery where paging gives a guaranteed one. `truncated`
    // is a SIGNAL layered on paging, not a substitute for it.
    expect(page.nextCursor).not.toBeNull();

    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 30, cursor: page.nextCursor! },
      makeDeps(seed),
    );
    expect(rowKeys(page2)).toEqual(['c-002', 'c-003', 'c-004']);
    expect(page2.nextCursor).toBeNull();
    expect(page2.truncated).toBeUndefined();
  });

  it('BADGE: a TRUNCATED ZERO count logs a rate-limited WARN (the silent zero is observable)', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never;
    const seed = unreadWorld(3);
    // The newest index entry is stale (flagged, stored count 0), so the single
    // raw item the budget buys yields no candidate: the badge answers 0 while
    // three unread rows sit behind it.
    seed.conversations.unshift({
      ...conv({
        conversationId: 'conv-stale-head-badge',
        participant_phone: '+14045554002',
        last_activity_at: T(23),
        unread_count: 0,
      }),
      unread_flag: 'unread',
    });

    const count = await countUnreadRows(
      makeDeps(seed, undefined, logger, { unreadWalkLimit: 1 }),
    );

    expect(count).toEqual({ unreadCount: 0, capped: false, truncated: true });
    // The client renders a truncated zero as NO BADGE, indistinguishable from
    // genuinely caught up. The UI affordance is out of scope for v1 (the issue
    // stays open), so the SERVER has to be the one that says it happened.
    const zeroWarns = warn.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'unread_badge_truncated_zero',
    );
    expect(zeroWarns).toHaveLength(1);
    expect(zeroWarns[0]![0]).toMatchObject({ scanned: 1 });
  });

  it('BUDGET: an empty page still says truncated when the budget dies before any row', async () => {
    const seed = unreadWorld(3);
    // The NEWEST index entry is stale (flagged, stored count 0), so the single
    // raw item the budget buys yields no candidate at all.
    seed.conversations.unshift({
      ...conv({
        conversationId: 'conv-stale-head',
        participant_phone: '+14045554001',
        last_activity_at: T(23),
        unread_count: 0,
      }),
      unread_flag: 'unread',
    });

    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps(seed, undefined, undefined, { unreadWalkLimit: 1 }),
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // Empty AND truncated is the one case the dashboard must NOT render as
    // "all caught up" - it renders the inbox error state instead.
    expect(page.truncated).toBe(true);
  });

  // CONFORMANCE N3. `scanPosition === undefined` means "no position to resume
  // from" - it does NOT mean "nothing was withheld". Reported as a natural end,
  // a feed with unread behind it renders "You're all caught up": the exact
  // silent-zero the truncated flag exists to prevent, in the one branch that
  // used to skip the question.
  it('BUDGET: a budget spent before ANYTHING was consumed still says truncated', async () => {
    const seed = unreadWorld(50);
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      // Budget 0: not one raw index item is scanned, so scanPosition never
      // advances and branch (a) takes the decision. In production the same
      // branch is reached by a queryUnreadPage that returns an empty page WITH
      // a LastEvaluatedKey.
      makeDeps(seed, undefined, undefined, { unreadWalkLimit: 0 }),
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // 50 unread contacts are sitting behind this answer.
    expect(page.truncated).toBe(true);
  });

  it('NATURAL END: an empty index reports no truncation (branch (a) is not blanket-truncated)', async () => {
    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps(unreadWorld(0)),
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // Genuinely caught up: nothing was withheld, so the dashboard must render
    // the empty state, not the error banner. The pair with the test above is
    // what makes `truncated = budgetSpent` a decision rather than a constant.
    expect(page.truncated).toBeUndefined();
  });

  it('STALE INDEX ROW: a point read drops a group/unknown row the index still lists as unread', async () => {
    const live = unreadContact('c-live', '+14045555001', T(6));
    const staleUnknown = conv({
      conversationId: 'conv-stale-unknown',
      participant_phone: '+14045555002',
      last_activity_at: T(10),
      type: 'unknown_1to1',
      unread_count: 0,
    });
    const staleGroup = groupText('gt-stale', T(9), 0);

    const page = await aggregateInbox(
      { filter: 'unread', limit: 25 },
      makeDeps({
        contacts: [live.contact],
        // The BASE table says both are read...
        conversations: [staleUnknown, staleGroup, live.conversation],
        // ...while the index image still carries them as unread (a lagging GSI
        // entry is stale in lockstep with its own projected attributes, so only
        // the point read can tell - which is why hydration does one for every
        // non-contact candidate).
        unreadIndexProjection: [
          { ...staleUnknown, unread_count: 2, unread_flag: 'unread' },
          { ...staleGroup, unread_count: 4, unread_flag: 'unread' },
          live.conversation,
        ],
      }),
    );

    expect(rowKeys(page)).toEqual(['c-live']);
  });

  /**
   * `hidden` deleted-contact threads (post-deletion OUTBOUND: each costs a
   * probe and resurfaces nobody) NEWEST in the index, with `live` ordinary
   * unread contacts behind them. The reviewers' A2 world.
   */
  function wallOfHiddenDeleted(hidden: number, live: number): Seed {
    const contacts: ContactItem[] = [];
    const conversations: ConversationItem[] = [];
    const latestMessage: Record<string, Partial<MessageItem>> = {};
    const DELETED_AT = '2026-06-01T00:00:00.000Z';
    for (let i = 0; i < hidden; i++) {
      const phone = `+1404555${String(6000 + i)}`;
      contacts.push({ contactId: `c-del-${i}`, type: 'tenant', phone, deleted_at: DELETED_AT });
      const id = `conv-del-${i}`;
      conversations.push(
        conv({
          conversationId: id,
          participant_phone: phone,
          last_activity_at: new Date(Date.parse(T(12)) - i * 60_000).toISOString(),
          unread_count: 1,
        }),
      );
      latestMessage[id] = {
        type: 'sms',
        direction: 'outbound',
        body: 'straggler',
        created_at: '2026-06-11T00:00:00.000Z',
      };
    }
    for (let i = 0; i < live; i++) {
      const made = unreadContact(
        `c-live-${String(i).padStart(2, '0')}`,
        `+1404555${String(7000 + i)}`,
        new Date(Date.parse(T(8)) - i * 60_000).toISOString(),
      );
      contacts.push(made.contact);
      conversations.push(made.conversation);
    }
    return { contacts, conversations, latestMessage };
  }

  it('PROBE BOUND: a wall of hidden deleted threads is skipped unprobed, and the LIVE rows behind it still render', async () => {
    // BLOCKING regression from adversarial r2 finding 2 / conformance r2 1.1:
    // fix wave 1 stopped the WALK at the bound, so this exact world returned
    // ZERO rows with a NULL cursor - the inbox failure state, with a Retry that
    // re-runs the identical deterministic prefix. Before that wave it returned
    // all five rows, expensively. Fix wave 2 bounds the PROBES: past the bound
    // a deleted-contact thread is treated as hidden without a read, and the
    // walk carries on to the live rows behind it.
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never;
    const seed = wallOfHiddenDeleted(27, 5);

    const badge = await countUnreadRows(makeDeps(seed, undefined, logger));
    // The five live rows are COUNTED, not lost behind the wall. The walk then
    // DRAINED, so this is a natural end and NOT a floor (fix wave 3,
    // adversarial r3 finding 2): the threads the bound refused to read are all
    // hidden ones, which no reader would have rendered anyway. The WARN below
    // is the operator's signal that the wall exists.
    expect(badge.unreadCount).toBe(5);
    expect(badge.capped).toBe(false);
    expect(badge.truncated).toBe(false);

    const page = await aggregateInbox(
      { filter: 'unread', limit: 25 },
      makeDeps(seed, undefined, logger),
    );
    expect(rowKeys(page)).toEqual([
      'c-live-00',
      'c-live-01',
      'c-live-02',
      'c-live-03',
      'c-live-04',
    ]);
    expect(page.truncated).toBeUndefined();

    // THE TRIPWIRE (adversarial r2 finding 7): attempted and skipped are
    // SEPARATE fields, so the operator can tell 26 residents from 2,600 - the
    // difference between "is this happening" and "how bad is it".
    const probeWarns = warn.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'unread_deleted_probe_tripwire',
    );
    expect(probeWarns.length).toBeGreaterThanOrEqual(1);
    expect(probeWarns[0]![0]).toMatchObject({
      probes: UNREAD_DELETED_PROBE_LIMIT,
      skipped: 27 - UNREAD_DELETED_PROBE_LIMIT,
      threshold: UNREAD_DELETED_PROBE_WARN,
    });
  });

  it('RESIDUE-ONLY AND CAUGHT UP: a DRAINED wall of hidden threads is a natural end, not a failure banner', async () => {
    // ADVERSARIAL r3 FINDING 2 (fix wave 3). Fix wave 2 made a skipped
    // (unprobed) deleted thread set `truncated` even on a walk that then
    // DRAINED its supply. An org whose index holds nothing but hidden residue
    // and is otherwise genuinely caught up therefore got `{0, truncated}` on the
    // badge and an empty truncated page - and Inbox.tsx gates its failure copy
    // on `serverRowCount === 0 && truncated`, so the Unread tab rendered "We
    // couldn't load your inbox." + Retry, permanently, over a deterministic
    // prefix that reproduces itself.
    //
    // THE RULE: a DRAINED stream is a NATURAL end regardless of skipped-hidden
    // deleted threads. The assumption made past the bound is "hidden", which is
    // the overwhelmingly likely truth inside a wall of confirmed-hidden threads,
    // and a hidden row is exactly what an empty page means. `truncated` stays
    // for budget-stopped and cap-related early ends. The operator signal moves
    // to the server WARN, which still fires below.
    const seed = wallOfHiddenDeleted(30, 0);

    const badge = await countUnreadRows(makeDeps(seed));
    expect(badge).toEqual({ unreadCount: 0, capped: false, truncated: false });

    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(seed));
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // The pair that decides the client: zero server rows + NO truncation is the
    // all-caught-up state (Inbox.test.tsx, "keeps the all-caught-up copy on an
    // empty unread page that was NOT truncated"), not the error banner.
    expect(page.truncated).toBeUndefined();
    // NOT SILENT: the wall is still announced with its depth by the
    // deleted-probe tripwire, pinned in the PROBE BOUND test above. It cannot be
    // re-asserted here - that WARN is rate limited on ONE module-scope 5-minute
    // window shared by every caller in the process, so the first firing in this
    // file suppresses the rest.
  });

  it('PROBE BOUND: a page behind the wall still gets a FORWARD PATH while supply remains', async () => {
    // The other half of the dead-end: not merely rows, but a cursor. A page
    // that stops with supply left must hand back something to page WITH.
    const seed = wallOfHiddenDeleted(27, 5);

    const page1 = await aggregateInbox({ filter: 'unread', limit: 3 }, makeDeps(seed));
    expect(rowKeys(page1)).toEqual(['c-live-00', 'c-live-01', 'c-live-02']);
    expect(page1.nextCursor).not.toBeNull();
    // A FULL page that stopped because it was full: an ordinary end, and the
    // skipped hidden threads behind it do not make it an early one (fix wave 3).
    expect(page1.truncated).toBeUndefined();

    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 3, cursor: page1.nextCursor! },
      makeDeps(seed),
    );
    expect(rowKeys(page2)).toEqual(['c-live-03', 'c-live-04']);
  });

  it('RESURFACING IS NOT WASTE: 50 resurfaced deleted contacts count in full and page in full', async () => {
    // BLOCKING regression from adversarial r2 finding 1: fix wave 1 counted
    // every probe against the bound, including the ones that produced a row, so
    // a badge in this ordinary world answered 26 - not at BADGE_COUNT_CAP, and
    // not through `capped`, the one flag the client was built to handle.
    const DELETED_AT = '2026-06-01T00:00:00.000Z';
    const contacts: ContactItem[] = [];
    const conversations: ConversationItem[] = [];
    const latestMessage: Record<string, Partial<MessageItem>> = {};
    for (let i = 0; i < 50; i++) {
      const phone = `+1404555${String(8000 + i)}`;
      const id = `conv-back-${String(i).padStart(2, '0')}`;
      contacts.push({
        contactId: `c-back-${String(i).padStart(2, '0')}`,
        type: 'tenant',
        phone,
        deleted_at: DELETED_AT,
      });
      conversations.push(
        conv({
          conversationId: id,
          participant_phone: phone,
          last_activity_at: new Date(Date.parse(T(12)) - i * 60_000).toISOString(),
          unread_count: 1,
        }),
      );
      // A post-deletion INBOUND: the product rule says this contact is BACK.
      latestMessage[id] = {
        type: 'sms',
        direction: 'inbound',
        body: 'are you still there?',
        created_at: '2026-06-11T00:00:00.000Z',
      };
    }
    const seed: Seed = { contacts, conversations, latestMessage };

    const badge = await countUnreadRows(makeDeps(seed));
    expect(badge).toEqual({ unreadCount: 50, capped: false, truncated: false });

    const page1 = await aggregateInbox({ filter: 'unread', limit: 30 }, makeDeps(seed));
    expect(page1.rows).toHaveLength(30);
    expect(page1.truncated).toBeUndefined();
    expect(page1.nextCursor).not.toBeNull();
    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 30, cursor: page1.nextCursor! },
      makeDeps(seed),
    );
    expect(page2.rows).toHaveLength(20);
    expect(page2.truncated).toBeUndefined();
    // All 50, once each.
    const union = [...rowKeys(page1), ...rowKeys(page2)];
    expect(new Set(union).size).toBe(50);
  });

  it('SCAN SENTINEL: the raw-scan total accumulates per REQUEST, not per collect', async () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never;
    // 600 unread contacts that ALL drop in hydration, with limit 1: the loop
    // makes 600 collects that each scan a SINGLE raw item, so the in-iterator
    // per-walk tripwire (500 scanned in one walk) can never fire. Only a
    // request-level accumulator sees the 600 - which is the whole point.
    const seed = unreadWorld(600);
    seed.participantProjection = seed.conversations.map((c) => ({ ...c, unread_count: 0 }));

    const page = await aggregateInbox(
      { filter: 'unread', limit: 1 },
      makeDeps(seed, undefined, logger),
    );

    expect(page.rows).toEqual([]);
    const scanWarns = warn.mock.calls.filter(
      (c) => (c[0] as { event?: string })?.event === 'unread_walk_scan_tripwire',
    );
    expect(scanWarns).toHaveLength(1);
    expect(scanWarns[0]![0]).toMatchObject({ scanned: 600, threshold: 500 });
  });

  it('CURSOR NAMESPACING: every foreign cursor is a 400, never a wrong-but-plausible page', async () => {
    const seed = unreadWorld(2);
    const page1 = await aggregateInbox({ filter: 'unread', limit: 1 }, makeDeps(seed));
    const unreadCursor = page1.nextCursor;
    expect(unreadCursor).not.toBeNull();

    // The unread cursor under filter=all would reach the 'open' partition as a
    // LastEvaluatedKey with the wrong hash attribute entirely.
    await expect(
      aggregateInbox({ filter: 'all', limit: 25, cursor: unreadCursor! }, makeDeps(seed)),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    // ...and the reverse: the 'open'-partition cursor under filter=unread.
    const openCursor = Buffer.from(JSON.stringify({ idx: 3 }), 'utf8').toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unread', limit: 25, cursor: openCursor }, makeDeps(seed)),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    // ...and the group partition's own tagged cursor.
    const groupCursor = Buffer.from(JSON.stringify({ t: 'gt1', k: { idx: 0 } }), 'utf8').toString(
      'base64url',
    );
    await expect(
      aggregateInbox({ filter: 'unread', limit: 25, cursor: groupCursor }, makeDeps(seed)),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    // A cursor that does not decode at all is the same 400, never a 500.
    await expect(
      aggregateInbox({ filter: 'unread', limit: 25, cursor: 'not-base64-json!!!' }, makeDeps(seed)),
    ).rejects.toBeInstanceOf(InboxBadRequestError);
  });

  it('CURSOR NAMESPACING: a tampered seen-set longer than the server would ever mint is a 400', async () => {
    const seed = unreadWorld(2);
    const tampered = Buffer.from(
      JSON.stringify({
        u: 1,
        a: T(23),
        c: 'conv-none',
        s: Array.from({ length: 101 }, (_, i) => `c-${i}`),
      }),
      'utf8',
    ).toString('base64url');

    await expect(
      aggregateInbox({ filter: 'unread', limit: 25, cursor: tampered }, makeDeps(seed)),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    // One id UNDER the cap still resumes, so this is a bound rather than a
    // blanket refusal of long cursors.
    const accepted = Buffer.from(
      JSON.stringify({
        u: 1,
        a: T(23),
        c: 'conv-none',
        s: Array.from({ length: 100 }, (_, i) => `c-${i}`),
      }),
      'utf8',
    ).toString('base64url');
    const page = await aggregateInbox(
      { filter: 'unread', limit: 25, cursor: accepted },
      makeDeps(seed),
    );
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it('CURSOR VALIDATION: an EMPTY scan position (or seen-set entry) is a 400, never a malformed key', async () => {
    // Adversarial A4. `a` and `c` become KEY attributes of the byUnread
    // ExclusiveStartKey, and DynamoDB refuses an empty key attribute with a
    // ValidationException - which nothing on this path maps, so the one decoder
    // written to guarantee 400s produced a 500 instead.
    const seed = unreadWorld(2);
    const cursorFor = (payload: unknown): string =>
      Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    await expect(
      aggregateInbox(
        { filter: 'unread', limit: 25, cursor: cursorFor({ u: 1, a: '', c: 'conv-x', s: [] }) },
        makeDeps(seed),
      ),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    await expect(
      aggregateInbox(
        { filter: 'unread', limit: 25, cursor: cursorFor({ u: 1, a: T(23), c: '', s: [] }) },
        makeDeps(seed),
      ),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    await expect(
      aggregateInbox(
        {
          filter: 'unread',
          limit: 25,
          cursor: cursorFor({ u: 1, a: T(23), c: 'conv-x', s: [''] }),
        },
        makeDeps(seed),
      ),
    ).rejects.toBeInstanceOf(InboxBadRequestError);

    // A well-formed cursor still resumes - this is a shape check, not a blanket
    // refusal.
    const page = await aggregateInbox(
      {
        filter: 'unread',
        limit: 25,
        cursor: cursorFor({ u: 1, a: T(23), c: 'conv-none', s: ['c-000'] }),
      },
      makeDeps(seed),
    );
    expect(page.rows.length).toBeGreaterThan(0);
  });

  it('SEEN-SET: a candidate DROPPED by hydration stays reachable (never suppressed for the session)', async () => {
    // Adversarial A3, reproduced. c-b owns TWO unread threads and is the newest
    // thing in the index, but the byParticipantPhone image hydration reads lags
    // INDEPENDENTLY of byUnread (spec 6) and reports nothing for it, so its
    // fresh unread sum is 0 and the row drops. Recording a DROPPED candidate in
    // the seen-set suppressed that contact for the WHOLE paging session while
    // the badge - which never hydrates - went on counting it: the operator saw
    // an unread count with no row anywhere to reach.
    const bNewPhone = '+14045553001';
    const bOldPhone = '+14045553002';
    const aPhone = '+14045553003';
    const contacts: ContactItem[] = [
      {
        contactId: 'c-b',
        type: 'tenant',
        phones: [
          { phone: bNewPhone, primary: true },
          { phone: bOldPhone, primary: false },
        ],
      },
      { contactId: 'c-a', type: 'tenant', phone: aPhone },
    ];
    const bNew = conv({
      conversationId: 'conv-b-new',
      participant_phone: bNewPhone,
      last_activity_at: T(12),
      unread_count: 1,
    });
    const aConv = conv({
      conversationId: 'conv-a',
      participant_phone: aPhone,
      last_activity_at: T(10),
      unread_count: 1,
    });
    const bOld = conv({
      conversationId: 'conv-b-old',
      participant_phone: bOldPhone,
      last_activity_at: T(8),
      unread_count: 1,
    });
    const conversations = [bNew, aConv, bOld];

    // PAGE 1 while the participant image still hides BOTH of c-b's threads.
    const page1 = await aggregateInbox(
      { filter: 'unread', limit: 1 },
      makeDeps({ contacts, conversations, participantProjection: [aConv] }),
    );
    expect(rowKeys(page1)).toEqual(['c-a']);
    expect(page1.nextCursor).not.toBeNull();
    const resumed = JSON.parse(
      Buffer.from(page1.nextCursor!, 'base64url').toString('utf8'),
    ) as { s: string[] };
    expect(resumed.s).toEqual(['c-a']);

    // PAGE 2 once that image caught up. c-b's older thread is still behind the
    // scan position, so a contact that was never EMITTED is offered again.
    const page2 = await aggregateInbox(
      { filter: 'unread', limit: 1, cursor: page1.nextCursor! },
      makeDeps({ contacts, conversations }),
    );
    expect(rowKeys(page2)).toEqual(['c-b']);
  });

  /**
   * Make the participant GSI hide `phone` on its FIRST read only - the lagging
   * image that has caught up by the time anything asks again. The seam has to
   * be per-CALL, not a static projection, because that is exactly what a
   * drop-aware RETRY can tell apart from a genuinely-read thread.
   */
  function lagOnceOnPhone(deps: InboxRouterDeps, phone: string): InboxRouterDeps {
    const repo = deps.conversationsRepo as unknown as {
      findByParticipantPhone(p: string): Promise<ConversationItem[]>;
    };
    const real = repo.findByParticipantPhone.bind(repo);
    let lagging = true;
    repo.findByParticipantPhone = async (p: string) => {
      if (p === phone && lagging) {
        lagging = false;
        return [];
      }
      return await real(p);
    };
    return deps;
  }

  /**
   * The lag shape production ACTUALLY produces (adversarial r3 finding 1), on
   * the FIRST read only: a DynamoDB GSI replicates the whole projected item, so
   * in the window where byUnread carries the increment and byParticipantPhone
   * does not, the thread is PRESENT in the participant image carrying its
   * PRE-increment `unread_count: 0`. Membership absence (lagOnceOnPhone above)
   * happens only for a conversation that did not exist a moment ago, which
   * resolves to no contact and takes the `unknown` branch anyway - so a
   * discriminator keyed on membership never fires for the dominant shape.
   */
  function staleCountOnceOnPhone(deps: InboxRouterDeps, phone: string): InboxRouterDeps {
    const repo = deps.conversationsRepo as unknown as {
      findByParticipantPhone(p: string): Promise<ConversationItem[]>;
    };
    const real = repo.findByParticipantPhone.bind(repo);
    let lagging = true;
    repo.findByParticipantPhone = async (p: string) => {
      const items = await real(p);
      if (p !== phone || !lagging) return items;
      lagging = false;
      return items.map((c) => ({ ...c, unread_count: 0 }));
    };
    return deps;
  }

  it('LAG DISCRIMINATOR: a STALE PROJECTED COUNT is lag - retried and rendered', async () => {
    // ADVERSARIAL r3 FINDING 1. Fix wave 2 discriminated lag by GSI MEMBERSHIP
    // ("is the offered thread absent from the fresh set?"), which is the shape a
    // reproduction reaches for and NOT the shape a lagging GSI produces: the
    // thread is there, carrying a stale zero. Every real lag was therefore
    // classified authoritative - never retried, and not even reported through
    // `truncated`, so the page claimed a clean natural end while the badge went
    // on counting the row. The discriminator is now ONE authoritative base-table
    // read of the offered thread.
    const bPhone = '+14045557021';
    const aPhone = '+14045557022';
    const contacts: ContactItem[] = [
      { contactId: 'c-b', type: 'tenant', phone: bPhone },
      { contactId: 'c-a', type: 'tenant', phone: aPhone },
    ];
    const bConv = conv({
      conversationId: 'conv-b',
      participant_phone: bPhone,
      last_activity_at: T(12),
      unread_count: 1,
    });
    const aConv = conv({
      conversationId: 'conv-a',
      participant_phone: aPhone,
      last_activity_at: T(10),
      unread_count: 1,
    });
    const seed: Seed = { contacts, conversations: [bConv, aConv] };

    const page = await aggregateInbox(
      { filter: 'unread', limit: 2 },
      staleCountOnceOnPhone(makeDeps(seed), bPhone),
    );

    // The BASE TABLE says conv-b is unread, so the fresh 0 was a missing
    // question rather than an answer: retry, and the row renders.
    expect(rowKeys(page)).toEqual(['c-b', 'c-a']);
    expect(page.truncated).toBeUndefined();
  });

  it('LAG DISCRIMINATOR: a thread the BASE TABLE says is closed/read is NOT lag - dropped, no retry, no truncation', async () => {
    // The other side of the same discriminator (conformance r3 finding 7). The
    // index still lists this thread as unread while the base table has it
    // CLOSED, so `contactConversations` (open-only) returns an empty set - the
    // membership shape fix wave 2 called lag. It is not: the point read is
    // authoritative, nothing a retry could learn, and claiming `truncated` here
    // would render the inbox ERROR state at the end of an ordinary triage
    // session (the C2 regression).
    const calls = emptyCallCounts();
    const gonePhone = '+14045557031';
    const closed = conv({
      conversationId: 'conv-gone',
      participant_phone: gonePhone,
      last_activity_at: T(12),
      unread_count: 1,
      status: 'closed',
    });
    const page = await aggregateInbox(
      { filter: 'unread', limit: 2 },
      makeDeps(
        {
          contacts: [{ contactId: 'c-gone', type: 'tenant', phone: gonePhone }],
          conversations: [closed],
          // The index image is the stale one: still open, still unread.
          unreadIndexProjection: [{ ...closed, status: 'open', unread_flag: 'unread' }],
        },
        calls,
      ),
    );

    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBeUndefined();
    // ONE participant-GSI read: the drop was answered, not retried.
    expect(calls.findByParticipantPhone).toBe(1);
  });

  it('LAG RETRY IS BOUNDED by the page limit, and the request line reports the count', async () => {
    // ADVERSARIAL r3 FINDING 4 / CONFORMANCE r3 FINDING 2. Correcting the
    // discriminator above makes this live: EVERY lag-classified drop used to be
    // retried, one fresh `conversationsForContact` each, so a degraded or
    // lagging participant GSI doubled the request's reads - up to
    // UNREAD_WALK_LIMIT of them - for a page that returns nothing. The cap is
    // the page `limit`: a retry that cannot fit on the page is counted
    // unresolved anyway.
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
    const calls = emptyCallCounts();
    const seed = unreadWorld(200);
    // The stale-count shape on EVERY contact: 200 lag-classified drops.
    seed.participantProjection = seed.conversations.map((c) => ({ ...c, unread_count: 0 }));

    const page = await aggregateInbox(
      { filter: 'unread', limit: 30 },
      makeDeps(seed, calls, logger),
    );

    expect(page.rows).toEqual([]);
    // 200 hydrations + AT MOST `limit` retries - not 400.
    expect(calls.findByParticipantPhone).toBe(230);
    // The page still refuses to claim a natural end while the badge counts rows
    // it could not deliver.
    expect(page.truncated).toBe(true);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled');
    expect(assembled?.[0]).toMatchObject({ laggedRetries: 30, unresolvedDrops: 200 });
  });

  it('DROPPED SINGLE-THREAD CONTACT: one retry at the end of the loop brings it back', async () => {
    // Adversarial r2 finding 4, the round-1 reproduction verbatim: contact B
    // owns exactly ONE unread thread and the participant GSI has not caught up,
    // so hydration drops it. Fix wave 1 stopped SUPPRESSING it (it is no longer
    // written into the seen-set) but nothing RE-OFFERS it: `scanPosition` is
    // already past its only index item, so the badge counted a row no page
    // would ever show, and the page reported a natural end.
    const bPhone = '+14045557001';
    const aPhone = '+14045557002';
    const contacts: ContactItem[] = [
      { contactId: 'c-b', type: 'tenant', phone: bPhone },
      { contactId: 'c-a', type: 'tenant', phone: aPhone },
    ];
    const bConv = conv({
      conversationId: 'conv-b',
      participant_phone: bPhone,
      last_activity_at: T(12),
      unread_count: 1,
    });
    const aConv = conv({
      conversationId: 'conv-a',
      participant_phone: aPhone,
      last_activity_at: T(10),
      unread_count: 1,
    });
    const seed: Seed = { contacts, conversations: [bConv, aConv] };

    const page = await aggregateInbox(
      { filter: 'unread', limit: 2 },
      lagOnceOnPhone(makeDeps(seed), bPhone),
    );

    // B renders. The retry runs AFTER every other read in the request, which is
    // what gives the participant image time to settle.
    expect(rowKeys(page)).toEqual(['c-b', 'c-a']);
    expect(page.truncated).toBeUndefined();
  });

  it('DROPPED SINGLE-THREAD CONTACT: a drop the retry cannot fix ends the page TRUNCATED, never silently', async () => {
    // The same world with an image that never catches up. The row cannot be
    // delivered, so the page must at least stop claiming it reached the end of
    // the supply - the badge is still counting that row.
    const bPhone = '+14045557011';
    const aPhone = '+14045557012';
    const contacts: ContactItem[] = [
      { contactId: 'c-b', type: 'tenant', phone: bPhone },
      { contactId: 'c-a', type: 'tenant', phone: aPhone },
    ];
    const bConv = conv({
      conversationId: 'conv-b',
      participant_phone: bPhone,
      last_activity_at: T(12),
      unread_count: 1,
    });
    const aConv = conv({
      conversationId: 'conv-a',
      participant_phone: aPhone,
      last_activity_at: T(10),
      unread_count: 1,
    });

    const page = await aggregateInbox(
      { filter: 'unread', limit: 2 },
      // The participant image knows NOTHING about B's thread, ever.
      makeDeps({ contacts, conversations: [bConv, aConv], participantProjection: [aConv] }),
    );

    expect(rowKeys(page)).toEqual(['c-a']);
    expect(page.truncated).toBe(true);
  });

  it('AGREEMENT: the pager and the index path build the SAME contact row', async () => {
    // The discriminating fixture (plan round 4): a NAMELESS soft-deleted contact
    // owning BOTH a phone thread and an email thread, unread on the NON-newest
    // (email) one, resurfaced by a post-deletion inbound. It discriminates
    // because the two paths reach buildContactRow from opposite directions - the
    // pager iterating the newest (phone) conversation, the index offering the
    // older (email) one - so every maxConv-derived field, including the
    // phone-formatted fallback NAME, has to come out identical.
    const DELETED_AT = '2026-06-01T00:00:00.000Z';
    const nameless: ContactItem = {
      contactId: 'c-agree',
      type: 'tenant',
      phone: '+14045558001',
      email: 'agree@example.com',
      deleted_at: DELETED_AT,
    };
    const phoneThread = conv({
      conversationId: 'conv-agree-phone',
      participant_phone: '+14045558001',
      last_activity_at: T(11),
      unread_count: 0,
      placementId: 'placement-agree',
    });
    const emailThread: ConversationItem = {
      status: 'open',
      type: 'tenant_1to1',
      ai_mode: 'auto',
      created_at: T(10),
      conversationId: 'conv-agree-email',
      participant_email: 'agree@example.com',
      last_activity_at: T(10),
      unread_count: 2,
      unread_flag: 'unread',
    };
    const seed: Seed = {
      contacts: [nameless],
      conversations: [phoneThread, emailThread],
      latestMessage: {
        'conv-agree-phone': {
          type: 'sms',
          direction: 'outbound',
          body: 'we tried you',
          created_at: T(11),
        },
        'conv-agree-email': {
          type: 'email',
          direction: 'inbound',
          body: 'still looking',
          created_at: T(10),
        },
      },
      placements: { 'placement-agree': { stage: 'touring' } },
    };

    const viaPager = await aggregateInbox({ filter: 'all', limit: 25 }, makeDeps(seed));
    const viaIndex = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps(seed));

    const pagerRow = viaPager.rows.find((r) => r.contactId === 'c-agree');
    const indexRow = viaIndex.rows.find((r) => r.contactId === 'c-agree');
    expect(pagerRow).toBeDefined();
    expect(indexRow).toBeDefined();
    // toEqual, not toMatchObject: a field present on one row and absent on the
    // other is exactly the drift a FORKED builder would produce.
    expect(indexRow).toEqual(pagerRow);
    // ...and the fields that can only be right if phone/email came from maxConv
    // (the newest, PHONE thread) rather than from the driving conversation.
    expect(indexRow).toMatchObject({
      name: '(404) 555-8001',
      phone: '+14045558001',
      deleted: true,
      unreadCount: 2,
      lastActivityAt: T(11),
      placementContext: { placementId: 'placement-agree', label: 'Touring' },
    });
  });
});
