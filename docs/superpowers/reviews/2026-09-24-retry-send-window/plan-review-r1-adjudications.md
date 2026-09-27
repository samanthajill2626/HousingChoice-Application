# Plan review round 1 - adjudications

Planner adjudication of `plan-review-r1-a.md` (10 findings) and
`plan-review-r1-b.md` (12 findings) against plan v1 @`d35f3e91` and spec draft
7.1. Reviewer B read the plan while the planner was already applying reviewer
A's findings, so several of B's items say "addressed in-flight"; each is
adjudicated on its own merits below. Result: 22 findings, all ACCEPTED (two in
part); 0 REJECT; 1 DEFER (filed). ONE DECISION CHANGED: a claim-time relay
decline is now APPENDED already closed in one write (A1 / B1). So a second round
follows (reviewer B continued, the re-review charge).

Spec: draft 7.2. Plan: v2 (Tasks 3 and 4 rewritten by the slice-A drafter;
everything else edited by the planner).

| finding | verdict | edit |
| --- | --- | --- |
| A1 / B1 D3's two-write close (append open, then close) though the decision is known before the append | ACCEPT - DECISION CHANGED | The declined rung is appended already closed in the claim's single append (spec D3, section 4, header table; plan Task 4 rewritten, Tasks 16, 20, 21 follow). `closeRetryLegEnqueueFailed` is unchanged, no rename; the failed-close path and its section 9 residual ("Stranded claim-time close") are gone; `relay-retry-stranded-claim-window` gains no new site (Task 20 Step 4 becomes a no-change check). |
| A2 section 1's invariant is not exact for relay legs; section 9 misses a thrown-exception twin | ACCEPT | Spec section 1 names the relay slot-before-claim window as an exception; section 9 gains its entry and adds "or whose request threw" to the crash-before-enqueue residual. |
| A3 a momentary human action at claim time becomes a permanent refusal | ACCEPT (accepted residual) | Spec section 9 "A human action reversed inside the backoff": accepted under Cameron's Q1 ruling (deliberate human actions); plan Task 20's residual table lists it. |
| A4 / B2 Task 1 Step 0 calls globalSetup fail-soft | ACCEPT | Step 0 now starts DynamoDB Local and says globalSetup fails every app run without it. |
| B2 (second half) `app/vitest.config.ts:121-123` carries the same stale "fail-soft" comment | DEFER | Out of this branch's scope; filed as `docs/issues/vitest-config-globalsetup-fail-soft-comment.md` (low). |
| A5 / B4 new comments call a missing conversation ERROR; two 30003 comments left stale; the parity-table file name | ACCEPT | The decision header and the twilio.ts taxonomy comment say WARN; Task 10 Step 7 gains (B2) the `isTerminalDeliveryFailure` doc and (B3) the one-to-one marker comment; the header names `test/sendMessage.test.ts`. |
| A6 / B5 / B6 the drift guard is overclaimed; the shared table does not drive the decision | ACCEPT IN PART | The parity comment and spec D3a now say a new send-path gate needs a new row; Task 10 Step 8b runs `SEND_REFUSAL_CASES` through the decision. The job's own two-line input mapping (`automated ?? true`, recipient by id) is not table-driven: both sides are pinned by their own tests (Tasks 10 and 11); a shared helper is not worth a second refactor on this branch. |
| A7 the relay job's pool-number throw order is untested; "Behavior unchanged" | ACCEPT | Task 3 (rewritten) pins both halves and its commit says what changed. |
| A8 / B3 the mid-build-state list is inaccurate | ACCEPT | The plan's slice section states the over-promise until Task 15 and the 409-while-Retry-shows window until Task 17. |
| A9 / B7 section 4 readers have no disposition | ACCEPT | A watch-item list with the reviewers' evidence (no change needed), including `types.ts:2308-2315` / `:2509-2515`. |
| A10 D3a's parenthetical misdescribes `evaluateScheduledSendSuppression` | ACCEPT | Spec D3a says what it covers and why it is not reused. |
| B8 D13 "unit tests inject the clock" not honored at three checkpoints | ACCEPT | Spec D13 states the rule as built: the helpers, the decision and the job take the clock; the claim, the relay job and the webhook use wall-clock-relative margins. |
| B9 section 1's expiry bound is stated for relay too | ACCEPT | Section 1 scopes the bound to the one-to-one bubble and names the relay's 15-minute quiet budget. |
| B10 a provider error on the retry's send is another promise with nothing behind it | ACCEPT | Spec D3a and section 9 name it; plan Task 20's residual table follows. |
| B11 D14 changes what `automated` means without correcting its doc; the audit loses "machine-initiated" | ACCEPT | Task 8 rewrites the whole `automated` doc (gating, not origin); spec D14 states the audit consequence (the row still tells them apart by `retry_attempt`). |
| B12 Task 21's "Relay for SOR" does not follow the standing instruction and no task owns it | ACCEPT | The standing instruction binds the PLANNER's final handback: Task 21's section is renamed "Facts for the planner's Relay for SOR" and says so; the planner writes the block. |
