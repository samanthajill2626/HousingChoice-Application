// Unit tests for the unread read model (design 2026-08-16, spec 4.3).
//
// LAYER 1 (`iterateUnreadConversations`) is a LAZY, PULL-BASED async generator
// over the sparse byUnread GSI. Laziness is the whole design: a consumer that
// stops pulling must stop the underlying Query paging, so the badge - the
// app's highest-frequency request - never walks the index to find its first
// 100 rows. The counting fake below is what proves it: an assertion on
// `calls.queryUnreadPage` is the only way a "materialized then sliced"
// implementation can be told apart from a lazy one.
//
// The conversations fake WRAPS the shared index model in
// test/helpers/unreadIndexFake.ts rather than re-deriving one: membership is
// the FLAG (never the counter) and order is the real
// (last_activity_at DESC, conversationId DESC) tuple, so a resume across a
// timestamp tie behaves the way DynamoDB does.
import { describe, expect, it, vi } from 'vitest';
import {
  collectUnreadRows,
  isOneToOneBucket,
  isUnreadVisible,
  iterateUnreadConversations,
  toExclusiveStartKey,
  warnDeletedProbes,
  BADGE_COUNT_CAP,
  UNREAD_DELETED_PROBE_LIMIT,
  UNREAD_DELETED_PROBE_WARN,
  UNREAD_WALK_LIMIT,
  UNREAD_WALK_WARN,
  type UnreadCandidate,
  type UnreadWalkState,
} from '../src/lib/unreadFeed.js';
import {
  GROUP_TEXT_STATUS,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
  type ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
import {
  contactEmails,
  contactPhones,
  type ContactItem,
  type ContactsRepo,
} from '../src/repos/contactsRepo.js';
import type { MessageItem, MessagesRepo } from '../src/repos/messagesRepo.js';
import type { Logger } from '../src/lib/logger.js';
import { queryUnreadPageFromItems } from './helpers/unreadIndexFake.js';

interface QueryCalls {
  queryUnreadPage: number;
}

function emptyQueryCalls(): QueryCalls {
  return { queryUnreadPage: 0 };
}

/**
 * The conversations dependency: the SHARED index model plus a call counter.
 * The counter lives here rather than inside the shared helper because it is a
 * property of THIS fake's wiring, not of the index's semantics.
 */
function makeConversations(
  items: ConversationItem[],
  calls: QueryCalls,
): Pick<ConversationsRepo, 'queryUnreadPage'> {
  return {
    async queryUnreadPage(opts) {
      calls.queryUnreadPage += 1;
      return queryUnreadPageFromItems(items, opts);
    },
  };
}

/** A logger whose `warn` is a spy; the tripwire tests assert through it. */
function makeLoggerSpy(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { warn } as unknown as Logger, warn };
}

function freshState(): UnreadWalkState {
  return { scanExhausted: false, scanned: 0 };
}

/** Descending timestamps: index position `i` is the (i+1)-th newest row. */
function tsAt(i: number): string {
  return new Date(Date.UTC(2026, 7, 16, 12, 0, 0) - i * 60_000).toISOString();
}

function conv(overrides: Partial<ConversationItem> & { conversationId: string }): ConversationItem {
  return {
    status: 'open',
    type: 'tenant_1to1',
    ai_mode: 'auto',
    created_at: tsAt(0),
    last_activity_at: tsAt(0),
    unread_count: 1,
    unread_flag: UNREAD_FLAG_VALUE,
    ...overrides,
  };
}

/**
 * A LEGACY row carrying NO `type` attribute. `ConversationItem.type` is
 * REQUIRED (worklist A4), so pre-`type` data cannot be expressed as a literal;
 * the attribute is dropped through the index signature instead. Weakening the
 * declared type to model a legacy fixture would ripple across the whole app.
 */
function withoutType(item: ConversationItem): ConversationItem {
  const row: Record<string, unknown> = { ...item };
  delete row['type'];
  return row as unknown as ConversationItem;
}

/** `count` visible 1:1 rows, newest first, ids ascending with age. */
function visibleSeries(count: number): ConversationItem[] {
  return Array.from({ length: count }, (_, i) =>
    conv({
      conversationId: `conv-${String(i).padStart(4, '0')}`,
      last_activity_at: tsAt(i),
      participant_phone: `+1555${String(1_000_000 + i)}`,
    }),
  );
}

