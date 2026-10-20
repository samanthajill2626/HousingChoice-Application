# U3 (S2a) - repo fences, harness, parity, landlord-change REMOVEs - Tasks 2.1, 2.2

- Unit: U3, slice S2a (plan Tasks 2.1-2.2), implementer model Claude Opus 5.5.
- Branch `feat/property-requirements`, worktree `W:/tmp/property-requirements`,
  started at `5362db0a` (U2's report commit).
- Rulings carried: AR6 (callers clone the read), AR7 (a restore that CLEARS
  the landlord is a landlord change), AR18 (applyRequirements stamps
  updated_at), PR1-8 (the Apply write's not-deleted condition follows
  isDeleted), OR-3 (no parity case for a non-string deleted_at), and the
  brief's CCF convention (`err instanceof ConditionalCheckFailedException`,
  no helper).
- STOP items: none.

## Per task

| Task | Result | Files |
|---|---|---|
| 2.1 Repo: the fenced writes (`updateIfRequirementsCurrent`, `applyRequirements`) on the real repo and the API-test fake | SHIPPED as written | `app/src/repos/unitsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`, `app/test/unitsRepoRequirementsFence.integration.test.ts` (new) |
| 2.2 A landlord-of-record change REMOVEs the map (`restoreWithLandlord`, the `addContact` claim) | SHIPPED as written | `app/src/repos/unitsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`, `app/test/primaryHandoffParity.integration.test.ts`, `app/test/helpers/requirementsFixtures.ts` (new), `app/test/unitsApiRequirementsReset.test.ts` (new) |
| Mutant follow-up (M10) | ADDED one parity case | `app/test/primaryHandoffParity.integration.test.ts:301-326` |

Plan fidelity, checked mechanically (a throwaway script in the session
scratchpad applies a task's plan anchor -> replacement line ranges to the
HEAD text and compares the result with the working file, before each
commit): Task 2.1 `unitsRepo.ts` (plan 5660/5693/5721-5725/5819-5821 ->
5666-5687/5699-5714/5731-5813/5827-5837) and the harness (5844-5845/5903-5904
-> 5851-5897/5910-5918); Task 2.2 `unitsRepo.ts` (6454/6473-6474/6492-6494/
6510-6511 -> 6460-6467/6480-6486/6500-6504/6517-6520), the harness
(6526/6544-6545 -> 6532-6538/6551-6556) and `primaryHandoffParity`
(eight anchors, plan 6168-6434). Every anchor matched exactly once and every
edited file equals base + plan edits byte for byte. The three new files
were extracted from the plan by line range (5337-5644, 5973-6057,
6063-6159) and are byte-identical to it.

Anchors vs line hints (AR47 class, nothing to apply on top): U2's Task 1.4
grew `UnitItem`, so the `unitsRepo.ts` hints moved (`update` interface
:620 -> :674, `createUnitsRepo` :913 -> :967, `updateRosterIfCurrent`'s tail
:1016 -> :1070, `update`'s tail :1145 -> :1199, the claim :1324 -> :1378,
the restore patch :1690 -> :1744 before my edits). The harness anchors were
at R1's lines exactly. Every quoted anchor matched by its text.

## Commits

| Hash | Subject |
|---|---|
| `c79dfd4a` | feat(units): fenced requirement writes on the units repo and the API-test fake |
| `2ec26f20` | feat(units): a landlord-of-record change REMOVEs requirement_sources |
| `1c379b0b` | test(units): a keepsOld restore leaves requirement_sources alone - parity case on both implementations |
| (this file) | docs(records): ... U3 S2a report |

## RED runs (each red for the stated reason)

- 2.1: `test/unitsRepoRequirementsFence.integration.test.ts` - 30/30 failed,
  15 `[harness fake]` + 15 `[DynamoDB Local]` (so the real half RAN), every
  one a `TypeError: w.units.updateIfRequirementsCurrent is not a function`
  (20) or `... applyRequirements is not a function` (10).
