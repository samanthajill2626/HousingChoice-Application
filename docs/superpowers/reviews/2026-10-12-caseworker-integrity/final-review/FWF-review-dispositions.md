# Orchestrator's FWF re-review - dispositions (2026-10-13)

`FWF-review.md` (one fresh opus reviewer on the FWF diff 437686d6..1358fb42,
run beside the p8 gate battery, terminal rule) reported 1 MEDIUM, 1 LOW, 6
INFO; every FWF fix REAL by mutant. The planner's own round-2 re-review
(`adjudications.md` "## Round 2") reached the same MEDIUM independently; the
planner's rulings are final and the overlapping items are handled there.
Gates on 1358fb42 (p8, bare): typecheck 0, smoke 0, npm test 0 (app 9541 +
1 skipped, dashboard 4479, e2e-ws 503, fake-twilio 275, fake-twilio-web 111),
e2e 0 (346 passed, 24.9 min).

| # | Finding | Sev | Disposition |
|---|---|---|---|
| F1 | The FWF-1 late-body 409 `unit_roster_conflict` loops when the stored landlord became a landlord again (dialog says "try that change again" forever) | MEDIUM | = planner R2-1: FIX in FWF2 (distinct 409 `restore_landlord_not_needed`, dialog closes, page sentence) |
| F2 | FWF-4 closes the review only on `suggestion.updated` (a conversion), not on a generic re-type | LOW | = planner R2-2: comment + issue append in FWF2 |
| F3 | In the A3 race, the FWF-2 settle re-read removes the refused row, and its sentence goes with it | INFO | Recorded (the page then shows the true list; no action) |
| F4 | `addContact`'s re-read after a lost write and `removeContact`'s reads stay eventually consistent | INFO | = planner R2-4: addContact's re-read made consistent in FWF2; removeContact noted in `contact-list-rule-duplication-and-fake-drift` |
| F5 | A soft-deleted landlord-typed contact added with the Landlord role still claims the landlord of record (the I3 claim is type-only) | INFO | = planner R2-3: DEFER, appended to `auto-routing-changes-not-named` |
| F6 | A plain restore of an already-live property writes a second `unit_restored` audit row (predates the branch) | INFO | Recorded in the handback as pre-existing; no action |
| F7 | The `addUnitContact` doc (`dashboard/src/api/endpoints.ts` ~:1068-1073) still states the revision-5 auto-primary rule | INFO | FIX (doc) in FWF2 |
| F8 | A review closed while its own "Yes, add it" is in flight still sends the accept when the add returns (the server refuses it; no plain PATCH follows) | INFO | Recorded (fails safe); no action |
