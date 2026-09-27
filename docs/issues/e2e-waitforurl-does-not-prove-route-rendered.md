---
id: e2e-waitforurl-does-not-prove-route-rendered
title: waitForURL resolves before a React Router 7 route renders, so a spec that acts right after it can race the navigation
type: debt
severity: low
status: open
area: e2e
created: 2026-09-25
refs: e2e/tests/dashboard-next/inbox-rows-timestamps.spec.ts, docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/slice-G-report.md
---

**Problem.** React Router 7's `BrowserRouter` (7.18.0) applies a location
change inside `React.startTransition` unless it is given
`useTransitions={false}`. The URL changes at once, but the new route renders
in a transition that commits later. So Playwright's `page.waitForURL(...)`
resolves BEFORE the route has rendered, and a spec that acts immediately
after it - most visibly `page.goBack()` - can supersede the uncommitted
transition: the old route never unmounts, and whatever the spec meant to
exercise (an unmount save, a restore, a reconcile) never happens, so its
checks pass or fail vacuously.

Seen by slice G of `feat/inbox-rows-timestamps` (2026-09-25): the trace showed
`waitForURL` resolving inside the row click and `goBack` 3.3 ms later, with no
request from the destination route; the Inbox never unmounted and the
back-button test failed deterministically. The fix there
(`inbox-rows-timestamps.spec.ts` test 3) waits for the Inbox list to LEAVE the
page (`toHaveCount(0)`) before pressing back, which proves the route
committed.

**Suggested fix.** Sweep the e2e specs for an action taken right after a URL
wait (`goBack` / `goForward`, a click, an assertion that assumes the old route
is gone) and wait instead on something the destination renders, or on the
source route's content disappearing.
