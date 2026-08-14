---
id: import-address-cells-needing-cleanup
title: A few imported property address cells carry chat text or duplicate one property across spellings
type: bug
severity: med
status: open
area: app
created: 2026-08-13
refs: app/src/lib/import/addresses.ts, app/src/lib/import/apply.ts:1277
---

**Problem.** `parseUnitAddress` now splits the reviewed workbook's free-text
address cell into a structured `Address`, and it deliberately does NOT invent or
silently delete anything it cannot classify. That leaves two residues in the
2026-08-09 book that only a human can settle:

1. THREE cells carry her message text around the address, so the text lands in
   `line1` verbatim (which is the honest outcome - quietly trimming it would
   hide the problem):
   - `"2 bath here. 280 Richardson Rd NW ..."`
   - `"3 bed 280 Richardson Rd NW ..."`
   - `"4 bed voucher 1272 North Ave NW ..."`
   The first two are the SAME property as each other, and each also differs from
   the clean spelling - so one property currently exists as several unit records.

2. Several properties exist under both a bare and a unit-bearing spelling, and
   only she knows which pairs are one dwelling:
   - `"846 Durant Pl NE"` alongside `"846 Durant Pl NE Unit 2"` and `"Unit 5"`
   - `"995 Mayson Turner Rd"` alongside `"995 Mayson Turner Rd NW Unit B"`
   - `"1425 Joseph E Boone"` alongside the full `"... Blvd NW, Unit 104, ..."`
   (`findUnitAmbiguousKeys` already flags this class during planning; these are
   the ones that survived review.) Genuinely-different dwellings in one building
   are CORRECT as separate units - see the unit/property glossary - so this is
   not a dedupe to automate.

WHY IT MATTERS BEYOND TIDINESS: `unitId` is seeded from the raw address cell, so
each spelling is a separate property record with its own listing, media and
placement history. Merging them after the fact means re-pointing those
references, which is why fixing the CELLS before the prod import is much cheaper
than fixing the records after it.

**Suggested fix.** Correct the three junk cells in the reviewed workbook, and
have the founder confirm which bare/unit-bearing pairs are one dwelling, before
the 2026-08-17 cutover import. Re-running `import:apply` is idempotent, so a
corrected workbook converges - but note that a cell EDIT changes that unit's
`unitId`, so the pre-edit record is left behind and needs removing (there is no
retraction path for units today).
