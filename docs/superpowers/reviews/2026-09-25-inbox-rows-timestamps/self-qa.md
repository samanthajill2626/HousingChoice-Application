# Live self-QA - inbox rows + timestamps

Date: 2026-09-26. Driver: the build orchestrator, in the desktop app's
built-in browser pane against a hermetic `e2e:session` lane (lane 16: app
:10601, dashboard :10611, fake-twilio :10621) reseeded with the FULL
profile, on the working tree at 887f0685 + slice H + the SQ-1 fix below
(the code the final gate commit carries). Every number below is a DOM
measurement (`getBoundingClientRect`, `scrollWidth`/`clientWidth`, a
`Range` on the last glyph) taken with the shipped CSS, not an eyeball.

One limitation, stated first: the pane was HIDDEN for the whole pass
(`document.visibilityState === 'hidden'`, `requestAnimationFrame` never
fired), so IntersectionObserver callbacks never ran and AUTO-LOAD COULD NOT
BE OBSERVED HERE - a manual observer with the same root and margin never
reported either. Auto-load (the chain at a tiny `?limit`, one page per
scroll at the group wall, the disarm on an all-duplicate page) is proven by
the Playwright spec `inbox-rows-timestamps.spec.ts` tests 2, 3 and 6, which
passed 6/6 three times on this lane after the main sync (slice H) and in the
full suite. Everything below that does not need a rendering update (layout,
DOM commits, scroll, SSE) measures fine hidden.

## 1. Desktop 1280x900, All tab, full profile (22 rows before minting)

- Every row's `<time>` sits inside its row with ONE right-edge offset (17
  px) across all rows: a straight column. No horizontal overflow
  (`main` 1025/1025). Relay and group-text rows show times ("Jun 1",
  "May 9"). Labels seen: "11:33 PM", "Jun 1", "May 9" ... "Feb 15".
- No sentinel and no Load more at 22 rows (< 100). No name ellipsized.
- Hover on "Leon Abara": the actions overlay (`position: absolute`, 100 px
  wide, "Mark unread") reveals over the row's right end and COVERS the
  time (overlay 1128-1228, time 1144-1224); the element under the time's
  center is the action button. This is the layout Sam approved (spec 5.4)
  and the reason the `<time>` title is unreachable by mouse on rows that
  offer an action (AD-3, filed).

## 2. Live update while scrolled (1280x400)

- Scrolled the container to 300 px, then sent an inbound from a fresh
  fake-Twilio party (+1 555 937-5200). The new row appeared at the TOP
  ("(555) 937-5200 - Text - Needs triage", time "11:36 PM"), rows 22 -> 23,
  `scrollTop` stayed 300 (no jump to the top), the same `<ul>` element
  stayed connected (never detached), and no spinner rendered.

## 3. Back button (1280x400)

- With `scrollTop` 300 and 23 rows, opened the 7th row ("With Tasha &
  Marcus", a group text) - the inbox left the page in ~0.9 s - then
  `history.back()`: the list was back in 29 ms with 23 rows and
  `scrollTop` 300, no spinner; 2 s later still 23 rows at 300 (the
  reconcile changed nothing visible). (The request-order claim - head read
  first, no cursor request - is pinned by e2e test 3; the resource-timing
  buffer was full here, so it was not re-measured.)

## 4. Phone width 360x800 (two-line rows)

- The row link is `display: grid`; every sampled row has the preview BELOW
  the name, the time in the row's TOP HALF and inside the row (17 px from
  the right edge); rows are 70 px tall; no horizontal overflow (`main` and
  document 360/360).
- Long relay/group names ellipsize (e.g. "With Diana Osei & Glo..." 252 ->
  141 px); ordinary names are whole.
- The stub row "(555) 937-5200" (Text + Needs triage): BEFORE the SQ-1 fix
  the number measured 108/107 px and a Range on its last glyph showed it
  CLIPPED - `text-overflow: ellipsis` would swallow the last digit
  ("(555) 937-520..."), the exact loss R2-6 was decided to prevent. Cause:
  with the Needs triage chip at `flex-shrink: 100` the name (`flex-shrink:
  1`) still takes ~1% of the shortfall, a sub-pixel, and the ellipsis
  replaces a whole glyph. AFTER the fix (`.numberName { flex-shrink: 0 }`
  on a formatted-number name): number 108/108, last glyph visible, the
  triage chip yields to 58/85 px ("Needs t..."), the head ends 8 px before
  the time (no overlap), time inside and in the top half.

## 5. The 768x720 band (tightest one-line layout, sidebar 240 px, content 513 px)

- One-line flex rows, 49 px tall; every sampled time is on the name's line
  and inside the row (17 px right gap); no horizontal overflow.
- Contact rows: "Leon Abara" 77/77, "Dario Reyes" 80/80, "Alexis Monroe"
  (a named unknown, Text + Needs triage) 98/98 with the triage chip yielding
  to 57/85. Relay/group names ellipsize under the 45% head cap (252 -> 123,
  279 -> 129), the preview keeps 133-201 px.
- The stub row: head 193 px (= the 45% cap of 430), the triage chip at its
  floor (47/48 px), the number 108/107 BEFORE the fix with the last glyph
  clipped, 108/108 with the last glyph visible AFTER it.

## 6. `?limit=15` and `?limit=2` (1280x400)

- `?limit=15`: the full world has only 13 contact rows, so page one holds
  everything (23 rows), no cursor, no sentinel, no Load more - the one-page-
  per-scroll case cannot be produced on this seed (e2e test 6 proves it on
  35 minted parties: page 847.5 px vs an 800 px viewport-plus-margin).
- `?limit=2`: page one = 2 contacts + 10 relay/group rows = 12 rows with a
  cursor, the sentinel 430 px below the viewport (outside the 400 px
  margin, so no load at rest - correct) and Load more live. Scrolling to
  the bottom put the sentinel 76 px INSIDE the viewport but nothing loaded:
  the hidden pane delivers no observer callbacks (see the limitation
  above), so this is not evidence either way; e2e tests 2 and 3 pin the
  chain at `?limit=2`.

## 7. Rows the seed could not offer

- No inbox row in the full profile carries a placement tag, a Closed relay
  tag or a Deleted chip, so the chip rule's geometry for those (R3-1: the
  4em floor; Closed and Deleted rigid) rests on the round-3 reviewer's
  browser measurements at 360-1440 (`code-review-r3.md`, section 1) and on
  the source-reading pins in `InboxRow.styles.test.ts`. The Needs triage
  chip - the one yielding chip the seed does offer - was measured above at
  360 and 768.

## SQ-1 (the fix this pass produced)

`dashboard/src/routes/inbox/InboxRow.module.css` `.numberName {
flex-shrink: 0 }`; `InboxRow.tsx` adds the class to a name matching
`^\(\d{3}\) \d{3}-\d{4}$`; pins in `InboxRow.test.tsx` (the class is
present on a formatted-number name and absent on an ordinary one) and
`InboxRow.styles.test.ts` (the rule); spec 5.4 amended. Dashboard suite
199 files / 3303 tests, typecheck 0, eslint 0 on the touched files; the
fix was hot-reloaded and re-measured live at 768 and 360 before the lane
was stopped.
