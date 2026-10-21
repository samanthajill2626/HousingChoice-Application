# U4 (S2b) - write planner, POST, PATCH fence, Activity reason - Tasks 2.3, 2.4, 2.5, 2.6

- Unit: U4, slice S2b (plan Tasks 2.3-2.6), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `f4ec3095` (U3's report commit).
- Rulings carried: AR6 (each fenced attempt passes its own `structuredClone`
  of the read), AR8 as superseded by PR1-10 (fenced-path audit = keys whose
  STORED value changes; plain path keeps `Object.keys(validation.fields)`),
  PR1-10a (empty fenced list: write, no row), PR2-2 (the asymmetry stands),
  AR9 (classification target), AR10 (refusal orders), AR11 (no extra fence),
  AR12 (`unitRequirementWrite.ts` S2-private), OR-1 (import split), and the
  brief's CCF convention (`err instanceof ConditionalCheckFailedException`).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 2.3 The pure write planner | SHIPPED as written | `app/src/lib/unitRequirementWrite.ts` (new), `app/test/unitRequirementWrite.test.ts` (new) |
| 2.4 POST /api/units: snapshot, classification, deposit_conflict | SHIPPED; Step 3a per OR-1 (three names) | `app/src/routes/units.ts`, `app/test/unitsApiRequirementsCreate.test.ts` (new) |
| 2.5 PATCH /api/units/:id: the fenced requirement write | SHIPPED; Step 3a adds `touchesRequirements` per OR-1 | `app/src/routes/units.ts`, `app/test/unitsApiRequirementsPatch.test.ts` (new) |
| 2.6 Activity: lift `reason` for `unit_updated` / `requirements_applied` only | SHIPPED as written | `app/src/routes/units.ts`, `app/test/unitsApiActivity.test.ts` |
| Mutant follow-up (M10, AR9) | ADDED two cases | `app/test/unitsApiRequirementsPatch.test.ts:28-32,201-215` |

Plan fidelity, checked mechanically (a throwaway script in the session
scratchpad counts each plan replacement block, by line range, in the edited
file): the four new files were extracted from the plan by line range (plan
6606-6998, 7010-7200, 7244-7408, 7598-7954) and are byte-identical to it
(the PATCH suite then gained the follow-up cases). In `units.ts` every
replacement block occurs exactly once: 2.4 3b/3c/3d (plan 7460-7486,
7500-7503, 7521-7542), the final import block (plan 7434-7440, i.e. 2.4's
block once 2.5 added `touchesRequirements`), 2.5 3a-3f (7992-7997,
8015-8028, 8041-8119, 8158-8168, 8189-8232, 8252-8271), 2.6 3a/3b
(8420-8427, 8444-8454); `unitsApiActivity.test.ts` holds 2.6 Step 1
(8333-8392) once, at the file end. Every quoted anchor matched by its text
exactly once; the line hints had drifted (U2/U3 grew the files, and 2.4
shifted 2.5's), e.g. the `clearedLandlordHeir` tail was at `:737` (hint
`:716-717`). No anchor region had been changed by an earlier task (AR47: no
on-top application needed).

## Commits

| Hash | Subject |
|---|---|
| `32fb1af4` | feat(units): the pure requirement write planner for unit create and PATCH |
| `a1a9e640` | feat(units): unit create records where each requirement value came from |
| `361a2f08` | feat(units): PATCH keeps requirement_sources behind a fenced, retried write |
| `4d5a969d` | feat(units): property Activity serves the requirements_applied reason |
| `dae28864` | test(units): a routing-pointer landlord of record classifies as no landlord - phone and email pointer cases |
| (this file) | docs(records): ... U4 S2b report |

## RED runs (each red for the stated reason)

- 2.3: `test/unitRequirementWrite.test.ts` - the suite failed to load,
  `Failed to load url ../src/lib/unitRequirementWrite.js` (no test ran;
  DynamoDB Local answered: globalSetup created the tables).
- 2.4: `test/unitsApiRequirementsCreate.test.ts` - 13 failed / 2 passed (the
  two PINs). The four snapshot 201 cases got 400; the six snapshot 400 cases
  got `unknown field: requirements_snapshot`; "only the items the body
  writes" got 201 with no `requirement_sources`; the two `deposit_conflict`
  cases got 201 and 404 - exactly plan Step 2.
- 2.5: `test/unitsApiRequirementsPatch.test.ts` - 19 failed / 4 passed (the
  four PINs). Classification cases: `requirement_sources` undefined (or the
  stale `{ pets: 'set_here' }` for the change-plus-item case); both legacy
  partner cases failed `toMatchObject`; the raw `pets: true` case got
  `['no_pets', 'pets']`; the every-key-unchanged case saw the fence spy
  called 0 times; `deposit_conflict` got 200; the landlord change kept the
  map; the consistent-read case saw no consistent `getById`; the five fence
  cases saw `calls` 0, 200 instead of 409 / 404, and `landlordId` not
  `c-new` - exactly plan Step 2.
- 2.6: `test/unitsApiActivity.test.ts` - 1 failed / 16 passed: the served
  event lacked `reason`; both new PINs and the 14 existing cases green.

## GREEN runs

| When | Command scope | Result |
|---|---|---|
| 2.3 | `test/unitRequirementWrite.test.ts` | 34/34 |
| 2.3 | root `npm run typecheck`; eslint (2 files) | exit 0; exit 0 |
| 2.4 | `test/unitsApiRequirementsCreate.test.ts` | 15/15 |
| 2.4 | `test/unitsApi.test.ts test/unitsLandlordOfRecord.test.ts test/unitsApiOrgNames.test.ts test/unitsApiRoster.test.ts test/unitFields.test.ts` | 5 files, 158/158 |
| 2.4 | root typecheck; eslint (`units.ts` + test) | exit 0; exit 0 |
| 2.5 | `test/unitsApiRequirementsPatch.test.ts` | 23/23 |
| 2.5 | `test/units test/listingSendsApi.test.ts test/unitFields.test.ts` | 35 files, 616/616 |
| 2.5 | root typecheck; eslint (`units.ts` + test) | exit 0; exit 0 |
| 2.6 | `test/unitsApiActivity.test.ts` | 17/17 |
| 2.6 | root typecheck; eslint (`units.ts` + test) | exit 0; exit 0 |
| Unit end (after the follow-up) | `test/units test/unitRequirementWrite.test.ts test/primaryHandoffParity.integration.test.ts test/caseworkerRepoParity.integration.test.ts test/listingSend test/tour test/followUps test/unitFields.test.ts test/publicIntake.test.ts test/requirement test/propertyFormFlyerParity.test.ts` | 71 files, 1817/1817, none skipped, 0 `[dynamoAdmin]` lines |
| Unit end | root `npm run typecheck` (app incl. `tsconfig.test.json`, dashboard, e2e, fake-twilio, fake-twilio-web) | exit 0 |
| Unit end | `npx eslint` on the six touched files (`git diff --name-only --diff-filter=d f4ec3095...HEAD`) | exit 0 (baseline for `units.ts` and `unitsApiActivity.test.ts` at `f4ec3095` was also exit 0) |

The brief's named suites in that unit-end run: every `units*` suite (33
files, including `unitsApiRequirementsCreate` 15, `unitsApiRequirementsPatch`
25, `unitsApiRequirementsReset` 5, `unitsApiActivity` 17,
`unitsLandlordOfRecord` 21, `unitsApiRoster` 25, `unitsApi` 31), plus
`unitRequirementWrite` 34, `primaryHandoffParity.integration` 20 (it is
`describe.skipIf` as a whole, so 20 ran = DynamoDB Local used),
`caseworkerRepoParity.integration` 46, `listingSendsApi` 25, the other
`listingSend*` suites (outcome 47, outcome API 45, row projection 3, tour 25,
repo 14 + 6), `followUps` 16 / `followUpsApi` 4, and the 19 `tour*` suites
(`toursApi` 232, `tourReminders` 143, `tourRemindersApi` 69, `toursRepo`
80, ...). Before the follow-up the same run was 71 files, 1815/1815.

