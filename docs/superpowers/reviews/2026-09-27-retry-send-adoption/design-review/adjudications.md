# Design review adjudications - retry-send adoption (send-outcome Stage 1b)

Reviewers are blind to the planner's reasoning; every finding is a claim,
adjudicated ACCEPT (the spec changes) / REJECT (with the reason) / DEFER
(filed). Severity is the reviewer's; whether a DECISION changed is the
planner's call, made after adjudication.

## Spec round 1 (2026-09-27) - two reviewers, spec revision 1 @034912bb

Reports: `spec-r1-reviewer-a.md` (15 findings), `spec-r1-reviewer-b.md`
(18). Overlap is heavy; the table lists each distinct finding once with both
ids. Load-bearing claims about existing code were re-read by the planner
(retrySend.ts, sendReconcile.ts dispatch sites, twilio.ts:322/:3898,
retrySendWindow.ts:73-80, sendMessage.ts:107, the wontfix issue).

Cameron's Branch B refinement (received during the round) is folded into
the same revision: every retry row carries `broadcast_id` AND `retry_root`;
the attempt record keys on the chain root.

| ids | finding | ruling | change in revision 2 |
|---|---|---|---|
| A1 / B1 | "the ORIGINAL" names two rows: for attempts 2-3 the job retries the PREVIOUS retry row (the only bubble on screen, where the webhook wrote `retry_due_at`); R5/R6/R10 assume the chain root | ACCEPT (BLOCKING) | Two names, used consistently: the RETRIED ROW (`payload.providerSid`'s row - the promise, `retry_outcome`, `retry_of` point here) and the ROOT (`retry_root`, the chain's first send - the owner key and Branch B's routing point here). |
| A3 / B4 | keeping the run-once marker ahead of the claim disables the record's only crash recovery (a redelivery is suppressed before it can take over the stale claim; other rungs are other records) | ACCEPT (HIGH) | The marker is REMOVED from `retrySend`; the claim is the duplicate guard (fresh -> refused; stale -> takeover). Every read runs before the claim; a throw there fails the delivery and SQS redelivers - correct, nothing claimed. |
| B3 | withdrawing the promise on a successful retry removes RSW's 409 stale-tab guard at once and gains nothing (the collapse hides the retried row) | ACCEPT (HIGH) | No promise write on success; RSW's expiry stands. (Also keeps `twilioStatusWebhook.test.ts`'s `annotates === 0` pin - A14.) |
| A10 / B17 | the spec reverses Cameron's 2026-09-26 wontfix on `one-to-one-retry-promise-outlives-job-decline` without a ruling | ACCEPT | Withdrawals on refusal, rejection and window-close are DROPPED; RSW's 2-minute expiry is the accepted behavior. The promise is WITHDRAWN only by the new `unresolved` close (Cameron's Q1 ask) and REFRESHED on a deferral or a pending reconcile (RSW #3). |
| A2 / B2 | R6 reads the record but claims closures that need a claim; a scheduled job not yet run has no record; the gap numbers are wrong | ACCEPT (HIGH) | R6 = RSW's time guard (the scheduled-not-yet-run window) PLUS the record guard (running / pending / unresolved); gaps are named by their text and re-mapped in the issue note by the build. |
| A5 / B5 | the record guard has no staleness bound: a stranded record refuses Retry for 30 days with a false "scheduled" | ACCEPT (HIGH) | Bounded: `attempting` within the claim TTL, `reconciling` within the reconcile schedule + grace, `redriven` within the 15-minute window; `done/unresolved` (and `enqueue_failed` after a possible send) refuses for good - that IS the Q1 ruling; everything else lets Retry through. "No third state" reworded. |
| A7 / B6 | the recipient key is re-derived from mutable `contactHoldsPhone` at every read; R1's owner lacks the recipient field | ACCEPT (HIGH) | The owner carries `recipientKey`, captured ONCE at claim time; the reconcile ref carries its hash; the route finds the chain's records through the recipient INDEX (sender + digest of the participant phone), not by re-deriving the key. |
| B7 / A11 | "forward-only" annotate is not conditional; the terminal write can lose to a refresh; `annotateMessage` has no conditional form | ACCEPT (HIGH) | A conditional `annotateRetryPromise(conversationId, tsMsgId, patch, expect)` (child-field write, conditioned on the `retry_due_at` value read); write order stated per arm; a losing terminal write is retried once from a fresh read. |
| A4 | Q1's "no Retry" rests on a best-effort write; R6 ignores `done/unresolved`; the superseded-exit re-apply is not bound to this owner | ACCEPT (HIGH) | The RECORD is authoritative for the route (409 on `done/unresolved`); `retry_outcome` is display; `slotCloseOf` for this owner = the withdraw + `retry_outcome` annotate, re-applied by a redelivered check; `closeSlot` gains a `never` default. |
| B8 | the unconfirmed marking has no crash recovery; the second-unknown arm's write order unstated | ACCEPT | Order: close the record, then the annotate; the re-apply covers a lost annotate (above). |
| A6 / B9 | `markRedriven` before the window check strands `redriven`; `original_missing` / "closed" unreachable; a re-driven run's pre-claim declines never close the record | ACCEPT | Window check FIRST (`retryFitsSendWindow` with `backoffMs: 0`); refusal closes through `closeFromReconcile` while still `reconciling`; unreachable causes dropped; a re-driven job's window decline runs `closeRedriven(refused, retry_window_closed)` (SOR D8 rev 11). |
| A8 / B10 | `attemptNo >= 2` counts claims, not deferrals | ACCEPT | The re-enqueued payload carries `deferred: true`; the job reads it; a re-drive payload never carries it. |
| B11 | the chain's own predecessors (and an adopted share root) are same-fingerprint siblings, so a clean `never_sent` becomes `unresolved`; always, in the lane | ACCEPT | The lookup excludes the chain's own lineage from the sibling set: `retry_send` records with the same `retryRoot`, and the root send's own owner record (a broadcast owner with the root's `broadcast_id` and this recipient key). A predecessor's adoption happened before this attempt began (its 30003 scheduled it) and cannot hold this attempt's message. |
| A9 | only 8 of the reconcile's owner-dispatch sites are named; an unlisted one fails silently | ACCEPT | R4 lists all eleven sites by line at 3dbb5740 and requires exhaustive switches (`never` defaults). |
| A13 / B12 | `broadcast_id` on retry rows is not "as today": every transitioned receipt of a share-retry row now waits `STATUS_UNKNOWN_SID_RETRY_DELAY_MS` (2.5 s) and reads the broadcast twice; `isBroadcastRowFor` is an unlisted reader | ACCEPT as a STATED COST | Cameron's fence ruling stands: R7 names the cost (2.5 s + two reads per receipt of a retried share text, inside Twilio's 15 s webhook budget) and the reader; Branch B removes it when it teaches the rollup. |
| B13 / A3 | the claim's facts need reads the spec never places | ACCEPT | R2 lists every read (the retried row, the recipient, the conversation, the business number, the window origin) BEFORE the claim; their failure = the delivery fails and redelivers. |
| B14 | the enqueue-failure close records the wrong outcome; after a deferral the record is already done | ACCEPT | Deferral: enqueue FIRST, then `finishAttempt(retryable)`; an enqueue throw -> `finishAttempt(retryable)` + ERROR, nothing sent, RSW's promise expires. Unknown/accepted: `handToReconcile` FIRST, then enqueue; a throw -> `closeFromReconcile(unresolved, enqueue_failed)` + the withdraw/unconfirmed annotate (SOR's as-built shape). |
| B15 / A14 | `app/test/retrySend.test.ts` does not exist; 19 registrations would build the real repo; api-router deps, harness copies and `retry_unresolved` copy omitted | ACCEPT | Section 4 names the real suites (`twilioStatusWebhook.test.ts`, `retrySendBackoff.test.ts`, `retrySendWindow.test.ts`, `api.test.ts`), the deps threading, the harness copies, and the dashboard copy for 409 `retry_unresolved`. |
| B16 / A12 | the record-phase row cannot happen as written | ACCEPT | With no success withdrawal the record phase is `finishAttempt(sent)` alone; a throw there leaves the record `attempting` (WARN, sweeper), never a false `sent_unrecorded`. |
| B18 / A15 | citations and wording: `statusFor`, `retryFitsSendWindow`'s arguments, "RSW B4/B5", the kill switch is a REFUSAL (`SmsSendingDisabledError extends SendRefusedError`, sendMessage.ts:107), media count without a store, author mapping, "attempts 1..3", the mirror test's constant, "worker log" | ACCEPT | Fixed throughout; the RSW handoff doc is cited by path; the mirror test pins `RETRY_PROMISE_WITHDRAWN_AT` and `RETRY_WINDOW_CLOSED_CODE`. |
| A10 (part) | "SOR's Stage 2 list names the manual Retry route" is false | ACCEPT | Removed. |

**Round 1 outcome:** 33 raw / 22 distinct findings, ACCEPT 22 (one as a
stated cost), REJECT 0, DEFER 0. Decisions changed: the run-once marker is
removed; no promise write on success, refusal, rejection or window-close;
the owner keys on the chain root and carries the recipient key; the manual
Retry guard is time + record with bounds and treats the record as
authoritative; the chain's lineage is excluded from the sibling rule. Plus
Cameron's Branch B refinement (`retry_root`, `broadcast_id` on every retry
row incl. the manual route's). -> Round 2 with reviewer B continued (the
larger accepted set), handed reviewer A's report.
