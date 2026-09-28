---
id: retry-promise-write-replay-skips-rerender
title: A replayed one-to-one retry promise write loses its dashboard re-render - annotateRetryPromise has no op token, so an SDK replay of a committed WITHDRAW or REFRESH emits no message.persisted
type: bug
severity: low
status: open
area: app
created: 2026-09-28
refs: app/src/repos/messagesRepo.ts:3388, app/src/repos/messagesRepo.ts:3413, app/src/services/retryPromiseWrites.ts:57, app/src/services/retryPromiseWrites.ts:93, app/src/services/retryPromiseWrites.ts:101, app/src/jobs/retrySend.ts:747, app/src/jobs/retrySend.ts:786, app/src/jobs/retrySend.ts:796, app/src/jobs/retrySend.ts:844, app/src/jobs/sendReconcile.ts:1328, app/src/jobs/sendReconcile.ts:1422, app/src/jobs/sendReconcile.ts:1637, app/src/repos/sendAttemptsRepo.ts:490
---

**Problem.** Found by code review round 2 of `feat/retry-send-adoption`
(R2-1, LOW, CONFIRMED by two throwaway probes; R2-4 folded in) and filed by
that round's adjudication instead of a second fix wave
(`docs/superpowers/reviews/2026-09-27-retry-send-adoption/code-review/r2-review.md`,
`r2-adjudications.md`). Anchors at `5a03e20b` on that branch (UNMERGED).

The one-to-one retry's promise on the retried row moves only through
`messagesRepo.annotateRetryPromise`
(`app/src/repos/messagesRepo.ts:3388-3426`), a plain conditional UpdateItem
on `retry_due_at` with no op token: a condition failure answers `false`
(`:3413`). The AWS SDK retries an UpdateItem whose response was lost; when
the first try had committed, the replay fails its own condition. The
send-attempt record guards against exactly this with its `last_op` token
(`app/src/repos/sendAttemptsRepo.ts:19-29`, `:490-519`); the promise write
does not. Neither helper then emits `message.persisted`:

- the WITHDRAW's retry-once re-reads the row, finds the sentinel and the
  outcome this very call wrote, and answers `'already'` with no emit
  (`app/src/services/retryPromiseWrites.ts:93`);
- a REFRESH whose condition failed is "dropped" at INFO with no emit
  (`:57-59`), although its own value landed.

In the reconcile the unresolved close emits anyway (`afterClose`,
`app/src/jobs/sendReconcile.ts:1422`). The JOB's two unresolved closes have
no such emit (`app/src/jobs/retrySend.ts:786`, `:844`), nor do the job's
REFRESHes (the deferral `:747`, the unknown hand-off `:796-801`) or the
reconcile's re-drive REFRESH (`sendReconcile.ts:1637-1642`). What an OPEN
dashboard shows until its next refetch:

- after a replayed WITHDRAW: "will retry" until the old promise lapses on
  the client ticker, then the plain 30003 failure WITH Retry - instead of
  "retry not confirmed" and no Retry; a press answers 409
  `retry_unresolved` (the right sentence);
- after a replayed REFRESH: the older promise; once it lapses the bubble
  offers Retry while the server's refreshed promise answers 409
  `retry_pending`, for about 2 minutes (until the reconcile's close or the
  deferred run emits) - round 1 A-4's flicker without a crash.

Server state and the manual Retry route stay correct: the attempt record
decides. It needs an SDK replay of a committed write, hence low.

**Also (R2-4).** Since round 1 C-2 the reconcile FAILS the check when the
WITHDRAW answers `'failed'` or `'lost'` (`sendReconcile.ts:1329-1331`), but
the helper's ERROR still reads "failure-arm write failed (best-effort); the
attempt record decides" (`retryPromiseWrites.ts:101-104`), and the reconcile
passes only the owner's ids as its context (`sendReconcile.ts:1328`), so the
line carries no `event: 'send_reconcile'`, `recipientKey` or `checkNo` (spec
R9's set) and a filter on the reconcile's event misses it.

**Suggested fix.** Emit `message.persisted` for the retried row on every
exit of both helpers - the event carries ids only and the client refetches
the stored value, so an extra emit can never show a wrong state - or give
the promise write an op token (the `last_op` pattern). Narrower: emit on the
fresh-read `'already'` branch and have the job's two unresolved closes emit
as `afterClose` does. And pass the caller's log base into the helpers (the
check's `base` at `sendReconcile.ts:1328`), with a reconcile-side message
that does not say best-effort.

**Related.** [send-attempt-sweeper](./send-attempt-sweeper.md) (its
2026-09-28 note: the retry owner's strands),
[send-reconcile-job-residues](./send-reconcile-job-residues.md) (item 15:
the non-record conditional writes and the SDK's replay),
[retry-send-lost-under-job-marker](./retry-send-lost-under-job-marker.md).
