---
id: unit-voucher-size-readers-diverge
title: The property page and New/Edit forms cannot show or edit a recorded voucher-size LIST (#12); every reader now uses acceptedVoucherSizes
type: debt
severity: med
status: open
area: dashboard
created: 2026-10-01
refs: dashboard/src/routes/listing/listingFormat.ts, app/src/lib/unitFields.ts, dashboard/src/routes/broadcasts/BroadcastComposer.tsx, dashboard/src/routes/listing/ListingDetail.tsx:755-756, dashboard/src/routes/listing/ListingEditForm.tsx:105, dashboard/src/routes/listing/UnitCreateForm.tsx:114
---

**Update (2026-10-12) - both readers are FIXED and a recorded size can be cleared**, after a
prod report that a property with its own voucher size showed its bedroom count on the public
flyer:

- **The flyer** (branch `fix/flyer-voucher-size`): `acceptedVoucherSizes` now has its server
  twin in `app/src/lib/unitFields.ts` (the source of truth; the dashboard copy is its hand
  mirror, same test cases in both suites), and `toUnitFlyer` reads it.
- **Matching's pre-fill** (branch `fix/matching-voucher-prefill`): `BroadcastComposer`
  pre-fills and tags the chip from `acceptedVoucherSizes`, and the note names the voucher
  size the property takes instead of "this N-bedroom property".
- **Clearing** (same branch): `voucher_size_accepted` is a `clearable_number` field - a PATCH
  of null REMOVEs it - and emptying it in the edit form sends that null, so a wrong recorded
  size can be taken off and the property falls back to its bedrooms. Other number fields
  still cannot be cleared.

Both readers state ONE size; for a recorded list (only the demo seed holds one until #12)
they take the first, and #12 decides how several sizes are worded and matched.

**DECIDED (Cameron, 2026-10-12): the property page's "Voucher size accepted" row stays EMPTY
when nothing is recorded.** It shows the separate, editable field, and an empty row is how
staff see that it is empty - do NOT show the bedrooms fallback there (no "3 (from
bedrooms)"); that would conflate the two. This settles the last bullet below.

What remains is the #12 list shape: the property page row and the New/Edit forms take ONE
number today (below).

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

- ~~**A recorded size cannot be cleared.**~~ FIXED 2026-10-12 (see the update above). The
  multi-select must keep that: its empty state sends null.
- ~~**The property page shows nothing for a beds-only property.**~~ DECIDED 2026-10-12: that
  is correct - the row shows the recorded field only (see the decision above).

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
