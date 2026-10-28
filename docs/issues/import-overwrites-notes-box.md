---
id: import-overwrites-notes-box
title: Re-import replaces a tenant's whole Notes box, erasing extraction's matching lines
type: bug
severity: med
status: open
area: app/import
created: 2026-10-26
refs: app/src/lib/import/apply.ts:1196, app/src/services/extraction/apply.ts:713
---

**Problem.** The importer's `upsertContact` sets `notes = :notes` on an
EXISTING contact whenever the workbook row carries notes
(app/src/lib/import/apply.ts:1196-1198). That is a wholesale replace, not an
append. Extraction appends dated `[Auto - <date>]` lines to the same box,
and from WP1 slice B1 those lines are the matching facts the ranker reads
(charter docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
sections 6.1 and 6.4); the "Possible caseworkers" signal also reads them
(app/src/lib/caseworkers.ts:42-82). A re-import of a tenant whose row has
notes erases every accumulated line and any staff edits to the box.

Found by the B1 design review (2026-10-26, reviewer A finding 10); out of
B1's scope.

**Suggested fix.** On an existing contact, merge instead of replace: append
the workbook's notes when they are not already present verbatim, or skip
the notes write when the box is non-empty. Decide before the next
`import:apply` on production data.
