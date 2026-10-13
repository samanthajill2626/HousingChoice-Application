# S2b slice report - app writes, second half (S2.7-S2.14)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 86b575eb (S2a report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S2.7-S2.14 (sections 0-3 and the 3.2 rulings binding; R2, R3, R6, R7,
R9, R11, R13, R14, R16 applied), plus the "S2 additions" of
`research/worklist-deltas.md` that fall in S2.7, S2.8, S2.13 and S2.14.
Implementer: Claude Opus 5.5, alone in the worktree. Date: 2026-10-13.

Environment checks before the first vitest run: `env | grep '^AWS_'`
printed nothing (exit 1). DynamoDB Local (`hc-dynamodb-local`) was already
Up; it was never started, stopped, restarted or reseeded. No `npm test`,
`npm run e2e`, `npm run e2e:session` or `npm run dev` was run. No background
command was left running.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S2.7 | 11b05393 | feat(units): restore swap re-runs the heir function per attempt; restores report the primary hand-off; landlordWasPrimary decides by the flag |
| S2.8 | d7991940 | feat(units): restores hand the primary through the heir function (earliest eligible), 503 on unknown liveness, audit handoff_on_restore |
| S2.9 | 0226d944 | feat(units): handOffPrimaryFrom for the contact-delete hand-off; list supports a consistent Scan |
| S2.10 | 3246eec1 | feat(contacts): best-effort primary hand-off service for a deleted contact (consistent Scan, heir per unit) |
| S2.11 | 08a5e764 | feat(contacts): deleting a contact hands its properties' primary to the heir (best-effort, never fails the delete) |
| S2.12 | f44a4c3a | test(units): pin heir parity between the real units repo and the API-test fake |
| S2.13 | 77aebbdf | docs(conversations): placementId docblock no longer claims a masked call routes on the unit primary_contact |
| S2.14 | (none) | slice gate - no code change, nothing forced a fix |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`git rev-parse --git-path MERGE_HEAD`), explicit paths only, the plan's
subject, the `Co-Authored-By: Claude Opus 5.5` trailer. S2.7, S2.8 and S2.13
carry one extra body line naming the worklist delta they fold in.
`npm run typecheck` after each task's commit: exit 0 every time (logs
`.superpowers/sdd/S2b-typecheck-S2.<n>.log`).

Mid-slice 500 window (plan section 0): it existed only between 11b05393
(S2.7) and d7991940 (S2.8), landed back to back; nothing live ran in between.
It is closed.

## 2. Files touched

Source (5): `app/src/repos/unitsRepo.ts`, `app/src/routes/units.ts` (ONLY the
propertyContact import line, the unitsRepo import's `landlordWasPrimary`
member, the deleted `soleLandlordToPromote` helper replaced by
`clearedLandlordHeir`, and the restore handler's header comment and tail),
`app/src/routes/contacts.ts` (one import + the DELETE handler), NEW
`app/src/services/primaryHandoff.ts`, `app/src/repos/conversationsRepo.ts`
(comment only).

Tests (10, all under `app/test/`): NEW `unitsRepoRestoreHandoff.integration.test.ts`,
`landlordWasPrimary.test.ts`, `unitsRestorePrimaryHandoff.test.ts`,
`unitsRepoHandOffPrimary.integration.test.ts`, `primaryHandoffService.test.ts`,
`contactDeletePrimaryHandoff.test.ts`, `primaryHandoffParity.integration.test.ts`;
EDITED `unitsRepoRestoreWithLandlord.integration.test.ts`,
`unitsRestoreLandlord.test.ts`, `helpers/twilioWebhookHarness.ts` (its
unitsRepo import, the fake `restoreWithLandlord`, the new fake
`handOffPrimaryFrom` ONLY).

`git diff --stat 86b575eb..HEAD` (before this report): exactly these 15
files, 2660+ / 179-. No file outside the brief's list was edited.

Ruling R16: the line
`    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });`
occurs exactly twice in `routes/units.ts`, and no S2b diff hunk touches it.

## 3. Tests and RED/GREEN evidence

Method: new test files and replaced regions were created by byte-exact
extraction of the plan's fenced blocks (`sed -n` over the plan lines, then a
script that counts each plan block in the target file - every block found
exactly once); the remaining edits used the Edit tool. Every new or touched
line is ASCII (checked per commit and at the gate).