ASCII: the four new files print 0 on the `tr` check; the added lines of
`units.ts` (pre-existing em dashes) and `unitsApiActivity.test.ts` print 0
(`git diff -U0 f4ec3095 HEAD`). No literal backslash-u anywhere.

## Mutant table

Ten one-line mutants, applied and reverted with the Edit tool, one at a time
(`git diff -U0` showed only the current mutant before each run). Each run
used the four suites this unit added or extended - `unitRequirementWrite`
34 + `unitsApiRequirementsCreate` 15 + `unitsApiRequirementsPatch` 23 +
`unitsApiActivity` 17 = 89 (baseline 89/89). Line numbers are in the final
tree. Afterwards `git status --short` and `git diff --stat` were empty.

| # | Mutant | file:line | Result (failed of 89) | Follow-up |
|---|---|---|---|---|
| M1 | classification equal/differ: the unchanged-landlord branch never reads the landlord of record (always no landlord, so nothing classifies `copied`) | `units.ts:799` | KILLED (10: back-to-equal, Deposit, raw pets, both legacy partner cases, re-sent key, consistent read, map race, claim race, restore race) | - |
| M2 | snapshot vs no-snapshot: POST never passes the snapshot (`false && ...`) | `units.ts:957` | KILLED (3: the three all-named-item snapshot creates) | - |
| M3 | reset-then-classify: the planner keeps the held map on a landlord change (`current: held`) | `unitRequirementWrite.ts:176` | KILLED (4: planner REMOVE + reset cases, route REMOVE + reset cases) | - |
| M4 | retry count: off-by-one (`attempt < 3`, two attempts) | `units.ts:786` | KILLED (1: three lost races, `calls` 2) | - |
| M5 | 409 `property_changed`: the final re-read answers `not_found` for a live unit | `units.ts:821` | KILLED (1: 404 instead of 409) | - |
| M6 | `deposit_conflict` checks the body alone, not the stored record merged with it | `unitRequirementWrite.ts:78` | KILLED (3: helper, planner, route) | - |
| M7 | audit changed keys: a REMOVE of a never-held key is listed (`value === null` -> true) | `unitRequirementWrite.ts:135` | KILLED (4: helper, planner x2, route raw `pets: true`) | - |
| M8 | PR1-10a: a row is appended for an empty fenced list (`>= 0`) | `units.ts:2417` | KILLED (1: every-key-unchanged) | - |
| M9 | Activity guard: any `unit_updated` reason lifted (`!== undefined` for `=== 'requirements_applied'`) | `units.ts:390` | KILLED (1: the other-reason PIN) | - |
| M10 | AR9: `readLandlordOfRecord` drops its routing-pointer guard | `units.ts:756` | SURVIVED (89/89; also 141/141 with `unitsLandlordOfRecord` + `unitsApi`) | Real gap, see below; committed `dae28864` |