async function drain(
  iterator: AsyncGenerator<ConversationItem>,
): Promise<ConversationItem[]> {
  const out: ConversationItem[] = [];
  for await (const item of iterator) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2 fixtures: contacts + messages
// ---------------------------------------------------------------------------

interface CollectCalls extends QueryCalls {
  findByPhone: number;
  findByEmail: number;
  listByConversation: number;
}

function emptyCollectCalls(): CollectCalls {
  return { queryUnreadPage: 0, findByPhone: 0, findByEmail: 0, listByConversation: 0 };
}

function contact(overrides: Partial<ContactItem> & { contactId: string }): ContactItem {
  return {
    type: 'tenant',
    status: 'searching',
    ...overrides,
  };
}

/**
 * Contact resolution derived exactly the way the repo derives it (the shared
 * contactPhones/contactEmails serializers), so a fixture that sets `phone`
 * instead of `phones[]` resolves here too.
 */
function makeContacts(
  contacts: ContactItem[],
  calls: CollectCalls,
  errors?: { findByPhone?: Error },
): Pick<ContactsRepo, 'findByPhone' | 'findByEmail'> {
  return {
    async findByPhone(phone) {
      calls.findByPhone += 1;
      if (errors?.findByPhone !== undefined) throw errors.findByPhone;
      return contacts.find((c) => contactPhones(c).some((p) => p.phone === phone));
    },
    async findByEmail(email) {
      calls.findByEmail += 1;
      return contacts.find((c) => contactEmails(c).some((e) => e.email === email));
    },
  };
}

function msg(overrides: Partial<MessageItem> & { created_at: string }): MessageItem {
  return {
    conversationId: 'conv-x',
    tsMsgId: `${overrides.created_at}#m1`,
    type: 'sms',
    direction: 'inbound',
    author: 'tenant',
    provider_sid: 'SM-test',
    provider_ts: overrides.created_at,
    delivery_status: 'delivered',
    ...overrides,
  };
}

/** Newest message per conversationId; an absent entry models "no readable row". */
function makeMessages(
  latest: Record<string, MessageItem>,
  calls: CollectCalls,
  throwFor?: string,
): Pick<MessagesRepo, 'listByConversation'> {
  return {
    async listByConversation(conversationId) {
      calls.listByConversation += 1;
      if (throwFor === conversationId) throw new Error('probe boom');
      const found = latest[conversationId];
      return found === undefined ? [] : [found];
    },
  };
}

/**
 * `count` rows in strict index order: BOTH the timestamp and the conversationId
 * descend with the array, so the tuple sort keeps array order even where a
 * deliberate `tie` makes two rows share one `last_activity_at`. Every row
 * resolves to its own contact.
 */
function contactSeries(
  count: number,
  tie?: number,
): { items: ConversationItem[]; contacts: ContactItem[] } {
  const items: ConversationItem[] = [];
  const contacts: ContactItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const phone = `+1555${String(2_000_000 + i)}`;
    items.push(
      conv({
        conversationId: `row-${String(count - i).padStart(4, '0')}`,
        last_activity_at: tsAt(tie !== undefined && i === tie + 1 ? tie : i),
        participant_phone: phone,
      }),
    );
    contacts.push(
      contact({
        contactId: `contact-${String(i).padStart(4, '0')}`,
        phones: [{ phone, primary: true }],
      }),
    );
  }
  return { items, contacts };
}

function contactCandidate(candidate: UnreadCandidate | undefined): Extract<
  UnreadCandidate,
  { kind: 'contact' }
> {
  if (candidate === undefined || candidate.kind !== 'contact') {
    throw new Error(`expected a contact candidate, got ${String(candidate?.kind)}`);
  }
  return candidate;
}

/** Row IDENTITY per kind: contactId / phone / conversationId. */
function candidateIds(candidates: UnreadCandidate[]): string[] {
  return candidates.map((c) => {
    if (c.kind === 'contact') return c.contactId;
    if (c.kind === 'unknown') return c.phone;
    return c.conversation.conversationId;
  });
}

describe('isUnreadVisible / isOneToOneBucket', () => {
  it('puts every non-group type - including a type-less legacy row - in the 1:1 bucket', () => {
    expect(isOneToOneBucket(conv({ conversationId: 'c1', type: 'tenant_1to1' }))).toBe(true);
    expect(isOneToOneBucket(conv({ conversationId: 'c2', type: 'unknown_1to1' }))).toBe(true);
    expect(isOneToOneBucket(withoutType(conv({ conversationId: 'c3' })))).toBe(true);
    expect(isOneToOneBucket(conv({ conversationId: 'c4', type: 'relay_group' }))).toBe(false);
    expect(isOneToOneBucket(conv({ conversationId: 'c5', type: 'group_text' }))).toBe(false);
  });

  it('applies the spec 4.3 visibility rules per type', () => {
    // 1:1 (and legacy) rows are visible only in the `open` partition.
    expect(isUnreadVisible(conv({ conversationId: 'c1' }))).toBe(true);
    expect(isUnreadVisible(conv({ conversationId: 'c2', status: 'closed' }))).toBe(false);
    expect(isUnreadVisible(withoutType(conv({ conversationId: 'c3' })))).toBe(true);
    // relay groups: open OR connecting.
    expect(isUnreadVisible(conv({ conversationId: 'c4', type: 'relay_group' }))).toBe(true);
    expect(
      isUnreadVisible(conv({ conversationId: 'c5', type: 'relay_group', status: 'connecting' })),
    ).toBe(true);
    expect(
      isUnreadVisible(conv({ conversationId: 'c6', type: 'relay_group', status: 'closed' })),
    ).toBe(false);
    // group texts: their own partition only.
    expect(
      isUnreadVisible(
        conv({ conversationId: 'c7', type: 'group_text', status: GROUP_TEXT_STATUS }),
      ),
    ).toBe(true);
    expect(isUnreadVisible(conv({ conversationId: 'c8', type: 'group_text' }))).toBe(false);
    // a non-positive counter never shows, however the row got indexed.
    expect(isUnreadVisible(conv({ conversationId: 'c9', unread_count: 0 }))).toBe(false);
    expect(isUnreadVisible(conv({ conversationId: 'c10', unread_count: undefined }))).toBe(false);
    // pointer partitions can never be visible, even if one somehow indexed.
    expect(isUnreadVisible(conv({ conversationId: 'phone#+15550001111' }))).toBe(false);
    expect(isUnreadVisible(conv({ conversationId: 'email#a@b.test' }))).toBe(false);
    expect(isUnreadVisible(conv({ conversationId: 'token#abc' }))).toBe(false);
  });
});

