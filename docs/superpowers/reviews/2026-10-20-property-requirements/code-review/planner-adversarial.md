# Property requirements - planner adversarial code review (plan-blind)

Summary: 0 BLOCKING, 0 HIGH, 1 MEDIUM, 4 LOW, 5 INFO (10 findings).

Reviewer: independent adversarial reviewer, read-only. Inputs: `git diff main...HEAD`
(merge base 3df43172 = main, branch tip 763314e5), `git log main..HEAD`, and the whole repo.
Nothing under docs/superpowers/ or .superpowers/ was read. No suite was run (the completion
gates own this worktree); every claim is from reading the code path end to end. Proposed tests
are written out where a test would prove or pin a claim.

Swept and found sound (no finding): the unit field allowlist (own keys only, prototype names
refused), the PATCH fence (landlordId + requirement_sources + every key of each written item,
re-read and recompute, 3 attempts), the legacy `pets` boolean on read, write and partner write,
deposit_conflict on unit and landlord writes (both guarded on what they read), the D5 reset of
requirement_sources on every writer that changes the landlord of record (PATCH, roster claim,
restore; the importer's `if_not_exists` claim can only meet `set_here` entries on an ownerless
unit, so no `copied` record ever survives a landlord change), the flyer projection (allowlist;
no staff-only requirement key, no subzone, no requirement_sources), the Apply body parser
(dedupe, caps, own-key reads), the API-test fake versus the real repo for the two fenced writes,
every server and dashboard reader of `voucher_size_accepted` (all go through the list-aware
readers), SMS merge fields, AI extraction profile and logs (no requirement values reach them),
and ASCII on every added line.

---

## PA-1 - MEDIUM - CONFIRMED - Apply overwrites a property's own value that changed after the dialog showed it

