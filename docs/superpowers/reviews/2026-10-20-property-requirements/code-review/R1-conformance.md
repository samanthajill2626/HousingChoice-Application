# R1 - spec-conformance review (reviewer RC)

- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  HEAD `738a2b4e` (main @3df43172 merged in), reviewed 2026-10-21.
- Contract: spec rev 6 (`docs/superpowers/specs/2026-10-20-property-requirements-design.md`),
  plan sections 0-4 (copy 1.1, interfaces 2.x, invariants 3.1, AR1-AR48, 4.1,
  4.2), orchestrator rulings OR-1..OR-28 (`build-research/worklist.md`).
- Method: every verdict below is from the LIVE tree (file:line), not from the
  unit reports; the reports' claims were checked against the code and, where
  doubtful, by throwaway tests (section 5). Reading was done while the gates
  ran; tests only after `.superpowers/gates/final/summary.txt` printed `end`.
- Gates (from `.superpowers/gates/final/`): typecheck 0, test 0 (app 522
  files / 10840 passed / 1 skipped = the known staticSmoke self-skip;
  dashboard 263 / 5264; e2e unit 22 / 508; 0 `[dynamoAdmin]` lines), smoke
  0, e2e 0 (367 passed, the new `property-requirements.spec.ts:195` and
  `:454` included), lint exit 1 = five PRE-EXISTING errors (RC-9).
- ASCII: 0 non-ASCII bytes in every added line of the branch
  (`git diff -U0 3df43172 HEAD | grep '^+' | tr -d ...` printed 0, planning
  docs included).

## 1. Summary - decision -> verdict

| Decision / area | Verdict | Key evidence (live code) |
|---|---|---|
| D1 eight items, keys, kinds, flyer | CONFORMS | `app/src/lib/requirements.ts:70-106`; mirror `dashboard/src/routes/listing/requirements.ts:66-133` |
| D1 value kinds (checkbox / text / money / tour_type) | CONFORMS | `requirements.ts:226-256`; `unitFields.ts:285-295` |
| D1 deposit alternatives + `deposit_conflict` | CONFORMS | `unitRequirementWrite.ts:73-79`; `units.ts:898`, `:781-822`; `contacts.ts:1644-1668`; `requirementForm.ts:103` |
| D1 legacy `pets` boolean (read, write, partner) | CONFORMS (probe P-B) | `requirements.ts:185-195`; `unitFields.ts:261-284`; `unitRequirementWrite.ts:105-118` |
| D1 item equality | CONFORMS | `requirements.ts:160-168,210-220` (mirror `:198-218`) |
| D1 one registry + hand mirror, same cases | CONFORMS | drift test `requirementsMirror.test.ts`; OR-12 copies in `requirements.test.ts` |
| D2 property flat keys / landlord `req_` keys | CONFORMS | `unitFields.ts:60-154`; `contactsRepo.ts:346-370`; `contacts.ts:785-790,1644-1668,1865`; create PIN |
| D3 subzone (staff only, clearable), area off forms, washer/dryer | CONFORMS | `unitFields.ts:72,296-316,491`; `FlyerPage.tsx:57`; `ListingDetail.tsx:980-981` |
| D4 voucher sizes list: write kind | CONFORMS | `unitFields.ts:233-254` |
| D4 picker B, off-chip line, page row | CONFORMS | `VoucherSizePicker.tsx:42-120`; `requirementForm.ts:158-186`; `ListingDetail.tsx:975`; `listingFormat.ts:124-134` |
| D5 `requirement_sources` map (server-only, whole, empty REMOVE) | CONFORMS | `unitRequirementWrite.ts:166-191`; `unitsRepo.ts:997-1005,1122-1189`; PIN `unitFields.test.ts:425` |
| D5 classification: create with / without snapshot, PATCH, Apply | CONFORMS (probe P-B) | `requirements.ts:341-398`; `units.ts:875-977`; `contactRequirementsApply.ts:181-220` |
| D5 landlord change REMOVEs (PATCH, restore, claim); importer untouched | CONFORMS (probe P-A on DynamoDB Local) | `unitRequirementWrite.ts:176,183-186`; `unitsRepo.ts:1510,1883`; no `lib/import` change |
| D5 PATCH reads + fence + 3 attempts + 409 `property_changed` | CONFORMS | `units.ts:556,754-758,781-822,2330-2331`; `unitsRepo.ts:1122-1189`; copy `ListingEditForm.tsx:55,271-274` |
| D6 tag table, "blank" counts, multi-field one tag, no-landlord, re-read | CONFORMS (probe P-C) | `dashboard/.../requirements.ts:330-412`; `PropertyRequirementsCard.tsx`; `ListingDetail.tsx:373-374`; `useListing.ts:274-300` |
| D7 New form prefill, note, refill, snapshot, load/failure | CONFORMS | `UnitCreateForm.tsx:98-108,201,226-258,321-325,378-383,729-749` |
| D8 dialog B (re-read, columns, defaults, own value, hand rules, batching, copy) | CONFORMS (OR-17 variant, RC-3) | `ApplyRequirementsDialog.tsx`; `applyRequirementsModel.ts:41-216` |
| D8 server route (refusals, skips, write, audit, response) | CONFORMS | `contactRequirementsApply.ts:41-226` (byte-identical to plan 9961-10187); `requirements.ts:431-477`; `unitsRepo.ts:1321-1327` |
| D9 landlord card, Notes copy, landlord form fieldset | CONFORMS | `LandlordFile.tsx:164-187`; `LandlordRequirementsCard.tsx`; `ContactEditForm.tsx:371-381,1014-1025` |
| D10 property page rows + Requirements card; forms order, tags, legend, notes, No fee / One month | CONFORMS | `ListingDetail.tsx:972-1052`; `ListingEditForm.tsx:305-639`; `UnitCreateForm.tsx:401-778`; `RequirementsFields.tsx:57-115`; `TaggedField.tsx:35-101` |
| D10a tag table + app walk + dashboard parity | CONFORMS | `requirements.ts:518-539`; `propertyFormFlyerParity.test.ts:149-171,249-274`; mirror `:254-294` |
| D11 flyer projection + wording + old-bundle keys | CONFORMS (probe P-C) | `unitFields.ts:375-421,471-513`; `FlyerPage.tsx:57-151,307-376`; `publicApi.ts` |
| D12 Matching list, 4 = 4 or more, normalizer, wire, composer, summary, draft key | CONFORMS | `blastAudienceRules.ts:210-281`; `broadcasts.ts:221-247`; `audienceResolution.ts:161,202,258`; `AudienceFilters.tsx:140-205`; `BroadcastComposer.tsx:208-232`; `useComposerDraft.ts:111` |
| D13 audit field names, Apply reason + lift, landlord audit | CONFORMS (wording note RC-2) | `units.ts:386-395,812,2398,2417`; `contactRequirementsApply.ts:210-216`; `listingFormat.ts:261` |
| Spec 6 testing bullets (app, dashboard, e2e) | CONFORMS (two coverage notes RC-1, RC-11) | section 3 |
| Spec 7 places to update | CONFORMS | section 3 |
| Plan 1.1 / AR3 / AR32 / AR38 copy | CONFORMS byte for byte | section 2 |
| Plan 2.1-2.6 interfaces | CONFORMS | section 3 |
| Plan 3.1 invariant rows | CONFORMS | section 3 |
| OR-1..OR-28 | CONFORMS (OR-23/OR-28 orchestrator-owned) | section 3 |

