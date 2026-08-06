---
id: tour-page-mixed-timezones
title: Tour page header renders scheduledAt in the BROWSER zone beside reminder copy composed in the ORG zone
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-05
updated: 2026-08-06
refs: dashboard/src/routes/tours/TourDetail.tsx:64, dashboard/src/routes/tours/TourDetail.tsx:191, dashboard/src/routes/placements/placementsFormat.ts
---

**UPDATE 2026-08-06 - the panel half moved; this issue is now HEADER-ONLY.**
The description below was written before the S1 follow-up landed on main
(`79f0fa29`). What changed:

- `dateTime(iso, timeZone?)` now appends a zone marker (`GMT+9`, `EDT`) when a
  zone is pinned AND it differs from the viewer's own
  (`Intl.DateTimeFormat().resolvedOptions().timeZone`). So the reminder chips
  are no longer silently foreign - a Los Angeles staffer sees
  `Aug 7, 3:00 PM EDT` on the panel.
- The HEADER is unchanged: `formatScheduledAt` still calls `toLocaleString`
  with no zone, so it renders browser-local and carries NO marker.

Net effect on the page for an out-of-zone staffer: header `12:00 PM` (their
zone, unlabelled) above a panel reading `3:00 PM EDT` (org zone, labelled). The
contradiction is now VISIBLE rather than silent, which is strictly better and
strictly not fixed. An org-zone staffer - every Housing Choice navigator today -
sees no marker anywhere and no difference at all.

Consequence for whoever picks this up: the fix is now ONLY to route the header
through the same zone-aware path, not to build the labelling (it exists). The
open design question below - whether the ACTIVITY log follows - is unchanged.

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