### S2.7 - `unitsRepoRestoreHandoff.integration.test.ts` (11), `landlordWasPrimary.test.ts` (4), `unitsRepoRestoreWithLandlord.integration.test.ts` (6 swap calls + delta retitles)

New (DynamoDB Local): "swap, the new landlord is live: it takes the
primary; onPrimaryHandoff reports { from: old, to: new }"; "swap, the new
landlord is SOFT-DELETED: the earliest eligible remaining contact takes the
primary; the new landlord stays landlord of record, not primary"; "swap, the
new landlord soft-deleted and nobody eligible: no primary row, the scalar
REMOVEd, no hand-off reported"; 2x "swap of a primary landlord, liveness
unknown (%s): RosterReadFailedError - nothing written"; "(PIN) swap where the
old landlord was NOT the primary: no liveness read, the other primary
stays"; "a swap retried after a contacts-only race decides the heir again on
a fresh read"; "without a landlord: the caller's heir pick is applied and
reported; no pick reports nothing"; "(PIN) without a landlord needs no
liveness read: a failed read changes nothing"; "swap: a stale scalar naming
the old landlord does NOT move the primary off a live flagged row; the
scalar is re-aligned"; "without a landlord: a stale scalar naming the
cleared landlord does NOT move the primary off a live flagged row".
landlordWasPrimary: "the landlord row is flagged -> true"; "ANOTHER row is
flagged -> false (...)"; "NO row is flagged -> true (...)"; "the
landlord-only DERIVED row (unitContacts) counts as flagged".

- RED: `Test Files  2 failed | 1 passed (3)`, `Tests  13 failed | 20 passed (33)`
  - restoreHandoff `11 tests | 9 failed` (exactly the plan's list: both
  soft-deleted-new-landlord swaps, both liveness-unknown, the retry
  `expected [] to have a length of 2 but got +0`, the handoffs/picked
  expectations `expected [] to deeply equal [ { from: 'c-old', to: 'c-new' } ]`,
  both stale-scalar cases); landlordWasPrimary `4 failed`
  (`TypeError: (0 , landlordWasPrimary) is not a function`, see D3); the
  edited existing file 18 passed. No SKIPPED line.
- GREEN (with unitsRepoAutoPrimary 15): `Test Files  4 passed (4)`,
  `Tests  48 passed (48)`.

### S2.8 - `unitsRestorePrimaryHandoff.test.ts` (11), `unitsRestoreLandlord.test.ts` (Edits 1-4 + delta retitle)

New (FakeWorld): "rows that are not eligible (a tenant, a soft-deleted
landlord-typed contact) are skipped for the earliest eligible one; the
hand-off is audited"; 2x "liveness unknown (%s): 503 roster_read_failed -
nothing written, no audit" (clear); "the cleared landlord was not the
primary: no liveness is needed (...) and no hand-off event"; "the new
landlord is live: it takes the primary; audited handoff_on_restore from the
old landlord"; "the new landlord is SOFT-DELETED: the earliest eligible
remaining contact takes the primary; (...)"; "the new landlord soft-deleted
and nobody else eligible: no primary row, the scalar removed, no hand-off
event"; 2x "liveness unknown (%s): 503 roster_read_failed - nothing written,
no audit" (swap); "the old landlord was not the primary: the other primary
stays, no liveness is needed, no hand-off event"; "(PIN) a soft-deleted
flagged primary stays flagged after a plain restore; no hand-off event".

- RED: `Test Files  2 failed (2)`, `Tests  12 failed | 32 passed (44)` -
  new file `11 tests | 8 failed` (earliest-eligible, four liveness-unknown,
  the three swap cases incl. the live one via its `assigned(...)`
  expectation); edited file `33 tests | 4 failed` (the EARLIEST-added case,
  the stale-scalar case, the one-batch PIN, the read-race test) - exactly the
  plan's list.
