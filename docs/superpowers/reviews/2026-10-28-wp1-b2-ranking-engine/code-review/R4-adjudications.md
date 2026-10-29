# B2a code review round 4 - orchestrator adjudications

Round 4 = one fresh re-reviewer on fix wave 3 (R4-dashboard.md): CRITICAL
0, HIGH 0, MEDIUM 0, LOW 2, INFO 2. FW3-1, FW3-2, FW3-4 verified REAL by
reverting each; FW3-3's comments match the code; no defect inside the FW3
diff. The loop rule of R2-adjudications.md applies.

## FIX - fix wave FW4 (micro)

| Id | Finding | Class | Fix |
|---|---|---|---|
| FW4-1 | R4-dashboard-1 (LOW, CONFIRMED): with a straddled expiry the page shows "expired" (no poll); the "Press Rank again" press joins the job now running and the press gate drops its running view, so the page is stuck until an event or a reload | REGRESSION (R3-dashboard-2's second half, left by FW3; the gate came in with FW1) | Apply the press's job view through the ordinary `applyJob` with a fresh issue number (R4's verified one-line change), so the within-generation progress rule decides; drop the separate gate. Regression test = R4's probe P1 (stuck without an event) plus P1b. |
| FW4-2 | R4-dashboard-4 (INFO): two FW2-era comments are inexact (loadRead's "never over a press"; "a generation the page has not shown" should read "other than the one on screen") | comment accuracy | Make the comments exact (and the header lines FW4-1 changes). |

## FILE (NOT A REGRESSION)

- Append to `rankings-page-hook-edges`: R4-dashboard-2 (the followed job
  ends unseen and a new generation that is still queued or running
  replaces it on screen; the old job's end is never counted, so its last
  batches are not read until the new job finishes a batch or ends, and the
  joined mark moves to the new job; R4's verified fix: count the job on
  screen being replaced by another generation as the followed job's end)
  and R4-dashboard-3 (item 3's second path: the first read, sent before a
  press the server refused with 409, can clear the 409 message; item 3's
  suggested fix covers it).

## Convergence

The hook has had four review rounds; each found less (R1 MEDIUM, R2 three
regressions, R3 two, R4 one incomplete fix). FW4-1 is the one-line change
R4 itself proposed and probe-tested on a scratch copy (rankings 123/123
plus its probes). The orchestrator verifies FW4 by hand (diff read, the
hook and dashboard suites, the rankings e2e spec, live self-QA) instead of
a fifth fresh round; anything newly found after it is filed.
