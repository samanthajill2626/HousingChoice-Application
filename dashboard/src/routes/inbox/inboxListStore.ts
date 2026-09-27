// inboxListStore - the in-memory list snapshot that lets /inbox come back
// instantly after a navigation (spec 5.8). Module-level state, no React: it
// lives for the page session, is keyed by OPERATOR + filter + page size so one
// operator's rows can never restore for another, and is cleared by AuthGate
// when the session goes anonymous. autoLoadArmed is deliberately NOT part of
// the snapshot: a restore mounts unarmed and the first complete head read arms.
import type { InboxFilter, InboxRow } from '../../api/index.js';

export interface InboxListSnapshot {
  /** Server order, NOT narrowed, NOT sorted, pending patches folded in. */
  head: InboxRow[];
  tail: InboxRow[];
  cursor: string | null;
  groupsTruncated: boolean;
  truncated: boolean;
  scrollTop: number;
}

const store = new Map<string, InboxListSnapshot>();

export function inboxListKey(operatorId: string, filter: InboxFilter, limit: number): string {
  return `${operatorId}:${filter}:${limit}`;
}

export function saveInboxList(key: string, snapshot: InboxListSnapshot): void {
  store.set(key, snapshot);
}

export function loadInboxList(key: string): InboxListSnapshot | undefined {
  return store.get(key);
}

export function clearInboxLists(): void {
  store.clear();
}
