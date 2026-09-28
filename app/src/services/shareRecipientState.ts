/**
 * share-sent-outcome D1: ONE per-recipient state for a property send, derived
 * from the slot plus - inside two bounds - the newest attempt's own message
 * row (its promise and its chain's end) and, for a queued slot of a finished
 * share, the recipient's send-attempt record. Two readings: SAFE (the review
 * list's "Already sent") and STRICT (labels, counts, ledger, milestone). The
 * share's STORED status is never read to decide whether a tenant got the
 * property (I1); it only tells a running pass from a finished one.
 *
 * Imports repos and libs only - never a job module (retrySend.ts and
 * sendReconcile.ts import each other; this service must not join that cycle).
 * Log lines carry ids and counts only.
 */
import type { Logger } from '../lib/logger.js';
import type { BroadcastItem, BroadcastRecipient, BroadcastsRepo } from '../repos/broadcastsRepo.js';
import { deriveBroadcastStats } from '../repos/broadcastsRepo.js';
import type { MessagesRepo } from '../repos/messagesRepo.js';
import type { SendAttemptRecord, SendAttemptsRepo } from '../repos/sendAttemptsRepo.js';
import { SEND_ATTEMPT_CLEANUP_MS } from '../repos/sendAttemptsRepo.js';
import { safeRecipientKey } from '../lib/sendFingerprint.js';
import { RECONCILE_CHECK_DELAYS_MS, SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import {
  RETRY_OUTCOME_UNCONFIRMED,
  RETRY_PROMISE_GRACE_MS,
  RETRY_SEND_WINDOW_MS,
  isRetryPromiseLive,
} from '../lib/retrySendWindow.js';
import { attemptKeyTimestampMs, retriedOfRowless } from '../lib/shareAttemptOrder.js';

export type RecipientState = 'reached' | 'pending' | 'unconfirmed' | 'in_flight' | 'stranded' | 'failed' | 'skipped';

/**
 * The longest a promise can be live, from the newest attempt's own timestamp:
 * the window, 1b's unknown-outcome refresh (the reconcile's last check delay),
 * the refresh's grace plus the liveness grace, and one minute of skew between
 * the provider's second-granular timestamp and the server clock. 24 minutes
 * today (15 + 4 + 2 + 2 + 1).
 */
export const RETRY_ROW_READ_BOUND_MS =
  RETRY_SEND_WINDOW_MS + RECONCILE_CHECK_DELAYS_MS[RECONCILE_CHECK_DELAYS_MS.length - 1]! + 2 * RETRY_PROMISE_GRACE_MS + 60_000;
/** A send-attempt record lives 30 days; an older strand reads stranded without a read. */
export const RECORD_READ_BOUND_MS = SEND_ATTEMPT_CLEANUP_MS;

/** A broadcast record `done` with one of these outcomes says the text never went. */
const NEVER_WENT = new Set<string>(['refused', 'rejected', 'enqueue_failed', 'redrive_refused']);
/** The only retried carrier code (a 30003 slot may hold a live promise). */
const RETRIED_CODE = '30003';

/** The share fields the classification reads: the stored status (a running pass or not) and its clocks. */
type ShareClock = Pick<BroadcastItem, 'status' | 'created_at' | 'updated_at'>;

export interface RecipientFacts {
  /** The newest attempt's row: its promise and chain end; 'unreadable' = the read threw. Absent = not read (outside the bound). */
  row?: { retryDueAt?: string; retryOutcome?: string } | 'unreadable';
  /** absent = the caller did not ask; null = read, absent; 'expired' = past the record's life, not read; 'unreadable' = the read threw. */
  record?: SendAttemptRecord | null | 'unreadable' | 'expired';
}
export interface ClassifiedRecipient {
  state: RecipientState;
  retryDueAt?: string;
  retryOutcome?: string;
  latestAttempt?: string;
}

export function classifyRecipient(share: ShareClock, slot: BroadcastRecipient, facts: RecipientFacts, nowMs: number): RecipientState {
  switch (slot.status) {
    case 'skipped':
      return 'skipped';
    case 'delivered':
    case 'sent':
      return 'reached';
    case 'queued': {
      if (share.status === 'sending') return 'in_flight';
      const rec = facts.record;
      if (rec === undefined || rec === 'unreadable') return 'in_flight'; // not asked, or the read threw: the safe side
      if (rec === null || rec === 'expired') return 'stranded'; // read and absent, or past the record's life
      return rec.state === 'done' && rec.outcome !== undefined && NEVER_WENT.has(rec.outcome) ? 'stranded' : 'in_flight';
    }
    case 'failed': {
      if (slot.errorCode === SEND_UNCONFIRMED_CODE) return 'unconfirmed';
      if (slot.errorCode !== RETRIED_CODE) return 'failed';
      const row = facts.row;
      if (row === undefined) return 'failed'; // outside the bound: the slot is authoritative
      if (row === 'unreadable') return 'pending'; // the safe side
      if (row.retryOutcome === RETRY_OUTCOME_UNCONFIRMED) return 'unconfirmed';
      return isRetryPromiseLive(row.retryDueAt, nowMs) ? 'pending' : 'failed';
    }
  }
}

/** SAFE reading (the composer's "Already sent"): the text may have reached the tenant. */
export function mayHaveReached(state: RecipientState): boolean {
  return state === 'reached' || state === 'pending' || state === 'unconfirmed' || state === 'in_flight';
}
/** STRICT reading (labels, counts, ledger, milestone): the carrier accepted or delivered it. */
export function hasReached(state: RecipientState): boolean {
  return state === 'reached';
}

function newestKey(slot: BroadcastRecipient): string | undefined {
  return slot.latestAttempt ?? slot.tsMsgId;
}

/** A failed-30003 slot whose newest attempt is younger than RETRY_ROW_READ_BOUND_MS (a key with no timestamp reads nothing). */
export function needsRowRead(slot: BroadcastRecipient, nowMs: number): boolean {
  if (slot.status !== 'failed' || slot.errorCode !== RETRIED_CODE) return false;
  const key = newestKey(slot);
  const ts = key === undefined ? undefined : attemptKeyTimestampMs(key);
  return ts !== undefined && nowMs - ts <= RETRY_ROW_READ_BOUND_MS;
}

/**
 * A queued slot of a finished share whose last write is younger than the
 * record's life. The age is `updated_at` (never earlier than the send start;
 * the send stamps no field of its own), falling back to `created_at`, so a
 * long-parked draft sent recently is not read as expired (deviation 16).
 */
export function needsRecordRead(share: ShareClock, slot: BroadcastRecipient, nowMs: number): boolean {
  if (slot.status !== 'queued' || share.status === 'sending') return false;
  const last = Date.parse(share.updated_at ?? share.created_at);
  return Number.isFinite(last) && nowMs - last <= RECORD_READ_BOUND_MS;
}

export interface RecipientStateDeps {
  messages: Pick<MessagesRepo, 'getByTsMsgIdConsistent'>;
  attempts: Pick<SendAttemptsRepo, 'get'>;
  now?: () => number;
  log: Logger;
}

const READ_CONCURRENCY = 8;

/** Map with at most `limit` calls in flight, preserving the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Every recipient's D1 state, keyed by contactKey. Row reads run only for
 * young failed-30003 slots; record reads only with `recordReads: true` (the
 * composer flag) - without them a queued slot of a finished share reads
 * `in_flight`, the safe side. Reads run 8 at a time; each read's failure is
 * caught per slot, logged, and read on the safe side.
 */
export async function resolveRecipientStates(
  deps: RecipientStateDeps,
  share: BroadcastItem,
  opts?: { recordReads?: boolean },
): Promise<Map<string, ClassifiedRecipient>> {
  const nowMs = (deps.now ?? Date.now)();
  const entries = Object.entries(share.recipients ?? {});
  const classified = await mapLimit(entries, READ_CONCURRENCY, async ([contactKey, slot]): Promise<[string, ClassifiedRecipient]> => {
    const facts: RecipientFacts = {};
    if (needsRowRead(slot, nowMs) && slot.conversationId !== undefined) {
      // A row-less marker reads the RETRIED row, which carries the outcome.
      const key = retriedOfRowless(newestKey(slot)!);
      try {
        const row = await deps.messages.getByTsMsgIdConsistent(slot.conversationId, key);
        facts.row =
          row === undefined
            ? {}
            : {
                ...(row.retry_due_at !== undefined && { retryDueAt: row.retry_due_at }),
                ...(row.retry_outcome !== undefined && { retryOutcome: row.retry_outcome }),
              };
      } catch (err) {
        deps.log.warn(
          { err, broadcastId: share.broadcastId, conversationId: slot.conversationId, tsMsgId: key },
          'share recipient state: attempt row read failed - reading the recipient as pending (safe)',
        );
        facts.row = 'unreadable';
      }
    }
    if (opts?.recordReads === true && slot.status === 'queued' && share.status !== 'sending') {
      if (!needsRecordRead(share, slot, nowMs)) {
        facts.record = 'expired';
      } else {
        try {
          const rec = await deps.attempts.get({ kind: 'broadcast', broadcastId: share.broadcastId, contactKey });
          facts.record = rec ?? null;
        } catch (err) {
          // A slot key may be `phone#<E164>`: logged redacted (the send sites' idiom).
          deps.log.warn(
            { err, broadcastId: share.broadcastId, recipientKey: safeRecipientKey(contactKey) },
            'share recipient state: attempt record read failed - reading the recipient as in flight (safe)',
          );
          facts.record = 'unreadable';
        }
      }
    }
    const state = classifyRecipient(share, slot, facts, nowMs);
    const row = facts.row !== undefined && facts.row !== 'unreadable' ? facts.row : undefined;
    return [
      contactKey,
      {
        state,
        ...(row?.retryDueAt !== undefined && { retryDueAt: row.retryDueAt }),
        ...(row?.retryOutcome !== undefined && { retryOutcome: row.retryOutcome }),
        ...(slot.latestAttempt !== undefined && { latestAttempt: slot.latestAttempt }),
      },
    ];
  });
  return new Map(classified);
}

/** The number of recipients whose retry promise is live (D4's `retry_pending`). */
export function retryPendingCount(states: Map<string, ClassifiedRecipient>): number {
  let n = 0;
  for (const s of states.values()) if (s.state === 'pending') n += 1;
  return n;
}

/** Keys whose D1 state is unconfirmed although the slot's own code is not send_unconfirmed (the row said the chain ended unresolved). */
export function unconfirmedByRow(states: Map<string, ClassifiedRecipient>, share: Pick<BroadcastItem, 'recipients'>): Set<string> {
  const keys = new Set<string>();
  for (const [key, s] of states) {
    if (s.state === 'unconfirmed' && share.recipients?.[key]?.errorCode !== SEND_UNCONFIRMED_CODE) keys.add(key);
  }
  return keys;
}

/** The STRICT reading over the slots, no reads: recipients the carrier accepted or delivered. */
export function reachedCount(share: Pick<BroadcastItem, 'recipients' | 'stats'>): number {
  const s = deriveBroadcastStats(share);
  return s.delivered + s.sent + (s.sending ?? 0);
}

/**
 * The composer flag's set (D1 SAFE reading) over every share of the unit,
 * whatever its stored status, resolved WITH record reads. Never throws: a
 * listByUnit failure logs WARN and returns what was resolved.
 */
export async function priorRecipientKeys(
  deps: RecipientStateDeps & { broadcasts: Pick<BroadcastsRepo, 'listByUnit'> },
  unitId: string,
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await deps.broadcasts.listByUnit(unitId, { ...(exclusiveStartKey !== undefined && { exclusiveStartKey }) });
      for (const share of page.items) {
        const states = await resolveRecipientStates(deps, share, { recordReads: true });
        for (const [contactKey, s] of states) if (mayHaveReached(s.state)) keys.add(contactKey);
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
  } catch (err) {
    deps.log.warn({ unitId, err, priorCount: keys.size }, 'priorRecipientKeys: byUnit read failed - returning what was resolved');
  }
  deps.log.info({ unitId, priorCount: keys.size }, 'broadcast prior-recipients resolved');
  return keys;
}
