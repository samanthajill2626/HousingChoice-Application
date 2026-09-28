# Code review round 1 - adjudications (retry-send adoption)

Orchestrator: the build orchestrator for `feat/retry-send-adoption`
(worktree `W:\tmp\retry-send-adoption`), 2026-09-28. Reviewed commit
`6c82058c` (every gate green there: typecheck 0, npm test 0, smoke 0, e2e
300/300 in 21.0 m, lint 0 new). Reports:

- `r1-conformance.md` - the spec-conformance reviewer (spec, plan, worklist,
  slice reports): 119 CONFORMS / 6 PARTIAL / 0 MISSING / 12 DEVIATES (10
  declared, 2 undeclared) / 7 PENDING (Task 9); 31 mutation runs, 28 red as
  expected, 3 diagnostic greens; findings C-1..C-10.
- `r1-adversarial.md` - the PLAN-BLIND adversarial reviewer (the diff package,
  the repository and the standing charter only): no BLOCKING, no HIGH; five
  throwaway probes, all red on HEAD; findings A-1..A-7.

Neither reviewer found a double text, a lost send or a stranded send on a
non-fault path. Rulings: ACCEPT (fixed in fix wave FW1), ACCEPT-DOC (recorded
in the Task 9 issue notes and/or the handback, no code change), or REJECT
(with the reason). Severity is the reviewer's; the ruling is the
orchestrator's, made against the APPROVED spec (revision 5) and Cameron's
rulings it carries.

## Conformance findings

| id | sev | finding | ruling | action |
|---|---|---|---|---|
| C-1 | MED | `declineBeforeClaim` wraps `closeRedriven` in `guardWrite`, so a thrown close is swallowed and a re-driven record strands `redriven` (R2: "a throw in steps 1-4 fails the delivery"; Review Focus 5). Proven by a throwaway probe. | ACCEPT | FW1: call `closeRedriven` directly (a throw fails the delivery; the redelivery re-runs the idempotent decline); keep the lost-fence INFO; a test where `closeRedriven` rejects once, the dispatch rejects, and the redelivery closes the record `done/refused`. |
| C-2 | MED | A WITHDRAW that fails (`'failed'`) or is lost twice (`'lost'`) is swallowed by `closeSlot`'s `retry_send` arm; the check succeeds, so the superseded exit never re-applies it (R4 crash safety; Q1's display half). The job's own two unresolved arms have no re-apply path either. Proven by a probe. | ACCEPT (reconcile half); ACCEPT-DOC (job half) | FW1: `closeSlot`'s `retry_send` arm THROWS when `withdrawRetryPromise` answers `'failed'` or `'lost'` (after the helper's ERROR), so the check fails and its redelivery re-applies through the superseded exit (the FW1-4 shape every other owner has); a test. The job half (a WITHDRAW that fails after the job's own `unresolved` close - second unknown, hand-off enqueue failure) cannot re-apply without a new gate-skip path; the record still refuses the press (409 `retry_unresolved`) for its 30-day life - FILED in `send-attempt-sweeper` (Task 9) and named in the handback. |
| C-3 | LOW | Test gap: removing the gate's `defer` return stays green (the claim backstops it). | ACCEPT | FW1: a case with a `reconciling` record and one with a fresh `attempting` record on a row past the window - one INFO `gate: 'defer'`, no ERROR, no `claim refused`, no `listRetryChildrenConsistent` call. |
| C-4 | LOW | The window-terminal deferral line does not say `retry window closed` (R3's table). | ACCEPT | FW1: the line reads `retrySend: retry window closed - a deferred re-run would land past the window; chain ended`; its pin updated. |
| C-5 | LOW | Two ERROR lines claim "the retry promise is withdrawn" without checking the WITHDRAW's answer. | ACCEPT | FW1: branch each message on the answer (`written`/`already` -> withdrawn; `lost`/`failed` -> "withdrawal failed - the record decides"). |
| C-6 | NOTE | The step-1 conversation-mismatch decline is declared only in S3's report. | ACCEPT-DOC | Handback: DEVIATION 11 (a third designed step-1 decline; unreachable from the webhook, a deferral or a re-drive; it keeps the owner addressable). |
| C-7 | NOTE | A PHONE-keyed attempt whose thread number changed: the code follows R1 (unaddressable, left for the sweeper), not R4's digest bullet. | ACCEPT-DOC | Handback states R1 governs (the key cannot be re-derived, so the owner cannot be resolved; R4's digest rule applies to a resolvable, contact-keyed owner - both pinned by tests); `send-attempt-sweeper` names the strand. |
| C-8 | NOTE | Spec item 13's `attempt === retry_attempt` clause is proven only jointly with the walk's stop at a manual row. | ACCEPT-DOC | Handback. Defense in depth, as S2 named it. |
| C-9 | NOTE | Worklist item 26's "(the route allows it at once)" is inaccurate: RSW's time guard answers 409 `retry_pending` first while the refreshed promise is live. | ACCEPT-DOC | The handback's residue text is corrected (see A-1). |
| C-10 | NOTE | The deviation-10 belt is permanent code for a one-time window. | ACCEPT | FW1: a dated `TODO(retry-send-lost-under-job-marker):` at the belt naming its removal after the first production deploy plus one SQS redelivery window; Task 9's anchor-issue note says the same. |

