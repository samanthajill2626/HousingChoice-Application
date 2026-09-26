# Planner live QA - inbox rows + timestamps

Date: 2026-09-26. Driver: the planner, in the desktop app's built-in browser
pane against a hermetic `e2e:session` lane (lane 16: app :10601, dashboard
:10611, fake-twilio :10621), reseeded with the FULL profile, on the working
tree at 967ef4ab (code tip d9339c08, the tree the final gates ran on). The
lane was stopped and its tables dropped afterwards (`npm run e2e:stop`).
Every number is a DOM measurement (`getBoundingClientRect`,
`scrollWidth`/`clientWidth`), not an eyeball.

Same limitation as the build's self-QA: the pane stayed HIDDEN
(`document.visibilityState === 'hidden'`), so IntersectionObserver callbacks
did not run and auto-load was not exercised here. Auto-load is proven by
`inbox-rows-timestamps.spec.ts` tests 2, 3 and 6 in the full suite (284
passed on b242b7d6 by the build and again on 967ef4ab by the planner). Layout,
DOM commits, scroll and the POP restore all measure correctly hidden.

## Rows the seed does not carry (conformance finding 2)

The full profile has no inbox row with a placement tag, a Closed relay tag
or a Deleted chip. Added to the lane's own DynamoDB tables
(`hc-local-16-*` only, dropped with the lane):

- placement tag: `conv-live-tenant-b` (Leon Abara's newest 1:1) given
  `placementId = placement-mx-awaiting-inspection-01` (stage
  `awaiting_inspection`, label "Awaiting inspection");
- Deleted chip: `contact-cast-toured-yes-tenant` (Brianna Whitfield) given
  `deleted_at = 2020-01-01`, its newest 1:1 `unread_count = 1`, and its
  latest inbound message stamped `created_at` (the seed's messages carry
  none, and the resurfacing predicate needs a post-deletion inbound with one:
  `app/src/routes/inbox.ts` `isFreshInbound`). The first attempt with
  `deleted_at = now` was hidden by that predicate (`resurfaceHidden: 1` on
  the assembled line), which is the rule working, not a defect;
- Closed tag: no fresh page can carry one (relay rows are listed for `open`
  and `connecting` only; a Closed chip appears only on a row that closed
  after it was listed), so a `<span class="_tag_...">Closed</span>` was
  injected after the channel chip of the first relay row and measured.

## 1. Desktop 1280x900, All tab

22 rows (21 before the Deleted row resurfaced). `main` 1025/1025, no
horizontal overflow. Every row's `<time>` ends 17px from its row's right edge:
one straight column. Labels seen: "12:21 PM" (today), "Jun 1" ... "Feb 15".
The time label's separator is U+0020 (`charCodeAt(5) === 32`) in this
Chromium, so the U+202F normalization holds here too.

| Row | name clipped | chips (width px) | row overflow |
| --- | --- | --- | --- |
| Leon Abara (placement) | no | Text 21, Awaiting inspection 122 | no |
| Brianna Whitfield (deleted, 1 unread) | no | Text 21, Deleted 60 | no |
| Alexis Monroe (triage) | no | Text 21, Needs triage 87 | no |
| relay row + injected Closed | no | Relay group 63, Closed 54 | no |

## 2. Tablet 768x1024 (sidebar open; `main` 513px)

22 rows, `main` 513/513, times 17px from the right edge on every row.

| Row | name (px, clipped) | chips (width px, clipped) | row overflow |
| --- | --- | --- | --- |
| Leon Abara (placement) | not clipped | Awaiting inspection 80, clipped ("Awaiting i...") | no |
| Brianna Whitfield (deleted) | 96, clipped | Deleted 60, not clipped | no |
| Alexis Monroe (triage) | not clipped | Needs triage 59, clipped | no |
| relay row + injected Closed | 3 letters ("Wit..."), clipped | Relay group 63, Closed 54, neither clipped | no |

So at 768 the chip rule behaves as specified: the two yielding chips
ellipsize (well above the 4em floor), the rigid ones never do, and the name
takes what is left. The cost shows on a relay row with two rigid chips: its
name collapses to three letters. Reachable only on a stale Closed row, and
the head's 45% cap is the R2-1 rule (verdict item for Cameron; the
one-rule revert is in the handback).

## 3. Phone 360x780 (two-line layout)

22 rows, `main` 360/360, no horizontal scroll, times 17px from the right
edge. Screenshot checked: dot, name, chip, time on line one; preview on line
two; group rows carry the group glyph.

| Row | name (px) | chips (width px, clipped) | row overflow |
| --- | --- | --- | --- |
| Leon Abara (placement) | "Leon Aba..." | Awaiting inspection 91, clipped ("Awaiting in...") | no |
| Brianna Whitfield (deleted) | 121, clipped ("Brianna Whitfi...") | Deleted 60, not clipped | no |
| Alexis Monroe (triage) | not clipped | Needs triage 87, not clipped | no |
| relay row + injected Closed | 80, clipped ("With Diana Os...") | Relay group 63, Closed 54, neither clipped | no |

## 4. Back button (spec 5.8), 768x400

Scrolled `main` to 300px (scrollHeight 1363, clientHeight 400), opened the
fourth row (Tasha Nguyen, `/contacts/contact-tenant-0001`; the row is a
`Link`), then `history.back()`:

- 306ms after the back call: `/inbox`, 21 rows rendered, `main.scrollTop`
  300, no "Loading" text. The list and the position came back from the
  store before any request answered.
- 2.8s later (the mount reconcile done): 21 rows, `scrollTop` still 300, no
  refresh banner. A complete page one replaced the list without moving it.

## 5. Not exercised here

- Auto-load and the group-wall behavior (hidden pane; Playwright tests 2, 3,
  6 cover them).
- The refresh-failure banner (Playwright test 5 covers it; it passed in both
  full runs).
- A live SSE update while scrolled: the build's self-QA section 2 measured
  it (a new row lands at the top and shifts the reading position by one row,
  spec section 8).