M10 is a real gap, low severity. AR9 binds that, for an unchanged
`landlordId`, a phone or email routing-pointer row counts as no landlord.
With the mutant the pointer row is read as a landlord holding blank values
for every item, so clearing an item on such a unit records `copied` instead
of `set_here`, and the item would then count as a copy, not an own value, in
Apply. Only bad data can name a pointer as the landlord of record (create
and a landlord change go through `requireLandlordContact`, which refuses
pointers). The new cases (`unitsApiRequirementsPatch.test.ts:201-215`, one
phone and one email pointer, real `phoneRefId` / `emailRefId` ids) fail with
M10 (2 of 25, `expected { credit_requirements: 'copied' } to deeply equal
{ credit_requirements: 'set_here' }`) and pass without it (25/25). Each
half-mutant (only the phone check dropped; only the email check dropped)
fails exactly its own case (1 of 25 each).

Considered and NOT run, recorded so nobody re-derives them:
- POST's planner refusal (`units.ts:959-962`) is unreachable:
  `depositConflictAfter(undefined, fields)` (`:898`) answers the same input
  first. It is the plan's defensive branch (equivalent mutant).
- The final re-read's `not_found` arm (`units.ts:821`) is reachable only
  when a unit is HARD-deleted during the third attempt; units are only
  soft-deleted (a soft-deleted unit still reads), so no route reaches it. The
  attempt-1 vanish is pinned ("the unit vanished under the write").
