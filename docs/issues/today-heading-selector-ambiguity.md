---
id: today-heading-selector-ambiguity
title: Non-exact "Today" heading selector makes every sign-in flaky once a tour is scheduled for today
type: bug
severity: med
status: resolved
area: e2e
created: 2026-08-19
resolved: 2026-08-19
updated: 2026-08-21
refs: e2e/support/today.ts, e2e/support/selectors.md
---

<!--
  MERGED 2026-08-21. `today-heading-locator-substring-collision` (med, filed
  2026-08-05) described this same defect from the other end - it enumerated 33
  non-exact call sites and proposed `exact: true` plus "consider hoisting one
  shared helper". This issue IS that hoist. Its file was deleted and the two
  stragglers it still covered were fixed; do not re-file it.
-->

**Two stragglers swept 2026-08-21 (`fix/test-suite-hardening`).** The 2026-08-19
migration moved 61 assertions onto `expectTodayReady`, but two specs written in
double quotes escaped the sweep and still hand-rolled the substring-matching
form:

- `e2e/tests/dashboard-next/ai-run-log.spec.ts:23`
- `e2e/tests/dashboard-next/manual-extraction-trigger.spec.ts:42`

Both now call the helper. A repo-wide grep confirms no non-exact `Today` heading
locator survives in `e2e/` - the only remaining textual matches are
`support/today.ts`'s own header and the `selectors.md` row, both of which quote
the WRONG form deliberately as the thing not to write.

That is the same lesson the header already records, one turn later: a
find-and-fix sweep is only as complete as the pattern it searched for, and these
two differed by nothing but quote style.

**Problem.** The dashboard sign-in readiness check is written as

```ts
await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
```

`getByRole` name matching is a SUBSTRING match by default, so this locator also
matches the Today queue's own `Tours today` group heading (`<h2>`). The moment
any spec in the lane leaves a tour scheduled for the current day, the Today page
renders that group and the locator resolves to two elements - a strict-mode
violation that fails the sign-in itself, in whatever spec happens to run next.

That is why the failure looks random: it depends on cross-spec ordering and on
whether a lane still holds a tour scheduled for today, not on the spec that
fails. Observed 2026-08-19 on `fix/tour-already-toured`, where three specs
(`post-tour-application.spec.ts` x2, `tour-no-show-checkin.spec.ts`) failed under
a five-spec run and all passed when re-run alone - the failing tests had nothing
to do with either the branch or each other, and the reported set changed between
runs.

The fix has been applied piecemeal for a while: roughly a dozen specs already
pass `exact: true` at their own sign-in helper, presumably added by whoever hit
the flake that day. About 40 call sites still do not.

**Suggested fix.** Two parts:

1. DONE 2026-08-19 (`fix/tour-already-toured`): the five occurrences in the
   shared `e2e/scenarios/steps.ts` - including the `Scenario.login()` every
   scenario spec funnels through - now pass `exact: true`, with a comment
   naming the trap.
2. Sweep the remaining per-spec sign-in helpers, and put the selector in ONE
   place - the reason this bug could be fixed a dozen times and still be live is
   that the assertion is copy-pasted per spec.

**Resolution (2026-08-19, `fix/e2e-today-selector`).** All 61 readiness
assertions across 53 files (`e2e/tests/**` + `e2e/scenarios/steps.ts`) now call
`expectTodayReady(page)` from the new `e2e/support/today.ts`, which owns the
`exact: true` locator and carries the explanation. The 19 sites that were
already correct were migrated too, so no copy of the selector survives to be
got wrong again. `support/selectors.md` gains a Today row pointing at the
helper.

Deliberately NOT the `signIn(page)` helper this issue originally proposed: the
suite has several legitimate ways in (the dev-user button, a POST to
`/auth/dev-login`, a persona login) plus plain mid-test navigations back to `/`
that are not sign-ins at all. Collapsing those would flatten real differences.
The one thing all of them share is the readiness assertion, so that is what was
extracted.

One call site is deliberately untouched: `e2e/performance/routes.test.ts:488`
holds `{ role: 'heading', name: 'Today', exactness: 'exact' }` - a data
descriptor for the perf runner, not a Playwright locator, and already exact.
