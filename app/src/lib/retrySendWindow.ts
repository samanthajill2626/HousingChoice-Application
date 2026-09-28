// retrySendWindow - the 15-minute send window for AUTOMATIC retries of a
// carrier-30003 failure (retry-send-window spec D1-D5, D10).
//
// Cameron's ruling on relay-30003 Q4: nothing re-sends a text more than 15
// minutes after the original went out. The window measures when a retry GOES
// OUT, not when the failure arrives. It limits the two machine-initiated
// resend paths only - the relay retry ladder and the one-to-one
// `messaging.retrySend` chain; a staff member's manual Retry is a new send.
//
// PURE: no clock and no I/O. Every caller passes `nowMs`, so tests inject the
// clock (D13) and the webhook, the jobs and the manual route all judge with
// the same arithmetic.

/** D1: how long after the original send an automatic retry may still go out. */
export const RETRY_SEND_WINDOW_MS = 15 * 60_000;

/**
 * D3/D3a: the scheduling margin. A retry is scheduled only if it would go out
 * with this much of the window to spare, absorbing queue delay; the job-time
 * check (D4) is then strict, because the grace was spent at scheduling.
 */
export const RETRY_JOB_GRACE_MS = 60_000;

/**
 * D8/D10: how long past its `retry_due_at` a one-to-one retry promise stays
 * live - on screen ("will retry") and in the manual Retry guard (409
 * `retry_pending`). Mirrored in the dashboard and pinned by a test (Task 14).
 */
export const RETRY_PROMISE_GRACE_MS = 2 * 60_000;

/** Written over retry_due_at when a promise must be withdrawn (D7 enqueue failure). */
export const RETRY_PROMISE_WITHDRAWN_AT = '1970-01-01T00:00:00.000Z';

/** Total send attempts for one logical message are capped at 1 + this (owned here since retry-send-adoption; jobs/retrySend.ts re-exports it). */
export const MAX_SEND_RETRY_ATTEMPTS = 3;
/** retry-send-adoption R5: the retried row's retry_outcome when the reconcile ruled the retry `unresolved`. The dashboard hand-copies it (routes/contact/retryPromise.ts) - pinned by retryPromiseMirror.test.ts. */
export const RETRY_OUTCOME_UNCONFIRMED = 'unconfirmed' as const;
export type RetryOutcome = typeof RETRY_OUTCOME_UNCONFIRMED;

/**
 * D3/D4/D8: the close code a WINDOW decline writes on a relay retry rung - the
 * relay claim (D3) or the relay job (D4) found the retry would go out more
 * than RETRY_SEND_WINDOW_MS after the member's original leg send. The ONE copy
 * in the app: the job's RelayRetryCloseCode and the claim's decline types
 * derive from it, and every write, compare and log site uses it. The
 * dashboard's hand copies (relayRetryJoin.ts WINDOW_CLOSED_CODE and the
 * INTERNAL_CODE_REASONS key in deliveryStatus.ts) are pinned to it by
 * dashboard/src/routes/contact/relayWindowCloseMirror.test.ts.
 */
export const RETRY_WINDOW_CLOSED_CODE = 'retry_window_closed' as const;

/** ms since epoch, or undefined when absent / not a string / unparseable (D5 fail-open).
 *  Accepts ISO 8601 and RFC 2822 (Date.parse). */
export function parseRetryWindowOrigin(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * D2, one-to-one: where a message's retry chain started - `retry_window_start`
 * on a retry row (the chain's FIRST send), else the row's own `provider_ts`.
 * The ONE copy of the rule, read by the 30003 decision and by the retry job.
 * Returns the RAW stored value: the job carries it onto the retry row as
 * retryWindowStart, and callers parse it with parseRetryWindowOrigin. `??` on
 * purpose: only an absent (undefined or null) `retry_window_start` falls
 * through - an empty or unparseable one does not, so the check fails open on
 * it (D5) rather than silently measuring from this row's own send. The
 * parameter is structural so this module stays import-free.
 */
export function oneToOneRetryWindowOrigin(message: {
  retry_window_start?: string;
  provider_ts?: string;
}): string | undefined {
  return message.retry_window_start ?? message.provider_ts;
}

/** Scheduling (D3, D3a): nowMs + backoffMs + RETRY_JOB_GRACE_MS <= originMs + RETRY_SEND_WINDOW_MS */
export function retryFitsSendWindow(args: {
  originMs: number;
  nowMs: number;
  backoffMs: number;
}): boolean {
  return args.nowMs + args.backoffMs + RETRY_JOB_GRACE_MS <= args.originMs + RETRY_SEND_WINDOW_MS;
}

/** Job time (D4), strict: nowMs <= originMs + RETRY_SEND_WINDOW_MS */
export function withinRetrySendWindow(args: { originMs: number; nowMs: number }): boolean {
  return args.nowMs <= args.originMs + RETRY_SEND_WINDOW_MS;
}

/** originMs + RETRY_SEND_WINDOW_MS (the bounded acquire's deadline, D4) */
export function retrySendDeadlineMs(originMs: number): number {
  return originMs + RETRY_SEND_WINDOW_MS;
}

/** Server-side promise liveness (D10 guard): nowMs < Date.parse(retryDueAt) + RETRY_PROMISE_GRACE_MS;
 *  false for undefined or unparseable. */
export function isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean {
  if (typeof retryDueAt !== 'string') return false;
  const dueMs = Date.parse(retryDueAt);
  if (!Number.isFinite(dueMs)) return false;
  return nowMs < dueMs + RETRY_PROMISE_GRACE_MS;
}
