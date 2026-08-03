---
id: comms-pane-overflows-on-short-viewports
title: Comms pane overflows its own bottom edge on short (<=640px tall) phones
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-03
refs: dashboard/src/routes/contact/Timeline.module.css:5, dashboard/src/ui/twoPaneShell.module.css:126
---

**Problem.** On a short phone viewport (measured at 360x640 — older Androids, the
small iPhone SE class) the tour page's comms pane cannot fit its own children, and
the leftover is UNREACHABLE: `.comms` is a bounded flex column with
`overflow: visible`, and its ancestors have almost no scroll to give (the `main`
content scroller had 16px). So the bottom of the composer — the reply note, and
with a long draft the Send button — sits past the pane's bottom edge with nothing
to scroll to it.

Measured on `/tours/tour-live-tomorrow`, Group text tab, 360x640:

| draft            | `.comms` overflow |
| ---------------- | ----------------- |
| empty            | 37px              |
| long (~170 char) | 110px             |
| at the max cap   | 153px             |

**This predates the mobile composer fix** (2026-08-03, `useAutoGrowTextarea` +
`Timeline.module.css`). Simulating the old collapsed-sliver reply box at the same
viewport still overflows by 19px with an empty draft, so the pane was already
short of room; the fix restores the composer's real height and widens the gap.
At 390x844 (iPhone 14 class and up) there is no overflow in any draft state —
verified empty, long, and past the cap — so this only bites the short tier.

The real cause is the budget, not the composer: the tour page's dark header band
(~250px at phone width) plus the pane toggle, the channel rail, and the Timeline
chrome consume most of a 640px viewport before the stream and composer get a say.

**Suggested fix.** Options, cheapest first:

1. Shrink the header band at phone widths (it is the single biggest consumer and
   the least information-dense) — likely enough on its own for the 640px tier.
2. Let `.comms` scroll as a last resort so nothing is ever unreachable. Note the
   twoPaneShell comment at line 152 warns this risks the double-scrollbar it was
   written to avoid, so it needs care: probably `overflow-y: auto` only under a
   short-viewport media query (`@media (max-height: 700px)`), not unconditionally.
3. Collapse `.upcoming` to a summary line (e.g. "2 scheduled") below some height
   threshold instead of rendering cards.

Worth confirming the same measurement on the placement hub and contact detail —
they share the twoPaneShell + Timeline, so they are very likely affected too.