- 2.2: `test/unitsApiRequirementsReset.test.ts` - 3 failed / 2 passed: the
  restore swap, restore clear and claim cases on
  `expected { unitId: 'u-1', ... } to not have property "requirement_sources"`
  (each after its 200 and landlordId assertions passed); both (PIN) cases
  green.
- 2.2: `test/primaryHandoffParity.integration.test.ts` - 5 failed / 14
  passed (19 ran, none skipped: the whole suite is `describe.skipIf`, so this
  proves DynamoDB Local was used): swap, clear, claim and both slow-write
  cases, all at the `expect(real.sources).toEqual(c.expected.sources)` line
  (`expected { pets: 'set_here' } to deeply equal null` /
  `{ credit_requirements: 'set_here' }`), i.e. the slow-write rejections
  already passed (2.1's landlordId fence) and only the map was red, as the
  plan predicted. The 12 existing cases and both (PIN) cases green.

## GREEN runs

| When | Command scope | Result |
|---|---|---|
| 2.1 | `test/unitsRepoRequirementsFence.integration.test.ts` (verbose) | 30/30; 15 `[DynamoDB Local]` + 15 `[harness fake]` passed, 0 skipped |
| 2.1 | `test/unitsRepo test/primaryHandoffParity.integration.test.ts test/caseworkerRepoParity.integration.test.ts test/unitsApi.test.ts` | 16 files, 268/268 (primaryHandoffParity 12 ran) |
| 2.1 | root `npm run typecheck` | exit 0 (app incl. `tsconfig.test.json`, dashboard, e2e, fake-twilio, fake-twilio-web) |
| 2.1 | `npx eslint` on the three files | exit 0 |
| 2.2 | `test/unitsApiRequirementsReset.test.ts test/primaryHandoffParity.integration.test.ts` | 2 files, 24/24 (parity 19, reset 5) |
| 2.2 | `test/units test/caseworkerRepoParity.integration.test.ts` | 32 files, 532/532 (every units* suite: roster, restore, auto-primary, contact-list rules, landlord of record, the 2.1 fence suite) |
| 2.2 | root `npm run typecheck` | exit 0 |
| 2.2 | `npx eslint` on the five files | exit 0 |
| Brief end run | `test/primaryHandoffParity.integration.test.ts test/unitsLandlordOfRecord.test.ts test/unitsApiRoster.test.ts` | 65/65 after 2.2 (19 + 21 + 25); 66/66 after the follow-up (20 + 21 + 25), none skipped |
| Follow-up | parity suite on real code | 20/20 |
| Unit end | `test/units test/caseworkerRepoParity.integration.test.ts test/primaryHandoffParity.integration.test.ts` | 33 files, 552/552 |
| Unit end | root `npm run typecheck` | exit 0 |
| Unit end | `npx eslint $(git diff --name-only --diff-filter=d 5362db0a...HEAD -- '*.ts' ...)` (the six files) | exit 0 |

ASCII: the three new files print 0 on the `tr` check; the added lines of
`unitsRepo.ts`, `twilioWebhookHarness.ts` (both carry pre-existing em
dashes) and `primaryHandoffParity.integration.test.ts` print 0, for each
task and for the follow-up. No literal backslash-u in any added line.

## Mutant table

Ten one-line mutants, each applied separately to the real repo and to the
harness (the brief asks for both); the real repo's absent-included rule has
two branches (landlordId and the map) where the fake shares one line, so M2
has three runs - 21 runs in all. Line numbers are in the final tree. Each
mutant was applied and reverted with the Edit tool; `git diff --stat`
showed only the current mutant before each run, and after the last revert
`git status --short` / `git diff --stat` were empty. Every run used the
three U3 suites (fence 30 + parity 19 + reset 5 = 54; baseline 54/54).

| # | Mutant | file:line | Result (failed of 54) | Follow-up |
|---|---|---|---|---|
| M1a | landlordId equality weakened to `(= OR attribute_exists)` | `unitsRepo.ts:1153` | KILLED (2: both "refuses when the landlordId changed" `[DynamoDB Local]`) | - |
| M1b | landlordId check dropped (`false ||`) | `twilioWebhookHarness.ts:2892` | KILLED (3: landlordId changed x2, ownerless claimed `[harness fake]`) | - |
| M2a | absent-included, landlordId: `attribute_not_exists` weakened to a tautology | `unitsRepo.ts:1155` | KILLED (1: "an ownerless unit was claimed" `[DynamoDB Local]`) | - |
| M2b | absent-included, map: the same | `unitsRepo.ts:1162` | KILLED (2: "a map appeared since a read that had none", "applyRequirements refuses when the map changed" `[DynamoDB Local]`) | - |
| M2c | absent-included, shared: `sameAsRead`'s absent branch answers `true` | `twilioWebhookHarness.ts:2882` | KILLED (3 `[harness fake]`) | - |
| M3a | map equality weakened to `(= OR attribute_exists)` | `unitsRepo.ts:1160` | KILLED (1: "refuses when the map changed" `[DynamoDB Local]`) | - |
| M3b | map check dropped (`false ||`) | `twilioWebhookHarness.ts:2893` | KILLED (4 `[harness fake]`) | - |
| M4a | not-deleted clause skipped (`if (false)`) | `unitsRepo.ts:1164` | KILLED (1: "applyRequirements refuses a soft-deleted unit" `[DynamoDB Local]`) | - |
| M4b | not-deleted check skipped (`false`) | `twilioWebhookHarness.ts:2894` | KILLED (1, same case `[harness fake]`) | - |
| M5a | PR1-8 regression: a blank deleted_at read as deleted (`:blankDeletedAt` = `'-'`) | `unitsRepo.ts:1167` | KILLED (1: "deleted_at is BLANK - live" `[DynamoDB Local]`) | - |
| M5b | PR1-8 regression: `unit.deleted_at !== undefined` instead of `isUnitDeleted` | `twilioWebhookHarness.ts:2894` | KILLED (1, same case `[harness fake]`) | - |
| M6a | updated_at not refreshed (`:updatedAt` = `read.updated_at`) | `unitsRepo.ts:1146` | KILLED (2: both write cases `[DynamoDB Local]`) | - |
| M6b | the fake's stamp line removed | `twilioWebhookHarness.ts:2909` | KILLED (2 `[harness fake]`) | - |
| M7a | an empty map SET, not REMOVEd (drop `isEmptySourcesMap`) | `unitsRepo.ts:1136` | KILLED (1: "an EMPTY map ... REMOVEs" `[DynamoDB Local]`) | - |
| M7b | the same in the fake (drop `emptySources`) | `twilioWebhookHarness.ts:2906` | KILLED (1 `[harness fake]`) | - |
| M8a | pre-AR7 rule: a restore that CLEARS the landlord keeps the map (`next !== null && next.contactId !== old`) | `unitsRepo.ts:1883` | KILLED (1: parity "restore clear (requirements)") | - |
| M8b | the same in the fake | `twilioWebhookHarness.ts:3357` | KILLED (2: route "a restore onto NO landlord", parity "restore clear") | - |
| M9a | the claim's `requirement_sources = null` dropped | `unitsRepo.ts:1510` | KILLED (2: parity claim, parity slow-write claim) | - |
| M9b | the fake claim's `delete unit.requirement_sources` dropped | `twilioWebhookHarness.ts:3120` | KILLED (3: route claim, parity claim, parity slow-write claim) | - |
| M10a | the restore REMOVE guard made unconditional (`if (true)`): a keepsOld restore wipes the map | `unitsRepo.ts:1883` | SURVIVED (54/54; also 73/73 in the four restore suites) | Real gap, see below; committed `1c379b0b` |
| M10b | the same in the fake | `twilioWebhookHarness.ts:3357` | SURVIVED (54/54) | same follow-up |

M10 is a real gap, low severity. Plan CI-2 / AR7 states that a `keepsOld`
restore (`next` names the landlord the restore read,
`unitsRepo.ts:1843`, harness `:3286`) changes nothing and keeps the map,
but no case pinned it: the route's "(PIN) a plain restore keeps the
landlord and the map" goes through `units.restore` (`units.ts:2363`), not
`restoreWithLandlord`, and keepsOld is reachable only under a race
(`unitsRepo.ts:1841-1842`). With the mutant, such a restore REMOVEs the map
though the landlord of record did not change, so a `copied` item that the
landlord later changed would show purple "Set on this property" instead of
orange "Landlord updated" and count as an own value in Apply. The new parity
case `(PIN) restore onto the SAME landlord (requirements): a keepsOld
restore leaves the map alone` (`primaryHandoffParity.integration.test.ts:301-326`)
fails with M10a (1 of 20, the fake/real comparison) and with M10b (1 of 20),
and passes on real code (20/20; the unit-end runs above include it).

Not run, recorded so nobody re-derives it: dropping `structuredClone` on the
fake's patch values (`twilioWebhookHarness.ts:2907`) is unobservable in
these suites (no caller mutates its patch after the write); it is a
fidelity detail (the real repo serializes), not a behavior.

## Divergences from the plan text

- None in code: every task's files are the plan's text (see "Plan fidelity").
- Added one parity case for M10 (`primaryHandoffParity.integration.test.ts:301-326`,
  between the restore-clear and the claim cases), commit `1c379b0b`.
- The brief's end run reports 66 tests (not the 65 it had at Task 2.2's
  commit) because of that case.

