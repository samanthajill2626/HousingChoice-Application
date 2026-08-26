// app/test/inboxUnknownTab.test.ts
//
// The filter=unknown CONTACT-SIDE read (design 2026-08-25): behavior, coverage
// classes, failure discrimination, and the cost inversion. The parity file
// (inboxUnknownParity.test.ts) pins row CONTENT across the flip; this file
// pins the NEW mechanics - what is read, what is not, and what happens when a
// read fails.
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateInbox,
  InboxBadRequestError,
  type InboxRouterDeps,
} from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem } from '../src/repos/contactsRepo.js';
import type { MessageItem } from '../src/repos/messagesRepo.js';
import { listByTypeFromContacts } from './helpers/contactsPartitionFake.js';
import { queryUnreadPageFromItems, unreadFlagFor } from './helpers/unreadIndexFake.js';

interface Seed {
  contacts: ContactItem[];
  conversations: ConversationItem[];
  latestMessage?: Record<string, Partial<MessageItem>>;
  /** Make findByParticipantPhone THROW for exactly this phone (requirement 4). */
  threadLookupErrorPhone?: string;
  /** Override the listByType answer wholesale (the retype-race test). */
  listByTypeOverride?: (type: string) => { items: ContactItem[] };
}

interface Calls {
  listByType: number;
  listByLastActivity: number;
  listRelayGroups: number;
  listGroupTexts: number;
  queryUnreadPage: number;
  findByPhone: number;
  findByParticipantPhone: number;
  listByConversation: number;
}