## Adversarial findings

| id | sev | finding | ruling | action |
|---|---|---|---|---|
| A-1 | MED (LOW if the accepted class covers it) | The branch's promise REFRESHES (the unknown hand-off; the re-drive) outlive its own no-send closes (`redrive_refused` on a closed window; a re-drive `enqueue_failed`; a re-driven run that is refused, rejected or declined): for about 4-5 minutes the bubble reads "will retry", Retry is hidden and a press gets 409 `retry_pending`; the `closeSlot` comment says "Retry stays available". Probes A1-A3 red. | REJECT the code change; ACCEPT the comment fix and the dated issue note | The spec (APPROVED, revision 5) decides this explicitly: section 0 "Kept as accepted (Cameron, 2026-09-26, `one-to-one-retry-promise-outlives-job-decline` = wontfix): after a refusal, a rejection, a WINDOW CLOSE or a success, the retried row's promise EXPIRES on RSW's clock ... nothing here withdraws it early"; R4 never_sent outside the window: "promise untouched (expires)"; section 7: "The refreshed promise keeps Retry hidden meanwhile - RSW #3's tradeoff". The proposed fix (writing the sentinel on those ends) is exactly the early withdrawal Cameron ruled wontfix. FW1 corrects the misleading comment; Task 9 adds a dated note to `one-to-one-retry-promise-outlives-job-decline` with the new, longer tails this branch's refreshes create (up to ~4-5 min instead of ~3); the handback flags it for Cameron's eye (he may reopen). |
| A-2 | LOW | A late automatic job and a manual press whose provider call is in flight both text the member (probe B: 2 texts, 2 children). | REJECT the code change; ACCEPT-DOC | The spec names this exact residual ("What stays open, by construction: a manual send IN FLIGHT while the job passes step 4a and claims ... the fork is the residual's consequence, named, not chased"). The reviewer's fix (the route takes a conditional write on the same record key before sending) is a new design with a trade-off (a press whose own send is then refused has also ended the automatic attempt) - a product call. Task 9's dated note in `manual-retry-double-send-residual-windows` records it as the remaining gap with this suggested fix. |
| A-3 | LOW | (1) Every receipt of a share-RETRY row goes through the rollup's miss path (two broadcast reads + a 2.5 s sleep, on `sent` AND terminal callbacks); (2) the WARN -> INFO change also silences a GENUINE miss on a share's own row (probe C). | REJECT the code change (fence); ACCEPT-DOC | (1) is spec R7's stated cost until Branch B ("Cost until Branch B, stated"); skipping the rollup for retry rows needs more than the one permitted line in the fenced `twilio.ts` (Cameron's Q2 ruling). (2) cannot be split inside one line: `rollIntoBroadcast` does not receive `retry_of` (`twilio.ts:3853-3864`). Task 9's note in `broadcast-30003-retry-never-updates-slot` records both - Branch B should skip retry rows AND restore WARN for a share's own row - and the handback flags (2) for Cameron's eye (his ruling asked for INFO; this is its side effect). |
| A-4 | LOW (PLAUSIBLE) | A crash between a record write and its enqueue strands the attempt; once the promise lapses the bubble shows Retry but the route refuses until attemptedAt + 15 min, then lets a press through. | ACCEPT-DOC | The filed `send-attempt-sweeper` class; Task 9 adds the `retry_send` owner and this consequence there. |
| A-5 | NOTE | Rollback dead-letters queued `retry_send` reconcile checks (pages `jobs-dlq-depth`); a mixed fleet's old workers append retry rows with no `retrychild#` pointer. | ACCEPT-DOC | Handback deploy/rollback notes (with worklist item 25). |
| A-6 | NOTE | The attempt record key is assembled twice (the job; the route) - a drift would silently disarm the route's guards; `adoptRetry` restates the append shape by hand. | ACCEPT (the key half, as a TEST); REJECT the refactor | FW1: one cross-component test - the REAL job leaves a record, then the REAL route is pressed over the same world with NO `retry_outcome` on the row (so only the record can answer) - pinning that the route reads the key the job writes. No shared-helper refactor this late (the attempt number is derived from different inputs by design: the payload vs the row). The `adoptRetry` restatement follows the `adoptBroadcastRecipient` precedent - noted, not changed. |
| A-7 | NOTE | The belt costs one read on every first run forever. | ACCEPT | Same as C-10. |

## Fix wave FW1 (one wave, the complete list)

C-1, C-2 (reconcile half), C-3, C-4, C-5, C-10/A-7 (the TODO), A-1 (the
comment only), A-6 (the cross-component key test). Everything else is Task 9
issue notes and handback text, listed above. After FW1: a fresh re-reviewer
(round 2) reviews the fix diff cold, looks for what round 1 missed, and may
contest any ruling here with file:line.
