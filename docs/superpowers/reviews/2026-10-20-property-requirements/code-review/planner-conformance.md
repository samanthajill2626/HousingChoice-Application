# Planner conformance review - feat/property-requirements

Reviewer: independent spec-conformance reviewer (read-only; no suites run - the
completion gates are live in this worktree).
Contract: docs/superpowers/specs/2026-10-20-property-requirements-design.md
(revision 6). Work map: mission-block.md. Code: `git diff main...HEAD` at
763314e5 (0 behind main). Plan, other review records and `.superpowers/` were
NOT read. Byte-exact quotes for the evidence are in
`.superpowers/sdd/planner-conformance-reference.md` (REF-n); this file cites
code by file:line.

**Summary: 0 BLOCKING, 0 HIGH, 1 MEDIUM, 9 LOW, 8 INFO (18 findings).**
The core of every decision is built and tested: the registry, kinds, legacy
pets, copy-only storage, the classification and fence, the Apply route and
dialog, the D6 tag table, picker B, the flyer wording, Matching's list and the
Activity reason. Every finding is a place the code is stricter, looser or
worded differently from the spec, for the product owner to accept or reverse.
Nothing crosses an out-of-scope line.

## Per-decision verdicts

| Decision | Verdict | Evidence / finding |
|---|---|---|
| Gate O1 (checkbox + details are ONE item) | CONFORMS | app/src/lib/requirements.ts:70-106 (8 items); Apply writes every key of a changing item app/src/lib/requirements.ts:467-474; e2e pins "No pets", never "No pets (Cats OK)" e2e/tests/dashboard-next/property-requirements.spec.ts:383-385 |
| Gate O2 (a blank landlord value counts as differing) | CONFORMS | dashboard/src/routes/listing/requirements.ts:416-422; test requirements.display.test.ts:82 |
| Goal 1 (landlord records requirements once) | CONFORMS | contacts PATCH req_ keys app/src/routes/contacts.ts:799-806; landlord card + fieldset (D9) |
| Goal 2 (copy only) | CONFORMS | nothing reads the landlord to fill a unit; the card reads the unit's own keys dashboard/src/routes/listing/PropertyRequirementsCard.tsx:56-75; test landlordRequirementsPatch.test.ts:424 |
| Goal 3 (exception vs out of date; Apply starts own values unchecked) | CONFORMS | D6, D8 rows below |
| Goal 4 (several voucher sizes everywhere) | CONFORMS | D4, D11, D12 rows below |
| Goal 5 (subzone, washer/dryer, deposit forms, No application fee) | CONFORMS | D3, D10 rows below |
| Goal 6 (every field tagged; a test fails when a tag disagrees with the flyer) | CONFORMS (see PC-1, PC-11) | app/test/propertyFormFlyerParity.test.ts:249-275; dashboard/src/routes/listing/requirementsMirror.test.ts:87 |
| D1 items, kinds, legacy pets, equality, deposit alternatives | PARTLY - PC-9 | registry app/src/lib/requirements.ts:70-106 (labels, groups, keys, flyer visibility all match the D1 table); kinds :226-256; legacy read :185-195; equality :210-215; deposit_conflict app/src/lib/unitRequirementWrite.ts:73-79, app/src/routes/units.ts:906-909, app/src/routes/contacts.ts:1688-1700; One-month save sends amount null dashboard/src/routes/listing/requirementForm.ts:155 |
| D2 where stored (flat unit keys; req_ keys on the landlord; landlord-only; audit) | PARTLY - PC-10 | app/src/lib/unitFields.ts:126-143; app/src/repos/contactsRepo.ts:345-370; type gate app/src/routes/contacts.ts:1677-1687; no AI provenance touch :1896-1898; create ignores req_ (test landlordRequirementsPatch.test.ts:443) |
| D3 subzone staff only, no Area, washer/dryer | CONFORMS | app/src/lib/unitFields.ts:72, 143, 300-321; toUnitFlyer has no subzone (unitFields.ts:489-516); flyer neighborhood = area dashboard/src/routes/public/FlyerPage.tsx:57-59; property page rows dashboard/src/routes/listing/ListingDetail.tsx:980-981; no Area input on either form |
| D4 voucher sizes as a list, picker B | CONFORMS (see PC-12) | validator app/src/lib/unitFields.ts:237-257; picker dashboard/src/routes/listing/VoucherSizePicker.tsx:49-111; off-chip values requirementForm.ts:212-241; page row ListingDetail.tsx:975 |
| D5 copy only, requirement_sources, classification, fence, landlord-change REMOVE | PARTLY - PC-10 | classification app/src/lib/requirements.ts:380-398; create app/src/routes/units.ts:884-976; PATCH loop :784-829 (3 attempts, 409 property_changed); restore REMOVE app/src/repos/unitsRepo.ts:1925; claim REMOVE :1551-1553; harness mirror app/test/helpers/twilioWebhookHarness.ts:2886-2915; form message dashboard/src/routes/listing/ListingEditForm.tsx:55 |
| D6 layout A tag table, one tag per item, no-requirements note, re-read on landlordId change | CONFORMS | dashboard/src/routes/listing/requirements.ts:408-431; PropertyRequirementsCard.tsx:43-75; useListing.ts:279-300; landlord-of-record guard ListingDetail.tsx:373-374; tags differ in lightness and hue PropertyRequirementsCard.module.css:71-80 (see PC-18) |
| D7 New form starts filled in from the landlord | PARTLY - PC-4, PC-5, PC-6 | prefill + snapshot UnitCreateForm.tsx:226-262, 319-329; refill on a different pick :254-262; Create waits :199; failure sends no snapshot :327 |
| D8 Apply to properties (dialog B + route) | PARTLY - PC-3, PC-7, PC-10, PC-15 | route app/src/routes/contactRequirementsApply.ts:136-228; per-unit plan app/src/lib/requirements.ts:431-477; dialog dashboard/src/routes/contact/ApplyRequirementsDialog.tsx; rules applyRequirementsModel.ts:39-150; skip copy :174-186 (exact for changed_since_opened / changed_during_apply) |
| D9 landlord card, fieldset, Notes copy | PARTLY - PC-1 | card dashboard/src/routes/contact/LandlordRequirementsCard.tsx; placed after Landlord onboarding LandlordFile.tsx:160-170; fieldset ContactEditForm.tsx:1014-1025; Notes copy LandlordFile.tsx:187 (exact); e2e moved contact-detail.spec.ts:134-190 |
| D10 property page and forms (order, tags outside the name, legend, public notes, No application fee, One month's rent) | CONFORMS (see PC-11, PC-13) | ListingDetail.tsx:969-1011, 1041-1054; form order ListingEditForm.tsx:305-640 and UnitCreateForm.tsx:413-797; TaggedField.tsx (tag outside label, aria-describedby); RequirementsFields.tsx:56-117 |
| D10a tag table + parity walk + mirror | CONFORMS (see PC-11) | app/src/lib/requirements.ts:518-539; dashboard/src/routes/listing/requirements.ts:255-295; app/test/propertyFormFlyerParity.test.ts; requirementsMirror.test.ts:87 |
| D11 public flyer wording and projection | PARTLY - PC-2 | projection app/src/lib/unitFields.ts:475-516 (keeps voucher_size, deposit, application_fee, pets; adds voucher_sizes, no_pets, pet_fee, deposit_one_month, deposit_flexible, washer_dryer); wording FlyerPage.tsx:65-75, 136-158, 315, 346-381 |
| D12 Matching voucher size list | CONFORMS (see PC-14) | normalizer app/src/lib/blastAudienceRules.ts:218-243; parse app/src/routes/broadcasts.ts:220-246; resolver app/src/services/audienceResolution.ts:161, 202; wire blastAudienceRules.ts:268-280; composer BroadcastComposer.tsx:208-232; note AudienceFilters.tsx:52, 202-204 (exact); draft key useComposerDraft.ts:109-111; seed matrix.ts:1232, 1271 |
| D13 history | PARTLY - PC-8 | audit fields app/src/lib/unitRequirementWrite.ts:131-139; Apply audit contactRequirementsApply.ts:213-218; Activity lift app/src/routes/units.ts:388-392; label dashboard/src/routes/listing/listingFormat.ts:258-262 (exact) |
| Section 4 consequences | CONFORMS | Apply stamps updated_at app/src/repos/unitsRepo.ts:1174-1176; no code was owed beyond that |
| Section 5 out of scope | CONFORMS | see "Out-of-scope check" below |
| Section 6 testing | CONFORMS with two gaps - PC-17, PC-18 | see "Tests per decision" below |
| Section 7 places to update | CONFORMS (see PC-16) | every listed app, dashboard and doc file is in the diff; public-pages.spec.ts and matching-blast-rules.spec.ts were not edited and their assertions still hold (fees 45/99/30, one size; a 2-BR chip still pressed) |

## Findings

### PC-1 - MEDIUM - the landlord form says "Tenants see this on the public flyer."

- Spec: D9 - the landlord fieldset's tags read **On property flyers** / **Staff
  only** "because these values reach flyers only through properties". D10 puts
  the "Tenants see this on the public flyer." line under the PROPERTY forms'
  public free-text boxes; nothing asks for it on the landlord form.
- Code: the shared component shows that line for every on-flyer text field
  whatever the audience - dashboard/src/routes/listing/RequirementsFields.tsx:149
  (REF-1) - so the landlord form shows it under Pets (details) and Pet fee.
  A test pins it for the landlord audience too:
  dashboard/src/routes/listing/RequirementsFields.test.tsx:73-86.
- Consequence: staff editing a landlord read, directly under the landlord's
  pets details, that tenants see this on the flyer - the opposite of copy
  only: nothing reaches a flyer until a property gets the value (create or
  Apply). The spec chose different landlord tag wording precisely to avoid
  that reading.
- Suggested fix: pass the note only for `audience === 'property'` (or a
  landlord wording such as "Tenants see this on each property's flyer once it
  is copied there." if Cameron wants a note), and change the test expectation
  at RequirementsFields.test.tsx:85 to depend on the audience.

### PC-2 - LOW - flyer voucher line says "an" before 8 and 11

- Spec: D11 fixes "Fits a 2- or 3-bedroom voucher", "Fits a 2-bedroom
  voucher", "Fits a studio voucher", "Fits a studio or 1-bedroom voucher",
  "Fits a 1-, 2-, or 3-bedroom voucher" - always "a".
- Code: dashboard/src/routes/public/FlyerPage.tsx:78-80, 315 (REF-2) switch to
  "an" when the phrase starts with 8 or 11; pinned at
  dashboard/src/routes/public/FlyerPage.test.tsx:413-421.
- Consequence: tenants see "Fits an 8-bedroom voucher" / "Fits an 11-...".
  Grammatical, but not the spec's template. Every D11 example reads exactly as
  the spec says.
- Suggested fix: Cameron to accept (likely) or drop voucherArticle.

### PC-3 - LOW - Apply copy goes singular at one property

- Spec: D8 "Update N properties", "Updated N properties", "Updated N
  properties before this stopped. Review the rest and press Update again."
- Code: dashboard/src/routes/contact/applyRequirementsModel.ts:226-240 (REF-3)
  reads "Update 1 property" / "Updated 1 property" / "Updated 1 property
  before this stopped. ..." at N = 1; pinned at applyRequirementsModel.test.ts:304,
  LandlordRequirementsCard.test.tsx:84 and the e2e
  property-requirements.spec.ts:353.
- Consequence: staff copy differs from the literal template at N = 1 only.
- Suggested fix: Cameron to accept (likely); otherwise drop the singular branch.

### PC-4 - LOW - the "Filled in from ..." note is hidden when the landlord has no requirements

- Spec: D7 - the section "starts filled in ... with a note "Filled in from
  <landlord name>'s requirements. Change anything that is different for this
  property."" and, when the landlord has none, "the section starts blank". The
  spec does not say to drop the note.
- Code: the note shows only when the landlord holds at least one requirement -
  dashboard/src/routes/listing/UnitCreateForm.tsx:103, 392-395 (REF-4); pinned
  at UnitCreateForm.test.tsx:793 and :640-642.
- Consequence: for a landlord with nothing recorded, staff see a blank section
  with no explanation of where values would have come from. Arguably better
  than a note claiming a fill that did not happen.
- Suggested fix: Cameron to accept, or show a landlord-has-none line instead.

### PC-5 - LOW - Try again after a failed landlord read fills only the items staff left blank

- Spec: D7 - the section starts filled in from the landlord "as soon as the
  landlord is known"; only "Picking a DIFFERENT landlord refills the section ...
  replacing anything typed there". The spec is silent on what Try again does
  with values typed while the read had failed.
- Code: UnitCreateForm.tsx:241 (REF-5) with
  dashboard/src/routes/listing/requirementForm.ts:178-191 - a whole item is
  filled only when every field of it is blank; typed items keep what staff
  typed. The snapshot is still the landlord's values, so a typed item that
  differs classifies set_here. Pinned at UnitCreateForm.test.tsx:706, 740.
- Consequence: a sensible interpretation, but it is a rule the spec never
  stated (staff can end up with a partly filled section).
- Suggested fix: Cameron to confirm the rule.

### PC-6 - LOW - D7 status lines can say "the landlord" instead of the name

- Spec: D7 "Loading <landlord>'s requirements..." and "Couldn't load
  <landlord>'s requirements, so this property starts without them. ..."
- Code: UnitCreateForm.tsx:384-391 (REF-4) uses the name from the landlord
  list read or the record read, else the words "the landlord" - so the
  loading line can briefly read "Loading the landlord's requirements..." while
  the list read is still in flight, and the failure line reads "Couldn't load
  the landlord's requirements, ..." when both reads fail.
- Consequence: copy differs from the template in those windows only.
- Suggested fix: accept, or hold the line until a name is known.

### PC-7 - LOW - an in-dialog re-read keeps staff's choices instead of the D8 opening defaults; extra notices

- Spec: D8 defines the opening state (items with a value checked, blank
  unchecked; rows per own values) and, after a 409 requirements_changed, a
  re-read and "This landlord's requirements changed. Review the updated list
  and press Update again." It says nothing about carrying choices across that
  re-read, and fixes no copy for a first request that fails without a 409 or
  answers 409 deposit_conflict.
- Code: ApplyRequirementsDialog.tsx:174-182, 248 with
  applyRequirementsModel.ts:66-75 and :141-148 - after any failed or stopped
  Update the left column keeps what staff had checked (an item the landlord
  blanked since comes back unchecked; an item the landlord FILLED IN since stays
  unchecked, pinned at applyRequirementsModel.test.ts:160), rows staff
  unchecked stay unchecked, rows staff checked go back to their starting
  state. Two notices the spec does not have: applyRequirementsModel.ts:245
  and :252-253 (REF-6).
- Consequence: after a requirements_changed 409, a requirement the landlord
  just added does NOT start checked as it would on opening the dialog; staff
  must notice and check it. Safer (never writes more than staff chose), but a
  behavior the spec does not define.
- Suggested fix: Cameron to confirm the carry rule and the two notice texts.

### PC-8 - LOW - a requirement PATCH that changes nothing writes no unit_updated row

- Spec: D13 "A staff edit keeps unit_updated with field names ... The names
  are the unit keys the write actually changed".
- Code: app/src/routes/units.ts:2425 (REF-7) skips the audit row when the
  fenced path changed no stored value (the write still stamps updated_at);
  pinned at app/test/unitsApiRequirementsPatch.test.ts:125. The plain path
  (no requirement key, no landlordId) still lists every body key, changed or
  not (units.ts:2406), so the two paths audit an unchanged re-send differently.
- Consequence: an edit-form save that re-sends only unchanged requirement
  values leaves no Activity line, while the same save of an unchanged plain
  field still does. Low practical impact (the forms send only changed fields).
- Suggested fix: Cameron to accept the no-op rule; optionally align the plain
  path to changedKeys too.

### PC-9 - LOW - a boolean `pets` beside any `no_pets` key is a 400

- Spec: D1 "the unit `pets` key still accepts a boolean (raw API callers). A
  written boolean MEANS what the read interpretation says ... and is stored in
  the new shape at once." No refusal is specified.
- Code: app/src/lib/unitFields.ts:273-275 (REF-8) refuses a boolean pets in a
  body that carries no_pets at all - even a consistent pair such as
  `pets: false, no_pets: true`; pinned at app/test/unitFields.test.ts:483.
- Consequence: STRICTER for raw API callers only; no dashboard form sends a
  boolean pets.
- Suggested fix: accept (it removes an ambiguous body), or refuse only a pair
  that disagrees.

### PC-10 - LOW - the fences are stricter than D5 / D8 state

- Spec: D5 conditions the PATCH write on `requirement_sources` and
  `landlordId`; D8 conditions the Apply write on existence, not deleted,
  `landlordId` and `requirement_sources`. D2 defines no contacts-PATCH 409.
- Code: both unit writes also condition on every key of each requirement item
  the patch writes - app/src/repos/unitsRepo.ts:1022-1032, 1196-1205 (harness
  mirror twilioWebhookHarness.ts:2897). The contacts PATCH carrying req_ keys
  is guarded on the stored type and, with a Deposit key, on the stored
  req_deposit_one_month / req_deposit - app/src/routes/contacts.ts:1638-1647 -
  so a race answers 409 contact_changed, which the landlord form shows only as
  the generic "Couldn't save - please try again." (ContactEditForm.tsx:566-569).
  Also, any PATCH naming an unchanged landlordId now takes the fenced path
  (units.ts:2338-2339) and can see 409 property_changed.
- Consequence: more retries / skips under races (an Apply racing an edit of
  the same item is skipped as changed_during_apply; a landlord save racing a
  colleague's deposit or type change fails with a generic error). Each closes a
  real lost-update hole; none changes a non-racing save.
- Suggested fix: Cameron to accept; consider a specific landlord-form message
  for 409 contact_changed.

### PC-11 - INFO - an "Owning landlord" row and tag beyond the D10a table

- Spec: D10a lists the form fields and tags; it has no landlord row.
- Code: app/src/lib/requirements.ts:519 and its mirror
  dashboard/src/routes/listing/requirements.ts:256 add "Owning landlord" (Staff
  only); the New form tags its landlord field UnitCreateForm.tsx:417-437.
- Consequence: one more Staff only tag on the New form; true and harmless.

### PC-12 - INFO - blank marker and the always-shown voucher row

- Spec: D9 "blank ones as "-""; D4 the page row "stays empty when none is
  recorded"; D10 Same-day RTA "Yes / No / -".
- Code: the dashboard's blank marker is U+2014 (Card.tsx:138, REF-10), used on
  the landlord card, the property Requirements card and every Property
  details row; the "Voucher sizes accepted" row now always renders, with that
  marker when nothing is recorded (ListingDetail.tsx:975), where main hid the
  row unless a number was stored.
- Consequence: consistent with the page's existing marker; the spec's ASCII
  "-" is read as that marker. Flagged only so Cameron sees the row is now
  always present.

### PC-13 - INFO - the tour card's empty state copy changed

- Spec: D10 "Tour & application process keeps Application process" - no copy
  given for its empty state.
- Code: ListingDetail.tsx:1053 (REF-9) now reads "No application process
  recorded yet." (main: "No process recorded yet."); pinned at
  ListingDetail.test.tsx:350.
- Consequence: accurate now that tour fields moved out; not spec copy.

### PC-14 - INFO - the Matching pre-fill leaves out a stored non-integer size

- Spec: D12 "the filter pre-fills one chip per accepted size
  (`acceptedVoucherSizes` ...)".
- Code: dashboard/src/routes/broadcasts/broadcastFormat.ts:80-82 drops sizes no
  chip can hold (a legacy 2.5); pinned at BroadcastComposer.test.tsx:900, 910.
- Consequence: old data only (the write API refuses non-integers since D4).

### PC-15 - INFO - Apply body: duplicates de-duplicated, ownItems required

- Spec: D8 lists the 400s (empty or unknown items, expected not exact, units
  empty / repeated / over 100, an ownItems entry not listed).
- Code: a repeated item id is de-duplicated, not refused
  (app/src/routes/contactRequirementsApply.ts:80-81, LOOSER); a units entry
  with no ownItems array is a 400 (:124-130, STRICTER - the dialog always
  sends one).
- Consequence: none for the dashboard; raw callers only.

### PC-16 - INFO - scope additions outside the spec

- dashboard/src/routes/contact/ContactDetail.tsx:353-371 - a contact change now
  closes EVERY per-contact dialog (edit, phones, relay group, placement, tour,
  New property, Delete), not only Apply. A behavior fix outside D8/D9.
- dashboard/src/routes/listing/ListingDetail.tsx:380 - the Contacts card's
  synthesized landlord row now uses the landlord-of-record guard.
- e2e/scenarios/steps.ts:1543 uses `getByLabel(/^Notes/)` where spec section 7
  says `{ exact: true }` (a wrapping label; test-only).
- Consequence: none adverse seen; listed so the product owner knows the change
  set is wider than the spec.

### PC-17 - INFO (test gap) - the landlord form's One-month-rent save is not tested end to end

- Spec: D1 "Both forms, on the save that CHECKS "One month's rent", send the
  amount as null in the same save".
- Coverage: the helper is tested (requirementForm.test.ts:122-140) and the
  property form is tested (ListingEditForm.test.tsx:734, 745); the landlord
  form's wiring (ContactEditForm.tsx:376-380, toLandlordPatch) has no test of
  this case.
- PROPOSED TEST (not run): in dashboard/src/routes/contact/ContactEditForm.test.tsx,
  render a landlord with `req_deposit: 500`, tick "One month's rent", press
  Save, and expect the PATCH body to contain `req_deposit_one_month: true` and
  `req_deposit: null`. Expected GREEN today; RED if the form passed its current
  values as the baseline or toLandlordPatch dropped nulls.

### PC-18 - INFO (test gap) - D6 tag lightness is not pinned

- Spec: D6 "The two tags differ in lightness as well as hue".
- Coverage: PropertyRequirementsCard.module.css:71-80 meets it (#6d28d9 fill vs
  #fef3c7 fill), but no test asserts it (the "Clears" contrast has one,
  ApplyRequirementsDialog.test.tsx). A token change could silently break it.
- PROPOSED TEST (not run): a CSS-module read in PropertyRequirementsCard.test.tsx,
  as the Clears contrast test does, asserting the two tag classes use different
  background tokens of different lightness. Expected GREEN.

## Out-of-scope check (section 5)

- No AI ranking, no AI prompt change: no file under app/src/services/extraction,
  app/src/jobs or any prompt is in the diff. CONFORMS.
- Blasts do not filter on No pets / No evictions; no matching on credit or
  income: audienceResolution.ts changes only the size rule (:161, :202). CONFORMS.
- #13 / #26 flyer changes: FlyerPage.tsx changes only the D11 rows and the
  neighborhood line. CONFORMS.
- Area on the forms; a subzone-to-area list: neither exists. CONFORMS.
- Requirements on the NEW-landlord form: contact create untouched and ignores
  req_ keys (landlordRequirementsPatch.test.ts:443). CONFORMS.
- Copying from roster members other than the landlord of record: Apply and the
  card use landlordId only (contactRequirementsApply.ts:188; ListingDetail.tsx:373-374). CONFORMS.
- Per-property, per-item Apply choices: one item list per request. CONFORMS.
- Backfill / migration / importer: no script, no app/src/lib/import change;
  seeds change only the full profile (cast.ts, matrix.ts; lean.ts untouched). CONFORMS.
- Tenant eviction history: untouched. CONFORMS.

## Readers and writers sweep (grep of app/src, dashboard/src, e2e)

- requirement keys: tour_type / tour_process readers (ScheduleTourForm.tsx:247-292,
  TourDetail.tsx:716, contact/Card.tsx:229, listingSendOutcome.ts:112,
  units.ts:1618) read keys whose names and storage are unchanged. `pets`,
  `deposit`, `application_fee` are read only through unitItemValue / toUnitFlyer
  (the old ListingDetail rows are gone). No reader left on the old shape.
- requirement_sources writers: planRequirementWrite (create, PATCH),
  planUnitApply (Apply), restoreWithLandlord and addContact REMOVE, the full seed
  (cast.ts:1386); the harness mirrors all of them. No other writer.
- landlordId writers: create, PATCH (fenced), restore, roster claim - all reset
  the map; the importer is unchanged (accepted by D5); removeContact refuses to
  remove the landlord of record; no other unit update writes landlordId
  (statusTransition, dev.ts and the media methods write other keys).
- req_ keys: written only by the contacts PATCH and the full seed; read only
  through landlordItemValue.
- voucher_size_accepted: read through acceptedVoucherSizes (flyer, composer,
  unitListFacets.ts:178), recordedVoucherSizes (page row) and
  splitVoucherSizes / voucherSizesPatchValue (Edit form) - all list-aware.
- Matching sizes: every app and dashboard reader goes through
  bedroomSizesOfFilter (broadcasts.ts parse, audienceResolution, wireAudienceFilter;
  AudienceFilters, BroadcastComposer, useComposerDraft, audienceSummary for
  BroadcastsList / BroadcastResults). No direct `bedroomSize` read remains.

## Tests per decision (would a test fail if the decision broke?)

- D1: yes - app/test/requirements.test.ts, unitFields.test.ts:342-506,
  requirementsMirror.test.ts. D2: yes - landlordRequirementsPatch.test.ts.
  D3: yes - unitFields.test.ts:509-535, 788-846; form tests. D4: yes -
  unitFields.test.ts:65-129, VoucherSizePicker.test.tsx, ListingDetail.test.tsx:380.
  D5: yes - requirementSources.test.ts, unitRequirementWrite.test.ts,
  unitsApiRequirementsCreate/Patch/Reset tests, unitsRepoRequirementsFence.integration.test.ts.
  D6: yes - requirements.display.test.ts, PropertyRequirementsCard.test.tsx,
  useListing.test.tsx:361 (lightness: PC-18). D7: yes - UnitCreateForm.test.tsx:535-860.
  D8: yes - requirementsApply.test.ts, requirementsApplyApi.test.ts,
  applyRequirementsModel.test.ts, ApplyRequirementsDialog.test.tsx.
  D9: yes - LandlordRequirementsCard.test.tsx, ContactEditForm.test.tsx,
  files.test.tsx:524, contact-detail.spec.ts (One-month on the landlord form: PC-17).
  D10 / D10a: yes - ListingEditForm.test.tsx:590-660, UnitCreateForm.test.tsx:997-1060,
  RequirementsFields.test.tsx, propertyFormFlyerParity.test.ts.
  D11: yes - unitFields.test.ts:724-846, FlyerPage.test.tsx:400-431 and the D11 cases.
  D12: yes - blastAudienceRules.test.ts, audienceResolution.test.ts,
  broadcastApi.test.ts, AudienceFilters / BroadcastComposer tests.
  D13: yes - unitsApiActivity.test.ts:356-400, unitRequirementWrite.test.ts:60-79,
  listingFormat.test.ts.
- E2E (section 6): property-requirements.spec.ts covers every listed step,
  including the "Cats OK" case and the 6-bedroom tenant on 4+.
