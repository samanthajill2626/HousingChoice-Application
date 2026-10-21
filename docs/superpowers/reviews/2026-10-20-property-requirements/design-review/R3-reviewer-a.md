# Design review R3 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`,
revision 3 (commit 41c92e88). I read the 254bc576..41c92e88 diff cold, then
re-read the whole spec. I also read the round-2 adjudications (no
rejections). Repo read at the same commit. This was a read-only review:
nothing was run, and the only file written is this one.

There are no BLOCKING, HIGH or MEDIUM findings this round. Revision 3's
mechanisms work as designed. What remains are interaction and wording gaps,
most of them in the new material.

---

## New findings

### 1. [LOW] The round-2 `{ exact: true }` fix breaks if the On flyer / Staff only tag sits inside the field's `<label>`, and the spec does not say where the tag goes

**What is wrong.** Both property forms use WRAPPING labels:
`<label><span>Notes</span><textarea/></label>` (`ListingEditForm.tsx:464-472`;
same pattern in `ContactEditForm.tsx:986-993`). D10 puts a tag "beside its
label" on EVERY property-form field, and D10a gives Notes the Staff only
tag. In this markup, the natural place for that tag is inside the `<label>`.
The accessible name then becomes "Notes Staff only", and the round-2 fix
`getByLabel('Notes', { exact: true })` at `listing-activity.spec.ts:293`
matches nothing. The same applies to every exact label lookup in the
dashboard unit tests. Testing Library's `getByLabelText` matches exactly by
default, and `ListingEditForm.test.tsx` and `UnitCreateForm.test.tsx` hold 40
such lookups, for example `getByLabelText('Notes')` at
`ListingEditForm.test.tsx:101`.

**What it implies.** Specify that the tag is NOT part of the accessible name
(render it outside the `<label>` and point to it with `aria-describedby`).
That keeps every existing selector and the field names screen readers
announce. Otherwise list the selector churn in section 7.

### 2. [LOW] D6's "no requirements recorded yet" rule and D8's own-value marks disagree for a landlord with nothing recorded, and Apply can end in a skip loop

**What is wrong.** D6 now hides all tags when the landlord has every item
blank. D8 defines own values as "the D6 purple cases", and the server
computes them "from its own `requirement_sources` and values (D6)". For a
landlord with nothing recorded, which is every landlord on day one, the D6
TABLE still has purple cases, but the D6 DISPLAY shows none. If the dialog
uses the display helper, it sends empty `ownItems`. The server computes the
own values from the table and skips every row with an existing value as
`changed_since_opened`. Reopening repeats the same computation, so this is
the same loop R2-1 closed, reached another way. The realistic trigger is
staff checking a "Clears" item to wipe a field across a new landlord's
properties.

**What it implies.** One sentence in D8: own values come from the D6 table
and are never suppressed by the "no requirements recorded yet" note. The
dashboard tests should cover the all-blank landlord.

### 3. [LOW] Apply marks EVERY listed item `copied`, contradicting D5's new rule ("classify every item whose stored keys a write actually changes")

**What is wrong.** D8 writes "the whole new `requirement_sources` map (listed
items `copied`)", and D5 says "Apply: every applied item becomes `copied`".
D5's general rule, new in this revision, classifies only items whose stored
keys change. Take a listed item that does NOT change on a unit (its value
already equals the landlord's) but is `set_here`, an exception that happens
to equal the landlord. It is silently relabelled `copied` whenever some
OTHER item on that unit changes. On a unit with no changing item it is
skipped as `already_matches` and keeps `set_here`. The relabel therefore
depends on unrelated items. When the landlord later changes, the relabelled
item shows orange "Landlord updated", and the next Apply starts it CHECKED.
An exception staff set on purpose then becomes a default overwrite.

**What it implies.** Apply should mark `copied` only the items whose keys it
wrote, which is the D5 rule. A listed, unchanged item keeps its source.

### 4. [LOW] The create snapshot is an unchecked client claim, and its all-or-400 coverage rule conflicts with the repo's stale-bundle principle

**What is wrong.**
- **Trust.** Revision 1 made the sources server-only because "client-supplied
  source sets are not accepted". With `requirements_snapshot`, the client now
  decides every item's classification on create, and the server cannot check
  it. A snapshot that was never the landlord's values (a buggy form, or a
  snapshot from a different landlord than the body's `landlordId`) records
  `copied` for values that were never copied. Those later show "Landlord
  updated" and start CHECKED in Apply. Apply already uses the safer pattern:
  check the client's view against the landlord's current values and answer
  409 with fresh values. The snapshot could do the same, letting the form
  refill. The adjudication preferred "a copy stays a copy even if the
  landlord changed", but nothing verifies that it was a copy.
- **Brittleness.** "The snapshot must name every item with every key (400
  otherwise)." Adding a registry item or key later (Work Package 1 reads
  these inputs) makes every New form left open from before that deploy fail
  to create. Apply's `expected` "must cover exactly the listed items and
  their keys" has the same problem. The repo's rule for writable fields is
  that "a stale cached dashboard bundle must not fail its save"
  (`unitFields.ts:119-129`, the tombstones).

**What it implies.** Either verify the snapshot against the landlord's
current values (409 with fresh values on a mismatch), or state plainly that
it is trusted. Treat items missing from a snapshot as never touched, not
as a 400.

