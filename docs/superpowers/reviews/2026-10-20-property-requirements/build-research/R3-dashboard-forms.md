# R3 - build research: dashboard Matching (S4 dashboard part) and dashboard property forms (S5)

- Reader: R3 (read-only live-tree drift check, per `.superpowers/sdd/research/CHARTER.md`).
- Slices covered: S4 dashboard part (Tasks 4.5, 4.6) and S5 (Tasks 5.1 - 5.9).
- Plan line ranges read: 1-913 in full (sections 0-4); S4 header, contract
  issues and facts 10627-10832; Task 4.3 wire excerpts 11406-12109; Tasks
  4.5-4.6 and S4 notes 12228-13565; S5 13566-20018 in full; S1 module code and
  the Task 1.7 table (1134-1912, 2290-2340, 4611-5006, skimmed for exports);
  S6 import blocks and Task 6.9 (20019-20110, 20278-20330, 21084-21220,
  22203-22275, 22450-22465, 22926-22937, 23181-23480, 24115-24280).
- Tree commit: `b0b07a5a080b5303b74e77d91e02977d503584e0` (main @1d7a4667 + docs).
  Main has since moved to 3df43172; its only dashboard/e2e change is
  b222a4ac (`dashboard/src/api/client.ts` + `client.abort.test.ts`), which
  touches no S4/S5 file.
- Severity totals: BLOCKER 0, MAJOR 0, MINOR 6.

## Findings

### R3-F1 - Task 4.6 Step 1a - ANCHOR - MINOR

- Plan (12814-12821): two single-line edits, the first anchored on
  `    expect(onChangeSpy).toHaveBeenLastCalledWith({ contact_type: 'tenant', bedroomSize: 2 });`
  ("in 'a list that fails to load says so...'").
- Tree: that exact line occurs TWICE in
  `dashboard/src/routes/broadcasts/AudienceFilters.test.tsx` - :122 (inside
  the voucher describe :95-144 that Step 1a replaces wholesale) and :207 (the
  intended site). The anchor is unique only after the describe is replaced.
- Instruction: in Task 4.6 Step 1a, replace the WHOLE describe
  `AudienceFilters - voucher size pre-fill + override` (:95-144) FIRST, then
  make the two single-line edits (an Edit call made before it fails as
  non-unique). The second anchor (:247, `bedroomSize: 2, housing_authorities`)
  is unique either way.

### R3-F2 - Task 5.2 Step 1 ("Same cases as the app suite") - FACT - MINOR

- Plan (14698-14712): "open S1's app test for this module
  (`app/test/requirements.test.ts`; if named otherwise, find it ...)".
- Tree/plan: S1 spreads the mirrored functions' cases over THREE app files:
  `app/test/requirements.test.ts` (Task 1.1: registry, `unitItemValue`,
  `landlordItemValue`, `itemValuesEqual`, `isItemBlank`, ids/keys),
  `app/test/requirementSources.test.ts` (Task 1.2, plan ~2290: 
  `readRequirementSources`, `isOwnValue`), and
  `app/test/propertyFormFlyerParity.test.ts` (Task 1.7, plan 4806-4878: the
  35-row `PROPERTY_FORM_FIELDS` table and its frozen case).
- Instruction: in Task 5.2 Step 1, copy the mirrored-function cases from all
  three files (same `it` names, same inputs/expected values), not only
  `requirements.test.ts`.

### R3-F3 - Tasks 1.1/1.2/1.3/1.7 -> 5.2 (drift test) - CONTRACT - MINOR

- Plan AR28 (749-751): the app module stays a leaf (only `./toursModel.js`, no
  Node globals). It says nothing about the ECMAScript LIB level.
- Tree: `dashboard/tsconfig.json:5` sets `"lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"]`;
  the app compiles with `tsconfig.base.json:6` `"target": "ES2023"` (default
  lib ES2023). `requirementsMirror.test.ts` makes the DASHBOARD typecheck
  compile `app/src/lib/requirements.ts` + `toursModel.ts`.