## Rulings applied

- AR6: neither fenced method mutates `read` or depends on the caller
  mutating it; both compare the store against the caller's object. Every
  test passes its own copy (`readBack` clones on the fake,
  `unitsRepoRequirementsFence.integration.test.ts:94-97`; the slow-write
  cases `structuredClone` the `getById` result). The fake copies patch values
  in with `structuredClone` (`twilioWebhookHarness.ts:2907`).
- AR7: the restore REMOVE fires whenever the landlord after the restore
  (`next.contactId`, or none for `next: null`) differs from
  `input.expectLandlordId`, which the repo has already required to equal the
  landlord it read (`unitsRepo.ts:1827`, harness `:3277`) - so it is exactly
  "differs from the one read". Pinned for a swap, a clear (M8) and, after
  M10, a keepsOld restore.
- AR18: both methods stamp `updated_at` (M6 pins it on both sides).
- PR1-8: the real clause is
  `(attribute_not_exists(#expectedDeletedAt) OR #expectedDeletedAt = :blankDeletedAt)`
  with `:blankDeletedAt = ''` (`unitsRepo.ts:1164-1169`); the fake refuses
  exactly when `isUnitDeleted(unit)` (`twilioWebhookHarness.ts:2894`). One
  parity case each way (`unitsRepoRequirementsFence.integration.test.ts:269`,
  `:278`); M4 and M5 pin both directions on both sides.
