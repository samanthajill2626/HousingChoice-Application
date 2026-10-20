# Design review R4 - reviewer A (adversarial, final round under the cap)

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`,
revision 4 (commit be1e65f2). I read the 41c92e88..be1e65f2 diff cold, then
re-read D1, D5, D6, D8, D10 and D11 in full, and the round-3 adjudications.
Repo read at the same commit. This was a read-only review: nothing was run,
and the only file written is this one.

One new MEDIUM comes from the fresh sweep. It was in the design from
revision 1, and all four rounds missed it. The rest are LOW, mostly in the
round-3 changes.

---

## New findings

### 1. [MEDIUM] Apply treats "No pets" and "Pets (details)" as independent items, so the default flow publishes a contradictory pet policy on the public flyer

**What is wrong.** D1 splits pets into three items (No pets, Pets (details),
Pet fee). The flyer joins them: "'No pets' when checked, followed by the
details in parentheses" (D11). D8 copies items one at a time and flags a row
only when a CHANGING item is an own value. Here is the default Apply for a
landlord that ticks No pets and leaves the details blank:

- Left column: No pets has a value, so it starts CHECKED. The details are
  blank, so they start unchecked as "Clears".
- A property whose details read "Cats OK" changes only `no_pets`. Its No
  pets item is never touched and blank, so it is NOT an own value (D6).
  The row starts CHECKED and nothing on it is marked.
- After Update, the flyer reads **"No pets (Cats OK)"**. That is a public
  statement that contradicts itself, made by the default action, with no
  own-value mark in the dialog and no tag on the property page afterwards.
  (The details are never touched, non-blank, against a blank landlord item,
  so D6's new row shows no tag.)

This is the common case, not an edge. The seeds and live data hold such
text (`lean.ts:252` "Cats & dogs OK", `cast.ts:1359` and `live.ts:226` "Cats
OK", plus the matrix variants), and D1 itself says most live properties
carry pet text. The mirror case gives the same result: a landlord with
details "Cats OK" and No pets blank, applied onto a property whose No pets
was ticked on the property. A Pet fee kept beside a newly ticked No pets
contradicts the same way. With the legacy `pets: true` read as "Allowed", it
produces "No pets (Allowed)".

**What it implies.** The pets items are coupled in meaning, so Apply has to
couple them. One option: when a row's No pets changes and that property's
Pets (details) or Pet fee is an own value, mark it on that row as an own
value and start the row unchecked. Another: when No pets is checked on the
left, check the two pets text items on the left too. Merging the items back
into one is a third. Whichever is chosen, add the "No pets (Cats OK)" case
to the dialog tests and to the flyer wording tests. Do not fix it by parsing
text on the flyer: D1 deliberately refuses to parse pet text.

### 2. [LOW] The new landlord-blank row exempts only never-touched values, so every NEW or EDITED property brings the purple flood back

**What is wrong.** Revision 4's row reads "property value not blank,
landlord blank | absent (never touched) | the value, no tag". The `set_here`
row still says "different | `set_here` | purple + 'Landlord: <value>'".
Through D5, every value staff type on the New form where the landlord's item
is blank (a snapshot blank, the body non-blank) becomes `set_here`. So does
every PATCH of an existing value while the landlord's item is blank (it
differs from the current landlord). Most landlords record few items, at
least at first. Two properties with the same "$1000 deposit" under the same
silent landlord therefore look different: the old one shows no tag, and the
new one, or one whose deposit staff just corrected, shows **Set on this
property / Landlord: blank**. Staff will see editing a value turn on a
purple tag, which reads like a bug. This is R3-6's flood again, coming in
through classification. The D6 rationale ("the landlord has said nothing
about this item") applies whatever the record says.

**What it implies.** Apply the landlord-blank row to `set_here` as well.
Only `copied` against a blank landlord stays orange, because that means the
landlord cleared a value the property copied. OWN VALUE already covers
`set_here` "whatever the landlord holds", so Apply is unaffected.

### 3. [LOW] Apply's pets-pair normalization fits neither new rule: by stored keys it can loop on `changed_since_opened`, by value it relabels an item nobody applied

**What is wrong.** Take a property with a legacy `pets: true` that is never
touched (it reads: No pets unchecked, details "Allowed"). Staff apply only No
pets. D1 makes the write store both keys, so the `pets` key changes from
`true` to "Allowed" while its interpreted value stays the same. Revision 4
says "the items whose keys this write changed become `copied`" (D8), and the
server "compute[s] its changing items" with no definition of changing.

- **If "changing" means stored keys:** the details item is changing, and it
  is an own value (never touched, non-blank). The dialog never listed it in
  `ownItems`, because its shown value does not change. The server skips the
  unit as `changed_since_opened`. Reopening recomputes the same rows, so
  that property can never receive No pets through Apply.
- **If "changing" means interpreted value:** the unit is written, but the
  normalized details item's keys did change, so it becomes `copied` though
  nobody applied it. If it differs from the landlord ("Allowed" against
  "Cats only"), it then shows "Landlord updated", and the next Apply starts
  it CHECKED.

**What it implies.** Define it explicitly. Changing items and the own-value
check are by INTERPRETED value. Only LISTED items whose keys the write
changed become `copied`. A partner key rewritten purely by normalization
keeps its record. PATCH already handles this through D5's comparison rule.
This affects legacy boolean data only, and how much of that exists in
production is UNVERIFIED.

### 4. [LOW] "Accepted only together with a `landlordId`" does nothing; the snapshot's landlord is still unverified (contesting the R3-4 rejection, identity half)

**What is wrong.** A create without a `landlordId` is already a 400
(`unitFields.ts:226-230`), so "it is accepted only together with a
`landlordId`" adds no check. R3-4 raised two halves: the snapshot's VALUES,
and the snapshot coming from a DIFFERENT landlord than the body's
`landlordId`. The adjudication rejected verifying the values, because a copy
should stay a copy when the landlord changed while the form was open. That
argument does not reach the identity half. Recording which landlord the
snapshot came from contradicts nothing in R2-4. D7's refill on a landlord
change is exactly where a client bug would pair one landlord's snapshot
with another landlord's id, recording every pre-filled item as `copied`
from a landlord it never came from.

**What it implies.** Put the landlord's id inside `requirements_snapshot`,
and answer 400 when it is not the body's `landlordId`. That is one line and
needs no read. I concede the values half: trusted, with the reasons given.

### 5. [LOW] After an Apply that followed a 409 re-read, the landlord page's Requirements card still shows the old landlord values

**What is wrong.** The dialog re-reads the landlord on open and after a 409
(D8). The page's own contact comes from `useContact`, which loads once
(`useContact.ts:30-45`) and refreshes only on `suggestion.updated`
(`:55-71`). After the dialog closes, the spec refetches only the PROPERTIES.
So when a colleague changed the landlord and the dialog picked that up, the
properties now hold the NEW values while the card beside them shows the old
ones until a reload.

**What it implies.** The dialog hands its fresh contact to the page's
`setContact` (`useContact.ts:51-53`), or the page re-reads the contact
together with its properties.

---

## The round-3 fixes, checked against the mechanism

- **R3-1 (tag in accessible name).** CLOSED. The tag sits outside the label
  text and is tied to the field with `aria-describedby`. Note: the forms'
  wrapping labels (`ListingEditForm.tsx:464-472`) mean the markup must
  change. "Outside the `<label>` text" has to mean outside the `<label>`
  ELEMENT, because any text inside a wrapping label is part of the field's
  name.
- **R3-2 (own value vs display).** CLOSED. OWN VALUE is now defined by the
  table and never by what the card displays. The gap left is finding 3, the
  pets normalization.
- **R3-3 (Apply relabels unchanged items).** CLOSED for ordinary items.
  The normalization edge is finding 3.
- **R3-4 (snapshot).** Tolerance CLOSED: missing items fall back, missing
  keys count as blank, unknown items are ignored. Trust is CONCEDED for the
  values; the identity half is contested in finding 4.
- **R3-5 (no-snapshot rule).** CLOSED.
- **R3-6 (day-one flood).** CLOSED for existing values; it comes back for
  new and edited values (finding 2).
- **R3-7 (hand-check wording).** CLOSED: the row resets only when an
  own-value item is added.
- **R3-8 (batching).** CLOSED: stop, re-read, then the honest "Updated N
  ... before this stopped".
- **R3-9 ("Save again").** CLOSED. Saving again is safe because the patch is
  dirty-tracked and the server recomputes on every attempt.
- **R3-10 (deposit null on every save).** CLOSED: the null is sent only on
  the save that checks One month's rent. The dead-end case is still
  covered.

## Adjudications contested

- **R3-4, verification half:** contested in part. The identity half is
  defensible (finding 4, `unitFields.ts:226-230`). I concede the values
  half.
- Everything else from rounds 1-3: no contest.