Evidence:
- The Apply body carries, per property, only `unitId` and `ownItems` (item ids):
  app/src/routes/contactRequirementsApply.ts:56-61, :122-132; the dialog builds it from the
  row's item ids only: dashboard/src/routes/contact/applyRequirementsModel.ts:160-171 (`ownItems:
  [...row.own]`).
- The server decides `changed_since_opened` from OWN-NESS alone - a changing item that is an own
  value and is not in `ownItems`: app/src/lib/requirements.ts:456-462. An item that was an own
  value when the dialog read it and is STILL an own value (with a different value) passes.
- The conditional write fences only the server's own read inside the request
  (app/src/routes/contactRequirementsApply.ts:182-200, app/src/repos/unitsRepo.ts
  updateIfRequirementsFenced), not what the dialog displayed minutes earlier.

Failure scenario: landlord L holds Pets = "No pets". Property P holds pets "Cats OK",
requirement_sources { pets: set_here }. Staff A opens Apply to properties; P's row reads
"Pets (own value)" and starts unchecked; A checks P, deciding to replace "Cats OK". Meanwhile
staff B (another tab) saves P's pets as "Cats and small dogs OK" with pet fee "$200" - a
legitimate property-specific term; the item stays set_here, so requirement_sources is unchanged.
A presses Update: pets is changing, own, and listed in ownItems, so planUnitApply writes; B's new
terms are replaced by "No pets", the PUBLIC flyer now says "No pets", and P's Activity reads
"Requirements applied from the landlord". A consented to replacing "Cats OK", never B's value.
The copy built for exactly this case ("changed since you opened this - review it again",
applyRequirementsModel.ts:177) is never shown. The same gap applies to Deposit and Application
fee (both on the flyer) and to a copied value a colleague changed to a different value that
classified copied again.

Who: staff working in two tabs or two staff on one landlord; tenants reading the flyer.

Suggested fix: send per unit the values the dialog showed for its changing items (for example
`units[].seen: { <itemId>: ItemValue }` from unitItemValue at the dialog read) and have
planUnitApply skip `changed_since_opened` when the consistent read's unitItemValue differs from
`seen` for any changing item. A coarser alternative is to send the unit's `updated_at` as read
and skip when it moved (any unrelated save then also skips the row).

PROPOSED TEST (app/test/requirementsApplyApi.test.ts, its helpers):
```
it('an own value a colleague changed after the dialog read is not overwritten (PA-1)', async () => {
  const { app, world } = makeWebhookHarness();
  seedLandlord(world);
  // The dialog read P with pets 'Cats OK' (own) and staff checked the row; a colleague then saved:
  seedUnit(world, 'u-p', { pets: 'Cats and small dogs OK', pet_fee: '$200', requirement_sources: { pets: 'set_here' } });
  const res = await postApply(app, applyBody(['pets'], EXPECTED_PETS, [{ unitId: 'u-p', ownItems: ['pets'] }]));
  expect(res.status).toBe(200);
  expect(res.body.updated).toEqual([]);
});
```
Expected on this branch: FAILS - `updated` is ['u-p'] and world.units.get('u-p') holds
no_pets true, pet_fee '$300', no pets details. Note the body cannot say what the dialog saw at
all, which is the finding; the passing version needs the contract change above.

---

## PA-2 - LOW - CONFIRMED - The landlord form tells staff its requirements ARE copied to the landlord's properties; nothing says existing properties do not change

Evidence: dashboard/src/routes/listing/FlyerTag.tsx:38 (landlord legend: "On property flyers -
copied to this landlord's properties, where tenants see it on the public flyer."), shown at the
top of the landlord form's Requirements / Qualifications fieldset
(dashboard/src/routes/contact/ContactEditForm.tsx, the `isLandlord` fieldset). Copy only happens
at property create (D7) or through Apply to properties; the "nothing on a property changes"
rule lives only in code comments (LandlordRequirementsCard.tsx:5-7). After Save the form closes
with no prompt to Apply.

Failure scenario: a landlord raises the deposit from $1,200 to one month's rent. Staff edit the
landlord's Deposit, read the legend, and reasonably conclude every property flyer now says one
month's rent. Every existing flyer keeps "$1200" until someone presses Apply to properties; the
property pages show "Landlord updated" only for items that were copied.

Who: staff; tenants reading stale public terms.

Suggested fix: make the legend conditional and explicit ("Copied to a NEW property of this
landlord, or to existing ones with Apply to properties"), and after a landlord save that changed
an on-flyer item, show a one-line nudge on the card ("Existing properties are unchanged - Apply
to properties").

---

## PA-3 - LOW - PLAUSIBLE - The two "re-read the current landlord" reads are eventually consistent

Evidence: GET /api/contacts/:contactId reads without consistentRead
(app/src/routes/contacts.ts:1259). It backs the Apply dialog's opening read
(dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:162-165), which then REPLACES the
page's contact (ContactDetail.tsx:1468 `onLandlordRead={setContact}`), and the New property
form's locked landlord read, whose values become the stored `requirements_snapshot`
(dashboard/src/routes/listing/UnitCreateForm.tsx:231, requirementForm.ts:193-197).

Failure scenario: staff save the landlord's requirements (the card shows the new values from the
PATCH response) and, within the replication window, (a) open Apply to properties: the GET returns
the pre-save landlord, the dialog shows old values AND setContact rolls the landlord card back
to the old values; Update then 409s requirements_changed and self-heals on the re-read; or
(b) press + New property: the form fills in the pre-save values and the server classifies them
`copied` against that snapshot - the new property is created with the landlord's OLD terms and
immediately carries "Landlord updated" tags. (b) persists wrong data. DynamoDB Local is strongly
consistent, so no hermetic suite can show either.

Who: staff acting quickly after a landlord edit.

Suggested fix: read these two through a consistent read (a `?consistent=1` on the contact GET
that the route maps to `{ consistentRead: true }`), or seed both from the page's in-memory
contact when it is newer.

PROPOSED TEST (app/test, contacts route): GET /api/contacts/:id?consistent=1 calls
contacts.getById with { consistentRead: true }. On this branch: no such parameter (fails).

---

## PA-4 - LOW - CONFIRMED - The public flyer prints requirement money raw: "$1250.4", "$1500"

Evidence: dashboard/src/routes/public/FlyerPage.tsx:149 (`$${flyer.deposit}`) and :157
(`$${fee}`). The D1 money kind stores any finite amount >= 0, cents included
(app/src/lib/requirements.ts:236-243), and the forms accept cents (`step="any"`,
RequirementsFields.tsx:104). The staff side was fixed to "$1,250.40"
(dashboard/src/routes/listing/requirements.ts formatRequirementMoney); the tenant-facing page was
not.

Failure scenario: deposit 1250.4 -> the flyer reads "Deposit: $1250.4"; an application fee of
37.5 reads "$37.5"; 1500 reads "$1500" next to the rent line's "$1,400". The raw form predates
the branch, but the branch rewrote both labels (depositLabel / applicationFeeLabel) and widened
the inputs to cents, so it now ships on the public page by design of this change.

Who: tenants (public flyer).

Suggested fix: format both through one money formatter (whole amount "$1,500", cents "$1,250.40").

PROPOSED TEST (dashboard/src/routes/public/FlyerPage.test.tsx): render a flyer with
`deposit: 1250.4, application_fee: 37.5` and expect "$1,250.40" and "$37.50". On this branch:
fails (renders "$1250.4" and "$37.5").

---

## PA-5 - LOW - PLAUSIBLE - 15 new uncapped text attributes on every landlord contact and unit can push an item past DynamoDB's 400 KB limit

Evidence: normalizeRequirementValue accepts any string length for text / long_text
(app/src/lib/requirements.ts:251-255), used by the contacts PATCH (req_*) and the unit
validator; express.json keeps its default 100 KB body (app/src/app.ts:140), so one save adds up
to ~100 KB and successive saves of different fields accumulate.

Failure scenario: a staff member pastes a long screening policy into Qualifications, then
others into Income, Credit and Evictions details over several saves. Past 400 KB every later
UpdateItem on that contact fails with a ValidationException - including system writes that
touch the landlord contact (inbound-message bookkeeping, opt-out flags), not just staff saves.
The class predates the branch (notes, staff_notes), but the branch adds 15 such attributes to
two hot item types.

Who: any landlord contact or property; the failure surfaces far from its cause.

Suggested fix: cap requirement text (e.g. 2,000 chars, Qualifications 10,000) in
normalizeRequirementValue with a 400, and mirror the cap as maxLength on the inputs.

PROPOSED TEST (app/test/landlordRequirementsPatch.test.ts): PATCH a landlord with
`req_qualifications: 'x'.repeat(90_000)`. On this branch: 200 (no cap). Expected after a fix: 400.

---

## PA-6 - INFO - CONFIRMED - Legacy blasts stored with bedroomSize 5..12 now read as "4+ BR": drafts reach wider, sent shares are summarized wrongly

Evidence: bedroomSizesOfFilter reads a legacy bedroomSize as [min(n, 4)]
(app/src/lib/blastAudienceRules.ts:218-233); wireAudienceFilter answers that list on every
projection (:268-279). Main's composer pre-filled the RAW property size, so a 5-bedroom property's
draft stored bedroomSize 5 and matched exactly 5 (main: BroadcastComposer.tsx
`bedroomSize: size` from `acceptedVoucherSizes(unit)[0]`).

Consequence: (a) such a legacy DRAFT, resumed and sent, now reaches every tenant with 4..12 -
the test file pins this as intended ("spec section 4"); (b) a SENT share that reached exactly the
5s is now summarized as "Tenants - 4+ BR" in the list and results header, and its API preview
resolves 4+ - so routes/broadcasts.ts:1040 ("keeps its historical filter and previews as
before") no longer holds for those rows. History misdescribes who was targeted. Noted for
Cameron's awareness, not a defect in the intended draft behavior.

---

## PA-7 - INFO - CONFIRMED - A landlord change that lands between Apply's read and write is reported as "changed since you opened this"

Evidence: the fence failure maps to `changed_during_apply` for every lost condition
(app/src/routes/contactRequirementsApply.ts:201-204), and its copy is "changed since you opened
this - review it again" (applyRequirementsModel.ts:178); a landlordId change is one of the fenced
conditions (unitsRepo.ts updateIfRequirementsFenced). The same property read a moment later would
have been skipped as `landlord_changed` ("has a different landlord now"). Suggested fix: on a
lost condition, re-read once and report landlord_changed / deleted / not_found when that is the
cause.

---

## PA-8 - INFO - CONFIRMED - On deploy every legacy property shows purple "Set on this property" tags with "Landlord: blank"

Evidence: no existing landlord holds a req_ key, and no existing unit holds
requirement_sources; requirementDisplay tags every never-touched non-blank item `set_here` with a
"Landlord: blank" line (dashboard/src/routes/listing/requirements.ts requirementDisplay, the
`!isItemBlank(own)` branch). Every legacy property with a deposit, pets text, application fee,
tour type or tour process therefore shows one tag per item plus "Landlord: blank" until its
landlord's requirements are filled in, and those rows start UNCHECKED in Apply. Consistent with
the stated rule (a blank landlord value counts as differing); flagged because it changes what
every existing user sees on day one and may read as alarm noise.

---

## PA-9 - INFO - CONFIRMED - The Touring item is operational, not descriptive: copying or clearing it changes how "Interested" behaves

Evidence: `tour_type` is a Touring requirement key (app/src/lib/requirements.ts:102-105), and the
listing-send Interested outcome auto-creates a tour only when the unit has a `tour_type`, else
409 tour_type_required -> the form path (app/src/routes/units.ts:1615-1621;
app/src/lib/listingSendOutcome.ts:111-112). An Apply with Touring checked (including a "Clears"
of a blank landlord Touring) switches every checked property between auto-created tours and the
manual form at once, and a new property now inherits the landlord's tour type by prefill. The
dialog says nothing about this. Suggest a one-line note on the Touring row in the dialog.

---

## PA-10 - INFO - CONFIRMED - A contact retyped away from landlord keeps its req_ requirements, and they return if it is retyped back

Evidence: the contacts PATCH refuses req_ keys on a non-landlord
(app/src/routes/contacts.ts, the `touchesRequirements` block) but nothing removes stored req_
keys when the type changes; the landlord card and Apply read them again after a later retype to
landlord. Harmless while hidden; worth a decision (clear on retype, or keep deliberately).
