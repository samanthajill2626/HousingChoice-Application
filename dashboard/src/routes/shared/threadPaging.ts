// Paging helpers shared by the three thread hooks (useRelayThread,
// useGroupThread, useContactTimeline).
//
// WHY MERGE INSTEAD OF REPLACE: the newest page is "the newest N entries", not a
// fixed window. If the operator has loaded older pages and new messages then
// arrive, the refetched newest page no longer contains the entries that fell out
// of the window - and those entries are not in any older page either, because
// they were never fetched as one. Replacing state would leave a HOLE in the
// middle of the transcript. Merging by id keeps everything already seen, so it
// cannot drop an entry the client has ALREADY read.
//
// It is NOT a guarantee of a continuous transcript, and an earlier version of
// this comment wrongly claimed it was. Merging fills no gap it never fetched: if
// MORE THAN ONE PAGE of new entries lands between two refetches, the newest page
// no longer overlaps what is held, and the union is two blocks with an
// unfetched, INVISIBLE hole between them - the transcript reads as continuous.
// Volume alone does not get there (every persisted message schedules a refetch),
// so the realistic trigger is a gap in the SSE stream - a backgrounded tab, a
// sleep, a reconnect - because the stream has no replay and the hooks do not
// resync on reconnect. Tracked in
// docs/issues/thread-merge-leaves-a-hole-after-an-sse-gap.md.
//
// Accepted consequence: an entry deleted server-side lingers in an open thread
// until the operator navigates away. Messages are not deleted in this product,
// and a stale-but-present bubble is a far smaller defect than a hole in a
// transcript.
import type { TimelineItem } from '../../api/index.js';

/** Page size for thread history reads - the server's own default (app/src/routes/api.ts). */
export const THREAD_PAGE_SIZE = 50;

/** Chronological order: oldest first, entries with no timestamp last, ties broken
 *  by id so a merged set has ONE deterministic order regardless of arrival. */
function compareItems(a: TimelineItem, b: TimelineItem): number {
  // `at` is declared `string` on TimelineBase but normalizeServerItems can leave
  // it undefined at runtime when no instant is derivable, so tsc cannot protect
  // this. Coerce before comparing or an at-less item throws.
  const aAt = a.at ?? '';
  const bAt = b.at ?? '';
  if (aAt !== bAt) {
    if (aAt === '') return 1;
    if (bAt === '') return -1;
    return aAt.localeCompare(bAt);
  }
  return a.id.localeCompare(b.id);
}

/**
 * Union `prev` and `incoming` by item id, preferring the INCOMING copy for any id
 * on both sides so a fresher delivery status wins. Always returns chronological
 * order - there is deliberately no empty-side fast path, because the documented
 * ordering contract has to hold on the first page too.
 */
export function mergeTimelineItems(
  prev: TimelineItem[],
  incoming: TimelineItem[],
): TimelineItem[] {
  const byId = new Map<string, TimelineItem>();
  for (const item of prev) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort(compareItems);
}