- S1's drafted module code uses only ES2022-safe APIs (`Object.hasOwn`,
  `flatMap`, `Map`, `Set`; the `structuredClone` hits are in the app TEST
  `propertyFormFlyerParity.test.ts`, not the module). But an S1 builder who
  writes `toSorted` / `findLast` / `toReversed` / `.with()` / `Object.groupBy`
  in the module passes `npm run typecheck -w @housingchoice/app` and fails
  only at S5 Task 5.2 Step 4 (root `npm run typecheck`).
- Instruction: S1 builders keep `app/src/lib/requirements.ts` within ES2022
  APIs; if Task 5.2 Step 4 typecheck fails inside the APP module, fix the API
  use in the app module (a lib-level change, not a behavior change) rather
  than widening the dashboard lib.

### R3-F4 - Task 5.7 Step 4 - FACT / COMMAND - MINOR

- Plan (17284-17294): GREEN runs `src/routes/orgs src/routes/contact
  src/routes/broadcasts src/routes/settings src/routes/listing src/routes/email
  src/routes/conversation` and lists the other ContactSearchField hosts as
  RecipientPreview, CreateRelayGroupModal, RelationshipsEditor,
  UnitSearchField, ConversationDetail, EmailTriage, ListingDetail,
  RestoreLandlordDialog.
- Tree: three more hosts exist -
  `dashboard/src/routes/placements/PlacementCreateForm.tsx`,
  `dashboard/src/routes/shared/PeopleCard.tsx`,
  `dashboard/src/routes/tours/ScheduleTourForm.tsx` (grep `ContactSearchField`).
  They pass none of the new props (markup unchanged; React omits
  `aria-describedby={undefined}`), and Task 5.9 Step 4 runs the whole
  dashboard suite, so nothing breaks.
- Instruction: add `src/routes/placements src/routes/shared src/routes/tours`
  to Task 5.7's GREEN run for coverage.

### R3-F5 - no task (S5/S6) - INVARIANT (stale reader doc) - MINOR

