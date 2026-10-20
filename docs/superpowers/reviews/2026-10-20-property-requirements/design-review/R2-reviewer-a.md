# Design review R2 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`,
revision 2 (commit 254bc576). I read it cold, then diffed it against
revision 1 (53757846). I also read `R1-reviewer-b.md` and `adjudications.md`.
Repo read at the same commit. This was a read-only review: nothing was run,
and the only file written is this one.

Order: new problems first (1-3, then the LOW ones), then a check of the
round-1 fixes, then the adjudications.

---

## New findings

### 1. [MEDIUM] Apply runs on landlord-page state that may be hours old, so the server never checks Goal 3, and a 409 retry loops forever

**What is wrong.** The D8 dialog works out each row's "own value" marks and
its default check from the units the landlord page loaded. It reads the
landlord's values (and therefore `expected`) from the contact the page
loaded. Both are loaded once:

- Units: `useContactFile.ts:149-158` (one `getAllUnits`; the only reload is
  the manual `refetch`, `:124-125`, which the spec calls only AFTER an
  Apply).
- Contact: `useContact.ts:30-45` loads it once. The only re-read is on a
  `suggestion.updated` event (`:55-71`).

The server's per-unit pre-read (D8) checks existence, deletion and
`landlordId`. It never looks at `requirement_sources`, so it overwrites
whatever the client sends for a checked row. Two consequences follow:

- **Goal 3 fails across the page's whole lifetime, not just a race
  window.** Suppose a colleague sets an exception on property P (or creates P
  with a cleared item) after this landlord page loaded. To this page, P's
  item still looks never-touched or copied, so its row starts CHECKED.
  Update then overwrites the exception. Goal 3 promises that "an exception is
  overwritten only when staff check that property on purpose", and that row
  was checked by default from stale data. D8's last paragraph accepts "a
  property edited between opening the dialog and pressing Update". The real
  window starts when the page loaded, which with long-lived tabs can be
  hours.
- **The 409 retry path is a dead end.** On `requirements_changed` the dialog
  says "Close and try again". Reopening rebuilds `expected` from the same
  in-memory contact, so it gets the same 409 every time, until staff reload
  the page.

**What it implies.** The server already does a consistent read per unit, so
enforcing Goal 3 there costs little. The client can send, per unit, the
own-value items it showed (or the sources map it saw). The server then skips
a unit as `changed_since_opened` when a listed item is now an own value the
client did not show. The dialog should also re-read the contact and the
units when it opens and after a 409, or the 409 body should carry the
current landlord values.

### 2. [MEDIUM] The new hand-choice rule lets a row staff checked earlier overwrite an own value that only came into play afterwards

**What is wrong.** Revision 2 changed the recompute rule. A row "staff
checked or unchecked by hand keeps the hand choice unless it becomes
'Already matches'" (D8). Revision 1 kept only hand UNchecks ("does not
re-check a row staff unchecked by hand unless that row's state changes").
The same paragraph promises: "A row with its own values is updated only when
staff check it."

Here is the failure. Row P starts unchecked because of an own value in Pets.
Staff read its list and check P by hand, accepting that Pets is overwritten.
Staff then check Tour type on the left, which starts unchecked because the
landlord's tour type is blank ("Clears"). P has its own tour type, so P's
changes now include a new own value. P keeps the hand check, and Update
clears P's tour type. That changes how its "interested" replies route
(section 4, first bullet). Staff checked the row on purpose, but before this
exception was part of the change.

**What it implies.** A hand check must be dropped (the row resets to
unchecked) whenever the row gains an own-value item it did not have when
staff checked it. A hand uncheck may stay. Add this case to the dashboard
dialog tests (section 6).

### 3. [LOW] The whole-map rewrite of `requirement_sources` has no fence, and the spec's reason for accepting that understates the risk

**What is wrong.** D5 writes the map "always WHOLE", as a read-modify-write.
PATCH computes it from a consistent read. Apply computes it from its
per-unit pre-read and writes it conditioned only on existence, not deleted
and `landlordId` (D8). The acceptance sentence says "two staff editing the
same requirement of the same property at the same second", which is wrong
in three ways:

- Because the map is rewritten whole, a stale writer reverts the source of
  EVERY item in the map, not just the one it edited. Two edits of DIFFERENT
  items collide.
- A PATCH that read the map before a restore swap or a roster claim REMOVEd
  it writes the old map back. PATCH's write is not conditioned on
  `landlordId`. The sources then come back against a landlord they were
  never classified for, which is the A3 defect this revision just fixed.
- "Like every unit PATCH today" is not accurate. Today a unit PATCH is a
  SET-merge that does not depend on what it read (the `media` diff aside).
  Classification makes PATCH a read-modify-write of shared state for the
  first time. The repo's own pattern for that case is an optimistic
  condition plus retry (`updateRosterIfCurrent`, `unitsRepo.ts:948-1017`,
  which compares `landlordId` and `contacts`).

