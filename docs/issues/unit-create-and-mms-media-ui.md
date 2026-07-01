---
id: unit-create-and-mms-media-ui
title: No dashboard UI to create a unit under a landlord, or to attach inbound MMS media to a unit
type: improvement
severity: med
status: open
area: dashboard
created: 2026-06-30
refs: dashboard/src/routes/contact/LandlordFile.tsx, dashboard/src/routes/listings/ListingsList.tsx, dashboard/src/routes/listing/ListingDetail.tsx, app/src/routes/units.ts:270
---

**Problem.** The property-intake loop has the Team **create/update the unit under the landlord**
from texted details + attach the **MMS photos/video** the landlord sends. Two UI gaps block
doing this in the dashboard today:

1. **No "create a unit" UI anywhere.** `POST /api/units` exists (`units.ts:270`) but is unwired:
   - Landlord contact page "Properties" card lists units but has **no "Add a unit"** action
     (`LandlordFile.tsx`).
   - The Properties list has no "New property" button; property detail edits an existing unit
     only; there is no `/listings/new` route.
   - So a Team member can't create a unit (or set its owning landlord) without a raw API call.
2. **No MMS-media → unit attach.** Inbound MMS is stored in S3 and shown in the landlord's
   "Media from comms" gallery, and units have a writable `media: string[]` field — but there is
   **no UI to move those photos onto the unit** (the property-detail "Photos + Add" button has no
   handler; the unit edit form doesn't expose `media`; no "save to property" affordance on a
   message). Attaching media requires a manual `PATCH /api/units/:id { media:[...] }`.

**Already present (no build).** Editing an existing unit's fields ("Edit property" modal,
`ListingEditForm`), and publishing via the "Property status" select → `available`
(`PATCH /api/units/:id/listing-status`). So publish + the listing link are covered.

**Decision needed.** For the e2e suite at Phase-1 altitude, is "create the unit from intake"
a UI build (a New-unit form on the landlord page) we do now, or do we model unit creation as
**API setup** (`seedAvailableUnit`, already used by the sending-unit suite) and keep the diagram's
[MANUAL] "create/update unit" as an API-backed step — asserting the unit exists + is published +
has a listing link + carries the intake media? And is MMS-attach a Phase-1 build, or is the media
proven via the landlord timeline gallery + a unit `media` set through the API?

**e2e impact.** Governs whether `teamCreatesUnitFromIntake` drives a real form (needs the build)
or an API-setup verb. Related: [[unit-onboarding-fields]].
