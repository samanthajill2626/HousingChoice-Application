---
id: import-washer-dryer-not-mapped
title: The Airtable import parses the "Washer Dryer?" column and drops it - imported properties never get washer_dryer
type: improvement
severity: low
status: open
area: app
created: 2026-10-21
refs: app/src/lib/import/airtableSource.ts:57, app/src/lib/import/airtableSource.ts:155, app/src/lib/import/workbook.ts:299-317, app/src/lib/import/apply.ts:1456-1621, app/src/lib/unitFields.ts
---

**Problem.** The Airtable source reader parses each property row's `Washer Dryer?` cell into
`AirtableProperty.washerDryer` (`app/src/lib/import/airtableSource.ts:57,155`), and nothing
reads it: the workbook's property rows carry no washer/dryer column
(`app/src/lib/import/workbook.ts:299-317`), and the import's unit write (`upsertUnit`,
`app/src/lib/import/apply.ts:1456-1621`) sets no `washer_dryer`. Since property requirements
(tracker #12, spec `docs/superpowers/specs/2026-10-20-property-requirements-design.md` D3)
`washer_dryer` is a real unit field - `hookups`, `included` or `none`, shown on the property
page and the public flyer - so the answer recorded in Airtable is lost on import and staff must
re-enter it by hand on each property. The spec kept importer changes out of scope (section 5),
so this was filed, not fixed (found by build research R1, finding R1-F5).

Related: the same reader also parses `Voucher Size Needed` (`airtableSource.ts:53,152`), and
nothing maps it to `voucher_size_accepted` either - the import never writes a voucher size (spec
section 2), so an imported property falls back to its bedrooms.

**Suggested fix.** Add a washer/dryer column to the workbook's property tab and map the
Airtable answers onto the three values (`hookups`, `included`, `none`), leaving an answer that
fits none of them for review; write it like the other property facts (every fact on an
import-owned unit, `if_not_exists` on a human-owned one - the ownership rule above `upsertUnit`).
Look at the real column's values first: the parser keeps the raw cell text.
