/**
 * share-sent-outcome D2: a LATER attempt reaches its share slot through ONE
 * attempt-ordered transition (broadcastsRepo.applyAttemptOutcome - the slot,
 * its newest-attempt pointer and the stats delta in one conditional write);
 * D7: the listing-send ledger follows it (shareLedger.applyShareLedgerEntry).
 *
 * The rule (spec D2), decided from a consistent read of the slot:
 * - FROM `failed` (any code) or `sent` only - never from `queued`,
 *   `delivered` or `skipped`, never TO `queued`;
 * - a NEWER attempt always applies and replaces status, code, carrier
 *   instant and pointer (it never inherits the older attempt's instant);
 * - the SAME attempt moves only forward from `sent` (to `delivered`, to
 *   `failed`, or `sent` gaining its carrier instant) - `failed` is terminal;
 * - an OLDER attempt applies only as a DELIVERY (a delivery is never erased,
 *   I2), and the slot then records the delivered attempt.
 * A refused condition re-reads and re-decides up to MAX_REAPPLY times, then
 * `'lost'` with ONE WARN (the repair heals it). A slot that ALREADY records
 * the write's own `next` is APPLIED (plan deviation 15: a committed write
 * whose response was lost and replayed); its side effects are idempotent and
 * run again, except that a replayed `failed` 30003 carrying no promise skips
 * the ledger (the winner's entry may be `pending`).
 *
 * The one source of a promise is the message row (I5): nothing here copies
 * `retry_due_at` or `retry_outcome` onto a slot or a ledger entry - a promise
 * only chooses the ledger state (`pending`) and the emit's lower bound.
 *
 * Imports repos and libs only - never a job module (the retrySend <->
 * sendReconcile import cycle, sendReconcile.ts header). Log lines carry ids
 * and counts only; a slot key can be `phone#<E164>`, so it is logged through
 * safeRecipientKey.
 */
import type { Logger } from '../lib/logger.js';
import type { BroadcastItem, BroadcastRecipient, BroadcastsRepo, BroadcastStats } from '../repos/broadcastsRepo.js';
import { deriveBroadcastStats } from '../repos/broadcastsRepo.js';
import type { MessageItem } from '../repos/messagesRepo.js';
import type { EventBus } from '../lib/events.js';
import { SEND_UNCONFIRMED_CODE } from '../lib/sendOutcome.js';
import { isRetryPromiseLive } from '../lib/retrySendWindow.js';
import { safeRecipientKey } from '../lib/sendFingerprint.js';
import { compareAttemptKeys } from '../lib/shareAttemptOrder.js';
import { applyShareLedgerEntry, ledgerEntryFor, type ShareLedgerDeps, type ShareLedgerOutcome } from './shareLedger.js';

/** What an attempt ended as. `sent` is carrier-confirmed when `carrierSentAt` is present, a bare acceptance otherwise. */
export type AttemptOutcome =
  | { kind: 'sent'; carrierSentAt?: string }
  | { kind: 'delivered'; carrierSentAt?: string }
  | { kind: 'failed'; errorCode: string; retryDueAt?: string }
  | { kind: 'unresolved' };

/**
 * A later attempt for one recipient of a share: matched to its slot by the
 * slot's conversation and ORIGINAL message pointer (`retryRoot`), never by
 * the slot key. `attemptKey` is the attempt's order key (its tsMsgId, or the
 * row-less marker). `recipientContactId` is the send-time holder the row
 * recorded - the ledger's contact when the slot key is `phone#...`.
 */
export interface LaterAttempt {
  broadcastId: string;
  conversationId: string;
  retryRoot: string;
  attemptKey: string;
  outcome: AttemptOutcome;
  recipientContactId?: string;
}

export interface ShareAttemptOutcomeDeps {
  broadcasts: Pick<BroadcastsRepo, 'getByIdConsistent' | 'applyAttemptOutcome'>;
  ledger: ShareLedgerDeps;
  events: EventBus;
  log: Logger;
  now?: () => number;
}

export type ApplyResult = 'applied' | 'refused' | 'no_slot' | 'no_broadcast' | 'lost';