- GREEN (with unitsApiRosterTypeChecks 23, unitsApiPrimaryOnAdd 17,
  unitsApiPrimaryOnRemove 7, unitsApi 29): `Test Files  6 passed (6)`,
  `Tests  120 passed (120)`.
- `grep -n "autoRoutingEligible" app/src/routes/units.ts` (case-sensitive):
  no hit - the only remaining spellings are `isAutoRoutingEligible` (:91
  import, :1134 comment, :1259 add-route call). `soleLandlordToPromote`:
  no reference left in app/src, app/test, dashboard/src or e2e.

### S2.9 - `unitsRepoHandOffPrimary.integration.test.ts` (13)

New (DynamoDB Local): "moved: the live landlord of record takes over; the
deleted contact keeps its row, unflagged"; "moved: an off-roster landlord of
record gets a landlord row as the primary"; "moved: no landlord - the
earliest-added eligible contact (a caseworker and a tenant are skipped)"; "a
soft-deleted unit is handed off too"; "unchanged: no live non-excluded
candidate - nothing written, the deleted contact stays flagged"; "unknown:
the liveness read failed - nothing written"; "not_primary: the contact holds
a row that is not the primary - nothing read, nothing written";
"not_primary: a unit that does not exist"; "(PIN) reads the unit
CONSISTENTLY"; "a lost write re-reads and re-checks: someone already moved
the primary -> not_primary, nothing more written"; "a lost write re-decides
from the new roster"; "gives up after 3 lost writes: RosterWriteConflictError,
nothing of its own written"; "list({ consistentRead: true }) sends a
consistent Scan; the default Scan does not".

- RED: `Tests  13 failed (13)` - `TypeError: units.handOffPrimaryFrom is not
  a function` (6), `repo.` (5), `contended.` (1), and the list test
  `expected { ...(2) } to match object { ConsistentRead: true }`. No SKIPPED.
- GREEN (with caseworkerRepoParity.integration 44, contactHoldings 16,
  orgRecords 24): `Test Files  4 passed (4)`, `Tests  97 passed (97)`.

### S2.10 - `primaryHandoffService.test.ts` (9)

"follows every consistent Scan page over live and deleted units, hands each
target off and audits each move"; "no heir: unchanged - nothing written, no
audit"; 2x "liveness unknown (%s): the unit is skipped with a WARN,
untouched"; "a unit whose hand-off throws is logged and skipped; the others
are handed off; it never throws"; "a Scan failure is logged and resolves;
the targets found before it are still handed off"; "an audit append that
fails is logged, never thrown; the move stands"; "never reads the deleted
contact for liveness"; "a primary someone else moved between the Scan and
the hand-off is not_primary - left as they set it".

- RED: `Error: Cannot find module '../src/services/primaryHandoff.js'` /
  `Failed to load url ../src/services/primaryHandoff.js`;
  `Test Files  1 failed (1)`, `Tests  no tests`.
- GREEN: `Test Files  1 passed (1)`, `Tests  9 passed (9)`.

### S2.11 - `contactDeletePrimaryHandoff.test.ts` (9)

"moves the primary to the heir in the same request - flag and scalar -
audited handoff_on_delete"; "a live landlord of record takes over, on a
soft-deleted unit too"; "no heir: nothing changes - and restoring the
contact leaves the property exactly as it was"; 2x "liveness unknown (%s):
the delete still succeeds; the unit is skipped with a WARN"; "one unit
failing does not fail the delete; the others are handed off"; "restoring the
contact afterwards changes no roster - the heir keeps the primary"; "Scans
consistently over live and deleted units and never reads the deleted contact
for liveness"; "(PIN) a contact who is the primary of no property: no unit
is written".

- RED: `Tests  7 failed | 2 passed (9)` - the no-heir and nobody's-primary
  PINs pass already, exactly as the plan says.
- GREEN (with contactSoftDelete 15, contactsCrud 36, contactEmailReaders 5,
  voiceInboxActivity 23): `Test Files  5 passed (5)`, `Tests  88 passed (88)`.

### S2.12 - `primaryHandoffParity.integration.test.ts` (9, a PIN)

