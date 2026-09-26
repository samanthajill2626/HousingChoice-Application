// inboxListMerge - the PURE list model behind useInbox (spec 5.5 / 5.6).
//
// The list is head (the server's page one) ++ tail (rows loaded by "Load
// more"). A HEAD READ applies through mergeHeadRead:
//   branch C (complete page):   the list BECOMES the page; loaded pages drop
//                               and reload on scroll (Option B, decision 6).
//   branch I (incomplete page): the read stopped early (budget exit / truncated),
//                               so it merges in and removes nothing.
// A loadMore page applies through appendPage, deduplicated against the list.
// Both run dedupeConversations so a relay group converted in place to a group
// text (same conversationId, keys g:<id> vs gt:<id>) never renders twice.
//
// pageEpoch bumps ONLY here - on a committed head read or appended page -
// never on a mark-read patch; useAutoLoad keys its re-check on it (spec 5.2).
import type { InboxFilter, InboxPage, InboxRow } from '../../api/index.js';

export interface ListState {
  head: InboxRow[];
  tail: InboxRow[];
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  autoLoadArmed: boolean;
  pageEpoch: number;
}

/** Stable identity for a row: conversationId for the two multi-party kinds,
 *  contactId for contacts, phone for unknowns. The four prefixes never collide -
 *  native group texts take `gt:` because `g:` is already relay's, and the
 *  trailing branch is the UNKNOWN case, so an unhandled kind would key as `u:`
 *  (empty phone) and collide with every other unhandled row. */
export function rowKey(row: InboxRow): string {
  if (row.kind === 'relay_group') return `g:${row.conversationId ?? ''}`;
  if (row.kind === 'group_text') return `gt:${row.conversationId ?? ''}`;
  return row.kind === 'contact' ? `c:${row.contactId ?? ''}` : `u:${row.phone ?? ''}`;
}

export function emptyListState(): ListState {
  return {
    head: [],
    tail: [],
    cursor: null,
    groupsTruncated: false,
    truncated: false,
    autoLoadArmed: false,
    pageEpoch: 0,
  };
}

export function baseOf(state: ListState): InboxRow[] {
  return [...state.head, ...state.tail];
}

function isAdditive(row: InboxRow, filter: InboxFilter): boolean {
  return filter === 'all' && (row.kind === 'relay_group' || row.kind === 'group_text');
}

function dedupeByRowKey(rows: InboxRow[]): InboxRow[] {
  const seen = new Set<string>();
  const out: InboxRow[] = [];
  for (const r of rows) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** One row per conversationId across kinds: a row whose rowKey is in
 *  `freshKeys` beats one that is not; otherwise the first occurrence wins. */
export function dedupeConversations(rows: InboxRow[], freshKeys: Set<string>): InboxRow[] {
  const winner = new Map<string, InboxRow>();
  for (const r of rows) {
    if (r.conversationId === undefined) continue;
    const cur = winner.get(r.conversationId);
    if (cur === undefined) {
      winner.set(r.conversationId, r);
    } else if (!freshKeys.has(rowKey(cur)) && freshKeys.has(rowKey(r))) {
      winner.set(r.conversationId, r);
    }
  }
  return rows.filter((r) => r.conversationId === undefined || winner.get(r.conversationId) === r);
}

function splitByConversation(head: InboxRow[], tail: InboxRow[], freshKeys: Set<string>): { head: InboxRow[]; tail: InboxRow[] } {
  const kept = new Set(dedupeConversations([...head, ...tail], freshKeys).map(rowKey));
  return {
    head: head.filter((r) => kept.has(rowKey(r))),
    tail: tail.filter((r) => kept.has(rowKey(r))),
  };
}

/** Apply a committed head read (spec 5.6). */
export function mergeHeadRead(
  state: ListState,
  page: InboxPage,
  filter: InboxFilter,
  limit: number,
): ListState {
  const P = page.rows;
  const C = page.nextCursor;
  const truncated = page.truncated === true;
  const groupsTruncated = page.groupsTruncated === true;
  const pagedP = P.filter((r) => !isAdditive(r, filter));
  const headComplete = !truncated && (C === null || pagedP.length >= limit);
  const freshKeys = new Set(P.map(rowKey));
  const hadRows = state.head.length + state.tail.length > 0;

  if (headComplete) {
    const split = splitByConversation(P, [], freshKeys);
    return {
      head: split.head,
      tail: [],
      cursor: C,
      groupsTruncated,
      truncated,
      autoLoadArmed: P.length > 0,
      pageEpoch: state.pageEpoch + 1,
    };
  }

  // Branch I: merge in, remove nothing. A list with rows keeps its old cursor
  // when it is NON-NULL (it continues the loaded tail); a null cursor takes
  // the read's cursor, so a feed that grew past a fully loaded list stays
  // reachable (the next page re-delivers rows the list holds; appendPage's
  // rowKey dedupe absorbs them). An empty list takes the read's cursor too.
  const inP = freshKeys;
  const mergedHead = dedupeByRowKey([...P, ...state.head.filter((r) => !inP.has(rowKey(r)))]);
  const keptTail = state.tail.filter((r) => !inP.has(rowKey(r)));
  const split = splitByConversation(mergedHead, keptTail, freshKeys);
  return {
    head: split.head,
    tail: split.tail,
    cursor: hadRows && state.cursor !== null ? state.cursor : C,
    groupsTruncated,
    truncated,
    autoLoadArmed: hadRows ? state.autoLoadArmed : P.length > 0,
    pageEpoch: state.pageEpoch + 1,
  };
}

/** Apply a committed loadMore page (spec 5.5): dedupe, install the cursor,
 *  bump the epoch, arm iff at least one NEW row arrived. */
export function appendPage(state: ListState, page: InboxPage): ListState {
  const present = new Set(baseOf(state).map(rowKey));
  const fresh = page.rows.filter((r) => !present.has(rowKey(r)));
  const freshKeys = new Set(fresh.map(rowKey));
  const split = splitByConversation(state.head, [...state.tail, ...fresh], freshKeys);
  return {
    ...state,
    head: split.head,
    tail: split.tail,
    cursor: page.nextCursor,
    truncated: page.truncated === true,
    autoLoadArmed: fresh.length > 0,
    pageEpoch: state.pageEpoch + 1,
  };
}

/** Rewrite one row's unreadCount wherever it sits. Not an epoch bump. */
export function patchUnread(state: ListState, key: string, unreadCount: number): ListState {
  const map = (rows: InboxRow[]): InboxRow[] =>
    rows.map((r) => (rowKey(r) === key ? { ...r, unreadCount } : r));
  return { ...state, head: map(state.head), tail: map(state.tail) };
}
