# Branch B plan review round 3 - adjudications

Date: 2026-09-28. Plan v3 (commit 0fe8e525) -> plan v4 (this commit).
Reviewer: B continued (`plan-review-r3.md`, 10 findings: 5 medium, 5 low).
Every finding is a claim: ACCEPT (the plan changed), REJECT (with the
reason), or DEFER (filed). Severity labels are the reviewer's; whether a
DECISION changed is the planner's call.

Decisions changed this round: 2. Round 4 runs (reviewer B continued) and is
the HARD CAP: precision folds in; a decision still moving goes to Cameron.

## Accepted - decision changed

1. **F1 (MEDIUM) - a slot write that committed but lost its response is
   replayed (by the SDK, and now by `applyLaterAttemptBounded`), refuses its
   own condition, and reads as `'refused'`: the ledger entry and the emit are
   skipped silently, at every D2 caller.** ACCEPT. Deviation 15: on a refused
   condition the re-read slot equal to the computed `next` (`slotEquals`) is
   treated as applied and the idempotent side effects run (INFO); a test
   replays a committed write and pins one delivery, one ledger entry, one
   emit.
2. **F2 (MEDIUM) - the withdrawal emit sent `retry_pending: 0`: against spec
   D4 (only the rollup emits a count) and wrong when another recipient is
   still pending (the list would replace with 0 and never refetch).**
   ACCEPT. Deviation 13 restated: the emit leaves the count UNSET, so the
   list's merge refetches the finished share's stats; `rolled` is declared
   before the `transitioned` block; a retry row re-reads the share by id; the
   test pins the count absent.

## Accepted - precision (no decision changed)

3. **F3 (MEDIUM)** - e2e (b) opened the list before the share existed (the
   hook patches only rows it holds): the list opens after the failure is
   stamped; the assertion holds without a reload.
4. **F4 (MEDIUM)** - T13's fixtures shared one ledger row and
   `seedTwoSlotShare` was undefined: every fixture owns its unit and contact;
   the helper is defined; the b-4 case seeds its own pair.
5. **F5 (MEDIUM)** - the census projected a move the D2 rule refuses:
   `projectSlot` is gated on `wouldApply`; the b-4 and b-5 dry runs are pinned.
6. **F6 (LOW)** - `'no_slot'` at the reconcile sites logs ERROR (a routing
   bug), as the webhook does.
7. **F7 (LOW)** - the record bound was measured from `created_at` (the
   draft's creation): deviation 16 measures it from `updated_at` (the last
   write, never earlier than the send), falling back to `created_at`; a test
   pins an old draft sent recently; the spec's D1 wording is amended in
   section 8.
8. **F8 (LOW)** - the tick override cleared on every payload (an SSE overlay
   after a tick brought a stale count back) and the interval read `rows`
   from a closure: the override clears only on a refetch; rows go through a
   ref; a test pins the overlay-after-tick case.
9. **F9 (LOW)** - the "queued / accepted" webhook test never reached
   `outcomeOf`: `outcomeOf` is exported and unit-pinned.
10. **F10 (LOW)** - a WITHDRAW that keeps losing sends the check to the DLQ
    with the slot write behind it never run: named in the spec's section 8
    amendment (the repair's record check covers it).

## Rejected

None.

## Deferred

None.

## Carried into round 4

- The reviewer's "checked and correct" list (the WITHDRAW-first redelivery,
  the bounded retry never double-applying, the `'expired'` branch, the chain
  separation, the apply-mode ledger, the landlord relabel, the list
  re-bucketing) is the baseline.
- New material for round 4: `slotEquals` and the already-applied branch; the
  count-less withdrawal emit and `rolled`'s scope; `updated_at` as the record
  bound; the refetch-only override clear; T13's per-fixture rows and the
  gated projection; e2e (b)'s ordering.
