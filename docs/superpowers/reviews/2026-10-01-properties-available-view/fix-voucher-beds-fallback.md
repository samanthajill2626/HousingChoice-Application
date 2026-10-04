# Post-merge fix - voucher size falls back to bedrooms

Date: 2026-10-04. Branch `feat/properties-available-view` (re-used at Cameron's request;
it had been fast-forwarded into main at 71e532fb, and main had not moved).

## Report (Cameron)

"When I choose to list the available properties under a housing authority, it shows the
list and they all show properly, with the num of beds listed on the property, but then if I
use the voucher size filter, they all go away showing there are no available properties."

## Diagnosis (assessment before any edit)

Reproduced on 71e532fb in hermetic lane 7 with the `full` demo world: cobb_housing's
Available count lists two properties (3 and 4 bedrooms); picking 3-BR empties the list
("No properties match the selected filters.") while the summary says "15 properties have
no voucher size recorded and are not counted."; adding Not recorded brings both back.

Cause - not a state bug. The rows show `beds`; the voucher filter read only
`voucher_size_accepted`, which the import never writes (only the New/Edit property forms
do), so it is blank on almost every property. The approved design (D3, Cameron's answer of
2026-10-01: "Not recorded, no fallback") sent every blank property to Not recorded.

## Decision (Cameron, 2026-10-04)

D3 reversed: a property's voucher size is its recorded `voucher_size_accepted` when there is
one, otherwise its bedroom count; only when BOTH are missing is it Not recorded. It must be
ONE reusable function on a property, so every place that needs a property's voucher size
calls it instead of re-deriving the rule.

## Change

- `acceptedVoucherSizes(unit)` in `dashboard/src/routes/listing/listingFormat.ts` replaces
  `voucherSizesOf`: recorded size(s) (one number or a list) win; else `[beds]`; else `[]`.
  The Properties filter and summary read it through `unitListFacets.unitVoucherBuckets`.
- The property page and the New/Edit forms keep reading the stored field itself: they show
  and edit what was RECORDED, which is not the same question.
- No shared package exists between app and dashboard, so the server has no copy yet; when
  server code first needs a property's voucher size (Matching audience #6, WP1 matching,
  the flyer), its twin belongs in `app/src/lib/unitFields.ts` as the source of truth, with
  this one becoming its hand mirror - the `authoritiesOf` arrangement.
