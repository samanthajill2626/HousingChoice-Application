# Code review round 2 - adjudications (retry-send adoption)

Orchestrator: the build orchestrator for `feat/retry-send-adoption`,
2026-09-28. Reviewed: `1b5ddb01` (fix wave FW1 = `3b05dec3..1b5ddb01` on top
of the round-1 commit `6c82058c`). Report: `r2-review.md` - a FRESH
reviewer (the AUTO-mode resume ban), charged in order with: what round 1
missed; the fix diff reviewed cold; contesting any round-1 ruling; only then
whether the fixes are real.

Verdict of the round: FW1's fixes are real and correctly placed (C-1: every
path to the new throw runs before the claim and no send precedes it; C-2: the
throw lands where the redelivery re-applies through the superseded exit, one
unresolved ERROR in total, no DLQ loop, the job never calls `closeSlot`; C-5:
still one close line per close). No BLOCKING, HIGH or MED finding, new or
residual. Seven findings, all LOW or NOTE; two contest round-1 actions.

The review loop has CONVERGED: round 1 (two MED on fault paths + LOWs) ->
FW1 -> round 2 (LOW/NOTE only, no staff-visible correctness defect on a
non-fault path). No second fix wave is opened: every item below is recorded
(an issue, a Task 9 note or a handback line) rather than changing reviewed,
gated code for a cosmetic or fault-path-only effect - Cameron's rule "keep a
fix only if small and contained, else FILE it" applied to LOW items, and the
code stays as round 2 reviewed it.

| id | sev | finding | ruling | action |
|---|---|---|---|---|
| R2-1 | LOW, CONFIRMED | `annotateRetryPromise` has no op token: an SDK retry of a write that already committed fails its own condition, so the WITHDRAW answers 'already' and a REFRESH reports "dropped" - neither emits `message.persisted`. In the reconcile path `afterClose` emits anyway; in the JOB's two unresolved closes (and a replayed refresh) an OPEN dashboard keeps the stale bubble until its next refetch. Server state and the route stay correct. | FILE | New issue `retry-promise-write-replay-skips-rerender` (low) with the reviewer's fix (emit on every exit of both helpers, or an op token on the promise write). Handback names it. |
| R2-2 | NOTE, CONFIRMED | If C-1's `closeRedriven` commits and then throws, the redelivery skips at the gate, so the one `retry window closed` ERROR is never logged (the record holds the truth: done/refused, cause retry_window_closed). | ACCEPT-DOC | Handback. |
| R2-3 | LOW | Three log-only branches have no test: C-1's lost-fence INFO (`retrySend.ts:689-691`), the step-5 takeover-lost INFO (`:509`), the hand-off fence-lost INFO (`:821`). | ACCEPT-DOC | Handback lists them as untested log-only branches. |
| R2-4 | NOTE | Since C-2 the WITHDRAW's ERROR text still says "best-effort" although the failure now fails the check, and it lacks `event` / `recipientKey` / `checkNo`. | ACCEPT-DOC | Folded into the R2-1 issue (the same helper; its log context and wording); handback. |
| R2-5 | LOW, contest of A-1's ACTION | Round 1 said Task 9 adds a dated note to the wontfix `one-to-one-retry-promise-outlives-job-decline`; spec section 5 and plan Task 9 say that issue stays UNTOUCHED. | ACCEPT (contest upheld) | The wontfix issue is NOT edited. The longer promise tails this branch's refreshes create (up to ~4-5 min after a no-send close that follows a refresh) go into the handback and a dated note in `send-reconcile-job-residues`. The A-1 ruling itself (no code change) stands - the reviewer agrees. |
| R2-6 | NOTE, extends A-2 | If the manual press's OWN send ends unknown or accepted-not-recorded, no manual row appears, so a late automatic retry claims and sends - the in-flight overlap then lasts until the automatic chain's window closes. | ACCEPT-DOC | Added to the Task 9 note in `manual-retry-double-send-residual-windows` beside A-2. |
| R2-7 | LOW, contest of A-3's PREMISE | Round 1 said the two costs "cannot be split inside one line"; the call site HAS the row: `&& message.retry_of === undefined` at `twilio.ts:3529` is one line that skips the 2.5 s sleep and two broadcast reads for every share-retry receipt and would let the give-up line keep WARN for a genuine miss on a share's own row. It is a DIFFERENT line from the one Cameron approved. | ACCEPT (premise corrected); the code stays as ruled | Round 1's "cannot be split inside one line" was wrong about the call site - corrected here. Cameron's Q2 ruling named the give-up line's level change and fenced everything else, so the build keeps exactly that line. The handback shows Cameron BOTH one-liners (as built: the give-up line at INFO; the alternative: revert that line to WARN and guard the call site on `retry_of`) with the Branch B implication (B teaches the rollup to route retry receipts, so a call-site guard would be B's to remove). His call. |

Round-1 rulings the reviewer confirmed without contest: A-1 (no code
change), A-2 (with R2-6), C-2's job half, C-6, C-7 (the reviewer adds that
the phone-keyed number change is actually unreachable - a one-to-one
thread's `participant_phone` is only ever rewritten for relay threads,
`conversationsRepo.ts:2158`), C-8, C-9, A-4, A-5, A-6's refactor half.
