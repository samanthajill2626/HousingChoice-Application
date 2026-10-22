/**
 * share-sent-outcome D7: the listing-send ledger follows the rule - only
 * reached attempts count. Each share of a (property, tenant) pair has ONE
 * entry on the pair's row: the attempt it records and that attempt's ledger
 * state. Every write is a conditional read-modify-write on the row's change
 * token (listingSendsRepo.putShareMemory), re-read and re-applied on a lost
 * condition up to a small bound, then logged at ERROR. A lost BROADCAST entry
 * is healed by the repair (app/scripts/repair-share-outcomes.ts rebuilds it
 * from the broadcast's slot); a lost flyer entry is not - the repair walks
 * broadcast slots only - so applyFlyerShareEntry logs its own ERROR line
 * saying so.
 *
 * Order-independence: entries order by attempt (shareAttemptOrder: message
 * ids; a row-less attempt right after the one it retried; a seeded entry
 * before every real attempt). A NEWER attempt applies; the SAME attempt only
 * moves forward (counted by acceptance -> counted by delivery | pending |
 * failed; pending -> failed); an OLDER attempt applies only as a DELIVERY; an
 * entry counted by a delivery is terminal (I2). A legacy row's first write
 * seeds its memory from the row itself.
 *
 * flyer-leads D7: a flyer sign-up is one more share entry (key `flyer`,
 * applyFlyerShareEntry) - refused while the pair holds a CURRENT decline,
 * decided on each round's read (O1: a decline stamps the token, so a decline
 * that lands mid-loop is seen on the forced re-read).
 *
 * Imports repos and libs only - never a job module. Log lines carry ids only.
 */
import type { Logger } from '../lib/logger.js';
import type { BroadcastRecipient } from '../repos/broadcastsRepo.js';
import type { ListingSendItem, ListingSendsRepo, ShareLedgerEntry, ShareMemoryWrite } from '../repos/listingSendsRepo.js';
import { RETRIED_ERROR_CODE } from '../lib/retrySendWindow.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys } from '../lib/shareAttemptOrder.js';
import { effectiveDecline } from '../lib/listingSendOutcome.js';
import { FLYER_SHARE_KEY, INDIVIDUAL_SHARE_KEY, flyerAttemptKey, latestCountedShareKey } from '../lib/shareLedgerKeys.js';

export type ShareLedgerOutcome =
  | { kind: 'accepted' }
  | { kind: 'delivered' }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'unconfirmed' };

export interface ShareLedgerDeps {
  listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>;
  log: Logger;
}

/** Re-reads after a lost condition (so up to 1 + MAX_REAPPLY writes). */
const MAX_REAPPLY = 3;

/**
 * The entry an attempt's outcome implies. A counted entry's `countedAt` is the
 * ATTEMPT's own provider instant (the ISO in its key), never the write instant,
 * so a delivery receipt does not move the pair's sentAt. A synthetic key
 * carries no instant and is never passed with a counting outcome.
 */
export function ledgerEntryFor(attempt: string, conversationId: string | undefined, outcome: ShareLedgerOutcome): ShareLedgerEntry {
  const base = { attempt, ...(conversationId !== undefined && { conversationId }) };
  const at = attemptKeyTimestampMs(attempt);
  const countedAt = at === undefined ? undefined : new Date(at).toISOString();
  switch (outcome.kind) {
    case 'accepted':
      return { ...base, state: 'counted', by: 'acceptance', ...(countedAt !== undefined && { countedAt }) };
    case 'delivered':
      return { ...base, state: 'counted', by: 'delivery', ...(countedAt !== undefined && { countedAt }) };
    case 'pending':
      return { ...base, state: 'pending' };
    case 'failed':
      return { ...base, state: 'failed' };
    case 'unconfirmed':
      return { ...base, state: 'unconfirmed' };
  }
}

