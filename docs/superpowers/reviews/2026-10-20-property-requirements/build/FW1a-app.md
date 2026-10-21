# FW1a (app) - code review fix wave 1, server side: RA-1 (OR-29), RA-2 (OR-30), RA-3, RA-7, RC-1

- Unit: FW1a, implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `b7fd58b6` (the round-1 review records commit).
- Work list (binding): `code-review/adjudications.md`, the rows marked FW1a.
  Findings and proofs: `code-review/R1-adversarial-app.md` (RA-1, RA-2, RA-3,
  RA-7) and `code-review/R1-conformance.md` (RC-1).
- STOP items: none.

## Per finding

| Finding | Result | Commit |
|---|---|---|
| RC-1 - no DynamoDB Local case of the PATCH landlord change through the fence | SHIPPED (coverage; a PIN by design - the behavior already conformed) | `e5818609` |
| RA-1 via OR-29 - the fence did not cover the item values the write was computed from | FIXED (real repo and harness) | `988f4208` |
| RA-3 - `WRITABLE_FIELDS[key]` was an inherited lookup | FIXED | `8567c4dc` |
| RA-7 - the fenced PATCH read the landlord contact even when nothing is classified | FIXED | `052175df` |
| RA-2 via OR-30 - the landlord PATCH checks were not fenced to its write; the 409 attribution beside it | FIXED (route; ExpectClause on real repo and harness) | `e76fa262` |

### RA-1 / OR-29 - the fence holds every key of each item the write touches

- How: a new exported helper `requirementFenceKeys(patch)`
  (`app/src/repos/unitsRepo.ts:1022`) returns every unit key of each
  requirement item that has a key the patch writes (a SET or a null REMOVE;
  undefined skipped), registry order, from `itemOfUnitKey` /
  `REQUIREMENT_ITEMS` (`app/src/lib/requirements.ts`; new import
  `unitsRepo.ts:35`, no cycle: `requirements.ts` imports only `toursModel.ts`,
  which imports nothing). The real `updateIfRequirementsFenced` adds, after the
  map condition, one clause per fence key (`unitsRepo.ts:1196-1205`):
  `#fenceJ = :fenceJ` with the READ value when `read` owns the key
  (hasOwnProperty, the existing landlordId / map convention), else
  `attribute_not_exists(#fenceJ)`. Both public methods share it, so
  `applyRequirements` is covered too. The harness fake mirrors it with
  `requirementFenceKeys(patch).every((key) => sameAsRead(unit, read, key))`
  (`app/test/helpers/twilioWebhookHarness.ts:2897`; import `:131`) - own
  property presence plus `isDeepStrictEqual`, like its existing fence.
- Unchanged, as ruled: the landlordId / requirement_sources / not-deleted
  conditions, both signatures, every caller. The routes changed in comments
  only (`units.ts:775-777` writeFencedPatch doc, `contactRequirementsApply.ts:196-199`).
- Consequence: a colleague's save of the same item between a PATCH's read and
  its write now fails the condition; the existing retry re-reads and
  recomputes (at most 3 attempts, then 409 property_changed). Apply skips such
  a unit as `changed_during_apply` (existing reason). An edit of a DIFFERENT
  item never refuses the write (pinned).
