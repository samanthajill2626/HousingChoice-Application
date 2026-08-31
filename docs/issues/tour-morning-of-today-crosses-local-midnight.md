---
id: tour-morning-of-today-crosses-local-midnight
title: tour.morning_of says "today" about a tour that is tomorrow
type: bug
severity: low
status: open
area: app
created: 2026-08-31
refs: app/src/messages/catalog.ts:154, app/src/jobs/tourReminders.ts:2428, app/src/messages/tourCopy.ts
---

**Problem.** `tour.morning_of` composes "looking forward to having you tour at
{time} today", but the rung no longer has a local-day anchor. It was 08:00
org-local ON the tour's local date, which made "today" true by construction.
The 2026-08-26 founder retiming made it a pure `scheduledAt - 4h` offset, and a
pure offset can cross local midnight.

Any tour starting between 00:00 and 03:59 org-local arms `morning_of` on the
PREVIOUS local day, so the message says "today" about a tour that is tomorrow.
Reproduced against `America/New_York`: a tour at 02:00 local arms the rung at
22:00 the previous day.

Practically hard to reach - it needs a tour booked in that four-hour overnight
window, which nobody books for a property viewing. Note what hides it, though:
the DEFAULT quiet-hours window clamps the rung into a `past_event` row and
swallows it. The lean e2e seed ships with quiet hours DISABLED, and disabling
them is a supported configuration, so the guard is a coincidence rather than a
control.

**Why this was not fixed on `feat/tour-reminder-ladder`.** The engineering is
small but the fix is not a developer decision:

1. It needs NEW FOUNDER COPY. The "today" wording is Sam's, pinned byte-exact
   by the 2026-08-26 spec section 5 and by a conformance test. A prior-day
   variant needs a string the founder writes; inventing one crosses the
   founder-vs-developer line that spec deliberately draws.
2. A second entry re-opens the twin proliferation that change deliberately
   REMOVED. A prior-day fork multiplied by the address fork puts the
   `_no_address`-style twins back in the catalog.
3. The nominal offset is not the real send time. Quiet-hours clamping and
   force-send both move the fire instant, so deriving the answer from
   `scheduledAt` alone is right only for the nominal case. A universally
   correct answer means threading the FIRE INSTANT into
   `composeTourReminderBody`, which today takes no send/due instant at all -
   a signature change across every compose path.

**Suggested fix.** Cheapest correct-enough option, once the founder supplies
wording: derive the prior-day case inside the composer, which already holds
`scheduledAt` and `timezone` and needs no new argument -
`localDateOf(scheduledAt - 4h, tz) !== localDateOf(scheduledAt, tz)` - and
select a founder-authored prior-day entry.

Be aware that no code fix is airtight here: `tour.morning_of` is
`editable: true`, so the string can be overridden back into a false sentence
from settings regardless of what the default says.

A cheaper alternative worth putting to the founder first: drop the word "today"
from the single existing string. One entry, no fork, no twin, and it reads
correctly in both cases.
