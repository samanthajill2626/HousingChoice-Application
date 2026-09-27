// The one-to-one retry PROMISE, as the screen judges it (retry-send-window D8,
// D10). A failed one-to-one message promises "will retry" only while it carries
// a live `retry_due_at` - the run time of the automatic retry the webhook
// scheduled, written in the same conditional write as the failure (D7) - never
// from the retry count. The Retry button is hidden while the promise is live.
// The manual Retry route refuses with 409 `retry_pending` over the same window
// on the server's clock (`isRetryPromiseLive` in app/src/lib/retrySendWindow.ts);
// the screen re-judges it on the Timeline's 60-second ticker, so the promise and
// the hidden button can outlast the server's guard by up to one tick - the bound
// spec section 1 states ("plus one ticker interval").

/**
 * MIRROR of RETRY_PROMISE_GRACE_MS in app/src/lib/retrySendWindow.ts - the
 * dashboard is a separate package and cannot import app code at runtime.
 * Pinned by retryPromiseMirror.test.ts. The grace covers a retry job that runs
 * a little late: a retry due at T still counts as scheduled until T + 2 minutes,
 * after which the promise drops and Retry returns.
 */
export const RETRY_PROMISE_GRACE_MS = 120_000;

/**
 * Is the promise live at `serverNowMs` - the SERVER's clock (`serverNowMs()` in
 * api/serverClock.ts), never the browser's? True while `serverNowMs` is before
 * `retry_due_at + RETRY_PROMISE_GRACE_MS`; false for an absent or unparseable
 * stamp, and for the epoch stamp an enqueue failure writes to withdraw a
 * promise (D7). The app's twin answers the same question the same way; the
 * mirror test runs one table through both.
 */
export function isRetryPromiseLive(retryDueAt: string | undefined, serverNowMs: number): boolean {
  if (retryDueAt === undefined) return false;
  const dueMs = Date.parse(retryDueAt);
  if (!Number.isFinite(dueMs)) return false;
  return serverNowMs < dueMs + RETRY_PROMISE_GRACE_MS;
}
