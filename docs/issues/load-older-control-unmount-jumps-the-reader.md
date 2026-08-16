---
id: load-older-control-unmount-jumps-the-reader
title: The reader jumps by the control's height on the LAST Load older click of a thread
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/contact/Timeline.tsx:1323, dashboard/src/routes/contact/Timeline.module.css:139, docs/superpowers/specs/2026-08-13-thread-history-paging-design.md:226
---

**Problem.** On the FINAL "Load older messages" click of a thread - the click that
exhausts history and retires the control - the bubble the operator was reading
jumps upward by exactly the control's height. Measured live in Chromium on the
hermetic lane at 41.78px. Every other click holds the reader to well under a
pixel.

The scroll arithmetic is not at fault; it is exact in both cases. The control row
is the first child of `.streamWrap`, a flex column, and `.stream` is its sibling.
When `hasOlder` flips false the row unmounts, so `.stream` grows into the vacated
42px and its top edge moves UP by 42px. Content is correctly positioned relative
to a container that itself moved.

Measured on the contact timeline (`useContactTimeline`), parked mid-thread:

| | non-final click | FINAL click |
| --- | --- | --- |
| marker bubble viewport top | 459.75 -> 459.06 (**0.69px**) | 458.91 -> 417.13 (**41.78px**) |
| `.stream` viewport top | 176 -> 176 (unchanged) | 176 -> 134 (**-42px**) |
| `scrollTop` delta vs `scrollHeight` growth | 2571 vs 2571 (exact) | 1769 vs 1769 (exact) |
| control after | still present | retired |

Spec section 4.5 moved the control OUTSIDE the scroll container specifically so
that "the restored offset would under-shoot by the control's own height on the
last Load older of every thread" could not happen, and concluded "Outside, only
prepended content changes the height, and the delta math is exact." The delta
math IS exact - that half of the reasoning holds. What the spec did not account
for is that the control's unmount still reflows the container it sits above, so
moving it outside converted a scroll-offset error into a layout shift of the same
magnitude rather than eliminating it.

Why no test catches it: every unit test runs in jsdom, which performs no layout,
and `stubScroll` fakes `scrollHeight`/`clientHeight` outright. The e2e assertion
added in `thread-history-paging.spec.ts` compares `scrollTop` against
`scrollHeight`, both of which are INTERNAL to `.stream` - it cannot observe the
container moving on screen. Only a real-browser measurement of an element's
viewport rect sees this, which is how it was found.

Impact is a one-time ~42px jump (about one bubble) at the moment history is
exhausted, on a thread the operator has already paged back through at least once.
No content is lost or duplicated. It is filed rather than fixed because every
remedy is a UX decision rather than a mechanical correction.

**Decision (2026-08-14).** Reviewed at the merge gate and DEFERRED by the human:
ship the branch, fix this later. It is not a merge blocker - one ~42px jump, once
per thread, at the moment history is exhausted, with nothing lost or duplicated.
The remedy stays open because all three candidates below are UX/copy calls rather
than mechanical corrections. Spec section 4.5 now carries the correction to its
own reasoning.

**Suggested fix.** Three candidates, in preference order:

1. Replace the control with a static end-of-history marker in the SAME 42px slot
   ("Beginning of conversation" or similar). Removes the shift and tells the
   operator why the control vanished, which today is silent. Needs a copy
   decision.
2. Reserve the row's height once a thread has paged at least once
   (`olderPagesLoaded > 0`) by keeping the row mounted with `visibility: hidden`.
   Mechanical, no new copy, but leaves a blank 42px strip.
3. Accept it and document it in the spec's residuals alongside the batched-render
   case already recorded in section 4.5.

Do NOT fix it by compensating for the control's height inside the layout effect:
that re-introduces exactly the control-height coupling section 4.5 moved the
control outside the container to avoid, and it would have to guess at a height it
does not own.

Neighbours: [`prepend-anchor-misses-height-changes-with-no-render`](prepend-anchor-misses-height-changes-with-no-render.md)
is the other real-layout gap in the same anchoring mechanism, and
[`load-older-control-loses-focus-and-announces-nothing`](load-older-control-loses-focus-and-announces-nothing.md)
covers the same unmount from an accessibility angle - a fix that keeps a marker
in the slot would likely address both.
