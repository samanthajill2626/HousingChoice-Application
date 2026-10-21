---
id: unit-onboarding-fields
title: Unit record missing intake fields - king-bed fit and square footage (voucher sizes, washer/dryer and qualifications built 2026-10-21)
type: improvement
severity: med
status: open
area: app
created: 2026-06-30
updated: 2026-10-21
refs: app/src/lib/unitFields.ts, app/src/lib/requirements.ts, app/src/routes/units.ts, dashboard/src/routes/listing/ListingEditForm.tsx, dashboard/src/routes/listing/UnitCreateForm.tsx, documentation/landlord-onboarding-sequence.mermaid
---

**Update (2026-10-21, feat/property-requirements, tracker #11 + #12) - three
of the five parts are BUILT; king-bed fit and square footage stay open.**

- Voucher sizes accepted: a LIST (`voucher_size_accepted`, integers 0..12),
  edited with picker B on the New and Edit forms, shown on the property
  page and the flyer, and read by Matching.
- Washer/dryer: `washer_dryer` - Hookups / Washer and dryer included / No
  hookups, or not recorded - on both forms, the property page and the flyer.
  The importer still drops the Airtable `Washer Dryer?` column it parses
  (importer changes were out of scope): [[import-washer-dryer-not-mapped]].
- Qualifications: a landlord REQUIREMENT (free text) copied to its
  properties, STAFF ONLY (Cameron, 2026-10-20). This reverses the intent
  below that qualifications go on the shareable listing; the diagram's
  listing note now says so.

Still open: does a bedroom fit a king bed (no field), and square footage
(no field). Design:
`docs/superpowers/specs/2026-10-20-property-requirements-design.md` D1,
D3, D4.

**Problem.** The property/unit intake step captures details the unit schema can't hold. The
unit PATCH has a strict allowlist (`PATCH /api/units/:id { voucher_size_accepted:2 }` →
`400 "unknown field: voucher_size_accepted"`), confirming these are genuinely absent.

**Missing unit fields (diagram → app).**
- **Voucher size ACCEPTED** — the voucher size the unit takes, DISTINCT from `beds` (a 3bd/2ba
  that accepts a 2BR voucher). Today `voucher_size` is DERIVED read-only from `beds`
  (`unitFields.ts`), so a unit whose accepted voucher ≠ its bedroom count can't be represented —
  and this directly affects which tenants it matches.
- **Does a bedroom fit a king bed** — no field.
- **Square footage (sqft)** — no field (the diagram lists it as listing-link content).
- **Washer/dryer hookups** — no field (listing-link content).
- **Qualifications text** — no field (`application_process` exists but is INTERNAL / never shared;
  qualifications are meant to be on the shareable listing).

**Already present (no build).** `beds`, `baths`, `address`, `rent_min/max`, `deposit`, `lif`,
`utilities` (free-form), `application_fee`, `video_url`, `same_day_rta`, `accepted_programs`,
writable `listing_link` (a landlord-provided external URL — can hold the **Zillow link**; not a
dedicated field but functionally covers it), and `media: string[]` (photos as URLs/S3 keys). The
shareable flyer is generated read-time (`GET /public/units/:id/flyer` + `/details`).

**Decision needed (small).** Mirror the [[landlord-onboarding-record-fields]] structured-vs-
freeform call for these: `voucher_size_accepted` (number) and the king-bed/W-D booleans + `sqft`
(number) + `qualifications` (string) are natural first-class fields, and `voucher_size_accepted`
in particular should be structured because it feeds matching. Confirm whether the Zillow link
reuses `listing_link` or gets its own field.

**e2e impact.** `teamCreatesUnitFromIntake(...)` / `expectUnitAvailableWithListingLink` assert
against whichever fields we add. Related: [[unit-create-and-mms-media-ui]].

**Update (2026-07-01) — partially built (human decision: "only voucher-size-accepted").** Added
the matching-critical field `voucher_size_accepted` (number, distinct from `beds`) as a writable
unit field + edit input + property-detail row (commits `cabffcd` + `3dd7d7a`). The rest —
king-bed fit, sqft, W/D hookups, qualifications — remain **DEFERRED** (this issue stays open for
them). The Zillow link reuses the existing writable `listing_link`.
