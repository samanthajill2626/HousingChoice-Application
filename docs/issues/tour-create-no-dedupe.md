---
id: tour-create-no-dedupe
title: POST /api/tours creates a second open tour for the same tenant and unit on a second click
type: bug
severity: med
status: open
area: app
created: 2026-10-12
refs: app/src/routes/tours.ts:310, app/src/repos/toursRepo.ts:366, dashboard/src/routes/tours/ScheduleTourForm.tsx:313
---

**Problem.** `POST /api/tours` validates its body shape and calls
`toursRepo.create` with no existence check and no conditional write on the
(tenantId, unitId) pair. Two clicks on the Schedule tour form's submit (or any
retried request) create two `requested` or `scheduled` tours for the same
tenant and property. Both then appear on Needs booking or the Tours list, each
with its own reminder ladder once scheduled, and the listing-send tour chip
links to whichever was created last. Found while designing the Interested
action for tracker #27 (spec
`docs/superpowers/specs/2026-10-12-last-heard-from-follow-up-status-design.md`,
section 5.4), which checks for an open tour before creating one on its own
path only.

**Suggested fix.** On create, read the pair's open tours (`requested` or
`scheduled`) and return the existing one (200, not 201) instead of creating a
duplicate; or add a per-pair open-tour marker written conditionally so a
concurrent double submit cannot race two creates through. The dashboard form
should also disable its submit while a request is in flight. Decide whether a
deliberate second tour for the same pair (a re-tour after a not-a-fit, then a
change of mind) must stay possible: closed, canceled and no-show tours do not
count as open, so the check above allows it.
