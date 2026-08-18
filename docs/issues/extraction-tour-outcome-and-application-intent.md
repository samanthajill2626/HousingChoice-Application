---
id: extraction-tour-outcome-and-application-intent
title: Extraction has no target for tour outcomes or application intent, so they land in the notes blob
type: improvement
severity: low
status: open
area: app/extraction
created: 2026-08-18
refs: app/src/services/extraction/schema.ts:140, app/src/services/extraction/prompt.ts:72, app/src/services/extraction/apply.ts:657
---

**Problem.** Extraction has nine structured targets (eight scalar fields plus the
address parts object) and a free-text `noteLines` array. Tour outcomes ("toured the
duplex and liked it") and application intent ("wants to move forward with an
application") have no structured target, so the model records them as note lines -
prose appended to the contact's single `notes` string.

Both facts are already modeled as first-class entities elsewhere. Tours are their own
records with outcomes; the decision to apply is a placement-side step. A tour outcome
sitting in the notes blob is therefore data that cannot advance a tour, cannot drive a
Today item, and cannot be reconciled against the tour record it describes - it is only
readable prose.

Observed on production contact 9556186f-f040-525a-b86d-e651e920ba72, whose notes
carried three separate auto lines all narrating one tour and one intent to apply. That
contact's redundancy is a separate concern (fixed by tightening the noteLines
reconciliation rules; see below), but the reason the facts were in `notes` at all is
this missing target.

**Suggested fix.** Add tour-outcome and application-intent targets to the extraction
wire schema, routed to the tour and placement records rather than to notes, and
suppress event narration in `noteLines` once something else catches it. Two design
questions to settle first:

- A tour outcome must bind to a SPECIFIC tour record. The model would need candidate
  tours in the profile snapshot (id plus unit address plus scheduled date) and would
  have to pick one, which is a new class of extraction output - every existing target
  writes a scalar or an address object onto the contact itself, never a reference to
  another entity.
- Advancing a tour or a placement has real downstream effects (status transitions,
  reminders, Today items). This likely wants the suggestion/review path rather than
  the direct-write path, even where the profile field is empty.

Deliberately deferred: this is a nice-to-have, and the notes-side redundancy that
surfaced it is addressed independently.

Related: [extraction-notes-current-state-summary](./extraction-notes-current-state-summary.md)
