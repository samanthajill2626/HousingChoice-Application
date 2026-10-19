# Live self-QA - feat/matching-blast-rules (tracker #6)

Orchestrator-driven, 2026-10-19, on the hermetic `npm run e2e:session` lane 10
(dashboard :10011, app :10001, fake-twilio :10021), project Playwright MCP
(bundled Chromium). Code under test: the branch after fix wave 1 (QA-1..QA-6),
then c3e8118b (QA-7, QA-8). Fixtures were created through the REAL routes by
`.superpowers/selfqa/setup.mjs` (gitignored): three run-unique housing
authorities (one 99 characters long, a stress case), two Available properties
(main: accepts all three; second: accepts one) and one in Setup carrying the
tours, eleven 2-BR tenants with explicit statuses (searching, onboarding,
placing, needs_review), five tours (upcoming, a fresh request, a toured tour
closed Not a fit, a toured tour with no outcome, an upcoming tour of a
no-consent onboarding tenant). Screenshots (gitignored):
`W:/tmp/matching-blast-rules/.playwright-mcp/qa*.png`.

## Scenarios and measured results

| # | Scenario | Result |
|---|---|---|
| QA-1 | Bare Matching entry: property step, then pick the main property | PASS. The list and the search offer exactly the 2 Available properties; the lean seed's Under application / Occupied units and the Setup property are absent (D9). The three accepted authorities fill "Housing authorities" as chips, 2-BR is pressed ("matches property") (D3, D3a). Network boundary: `GET /api/units/<id>` answered at t=3519 ms; the FIRST `POST /api/broadcasts` went at t=4129 ms (the 600 ms debounce) and already carried all three `housing_authorities` + `bedroomSize: 2` - no create before the prefill settled (AR23); the flyer re-prefill recreated once and DELETEd the superseded draft. Reach read "Estimating reach..." then "Reaches 4 recipients". |
| QA-2 | Preview, Select all, Add a tenant | PASS. 8 rows listed; Placing, Needs review and no-authority tenants absent (D1, D2). Checked by default: exactly the 4 the reach named (D8). Held rows unchecked with labels and names: `Tour Oct 24` / `... - tour oct 24`, `Toured Oct 16, needs outcome` / `... - toured oct 16, needs outcome`, `Tour requested Oct 19, no date yet` / `... - tour requested oct 19, no date yet` (AR43). The held no-consent tenant: disabled, `<name> - consent not recorded` only (no-consent outranks every cue, as on main). Deselect all then Select all: the same 4 (held skipped). Add a tenant: the Placing and Needs review tenants join CHECKED and survive Select all (6). The option note shows the tour label (`... Tour Oct 24`). Console: 0 errors, 0 warnings. |
| QA-3 | Send | PASS. "Send to 4 recipients" reached exactly the 4 checked phones, one message each (fake-twilio thread store); none of the held, no-consent, Placing, Needs review or no-authority tenants got it. |
| QA-4 | Ownership of the prefill (D3) | PASS. Removing the long chip held for 2.5 s (no revert). Change -> a DIFFERENT property: filters reset to its prefill (`[Finch]`), no confirm. Removing its only chip dropped caption sentence 2 and widened the reach (5, the no-authority tenant now included). Change -> the SAME property again: the emptied filter stayed. Change -> back to main: main's three chips again. Every create carried the filter on screen. (After QA-3 the main property's reach read 0: the 4 were now already sent - D8 as specified.) |
| QA-5 | `?contactId=` entry for a HELD tenant | PASS. The property step offers Available only; seeds-only (no filters); the one row is CHECKED and still labeled `Tour Oct 24`; "Send to 1 recipient" (a hand pick is never held). |
| QA-6 | `?unitId=` of the Setup property | PASS. Banner "This property is Setup, so its flyer link won't work..."; no Change control; its one authority prefilled; Send opens "Property isn't Available" with Make Available & send (cancelled). |
| QA-7 | Review row geometry, every row shape, 360-1440 px | FAIL then FIXED (QA-L1 below). After c3e8118b: no tag past the list's visible edge at any width (max clip 0 px at 1440/1280/1024/900/768/600/414/360); the wide layout (1280, 1440) has no sideways scroll; long tags wrap to 2 lines inside the tags column; short tags keep their width (Already sent 84 px, Tour Oct 24 79 px, Added 52 px); a two-tag row (Already sent + Tour Oct 24, made by a direct send to the held tenant) lays out on one line each. Page never overflows. |
| QA-8 | Compose step geometry (chips, caption) at 360 / 768 / 1280 | PASS. No page overflow, no scrolling container; the 99-character authority chip wraps inside the panel (263 px at 360). |

## Finding QA-L1 (fixed on the branch)

In the review list's wide layout (pane 768 px+) the tag spans were `flex: 0 0
auto` inside the `minmax(0, 1.2fr)` tags column, so a tag wider than the
column overflowed the row and the list scrolled sideways, cutting the label:
at a 1280 px viewport `Tour requested Oct 19, no date yet` ran 34 px past the
visible list, `Toured Oct 16, needs outcome` 12 px, and the pre-existing
`consent not recorded - fix before sending` tag 81 px (5 px / 52 px at 1440).
The new tour labels (AR43's longer one most of all) made it common. Fixed in
c3e8118b by a self-QA fix child: the four tag classes shrink and wrap
(`flex: 0 1 auto; min-width: 0`); pinned in `matching-blast-rules.spec.ts` by
a geometry assertion at 1280x900 (RED with the spec alone - tag right 1272.89
vs <= 1240 - GREEN with the CSS). Report: `selfqa-fix-report.md` (this
folder). Verified independently by the orchestrator (QA-7), not by the fixer.

## Pre-existing, not changed here (filed)

- In the NARROW (stacked) review layout, `.cellAuthority` is `flex: 0 0
  auto`, so a long housing authority name overflows its row and the list
  scrolls sideways (measured with the 99-character stress name: row 654 px in
  a 280 px list at 360). The longest real list name, "HUD-Veterans Affairs
  Supportive Housing (HUD-VASH)" (50 characters), is long enough to do it on a
  phone. Untouched by this branch (the stacked layout is the last-heard-from
  mission's); filed as `docs/issues/review-recipients-narrow-authority-overflow.md`.

## Not covered live (unit-tested instead)

The 503 "Couldn't check tours and Not interested replies..." path, the
seeds-only "labels couldn't be loaded" notice, the failed property / list
read notices, the picker's failed and empty states, and the 422
one-member removal need a failing read or a list change mid-compose; each is
pinned by the dashboard and app unit tests the build added (see the build
reports) - a hermetic lane has no switch to fail those reads on demand.
