# Planner verdict - retry send window (feat/retry-send-window)

Date: 2026-09-26. Planner: this session (the feature-mission planner). Branch
`feat/retry-send-window`, worktree `W:\tmp\retry-send-window`. Code at
`711bf432`; this verdict is a docs-only commit on top of it.

## MERGE-READY @711bf432 - UNMERGED (Cameron merges)

`main` was merged in twice, per Cameron's ruling ("do another one if it moves"):
at `f49a2fe9` (share-skip-fix Branch A) and at `1db4b77e` (inbox-rows-timestamps,
no file overlap). The branch is 0 behind `main` @`8cdeda10`.

Post-merge ops owed: NONE (no infra, deploy, secret, flag, migration or
dependency change). Deploy note: reload every open dashboard tab after the
deploy - nothing forces a reload, and a tab loaded before it shows the old
"will retry" copy and, on a window-declined relay leg, the raw code.

Merge (PowerShell, from the shared main checkout):

```
cd "W:\AI Projects\Housing Choice\HC Application"; git merge --no-ff feat/retry-send-window
```

## Gates - the planner's own runs at 711bf432 (bare; logs under the gitignored `.superpowers/planner-gates/`)

- `npm run typecheck` -> EXIT=0
- `npm run smoke` -> EXIT=0, "smoke-dist: OK - 1430 import specifier(s) across 252 emitted file(s) resolve under plain Node."
- `npm test` -> EXIT=0: app 375 files, 7199 passed + 1 skipped; dashboard 203 / 3360; e2e unit 21 / 499; fake-twilio 34 / 245; fake-twilio-web 13 / 111; 0 `[dynamoAdmin]` lines
- `timeout 1500 npm run e2e` -> EXIT=0, "285 passed (20.9m)", 0 `[dynamoAdmin]`; lane stopped and its ports free afterwards
- gate 5 `npx eslint <touched files>` -> EXIT=1 with ONE error, pre-existing:
  `dashboard/src/routes/contact/Timeline.tsx:1577:7 react-hooks/set-state-in-effect`
  on `setNow(fresh);` - the same statement errors at `:1495` at the merge base
  (baseline in `build-review-adjudications.md`). The branch adds no lint error.

One earlier planner `npm test` run (at `56085389`) failed one file,
`app/test/tourRemindersApi.test.ts` (the earlier[] tie-break case): a fixture
race - two `Date.now()` reads meant to be identical - untouched by this branch;
it passed alone twice and in every later run. Filed:
`tour-reminders-earlier-tie-break-test-ms-race` (low).

## What shipped

Every spec decision (D1-D14, the section 1 invariant and its named exceptions,
the section 4 surfaces, the section 6 test intentions) is traced to code and
tests in `planner-review-conformance.md` (verdict: CONFORMS). In short: no
automatic 30003 retry - relay ladder or one-to-one chain - goes out more than 15
minutes after the original send; the relay claim decides at once (a declined
rung is appended already closed: "Not retried - ..." for a human action, the
plain "Phone unreachable (error 30003)" past the window); the one-to-one
webhook decides before it writes the failure and writes `retry_due_at` in the
same conditional write, so "will retry" appears with the failure and only when a
retry will be attempted; the manual Retry is hidden and refused (409
`retry_pending`, "A retry is already scheduled for this message.") while one is
pending; native group texts never promise; and the retry follows the original
send - its `automated` flag and its recipient (D14).

## Reviews and fixes

- Build (orchestrator): research, 5 slices, gates, a spec-conformance and a
  plan-blind adversarial review, one fix wave, a fresh re-review and a small
  wave 1b; live self-QA on a fresh lane (four scenarios, measured:
  `build-selfqa.md`).
- Planner (this verdict): its own gates; a spec-conformance reviewer
  (CONFORMS, 3 low notes); a plan-blind adversarial reviewer (1 medium, 5 low),
  continued twice with the re-review charge; the riskiest diffs read directly.
  Fixed by the planner, red first (`planner-review-adjudications.md`):
  - ADV-1 (medium): a retry judged the RECORDED recipient even after it no
    longer held the thread's number, so the consent gate could judge the wrong
    person on a staff Retry. Now `sendMessage` counts a named recipient only
    while it holds the number (`contactHoldsPhone`); the preview and the
    decision mirror it.
  - RR-2: Twilio never redelivers a 5xx status callback by default (retry
    policy `ct`), so the relay claim's new gate preview now fails OPEN rather
    than returning `claim_failed`; the older reliance on redelivery is filed.
  - Comment, log-text and drift-pin fixes (ADV-2, ADV-6, RR-1, RR2-1, RR2-2).

