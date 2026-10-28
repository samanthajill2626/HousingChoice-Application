# Planner review adjudications - permanent flyer links

Reviewed commit 3635160e (branch diff vs main 71fb9b45). Two opus reviewers,
independent: conformance.md (spec-anchored; 0 blocking, 1 medium, 1 low,
1 info) and adversarial.md (PLAN-BLIND; 0 blocking, 1 high, 3 medium, 3 low,
1 info). Rulings below are the planner's; "Q1" is the imported-unitId
question relayed to Cameron on 2026-10-28 (intent.md STATE).

| # | Finding | Ruling |
|---|---|---|
| PC-1 / PA-1 | Imported unitIds are computable from an address (public GitHub remote); with occupied now public, every imported Airtable "placed" home (imported as occupied) starts serving on deploy | Q1 - Cameron's decision. PA-1's bulk-flip-on-deploy framing is already in the handback (Your eye 5) and goes into the verdict next to Q1 |
| PC-2 | Four field comments still say "Shareable." for the flyer's set (unitsRepo.ts:481/483/485, unitFields.ts:418), against the new GLOSSARY entry | ACCEPT - comment-only, next fix wave |
| PC-3 / PA-2 | A non-Available flyer keeps "Same-day tours available", the RTA row, the "Interested in this home?" CTA and the "about this home" thank-you | REJECT as a code change - spec D3 and Cameron's answer "Drop listing link only" (2026-10-27) decided it; listed in the verdict for Sam's copy review |
| PA-3 | Nulling listing_link off Available tells a payload reader the home left Available; comments still claim the public learns nothing beyond holding the id | ACCEPT the comment correction (public.ts ~468/~873 comments, next fix wave); the behavior is D3a, Cameron's pick |
| PA-4 | Fallback sign-ups land as needs_review with no housing authority, and the authority backfill skips them (housing_fair_signup_v2 set) | No code change - recorded assumption (intent.md Assumptions). The backfill detail is new; it goes into the verdict for Cameron |
| PA-5 | Photos uploaded during occupancy are public with no staff cue | REJECT as a code change - Cameron accepted occupied homes keeping photos public (2026-10-27); noted in the verdict |
| PA-6 | "Public listing link" is tagged "On flyer" but shows only while Available | Already in the handback (Your eye 4); no change in this branch unless Cameron asks |
| PA-7 | public.ts:224 and :885 compare to the literal 'available' rather than the SHAREABLE set | ACCEPT if cheap in the next fix wave (use the existing constant); otherwise leave - single-status today |
| PA-8 | The only durable take-down is delete | REJECT - Cameron: "No new switch should be fine too. We don't need to turn this off." (2026-10-27) |

Decisions changed by this round: none outside Q1. The fix wave waits for
Cameron's Q1 answer so it runs once.