- OR-3: no parity case for a non-string `deleted_at` (the only real/fake
  difference: a stored NULL or number stamp, which no repo path writes).
- CCF convention: the new code throws (fake: `conditionalCheckFailed`,
  `twilioWebhookHarness.ts:2896`) or lets the SDK throw (real) a genuine
  `ConditionalCheckFailedException`; no helper was added, so callers keep
  `err instanceof ConditionalCheckFailedException`.

## CONTRACT (what U4 / U5 and later units rely on)

### `unitsRepo.updateIfRequirementsCurrent` / `unitsRepo.applyRequirements`

Signatures (the `UnitsRepo` interface, `app/src/repos/unitsRepo.ts:687`
and `:695`; the harness implements the same interface):
- `updateIfRequirementsCurrent(read: UnitItem, patch: Record<string, unknown>): Promise<UnitItem>`
- `applyRequirements(read: UnitItem, patch: Record<string, unknown>): Promise<UnitItem>`

Real repo: both call the private `updateIfRequirementsFenced(read, patch, { requireLive })`
(`unitsRepo.ts:1122-1189`; public methods `:1321-1327`), `requireLive`
false / true. ONE `UpdateCommand` on `Key: { unitId: read.unitId }`:
- Update expression: every patch key whose value is not `undefined` -
  `null` -> REMOVE; a `requirement_sources` value that is a non-array object
  with no keys -> REMOVE (`isEmptySourcesMap`, `:997-1005`); anything else
  -> SET. Always `SET updated_at = <now ISO>`. `ReturnValues: 'ALL_NEW'`.
  Logs `unit updated (requirements fence)` with `{ unitId, fields, live }`.
