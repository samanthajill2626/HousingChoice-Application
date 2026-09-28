// retry-send-adoption R3: the two writes of the one-to-one retry PROMISE on the
// RETRIED ROW, the only way the retry job and the reconcile move it. Both go
// through messagesRepo.annotateRetryPromise, conditioned on `retry_due_at`
// still holding the value the caller read, so a writer holding a stale read
// loses:
//
// - REFRESH moves the promise to a new run time (a deferral, an unknown
//   hand-off, a takeover, a re-drive). A lost condition means a newer promise
//   stands: dropped, at INFO.
// - WITHDRAW (Cameron's Q1 ruling, the `unresolved` close) writes the sentinel
//   AND retry_outcome 'unconfirmed' in ONE write - "retry not confirmed", no
//   promise, no Retry. A lost condition is retried ONCE from a fresh consistent
//   read; a row that already holds both is a no-op (the superseded exit's
//   re-apply, R4). "Withdrawn" keys on the OUTCOME, never on the sentinel
//   alone: RSW's enqueue-failure withdrawal writes the sentinel with no outcome
//   and must keep offering Retry.
//
// Neither throws: they run in failure arms, where a throw is the anchor bug's
// shape; a failed write is ONE ERROR (guardWrite's line) and the attempt
// record decides. A written promise emits message.persisted for the retried
// row so the dashboards re-render it. Callers pass `ctx` (conversationId,
// retryRoot, retriedTsMsgId, attempt, ...) - never a phone or a body (R9).
import type { EventBus } from '../lib/events.js';
import type { Logger } from '../lib/logger.js';
import { RETRY_OUTCOME_UNCONFIRMED, RETRY_PROMISE_WITHDRAWN_AT } from '../lib/retrySendWindow.js';
import type { MessageItem, MessagesRepo } from '../repos/messagesRepo.js';

export interface RetryPromiseDeps {
  messages: Pick<MessagesRepo, 'annotateRetryPromise' | 'getByTsMsgIdConsistent'>;
  events: EventBus;
  log: Logger;
}

function emitPersisted(deps: RetryPromiseDeps, row: MessageItem): void {
  deps.events.emit('message.persisted', {
    conversationId: row.conversationId,
    tsMsgId: row.tsMsgId,
    direction: row.direction,
    deliveryStatus: row.delivery_status,
  });
}

/** R3 REFRESH: one conditional write against the value `row` was read with. Lost -> dropped (the newer value stands, INFO). A throw is a failure-arm write failure: ERROR, false. */
export async function refreshRetryPromise(
  deps: RetryPromiseDeps,
  row: MessageItem,
  retryDueAt: string,
  ctx: Record<string, unknown>,
): Promise<boolean> {
  try {
    const won = await deps.messages.annotateRetryPromise(
      row.conversationId,
      row.tsMsgId,
      { retryDueAt },
      { retryDueAt: row.retry_due_at },
    );
    if (!won) {
      deps.log.info({ ...ctx, retryDueAt }, 'retry promise refresh dropped - a newer promise stands');
      return false;
    }
    emitPersisted(deps, { ...row, retry_due_at: retryDueAt });
    return true;
  } catch (err) {
    deps.log.error(
      { err, ...ctx, retryDueAt, label: 'refreshRetryPromise' },
      'failure-arm write failed (best-effort); the attempt record decides',
    );
    return false;
  }
}

const isWithdrawn = (row: Pick<MessageItem, 'retry_due_at' | 'retry_outcome'>): boolean =>
  row.retry_due_at === RETRY_PROMISE_WITHDRAWN_AT && row.retry_outcome === RETRY_OUTCOME_UNCONFIRMED;

/** R3 WITHDRAW (the Q1 ruling): retry_due_at = the sentinel AND retry_outcome = unconfirmed in ONE write, conditioned on the value read; a lost condition is retried ONCE from a fresh consistent read. A row that already holds both (the superseded exit's re-apply, R4) is a NO-OP: 'already', no write, no emit. */
export async function withdrawRetryPromise(
  deps: RetryPromiseDeps,
  row: MessageItem,
  ctx: Record<string, unknown>,
): Promise<'written' | 'already' | 'lost' | 'failed'> {
  const patch = { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT, retryOutcome: RETRY_OUTCOME_UNCONFIRMED };
  try {
    if (isWithdrawn(row)) return 'already';
    if (await deps.messages.annotateRetryPromise(row.conversationId, row.tsMsgId, patch, { retryDueAt: row.retry_due_at })) {
      emitPersisted(deps, row);
      return 'written';
    }
    const fresh = await deps.messages.getByTsMsgIdConsistent(row.conversationId, row.tsMsgId);
    if (fresh === undefined) {
      deps.log.error({ ...ctx }, 'retry promise withdrawal failed - the retried row is missing');
      return 'failed';
    }
    if (isWithdrawn(fresh)) return 'already';
    if (await deps.messages.annotateRetryPromise(row.conversationId, row.tsMsgId, patch, { retryDueAt: fresh.retry_due_at })) {
      emitPersisted(deps, fresh);
      return 'written';
    }
    deps.log.error({ ...ctx }, 'retry promise withdrawal lost twice - a concurrent writer keeps moving the promise');
    return 'lost';
  } catch (err) {
    deps.log.error(
      { err, ...ctx, label: 'withdrawRetryPromise' },
      'failure-arm write failed (best-effort); the attempt record decides',
    );
    return 'failed';
  }
}
