# Matching blast rules - plan review adjudications

Plan: `docs/superpowers/plans/2026-10-14-matching-blast-rules.md`.
Planner adjudicates every finding: ACCEPT (plan edited - rulings land in plan
section 4.1, which wins over slice text) / REJECT (why) / DEFER (filed).
Severity is the reviewer's; "decision changed" is the planner's.

## Plan round 1 (PLAN v1 @ccc32a88)

Two independent opus reviewers. A: whole plan + server seams
(`plan-r1-reviewer-a.md`, 6 findings: 1 MEDIUM, 5 LOW). B: dashboard + e2e
focus (`plan-r1-reviewer-b.md`, 8 findings: 1 MEDIUM, 7 LOW). Neither found a
BLOCKING or HIGH defect; A confirmed every spec decision maps to a task, all
S1 old_strings exist on the base, the Task 2.5 grep gate prints exactly 7
lines, S2's preview fields are what S3 reads and S3's copy is what S4
asserts. Three findings overlap (A5=B1, A6=B4, A1=B6).

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| B1 / A5 | The draft-delete e2e test (`broadcasts.spec.ts:398-440`) captures the FIRST create; the org-list prefill can supersede and delete it - an order-dependent gate failure | ACCEPT -> AR22 (repair the test: read the LAST create once Preview is enabled; add it to the inventory) | YES (new surface: a test repair) |
| B2 | The reach line can show a pre-prefill draft's count while Preview is gated | ACCEPT -> AR23: no draft is created while the prefill is unsettled (`hold` input on the draft hook; reach shows pending). This also removes B1's race at the source. | YES (behavior) |
| B3 | The new empty state flashes while units load; its test cannot tell loading from loaded | ACCEPT -> AR24 | no |
| B4 / A6 | The 503 alert is never cleared by an audience, message or property change | ACCEPT -> AR25 | no |
| B5 | A preview 422 landing after Change property rewrites the old property's edits and shows its notice under the new one | ACCEPT -> AR26: Change is disabled while a preview is in flight; `rejectAuthority` ignores a stale property id | YES (behavior) |
| A1 / B6 | AR19's lint-count update has no task and runs before the gate that measures it | ACCEPT -> AR27 (last step of Task 4.4, measured with `npm run lint`, two files, docs-only commit) | no |
| A2 | AR18 binds sync-first but Task 4.4 Step 0 says "MAY" | ACCEPT -> AR28 (MUST) | no |
| A3 | S1 preflight says ask before `db:start`, contradicting AR2 | ACCEPT -> AR29 (start, never restart) | no |
| A4 | S2's command blocks are PowerShell with no label | ACCEPT -> AR30 | no |
| B7 | Task 4.1's closing grep expects one Tasha line; 3h adds a second | ACCEPT -> AR31 | no |
| B8 | The binding truncation message states the recipient cap, not the read bound | ACCEPT -> AR32 (drop the number) | no |

0 rejected. Round 1 changed decisions (AR22 surface, AR23 and AR26
behavior), so round 2 runs: reviewer B continued (it landed more accepted
findings) with A's report handed over and the re-review charge.
