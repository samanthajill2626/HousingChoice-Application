# U1 (S1a) - requirement registry core - Tasks 1.1, 1.2, 1.3

- Unit: U1, slice S1a (plan Tasks 1.1-1.3), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `5a767fed` (main @1d7a4667 + docs).
- Rulings carried: OR-2, OR-6 (worklist), AR5, AR28 (plan section 4).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 1.1 registry: items, kinds, D1 read, equality, deposit conflict, landlord PATCH parser | SHIPPED as written | `app/src/lib/requirements.ts` (new), `app/test/requirements.test.ts` (new) |
| 1.2 sources read, own value, create snapshot, classification | SHIPPED as written | `app/src/lib/requirements.ts` (append), `app/test/requirementSources.test.ts` (new) |
| 1.3 `planUnitApply` | SHIPPED as written | `app/src/lib/requirements.ts` (append), `app/test/requirementsApply.test.ts` (new) |
| Mutant follow-up (M3) | ADDED one test case | `app/test/requirements.test.ts:270-275` |

Plan fidelity, checked mechanically: the plan's three Step 3 code blocks
(plan lines 1590-1880, 2305-2410, 2725-2802) concatenated are byte-identical
to `app/src/lib/requirements.ts`; `requirementSources.test.ts` and
`requirementsApply.test.ts` are byte-identical to plan lines 1931-2287 and
2463-2709; `requirements.test.ts` equals plan lines 1161-1573 plus the 7-line
M3 follow-up only.

## Commits

| Hash | Subject |
|---|---|
| `d49384c4` | feat(requirements): the requirement registry - eight items, kinds, the D1 read, equality |
| `a0b629ee` | feat(requirements): where each value came from - sources read, own value, snapshot, classification |
| `f8b086e4` | feat(requirements): planUnitApply - the per-unit Apply decision |
| `23040ea7` | test(requirements): itemValuesEqual is symmetric - a key missing on either side is blank |
| (this file) | docs(records): ... U1 S1a report |

## RED runs (each red for the stated reason)

- 1.1: `test/requirements.test.ts` - the suite failed to load, "Cannot find
  module '../src/lib/requirements.js'" (0 tests ran). DynamoDB Local was
  reachable (globalSetup created the tables).
- 1.2: `test/requirementSources.test.ts` - 30/30 failed, all "is not a
  function": `nextRequirementSources` 17, `parseRequirementsSnapshot` 6,
  `readRequirementSources` 4, `isOwnValue` 3.
- 1.3: `test/requirementsApply.test.ts` - 19/19 failed, "planUnitApply is
  not a function" (the throw case received that TypeError text instead of
  the expected message).
- Not separately run: the TS2307 / TS2305 typecheck RED that the plan
  describes alongside each vitest RED; the vitest RED already showed each
  stated reason.

## GREEN runs

| When | Command scope | Result |
|---|---|---|
| 1.1 | `test/requirements.test.ts` | 36/36 passed |
| 1.1 | `npm run typecheck -w @housingchoice/app` | exit 0 |
| 1.1 | `npx eslint app/src/lib/requirements.ts app/test/requirements.test.ts` | exit 0 |
| 1.2 | `test/requirementSources.test.ts test/requirements.test.ts` | 66/66 (30 + 36) |
| 1.2 | app typecheck / eslint (module + `requirementSources.test.ts`) | exit 0 / exit 0 |
| 1.3 | `test/requirementsApply.test.ts test/requirementSources.test.ts test/requirements.test.ts` | 85/85 (19 + 30 + 36) |
| 1.3 | app typecheck / eslint (module + `requirementsApply.test.ts`) | exit 0 / exit 0 |
| Unit end | root `npm run typecheck` (app, dashboard, e2e, fake-twilio, fake-twilio-web) | exit 0 |
| Unit end | `npx eslint` on the module + all three test files | exit 0 |
| After M3 follow-up | the three suites | 86/86 (19 + 30 + 37) |
| AR28 / OR-6 proof | `tsc` on `requirements.ts` alone, `lib: ["ES2022"]`, `types: []`, strict + noUncheckedIndexedAccess (throwaway tsconfig in the session scratchpad, not committed) | exit 0; the program held only `toursModel.ts` and `requirements.ts` |

ASCII: all four files are new and print 0 on the `tr` check (the follow-up's
added lines also print 0). No literal backslash-u anywhere; the `\n` and `\'`
escapes in `requirements.test.ts:166,168,328` landed literally.

## Mutant table

