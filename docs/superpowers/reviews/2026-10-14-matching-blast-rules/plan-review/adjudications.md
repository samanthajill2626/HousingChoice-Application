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

## Plan round 2 (plan @fdda1242 -> rulings AR33-AR38, plan section 4.2)

Reviewer B continued with the re-review charge (A's report handed over).
Report: `plan-r2-reviewer-b.md` (7 findings: 2 MEDIUM, 5 LOW), all aimed at
the round-1 rulings. B contested AR26's disable and AR27's count premise and
conceded every other adjudication; it judged AR22, AR28-AR32 correct and
found nothing new in a fresh read of S1/S2.

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R2-1 | AR26's disabled Change breaks the existing deliberate test `BroadcastComposer.test.tsx:946-970` (Change during a held preview) | ACCEPT (contest upheld) -> AR33: Change stays enabled; the existing staleness check also governs a late 422/503; a new held-422 test | YES (reverts AR26's disable) |
| R2-2 | AR23 contradicts two Task 3.5 tests that wait for "Reaches 5" while the gate is closed | ACCEPT -> AR34: both tests rewritten (no create, `Estimating reach`, then one create) | no |
| R2-3 | AR23 does not say how `hold` fits the hook; a stored pending flag could stick | ACCEPT -> AR35: effect dependency, early return, derived `reachPending` | no |
| R2-4 | AR25's "whenever the draft key changes" invites a set-state-in-effect lint error | ACCEPT -> AR36: derived alert keyed by the draft key | no |
| R2-5 | AR26's belt needs a ref written during render | ACCEPT (moot) -> AR33 uses the existing staleness check | (folded) |
| R2-6 | AR24 keeps the flash and says nothing about a failed units read | ACCEPT -> AR37 (`loading / loaded / failed`; failed copy `Couldn't load the properties.`) | no |
| R2-7 | AR27's premise is stale: the issue already records 22/17 and says AGENTS.md is left as it is | ACCEPT (contest upheld) -> AR38: issue file only, new dated status paragraph, measured with `npx eslint .`; AGENTS.md untouched | no |

0 rejected. R2-1 reverts the one behavior round 1 added (the disable), so
by the stop rule round 3 runs on the AR33-AR38 text with the same reviewer.

## Plan round 3 (plan @9f0d7520 -> rulings AR39-AR42, plan section 4.3) - TERMINAL

Reviewer B continued. Report: `plan-r3-reviewer-b.md` (5 findings: 2
MEDIUM, 3 LOW), all precision on the round-2 rulings.

| # | Finding | Ruling | Decision changed? |
|---|---|---|---|
| R3-1 | AR33 names no mechanism: the staleness check runs at render, the catch closes over a stale render, a D3b removal changes the key; "discarded as a late 200" is ambiguous | ACCEPT -> AR39: record the refusal with `{ draftId, key, unitId }` like a result; 503 alert on the `currentPreview` predicate; 422 removal as a functional update on S3's `FilterEdits` keyed by `unitKey`; notice keyed by property; a late refusal shows nothing; a precise test | no (mechanism for an existing decision) |
| R3-2 | AR34's test fixture has no accepted authorities, so its assertion is red as written | ACCEPT -> AR40 | no |
| R3-3 | AR36's "current draft key" is ambiguous (`key` vs `draftKey`) | ACCEPT -> folded into AR39 (`draft.key` + the full predicate) | no |
| R3-4 | AR37's `.catch` also catches StrictMode's aborted read; no tests for loading/failed | ACCEPT -> AR41 (AbortError stays loading; three tests) | no |
| R3-5 | AR38 omits the convention's frontmatter title/updated edits and placement | ACCEPT -> AR42 | no |

0 rejected. No accepted finding changed a decision, so round 3 is the
TERMINAL round (stop rule). Plan review CLOSED.

Totals: 3 rounds, 26 findings (14 + 7 + 5), 0 BLOCKING, 0 HIGH, 0 rejected;
reviewer contests upheld twice (round 2).
