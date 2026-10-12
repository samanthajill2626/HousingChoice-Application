---
id: unit-voucher-size-readers-diverge
title: Matching's pre-fill reads a property's voucher size from beds instead of acceptedVoucherSizes (the flyer is fixed)
type: debt
severity: med
status: open
area: dashboard
created: 2026-10-01
refs: dashboard/src/routes/listing/listingFormat.ts, dashboard/src/routes/listings/unitListFacets.ts, dashboard/src/routes/broadcasts/BroadcastComposer.tsx:256-263, dashboard/src/routes/broadcasts/AudienceFilters.tsx:91, app/src/lib/unitFields.ts, dashboard/src/routes/listing/ListingDetail.tsx:755-756, dashboard/src/routes/listing/ListingEditForm.tsx:105, dashboard/src/routes/listing/ListingEditForm.tsx:188
---

**Update (2026-10-12) - the flyer half is FIXED** (branch `fix/flyer-voucher-size`),
after a prod report that a property with its own voucher size showed its bedroom count on
the public flyer. `acceptedVoucherSizes` now has its server twin in
`app/src/lib/unitFields.ts` (the source of truth; the dashboard copy is its hand mirror,
same test cases in both suites), and `toUnitFlyer` reads it. The flyer still states ONE
size: for a recorded list (only the demo seed holds one until #12) it shows the first, and
#12 decides how the flyer words several sizes.

Still open: **Matching's pre-fill** (below) - Cameron asked for it next, single-size
only (no multi-select until #12). The #12 items further down are unchanged.

**Update (2026-10-04).** The rule is now settled and lives in ONE place: a property's voucher
size is its recorded `voucher_size_accepted` when there is one (one number, or a list after
#12), otherwise its bedroom count, and "Not recorded" only when both are missing (Cameron,
reversing the 2026-10-01 no-fallback call after seeing every size chip empty the Properties
list - the import never writes the field). The reader is `acceptedVoucherSizes(unit)` in
`dashboard/src/routes/listing/listingFormat.ts`; the Properties list's filter and summary use
it. This issue now tracks the readers that still derive a property's voucher size on their own.

**Problem.** Two surfaces still answer "which voucher sizes does this property take?" from
`beds`, ignoring a recorded voucher size:

- **The Matching composer** pre-fills the audience's voucher size from the property's `beds`
  (`BroadcastComposer.tsx:219-227`) and labels it as matching the property
  (`AudienceFilters.tsx`). Its filter holds ONE size, so a property recording a list needs a
  rule for which size(s) to pre-fill.
- **The public flyer** tells tenants it "Fits a N-bedroom voucher" from `beds`
  (`app/src/lib/unitFields.ts:294-306`, `voucher_size: beds`) - server code, so it needs the
  server twin of `acceptedVoucherSizes` (in `unitFields.ts`, with the dashboard copy becoming
  its hand mirror, as `authoritiesOf` does).

Separately, for #12's multi-select: **the property page** shows "Voucher size accepted" only
when the stored value is a NUMBER (`ListingDetail.tsx:752-754`), and **the edit form** reads a
stored list as an empty field (`ListingEditForm.tsx:30-32,68`), so saving a typed size there
replaces the list with one number. These two show and edit the RECORDED field, so they should
keep reading it directly - but they must take the list shape. Two more for #12, from the review
of the bedrooms fallback (2026-10-04):

- **A recorded size cannot be cleared.** The edit form skips an emptied number
  (`ListingEditForm.tsx:101`, "clearing a number isn't supported") and the unit PATCH rejects
  null for a number field (`app/src/lib/unitFields.ts:165-167`). A wrong recorded size can be
  corrected to another number, but never removed to fall back to the bedrooms again. The
  multi-select needs an explicit empty state that removes the field.
- **The property page shows nothing for a beds-only property**, while the Properties list
  files it under its bedroom chip. Decide whether the page shows the effective size (for
  example "3 (from bedrooms)") beside or instead of the recorded row.

**Failure scenario.** A property with `beds: 3` and `voucher_size_accepted: 2` (the case the
field exists for): the Properties list files it under 2-BR, but its "Send to tenants" composer
pre-fills 3-BR voucher holders as "matching" the property, and the flyer tells them it fits a
3-bedroom voucher. A property with only `beds` agrees everywhere.

**Why filed, not fixed.** Found by the plan-blind reviewer of tracker #1 (code review r1, A3).
The surfaces above belong to #6 (Matching audience rules) and #12 (the voucher-size field and
its display).

**Suggested fix.** #6: pre-fill and tag from `acceptedVoucherSizes` (decide the list case).
Flyer: add the server twin and decide what "Fits a N-bedroom voucher" says when the accepted
sizes differ from the bedrooms. #12: the property page and edit form take the list shape.
