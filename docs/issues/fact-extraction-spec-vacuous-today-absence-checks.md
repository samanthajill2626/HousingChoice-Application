---
id: fact-extraction-spec-vacuous-today-absence-checks
title: conversation-fact-extraction.spec asserts a Today AI-suggestion row is ABSENT before the queue has loaded
type: debt
severity: low
status: open
area: e2e
created: 2026-09-30
refs: e2e/tests/flows/conversation-fact-extraction.spec.ts:350, e2e/tests/flows/conversation-fact-extraction.spec.ts:395, e2e/support/today.ts
---

**Problem.** Two checks in `e2e/tests/flows/conversation-fact-extraction.spec.ts`
(around lines 350-356 and 395-401) navigate to Today, wait for
`expectTodayReady` - which waits only for the `<h1>Today</h1>` - and then
assert `toHaveCount(0)` on an "AI suggestions to review" row. The h1 renders
while the queue is still loading (spinner), so the absence check can run
before the list exists and passes whether or not the row would appear. A
regression that wrongly surfaced the suggestion would not be caught.

Found by the plan-blind review of feat/today-past-tours (round 4, I4-1,
`docs/superpowers/reviews/2026-09-30-today-past-tours/`); it predates that
branch.

**Suggested fix.** Before asserting absence, wait for a settled Today: the
spinner gone and either another group's list or the "All caught up" state
visible (a small `expectTodaySettled(page)` helper beside `expectTodayReady`
in `e2e/support/today.ts` would serve every future absence check).
