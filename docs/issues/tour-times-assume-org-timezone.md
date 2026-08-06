---
id: tour-times-assume-org-timezone
title: Tour times assume the ORG timezone; a property in another zone texts the tenant a wrong time
type: bug
severity: med
status: open
area: app+dashboard
created: 2026-08-06
refs: dashboard/src/routes/tours/ScheduleTourForm.tsx:311, app/src/lib/quietHours.ts:39, app/src/messages/tourCopy.ts
---

**Problem.** Every tour time in the system is interpreted and rendered in ONE
timezone - the org's (`America/New_York`) - with no notion of where the property
actually is. That was invisible while reminder copy said "your tour is today". As
of `feat/tour-reminder-details` the copy states a specific wall-clock time, so
the assumption is now quotable to a tenant, and a property outside the org zone
produces a WRONG time in an SMS.

There is no timezone on a unit, no state-to-zone mapping, and no zone shown on
the booking form. Verified: `grep` for timezone across `repos/unitsRepo.ts` and
`lib/address.ts` returns nothing.

**Failure story (Cameron, 2026-08-06).** Property in Alabama (Central), navigator
and org in Atlanta (Eastern), tour booked for "3:00 PM":

1. `ScheduleTourForm.tsx:311` does `new Date(scheduledAtLocal).toISOString()` on a
   ZONE-LESS `datetime-local` value, so the typed time is interpreted in the
   NAVIGATOR'S BROWSER zone -> stored instant is 19:00Z.
2. The composer renders 19:00Z through `resolveQuietHoursTimezone(settings)`,
   which returns the ORG zone unconditionally -> the SMS says "3:00 PM".
3. The tenant is standing in Central, where 19:00Z is 2:00 PM.
4. They read "3:00 PM", apply their own clock, and arrive at 3:00 PM Central =
   20:00Z - ONE HOUR AFTER the tour.

The input side is ambiguous in the same way and in the same direction: if the
navigator MEANT 3 PM at the property, the stored instant was already an hour off
before any copy was composed, and the landlord is the one left waiting.

**Two axes have been conflated.** `resolveQuietHoursTimezone(settings, _contact?)`
(`lib/quietHours.ts:39`) documents a future PER-RECIPIENT override. That is the
right axis for QUIET HOURS - do not text someone at 3am where THEY are. It is the
WRONG axis for a tour time, which is anchored to where the PROPERTY is: a tenant
relocating from Phoenix touring an Atlanta property should be told Atlanta time.
Filling in the existing seam as designed would NOT fix this case.

- quiet hours / send suppression -> per RECIPIENT
- tour times, and any copy quoting a property's local clock -> per UNIT

**Blast radius beyond the SMS.** The same org-zone assumption drives
`morning_of`'s 08:00 anchor (08:00 Eastern is 07:00 Central at the property),
quiet-hours clamping for an out-of-zone recipient, and every dashboard chip the
tour-reminder work re-zoned.

**Reachability.** Nothing prevents an out-of-zone unit today: `Address` carries a
free-text `state`, and the write surface accepts any value. Housing Choice serves
metro Atlanta, so the common case is single-zone - but the GA/AL line is ~100
miles west, and Columbus GA / Phenix City AL straddle both the state and the zone
boundary. Severity is `med` rather than `high` because it needs an out-of-zone
property to bite, not because the outcome is mild: the outcome is a tenant
missing a tour.

**Suggested fix (sketch, not decided).**

1. Add an optional IANA `timezone` to the unit. Do NOT infer it from `state` -
   several states straddle a boundary, and a wrong inference is worse than an
   absent one.
2. Resolve tour-time rendering through a new `resolveUnitTimezone(unit, settings)`
   seam that falls back to the org zone, rather than through the per-recipient
   quiet-hours seam. Keep the two seams separate; they answer different questions.
3. Make the booking form state which zone it is capturing, and capture the
   PROPERTY's zone rather than the browser's.
4. Only then decide whether the SMS should name the zone. With a correct
   per-property zone the text is right for a tenant at the property, and a zone
   marker is noise; it is only needed while the rendered zone can be wrong.

**Related.** `tour-page-mixed-timezones` (dashboard-only, header vs chips).
Adjacent but distinct: that one is about which zone STAFF see, this one is about
the zone being wrong for the TENANT.
