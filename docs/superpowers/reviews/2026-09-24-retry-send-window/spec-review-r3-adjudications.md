# Spec review round 3 - adjudications

Planner adjudication of `spec-review-r3.md` (reviewer B, continued; 11 findings)
against spec DRAFT 3 @`613752d1`. Claims re-verified before acceptance:
`app/src/routes/webhooks/twilio.ts:2770-2782` with `:595-605` (the claim's only
roster read is inside `composeRelayLegCopy`, reached for rung 1 from a member
sender only - never for a team send or rungs 2-3); `twilio.ts:433-446` (the claim's
WARN set is `claimed`, `already_claimed`, `fenced_announcement`, `slot_settled`, so
`gate_refused` would log ERROR); `app/src/lib/tokenBucket.ts` (`acquire(count,
{ timeoutMs })` bounds the whole wait; in production use at
`app/src/services/groupSend.ts:504`); and that only the relay send waits on the
bucket (`app/src/jobs/relayFanOut.ts:1360`) - `sendMessage` and `retrySend` do not.

Result: all 11 ACCEPTED (0 REJECT, 0 DEFER). Decisions changed: the relay claim
now previews all four job gates (R3-1); the promise is anchored to the server's
clock (R3-3, R3-4); the throttle overrun is closed rather than allowed (R3-7); the
relay map's 30003 entry is KEPT, reversing round 2's removal (R3-10). Round 4 - the
last the cap allows - follows. If it still changes a decision, the design goes to
Cameron with the open findings.

| finding | verdict | decision changed? | disposition |
| --- | --- | --- | --- |
| R3-1 D3 step 2 rests on a roster read that exists only at rung 1 for a member sender (MEDIUM) | ACCEPT (full remedy) | yes | On the decline path only (rare), the claim reads what the job's four gates read - the conversation (status, roster, the current number's digest) and the member's suppression - and if any gate would refuse, logs WARN with that gate's code (Q1) instead of `window_closed`. R2-8's partial remedy and its residual are gone. |
| R3-2 no outcome value for the WARN; copy differs from today (LOW) | ACCEPT | no | The claim logs the existing `gate_refused` outcome with the gate's code, and `isTerminalRelayLegFailure` adds `gate_refused` to its WARN set (at the claim it arises only on this path). The union stays at fourteen (`window_closed` is the only new value). Noted: a late callback on a closed group now shows the plain "Phone unreachable (error 30003)" rather than today's "Not retried - group closed" (no rung exists to carry it), consistent with the ruling. |
| R3-3 the skew bound is checked against a moving clock (LOW) | ACCEPT (reviewer's primary remedy) | yes | The promise's live test runs on the SERVER's clock as the dashboard estimates it from its latest fresh API response; the 360-second browser-clock bound is removed. A skewed browser clock no longer changes how long the promise shows. The mechanism (a server-now field, or the response's `Date` header, which stays fresh on a 304) is the plan's. |
| R3-4 the bound's constant is unmirrored; requirement 3 can exceed it (LOW) | ACCEPT | no | Moot under R3-3: no bound constant remains. |
| R3-5 requirement 3 omits the emit; the promise may already be false while reconcile runs (LOW) | ACCEPT | no | Requirement 3 now requires the `message.persisted` emit after a refresh. Keeping "will retry" while a retry's outcome is pending reconcile - its text may already be out - is accepted as a rare residual: one field keys both the copy and the guard, and the guard is what prevents a double send. |
| R3-6 fail-open contradicts D11; "schedule as today" is ambiguous (LOW) | ACCEPT (choice: no stamp) | no | D11 says "unless the conversation read fails". A fail-open schedules the retry WITHOUT stamping: never promise what could not be checked - with a stamp, a read failure on a manual-mode thread would recreate round 1's false promise and hidden button. Test intention 4 pins it. |
| R3-7 the throttle overrun can be closed with the existing bounded acquire (LOW) | ACCEPT | yes | The relay retry job passes its send deadline (the window's end) into `sendOneRelayLeg`, whose acquire becomes `acquire(1, { timeoutMs })` for that caller only; a timeout sends nothing and the job closes the rung `retry_window_closed` (ERROR). The fan-out passes no deadline and is unchanged. The invariant loses its allowance; the throttle issue file is withdrawn (it never reached `main`). |
| R3-8 defects in the two new issue files (LOW) | ACCEPT | no | The throttle file is withdrawn (R3-7; its second item is gone with R3-1). The double-send file is corrected: its first gap is server-side (a press that reaches the route before the stamp is written), and its suggested fix names reconcile revision 4's per-recipient send-attempt record as the natural claim substrate. |
| R3-9 `retry_window_closed` has no internal copy (LOW) | ACCEPT | no | A no-tail fallback entry, "Not retried - message too old", keeps the A16 rule intact for any future direct render; the join still renders the original's 30003 on every current surface. The internal-code copy test gains it. |
| R3-10 removing the relay 30003 entry leaves dead code and lying comments (LOW) | ACCEPT (keep the entry) | yes | Round 2's removal is reversed: the relay map keeps its 30003 entry and the `relay` option keeps working, and `relay` WINS over `retryScheduled`, so a relay leg can never promise through the one-to-one option. The order test is rewritten to pin exactly that, which gives it a real purpose. |
| R3-11 section 4 misses the new repository surface (LOW) | ACCEPT | no | Section 4 adds the new public consistent pointer read on `MessagesRepo`, its implementation in the webhook harness fake, and the claim's decline-path conversation and suppression reads. |