/** The row's memory, seeded from the row itself on a legacy row (the share its broadcastId names, else `individual`, counted at its own sentAt). */
function seeded(row: ListingSendItem | undefined): Record<string, ShareLedgerEntry> {
  if (row === undefined) return {};
  if (row.shares !== undefined) return { ...row.shares };
  if (row.sentAt === undefined) return {};
  return row.broadcastId !== undefined
    ? { [row.broadcastId]: { attempt: LEGACY_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: row.sentAt } }
    : { [INDIVIDUAL_SHARE_KEY]: { attempt: INDIVIDUAL_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: row.sentAt } };
}

/** Whether `next` may replace `existing` for the same share (spec D7 order rule). */
function mayReplace(existing: ShareLedgerEntry | undefined, next: ShareLedgerEntry): boolean {
  if (existing === undefined) return true;
  if (existing.state === 'counted' && existing.by === 'delivery') return false; // a delivery is never erased (I2)
  const cmp = compareAttemptKeys(next.attempt, existing.attempt);
  if (cmp === 1) return true;
  if (cmp === -1) return next.state === 'counted' && next.by === 'delivery';
  // The SAME attempt: forward only.
  if (existing.state === 'counted') {
    return next.state === 'counted' ? next.by === 'delivery' : next.state === 'pending' || next.state === 'failed';
  }
  if (existing.state === 'pending') return next.state === 'failed';
  return false;
}

/**
 * Whether one entry counts the pair: a `counted` entry carrying its attempt's
 * instant (an entry without an instant counts nowhere). The summary's rule is
 * lib/shareLedgerKeys.ts latestCountedShareKey (flyer-leads AR1, OR-11). The
 * two agree on every entry the ledger writes (ledgerEntryFor stamps a string
 * countedAt or none) and differ only on a corrupt stored one: a non-string
 * countedAt (null, a number) passes this `!== undefined` test but not
 * latestCountedShareKey's `typeof === 'string'`. The repair script's census
 * reads this one, on the entry it forecasts for a pair with no row yet (built
 * by ledgerEntryFor), so the census and the summary agree there; a caller
 * that applied it to a stored entry could disagree with the summary.
 */
export function ledgerEntryCounts(entry: ShareLedgerEntry): entry is ShareLedgerEntry & { countedAt: string } {
  return entry.state === 'counted' && entry.countedAt !== undefined;
}

/**
 * Whether a STORED row counts the pair as the readers see it
 * (listingSendsRepo's listed rule): `counted` not false - absent on a legacy
 * row, which reads as counted - and a `sentAt`. An absent row counts nothing.
 */
export function ledgerRowCounted(row: ListingSendItem | undefined): boolean {
  return row !== undefined && row.counted !== false && typeof row.sentAt === 'string';
}

/**
 * The pair-level fields the entries imply: `counted` while a counted entry
 * (with its instant) exists; `sentAt` = the latest such instant and
 * `broadcastId` = that entry's share - absent for `individual` and, since
 * flyer-leads D7, for `flyer` (neither is a broadcast). The latest entry is
 * latestCountedShareKey's (lib/shareLedgerKeys.ts - the ONE rule the outcome
 * derivation reads too). So a counted row always carries sentAt, and an
 * un-counted one never does.
 */
function summarize(shares: Record<string, ShareLedgerEntry>): Pick<ShareMemoryWrite, 'counted' | 'sentAt' | 'broadcastId'> {
  const key = latestCountedShareKey(shares);
  const sentAt = key === undefined ? undefined : shares[key]?.countedAt;
  if (key === undefined || sentAt === undefined) return { counted: false, sentAt: undefined, broadcastId: undefined };
  return { counted: true, sentAt, broadcastId: key === INDIVIDUAL_SHARE_KEY || key === FLYER_SHARE_KEY ? undefined : key };
}

