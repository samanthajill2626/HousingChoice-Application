---
id: ai-run-log-decisions-count-miscounts
title: AI run list "N decisions" cell double-counts and is constant across runs
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-09
refs: dashboard/src/routes/settings/AiRunList.tsx, app/src/routes/aiRuns.ts, app/src/services/extraction/decisions.ts
---

**Problem.** The run list's summary cell sums the outcome buckets AND an
orthogonal `pending` cross-tab, so it counts some decisions twice and reports a
near-constant number on every run regardless of what the run actually did.

**Confirmed live**, not just by inspection. In a hermetic lane on
2026-08-09 (planner self-QA, lane 15):

- a run whose model addressed nothing rendered `12 decisions`
- a run that WROTE one field and SUGGESTED another rendered `13 decisions`

There are only twelve decision targets in total, so 13 is impossible as a
decision count. The two runs also did materially different things while
reporting nearly the same number, which is the real damage: the column is the
list's only at-a-glance signal of what a run did, and it cannot distinguish a
run that changed data from one that changed nothing.

**Fix direction.** Count the decisions whose outcome is `wrote` or `suggested`
(what an operator scanning the log cares about), or show the outcome breakdown
explicitly. Do not sum a cross-tab that overlaps the buckets. A test should
assert two runs with different outcomes render different values.

**Evidence.** `.superpowers/design-review/final-adversarial.md` (P2-7), plus
the live observation above.
