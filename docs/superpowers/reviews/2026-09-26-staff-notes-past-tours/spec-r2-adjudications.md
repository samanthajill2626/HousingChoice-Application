# Spec review round 2 - adjudications

Spec: DRAFT 2 @212020f0 -> DRAFT 3 (this round).
Reviewer: B continued (`spec-r2-reviewer-b.md`, 9 findings + 2 concessions),
re-review charge; reviewer A's R1 report was handed to it.
Planner: Fable, overnight unattended run. Every ACCEPT below is the planner's
call; product-shaped ones are in the spec's section 9.

Verification: the planner re-read `apply.ts:452-466` (the direct-write
patch), `tours.ts:1350-1380` (the terminal sweep) and confirmed react-router
7.18.0 is the installed version; reviewer B's react-router line citations were
read from its report, not re-opened.

Counts: 9 findings -> 9 ACCEPT (4 changed a decision), 0 REJECT, 0 DEFER; the
2 contested R1 rulings were CONCEDED by the reviewer, with two residual notes
accepted.

## Decision-changing accepts

| # | finding | ruling |
|---|---|---|
| R2-1 | the pre-read guard checks status only; a tour rescheduled since the list loaded (scheduled -> scheduled, or no_show -> scheduled) is marked toured, its fresh reminders deleted, a false milestone written, then it vanishes from every list | ACCEPT. The guard is now "current status is `scheduled` AND current `scheduledAt` equals the listed one"; the eventually consistent GET is named; the above-toolbar block reports EVERY result whose row the reload dropped, successes included. Spec 4.5, 4.7, 9 Q14 (with the same-time revival residual named). |
| R2-2 | stripping `?outcome=1` with a replace navigation resets `location.state` to null, so the back arrow returns to /tours on exactly the Record-outcome path; the spec's own e2e step fails | ACCEPT. The strip passes `state: location.state` and runs only when the param is present; the unit test mounts with both the param and `state.back`. Spec 4.6, 5. |
| R2-3 | `to = now` hides a tour marked toured or no-show BEFORE its scheduled time today | ACCEPT. `to` = end of today local (start of tomorrow minus 1 ms, calendar arithmetic); step 2 already drops today's scheduled rows so nothing double-lists. A tour marked on a FUTURE date stays invisible until that date, stated. Spec 4.2, 9 Q7, Q9. |
| R2-4 | the toured-with-outcome exclusion also hides a failed move_forward conversion, which the Past tab's own Record-outcome path can now produce | ACCEPT. A toured row with an outcome is kept when `convertible === true` and no `convertedPlacementId`: chip "Needs placement", no row action (the tour page's CTA is "Start placement"). not_a_fit stays excluded. Spec 1, 4.1 intro, 4.2 step 3, 4.3, 4.4, 9 Q3. |

## Precision accepts

| # | finding | ruling |
|---|---|---|
| R2-5 | "Could not mark toured: Could not mark toured"; the above-toolbar block needs labels captured before the reload | ACCEPT. Message is "The update failed"; the runner snapshots tenant, property and date-time per id at batch start. Spec 4.5. |
| R2-6 | 4.4 overclaims that the row button's name "never collides" with the bulk button | ACCEPT. Reworded: distinct under exact or anchored matching only; every test locates the bulk button by an anchored name. Spec 4.4, 5. |
| R2-7 | contact-detail.spec holds no Edit-dialog locator; the builder introduces one | ACCEPT. Spec 5 says "introduces", both sites. |
| R2-8 | applyExtraction also commits a direct-write patch; the planned test checks one call | ACCEPT. 3.4 names both patches; the test direct-writes AND appends and asserts no update call carries either key. Spec 3.4, 5. |
| R2-9 | glossary: Unit `notes` still says "INTERNAL staff notes"; the entry says the stamp renders unconditionally; 3.8 says "contact vocabulary" | ACCEPT. All three fixed (`documentation/GLOSSARY.md`; spec 3.8 says "under Feature & label notes"). |

## Contested rulings

| # | ruling |
|---|---|
| R2-10 | B4 deferral CONCEDED. Residuals accepted: Q10 now rests the deferral on cost and the undated-row placement rule, not on the mission's literal text; the intro copy is left as is and Q10 says it does not carve the undated case out. |
| R2-11 | A18 reject and A4 defer CONCEDED. No change. |

## Stop rule

Round 2 changed four decisions, so a round 3 runs (hard cap 4). Its scope is
the DRAFT 3 delta: the two-part guard, the state-preserving strip, the
end-of-today window, and the "Needs placement" row.