- Tree: `dashboard/src/routes/listing/listingFormat.ts:78-81` (the
  `acceptedVoucherSizes` doc) says "ONE number today, or a LIST once tracker
  #12 makes the field a multi-select", and `:89-90` "NOT for the property
  page's 'Voucher size accepted' row or the New/Edit forms";
  `dashboard/src/routes/listing/listingFormat.test.ts:83-86` repeats "ONE
  number today, a multi-select LIST with tracker #12". After S5 (tracker #12
  delivered; the row is "Voucher sizes accepted") these are stale. The code
  needs no change (list-ready; list cases already pinned at
  `listingFormat.test.ts:93-102`, which satisfies plan 3.1's "list cases
  re-pinned 5.x" without an S5 task).
- Instruction: S6 Task 6.2 (which edits `listingFormat.ts`) refreshes the two
  comment blocks (ASCII only on added lines; the file has pre-existing arrows).

### R3-F6 - S5 facts F25 / C10 / F17 - FACT - MINOR (cosmetic)

- F25 (13790-13798) lists non-ASCII at `types.ts:2541,2543,2549`; the tree
  also has non-ASCII at `:2539` (section sign, `video_url` comment) and `:2545`
  (em dash, replaced by Edit E). No edit touches 2539/2541/2543/2549, so
  harmless.
- C10 (13679-13680) cites `types.ts:8` for the one routes import; it is
  `dashboard/src/api/types.ts:15`
  (`import type { RETRY_OUTCOME_UNCONFIRMED } from '../routes/contact/retryPromise.js';`).
  Note the comment above it: the APP typecheck also compiles `types.ts`
  (`app/test/contactTimeline.test.ts:42`) - Task 5.1's additions are type-only
  with no new import, which keeps that working.
- F17 cites `AppFrame.test.tsx:115`; the file is
  `dashboard/src/app/AppFrame.test.tsx:115`.
- Instruction: none required (do not add any import to `types.ts`).

## Confirmed

Anchors (byte-exact in the tree unless noted "produced by"):

- Task 4.5: 12/12 - broadcastFormat.test.ts import block and the two
  insertion points (`describe('audienceSummary'`, the PA-5 case :50-52);
  BroadcastsList.test.tsx :84-86 (all ASCII); BroadcastResults.test.tsx :102;
  types.ts :3268 and :3278-3281; endpoints.ts :1984; broadcastFormat.ts
  :25-27, :42-44, :46-48, :68.
- Task 4.6: 30/30 - AudienceFilters.test.tsx harness :45, :58-59, :82; the
  describe :95-144; :207 and :247 (see R3-F1 for order). BroadcastComposer.test.tsx
  `unit()` end :52-55, :208, :223, override case :226-233, insertion comment
  :823 (unique), Oak anchor :954-955 (unique); replace_all counts match the
  plan exactly: `bedroomSize: 3,` 2 sites after the Oak edit (:744, :908),
  `bedroomSize: 2,` 8 sites (:732,:759,:769,:877,:986,:1091,:1130,:1206),
  `{ contact_type: 'tenant', bedroomSize: 2 }` 2 sites (:890,:1161); 13 total
  = the plan's list. AudienceFilters.tsx :2-3, :12-15, :30-33, :46-47, :66-69,
  :106-108, block :133-152 (line :137 carries U+2192, see ref file), :175-176,
  :184, :192-197. broadcastFormat.ts `bedroomPhrase` :50-56. useComposerDraft.ts
  import :21-26 and key :107-108. BroadcastComposer.tsx :40, :95-96, :193-196,
  :205, :213-225, :298-308, :768.
- Task 5.1: 16/16 - mutationCatalog.test.ts :380-382 (pin 121 today);
  endpoints.test.ts :11-13, :35-36, :59; types.ts Edit A :2516 (unique), B
  :2520 (unique), C :2527-2530, D :2544 (unique), E :2545-2548 (em dash on
  :2545, see ref), F :2572 (unique), G :2293-2294 (unique), H :2359-2360
  (unique); endpoints.ts Edit 1 :26-27, Edit 2 :966-969, Edit 3 :1460-1466;
  mutationCatalog.ts :145.
- Task 5.7: 8/8 - OrgPicker.tsx :73-74, :171-174, :305-308, :358-361;
  OrgPicker.module.css :12-16; ContactSearchField.tsx :68-69, :93-95, :249-250.
- Task 5.8 test edits T1-T7: 7/7 (ListingEditForm.test.tsx :22, :175-180,
  :195/:200 (only regex sites after T2), :211-251, :253-263, :302-305, :469);
  ListingEditForm.module.css comment :113.
- Task 5.9 test edits U1-U8: all present - the 16
  `await screen.findByRole('dialog', { name: 'New property' });` lines are
  exactly :139,170,194,225,239,258,274,299,323,342,376,391,411,424,458,485 (all
  locked-path; :94 does not match); `fill` helper :85-88; :99; :144; :157;
  the six exact body pins :180-183, :230, :247, :381-384, :397-401, :478; U7
  title :220 (em dash, see ref); U8 :415. endpoints.ts anchors for 5.9 are
  produced by Task 5.1 Edit 1 / exist at :970.
- Tasks 5.2-5.6 create new files only; their imports resolve to exports S5
  itself defines or the api barrel already has (`TOUR_TYPE_LABELS`
  `types.ts:907-911`, `TourType` :904, `Address`, `ApiError`).

Facts:

- S4 dashboard facts F8-F16 true (F8 `tenantFacets.ts:8,47-51`; F13
  `BroadcastsList.tsx:48`, `BroadcastResults.tsx:209,223`; F14 matches
  `docs/issues/lint-backlog-repo-wide.md:13-25`).
- S5 F1-F24, F26 true against the tree (line hints within a few lines);
  F11 `contacts.ts:1107-1109`, `contactsRepo.ts:1361`; F12 `client.ts:39-40`;
  F13 `Card.tsx:136-144`, `e2e/scenarios/steps.ts:1736`; F15 `eslint.config.mjs:49-53`;
  F18 `client.ts:74-80`; F20 `ContactSearchField.tsx:204,211`; F21
  `Modal.tsx:179-184`. C13 true (count pin :382, `firewall.ts:189-195`,
  `methodFromObject` handles the `signal` spread, `placeholderFor` turns
  `${encodeURIComponent(contactId)}` into `:contactId`).
- Every CSS custom property the new modules use exists in
  `dashboard/src/ui/tokens.css` (sp-1..4, fs-xs/sm/md, fw-medium/semibold,
  radius-pill/md, c-brand/-soft/-hover, c-surface-2, c-text/-muted/-inverse,
  c-border/-strong, c-focus-ring, c-danger); every `formStyles.*` class used
  exists in `ListingEditForm.module.css`.

Rulings (no conflict found):

- AR1 / PR1-2 (hunt 6): Task 5.2's FORM_FIELD_LIST and Task 1.7's
  `PROPERTY_FORM_FIELDS` are equal row for row - 35 rows, same labels, keys
  and flyer values, same order (Owning landlord first; No application fee
  immediately before Application fee). Frozen alike.
- AR22-AR26 (S4): the dashboard `bedroomSizesOfFilter` keeps integers >= 0 in
  both arms; the 14 SIZE_CASES of Task 4.5 equal Task 4.1's table
  (plan 10892-10911); non-integer sizes left out of the pre-fill; `withSizes()`
  cast; note text bound and names chips.
- AR27-AR34, AR36, AR37, AR39, PR1-1, PR1-3, PR1-7, PR2-1, PR2-3 (S5): all
  delivered as written (mirror read-side scope; leaf import; optional
  labelAside/describedBy; `the landlord` fallback; C7 note gating; both
  deposit_conflict copies; wire types in `types.ts` with re-export; S5 helper
  names; host renders heading + legend; WASHER_DRYER_LABELS and
  acceptsSummary placement; tour type via TOUR_TYPE_LABELS keys exactly;
  money inputs `min={0}` + `step="any"` with tests in 5.8 and 5.9).
- Plan 1.1 copy: every S4/S5 string asserted by a test matches 1.1 exactly
  (tags, both legends, public note, headings, labels, Washer / dryer options,
  picker chips/controls/summary/off-chip line, 409, create note / loading /
  failure / Try again, pre-fill note, summary joins). The blank all-items
  snapshot for a landlord with no requirements is spec D7 ("the snapshot is
  all blank").

Contracts:

- Hunt 4 (S5 -> S6): every name S6 imports from S5 files exists with the
  signature S6 uses - from `routes/listing/requirements.ts`: REQUIREMENT_ITEMS,
  isItemBlank, isOwnValue, itemValuesEqual, landlordItemValue,
  readRequirementSources, unitItemValue, WASHER_DRYER_LABELS, types ItemValue
  and RequirementItemId (S6 appends formatItemValue, requirementDisplay,
  landlordHasNoRequirements, requirementItemsByGroup itself); from
  `FlyerTag.js`: FlyerLegend `{ audience }`; from `RequirementsFields.js`:
  `{ values, onChange, audience, disabled? }`; from `requirementForm.js`:
  `requirementFormValuesFromLandlord(contact)`, `buildRequirementPatch(initial,
  current)` -> `{ ok: true; patch } | { ok: false; error }`,
  `toLandlordPatch(patch)` (S6 merges it with `Object.assign`, so the
  `Record<string, unknown>` return type is fine), `RequirementFormValues`;
  from the api barrel: `applyLandlordRequirements(contactId, body, signal?)`,
  `ApplyRequirementsBody`, `ApplyRequirementsResult`, `UnitItem` /
  `Contact` with the req_ keys and `requirement_sources`. S6 fixtures
  (`req_qualifications`, `requirement_sources: { deposit: 'copied' }`, unit
  `no_pets` / `pet_fee` / `evictions_notes`) all type-check against Task 5.1.
  S6's select `getByRole('combobox', { name: 'Tour type' })` holds
  (@testing-library/dom 10.4.1 / aria-query 5.3.0 map a single select to
  combobox).
- Hunt 5 (S4 app -> S4 dash): the wire returns `bedroomSizes` always and
  `bedroomSize` (the first) when non-empty (Task 4.3, plan 11514-11537,
  11697-11719); the dashboard reads every filter only through
  `bedroomSizesOfFilter` (list wins), keeps `bedroomSize?: number` as
  read-only compat, sends only `bedroomSizes`, and the composer never reads a
  stored filter (F12). Consistent.
- S5 <- S1-S3: the drift test's 15 app exports exist in S1 Tasks 1.1/1.2/1.7;
  `{ error: 'property_changed' }` / `{ error: 'deposit_conflict' }` (S2) reach
  the forms as `ApiError.code` (`client.ts:76`); the Apply path
  `/api/contacts/:contactId/requirements/apply` matches S3 Task 3.2; the
  snapshot shape `requirementsSnapshotOf` emits (every item, every key, null
  blank, naming `landlordId`) matches plan 2.4; '' REMOVEs `washer_dryer`
  (S1 Task 1.5 test, plan 3529) and the text kinds.
- main b222a4ac (a signalled request waits one microtask and is dropped if
  aborted in that tick): S6 calls `applyLandlordRequirements` WITHOUT a
  signal (plan 24279), so the Apply write always dispatches; Task 5.9's
  locked `getContact(landlordId, ac.signal)` effect ignores the dropped
  first-mount read (`if (!ac.signal.aborted)` guard), so StrictMode stays
  correct after the S7 main sync.

Existing tests that pin changed behavior - every one is updated by a task:

- AudienceFilters.test.tsx :95-144 (4.6 rewrite), :207, :247 (4.6).
- BroadcastComposer.test.tsx :208, :223, :226-233, and the 13 `bedroomSize`
  lines (4.6). Still valid unchanged: :198-209 single tag, :221, :253-267,
  :441, :575, :899-910 (now [2,3]), :912-961, :1026, :1286-1310, :1474-1493.
- broadcastFormat.test.ts :28-49, BroadcastsList.test.tsx :40/:84,
  BroadcastResults.test.tsx :44, useBroadcastResults.test.tsx :35 - PINs of
  the old shape, valid as written (4.5).
- ListingEditForm.test.tsx :175-180 (T2), :195/:200 regex `/Application fee/i`
  (T3), :211-251 number voucher input (T4), :253-263 `'Deposit'` (T5),
  :302-305 hint line (T6), :469 exact description (T7). Unchanged and still
  green: :65-79, :81-93, :95-109 (`'Notes'` exact - no collision with
  "Deposit notes"), :111-125, :127-143, :166-173, :265-290 Tour type,
  :292-300 (`/couldn.t save/i` matches the new ASCII copy), :309-547.
- UnitCreateForm.test.tsx :99, :144/:157 (U4, U5), the six exact body pins
  (U6), :220 title (U7), :415 (U8), 16 dialog lines (U2). Unchanged and still
  green: :91-131 locked/picker cases, :256-270 (Beds `min={0}` native
  validation still blocks), :272-310, :313-331, the picker-list cases.
- ListingDetail.test.tsx :215-233 edit dialog stays `{ utilities: 'Gas only' }`
  (untouched voucher 2, deposit 1400, pets 'Cats only', fee 25 send nothing).
  ListingDetail.test.tsx :211, :253-285, :298-313, :341-346 are S6 (6.5) and
  listed in S6's table (plan 20241-20244).
- No dashboard test imports `bedroomPhrase`; no snapshot tests exist; no other
  dashboard test opens either property form (F26 holds).

Testing-library collisions (hunt 2): every regex `getByLabelText` in
ListingEditForm.test, UnitCreateForm.test and ListingDetail.test (Street
address, Tenant-paid utilities, Rent max, Video URL, Same-day RTA, Accepted
vouchers) matches one label in the rebuilt forms; only `/Application fee/i`
collides and T2/T3 fix it. Exact selectors (`'Notes'`, `'Tour type'`,
`'Application fee'`, `'Pets (details)'`) are unique. ContactEditForm.test
landlord selectors are anchored (`/^Lease terms$/i`, `/^Pet policy$/i`) and do
not hit the S6 fieldset's labels.

Native constraint validation (hunt 3): no S4/S5 UI test submits a value a
`min` / `step` / `required` attribute rejects except the intended pre-existing
negative-Beds case (UnitCreateForm.test :256-270); the bad-amount `ok: false`
branch is pinned only at helper level (Task 5.3), the cents cases (5.8, 5.9)
assert `step="any"`, and disabled amount inputs are barred from validation.
Other number inputs keep `step={1}` / `step={0.5}` (PR2-3: unchanged).

Commands (check 8): every RED/GREEN path exists (dashboard
`src/routes/contacts/tenantFacets.test.ts`, `useBroadcastResults.test.tsx`,
`BroadcastComposer.prefill.test.tsx`, `RecipientPreview.test.tsx`,
`src/api/endpoints.test.ts`, `src/api/lists.test.ts`; e2e
`performance/mutationCatalog.test.ts` and `firewall.test.ts` under
`e2e/vitest.config.ts` include `performance/**/*.test.ts`). Root
`npm run typecheck` runs app (3 tsconfigs), dashboard and e2e; the drift
test's cross-workspace import typechecks under `dashboard/tsconfig.json`
(`moduleResolution: bundler`, `include: ["src", ...]`, precedent
`caseworkerRoleMirror.test.ts:18-22`) given R3-F3.

Mutation catalog (check 6c): today 121 non-delegated fingerprints; S5 adds
exactly one (`applyLandlordRequirements :: request:POST ::
/api/contacts/:contactId/requirements/apply`, first_party_api, workflow_only)
-> 122; no other S4/S5/S6 change adds a fingerprint (createUnit / updateUnit /
updateContact keep theirs; S6's getUnits landlordId is a GET). No other e2e
file pins the count (`e2e/performance/routes.ts` cites endpoints.ts line
numbers as unvalidated strings only).

## Invariant sweep

(a) Unit `voucher_size_accepted` - dashboard and e2e

| Surface | Kind | Status |
|---|---|---|
| `dashboard/src/api/types.ts:2548` `number` -> `number \| number[]` | type | IN-PLAN (5.1) |
| `routes/listing/ListingEditForm.tsx:105,193-206` number input | writer | IN-PLAN (5.8, picker B) |
| `routes/listing/UnitCreateForm.tsx:115,219,555-565` number input | writer | IN-PLAN (5.9, picker B) |
| `routes/listing/listingFormat.ts:103-109` `acceptedVoucherSizes` mirror | reader | IN-PLAN (3.1 WATCH; list cases already pinned `listingFormat.test.ts:93-102`) |
| `routes/listing/listingFormat.ts:78-91` + `listingFormat.test.ts:83-86` doc | comment | NOT-IN-PLAN (R3-F5, stale) |
| `routes/listings/unitListFacets.ts:175-196` | reader | IN-PLAN (3.1 WATCH, list-ready) |
| `routes/broadcasts/BroadcastComposer.tsx:205` first size only | reader | IN-PLAN (4.6) |
| `routes/broadcasts/AudienceFilters.tsx:66-69,150-152` prop | reader | IN-PLAN (4.6) |
| `routes/listing/ListingDetail.tsx:973-974` row | reader | IN-PLAN (6.5) |
| `routes/public/FlyerPage.tsx:265-267`, `publicApi.ts:35` (derived) | reader | IN-PLAN (6.6) |
| `routes/listings/AuthoritySummary.tsx:116` | comment | NOT-IN-PLAN (comment only, harmless) |
| `e2e/scenarios/steps.ts:1683` (form fill), `:1717` (API PATCH) | writer | IN-PLAN (S7 7.2) |
| `e2e/scenarios/steps.ts:1736-1737,1744-1760` | reader | IN-PLAN (S7 7.2) |
| `e2e/tests/dashboard-next/broadcasts.spec.ts:311`, `properties-available-view.spec.ts:65`, `public-pages.spec.ts:375` numeric API writes | writer | IN-PLAN (S7 list, AR43; still valid writes) |

(a') The 15 requirement keys, `subzone`, `washer_dryer` - dashboard and e2e

| Surface | Kind | Status |
|---|---|---|
| `ListingEditForm.tsx` (pets, deposit, application_fee, tour_type, tour_process) | writer | IN-PLAN (5.8) |
| `UnitCreateForm.tsx` (same keys on create) | writer | IN-PLAN (5.9) |
| `ContactEditForm` req_ keys / Apply dialog | writer | IN-PLAN (6.9 / 6.11) |
| `ListingDetail.tsx:962-968` Deposit, Pets, Application fee rows; `:1025-1028` tour rows | reader | IN-PLAN (6.5) |
| `FlyerPage.tsx:54-55` subzone neighborhood, `:231,298-307`; `publicApi.ts:34` | reader | IN-PLAN (6.6) |
| `TourDetail.tsx:716`, `ScheduleTourForm.tsx:247-292`, `contact/Card.tsx:221` | reader | IN-PLAN (3.1 WATCH, semantics unchanged) |
| `contact/ContactEditForm.tsx:404`, `EligibilityIntakeCard.tsx:75` | reader | n/a - the TENANT contact's `pets`, not a unit key (3.1 WATCH row 3) |
| `e2e/tests/dashboard-next/public-pages.spec.ts:114-115` deposit / pets API writes | writer | IN-PLAN (AR43 no edit; still valid) |
| `e2e/scenarios/steps.ts:907` `getByLabel('Pets')` | selector | tenant contact form, not the property form; S7 sweep |

(b) `AudienceFilter.bedroomSize` / `bedroomSizes` - dashboard and e2e

| Surface | Kind | Status |
|---|---|---|
| `api/types.ts:3266-3281` | type | IN-PLAN (4.5) |
| `api/endpoints.ts:1984` doc | comment | IN-PLAN (4.5) |
| `AudienceFilters.tsx:133-148` pickSize / setAuthorities, `:175` pressed | writer + reader | IN-PLAN (4.6) |
| `BroadcastComposer.tsx:213-225` filter memo, `:296-309` onFilterChange | writer | IN-PLAN (4.6) |
| `useComposerDraft.ts:107-108` draft key; `:217` sends `input.filter` unchanged | reader / pass-through | IN-PLAN (4.6) |
| `broadcastFormat.ts:68` audienceSummary | reader | IN-PLAN (4.5) |
| `BroadcastsList.tsx:48`, `BroadcastResults.tsx:209` (via audienceSummary) | reader | IN-PLAN (4.5, tests only) |
| e2e API POSTs with legacy `bedroomSize: 2`: `a2p-compliance.spec.ts:530`, `broadcasts.spec.ts:152,359`, `landlord-activity.spec.ts:85`, `listing-activity.spec.ts:105,186`, `send-outcome-cards.spec.ts:117` | writer | IN-PLAN (S4 note to S7: legacy-body coverage, no repair needed) |
| e2e `broadcasts.spec.ts:320` old note copy | reader | IN-PLAN (S4 note to S7) |
| no other dashboard reader or writer (grep `bedroomSize\|AudienceFilter` over `dashboard/src`) | - | confirmed |

(c) Dashboard mutating API calls

| Surface | Status |
|---|---|
| new `applyLandlordRequirements` (POST, signal optional) | IN-PLAN (5.1 catalog entry, pin 121 -> 122) |
| `createUnit` typed `CreateUnitBody` (same fingerprint) | IN-PLAN (5.9) |
| `updateUnit` / `updateContact` new body keys (same fingerprints) | IN-PLAN (no catalog change) |
| S6 `getUnits` / `getAllUnits` `landlordId` (GET) | not a mutation |