type Bucket = 'queued' | 'sent' | 'delivered' | 'failed' | 'unconfirmed';
/** Re-reads after a lost condition (so up to 1 + MAX_REAPPLY writes). */
const MAX_REAPPLY = 3;
/** applyLaterAttemptBounded: calls in all before a throw is dropped (the first + two retries). */
const BOUNDED_TRIES = 3;
/** The only retried carrier code (a replayed 30003 without its promise must not downgrade a pending entry). */
const RETRIED_CODE = '30003';

/** The persisted stats bucket a slot counts in (`failed` with send_unconfirmed is `unconfirmed`; a skip moves nothing here). */
function bucketOf(slot: Pick<BroadcastRecipient, 'status' | 'errorCode'>): Bucket | undefined {
  if (slot.status === 'skipped') return undefined;
  if (slot.status === 'failed') return slot.errorCode === SEND_UNCONFIRMED_CODE ? 'unconfirmed' : 'failed';
  return slot.status;
}

/** The slot a write leaves: the original pointer kept, the newest-attempt pointer set, the carrier instant the OUTCOME's (the same attempt keeps the slot's when the outcome has none). */
function nextSlot(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>, sameAttempt: boolean): BroadcastRecipient {
  const keep = {
    ...(slot.conversationId !== undefined && { conversationId: slot.conversationId }),
    ...(slot.tsMsgId !== undefined && { tsMsgId: slot.tsMsgId }),
    latestAttempt: input.attemptKey,
  };
  const o = input.outcome;
  const carrier = o.kind === 'sent' || o.kind === 'delivered' ? (o.carrierSentAt ?? (sameAttempt ? slot.carrierSentAt : undefined)) : undefined;
  switch (o.kind) {
    case 'sent':
      return { ...keep, status: 'sent', ...(carrier !== undefined && { carrierSentAt: carrier }) };
    case 'delivered':
      return { ...keep, status: 'delivered', ...(carrier !== undefined && { carrierSentAt: carrier }) };
    case 'failed':
      return { ...keep, status: 'failed', errorCode: o.errorCode };
    case 'unresolved':
      return { ...keep, status: 'failed', errorCode: SEND_UNCONFIRMED_CODE };
  }
}

/** The attempt a slot currently records (`''` for a slot that never sent - every key is newer). */
function currentAttempt(slot: BroadcastRecipient): string {
  return slot.latestAttempt ?? slot.tsMsgId ?? '';
}

/** The D2 order rule: may `input` move `slot`? The comparison when allowed. */
function allowed(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): { cmp: -1 | 0 | 1 } | undefined {
  if (slot.status !== 'failed' && slot.status !== 'sent') return undefined;
  const cmp = compareAttemptKeys(input.attemptKey, currentAttempt(slot));
  if (cmp === 1) return { cmp };
  if (cmp === -1) return input.outcome.kind === 'delivered' ? { cmp } : undefined;
  if (slot.status !== 'sent') return undefined; // the same attempt: failed is terminal
  if (input.outcome.kind === 'delivered' || input.outcome.kind === 'failed') return { cmp };
  return input.outcome.kind === 'sent' && slot.carrierSentAt === undefined && input.outcome.carrierSentAt !== undefined ? { cmp } : undefined;
}

/** The D2 order rule alone, no reads (the repair's census asks it before counting a slot "to move"). */
export function wouldApply(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): boolean {
  return allowed(slot, input) !== undefined;
}

/** The slot as the transition would leave it (the repair's census projection); meaningful only where `wouldApply` holds. */
export function projectSlot(slot: BroadcastRecipient, input: Pick<LaterAttempt, 'attemptKey' | 'outcome'>): BroadcastRecipient {
  return nextSlot(slot, input, compareAttemptKeys(input.attemptKey, currentAttempt(slot)) === 0);
}

function slotEquals(a: BroadcastRecipient, b: BroadcastRecipient): boolean {
  return a.status === b.status && a.errorCode === b.errorCode && a.carrierSentAt === b.carrierSentAt && a.latestAttempt === b.latestAttempt;
}

