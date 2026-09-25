# Spec review round 1 - adjudications

Planner adjudication of `spec-review-r1-a.md` (11 findings) and
`spec-review-r1-b.md` (13 findings) against spec DRAFT 1 @`a6c4c01b`. The two
reviewers worked independently and converged on the five highest findings.
Load-bearing claims about existing code were re-verified before acceptance:
`app/src/services/sendMessage.ts:348-349` (manual mode refuses every automated
send), `app/src/lib/import/apply.ts:1093`, `:1107` (the import writes
`ai_mode = manual`), `dashboard/src/routes/contact/deliveryStatus.ts:931-934` (the
"Not retried - ..." copy family), the share-skip-fix spec at its current HEAD
`3a6a1a06` (v5), `app/src/services/scheduledSendSuppression.ts:36-68` (the
automated-send suppression preview) and `app/src/lib/relayRetryClaim.ts:33-35`
(the deterministic rung SID).

Result: all 24 findings ACCEPTED (0 REJECT, 0 DEFER); where the reviewers
offered alternative remedies, the one chosen is stated, and for A5/B-F5 the
remedy is to remove the undeliverable guarantee rather than build it. Several
change DECISIONS (marked), so a round 2 follows.

| finding | verdict | decision changed? | disposition |
| --- | --- | --- | --- |
| A1 / B-F2 share-skip-fix coupling misstated (HIGH) | ACCEPT | yes | Section 5 rewritten against share-skip-fix v5: same `retrySend` send call and retry route (it makes both carry the share), a copy conflict on the share results row, and the one-to-one backoff seam. One rule for 30003 copy across both specs: "will retry" only while a retry is SCHEDULED (`retry_due_at`), never from the retry COUNT - after this branch a window- or switch-declined 30003 has retries remaining by count but none scheduled. The share row stays share-skip-fix's surface. Its "retries remaining" derivation is replaced by the scheduled signal, whichever branch lands second. Section 2's broadcast wording corrected: a broadcast recipient's 30003 IS retried today; the badge never learns the outcome. |
| A4 / B-F1 manual-mode threads (HIGH) | ACCEPT (remedy chosen) | yes | Main's behavior, not share-skip-fix's: every Quo-imported one-to-one thread is manual, and there the automatic retry is certain to be refused. New D3a: the one-to-one arm previews the automated-send suppression (`evaluateScheduledSendSuppression`: kill switch, opt-out, manual mode) and, if the send would be refused, schedules nothing, stamps nothing and logs WARN (the job's refusal level today). The bubble then shows the plain failure with a live Retry button - today's working path, preserved. The same conversation read carries the `group_text` guard (B-F7). |
| A2 / B-F3 invariant vs the grace (MEDIUM) | ACCEPT (A's remedy) | yes | The grace moves to SCHEDULING: a rung is scheduled only if `now + backoff + RETRY_JOB_GRACE_MS <= origin + window`; the job checks `now <= origin + window` strictly. The invariant now holds at 15 minutes except for the send path's throttle wait (stated in the invariant and section 9). The promise half is restated honestly: at most `RETRY_PROMISE_GRACE_MS` past the due time. |
| A3 / B-F4 anchor ruling not on the branch; job-time copy contradicts it (MEDIUM) | ACCEPT | yes | The rulings are quoted in the spec and recorded in `rulings.md`. The ruling says a declined retry shows as a plain failed attempt, so a relay rung declined at send time keeps its own close code (`retry_window_closed`, for data and logs) but renders exactly like a claim-time decline: copy "Phone unreachable (error 30003)". The section 7 question about the difference is withdrawn - the ruling settled it. |
| A5 / B-F5 D10's "can never" not delivered (MEDIUM) | ACCEPT (remedy: remove) | yes | The `manual_retry_at` reverse guard was a planner addition, never part of Cameron's option 1, and neither write order makes "never" true without contended conditional writes on both sides. Removed. D10 is now exactly the approved forward guard (hide the button; the route refuses while a retry is pending). The narrowed remaining race is a named residual. |
| A6 stamp lands after the only SSE (LOW) | ACCEPT | no (precision) | D7 now requires a `message.persisted` emit after the stamp. |
| A7 / B-F6 reconcile's deferred one-to-one re-enqueue (LOW) | ACCEPT | no | Added to section 5: that deferral is a second scheduling site; whichever branch lands second applies D3 there and refreshes `retry_due_at`. |
| A8 / B-F9 unenumerated surfaces (LOW) | ACCEPT | no | Section 4 adds the harness fake `append` allowlist, the `RelayRetryCloseCode` union and its gate-case table, `e2e/support/selectors.md:49`, the `sendMessage` input/append path, the job's read of the original, the route's checks, and an explicit "no seed or dev seam writes retry fields". |
| A9 / B-F7 / B-F8 comments and reachability (LOW) | ACCEPT | yes (D11) | D11 guards `group_text` UNCONDITIONALLY at the one-to-one arm (the conversation is read anyway for D3a). Reachability is live Twilio behavior no build can settle; the repo asserts both sides (`groupReceipts.ts:3-10` vs `twilio.ts:3422-3429`, `:3477-3479`), and a synthetic test drives it (`app/test/twilioStatusWebhook.test.ts:1420-1463`). D12 lists every comment named by both reviewers. |
| A10 / B-F11 browser-clock skew (LOW) | ACCEPT (B's remedy) | no | The promise's live test reuses the Timeline's existing futurity bound (`Timeline.tsx:791-797`), so a skewed browser clock cannot hold the promise indefinitely. |
| A11 precision defects (LOW) | ACCEPT | no | D2: carried forward, never derived from the retry row's own `sentAt` (D5 fails open instead). D8: the claim-time reason fixed (at rungs 2-3 a rung exists; the leg goes terminal through the join as at `cap_exhausted`). D13: relay fixtures need a slot `sentAt` (new fixtures); one-to-one fixtures move to realistic `provider_ts`. |
| B-F10 the one-to-one e2e does not fit the lane (LOW) | ACCEPT | no | D13 adds the one-to-one backoff lane seam (the same guard as the relay's; share-skip-fix plans the same seam - whichever lands first builds it), and the window seam's floor must exceed both ladders. |
| B-F12 claim-time decline cannot recognize an already-claimed rung (LOW) | ACCEPT | no | Before declaring `window_closed`, the claim probes the rung's deterministic pointer (`relayRetryProviderSid`); if it exists, the outcome is `already_claimed` (WARN), not a dead end. |
| B-F13 anchors unrecorded (LOW) | ACCEPT | no | `rulings.md` records the Q4 ruling and the brainstorm answers. |

Round 1 changed six decisions (D3a added; D1/D4 grace placement; D8 job-time
copy; D10 reverse guard removed; D11 unconditional guard; section 5 copy rule).
Round 2 is the re-review charge to reviewer B (continued), with A's report.
