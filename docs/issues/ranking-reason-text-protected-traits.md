---
id: ranking-reason-text-protected-traits
title: No code check or merge gate screens a ranking's reason text for protected characteristics
type: decision
severity: med
status: open
area: app/ranking
created: 2026-10-29
refs: app/src/services/ranking/parse.ts:84, app/src/services/ranking/rubric.ts:69, app/src/services/ranking/rubric.ts:83, app/scripts/rankingCounterfactual/evaluate.ts:1, app/src/services/ranking/runBatch.ts:130, app/src/services/ranking/runLog.ts:67, dashboard/src/routes/settings/rankings/RankingTable.tsx:35
---

**Problem.** The ranker's for / against reasons are kept as the model
writes them. `readReasons` (parse.ts:84-99) keeps any reason with a known
source, cut to 80 characters; the match (runBatch.ts:130-131) and the run's
own results (runLog.ts:67-73) store it for 180 days; the Rankings page shows
it (RankingTable.tsx:35-36), and GET /api/rankings returns it to admin AND
va. The only control on its CONTENT is the rubric's instruction never to use
a protected characteristic (rubric.ts:69, :83).

The counterfactual check - B2a's merge gate (spec D17, charter 7.2) -
compares mean SCORE and the Weak-cap counts across the swaps
(app/scripts/rankingCounterfactual/evaluate.ts). So a reason such as "3 kids,
2BR tight" or "uses a wheelchair" on a pair whose score the model did not
move passes the gate, is stored, and reads to staff as a reason against -
the steering signal fair housing forbids - with nothing in code or the gate
to notice. Found by the B2a planner's plan-blind review (PA-2, MEDIUM,
PLAUSIBLE: the mechanism is certain, the model's wording is not shown).

Charter 7.2 relies on the rubric plus the counterfactual check; neither
looks at reason text. Changing that is a design decision, so it is for
Cameron (raised at the B2a handback).

**Options.**

- (a) Extend the counterfactual check: fail a run when a SWAPPED value (the
  name, the household facts, the address, the credit or income line the
  swap changed) appears in any for / against text, beside today's score and
  cap comparison. Cheap; it uses the swaps the check already makes; it only
  catches what the swaps vary.
- (b) A parse-time screen: drop (and count, like `droppedUnlawfulFlags`) a
  reason whose text names a protected characteristic. Needs a word list or a
  grader; Cameron has preferred model judgment over banned-word lists
  (charter section 20 item 10).
- (c) Accept the rubric plus the score gate as they stand.

Source: docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/code-review/
planner-adversarial.md (PA-2) and planner-adjudications.md.
