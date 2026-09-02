// PARITY BASELINE for the `filter=unread` rewrite (inbox-unread-index, plan
// Task 6 Step 0). CAPTURED AGAINST THE PRE-REWRITE aggregateInbox and committed
// on its own, BEFORE inbox.ts is touched - a builder halfway through the rewrite
// can no longer run "the old code", so the pin has to exist first.
//
// WHAT THIS FILE PINS: the CONTENT of one row of each of the four kinds the
// unread feed can emit - contact, unknown, relay_group, group_text - as literal
// expected objects keyed by a stable per-row identity.
//
// WHAT IT DELIBERATELY DOES NOT PIN, and why: the page ORDER, `nextCursor`, and
// `groupsTruncated`. Design spec 4.5 DECLARES all three changed by the rewrite
// (page composition becomes a single unified stream capped at `limit` with
// overflow behind a cursor; `groupsTruncated` loses its producer under
// filter=unread). Pinning them here would pin the behavior the rewrite exists to
// replace, and this test would then fight its own feature. Row CONTENT is what
// the rewrite promises to preserve; page COMPOSITION is not.
//
// The fixtures carry `unread_flag` on every unread item on purpose. It is inert
// under today's code (which never reads the attribute) and REQUIRED after the
// rewrite, when the same fixtures must still be visible through the sparse
// byUnread index. A flagless baseline would go red with `rows: []` for a reason
// that has nothing to do with parity.
import { describe, expect, it } from 'vitest';
import { aggregateInbox, type InboxRouterDeps, type InboxRow } from '../src/routes/inbox.js';
import {
  GROUP_TEXT_STATUS,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
} from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';

// --- The fixture world -------------------------------------------------------

const PARITY_CONTACT: ContactItem = {
  contactId: 'c-parity-tenant',
  type: 'tenant',
  firstName: 'Dana',
  lastName: 'Doe',
  phone: '+15550000101',
  phones: [{ phone: '+15550000101', primary: true }],
};

/** One unread 1:1 thread owned by PARITY_CONTACT, carrying a placement label. */
const CONTACT_CONV: ConversationItem = {
  conversationId: 'conv-parity-contact',
  type: 'tenant_1to1',
  status: 'open',
  ai_mode: 'auto',
  participant_phone: '+15550000101',
  placementId: 'pl-parity',
  last_activity_at: '2026-06-12T15:00:00.000Z',
  last_message_preview: 'stored contact preview',
  created_at: '2026-06-01T00:00:00.000Z',
  unread_count: 2,
  unread_flag: UNREAD_FLAG_VALUE,
};

/** An unread inbound from a number no contact owns. */
const UNKNOWN_CONV: ConversationItem = {
  conversationId: 'conv-parity-unknown',
  type: 'unknown_1to1',
  status: 'open',
  ai_mode: 'auto',
  participant_phone: '+14049824978',
  last_activity_at: '2026-06-12T14:00:00.000Z',
  last_message_preview: 'stored unknown preview',
  created_at: '2026-06-02T00:00:00.000Z',
  unread_count: 1,
  unread_flag: UNREAD_FLAG_VALUE,
};

/** An OPEN relay group - the second row source (listRelayGroups). */
const RELAY_CONV: ConversationItem = {
  conversationId: 'conv-parity-relay',
  type: 'relay_group',
  status: 'open',
  ai_mode: 'manual',
  participant_phone: '+15550160001',
  pool_number: '+15550160001',
  participants: [
    { contactId: 'c-parity-tenant', phone: '+15550000101', name: 'Dana' },
    { contactId: 'c-parity-landlord', phone: '+15550000202', name: 'Lee' },
  ],
  owner: { type: 'placement', id: 'pl-parity' },
  last_activity_at: '2026-06-12T13:00:00.000Z',
  last_message_preview: 'stored relay preview',
  created_at: '2026-06-03T00:00:00.000Z',
  unread_count: 3,
  unread_flag: UNREAD_FLAG_VALUE,
};

/** A NATIVE carrier group thread - the third row source (listGroupTexts). */
const GROUP_CONV: ConversationItem = {
  conversationId: 'conv-parity-group',
  type: 'group_text',
  status: GROUP_TEXT_STATUS,
  ai_mode: 'manual',
  // A roster DIFFERENT from the relay group's on purpose: the two labels are
  // built by separate derivations (groupThreadLabel vs relayRowFor's precedence
  // chain), and identical rosters would let a row built by the wrong builder
  // still match its pin.
  participants: [
    { contactId: 'c-parity-rae', phone: '+15550000303', name: 'Rae' },
    { contactId: 'c-parity-sam', phone: '+15550000404', name: 'Sam' },
  ],
  last_activity_at: '2026-06-12T12:00:00.000Z',
  last_message_preview: 'stored group preview',
  created_at: '2026-06-04T00:00:00.000Z',
  unread_count: 4,
  unread_flag: UNREAD_FLAG_VALUE,
};

