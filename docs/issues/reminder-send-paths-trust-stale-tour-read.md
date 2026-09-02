---
id: reminder-send-paths-trust-stale-tour-read
title: Reminder send paths judge supersession and tour status from eventually consistent or pre-dated tour reads
type: debt
severity: low
status: open
area: app
created: 2026-09-02
refs: app/src/jobs/tourReminders.ts, app/src/routes/tourReminders.ts, app/src/routes/tours.ts
---

**Problem.** Two instances of one class, from the planner's adversarial review
of `feat/tour-reminder-supersession` (findings 3 and 4):

1. A reschedule PATCH that straddles a completed conversion can arm a live,
   pointed ladder on a closed/converted tour - the PATCH read its tour before
   the conversion finalized, and the poll has no tour-status gate. Pre-existing
   TOCTOU class; the supersession pointer neither widens nor closes it.
2. `forceSendReminder` judges `superseded` from an eventually consistent tour
   read, so a sweep-missed rung plus a stale pointer can force-send a
   dead-generation rung in the seconds after a reschedule. `ConsistentRead`
   exists one file over.

Both are bounded: the claim guards still refuse deleted rows, and the windows
are seconds wide. Neither was judged merge-blocking.

**Suggested fix.** (1) A tour-status gate in the poll's resolve (a terminal or
converted tour sends nothing regardless of pointer match). (2) `ConsistentRead`
on the tour read inside `forceSendReminder` - a human pressing the button is
worth the read unit.
