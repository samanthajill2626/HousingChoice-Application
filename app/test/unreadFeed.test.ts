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
  isOneToOneBucket,
  isUnreadVisible,
  iterateUnreadConversations,
  toExclusiveStartKey,
  UNREAD_WALK_LIMIT,
  UNREAD_WALK_WARN,
  type UnreadWalkState,
} from '../src/lib/unreadFeed.js';
import {
  GROUP_TEXT_STATUS,
  UNREAD_FLAG_VALUE,
  type ConversationItem,
  type ConversationsRepo,
} from '../src/repos/conversationsRepo.js';
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
