---
id: today-page-no-refetch-on-reconnect-or-midnight
title: The Today page never refetches after an SSE reconnect or when the local day rolls over
type: improvement
severity: low
status: open
area: dashboard/today
created: 2026-09-30
refs: dashboard/src/routes/today/useToday.ts:142, dashboard/src/routes/today/useTodayPastTours.ts:139, dashboard/src/api/EventStreamProvider.tsx
---

**Problem.** Today stays live only through server events: `useToday`
refetches on placement / conversation / suggestion (and, since
feat/today-past-tours, tour) events, and the past-tours section reloads on
tour events. Two cases never trigger a refetch:

1. **SSE reconnect.** Events emitted while the stream was down (a laptop
   sleep, a network blip, an app deploy) are not replayed, and neither hook
   reloads when the stream reopens. The queue shows what was true before the
   drop until an unrelated event arrives or the page remounts.
2. **Local midnight.** "Tours today" is computed for the day the page loaded
   (`localDayWindow`), and the past-tours section drops today's still-scheduled
   tours until the day ends. A Today tab left open overnight keeps yesterday's
   tours under "Tours today" and does not move them into "Past tours needing
   an outcome".

Found by the plan-blind review of feat/today-past-tours (finding L7,
`docs/superpowers/reviews/2026-09-30-today-past-tours/`); it predates that
branch for `useToday`.

**Suggested fix.** Refetch both on the stream's reopen (if the provider can
expose an `onOpen`/reconnect signal) and on a timer at the next local
midnight. The Inbox has the same midnight shape
(`inbox-labels-do-not-roll-over-at-midnight`); one shared "day changed" hook
could serve both.
