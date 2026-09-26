# Plan review round 2 - adjudications (share-skip-fix Branch A)

Date: 2026-09-25. Plan v2 @a5b95400 -> plan v3 (this commit). Reviewer: B,
continued from round 1 (`plan-review-r2.md`, 8 findings, re-review charge).
Every finding is a claim: ACCEPT (the plan changed), REJECT (with the reason),
or DEFER (filed).

Decisions changed this round: NONE. Every accepted finding is a precision
edit - a test shape, a hand-off mechanic, a label, a command - none alters
what gets built, adds or removes a surface, or moves an invariant. Under the
stop rule this is the TERMINAL round: the edits are folded in and the review
closes at round 2 (cap 4).

## Accepted - precision (no decision changed)

1. **B1 (HIGH) - Task 14 test 3 raced `finalize`: the fake fails
   asynchronously (~300 ms), a one-recipient share whose only text fails
   finalizes `failed` and is excluded whole, so the "failed stays flagged" pin
   held only by timing.** The mechanism is verified in the reviewer's file:line
   trail (`fake-twilio/src/engine/delivery.ts:18-19`, `broadcastFanOut.ts:690-693`,
   `broadcastsRepo.ts:537`). CHANGE: test 3 shares with TWO recipients, one
   delivering and one armed to fail 30007, so the share finalizes `sent`
   whatever the timing, and it asserts the header reads Sent, the failed row's
   carrier reason, and the failed recipient's "Already sent" flag; the test
   comment says why. Spec v10 section 8 states the scope of the interim rule
   (counts within `sent` / `sending` shares; an all-failed share is excluded
   whole, today's rule, unchanged by A; Branch B replaces both).
2. **B2 (MEDIUM) - the RUNBOOK sent Cameron's dev/prod runs through the build
   worktree while Tasks 6-15 keep editing it (the scripts' import closure
   reaches `sendMessage.ts`).** CHANGE: the planner hands Cameron a pinned,
   detached worktree of the reviewed slice-1 SHA (`W:\tmp\share-skip-fix-ops`,
   `npm ci` there, never a shared `node_modules`); the RUNBOOK heading says
   "from the pinned checkout the planner hands over, never the build
   worktree"; Task 5 Step 3 has the orchestrator report the slice's final SHA
   and names the planner as the one who cuts the ops worktree; it is removed
   only on an explicit cleanup ask.
3. **B3 (LOW) - Task 10 pre-imported Task 11's `presentShareLabel`, failing
   Task 10's own typecheck.** CHANGE: Task 10 adds only `shareRecipientReason`;
   Task 11 adds `presentShareLabel` and the `BroadcastStats` type import.
4. **B4 (LOW) - two red claims still false (Task 7's I1 test is green once
   Task 6 lands; Task 6's bumpStats case cannot flip through Task 6).** CHANGE:
   the I1 test is labeled a pin with the reason; Task 6 Step 3 is a
   VERIFICATION case with a stated contingency - RED means `bumpStats` moves to
   `SET stats.#k = if_not_exists(stats.#k, :zero) + :v` for every counter -
   and Step 5 no longer expects it to fail.
5. **B5 (LOW) - the census called its released count "exact"; it is an upper
   bound, and the replayed `resolveUsableGroup` logged the job's WARN.**
   CHANGE: the header and the done line say UPPER BOUND and list the unreplayed
   gates (quiet hours, conversion claims, open-group wait, roster,
   opt-out/deleted); `resolveUsableGroup` gets a silent logger. The reviewer's
   cheaper exclusion of opt-out/deleted contacts was NOT taken: it would add a
   bucket and a fixture row to close a LOW on a number now labeled a bound,
   and this round adds no surface.
6. **B6 (LOW) - the lost-audit remedy had no command.** CHANGE: RUNBOOK step 3
   gives the exact PowerShell `put-item` line (the `auditRepo.append` item
   shape, `ts` = `<ISO>#backfill`, `backfilled: true`, a
   `attribute_not_exists` condition), with the `reason` rule for a resume. The
   reviewer's alternative (`--audit-only` script mode) was NOT taken: it is a
   new surface on a one-time script for a case the run already names and
   counts.
7. **B7 (LOW) - `laneAccessKeyId` was pinned only against itself.** CHANGE:
   `stageClient.test.ts` imports `laneAccessKeyId` from
   `e2e/support/lane.mjs` (the path `app/test/lane.test.ts` already uses) and
   asserts parity for several lanes.
8. **B8 (LOW) - a DeliveryBadge test title Task 10 made false; Global
   Constraints vs Task 5 on the Task 6 trigger.** CHANGE: Task 10 replaces
   `shows just the Failed label when no error code is supplied` with the D7
   "Delivery failed" test (which also keeps its `/error/i` absence check); the
   trigger is now stated once - Task 6 starts when the orchestrator's slice
   review is clean and it has reported the slice SHA; the planner's hand-off
   runs in parallel and the build never waits for it.

## Contested adjudications (round 1), resolved

- 3 (e2e coverage) - conceded; item (c)'s failed half is now covered by a
  deterministic test (above, 1).
- 5 (audit-failure path) - conceded; the remedy now has a command (6).
- 7 (census overstatement) - conceded; "exact" was wrong (5).
- 13 and 19 (red states; bumpStats) - conceded (4).
- 16 (RUNBOOK) - conceded; the new wording introduced the worktree hazard (2).
- 1 (lane selector) - upheld in substance by the reviewer; the parity pin is
  now real (7).

## Rejected

None.

## Deferred

None.

## Verified-correct v2 material (carried from the reviewer's report)

The lane selector's database identity; the census fixture counts against
`isSupersededRung`, `resolveUsableGroup`, the job's 1:1 lookup,
`retiredByTourStart` and `listDue`; the fix script's seven tests; the
`recipient` wrapper test needing no fixture change; Task 14 test 2's
no-consent path end to end; the `?cta=text` steady state; the prefill test;
the seed fixtures; and that no test depends on shares being automated.
