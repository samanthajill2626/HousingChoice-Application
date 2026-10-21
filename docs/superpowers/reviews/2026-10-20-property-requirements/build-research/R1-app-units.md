# R1 - build research: app units (S1 + S2)

- Reader: R1 (read-only live-tree drift check, charter
  `.superpowers/sdd/research/CHARTER.md`).
- Slices: S1 App foundations (Tasks 1.1-1.7, plan lines 914-5134) and S2 App
  property writes (Tasks 2.1-2.6, plan lines 5135-8557). Sections 0-4 (plan
  lines 1-913) read in full. Cross-slice greps into S3 (8558-10626), S5
  (13566-20018, Task 5.2 at 14371-15250) and S7 (Task 7.4 mutants, ~26019).
- Tree: `b0b07a5a080b5303b74e77d91e02977d503584e0` (main @1d7a4667 + docs).
- Method: every quoted anchor of Tasks 1.4-1.7 and 2.1-2.6 was extracted from
  the plan by line range and counted in the target file with a script
  (EM DASH placeholders substituted). Byte-exact quotes and the kind /
  importer / writer tables are in the reference file
  `.superpowers/sdd/research/R1-app-units-ref.md`.

## Findings

Counts: BLOCKER 0, MAJOR 0, MINOR 7.

R1-F1 - Task 2.4 Step 3a - KIND: OTHER (lint) - SEVERITY: MINOR
- Plan (7435-7444): imports `touchesRequirements` in 2.4 with the hedge "if
  the linter flags it as unused in this commit, import only the other three".
- Tree: `eslint.config.mjs:32-40` makes `@typescript-eslint/no-unused-vars` an
  ERROR (only `^_` names opt out), so the hedge always fires; `tsc` is silent
  (`tsconfig.base.json` has no `noUnusedLocals`), so the 2.4 GREEN step
  (vitest + typecheck only) would not catch it and the commit would carry a
  gate-5 error until 2.5.