## Issues

- Closed: `group-text-30003-leg-retry-promise-unverified`.
- Filed on this branch: `manual-retry-double-send-residual-windows` (low),
  `one-to-one-retry-promise-outlives-job-decline` (low),
  `vitest-config-globalsetup-fail-soft-comment` (low),
  `tour-reminders-earlier-tie-break-test-ms-race` (low),
  `relay-retry-claim-assumes-5xx-redelivery` (MED - pre-existing, see below).
- Annotated: `quiet-hours-ungated-automated-paths` (item 3),
  `ai-mode-switch-gates-all-automation` (item 3 delivered for the 30003 retry),
  `relay-hub-message-delivery-status-never-terminal`,
  `optional-call-outcome-breaks-already-loaded-bundles`.

## Open for Cameron (none blocks the merge)

1. When the retry job refuses at send time because something changed during
   the 1-4 minute backoff (a STOP, the kill switch, manual mode on an automated
   original, a deleted contact, lost consent), the bubble keeps "will retry"
   and hides Retry until the promise expires (170 s measured). Accept, or have
   the job withdraw the promise on refusal (small, beyond the approved spec) -
   `one-to-one-retry-promise-outlives-job-decline`, group b.
2. `relay-retry-claim-assumes-5xx-redelivery` (med, predates this branch): a
   transient DynamoDB fault inside the relay 30003 claim loses that member's
   retry for good, because Twilio does not redeliver a 5xx by default. The fix
   is either a config change (an `rp=5xx` connection override on the Messaging
   Service's Delivery Status Callback URL - console / infrastructure, so only on
   your go) or code (retry the claim through the jobs queue).
3. Alarm watch item: late 30003s past the window are now one ERROR line each;
   ErrorLogs' 5-in-5-minutes threshold is unchanged by your ruling.

## Mission health

Two orchestrator deaths on account usage limits (the Fable limit at 00:09, the
Opus weekly limit at ~02:40), both recovered by a fresh orchestrator on the
ledger with no lost work; one planner-side orphaned e2e run (a stopped gate
script kept going on Windows) was tree-killed and its lane cleaned before any
edit. The final gates ran once, to completion, on the final commit.

## Relay for SOR

Cameron's standing instruction: one fenced, ASCII-only block with full W:\
paths, Branch A's items for SOR unchanged, plus this branch's hand-off - paste
it to the send-outcome-reconcile session verbatim.

````
RELAY FOR SOR (send-outcome-reconcile) - from the retry-send-window (RSW) planner, 2026-09-26

PATHS: every W:\tmp\send-outcome-reconcile\ path below resolves in SOR's own worktree after its ONE main sync, once RSW has merged; W:\tmp\share-skip-fix\ paths are Branch A's worktree.

ORDER (plan against it): RSW (feat/retry-send-window) merges first. Then SOR Stage 1. Then SOR Stage 1b, the retrySend adoption, in its own worktree (your revision 6 @b93ab376 records Cameron's 2026-09-25 refinement; the earlier relay said "together with Branch B"). Then share-skip-fix Branch B, whose stub is W:\tmp\share-skip-fix\docs\superpowers\specs\2026-09-25-share-sent-outcome-design.md. SOR syncs main ONCE, after RSW has merged, and plans each stage against the code that exists by then.

A. BRANCH A (share-skip-fix) ITEMS FOR SOR - carried forward unchanged, with RSW's notes:
1. SOR's adoption writes the message and audit rows a property send's send would have made, so it MUST read Branch A's created_via record on the broadcast row ('dashboard' = a person's send, absent = automated) to stamp the audit row's `automated` flag correctly.
   RSW NOTE (extension, not a conflict): since RSW, sendMessage also records `automated` (true or false) and, when a recipient was named, `recipient_contact_id` on the MESSAGE row itself (spec D14). An adopted row must carry both, consistent with created_via - the automatic 30003 retry reads them to decide how the retry is sent.
