// S4/T4.1 - the inbox's THIRD row source: native group_text threads read from
// the group_open partition. Driven directly against `aggregateInbox` with
// in-memory fakes that mirror the real repo contracts:
//   - listGroupTexts pages the group_open partition newest-first, honors its own
//     TAGGED cursor, and reports `truncated` when its walk budget stopped early;
//   - listByLastActivity / listRelayGroups never return a group thread (different
//     partitions entirely), which is what makes the merge split-proof.
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateInbox,
  groupThreadLabel,
  InboxBadRequestError,
  type InboxRouterDeps,
} from '../src/routes/inbox.js';
import {
  encodeGroupCursor,
  GroupCursorError,
  GROUP_TEXT_STATUS,
  type ConversationItem,
} from '../src/repos/conversationsRepo.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface GroupSeed {
  groups?: ConversationItem[];
  open?: ConversationItem[];
  relay?: ConversationItem[];
  /** Force listGroupTexts to report a budget-stopped walk. */
  truncated?: boolean;
  /** Fail the group query (spec 4.2: LOUD, never best-effort-empty). */
  groupQueryError?: Error;
  contacts?: { contactId: string; phone: string; name?: string }[];
}

interface Calls {
  groupLimits: (number | undefined)[];
  groupCursors: (string | undefined)[];
}

