---
id: fact-extraction-spec-vacuous-today-absence-checks
title: conversation-fact-extraction.spec asserts a Today AI-suggestion row is ABSENT before the queue has loaded
type: debt
severity: low
status: resolved
resolved: 2026-10-24
area: e2e
created: 2026-09-30
updated: 2026-10-24
refs: e2e/tests/flows/conversation-fact-extraction.spec.ts:350, e2e/tests/flows/conversation-fact-extraction.spec.ts:395, e2e/support/today.ts:121, e2e/tests/flows/conversation-fact-extraction.spec.ts:365, e2e/tests/flows/conversation-fact-extraction.spec.ts:405, e2e/tests/dashboard-next/caseworkers.spec.ts:550
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

**Resolution (2026-10-24).** Fixed on `feat/today-checklist` (tracker #31,
plan S7.5 / S7.6, rulings PR75 and C3), where the "AI suggestions to review"
list became one collapsed "AI suggestions for N contacts" line whose list is
not in the accessibility tree until opened - so the old checks were vacuous
twice over. One shared helper, `expectNoAiSuggestionFor`
(`e2e/support/today.ts:121`), replaces them: it asserts on server truth
first (GET /api/today holds no `ai_suggestions` row for the contact; a
non-200 throws, so a failed read never passes), then loads Today, waits for
that page's own `/api/today` response and for the page spinner to be gone,
and asserts the AI line ABSENT when the server holds no AI rows at all, else
the line names the server's count and the opened list holds no row for the
contact. Its call sites: the two "clears Today review" tests of
`e2e/tests/flows/conversation-fact-extraction.spec.ts` (:365, :405; commit
d1bc799a) and the Unknown card test of
`e2e/tests/dashboard-next/caseworkers.spec.ts` (:550; commit 6f5ac427).
RED probes in S7.5 and S7.6 proved the helper fails when the row is still
there (the S7 report,
`docs/superpowers/reviews/2026-10-23-feat-today-checklist/slices/S7-report.md`).