Line numbers are in `app/src/lib/requirements.ts` at `f8b086e4` (unchanged
since). Each mutant was applied and reverted with the Edit tool. Afterwards
`git diff --exit-code HEAD -- app/src/lib/requirements.ts` was clean and
`git status --short` showed only the follow-up test, since committed as
`23040ea7`.

| # | Mutant | Line | Test run | Result | Follow-up |
|---|---|---|---|---|---|
| M1 | legacy pets read flipped (`false` -> No pets unchecked) | :191 | `requirements.test.ts` | KILLED (5 of 36 failed) | - |
| M2 | money read `>= 0` -> `> 0` (a stored 0 reads blank) | :174 | `requirements.test.ts` | KILLED (1 of 36) | - |
| M3 | `itemValuesEqual` iterates only the first value's keys | :211 | all three suites | SURVIVED (85/85) | Real gap, see below. New case fails on the mutant (1 of 37 failed, "expected true to be false") and passes on real code (37/37); committed `23040ea7` |
| M4 | `hasDepositConflict` side prefix swapped | :286 | `requirements.test.ts` | KILLED (2 of 37) | - |
| M5 | binding AR3 copy drift: `true, false or null` -> `true, false, or null` | :234 | `requirements.test.ts` | KILLED (2 of 37) | - |
| M6 | snapshot accepts `landlordId: ''` (the OR-2 behavior removed) | :346 | `requirementSources.test.ts` | KILLED (1 of 30) | - |
| M7 | snapshot-named items no longer all classified (`!changed && fromSnapshot === undefined` -> `!changed`) | :392 | `requirementSources.test.ts` | KILLED (5 of 30) | - |
| M8 | `isOwnValue` loses its `copied` guard | :321 | `requirementSources.test.ts` + `requirementsApply.test.ts` | KILLED (7 of 49) | - |
| M9 | `planUnitApply` ignores `ownItems` (own values always block) | :459 | `requirementsApply.test.ts` | KILLED (3 of 19) | - |
| M10 | `storedValueChanges` counts a REMOVE of an absent key | :413 | `requirementsApply.test.ts` | KILLED (3 of 19) | - |

M3 is a real gap because D1 equality treats a key missing on EITHER side as
blank, but every registry reader returns every key of the item, so no S1a
case ever passed values with different key sets. With the mutant,
`itemValuesEqual({}, { pets: 'Cats OK' })` returned true (asymmetric). Today's
callers pass whole item values. The S3 Apply route, though, compares
`landlordItemValue(...)` against the wire-supplied `expected` (plan 2.4) and
relies on its own key-coverage 400 to make the key sets match. The new case
pins the symmetry both ways round.

Candidates considered and NOT run, because they are equivalent on every
reachable input (recorded so nobody re-derives them):
- `planUnitApply`'s `requirement_sources: null` branch (`:475`) is
  unreachable: a write always has at least one changing item, which it
  marks `copied`. It is defensive, as plan 2.1 states ("null when empty").
- `parseRequirementsSnapshot` short-circuits an `undefined` field value
  (`:360`) before `normalizeRequirementValue`. Removing that short-circuit is
  equivalent, because every kind already turns `undefined` into a failure,
  which reads as null.
- `canonical(...)` on `planUnitApply`'s target values (`:469`) is
  idempotent for `landlordItemValue` output, which is the route's contract
  for `landlordValues`.

## Divergences from the plan text

- None in code: the module and the three suites are the plan's text (see
  "Plan fidelity" above).
- Added one test case for M3. It is a new `it` inside the
  `itemValuesEqual / isItemBlank - D1 equality` describe
  (`app/test/requirements.test.ts:270-275`).
- Line-hint drift only (R1-F7 class): the comment in
  `app/test/requirementsApply.test.ts:192` (verbatim from the plan) cites
  `app/src/lib/seed/lean.ts:224-226` for unit A's `deposit` / `pets` /
  `tour_process`; in the tree they are at `lean.ts:228-230`. The fact itself
  holds and the comment was left as the plan wrote it.

## Rulings applied

- OR-2: `parseRequirementsSnapshot` answers `requirements_snapshot must be
  an object with a landlordId` for `landlordId: ''` (`requirements.ts:346`).
  This is the recorded interpretation of plan 2.4. It is pinned by the
  shape-refusal case (`requirementSources.test.ts:108`), and M6 shows the pin
  works.
- OR-6: no post-ES2022 API in the module (no `toSorted`, `toReversed`,
  `toSpliced`, `.with()`, `findLast(Index)`, `groupBy`). This is proven by
  the lib-ES2022 compile above. `Object.hasOwn` (ES2022), `flatMap`, `Map`,
  `Set` and `Object.freeze` are all inside ES2022.