const ALL_CONVERSATIONS: readonly ConversationItem[] = [
  CONTACT_CONV,
  UNKNOWN_CONV,
  RELAY_CONV,
  GROUP_CONV,
];

/** Latest message per conversationId (drives channel/direction/preview). */
const LATEST_MESSAGES: Record<string, Partial<MessageItem>> = {
  'conv-parity-contact': {
    type: 'sms',
    direction: 'inbound',
    body: 'Any update on the application?',
    created_at: '2026-06-12T15:00:00.000Z',
  },
  'conv-parity-unknown': {
    type: 'sms',
    direction: 'inbound',
    body: 'Is the place still available?',
    created_at: '2026-06-12T14:00:00.000Z',
  },
};

// --- The fake repos ----------------------------------------------------------

/** Newest-activity-first, ties broken by conversationId descending (the real
 *  byLastActivity order, and the same tuple the unread index uses). */
function compareActivityDesc(a: ConversationItem, b: ConversationItem): number {
  if (a.last_activity_at !== b.last_activity_at) {
    return a.last_activity_at < b.last_activity_at ? 1 : -1;
  }
  if (a.conversationId !== b.conversationId) return a.conversationId < b.conversationId ? 1 : -1;
  return 0;
}

/**
 * A deps object over the fixture world above, modeling the repo contracts the
 * aggregator relies on. Written so the SAME fixtures drive the pre-rewrite path
 * (listByLastActivity + listRelayGroups + listGroupTexts) and the post-rewrite
 * path (queryUnreadPage + getById), which is the whole point of a parity pin.
 */