- Tests:
  - Repo level, `app/test/unitsRepoRequirementsFence.integration.test.ts:255-324`,
    every case on BOTH the harness fake and DynamoDB Local (`parity`):
    a stale write refused, nothing written, for each value type - a string
    (the Pets details), a number (the deposit amount), a legacy boolean pets,
    a checkbox true cleared since, absent (One month's rent checked since),
    and the patch key itself; `applyRequirements` refused over an edit of the
    item it copies (map unchanged); (PIN) an item matched exactly when
    unchanged (legacy false, number, checkbox true, absent keys) lands;
    (PIN) the fence is per item (another item's edit does not refuse).
  - Route level on the harness, the colleague's save racing INSIDE the first
    fenced write (wrapped repo method, the colleague through the real route):
    RA-1a `unitsApiRequirementsPatch.test.ts:394` (the stale pet_fee save
    ends `set_here`, 3 write calls; the later Apply with `ownItems: []`
    skips `changed_since_opened` and 'Dogs OK' is kept); RA-1b `:426` (the
    stale amount over a colleague's One month's rent answers 400
    deposit_conflict after the retry; one-month stored, no amount; a later
    deposit_notes save is 200); RA-1c `requirementsApplyApi.test.ts:520`
    (Apply over an edit with the map unchanged is `changed_during_apply`;
    'Dogs OK' and the set_here record kept; only the colleague's audit row).
  - New fixture `postRequirementsApply` (`app/test/helpers/requirementsFixtures.ts:93`).

### RC-1 - a PATCH landlord change through the fence on DynamoDB Local

- `unitsRepoRequirementsFence.integration.test.ts:326-385`, both halves: the
  real planner's patch for `{ landlordId: 'c-new' }` is exactly
  `{ landlordId: 'c-new', requirement_sources: null }`; it lands (landlordId
  moved, map REMOVEd, other keys kept, updated_at stamped, ALL_NEW equals the
  stored item); a later write from the older read is refused and writes
  nothing. Second case: a landlord change plus an item - reset, then the item
  classified `copied` against the NEW landlord, in one write.
- Committed BEFORE OR-29 on purpose: green on the pre-OR-29 code (34/34) and
  still green after it (the item fence does not disturb the landlord-change
  write).

### RA-3 - only OWN allowlist keys are fields

- How: `const kind = Object.hasOwn(WRITABLE_FIELDS, key) ? WRITABLE_FIELDS[key] : undefined;`
  (`app/src/lib/unitFields.ts:224`). Every Object.prototype name
  (`__proto__`, `constructor`, `toString`, `valueOf`, `hasOwnProperty`, ...)
  is now 400 `unknown field: <key>`, on create and update, wherever it sits
  in the body.
- Audit of the other allowlist lookups this branch added or touched - none
  has the hole, no change: `parseLandlordRequirementPatch`
  (`requirements.ts:269`, Object.hasOwn), `readRequirementSources` (`:307`,
  Object.hasOwn), `parseRequirementsSnapshot` (`:351`, Object.hasOwn; fixed
  registry keys inside an item), `splitRequirementsSnapshot`
  (`unitRequirementWrite.ts:91`, hasOwnProperty), the Apply body parser
  (`contactRequirementsApply.ts:87,93,96,127` - Map / Set lookups, own keys
  only), the contacts `REQUIREMENT_KEYS` / `DEPOSIT_REQUIREMENT_KEYS` Sets
  (`contacts.ts:1087-1088`), `REQUIREMENT_FIELD_BY_KEY` (a Map). A JSON
  body never carries a foreign prototype (JSON.parse defines `__proto__` as
  an own key), so the only vector was the allowlist object.
- Not applied (RA's "optionally"): an Object.hasOwn read of
  `fields['landlordId']` at `units.ts:788` / `:2339` - the validated fields
  can no longer have a foreign prototype, so the plain reads are safe.
- Tests: `unitFields.test.ts:188-212` - every
  `Object.getOwnPropertyNames(Object.prototype)` name (12) refused on update
  and create from a JSON-parsed body, a sanity case that the list holds the
  five names the review named, and an inherited name AFTER a valid field;
  route `unitsApiRequirementsPatch.test.ts:279` (`__proto__` carrying a
  landlordId, and `toString`): 400 `unknown field: <key>`, the unit (map
  included) byte-equal to before, no audit row. New fixture `patchUnitRaw`
  (`requirementsFixtures.ts:76`, sends the JSON text as is).

### RA-7 - a fenced PATCH that classifies nothing reads no contact

- How: `const classifies = touchesRequirements(fields)` once per request
  (`units.ts:793`); the unchanged-landlord branch reads `readLandlordOfRecord`
  only `else if (classifies)` (`:804`). A landlord CHANGE still reads and
  type-checks the new landlord (I3). Skipping is behavior-neutral: with no
  requirement key nothing is classified (no item changes, the map is kept,
  no legacy partner, no deposit check) - the audit list for that body was
  already `Object.keys(fields)` (`:818`, unchanged).
- Test: `unitsApiRequirementsPatch.test.ts:232` - `{ landlordId: <stored>, beds: 3 }`
  with `contactsRepo.getById` rejecting: 200, getById never called, one
  fenced write, map kept.

### RA-2 / OR-30 - the landlord PATCH write is guarded on what its checks read

- ExpectClause gains `boolean` (`app/src/repos/contactsRepo.ts:714`; doc
  `:704-711`, users list `:724-728`). Runtime: both repos already compared
  with `=` / `===` (real: BOOL marshalled; harness:
  `twilioWebhookHarness.ts:2439-2453`, comment updated), so the change is the
  type plus docs; parity case below.
- Route (`app/src/routes/contacts.ts`): `guardAsRead(record, attr)`
  (`:527`) builds a clause holding the stored value exactly as read - its
  string / number / boolean, or null when absent; a value no writer stores
  (a list, a map, a stored NULL) has no clause form and stays unguarded.
  Right after the consistent read (`:1631-1646`, captured before any await,
  like `classificationGuard`): when the body carries any req_ key and no
  `type`, a guard on the stored `type`; when it carries a Deposit key, guards
  on the stored `req_deposit_one_month` and `req_deposit`. They ride the ONE
  `contacts.update` (`:1915-1919`, order: classification, requirement
  guards, staff notes). A lost guard is the existing 409 `contact_changed`
  with the current contact.
- Attribution fix (`:1930-1942`): `staff_notes_stale` was claimed whenever
  a staff-notes guard rode without the classification guard - a lost
  requirement guard would have read as a stale note. Now: stale when the
  staff-notes guard is the ONLY guard, else decided from the fresh
  contact's `staff_notes_updated_at` vs the expected stamp.
- Tests (`app/test/landlordRequirementsPatch.test.ts:247-378`, the
  colleague's PATCH racing inside the first `contacts.update` through the
  real route): RA-2a both directions (`:287` - an amount over a colleague's
  One month's rent; a raw One-month save with no amount over a colleague's
  amount): 409 contact_changed, the colleague's form kept, never both, only
  the colleague audited; RA-2b (`:302`): a req_pets save racing a re-type to
  tenant is 409 contact_changed, no req_ key on the tenant; attribution
  (`:315`): a lost deposit guard beside a CURRENT notes stamp is
  contact_changed, not staff_notes_stale; (PIN) a staff-notes-only conflict
  on a landlord is staff_notes_stale (`:332`); (PIN) a moved stamp beside
  requirement guards that hold is staff_notes_stale (`:344`); the
  unraced save lands and the guards are exactly
  `[type 'landlord', req_deposit_one_month true, req_deposit null]` (`:358`).
  Parity: `caseworkerRepoParity.integration.test.ts:271` - a boolean clause
  matches a stored boolean exactly, never absent, the other boolean or the
  string 'true', on DynamoDB Local and the fake.

## Commits

| Hash | Subject |
|---|---|
| `e5818609` | test(units): a PATCH landlord change through the requirements fence on DynamoDB Local (code review RC-1) |
| `988f4208` | fix(units): the requirements fence also holds every key of each item the write touches, as read (code review RA-1, OR-29) |
| `8567c4dc` | fix(units): the unit field allowlist knows only its OWN keys - no Object.prototype name is a field (code review RA-3) |
| `052175df` | fix(units): a fenced PATCH that classifies nothing reads no landlord contact (code review RA-7) |
| `e76fa262` | fix(contacts): the landlord PATCH write is guarded on the type and Deposit pair its checks read (code review RA-2, OR-30) |
| (this file) | docs(records): property requirements fix wave FW1a (app) report |

## RED runs (each on the unchanged source, red for the stated reason)

- OR-29: fence integration + unit PATCH + Apply suites: 17 failed / 109
  passed (126). The 14 repo-level runs (7 cases x 2 halves, so DynamoDB
  Local ran) `promise resolved ... instead of rejecting`; RA-1a
  `expected { pets: 'copied' } to deeply equal { pets: 'set_here' }`; RA-1b
  `expected 200 to be 400`; RA-1c
  `expected { updated: [ 'u-race' ], skipped: [] } to deeply equal { updated: [], skipped: [...] }`.
  The 4 PIN runs green.
- RC-1: green on the pre-OR-29 code by design (coverage only): 34/34.
- RA-3: `unitFields` + unit PATCH: 15 failed / 95 passed (110) - the 12
  inherited names and the after-a-valid-field case got
  `{ ok: true, ... }` (`__proto__`: `fields: { notes: 'x' }`, the prototype
  set); the two route cases `expected 200 to be 400`. The sanity case green.
- RA-7: `expected 500 to be 200` (the contact read rejected the save).
- OR-30: landlord PATCH + caseworker parity: 5 failed / 76 passed (81) -
  RA-2a x2, RA-2b and the attribution case `expected 200 to be 409`; the
  guard-shape case `expected undefined to deeply equal { expect: [...] }`.
  The two PINs green. The boolean parity case is green at runtime by
  construction; its RED is the type: root `npm run typecheck` exit 2 with
  3 x TS2322 (`Type 'true' / 'false' / 'string | number | boolean | null'
  is not assignable to type 'string | number | null'`,
  `caseworkerRepoParity.integration.test.ts:284,291`).

## GREEN runs

| When | Scope | Result |
|---|---|---|
| Baseline (before any edit) | units*, contact*, landlordRequirementsPatch, requirement*, unitRequirementWrite, primaryHandoffParity, caseworkerRepoParity, suggestion*, seed*, unitFields | 101 files, 1885/1885 |
| RC-1 | fence integration suite | 34/34 (both halves) |
| OR-29 | fence integration + unit PATCH + Apply | 126/126 |
| OR-29 | the baseline scope | 101 files, 1910/1910 |
| RA-3 | unitFields + unit PATCH | 110/110 |
| RA-3 | units*, unitFields, publicIntake, propertyFormFlyerParity, seed*, requirement*, listingSend* | 65 files, 1270/1270 |
| RA-7 | unit PATCH, create, reset, landlord of record, unitsApi | 5 files, 102/102 |
| RA-7 | the baseline scope | 101 files, 1927/1927 |
| OR-30 | landlord PATCH, caseworker parity, staff notes, triage | 4 files, 169/169 |
| OR-30 | the baseline scope + caseworker* | 104 files, 2121/2121 |
| Final (after the mutants) | the baseline scope + caseworker*, publicIntake, propertyFormFlyerParity | 106 files, 2188/2188, none skipped, 0 `[dynamoAdmin]` lines |
| Each commit and final | root `npm run typecheck` | exit 0 |
| Each commit and final | `npx eslint` on the touched files (final: the 14 `git diff --name-only --diff-filter=d b7fd58b6...HEAD -- '*.ts' ...` files) | exit 0 |

Final run per group (files / tests): units* 33 / 556 (incl.
`unitsRepoRequirementsFence.integration` 52, `unitsApiRequirementsPatch` 30,
`unitsApiRequirementsCreate` 15, `unitsApiRequirementsReset` 5); contact* 33 /
605 (incl. `contactStaffNotes` 26, `contactTriage` 62);
`landlordRequirementsPatch` 33; requirement* 5 / 137 (`requirementsApplyApi`
47, `requirements` 37, `requirementSources` 30, `requirementsApply` 19,
`requirementItemTypes` 4); `unitRequirementWrite` 34;
`primaryHandoffParity.integration` 20; caseworker* 4 / 233 (incl.
`caseworkerRepoParity.integration` 48); suggestion* 8 / 157 (`suggestions`
20); seed* 17 / 265 (`seedRequirements` 6); `unitFields` 81; `publicIntake`
58; `propertyFormFlyerParity` 9. The integration suites' DynamoDB Local
halves ran (no skips).

ASCII: every added line of the fix wave prints 0 on the `tr` check
(`git diff -U0 b7fd58b6..HEAD -- app`); no literal backslash-u added.

## Mutant table

Eight mutants, fourteen runs, each applied and reverted with the Edit tool;
`git diff --stat` showed only the current mutant before each run, and after
the last revert `git status --short` and `git diff --stat` were empty.
Baselines: fence integration 52, unit PATCH 30, Apply 47, landlord PATCH 33,
staff notes 26, unitFields 81. Line numbers are in the final tree.

| # | Mutant | file:line | Test run | Result | Follow-up |
|---|---|---|---|---|---|
| M1a | drop one item key (`deposit_one_month`) from the real fence | `unitsRepo.ts:1196` | fence integration | KILLED (2 of 52: the checkbox-true and absent One-month cases `[DynamoDB Local]`) | - |
| M1b | the same at the harness | `twilioWebhookHarness.ts:2897` | fence + unit PATCH + Apply | KILLED (3 of 129: both One-month cases `[harness fake]`, RA-1b) | - |
| M2a | absent-included: `attribute_not_exists` weakened to a tautology (the name stays used, so DynamoDB does not refuse the expression for another reason) | `unitsRepo.ts:1203` | fence integration | KILLED (1 of 52: absent One-month `[DynamoDB Local]`) | - |
| M2b | absent-included dropped at the harness (`!ownsKey(read, key) ||`) | `twilioWebhookHarness.ts:2897` | fence + unit PATCH + Apply | KILLED (2 of 129: absent `[harness fake]`, RA-1b) | - |
| M3a | fence only the patch's own requirement keys, not the whole item | `unitsRepo.ts:1196` | fence integration | KILLED (5 of 52: string, number, legacy boolean, checkbox true, absent `[DynamoDB Local]`) | - |
| M3b | the same at the harness (fence keys filtered to the patch's own keys) | `twilioWebhookHarness.ts:2897` | fence + unit PATCH + Apply | KILLED (7 of 129: the 5 `[harness fake]`, RA-1a, RA-1b) | - |
| M4a | contacts: the type guard dropped | `contacts.ts:1640` | landlord PATCH + staff notes | KILLED (2 of 59: RA-2b, guard shape) | - |
| M4b | contacts: the `req_deposit_one_month` guard dropped | `contacts.ts:1643` | landlord PATCH + staff notes | KILLED (3 of 59: RA-2a amount-over-one-month, attribution, guard shape) | - |
| M4c | contacts: the `req_deposit` guard dropped | `contacts.ts:1644` | landlord PATCH + staff notes | KILLED (2 of 59: RA-2a raw-one-month-over-amount, guard shape) | - |
| M5 | the old attribution (`classificationGuard === undefined`) | `contacts.ts:1940` | landlord PATCH + staff notes | KILLED (1 of 59: the attribution case) | - |
| M6 | the hasOwn check removed (bare `WRITABLE_FIELDS[key]`) | `unitFields.ts:224` | unitFields + unit PATCH | KILLED (15 of 111) | - |
| M7 | the RA-7 skip dropped (`else if (classifies)` -> `else`) | `units.ts:804` | unit PATCH | KILLED (1 of 30: RA-7) | - |
| M7b | the skip inverted (`else if (!classifies)`: a requirement body classified against no landlord) | `units.ts:804` | unit PATCH | KILLED (11 of 30) | - |
| M8 | contacts absent-included: an absent stored value gets no guard | `contacts.ts:529` | landlord PATCH + staff notes | KILLED (4 of 59: RA-2a x2, attribution, guard shape) | - |

No mutant survived; no follow-up test was needed. Noted: the real repo's
absent branch is killed by one DynamoDB Local case (M2a); every value type
has its own case, and the absent case is RA-1b's shape at the repo level.
A first M3b draft named `REQUIREMENT_UNIT_KEYS`, which the harness does not
import (it would have failed on a ReferenceError, not on behavior); it was
rewritten with in-scope names before the run.

## Divergences and decisions

- OR-29 is the binding override of plan ruling AR11 (recorded in the
  adjudications). The spec's D5 / D8 text still describes the fence as the
  landlordId and the map only ("CONDITIONED on the unit's requirement_sources
  and landlordId still being what it read"); the code now also conditions the
  item values. Not edited here (outside this unit's files) - the orchestrator
  decides whether the spec records it.
- The fence-key derivation is ONE exported helper in the real repo
  (`requirementFenceKeys`) that the harness imports - the established
  pattern (`decideAutoPrimary`, `landlordWasPrimary`, ... are imported the
  same way) - so both sides derive the same key set; each side's own
  condition code is mutant-checked separately (M1-M3).
- Repo-level OR-29 cases use whole-row puts for the colleague's write
  (the map and landlordId identical to the read), so each case isolates one
  item key's value type.
- OR-30 guards are captured at the read (before any await), like the
  existing `classificationGuard`, because the harness hands out its live
  object.
- RC-1 committed first (a PIN), so its green run on the pre-OR-29 code is
  on record.
- Comment-only edits in two route files (`units.ts`, `contactRequirementsApply.ts`)
  keep their fence descriptions true; no route logic changed for OR-29.

## CONTRACT (what later units and the gates rely on)

- `export function requirementFenceKeys(patch: Record<string, unknown>): string[]`
  (`app/src/repos/unitsRepo.ts:1022`) - every unit key of each requirement
  item with a key the patch writes (value not undefined), registry order.
- `unitsRepo.updateIfRequirementsCurrent` / `applyRequirements` (signatures
  unchanged): the condition also holds, per fence key, `= <read value>` when
  `read` owns the key, else `attribute_not_exists`. Still one
  `ConditionalCheckFailedException` for ANY lost condition; callers unchanged.
  Caller rule unchanged and now load-bearing for the item values too: pass
  your own `structuredClone` of a consistent read (AR6), never an explicit
  `undefined` key.
- `ExpectClause.value: string | number | boolean | null`
  (`app/src/repos/contactsRepo.ts:714`); null = absent, as before.
- `PATCH /api/contacts/:contactId` with a req_ key: no new status or error
  string. A race on the stored type (no type change in the body) or, for a
  Deposit key, on the stored `req_deposit_one_month` / `req_deposit` is the
  existing 409 `{ error: 'contact_changed', contact }`. `staff_notes_stale`
  vs `contact_changed`: stale when the staff-notes guard is the only guard,
  else decided by the current stamp vs the expected one.
- `validateUnitBody`: any key not OWNED by the allowlist is 400
  `unknown field: <key>` (`unitFields.ts:224`).
- `PATCH /api/units/:unitId` naming only an unchanged landlordId (no
  requirement key) reads no contact (`units.ts:804`).
- Test helpers (`app/test/helpers/requirementsFixtures.ts`):
  `patchUnitRaw(app, unitId, json)` (`:76`), `postRequirementsApply(app, contactId, body)` (`:93`).
- No wire change, no new stored attribute, no new copy.

## For the orchestrator and FW1b

- The contact edit form answers a 409 `contact_changed` with the generic
  "Couldn't save - please try again." (`dashboard/src/routes/contact/ContactEditForm.tsx:568`,
  pre-existing handling) and keeps the draft; the next save answers truly
  (lands, or the AR32 deposit_conflict copy). OR-30 makes that 409 reachable
  from the landlord Requirements fieldset under a race. Dashboard is FW1b's;
  no change made here.
- Behavior under a race, for the handback: a property PATCH racing a
  colleague's save of the SAME requirement item now retries (at most 3
  writes, then 409 property_changed, as before); an Apply racing such a save
  skips that property as `changed_during_apply`. Nothing changes without a
  race.
- Gates not run, per the brief: the full `npm test`, `npm run smoke`, any
  e2e. No `AWS_*` variable is exported here; DynamoDB Local answered
  throughout (every integration half ran).
