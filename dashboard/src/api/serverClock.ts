// The SERVER's clock, estimated in the browser (retry-send-window spec D8).
//
// A one-to-one bubble promises "will retry" only while its `retry_due_at` plus
// RETRY_PROMISE_GRACE_MS lies ahead on the SERVER's clock - the clock that wrote
// the stamp, and the one the manual Retry route's 409 guard reads. Judged on the
// browser's clock instead, a browser running fast drops the promise early (and
// offers a Retry the server refuses) and one running slow keeps it up for as
// long as the skew. So every API response through `requestWithStatus`
// (client.ts) re-estimates the server's clock from its `Date` header, and the
// promise reads `serverNowMs()`.
//
// WHY THE HEADER IS FRESH. Every /api response is uncached end to end: the
// CloudFront behavior for /api/* runs the managed CachingDisabled policy
// (infra/modules/cloudfront/main.tf), the app sends no Cache-Control and no
// Last-Modified on API JSON, so a browser never serves one as heuristically
// fresh, and a revalidated 304 carries a new `Date` that replaces the stored
// one. The only `max-age` API routes (call recordings, MMS media) are element
// sources, never fetched through the API client, and the service worker
// (public/sw.js) intercepts no fetch.
//
// THE ERROR. The header has one-second resolution (the server drops the
// milliseconds) and is stamped before the response travels, so the estimate
// lags the true server clock by under a second plus the one-way trip - it never
// runs ahead. The promise shows at most that much longer, and the Retry button
// never returns before the server would accept the press.
//
// One estimate per page, as module state; `resetServerClockForTests` exists for
// test isolation only.

/** The latest (server - browser) clock offset, ms. Zero until a response is seen. */
let offsetMs = 0;

/**
 * Re-estimate the server's clock from one response's `Date` header, received at
 * `receivedAtMs` on the browser's clock (default: now). A missing or unparseable
 * header changes nothing - the previous estimate stands.
 */
export function noteServerDate(dateHeader: string | null, receivedAtMs: number = Date.now()): void {
  if (dateHeader === null) return;
  const serverMs = Date.parse(dateHeader);
  if (!Number.isFinite(serverMs) || !Number.isFinite(receivedAtMs)) return;
  offsetMs = serverMs - receivedAtMs;
}

/** The server's clock now: the browser clock plus the latest offset - the plain
 *  browser clock before any response has been seen. */
export function serverNowMs(): number {
  return Date.now() + offsetMs;
}

/** Test isolation only: forget every response seen so far. */
export function resetServerClockForTests(): void {
  offsetMs = 0;
}