Counts: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 1, INFO 10.

## 2. Findings

### RC-1 - LOW - test-coverage - CONFIRMED (probe P-A)

- Where: `app/src/routes/units.ts:781-822` (writeFencedPatch) ->
  `app/src/repos/unitsRepo.ts:1122-1189` (updateIfRequirementsFenced);
  real-repo suite `app/test/unitsRepoRequirementsFence.integration.test.ts:134-310`.
- Departs from: spec 6 "landlord change by PATCH ... REMOVEs the map" is
  pinned only on the API-test FAKE (`unitsApiRequirementsPatch.test.ts:161-183`).
  No committed DynamoDB Local case drives the fenced write with a patch that
  carries `landlordId` (SET of the attribute the condition also names) plus
  `requirement_sources: null`. Every real-repo fence case patches item keys
  or the map only.
- Proof: throwaway `app/test/zz-review-rc-fence-landlord.integration.test.ts`
  ran against DynamoDB Local (reachability asserted, not skipped): the
  planner's patch for `{ landlordId: 'c-new' }` was exactly
  `{ landlordId: 'c-new', requirement_sources: null }`; the real fenced write
  landed it (landlordId moved, map gone, updated_at stamped); a write from the
  stale read then threw `ConditionalCheckFailedException`; a landlord change
  plus `income_requirements` reset then classified `{ income_requirements: 'copied' }`
  against the new landlord. 3/3 passed. So the BEHAVIOR conforms; only the
  committed coverage is missing.
- Fix: add one `parity(...)` case to `unitsRepoRequirementsFence.integration.test.ts`
  whose patch carries `landlordId` and `requirement_sources: null` (and one
  refusing a stale read after it), so a future change to the SET / condition
  build cannot break the landlord-change PATCH in production unseen.

### RC-2 - INFO - spec-wording - CONFIRMED (reading)

- Where: `app/src/routes/contacts.ts:785-790` (every present `req_` key is
  pushed to `changedFields`) and `:2076-2077` (audit `fields: parsed.changedFields`);
  `app/src/routes/units.ts:2398` (plain PATCH path audits `Object.keys(validation.fields)`).