/**
 * spec D8 (the repair's census): what writing `entry` for `broadcastId` would
 * do to the pair's row, decided by the SAME rule applyShareLedgerEntry applies
 * (the legacy seed, then mayReplace) - and nothing is written. `'none'` = the
 * rule keeps the stored entry (the write would be refused); `'create'` = no
 * row yet (the entry becomes the row's first memory - whether that row counts
 * is ledgerEntryCounts(entry)); `'recount'` / `'uncount'` = the row's counted
 * flag, as the readers see it (ledgerRowCounted), flips on / off; `'update'` =
 * the entry changes and the flag does not.
 */
export function ledgerWouldChange(
  row: ListingSendItem | undefined,
  broadcastId: string,
  entry: ShareLedgerEntry,
): 'create' | 'recount' | 'uncount' | 'update' | 'none' {
  const shares = seeded(row);
  if (!mayReplace(shares[broadcastId], entry)) return 'none';
  if (row === undefined) return 'create';
  shares[broadcastId] = entry;
  const before = ledgerRowCounted(row);
  const after = summarize(shares).counted;
  if (before === after) return 'update';
  return after ? 'recount' : 'uncount';
}

/**
 * The entry a slot's OWN state implies (the repair's ledger rebuild, T13): the
 * slot is the durable record, the ledger follows it. delivered -> delivered;
 * sent -> accepted; failed 30003 with a live promise -> pending;
 * send_unconfirmed -> unconfirmed; any other failure -> failed; queued and
 * skipped -> none. The attempt is the slot's newest (`latestAttempt ??
 * tsMsgId`); a slot with neither implies none.
 */
export function ledgerEntryForSlot(slot: BroadcastRecipient, conversationId: string, promiseLive: boolean): ShareLedgerEntry | undefined {
  const attempt = slot.latestAttempt ?? slot.tsMsgId;
  if (attempt === undefined) return undefined;
  switch (slot.status) {
    case 'delivered':
      return ledgerEntryFor(attempt, conversationId, { kind: 'delivered' });
    case 'sent':
      return ledgerEntryFor(attempt, conversationId, { kind: 'accepted' });
    case 'failed':
      if (slot.errorCode === SEND_UNCONFIRMED_CODE) return ledgerEntryFor(attempt, conversationId, { kind: 'unconfirmed' });
      // Only a failed 30003 with a live promise is pending.
      return ledgerEntryFor(attempt, conversationId, { kind: slot.errorCode === RETRIED_ERROR_CODE && promiseLive ? 'pending' : 'failed' });
    default:
      return undefined;
  }
}

/** What one run of the ledger loop decided. `'vetoed'` = the caller's veto refused the write on a read. */
type LedgerLoopResult = 'written' | 'refused' | 'lost' | 'vetoed';

/**
 * The ONE read-modify-write loop every ledger write runs (spec D7): read
 * consistently; let `veto` refuse the write on THAT read (flyer-leads D7: the
 * flyer's current-decline refusal - decided on each round's read, so a decline
 * that lands mid-loop is seen on the re-read its token change forces, O1);
 * seed a legacy row's memory, apply the order rule, summarize, write on the
 * token. A lost condition re-reads and re-applies up to MAX_REAPPLY times,
 * then ONE ERROR (`lostLine`, ids only: the pair, `lostIds`, the attempt and
 * its state) and `'lost'`.
 */
async function applyLedgerLoop(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; shareKey: string; entry: ShareLedgerEntry },
  opts: { veto?: (row: ListingSendItem | undefined) => boolean; lostLine: string; lostIds: Record<string, string> },
): Promise<LedgerLoopResult> {
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const row = await deps.listingSends.getByKeyConsistent(args.unitId, args.contactId);
    if (opts.veto !== undefined && opts.veto(row)) return 'vetoed';
    const shares = seeded(row);
    if (!mayReplace(shares[args.shareKey], args.entry)) return 'refused';
    shares[args.shareKey] = args.entry;
    const next: ShareMemoryWrite = { shares, ...summarize(shares) };
    if (await deps.listingSends.putShareMemory(args.unitId, args.contactId, next, { token: row?.shares_op })) return 'written';
  }
  deps.log.error(
    { unitId: args.unitId, contactId: args.contactId, ...opts.lostIds, attempt: args.entry.attempt, state: args.entry.state },
    opts.lostLine,
  );
  return 'lost';
}