- Condition expression, joined with AND, in this order:
  1. `attribute_exists(unitId)`
  2. `#expectedLandlordId = :expectedLandlordId` when `read` OWNS
     `landlordId` (`hasOwnProperty`), else `attribute_not_exists(#expectedLandlordId)`
  3. `#expectedSources = :expectedSources` (the whole map) when `read` owns
     `requirement_sources`, else `attribute_not_exists(#expectedSources)`
  4. `applyRequirements` only:
     `(attribute_not_exists(#expectedDeletedAt) OR #expectedDeletedAt = :blankDeletedAt)`,
     `:blankDeletedAt = ''`
- Throws the SDK's `ConditionalCheckFailedException` on ANY lost condition,
  a missing unit included; nothing is written. No re-read, no retry: the
  caller re-reads to tell 404 from a race (U4's PATCH loop) or maps it to
  `changed_during_apply` (U5's Apply route). Any other error propagates.
- `updateIfRequirementsCurrent` writes a soft-deleted unit (pinned);
  `applyRequirements` refuses a non-empty `deleted_at` and writes a blank
  one.

Harness (`app/test/helpers/twilioWebhookHarness.ts`): `fencedRequirementsWrite(method, read, patch, requireLive)`
(`:2883-2911`, helpers `ownsKey` `:2877`, `sameAsRead` `:2879-2882`;
methods `:2961-2966`). Refuses when the stored unit is missing, or
`landlordId` / `requirement_sources` differ from `read` (own-property
presence on both sides, then `isDeepStrictEqual`), or (`requireLive`)
`isUnitDeleted(unit)`; it throws
`ConditionalCheckFailedException` with the message
`<method>: unit <unitId> changed since the read`. Otherwise it applies the
patch IN PLACE on the live stored unit (null or an empty map -> delete; else
`structuredClone(value)`), stamps `updated_at`, and returns the LIVE stored
object (like the rest of the fake; the real repo returns a fresh ALL_NEW
item).

Caller rules (for U4 and U5):
- Pass your OWN `structuredClone` of a consistent read (AR6). With the fake,
  passing the `getById` result itself compares the store with itself and
  can never lose. Never hand-build a read with an explicit `undefined` key
  (the real repo would try to marshal it as an expected value).
- Never put `updated_at` (or `unitId`) in the patch: the method SETs
  `updated_at` itself and DynamoDB refuses two writes to one path.
- An empty patch is valid and still stamps `updated_at` (PR1-10a's
  every-key-unchanged save).
- `requirement_sources: null` and `requirement_sources: {}` both REMOVE the
  attribute; the map is never stored empty.
- The patch may carry `landlordId` (a PATCH landlord change): the condition
  still compares the landlordId `read` holds.

### `restoreWithLandlord` / `addContact` - the REMOVE behavior

- Real `restoreWithLandlord` adds `requirement_sources: null` to the patch it
  already writes whenever `(next !== null ? next.contactId : undefined) !== old`
  (`unitsRepo.ts:1879-1883`, `old = input.expectLandlordId`): a swap onto
  another landlord or a clear (`next: null`) of a landlord REMOVEs the map in
  the same `updateRosterIfCurrent(..., { requireSoftDeleted: true })` write.
  A keepsOld restore (`next` = the landlord read) and a clear of an ownerless
  unit (no landlord before or after) keep it. The fake mirrors it with
  `delete unit.requirement_sources` (`twilioWebhookHarness.ts:3354-3357`).
- Real `addContact`: the claim of the vacant landlord slot
  (`claimsVacantLandlord`: role `landlord` on a unit with NO `landlordId`
  attribute) adds `requirement_sources: null` beside `landlordId` in the same
  `updateRosterIfCurrent` write (`unitsRepo.ts:1504-1511`); every other
  roster write leaves the map alone. Fake: `twilioWebhookHarness.ts:3115-3121`.
- Unchanged and verified to leave the map alone: the plain `restore`
  (`units.ts:2363`), `removeContact` (pinned by the new remove (PIN) parity
  case), `handOffPrimaryFrom`, `assignPrimaryIfCurrent`, `softDelete`,
  `update`, the media and authorities writes.
- Both interface doc comments say so (`unitsRepo.ts:741-745`, `:874-877`).
- The restore and contacts-add routes spread the stored unit, so their
  responses carry no `requirement_sources` after a landlord change (pinned on
  the HTTP response and the stored unit, `unitsApiRequirementsReset.test.ts`).

### New test files later units may use

- `app/test/helpers/requirementsFixtures.ts` (AR12, S2-private; S3 may
  reuse): `REQ_STAMP` (`:13`), `ALL_COPIED` (`:16`), `seedLandlord` (`:21`),
  `seedContact` (`:26`), `seedUnit` (`:31`, owned by `c-ll` unless told
  otherwise; an `undefined` field is left OFF), `snapshotOf` (`:45`, every
  item every key null, then overrides), `postUnit` / `patchUnit` / `getUnit`
  (`:59`, `:67`, `:75`, authed supertest requests), `unitUpdatedEvents`
  (`:83`). Only `REQ_STAMP`, `seedContact`, `seedLandlord`, `seedUnit` are used
  so far (the rest are U4's Tasks 2.4 / 2.5).
- `app/test/unitsRepoRequirementsFence.integration.test.ts`: the
  `parity(name, run)` real/fake pattern for the two fenced methods (15 cases
  x 2 halves).
- `app/test/primaryHandoffParity.integration.test.ts`: `Shape.sources`,
  `expected.sources` (`null` = REMOVEd, `undefined` = not pinned) and
  `observe().sources` - add a case there to pin any future map writer on a
  roster method against both implementations.

## For later units and the orchestrator

- U4 (Tasks 2.3-2.6): the PATCH fence is `updateIfRequirementsCurrent`; its
  CCF covers a vanished unit too, so the route's re-read decides 404 vs
  retry, as plan 2.3 says. The fake ignores `consistentRead` on `getById`
  (in memory is consistent) and hands out the live object, so the route's
  `structuredClone` is what makes the fake able to lose a race at all.
- U5 (Task 3.2): `applyRequirements` refuses a unit deleted after the read
  (a non-empty stamp) with the same CCF as a landlord or map race; plan 2.4
  maps every CCF to `changed_during_apply`. A blank `deleted_at` is live, as
  in `planUnitApply`.
- Facts re-verified in the tree (AR48), all holding: `update` (`unitsRepo.ts:1273-1319`
  now) SETs / REMOVEs / stamps with `attribute_exists(unitId)` only;
  `updateRosterIfCurrent` is the precedent the fence copies (`:1050-1111`);
  `ROSTER_WRITE_MAX_ATTEMPTS = 3` (`:239`); the harness `getById` returns the
  live object and `update` mutates in place; `conditionalCheckFailed`,
  `isDeepStrictEqual`, `isUnitDeleted` are in scope of the units fake;
  `primaryHandoffParity` is `describe.skipIf(!reachable)` as a whole (it ran
  in every RED and GREEN run above). No `AWS_*` variable is exported here;
  DynamoDB Local answered throughout.
- Not run, per the brief: the full `npm test`, any e2e.