- Departs from: D2 "The audit `contact_updated` lists the changed `req_`
  keys"; D13 "The names are the unit keys the write actually changed".
- Status: deliberate and ruled - AR19 (contacts audit = keys the body
  carries, the existing convention) and PR2-2 (plain-path asymmetry stands,
  rejected finding). The fenced unit path does list keys actually changed
  (`units.ts:812`, `unitRequirementWrite.ts:131-139`; probe P-B saw
  `['pets']` for a REMOVE of the partner only). Every dashboard form sends
  only changed keys, so staff-visible history is the same; only a raw API
  call re-sending an unchanged value is listed.
- Fix: none required. Keep in mind if history is ever used as a change log.

### RC-3 - INFO - recorded-deviation - CONFIRMED (diff vs plan)

- Where: `dashboard/src/routes/contact/ApplyRequirementsDialog.tsx:121-125,144-148,211-220`;
  `applyRequirementsModel.ts:57-63` (`carryCheckedItems`).
- What: OR-17 - after a stopped run (a later batch 409 / failure) or a
  first-request non-409 failure, the re-read keeps the left column staff
  chose, narrowed to items the re-read landlord still holds; the plan text
  reset to defaults. The spec (D8) does not say what the left column does on
  that re-read, so this is within the spec; it only ever copies LESS than
  staff chose (a "Clears" item staff checked comes back unchecked).