- Instruction: in Task 2.4 Step 3a import ONLY `depositConflictAfter`,
  `planRequirementWrite`, `splitRequirementsSnapshot`; add
  `touchesRequirements` in Task 2.5 Step 3a (the plan's own fallback). Run
  `npx eslint app/src/routes/units.ts` at the end of 2.4.

R1-F2 - Task 1.2 (parseRequirementsSnapshot) vs plan 2.4 - KIND: RULING (precision) - SEVERITY: MINOR
- Plan 2.4 (408-410): the shape 400 is for "not an object / no string
  `landlordId`". Task 1.2 code (2358) and its test (2039) also refuse
  `{ landlordId: '' }` with the shape message.
- Effect: an empty-string snapshot landlordId gets
  `requirements_snapshot must be an object with a landlordId` instead of the
  mismatch 400. Both are 400s; create already requires a non-empty
  `landlordId` (`unitFields.ts:226-230`). No test outside S1 asserts the
  other reading.
- Instruction: keep S1's behavior as written (empty string = no landlordId);
  record it in the S1 slice report as the interpretation of 2.4. No code change.

R1-F3 - Task 2.1 Step 3e (harness `fencedRequirementsWrite`) - KIND: CONTRACT (parity edge) - SEVERITY: MINOR
- Plan (5878): the fake refuses `applyRequirements` when `isUnitDeleted(unit)`
  (`typeof deleted_at === 'string' && length > 0`, `unitsRepo.ts:532-534`); the
  real condition (5789) is `(attribute_not_exists(deleted_at) OR deleted_at = '')`.
- They differ only for a stored NON-string `deleted_at` (NULL / number): real
  refuses, fake writes. No repo path stores one (create strips null,
  `unitsRepo.ts:1029-1036`; update REMOVEs null), and PR1-8 explicitly rules
  "the harness repo mirrors it with `isDeleted`".
- Instruction: no change (PR1-8 binds it). Do not add a parity case for a
  non-string stamp.

R1-F4 - Plan 3.1 row "landlordId vs requirement_sources" - KIND: INVARIANT - SEVERITY: MINOR
- Plan names create, PATCH, restoreWithLandlord, the addContact claim and the
  importer fill/replace. Full sweep (reference file section 4) found two more
  CREATE-time landlordId writers not listed: the performance seed
  `buildUnit` (`app/src/lib/seed/performance.ts:582-605`, landlordId + roster)
  and the dev zero-primary fixture (`app/src/routes/dev.ts:1405-1409`,
  ownerless create). Neither writes `requirement_sources` or a requirement
  key, and neither changes an existing unit's landlord.
- Instruction: none for the build; optionally add both as WATCH lines to 3.1
  in the S7 docs pass.

R1-F5 - Plan 3.1 row `washer_dryer` / spec "no importer change" - KIND: INVARIANT - SEVERITY: MINOR
- Tree: `app/src/lib/import/airtableSource.ts:57,155` parses the Airtable
  column `Washer Dryer?` into `washerDryer`, and nothing reads it
  (`upsertUnit`, `app/src/lib/import/apply.ts:1476-1621`, writes no
  washer key). Not a writer today; the plan lists none.
- Instruction: no build change (spec: no importer change). Worth one line in
  the S7 issue-registry update (`unit-onboarding-fields`) so the dropped
  column is a known gap, not a surprise.

R1-F6 - Task 1.5 Step 4 - KIND: COMMAND (hint text) - SEVERITY: MINOR
- Plan (3979-3984): "... plus `publicIntake`, `similarUnits`, `seedData` and
  the three `requirement*` suites". At 1.5 the filter `requirement` matches
  FOUR files (`requirements`, `requirementSources`, `requirementsApply`,
  `requirementItemTypes` from Task 1.4). The command itself is right.
- Instruction: none; expect four `requirement*` files in the run.

R1-F7 - S1 section B / S2 section 2 line hints - KIND: FACT (hints) - SEVERITY: MINOR
- A few cited line numbers are off by 1-5 (e.g. `contactsRepo.ts`
  `income_includes_voucher` is :343 not :344 and the NOTE starts :344;
  `units.ts` create spread is :820-826 not :815-821). Every quoted anchor
  still matches byte-exact exactly once (see Confirmed), so nothing breaks.
- Instruction: none; anchor by the quoted text (plan section 0).

## Confirmed

Anchors (byte-exact, each matched exactly once in the current tree):
- Task 1.4: 7/7 (`unitsRepo.ts` :410, :416, :442 (EM DASH x3), :462 (EM DASH),
  :479; `contactsRepo.ts` :22, :343).
- Task 1.5 tests: T1 :14, T2 :65-111 (47 lines), T3 :298 in `unitFields.test.ts`;
  T4 `voucher_size_accepted).toBe(2);` exactly 4 hits (:162, :169, :392, :399)
  + title :153; T5 :197; T6 :409 in `unitsApi.test.ts`.
- Task 1.5 source: 11/11 in `unitFields.ts` (:10, :24, :56, :64, :79, :86,
  :92, :135, :175, :192, :320). `isTourType` used only at :205 (import :11), so
  Edit 1's removal is safe.
- Task 1.6: 10/10 in `unitFields.test.ts` (:343, :357, :382, :396, :417, :423,
  :440, :443, :469, :483 = last 3 lines), 5/5 in `publicIntake.test.ts` (:311,
  :339, :350, :366, :381), 4/4 in `unitFields.ts` (:243, :255, :260-293,
  :343-371).
- Task 2.1: 6/6 (`unitsRepo.ts` :620, :913, :1016-1020, :1145-1147; harness
  :2867-2868, :2915-2916).
- Task 2.2: 10/10 (`primaryHandoffParity.integration.test.ts` :12, :73, :85,
  :241, :252, :278, :297, :303; `unitsRepo.ts` :1324, :1690) + 3c/3d/3e
  (`unitsRepo.ts` :666, :797; harness :3063, :3295).
- Task 2.4: 4/4 (`units.ts` :24, :770, :802, :820). Task 2.5: 6/6 (`units.ts`
  :89, :525, :716, :2179-2206, :2231-2240, :2249-2257). Task 2.6: 3/3
  (`unitsApiActivity.test.ts` :348 file tail; `units.ts` :331, :369).
- No task in S1/S2 edits a region an earlier task already changed except the
  stated sequential ones (1.5 -> 1.6 in `unitFields.ts` / `unitFields.test.ts`,
  2.4 -> 2.5 in `units.ts`), and those anchors do not overlap.

Facts (S1 section B, S2 section 2): all true against the tree, line hints
aside (F7): validator callers only `units.ts:771`, `:2117`; `toUnitFlyer`
one caller `public.ts:463`; both repos drop null on create / REMOVE null on
update; harness `getById` hands out the live object (:2886-2888) and
`update` mutates in place (:2901-2914); `conditionalCheckFailed` :625-626,
`isDeepStrictEqual` :8, `isDeleted as isUnitDeleted` :123 in scope;
`updateRosterIfCurrent` :956-1017 (landlordId equal / absent, contacts whole
`=`, optional `attribute_exists(deleted_at)`); `ROSTER_WRITE_MAX_ATTEMPTS = 3`
:239; addContact claim :1216 / :1324 / :1328; restore `keepsOld` :1656, patch
:1687-1691, `requireSoftDeleted` :1747; `requireLandlordContact` RETURNS the
contact and refuses routing pointers (`contactTypeGuards.ts:83-93`);
`LandlordNotFoundError` exported (:44-49) and mapped to 404 (:101-120);
`toUnitActivityEvent` lifts `reason` only for `unit_primary_contact_assigned`
(:369-374); responses spread the stored unit (GET :854, contacts add :1834,
restore :2501). Only full `UnitsRepo` implementers: the real repo (:913) and
the harness (:2867); `placementNudges.test.ts:182` is `as unknown as`.

Hunt answers:
- (2) AR28 holds: `app/src/lib/toursModel.ts` has NO import statement (pure,
  "NO I/O", `isTourType` exported :124-126); S1's `requirements.ts` imports only
  `./toursModel.js`; Tasks 1.2/1.3/1.7 append without imports; no Node global
  is used (`Object.hasOwn` is ES2022 and the dashboard `lib` is ES2022,
  `dashboard/tsconfig.json`). Same leaf pattern as the working precedent
  `dashboard/src/routes/contact/caseworkerRoleMirror.test.ts` ->
  `app/src/lib/caseworkers.ts` -> `orgNames.ts`.
- (3) Harness vs real: landlordId / map "exactly as read, absent included"
  match (hasOwnProperty on the read; `isDeepStrictEqual` vs DynamoDB `=`, both
  key-order free; list-of-map `=` is already proven by the roster parity
  suite); empty map REMOVEs on both; both stamp `updated_at`; ALL_NEW (fake
  returns the live object); both throw a real `ConditionalCheckFailedException`.
  Only gap: F3 (ruled by PR1-8).
- (4) CCF detection convention: no helper exists anywhere in `app/src` or
  `app/test` (`isConditionalCheckFailed` etc. absent); the units repo and units
  routes use `err instanceof ConditionalCheckFailedException`
  (`unitsRepo.ts:1330,1435,1594,1608`; `units.ts:1190,1242,2235,2365,2459`);
  the importer alone uses `.name === 'ConditionalCheckFailedException'`
  (`import/apply.ts:758,1401,1613`). S2 (2.5) and S3 (3.2) use `instanceof` -
  correct.
- (5) Cross-slice names: S3 imports `hasDepositConflict`,
  `parseLandlordRequirementPatch`, `REQUIREMENT_ITEMS`,
  `REQUIREMENT_LANDLORD_KEYS`, `isRequirementItemId`, `itemValuesEqual`,
  `landlordItemValue`, `planUnitApply`, `normalizeRequirementValue`,
  `readRequirementSources`, `unitItemValue`, types `ApplySkipReason`,
  `ItemValue`, `RequirementItemId`; calls `units.applyRequirements(read, patch)`
  and catches `instanceof ConditionalCheckFailedException` - all match S1/S2
  task code (names, arity, return types). S3 defines its own seed helpers (does
  not import `requirementsFixtures.ts`). S5 Task 5.2 imports
  `* as app from '../../../../app/src/lib/requirements.js'` and uses only
  exported S1 names. S7 Task 7.4 mutant M1's 2-line anchor equals S1 Task 1.3's
  `planUnitApply` loop body (6-space indent once the list indent is stripped).
  S5's `requirementsSnapshotOf` builds unit-keyed items via
  `landlordItemValue`, which S1's parser reads. S7's e2e expectations of
  `requirement_sources` after create (A/B/C at ~25759-25790) follow S2's rules.
- (6) The 35-row table: Task 1.7 test list (4811-4845), Task 1.7
  implementation (4968-4987 + the registry-derived rows), Task 5.2 mirror
  `FORM_FIELD_LIST` and Task 5.2 test list are IDENTICAL row for row
  (label, keys, flyer; scripted diff, 35 = 35 = 35 = 35).

Existing tests (check 4) - every pin of OLD behavior is updated by a task:
- `unitFields.test.ts:64-112` voucher single number / "only the voucher size is
  clearable" -> 1.5 T2; `:375-401` exact flyer shape incl `subzone` -> 1.6 T2;
  `:403-424` allowlist wall -> 1.6 T3; `:426-441` absent -> 1.6 T4; `:443-448`
  boolean pets passthrough -> 1.6 T5; `:469-472` list cast -> 1.6 T6.
- `unitsApi.test.ts:153-170`, `:382-407` voucher `toBe(2)` -> 1.5 T4;
  `:182-198` create `pets: true` stored `true` -> 1.5 T5.
- `publicIntake.test.ts:311-313` toMatchObject `subzone`, `:320-345` exact
  keys, `:355-371` secrets wall, `:374-384` voucher -> 1.6 T8-T11.
- PINs that stay green (traced): `unitFields.test.ts:16-62` (money messages
  unchanged), `:114-296`, `:298-329`; `unitsApi.test.ts:172-180`, `:409-430`,
  `:432-495` (tour_type now on the fenced path; asserts properties only);
  `unitsApiActivity.test.ts:82-145` (`fields: ['rent_min', 'deposit']` - both
  keys change from the seed, patch order kept by `changedKeys`);
  `unitsLandlordOfRecord.test.ts:119-198` (empty id -> `LandlordNotFoundError`
  -> 404; not-landlord -> 409; unknown unit -> 404; unchanged id never
  type-checked); `unitsApiRoster.test.ts:476-517`; the Activity reason pins
  `unitsApiActivity.test.ts:293-349`. No app test asserts a whole unit
  response with `toEqual` (only `devZeroPrimaryFixture.test.ts:84`, a
  `{ unitId }` body), so the new `requirement_sources` key breaks none.
- Seed suites never route units through `validateUnitBody`
  (`seedData.test.ts:102-115` checks names only).
- Dashboard tests mock the API (unaffected by S1/S2). e2e pins
  (`e2e/scenarios/steps.ts:1736-1737` voucher `toBe`) are S7 Task 7.2's.

Importers (check 5): `UnitItem` widening (`voucher_size_accepted` ->
`number | number[]`) has no typed reader (only `acceptedVoucherSizes`, which
takes `unknown`, and the untyped seed `cast.ts:1358`); `UnitFlyer` has one
app consumer (`public.ts:463`, spread) and a dashboard hand mirror
(`publicApi.ts:24-34`, S6). `CreateUnitInput = Partial<UnitItem> & ...`
(`unitsRepo.ts:598`) takes the new keys. e2e imports no unit module.

Commands (check 8): every RED/GREEN path exists or is created by its task;
workspace `@housingchoice/app` exists; root `typecheck` runs all workspaces;
`listingSendsApi.test.ts`, `caseworkerRepoParity.integration.test.ts`,
`primaryHandoffParity.integration.test.ts`, `helpers/orgFixtures.ts`
(`quietLogger`), `helpers/authSession.ts`, `helpers/logCapture.ts` exist;
vitest has no include/exclude override, so `*.integration.test.ts` run.
Note: `primaryHandoffParity` is `describe.skipIf(!reachable)` as a whole -
its RED/GREEN in Task 2.2 needs DynamoDB Local up.

Rulings (check 3): S1/S2 task code agrees with 1.0-1.1, 2.1-2.4, AR1-AR12,
AR28, PR1-8, PR1-10, PR1-10a, PR2-2; AR3's nine error strings are produced
verbatim by the S1 code; AR10's create and PATCH refusal orders are what Tasks
2.4 / 2.5 implement. Only F2 is a precision note.

## Invariant sweep

(a) The 15 unit requirement keys

| Surface | Kind | file:line | Status |
|---|---|---|---|
| `validateUnitBody` | writer | `app/src/lib/unitFields.ts:46-117,145-236` | IN-PLAN (1.5) |
| POST /api/units | writer | `app/src/routes/units.ts:769-835` | IN-PLAN (2.4) |
| PATCH /api/units/:id | writer | `app/src/routes/units.ts:2114-2258` | IN-PLAN (2.5) |
| Apply route | writer | new | IN-PLAN (3.2) |
| full seed (cast) | writer | `app/src/lib/seed/cast.ts:480-483,688-690,744-746,1221-1223,1357-1360` | IN-PLAN (3.3) |
| lean / live / matrix seeds | writer | `lean.ts:228-230,251-252`; `live.ts:203-205,225-227,247-249`; `matrix.ts:500-502,555-558,620-622,678-680,720-723,746-748,770-772` (`pets`, `deposit`, `tour_process`, matrix also `tour_type`) | IN-PLAN (WATCH) |
| importer `upsertUnit` | writes none | `app/src/lib/import/apply.ts:1476-1621` | IN-PLAN (WATCH) |
| AI extraction | contact only | `app/src/services/extraction/apply.ts:98-139` | IN-PLAN (WATCH) |
| dev routes, perf seed, scripts | write none | `dev.ts:1318,1405`; `seed/performance.ts:582-605`; `app/scripts/*` | none needed |
| `toUnitFlyer` | reader (on-flyer keys) | `unitFields.ts:343-371` | IN-PLAN (1.6) |
| `interestedModeFor` | reader `tour_type` | `app/src/lib/listingSendOutcome.ts:111-112` | IN-PLAN (WATCH) |
| interested -> tour | reader `tour_type` | `app/src/routes/units.ts:1466-1470` | IN-PLAN (WATCH) |
| share merge fields, tour copy, AI prompt, similar units, exports | read no requirement key | `mergeFields.ts:36-69`; `messages/tourCopy.ts`; `services/extraction/prompt.ts`; `similarUnits.ts` | n/a (verified none) |
| dashboard readers | `TourDetail.tsx:716`, `ScheduleTourForm.tsx:247-251`, `contact/Card.tsx:220-221`, `ListingDetail.tsx`, forms, `FlyerPage.tsx` | IN-PLAN (WATCH / 5.x / 6.x) |

(b) `requirement_sources`

| Surface | Kind | file:line | Status |
|---|---|---|---|
| POST create / PATCH | writer | `units.ts` (2.4, 2.5 via `unitRequirementWrite.ts`) | IN-PLAN |
| Apply | writer | S3 route + `planUnitApply` | IN-PLAN (3.2, 1.3) |
| `restoreWithLandlord`, `addContact` claim | REMOVE | `unitsRepo.ts:1324,1687-1691`; harness :3063, :3294-3295 | IN-PLAN (2.2) |
| harness fenced writes | writer | new (2.1) | IN-PLAN |
| full seed | writer | S3 | IN-PLAN (3.3) |
| importer fill / replace of landlordId | must not write | `apply.ts:1584,1593-1619` | IN-PLAN (WATCH, PR1-9) |
| plain restore, softDelete, roster remove / hand-off, media, authorities rewrite, status transition | never touch | `unitsRepo.ts` (restore, removeContact :1371, handOffPrimaryFrom :1773, assignPrimaryIfCurrent :1601) | n/a (verified) |
| readers | `readRequirementSources` (S1), S2 planner, S3 Apply, S6 card / dialog; never `toUnitFlyer` (1.6 test), never audit `fields` (`changedKeys` excludes it) | IN-PLAN |

(c) unit `landlordId` - every writer

| Writer | file:line | Status |
|---|---|---|
| `unitsRepo.create` via POST | `units.ts:820-826` | IN-PLAN (2.4) |
| `unitsRepo.update` via PATCH (moves into the fence) | `units.ts:2179-2206,2231-2240` | IN-PLAN (2.5) |
| `restoreWithLandlord` (swap / clear) | `unitsRepo.ts:1687-1691` | IN-PLAN (2.2) |
| `addContact` vacant-slot claim | `unitsRepo.ts:1324` | IN-PLAN (2.2) |
| importer fill (`if_not_exists`) / replace (import-owned) | `import/apply.ts:1584,1602-1619` | IN-PLAN (WATCH) |
| seeds (lean / live / matrix / full) PutCommand | `lib/seed/*` | create-time; IN-PLAN (S3 full seed) |
| performance seed `buildUnit` | `seed/performance.ts:582-605` | NOT-IN-PLAN (create-time, no map; F4) |
| dev zero-primary fixture (ownerless) | `routes/dev.ts:1405-1409` | NOT-IN-PLAN (create-time, no map; F4) |
| removeContact / handOffPrimaryFrom / assignPrimaryIfCurrent / caseworker conversion / contact type change | never write landlordId (verified) | n/a |

(d) `voucher_size_accepted`: writers = validator (1.5), forms (5.x), seed
`cast.ts:1358` (WATCH), e2e API setups (S7); readers = `acceptedVoucherSizes`
(`unitFields.ts:336-341`, mirror `listingFormat.ts:103`), `toUnitFlyer`
(1.6), `ListingDetail.tsx:973-974` (6.x), `ListingEditForm.tsx:105,195-206`
and `UnitCreateForm.tsx:219` (5.x), `BroadcastComposer.tsx:205` (4.x),
`unitListFacets.ts:175-196` (WATCH), `steps.ts:1736` (S7 7.2). All IN-PLAN.

(e) `subzone`: writer validator (1.5) + forms (5.x; the forms have no subzone
field today); readers `toUnitFlyer` (dropped, 1.6), `FlyerPage.tsx:54-55` and
`publicApi.ts:34` (6.x), `similarUnits.ts:52-65,126` (WATCH), dashboard
`types.ts:2516`. `washer_dryer`: new; writer validator (1.5) + forms (5.x);
readers `toUnitFlyer` (1.6), FlyerPage / ListingDetail (6.x). Importer source
column parsed but unused (F5).

(f) Raw writes on the units table outside the fence: `unitsRepo.update`
callers are the PATCH plain path (no requirement key, no landlordId after
2.5), `statusTransition.ts:382,521,643` (status / final_rent),
`dev.ts:1318` (accepted_authorities); raw `UpdateCommand` on units only in
the importer (`apply.ts:1593-1619`, no requirement key); `clean-org-names`
writes through `rewriteAcceptedAuthorities`. None can write a requirement
key, the map, or (except the importer, WATCHed) landlordId.