- AR28: the only import is `./toursModel.js` (`requirements.ts:18`), and
  `toursModel.ts` imports nothing. No Node global is used: the compile with
  `types: []` loaded no `@types/node`.
- AR5: `planUnitApply` throws `planUnitApply: no landlord value for item
  <id>` (`requirements.ts:451`), pinned by the last case in
  `requirementsApply.test.ts`.

## CONTRACT (what U2-U13 import from `app/src/lib/requirements.ts`)

Types (line numbers in the module):
- `:20` `type RequirementItemId = 'evictions' | 'credit_requirements' | 'income_requirements' | 'qualifications' | 'pets' | 'deposit' | 'application_fee' | 'touring'`
- `:29` `type RequirementGroup = 'Screening' | 'Pets' | 'Move-in costs' | 'Touring'`
- `:30` `type RequirementFieldKind = 'checkbox' | 'text' | 'long_text' | 'money' | 'tour_type'`
- `:31` `type FlyerVisibility = 'on_flyer' | 'staff_only'`
- `:33` `interface RequirementField { key: string; landlordKey: string; label: string; kind: RequirementFieldKind; flyer: FlyerVisibility }`
- `:44` `interface RequirementItem { id: RequirementItemId; label: string; group: RequirementGroup; fields: readonly RequirementField[] }`
- `:150` `type ItemValue = Record<string, string | number | true | null>` (keys are UNIT keys; null = blank)
- `:295` `type RequirementSource = 'copied' | 'set_here'`
- `:296` `type RequirementSources = Partial<Record<RequirementItemId, RequirementSource>>`
- `:326` `interface RequirementsSnapshot { landlordId: string; items: Partial<Record<RequirementItemId, ItemValue>> }`
- `:402` `type ApplySkipReason = 'not_found' | 'deleted' | 'landlord_changed' | 'changed_since_opened' | 'already_matches' | 'changed_during_apply'`

Constants:
- `:70` `REQUIREMENT_ITEMS: readonly RequirementItem[]`. The eight items in
  D1 display order, frozen at every level (array, item, `fields` array, field).
- `:108` `REQUIREMENT_ITEM_IDS: readonly RequirementItemId[]` (frozen, 8).
- `:112` `REQUIREMENT_UNIT_KEYS: readonly string[]` (frozen, 15, item order
  then field order).
- `:116` `REQUIREMENT_LANDLORD_KEYS: readonly string[]` (frozen, 15,
  `req_` + unit key, same order).
- `:121` `WASHER_DRYER_VALUES: readonly ['hookups', 'included', 'none']` (frozen).
- `:123` `VOUCHER_SIZE_MAX: 12`.

Functions:
- `:132` `isRequirementItemId(v: unknown): v is RequirementItemId`
- `:137` `itemOfUnitKey(key: string): RequirementItem | undefined`
- `:185` `unitItemValue(unit: Record<string, unknown>, id: RequirementItemId): ItemValue`
- `:202` `landlordItemValue(contact: Record<string, unknown>, id: RequirementItemId): ItemValue`
- `:210` `itemValuesEqual(a: ItemValue, b: ItemValue): boolean`
- `:218` `isItemBlank(v: ItemValue): boolean`
- `:226` `normalizeRequirementValue(field: RequirementField, value: unknown, keyForError: string): { ok: true; value: string | number | true | null } | { ok: false; error: string }`
- `:263` `parseLandlordRequirementPatch(body: Record<string, unknown>): { ok: true; fields: Record<string, string | number | true | null> } | { ok: false; error: string }`
- `:285` `hasDepositConflict(record: Record<string, unknown>, side: 'unit' | 'landlord'): boolean`
- `:303` `readRequirementSources(raw: unknown): RequirementSources`
- `:318` `isOwnValue(sources: RequirementSources, id: RequirementItemId, unitValue: ItemValue): boolean`
- `:341` `parseRequirementsSnapshot(raw: unknown): { ok: true; snapshot: RequirementsSnapshot } | { ok: false; error: string }`
- `:380` `nextRequirementSources(input: { before: Record<string, unknown>; after: Record<string, unknown>; current: RequirementSources; landlord: Record<string, unknown> | undefined; snapshot?: RequirementsSnapshot }): RequirementSources`
- `:431` `planUnitApply(input: { unit: Record<string, unknown> | undefined; landlordId: string; items: readonly RequirementItemId[]; landlordValues: Partial<Record<RequirementItemId, ItemValue>>; ownItems: readonly RequirementItemId[] }): { kind: 'skip'; reason: Exclude<ApplySkipReason, 'changed_during_apply'> } | { kind: 'write'; patch: Record<string, unknown>; changedKeys: string[]; changedItems: RequirementItemId[] }`

