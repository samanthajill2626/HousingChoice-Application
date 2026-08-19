---
id: today-heading-selector-ambiguity
title: Non-exact "Today" heading selector makes every sign-in flaky once a tour is scheduled for today
type: bug
severity: med
status: open
area: e2e
created: 2026-08-19
refs: e2e/scenarios/steps.ts:373
---

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
2. STILL OPEN: sweep the remaining per-spec sign-in helpers under `e2e/tests/`
   (`grep -rn "name: 'Today' }" e2e/tests`) to `{ name: 'Today', exact: true }`.
   Better still, replace them all with a single shared `signIn(page)` helper so
   the readiness selector exists in exactly one place - the reason this bug
   could be fixed a dozen times and still be live is that the assertion is
   copy-pasted per spec.

A `Tours today` group is not rare in a shared lane, so this will keep costing
re-runs and false "did my branch break it?" investigations until the sweep lands.
