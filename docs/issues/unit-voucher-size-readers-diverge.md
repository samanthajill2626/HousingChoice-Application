---
id: unit-voucher-size-readers-diverge
title: A property's voucher size is read two ways - beds on Matching and the flyer, voucher_size_accepted (one number or a list) on the Properties list
type: debt
severity: med
status: open
area: dashboard
created: 2026-10-01
refs: dashboard/src/routes/listing/listingFormat.ts, dashboard/src/routes/listings/unitListFacets.ts, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:219-227, dashboard/src/routes/broadcasts/AudienceFilters.tsx, app/src/lib/unitFields.ts:294-306, dashboard/src/routes/listing/ListingDetail.tsx:752-754, dashboard/src/routes/listing/ListingEditForm.tsx:30-32, dashboard/src/routes/listing/ListingEditForm.tsx:68
---

**Problem.** "Which voucher sizes does this property take?" now has two answers in the app.

- **The Properties list's voucher filter** (tracker #1, `feat/properties-available-view`) reads
  `voucher_size_accepted` through `voucherSizesOf` (`listingFormat.ts`): ONE number today, or a
  LIST once tracker #12 makes the field a multi-select (the `full` demo seed already stores
  `[2, 3]`). It NEVER falls back to `beds` - Cameron's decision (2026-10-01), because a 3-bed
  property may take a 2-BR voucher.
- **The Matching composer** pre-fills the audience's voucher size from the property's `beds`
  (`BroadcastComposer.tsx:219-227`) and labels it as matching the property (`AudienceFilters.tsx`).
- **The public flyer** tells tenants it "Fits a N-bedroom voucher" from `beds`
  (`unitFields.ts:294-306`, `voucher_size: beds`).
- **The property page** shows "Voucher size accepted" only when the value is a NUMBER
  (`ListingDetail.tsx:752-754`), so a stored list shows nothing.
- **The edit form** reads a stored list as an empty field (`ListingEditForm.tsx:30-32,68`), and
  saving a typed size there replaces the list with one number.

**Failure scenario.** A property with `beds: 3` and `voucher_size_accepted: 2` (the case the
field exists for): the Properties list files it under 2-BR, but its "Send to tenants" composer
pre-fills 3-BR voucher holders as "matching" the property, and the flyer tells them it fits a
3-bedroom voucher.

**Why filed, not fixed.** Found by the plan-blind reviewer of tracker #1 (code review r1, A3).
Every surface above is outside #1's scope: #12 owns the voucher-size write path and its display
(the multi-select), and #6 owns the Matching audience rules. The no-beds rule is settled for the
Properties filter only.

**Suggested fix.** With #12: make `voucherSizesOf` the one reader for "voucher sizes this
property takes" - the composer pre-fill and its tag, the property page, and the edit form (a
multi-select that round-trips a list) - and decide what the flyer's "Fits a N-bedroom voucher"
line should say when the accepted sizes differ from the bedroom count.
