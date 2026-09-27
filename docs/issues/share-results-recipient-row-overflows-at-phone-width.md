---
id: share-results-recipient-row-overflows-at-phone-width
title: At phone width a share's recipient row with a reason overflows - the badge never shrinks and covers the recipient's name
type: bug
severity: med
status: open
area: dashboard
created: 2026-09-27
refs: dashboard/src/routes/broadcasts/DeliveryBadge.module.css:4-17, dashboard/src/routes/broadcasts/DeliveryBadge.tsx:39-41
---

**Problem.** On a share's results page (`/broadcasts/<id>`), every recipient
row whose badge carries a reason - Failed, Skipped, and since the
send-outcome-reconcile branch "Not confirmed" - overflows its row at phone
width, and the badge covers the recipient's name: the rows staff most need to
act on are the ones whose name they cannot read.

Measured on a hermetic lane at a 375 x 812 viewport (send-outcome-reconcile
self-QA, 2026-09-27, `docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/self-qa.md`):

- a "Not confirmed" row (reason "Couldn't confirm whether this text went
  out"): the badge is 344 px wide, the row's scrollWidth 364 against its
  clientWidth 327, and the badge's right edge at x = 388, past the viewport;
- a "Failed" row (reason "Carrier filtered the message (error 30007)"): the
  row's scrollWidth 485 against 327, the name's box collapsed to 0 px, and the
  "open conversation to retry" hint cut off.

The document itself does not scroll sideways (scrollWidth 375), so the tail of
the badge is simply lost off the right edge.

**Cause.** `.badge` in `DeliveryBadge.module.css` is `display: inline-flex`,
`flex: 0 0 auto` and `white-space: nowrap`: the badge never shrinks, so its
width is the label plus the whole reason. `.reason` sets `white-space: normal`,
but as a flex item of a badge that will not shrink it never gets a narrower
box to wrap into. It predates the send-outcome work: the badge primitive came
with 5004dce4 and the reasons on failed and skipped rows with e4fb6085
(share-skip-fix D7), both on main; the "Not confirmed" row only inherits it.

Cosmetic, same cause: the reason span's text begins with a space before its
em dash, but as a flex item its leading space collapses, so the label runs
straight into the dash on every reason row (at any width).

**Suggested fix.** Let the badge shrink and wrap on narrow panes (for example
`flex: 0 1 auto; min-width: 0; white-space: normal` on the badge, or the
reason on its own line below the name under a width breakpoint), and give the
separator a real gap (a flex `gap`, or a margin on `.reason`) instead of a
leading space. Pin it with a phone-width e2e measurement (the row's scrollWidth
equals its clientWidth, and the name's box has width) for a Failed and a Not
confirmed row.