2. A's merge points are spec section 6 item 3 of W:\tmp\share-skip-fix\docs\superpowers\specs\2026-09-24-share-skip-fix-design.md: the derived stats buckets (skipped_other; StatChips sums via skippedTotal in W:\tmp\send-outcome-reconcile\dashboard\src\routes\broadcasts\broadcastFormat.ts - SOR's `unconfirmed` bucket joins that balance), the results-row reason gate `shareRecipientReason` in that same file, which the recipient badge calls for skipped AND failed rows over the share-skip map (SHARE_SKIP_REASONS beside INTERNAL_CODE_REASONS in W:\tmp\send-outcome-reconcile\dashboard\src\routes\contact\deliveryStatus.ts), the fan-out's fences / send call / finalize log in W:\tmp\send-outcome-reconcile\app\src\jobs\broadcastFanOut.ts (SOR restructures the recipient unit and rebuilds finalize), W:\tmp\send-outcome-reconcile\app\src\services\sendMessage.ts (A's I8 gates and `recipient` input; SOR's typed errors), and the seed broadcast fixtures.
   RSW NOTE: RSW also edits sendMessage.ts (new inputs retryAttempt / retryWindowStart; the append writes automated, recipient_contact_id, retry_of, retry_attempt, retry_window_start; the `automated` doc now means GATING, not origin) and deliveryStatus.ts (INTERNAL_CODE_REASONS gains retry_window_closed: "Not retried - message too old"; deliveryReason gains the retryScheduled option). RSW did not touch broadcastFanOut.ts, broadcastsRepo.ts, StatChips.tsx or shareRecipientReason's code.
3. Any NEW app code on a FAILED share slot - SOR's `send_unconfirmed` above all - needs its own arm in `shareRecipientReason`, or it falls through to `deliveryReason`, whose internal map holds a whole-group sentence for `contact_opted_out`.
   RSW NOTE: RSW added no share-slot code; a failed share 30003 still falls through to deliveryReason WITHOUT retryScheduled, so it reads the plain "Phone unreachable (error 30003)" (under-promising) until Branch B reads retry_due_at there.
