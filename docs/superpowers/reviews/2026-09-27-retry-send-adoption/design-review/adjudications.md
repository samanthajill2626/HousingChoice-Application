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

## Spec round 2 (2026-09-27) - reviewer B continued, spec revision 2 @08a41dc7

Report: `spec-r2-reviewer-b.md` (12 findings: 1 blocking, 2 high, 4 medium,
5 low; five are contests of round-1 rulings, all upheld).

| # | finding | ruling | change in revision 3 |
|---|---|---|---|
| 1 | keying the record on the chain root makes a manual Retry's own 30003 chain reuse the earlier chain's records (30-day TTL): refused at INFO, silently dropped under a live promise | ACCEPT (BLOCKING) | The owner keys on the RETRIED ROW + attempt (`retry#<conversationId>#<retriedTsMsgId>#<attempt>`); `retryRoot` rides the owner as a fact. The webhook schedules attempt N against one specific failed row, so the pair is unique; a manual row that fails later is a new retried row. |
| 2 | CONTEST A7/B6 upheld: the recipient key is recomputed by the deferral re-run, the re-drive and a crash redelivery; a contact edit forks the chain | ACCEPT (HIGH) | The key derives from IMMUTABLE row data (`recipient_contact_id` on the retried row, else the conversation's participant phone), never from `contactHoldsPhone`; the payload carries `recipientKey` on every re-enqueue; a redelivery re-derives the same value. |
| 3 | CONTEST A2/B2 upheld: R6 still claimed closures with no record and no promise (a late job; an enqueue that threw after SQS accepted); the stale-tab gap misnamed | ACCEPT (HIGH) | The JOB declines before claiming when a manual retry row of the retried row already exists (R2 step 4a) - the job's half; the route's record guard is the other half; the residual races are named exactly (same-instant press vs claim; the stale tab; manual vs manual) and mapped by the build. |
| 4 | CONTEST A4/B8 upheld: the `retry_unresolved` refusal lasted 30 minutes (the index lookup's bound) and the route never read `retry_outcome` | ACCEPT | With the key on the retried row the route reads the records DIRECTLY by key (three `get`s, no index, no time bound) and reads the row's `retry_outcome` as a belt. |
| 5 | a chain that ends at a deferral leaves a claimable `done/retryable`; with the marker gone a redelivery restarts an ended chain | ACCEPT | A terminal deferral (cap or window) closes `done/refused` (cause `deferral_cap` / `retry_window_closed`) - non-claimable; only a re-scheduled deferral leaves `done/retryable`. |
| 6 | the window check before the claim means a crash redelivery in the last minutes never takes over an attempt that may have sent | ACCEPT | R2 step 4: an EXISTING record is resolved (takeover / refuse / proceed) before the window gates a NEW claim; RSW #6's "a decline never holds a claim" still holds for the new-claim case. |
| 7 | CONTEST B14 upheld: mapping `enqueue_failed` to withdraw+unconfirmed marks a never-sent re-drive "not confirmed"; R6's `enqueue_failed` test not computable | ACCEPT | Split: a never-sent re-drive's enqueue failure is `closeRedriven(enqueue_failed)` with NO promise write (Retry allowed); an enqueue failure after a possible send is `unresolved` cause `enqueue_failed` (SOR as built). `slotCloseOf` maps ONLY `unresolved`; R6 blocks on `done/unresolved` only. |
| 8 | the pre-claim conversation read has no rule for a missing / group / relay conversation or a missing phone | ACCEPT | A designed decline at WARN with the webhook decision's vocabulary (RSW D11), never a throw. |
| 9 | `{ retriedTsMsgId }` fails `parseContinuation`; the site list omits the parser, `slotCloseOf`, `afterClose` | ACCEPT (moot + fixed) | The owner carries `retriedTsMsgId`; no continuation; the site list is complete with line numbers and a `never`-default rule. |
| 10 | CONTEST A13/B12 upheld: the router is `twilio.ts:3529`, not `isBroadcastRowFor`; its effect on retry (and now manual) rows unstated | ACCEPT | R7 names the router; the build reads `isBroadcastRowFor` and states its effect in the handback. |
| 11 | CONTEST A15/B18 upheld: the media-count rule disagreed with the job on two paths | ACCEPT | The count is taken from the job's own media resolution, factored into one function the job, the facts and the adoption share. |
| 12 | smaller: Resolve needlessly read the root; legacy rows' root; a phantom competing writer; the second-unknown close method; the lineage match; `parseRetrySendPayload` stripping `deferred`; unnamed marker tests; `guardWrite` logs ERROR; mirror constants; no-origin; test 19's scope | ACCEPT | Each fixed: the root is a fact (no read); `retry_root ?? retry_of ?? tsMsgId`; the writer removed; `finishAttempt(unresolved)` from `attempting`; lineage by the sibling's `owner.retryRoot` / the root's broadcast owner; the parser carries `deferred` and `recipientKey`; tests 6a-6d; ERROR stated; the mirror pins the dashboard's sentinel copy; RSW D5 fail-open stated; test 19 scoped to the owner's `send_reconcile` ERROR. |

**Round 2 outcome:** 12 findings, ACCEPT 12 (5 as upheld contests of
round-1 rulings), REJECT 0. Decisions changed: the record key (root ->
retried row); the recipient key derivation (immutable row data, carried in
the payload); the job's manual-supersession check; existing-attempt
resolution before the window; terminal deferrals close `refused`; the
`enqueue_failed` split. -> Round 3 with reviewer B continued.