describe('toExclusiveStartKey', () => {
  it('synthesizes the full byUnread key', () => {
    expect(
      toExclusiveStartKey({ lastActivityAt: '2026-08-16T12:00:00.000Z', conversationId: 'conv-9' }),
    ).toEqual({
      unread_flag: UNREAD_FLAG_VALUE,
      last_activity_at: '2026-08-16T12:00:00.000Z',
      conversationId: 'conv-9',
    });
  });
});

describe('iterateUnreadConversations', () => {
  it('yields exactly the visible rows, in index order', async () => {
    const items = [
      conv({ conversationId: 'a-open-1to1', last_activity_at: tsAt(0) }),
      conv({ conversationId: 'b-closed-1to1', last_activity_at: tsAt(1), status: 'closed' }),
      withoutType(conv({ conversationId: 'c-legacy-typeless', last_activity_at: tsAt(2) })),
      conv({ conversationId: 'd-relay-open', last_activity_at: tsAt(3), type: 'relay_group' }),
      conv({
        conversationId: 'e-relay-connecting',
        last_activity_at: tsAt(4),
        type: 'relay_group',
        status: 'connecting',
      }),
      conv({
        conversationId: 'f-relay-closed',
        last_activity_at: tsAt(5),
        type: 'relay_group',
        status: 'closed',
      }),
      conv({
        conversationId: 'g-group-open',
        last_activity_at: tsAt(6),
        type: 'group_text',
        status: GROUP_TEXT_STATUS,
      }),
      conv({ conversationId: 'h-group-wrong-status', last_activity_at: tsAt(7), type: 'group_text' }),
      conv({ conversationId: 'phone#+15550001111', last_activity_at: tsAt(8) }),
      conv({ conversationId: 'j-read', last_activity_at: tsAt(9), unread_count: 0 }),
    ];
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        { budget: UNREAD_WALK_LIMIT },
        state,
      ),
    );

    expect(yielded.map((c) => c.conversationId)).toEqual([
      'a-open-1to1',
      'c-legacy-typeless',
      'd-relay-open',
      'e-relay-connecting',
      'g-group-open',
    ]);
    expect(state.scanned).toBe(10);
    expect(state.scanExhausted).toBe(true);
  });

  it('is LAZY: a consumer that stops pulling stops the Query paging', async () => {
    const items = visibleSeries(300);
    const calls = emptyQueryCalls();
    const state = freshState();

    const taken: string[] = [];
    for await (const item of iterateUnreadConversations(
      { conversations: makeConversations(items, calls) },
      { budget: UNREAD_WALK_LIMIT },
      state,
    )) {
      taken.push(item.conversationId);
      break;
    }

    expect(taken).toEqual(['conv-0000']);
    // The proof: ONE page (100 rows) was fetched, not all 300.
    expect(calls.queryUnreadPage).toBe(1);
    expect(state.scanned).toBe(1);
    expect(state.scanExhausted).toBe(false);
    expect(state.scanPosition).toEqual({
      lastActivityAt: tsAt(0),
      conversationId: 'conv-0000',
    });
  });

  it('advances scanPosition through a fully-filtered run so it cannot dead-end the feed', async () => {
    const items = [
      ...Array.from({ length: 250 }, (_, i) =>
        conv({
          conversationId: `hidden-${String(i).padStart(4, '0')}`,
          last_activity_at: tsAt(i),
          status: 'closed',
        }),
      ),
      conv({ conversationId: 'visible-tail', last_activity_at: tsAt(250) }),
    ];
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        { budget: UNREAD_WALK_LIMIT },
        state,
      ),
    );

    expect(yielded.map((c) => c.conversationId)).toEqual(['visible-tail']);
    expect(state.scanned).toBe(251);
    expect(state.scanPosition).toEqual({
      lastActivityAt: tsAt(250),
      conversationId: 'visible-tail',
    });
    expect(state.scanExhausted).toBe(true);
  });

  it('stops at the budget without claiming the stream ended', async () => {
    const items = visibleSeries(300);
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        { budget: 50 },
        state,
      ),
    );

    expect(yielded).toHaveLength(50);
    expect(state.scanned).toBe(50);
    expect(state.scanExhausted).toBe(false);
    // The internal page never asks for more than the remaining budget.
    expect(calls.queryUnreadPage).toBe(1);
  });

  it('reports scanExhausted once the index is fully drained', async () => {
    const items = visibleSeries(5);
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        { budget: UNREAD_WALK_LIMIT },
        state,
      ),
    );

    expect(yielded).toHaveLength(5);
    expect(state.scanned).toBe(5);
    expect(state.scanExhausted).toBe(true);
    expect(calls.queryUnreadPage).toBe(1);
  });

  it('pays the extra Query DynamoDB charges for a page that exactly fills its Limit', async () => {
    // Adversarial A7. The real service returns a LastEvaluatedKey whenever the
    // request's Limit was REACHED, whether or not anything remains - so an
    // exact-multiple walk costs one more round trip than "items remaining"
    // modelling suggests, and the "non-empty page carrying a LEK followed by an
    // empty page with none" interleaving that the route's cursor block says
    // "gets here in production" could not be produced by the fake at all. Every
    // query-count assertion in this file is calibrated against that model, so
    // the model has to be the service's.
    const items = visibleSeries(100); // exactly UNREAD_QUERY_PAGE_SIZE
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        { budget: UNREAD_WALK_LIMIT },
        state,
      ),
    );

    expect(yielded).toHaveLength(100);
    expect(state.scanned).toBe(100);
    // TWO queries: the full page WITH a key, then the empty page that proves
    // the stream really ended. Only the second one can set scanExhausted.
    expect(calls.queryUnreadPage).toBe(2);
    expect(state.scanExhausted).toBe(true);
  });

  it('resumes exactly after startAfter', async () => {
    const items = visibleSeries(5);
    const calls = emptyQueryCalls();
    const state = freshState();

    const yielded = await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(items, calls) },
        {
          budget: UNREAD_WALK_LIMIT,
          startAfter: { lastActivityAt: tsAt(1), conversationId: 'conv-0001' },
        },
        state,
      ),
    );

    expect(yielded.map((c) => c.conversationId)).toEqual(['conv-0002', 'conv-0003', 'conv-0004']);
    expect(state.scanned).toBe(3);
  });

  it('fires the rate-limited scan tripwire only past UNREAD_WALK_WARN', async () => {
    // ORDER MATTERS: the limiter is module-scope and time-based, so the
    // under-threshold walk must run FIRST (it emits nothing, leaving the
    // window untouched) and the over-threshold walk second.
    const quiet = makeLoggerSpy();
    await drain(
      iterateUnreadConversations(
        { conversations: makeConversations(visibleSeries(10), emptyQueryCalls()), logger: quiet.logger },
        { budget: UNREAD_WALK_LIMIT },
        freshState(),
      ),
    );
    expect(quiet.warn).not.toHaveBeenCalled();

    const loud = makeLoggerSpy();
    const state = freshState();
    await drain(
      iterateUnreadConversations(
        {
          conversations: makeConversations(visibleSeries(UNREAD_WALK_WARN + 100), emptyQueryCalls()),
          logger: loud.logger,
        },
        { budget: UNREAD_WALK_LIMIT },
        state,
      ),
    );

    expect(state.scanned).toBe(UNREAD_WALK_WARN + 100);
    // AT-LEAST-ONCE: the limiter is time-based, and its own throttle behavior
    // is tested in lib/rateLimitedWarn.ts - never assert exactly-once here.
    expect(loud.warn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(loud.warn.mock.calls[0]?.[0]).toMatchObject({ event: 'unread_walk_scan_tripwire' });
  });
});

