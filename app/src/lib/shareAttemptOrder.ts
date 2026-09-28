/**
 * share-sent-outcome D2: the ORDER of a recipient's attempts. An attempt's
 * key is its message id (`<provider ISO>#<SID>`, messagesRepo.buildTsMsgId),
 * so plain string order is provider-time order. Two synthetic keys exist:
 * a ROW-LESS attempt (the reconcile closed a retry `unresolved` before any
 * row was appended) is `<retried row's key>~` - `~` (0x7E) sorts after `#`
 * and every SID character, so the marker is newer than the row it retried
 * and older than any row with a later timestamp; a SEEDED legacy ledger
 * entry is `!legacy` (`!` sorts before any year digit). Import-free leaf.
 */
export const ROWLESS_ATTEMPT_SUFFIX = '~';
export const LEGACY_ATTEMPT_KEY = '!legacy';
export const INDIVIDUAL_ATTEMPT_KEY = '!individual';

export function rowlessAttemptKey(retriedTsMsgId: string): string {
  return `${retriedTsMsgId}${ROWLESS_ATTEMPT_SUFFIX}`;
}

export function isRowlessAttemptKey(key: string): boolean {
  return key.endsWith(ROWLESS_ATTEMPT_SUFFIX);
}

export function retriedOfRowless(key: string): string {
  return isRowlessAttemptKey(key) ? key.slice(0, -ROWLESS_ATTEMPT_SUFFIX.length) : key;
}

export function compareAttemptKeys(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The provider instant a key carries (the ISO before the first `#`); undefined for a synthetic `!` key or garbage. */
export function attemptKeyTimestampMs(key: string): number | undefined {
  if (key.startsWith('!')) return undefined;
  const hash = key.indexOf('#');
  if (hash <= 0) return undefined;
  const ms = Date.parse(key.slice(0, hash));
  return Number.isFinite(ms) ? ms : undefined;
}
