---
id: extraction-text-field-write-races-staff-fill
title: An extraction write can overwrite a tenant field staff filled while the model call was running
type: bug
severity: low
status: open
area: app/extraction
created: 2026-10-27
updated: 2026-10-29
refs: app/src/jobs/extraction.ts:438, app/src/services/extraction/apply.ts:498, app/src/repos/contactsRepo.ts:743, app/src/services/extraction/apply.ts:995
---

**Problem.** Extraction decides whether a profile field is empty from the
contact it read at the start of the run (`contacts.getById`,
jobs/extraction.ts:438), before the message read, the organization-list read
(and, from WP1 B1, the properties-sent reads) and the model call. apply then
commits every field write in ONE unconditional `contacts.update`
(apply.ts:498-500). A staff PATCH that fills the same field inside that window
is overwritten by the model's value and stamped `<key>_source`, so the record
shows an Auto badge on a value staff did not type.

WP1 B1's rule that a model `write` on a FILLED tenant matching text field is
dropped (`text_field_filled`, spec 2026-10-26-wp1-b1-ranking-inputs D3: "the
model never rewrites staff text live") therefore holds against the run's
snapshot, not under concurrency. The same race already exists for pets,
evictions and tenure (the accepted last-write-wins class; the Notes box
read-modify-write accepts it too). Found by the WP1 B1 build research (reader
E1, 2026-10-27) and recorded there as an accepted residual.

**Suggested fix.** A conditional batched write: guard each text key the run
writes with its as-read value (`contactsRepo.update` already accepts `expect`
conditions, contactsRepo.ts:743-753, :869), and on
ConditionalCheckFailedException retry once without those keys and their
`_source` keys, recording each as dropped / `text_field_filled`, plus an apply
test whose first update throws that exception. Small, but it touches the
shared write path for every field: schedule it with the next extraction
change.

**Update (2026-10-29, WP1 B2a code review R1, finding A2-4).** The Notes
box is the same race, now with a cheap guard available. Extraction reads the
contact (jobs/extraction.ts:486) before the message, org-list and sends reads
and the model call (:673); apply then writes `notes` as the SNAPSHOT's box
plus the new `[Auto - ...]` lines, with no `expect`
(services/extraction/apply.ts:995). A staff edit-form save that lands in
between (accepted, its stamp moved) is overwritten: the page then refetches
on `suggestion.updated` and shows the Auto line without the staff text.
Reproduced on a stub store by the reviewer. WP1 B2a closed the OTHER
direction only (an edit form opened before an extraction append is refused
409 `notes_stale`); spec section 4 keeps extraction's Notes write unguarded,
and B2a's comment there now says so. Two things changed with B2a: every
Notes writer stamps `notes_updated_at` in the same write, so the guard is
one `expect`; and the box is ranking evidence (the tenant card carries it,
and the attach step files its lines under the homes they name), so a lost
staff line changes the next ranking.

Suggested fix for the Notes box: write the append with
`{ expect: { attr: 'notes_updated_at', value: <the snapshot's stamp, or null
for never stamped> } }`; on ConditionalCheckFailedException re-read the
contact (consistent), re-run `filterNoteLines` against the fresh box, and
write once more (bounded: one retry, then log it and drop the lines). Test:
an apply
test whose first update throws ConditionalCheckFailedException and whose
re-read returns the staff save; the second write holds the staff line plus
the new line.
