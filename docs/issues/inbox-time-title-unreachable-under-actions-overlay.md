---
id: inbox-time-title-unreachable-under-actions-overlay
title: An inbox row's full-date tooltip cannot be reached with a mouse, because the hover actions overlay covers the time
type: improvement
severity: low
status: open
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/inbox/InboxRow.tsx:128, dashboard/src/routes/inbox/InboxRow.module.css:150, dashboard/src/routes/inbox/InboxRow.module.css:166, docs/superpowers/reviews/2026-09-25-inbox-rows-timestamps/code-review-r1-adversarial.md
---

**Problem.** Every inbox row's `<time>` carries the full stamp as its `title`
("Sep 12, 2026, 2:14 PM", from `formatInboxTimeFull`), and that tooltip is the
only place the exact date and year behind a "2:14 PM" or "Sep 12" label shows.
A mouse cannot reach it on any row that offers an action - every unread row
(Mark read) and every read row that is not deleted or closed (Mark unread) -
which is almost every row.

The mechanism (build review AD-3, from the CSS geometry; no browser was run):

- `.actions` (`InboxRow.module.css:166`) is an absolutely positioned
  descendant of `.row`, so it paints and hit-tests ABOVE the non-positioned
  row link. It sits at `right: var(--sp-3)` (12px) with a 12px `padding-left`
  and an opaque background, and takes `pointer-events: auto` on `.row:hover`
  and `:focus-within`.
- One action button at `--fs-xs`, with its padding, is about 75-90px wide, so
  the overlay spans roughly 12px to 99-114px from the row's inner right edge.
- `.time` (`:150`, `min-width: 5rem`) sits at the link's right end inside
  `.main`'s 16px right padding: roughly 16px to 96px from the same edge.
- The only way to put the pointer over the time is to hover the row, which
  turns the overlay on over it. The element under the pointer is then
  `.actions`, and the browser shows no tooltip.

Spec `2026-09-25-inbox-rows-timestamps-design.md` 5.4 and section 8 accepted
the overlay COVERING the time while revealed (Sam approved the aligned-column
layout); losing the tooltip is a consequence the spec did not spell out.
`InboxRow.test.tsx` checks only that the attribute is present.

**Suggested fix.** Either option alters the approved visual, so this is a
product call for Sam, not a code fix:

1. Put the full stamp where the pointer can reach it: on the row link, or on
   `.actions` itself.
2. Offset the one-line (desktop) overlay LEFT of the time column, e.g.
   `right: calc(var(--sp-4) + 5rem + var(--sp-3))` on `.actions`, which also
   keeps the time visible while the actions show.