function emptyCalls(): Calls {
  return {
    listByType: 0,
    listByLastActivity: 0,
    listRelayGroups: 0,
    listGroupTexts: 0,
    queryUnreadPage: 0,
    findByPhone: 0,
    findByParticipantPhone: 0,
    listByConversation: 0,
  };
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

function makeDeps(
  seed: Seed,
  calls: Calls = emptyCalls(),
  logger?: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> },
  seams?: Pick<
    InboxRouterDeps,
    'unknownQueueMaxRows' | 'unknownQueueMaxPages' | 'unknownQueuePageSize'
  >,
): InboxRouterDeps {
  const log = logger ?? { info: vi.fn(), warn: vi.fn() };
  return {
    logger: { ...log, error: vi.fn(), debug: vi.fn() } as never,
    ...seams,
    conversationsRepo: {
      async getById(id: string) {
        return seed.conversations.find((c) => c.conversationId === id);
      },
      async queryUnreadPage(opts: { limit: number; exclusiveStartKey?: Record<string, unknown> }) {
        calls.queryUnreadPage += 1;
        return queryUnreadPageFromItems(seed.conversations, opts);
      },
      async listByLastActivity({ limit }: { status: string; limit?: number }) {
        calls.listByLastActivity += 1;
        const open = seed.conversations
          .filter((c) => c.status === 'open')
          .sort((a, b) => (a.last_activity_at < b.last_activity_at ? 1 : -1));
        return { items: open.slice(0, limit ?? 50) };
      },
      async findByParticipantPhone(phone: string) {
        calls.findByParticipantPhone += 1;
        if (seed.threadLookupErrorPhone === phone) throw new Error('participant GSI unavailable');
        return seed.conversations.filter((c) => c.participant_phone === phone);
      },
      async findByParticipantEmail(email: string) {
        return seed.conversations.filter((c) => c.participant_email === email);
      },
      async listRelayGroups(status: string) {
        calls.listRelayGroups += 1;
        return {
          items: seed.conversations.filter((c) => c.type === 'relay_group' && c.status === status),
          truncated: false,
        };
      },
      async listGroupTexts() {
        calls.listGroupTexts += 1;
        return { items: [], truncated: false };
      },
    } as unknown as NonNullable<InboxRouterDeps['conversationsRepo']>,
    contactsRepo: {
      async findByPhone(phone: string) {
        calls.findByPhone += 1;
        return seed.contacts.find((c) => c.phone === phone);
      },
      async findByEmail(email: string) {
        return seed.contacts.find((c) => c.email === email);
      },
      async getById(contactId: string) {
        return seed.contacts.find((c) => c.contactId === contactId);
      },
      async listByType(type: string, opts = {}) {
        calls.listByType += 1;
        if (seed.listByTypeOverride !== undefined) return seed.listByTypeOverride(type);
        return listByTypeFromContacts(seed.contacts, type, opts);
      },
    } as unknown as NonNullable<InboxRouterDeps['contactsRepo']>,
    messagesRepo: {
      async listByConversation(conversationId: string) {
        calls.listByConversation += 1;
        const latest = seed.latestMessage?.[conversationId];
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

describe('filter=unknown - the contact-side read', () => {
  it('costs one partition Query, never the open-partition walk: 40 open threads, 1 unknown -> 1 listByType, 0 listByLastActivity, 0 findByPhone, 0 listRelayGroups', async () => {
    // THE STARVED FIXTURE (spec section 6): many open conversations, few
    // matches. Under the old pager this cost one findByPhone per conversation.
    // (Nothing here is unread, which used to matter: a resurfacing sweep
    // resolved a contact per visible unread index item and would have polluted
    // the findByPhone count. The sweep was deleted 2026-08-26 and the
    // unread-independence is now pinned outright by THE READ THAT SHIPS
    // below, which DOES carry unread rows and still expects zero.)
    const contacts: ContactItem[] = [{ contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550002000' }];
    const conversations: ConversationItem[] = [
      conv({ conversationId: 'cv-unk', participant_phone: '+15550002000', last_activity_at: '2026-06-12T12:00:00.000Z' }),
    ];
    for (let i = 0; i < 40; i += 1) {
      contacts.push({ contactId: `c-t-${i}`, type: 'tenant', phone: `+1555100${String(i).padStart(4, '0')}` });
      conversations.push(
        conv({
          conversationId: `cv-t-${i}`,
          type: 'tenant_1to1',
          participant_phone: `+1555100${String(i).padStart(4, '0')}`,
          last_activity_at: `2026-06-11T${String(10 + (i % 12)).padStart(2, '0')}:00:00.000Z`,
        }),
      );
    }
    const calls = emptyCalls();
    const page = await aggregateInbox({ filter: 'unknown', limit: 30 }, makeDeps({ contacts, conversations }, calls));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-unk']);
    expect(calls.listByType).toBe(1);
    expect(calls.listByLastActivity).toBe(0); // the pager never runs
    expect(calls.findByPhone).toBe(0); // no per-conversation contact resolution
    expect(calls.queryUnreadPage).toBe(0); // the branch does not touch byUnread at all
    expect(calls.listRelayGroups).toBe(0); // nothing to filter away
    expect(calls.listGroupTexts).toBe(0);
  });

  it('a cap-cut queue: single page, no truncated key, WARNed - and the cut is PARTITION order, so the newest rows can be the hidden ones', async () => {
    // Every contact here shares status='needs_review', so the range-key sort
    // ties and partition order falls back to contactId (c-u0..c-u3) - while
    // activity order is the REVERSE (c-u3 newest). The collector cap keeps the
    // first maxRows in PARTITION order, and the byTypeStatus range key is
    // `status`, which carries no recency dimension - so the two NEWEST
    // contacts are exactly the hidden ones, and the rendered list is
    // "newest-first of what survived", NOT "the newest of the queue". This is
    // the documented, deliberate limitation of cap-plus-WARN (spec
    // requirement 2); the WARN copy names it, and this pin is what keeps
    // anyone from quietly claiming otherwise.
    //
    // A SINGLE-STATUS fixture isolates the recency half of the problem. The
    // MIXED-status case - where the cut is not merely recency-blind but
    // deterministically starves `needs_review` - is pinned at the collector in
    // test/unknownQueue.test.ts ("THE CAP STARVES needs_review").
    const contacts = Array.from({ length: 4 }, (_, i) => ({
      contactId: `c-u${i}`,
      type: 'unknown' as const,
      status: 'needs_review',
      phone: `+155500021${String(i).padStart(2, '0')}`,
    }));
    const conversations = contacts.map((c, i) =>
      conv({
        conversationId: `cv-u${i}`,
        participant_phone: c.phone!,
        last_activity_at: `2026-06-12T0${i}:00:00.000Z`, // c-u3 is the newest
      }),
    );
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 30 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info: vi.fn(), warn }, { unknownQueueMaxRows: 2 }),
    );
    // Kept: c-u0 and c-u1 (partition order), then sorted newest-first.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-u1', 'c-u0']);
    expect(page.nextCursor).toBeNull();
    // The wire flag belongs to the unread branch (InboxPage.truncated) - and
    // an empty page carrying it renders the dashboard FAILURE banner on a tab
    // whose normal state is an empty queue (requirement 5).
    expect('truncated' in page).toBe(false);
    expect('groupsTruncated' in page).toBe(false);
    // The collector's WARN is the truncation signal, and its copy carries the
    // ordering caveat. The matched phrase moved with the round-2 N2 rewrite:
    // the copy no longer claims WHICH rows were hidden (false on an
    // all-`active` partition), only the status-ascending mechanism that is true
    // in every composition.
    expect(
      warn.mock.calls.some((c) => String(c[1]).includes('needs_review rows are cut FIRST')),
    ).toBe(true);
  });

  it('windows the sorted result to the request limit and WARNs about the rows it could not show', async () => {
    const contacts = Array.from({ length: 5 }, (_, i) => ({
      contactId: `c-w${i}`,
      type: 'unknown' as const,
      status: 'active',
      phone: `+155500022${String(i).padStart(2, '0')}`,
    }));
    const conversations = contacts.map((c, i) =>
      conv({
        conversationId: `cv-w${i}`,
        participant_phone: c.phone!,
        last_activity_at: `2026-06-12T0${i}:00:00.000Z`,
      }),
    );
    const warn = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 3 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info: vi.fn(), warn }),
    );
    // Newest first, exactly `limit` rows.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-w4', 'c-w3', 'c-w2']);
    expect(page.nextCursor).toBeNull();
    expect(warn.mock.calls.some((c) => String(c[1]).includes('could not show every triage row'))).toBe(true);
  });

  it('rejects any cursor: the unknown feed mints none, so a cursor here is foreign (400 posture, not a wrong-partition Query)', async () => {
    const deps = makeDeps({ contacts: [], conversations: [] });
    const allCursor = Buffer.from(JSON.stringify({ idx: 0 }), 'utf8').toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: allCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
    const unreadCursor = Buffer.from(
      JSON.stringify({ u: 1, a: '2026-06-12T10:00:00.000Z', c: 'cv-x', s: [] }),
      'utf8',
    ).toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: unreadCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
  });

  it('requirement 4: a THROWN thread read withholds ONE row loudly - it neither 500s the tab nor impersonates an empty thread set', async () => {
    const seed: Seed = {
      contacts: [
        { contactId: 'c-ok', type: 'unknown', status: 'needs_review', phone: '+15550002300' },
        { contactId: 'c-broken', type: 'unknown', status: 'needs_review', phone: '+15550002301' },
        { contactId: 'c-empty', type: 'unknown', status: 'needs_review', phone: '+15550002302' }, // no threads at all
      ],
      conversations: [
        conv({ conversationId: 'cv-ok', participant_phone: '+15550002300', last_activity_at: '2026-06-12T10:00:00.000Z' }),
        conv({ conversationId: 'cv-broken', participant_phone: '+15550002301', last_activity_at: '2026-06-12T11:00:00.000Z' }),
      ],
      threadLookupErrorPhone: '+15550002301',
    };
    const info = vi.fn();
    const warn = vi.fn();
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed, emptyCalls(), { info, warn }));
    // The page SERVES (no throw), minus exactly the broken row.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-ok']);
    // The failure is its OWN code path: the specific WARN with the contactId...
    const failLine = warn.mock.calls.find((c) => String(c[1]).includes('thread read FAILED'));
    expect(failLine?.[0]).toMatchObject({ contactId: 'c-broken' });
    // ...and its OWN drop reason, distinct from the empty-thread-set drop. A
    // build that routes this through the best-effort contactConversations seam
    // (which returns [] for both) collapses these two counters into one and
    // goes red here.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownThreadReadFailed: 1, unknownNoOpenThread: 1 });
    expect(assembled?.threadReadFailures).toBe(1);
  });

  it('class b: a contact whose only threads are closed or relay_group yields no row', async () => {
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps({
      contacts: [{ contactId: 'c-b', type: 'unknown', status: 'needs_review', phone: '+15550002400' }],
      conversations: [
        conv({ conversationId: 'cv-closed', participant_phone: '+15550002400', last_activity_at: '2026-06-12T10:00:00.000Z', status: 'closed' }),
        conv({ conversationId: 'cv-relay', participant_phone: '+15550002400', last_activity_at: '2026-06-12T11:00:00.000Z', type: 'relay_group' }),
      ],
    }));
    expect(page.rows).toEqual([]);
  });

  // DELETED 2026-08-26 with the resurfacing sweep itself: "class d via
  // byUnread" (a soft-deleted unknown resurfacing HERE) and "a CAPPED sweep is
  // a floor and says so". Both pinned sweep mechanics, and a soft-deleted
  // unknown no longer enters this queue at all - the ruling is that a contact
  // you deliberately deleted has already been triaged. The surviving class (d)
  // pin lives in test/inboxUnknownParity.test.ts, where it asserts the ABSENCE
  // here alongside the `filter: 'all'` row that keeps the trade honest.

  it('a failed triage-partition Query is LOUD: the branch propagates (route 500), never an empty queue impersonating health', async () => {
    // The module norm is best-effort, but "no unknown contacts" and "the
    // query broke" must not be indistinguishable - the failure mode is the
    // whole triage queue silently vanishing behind a healthy empty state.
    // Same posture, same reason as the group source (inbox.ts
    // readGroupSource).
    const seed: Seed = {
      contacts: [],
      conversations: [],
      listByTypeOverride: () => {
        throw new Error('byTypeStatus unavailable');
      },
    };
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed)),
    ).rejects.toThrow('byTypeStatus unavailable');
  });

  it('THE READ THAT SHIPS: ONE partition Query and nothing else - no byUnread walk, no contact read per unread item', async () => {
    // The starved pin above zeroes the unread index to isolate the queue
    // read; this one prices the whole configuration production runs, on a
    // fixture that is DELIBERATELY unread-heavy, so the branch's cost claim is
    // on the record rather than assumed. Fixture: one live queue row (no
    // unread), two unread tenant threads, one deleted unknown with a fresh
    // post-deletion inbound.
    //
    // REWRITTEN 2026-08-26 when the resurfacing sweep was deleted. It used to
    // assert the CHEAPER-IN-QUANTITY-BUT-WORSE-IN-CONSTANT shape the sweep
    // bought: `queryUnreadPage: 1` and `findByPhone: 3` - one index page plus
    // ONE contact resolution per VISIBLE UNREAD ITEM, on every page load and
    // re-paid on every debounced refetch. Both are now ZERO, and the unread
    // population no longer appears in this branch's cost at all. A cost claim
    // with no test is how the old open-partition walk survived so long, which
    // is why this pin was rewritten rather than deleted.
    const seed: Seed = {
      contacts: [
        { contactId: 'c-unk', type: 'unknown', status: 'needs_review', phone: '+15550002900' },
        { contactId: 'c-t1', type: 'tenant', phone: '+15550002901' },
        { contactId: 'c-t2', type: 'tenant', phone: '+15550002902' },
        { contactId: 'c-del', type: 'unknown', status: 'needs_review', phone: '+15550002903', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-q', participant_phone: '+15550002900', last_activity_at: '2026-06-12T13:00:00.000Z' }),
        conv({ conversationId: 'cv-t1', type: 'tenant_1to1', participant_phone: '+15550002901', last_activity_at: '2026-06-12T12:00:00.000Z', unread_count: 1 }),
        conv({ conversationId: 'cv-t2', type: 'tenant_1to1', participant_phone: '+15550002902', last_activity_at: '2026-06-12T11:00:00.000Z', unread_count: 2 }),
        conv({ conversationId: 'cv-del', participant_phone: '+15550002903', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
      ],
      latestMessage: {
        'cv-del': { type: 'sms', direction: 'inbound', body: 'still there?', created_at: '2026-06-12T10:00:00.000Z' },
      },
    };
    const calls = emptyCalls();
    const info = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 25 },
      makeDeps(seed, calls, { info, warn: vi.fn() }),
    );
    // c-del is soft-deleted: listByType's `deleted` option is a tri-state with
    // no "both", so it cannot come from the partition read, and nothing else
    // looks for it any more.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-unk']);
    // The queue read: one partition Query, no open-partition walk.
    expect(calls.listByType).toBe(1);
    expect(calls.listByLastActivity).toBe(0);
    // THE CHEAPER SHAPE, and the whole point of the rewrite: the byUnread
    // index is never touched, so three unread threads cost nothing here. These
    // two zeros are what make this branch's cost independent of how far behind
    // the operator is.
    expect(calls.queryUnreadPage).toBe(0);
    expect(calls.findByPhone).toBe(0);
    // Thread resolution: the one queue row.
    expect(calls.findByParticipantPhone).toBe(1);
    // Message reads: one latest-message hydration for the one rendered row
    // (cv-q). The collector's resurfacing probe on cv-del is gone with the
    // sweep.
    expect(calls.listByConversation).toBe(1);
    // And the retired cost field is GONE from the log, not zeroed - an old
    // query for it must return nothing rather than a misleading 0.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled).not.toHaveProperty('sweepScanned');
    // If any of these counts move, find WHICH read moved and why before
    // repinning - each number above names its buyer.
  });

  it('sorts the triage rows newest displayed activity first - and the soft-deleted unknown between them is simply not there', async () => {
    // c-mid is a soft-deleted unknown with an unread post-deletion inbound,
    // and it sits BETWEEN the two live rows by activity - so if anything ever
    // re-admits deleted contacts to this queue, this pin catches it in the
    // middle of the list rather than at an edge.
    const seed: Seed = {
      contacts: [
        { contactId: 'c-old', type: 'unknown', status: 'needs_review', phone: '+15550002600' },
        { contactId: 'c-new', type: 'unknown', status: 'active', phone: '+15550002601' },
        { contactId: 'c-mid', type: 'unknown', status: 'needs_review', phone: '+15550002602', deleted_at: '2026-06-10T00:00:00.000Z' },
      ],
      conversations: [
        conv({ conversationId: 'cv-old', participant_phone: '+15550002600', last_activity_at: '2026-06-12T08:00:00.000Z' }),
        conv({ conversationId: 'cv-new', participant_phone: '+15550002601', last_activity_at: '2026-06-12T12:00:00.000Z' }),
        conv({ conversationId: 'cv-mid', participant_phone: '+15550002602', last_activity_at: '2026-06-12T10:00:00.000Z', unread_count: 1 }),
      ],
      latestMessage: {
        'cv-mid': { type: 'sms', direction: 'inbound', body: 'hey', created_at: '2026-06-12T10:00:00.000Z' },
      },
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-new', 'c-old']);
  });

  it('the type guard drops a non-unknown row - reached ONLY through an override, because no real Query can produce one', async () => {
    // READ THIS BEFORE TRUSTING THE PIN. The guard it exercises is
    // STRUCTURALLY UNREACHABLE in production (adversarial MED-2, 2026-08-25):
    // listByType('unknown') Queries the index whose HASH KEY IS `type`, so
    // every item it can return carries type === 'unknown', and roleFromContact
    // reads that same attribute off that same image. Even the retype race this
    // was originally written for does not reach it - a stale index entry stays
    // keyed type='unknown' with its projected `type` stale to match.
    //
    // So `listByTypeOverride` below is not a convenience: it is the ONLY way
    // to drive this arm, and it deliberately supplies an item shape
    // (`type: 'tenant'` from the unknown partition) that the shared
    // DynamoDB-faithful fake would never emit. What this test pins is the
    // guard's BEHAVIOUR if a future caller ever hands the loop contacts from
    // somewhere other than a byTypeStatus Query - not a path any production
    // request takes, and `unknownQueueRetyped` will never appear on a real log
    // line.
    const seed: Seed = {
      contacts: [],
      conversations: [conv({ conversationId: 'cv-x', participant_phone: '+15550002700', last_activity_at: '2026-06-12T10:00:00.000Z' })],
      listByTypeOverride: () => ({
        items: [{ contactId: 'c-retyped', type: 'tenant', phone: '+15550002700' } as ContactItem],
      }),
    };
    const info = vi.fn();
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed, emptyCalls(), { info, warn: vi.fn() }));
    expect(page.rows).toEqual([]);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownQueueRetyped: 1 });
  });

  it('a DUPLICATED queue item ships ONE row: the partition loop consults `emitted`, like its sibling sweep loop', async () => {
    // REGRESSION TEST for round-2 finding N5. Before the guard landed, the
    // partition loop ADDED to `emitted` and never read it (the resurfacing
    // sweep, deleted 2026-08-26, was the only reader) - so this fixture
    // produced two identical `kind: 'contact'` rows on the wire, which the
    // dashboard keys identically (useInbox `rowKey` -> `c:<contactId>`): a
    // duplicate React key and a doubled row. The guard is NOT sweep leftovers:
    // it guards the PARTITION read, and this is the shape it guards.
    //
    // WHY A DUPLICATE IS REACHABLE AT ALL, stated narrowly. A Query resuming
    // from an ExclusiveStartKey cannot re-serve an item unless the item's index
    // key MOVED - and `status` IS byTypeStatus's range key, so a contact
    // flipped 'active' -> 'needs_review' between two pages of the SAME walk
    // moves forward past the cursor and is collected twice. That needs a
    // multi-page walk (>100 unknown contacts) and a write landing between two
    // sequential Queries. `listByTypeOverride` is how the shape is driven here,
    // because the DynamoDB-faithful fake pages a static array and will never
    // race itself.
    const dup: ContactItem = {
      contactId: 'c-dup',
      type: 'unknown',
      status: 'needs_review',
      phone: '+15550002800',
    } as ContactItem;
    const seed: Seed = {
      contacts: [dup],
      conversations: [
        conv({
          conversationId: 'cv-dup',
          participant_phone: '+15550002800',
          last_activity_at: '2026-06-12T11:00:00.000Z',
        }),
      ],
      listByTypeOverride: () => ({ items: [dup, dup] }),
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-dup']);
    expect(new Set(page.rows.map((r) => r.contactId)).size).toBe(page.rows.length);
  });
});
