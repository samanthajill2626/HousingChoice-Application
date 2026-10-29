# B2a code review round 3 - orchestrator adjudications

Round 3 = one fresh re-reviewer on fix wave 2 and the dashboard area
(R3-dashboard.md): CRITICAL 0, HIGH 0, MEDIUM 0, LOW 3, INFO 2. FW2-1,
FW2-2, FW2-3, FW2-4, FW2-5, FW2-6, FW2-7 verified REAL (each new test fails
with only its own row reverted; FW2-4's hand-up resets nothing in an open
form or Staff notes edit and leaves the contact_type_changed path alone).
No adjudication overturned. The loop rule of R2-adjudications.md applies.

## FIX - fix wave FW3 (small)

| Id | Finding | Class | Fix |
|---|---|---|---|
| FW3-1 | R3-dashboard-1: FW2-1's wider "the job ended" also clears a refused press's own message (429, network error) when the first view of the anchor's old finished job lands | REGRESSION (FW2-1) | Clear the press error and the joined mark only when the FOLLOWED job ends (`wasLive` before the view, and not live after), computed before `wasLive` is overwritten; keep FW2-1's wider `ended` for the full read. Test: a refused press (429) whose message survives the first read's finished old job. |
| FW3-2 | R3-dashboard-2: `jobProgress` ranks the derived `expired` with done / failed, but a job claimed on a tick that straddles its expiry runs on in the same generation, so every later running view is dropped | REGRESSION (FW2-5) | Rank `expired` with `queued` (stage 0). Test: expired then running in one generation -> running applies and the poll continues. |
| FW3-3 | R3 INFO: the hook header and the press comment overstate the press path (a press takes its issue number when answered; a press's view of the generation already on screen is never applied; "read after the claim" is false for a join) | comment written by the fix waves | Make both comments exact. |
| FW3-4 | R3 INFO: two FW2 details have no pinning test (mutants of FW2-5's batch-count tier and of FW2-2's negative-age rule leave the suite green) | fix-wave tests incomplete | Add one test for each that fails on the mutant (describe the mutant in the report). |

## FILE

- Append to `rankings-page-hook-edges`: R3-dashboard-3 (NOT A REGRESSION)
  - a late job snapshot across GENERATIONS (FW2-5 orders within one
  generation only) can show the old generation's "Done", stop the poll and
  leave the page on events while a new generation runs; suggested fix:
  order views by the job record's (requestedAt, startedAt).
