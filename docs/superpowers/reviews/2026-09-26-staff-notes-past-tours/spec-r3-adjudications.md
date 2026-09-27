# Spec review round 3 - adjudications (TERMINAL round)

Spec: DRAFT 3 @d6b2922f -> DRAFT 4, APPROVED FOR BUILD (this round).
Reviewer: B continued (`spec-r3-reviewer-b.md`, 4 findings, all LOW; all R2
rulings conceded). Scope was the DRAFT 3 delta.
Planner: Fable, overnight unattended run.

Stop rule: round 3 changed NO decision - every finding is a precision edit -
so per the skill this is the terminal round: the edits are folded in and the
spec review stops (3 of the 4-round cap used).

Verification: the planner re-read `placements.ts:754-760` (finalize failure
residue) and `TourDetail.tsx:292` (`isConverted` on any string) before ruling
on R3-1.

| # | finding | ruling |
|---|---|---|
| R3-1 | "Needs placement" covers one of the states a failed conversion leaves; a `pending:` placeholder is excluded and its tour page links "View placement" to a non-placement (pre-existing); chip precedence for convertible-with-no-outcome undefined | ACCEPT (precision). 4.2 step 3 and Q3 name the placeholder state and why it stays excluded; `pastState` is defined in table order (no outcome -> "Needs outcome" first); filed `tour-conversion-pending-placeholder-view-link` (bug, low, pre-existing). The rule is NOT widened. |
| R3-2 | section 1 says a tour dated today stays on Active "marked or not", contradicting 4.2/Q9 | ACCEPT (precision). Section 1 reworded. |
| R3-3 | "no result is ever silent" depends on the reload succeeding; a failed reload would replace the list with the page error | ACCEPT (precision, mechanism added): a failed RELOAD keeps rows and results and sets `reloadFailed`; the page adds one alert line; only a failed FIRST load shows the page-level error. 4.2, 4.5, 5. |
| R3-4 | the snapshot must carry the raw ISO `scheduledAt` for the step 2c compare | ACCEPT (precision). The snapshot is the whole `Tour` per id; 4.5 step 1 and 2c say so. |
| R3-5 | all R2 rulings and R2-10/R2-11 residuals CONCEDED | Recorded. |

Reviewer B stays alive for the post-build re-review.