Nine cases, each "%s: the real repo and the fake agree": remove x5 (live
landlord takes over; off-roster landlord gets a row; no landlord - earliest
eligible; nobody eligible - flags cleared, scalar removed; soft-deleted
landlord skipped), delete hand-off x2 (moved to the earliest eligible, the
deleted row kept; no heir - unchanged), restore swap (soft-deleted new
landlord skipped for the earliest eligible), add P2 (soft-deleted flagged
primary counts as absent).

- First run GREEN, as the plan expects: `Test Files  1 passed (1)`,
  `Tests  9 passed (9)`. No drift; step 3 changed nothing.

### S2.13 - comments only, no test

`conversationsRepo.ts` placementId docblock: the plan's four lines (two with
a non-ASCII arrow) replaced by the plan's six ASCII lines, by line splice.
Delta widening: the `unitsRepo.ts` `UnitContact` docblock and the
`primary_contact` docblock (see D4).

## 4. Shipped contracts S3 and S5 build on (exact)

`app/src/repos/unitsRepo.ts`:

```ts
export function landlordWasPrimary(roster: readonly UnitContact[], landlordId: string): boolean;
//   true when NO row of `roster` (unitContacts(unit)) is flagged, else true
//   only when landlordId's row is the flagged one. Never reads the scalar.

// UnitsRepo
list(
  opts?: ListUnitsOpts & { consistentRead?: boolean },  // ConsistentRead on the Scan; on list only
): Promise<UnitsPage>;
restoreWithLandlord(
  unitId: string,
  input: RestoreWithLandlordInput,                       // unchanged union; `promote` = the caller's heir pick
  opts?: RosterHandoffOpts,                              // { readContacts?, onPrimaryHandoff? } from S2a
): Promise<UnitItem>;
handOffPrimaryFrom(
  unitId: string,
  fromContactId: string,
  readContacts: ReadRosterContacts,                      // (ids: string[]) => Promise<RosterContactsRead>
): Promise<PrimaryHandOffResult>;
// PrimaryHandOffResult (S2a, now used):
//   | { outcome: 'moved'; unit: UnitItem; to: string }
//   | { outcome: 'unchanged' | 'not_primary' | 'unknown' }
```

restoreWithLandlord semantics (real and fake, same three pure functions):
`oldWasPrimary = old !== undefined && !keepsOld && landlordWasPrimary(unitContacts(unit), old)`.

- SWAP (`next` set) with oldWasPrimary: per attempt, `read =
  opts.readContacts(rosterContactIds({ contacts: nextRoster, landlordId:
  next.contactId }).filter(id => id !== old))` (absent -> `{ ok: false }`);
  `chooseHeir({ roster: nextRoster, landlordId: next.contactId, exclude:
  old, read })`; unknown -> `RosterReadFailedError` before any write;
  else `applyPrimary(nextRoster, heir | null)` sets contacts + scalar (null
  = REMOVE). A contacts-only race retries and decides again.
- CLEAR (`next: null`) with oldWasPrimary: applies `promote` when it names a
  remaining row (`applyPrimary(..., { contactId: promote, addLandlordRow:
  false })`), else clears every flag and REMOVEs the scalar. Reads nothing.
