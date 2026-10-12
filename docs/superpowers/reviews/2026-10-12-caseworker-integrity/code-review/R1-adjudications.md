# Code review R1 - orchestrator adjudications

Round 1 on `fix/caseworker-integrity` @f11e46fb (base 19607658). Three
read-only opus reviewers in parallel:

- `R1-conformance.md` - spec conformance: 190 rows, all CONFORMS; 6 INFO.
- `R1-adversarial-backend.md` - plan-blind, app/: 0 BLOCKER, 0 HIGH, 0 MEDIUM,
  2 LOW, 8 INFO.
- `R1-adversarial-dashboard.md` - plan-blind, dashboard/ + e2e/: 0 BLOCKER,
  0 HIGH, 1 MEDIUM, 5 LOW, 5 INFO.

Gates on the reviewed commit (orchestrator, bare): typecheck 0, smoke 0,
npm test 0, e2e 0 (345 passed, 22.5 min); lint gate 5 = exactly the two
pre-existing baseline errors.

Every CONFIRMED claim below that rests on tree behavior was re-checked by the
orchestrator in code where the ruling depends on it (B1: `unitsRepo.addContact`
re-reads and re-decides per attempt; D1: `addContact` never auto-promotes a
non-primary row, so the resolvers' `primary ?? landlordId` rule stays empty).

## Dispositions

| # | Finding | Sev | Ruling | Fix wave |
|---|---|---|---|---|
| B1 | Contact-list add decides I4 (new seat) and I3 (vacant claim) on the route's read; `addContact` re-reads and re-decides per attempt without either rule - two confirmed races (a concurrent DELETE re-seats a caseworker as a new primary row; a concurrent restore `{landlordId: null}` lets a tenant claim the slot) | LOW | FILE `contact-list-checks-outside-roster-write-loop`. The route-side decision is the plan's ruled design (ruling S4-1, "L1 class"; the spec prescribes "both before the repo call"); closing it moves the rule into the shared roster write and its fake - a design change for Cameron, not a defect of this build | issue |
| B2 | `restoreWithLandlord` neither checks nor conditions on the unit still being soft-deleted, so a racing plain restore lets the landlord of a LIVE property be swapped or cleared through restore (reproduced on DynamoDB Local) | LOW | FIX. New code contradicting its own contract ("restore must never become a way to reassign a live property's landlord"); small and contained | FW-1 |
| B3 | `transitionPlacement`'s terminal-exit check is decided on a read its stage write is not conditioned on; a concurrent move (not only read lag) defeats it | INFO | FILE (append to `placement-terminal-stage-exit-unguarded`: the fix is a `stage = :from` write condition, which changes every transition's concurrency semantics) and FIX the RUNBOOK clause wording | FW-2 |
| B4 | `restoreWithLandlord`'s "old landlord was primary by the scalar alone" rule is untested on the real repo (mutant survives 9/9) | INFO | FIX (test only) | FW-3 |
| B5 | The lost-acknowledgement path's `superseded_by_reclassification` answer is untested (mutant survives) | INFO | FIX (test only) | FW-4 |
| B6 | A contacts routing-pointer row named as a tour/placement tenant answers 409 `contactKind: "undefined"` instead of 404 | INFO | FIX: the guards treat pointer rows (no `type`) as not found, using the codebase's existing pointer detection; `contactKind` never stringifies an absent type | FW-5 |
| B7 | `TENANT_ONLY_TARGETS` is a literal copy of extraction's tenant-fact rule; a new extractable field would drift silently | INFO | FIX (test only): a drift guard - every extractable target plus `status` is classified exactly once as tenant-only or neutral (`firstName`, `lastName`, `phone`, `address`) | FW-6 |
| B8 | The legacy fallback also refuses a pre-deploy journal on a contact converted and later re-typed back to tenant (it keeps `caseworker_conversion`) | INFO | FIX (comment only): name it in `effectiveGuard`'s known limits (fails safe; population about zero) | FW-7 |
| B9 | `services/contactTypeGuards.ts` imports Express's `Response` type and writes HTTP answers | INFO | REJECT: plan section 2 binds `sendContactTypeError` to this module; the import is type-only. Noted for the handback | - |
| B10 | Restore answers two shapes, and a landlord choice the server ignores (the plain restore applies) is not flagged in the 200 | INFO | REJECT the wire change (spec section 4: a body is ignored when the plain restore applies; the dashboard applies both shapes); the dashboard-side visibility is filed with D3 | issue |
| D1 | The ownerless "Remove the primary contact?" sentence (planner ruling Q2) names the wrong remedy: "+ Add contact" always posts `primaryContact: false`, so adding anyone but a Landlord leaves no primary and no landlordId - nobody becomes reachable | MEDIUM | QUESTION Q3 to the planner - the sentence is a planner ruling ("exact"); recommend the reviewer's wording | pending |
| D2 | "so they must stay a landlord" (spec section 3's sentence) is shown when the landlord of record is typed unknown / tenant / partner (pre-branch or importer data only) | LOW | REJECT for this branch: spec-approved copy; reachable only on data that already violates I3 (L2). FILE in `contact-type-refusal-copy-edge-cases` | issue |
| D3 | The restore dialog closes as a success when the server ignored the choice (the old landlord became a landlord again between the 409 and the click) | LOW | FILE in `contact-type-refusal-copy-edge-cases` (rare race; the page then shows the real landlord; telling staff needs new copy) | issue |
| D4 | Any other plain-restore failure (404, 500) is still a dead click on the banner Restore | LOW | FILE in `contact-type-refusal-copy-edge-cases` as pre-existing (spec section 4 / W7: "any other failure keeps each site's current copy") | issue |
| D5 | The restore dialog swallows a failed landlords read: the picker is silently empty and the only live action is "Restore without a landlord" | LOW | FIX: a load-error `role="alert"` reading "Couldn't load the landlords." (the house "Couldn't load <thing>" pattern) | FW-8 |
| D6 | The Unknown card's two contact-isolation guards (`ContactDetail.tsx:686` generation guard, `:292` reset) are untested (both mutants survive) - also in the S2 report | LOW | FIX (test only) | FW-9 |
| D7 | The edit form's per-save refusal reset (`ContactEditForm.tsx:498`) is untested (mutant survives) | INFO | FIX (test only) | FW-10 |
| D8 | The restore dialog is not bound to the property it opened for (survives an in-place `/listings/A -> /listings/B` move and posts against B) | INFO | FIX for the new dialog: reset its state when the unitId changes. FILE the pre-existing twin (`confirmingDelete`, "Delete property?") as `listing-detail-dialogs-survive-property-navigation` | FW-11 + issue |
| D9 | Two new unit tests drive refusals on paths the server never refuses (TourDetail runDirect "Mark toured"; PlacementsPage open-to-open move) | INFO | FIX (test only): drive the PlacementsPage case from a lost row in the closed view; label the TourDetail case as a defensive-mapping test | FW-12 |
| D10 | The restore sentence says "no longer a landlord" when the stored landlord contact no longer exists | INFO | REJECT for this branch (spec-approved dialog sentence; rare - contacts soft-delete). FILE in `contact-type-refusal-copy-edge-cases` | issue |
| D11 | A non-tenant's tenant-fact chip still offers an Accept that can only be refused | INFO | REJECT: spec D1.2's design (refused, chip kept, "Dismiss it instead") | - |
| C-INFO 1-6 | Conformance observations (legacy fallback fails safe; #19 live in prod; plain restore unconditioned by ruling S4-2; two restore shapes; FakeWorld-only D1 cases by plan; one main sync owed) | INFO | Recorded for the handback; INFO 2 becomes a post-deploy RUNBOOK note | - |

Issues the fix wave files: `contact-list-checks-outside-roster-write-loop`
(B1), `contact-type-refusal-copy-edge-cases` (D2, D3, D4, D10),
`listing-detail-dialogs-survive-property-navigation` (D8's pre-existing twin);
and one appended paragraph on `placement-terminal-stage-exit-unguarded` (B3).

## Question sent to the planner (2026-10-12)

- Q3 (D1): the Q2 sentence "This property will have no primary contact and
  has no landlord of record, so calls and new relay groups for it will reach
  no one until a contact is added." is still inaccurate on its remedy. The
  reviewer's wording: "...will reach no one until someone on its contact list
  is made the primary contact or a landlord is added." Recommendation: adopt
  it (or a wording the planner prefers) in the fix wave - the string, its two
  test pins, the selectors row and the comment above `promotionNotice`.
