---
id: tour-list-date-inputs-half-typed-year
title: Typing a year into the Tours All tab's From / To date inputs may act on every half-typed year (plausible, confirm first)
type: bug
severity: low
status: open
area: dashboard/tours
created: 2026-10-07
refs: dashboard/src/routes/tours/AllToursView.tsx, dashboard/src/routes/tours/tourListSelection.ts, docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adversarial-r2.md, docs/superpowers/reviews/2026-10-06-tour-list/planner-review/adjudications.md
---

**Problem (PLAUSIBLE, not reproduced - confirm before fixing).** Under When =
Date range, the Tours page's All tab (`/tours/all`) shows From and To date
inputs. Each commits on every change: its `onChange` calls `change` in
`AllToursView` (`dashboard/src/routes/tours/AllToursView.tsx`), which applies
the selection, replaces the URL and, through a new list key
(`tourListApiKey`, `dashboard/src/routes/tours/tourListSelection.ts`), starts
a new list. Chromium reports a date input's value while the year is being
typed, so typing a year passes through `0002`, `0020` and `0202` before
`2026`, and each of those is a complete, valid input value:

- Typing the To year while From is set (say From 2026-10-01): for the first
  three keystrokes From is after To, so `tourListRangeError` holds - the list
  vanishes, the range message is inserted into the list area's
  `role="alert"` and announced while the user is still typing a valid date,
  and the list then reloads from page 1.
- Typing the From year while To is set: up to three throwaway lists start and
  are aborted in turn (`0202-..` is a valid bound; `0002-..` and `0020-..`
  fail `ymdParts` - a JavaScript `Date` reads years 0-99 as 1900-1999 - so the
  bound is silently dropped, which is a different list again). The client
  aborts only its own wait; each request can still cost the server up to six
  Queries (spec `docs/superpowers/specs/2026-10-06-tour-list-design.md` 5.4).

Found by the plan-blind re-review of feat/tour-list (planner review round 2,
R2-3, PLAUSIBLE; ruled DEFER in `adjudications.md` in the same directory).
Nothing proves it yet: no trace exists, and Firefox and Safari may report the
value differently.

**Confirm first.** On a hermetic e2e lane (`npm run e2e:session`, never the
live `:5174` / `:8080` stack), in Chromium: open `/tours/all`, pick Date
range, set one bound with the picker, then TYPE the other bound's year from
the keyboard, one digit at a time. Count the `GET /api/tours/list` requests
(the Playwright MCP's network list, or a `page.on('request')` counter) and
watch for the range alert appearing and leaving, once for From and once for
To. Expected if the finding holds: three extra requests (From) or three
alert flashes (To). Record the result here either way.

**Suggested fix (only if confirmed).** Each option trades something:

- Debounce the two date inputs (the search box's 300 ms is the house
  precedent): the half-typed values never reach the list key, but every
  picker choice then waits too, and the range message lags a real error.
- An "incomplete year" state: keep each input's raw value as a local draft
  and commit it to the selection only when its year is at least 1000 (or on
  blur), judging `tourListRangeError` on committed values only, so a draft
  never changes the list key or shows the alert. A controlled input cannot
  simply ignore the intermediate change - that would refuse the keystroke -
  hence the separate draft state.

Either way, add a view test that types a year digit by digit and asserts one
request and no alert.
