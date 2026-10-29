---
id: import-overwrites-notes-box
title: Re-import replaces a tenant's whole Notes box, erasing extraction's matching lines
type: bug
severity: med
status: open
area: app/import
created: 2026-10-26
updated: 2026-10-29
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

**Update (WP1 B2a, 2026-10-29): the importer now stamps `notes_updated_at`.**
B2a's Notes guard (spec D14.3) has every Notes writer stamp
`notes_updated_at` in the same write as the box, the importer included: its
one upsert sets the stamp (to the run's `importedAt`) beside
`notes = :notes` whenever the workbook row carries notes - also when the
text is UNCHANGED (app/src/lib/import/apply.ts, `upsertContact`). So a
contact edit form open across an import meets the "These notes were changed
since you opened this form" conflict over identical text (the form shows
the current notes; Save again stores the typed text). Accepted with D14.3.
The replace itself is unchanged and this issue stays open: a
merge-instead-of-replace fix should also skip the stamp when the text does
not change. Since B2a the ranking's tenant card also reads the Notes box,
so a replace now also changes what the next ranking sees.
