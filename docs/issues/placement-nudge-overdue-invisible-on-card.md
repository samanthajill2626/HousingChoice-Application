---
id: placement-nudge-overdue-invisible-on-card
title: A placement nudge past its dueAt still reads 'upcoming' on the card - there is no overdue signal
type: improvement
severity: med
status: open
area: app/routes
created: 2026-08-31
refs: app/src/routes/placementNudges.ts:136, app/src/routes/placementNudges.ts:176, dashboard/src/api/types.ts:1518, app/src/routes/tourReminders.ts:161
---

**Problem.** `PlacementNudgeView.state` is a four-value union -
`'upcoming' | 'sent' | 'canceled' | 'skipped'` - derived server-side by
`stateOf` (`app/src/routes/placementNudges.ts:176`) from the row's terminal
markers ALONE. `dueAt` is not consulted. So a rung whose send time passed hours
or days ago is indistinguishable, on the wire and on the Deadlines & Nudges
card, from one due next week: both read `upcoming`.

That matters whenever the poll leaves a rung UNCLAIMED rather than retiring it -
the pre-claim deferral posture the ladder uses for conditions that may be
transient. An unclaimed rung stays pending, keeps re-listing on every tick, and
the card goes on calling it `upcoming` for as long as the condition lasts. If
the condition never clears, the nudge is never sent and nothing anywhere says
so. If it clears late, the backlog fires at once, carrying copy whose moment has
passed.

**This is the SAME defect being fixed for tour reminders** in the Phase B
mission (`tour-reminder-ladder-phase-b`), where the identical four-value union
is derived by the identical `stateOf` at `app/src/routes/tourReminders.ts:161`.
It is filed separately, rather than fixed in that branch, to keep a change that
turns automatic tour sending on out of the placement surface.

**Suggested fix.** Follow whatever ships for tours, which is deliberately the
cheap shape:

- Do NOT add `'overdue'` as a fifth value of the `state` union. Downstream
  predicates test `'upcoming'` by equality - on the tours side `hasUpcoming`
  (`routes/tourReminders.ts:497`) and the next-rung pick (`:616`), and this
  file has its own twins at `:376` and `:419` - so widening the union drops
  overdue rungs out of exactly the places that surface them.
- Add a separate derived boolean to the view instead:
  `overdue = state === 'upcoming' && dueAt < now`. Purely additive, no stored
  field, every existing predicate untouched, one chip on a row the card already
  renders.

Take it with the tours fix as the reference implementation so the two ladders
keep rendering through one shared chip vocabulary (the `suppression` field's
docblock at `:141` already states that as the standing intent).