### 5. [LOW] The no-snapshot create rule contradicts the general classification rule for blank body values

D5's general rule: "classify every item whose STORED keys a write actually
changes". The no-snapshot bullet: "only items whose keys are in the body are
classified". An API create carrying `pet_fee: ''` (or `null`, or `false` for
a checkbox) writes nothing, because blank means REMOVE, which is a no-op on
create. The general rule leaves that item never touched. The no-snapshot
rule classifies it, as `set_here` when the landlord has a value. Pick one;
the general rule is the safer of the two.

### 6. [LOW] The landlord-wide "no requirements yet" rule fixes only the day-one snapshot and also hides genuinely stale copies

- **The flood returns.** Once a landlord records ONE item (say Credit
  score), the rule stops applying. Every existing deposit, pets text,
  application fee, tour type and tour process on its properties then shows
  purple "Set on this property / Landlord: blank" again. This is R2-9, one
  item at a time. A per-item rule fixes the display without the flood: an
  item never touched, with the landlord's value blank, shows the value with
  no tag. Apply can keep treating it as an own value (unchecked "Clears"), so
  nothing is overwritten.
- **Stale copies hidden.** A landlord that clears all its requirements has
  the same "every item blank" state as a landlord that never recorded any (a
  contact has no `updated_at`). Every `copied` item on its properties then
  loses its "Landlord updated" tag. That contradicts Goal 3: "staff can
  always see ... which are out of date".

### 7. [LOW] The hand-check reset rule says two different things

D8: a hand-checked row "stays checked only while its own-value items are the
ones it had when staff checked it: if a left-column change ADDS an own-value
item to that row, the row resets". The first clause also resets when an own
value is REMOVED (an item unchecked on the left). The second resets only
when one is ADDED. The safe behavior and the tests in section 6 both need
one rule, and "resets on add" is the one that matches the stated intent.

### 8. [LOW] Batching changes what "nothing is applied" means, and a failed batch has no defined outcome

Every batch of 100 runs its own 409 check. If the landlord changes between
batch 1 and batch 2, batch 1 is applied (with the old values) and batches 2+
answer 409. The D8 text "nothing is applied" is then true per request but
not for the action. A network failure on batch N leaves no response to
merge, and the "Updated N / M skipped" summary is undefined. State both
cases: the dialog re-reads and reports what was applied, and the 409 copy
says some properties were already updated.

### 9. [LOW] The 409 `property_changed` copy tells staff to throw their edits away

"This property changed while you were saving. Reload and try again." The
edit form is a modal, so reloading discards what staff typed. Saving again
is safe: the dirty-tracked patch only SETs the changed fields, and the
server re-reads and recomputes on every attempt. The copy should say
"Save again" (or "Try again"), keep the dialog open, and be listed under
`ListingEditForm.tsx` with its catch path. Today every non-org error shows
"Couldn't save - please try again." (`ListingEditForm.tsx:249-259`).

### 10. [LOW] "Send the amount as null whenever One month's rent is checked" makes the landlord's history log a deposit change on every save

For contacts PATCH, `changedFields` are the body's keys, not a diff
(`contacts.ts:581-587` pushes on presence). D2/D13 say "The audit
`contact_updated` lists the changed `req_` keys". If "whenever checked"
means every save while the box is ticked, every landlord save (a Company
fix, for example) records `req_deposit`. It also reads a pending
suggestion for it (`contacts.ts:1784-1793`). The stale-form dead end R2-7
describes needs the null only on the save that CHECKS the box. Say "on the
save that checks it", or have the contacts audit list only keys whose
stored value changed.

---

## The round-2 fixes, checked against the mechanism

- **R2-1 (stale Apply, retry loop).** CLOSED. The re-read on open and after
  a 409, plus the server's `ownItems` / `changed_since_opened` check,
  enforce Goal 3 on the server. The new interaction is finding 2.
- **R2-2 (hand-check).** CLOSED in intent; the wording conflict is finding 7.
- **R2-3 (unfenced map).** CLOSED. Conditioning on the map and `landlordId`
  read, with 3 attempts, mirrors `updateRosterIfCurrent`
  (`unitsRepo.ts:948-1017`) and stops a slow PATCH writing a removed map
  back. The residual is acceptable: the fence covers the map, not the item
  values, so two simultaneous edits of different keys of one item that
  leave its classification unchanged can combine into a value neither
  edit's classification saw. That needs a sub-second race. The copy is
  finding 9.
- **R2-4 (create classification).** CLOSED for the stale-picker case and for
  API creates. The snapshot design itself is findings 4 and 5.
- **R2-5 (Notes selector).** INCOMPLETE: finding 1.
- **R2-6 (raw pets boolean).** CLOSED. A written boolean means the read
  interpretation, and classification follows stored-key changes.
- **R2-7 (deposit edges).** CLOSED. The audit side effect is finding 10.
- **R2-8 (repo method, cap).** CLOSED. Batching edges are finding 8.
- **R2-9 (day-one flood).** PARTIAL: finding 6.
- **R2-10, R2-11, R2-12.** CLOSED as written.

## Adjudications contested

None. Round 2 had no rejections, and every accepted fix is described above.
The two round-1 rejections stay conceded.
