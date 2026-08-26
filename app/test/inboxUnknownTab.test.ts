// app/test/inboxUnknownTab.test.ts
//
// The filter=unknown CONTACT-SIDE read (design 2026-08-25; reworked into a
// paged, unbounded read 2026-08-26): behavior, coverage classes, failure
// discrimination, paging, and the cost inversion. The parity file
// (inboxUnknownParity.test.ts) pins row CONTENT across the flip; this file
// pins the MECHANICS - what is read, in what order, what happens when a read
// fails, and what the cursor guarantees.
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateInbox,
  InboxBadRequestError,
  type InboxRouterDeps,
} from '../src/routes/inbox.js';
import type { ConversationItem } from '../src/repos/conversationsRepo.js';
import type { ContactItem, ListContactsOpts } from '../src/repos/contactsRepo.js';
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
  listByTypeOverride?: (type: string, opts: ListContactsOpts) => { items: ContactItem[] };
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
  logger?: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    /** Optional, because only the page-head thread-failure pins read it. */
    error?: ReturnType<typeof vi.fn>;
  },
  seams?: Pick<InboxRouterDeps, 'unknownQueueScanBudget' | 'unknownQueuePageSize'>,
): InboxRouterDeps {
  const log = logger ?? { info: vi.fn(), warn: vi.fn() };
  return {
    logger: { error: vi.fn(), debug: vi.fn(), ...log } as never,
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
      async listByType(type: string, opts: ListContactsOpts = {}) {
        calls.listByType += 1;
        if (seed.listByTypeOverride !== undefined) return seed.listByTypeOverride(type, opts);
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

/** One unknown contact plus its open 1:1 thread. */
function queueContact(
  id: string,
  status: 'needs_review' | 'active',
  phoneTail: number,
  lastActivityAt: string,
): { contact: ContactItem; conversation: ConversationItem } {
  const phone = `+1555${String(3_000_000 + phoneTail).padStart(7, '0')}`;
  return {
    contact: { contactId: id, type: 'unknown', status, phone },
    conversation: conv({
      conversationId: `cv-${id}`,
      participant_phone: phone,
      last_activity_at: lastActivityAt,
    }),
  };
}

describe('filter=unknown - the contact-side read', () => {
  it('costs one Query PER BLOCK, never the open-partition walk: 40 open threads, 1 unknown -> 2 listByType, 0 listByLastActivity, 0 findByPhone', async () => {
    // THE STARVED FIXTURE (spec section 6): many open conversations, few
    // matches. Under the original pager this cost one findByPhone per
    // conversation. TWO listByType calls now, not one: the read issues a
    // bounded Query per STATUS BLOCK (needs_review, then active) so a
    // (unknown, active) contact stays covered - coverage class f - while the
    // untriaged block is drained first.
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
    expect(page.nextCursor).toBeNull(); // both blocks drained
    expect(calls.listByType).toBe(2); // one per block
    expect(calls.listByLastActivity).toBe(0); // the pager never runs
    expect(calls.findByPhone).toBe(0); // no per-conversation contact resolution
    expect(calls.queryUnreadPage).toBe(0); // the branch does not touch byUnread at all
    expect(calls.listRelayGroups).toBe(0); // nothing to filter away
    expect(calls.listGroupTexts).toBe(0);
  });

  it('THE FULL WALK: every row is reachable across both blocks - the union of all pages is the whole queue, with no duplicates and no skips', async () => {
    // The pin the rework exists for. The pre-rework read served ONE window and
    // minted no cursor, so row 31 was unreachable by any client action; this
    // walks a queue three pages deep and proves the union is exact.
    const seeds = [
      queueContact('c-n0', 'needs_review', 10, '2026-06-12T01:00:00.000Z'),
      queueContact('c-n1', 'needs_review', 11, '2026-06-12T02:00:00.000Z'),
      queueContact('c-n2', 'needs_review', 12, '2026-06-12T03:00:00.000Z'),
      queueContact('c-n3', 'needs_review', 13, '2026-06-12T04:00:00.000Z'),
      queueContact('c-a0', 'active', 14, '2026-06-12T05:00:00.000Z'),
      queueContact('c-a1', 'active', 15, '2026-06-12T06:00:00.000Z'),
      queueContact('c-a2', 'active', 16, '2026-06-12T07:00:00.000Z'),
    ];
    const seed: Seed = {
      contacts: seeds.map((s) => s.contact),
      conversations: seeds.map((s) => s.conversation),
    };
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await aggregateInbox(
        { filter: 'unknown', limit: 3, ...(cursor !== undefined && { cursor }) },
        makeDeps(seed),
      );
      pages.push(page.rows.map((r) => r.contactId!));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    const seen = pages.flat();
    // NO SKIPS: the union is the whole queue.
    expect([...seen].sort()).toEqual(
      ['c-a0', 'c-a1', 'c-a2', 'c-n0', 'c-n1', 'c-n2', 'c-n3'],
    );
    // NO DUPLICATES.
    expect(new Set(seen).size).toBe(seen.length);
    // Three pages of 3/3/1, and the last one ends paging.
    expect(pages.map((p) => p.length)).toEqual([3, 3, 1]);

    // UNTRIAGED BEFORE REVIEWED, ACROSS THE PAGE BOUNDARY. Every needs_review
    // row is served on a page no later than the first page carrying a reviewed
    // one - which is what the 2026-08-26 ruling bought, and what makes the
    // starvation the old cap caused impossible.
    const pageOf = (id: string) => pages.findIndex((p) => p.includes(id));
    const lastUntriaged = Math.max(...['c-n0', 'c-n1', 'c-n2', 'c-n3'].map(pageOf));
    const firstReviewed = Math.min(...['c-a0', 'c-a1', 'c-a2'].map(pageOf));
    expect(lastUntriaged).toBeLessThanOrEqual(firstReviewed);
    // Page 1 is untriaged rows ONLY, sorted newest-first WITHIN the page - the
    // per-page sort, not a global one. The global order is queue order, which
    // is why c-a2 (the newest row in the whole queue) is on the LAST page.
    expect(pages[0]).toEqual(['c-n2', 'c-n1', 'c-n0']);
    expect(pages[2]).toEqual(['c-a2']);
  });

  it('a page that fills mints a cursor that resumes EXACTLY after the last row it served - no re-serve, no skip', async () => {
    const seeds = [
      queueContact('c-p0', 'needs_review', 20, '2026-06-12T01:00:00.000Z'),
      queueContact('c-p1', 'needs_review', 21, '2026-06-12T02:00:00.000Z'),
      queueContact('c-p2', 'needs_review', 22, '2026-06-12T03:00:00.000Z'),
    ];
    const seed: Seed = {
      contacts: seeds.map((s) => s.contact),
      conversations: seeds.map((s) => s.conversation),
    };
    const first = await aggregateInbox({ filter: 'unknown', limit: 2 }, makeDeps(seed));
    expect(first.rows.map((r) => r.contactId)).toEqual(['c-p1', 'c-p0']);
    expect(first.nextCursor).not.toBeNull();
    // ROUND TRIP: the cursor this branch minted is accepted by this branch.
    const second = await aggregateInbox(
      { filter: 'unknown', limit: 2, cursor: first.nextCursor! },
      makeDeps(seed),
    );
    expect(second.rows.map((r) => r.contactId)).toEqual(['c-p2']);
    expect(second.nextCursor).toBeNull();
  });

  it('rejects a FOREIGN cursor (400, never a wrong-partition Query) - and its own cursor is foreign to filter=all', async () => {
    const deps = makeDeps({ contacts: [], conversations: [] });
    const allCursor = Buffer.from(JSON.stringify({ idx: 0 }), 'utf8').toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: allCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
    const unreadCursor = Buffer.from(
      JSON.stringify({ u: 1, a: '2026-06-12T10:00:00.000Z', c: 'cv-x', s: [] }),
      'utf8',
    ).toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: unreadCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
    const groupCursor = Buffer.from(JSON.stringify({ t: 'g', k: {} }), 'utf8').toString('base64url');
    await expect(aggregateInbox({ filter: 'unknown', limit: 25, cursor: groupCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
    // TAMPERED PAYLOADS INSIDE OUR OWN NAMESPACE. Every one of these reaches
    // DynamoDB and returns 500 if the decoder does not refuse it: the route
    // maps only InboxBadRequestError to 400 and rethrows everything else, so a
    // ValidationException is a 500 on an endpoint whose decoder exists to
    // guarantee 400s.
    const tampered: Array<[string, unknown]> = [
      // An out-of-range block index (would index UNKNOWN_QUEUE_BLOCKS to
      // undefined and crash the reader).
      ['block index out of range', { q: 1, b: 99 }],
      // An empty key attribute: DynamoDB permits an empty String for a non-key
      // attribute ONLY, so this is a ValidationException.
      [
        'empty key attribute',
        { q: 1, b: 0, k: { type: 'unknown', status: 'needs_review', contactId: '' } },
      ],
      // THE FIVE SHAPES MEASURED AGAINST DYNAMODB LOCAL (rework review A2/B3),
      // none of which the pre-2026-08-26 decoder caught. The first three answer
      // "The provided starting key is invalid"...
      ['junk key names', { q: 1, b: 0, k: { foo: 'bar' } }],
      ['index keys missing', { q: 1, b: 0, k: { contactId: 'c2' } }],
      [
        'an EXTRA attribute alongside valid keys',
        {
          q: 1,
          b: 0,
          k: { type: 'unknown', status: 'needs_review', contactId: 'c2', extra: 'x' },
        },
      ],
      // ...and these two "does not match the range key predicate": the block
      // picks the Query's KeyConditionExpression while `k` is its
      // ExclusiveStartKey, and nothing used to check that the pair named the
      // same partition. Block 0 is needs_review.
      [
        'k.status contradicting the block',
        { q: 1, b: 0, k: { type: 'unknown', status: 'active', contactId: 'a1' } },
      ],
      [
        'a wrong type',
        { q: 1, b: 0, k: { type: 'tenant', status: 'needs_review', contactId: 'a1' } },
      ],
    ];
    for (const [, payload] of tampered) {
      const cursor = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
      await expect(
        aggregateInbox({ filter: 'unknown', limit: 25, cursor }, deps),
      ).rejects.toBeInstanceOf(InboxBadRequestError);
    }
    // AND THE HONEST CURSOR STILL ROUND-TRIPS - a validator that refuses
    // everything passes the assertions above and breaks paging. The other
    // direction is covered by "a page that fills mints a cursor that resumes
    // EXACTLY after the last row it served".
    const honest = Buffer.from(
      JSON.stringify({ q: 1, b: 1, k: { type: 'unknown', status: 'active', contactId: 'c-x' } }),
      'utf8',
    ).toString('base64url');
    await expect(
      aggregateInbox({ filter: 'unknown', limit: 25, cursor: honest }, deps),
    ).resolves.toMatchObject({ rows: [] });
    // THE OTHER DIRECTION: an unknown cursor replayed under `all` would hand
    // the 'open' partition Query a byTypeStatus key.
    const ourCursor = Buffer.from(JSON.stringify({ q: 1, b: 0 }), 'utf8').toString('base64url');
    await expect(aggregateInbox({ filter: 'all', limit: 25, cursor: ourCursor }, deps)).rejects.toBeInstanceOf(InboxBadRequestError);
  });

  it('the SCAN BUDGET returns a SHORT page WITH a cursor - never the wire `truncated` flag, and nothing is lost', async () => {
    // A wall of soft-deleted residue: the FilterExpression runs after Limit, so
    // the pages come back empty with a key in hand. The budget stops the
    // request; the CURSOR is the continuation signal.
    //
    // A budget-stopped page that keeps ZERO rows returns an EMPTY page WITH a
    // cursor. The dashboard renders its ordinary empty state plus a live Load
    // more - odd-looking, honest, and specifically NOT the failure banner that
    // `truncated` would light (it is not filter-gated in useInbox/Inbox.tsx).
    const contacts: ContactItem[] = [];
    const conversations: ConversationItem[] = [];
    for (let i = 0; i < 8; i += 1) {
      const { contact, conversation } = queueContact(`c-d${i}`, 'needs_review', 40 + i, '2026-06-12T01:00:00.000Z');
      contacts.push({ ...contact, deleted_at: '2026-06-01T00:00:00.000Z' });
      conversations.push(conversation);
    }
    const live = queueContact('c-live', 'needs_review', 60, '2026-06-12T09:00:00.000Z');
    contacts.push(live.contact);
    conversations.push(live.conversation);

    const info = vi.fn();
    const seams = { unknownQueuePageSize: 2, unknownQueueScanBudget: 4 };
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 25 },
      makeDeps({ contacts, conversations }, emptyCalls(), { info, warn: vi.fn() }, seams),
    );
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).not.toBeNull();
    expect('truncated' in page).toBe(false);
    expect('groupsTruncated' in page).toBe(false);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled).toMatchObject({ count: 0, budgetStopped: true });

    // AND THE ROW BEHIND THE WALL IS REACHABLE: keep paging with the same tiny
    // budget and it arrives. The deleted page-budget behaviour reported
    // `truncated` and stranded it.
    let cursor: string | null = page.nextCursor;
    const reached: string[] = [];
    for (let guard = 0; guard < 12 && cursor !== null; guard += 1) {
      const next: Awaited<ReturnType<typeof aggregateInbox>> = await aggregateInbox(
        { filter: 'unknown', limit: 25, cursor },
        makeDeps({ contacts, conversations }, emptyCalls(), undefined, seams),
      );
      reached.push(...next.rows.map((r) => r.contactId!));
      cursor = next.nextCursor;
    }
    expect(reached).toEqual(['c-live']);
  });

  it('THE COST IS THE PAGE, NOT THE PARTITION: a small page pays thread resolutions for the rows it serves, not for the queue', async () => {
    // The pin that replaces the old hydration-cost claim. The pre-rework read
    // resolved threads AND hydrated every collected row (up to the 200 cap)
    // before a window discarded most of them; this one stops consuming the
    // moment the page is full.
    const seeds = Array.from({ length: 10 }, (_, i) =>
      queueContact(`c-c${i}`, 'needs_review', 70 + i, `2026-06-12T0${i % 10}:00:00.000Z`),
    );
    const seed: Seed = {
      contacts: seeds.map((s) => s.contact),
      conversations: seeds.map((s) => s.conversation),
    };
    const calls = emptyCalls();
    const page = await aggregateInbox({ filter: 'unknown', limit: 2 }, makeDeps(seed, calls));
    expect(page.rows).toHaveLength(2);
    // ONE block Query (the page filled inside the untriaged block, so the
    // reviewed block is never touched)...
    expect(calls.listByType).toBe(1);
    // ...TWO thread resolutions, one per row SERVED - not ten, one per row in
    // the partition...
    expect(calls.findByParticipantPhone).toBe(2);
    // ...and TWO latest-message reads, because presentation hydration runs only
    // over the rows being returned.
    expect(calls.listByConversation).toBe(2);
    // If any of these counts move, find WHICH read moved and why before
    // repinning - each number above names its buyer.
  });

  it('requirement 4: a THROWN thread read STOPS the page AT that row - it neither 500s the tab nor steps over the row', async () => {
    // REWRITTEN 2026-08-26 (rework review A3/M3) for a BEHAVIOUR CHANGE. The
    // old build `continue`d past a failed row, kept filling the page from LATER
    // rows and then minted the boundary from one of THEM - so the cursor
    // stepped over a row that was never served and the walk still ended
    // `nextCursor: null`. The row appeared on NO page; the WARN called it
    // "withheld from this page" and it was withheld from everything.
    //
    // Now the failure ENDS the page and the boundary is set AT the failed row,
    // so the next request re-attempts it. The ids sort ascending in the
    // partition (rule 6), so `c-q1-ok` is consumed and kept BEFORE the failure
    // - which is what makes "the rows already kept still ship" a real claim
    // here rather than a vacuous one.
    const seed: Seed = {
      contacts: [
        { contactId: 'c-q1-ok', type: 'unknown', status: 'needs_review', phone: '+15550002300' },
        { contactId: 'c-q2-broken', type: 'unknown', status: 'needs_review', phone: '+15550002301' },
        { contactId: 'c-q3-empty', type: 'unknown', status: 'needs_review', phone: '+15550002302' }, // no threads at all
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
    // The page SERVES (no throw) the rows it had already kept...
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-q1-ok']);
    // ...and it is a SHORT page WITH a cursor, not the end of the queue. A null
    // cursor here is the silent-loss shape this fix removed.
    expect(page.nextCursor).not.toBeNull();
    // The failure is its OWN code path: the specific WARN with the contactId...
    const failLine = warn.mock.calls.find((c) => String(c[1]).includes('thread read FAILED'));
    expect(failLine?.[0]).toMatchObject({ contactId: 'c-q2-broken' });
    // ...and its OWN drop reason, distinct from the empty-thread-set drop. A
    // build that routes this through the best-effort contactConversations seam
    // (which returns [] for both) collapses these two counters into one and
    // goes red here.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownThreadReadFailed: 1 });
    expect(assembled?.threadReadFailures).toBe(1);
    // c-q3-empty is BEHIND the failed row and was never consumed, so its
    // no-open-thread drop has not happened yet. That is the point: the page
    // stopped rather than reading past the failure.
    expect(assembled?.drops).not.toHaveProperty('unknownNoOpenThread');
  });

  it('a TRANSIENT thread-read failure costs a SHORT PAGE, not a lost row: the retry serves it', async () => {
    // A3/M3. The participant GSI throws for ONE contact on request 1 only (a
    // throttle, a timeout) and is healthy afterwards. Before the fix that row
    // appeared on zero pages of a walk that ended `nextCursor: null` - a
    // complete-looking queue with a row silently missing. The trade taken
    // instead: a PERMANENTLY failing row becomes a short page whose Load more
    // does not advance - visible-stuck rather than silent-loss.
    const seeds = [
      queueContact('c-t1', 'needs_review', 80, '2026-06-12T01:00:00.000Z'),
      queueContact('c-t2', 'needs_review', 81, '2026-06-12T02:00:00.000Z'),
      queueContact('c-t3', 'needs_review', 82, '2026-06-12T03:00:00.000Z'),
      queueContact('c-t4', 'needs_review', 83, '2026-06-12T04:00:00.000Z'),
    ];
    const healthy: Seed = {
      contacts: seeds.map((s) => s.contact),
      conversations: seeds.map((s) => s.conversation),
    };
    const brokenPhone = seeds[1]!.contact.phone!;
    const flaky: Seed = { ...healthy, threadLookupErrorPhone: brokenPhone };

    // Request 1 consumes c-t1 (kept), then c-t2 THROWS and the page stops.
    const first = await aggregateInbox({ filter: 'unknown', limit: 2 }, makeDeps(flaky));
    expect(first.rows.map((r) => r.contactId)).toEqual(['c-t1']);
    expect(first.nextCursor).not.toBeNull();

    // THE BOUNDARY DOES NOT STEP OVER THE FAILED ROW. Replaying the cursor
    // against a HEALTHY world with room for exactly one row returns c-t2 -
    // i.e. the resume point is AT the failed row, not past it.
    const retry = await aggregateInbox(
      { filter: 'unknown', limit: 1, cursor: first.nextCursor! },
      makeDeps(healthy),
    );
    expect(retry.rows.map((r) => r.contactId)).toEqual(['c-t2']);

    // AND THE WHOLE WALK IS EXACT: one transient failure costs a short page and
    // nothing else - no row is lost and none is served twice.
    const seen = ['c-t1'];
    let cursor: string | null = first.nextCursor;
    for (let guard = 0; guard < 10 && cursor !== null; guard += 1) {
      const page: Awaited<ReturnType<typeof aggregateInbox>> = await aggregateInbox(
        { filter: 'unknown', limit: 2, cursor },
        makeDeps(healthy),
      );
      seen.push(...page.rows.map((r) => r.contactId!));
      cursor = page.nextCursor;
    }
    expect([...seen].sort()).toEqual(['c-t1', 'c-t2', 'c-t3', 'c-t4']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('a thread read that fails AT THE PAGE HEAD is STEPPED OVER, not retried forever', async () => {
    // F1 (fix wave 2, round-2 review N1). The stop-at-the-failed-row trade above
    // is bounded ONLY when the request has already made progress. When the
    // failure lands on the FIRST row this request consumes and NOTHING has been
    // kept, `retryFrom` is still the position the client sent, so the answer is
    // an empty page carrying the cursor it arrived with - every subsequent Load
    // more repeats it, verbatim, forever. That is byte-identical to the shape
    // readUnknownQueue THROWS to outlaw one file over ("a Load more that never
    // advances and never ends", unknownQueue.ts's budget guard).
    //
    // So the retry is capped at ONE: the previous request already re-read this
    // row, and the row is now DROPPED (an ERROR, not the deferral WARN) so the
    // walk can move. Neither pin above can see this - one failure clears, the
    // other has a kept row ahead of it.
    const broken = queueContact('c-h1-broken', 'needs_review', 90, '2026-06-12T01:00:00.000Z');
    const rest = [
      queueContact('c-h2', 'needs_review', 91, '2026-06-12T02:00:00.000Z'),
      queueContact('c-h3', 'needs_review', 92, '2026-06-12T03:00:00.000Z'),
    ];
    const seed: Seed = {
      contacts: [broken, ...rest].map((s) => s.contact),
      conversations: [broken, ...rest].map((s) => s.conversation),
      threadLookupErrorPhone: broken.contact.phone!,
    };
    const info = vi.fn();
    const warn = vi.fn();
    const error = vi.fn();
    const page = await aggregateInbox(
      { filter: 'unknown', limit: 25 },
      makeDeps(seed, emptyCalls(), { info, warn, error }),
    );
    // THE ROWS BEHIND THE BAD ROW SHIP. Before F1 this page was `[]`.
    expect(page.rows.map((r) => r.contactId).sort()).toEqual(['c-h2', 'c-h3']);
    // ...and the walk ENDS, rather than handing back the cursor it was given.
    expect(page.nextCursor).toBeNull();
    // THE LOG ESCALATES: a dropped row is an ERROR, and it is NOT the deferral
    // WARN, because nothing is being deferred any more.
    const errLine = error.mock.calls.find((c) => String(c[1]).includes('thread read FAILED'));
    expect(errLine?.[0]).toMatchObject({ contactId: 'c-h1-broken' });
    expect(warn.mock.calls.filter((c) => String(c[1]).includes('thread read FAILED'))).toEqual([]);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownThreadReadFailed: 1 });
  });

  it('a page-head failure AFTER A BLOCK ROLL-OVER does not strand the whole later block', async () => {
    // F1, the second unbounded shape. Page 1 fills inside `needs_review`, so
    // page 2 resumes at a position whose first CONSUMED row is the first row of
    // the `active` block. Before F1 that page came back empty with the cursor it
    // was sent and every remaining `active` row was unreachable from the UI.
    const seeds = [
      queueContact('c-r1', 'needs_review', 95, '2026-06-12T01:00:00.000Z'),
      queueContact('c-r2', 'needs_review', 96, '2026-06-12T02:00:00.000Z'),
      queueContact('c-r3-broken', 'active', 97, '2026-06-12T03:00:00.000Z'),
      queueContact('c-r4', 'active', 98, '2026-06-12T04:00:00.000Z'),
    ];
    const seed: Seed = {
      contacts: seeds.map((s) => s.contact),
      conversations: seeds.map((s) => s.conversation),
      threadLookupErrorPhone: seeds[2]!.contact.phone!,
    };
    const first = await aggregateInbox({ filter: 'unknown', limit: 2 }, makeDeps(seed));
    expect(first.rows.map((r) => r.contactId).sort()).toEqual(['c-r1', 'c-r2']);
    expect(first.nextCursor).not.toBeNull();

    // THE WHOLE WALK TERMINATES AND REACHES THE LIVE ROW BEHIND THE BAD ONE.
    // The guard is the assertion: a cursor that never advances spins to it.
    const seen = first.rows.map((r) => r.contactId!);
    let cursor: string | null = first.nextCursor;
    let pages = 0;
    for (; pages < 8 && cursor !== null; pages += 1) {
      const next: Awaited<ReturnType<typeof aggregateInbox>> = await aggregateInbox(
        { filter: 'unknown', limit: 2, cursor },
        makeDeps(seed),
      );
      seen.push(...next.rows.map((r) => r.contactId!));
      cursor = next.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen.sort()).toEqual(['c-r1', 'c-r2', 'c-r4']);
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
  //
  // DELETED 2026-08-26 with the RESULT CAP: "a cap-cut queue" and "windows the
  // sorted result to the request limit and WARNs". Both described a windowed,
  // cursorless feed that no longer exists - the first pinned rows being hidden
  // in partition order, the second a WARN for rows the response could not
  // reach. There is no window and no unreachable tail now; THE FULL WALK above
  // is what replaced them, and it asserts the opposite property.

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

  it('THE READ THAT SHIPS: block Queries and nothing else - no byUnread walk, no contact read per unread item', async () => {
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
    // no "both", so it cannot come from the block read, and nothing else looks
    // for it any more.
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-unk']);
    // The queue read: one Query per block, no open-partition walk.
    expect(calls.listByType).toBe(2);
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
    // And the retired cost fields are GONE from the log, not zeroed - an old
    // query for them must return nothing rather than a misleading 0.
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled).not.toHaveProperty('sweepScanned');
    expect(assembled).not.toHaveProperty('queueContacts');
    expect(assembled).not.toHaveProperty('queuePages');
    expect(assembled).not.toHaveProperty('queueTruncated');
  });

  it('sorts the triage rows on ONE page newest displayed activity first - and the soft-deleted unknown between them is simply not there', async () => {
    // c-mid is a soft-deleted unknown with an unread post-deletion inbound,
    // and it sits BETWEEN the two live rows by activity - so if anything ever
    // re-admits deleted contacts to this queue, this pin catches it in the
    // middle of the list rather than at an edge.
    //
    // NOTE what this does NOT say: c-new is `active` and c-old is
    // `needs_review`, so they come from DIFFERENT blocks and the read order is
    // c-old first. The per-PAGE sort is what puts c-new on top, and it applies
    // only because both fit on one page. Across a page boundary the untriaged
    // row would come FIRST - see THE FULL WALK above.
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
    // DynamoDB-faithful fake would never emit. It is scoped to the FIRST block
    // so the row is offered once, not once per block.
    const seed: Seed = {
      contacts: [],
      conversations: [conv({ conversationId: 'cv-x', participant_phone: '+15550002700', last_activity_at: '2026-06-12T10:00:00.000Z' })],
      listByTypeOverride: (_type, opts) =>
        opts.status === 'needs_review'
          ? { items: [{ contactId: 'c-retyped', type: 'tenant', phone: '+15550002700' } as ContactItem] }
          : { items: [] },
    };
    const info = vi.fn();
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed, emptyCalls(), { info, warn: vi.fn() }));
    expect(page.rows).toEqual([]);
    const assembled = info.mock.calls.find((c) => c[1] === 'inbox feed assembled')?.[0];
    expect(assembled?.drops).toMatchObject({ unknownQueueRetyped: 1 });
  });

  it('a WITHIN-REQUEST duplicate ships ONE row: the block loop consults `emitted` (it does NOT cover the cross-page shape)', async () => {
    // REGRESSION TEST for round-2 finding N5. Without the guard this fixture
    // produced two identical `kind: 'contact'` rows on the wire, which the
    // dashboard keys identically (useInbox `rowKey` -> `c:<contactId>`): a
    // duplicate React key and a doubled row.
    //
    // WHAT THIS ACTUALLY PINS, corrected 2026-08-26 (rework review A7). One
    // Query answering `[dup, dup]` - the WITHIN-request shape, which is exactly
    // what `emitted` (a per-REQUEST Set) covers. This comment used to describe
    // the CROSS-PAGE duplicate instead, a status flip moving a row past the
    // cursor between two HTTP requests, and then test something else: that
    // shape has no guard here and this test CANNOT fail for it. Read the
    // fixture, not the name.
    //
    // The cross-page shape is real, reachable, and deliberately unfixed -
    // docs/issues/unknown-queue-status-flip-duplicates-across-pages.md. A test
    // for it would have to assert the DEFECT, so there is none.
    //
    // `listByTypeOverride` is how the within-request shape is driven, because
    // the DynamoDB-faithful fake pages a static array and will never race
    // itself.
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
      listByTypeOverride: (_type, opts) =>
        opts.status === 'needs_review' ? { items: [dup, dup] } : { items: [] },
    };
    const page = await aggregateInbox({ filter: 'unknown', limit: 25 }, makeDeps(seed));
    expect(page.rows.map((r) => r.contactId)).toEqual(['c-dup']);
    expect(new Set(page.rows.map((r) => r.contactId)).size).toBe(page.rows.length);
  });
});
