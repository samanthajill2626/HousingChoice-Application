# Plan review R3 - back half (head + S5-S9), plan v4 at 59183a22

Reviewer: adversarial plan reviewer, read-only. I read the round-2 diff
(`git diff b71f2b18 59183a22`) cold for sections 0-4 and 9-13, the Round 2
adjudications (PR40-PR44), and the S2/S3 text the new S5 code relies on.

**Verdict: nothing I found changes a decision.** The two findings below are
precision edits. I contest no ruling.

## Checked and found correct

- PR42, how a partial write is recorded. A batch whose call succeeded and
  that wrote at least one row goes in `batchesDone` AND gets a
  `failedBatches` entry. That entry lists only the candidates whose rows are
  not confirmed written, with failure `'repo'` (plan ~24754-24762).
  - The fake's `updateJobProgress` and S2's real one both append both lists
    in one write. S2 shares one `:empty` value between the two
    `list_append(if_not_exists(...))` clauses, which is legal.
  - The read's PR13 rule (`inLastJob`) marks only the listed candidates; the
    landed rows read as current.
  - S5's `finishedBatchCount` and S7's de-duplicate batch indexes, so the
    event never reports more finished batches than `batchCount`.
- PR42, the counts. The outcome now carries `unscored`, `omitted` and
  `written`. `runJob` adds the omitted counts of failed batches too, and
  splits `'repo'` losses ("N scores could not be saved") from other
  failures ("N tenants could not be scored").
  - S7's `notScoredCount` counts distinct candidates across `failedBatches`
    and `notScored`.
  - The e2e assertions were updated to the new copy ("Done: 1 batch",
    "Done: 1 batch; 2 candidates not scored"; plan 34763, 34818, 34872).
- R2B5. The finish write needs no guard read in front of it: S2's
  `finishJob` is already conditioned on `#status = :running AND
  #gen = :gen`. The "superseded after the last write" test proves a
  takeover's record is left alone. `isStopped()` still covers a lease
  renewal that was refused. The 500 ms sleep can be injected, and its
  default timer is unref'd.
- R2B7. `failure = call.ok ? 'repo' : call.failure`. A failed call is
  counted as "could not be scored", not "could not be saved".
- PR43. S3 sets `candidateIds` on the property path too (plan 15882, from
  the landlord read) and on the tenant path (15953). S5 handles either kind
  and picks the message for the anchor's kind. The read-side test mirrors
  PR38's.
- R2F6. `dev.ts` imports `loadConfig, tableName, type AppConfig` from
  `../lib/config.js` exactly as the anchor says (`app/src/routes/dev.ts:9`).
  The e2e lane's endpoint is `http://localhost:8000`
  (`scripts/e2e-session.mjs:144`), so the tick stays mounted there. The new
  404 test covers a non-local endpoint.
- R2B6. I recomputed all five `costRange` cases (for example, a lone `to`
  of 2026-10-04 gives a Monday 2026-09-28 and a `from` of 2026-07-13).
  `costRangeNote` matches the server's three filled cases.
- PR41 / C3. C3 is told apart from C1 correctly: the assistance animal plus
  "no pets" in `qualifications` means C3. Under PR40,
  `requirementItemOfField('qualifications')` is its own item, so an
  accommodation on `qualifications` lifts a failed `qualifications`, while
  one on a Pets key does not. That matches the two C3 test outcomes. The
  call count is 6 x 2 x 33 + 3 x 2 x 3 = 414, and stage two's worst case
  stays 660.

---

## R3-1 [LOW] [PRECISION] S8.4's passing case still expects 18 calls per direction; with C3 there are 21

Plan 37385, in "PASS, exit 0, the plan printed before the first call, both
directions run": the total was correctly updated to 42, but the next line
is still
`expect(driver.calls.filter((c) => c.direction === direction)).toHaveLength(18);`.

The SMALL suite has 1 pair x (6 base runs + 2 swaps x 3) = 12 calls per
direction, plus 3 controls x 3 runs = 9 per direction: 21. The test as
written cannot go GREEN. Fix: change 18 to 21.

## R3-2 [LOW] [PRECISION] RUNBOOK "Reading a ranking that went wrong" does not cover round 2's job messages

The S8.8 section (plan 38998-39010) still lists only the round-1 messages.
The operator gets no guidance for:

- PR42's "N tenants|properties could not be scored. Press Rank again." and
  "N score(s) could not be saved. Press Rank again." (a run or match write
  failed: a DynamoDB problem, not the model);
- PR36's "The ranking could not finish. Press Rank again." (the
  generation-check read failed twice);
- PR38 / PR43's "Could not read this tenant's|property's record. Press Rank
  again."

Its "not scored - retry" bullet also says "the run detail's raw output and
failure say which". That is not true after a `putRun` failure, which leaves
no run; the error log line holds the usage and cost. S8.8's copy
cross-check grep (`Pool too large to rank\|was not picked up\|...`) would
not catch the gap either.

Fix: add one bullet per message above, saying what each means and that a
"could not be saved" retry is safe. Fix the "not scored" bullet for the
`putRun` case. Add the new strings to the S8.8 cross-check grep.