- No hand-off: the scalar is re-aligned to the stored flag (the flagged
  row's id, else REMOVE) - the old scalar is never read.
- Hand-off reporting, both branches: `opts.onPrimaryHandoff({ from: old,
  to: heirId })` once, after the successful conditional write, only when a
  row was flagged in place of the old landlord (a clear with no pick, or a
  swap with no heir, reports nothing). Log line `unit restored with a
  landlord change` carries `primaryPromoted: heirId` for either branch.

handOffPrimaryFrom semantics (real; the fake mirrors it without the retry
loop): consistent `getById`; missing unit or `fromContactId` not the
flagged `unitContacts()` row -> `not_primary` with nothing read; `read =
readContacts(rosterContactIds(unit).filter(id => id !== fromContactId))`;
`chooseHeir({ roster, landlordId, exclude: fromContactId, read })`;
unknown -> `unknown`, none -> `unchanged` (nothing written); heir ->
`updateRosterIfCurrent(unit, { contacts, primary_contact })` -> `{ outcome:
'moved', unit, to }`; a lost condition re-reads, re-checks, re-decides,
bounded at 3 attempts, then `RosterWriteConflictError`. Logs `unit primary
handed off from a deleted contact` `{ unitId, attempts, from, to }`.

`app/src/services/primaryHandoff.ts` (NEW):

```ts
export interface PrimaryHandoffDeps {
  units: Pick<UnitsRepo, 'list' | 'handOffPrimaryFrom'>;
  contacts: Pick<ContactsRepo, 'getManyByIds'>;
  audit: Pick<AuditRepo, 'append'>;
  logger: Logger;
}
export interface DeletedContactHandoffSummary {
  targets: string[]; moved: string[]; unchanged: string[];
  notPrimary: string[]; unknown: string[]; failed: string[]; scanFailed: boolean;
}
export async function handOffPrimariesOfDeletedContact(
  deps: PrimaryHandoffDeps, contactId: string, actor: string | undefined,
): Promise<DeletedContactHandoffSummary>;   // never throws
```

It pages `units.list({ deleted: 'any', consistentRead: true,
exclusiveStartKey? })` (no limit), targets units whose `unitContacts()`
flagged row is `contactId`, then per target calls `handOffPrimaryFrom(unitId,
contactId, ids => readRosterContacts(contacts, ids.filter(id => id !==
contactId), log))`. WARN lines (ids only): `contact delete: primary handoff
scan failed (best-effort)` `{ err, contactId, found }`; `... primary handoff
failed for a unit (best-effort)` `{ err, contactId, unitId }`; `... primary
handoff skipped - the liveness read failed` `{ contactId, unitId }`; `...
primary handoff audit append failed (best-effort)` `{ err, contactId,
unitId }`. INFO `contact delete: primary handoff done` when there were
targets or the Scan failed.

`app/src/routes/contacts.ts` DELETE `/api/contacts/:contactId`: right after
the `contact_deleted` audit append (soft delete persisted), before the
unread reset and presence fan-outs:
`await handOffPrimariesOfDeletedContact({ units, contacts, audit, logger: log }, contactId, req.user?.userId)`
inside a try/catch that WARNs `contact delete: primary handoff failed
(best-effort)` - a failure never turns the delete into a 500. Contact
RESTORE is unchanged (no roster write).

Audit payloads actually written (entity `units#<unitId>`, event
`unit_primary_contact_assigned`; the audit repo hoists `actor` to
`actorId`):

- `handoff_on_restore` (restore route, after `unit_restored`, either
  branch, only when the repo reported a hand-off):
  `{ actor: req.user?.userId, contactId: handoff.to, reason: 'handoff_on_restore', from: handoff.from }`.
- `handoff_on_delete` (the service, per `moved` unit, best-effort):
  `{ actor, contactId: result.to, reason: 'handoff_on_delete', from: <deleted contactId> }`.
- `unit_restored` keeps caseworker-integrity's shape: `landlordReplaced {
  from, to }` on a swap; `landlordCleared { from }` plus `primaryPromoted {
  to }` (only when the written row is flagged) on a clear.

Restore route 503 path (`POST /api/units/:unitId/restore`): clear branch -
`clearedLandlordHeir(listRead, storedLandlordId)` (landlordWasPrimary on
`unitContacts({ contacts: listRead, landlordId })`, then ONE
`readRosterContacts(contacts, <remaining row ids>, log)`, then
`chooseHeir({ roster: rows, landlordId: undefined, exclude:
clearedLandlordId, read })`) answers `{ kind: 'unknown' }` -> WARN `unit
restore refused: the liveness read failed` `{ unitId, actor }` + 503
`{ error: 'roster_read_failed' }` before any write. Swap branch - the repo's
`RosterReadFailedError` -> the same WARN + 503. Other catches unchanged
(`RosterWriteConflictError` 409 `unit_roster_conflict`,
`ConditionalCheckFailedException` 404 `unit_not_found`). The route passes
`{ readContacts: ids => readRosterContacts(contacts, ids, log),
onPrimaryHandoff }` to both branches; a plain restore never runs a hand-off
and never answers 503.

`routes/units.ts` propertyContact import, EXACT (line 91; S3.5 3a replaces
it byte-for-byte; the two comment lines above it are unchanged):

```ts
import { chooseHeir, isAutoRoutingEligible, readRosterContacts } from '../lib/propertyContact.js';
```

The unitsRepo import gained `landlordWasPrimary` (between
`RosterWriteConflictError,` and `unitContacts,`); the contactsRepo import is
unchanged from S2a.

## 5. Divergences from the plan text

- D1 (worklist delta S2-F3, applied in S2.7/S2.8). The three kept no-flag
  pins were retitled and recommented to say they pass because NO row is
  flagged; their assertions are unchanged:
  `unitsRepoRestoreWithLandlord.integration.test.ts` "moves the primary to
  the new landlord when only the primary_contact scalar named the old one"
  -> "moves the primary to the new landlord when no row is flagged - the
  scalar naming the old one decides nothing" (comment above rewritten);
  "without a landlord: promotes when only the primary_contact scalar named
  the cleared landlord" -> "without a landlord: promotes when no row is
  flagged - the scalar naming the cleared landlord decides nothing" (new
  two-line comment), and the block comment above PROMOTION_ROSTER now names
  the heir pick and landlordWasPrimary; `unitsRestoreLandlord.test.ts`
  "promoted too when only the primary_contact scalar named the cleared
  landlord" -> "promoted too when no row is flagged - the scalar naming the
  cleared landlord decides nothing" (new three-line comment).
- D2 (worklist delta S2-F2). `app/test/landlordWasPrimary.test.ts` was added
  to the S2.14 vitest and eslint lists.
- D3 (RED shape). `landlordWasPrimary.test.ts` RED was `TypeError: (0 ,
  landlordWasPrimary) is not a function` (4 failed), not a failed import as
  the plan words it: vite-node binds a missing named export to undefined.
  Same cause.
- D4 (worklist delta S2.13 widening, S1-F2 / S2-F4). Beyond the plan's
  conversationsRepo lines, `unitsRepo.ts`'s `UnitContact` docblock and the
  `UnitItem.primary_contact` docblock now say the property-contact lookup
  (lib/propertyContact.ts) takes the LIVE row marked primary, else the LIVE
  landlord of record, skipping a soft-deleted or missing contact, and name
  every roster write that keeps the scalar consistent (addContact,
  removeContact, restoreWithLandlord, handOffPrimaryFrom); the scalar
  docblock also says it is no longer client-writable (spec 4.5), is
  normally absent on a landlord-only unit, and has no runtime reader (spec
  9.2). S2.3's own comment text was already folded by S2a (its D1).
  Pre-existing non-ASCII characters on untouched lines of those docblocks
  stay.
- D5 (brief). S2.14 step 4 (`npm test -w @housingchoice/app`, the whole app
  workspace) was NOT run: the brief forbids the full suite and defines the
  slice gate as typecheck plus the named files.
- D6 (extra, non-gate evidence). eslint over every code file S2 touched
  (cbbf3ac2..HEAD), the AST cycle check with a negative control, `npm run
  smoke`, and a plain-Node ESM load of the cycle modules in three orders
  (section 9).

No code divergence: every plan code block landed byte-identical (script
check: each fenced new_string / replacement / new file found exactly once),
every predicted RED matched (D3 aside), every GREEN matched.

## 6. Cycle safety (ruling R3)

TypeScript-AST check (`ts.createSourceFile`, every top-level statement
walked; function, arrow, method and constructor bodies skipped as deferred;
types erased):

- `app/src/repos/unitsRepo.ts`: value imports from propertyContact =
  [applyPrimary, chooseHeir, rosterContactIds] -> top-level reads: NONE
  (14 imports, 5 type aliases, 4 variable statements, 11 interfaces, 7
  classes, 7 function declarations - `landlordWasPrimary` is the new one -
  1 re-export).
- `app/src/lib/propertyContact.ts`: value import from unitsRepo =
  [unitContacts] -> NONE (3 imports, 14 functions, 4 type aliases).
- `app/src/services/primaryHandoff.ts`: value imports from the cycle
  modules = [readRosterContacts, unitContacts] -> NONE (5 imports, 2
  interfaces, 1 function). It adds no top-level read.
- Negative control: the same checker on unitsRepo.ts against
  `../lib/statusModel.js` flags `:60 LISTING_STATUSES` and `:63 SHAREABLE`
  (the known, harmless reads), so it does see top-level reads.
- Runtime: after `npm run smoke`, the compiled modules load under plain Node
  ESM with `services/primaryHandoff.js`, `lib/propertyContact.js` or
  `repos/unitsRepo.js` loaded FIRST, each exit 0, cross-module calls working
  (`landlordWasPrimary([...no flag...], 'c-old')` -> true,
  `rosterContactIds({ landlordId: 'c-ll' })` -> `["c-ll"]`). Log
  `S2b-extra-esm-cycle.log`.

## 7. caseworker-integrity pins replaced or changed

- `unitsRestoreLandlord.test.ts` "(PIN) reads the remaining contacts
  CONSISTENTLY" -> "(PIN) reads the remaining contacts in ONE complete batch
  read" (ruling R13: per-row consistent getById relaxed to the spec 4.2
  batch read).
- `unitsRestoreLandlord.test.ts` "two remaining contacts typed landlord:
  nobody is promoted - no primary row, primary_contact removed, no
  primaryPromoted" -> "two remaining contacts typed landlord: the
  EARLIEST-added (c-pm) is promoted - ..." (spec 4.6).
- `unitsRestoreLandlord.test.ts` "a contact-list change WHILE the route
  reads the contact types: 409 ..." -> "... WHILE the route reads the
  contacts liveness: 409 ..." (the race hooks getManyByIds; assertions
  unchanged).
- `unitsRestoreLandlord.test.ts` describe "... without a landlord: the
  sole-landlord promotion" -> "... without a landlord: the heir takes over"
  (header comment rewritten).
- NEW beside them: "a stale primary_contact naming the cleared landlord
  does NOT move the primary off a live flagged contact; the scalar is
  re-aligned to it" (main's flag-OR-scalar rule is gone).
- The three no-flag pins retitled (D1); `unitsRepoRestoreWithLandlord`'s six
  primary-landlord swap calls now pass `{ readContacts:
  EVERYONE_LIVE_LANDLORD }` (assertions unchanged).
- Deleted: `routes/units.ts` `soleLandlordToPromote` (exactly one eligible
  -> promote, two or more -> nobody; flag OR scalar; per-row consistent
  getById), replaced by `clearedLandlordHeir`.

## 8. Worries for the orchestrator (non-blocking)

- W1. `routes/units.ts` add-route header comment (:1127-1129) still says
  "the roster resolvers take the row marked primary, else the landlord of
  record" (no "live", old resolver wording) - outside S2b's units.ts scope
  (the contact-list handler; S2a's W1 too). Also stale, also out of scope:
  `unitsApiRosterAutoPrimary.test.ts:150` ("the restore's sole-landlord
  promotion uses") and two `unitsRepoRestoreWithLandlord` titles at :192
  and :247 that still say "sole landlord-typed contact" (the repo test
  passes `promote` itself, so they are not wrong, only dated).
- W2. A restore WITHOUT a landlord that promotes now records the promotion
  twice: `unit_restored.primaryPromoted { to }` (caseworker-integrity) AND
  `unit_primary_contact_assigned { reason: 'handoff_on_restore' }`. A swap
  records only the new event. S3's Activity projection / S4's renderer
  should decide whether both lines show.
- W3. Two WARNs per failed liveness read on the restore and delete paths:
  `readRosterContacts`' own `property contact: roster liveness read failed
  - liveness unknown` (with err), then the route's / service's ids-only
  line.
- W4. Every contact DELETE now runs one strongly consistent full-table
  units Scan (paged, no limit) before the unread-reset and presence
  fan-outs (S2-F7, spec-conformant). e2e `roster-paging.spec.ts` deletes 60
  contacts concurrently - the plan's gate-4 watch item.
- W5. Now live through the real routes (S5's e2e sees it): "Restore without
  a landlord" promotes the earliest-added eligible contact (two or more no
  longer means nobody), and a no-flag roster hands off whatever the stale
  scalar says; a SWAP to a soft-deleted landlord-typed contact
  (`requireLandlordContact` accepts one) keeps that contact as landlord of
  record but flags the earliest eligible row instead, or nobody.
- W6. The FakeWorld `list()` ignores `consistentRead` (commented in the
  fake); only the real-repo integration test pins the `ConsistentRead`
  Scan input, and the route test pins the options the service passes.
- W7. `main` is at 16ca96cc, two docs-only commits past the merge base
  fa35f228 (RUNBOOK + historical-doc freeze); no code drift.
- W8. The extra smoke run rebuilt the gitignored `app/dist/`.

## 9. S2.14 slice gate (bare, output to `.superpowers/sdd/`, real exit codes)

1. `env | grep '^AWS_'` -> nothing printed, `EXIT:1` (no key exported). Log
   `S2b-gate-aws-env.log`.
2. `cd W:/tmp/primary-contact-integrity && npm run typecheck` -> `EXIT:0`;
   0 `error TS` lines; all five workspaces ran (app: src, scripts and tests;
   dashboard; e2e; fake-twilio; fake-twilio-web). Log
   `S2b-gate-typecheck.log`.
3. `cd app && npx vitest run` on the plan's 30 files plus
   `test/landlordWasPrimary.test.ts` (D2) -> `EXIT:0`;
   `Test Files  31 passed (31)`, `Tests  544 passed (544)`; 0 `[dynamoAdmin]`
   lines; 0 SKIPPED lines. Per file: unitFields 40, unitsApi 29,
   unitsRepoAutoPrimaryDecision 18, unitsRepoPrimaryOnAdd.integration 17,
   unitsRepoAutoPrimary.integration 15, unitsApiPrimaryOnAdd 17,
   unitsApiRosterAutoPrimary 19, unitsRepoPrimaryOnRemove.integration 9,
   unitsRepoRoster.integration 17, unitsApiPrimaryOnRemove 7,
   unitsApiRoster 25, unitsRepoRestoreHandoff.integration 11,
   unitsRepoRestoreWithLandlord.integration 18, unitsRestorePrimaryHandoff
   11, unitsRestoreLandlord 33, unitsRepoHandOffPrimary.integration 13,
   primaryHandoffService 9, contactDeletePrimaryHandoff 9,
   primaryHandoffParity.integration 9, unitsApiRosterTypeChecks 23,
   unitsRepoContactListRules.integration 6, unitsApiActivity 11,
   placementsVoiceRouting 11, contactSoftDelete 15, contactsCrud 36,
   contactEmailReaders 5, voiceInboxActivity 23,
   caseworkerRepoParity.integration 44, contactHoldings 16, orgRecords 24,
   landlordWasPrimary 4. Log `S2b-gate-vitest.log`.
4. Whole app workspace: NOT RUN (brief; D5).
5. `npx eslint` on the plan's 18 paths plus
   `app/test/landlordWasPrimary.test.ts` -> `EXIT:0`, empty output (log
   `S2b-gate-eslint.log`). No baseline comparison needed.
6. ASCII: `git diff main...HEAD -U0 -- app | grep -nP '^\+.*[^\x00-\x7F]'`
   -> no output, grep `EXIT:1` (the pass). Log `S2b-gate-ascii.log`.

Extra evidence (not gate steps):

- `npx eslint` on all 27 code files S2 touched (`git diff --name-only
  --diff-filter=d cbbf3ac2..HEAD`, S2a + S2b) -> `EXIT:0`, empty output. Log
  `S2b-extra-eslint-s2range.log`; list `S2b-touched-files.txt`.
- AST cycle check -> `CYCLE-SAFE: no top-level read`, `EXIT:0`; negative
  control flags the two statusModel reads. Log `S2b-extra-cycle-check.log`.
- `npm run smoke` -> `EXIT:0`, `smoke-dist: OK - 1676 import specifier(s)
  across 291 emitted file(s) resolve under plain Node.` Log
  `S2b-extra-smoke.log`.
- Plain-Node ESM load in three orders -> `EXIT:0` three times. Log
  `S2b-extra-esm-cycle.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`,
seven S2b commits on top of 86b575eb (this report is the eighth).

Next step: slice S3 (plan line 11167), starting with its contract issues.
