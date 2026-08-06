---
id: tour-page-mixed-timezones
title: Tour page header renders scheduledAt in the BROWSER zone beside reminder copy composed in the ORG zone
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-05
refs: dashboard/src/routes/tours/TourDetail.tsx:64, dashboard/src/routes/tours/TourDetail.tsx:191
---

**Problem.** `TourDetail.tsx` has TWO time renderers, and after
feat/tour-reminder-details they can disagree on one page for staff outside the
org timezone:

- `formatScheduledAt` (:64, a LOCAL helper calling `toLocaleString` with no
  `timeZone`; used at :191 for the header's "When") renders the tour's start
  in the BROWSER zone.
- The Reminders panel on the same page now shows rung BODIES composed in the
  ORG zone ("... is today at 3:00 PM") and a sent chip formatted in the
  composing zone.

A staffer in Los Angeles sees a header saying `Fri, Aug 7, 2026, 12:00 PM`
above copy saying `today at 3:00 PM` - the exact chip-vs-body contradiction
spec D8 closed for the reminder surfaces, one element higher on the page.

**Provenance, stated precisely.** This is a SPEC GAP, not a scope boundary the
build respected: the spec froze `dateTime(row.at)` at TourDetail.tsx:658 (the
tour ACTIVITY log - a deliberate D8 constraint, provably unchanged by test),
but never considered the header's separate `formatScheduledAt`. D8's own
argument ("before this change no disagreement was possible, so this change
introduces the defect") applies to the header just as it did to the two card
surfaces. Deferred from the branch as dashboard scope discovered at review
time (adversarial finding A-3), with the framing corrected by the planner.

**Mitigations (why severity low).** All Housing Choice staff operate in the
org zone today, where the two renders are identical; and the header's
browser-zone render is PRE-EXISTING - only the beside-org-zone-copy
inconsistency is new.

**Suggested fix.** Thread the reminders-list `timezone` (already held in
RemindersPanel state) or the org zone up to the header, and render
`formatScheduledAt` with it - or fold the helper into `dateTime(iso, zone)`.
Decide deliberately whether OTHER tour-page timestamps (activity log :658)
should follow; the spec froze them for this branch on purpose.