function ledgerOutcome(o: AttemptOutcome, nowMs: number): ShareLedgerOutcome {
  switch (o.kind) {
    case 'delivered':
      return { kind: 'delivered' };
    case 'sent':
      return { kind: 'accepted' };
    case 'unresolved':
      return { kind: 'unconfirmed' };
    case 'failed':
      return isRetryPromiseLive(o.retryDueAt, nowMs) ? { kind: 'pending' } : { kind: 'failed' };
  }
}

/** spec D7: the pair's contact - the slot key when it is a contact id; else the row's send-time holder; else none. */
function pairContact(contactKey: string, recipientContactId: string | undefined): string | undefined {
  return contactKey.startsWith('phone#') ? recipientContactId : contactKey;
}

/** The D7 entry for one attempt of one share's pair. Best-effort: a throw is ONE ERROR, never propagated. */
async function writeLedger(
  deps: Pick<ShareAttemptOutcomeDeps, 'ledger' | 'log' | 'now'>,
  share: BroadcastItem,
  contactId: string | undefined,
  attempt: string,
  conversationId: string,
  outcome: AttemptOutcome,
): Promise<void> {
  if (typeof share.unitId !== 'string' || share.unitId.length === 0) return;
  if (contactId === undefined) {
    deps.log.info({ broadcastId: share.broadcastId, conversationId, attempt }, 'share ledger: no contact for the pair - no ledger entry');
    return;
  }
  const entry = ledgerEntryFor(attempt, conversationId, ledgerOutcome(outcome, (deps.now ?? Date.now)()));
  try {
    await applyShareLedgerEntry(deps.ledger, { unitId: share.unitId, contactId, broadcastId: share.broadcastId, entry });
  } catch (err) {
    deps.log.error({ err, broadcastId: share.broadcastId, contactId, conversationId, attempt }, 'share ledger: entry write failed (best-effort)');
  }
}

/** The idempotent side effects of an applied outcome: the ledger entry, then the emit (a promise count only for a failed 30003 with a live promise - the rollup's lower bound, spec D4). */
async function sideEffects(
  deps: ShareAttemptOutcomeDeps,
  item: BroadcastItem,
  contactKey: string,
  input: LaterAttempt,
  ids: Record<string, unknown>,
  replayed: boolean,
): Promise<void> {
  const nowMs = (deps.now ?? Date.now)();
  const o = input.outcome;
  const skipLedger = replayed && o.kind === 'failed' && o.errorCode === RETRIED_CODE && o.retryDueAt === undefined;
  if (skipLedger) {
    deps.log.info({ ...ids, recipientKey: safeRecipientKey(contactKey) }, 'share attempt outcome: replayed failure without a promise - ledger left to the winner');
  } else {
    await writeLedger(deps, item, pairContact(contactKey, input.recipientContactId), input.attemptKey, input.conversationId, o);
  }
  const pending = o.kind === 'failed' && isRetryPromiseLive(o.retryDueAt, nowMs);
  deps.events.emit('broadcast.updated', {
    broadcastId: item.broadcastId,
    status: item.status,
    stats: deriveBroadcastStats(item, pending ? { retryPending: 1 } : undefined),
  });
}

/**
 * Apply a later attempt's outcome to its share slot (spec D2) and, when it
 * applied, its ledger entry (D7) and a `broadcast.updated` emit. Never throws
 * for a refusal, a missing slot or a missing share; a repo fault propagates
 * (the callers bound or guard it). `'no_slot'`: the CALLER picks the level
 * (ERROR for a retry row - a routing bug).
 */