function makeDeps(): InboxRouterDeps {
  return {
    conversationsRepo: {
      async getById(conversationId: string) {
        return ALL_CONVERSATIONS.find((c) => c.conversationId === conversationId);
      },
      // The sparse byUnread index, DERIVED FROM THE FLAG (never from the
      // counter - the flag is what the real GSI keys on) and ordered by the real
      // (last_activity_at DESC, conversationId DESC) tuple. Shared model, so this
      // fake cannot drift into agreeing with a broken implementation.
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        return queryUnreadPageFromItems(ALL_CONVERSATIONS, opts);
      },
      // The 'open' partition, newest-first, resuming from a synthesized full key
      // rather than an index POSITION (a position key cannot express a resume
      // across rows sharing one last_activity_at).
      async listByLastActivity({
        status,
        limit,
        exclusiveStartKey,
      }: {
        status: string;
        limit?: number;
        exclusiveStartKey?: Record<string, unknown>;
      }) {
        const ordered = ALL_CONVERSATIONS.filter((c) => c.status === status).sort(
          compareActivityDesc,
        );
        const startTs = exclusiveStartKey?.['last_activity_at'];
        const startId = exclusiveStartKey?.['conversationId'];
        const remaining =
          typeof startTs === 'string' && typeof startId === 'string'
            ? ordered.filter(
                (c) =>
                  compareActivityDesc(c, {
                    ...c,
                    last_activity_at: startTs,
                    conversationId: startId,
                  }) > 0,
              )
            : ordered;
        const page = remaining.slice(0, limit ?? 50);
        const last = page[page.length - 1];
        const more = remaining.length > page.length;
        return {
          items: page,
          ...(more &&
            last !== undefined && {
              lastEvaluatedKey: {
                status,
                last_activity_at: last.last_activity_at,
                conversationId: last.conversationId,
              } as Record<string, unknown>,
            }),
        };
      },
      async findByParticipantPhone(phone: string) {
        return ALL_CONVERSATIONS.filter((c) => c.participant_phone === phone);
      },
      // A18: layer 2 resolves by phone and THEN by email, so an email finder that
      // is merely absent is a RUNTIME TypeError, not a compile error, in a cast
      // fake. Modeled rather than omitted.
      async findByParticipantEmail(email: string) {
        return ALL_CONVERSATIONS.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: 'open' | 'closed' | 'connecting') {
        const items = ALL_CONVERSATIONS.filter(
          (c) => c.type === 'relay_group' && c.status === status,
        ).sort(compareActivityDesc);
        return { items, truncated: false };
      },
      async listGroupTexts({ limit }: { limit?: number; cursor?: string } = {}) {
        const items = ALL_CONVERSATIONS.filter((c) => c.type === 'group_text')
          .sort(compareActivityDesc)
          .slice(0, limit ?? 50);
        return { items, truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        return [PARITY_CONTACT].find((c) => c.phones?.some((p) => p.phone === phone));
      },
      // A18 again: the hydration collector calls this whenever findByPhone misses.
      async findByEmail(email: string) {
        return [PARITY_CONTACT].find((c) => c.emails?.some((e) => e.email === email));
      },
      async getById(contactId: string) {
        return [PARITY_CONTACT].find((c) => c.contactId === contactId);
      },
      // Explicit and empty (M1). The roster-name boundary batches through this
      // method; the cast above would let it be MISSING, and the resulting
      // TypeError is swallowed - so this suite would go green by resolving zero
      // names silently rather than by resolving none.
      async getDisplaysByIds() {
        return new Map();
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      // A18: the deleted-contact probe and every latest-message hydration read
      // land here.
      async listByConversation(conversationId: string) {
        const latest = LATEST_MESSAGES[conversationId];
        return latest ? [latest as MessageItem] : [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById(placementId: string) {
        return placementId === 'pl-parity'
          ? ({ placementId, stage: 'touring' } as unknown)
          : undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
}

/**
 * A stable identity for a row that does NOT depend on its position in the page -
 * the same kind-free key scheme the dashboard's mark-read wiring uses (contact
 * -> c:, unknown -> u:, both multi-party kinds -> cv:).
 */
function rowKey(row: InboxRow): string {
  if (row.kind === 'contact') return `c:${row.contactId ?? ''}`;
  if (row.kind === 'unknown') return `u:${row.phone ?? ''}`;
  return `cv:${row.conversationId ?? ''}`;
}

function byRowKey(rows: readonly InboxRow[]): Record<string, InboxRow> {
  const out: Record<string, InboxRow> = {};
  for (const row of rows) out[rowKey(row)] = row;
  return out;
}

// --- The pinned rows ---------------------------------------------------------
//
// CAPTURED, NOT HAND-WRITTEN: produced by running this file's fixtures through
// the pre-rewrite aggregateInbox with a temporary console.log and pasting the
// output verbatim. Do NOT re-capture these after inbox.ts changes - that would
// turn the parity test into a mirror of whatever the new code does.
const EXPECTED_ROWS: Record<string, InboxRow> = {
  'c:c-parity-tenant': {
    kind: 'contact',
    contactId: 'c-parity-tenant',
    phone: '+15550000101',
    name: 'Dana Doe',
    role: 'tenant',
    placementContext: { placementId: 'pl-parity', label: 'Touring' },
    unreadCount: 2,
    preview: 'Any update on the application?',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-12T15:00:00.000Z',
    needsTriage: false,
  },
  'u:+14049824978': {
    kind: 'unknown',
    phone: '+14049824978',
    name: '(404) 982-4978',
    role: 'unknown',
    unreadCount: 1,
    preview: 'Is the place still available?',
    channel: 'sms',
    direction: 'inbound',
    lastActivityAt: '2026-06-12T14:00:00.000Z',
    needsTriage: true,
  },
  'cv:conv-parity-relay': {
    kind: 'relay_group',
    conversationId: 'conv-parity-relay',
    name: 'With Dana & Lee',
    unreadCount: 3,
    preview: 'stored relay preview',
    lastActivityAt: '2026-06-12T13:00:00.000Z',
    status: 'open',
    owner: { type: 'placement', id: 'pl-parity' },
    needsTriage: false,
  },
  'cv:conv-parity-group': {
    kind: 'group_text',
    conversationId: 'conv-parity-group',
    name: 'With Rae & Sam',
    unreadCount: 4,
    preview: 'stored group preview',
    lastActivityAt: '2026-06-12T12:00:00.000Z',
    needsTriage: false,
  },
};

describe('filter=unread ROW-SHAPE parity baseline (pre-rewrite pin)', () => {
  it('emits exactly one row per fixture kind - contact, unknown, relay_group, group_text', async () => {
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps());

    // SORTED so this asserts membership, never page ORDER (spec 4.5 changes the
    // order deliberately).
    expect(page.rows.map(rowKey).sort()).toEqual(Object.keys(EXPECTED_ROWS).sort());
    expect(page.rows).toHaveLength(4);
  });

  for (const [key, expected] of Object.entries(EXPECTED_ROWS)) {
    it(`row ${key} keeps its exact content through the unread rewrite`, async () => {
      const page = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps());
      const actual = byRowKey(page.rows)[key];

      // toEqual, not toMatchObject: an EXTRA field is a content change too, and
      // a row that silently gained (or lost) an optional attribute is exactly
      // the kind of drift this pin exists to catch.
      expect(actual).toEqual(expected);
    });
  }

  it('pins row CONTENT only - page order, nextCursor and groupsTruncated are declared CHANGED', async () => {
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, makeDeps());

    // The three page-level outputs spec 4.5 rewrites. Asserted here ONLY as
    // "structurally present and of the right type", so that a future reader
    // cannot mistake this file's silence for an oversight - and so the rewrite
    // is free to change every one of their values without touching this test.
    expect(Array.isArray(page.rows)).toBe(true);
    expect(page.nextCursor === null || typeof page.nextCursor === 'string').toBe(true);
    expect(
      page.groupsTruncated === undefined || typeof page.groupsTruncated === 'boolean',
    ).toBe(true);
  });
});
