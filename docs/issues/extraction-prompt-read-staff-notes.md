---
id: extraction-prompt-read-staff-notes
title: Let the extraction prompt read staff notes as context (it reads only `notes` today)
type: improvement
severity: low
status: open
area: app/extraction
created: 2026-09-26
refs: app/src/jobs/extraction.ts:131, app/src/services/extraction/prompt.ts:97
---

**Problem.** The staff-notes feature (Sam's improvements list item 22, spec
`docs/superpowers/specs/2026-09-26-staff-notes-past-tours-design.md`) adds a
`staff_notes` field on contacts that staff write by hand. By decision the AI
neither reads nor writes it: `toProfile` (`app/src/jobs/extraction.ts:131`)
builds the model's profile from an explicit field list that names `notes` and
not `staff_notes`, and `applyExtraction` appends its `[Auto - <date>]` lines to
`notes` only.

That means a fact staff already recorded by hand ("stairs are a problem for
her") is invisible to the model, which may then re-extract it from a later
transcript and append a duplicate `[Auto - ...]` line to `notes`. The prompt's
reconciliation rule ("if the notes already express the fact ... omit the line",
`prompt.ts:99-112`) only sees `notes`.

**Suggested fix.** Add a read-only `staffNotes` field to the
`ExtractionProfileSnapshot` (populated from `staff_notes` in `toProfile`), and
teach the prompt to reconcile note lines against BOTH the profile notes and the
staff notes, while still appending only to `notes`. Keep the write side as it
is: the model must never write into `staff_notes`. Add a driver test that a
fact present in `staff_notes` produces no `noteLines` output, and an apply test
that `staff_notes` is byte-identical after a run.

Not built with item 22 because the mission decided the field is human-only for
now; revisit once Sam has used the box for a while and we can see what goes in
it.
