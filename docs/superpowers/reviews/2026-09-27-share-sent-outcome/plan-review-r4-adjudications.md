# Branch B plan review round 4 - adjudications (the cap; terminal)

Date: 2026-09-28. Plan v4 (commit 69661768) -> plan v5 (this commit).
Reviewer: B continued (`plan-review-r4.md`, 5 findings: 1 medium, 4 low).
Every finding is a claim: ACCEPT (the plan changed), REJECT (with the
reason), or DEFER (filed). Severity labels are the reviewer's; whether a
DECISION changed is the planner's call.

Decisions changed this round: 0. Round 4 is precision only, which makes it
the TERMINAL round: the loop closes at four rounds without reaching the
"still moving at the cap" stop. The plan is final for the build.

## Accepted - precision (no decision changed)

1. **F1 (MEDIUM) - the already-applied check sat inside the refused-condition
   branch, so a fresh replayed call (the bounded retry after a throw, a
   guarded arm, the webhook's try/catch) was refused by the order rule at
   the top of the loop before any write, and the round-3 defect stood; the
   new test was red as written.** ACCEPT (the decision - a replayed
   committed write reads as applied - stands; its mechanism moves): the check
   runs at the TOP of the loop, before the order rule, with the post-refusal
   check kept for the SDK's own replay; the side effects are one shared
   helper; the test's premise now holds. Deviation 15 restated.
2. **F2 (LOW) - the seed helper's entry key was unnamed; a natural key sorts
   after the fixture's original and breaks the un-count case.** ACCEPT: the
   seeded entry's attempt is `LEGACY_ATTEMPT_KEY` (`INDIVIDUAL_ATTEMPT_KEY`
   without a share), `countedAt = sentAt`.
3. **F3 (LOW) - clearing the tick override only on a refetch mirrors round
   3's flash: a tick recounted to 0, then an overlay carrying the rollup's
   `retry_pending: 1` for another recipient, showed Not sent until the
   refetch.** ACCEPT: the override also clears on an overlay that CARRIES a
   count; an overlay whose count is unset never clears it; a test pins both.
4. **F4 (LOW) - `slotEquals` ignores the promise, so a replayed `failed`
   30003 without one could move the winner's `pending` ledger entry to
   `failed`.** ACCEPT: a replayed failed-30003 outcome with no promise skips
   the ledger write (INFO); a test pins it.
5. **F5 (LOW) - deviation 16 said every later write stamps `updated_at`;
   `setRecipient` does not.** ACCEPT: the sentence names `setRecipient` as
   the exception and says it is not changed; the bound holds through
   `markSending` / `markFailed`.

## Rejected

None.

## Deferred

None.

## Loop summary (four rounds)

| Round | Reviewer(s) | Findings | Decisions changed | Rejected |
|---|---|---|---|---|
| 1 | A + B, independent | 16 + 21 | 16 | none |
| 2 | B continued | 13 | 6 | none |
| 3 | B continued | 10 | 2 | none |
| 4 | B continued (cap) | 5 | 0 - terminal | none |

Named by the reviewer, not a finding: during a retry chain the list row
passes through `Sent` between a retry's carrier `sent` confirmation and its
failure. That follows spec D1 (a carrier-accepted slot counts as reached);
the e2e asserts the end state.
