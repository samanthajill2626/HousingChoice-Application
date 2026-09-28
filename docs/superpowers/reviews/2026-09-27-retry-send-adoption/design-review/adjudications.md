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

## Spec round 3 (2026-09-27) - reviewer B continued, spec revision 3 @687e53bd

Report: `spec-r3-reviewer-b.md` (7 findings: 1 high, 1 medium, 5 low; two
contests of round-2 rulings, both upheld).

| # | finding | ruling | change in revision 4 |
|---|---|---|---|
| 1 | CONTEST r2#6/r2#3 upheld: step 4 ran the manual check and the window check only when NO record existed, so a deferral re-run and a re-drive skipped both - a late re-run could send past the window (RSW #1) and past a manual retry | ACCEPT (HIGH) | Step 4: an existing attempt is resolved first (takeover / refuse / return); then EVERY run that may send (absent, `done/retryable`, `redriven`) passes both gates; a decline on `redriven` closes the record, on `done/retryable` writes nothing (idempotent), never holds a claim. |
| 2 | CONTEST r2#3/r2#4 upheld: R6 and 4a looked only at the pressed row; a press on an EARLIER row of the chain passes and double-sends against a pending later attempt; the "stale-tab" residual cannot occur; the real race lasts the whole manual send | ACCEPT (MEDIUM - a new route rule) | The route finds the chain's NEWEST row first (paged, bounded at the pressed row); a press on a row with a later attempt is 409 `superseded` (new dashboard copy); the record guard evaluates the newest row's records; the residual is restated as the manual send's duration. |
| 3 | the lineage exclusion treated same-root as predecessor; a manual-retry chain and the original chain would drop each other's protection | ACCEPT | Lineage = the `retry_of` ancestry of the retried row (at most 3 reads) - the attempts that PRODUCED those rows, plus the root's broadcast owner; same root alone is not lineage. |
| 4 | step 4a's scan had no paging or lower bound | ACCEPT | `listByConversationConsistent` paged with `before` until the page's oldest `tsMsgId` sorts before the retried row's (the ISO-leading key is the bound); R6's chain walk uses the same. |
| 5 | R6's `reconciling` bound (360 s) is shorter than the reconcile's own SQS redelivery budget | ACCEPT | One bound for every open state: `RETRY_SEND_WINDOW_MS` from `attemptedAt`. |
| 6 | the `phone#` key from the conversation is stable only by an unstated assumption; carrying it in the payload puts a phone in a queue payload; the reconcile's raw-key recovery unstated | ACCEPT | The key is derived the same way on every run and NOT carried (D12); the one-to-one thread's phone immutability is stated; the reconcile re-derives and checks the hash. |
| 7 | "one hop reaches the root" false for pre-deploy attempt-2/3 rows; Branch B's root keying dropped without a recorded ruling; "a lost fence leaves attempting" wrong; test 16's sentinel copy | ACCEPT | The root walk follows `retry_of` up to the cap; section 0 records why the record does not key on the root (Cameron told at the gate); a lost fence = taken over -> `reconciling`, repaired by the reconcile's `mine` path; test 16 pins the literal and the copy only. |

