---
id: tour-reschedule-of-confirmed-not-surfaced
title: Rescheduling a CONFIRMED tour emits no activity/audit milestone
type: bug
severity: low
status: open
area: app/tours
created: 2026-07-03
refs: app/src/routes/tours.ts
---

**Problem.** Found during the activity-coverage build review (2026-07-03). Tour
lifecycle propagation (`recordTourEvent` in `tours.ts`) emits a `tour_scheduled` /
`tour_rescheduled` milestone on a time change only when the tour is (or moves to)
status `scheduled`. The reschedule guard is:

```
wasReschedule = scheduledAtIso !== undefined
             && currentStatus === 'scheduled'
             && effectiveStatus === 'scheduled'
```

A tour in status **`confirmed`** whose `scheduledAt` is changed (a bare time change,
no status field) keeps status `confirmed` — the booking/revival auto-advance only
promotes `requested`/`canceled`/`no_show` to `scheduled`, not `confirmed`. So
`effectiveStatus === 'confirmed'`, neither the into-scheduled branch nor
`wasReschedule` fires, and **that real time change is invisible on both the tenant
timeline and the property Activity card**.

This is consistent with the plan as literally worded (the plan's decision was
"scheduled/rescheduled covers confirmed" and it did not spec a confirmed-reschedule
path), so it was left as-is rather than silently expanding scope — but it is a genuine
coverage gap: a confirmed tour getting moved to a new time is exactly the kind of
change staff would want to see while texting.

**Suggested fix.** Widen the reschedule guard to also fire on a time change while
`confirmed`:

```
wasReschedule = scheduledAtIso !== undefined
             && (currentStatus === 'scheduled' || currentStatus === 'confirmed')
             && (effectiveStatus === 'scheduled' || effectiveStatus === 'confirmed')
```

emitting `tour_scheduled` (activity) / `tour_rescheduled` (audit) with a "Tour
rescheduled" label. Decide deliberately (product) whether a confirmed-tour reschedule
should read as "rescheduled" on the timelines.
