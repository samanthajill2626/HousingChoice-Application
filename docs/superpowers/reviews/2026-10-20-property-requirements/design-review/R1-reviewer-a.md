# Design review R1 - reviewer A (adversarial)

Spec: `docs/superpowers/specs/2026-10-20-property-requirements-design.md`
(DRAFT revision 1). Repo read at `W:\tmp\property-requirements`, HEAD
53757846 (main @1d7a4667 plus the spec commit). Read-only review; no tests
run.

Most of the "Today" section checks out against the code. I verified these
citations by reading the code: `unitFields.ts` kinds and the flyer allowlist,
`unitsRepo.update`, the importer's ownership rule, the composer pre-fill
(`BroadcastComposer.tsx:205,213`), the exact-match resolver
(`audienceResolution.ts:186-189`), `wireAudienceFilter`, `ListingDetail.tsx`
rows, the edit form's hint line and number-clearing rule, the Notes copy and
its e2e assertion, contacts provenance clearing, and the tour_type routing
409. The findings below are what does not hold.

---

## 1. [HIGH] The source sets are DynamoDB string sets, and a string set serializes to `{}` on every unit response

**What is wrong.** D5 stores `requirements_copied` / `requirements_set_here`
as "two string-set attributes on the unit", and section 7 asks for
"string-set ADD/DELETE support in `update`". The DocumentClient unmarshals an
SS attribute into a JS `Set`. The unit routes return repo items raw through
`res.json`, and `JSON.stringify(new Set([...]))` is `{}`. The dashboard would
therefore get `{}` for both sets on every read. D6 (the tags) and D8 (the
"Has its own value" defaults) are both computed in the dashboard from those
sets, so neither can work.

**Evidence.**
- `GET /api/units/:unitId` spreads the raw item: `res.json({ unit: { ...unit, ... } })` (`app/src/routes/units.ts:854`).
- `GET /api/units` returns `page.items` raw (`units.ts:762-766`). The landlord page builds the Apply dialog from this list (`dashboard/src/routes/contact/useContactFile.ts:158`).
- `PATCH` returns `res.json({ unit })` (`units.ts:2257`), and `POST` does the same (`units.ts:834`).
- Every existing string-set attribute is internal, and every reader converts it by hand: `toSortedArray` "a JS Set after unmarshalling" (`app/src/repos/contactVocabularyRepo.ts:42-50`), `burned instanceof Set ? ...` (`app/src/routes/poolNumbersAdmin.ts:247`), and the `Set<string> | string[]` types (`conversationsRepo.ts:294`, `poolNumbersRepo.ts:111`). No global JSON replacer exists (grep for `json replacer` finds nothing).
- DynamoDB forbids an empty string set, so create must omit an empty one (`poolNumbersRepo.ts:348-350`). The spec says nothing about this.

**What it implies.** If the build follows the spec literally, D6 and D8 come
out broken, and the failure is silent: `{}` is truthy, has no `.has`, and
`Array.isArray` is false on it. Fixing it means a converter at every egress
that returns a unit. That covers GET one, GET list, POST, PATCH, DELETE,
restore, the photo routes, the roster routes and the listing-status route.
Storing both as plain string LISTS (the `accepted_authorities` /
`media` precedent) avoids the class entirely. The spec has to choose one.
Section 7 currently points the builder at the SS shape.

---

## 2. [HIGH] The New form leaves out blank fields, so an exception staff make on create is never recorded and the default Apply overwrites it

**What is wrong.** D7 says that on the New form "an unchanged field is a copy
and a changed one is set on this property". D5 classifies only items that
have "any key of the item in the body". `UnitCreateForm` builds its body from
NON-EMPTY fields only: blank strings are skipped, blank numbers are skipped,
"Not set" tour type is left out and an unchecked box is left out. Suppose
staff clear or uncheck a value that was pre-filled from the landlord, because
this property differs. That item is never sent, so the server records it as
NEVER TOUCHED. D6 row 5 then shows "blank + Landlord: <value>, no tag", and
D8 starts that row CHECKED (it is not "set on this property"). One Update
then writes the landlord's value over the exception staff made on purpose.

**Evidence.**
- `UnitCreateForm.tsx:179` (`if (value.trim() === '') return true;` - number skipped), `:195-198` (`addStr` sends only non-empty), `:209` (tour type sent only when chosen), `:210` (same_day_rta sent only when true).
- Spec D5: "(any key of the item in the body)". D6 row 5. D8: a row starts unchecked only when "any changing item is set on this property".
- D1 says "Writing `false` or null REMOVEs the key", but nothing tells the create form to send `false` / null / '' for a cleared item.