- Verified: `diff` of the shipped dialog against plan lines 24093-24416 shows
  ONLY the OR-17 hunks (header note, import, `carryRef`, the read effect's
  carry, the catch's three branches). Pinned by
  `ApplyRequirementsDialog.test.tsx:360-449` and `applyRequirementsModel.test.ts:109-133`.
- Fix: none; it is the documented divergence for Cameron's eye.

### RC-4 - INFO - ux-note - CONFIRMED (reading)

- Where: `dashboard/src/routes/listing/ListingDetail.tsx:1035` (title
  "Tour & application process"), `:1038` (action label
  "Edit tour & application process"), `:1051` ("No process recorded yet.").
- What: tour type and tour process moved to the Requirements card (D10), so
  this card now shows only the application process but keeps "Tour" in its
  title and action name. D10 names the card by this title ("'Tour &
  application process' keeps Application process"), so it conforms.
- Fix: optional follow-up rename ("Application process"), Cameron's call;
  e2e/selectors that name the card would move with it.

### RC-5 - INFO - copy - CONFIRMED (reading)

- Where: `dashboard/src/routes/contact/Card.tsx:138` (`BLANK = '\u2014'`),
  used by `LandlordRequirementsCard.tsx:87`, `PropertyRequirementsCard.tsx`
  and the property-details rows.
- What: D9 says blank items show "-"; the build uses the page's existing
  em-dash marker, as AR40 binds ("blank values use the existing BLANK
  constant"). Consistent with every other blank on both pages.
- Fix: none.

### RC-6 - INFO - recorded-deviation - CONFIRMED (reading)

- Where: `dashboard/src/routes/listing/listingFormat.ts:124-129`
  (`recordedVoucherSizes`, no integer filter, OR-20);
  `app/src/lib/unitFields.ts:477` (`voucher_sizes` = all of
  `acceptedVoucherSizes`).
- What: a legacy stored non-integer size (possible only under the old
  number kind) shows on the property page as "2.5 BR" and on the flyer as
  "Fits a 2.5-bedroom voucher" until the next Edit save, which drops it (the
  form lists it as "Not a valid size, removed when you save: 2.5"). D4 ("the
  RECORDED sizes") and D11 ("all of acceptedVoucherSizes") both say exactly
  this.
- Fix: none.

### RC-7 - INFO - recorded-deviation - CONFIRMED (reading)

- Where: `e2e/scenarios/steps.ts:1543` (`dialog.getByLabel(/^Notes/)`);
  `e2e/tests/dashboard-next/listing-activity.spec.ts:295` (`{ exact: true }`).
- What: spec 7 says both `getByLabel('Notes')` selectors become
  `{ exact: true }`; OR-26 uses an anchored regex for the LANDLORD form
  because its Notes is a wrapping label whose text grows with the textarea.
  Same intent (never matches "Deposit notes"); the property form keeps
  `{ exact: true }` as specified.
- Fix: none.

### RC-8 - INFO - behavior-note - PLAUSIBLE (reading; U12 observation)

- Where: `ApplyRequirementsDialog.tsx:197-228` (`liveRef` gates only UI updates).
- What: if the page unmounts mid-run (browser Back while sending), the loop
  still sends the remaining batches for that landlord; Cancel / Escape /
  backdrop are disabled while sending, so only navigation can do it. The
  spec's "sends no more" is about a 409 / failure, not unmount, so this is
  spec-neutral; the landlord page re-reads its file on return.
- Fix: none required.

### RC-9 - INFO - gate-note - CONFIRMED (baseline reading)

- Where: `.superpowers/gates/final/5-lint.log` - 5 errors, all
  `react-hooks/*`: `BroadcastComposer.tsx:426,445`, `useComposerDraft.ts:155`,
  `FlyerPage.tsx:177,195`.
- Baseline: the same statements exist at the merge base 3df43172
  (`git show`): `BroadcastComposer.tsx:419,438` (`setMessage((current) =>`),
  `useComposerDraft.ts:152` (`disposableRef.current = ...`),
  `FlyerPage.tsx:142,160` (`setVariant(...)`, `setStage(...)`); they only moved.
  No new lint error. U7 and U11 attributed them the same way.
- Note: Task 7.9 Step 8 / AR46 (update `docs/issues/lint-backlog-repo-wide.md`
  "if Step 8 applies") is the orchestrator's and is not in the diff yet; the
  handback must NAME these five as pre-existing (AGENTS.md gate 5).

### RC-10 - INFO - recorded-deviation - CONFIRMED (reading)

- Where: `docs/issues/import-washer-dryer-not-mapped.md:4`.
- What: OR-5 asked for type "gap"; the registry's types are closed
  (`scripts/issues.mjs`), so U13 used `improvement` (severity low, status
  open, as ruled). Harmless; `npm run issues` ran without warnings.
- Fix: none.

### RC-11 - INFO - test-coverage - CONFIRMED (probe P-C)

- Where: `dashboard/src/routes/public/FlyerPage.tsx:65-75` (`voucherPhrase`);
  tests `FlyerPage.test.tsx:403-413`.
- What: plan 1.1 binds a GENERAL rule (studio as `studio`, every non-final
  number `<n>-`, `, or ` before the last of three or more); the suite pins
  the five spec examples plus a de-duplication case, but no mixed list with
  a studio among three or more. Probe P-C: `[0, 2, 3]` -> "Fits a studio,
  2-, or 3-bedroom voucher", `[0, 5]` -> "Fits a studio or 5-bedroom
  voucher", `[1, 12]`, `[4, 1, 2, 3]` all correct. Behavior conforms.
- Fix: optionally add `[0, 2, 3]` to the `it.each` table.

## 3. Confirmed conformant (with evidence)

### 3.1 By decision

- D1 items: ids, labels, groups, field keys / labels / kinds / flyer exactly
  as the spec table and plan 1.0 (`requirements.ts:70-106`; 15 unit keys and
  15 `req_` keys `:112-118`); dashboard mirror identical
  (`dashboard/.../requirements.ts:66-130`, drift test imports the app module).
- D1 kinds: checkbox true or REMOVE on false/null (`requirements.ts:231-235`);
  text trimmed, ''/null REMOVE (`:252-255`); money finite >= 0, null REMOVE
  (`:236-243`); tour_type enum, ''/null REMOVE (`:244-250`); deposit and
  application_fee clearable (`unitFields.ts:82,109`).
- D1 deposit_conflict: unit create (`units.ts:898-901`), unit PATCH against
  the consistent read (`unitRequirementWrite.ts:73-79,168`), landlord PATCH
  against the consistent stored contact (`contacts.ts:1598,1657-1666`); both
  forms send the amount as null on the save that CHECKS One month's rent
  (`requirementForm.ts:103`, landlord via `toLandlordPatch` `ContactEditForm.tsx:376-380`).
- D1 legacy pets: read (`requirements.ts:189-193`); boolean write stored in
  the new shape, 400 beside `no_pets` (`unitFields.ts:268-276`); partner on a
  stored boolean (`unitRequirementWrite.ts:105-118`); free text never parsed.
  Probe P-B: No pets checked on stored `true` -> `{ no_pets: true, pets: 'Allowed' }`,
  classified, audit `['no_pets','pets']`; unchecked on stored `false` -> both
  REMOVEd, audit `['pets']`.
- D2: `req_` keys parsed one by one (`contacts.ts:785-790`), unknown ignored,
  resulting-type gate 400 `requirements can only be set on a landlord`
  (`:1649-1653`), suggestion loop skips `req_` keys (`:1865`), provenance
  untouched (only `PROVENANCE_FIELDS`); create ignores them (PIN
  `landlordRequirementsPatch.test.ts:309`).
- D3: subzone clearable text (`unitFields.ts:72,296-306`), never projected
  (`:491` has no subzone; never-list `:347-355`), area-only neighborhood
  (`FlyerPage.tsx:57-59`), page row (`ListingDetail.tsx:402-403,980`), both
  forms; no Area input on either form; washer_dryer kind (`unitFields.ts:307-316`),
  flyer key (`:511`), page row (`ListingDetail.tsx:981`), flyer row
  (`FlyerPage.tsx` Washer / dryer dt/dd).
- D4: write kind null/[] REMOVE, integer -> [n], list de-duplicated ascending,
  400 otherwise (`unitFields.ts:240-253`); picker B chips, auto-open, Fewer
  only when no 5+ selected, aria-pressed toggles, group label, Accepts line,
  off-chip line (`VoucherSizePicker.tsx:36-120`); empty sends null and an
  off-chip value is dropped on save (`requirementForm.ts:175-186`,
  `ListingEditForm.tsx:206-207`); page row recorded sizes only, blank marker
  (`ListingDetail.tsx:975`).
- D5: map server-only (PIN `unitFields.test.ts:425`), whole, empty -> REMOVE
  (`unitRequirementWrite.ts:180-189`, `unitsRepo.ts:997-1005`); create with
  snapshot classifies every named item against it, missing key blank,
  unknown items ignored, landlordId mismatch 400 (`units.ts:880-895`,
  `requirements.ts:341-366,380-398`); without snapshot only items written
  non-blank vs the landlord just read (`units.ts:930,952-958`); PATCH vs the
  landlord of record AFTER the write (`units.ts:792-799`, AR9); landlord
  change resets then classifies (`unitRequirementWrite.ts:176`); restore and
  claim REMOVE (`unitsRepo.ts:1883,1510`); fence on landlordId + map, 3
  attempts, 409 (`units.ts:786-822`); a slow PATCH cannot write a map back
  (`unitsApiRequirementsPatch.test.ts:328-375`). Probe P-B: an explicit blank
  body key against a snapshot holding a value -> `set_here`, key absent.
- D6: `requirementDisplay` implements the five rows, blank prints "blank" and
  counts as differing, no landlord -> nothing (`dashboard/.../requirements.ts:389-405`);
  one tag + one whole-item line (`:330-382`); no-requirements note
  (`PropertyRequirementsCard.tsx:45-49`, `landlordHasNoRequirements` `:410-412`);
  of-record guard (`ListingDetail.tsx:373-374`); re-read on landlordId change
  incl. A->B->A (`useListing.ts:274-300`); tags differ in lightness and hue,
  text always present (`PropertyRequirementsCard.module.css`: solid
  #6d28d9 / white vs pale amber #fef3c7 / #92400e). OWN VALUE per D6, both
  sides (`requirements.ts:318-323`, mirror `:234-237`). Probe P-C: copied +
  landlord blanked -> orange, "Landlord now: blank".
- D7: locked path reads the contact (`UnitCreateForm.tsx:228-245`), picker
  path uses the list record (`:250-258`); note only with a requirement (AR31,
  `:380-383`); a different pick refills (`:252-257`); loading line and Create
  waits (`:201,730-733`); failure line + Try again, no snapshot (`:736-745,323-325`);
  snapshot = every item, every key, null for blank (`requirementForm.ts:136-140`).
- D8 dialog: re-reads both on open with loading / error + Try again
  (`ApplyRequirementsDialog.tsx:135-170,259-267`); left column defaults
  (`applyRequirementsModel.ts:41-45`) with Clears (`:294-298`); rows live,
  own value per D6 (`:70-82`), Already matches disabled (`:323`), start state
  (`:86-91`), hand rules (`:98-114`); no Select all; Update N / disabled at 0
  (`:242-250`); batches of 100 (`:205`); first 409 -> requirements-changed
  notice + re-read; later failure -> stopped notice + re-read; done ->
  `onDone` (summary) (`:197-228`); page takes every landlord read and
  refetches (`ContactDetail.tsx:1449-1463`).
- D8 server: order 404 / 400 not landlord / 400 body / 409 deposit_conflict /
  409 requirements_changed (`contactRequirementsApply.ts:145-176`); per unit
  consistent read + own clone + `planUnitApply` + conditional write, CCF ->
  `changed_during_apply`, other errors rethrown (`:181-205`); audit per
  written unit with `changedKeys`, reason, landlordId, best effort
  (`:210-219`); skip order and patch rules (`requirements.ts:431-477`);
  condition = exists + landlordId + map + not deleted as isDeleted reads it
  (`unitsRepo.ts:1145-1170`). Probe P-B: Apply over a legacy true -> audit
  `['no_pets','pets']`, reason and landlordId present.
- D9: card right after Landlord onboarding (`LandlordFile.tsx:162-170`),
  groups, Apply (disabled with reason) + Edit (`LandlordRequirementsCard.tsx:39-60`);
  fieldset after the onboarding block (`ContactEditForm.tsx:1007-1025`),
  landlord tags and legend, only changed `req_` keys (`:371-381`); Notes copy
  (`LandlordFile.tsx:187`); e2e moved (`contact-detail.spec.ts` D9 case).
- D10: Property details rows (Deposit / Pets / Application fee removed;
  Subzone, Washer / dryer, Voucher sizes accepted added) and the Requirements
  card with Edit (`ListingDetail.tsx:972-1012`); tour card keeps only the
  application process (`:1035-1052`, RC-4); form order, a tag on every field
  outside the label via aria-describedby, legend, public notes, No
  application fee and One month's rent couplings, Same-day RTA kind kept
  (`ListingEditForm.tsx:305-639`, `UnitCreateForm.tsx:401-778`,
  `RequirementsFields.tsx:57-115`, `TaggedField.tsx:35-101`).
- D10a: 35-row table, Owning landlord first (AR1), No application fee row
  (AR2) (`requirements.ts:518-539`); walk over three bases with the
  non-vacuity and trap pins (`propertyFormFlyerParity.test.ts:149-274`);
  mirror table compared by the drift test.
- D11: `voucher_sizes` ascending, `voucher_size` kept, subzone gone, new
  public keys, staff-only keys never projected, deposit / fee / pets read
  through D1 (`unitFields.ts:471-513`); wording for sizes, pets, pet fee,
  deposit (incl. flexible alone, no row for notes alone), fee, washer/dryer
  (`FlyerPage.tsx:57-151,307-376`); old-bundle keys kept (`unitFields.ts:381-404`).
- D12: list of chip values, 4 = 4 or more, ONE normalizer, POST either key
  with `bedroomSizes` winning (AR25), stored list only, wire list + compat
  first size (`blastAudienceRules.ts:210-281`, `broadcasts.ts:221-247`);
  resolver + log field (`audienceResolution.ts:161,202,258`); composer
  multi-select, one tagged chip per accepted size with 5+ on 4+, note,
  summary, draft key (`AudienceFilters.tsx:140-205`, `BroadcastComposer.tsx:208-232`,
  `broadcastFormat.ts:51-114`, `useComposerDraft.ts:111`); list / results via
  `audienceSummary` (`BroadcastsList.tsx:48`, `BroadcastResults.tsx:209`).
- D13: fenced PATCH lists keys actually changed incl. the pets partner,
  never the map; empty list -> no row (PR1-10a) (`units.ts:806-812,2417`);
  Apply audit reason; Activity lifts reason for `unit_updated` only when
  exactly `requirements_applied` (`units.ts:386-395`); dashboard label
  (`listingFormat.ts:261`).

### 3.2 Plan 1.1 / AR3 / AR32 / AR38 copy - byte check

Every string below was grepped (fixed-string) in non-test `app/src` and
`dashboard/src` sources and found; the five constructed ones were read at
the construction site.

- Tags `On flyer`, `Staff only`, `On property flyers` (`FlyerTag.tsx:21-24`);
  both legends, all four lines (`FlyerTag.tsx:35-41`); `Tenants see this on
  the public flyer.` (`TaggedField.tsx:16`).
- Headings `Requirements` (`ListingEditForm.tsx:609`, `UnitCreateForm.tsx:729`,
  card title), `Requirements / Qualifications` (fieldset legend, card title);
  groups `Screening`, `Pets`, `Move-in costs`, `Touring`; all 16 field labels;
  `Subzone`; `Washer / dryer` with `Not recorded` / `Hookups` / `Washer and
  dryer included` / `No hookups`; `Voucher sizes accepted`.
- Picker: `Studio`, `1`..`12`, `More sizes (5-12)`, `Fewer sizes`,
  `Accepts: ` + `Studio` / `<n> BR` joined `, `, `Accepts: none recorded`,
  `Not a valid size, removed when you save: ` + values joined `, `.
- `This property changed while you were saving. Save again.`; `Filled in
  from <L>'s requirements. Change anything that is different for this
  property.`; `Loading <L>'s requirements...`; `Couldn't load <L>'s
  requirements, so this property starts without them. You can apply them
  from the landlord page later.` + `Try again` (`UnitCreateForm.tsx:382,732,739,742`).
- Page: `Set on this property`, `Landlord updated`, `Landlord: `,
  `Landlord now: `, `blank`, `<L> has no requirements recorded yet.`,
  `Requirements applied from the landlord`.
- Landlord page and dialog: `Apply to properties`, `This landlord has no
  properties yet.`, `No notes yet - use + Add.`, `What to copy`, `Which
  properties`, `Clears`, ` (own value)`, `Already matches`, `Update <N>
  properties` / `Update 1 property`, `Loading...`, `Couldn't load this
  landlord's properties.`, the requirements-changed and stopped notices
  (singular via `propertiesCount`), `Updated <N> properties` / `Updated 1
  property`, `<M> skipped`, `<address> - <reason>` and all six reasons
  (`applyRequirementsModel.ts:143-216`).
- Flyer: `Fits a ... voucher` with the general rule (probe P-C), `No pets`,
  `No pets (<details>)`, `Pet fee`, `One month's rent` / `$N` + `, flexible /
  payment plan available`, `Flexible / payment plan available`, `No
  application fee`, the washer/dryer labels; `$N` = the flyer's existing
  `$${n}`.
- Matching: `Pre-filled to the voucher sizes this property takes: ` + chip
  labels joined `, ` (`AudienceFilters.tsx` PREFILL_SIZES_NOTE); summary joined
  `, ` (`broadcastFormat.ts` `voucherSizesLabel`).
- AR3: `<key> must be true, false or null`, `... must be a string or null`,
  `... must be a number`, `... must be >= 0`, `... must be one of:
  self_guided, landlord_led, pm_team` (`requirements.ts:234-253`); `pets must
  be a string, a boolean or null`, `voucher_size_accepted must be an integer
  0..12 or a list of them`, `subzone must be a string or null`,
  `washer_dryer must be one of: hookups, included, none` (built from
  `WASHER_DRYER_VALUES`, `unitFields.ts:314`), `pets: a boolean pets cannot be
  combined with no_pets`; plan 2.4 snapshot / landlord strings; AR14 Apply
  400s (identical to plan 9961-10187 by `diff`).
- AR32: both `A deposit can be one month's rent or a fixed amount, not both.
  Reload the property|landlord and try again.` (`ListingEditForm.tsx:59-60`,
  `ContactEditForm.tsx` DEPOSIT_CONFLICT_COPY). AR38: `Couldn't update the
  properties. Review the list and press Update again.` and the one-property
  stopped notice.

### 3.3 Spec section 6 testing bullets

- App registry/validation, contacts `req_`, classification (incl. the HTTP
  response asserts), Apply route (all 404/400/409, all six skip reasons,
  SET/REMOVE, pets pair, sources map, all-blank Clears, audit, the 100 cap),
  flyer projection (walk over 3 bases, voucher_sizes, voucher_size, subzone,
  staff-only absent, deposit cases), Activity projection, Audience
  (normalizer, any-of, projection): present - `requirements.test.ts`,
  `requirementSources.test.ts`, `requirementsApply.test.ts`,
  `unitFields.test.ts`, `landlordRequirementsPatch.test.ts`,
  `unitsApiRequirementsCreate/Patch/Reset.test.ts`,
  `unitsRepoRequirementsFence.integration.test.ts`,
  `primaryHandoffParity.integration.test.ts`, `requirementsApplyApi.test.ts`,
  `propertyFormFlyerParity.test.ts`, `unitsApiActivity.test.ts`,
  `blastAudienceRules.test.ts`, `audienceResolution.test.ts`,
  `broadcastApi.test.ts`. Coverage note RC-1.
- Dashboard bullets: `RequirementsFields.test.tsx`, `VoucherSizePicker.test.tsx`,
  `requirements.display.test.ts`, `PropertyRequirementsCard.test.tsx`,
  `ApplyRequirementsDialog.test.tsx` (re-read, defaults, all-blank own
  values, live recompute, hand reset only on a gained own value, ownItems,
  batching, mid-run 409 / failure, 409 re-read), form suites (tags out of
  names, property_changed, prefill / snapshot / refill / load / failure,
  One-month null), composer suites, `FlyerPage.test.tsx`,
  `requirementsMirror.test.ts`. Coverage note RC-11.
- E2E: `property-requirements.spec.ts:195` covers prefill, set-here, landlord
  updated, Apply defaults (exception unchecked + marked, stale copy checked,
  Cats OK own value), Update, page values + Activity line, flyer public /
  staff-only, "No pets" never "No pets (Cats OK)"; `:454` two-size pre-fill
  and a 6-bedroom tenant on 4+. Both ran green in gate 4.

### 3.4 Spec section 7 places

All present in the diff: `unitFields.ts`, `requirements.ts` (new),
`unitsRepo.ts` (UnitItem, lease_terms comment fixed, fence, applyRequirements,
both REMOVEs), `units.ts`, `contacts.ts` + `contactRequirementsApply.ts`
(AR13), `contactsRepo.ts`, the harness repo, Matching (4 files incl. the
router header comment), seeds (Delia Okonkwo's unit holds copied / set-here
/ landlord-updated items with `updated_at` (OR-7), `[2, 3]` kept, matrix one
legacy + one list; lean byte-stable - `git diff 3df43172 HEAD -- app/src/lib/seed/lean.ts`
empty), dashboard `api/types.ts` (stale comments fixed `:2570-2572,2620-2624`;
no import added, OR-15), `endpoints.ts`, every listing / contact / public /
broadcasts file named. `useContactFile.ts`, `BroadcastsList.tsx`,
`BroadcastResults.tsx` needed no edit (existing `refetch`; `audienceSummary`).
E2E repairs as listed (AR43's three specs untouched and green), both Notes
selectors (RC-7), GLOSSARY (all four asks), the mermaid line, two issues
resolved and the onboarding issue partly closed. No importer change.

### 3.5 Plan 2.x interfaces

2.1 every export and signature (`requirements.ts`, U1 contract table
re-checked); 2.2 kinds, boolean-pets 400, pure validator without
deposit_conflict, UnitFlyer adds / keeps / removes; 2.3 both fenced methods
(`unitsRepo.ts:687,695`), REMOVEs; 2.4 wire incl. snapshot errors, Apply
body / order / response, Activity lift; 2.5 `VOUCHER_CHIP_MAX`,
`bedroomSizesOfFilter`, `voucherSizeMatches`, `WireAudienceFilter`, POST
error string, log field; 2.6 mirror (AR27 scope), `RequirementDisplay`,
`requirementDisplay`, `formatItemValue`, `landlordHasNoRequirements`,
`FlyerTag` / `FlyerLegend`, `VoucherSizePicker` (+ AR29 props),
`RequirementsFields`, the three cards / dialog, `applyLandlordRequirements(contactId, body, signal?)`
(`endpoints.ts:1485`), `createUnit(CreateUnitBody)` (`:976`), the wire types.

### 3.6 Plan 3.1 invariant rows

Every writer and reader row checked: unit requirement keys (WATCH readers
`TourDetail.tsx:716`, `ScheduleTourForm.tsx:247-292`, `listingSendOutcome.ts:112`,
`contact/Card.tsx:229`, `units.ts:1610` unchanged); `requirement_sources`
(writers create / PATCH / Apply / restore / claim / harness / seed only;
never in `toUnitFlyer` - `unitFields.test.ts:661`; never in an audit list);
landlord `req_` keys; voucher list (one reader both sides); audience list;
subzone; washer_dryer; landlordId vs map (PR1-9 WATCH holds: no map writer
skips `updated_at`; the seed now stamps it, OR-7). Only other runtime
`landlordId` writers are the PATCH, `addContact` claim and
`restoreWithLandlord` (grep of `app/src`), all covered.

### 3.7 OR rulings

OR-1 (import split, `units.ts:25-30`), OR-2 (`requirements.ts:346`), OR-3,
OR-4 (WATCH), OR-5 (RC-10), OR-6 / AR28 (leaf: only `./toursModel.js`; no
post-ES2022 API by grep), OR-7 (`cast.ts` unit `updated_at`), OR-8, OR-9,
OR-10 (U5 report), OR-11, OR-12, OR-13, OR-14 (`listingFormat.ts:79-94`),
OR-15, OR-16 (`dashboard/.../requirements.ts:19-26`), OR-17 (RC-3), OR-18
(`ContactDetail.tsx:357-358` + two pins), OR-19 (`RequirementsFields.tsx:97`
`step="any"`), OR-20 (RC-6), OR-21 (e2e uses substring for the Activity label
and own value; group queries scoped), OR-22 (`ListingDetail.tsx:380`),
OR-24 (comments), OR-25 (catalog pin 122), OR-26 (RC-7), OR-27
(`e2e/README.md:191`): all applied. OR-23 and OR-28 are orchestrator
handback items; gate 2 ran the full dashboard suite (ContactDetail and
useContactFile included) after the sync, green.

## 4. Unit-report deviations audited

All recorded deviations are real, intended and harmless: U1-U3 mutant
follow-up tests only; U4 OR-1 + two pointer cases; U5 OR-7 + commit style;
U8 OR-12 copies + one import line; U9 three follow-up tests; U10 one
StrictMode test; U11 the `requirementsLandlord` const moved above its first
use (TDZ) + OR-22 test + doc-comment wording; U12 OR-17 (RC-3, diff-verified),
three plan-test slips fixed in tests only (the changes list in DISPLAY order
matches D1 "display order everywhere"), OR-18 inside the existing effect;
U13 OR-26, selectors notes, issue type (RC-10). No SILENT deviation found:
the Apply route is byte-identical to the plan; the dialog differs only by
OR-17; the FlyerPage helpers match the plan text.

## 5. Empirical probes (throwaway, deleted by exact name)

| Probe | File | Ran | Result |
|---|---|---|---|
| P-A | `app/test/zz-review-rc-fence-landlord.integration.test.ts` | DynamoDB Local (reachability asserted) | 3/3 passed - see RC-1 |
| P-B | `app/test/zz-review-rc-route-probes.test.ts` | harness | 4/4 passed - D1 partner on the No pets path, D5 explicit blank vs snapshot, D8 + D13 audit over a legacy boolean |
| P-C | `dashboard/src/routes/public/zz-review-rc-flyer.test.tsx` | jsdom | 5/5 passed - plan 1.1 general voucher rule, D6 copied + blanked landlord |

All three files were removed with `rm` by exact path after the runs;
`git status --short` lists none of them (the untracked `zz-review-ra-*` /
`zz-review-rd-*` files belong to other reviewers and were not touched). No
git writes were made.
