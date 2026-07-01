---
id: inbound-media-attach-to-unit
title: No way to attach inbound comms media (MMS photos) onto a unit — manual, user-driven
type: improvement
severity: med
status: open
area: dashboard
created: 2026-07-01
refs: app/src/repos/unitsRepo.ts:157, dashboard/src/routes/contact/MediaGallery.tsx, dashboard/src/routes/listing/ListingEditForm.tsx
---

**Problem.** In property intake, a landlord texts photos/video of the unit. That media IS
captured — mirrored to S3 and shown in the contact's "Media from comms" gallery — and units
already have a writable `media: string[]` field (`unitsRepo.ts:157`, in the always-legal PATCH
set). But there is **no way for a Team member to attach a specific inbound photo onto the unit
record**. Doing so today requires a raw `PATCH /api/units/:id { media: [...] }`.

**NOT automatic (product decision).** This is deliberately a **manual, user-driven** action:
the Team CHOOSES which inbound media belong on the unit (an actual photo of the unit vs. an
unrelated attachment in the thread). The system must **not** auto-attach every inbound media to
a unit.

**What's missing.** A UI affordance to select an inbound comms media item and save it onto a
chosen unit's `media` — e.g. a "Save to property" action on a media item in the gallery /
timeline (targeting a unit), writing via `PATCH /api/units/:id { media: [...] }`, plus surfacing
the unit's `media` on the property detail/edit views. The storage exists; the selection UI +
wiring do not.

**Why it matters.** Unit listings/flyers need photos; the flyer projection already reads unit
media, so wiring the manual attach makes the texted photos usable end-to-end.

**Scope.** Split out from [[unit-create-and-mms-media-ui]] (the create-unit-UI half stays there).
Related: [[outbound-mms-send-path]]. Discovered during the landlord-onboarding sequence work.