**What it implies.** This is exactly the accident Goal 3 promises to prevent
("Apply never overwrites an exception by accident"), and it happens on the
main path D7 describes. The spec must require one of two things. Either the
create body carries EVERY registry item (blank as null/false), or the server
classifies all twelve items on create whatever the body says (a key left out
counts as blank). It also needs a test: clear one pre-filled item on create,
then check that the Apply row starts unchecked.

---

## 3. [MEDIUM] Landlord changes outside PATCH keep stale source sets, and the one path D5 covers has no dashboard UI

**What is wrong.** D5's only landlord-change rule is "A PATCH that CHANGES
the property's landlord (`landlordId`) empties both sets". `landlordId`
changes on at least three other surfaces, none of which is mentioned:

- **Restore with a landlord swap.** `POST /api/units/:unitId/restore` with
  `{ landlordId: <id> }` restores the unit AND makes another contact its
  landlord of record (`units.ts:2293-2295`; `unitsRepo.restoreWithLandlord`
  "sets landlordId to `next.contactId`", `unitsRepo.ts:790-822`). The
  dashboard's restore dialog uses this path (`dashboard/src/api/endpoints.ts:1043-1061`).
- **A roster claim of the vacant landlord slot.** `addContact` with role
  landlord on an ownerless unit sets `landlordId` in the same write
  (`unitsRepo.ts:666-668`, code at `:1324`).
- **The importer** fills an absent `landlordId` even on a human-owned unit
  (`if_not_exists`, `app/src/lib/import/apply.ts:1583-1585,1615-1619`).

The dashboard also has no path that PATCHes `landlordId`: "no dashboard UI
can reassign a property's landlord yet" (`dashboard/src/lib/holdingRefusals.ts:29-35`).
So the rule the spec states covers raw API callers only. The two landlord
changes staff can actually make in the UI are not covered.

**What it implies.** After a restore swap, every item that was copied from
the OLD landlord shows "Landlord updated / Landlord now: <new landlord's
value>", against a landlord it was never copied from. The Apply dialog then
starts those rows checked. The invariant has to live in the repo methods that
write `landlordId`: `update`, `restoreWithLandlord` and `addContact`'s claim.
The importer's fill needs a decision, even if that decision is "out of
scope, accepted". The route alone is not enough.

---

## 4. [MEDIUM] The legacy `pets` boolean ties "No pets" and "Pets (details)" together, so Apply and edits never settle

**What is wrong.** D1 makes "No pets" (`no_pets`) and "Pets (details)"
(`pets`) two separate ITEMS. Each is the unit of copying, comparing and
tagging. But D1's read rule takes the value of the No pets item from the
`pets` key: "`false` = No pets checked". The D8 server writes only the keys
of each applied item. So:

- Apply copies only "No pets" from a landlord with No pets blank to a
  property holding `pets: false`. That REMOVEs `no_pets`, but `pets: false`
  stays, so the item still reads "checked". The item is now in
  `requirements_copied` and differs from the landlord, so it shows "Landlord
  updated" straight after the Apply. The dialog lists that row as a change
  forever.
- Apply copies only "Pets (details)" with a blank landlord value. That
  REMOVEs `pets: false` and silently flips the No pets item, which staff did
  not select.
- In the edit form, unchecking "No pets" on such a property must also rewrite
  `pets`. That touches, and reclassifies, the other item.

The spec's reason for keeping boolean writes ("for a stale cached dashboard
bundle") is also wrong. No current bundle writes a boolean: the edit form
turns booleans into the strings 'Yes'/'No' (`ListingEditForm.tsx:87-95,180`),
and the create form sends a string (`UnitCreateForm.tsx:203`). Booleans come
only from old data or raw API callers.

**Evidence.** Spec D1 (the read rule, and "An item is the unit of copying")
and D8 ("SETs or REMOVEs the item's keys"). `unitFields.ts:192-196`.

**What it implies.** The spec needs one of these: (a) make No pets plus
details ONE item, or (b) require every write that touches either item to
write both keys, turning a legacy boolean into the new shape. Related: every
seed and probably most live data store "No pets" as TEXT in `pets`
(`app/src/lib/seed/cast.ts:226`, `lean.ts:229`, `matrix.ts:556`, ...). A
landlord that ticks the No pets box therefore never equals those properties,
and they all start as "Set on this property". That outcome is acceptable,
but the spec should say it is expected.

---

## 5. [MEDIUM] A fixed deposit hidden under "One month's rent" breaks equality and still reaches the public flyer payload

**What is wrong.** D10: "One month's rent" disables the fixed amount, but
"the stored fixed amount is kept, not cleared". D1: the Deposit item is equal
"only when all four of its keys are equal". This causes two problems:

