---
id: paused-reminder-rows-grow-listdue-without-bound
title: "Paused tour reminder rows never leave listDue, so the 30s poll re-reads a monotonically growing batch"
type: debt
severity: low
status: open
area: app
created: 2026-08-20
refs: app/src/repos/tourRemindersRepo.ts:204, app/src/jobs/tourReminders.ts
---

**Problem.** The manual-only hold-back (2026-08-20) deliberately leaves a
held-back rung PENDING rather than claim-skipping it, so "Send now" keeps
working. Pending is exactly the state `listDue` selects for, and `listDue` has
no lower bound: it queries the whole `reminders` partition for `dueAt <= now`
and paginates every page, filtering only on `sentAt` / `canceledAt` /
`skippedAt`. A paused rung is stamped with none of those, so it is re-read on
every poll tick, forever.

The worker polls every 30s, so the cost is a query whose result set only ever
grows - up to 4 permanently-pending rows per tour booked - read and paginated
2,880 times a day and then discarded by the in-process filter.

This is BOUNDED IN PRACTICE by the tour lifecycle: marking a tour toured (or
canceling/rescheduling it) cancels its pending rungs, which does stamp
`canceledAt` and drops them out of `listDue`. The leak is therefore the
abandoned tours - booked, never marked toured, never canceled - plus everything
armed while the pause is on and resolved afterwards. Slow, monotonic, and
harmless at current volumes; it is filed because it does not self-heal and
because "temporary" has a way of lasting.

Not a defect in the pause itself: the same shape applies to the application
nudges paused on 2026-08-18, and claim-skipping instead would break the Send now
button both pauses exist to preserve.

**Suggested fix.** Prefer bounding the query over retiring the rows. A lower
bound on the `byDueAt` key condition (`dueAt BETWEEN :floor AND :now`, floor =
now - N days) drops the tail without touching row state, so Send now still
works on anything the panel shows. Pick the floor against worker-downtime
recovery: it must be comfortably longer than the longest outage the poll is
expected to catch up from, and it should be logged when it truncates, so a
bounded read is never mistaken for an empty one.

Do NOT "fix" this by claim-skipping paused rungs - that is the one option the
hold-back's design explicitly rejects.
