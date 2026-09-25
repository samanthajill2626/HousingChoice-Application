# Spec review round 2 - adjudications

Planner adjudication of `spec-review-r2.md` (reviewer B, continued; 14 findings)
against spec DRAFT 2 @`d4446de0`. Claims re-verified before acceptance:
`dashboard/src/routes/contact/deliveryStatus.ts:878-882` and
`deliveryStatus.test.ts:1656-1659` (internal codes carry no "(error N)" tail, and
the test pins it); `dashboard/src/routes/contact/relayRetryJoin.ts:405-415` (the
terminal step falls back to the original's carrier code when the last rung has
none); `app/src/repos/messagesRepo.ts:1960-1974` (`getSidPointer` supports a
consistent read). `feat/send-outcome-reconcile` has moved again, to revision 4
@`bf2c5bf2` ("coordination state moves to a per-recipient send-attempt record"),
so section 5 now states its couplings as REQUIREMENTS on any path, not as
descriptions of that branch's moving mechanics.

Result: all 14 ACCEPTED (0 REJECT, 0 DEFER). R2-8 is accepted with a partial
remedy (below). Decisions changed: the job-time relay copy mechanism (R2-1), the
failure semantics of the new reads (R2-3), the promise's skew bound (R2-5), the
relay claim's precedence (R2-8), and the reason API (R2-12). A round 3 follows.

| finding | verdict | decision changed? | disposition |
| --- | --- | --- | --- |
| R2-1 job-time copy collides with the A16 no-tail rule (MEDIUM) | ACCEPT (reviewer's remedy) | yes | No `INTERNAL_CODE_REASONS` entry. The rung keeps `retry_window_closed` for data and logs; the join's terminal step treats it as carrying no display code, so the original's 30003 stands and the leg reads "Phone unreachable (error 30003)" through the normal chain - byte-identical to a claim-time decline. A join test pins it; the A16 rule is untouched. |
| R2-2 section 5 stale against reconcile; its pending checks outlive the promise (MEDIUM) | ACCEPT | yes (section 5) | Coupling rewritten as a requirement: any path that defers a one-to-one retry, or leaves its outcome pending past `retry_due_at` (a deferral, or an `unknown` awaiting reconcile checks at about 5 s, 30 s and 4 minutes), keeps the promise and D10's guard up until it resolves, by refreshing `retry_due_at` to cover the pending schedule. Reconcile's filed issue about an unresolved retry leaving "will retry" standing changes with D8. |
| R2-3 D3a's reads fail closed and permanently (LOW) | ACCEPT | yes | A failed preview read, or a missing or unparseable origin, fails OPEN: WARN and schedule as today. Safe because the job's `sendMessage` re-applies every refusal at send time (`sendMessage.ts:286-300`, `:307-318`, `:348-349`). D5 extended to an unparseable origin. |
| R2-4 a lost stamp leaves the whole wait unguarded (LOW) | ACCEPT | no | D7 drops "honest" and keeps enqueue-then-stamp for the stated reason (a stamp followed by a failed enqueue would promise a retry that never comes, and `annotateMessage` cannot remove one). The lost-stamp window is named in section 9 and in the new residual issue. |
| R2-5 the reused skew bound is 15 minutes wide and faces the wrong way (LOW) | ACCEPT | yes | The promise gets its own bound: live only while the bubble clock is before `retry_due_at + RETRY_PROMISE_GRACE_MS` AND `retry_due_at` is no further ahead of it than the longest backoff plus the grace. A due time further ahead than any real schedule means the browser clock is behind, and the promise is treated as not live. Test intention 7 names the skew sizes. |
| R2-6 section 1's promise bound restates a slogan (LOW) | ACCEPT | no | Section 1 now states the real bound: the grace plus one ticker interval, on a browser clock within D8's skew bound. |
| R2-7 the lane-window floor ignores the scheduling grace; the one-to-one lane value is unlisted (LOW) | ACCEPT | no | D13's floor is the longest lane rung backoff plus `RETRY_JOB_GRACE_MS`, with margin. Section 4 lists `E2E_SEND_RETRY_BACKOFF_MS` in the lane's `childEnv`. |
| R2-8 the two paths log one dead end at two severities (LOW) | ACCEPT (partial remedy) | yes | The relay claim, before declaring `window_closed`, checks the two job gates it can see from the roster it already reads: a closed group or a removed member logs WARN with that reason (Q1's human-action ruling), not a dead-end ERROR. An opted-out member or a changed number is not visible at the claim without extra reads; those rare late cases still log `window_closed` at ERROR, named in section 9. |
| R2-9 "every surface" forbids the relay Retrying state (LOW) | ACCEPT | no | D8's rule is scoped to the one-to-one bubble and the share results row; the relay promise stays governed by its live rung (`relayRetryJoin.ts:370-377`). |
| R2-10 the share row cannot follow the rule on this branch (LOW) | ACCEPT | no | Stated plainly: on this branch alone the base copy removes the share row's promise even while a retry is scheduled (the row reads only the broadcast slot). Reading `retry_due_at` from the failed message belongs to share-skip-fix's results path, which already reads that message; whichever branch lands second wires it. |
| R2-11 the `already_claimed` probe reads eventually consistently (LOW) | ACCEPT | no | The probe is a strongly consistent read of the rung's `sid#` pointer; the repository exposes one (it already supports it privately). |
| R2-12 base copy equals the relay override; precedence of the promise unstated (LOW) | ACCEPT | yes | `deliveryReason` gains a `retryScheduled` option. With it and code 30003, the reason is "Phone unreachable - will retry", ahead of the media, relay and base maps, so an MMS one-to-one bubble with a live stamp still promises. The relay map's 30003 entry is redundant once the base drops the promise and is removed; its order test is rewritten to pin "no promise without `retryScheduled`". |
| R2-13 two share-skip-fix couplings missing (LOW) | ACCEPT | no | Section 5 adds its switched-off lean tenant (test intention 8 must not use it) and its import writing `auto` (section 2's manual-mode statement then describes pre-existing rows only; D3a reads the live switch either way). |
| R2-14 residuals have no issue files (LOW) | ACCEPT | no | Filed on this branch: `manual-retry-double-send-residual-windows` (low) and `relay-retry-send-throttle-past-window` (low). |

The reviewer conceded the removal of the `manual_retry_at` reverse guard
(faithful to Cameron's option 1) while noting the residual list was incomplete;
R2-2, R2-4 and R2-14 complete it.
