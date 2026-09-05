# CloudFront maintenance page - spec adjudications

## Round 1

Reports: `spec-r1-reviewer-a.md`, `spec-r1-reviewer-b.md`, and `spec-r1-planner.md`.

Reviewer A returned no findings. Reviewer B returned two HIGH findings and one MEDIUM finding. The planner independently found the same 503 issue. Every claim was checked against the current worktree.

| Finding | Ruling | Reason and action | Decision changed |
| --- | --- | --- | --- |
| B1 HIGH and P1 HIGH: distribution-wide 503 removes semantic JSON | ACCEPT | Verified relay pre-provisioning refusals, the modal's `safeToRetry`, and push configuration classification. Limit fallback to 502 and 504; preserve every 503 status/body. Require a guard against adding 503 and retain typed-refusal tests. No new architecture or product regression is necessary. | Yes: remove 503 from fallback scope. |
| B2 HIGH: hosted acceptance lacks explicit substituted-body proof | ACCEPT as precision | The prior section 7 already required original-status fallback and recovery, but did not spell out the body assertion. Require a non-maintenance application URL, its selected status, Content-Type and unique page marker, then the same URL's recovery. Report configured but hosted substitution unverified until observed under separate dev authorization. | No: the existing hosted-fallback obligation is made measurable. |
| B3 MEDIUM: deploy only uses an origin-local probe | REJECT the factual claim; clarify wording | `scripts/deploy.mjs:552` does probe locally, but lines 652-658 separately gate through CloudFront and explicitly distinguish success of the instance-side health check. The original status-retention requirement is valid for that second gate. Section 2 and section 5 now name both stages to prevent ambiguity. | No. |

Round 1 changes one design decision. Continue reviewer B for a broad R2 review, including the revised copy/status contract and the rejected finding's evidence. No implementation or AWS action has been performed.

## Round 2 - terminal

Continued reviewer B reviewed the revised spec and adjudications, including the other review and planner finding. `spec-r2-reviewer-b.md` reports no actionable findings, confirms the 503 regression is avoided and hosted body proof is explicit, and concedes B3 after checking the separate CloudFront deploy gate.

No design decision changed in round 2. The review has converged under the mission stop rule. The spec is ready for the human's written-spec review gate. No plan, implementation, completion gates, merge, or AWS action has been performed.