export async function applyLaterAttempt(deps: ShareAttemptOutcomeDeps, input: LaterAttempt): Promise<ApplyResult> {
  const ids = { broadcastId: input.broadcastId, conversationId: input.conversationId, retryRoot: input.retryRoot, attempt: input.attemptKey, outcome: input.outcome.kind };
  for (let round = 0; round <= MAX_REAPPLY; round += 1) {
    const share = await deps.broadcasts.getByIdConsistent(input.broadcastId);
    if (share === undefined) {
      deps.log.warn(ids, 'share attempt outcome: broadcast not found');
      return 'no_broadcast';
    }
    const found = Object.entries(share.recipients ?? {}).find(([, s]) => s.conversationId === input.conversationId && s.tsMsgId === input.retryRoot);
    if (found === undefined) return 'no_slot';
    const [contactKey, slot] = found;
    const recipientKey = safeRecipientKey(contactKey);
    // Deviation 15, first check: a replayed call (a throw after a committed
    // write, retried by the caller, or any fresh call over the same outcome)
    // finds the slot already recording THIS outcome - the order rule would
    // refuse it, so decide before the rule. No write: the stats never move twice.
    if (slotEquals(slot, nextSlot(slot, input, true)) || slotEquals(slot, nextSlot(slot, input, false))) {
      deps.log.info({ ...ids, recipientKey }, 'share attempt outcome: already applied (a replayed call) - running its side effects');
      await sideEffects(deps, share, contactKey, input, ids, true);
      return 'applied';
    }
    const ok = allowed(slot, input);
    if (ok === undefined) return 'refused';
    const next = nextSlot(slot, input, ok.cmp === 0);
    const from = bucketOf(slot);
    const to = bucketOf(next);
    const delta: Partial<BroadcastStats> = from !== to ? { ...(from !== undefined && { [from]: -1 }), ...(to !== undefined && { [to]: 1 }) } : {};
    const res = await deps.broadcasts.applyAttemptOutcome(input.broadcastId, contactKey, { status: slot.status, latestAttempt: slot.latestAttempt }, next, delta);
    if (!res.applied) {
      // Deviation 15, second check: the SDK's own replay of a committed write
      // refuses its condition; the consistent re-read tells.
      const again = await deps.broadcasts.getByIdConsistent(input.broadcastId);
      const now = again?.recipients?.[contactKey];
      if (again === undefined || now === undefined || !slotEquals(now, next)) continue;
      deps.log.info({ ...ids, recipientKey }, 'share attempt outcome: already applied (a replayed write) - running its side effects');
      await sideEffects(deps, again, contactKey, input, ids, true);
      return 'applied';
    }
    await sideEffects(deps, res.item ?? share, contactKey, input, ids, false);
    deps.log.info({ ...ids, recipientKey, from: slot.status, to: next.status }, 'share attempt outcome applied');
    return 'applied';
  }
  deps.log.warn(ids, 'share attempt outcome: the slot write lost its condition past the re-read bound - the repair heals it');
  return 'lost';
}

/**
 * Plan deviation 11 (the reconcile's two sites): `applyLaterAttempt` with a
 * THROW retried twice (a transient DynamoDB fault survives), then ONE ERROR
 * with the ids and `'threw'` - never propagated, so a permanent failure (the
 * 400 KB item-size error) never loops a check through the queue to the DLQ.
 * A dropped write is the repair's residue. A replay of a write that committed
 * before its throw reads as applied (deviation 15).
 */
export async function applyLaterAttemptBounded(deps: ShareAttemptOutcomeDeps, input: LaterAttempt): Promise<ApplyResult | 'threw'> {
  let last: unknown;
  for (let attempt = 0; attempt < BOUNDED_TRIES; attempt += 1) {
    try {
      return await applyLaterAttempt(deps, input);
    } catch (err) {
      last = err;
    }
  }
  deps.log.error(
    { err: last, broadcastId: input.broadcastId, conversationId: input.conversationId, retryRoot: input.retryRoot, attempt: input.attemptKey, outcome: input.outcome.kind },
    'share slot write failed after retries (best-effort; the repair heals it)',
  );
  return 'threw';
}

/**
 * spec D7 for an ORIGINAL row's receipt (the webhook's rollup matched the
 * slot): the same entry mapping, `attempt` = the row's tsMsgId; the pair's
 * contact is the slot key when a contact id, else the row's
 * `recipient_contact_id` (plan deviation 6), else INFO and no entry; a
 * unit-less share writes nothing.
 */
export async function originalRowLedgerWrite(
  deps: Pick<ShareAttemptOutcomeDeps, 'ledger' | 'log' | 'now'>,
  args: { share: BroadcastItem; contactKey: string; row: Pick<MessageItem, 'tsMsgId' | 'conversationId' | 'recipient_contact_id'>; outcome: AttemptOutcome },
): Promise<void> {
  await writeLedger(deps, args.share, pairContact(args.contactKey, args.row.recipient_contact_id), args.row.tsMsgId, args.row.conversationId, args.outcome);
}
