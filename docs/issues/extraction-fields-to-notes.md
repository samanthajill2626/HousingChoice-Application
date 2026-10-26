---
id: extraction-fields-to-notes
title: Extraction writes matching facts into separate tenant fields instead of the Notes box
type: decision
severity: med
status: deferred
area: app/extraction
created: 2026-10-26
refs: app/src/services/extraction/schema.ts:23, app/src/services/extraction/apply.ts:713, docs/superpowers/specs/2026-10-24-wp1-matching-charter-design.md
---

**Problem.** Facts about a tenant live in several places: the profile fields
extraction reconciles (voucher size, authority, pets, evictions, tenure,
porting), the Notes box where extraction appends dated `[Auto - <date>]`
lines, Staff notes, custom fields, and - from WP1 slice B1 - four more fixed
fields (area preference, maximum tenant portion, accessibility need,
preferences and constraints). Cameron (2026-10-26, at the B1 restatement):
"we have multiple different places where data exists that's not part of the
person. These additional fields that we're trying to add on a tenant, I'm
pretty sure they should all just sit in notes." His direction: "eventually
... All of these extra fields will end up being extracted into notes rather
than put into specific fields on a tenant, like location or matched rent
amount". He did not want it to hold up B1.

B1 builds the four fields anyway because Amendment No. 1 names them ("new
tenant preference fields (area, maximum tenant portion, free-text
constraints) on the record, the edit form and the AI reading layer"); moving
them is a later change Sam should hear about.

**What B1 and B2 do so the move is cheap** (charter section 6.4, amended
2026-10-26):

- One list in code names each tenant matching input and its source (a field
  today). Extraction's field entries and B2's completeness pass read it.
- The ranker's tenant card already carries the whole Notes box, so the
  ranker needs no change when a source moves from a field to notes.
- The edit-form inputs and record display for the four fields stay thin.

**Suggested fix (when taken up).** Redesign extraction storage as a whole,
not field by field: decide which facts are "part of the person" (identity,
voucher, authority - the facts the pool and the completeness pass must read
in code) and which are matching context that belongs in notes. For each fact
moved: change its source in the one list, stop extraction writing the field,
let the widened notes instruction pick it up, decide whether existing field
values are folded into notes as lines, and remove the edit-form input.

**Known cost.** B2's completeness pass (charter 7.3) checks missing inputs in
code against fixed fields. A fact that lives only in notes cannot be checked
that way; its gap would come from the ranker's own unknowns instead, and the
"missing area preference" banner would be the model's report, not a field
check. Moving the facts named in A1 also departs from the signed text, so Sam
hears it first.