**What it implies.** Condition both the PATCH and the Apply map write on the
map (and `landlordId`) value they read, and retry or 409 when the condition
fails. This reuses an existing pattern. If the spec still accepts the race,
the stated reason should describe the real exposure.

### 4. [LOW] "Create classifies all twelve items" turns any left-out key into a deliberate exception, including for callers that know nothing about requirements

**What is wrong.** D5 counts a key left out of POST as blank and classifies
it. That is right for the new form (it closes R1 A2), but `POST /api/units`
is an API. Some callers never send requirement keys: e2e API setup (for
example `tours-page.spec.ts:317`), scripts, and any `UnitCreateForm` bundle
still open from before the deploy. For a landlord WITH requirements, each of
those creates is recorded as every non-blank item `set_here`, with blank
values. D6 shows twelve purple "Set on this property" tags, and the Apply
row starts unchecked as though staff had cleared everything on purpose.

The same applies to the new form with a stale landlord. The picker's
landlord list is loaded once at mount (`UnitCreateForm.tsx:136-169`), while
the server classifies against the landlord's CURRENT values. If a colleague
edited the landlord in between, the fields staff left unchanged are
recorded as exceptions. D7 promises "an unchanged field is a copy".

**What it implies.** Make the inference explicit and narrow. Either the form
declares that it carries the requirements section (a body flag, or the
landlord values it used as a snapshot, which the server compares like
Apply's `expected` and answers 409 on), or a create without that
declaration leaves left-out items never touched. The new e2e spec will need
this too. Its "another property shows Landlord updated" step only works if
that property's pets item was created as `copied`.

### 5. [LOW] A "Deposit notes" label breaks two existing e2e flows that select `getByLabel('Notes')`, and section 7 does not list them

**What is wrong.** D1 gives `deposit_notes` no label. Any label containing
"notes", such as "Deposit notes", makes Playwright's default (substring,
case-insensitive) `getByLabel('Notes')` match two fields. That is a
strict-mode failure in:

- the LANDLORD edit dialog, `teamRecordsLandlordOnboarding`
  (`e2e/scenarios/steps.ts:1515`), driven by
  `landlord-onboarding.spec.ts:55,73` with `softTermsNote`. The new
  Requirements fieldset lives in that dialog (D9).
- the PROPERTY edit dialog, `listing-activity.spec.ts:293`. That spec is not
  in section 7.

Placing the D10 tags inside the `<label>` would not avoid the collision,
because the substring still matches.

**What it implies.** Name the field's label, and either keep "Notes" out of
it or switch those two selectors to `{ exact: true }`. List both in section
7.

### 6. [LOW] The pets rule for a raw boolean write contradicts itself, and the item the server changes is never classified

**What is wrong.** D1 says a boolean `pets` is "stored in the new shape at
once" and also that the write must "keep the other item's interpreted value
unchanged". For a raw `pets: false`, the new shape means No pets checked.
That is exactly a change to the OTHER item, so the two rules conflict. D5
then classifies only items "ANY of whose keys is in the body". The body
carries `pets`, so the No pets item's value changes while its source stays
as it was. A `copied` No pets item then shows "Landlord updated" for a
change that was made on the property.

**What it implies.** Pick one meaning for a raw boolean. Then classify every
item whose stored keys the write actually changes, after normalization,
rather than every item whose keys appear in the body. The same rule then
also covers Apply's normalized writes.

### 7. [LOW] The deposit rule leaves four edges open

- The landlord-side `deposit_conflict` check runs on `stored`, which
  contacts PATCH reads with a plain (eventually consistent) read unless the
  body changes type, role or an organization field (`contacts.ts:1548-1556`).
  A conflict can therefore pass and be stored.
- Apply copies all four Deposit keys. Nothing says what Apply does when the
  landlord holds both (copy the conflict onto properties, refuse, or skip).
- A landlord form opened before a colleague set `req_deposit` sends only
  `req_deposit_one_month: true`, because the amount looked unchanged to it.
  The PATCH then 400s with no recovery other than a reload. The form should
  always send the amount clear when it checks One month's rent.
- D11 has no wording for Flexible alone, or for notes alone. Read literally,
  it prints ", flexible / payment plan available" with a leading comma. It
  also never says whether a Deposit row appears when only the staff-only
  notes are set.

### 8. [LOW] The Apply write is a new repo method that section 7 does not list, and the 200 cap has no dialog behavior

- D8's write is conditioned on existence, not deleted, and `landlordId`.
  `unitsRepo.update` conditions only on `attribute_exists(unitId)`
  (`unitsRepo.ts:1139`). The harness bullet says the fake mirrors "the Apply
  condition", but the `unitsRepo.ts` bullet in section 7 does not name the
  new method.