describe('collectUnreadRows - grouping', () => {
  it('groups index items into ONE candidate per row identity', async () => {
    const alice = contact({
      contactId: 'contact-alice',
      phones: [
        { phone: '+15550000001', primary: true },
        { phone: '+15550000002', primary: false },
      ],
    });
    const bob = contact({
      contactId: 'contact-bob',
      phones: [{ phone: '+15550000003', primary: true }],
      emails: [{ email: 'bob@test.example', primary: true }],
    });
    const items = [
      conv({ conversationId: 'a-newer', last_activity_at: tsAt(0), participant_phone: '+15550000001' }),
      conv({ conversationId: 'a-older', last_activity_at: tsAt(1), participant_phone: '+15550000002' }),
      conv({ conversationId: 'b-phone', last_activity_at: tsAt(2), participant_phone: '+15550000003' }),
      conv({
        conversationId: 'b-email',
        last_activity_at: tsAt(3),
        participant_email: 'bob@test.example',
      }),
      conv({ conversationId: 'u-unknown', last_activity_at: tsAt(4), participant_phone: '+15550000099' }),
      // Contactless email thread: no identity to render, so it is SKIPPED
      // (parity with the inbox reader) - email unknowns live in the
      // unmatched-email surface only.
      conv({
        conversationId: 'e-orphan',
        last_activity_at: tsAt(5),
        participant_email: 'nobody@test.example',
      }),
      conv({ conversationId: 'g-relay', last_activity_at: tsAt(6), type: 'relay_group' }),
      conv({
        conversationId: 'g-group',
        last_activity_at: tsAt(7),
        type: 'group_text',
        status: GROUP_TEXT_STATUS,
      }),
    ];
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts([alice, bob], calls),
        messages: makeMessages({}, calls),
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );

    expect(candidateIds(result.candidates)).toEqual([
      'contact-alice',
      'contact-bob',
      '+15550000099',
      'g-relay',
      'g-group',
    ]);
    // Representative is the FIRST (newest) thread encountered; the older ones
    // merge behind it. No unread SUMS are computed at this layer.
    const aliceRow = contactCandidate(result.candidates[0]);
    expect(aliceRow.unreadConversations.map((c) => c.conversationId)).toEqual(['a-newer', 'a-older']);
    const bobRow = contactCandidate(result.candidates[1]);
    expect(bobRow.unreadConversations.map((c) => c.conversationId)).toEqual(['b-phone', 'b-email']);
    expect(result.consumedAll).toBe(true);
    expect(result.capped).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.deletedProbes).toBe(0);
    // No hydration: nothing read a message for a live (non-deleted) contact.
    expect(calls.listByConversation).toBe(0);
    expect(result.remainingBudget).toBe(UNREAD_WALK_LIMIT - items.length);
  });

  it('skips excluded contacts entirely while their items still consume scan range', async () => {
    const { items, contacts } = contactSeries(4);
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages({}, calls),
      },
      {
        maxRows: 100,
        budget: UNREAD_WALK_LIMIT,
        excludeContactIds: new Set(['contact-0000', 'contact-0001']),
      },
    );

    expect(candidateIds(result.candidates)).toEqual(['contact-0002', 'contact-0003']);
    // Scan range was consumed by the excluded rows too: the position is past
    // the LAST item, and the walk drained.
    expect(result.scanPosition).toEqual({ lastActivityAt: tsAt(3), conversationId: 'row-0001' });
    expect(result.consumedAll).toBe(true);
    expect(result.remainingBudget).toBe(UNREAD_WALK_LIMIT - 4);
  });

  it('degrades to no-contact when the lookup throws, and to not-resurfaced when the probe throws', async () => {
    const calls = emptyCollectCalls();
    const items = [
      conv({ conversationId: 'x-1', last_activity_at: tsAt(0), participant_phone: '+15550000501' }),
    ];

    // Injected loggers keep the best-effort WARNs out of the suite's stdout
    // AND prove each degrade path is actually logged rather than swallowed.
    const lookupLog = makeLoggerSpy();
    const degraded = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts([], calls, { findByPhone: new Error('lookup boom') }),
        messages: makeMessages({}, calls),
        logger: lookupLog.logger,
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );
    // A failed lookup must not drop the row silently: it falls back to the
    // unknown-number identity, exactly as the inbox reader does.
    expect(candidateIds(degraded.candidates)).toEqual(['+15550000501']);
    expect(lookupLog.warn).toHaveBeenCalled();

    const deleted = contact({
      contactId: 'contact-probe-error',
      phones: [{ phone: '+15550000502', primary: true }],
      deleted_at: '2026-08-12T00:00:00.000Z',
    });
    const probeCalls = emptyCollectCalls();
    const probeItems = [
      conv({ conversationId: 'x-2', last_activity_at: tsAt(0), participant_phone: '+15550000502' }),
    ];
    const probeLog = makeLoggerSpy();
    const probeFailed = await collectUnreadRows(
      {
        conversations: makeConversations(probeItems, probeCalls),
        contacts: makeContacts([deleted], probeCalls),
        messages: makeMessages({}, probeCalls, 'x-2'),
        logger: probeLog.logger,
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );
    expect(probeFailed.candidates).toEqual([]);
    expect(probeFailed.deletedProbes).toBe(1);
    expect(probeLog.warn).toHaveBeenCalled();
  });
});