- A property showing "One month's rent" with a hidden $1500, against a
  landlord showing "One month's rent" and no amount, is NOT equal. The
  property page tags it ("Set on this property" + "Landlord: One month's
  rent") although the two values look the same.
- `toUnitFlyer` ships `deposit` whenever it is a finite number
  (`unitFields.ts:368`), and D11 says nothing about leaving it out when
  `deposit_one_month` is set. The public payload therefore still carries
  $1500. The spec cares about cached older flyer bundles elsewhere (it keeps
  `voucher_size` for them). Such a bundle renders `Deposit $1500`
  (`FlyerPage.tsx:298-303`) for a property staff marked "One month's rent".

**What it implies.** Either clear the fixed amount when "One month's rent" is
checked, or define equality and the projection on the EFFECTIVE value
(ignore `deposit` while `deposit_one_month` is true; the projection sends
`deposit: null` then). The same question applies to the landlord side.

---

## 6. [MEDIUM] "The form always sends the whole section" lets an unrelated landlord edit silently undo a colleague's requirement edits

**What is wrong.** D2: the body's `requirements` "REPLACES the stored map as
a whole (the form always sends the whole section)", and contact PATCH has no
guard for it. Today `ContactEditForm` is dirty-tracked: only changed fields
are sent (`ContactEditForm.tsx:327-335`, "dirty-tracked, only the changed
fields ride the PATCH"). That is why two staff editing different landlord
fields do not overwrite each other. With a whole-map replace sent on every
save, a staffer who opened the landlord page this morning and now changes
only the Company re-sends this morning's requirements, undoing a
colleague's noon edit without warning. Even if the form sends the section only when a requirement
changed, two edits of different items still lose one. The same history also
picks up `requirements` on every landlord save (D13) unless the form diffs.

**Evidence.** Spec D2, D13. `contacts.ts:1795-1806`: the only contact guards
are staff-notes and classification; there is no general version check.

**What it implies.** Send `requirements` only when the section changed, and
guard it. The repo already has the shape (`expect: [{ attr, value }]`,
`contacts.ts:1803-1814`) and the staff-notes stale-save 409 precedent. A
per-item merge would also work. "Always" must not ship as written.

---

## 7. [MEDIUM] "Requirements applied from the landlord" cannot be shown: the Activity projection drops `reason` for `unit_updated` on purpose

**What is wrong.** D13 and D8 have the Activity feed tell an Apply apart by
`reason: 'requirements_applied'` on `unit_updated`. The server's Activity
projection is a fixed whitelist and lifts `reason` ONLY for
`unit_primary_contact_assigned`. Its comment says another event's free-text
`reason` "must not start serving". `landlordId` is not projected either.
Section 7 lists only `listingFormat.ts` (the dashboard label), not
`toUnitActivityEvent`.

**Evidence.** `app/src/routes/units.ts:311-337,369-374`.

**What it implies.** As specified, the dashboard always receives a plain
`unit_updated` and shows "Property updated". The spec must widen the
whitelist for `unit_updated` (keeping the `listing_status_changed` guard),
add it to section 7, and test the projection.

---

## 8. [MEDIUM] "The tag comes from the same allowlist as the flyer projection" has no mechanism, and a key-based copy would mislabel voucher sizes

**What is wrong.** D10 promises that "the form cannot claim 'Staff only' for a
field the flyer publishes" because the tag "comes from the same allowlist as
the flyer projection". The projection is app code. The dashboard cannot
import it (no cross-workspace import, `unitFields.ts:303-304`), so the tag
list would be another hand mirror. Worse, the projection renames and derives
keys. `voucher_size_accepted` is on the NEVER-public list
(`unitFields.ts:245`), yet its value is published as `voucher_size`
(`:356`). `accepted_authorities` is built from the legacy `jurisdiction`
(`:357`). A mirror that tags a form field by "is this key in the projection"
marks "Voucher sizes accepted" as Staff only, while the flyer prints "Fits a
2-bedroom voucher". That is the exact claim D10 says cannot happen.

**What it implies.** Back the promise with an app-side test that derives, for
each form field, whether changing it changes `toUnitFlyer`'s output (or with
an explicit field-to-visibility table checked against that test), plus a
parity test against the dashboard mirror. Until then the guarantee is only a
claim. The same applies to the landlord form's "On property flyers" tags.

---

## 9. [LOW] D10's "Booleans become recordable as No" says the opposite of D1, and "every checkbox" would break same-day RTA's stored "No"

**What is wrong.** D1 stores a checkbox as `true` or absent. "No" and "not
recorded" are then the same value, and "no ambiguity" holds only because the
difference is erased. D10's heading claims the opposite. "Every checkbox
writes `true` or REMOVE" also reads as covering `same_day_rta`, which today
stores `false` (`ListingEditForm.tsx:159`) and shows "No" as distinct from
"-" (`ListingDetail.tsx:969-972`). Applied there, it would remove behavior
that ships today.

**What it implies.** Reword the heading, and limit the true/REMOVE rule to
the requirement checkboxes explicitly.

---

## 10. [LOW] The size normalizer also widens and relabels stored 5..12 filters, not only stored 4

**What is wrong.** Section 4 says only that "a stored blast with
`bedroomSize: 4` now also reaches 5- to 12-bedroom holders". The composer
pre-fills without a cap today (`BroadcastComposer.tsx:205,213`) and the API
accepts 0..12 (`broadcasts.ts:210-217`), so a stored 5..12 can exist. After
`[min(n, 4)]` it reaches 4-BR holders and every other 4+ size too. The
projection also gives SENT blasts `bedroomSizes`, so the history of a blast
sent only to 5-BR holders will now read "4+ BR".

**What it implies.** Say it in section 4, and consider projecting a legacy
record's exact value for display.

---

## 11. [LOW] Classification and Apply's 409 check read first and write later, with no guard; a PATCH that changes the landlord and touches items is undefined

**What is wrong.** Classifying a PATCH needs the stored unit (the result of a
multi-key Deposit item, the legacy `pets` boolean, the stored `landlordId`)
and the landlord's map. Neither read is atomic with the write, and a unit
PATCH has no version check (`unitsRepo.ts:1139`). Apply's `expected` check is
the same read-then-write. A concurrent landlord or property edit can
therefore misclassify without notice. The spec also never says what happens
when one PATCH both changes `landlordId` and touches items: empty the sets,
or classify against the new landlord? One UpdateExpression cannot both
REMOVE and ADD the same attribute.

**What it implies.** Say which read the classification uses, accept the race
explicitly as the spec does elsewhere, and define the combined case.

---

## 12. [LOW] Item ids, set member strings and the `expected` wire shape are never defined

**What is wrong.** The sets, `items: string[]`, `expected: { <item>: ... }`
and D6 all speak of ITEMS. D1 gives labels and KEYS only. The Deposit item has
four keys and no id. If its id is `deposit`, it clashes with its own key.
`expected` for a four-key item and for a blank value has no defined shape.
Two hand-mirrored registries must agree on all of this.

**What it implies.** Add an item-id column to D1 and define the value shape
of `expected`.

---

## 13. [LOW] Section 4's "Select all is the shortcut" undercuts Goal 3; a row is all-or-nothing

**What is wrong.** A checked row receives every checked left-column item,
the property's own exceptions included. No item can be chosen per row.
Section 4 says the first Apply on any existing landlord starts most rows
unchecked because existing values count as set here, and calls Select all
"the shortcut". That shortcut overwrites every existing per-property deposit,
pet policy and tour type. The tour type changes routing (section 4, first
bullet).

**What it implies.** Drop the recommendation, or warn on Select all when
the selection includes rows marked "Has its own value".

---

## 14. [LOW] The landlord page is not told to reload its units after Apply

**What is wrong.** The Apply response returns ids only. The landlord page
holds the units from a single load (`useContactFile.ts:149-158`). If the page
does not call `refetch` (`:124-125`), reopening the dialog works from stale
rows, and "Already matches" and the default checks come out wrong. The spec
says only that the page shows "Updated N properties".

---

## 15. [LOW] Stored voucher sizes that D4 now rejects cannot be shown in picker B

**What is wrong.** Today's kind accepts any finite number >= 0
(`unitFields.ts:175-185`), so 2.5 or 15 can be stored. Picker B has no chip
for them. A form save that re-sends the list containing such a value gets a
400, and staff have no chip to deselect. Whether production holds such
values is UNVERIFIED.

**What it implies.** One sentence: drop out-of-range stored members when the
picker loads (and show that it did), or let the server ignore them.

---

## 16. [LOW] Property managers are typed `landlord`, so the type gate gives them requirements the non-goals exclude

**What is wrong.** A property manager is "a landlord with a role"
(`units.ts:797`; `contacts.ts:1867`). D2's gate on `type === 'landlord'` and
the LandlordFile card therefore apply to property managers. Section 5 rules
out "requirements for property managers". The intent is presumably "landlord
of record only", which is what Apply already enforces. The wording should
match.

---

## 17. [LOW] Doc drift and a misdescription

- The GLOSSARY entry "Landlord preferences + expected rent live on the UNIT"
  (`documentation/GLOSSARY.md:176-187`) says the landlord contact no longer
  models pet policy. Pets, tour type and the other requirements now live on
  the landlord too. The entry also already says wrongly that `lease_terms`
  is "internal-only" (it is public, `unitFields.ts:74-78`). The section 7
  Docs list does not name this entry.
- Section 2 says `UnitCreateForm` "keeps only the label". It keeps the full
  `Contact` list in state (`UnitCreateForm.tsx:62,146`). Only the
  locked-landlord fallback keeps just a label (`:160-161`). This does not
  change D7, but the claim is inaccurate.
