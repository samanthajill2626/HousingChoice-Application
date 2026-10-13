# Planner live QA - caseworker integrity (2026-10-13, independent of the build)

Tip under test: 54599c02 (product code e79e408d). Hermetic lane 6 via
`npm run e2e:session` from the worktree, driven with the Playwright MCP as the
dev admin; fixtures created through the lane's own API (never the live
:5174/:8080 stack). Lane stopped afterwards with `npm run e2e:stop` (exit 0,
lane tables dropped). Focus: the behavior that changed AFTER the
orchestrator's self-QA (self-qa.md S1-S8) - the planner's final fix waves FWF
and FWF2 - plus "Restore with this landlord", which no live pass had driven.

Setup: landlords Lena Planqa and Omar Planqa; two properties owned by Lena,
both soft-deleted; Lena re-typed to tenant through the contacts PATCH ->
200 (allowed: her only properties are deleted - the live-unit-only type
change rule).

| # | State | Measured result | Verdict |
|---|---|---|---|
| Q1 | 202 Planner QA St (deleted, landlord Lena now a tenant): banner Restore | Plain restore -> 409 (console); the "Restore property" dialog: "Lena Planqa is no longer a landlord, so they can't stay this property's landlord. Choose its landlord:", combobox "Landlord", Cancel / Restore without a landlord / Restore with this landlord (disabled until a pick) | PASS |
| Q2 | Type "Omar" in the picker | Options: exactly "Omar Planqa - Landlord" (Lena, now a tenant, is not offered - landlords only) | PASS |
| Q3 | Pick Omar, "Restore with this landlord" | Dialog closed; deleted banner gone; Contacts card "Omar Planqa (primary) Landlord". Stored: deleted_at absent, landlordId = Omar, primary_contact = Omar, contacts = [Omar, landlord, primary] - Lena's row removed | PASS (spec section 4 Restore, with a landlord) |
| Q4 | 101 Planner QA St (deleted, landlord Lena a tenant): Restore -> dialog open; meanwhile Lena re-typed back to landlord through the API (200); then "Restore without a landlord" | Request body `{"landlordId":null}` -> 409 `{"error":"restore_landlord_not_needed"}`; the dialog closed; the page shows exactly "This property's landlord changed while you were choosing. Choose Restore again."; stored: still deleted, landlordId still Lena, contact list unchanged (nothing written) | PASS (FWF2 R2-1 - no loop, explicit choice not overridden) |
| Q5 | Banner Restore again | Plain restore 200, no dialog; property live with Lena as landlord of record and primary; the stale sentence cleared | PASS |

Not re-driven here (covered by self-qa.md live states and by e2e specs that
passed in both the orchestrator's and the planner's full gate runs): the
team-member chip refusal and buttons, the Unknown card refusal, the edit-form
refusal at 360 px, auto-primary (landlord-typed only), the ownerless notice
copy, the landlord-list load failure.