4. SOR files the "broadcast 30003 retries never update the broadcast slot" issue itself - it is Branch B's to fix, not A's (SOR's section 9 said A "may land" it; A did not). Unchanged by RSW.
5. A's lean-seed tenant contact-tenant-0002 / conv-0002 is switched OFF on purpose; SOR's e2e must not use him as a recipient of anything automated. RSW's own e2e uses conv-0001 (Tasha) and complies.
No item of A's conflicts with what RSW built.

B. RSW HAND-OFF

B1. SECTION 5 REQUIREMENTS (W:\tmp\send-outcome-reconcile\docs\superpowers\specs\2026-09-24-retry-send-window-design.md section 5; SOR Stage 1 carries 1 and 6 for the relay rung, plus 5 and 7; Stage 1b carries 1 and 6 for the one-to-one retry, plus 2, 3, 4 and the joint gap):
 1. Any retry SOR re-drives later runs the same job handler, so the job-time window check bounds it: relayRetryLeg's window gate (the LAST gate, after the opt-out gate) and retrySend's strict check after its execution marker.
 2. (Stage 1b) Any path that appends a one-to-one retry row (the adoption) carries retry_of, retry_attempt, retry_window_start, automated and recipient_contact_id AT APPEND - for a share, consistent with created_via. There is NO annotate-after path for lineage any more (MessageAnnotations.retryOf / retryAttempt were removed); the origin rule is oneToOneRetryWindowOrigin in W:\tmp\send-outcome-reconcile\app\src\lib\retrySendWindow.ts.
 3. (Stage 1b) Any path that DEFERS a one-to-one retry, or leaves its outcome pending past retry_due_at (a deferral, or an `unknown` send outcome awaiting reconcile checks), applies the window to every re-schedule (retryFitsSendWindow) and keeps the promise and the manual-Retry guard up until the retry resolves, by refreshing retry_due_at to cover the pending schedule and emitting message.persisted after each refresh. Otherwise the Retry button returns while an automatic text may already be out.
 4. (Stage 1b) SOR's filed issue that an unresolved one-to-one retry "leaves the original's 'will retry' copy standing" changes: the copy now follows retry_due_at (never the retry count), so requirement 3 is what keeps it truthful.
 5. (Stage 1) The relay retry rung's token-bucket wait is BOUNDED by its send window: sendOneRelayLeg(args.sendDeadlineMs) acquires with a timeout and returns { kind: 'deadline_exceeded' } (the last member of RelayLegSendOutcome.kind in W:\tmp\send-outcome-reconcile\app\src\jobs\relayFanOut.ts) BEFORE any `attempted` write; the job closes the rung retry_window_closed through refuseGate. Whatever phase model SOR gives sendOneRelayLeg, a deadline timeout is TERMINAL for a relay retry rung - never a `retryable` deferral, which would re-open a send past the window. The fan-out passes no deadline. Re-run the relay job tests after the merge.
 6. SOR's D8 close gate (every close by a writer other than the recipient's own attempt first reads the attempt record, strongly consistently, and closes only if it is absent or done / retryable) covers RSW's job-time window closes: the window gate and the bounded-acquire timeout in W:\tmp\send-outcome-reconcile\app\src\jobs\relayRetryLeg.ts. RSW's window checks run BEFORE SOR's claim (in retrySend too), so a decline never holds a claim. A CLAIM-TIME decline is not a close: the webhook claim APPENDS the declined rung already closed (gate code or retry_window_closed) in its one append and never enqueues it, so no attempt record can exist for it; closeRetryLegEnqueueFailed is unchanged and remains the claim's only close.
 7. Both branches edit the relay join's terminal step (W:\tmp\send-outcome-reconcile\dashboard\src\routes\contact\relayRetryJoin.ts): SOR's `send_unconfirmed` case ("Not confirmed", not a failure) and RSW's retry_window_closed case (no display code, so the original 30003 stands; now the exported WINDOW_CLOSED_CODE, pinned to the app constant by relayWindowCloseMirror.test.ts) must both survive, each with its test.
 JOINT GAP (Stage 1b, recorded as gap 4 of W:\tmp\send-outcome-reconcile\docs\issues\manual-retry-double-send-residual-windows.md): a one-to-one retry SOR rules `unresolved` leaves the original visibly undelivered with Retry live after RSW's guard expired, although the retry's text may be out. Gap 5 there (an enqueue that throws after SQS accepted the job) is new and SOR-relevant: the claim-based fix in that issue's "Suggested fix" closes gaps 1, 2 and 5 alike.