describe('collectUnreadRows - capped / consumedAll / truncated', () => {
  it('distinguishes the CAP from the SUPPLY running out on identical data', async () => {
    const { items, contacts } = contactSeries(300);

    const cappedCalls = emptyCollectCalls();
    const capped = await collectUnreadRows(
      {
        conversations: makeConversations(items, cappedCalls),
        contacts: makeContacts(contacts, cappedCalls),
        messages: makeMessages({}, cappedCalls),
      },
      { maxRows: 30, budget: UNREAD_WALK_LIMIT },
    );

    expect(capped.candidates).toHaveLength(30);
    expect(capped.capped).toBe(true);
    // THE round-3 blocking case: `consumedAll` is a CONSUMPTION fact and must
    // NOT be inferred from the scan. Conflating it with layer 1's
    // scanExhausted made every under-budget dataset return page one with a
    // null cursor.
    expect(capped.consumedAll).toBe(false);
    expect(capped.truncated).toBe(false);
    expect(capped.scanPosition).toEqual({ lastActivityAt: tsAt(29), conversationId: 'row-0271' });

    const wholeCalls = emptyCollectCalls();
    const whole = await collectUnreadRows(
      {
        conversations: makeConversations(items, wholeCalls),
        contacts: makeContacts(contacts, wholeCalls),
        messages: makeMessages({}, wholeCalls),
      },
      { maxRows: 500, budget: UNREAD_WALK_LIMIT },
    );

    expect(whole.candidates).toHaveLength(300);
    expect(whole.consumedAll).toBe(true);
    expect(whole.capped).toBe(false);
    expect(whole.truncated).toBe(false);
  });

  it('reports truncated when the request budget runs out first', async () => {
    const { items, contacts } = contactSeries(300);
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages({}, calls),
      },
      { maxRows: 100, budget: 10 },
    );

    expect(result.candidates).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.capped).toBe(false);
    expect(result.consumedAll).toBe(false);
    expect(result.remainingBudget).toBe(0);
  });

  it('carries laziness through: maxRows 1 against 300 visible rows is ONE query', async () => {
    const { items, contacts } = contactSeries(300);
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages({}, calls),
      },
      { maxRows: 1, budget: UNREAD_WALK_LIMIT },
    );

    expect(result.candidates).toHaveLength(1);
    expect(result.capped).toBe(true);
    expect(calls.queryUnreadPage).toBe(1);
    // Only the ONE row it emitted was resolved - the collector stopped pulling.
    expect(calls.findByPhone).toBe(1);
    expect(result.remainingBudget).toBe(UNREAD_WALK_LIMIT - 1);
  });

  it('resumes from scanPosition + the seen-set without duplicating or skipping a row', async () => {
    // Rows 29 and 30 share a `last_activity_at`, so the resume crosses a
    // TIMESTAMP TIE - the case an index-position cursor cannot express.
    const { items, contacts } = contactSeries(300, 29);
    const firstCalls = emptyCollectCalls();

    const first = await collectUnreadRows(
      {
        conversations: makeConversations(items, firstCalls),
        contacts: makeContacts(contacts, firstCalls),
        messages: makeMessages({}, firstCalls),
      },
      { maxRows: 30, budget: UNREAD_WALK_LIMIT },
    );
    expect(first.scanPosition).toBeDefined();
    const seen = new Set(candidateIds(first.candidates));
    expect(seen.size).toBe(30);

    const secondCalls = emptyCollectCalls();
    const second = await collectUnreadRows(
      {
        conversations: makeConversations(items, secondCalls),
        contacts: makeContacts(contacts, secondCalls),
        messages: makeMessages({}, secondCalls),
      },
      {
        maxRows: 30,
        budget: UNREAD_WALK_LIMIT,
        ...(first.scanPosition !== undefined && { startAfter: first.scanPosition }),
        excludeContactIds: seen,
      },
    );

    const secondIds = candidateIds(second.candidates);
    expect(secondIds).toEqual(
      Array.from({ length: 30 }, (_, i) => `contact-${String(30 + i).padStart(4, '0')}`),
    );
    expect(new Set([...seen, ...secondIds]).size).toBe(60);
  });
});

