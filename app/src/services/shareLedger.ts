/**
 * share-sent-outcome D7: the listing-send ledger follows the rule - only
 * reached attempts count. Each share of a (property, tenant) pair has ONE
 * entry on the pair's row: the attempt it records and that attempt's ledger
 * state. Every write is a conditional read-modify-write on the row's change
 * token (listingSendsRepo.putShareMemory), re-read and re-applied on a lost
 * condition up to a small bound, then logged at ERROR (the repair heals it).
 *
 * Order-independence: entries order by attempt (shareAttemptOrder: message
 * ids; a row-less attempt right after the one it retried; a seeded entry
 * before every real attempt). A NEWER attempt applies; the SAME attempt only
 * moves forward (counted by acceptance -> counted by delivery | pending |
 * failed; pending -> failed); an OLDER attempt applies only as a DELIVERY; an
 * entry counted by a delivery is terminal (I2). A legacy row's first write
 * seeds its memory from the row itself.
 *
 * Imports repos and libs only - never a job module. Log lines carry ids only.
 */
import type { Logger } from '../lib/logger.js';
import type { BroadcastRecipient } from '../repos/broadcastsRepo.js';
import type { ListingSendItem, ListingSendsRepo, ShareLedgerEntry, ShareMemoryWrite } from '../repos/listingSendsRepo.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { INDIVIDUAL_ATTEMPT_KEY, LEGACY_ATTEMPT_KEY, attemptKeyTimestampMs, compareAttemptKeys } from '../lib/shareAttemptOrder.js';

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
/** The entry key of an individual send (a seeded legacy row with no share id). */
const INDIVIDUAL_KEY = 'individual';
/** The only retried carrier code (a failed 30003 with a live promise is pending). */
const RETRIED_CODE = '30003';

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
    : { [INDIVIDUAL_KEY]: { attempt: INDIVIDUAL_ATTEMPT_KEY, state: 'counted', by: 'acceptance', countedAt: row.sentAt } };
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

/** Whether one entry counts the pair: a `counted` entry carrying its attempt's instant (the summary's rule - an entry without an instant counts nowhere). */
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
 * `broadcastId` = that entry's share (absent for `individual`). So a counted
 * row always carries sentAt, and an un-counted one never does.
 */
function summarize(shares: Record<string, ShareLedgerEntry>): Pick<ShareMemoryWrite, 'counted' | 'sentAt' | 'broadcastId'> {
  let latest: { key: string; at: string } | undefined;
  for (const [key, e] of Object.entries(shares)) {
    if (!ledgerEntryCounts(e)) continue;
    if (latest === undefined || e.countedAt > latest.at) latest = { key, at: e.countedAt };
  }
  if (latest === undefined) return { counted: false, sentAt: undefined, broadcastId: undefined };
  return { counted: true, sentAt: latest.at, broadcastId: latest.key === INDIVIDUAL_KEY ? undefined : latest.key };
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
      return ledgerEntryFor(attempt, conversationId, { kind: slot.errorCode === RETRIED_CODE && promiseLive ? 'pending' : 'failed' });
    default:
      return undefined;
  }
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
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const row = await deps.listingSends.getByKeyConsistent(args.unitId, args.contactId);
    const shares = seeded(row);
    if (!mayReplace(shares[args.broadcastId], args.entry)) return 'refused';
    shares[args.broadcastId] = args.entry;
    const next: ShareMemoryWrite = { shares, ...summarize(shares) };
    if (await deps.listingSends.putShareMemory(args.unitId, args.contactId, next, { token: row?.shares_op })) return 'written';
  }
  deps.log.error(
    { unitId: args.unitId, contactId: args.contactId, broadcastId: args.broadcastId, attempt: args.entry.attempt, state: args.entry.state },
    'share ledger: the entry write lost its condition past the re-read bound - the repair heals it',
  );
  return 'lost';
}
