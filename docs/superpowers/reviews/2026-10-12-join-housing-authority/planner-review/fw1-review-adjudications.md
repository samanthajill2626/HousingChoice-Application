# Planner fix wave 1 - review adjudications (orchestrator)

Review: `fw1-review.md` (fresh opus reviewer on the fix diff 09acd16b..e16d408b): 0 CRITICAL,
0 HIGH, 3 MEDIUM, 4 LOW, 5 INFO; FW-2..FW-5 CONFORM, FW-1 PARTIAL; 31/31 backfill mutants and
16/17 dashboard mutants killed. The orchestrator's own read of the unit A diff had flagged
F1 independently (ledger O-2) before the review returned.

| Id | Sev | Disposition |
|---|---|---|
| F1 (= O-2) | MEDIUM | FIX (micro wave FW-1b). A --skip lead must never depend on a read: its reason is `skipped` whatever the reads say, it is never listed under the targets header, and on `--apply` a failed history read still attempts the exclusion append (a possible duplicate event is harmless; the record is the safety). Only a failed APPEND makes it fail (exit 1). A dry run does not read a --skip lead at all. |
| F2 | MEDIUM | RUNBOOK wording now (option b), OPEN QUESTION for Cameron on option (a). The report reason text is spec revision 5's exact string and stays. The RUNBOOK's pending-suggestion bullet gains: if the pending value IS Atlanta Housing Authority and staff judge it wrong, dismissing it does NOT keep the backfill away - set the lead's real authority on its contact page, or name it in `--skip` on the next apply. Option (a) - also leave out a lead holding a dismissal of Atlanta Housing Authority (one more GetItem per would-be target) - is a new left-out rule beyond the planner's complete list, so it is Cameron's call. |
| F3 | MEDIUM | DONE BY THE ORCHESTRATOR (it was always its step): the lane rehearsal re-runs with the new behavior and its expected and actual output go verbatim into `planner-review/backfill-rehearsal-2.md`. The plan's Task 6.3a text describes the pre-fix-wave behavior and is superseded by that record (the plan is not edited). |
| F4 | LOW | FIX (micro wave): "its exclusion may not have been recorded" - the same honesty FW-3 gave writes (an append can land and then error). |
| F5 | LOW | FIX (RUNBOOK wording): only CANDIDATES named in `--skip` are remembered; a `--skip` id naming a non-candidate (for example a deleted lead) is reported and not remembered - name it again if it ever becomes a candidate (a restored lead). |
| F6 | LOW | ACCEPT and note (beside spec D10's accepted edges): a staff accept in flight, or one whose process died after claiming the suggestion (the `resolve#` journal), is invisible to the pending read for that window; the backfill can then write Atlanta and the accept is refused as superseded. Needs an accept in flight or crashed during the run; recorded in the fix-wave handback. |
| F7 | LOW | FIX (micro wave): a negative test on a housing authority "Not on the list" row for a settle that adds no entry (Use or Clear) - must fail with the `settle.action === 'add'` clause removed. |
| I1-I5 | INFO | NOTED. I1 (the kind-change note can flash while usage loads) accepted - the note is true until the dialog learns the move is blocked. |
