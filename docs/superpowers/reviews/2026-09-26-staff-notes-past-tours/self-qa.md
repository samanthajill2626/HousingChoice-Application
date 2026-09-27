# Live self-QA - feat/staff-notes-past-tours

Date: 2026-09-27
Driver: the build orchestrator (Fable 5.1) - the eyeball was not delegated.
Stack: hermetic `npm run e2e:session` on lane 13 (dashboard
`http://127.0.0.1:10311`, app `:10301`, fake Twilio `:10321`), `/__dev/ping`
`{"dev":true,...,"appCommit":"9382e0c7"}` = HEAD at the time. Never the live
`:5174` / `:8080`. Browser: the plugin Playwright MCP (the project MCP's
Chromium build is not installed and installing one is a download, not taken
overnight); its artifacts land in the MAIN checkout's gitignored
`.playwright-mcp/` (the documented location); nothing else was written there.
Measurements are `getBoundingClientRect` / `scrollWidth` reads through
`browser_evaluate`; wire facts are the MCP's recorded request and response
bodies. Session stopped afterwards with `npm run e2e:stop`, ports proven free.

Screenshots (all under `W:\AI Projects\Housing Choice\HC Application\.playwright-mcp\`):

| # | file | what |
|---|---|---|
| 01 | `staff-notes-past-tours-01-tenant-file-empty-desktop.png` | tenant file, Staff notes card empty, above Preferences & notes |
| 02 | `staff-notes-past-tours-02-tenant-file-edit-mode-desktop.png` | editor open (no aside), Save / Cancel |
| 03 | `staff-notes-past-tours-03-tenant-file-saved-desktop.png` | saved text + "Last edited Sep 27, 2026", aside "Edit" |
| 04 | `staff-notes-past-tours-04-tenant-file-edit-360.png` | editor open at 360px inside the profile pane |
| 05 | `staff-notes-past-tours-05-tours-past-desktop-1280.png` | Past tab, three rows, aligned cards, toolbar |
| 06 | `staff-notes-past-tours-06-tours-past-960.png` | 960px viewport (672px pane): stacked cards, whole names |
| 07 | `staff-notes-past-tours-07-tours-past-360.png` | 360px: checkbox beside its card, action under the link |
| 08 | `staff-notes-past-tours-08-tours-past-after-bulk-desktop.png` | after Mark toured (1): "Marked toured", row now Needs outcome |
| 09 | `staff-notes-past-tours-09-tour-page-outcome-dialog-open.png` | deep link: Record outcome dialog open, URL stripped |
| 10 | `staff-notes-past-tours-10-tour-page-after-cancel.png` | after Cancel: CTA "Record outcome", status Toured |
| 11 | `staff-notes-past-tours-11-tours-active-none-of-the-past-tours.png` | Active tab: none of the three tours |

## Part 1 - Staff notes (tenant file `/contacts/contact-tenant-0001`)

- Card order: the "Staff notes" `<section>` is the immediate previous sibling
  of "Preferences & notes" (`nextElementSibling` identity), both inside the
  file pane; heading text "Staff notes", aside button `aria-label="Add staff
  notes"` / text "+ Add"; body "No staff notes yet."; no "Last edited".
- Edit mode (after "+ Add"): a `<textarea rows=4>` with a sibling
  `<label for=...>` reading "Staff notes" that is visually hidden
  (`position: absolute; width: 1px`); `document.activeElement` is the
  textarea on entry; the heading carries no aside; buttons "Save" and
  "Cancel" enabled; no alert.
- Save with two lines of text: the recorded request is
  `PATCH /api/contacts/contact-tenant-0001` with body EXACTLY
  `{"staff_notes":"Self-QA marker: ... (line 1)\nSecond line kept as typed"}`
  (no other key); the response contact carries
  `staff_notes_updated_at: "2026-09-27T10:22:54.010Z"` (server-stamped), the
  text as typed, no `staff_notes_source`, `preferences_notes` untouched.
- Read mode after save: the text, "Last edited Sep 27, 2026", aside
  `Edit staff notes` / "Edit", no textarea. The Preferences & notes card's
  innerText is byte-identical before and after.
- Full reload: the same text and "Last edited Sep 27, 2026" from the server.
  Console: 0 errors, 0 warnings.
- 360x800, profile pane via the "View > Profile" toggle, editor open: no
  horizontal overflow at ANY layer - document 360/360, `<main>` 360/360, the
  `.right` scroll pane 321/321, the card 295/295; the textarea spans x 37-308
  inside the card (24-321); Save (37-90) and Cancel (98-163) inside; the
  textarea keeps focus.
- Clear path: empty the box, Save -> request body EXACTLY `{"staff_notes":""}`
  (an empty string, not null); read mode shows "No staff notes yet.", no
  "Last edited", aside back to "+ Add".

## Part 2 - Past tab (`/tours/past`)

Data: three past-dated tours for Tasha Nguyen created through the page's own
authenticated `fetch` (`POST /api/tours`, 201 each): Sep 26 10:00 at unit-0001
(left scheduled), Sep 25 10:00 at unit-0002 (PATCHed to `toured`, 200), Sep 24
10:00 at unit-0001 (PATCHed to `no_show`, 200). Fake thread store before:
0 threads, 0 outbound (the past-dated creates sent nothing).

- Page: h1 "Past tours"; the intro line byte-for-byte; tabs Active | Past |
  Closed with `aria-current="page"` on Past; no "+ New tour"; toolbar
  "Select all not marked" (unchecked, enabled) + "Mark toured (0)" disabled.
- Rows (most recent first), every accessible name ending with the row's own
  date-time: (1) checkbox "Select tour for Tasha Nguyen at 1450 Joseph E.
  Boone Blvd NW, Atlanta, GA 30314 on Sep 26, 2026, 10:00 AM", link "Tour
  for ... on Sep 26, 2026, 10:00 AM" -> `/tours/tour-946c...`, chip "Not
  marked", button "Mark toured" with aria-label "Mark toured: ... on Sep 26,
  2026, 10:00 AM"; (2) link "... on Sep 25, 2026, 10:00 AM", chip "Needs
  outcome", link "Record outcome: ... on Sep 25, 2026, 10:00 AM" ->
  `/tours/tour-d2f2...?outcome=1`, no checkbox; (3) "... on Sep 24, 2026,
  10:00 AM", chip "No show", no checkbox, no action.
- Wire on load: ONE Past read, `GET /api/tours?from=2026-06-29T04:00:00.000Z&to=2026-09-28T03:59:59.999Z`
  (= Jun 29 00:00 local, 90 calendar days back, through Sep 27 23:59:59.999
  local); no write. The page also issues the Active window's two reads
  (`from=today..+30d` and `status=requested`) as the Closed tab always has
  (page-level `useTours`; pre-existing shape, noted). Each read appears once
  more as `net::ERR_ABORTED` - React StrictMode's dev-only double effect.
- Desktop 1280x900 (pane 992px): all three cards share left 290 / right 1112
  (aligned; OD-7); the checkbox at x 264-282, the action slot right-aligned
  at 1157-1256; no element inside any card has `scrollWidth > clientWidth`.
- 960x800 (pane 672px, the R2-1 band): every card stacks its identity over
  its meta (meta top >= tenant bottom on all three), the tenant box is 95px
  (the whole name), nothing clipped, cards aligned 290-792, document 960/960.
- 360x800: the "Not marked" row's checkbox (x 24-42, y 339-356) lies inside
  its card's vertical span (286-409) and left of it (card x 50-336); its
  "Mark toured" button wraps under the card (top 417 >= bottom 409); the
  Needs-outcome row's "Record outcome" link wraps under its card; the No show
  row is exactly its card's height (124px - no blank action line); nothing
  clipped; document 360/360, `<main>` 360/360, region 312/312.
- Bulk: tick the Not-marked row -> the anchored `button:text-is("Mark toured
  (1)")` is clickable (Playwright refuses a disabled target). Wire, in
  order: `GET /api/tours/tour-946c...` (200) -> `PATCH /api/tours/tour-946c...`
  with body EXACTLY `{"status":"toured"}` -> `GET /api/tours?from=...&to=...`
  (the reload). No other POST / PATCH / PUT / DELETE on the page. The PATCH
  response tour is `status: "toured"` with NO `outcome` key. After a 2 s
  settle the fake thread store still holds 0 threads / 0 outbound.
- After the batch: row 1 shows `role="status"` "Marked toured", chip "Needs
  outcome", a "Record outcome" link, no checkbox; "Mark toured (0)" disabled;
  select-all disabled (no Not-marked row left); no alert; no above-toolbar
  block.
- Deep link: the row's "Record outcome" lands on `/tours/tour-946c...` with NO
  `?outcome` in the URL, the `role="dialog"` named "Record outcome" open
  (form "Record outcome form", a Cancel), the back arrow `href="/tours/past"`,
  and `window.history.state` = `{"usr":{"back":"/tours/past"},...}` - the
  router state survived the replace navigation (spec 4.6).
- Cancel (scoped to the dialog): dialog gone, primary CTA "Record outcome",
  status pill "Toured", back arrow still `/tours/past`; clicking it lands on
  `/tours/past` with a FRESH Past view (no result lines, no selection,
  "Mark toured (0)" disabled).
- Plain load of the stripped URL: no dialog, CTA "Record outcome", back arrow
  `href="/tours"` (no router state -> the fallback).
- Active tab: both regions ("Upcoming tours", "Needs booking") rendered,
  zero links to any of the three tour ids, "+ New tour" present, tabs Active
  | Past | Closed in that order. Console across the whole session: 0 errors,
  0 warnings.

## Observations (not defects)

- The Past view triggers the page-level Active reads too (above). Pre-existing
  page shape shared with Closed; the profiler contract for `/tours` and
  `/tours/closed` is unchanged.
- The tour page's schedule card on a past-dated tour is unremarkable after the
  mark (the S7 note about a skipped "Day before" preview was on the
  still-scheduled state; it reads "tomorrow" because the rung's preview is the
  message template - pre-existing RemindersPanel copy).

Verdict: every state the spec cares about behaves as specified on the real
stack; both architectural claims (a status-only PATCH after a re-read with no
send; a replace navigation that keeps router state) hold at the boundary and
are pinned in unit tests and the two e2e specs.
