---
id: today-past-tours-labeling-settle-window
title: Today shows "All caught up" for one round trip while a past-tours reload is still labeling the rows it brought
type: bug
severity: low
status: open
area: dashboard
created: 2026-10-25
refs: dashboard/src/routes/tours/useTours.ts:328, dashboard/src/routes/today/useTodayPastTours.ts:167-178, dashboard/src/routes/today/useTodayPastTours.ts:199, dashboard/src/routes/today/Today.tsx:529-536
---

**Problem.** A past-tours reload that recovers from a failure, or one that
goes from empty to non-empty, shows "All caught up" for one labeling round
trip. `usePastTours` clears `reloadFailed` as soon as the raw rows land
(`useTours.ts:328`). `useTodayPastTours` labels those rows afterwards,
asynchronously (the tenant and property point reads,
`useTodayPastTours.ts:167-178`), and until the labels land it returns the
PREVIOUS labeled rows together with the new, cleared `reloadFailed` (`:199`).
The page's `allCaughtUp` (`Today.tsx:529-536`) reads those stale empty rows
and `!past.reloadFailed`, so an otherwise empty Today reads "All caught up" -
the reload note gone, the new row not yet listed - until the labels land and
the row appears. That is against spec 2.3's settle rule (the message waits
for the past-tours section to settle so it never flashes above rows about to
appear) and spec 5.3 ("The 'All caught up' settle wait covers this
labeling"): the settle wait covers only the FIRST load (`status: 'idle'`
while nothing is labeled yet). For the fix-wave-3 rule that a failed reload
withholds "All caught up" (code review R3-1), the withhold lapses one round
trip early. Transient and visual only; nothing is lost or sent. Pre-existing
on main's shape: main's `useTodayPastTours` labels asynchronously and keeps
the old rows the same way. Found by the tracker #31 R4 review (R4-2),
`docs/superpowers/reviews/2026-10-23-feat-today-checklist/code-review/R4-review.md`.

**Suggested fix.** Treat "raw rows changed, labels pending" as not settled.
`useTodayPastTours` remembers which `past` array its labeled rows were built
from and, while a newer array is still waiting for its labels, reports the
section unsettled (for example a `labeling` flag, or the previous
`reloadFailed` kept until the labels land); `allCaughtUp` also requires the
section to be settled. The rows and the reload note keep their current
timing.