**Round 3 outcome:** 7 findings, ACCEPT 7, REJECT 0. Decisions changed: one
- the route's newest-row rule (409 `superseded`); the rest restore
invariants revision 3 had broken (RSW #1 on re-runs) or are precision.
Round 4 is the LAST the cap allows; it reviews revision 4's deltas. If it
still changes a decision the design goes to Cameron as a decision.

## Spec round 4 (2026-09-27) - reviewer B continued, spec revision 4 @8d072260 - FINAL round

Report: `spec-r4-reviewer-b.md` (5 findings: 2 medium, 3 low; one contest,
upheld).

| # | finding | ruling | change in revision 5 |
|---|---|---|---|
| 1 | CONTEST r3#3 upheld: the ancestry rule took the original chain's attempt against a manual row's PARENT as that manual row's producer, dropping the manual chain's same-fingerprint protection | ACCEPT | The walk follows `retry_of` only through AUTOMATIC rows (stops at a row without `retry_attempt` - the root or a manual row) and a producer must match on `attempt === retry_attempt`. |
| 2 | the route's `superseded` scan had no time bound (a press on an old bubble pages the whole thread since it); the forward newest-row walk was dead code | ACCEPT - a NEW SURFACE, put to Cameron at the gate | A `retrychild#<conversationId>#<parentTsMsgId>` pointer family written in the append transaction of every retry row (automatic, adopted, manual); step 4a and the route each become ONE consistent Query; "any child = superseded". The alternative (a bounded thread scan) was rejected as a guess at a bound. |
| 3 | after the named race the retried row has two children whose chains run independently for 15 minutes | ACCEPT as a NAMED residue | R6 names the fork; a third text needs a second race. |
| 4 | the adopted row recorded `recipient_contact_id` from the derived key even for a deleted or moved contact | ACCEPT | One contact read + `contactHoldsPhone` at adoption, as the broadcast adoption does. |
| 5 | precision: the unaddressable-record wording; test 15's false claim; lineage by the retried row's `broadcast_id`; the route tests live in `apiRoutes.test.ts` (fakes must gain the repos); test 16's copy has no app constant | ACCEPT | Each fixed. |

**Round 4 outcome:** 5 findings, ACCEPT 5, REJECT 0. Decision changed:
ONE - the `retrychild#` pointer family (finding 2), a new item family
written by every retry append. The cap is reached, so this one goes to
Cameron at the spec gate as a decision with my recommendation (adopt it:
the same shape as the `sid#` pointer, written in the same transaction,
O(1) for the job and the route, and the only way to answer "does this row
have a child?" without a thread scan). Review loop CLOSED at four rounds:
46 distinct findings over four rounds, 46 accepted, 0 rejected.

## Plan round 1 (2026-09-27, plan revision 1 @38526a44 -> revision 2)

Two independent opus reviewers, the PLAN brief (design-review-briefs.md) with the spec attached. Reports: `plan-r1-reviewer-a.md` (12 findings: 3 medium, 9 low), `plan-r1-reviewer-b.md` (16 findings: 5 medium, 11 low). Neither found a BLOCKING finding; both walked every spec decision to a task and found no spec decision undelivered in the production code the plan writes. Overlap: A2=B2, A3=B3, A4=B8b, A5=B8a, A6=B5, A8=B6, A9=B9, A10=B11, A11=B16, A12a=B10, A12d=B15, A12e=B14 -> 20 distinct findings. Severity is the reviewer's; the DECISION CHANGED column is the planner's.

| # | reviewer | severity | finding | adjudication | decision changed? |
|---|---|---|---|---|---|
| 1 | B1 | MEDIUM | T1 breaks typecheck: two full uncast `MessagesRepo` literals (`sendMessage.test.ts:256`, `scheduledSendSuppression.test.ts:273`) are not in T1's list | ACCEPT - both files added to T1's Files, run list and `git add`, each gaining the two trivial stubs | no (a surface) |
| 2 | A2 / B2 | MEDIUM | "unchanged assertions" is false: exact `toEqual` pins on the send input at `twilioStatusWebhook.test.ts:1706` (gains `retryRoot` + `beforeProviderSend`) and `apiRoutes.test.ts:614` (gains `retryRoot`) go red | ACCEPT - T4 re-pins `:1706` with `toMatchObject` + `retryRoot` + `typeof beforeProviderSend === 'function'` (and any other `expect(calls).toEqual` in the file); T5 names `:614` beside `:475` | no |
| 3 | A3 / B3 | MEDIUM | the rewritten DUPLICATE GUARD case asserts a `claim refused fresh:false` line the handler never emits: step 4's `gateFor` SKIPS a `done/sent` record before any claim | ACCEPT - the case (and 6a, 4-cap) assert the gate's skip line (`gate: 'skip'`) | no |
| 4 | B4 | MEDIUM | the CONCURRENT duplicate guard - the reason the marker can go - is untested: no case seeds a fresh `attempting` record (gate `defer`) or races the claim (`refused fresh: true`) | ACCEPT - T4 gains 6e (gate defer on a 5 s `attempting` record) and 6f (`get` spied absent so the claim itself refuses `fresh: true`); Review Focus 1 rewritten to cite 6a/6e/6f/9 | YES - two guarantees now pinned |
| 5 | A6 / B5 | MEDIUM (B) / LOW (A) | T2 test 12a contradicts T2's `resolve`: a CONTACT-keyed row with the phone removed resolves and closes `unresolved digest_mismatch` + WITHDRAW; only a PHONE-keyed row is unaddressable; the label "RF5" is wrong | ACCEPT - 12a split into 12a (contact-keyed: digest_mismatch + withdrawal, both sub-cases) and 12a2 (phone-keyed: resolve undefined, left for the sweeper); label removed | no (the code was right; the test was wrong) |
| 6 | A8 / B6 | LOW | `export { X } from ...` creates no local binding; `retrySend.ts:80-81` reads the moved constant -> TS2304 | ACCEPT - import it, then `export { MAX_SEND_RETRY_ATTEMPTS };` | no |
| 7 | B7 | LOW | T8's `pollRow` uses the unauthenticated `request` fixture on an authed route | ACCEPT - every app API call through `page.request`; `request` for the fake and the logtail only | no |
| 8 | A5 / B8a | LOW | T2 hard-codes `RETRY_CONV` but the fake mints `conv-<n>` | ACCEPT - `retryConv` is set by `seedOneToOne` from the minted conversation | no |
| 9 | A4 / B8b | LOW | the R9 test "every line with conversationId has retryRoot" cannot pass: the logger mixin puts `conversationId` on jobs.ts's own lines | ACCEPT - scoped to lines whose `msg` starts with `retrySend:` | no |
| 10 | B8c + A12b | LOW | `withdrawRetryPromise`'s 'already' case: with the CURRENT row the first conditional write matches the sentinel and re-writes + re-emits; the spec's re-apply must be a NO-OP | ACCEPT - `withdrawRetryPromise` short-circuits when the input row (or the fresh re-read) already holds both fields: 'already', no write, no emit; the test sketch states which snapshot each sub-case passes | YES - the re-apply is now the no-op R4 requires |
| 11 | A9 / B9 | LOW | deviation 6 not followed: `refuse`, the rejected arm and `deferOrEnd`'s four `finishAttempt` calls drop the fence answer; `deferOrEnd` refreshes and logs "re-scheduled" after a lost release | ACCEPT - a `finish()` helper captures every fence answer (INFO on a lost fence); `deferOrEnd` refreshes and logs only when the release WON; a new test 4-lost pins it | YES - a lost release no longer refreshes |
| 12 | A12a / B10 | LOW | undeclared deviation: spec item 15's "200 on a stale attempting (31 s)" vs R6's `RETRY_SEND_WINDOW_MS` bound; the plan follows R6 silently | ACCEPT - declared as deviation 8 | no (declared) |
| 13 | A10 / B11 | LOW | "enforced by the record, for good" is false under the record's 30-day TTL; the 45-day test passes only because the fake never reaps | ACCEPT - the test's name says the ROUTE's read has no bound of its own; T9 records the TTL residue in `send-attempt-sweeper` | no (spec-inherited residue, filed) |
| 14 | B12 | LOW | pre-gate declines (steps 1 and 3) on a re-driven job strand the `redriven` record (practically unreachable) | ACCEPT as a residue - T9's sweeper note names it; no code change (the spec names 4a/4b only) | no |
| 15 | B13 + A1 | LOW (B) / MEDIUM (A) | e2e commands: a bare `npx playwright` departs from the sanctioned form; `timeout 1500` is too short (SOR's green runs 23.2 / 23.7 min; three slow specs added) and has no orphan-stack recovery | ACCEPT - `npm run e2e -- <spec>` for a single spec; the gate is `timeout 1800 npm run e2e`; a fired timeout -> `e2e:stop` + prove the ports free before re-running (Global Constraints, T8, T9) | YES - the gate's budget |
| 16 | A12e / B14 | LOW | placeholders: the elided adoption touch block with an undeclared `touched`; `appendOutbound`/`T0`/`DUE_1`/`outboundRow`/`iso`/`originalSend` exist in no cited file; `vi` not imported in `twilioStatusWebhook.test.ts`; `toConversationUpdatedEvent` and `TRANSPORT_SCHEMA_VERSION` not imported in `sendReconcile.ts`; T4's helper closures untyped over `let` deps; test labels drift from the spec's 4b-4e | ACCEPT - the touch block written out; every helper defined file-locally in its sketch; the two imports named with their source modules; the helpers typed and bound over narrowed consts; T4's tests relabeled to the spec's numbering (4, 4-cap, 4-window, 4-redriven, 4-lost, 4b, 4c, 4d, 4e) and the Review Focus citations aligned | no |
| 17 | A12d / B15 | LOW | `conversationRetryDecline` invents `no_participant_phone` and folds `group_text` into `not_one_to_one` instead of the decision's vocabulary | ACCEPT - returns `conversation_missing` / `group_text` / `not_one_to_one` with the decision's own reading (`oneToOneRetryDecision.ts:90-97`: a relay group or a phone-less thread is `not_one_to_one`) | YES - the log vocabulary |
| 18 | A11 / B16 | LOW | T9's residual-windows note mislabels gap 5 (R6 says step 4a closes it, except the in-flight race) and understates the route's pre-deploy pointer gap (permanent, not 15 minutes) | ACCEPT - both notes corrected | no |
| 19 | A7 | LOW | test 4-cap's "sent 0" is vacuous: the throttle throws before the fake records, so a broken guard that re-called the provider still passes | ACCEPT - the case counts provider calls through a spy and pins `attemptNo` 1 after the redelivery | no |
| 20 | A12c (+ B's undeclared-deviation note) | LOW | the adoption does not call the shared media function; it reads `record.mediaCount` | ACCEPT AS DECLARED, not re-planned: the record carries the plan's own answer computed at claim time, and the reconcile has no media store to re-plan with; deviation 9 states it | no (declared) |

Round summary: 20 distinct findings, 20 accepted (0 rejected, 0 deferred). Decisions changed: five (the concurrent-guard tests; the WITHDRAW no-op re-apply; no refresh after a lost release; the 1800 s e2e budget; the decline vocabulary). Round 2 goes to the continued reviewer (B: 16 findings, the larger accepted set) with the RE-REVIEW CHARGE and reviewer A's report.

Both reviewers judged all seven declared deviations legitimate (deviation 7, `isBroadcastRowFor`, judged necessary and a CODE change the handback must state as such - now stated in the header). Both verified and holding: test 1 is red on main; the deferral's `delaySeconds` pin holds; the hop count along the longest path is exactly 10; the import cycle reads no binding at module load; no seed, importer, dev seam or fake-twilio path writes retry fields; the messages table has no GSI and no stream consumer; every writer of `retry_due_at` is enumerated; the Retry button has one renderer.