/**
 * Apply one share's entry to the pair's row: read consistently, seed a legacy
 * row's memory, apply the order rule, summarize, write on the token. A lost
 * condition re-reads and re-applies up to MAX_REAPPLY times, then `'lost'`
 * with ONE ERROR. `'refused'` = the order rule kept the stored entry.
 */
export async function applyShareLedgerEntry(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; broadcastId: string; entry: ShareLedgerEntry },
): Promise<'written' | 'refused' | 'lost'> {
  const result = await applyLedgerLoop(
    deps,
    { unitId: args.unitId, contactId: args.contactId, shareKey: args.broadcastId, entry: args.entry },
    {
      lostLine: 'share ledger: the entry write lost its condition past the re-read bound - the repair heals it',
      lostIds: { broadcastId: args.broadcastId },
    },
  );
  // No veto is passed, so the loop never answers 'vetoed' here.
  return result === 'vetoed' ? 'refused' : result;
}

/** flyer-leads D7 (plan 2.2, AR2): what a flyer sign-up's ledger write did. */
export type FlyerShareResult = 'written' | 'declined' | 'refused' | 'lost';

/**
 * flyer-leads D7: record a flyer sign-up for (unitId, contactId) at
 * `signedUpAt` (ISO with ms): ONE counted-by-acceptance entry under the
 * `flyer` key whose attempt is `<signedUpAt>#flyer`, so the pair's sentAt
 * moves to the sign-up and it reads `signed_up` (D8); no "Property sent"
 * milestone is written here. Same loop as applyShareLedgerEntry plus ONE
 * refusal, decided on EACH round's consistent read: a CURRENT decline
 * (effectiveDecline(row, undefined) - at or after the row's sentAt, or any
 * decline on a row with none; tours are not consulted) answers 'declined',
 * writes nothing and logs at INFO. A sign-up never clears a decline it reads,
 * so a public request never undoes a decline already written (one the
 * outcome route has stamped but not yet written can be superseded at birth -
 * docs/issues/flyer-signup-decline-click-race.md); the refusal is the
 * flyer's ONLY - a broadcast or individual share still supersedes a decline.
 * Because tours are not consulted, a decline that a later tour already
 * superseded (a tenant's pair reads Interested) still refuses the entry, and
 * if that tour is later canceled the pair reads by its old sentAt (No reply
 * yet), not signed_up - the spec D7 residual. 'refused' = the order rule kept
 * the stored flyer entry (an equal or newer sign-up instant - AR2). 'lost' =
 * token retries exhausted, ONE ERROR with the flyer's own line: the repair
 * walks broadcast slots only, so it never heals a flyer entry. A brand-new
 * row's `via` is 'broadcast', putShareMemory's first-write if_not_exists
 * value: first-write furniture that rides the wire but that nothing renders
 * or branches on. Log lines carry ids only.
 */
export async function applyFlyerShareEntry(
  deps: ShareLedgerDeps,
  args: { unitId: string; contactId: string; signedUpAt: string },
): Promise<FlyerShareResult> {
  const entry = ledgerEntryFor(flyerAttemptKey(args.signedUpAt), undefined, { kind: 'accepted' });
  const result = await applyLedgerLoop(
    deps,
    { unitId: args.unitId, contactId: args.contactId, shareKey: FLYER_SHARE_KEY, entry },
    {
      veto: (row) => effectiveDecline(row ?? {}, undefined),
      lostLine:
        'share ledger: the flyer entry write lost its condition past the re-read bound - not repaired (the repair walks broadcast slots only)',
      lostIds: { shareKey: FLYER_SHARE_KEY },
    },
  );
  if (result === 'vetoed') {
    deps.log.info({ unitId: args.unitId, contactId: args.contactId }, 'share ledger: flyer entry not written - the pair holds a current decline');
    return 'declined';
  }
  return result;
}
