import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../api/index.js';
import { mergeTimelineItems, THREAD_PAGE_SIZE } from './threadPaging.js';

function msg(id: string, at: string, status = 'delivered'): TimelineItem {
  return {
    kind: 'message',
    id,
    at,
    conversationId: 'c1',
    tsMsgId: id,
    direction: 'inbound',
    author: 'contact',
    type: 'sms',
    body: id,
    delivery_status: status,
  } as TimelineItem;
}

describe('THREAD_PAGE_SIZE', () => {
  it('matches the server default page size', () => {
    expect(THREAD_PAGE_SIZE).toBe(50);
  });
});

describe('mergeTimelineItems', () => {
  it('returns the incoming page, sorted, when there is nothing held', () => {
    const incoming = [msg('b', '2026-08-13T10:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems([], incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns what is held, sorted, when the incoming page is empty', () => {
    const prev = [msg('b', '2026-08-13T10:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, []).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('unions both sides and sorts oldest to newest', () => {
    const prev = [msg('b', '2026-08-13T10:00:00.000Z')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('prefers the incoming copy for an id present on both sides', () => {
    const prev = [msg('a', '2026-08-13T09:00:00.000Z', 'queued')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z', 'delivered')];
    const merged = mergeTimelineItems(prev, incoming);
    expect(merged).toHaveLength(1);
    expect((merged[0] as { delivery_status: string }).delivery_status).toBe('delivered');
  });

  // The gap bug this whole rule exists to prevent (spec 4.1): the newest page is
  // "the newest N", not a fixed window, so a shifted window must not drop the
  // entries that fell out of it.
  it('keeps entries that fell out of the shifted newest window', () => {
    const held = [
      msg('m1', '2026-08-13T09:00:00.000Z'),
      msg('m2', '2026-08-13T09:01:00.000Z'),
      msg('m3', '2026-08-13T09:02:00.000Z'),
    ];
    const shifted = [msg('m3', '2026-08-13T09:02:00.000Z'), msg('m4', '2026-08-13T09:03:00.000Z')];
    expect(mergeTimelineItems(held, shifted).map((i) => i.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('sorts entries with no timestamp last', () => {
    const prev = [msg('a', '2026-08-13T09:00:00.000Z')];
    const incoming = [msg('z', '')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'z']);
  });

  // A3. normalizeServerItems (useContactTimeline.ts) returns an item UNCHANGED
  // when no instant is derivable, so `at` can be undefined at runtime even though
  // TimelineBase declares it `string`. A raw localeCompare on that item throws a
  // TypeError and kills the older-page load, so the comparator must coerce.
  it('merges an item whose at is undefined at runtime and sorts it last', () => {
    const prev = [msg('a', '2026-08-13T09:00:00.000Z')];
    const noInstant = {
      kind: 'message',
      id: 'z',
      conversationId: 'c1',
      tsMsgId: 'z',
      direction: 'inbound',
      author: 'contact',
      type: 'sms',
      body: 'z',
      delivery_status: 'delivered',
    } as unknown as TimelineItem;
    expect(mergeTimelineItems(prev, [noInstant]).map((i) => i.id)).toEqual(['a', 'z']);
  });

  it('breaks ties by id so the order is deterministic', () => {
    const prev = [msg('b', '2026-08-13T09:00:00.000Z')];
    const incoming = [msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems(prev, incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });

  // No fast paths: the tie-break contract must hold on the FIRST page too, which
  // is the page every user sees.
  it('applies the id tie-break even when nothing is held yet', () => {
    const incoming = [msg('b', '2026-08-13T09:00:00.000Z'), msg('a', '2026-08-13T09:00:00.000Z')];
    expect(mergeTimelineItems([], incoming).map((i) => i.id)).toEqual(['a', 'b']);
  });
});
