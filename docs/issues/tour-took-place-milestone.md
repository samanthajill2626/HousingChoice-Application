---
id: tour-took-place-milestone
title: tour_took_place activity milestone no longer fires (was derived from retired placement.tours[])
type: debt
severity: low
status: open
area: app
created: 2026-07-01
refs: app/src/routes/placements.ts:567, app/src/repos/activityEventsRepo.ts:39, dashboard/src/routes/contact/Timeline.tsx:98
---

**Problem.** The Tours first-class-entity build retired `placement.tours[]` (repointed the
"Tours" card to the Tour entity per its design spec). The `tour_took_place` activity
milestone was previously derived from `placement.tours[]`, so it no longer fires — the
milestone TYPE still exists (`activityEventsRepo.ts`) and the Timeline still renders it
(`Timeline.tsx`), but nothing emits it. `tour_scheduled` is unaffected (it derives from the
placement's own `tour_date`, not from `tours[]`). No crash; a placeholder comment marks the
spot at `placements.ts:567`. `placement.tours[]` had no real data, so nothing historical is
lost — but the milestone is now dead until re-wired.

**Suggested fix.** Re-implement `tour_took_place` against the first-class tours API: emit the
milestone from a tour status/outcome change (e.g. when a Tour transitions to `toured`), via
a tour event/hook, keyed to the tour's tenant (+ unit). This belongs with the downstream
Post-Tour & Application wiring (the tour→placement conversion sequence), where tour events
first cross into placement/activity territory.
