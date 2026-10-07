---
id: tour-list-restore-anchor-trackpad-swipe
title: A macOS trackpad swipe-back may cancel the Tours All tab's return anchor through momentum wheel events (plausible, unproven)
type: bug
severity: low
status: open
area: dashboard/tours
created: 2026-10-06
refs: dashboard/src/routes/tours/AllToursView.tsx, docs/superpowers/specs/2026-10-06-tour-list-design.md, docs/superpowers/reviews/2026-10-06-tour-list/code-review/r1-adversarial.md
---

**Problem (plausible, not reproduced).** On a return to the Tours page's All
tab (`/tours/all`) - the tour page's back arrow, or a browser Back - the view
reloads the list to the recorded depth and focuses the row that was opened
(spec `docs/superpowers/specs/2026-10-06-tour-list-design.md` section 4.9,
the return anchor). The anchor is a convenience, never a hijack: any
user-intent event after the view mounts cancels it - `pointerdown`,
`keydown`, `wheel` and `touchstart`, listened for on the document in the
capture phase (the `userActed` effect of `AllToursView`,
`dashboard/src/routes/tours/AllToursView.tsx`); a
browser-made `scroll` does not.

Chrome on macOS turns a two-finger horizontal trackpad swipe into Back
(overscroll history navigation) and may keep delivering momentum-phase
`wheel` events after the `popstate`. If one lands after the All view mounts,
the anchor is cancelled and the row is never focused - for exactly the
gesture that brought the user back. Nothing proves it yet: no trace exists,
and the spec names `wheel` as a user-intent event on purpose, so the behavior
is not changed on a hypothesis.

Found by the plan-blind code review of feat/tour-list (r1 AD-5, PLAUSIBLE).

**The probe.** In real Chrome on macOS: open a tour from an All-tab list long
enough to scroll, swipe back with two fingers, and log every `wheel` event
(timestamp, `deltaX`, `deltaY`) against the All view's mount time - for
example a temporary document capture listener installed at module load plus
a `performance.now()` mark in the view's mount effect. Any `wheel` event
after the mount means the gesture cancels its own anchor.

**Candidate fix (only if the probe shows it).** Ignore a `wheel` event whose
`deltaX` dominates its `deltaY` (a horizontal swipe is not a list scroll), or
ignore every `wheel` within about 300 ms of mount. Either keeps a deliberate
vertical scroll cancelling the anchor. Add a view test for the kept and the
ignored case beside the existing guard-event cases in
`dashboard/src/routes/tours/AllToursView.test.tsx`.