describe('collectUnreadRows - deleted-contact resurfacing', () => {
  const DELETED_AT = '2026-08-12T00:00:00.000Z';
  const BEFORE_DELETE = '2026-08-11T00:00:00.000Z';
  const AFTER_DELETE = '2026-08-14T00:00:00.000Z';

  function deletedContact(id: string, phone: string): ContactItem {
    return contact({ contactId: id, phones: [{ phone, primary: true }], deleted_at: DELETED_AT });
  }

  it('surfaces only the deleted contact whose newest message is a post-deletion INBOUND', async () => {
    const items = [
      conv({ conversationId: 'thr-fresh', last_activity_at: tsAt(0), participant_phone: '+15550000101' }),
      conv({ conversationId: 'thr-stale', last_activity_at: tsAt(1), participant_phone: '+15550000102' }),
      conv({ conversationId: 'thr-out', last_activity_at: tsAt(2), participant_phone: '+15550000103' }),
    ];
    const contacts = [
      deletedContact('contact-fresh', '+15550000101'),
      deletedContact('contact-stale', '+15550000102'),
      deletedContact('contact-out', '+15550000103'),
    ];
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages(
          {
            'thr-fresh': msg({ created_at: AFTER_DELETE, direction: 'inbound' }),
            // Pre-deletion unread stays hidden - deleting draws a line.
            'thr-stale': msg({ created_at: BEFORE_DELETE, direction: 'inbound' }),
            // A straggler scheduled send does not resurface anyone.
            'thr-out': msg({ created_at: AFTER_DELETE, direction: 'outbound' }),
          },
          calls,
        ),
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );

    expect(candidateIds(result.candidates)).toEqual(['contact-fresh']);
    expect(result.deletedProbes).toBe(3);
  });

  it('probes UNCONDITIONALLY: a thread whose last_activity_at predates deleted_at still resurfaces', async () => {
    // THE withdrawn-short-circuit regression. A round-2 remedy skipped the
    // probe when last_activity_at <= deleted_at; that premise is false here -
    // last_activity_at is the PROVIDER clock while created_at is OUR ingest
    // clock, and the append/touch gap can leave last_activity_at stale while
    // a fresh post-deletion inbound exists.
    const items = [
      conv({
        conversationId: 'thr-clock-skew',
        last_activity_at: '2026-08-10T00:00:00.000Z',
        participant_phone: '+15550000201',
      }),
    ];
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts([deletedContact('contact-skew', '+15550000201')], calls),
        messages: makeMessages(
          { 'thr-clock-skew': msg({ created_at: AFTER_DELETE, direction: 'inbound' }) },
          calls,
        ),
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );

    expect(candidateIds(result.candidates)).toEqual(['contact-skew']);
    expect(result.deletedProbes).toBe(1);
  });

  it('evaluates PER THREAD: a qualifying OLDER thread emits the row at its own stream position', async () => {
    // plan-review A6: a one-shot candidate evaluation would drop this contact
    // entirely, because the FIRST thread it meets does not qualify.
    const items = [
      conv({ conversationId: 'multi-newest', last_activity_at: tsAt(0), participant_phone: '+15550000301' }),
      conv({ conversationId: 'live-between', last_activity_at: tsAt(1), participant_phone: '+15550000399' }),
      conv({ conversationId: 'multi-older', last_activity_at: tsAt(2), participant_phone: '+15550000302' }),
      conv({ conversationId: 'multi-oldest', last_activity_at: tsAt(3), participant_phone: '+15550000303' }),
    ];
    const multi = contact({
      contactId: 'contact-multi',
      phones: [
        { phone: '+15550000301', primary: true },
        { phone: '+15550000302', primary: false },
        { phone: '+15550000303', primary: false },
      ],
      deleted_at: DELETED_AT,
    });
    const live = contact({
      contactId: 'contact-live',
      phones: [{ phone: '+15550000399', primary: true }],
    });
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts([multi, live], calls),
        messages: makeMessages(
          {
            'multi-newest': msg({ created_at: AFTER_DELETE, direction: 'outbound' }),
            'multi-older': msg({ created_at: AFTER_DELETE, direction: 'inbound' }),
            'multi-oldest': msg({ created_at: AFTER_DELETE, direction: 'inbound' }),
          },
          calls,
        ),
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );

    // EXACTLY ONE candidate for the contact, emitted AFTER the live row - i.e.
    // at the position of the first thread whose probe passed, not at the
    // position of the newer thread that failed.
    expect(candidateIds(result.candidates)).toEqual(['contact-live', 'contact-multi']);
    const row = contactCandidate(result.candidates[1]);
    expect(row.unreadConversations.map((c) => c.conversationId)).toEqual([
      'multi-newest',
      'multi-older',
      'multi-oldest',
    ]);
    // Two probes: the failing newest and the qualifying older. Once EMITTED,
    // later threads of the same contact merge WITHOUT probing.
    expect(result.deletedProbes).toBe(2);
  });

  it('counts probes and fires the shared rate-limited warn only past the threshold', async () => {
    const probeCount = UNREAD_DELETED_PROBE_WARN + 1;
    const items: ConversationItem[] = [];
    const contacts: ContactItem[] = [];
    const latest: Record<string, MessageItem> = {};
    for (let i = 0; i < probeCount; i += 1) {
      const phone = `+1555${String(3_000_000 + i)}`;
      const id = `probe-${String(probeCount - i).padStart(4, '0')}`;
      items.push(conv({ conversationId: id, last_activity_at: tsAt(i), participant_phone: phone }));
      contacts.push(deletedContact(`contact-probe-${String(i).padStart(4, '0')}`, phone));
      // None qualifies: every one costs a probe and emits nothing.
      latest[id] = msg({ created_at: BEFORE_DELETE, direction: 'inbound' });
    }
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages(latest, calls),
      },
      { maxRows: 100, budget: UNREAD_WALK_LIMIT },
    );

    expect(result.candidates).toEqual([]);
    expect(result.deletedProbes).toBe(probeCount);
    // A contact that never emits never enters the seen-set, but its items DID
    // consume scan range and count toward consumedAll.
    expect(result.consumedAll).toBe(true);

    // The WARN belongs to the CALLER (it accumulates across the page loop's
    // many collects), so it is fired explicitly from the shared module-scope
    // limiter. ORDER MATTERS: at-threshold first (emits nothing, leaving the
    // limiter window untouched), over-threshold second.
    const spy = makeLoggerSpy();
    warnDeletedProbes(spy.logger, { probes: UNREAD_DELETED_PROBE_WARN, skipped: 0 });
    expect(spy.warn).not.toHaveBeenCalled();

    warnDeletedProbes(spy.logger, { probes: result.deletedProbes, skipped: 0 });
    expect(spy.warn.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(spy.warn.mock.calls[0]?.[0]).toMatchObject({ event: 'unread_deleted_probe_tripwire' });
  });

  it('BOUNDS the WASTED probe work: a wall of hidden deleted threads is SKIPPED unprobed, and the walk continues', async () => {
    // Adversarial A2(b), reproduced at a smaller scale (the reviewer measured
    // 4,020 serial round trips on ONE authed badge request over 2,500 rows).
    // Hidden deleted candidates never count toward maxRows, so the cap could
    // not stop the walk and the badge paid a contact Query PLUS a message probe
    // for every one of them - then returned 0.
    //
    // FIX WAVE 2 (adversarial r2 findings 1-2): the bound counts WASTED probes
    // only, and it stops PROBING, never the WALK. Past the bound a
    // deleted-contact thread is treated as hidden without a read, and
    // everything else in the stream keeps being counted and emitted.
    const hidden = 200;
    const items: ConversationItem[] = [];
    const contacts: ContactItem[] = [];
    const latest: Record<string, MessageItem> = {};
    for (let i = 0; i < hidden; i += 1) {
      const phone = `+1555${String(4_000_000 + i)}`;
      const id = `hidden-${String(hidden - i).padStart(4, '0')}`;
      items.push(conv({ conversationId: id, last_activity_at: tsAt(i), participant_phone: phone }));
      contacts.push(deletedContact(`contact-hidden-${String(i).padStart(4, '0')}`, phone));
      // A post-deletion OUTBOUND resurfaces nobody: every row is hidden.
      latest[id] = msg({ created_at: AFTER_DELETE, direction: 'outbound' });
    }
    // A LIVE unread contact BEHIND the whole wall. It is the difference between
    // bounding the probes and bounding the walk: this row must still be found.
    const behindPhone = '+15554999999';
    items.push(
      conv({
        conversationId: 'behind-the-wall',
        last_activity_at: tsAt(hidden),
        participant_phone: behindPhone,
      }),
    );
    contacts.push(contact({ contactId: 'contact-behind', phones: [{ phone: behindPhone, primary: true }] }));
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages(latest, calls),
      },
      { maxRows: BADGE_COUNT_CAP, budget: UNREAD_WALK_LIMIT },
    );

    // The live row behind the wall is DELIVERED, not withheld.
    expect(candidateIds(result.candidates)).toEqual(['contact-behind']);
    expect(result.capped).toBe(false);
    // ...and the walk DRAINED, so this is a NATURAL end (fix wave 3,
    // adversarial r3 finding 2). Fix wave 2 reported a floor here, which made a
    // residue-only, genuinely caught-up org render the inbox failure banner
    // permanently. The assumption past the bound is "hidden", which is exactly
    // what the empty half of this answer already means; `skippedDeletedThreads`
    // and the probe WARN carry the wall's depth to the operator instead.
    expect(result.truncated).toBe(false);
    expect(result.consumedAll).toBe(true);
    // The MESSAGE work is bounded by the limit, NOT by the number of hidden
    // rows - and every probe past it becomes a counted SKIP instead.
    expect(result.deletedProbes).toBe(UNREAD_DELETED_PROBE_LIMIT);
    expect(calls.listByConversation).toBe(UNREAD_DELETED_PROBE_LIMIT);
    expect(result.wastedProbes).toBe(UNREAD_DELETED_PROBE_LIMIT);
    expect(result.skippedDeletedThreads).toBe(hidden - UNREAD_DELETED_PROBE_LIMIT);
    // The bound is set ABOVE the tripwire on purpose, so tripping it is always
    // a state the WARN also reports.
    expect(UNREAD_DELETED_PROBE_LIMIT).toBeGreaterThan(UNREAD_DELETED_PROBE_WARN);
    // The whole stream really was walked to its end.
    expect(result.scanPosition?.conversationId).toBe('behind-the-wall');
  });

  it('does NOT spend the bound on PRODUCTIVE probes: 50 resurfaced deleted contacts all count', async () => {
    // Adversarial r2 finding 1 / conformance r2 finding 1.1 (BLOCKING). A
    // resurfaced deleted contact is a product state, not an error state: spec
    // 4.3 step 2 keeps it unread until someone reads it, and a fresh inbound
    // puts it at the HEAD of the index. Counting those probes against the bound
    // capped the badge at 26 - below its own BADGE_COUNT_CAP, and through
    // `truncated`, which the client does not render.
    const resurfaced = 50;
    const items: ConversationItem[] = [];
    const contacts: ContactItem[] = [];
    const latest: Record<string, MessageItem> = {};
    for (let i = 0; i < resurfaced; i += 1) {
      const phone = `+1555${String(5_000_000 + i)}`;
      const id = `back-${String(resurfaced - i).padStart(4, '0')}`;
      items.push(conv({ conversationId: id, last_activity_at: tsAt(i), participant_phone: phone }));
      contacts.push(deletedContact(`contact-back-${String(i).padStart(4, '0')}`, phone));
      // A post-deletion INBOUND: every one of these RESURFACES and emits a row.
      latest[id] = msg({ created_at: AFTER_DELETE, direction: 'inbound' });
    }
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages(latest, calls),
      },
      { maxRows: BADGE_COUNT_CAP, budget: UNREAD_WALK_LIMIT },
    );

    expect(result.candidates).toHaveLength(resurfaced);
    expect(result.capped).toBe(false);
    // NOT a floor: nothing was skipped and the supply drained.
    expect(result.truncated).toBe(false);
    expect(result.consumedAll).toBe(true);
    // Every probe was productive, so none of them spent the bound. The rows
    // they produced are bounded by maxRows, which is the cap that owns them.
    expect(result.deletedProbes).toBe(resurfaced);
    expect(result.wastedProbes).toBe(0);
    expect(result.skippedDeletedThreads).toBe(0);
  });

  it('threads the WASTED probe total across a REQUEST: a collect resuming past the bound probes nothing', async () => {
    // The bound is a REQUEST budget, not a per-collect one: the unread page's
    // fill loop makes many collects, and a per-collect bound would let a
    // pathological wall be re-paid once per iteration.
    const items: ConversationItem[] = [];
    const contacts: ContactItem[] = [];
    const latest: Record<string, MessageItem> = {};
    for (let i = 0; i < 4; i += 1) {
      const phone = `+1555${String(6_000_000 + i)}`;
      const id = `carry-${String(4 - i).padStart(4, '0')}`;
      items.push(conv({ conversationId: id, last_activity_at: tsAt(i), participant_phone: phone }));
      contacts.push(deletedContact(`contact-carry-${String(i).padStart(4, '0')}`, phone));
      // These WOULD resurface - but the request has already spent its bound, so
      // they are skipped unread rather than probed. That is the declared cost.
      latest[id] = msg({ created_at: AFTER_DELETE, direction: 'inbound' });
    }
    const calls = emptyCollectCalls();

    const result = await collectUnreadRows(
      {
        conversations: makeConversations(items, calls),
        contacts: makeContacts(contacts, calls),
        messages: makeMessages(latest, calls),
      },
      {
        maxRows: BADGE_COUNT_CAP,
        budget: UNREAD_WALK_LIMIT,
        wastedProbesBefore: UNREAD_DELETED_PROBE_LIMIT,
      },
    );

    expect(result.candidates).toEqual([]);
    expect(calls.listByConversation).toBe(0);
    expect(result.deletedProbes).toBe(0);
    expect(result.skippedDeletedThreads).toBe(4);
    // The SKIP total is the floor signal; `truncated` is not (fix wave 3,
    // adversarial r3 finding 2 - a drained stream is a natural end).
    expect(result.truncated).toBe(false);
  });
});