Not in the module yet: `FormFieldVisibility` and `PROPERTY_FORM_FIELDS`
(plan 2.1). U2 appends them in Task 1.7 (the 35-row list, AR1). Everything
else in plan 2.1 now exists with the plan's signatures.

Error strings the module produces (`<key>` = the `keyForError` argument:
the unit key from the unit validator, the `req_` key from
`parseLandlordRequirementPatch`):
- `<key> must be true, false or null` - checkbox (`:234`)
- `<key> must be a string or null` - text and long_text (`:253`)
- `<key> must be a number` - money (`:239`)
- `<key> must be >= 0` - money (`:241`)
- `<key> must be one of: self_guided, landlord_led, pm_team` - tour_type (`:247`)
- `requirements_snapshot must be an object with a landlordId` (`:332`,
  returned `:344`, `:347`). Returned when the snapshot is not a plain object
  (null, an array or a primitive), or when `landlordId` is not a non-empty
  string (OR-2).
- `requirements_snapshot.<item id> must be an object` (`:355`). Returned
  when a named item is present but not a plain object (null included). An
  `undefined` item is skipped.
- Thrown `Error`: `planUnitApply: no landlord value for item <id>` (`:451`, AR5).
- Thrown `Error`: `requirements: unknown item id <id>` (`:143`). This is an
  internal guard, reachable only when a caller casts a non-id into
  `unitItemValue` / `landlordItemValue`.

Produced ELSEWHERE, not by this module:
- The unit-validator AR3 strings are U2's, in `unitFields.ts`, Task 1.5:
  - `pets must be a string, a boolean or null`
  - `voucher_size_accepted must be an integer 0..12 or a list of them`
  - `subzone must be a string or null`
  - `washer_dryer must be one of: hookups, included, none`
  - `pets: a boolean pets cannot be combined with no_pets`
- `deposit_conflict` is the routes' (S2, S3), built on `hasDepositConflict`.
- `requirements_snapshot.landlordId does not match landlordId` is the S2
  create route's.

## For later units and the orchestrator

- U8 (S5 mirror, OR-12): copy the NEW case `a key missing on either side is
  blank, so equality is symmetric` (`app/test/requirements.test.ts:270-275`)
  into the dashboard mirror suite with the other `itemValuesEqual` cases. It
  is not in Task 5.2's literal text.
- U4 (S2 writes):
  - `nextRequirementSources` returns `{}` (never null) when no item has a
    record. The write path must turn an empty map into a REMOVE (D5).
  - It never mutates `current` and always returns a new object (pinned).
  - Pass `current: {}` after a landlord-change reset.
  - `after` may carry null for a REMOVE (it reads as blank).
  - `parseRequirementsSnapshot(null)` is the shape 400. If S2 wants null to
    mean "no snapshot", it must skip the parser for null (S1 note E).
  - `normalizeRequirementValue` does not accept `undefined`: callers skip
    it, as `parseLandlordRequirementPatch` does.
- U3 / U5 (repo and Apply route):
  - `planUnitApply`'s `patch` writes EVERY key of each changing item: the
    landlord's canonical value, or null = REMOVE. That includes keys whose
    stored value already matches (for example a re-SET `no_pets: true`, or a
    REMOVE of an absent key, which is a no-op in DynamoDB).
  - `changedKeys` lists only the keys whose stored value actually changes.
    That is the audit list, never `requirement_sources`.
  - `patch.requirement_sources` is always a fresh, non-empty map in
    practice. Unknown ids or values in the stored map are dropped on write.
  - `items` is de-duplicated implicitly (registry order, AR15).
  - The `deleted` check mirrors `unitsRepo.isDeleted`
    (`app/src/repos/unitsRepo.ts:532-534`, PR1-8).
  - `planUnitApply` never mutates the unit it is given (pinned). AR6's
    `structuredClone` is still the route's job, for the repo write.
- `hasDepositConflict`: a fixed amount of 0 is still an amount (a conflict);
  null or absent is not. `isItemBlank(unitItemValue({ pets: false }, 'pets'))`
  is false: a legacy false reads as No pets checked.
- Facts re-verified in the tree (AR48), all holding:
  - `app/src/lib/toursModel.ts` has no import and exports `isTourType`
    (`:125-127`).
  - `unitsRepo.isDeleted` is at `:532-534`.
  - `Object.hasOwn` precedent at `app/src/routes/contactTimeline.ts:516`.
  - The lean unit A values exist (at `lean.ts:228-230`, see "Divergences").
  - No `AWS_*` variable is exported in this environment.
