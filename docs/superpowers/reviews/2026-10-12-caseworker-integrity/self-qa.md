# Self-QA - caseworker integrity (orchestrator, live)

Driven by the build orchestrator on the hermetic lane 6 (`npm run e2e:session`,
dashboard http://127.0.0.1:9611, StrictMode dev build) at
`fix/caseworker-integrity` @dfd1dff4, 2026-10-12 ~22:58-23:10 EDT, with the
project Playwright MCP (`browser_run_code_unsafe`, measured facts, not
eyeballed). Fixtures came from the real API as the VA, inbound SMS through
the signed webhook (the fake extraction driver), and ONE direct DynamoDB Local
write with the lane's own key (S3: a legacy-shaped `unknown` landlord of
record, which no API path can create any more). Screenshots are run artifacts
in the worktree's ignored `.playwright-mcp/` (names below).

The states were chosen where automated coverage is thinnest: the plan's S5
list of what its e2e does NOT drive (the Unknown card, the team-member file,
the D1 chip in the UI), plus the build's later additions (planner Q1, Cameron's
SA-1 / Q4 / Q5, fix wave 1's load error) and 360 px layout.

| # | State | Measured result | Verdict |
|---|---|---|---|
| S1 | A TEAM MEMBER (re-typed from tenant) with a pending housing-authority chip "Atlnta Housing" (not on the list); Accept | Network: the PLAIN accept `POST /api/contacts/:id/suggestions/housingAuthority/accept` -> 409 (browser log). The chip's alert reads exactly "This contact isn't a tenant, so this can't be applied. Dismiss it instead."; no "Is this really new?" dialog; Dismiss enabled; the stored `housingAuthority` stays empty; type stays `team_member` | PASS (planner Q1 / Task 1.11, D1) |
| S2 | The same team member's file | 0 "+ Schedule" and 0 "+ Start placement" controls | PASS (D3 team members) |
| S3 | A legacy `unknown` contact that is the landlord of record of a LIVE property; the Unknown card's "Mark as Tenant" | Card offers Mark as Tenant / Landlord / Partner / Caseworker / Property Manager. PATCH -> 409 `{ error: 'type_change_refused', refusals: [{ code: 'landlord_of_record', unitId }] }`; the card's alert: "This contact is the landlord of record for a property, so they must stay a landlord. Changing a property's landlord isn't available in the dashboard yet." + "View property" -> `/listings/<that unit>`; stored type stays `unknown`. 360 px: page scrollWidth 360 = clientWidth (the card sits behind the Profile switch there) | PASS (D2 Unknown card; the "must stay" wording on an `unknown` is filed copy edge D2) |
| S8 | A tenant with an open placement AND an open tour; edit form Tenant -> Landlord, at 360 px | PATCH -> 409 with `[open_placement, open_tour]` in that order; two sentences ("Finish or close this contact's placement first." / "Cancel or close this contact's open tour first.") with "View placement" -> `/placements/<id>` and "View tour" -> `/tours/<id>`; the Landlord segment stays `aria-pressed="true"` (draft kept); nothing written. 360 px: dialog 16..344 px (16 px gutters), list items 50..295, page scrollWidth 360 = clientWidth (the only "overflowing" nodes are 1 px screen-reader-only labels, by design) | PASS (D2 edit form, layout) |
| S4 | Cameron's Q5: a deleted property whose landlord of record (primary) was re-typed to tenant, with ONE landlord-typed PM left; banner Restore at 360 px, then "Restore without a landlord" | Plain restore -> 409 `{ restore_needs_landlord, landlordName }`; the "Restore property" dialog shows the spec's sentence with the old landlord's name and the three buttons stacked inside 33..327 px; dialog 16..344, scrollWidth 360. Then 200 with the roster `[PM, pm, primary]`; the Contacts card shows "<PM> (primary)"; stored: `deleted_at`, `landlordId` gone, `primary_contact` = the PM. Activity: "unit_restored" (the audit fields are not projected - filed) | PASS (spec rev 5 sole-landlord promotion) |
| S5 | Cameron's Q4 + SA-1 on an ownerless, primary-less property: "+ Add contact" a TENANT (role other), then a landlord-typed PM | Both POSTs send `primaryContact: false`. The tenant joins NON-primary (its "Make ... the primary contact" is offered); the PM becomes primary (no Make primary on its row; `primary_contact` = the PM; the tenant still non-primary) | PASS (spec rev 5 auto-primary, landlord-typed only) |
| S6 | Remove that primary PM (no landlord of record) | "Remove the primary contact?" reads exactly Cameron's SA-1 sentence: "This property will have no primary contact and has no landlord of record, so calls and new relay groups for it will reach no one until someone on its contact list is made the primary contact or a new contact is added."; Cancel removed nothing | PASS (SA-1 copy) |
| S7 | The restore dialog when the landlords list fails to load (the page's `GET /api/contacts?type=landlord` forced to 500 by route interception), under StrictMode | Exactly ONE alert "Couldn't load the landlords." (the double effect's aborted read adds none; S4 showed none when the load succeeds); "Restore with this landlord" disabled; "Restore without a landlord" enabled; Cancel wrote nothing (still deleted) | PASS (fix wave 1 FW-8 / R2 A3) |

Not repeated live (each is driven end to end by the branch's own e2e specs,
green in every full run): the edit-form refusal at desktop width, the Add
contact picker hiding a caseworker, restore with / without a landlord on an
empty list, the tour Reopen dialog's refusal, a placement moved out of Lost.

Artifacts (ignored, `W:\tmp\caseworker-integrity\.playwright-mcp\`):
`selfqa-s1-teammember-ha-chip.png`, `selfqa-s3-unknown-card-refusal.png`,
`selfqa-s3-unknown-card-refusal-360.png`,
`selfqa-s8-editform-two-refusals-360.png`, `selfqa-s4-restore-dialog-360.png`,
`selfqa-s4-restored-pm-primary.png`,
`selfqa-s5-q4-tenant-not-primary-pm-primary.png`,
`selfqa-s6-ownerless-notice.png`, `selfqa-s7-restore-dialog-load-error.png`.
The fixture script lives in the session scratchpad (`selfqa/setup.mjs`).

Result: 8/8 PASS; no defect found live.