B2. THE RETRY WINDOW - FINAL SEMANTICS
- No automatic 30003 retry (relay ladder or one-to-one retrySend chain) is SENT more than 15 minutes after the ORIGINAL send. Checked at scheduling (now + backoff + 60 s grace must fit) and again at send time (strict).
- Origins: one-to-one = the original's provider_ts, carried on every automatic retry row as retry_window_start; relay = the member's ORIGINAL leg send (the root slot's sentAt), carried on every rung as relay_retry_window_start. A missing or unparseable origin fails open (WARN, no window).
- The relay claim decides at once: a job gate that would refuse (group closed, member removed, number changed, opted out) -> rung appended closed with that code, outcome gate_refused (WARN), the leg reads "Not retried - ..." at once; past the window -> rung appended closed retry_window_closed, outcome window_closed (ERROR), the leg reads "Phone unreachable (error 30003)".
- The relay claim's gate preview FAILS OPEN on a read error (the rung is claimed open with a WARN; the job re-runs every gate at send time): Twilio's default webhook retry policy (`ct`) never redelivers a 5xx status callback, so a 5xx would lose the ladder.
- The one-to-one webhook decides BEFORE the status write and writes retry_due_at (= the retry's run time) in the SAME conditional updateDeliveryStatus write as the failure; a failed enqueue re-writes it to RETRY_PROMISE_WITHDRAWN_AT ('1970-01-01T00:00:00.000Z'). A failed read fails OPEN (the retry is attempted and promised).
- Constants in W:\tmp\send-outcome-reconcile\app\src\lib\retrySendWindow.ts: RETRY_SEND_WINDOW_MS 15 min, RETRY_JOB_GRACE_MS 60 s, RETRY_PROMISE_GRACE_MS 2 min, RETRY_PROMISE_WITHDRAWN_AT, RETRY_WINDOW_CLOSED_CODE; helpers parseRetryWindowOrigin, retryFitsSendWindow, withinRetrySendWindow, retrySendDeadlineMs, isRetryPromiseLive, oneToOneRetryWindowOrigin.

B3. FIELDS RSW WRITES (exact names; all on message rows)
- retry_due_at - on the FAILED one-to-one original, with the failure (see B2). Read by the manual Retry route (409 { error: 'retry_pending' } while retry_due_at + 2 min is ahead on the server clock) and, via the contact-timeline projection, by the dashboard.
- retry_window_start - on one-to-one AUTOMATIC retry rows (never on a manual Retry row).
- relay_retry_window_start - on relay retry rows (rungs); optional in the job's lineage check.
- automated - on EVERY one-to-one row sendMessage appends (false is written; absent = a pre-deploy row, treated as automated).
- recipient_contact_id - on one-to-one rows appended with a named recipient (share fan-out, retry job, manual Retry).
- retry_of and retry_attempt - now written AT APPEND by the retry job (no annotate-after).
- New values: close code retry_window_closed; claim outcome window_closed (RelayRetryClaimOutcome, 14 values); gate_refused now produced at claim time (WARN); already_claimed also answers a duplicate for a rung appended CLOSED.

B4. WHAT THE AUTOMATIC RETRY DOES WITH THE ORIGINAL SEND'S `automated` AND `recipient` (spec D14 - SOR's adoption stamps `automated` from the same record)
- The one-to-one 30003 retry is sent with the ORIGINAL row's `automated` value (absent -> true) and, when the original recorded recipient_contact_id, with that contact as sendMessage's `recipient` (read by id; a contact that no longer exists falls back to the phone lookup with a WARN). A person's send is retried as a person's send: manual mode and the breaker do not apply, the JIT consent gate does. An automated original is retried automated and breaker-metered. Each retry row records the flags it was sent with.
- sendMessage counts a named recipient ONLY while it still holds the thread's number (contactHoldsPhone in W:\tmp\send-outcome-reconcile\app\src\repos\contactsRepo.ts - primary or secondary phone): otherwise it ignores the recipient for every gate, judges the phone-matched contact (the person the text reaches), records no recipient_contact_id and WARNs. previewSendRefusal (now with a required participantPhone) and the 30003 decision mirror it. An adopted row should likewise record recipient_contact_id only for a recipient that held the number.
- The manual Retry route also passes the recorded recipient and stays automated: false.
- `automated` now means how a send is GATED, not who initiated it: the message_sent audit row cannot tell an automatic retry of a staff text from a staff Retry; the message row can, by retry_attempt (automatic retries only).
- The 30003 decision (W:\tmp\send-outcome-reconcile\app\src\services\oneToOneRetryDecision.ts) previews the send path's refusals for exactly those inputs through previewSendRefusal (W:\tmp\send-outcome-reconcile\app\src\services\sendRefusalPreview.ts), pinned to sendMessage by a parity test over one shared table (W:\tmp\send-outcome-reconcile\app\test\helpers\sendRefusalCases.ts). A NEW gate SOR adds to sendMessage needs a new row there, or the promise and the send path drift.

B5. THE 30003 COPY RULE AND WHERE IT LIVES
- A 30003 promises a retry ONLY while the failed message carries a live retry_due_at (never from the retry count). deliveryReason(code, { retryScheduled }) in W:\tmp\send-outcome-reconcile\dashboard\src\routes\contact\deliveryStatus.ts: with retryScheduled and no `relay`, "Phone unreachable - will retry (error 30003)"; otherwise "Phone unreachable (error 30003)". `relay` wins over retryScheduled. The one-to-one chip passes retryScheduled = isRetryPromiseLive(retry_due_at, serverNowMs()) (W:\tmp\send-outcome-reconcile\dashboard\src\routes\contact\retryPromise.ts, W:\tmp\send-outcome-reconcile\dashboard\src\api\serverClock.ts) and hides Retry while it is live.
- A relay leg's "Retrying" follows its live rung (the join), not this rule.
- Any NEW failed-slot state SOR shows on a one-to-one bubble must not re-promise from anything but retry_due_at.

B6. THE LANE SEAM - REUSE, DO NOT REBUILD
- E2E_SEND_RETRY_BACKOFF_MS = '10000', set in W:\tmp\send-outcome-reconcile\scripts\e2e-session.mjs childEnv beside E2E_RELAY_RETRY_BACKOFF_MS; read only by resolveSendRetryBackoffMs(attempt) in W:\tmp\send-outcome-reconcile\app\src\jobs\retrySend.ts, honored only when JOBS_QUEUE_URL is unset and the value is a positive integer. enqueueSendRetry now takes (payload, runAt). A running lane must be booted FRESH to pick up childEnv changes (e2e:restart keeps the launcher's old env).

B7. FILES RSW CHANGED THAT SOR WILL MEET (paths resolve in SOR's worktree after its one sync)
- W:\tmp\send-outcome-reconcile\app\src\jobs\relayRetryLeg.ts (gates via the shared evaluator W:\tmp\send-outcome-reconcile\app\src\lib\relayRetryGates.ts; window gate; transient re-check; deadline_exceeded handling; RelayRetryCloseCode gains retry_window_closed)
- W:\tmp\send-outcome-reconcile\app\src\jobs\relayFanOut.ts (sendOneRelayLeg: sendDeadlineMs, bounded acquire, deadline_exceeded)
- W:\tmp\send-outcome-reconcile\app\src\jobs\retrySend.ts (window, lineage at append, D14 flags, resolveSendRetryBackoffMs, enqueueSendRetry(payload, runAt))
- W:\tmp\send-outcome-reconcile\app\src\services\sendMessage.ts (see A2 note; plus the held-recipient rule in B4)
- W:\tmp\send-outcome-reconcile\app\src\services\sendRefusalPreview.ts and W:\tmp\send-outcome-reconcile\app\src\services\oneToOneRetryDecision.ts (new; a new sendMessage gate needs a row in W:\tmp\send-outcome-reconcile\app\test\helpers\sendRefusalCases.ts)
- W:\tmp\send-outcome-reconcile\app\src\repos\contactsRepo.ts (contactHoldsPhone)
- W:\tmp\send-outcome-reconcile\app\src\repos\messagesRepo.ts (NewMessage / MessageItem fields; updateDeliveryStatus options.retryDueAt; MessageAnnotations.retryDueAt; retryOf/retryAttempt REMOVED from MessageAnnotations)
- W:\tmp\send-outcome-reconcile\app\src\routes\webhooks\twilio.ts (SOR fences it off, but it holds the claim decision and the one-to-one 30003 decision)
- W:\tmp\send-outcome-reconcile\app\src\routes\api.ts (manual Retry 409 + recipient)
- W:\tmp\send-outcome-reconcile\dashboard\src\routes\contact\deliveryStatus.ts, relayRetryJoin.ts, Timeline.tsx
- W:\tmp\send-outcome-reconcile\app\test\helpers\twilioWebhookHarness.ts (fake append / updateDeliveryStatus / annotateMessage carry the new fields - keep them in step)

B8. DEFERRED / OPEN THAT SOR MAY MEET
- W:\tmp\send-outcome-reconcile\docs\issues\one-to-one-retry-promise-outlives-job-decline.md: when the retry job gives up at send time (a refusal whose cause arose during the backoff - a STOP, the kill switch, manual mode on an automated original, a deleted contact, lost consent), "will retry" and the hidden Retry last until retry_due_at + 2 min (170 s measured). Open for Cameron; if SOR's attempt record changes the job's exits, keep this in view.
- W:\tmp\send-outcome-reconcile\docs\issues\manual-retry-double-send-residual-windows.md gaps 3-5 (SOR-relevant, above).
- W:\tmp\send-outcome-reconcile\docs\issues\relay-retry-claim-assumes-5xx-redelivery.md (med, found in RSW's review): Twilio does NOT redeliver a 5xx status callback by default (retry policy `ct`), so the relay claim's older `claim_failed` path (its consistent re-read, roster read and append) loses a retry for good. Do not build anything in Stage 1 that counts on webhook redelivery after a 5xx.
- Alarm watch item (not SOR's): late 30003s past the window are now one ERROR line each (ErrorLogs 5-in-5-minutes threshold unchanged by Cameron's ruling).
````