- The server returns 400 above 200 `unitIds`, but the dialog has no cap and
  no batching. A landlord-typed property manager with more than 200
  properties of record would get a 400 that names nothing. Whether any
  exists is UNVERIFIED.

### 9. [LOW] On day one every existing property is covered in purple tags against landlords that record nothing

D6 shows "different, never touched, non-blank" as Set on this property, and
prints a blank landlord value as "blank". On deploy no landlord holds any
`req_` key. Every existing deposit, pets text, application fee, tour type and
tour process on every property therefore shows a purple **Set on this
property** tag plus "Landlord: blank". The seeds behave the same way: every
matrix property with pets text. The tag stops meaning anything until each
landlord is set up. Section 4 should say this, or D6 should hide tags while
the landlord of record has no requirement recorded.

### 10. [LOW] Goal 6 promises tags on every landlord-form field; D9 tags only the Requirements fieldset

Goal 6: "Every field on the property and landlord forms says whether tenants
see it." D9 tags only the new fieldset, so Company, phones, onboarding
checkboxes and Notes get no tag. Either narrow Goal 6 or tag the rest (all
Staff only).

### 11. [LOW] With both keys on the wire, an open older composer silently narrows a multi-size draft

D12 returns `bedroomSizes` plus `bedroomSize` (the first). A composer bundle
open from before the deploy resumes a `[2, 3]` draft and shows "2-BR". Any
filter edit there re-creates the draft as `bedroomSize: 2`, dropping 3
without notice. Preview of the untouched stored draft, by contrast, reaches
3-BR holders under a "2-BR" summary. This only lasts until reload, but D11
writes the equivalent acceptance down for the flyer, and D12 should too.

### 12. [LOW] It is undefined what `unit_updated.fields` lists when the server adds keys

PATCH audits `Object.keys(validation.fields)` (`units.ts:2249-2252`). The
server now also writes `requirement_sources`, the normalized pets partner
key and the cleared deposit amount. The spec does not say whether these
appear. If `requirement_sources` does, `humanize` puts "Requirement sources"
in the Activity feed (`listingFormat.ts:225-228`). Say that the audit lists
the item keys the write changed and never `requirement_sources`.

---

## The round-1 fixes, checked against the mechanism

- **A1 (string sets).** CLOSED. A plain map is JSON-safe, and the routes
  return items as stored (`units.ts:762-766,834,854,2257`). The new problem
  with the write mechanism is finding 3.
- **A2 (create left out blanks).** CLOSED for the new form. The Save hold in
  D7 is sound: the picker's candidates are full `Contact`s
  (`UnitCreateForm.tsx:62,299`), and the locked path's `getContact` already
  exists (`:157-166`). The new side effects are finding 4.
- **A3 (landlord-change surfaces).** CLOSED. All three writers go through
  `updateRosterIfCurrent` / `update`, and both take null as REMOVE
  (`unitsRepo.ts:966-977,1101-1126`). Restore with a landlord can only pick
  a different contact (`units.ts:2340-2346`), so "different" holds. A
  regression path through PATCH remains: finding 3, second bullet.
- **A4 (pets pair).** CLOSED for Apply and the edit form: the
  "keep the other item" rule makes Apply converge. The raw-boolean edge is
  finding 6.
- **A5 (hidden deposit).** CLOSED by the alternatives rule. The edges are
  finding 7.
- **A6 (whole-map landlord save).** CLOSED. Flat `req_` keys keep the form's
  dirty-tracking (`ContactEditForm.tsx:327-335`), and contacts update
  REMOVEs on null (`contactsRepo.ts:1516-1551`).
- **A7 (Activity reason).** CLOSED, with the type-scoped lift and the test
  that `listing_status_changed` stays unserved.
- **A8 (tag mechanism).** CLOSED by the D10a walk against `toUnitFlyer`.
  Note: the walk should use more than one base unit, because a single base
  that records voucher sizes equal to its beds makes "Voucher sizes
  accepted" look identical. The wording gap is finding 10.
- **A9, A11-A17.** CLOSED as written. A11's acceptance text is inaccurate:
  finding 3.

## Adjudications contested

- My round-1 findings were all accepted, so there is nothing of mine to
  defend.
- **A10, second half (sent-blast history relabeled):** CONCEDE.
  `voucherSizeLabel` already shows every size of 4 or more as "4+ BR"
  (`broadcastFormat.ts:44-48`), so the history reads the same.
- **Rejection 1 (B7, per-row per-item choice):** CONCEDE. It is a product
  decision (dialog B over grid C), and no code argues against it. But the
  rejection relies on rows starting unchecked whenever they hold an own
  value, and the new hand-choice rule breaks that: finding 2.
- **Rejection 2 (B16, "flexible" copy):** CONCEDE. Both texts were approved
  separately, and D11 now says the difference is deliberate.