function makeDeps(seed: GroupSeed): { deps: InboxRouterDeps; calls: Calls } {
  const calls: Calls = { groupLimits: [], groupCursors: [] };
  const groups = [...(seed.groups ?? [])].sort((a, b) =>
    a.last_activity_at < b.last_activity_at ? 1 : -1,
  );
  const open = [...(seed.open ?? [])].sort((a, b) =>
    a.last_activity_at < b.last_activity_at ? 1 : -1,
  );
  /** Every seeded row across the three partitions (the whole fake "table"). */
  const allSeeded = (): ConversationItem[] => [...groups, ...open, ...(seed.relay ?? [])];

  const deps: InboxRouterDeps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    conversationsRepo: {
      async getById(conversationId: string) {
        return allSeeded().find((c) => c.conversationId === conversationId);
      },
      // The sparse byUnread index over EVERY seeded row regardless of which
      // partition it belongs to - that is the point of the index: one stream,
      // no per-source walk. Tuple-ordered; see helpers/unreadIndexFake.ts.
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        return queryUnreadPageFromItems(allSeeded(), opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        return open.filter((c) => c.participant_phone === phone);
      },
      async listRelayGroups(status: 'open' | 'closed' | 'connecting') {
        return {
          items: (seed.relay ?? []).filter((c) => c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts(opts: { limit?: number; cursor?: string } = {}) {
        calls.groupLimits.push(opts.limit);
        calls.groupCursors.push(opts.cursor);
        if (seed.groupQueryError) throw seed.groupQueryError;
        // The real repo decodes (and refuses) the cursor BEFORE any I/O.
        let start = 0;
        if (opts.cursor !== undefined) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8'));
          } catch {
            throw new GroupCursorError('not decodable');
          }
          if ((parsed as { t?: unknown })?.t !== 'gt1') throw new GroupCursorError('wrong tag');
          start = ((parsed as { k?: { idx?: number } }).k?.idx ?? -1) + 1;
        }
        const limit = opts.limit ?? 50;
        const items = groups.slice(start, start + limit);
        const endIdx = start + items.length - 1;
        const more = start + items.length < groups.length;
        return {
          items,
          ...(more && { nextCursor: encodeGroupCursor({ idx: endIdx }) }),
          truncated: seed.truncated === true,
        };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        const c = (seed.contacts ?? []).find((x) => x.phone === phone);
        return c ? { ...c, status: 'active' } : undefined;
      },
      async getById(contactId: string) {
        return (seed.contacts ?? []).find((x) => x.contactId === contactId);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation() {
        return [];
      },
    } as unknown as NonNullable<InboxRouterDeps['messagesRepo']>,
    placementsRepo: {
      async getById() {
        return undefined;
      },
    } as unknown as NonNullable<InboxRouterDeps['placementsRepo']>,
  };
  return { deps, calls };
}

function groupConv(
  over: Partial<ConversationItem> & { conversationId: string; last_activity_at: string },
): ConversationItem {
  return {
    status: GROUP_TEXT_STATUS,
    type: 'group_text',
    ai_mode: 'manual',
    created_at: over.last_activity_at,
    participants: [
      { contactId: 'c-ann', phone: '+14045550111', name: 'Ann Tenant' },
      { contactId: 'c-marcus', phone: '+14045550112', name: 'Marcus Landlord' },
    ],
    // FLAG IFF COUNT>0, derived centrally (helpers/unreadIndexFake.ts): the
    // sparse byUnread index keys on `unread_flag`, so a fixture with unread and
    // no flag is invisible to this file's own queryUnreadPage. Overridable below.
    ...unreadFlagFor(over),
    ...over,
  };
}

describe('groupThreadLabel - the roster-derived title', () => {
  it('spells out member FIRST names', () => {
    expect(
      groupThreadLabel([
        { contactId: 'c1', phone: '+14045550111', name: 'Ann Tenant' },
        { contactId: 'c2', phone: '+14045550112', name: 'Marcus Landlord' },
      ]),
    ).toBe('With Ann & Marcus');
  });

  it('falls back to the formatted number for a member with no name', () => {
    expect(groupThreadLabel([{ contactId: 'c1', phone: '+14045550111' }])).toBe(
      'With (404) 555-0111',
    );
  });

  it('summarizes a large roster instead of rendering nine names', () => {
    const roster = ['Ann', 'Bo', 'Cy', 'Dee', 'Eve'].map((name, i) => ({
      contactId: `c${i}`,
      phone: `+1404555011${i}`,
      name,
    }));
    expect(groupThreadLabel(roster)).toBe('With Ann & Bo & Cy +2 more');
  });

  it('degrades to a plain label when the roster is missing', () => {
    expect(groupThreadLabel(undefined)).toBe('Group text');
    expect(groupThreadLabel([])).toBe('Group text');
  });
});

describe('aggregateInbox - the group_text source (filter=all)', () => {
  it('emits a group row with the roster title, unread count and preview - and NO relay status', async () => {
    const { deps } = makeDeps({
      groups: [
        groupConv({
          conversationId: 'gt-1',
          last_activity_at: '2026-06-17T10:00:00.000Z',
          unread_count: 3,
          last_message_preview: 'Can we all meet Saturday?',
        }),
      ],
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows).toEqual([
      {
        kind: 'group_text',
        conversationId: 'gt-1',
        name: 'With Ann & Marcus',
        unreadCount: 3,
        preview: 'Can we all meet Saturday?',
        lastActivityAt: '2026-06-17T10:00:00.000Z',
        needsTriage: false,
      },
    ]);
    // No `status`: a group_open thread has no relay lifecycle, and reporting it
    // as 'open' (relayRowFor's catch-all) would be a silent lie.
    expect(page.rows[0]).not.toHaveProperty('status');
    expect(page.rows[0]).not.toHaveProperty('owner');
    expect(page.rows[0]).not.toHaveProperty('channel');
  });

  it('interleaves group rows with contact rows newest-activity-first', async () => {
    const { deps } = makeDeps({
      open: [
        {
          conversationId: 'c-1',
          status: 'open',
          type: 'tenant_1to1',
          participant_phone: '+14045550999',
          last_activity_at: '2026-06-17T09:00:00.000Z',
          created_at: '2026-06-17T09:00:00.000Z',
          ai_mode: 'auto',
        } as ConversationItem,
      ],
      contacts: [{ contactId: 'c-solo', phone: '+14045550999', name: 'Solo Tenant' }],
      groups: [
        groupConv({ conversationId: 'gt-new', last_activity_at: '2026-06-17T11:00:00.000Z' }),
        groupConv({ conversationId: 'gt-old', last_activity_at: '2026-06-17T08:00:00.000Z' }),
      ],
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.rows.map((r) => r.conversationId ?? r.contactId)).toEqual([
      'gt-new',
      'c-solo',
      'gt-old',
    ]);
  });

  it('caps page one at the top 50 and SURFACES the truncation', async () => {
    const groups = Array.from({ length: 60 }, (_, i) =>
      groupConv({
        conversationId: `gt-${i}`,
        last_activity_at: `2026-06-17T${String(10 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 10).padStart(2, '0')}:00.000Z`,
      }),
    );
    const { deps, calls } = makeDeps({ groups });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(calls.groupLimits).toEqual([50]);
    expect(page.rows).toHaveLength(50);
    expect(page.groupsTruncated).toBe(true);
  });

  it('omits the truncation flag entirely when nothing was withheld', async () => {
    const { deps } = makeDeps({
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.groupsTruncated).toBeUndefined();
  });

  it('surfaces truncation when the repo walk budget stopped early', async () => {
    const { deps } = makeDeps({
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
      truncated: true,
    });
    const page = await aggregateInbox({ filter: 'all', limit: 25 }, deps);
    expect(page.groupsTruncated).toBe(true);
  });

  it('merges group rows on page ONE only (a later page cannot double-serve them)', async () => {
    const { deps, calls } = makeDeps({
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
    });
    const cursor = Buffer.from(JSON.stringify({ idx: 3 }), 'utf8').toString('base64url');
    const page = await aggregateInbox({ filter: 'all', limit: 25, cursor }, deps);
    expect(calls.groupLimits).toEqual([]);
    expect(page.rows.some((r) => r.kind === 'group_text')).toBe(false);
  });

  it('FAILS LOUD when the group query breaks (never a silently group-less inbox)', async () => {
    const { deps } = makeDeps({ groupQueryError: new Error('dynamo down') });
    await expect(aggregateInbox({ filter: 'all', limit: 25 }, deps)).rejects.toThrow('dynamo down');
  });
});

describe('aggregateInbox - group rows under the other filters', () => {
  it('returns ALL unread group threads under filter=unread (the full-partition-walk contract)', async () => {
    const groups = Array.from({ length: 60 }, (_, i) =>
      groupConv({
        conversationId: `gt-${i}`,
        last_activity_at: `2026-06-17T${String(10 + Math.floor(i / 10)).padStart(2, '0')}:${String(i % 10).padStart(2, '0')}:00.000Z`,
        unread_count: 1,
      }),
    );
    const { deps, calls } = makeDeps({ groups });
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, deps);
    // NOT the 50-row page-one cap: the nav badge counts these rows.
    expect(calls.groupLimits[0]).toBeGreaterThan(60);
    expect(page.rows).toHaveLength(60);
    expect(page.groupsTruncated).toBeUndefined();
  });

  it('drops read group threads under filter=unread', async () => {
    const { deps } = makeDeps({
      groups: [
        groupConv({
          conversationId: 'gt-read',
          last_activity_at: '2026-06-17T10:00:00.000Z',
          unread_count: 0,
        }),
        groupConv({
          conversationId: 'gt-unread',
          last_activity_at: '2026-06-17T09:00:00.000Z',
          unread_count: 2,
        }),
      ],
    });
    const page = await aggregateInbox({ filter: 'unread', limit: 25 }, deps);
    expect(page.rows.map((r) => r.conversationId)).toEqual(['gt-unread']);
  });

  it('never reads the group partition under filter=unknown (needsTriage is always false)', async () => {
    const { deps, calls } = makeDeps({
      groups: [
        groupConv({
          conversationId: 'gt-1',
          last_activity_at: '2026-06-17T10:00:00.000Z',
          unread_count: 4,
        }),
      ],
    });
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, deps);
    expect(calls.groupLimits).toEqual([]);
    expect(page.rows).toEqual([]);
  });
});

describe('aggregateInbox - filter=groups', () => {
  it('serves ONLY group rows, straight from the group partition', async () => {
    const { deps } = makeDeps({
      open: [
        {
          conversationId: 'c-1',
          status: 'open',
          type: 'tenant_1to1',
          participant_phone: '+14045550999',
          last_activity_at: '2026-06-17T23:00:00.000Z',
          created_at: '2026-06-17T23:00:00.000Z',
          ai_mode: 'auto',
        } as ConversationItem,
      ],
      contacts: [{ contactId: 'c-solo', phone: '+14045550999', name: 'Solo Tenant' }],
      relay: [
        {
          conversationId: 'relay-1',
          status: 'open',
          type: 'relay_group',
          pool_number: '+15550160001',
          last_activity_at: '2026-06-17T22:00:00.000Z',
          created_at: '2026-06-17T22:00:00.000Z',
          ai_mode: 'manual',
        } as ConversationItem,
      ],
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
    });
    const page = await aggregateInbox({ filter: 'groups', limit: 25 }, deps);
    expect(page.rows.map((r) => r.kind)).toEqual(['group_text']);
    expect(page.rows[0]?.conversationId).toBe('gt-1');
  });

  it('pages the FULL list through the group partition cursor', async () => {
    const groups = Array.from({ length: 5 }, (_, i) =>
      groupConv({
        conversationId: `gt-${i}`,
        last_activity_at: `2026-06-17T1${i}:00:00.000Z`,
      }),
    );
    const { deps } = makeDeps({ groups });
    const first = await aggregateInbox({ filter: 'groups', limit: 2 }, deps);
    expect(first.rows.map((r) => r.conversationId)).toEqual(['gt-4', 'gt-3']);
    expect(first.nextCursor).not.toBeNull();

    const second = await aggregateInbox(
      { filter: 'groups', limit: 2, cursor: first.nextCursor! },
      deps,
    );
    expect(second.rows.map((r) => r.conversationId)).toEqual(['gt-2', 'gt-1']);
  });

  it('400s a cursor minted under another filter instead of paging the wrong partition', async () => {
    const { deps } = makeDeps({
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
    });
    // An 'open'-partition cursor: a bare LastEvaluatedKey, no tag.
    const openCursor = Buffer.from(JSON.stringify({ idx: 3 }), 'utf8').toString('base64url');
    await expect(
      aggregateInbox({ filter: 'groups', limit: 25, cursor: openCursor }, deps),
    ).rejects.toBeInstanceOf(InboxBadRequestError);
  });

  it('400s a GROUP cursor replayed into another filter', async () => {
    const { deps } = makeDeps({
      groups: [groupConv({ conversationId: 'gt-1', last_activity_at: '2026-06-17T10:00:00.000Z' })],
    });
    const groupCursor = encodeGroupCursor({ idx: 1 });
    await expect(
      aggregateInbox({ filter: 'all', limit: 25, cursor: groupCursor }, deps),
    ).rejects.toBeInstanceOf(InboxBadRequestError);
  });
});
