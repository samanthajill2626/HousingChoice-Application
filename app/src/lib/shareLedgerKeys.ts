/**
 * flyer-leads plan 2.1 (assembly ruling AR1): the share-ledger KEYS and the
 * ONE "latest counted entry" rule. A pure, import-free leaf, because
 * services/shareLedger.ts (summarize: the pair's sentAt and broadcastId) and
 * lib/listingSendOutcome.ts (deriveListingSendOutcome: `signed_up`, spec D8)
 * must read the SAME entry, and lib/ never imports services/.
 *
 * A pair's row (listingSendsRepo `shares`) holds one entry per share, keyed
 * by the share's broadcastId, by `individual` (a seeded legacy row with no
 * share id) or by `flyer` (a flyer sign-up, spec D7).
 */

/** The entry key of an individual send (a seeded legacy row with no share id). */
export const INDIVIDUAL_SHARE_KEY = 'individual';

/** flyer-leads D7: the entry key of a flyer sign-up. */
export const FLYER_SHARE_KEY = 'flyer';

/**
 * flyer-leads D7: the attempt key of a flyer sign-up at `iso` - `<iso>#flyer`.
 * Like every attempt key it carries its instant before the first `#`
 * (shareAttemptOrder.attemptKeyTimestampMs), so the entry's countedAt is the
 * sign-up instant and a later sign-up is a NEWER attempt.
 */
export function flyerAttemptKey(iso: string): string {
  return `${iso}#${FLYER_SHARE_KEY}`;
}

/**
 * The key of the pair's LATEST counted entry: an entry whose state is
 * 'counted' AND that carries a string countedAt (an entry without an instant
 * counts nowhere). The greatest countedAt wins, compared as strings exactly
 * as summarize always has (countedAt is a normalized ISO); a tie keeps the
 * FIRST entry in Object.entries order (a strict `>`). Keys are never sorted.
 * undefined when no entry counts.
 */
export function latestCountedShareKey(
  shares: Record<string, { state: string; countedAt?: string }> | undefined,
): string | undefined {
  if (shares === undefined) return undefined;
  let latest: { key: string; at: string } | undefined;
  for (const [key, e] of Object.entries(shares)) {
    if (e.state !== 'counted' || typeof e.countedAt !== 'string') continue;
    if (latest === undefined || e.countedAt > latest.at) latest = { key, at: e.countedAt };
  }
  return latest?.key;
}
