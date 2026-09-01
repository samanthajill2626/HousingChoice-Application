# Plan adversarial review - round 4 adjudications (HARD CAP; review CLOSED)

Reviewer C, continued. Report: `plan-r4-reviewer-c.md`. 6 findings.

**Outcome: 6 ACCEPT, 0 rejected. All applied. The plan review is CLOSED
without a round 5.**

## Why closing here is the right call, and not a quiet overrun

The skill's rule is a hard cap of four rounds, and "still changing
decisions at round 4 means the design is not converging: STOP and put it to
the human as a decision, with the open findings."

Round 4's verdict was **(B) NOT TERMINAL - but NOTHING needs a human**: one
finding above precision, all six mechanical plan edits with the exact
replacement text supplied, none reopening a decision, and the reviewer
stating plainly that it would not spend a fifth round.

So the cap is honoured as written: **no round 5.** The six edits are
applied and the review is closed. This is recorded rather than glossed,
because "the last round was not terminal" is exactly the fact a reader
deserves to see stated rather than inferred.

## Accepted

| # | finding | verdict |
|---|---|---|
| 1 HIGH | **S5's probe never names the table it describes, and only 4 of 22 specs carry `ttlAttribute`** (`tables.ts:231`, `:246`, `:615`, `:648`; guard at `dynamoAdmin.ts:117`). The likeliest pick reports DISABLED in BOTH arms - and the plan's own escape hatch then deletes a TRUE issue and writes a FALSE finding into the handback | ACCEPT. **Fourth consecutive round on this same probe, and this time in the opposite direction**: round 3 fixed a false ENABLED/ENABLED contrast, round 4 catches a false DISABLED/DISABLED one. The table is now named (`messages`), and the plan says why a DISABLED reading is only meaningful on a TTL-bearing table. The escape hatch was added to keep the mission honest; unqualified, it would have produced the exact dishonesty it was meant to prevent. |
| 2 MEDIUM | The liveness fix transcribed only the PID half of `otherLiveRuns` - the 6h `MARKER_BACKSTOP_MS` filter against recycled pids (`testRunRegistry.ts:42-48`, `:110-115`) and the all-digit filename filter (`:104`) are missing, and both fail in the OVER-counting direction the fix existed to close | ACCEPT. Round 3 replaced a raw count with a partial reimplementation, which is the same defect wearing a better disguise. All three filters now transcribed explicitly. |
| 3 MEDIUM | The exported poll's exhaustion contract contradicts its own signature - it is called `pollUntilActive(client, physicalName)` yet required to rethrow an original `ResourceInUseException` it cannot see, and case 17 names no error type | ACCEPT. Split across the two layers where the information actually lives: the poll throws its own error naming table and status; `ensureTable`, which holds the original exception, catches that and rethrows the `ResourceInUseException` with the status appended. Case 17 asserts the POLL's error. |
| 4 LOW | S7.2's item 2 was retitled but not converted to a back-reference, and nothing verifies the slug shipped in S3.3's SKIP string matches the filename S3 actually files | ACCEPT. A wrong slug in a user-facing message is worse than none; a verification step now exists. |
| 5 LOW | The stub contract still lists the superseded "per-command call counters" bullet alongside the new sends-vs-hook-calls requirement | ACCEPT. Superseded text left in place next to its replacement is how a builder picks the wrong one. |
| 6 LOW | The tautology watch item still says "three revisions running", though the pattern was made explicit a round later | ACCEPT. Updated to four, and a second watch item added for the round's real theme - a fix introducing a defect of the class it closed, which happened in three consecutive rounds. |

## The two deletions, upheld - and one for a better reason than I gave

The reviewer was asked to attack both round-3 deletions and upheld both:

- **The poll's endpoint gate should go**, but the stronger argument is not
  the one the plan made ("unreachable dead code"). It is that the poll
  issues a `DescribeTable`, and the spec's own disposition rule already
  excludes READS from gating - so gating this one read and no other was an
  inconsistency, not merely dead weight. Worth recording: a right decision
  held up by a weaker reason than the one available.
- **The describe-2 narrowing is right.** `buildWith`
  (`staticSmoke.test.ts:178-187`) is called only inside each `it`, so its
  `distDir` reference resolves after a file-scoped `beforeAll`.
  Restructuring it would have been churn on working code.

## Convergence

| round | reviewers | findings | accepted | above LOW |
|---|---|---|---|---|
| 1 | 2, independent | 38 | 38 | 2 blocking + 12 |
| 2 | 1, continued | 15 | 15 | 2 blocking + 5 |
| 3 | 1, continued | 12 | 12 | 2 |
| 4 | 1, continued | 6 | 6 | 1 |

Monotone decline in volume and in severity. **71 findings, 71 accepted, 0
rejected across the plan review; 83/83/0 across the spec review.** The
plan is v5 FINAL.
