---
id: prepend-anchor-misses-height-changes-with-no-render
title: The prepend scroll anchor cannot re-baseline for a height change that triggers no React render
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/contact/Timeline.tsx:1199, dashboard/src/routes/contact/Timeline.tsx:1214, dashboard/src/routes/contact/Timeline.module.css:110
---

**Problem.** `<Timeline>` arms a scroll anchor (`el.scrollHeight`) immediately
before an older page is requested, and restores the reader's offset when the page
merges with `el.scrollTop += el.scrollHeight - anchor`. Because the stream's
height can change WHILE the page is in flight, there is a re-baseline branch
(`Timeline.tsx:1199-1204`) whose whole job is to keep the eventual delta counting
only the prepended content.

That branch lives inside a `useLayoutEffect` keyed on
`[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`Timeline.tsx:1214`), so
it can only fire when one of those three changes. An append or a "Comms only"
toggle does change `clusters` - but a height change that involves no React render
at all cannot reach it. The obvious source is image layout: an MMS thumbnail
(`.mediaImg`, capped at 200x200 but laid out from the decoded intrinsic size) or
an email attachment image finishing decode inside an ALREADY-RENDERED bubble
changes the stream height with no state change, no new items array and therefore
no effect run. MMS is a first-class channel on this surface, and a slow media
presign/decode landing inside the older page's flight window is ordinary, not
exotic.

The same hole exists for anything else that resizes the stream without a render:
a window/pane resize, a font swap, or the browser zooming.

**Failure story (reproduced by the adversarial reviewer, as a throwaway spec).**
Reader parked at `scrollTop` 40 with the anchor armed at `scrollHeight` 500. While
the older page is in flight the stream SHRINKS to 300 - same `items` reference, no
render - because a media element resolved to a smaller box than it reserved. The
real prepend then lands and takes the stream from 300 back to 500. The correct
restore is `40 + 200 = 240`; the code computes `40 + (500 - 500) = 40`.

```
 x ADVERSARIAL PROBE 2 > mis-restores by the amount the stream shrank while the
   older page was in flight
   -> expected 40 to be 240 // Object.is equality
      Tests  1 failed (1)
```

The reader is not moved at all while 200px of history was inserted above them.
Bounded and self-correcting on the next scroll - it costs a scroll offset, never
content - but it is the exact failure the re-baseline branch was written to
prevent, and it compounds the fact that the anchor arithmetic has no unit
coverage in an engine that performs layout (jsdom does not, so no existing test
can see this).

**Suggested fix.** Two candidates, either sufficient on its own:

1. Widen the layout effect's deps so intervening height changes are observed.
   Cheapest, but weakest - it still only samples on renders, so it closes the
   common cases (appends, filter toggles) and not the image-decode one, which is
   the case that motivated this issue.
2. Re-baseline from a `ResizeObserver` on `.stream` that is attached only while
   `paging.loadingOlder` is true: on every observed height change with the anchor
   armed, set `prependAnchorRef.current = el.scrollHeight`. This tracks the height
   itself rather than a proxy for it, so it covers image decode, pane resize and
   font swap alike, and it costs nothing when no page is in flight. Watch the
   ordering against the layout effect - the observer callback must not run between
   the prepend's DOM mutation and the layout effect's consume, or it would
   re-baseline away the very delta being restored. Gating the observer on
   `loadingOlder` and clearing it in the consume branch is the natural guard.

Either way the fix needs a real-browser assertion to be worth anything; the
`scrollTop` check in `e2e/tests/dashboard-next/thread-history-paging.spec.ts` is
the place to extend, with a mid-flight image load.

Natural neighbour: `load-older-control-loses-focus-and-announces-nothing` - both
are defects in the same control's "keep the operator's place" promise, both were
reasoned rather than driven in a browser, and both would be settled by the same
interactive session.
