---
id: share-results-promise-refresh-not-emitted
title: A retry promise REFRESH emits no broadcast.updated, so the share results page recounts pending at the OLD due instant and reads a final failure while the thread still says "will retry"
type: bug
severity: low
status: open
area: dashboard/broadcasts
created: 2026-09-28
refs: app/src/services/retryPromiseWrites.ts:34, app/src/services/retryPromiseWrites.ts:44, dashboard/src/routes/broadcasts/BroadcastResults.tsx:172, dashboard/src/routes/broadcasts/useBroadcastResults.ts
---

**Found by.** The plan-blind adversarial code review of `feat/share-sent-outcome`
(round 1, ADV-6; `docs/superpowers/reviews/2026-09-27-share-sent-outcome/code-review/adversarial-r1.md`),
ACCEPTED in `r1-adjudications.md`. Anchors at the branch's fix wave 1.

**Problem.** Stage 1b's promise writers `refreshRetryPromise` and
`withdrawRetryPromise` emit only `message.persisted` for the retried row
(`app/src/services/retryPromiseWrites.ts:34-41`, `:44`). The retry job's
deferral and its unknown-outcome hand-off REFRESH the original row's
`retry_due_at` to a later instant. The share results page listens to
`broadcast.updated` only, so it keeps the row's OLD `retryDueAt`, and its
one-minute ticker recounts `retry_pending` from its own rows
(`dashboard/src/routes/broadcasts/BroadcastResults.tsx:172`): once the old
instant lapses, the row drops "will retry", shows the "open conversation to
retry" hint, and the pill turns "Not sent" - while the tenant's thread still
says "will retry" and the manual Retry route answers 409 `retry_pending`.

**Transient.** Any fetch reads the route's truth at once (Refresh, a reload,
the next event's refetch), and the retry's own receipt or the chain's end
corrects the row. Nothing is written wrong; only this page's copy is stale.

**Why accepted.** An emit from `retryPromiseWrites.ts` would touch 1b's
promise writer for a display transient (the branch's I7 fence).

**Directions (not taken).** Emit `broadcast.updated` for a promise write on a
share row (the row carries `broadcast_id`); or let the ticker skip rows whose
facts predate the newest `message.persisted` for the same thread.

**Related.** [share-list-sse-patch-rebucket-and-refresh](./share-list-sse-patch-rebucket-and-refresh.md)
(the list's twin class: an emit's stats omit a fact only the routes compute),
[share-retry-late-send-flag-window](./share-retry-late-send-flag-window.md).