- AR6's `structuredClone(stored)` (`units.ts:789`), past the 10-mutant cap.
  Not run, so no evidence either way; by construction the fake can only lose
  a race through it (the overrides mutate the stored object, which the fake
  compares with the caller's read), so the map-race, three-lost-races and
  claim / restore race cases depend on it.

## Divergences from the plan text

- OR-1 (binding): Task 2.4 Step 3a imported only `depositConflictAfter`,
  `planRequirementWrite`, `splitRequirementsSnapshot`; Task 2.5 Step 3a added
  `touchesRequirements`. Final import block = the plan's 2.4 block
  (`units.ts:25-30`). eslint ran at the end of each task (all exit 0).
- Added two test cases for M10 (`dae28864`) - the only code beyond the plan.
- None otherwise (see "Plan fidelity").

## Rulings applied

- AR6: each attempt clones its own consistent read (`units.ts:787-789`) and
  passes the clone to both `planRequirementWrite` and
  `updateIfRequirementsCurrent` (`:801`, `:804`).
- AR8 / PR1-10: fenced path uses `plan.auditFields` (`changedKeys` of the
  read and the final patch, computed before the map key is added, so the map
  is never listed) when the landlord changes or a requirement key is touched
  (`units.ts:806-812`); a body naming only an unchanged landlordId keeps
  `Object.keys(fields)`; the plain path keeps `Object.keys(validation.fields)`
  (`:2398`). PR1-10a: `units.ts:2417` (empty list -> no row; the fenced write
  still stamped `updated_at`, pinned). PR2-2: the asymmetry is as built.
- AR9: target = the landlord AFTER the write: a change reads the new one
  through `requireLandlordContact` (type-checked, `:795`); an unchanged
  non-empty `landlordId` reads `readLandlordOfRecord` (`:754-758`, consistent,
  any type or state, missing or pointer -> none; never type-checked, L2 pin
  green); an ownerless unit -> none. Pointer half pinned by `dae28864`.
- AR10: the orders as built are in the CONTRACT below.
- AR11: no extra fence; the condition is U3's landlordId + map only.
- AR12: `unitRequirementWrite.ts` is imported only by `units.ts`.
- CCF convention: `units.ts:815` (`instanceof`), no helper added.

## CONTRACT (what later units rely on)

### `app/src/lib/unitRequirementWrite.ts` (NEW, S2-private, AR12)

Imports only `node:util` (`isDeepStrictEqual`) and `./requirements.js`. Exports:
- `touchesRequirements(fields: Record<string, unknown>): boolean` (`:54`) -
  some key of `fields` is one of the 15 `REQUIREMENT_UNIT_KEYS` (a null
  REMOVE counts).
- `applyUnitPatch(record: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown>` (`:59`) -
  a copy with the patch applied as the repos apply one (null deletes,
  undefined skipped); mutates neither input.
- `depositConflictAfter(stored: Record<string, unknown> | undefined, fields: Record<string, unknown>): boolean` (`:73`) -
  false unless `fields` carries a Deposit key; then `hasDepositConflict` of
  the stored record (or `{}` on create) merged with `fields`, unit side.
- `splitRequirementsSnapshot(body: unknown): { ok: true; body: unknown; snapshot?: RequirementsSnapshot } | { ok: false; error: string }` (`:87`) -
  a non-object body, or one without the key, passes through as the SAME
  reference; otherwise the key comes off (`body` is the rest) and is parsed
  by `parseRequirementsSnapshot` (a `null` snapshot is the shape 400, U1's
  note E).
- `changedKeys(before: Record<string, unknown>, patch: Record<string, unknown>): string[]` (`:131`) -
  patch order; `requirement_sources` and undefined never listed; a null
  listed only when `before` owns the key; a value listed when `before` lacks
  the key or holds a value not `isDeepStrictEqual` to it.
- `interface RequirementWriteInput` (`:141`): `stored` (the caller's copy of
  the consistent read; undefined on create), `fields` (validator output),
  `landlord` (the landlord of record AFTER the write; undefined = none),
  `landlordChanged`, `snapshot?`.
- `type RequirementWritePlan` (`:154`): `{ ok: true; patch; auditFields; sources }`
  or `{ ok: false; error: 'deposit_conflict' }`.
- `planRequirementWrite(input: RequirementWriteInput): RequirementWritePlan` (`:166`) -
  order: `deposit_conflict`; patch = fields + the legacy pets partner;
  `auditFields = changedKeys(stored, patch)`; `sources =
  nextRequirementSources` with `current = {}` after a landlord change, else
  the held map read defensively; the map key goes in the patch: on create
  only when non-empty; on a landlord change the new map, or null when it is
  empty and the read held one (absent when the read held none); otherwise
  only when it differs from the held map (null when it empties). `sources`
  is the whole map after the write.
- Legacy pets partner (private, `:105-118`): only when the STORED `pets` is a
  boolean and the body writes a Pets key, only keys the body leaves out, only
  ones whose stored value changes: stored false -> `no_pets: true` (unless
  already true) and `pets: null`; stored true -> `pets: 'Allowed'`, and
  `no_pets: null` only when the read holds `no_pets`.

### POST /api/units as built (`units.ts:875-977`)

Refusal order (AR10): 400 snapshot parse (`:880-884`:
`requirements_snapshot must be an object with a landlordId`,
`requirements_snapshot.<item id> must be an object`) -> 400 validator
(`:885-889`) -> 400 `requirements_snapshot.landlordId does not match landlordId`
(`:892-895`) -> 400 `{ error: 'deposit_conflict' }` (`:898-901`) -> 422 org
list (`:908-921`) -> 404 `landlord_not_found` / 409 `landlord_not_landlord`
(`requireLandlordContact`, `:930`, its contact now kept as the
classification target) -> create. The snapshot is never stored. 201
`{ unit }` carries `requirement_sources` when any item was classified: with
the New form's full snapshot every named item gets a record; without one,
only items written non-blank, against the landlord just read; absent when
none. `unit_created` audit unchanged (no field list).

### PATCH /api/units/:unitId as built (`units.ts:2257-2428`)

Refusal order (AR10): 400 validator (`:2259-2263`) -> tombstone no-op 200 /
404 (`:2272-2281`) -> org list: 404 `unit_not_found` on its pre-read / 422
(`:2294-2320`) -> then, on the FENCED path (`:2330`: the body touches a
requirement key OR names any string `landlordId`, unchanged included),
`writeFencedPatch` (`:781-822`), per attempt (at most
`REQUIREMENTS_WRITE_MAX_ATTEMPTS = 3`, `:556`): consistent unit read (404
`unit_not_found` when absent) -> landlord: a CHANGED id `''` is 404
`landlord_not_found` with no read, else `requireLandlordContact` (404 / 409);
an unchanged id reads `readLandlordOfRecord` -> 400
`{ error: 'deposit_conflict' }` (against this attempt's read) -> the fenced
write; a `ConditionalCheckFailedException` re-reads and recomputes; after
three lost writes a final consistent read answers 404 `unit_not_found` (gone)
or 409 `{ error: 'property_changed' }`. Every other body: the plain
`units.update` (CCF -> 404), unchanged. Outcome type `FencedPatchOutcome`
(`:549-553`). Logs (ids / counts only): info `unit patch: requirements fence
held on a retry` `{ unitId, attempts }`; info `unit patch refused: a
one-month deposit and a fixed amount`; warn `unit patch refused: the
property changed under every attempt` `{ unitId, actor, attempts: 3 }`.
Responses carry the stored `requirement_sources` (absent after a landlord
change until an item is next written).

Audit `unit_updated.fields` (D13, PR1-10, PR1-10a): fenced path with a
landlord change or a touched requirement key -> the keys whose STORED value
the write changed, body order then partner order, never
`requirement_sources`; fenced path with only an unchanged `landlordId`
re-sent beside other fields -> `Object.keys(fields)`; plain path ->
`Object.keys(validation.fields)`. A row is appended only when the list is
non-empty (`:2417`); an empty fenced list still wrote and stamped
`updated_at`.

### Activity projection (`toUnitActivityEvent`, `units.ts:353-394`, the guard `:382-392`; wire doc `:342-349`)

`reason` is served when it is a string AND the event is
`unit_primary_contact_assigned`, OR the event is `unit_updated` and the
reason is exactly `requirements_applied`. Every other `unit_updated` reason,
`listing_status_changed`'s free text, and `requirements_applied` on any other
event stay off the wire. The Apply payload's `landlordId` is never served.

## For later units and the orchestrator

- U5 (S3 Apply route): write `unit_updated` `{ actor, fields, reason:
  'requirements_applied', landlordId }`; the Activity already serves
  `reason` (pinned) and never `landlordId`. `changedKeys` here implements
  the same "stored value changes" rule as `planUnitApply.changedKeys` if a
  second caller wants it (the latter stays binding for Apply). Pass a
  `structuredClone` of each read (AR6). Seeds write `requirement_sources`
  directly (the API refuses it: `unknown field: requirement_sources`, PIN).
- U10 (S5 forms): send `requirements_snapshot.landlordId` equal to the
  body's `landlordId`; omit the snapshot when the landlord failed to load.
  Create and PATCH answer 400 `{ error: 'deposit_conflict' }`; PATCH answers
  409 `{ error: 'property_changed' }`; sending `deposit: null` with
  `deposit_one_month: true` is the clearing save.
- U11 (S6): a fenced save that changes no stored value shows no Activity
  line; an Apply row carries `reason: 'requirements_applied'`.
- Cost, by the plan's design (no change made): every PATCH naming a
  `landlordId`, even the stored one, takes the fenced path - one consistent
  unit read and one consistent contact read per attempt. On a body that
  touches no requirement key the contact read classifies nothing.
- A PATCH whose unchanged landlord of record is a non-landlord contact (L2)
  or a soft-deleted one is classified against that record's `req_` values
  (AR9; a re-typed landlord keeps its keys, R2-F6).
- Facts re-verified in the tree (AR48), all holding: the harness wires
  `world.unitsRepo` / `world.contactsRepo` into the units router by reference
  (`twilioWebhookHarness.ts:5667,5672`), so `vi.spyOn` and reassigned methods
  reach the route; `requireLandlordContact` returns the contact and refuses
  pointers (`contactTypeGuards.ts:83`); `LandlordNotFoundError` maps to 404
  (`sendContactTypeError`, `:99`); `ContactItem` and `UnitItem` were already imported in
  `units.ts`. No `AWS_*` variable is exported here; DynamoDB Local answered
  throughout.
- Not run, per the brief: the full `npm test`, any e2e.
