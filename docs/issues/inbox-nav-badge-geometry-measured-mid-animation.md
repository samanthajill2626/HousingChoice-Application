---
id: inbox-nav-badge-geometry-measured-mid-animation
title: inbox-nav-badge.spec.ts measured nav geometry while the rail was still animating
type: bug
severity: low
status: resolved
area: e2e
created: 2026-08-23
resolved: 2026-08-23
refs: e2e/tests/dashboard-next/inbox-nav-badge.spec.ts, dashboard/src/app/AppFrame.module.css:20
---

**Problem.** The spec collapses the navigation, waits only for the
`Expand navigation` button to appear, and then takes ONE `boundingBox()`
snapshot of the nav row and the unread badge.

But the rail ANIMATES: `AppFrame.module.css:20` sets
`transition: flex-basis 0.18s ease, width 0.18s ease`. The button flips into the
DOM the instant the state changes - long before the width has finished moving -
so the snapshot can be taken mid-transition.

Observed in the 2026-08-23 gate run on `fix/test-suite-hardening` (a branch that
touches no dashboard source):

```
1) tests/dashboard-next/inbox-nav-badge.spec.ts:149
   the active Inbox link spans the full nav row when its unread badge is present
   Error: expect(received).toBeLessThanOrEqual(expected)
   Expected: <= 218.265625
   Received:    226
   at expectBadgeInsideRow (inbox-nav-badge.spec.ts:134)
```

An ~8px overshoot that is simply the rail still narrowing. `250 passed, 1
failed` in the suite; **3/3 passing when the file runs alone** - the signature of
a race the machine's speed decides.

Ruled out before fixing: the badge's WIDTH is not data-dependent. The spec
reseeds in `beforeEach` and pins the count with
`toHaveAttribute('aria-label', '1 unread')`, so an earlier spec leaving extra
unread rows cannot widen it. The variable is the animation, not the content.

**Resolution (2026-08-23).** Both geometry helpers now use `expect.poll`, which
retries the whole measurement until it settles. A real layout bug still fails -
it never settles - while an in-flight transition does not. Each returns the
WORST overhang on any edge, so one number covers all four claims and the failure
message reports how far outside the row the badge actually sat.

Probed rather than assumed: replacing the tolerance with an impossible `-50`
threshold fails with `the unread badge never settled inside its nav row`, so the
polled assertion is not vacuous. Restored, 3/3 green.

Same class as [`schedule-tour-form-test-flake`](./schedule-tour-form-test-flake.md)
and [`tourdetail-composer-footer-suite-flake`](./tourdetail-composer-footer-suite-flake.md):
an assertion snapshotting state that is still settling, which reads as "the
layout is wrong" rather than "I measured too early".
