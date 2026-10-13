# S2a slice report - app writes, first half (S2.1-S2.6)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base cbbf3ac2 (S1 report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S2.1-S2.6 (sections 0-3 and the 3.2 rulings binding; R2, R3, R6-R11,
R16 applied), plus the S2.3 comment item of the "S2 additions" in
`research/worklist-deltas.md`. Tasks S2.7-S2.14 are the later S2b dispatch
and were NOT started. Implementer: Claude Opus 5.5, alone in the worktree.
Date: 2026-10-13.

Environment checks before the first vitest run: `env | grep '^AWS_'`
printed nothing (exit 1). DynamoDB Local (`hc-dynamodb-local`) was already
Up; it was never started, stopped, restarted or reseeded. No `npm test`,
`npm run e2e`, `npm run e2e:session` or `npm run dev` was run. No
background command was left running.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S2.1 | 02ccba0f | feat(units): primary_contact is no longer writable on unit create or PATCH (P2b) |
| S2.2 | 2d507ac0 | feat(units): roster hand-off contracts and the pure P2 auto-primary decision |
| S2.3 | 57bc3a74 | feat(units): addContact auto-primary counts deleted as absent and edits of the contact's own row (P2) |
| S2.4 | 21741f91 | feat(units): contact-list add reads liveness for auto-primary, refuses a deleted primary (409), audits auto_on_add |
| S2.5 | b198e2e0 | feat(units): removing the primary hands it to the heir function's pick, refuses on unknown liveness |
| S2.6 | 2bbceeab | feat(units): remove route hands the primary off (503 roster_read_failed on unknown liveness), audits handoff_on_remove |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent,
explicit paths only, the plan's subject, the `Co-Authored-By: Claude Opus
5.5` trailer. The S2.3 commit carries one extra body line naming the
worklist delta. `npm run typecheck` after each task's commit: exit 0 every
time (logs `.superpowers/sdd/S2a-typecheck-S2.<n>.log`).

Mid-slice 500 window (plan section 0): it existed only between b198e2e0
(S2.5) and 2bbceeab (S2.6), landed back to back; nothing live ran in
between. It is closed.

## 2. Files touched

Source (4): `app/src/lib/unitFields.ts`, `app/src/repos/unitsRepo.ts`,
`app/src/routes/units.ts` (ONLY the three import blocks named by S2.4/S2.6
- unitsRepo, contactsRepo, propertyContact - and the contact-list add and
remove handlers with their comment blocks), `app/test/helpers/twilioWebhookHarness.ts`
(its unitsRepo import, the new propertyContact import, the fake
`addContact` and the fake `removeContact` ONLY).

Tests (11, all under `app/test/`): NEW `unitsRepoAutoPrimaryDecision.test.ts`,
`unitsRepoPrimaryOnAdd.integration.test.ts`, `unitsApiPrimaryOnAdd.test.ts`,
`unitsRepoPrimaryOnRemove.integration.test.ts`, `unitsApiPrimaryOnRemove.test.ts`;
EDITED `unitFields.test.ts`, `unitsApi.test.ts`,
`unitsRepoAutoPrimary.integration.test.ts`, `unitsApiRosterAutoPrimary.test.ts`,
`unitsApiRoster.test.ts` (two seed lines: S2.4 (c) and S2.6 (b)),
`unitsRepoRoster.integration.test.ts`.

`git diff --stat cbbf3ac2..HEAD`: exactly these 15 files (2130+, 205-).
No file outside the brief's list was edited.

Ruling R16: the line
`    res.json({ unit: { ...updated, contacts: await enrichRoster(updated) } });`
occurs exactly twice in `routes/units.ts` (add handler :1352, remove handler
:1428), byte-identical to before.

## 3. Tests and RED/GREEN evidence

Method: every plan code block was checked byte-for-byte by script (the
plan's fenced new_string lines found exactly once in the edited file). New
test files were created by byte-exact extraction of the plan's fenced
blocks (see divergence D3).

### S2.1 - P2b (`unitFields.test.ts` +2, `unitsApi.test.ts` one test replaced, one added)

Added: describe "validateUnitBody - primary_contact is not writable
(primary-contact-integrity spec 4.5)": "refuses primary_contact on create";
"refuses primary_contact on update, even beside a writable field".
unitsApi: "accepts the per-unit internal fields (CO1)" (replaces "... incl.
primary_contact (CO1)"); "refuses primary_contact on create and on PATCH -
400, nothing written".

- RED: unitFields `40 tests | 2 failed` (`expected { ok: true, fields: { ...(2) } } to deeply equal { ok: false, ...(1) }`),
  unitsApi `29 tests | 1 failed` (`expected 201 to be 400`);
  `Test Files  2 failed (2)`, `Tests  3 failed | 66 passed (69)`.
- GREEN: `Test Files  2 passed (2)`, `Tests  69 passed (69)`.

### S2.2 - contracts + pure P2 decision (`unitsRepoAutoPrimaryDecision.test.ts`, 18 tests)

autoPrimaryLivenessIds: "no flagged row and no landlord of record: nothing
to read"; "reads the flagged primary and the landlord of record - each
once"; 4x "%s: null - no read can change the answer" (X not eligible / the
request already asks for primary / X is itself the flagged primary / X is
the landlord of record). decideAutoPrimary: "no flagged row and no landlord
of record: promote, with no read at all"; "a soft-deleted flagged primary
counts as absent: promote"; "a MISSING flagged primary (no record) counts
as absent: promote"; "a soft-deleted landlord of record counts as absent:
promote"; "a LIVE flagged primary: keep the request flag"; "a LIVE landlord
of record: keep, even beside a soft-deleted flagged primary"; "a liveness
read that failed, or that was not supplied, is unknown - never a
promotion"; 4x "%s: keep, whatever the read says". Errors: "RosterReadFailedError
and PrimaryContactDeletedError are named Errors".

- RED: `18 tests | 18 failed` - `(0 , autoPrimaryLivenessIds) is not a function`,
  `(0 , decideAutoPrimary) is not a function`, `RosterReadFailedError is not a constructor`;
  `Test Files  1 failed (1)`.
- GREEN: `Test Files  1 passed (1)`, `Tests  18 passed (18)`.

### S2.3 - addContact P2 widened (`unitsRepoPrimaryOnAdd.integration.test.ts` 17 tests; `unitsRepoAutoPrimary.integration.test.ts` header + case (f) reversed)

New (DynamoDB Local): "a soft-deleted flagged primary on an ownerless
property: an eligible add becomes the primary, the deleted row is demoted";
"a flagged primary whose contact record is MISSING counts as absent"; "a
soft-deleted landlord of record and no flagged row: an eligible add becomes
the primary; landlordId stays"; "a landlord-only unit whose landlord of
record is soft-deleted: the derived landlord row is demoted, the add is the
primary"; "(PIN) a LIVE flagged primary: ..."; "(PIN) a LIVE landlord of
record beside a soft-deleted flagged primary: nothing promoted - the deleted
row keeps its flag AND the scalar"; "a contact NOT eligible for automatic
routing: nobody is promoted and nothing is read - ..."; "a write for one
contact never promotes ANOTHER - ..."; "an edit of a seated contact (a role
change) on a property with a soft-deleted primary makes THAT contact the
primary"; "liveness unknown (the read failed): the add succeeds without a
promotion - ..."; "(PIN) no readContacts supplied: main rule only - a
flagged row blocks the promotion"; "no row flagged after the write: a stale
primary_contact scalar is REMOVEd"; "an explicit primaryContact false on the
only primary row demotes it and REMOVEs the scalar"; "a soft-deleted contact
asked to be primary on a row that is not the primary:
PrimaryContactDeletedError, nothing written"; "a soft-deleted contact whose
row IS already the primary: re-sending primaryContact true is not refused
and changes nothing"; "(PIN) a soft-deleted contact added NON-primary stays
allowed"; "the liveness read is refreshed on every attempt: a live primary
that lands after attempt 1 blocks the promotion on the retry". Case (f)
retitled "(f) an edit of a contact already on an ownerless no-primary list
(%s, primaryContact false) makes THAT contact the primary".

- RED: PrimaryOnAdd `17 tests | 9 failed`, AutoPrimary `15 tests | 2 failed`
  (both (f) cases); `Tests  11 failed | 21 passed (32)`. No SKIPPED line.
- GREEN (with unitsRepoRoster 17, unitsRepoContactListRules 6):
  `Test Files  4 passed (4)`, `Tests  55 passed (55)`.

### S2.4 - add route + fake addContact (`unitsApiPrimaryOnAdd.test.ts` 17 tests; `unitsApiRosterAutoPrimary.test.ts` case (f) reversed; `unitsApiRoster.test.ts` seed `c-ll-1`)

New (FakeWorld): "470 Bolton: an edit of the only contact (typed landlord)
on an ownerless no-primary property makes them the primary, audited
auto_on_add"; "delete the primary, then add the replacement: the
replacement is promoted (...)"; "a soft-deleted landlord of record counts as
absent: an eligible add is promoted; landlordId stays"; "(PIN) a LIVE
landlord of record: the add joins non-primary and no auto_on_add row is
written"; "a contact NOT eligible (a tenant): nobody is promoted - ...";
"a write for one contact never promotes another eligible contact already on
the list"; "reads liveness for exactly the flagged primary and the landlord
of record - ONE complete batch read"; 2x "liveness unknown (%s): 200, the
add joins non-primary, and the route WARNs" (raw chunk error /
IncompleteBatchReadError); 409 describe: "making a soft-deleted contact
primary when its row is not the primary: 409 - nothing written, no audit";
"a NEW seat for a soft-deleted contact asked to be primary: 409 too";
"re-sending primaryContact true for a soft-deleted contact whose row IS the
primary: 200, nothing changes"; "(PIN) adding a soft-deleted contact
NON-primary stays allowed"; "order: an unknown contact answers 404
contact_not_found first"; "order: a soft-deleted caseworker taking a NEW
seat answers contact_list_caseworker first"; "order: a soft-deleted
non-landlord claiming the vacant landlord slot answers landlord_not_landlord
first"; "decided again in the roster write: the primary moved off the
deleted contact after the route read - 409, nothing written".

- RED: PrimaryOnAdd `17 tests | 9 failed`, RosterAutoPrimary `19 tests | 2 failed`;
  `Tests  11 failed | 25 passed (36)` - exactly the plan's list (`expected 1st "getManyByIds" call to have been called with [ [ 'c-dead', 'c-ll' ], ...(1) ]`,
  `expected undefined to match object { unitId: 'u-unknown', ...(1) }`, `expected 200 to be 409`).
- GREEN (with unitsApiRoster 25, unitsApiRosterTypeChecks 23,
  unitsApiActivity 11, unitsRestoreLandlord 32, placementsVoiceRouting 11):
  `Test Files  7 passed (7)`, `Tests  138 passed (138)`.

### S2.5 - removeContact heir (`unitsRepoPrimaryOnRemove.integration.test.ts` 9 tests; `unitsRepoRoster.integration.test.ts` imports + liveness stubs + 3 tests rewritten)

New (DynamoDB Local): "the live landlord of record takes over - flag and
scalar - and onPrimaryHandoff reports it once"; "an off-roster landlord of
record takes over: a landlord row is ADDED as the primary"; "no landlord of
record: the EARLIEST-added remaining eligible contact takes over - a tenant,
a soft-deleted landlord-typed contact and a caseworker are skipped"; "a
soft-deleted landlord of record is skipped for the earliest eligible roster
contact; landlordId stays"; "no heir (nobody eligible left): every flag
cleared, the scalar REMOVEd, no hand-off reported"; 2x "liveness unknown
(%s): RosterReadFailedError - nothing written" (the read failed / no read
was supplied); "(PIN) removing a NON-primary row reads no liveness - ...";
"(PIN) every attempt reads the unit CONSISTENTLY, and a retry decides the
heir again on its own read". unitsRepoRoster: the three removeContact-of-the-
primary tests now pass `EVERYONE_LIVE_LANDLORD` / `EVERYONE_LIVE_TENANT`.

- RED: PrimaryOnRemove `9 tests | 7 failed`, unitsRepoRoster `17 tests`
  all green (as the plan predicts); `Tests  7 failed | 19 passed (26)`.
  No SKIPPED line.
- GREEN (with unitsRepoContactListRules 6): `Test Files  3 passed (3)`,
  `Tests  32 passed (32)`.

### S2.6 - remove route + fake removeContact (`unitsApiPrimaryOnRemove.test.ts` 7 tests; `unitsApiRoster.test.ts` seed `c-ll-c`)

New (FakeWorld): "the live landlord of record takes over - flag and scalar -
audited handoff_on_remove"; "an off-roster landlord of record takes over
with a landlord row added as the primary"; "no landlord of record (470
Bolton): the earliest-added eligible contact takes over - a tenant and a
caseworker are skipped"; "no eligible contact left: every flag cleared, the
scalar removed, no hand-off event"; 2x "liveness unknown (%s): 503
roster_read_failed - nothing written, no audit"; "(PIN) removing a
NON-primary row needs no liveness: it succeeds even when every batch read
fails".

- RED: PrimaryOnRemove `7 tests | 5 failed` (`expected [] to deeply equal [ { entityKey: 'units#u-1', ...(3) } ]`,
  `expected [] to have a length of 1 but got +0`, `expected 200 to be 503`);
  unitsApiRoster 25 green; `Tests  5 failed | 27 passed (32)`.
- GREEN (with unitsApiRoster 25, unitsApiRosterTypeChecks 23,
  unitsApiActivity 11, unitsApiPrimaryOnAdd 17): `Test Files  5 passed (5)`,
  `Tests  83 passed (83)`.

## 4. Shipped contracts S2b builds on (exact)

`app/src/repos/unitsRepo.ts`:

```ts
import { applyPrimary, chooseHeir, rosterContactIds, type RosterContactsRead } from '../lib/propertyContact.js'; // (multi-line in the file)
import { isDeleted as isContactDeleted } from './contactsRepo.js';

export interface ContactListFacts {
  caseworker: boolean;
  landlordTyped: boolean;
  autoPrimaryEligible: boolean;   // docblock now points at lib/propertyContact.ts isAutoRoutingEligible
  contactDeleted?: boolean;       // NEW; absent = not deleted
}

export class RosterReadFailedError extends Error {}      // name 'RosterReadFailedError'; route 503 { error: 'roster_read_failed' }
export class PrimaryContactDeletedError extends Error {} // name 'PrimaryContactDeletedError'; route 409 { error: 'primary_contact_deleted' }

export type ReadRosterContacts = (ids: string[]) => Promise<RosterContactsRead>;
export interface PrimaryHandoff { from: string; to: string; }
export interface RosterHandoffOpts {
  readContacts?: ReadRosterContacts;                     // per attempt; absent = liveness unknown
  onPrimaryHandoff?: (handoff: PrimaryHandoff) => void;  // once, after the successful write, only when an heir was flagged
}
export type PrimaryHandOffResult =                       // declared for S2.9 handOffPrimaryFrom; not used yet
  | { outcome: 'moved'; unit: UnitItem; to: string }
  | { outcome: 'unchanged' | 'not_primary' | 'unknown' };
export interface AutoPrimaryArgs {
  roster: readonly UnitContact[]; landlordId: string | undefined;
  contactId: string; eligible: boolean; requested: boolean;
}
export function autoPrimaryLivenessIds(args: AutoPrimaryArgs): string[] | null;
export function decideAutoPrimary(
  args: AutoPrimaryArgs & { read: RosterContactsRead | undefined },
): 'promote' | 'keep' | 'unknown';

// UnitsRepo
addContact(unitId, contact, facts: ContactListFacts, opts?: { readContacts?: ReadRosterContacts }): Promise<UnitItem>;
removeContact(unitId: string, contactId: string, opts?: RosterHandoffOpts): Promise<UnitItem>;
```

Semantics as shipped:

- `autoPrimaryLivenessIds`: null when X is not eligible, the request asks
  for primary, X is the landlord of record, or X's row is the flagged
  primary; else [flagged primary id, landlordId] de-duplicated (empty =
  nothing flagged and no landlord: promote with no read).
- `decideAutoPrimary`: null ids -> 'keep'; [] -> 'promote'; read undefined
  or `{ ok: false }` -> 'unknown' (no promotion); else 'keep' if any id is
  a LIVE record (present and not `isDeleted`), else 'promote'.
- `addContact` (real and fake, same order): I4 -> I3 ->
  PrimaryContactDeletedError (`contact.primaryContact === true &&
  facts.contactDeleted === true && existing?.primaryContact !== true`) ->
  LandlordReassignmentRequiredError -> P2 decision. `opts.readContacts` is
  called only when the ids list is non-empty, per attempt (a retry re-reads).
  Scalar: `primary_contact` = the flagged row's id, else REMOVEd (null in
  the patch). Its log line adds `autoPrimaryUnknown: true` on 'unknown'.
  No `onPrimaryHandoff` on add: the route derives `auto_on_add` from the
  written row (`effectivePrimary && !primaryContact`), payload
  `{ actor, contactId, reason: 'auto_on_add' }`, no `from` (R7).
- `removeContact` (real): every attempt reads the unit CONSISTENTLY (and
  the CCF re-read too). Non-primary row: no liveness read. Primary row:
  `read = opts.readContacts(rosterContactIds(unit).filter(id => id !== removed))`
  (or `{ ok: false }` when absent) -> `chooseHeir({ roster, landlordId,
  exclude: removed, read })` -> unknown throws RosterReadFailedError before
  any write -> `applyPrimary(remaining, heir|null)` sets contacts + scalar
  (null = REMOVE). `onPrimaryHandoff({ from: removed, to: heir })` is called
  once after the successful conditional write, only for kind 'heir' (a
  clear reports nothing). The fake mirrors it with the same three pure
  functions (no twin logic).
- Routes: add passes `readContacts: (ids) => readRosterContacts(contacts,
  ids, log)` plus a WARN `unit contact add: the liveness read failed -
  auto-primary skipped` on `{ ok: false }`; 409 `primary_contact_deleted`
  from the route check (after 404s, I4, I3) and from the repo error.
  Remove passes `readContacts` + `onPrimaryHandoff`; RosterReadFailedError
  -> WARN `unit contact remove refused: the liveness read failed` + 503
  `{ error: 'roster_read_failed' }`; a hand-off appends
  `unit_primary_contact_assigned { actor, contactId: to, reason:
  'handoff_on_remove', from }` after `unit_contact_removed`.
- `routes/units.ts` propertyContact import as of 2bbceeab (ruling R2; the
  alias stays for `soleLandlordToPromote` at :445/:462 until S2.8):

```ts
import {
  isAutoRoutingEligible,
  isAutoRoutingEligible as autoRoutingEligible,
  readRosterContacts,
} from '../lib/propertyContact.js';
```

  The contactsRepo import again carries `isDeleted as isContactDeleted`;
  the unitsRepo import gained `PrimaryContactDeletedError`,
  `RosterReadFailedError` and `type PrimaryHandoff`. The harness imports
  `autoPrimaryLivenessIds`, `decideAutoPrimary`, `PrimaryContactDeletedError`,
  `RosterReadFailedError` from unitsRepo and `applyPrimary`, `chooseHeir`,
  `rosterContactIds`, `type RosterContactsRead` from propertyContact (a
  NEW import block after the unitMedia import; S1 had added none).

## 5. Divergences from the plan text

- D1 (worklist delta S2-F4 / S1-F2, applied as instructed). S2.3's two new
  scalar comments fold in "live": the addContact interface docblock part (b)
  ends "(nothing routes on the scalar: the property-contact lookup,
  lib/propertyContact.ts, takes the LIVE row marked primary, else the LIVE
  landlord of record, skipping a soft-deleted or missing contact)", and the
  write-region comment says "the property-contact lookup,
  lib/propertyContact.ts, takes the LIVE row marked primary, else the LIVE
  landlord of record". Every other S2.3 line is byte-identical to the plan
  (script-verified: plan 4857-4874, 4892-4894, 4897-4899, 4912-4914,
  4925-5041, 5050-5100 each found once).
- D2 (brief / research correction, no impact). The target files are LF in
  the working tree, not CRLF: `git ls-files --eol` shows `i/lf w/lf
  attr/text=auto eol=lf`, and `tr -cd '\r' | wc -c` is 0. The research
  reference's "1383/1383 lines carry CR" comes from a Git Bash
  `grep -c $'\r$'` that matches every line (the CR is lost from the
  argument, leaving the pattern `$`). Nothing was converted.
- D3 (method). The five NEW test files were created by byte-exact
  extraction of the plan's fenced blocks (`sed -n` over plan lines
  3925-4043, 4285-4738, 5153-5523, 6102-6458, 6788-7002) instead of
  retyping them; every existing file was changed with the Edit tool. All
  new/edited lines are ASCII (checked by script on each commit).
- D4 (RED shape). S2.3 RED had 11 failures, one more than the plan names:
  "a flagged primary whose contact record is MISSING counts as absent" (same
  cause; the plan's list says "include"). S2.5's retry test failed at its
  contacts assertion (`expected [ Array(2) ] to deeply equal [ Array(2) ]`,
  test :347) before the `liveness.calls` assertion the plan names - same
  root cause (the old code never hands off).
- D5. S2.6 (d)'s merge clause did not apply (S1 added no propertyContact
  import to the harness); the import block was added as written.
- D6. Extra, non-gate evidence runs (section 8): neighbor suites, `npm run
  smoke`, a plain-Node ESM load in both orders, and eslint on the touched
  files.

## 6. Cycle safety (ruling R3)

TypeScript-AST check (`ts.createSourceFile`, every top-level statement
walked, function bodies skipped as deferred):

- `app/src/repos/unitsRepo.ts`: value imports from propertyContact =
  [applyPrimary, chooseHeir, rosterContactIds] -> NO top-level read. Top
  level: 14 imports, 5 type aliases, 11 interfaces, 7 classes, 6 function
  declarations, 4 variable statements, 1 re-export.
- `app/src/lib/propertyContact.ts`: value import from unitsRepo =
  [unitContacts] -> NO top-level read (3 imports, 14 functions, 4 type
  aliases).
- Negative control: the same check on unitsRepo.ts against `statusModel`
  flags `:60 LISTING_STATUSES` and `:63 SHAREABLE` (the known, harmless
  reads), so the checker does see top-level reads. contactsRepo.ts imports
  neither unitsRepo nor propertyContact (no second cycle).
- Runtime: the compiled `app/dist` modules load under plain Node ESM in
  BOTH orders (propertyContact -> unitsRepo and unitsRepo ->
  propertyContact), each exit 0, with cross-module calls working
  (`rosterContactIds({ landlordId: 'c-ll' })` -> `["c-ll"]`,
  `decideAutoPrimary(...)` -> `promote`). Under vite-node, S1's
  propertyContact tests (which load that module first) pass with the
  runtime cycle in place (section 8).

## 7. Worries for the orchestrator (non-blocking)

- W1. The add-route header comment is the plan's S2.4 (d) text verbatim and
  still says "the roster resolvers take the row marked primary, else the
  landlord of record" without "live" (the delta named only S2.3's text).
  The `UnitContact` docblock (`unitsRepo.ts:65-77`) and the
  `primary_contact` docblock (above `unitsRepo.ts:484`) are S2.13's per the
  delta. S2b's comment sweep may want the route comment too.
- W2. Two WARNs per failed liveness read: `readRosterContacts` logs
  `property contact: roster liveness read failed - liveness unknown` (with
  err), then the route logs its own ids-only line. On the add path that
  happens per attempt (up to 3x under write contention).
- W3. Now live through the real route (S5's e2e sees it): a contact-list
  write on a unit whose `landlordId` names NO record or a soft-deleted one,
  with no live flagged row, promotes the eligible written contact - an
  edit of an existing row included; an explicit `primaryContact: false` on
  X's own primary row REMOVEs the scalar; any write that leaves no row
  flagged REMOVEs a stale scalar. `unitsApiRoster`'s add test needed its
  landlord seeded for exactly this reason (S2.4 (c)).
- W4. The FakeWorld `getManyByIds` ignores its options; only
  unitsApiPrimaryOnAdd's spy pins `{ requireComplete: true }` on the add
  path. The remove path has no such spy pin (both routes go through S1's
  `readRosterContacts`, which pins it). Low risk.
- W5. Ruling R2 state for S2.8: units.ts still has the alias import and
  `soleLandlordToPromote` calls `autoRoutingEligible` at :462; S2.8 drops
  the alias, and S3.5 3a expects the single line `import { chooseHeir,
  isAutoRoutingEligible, readRosterContacts } from '../lib/propertyContact.js';`.
- W6. The extra smoke run rebuilt the gitignored `app/dist/`.

## 8. Interim gate (bare, output under `.superpowers/sdd/`, real exit codes)

1. `cd W:/tmp/primary-contact-integrity && npm run typecheck`
   -> `EXIT:0`; 0 `error TS` lines; all five workspaces ran (app: src,
   scripts and tests). Log `S2a-gate-typecheck.log`.
2. `cd app && npx vitest run` on the 11 test files this dispatch created or
   edited -> `EXIT:0`; `Test Files  11 passed (11)`,
   `Tests  213 passed (213)`; no `[dynamoAdmin]` line; no SKIPPED line.
   Per file: unitFields 40, unitsApi 29, unitsRepoAutoPrimaryDecision 18,
   unitsRepoPrimaryOnAdd.integration 17, unitsRepoAutoPrimary.integration
   15, unitsApiPrimaryOnAdd 17, unitsApiRosterAutoPrimary 19,
   unitsApiRoster 25, unitsRepoPrimaryOnRemove.integration 9,
   unitsRepoRoster.integration 17, unitsApiPrimaryOnRemove 7. Log
   `S2a-gate-vitest.log`.

Extra evidence (not gate steps):

- Neighbors + S1 cycle-order files (unitsRepoContactListRules 6,
  unitsApiRosterTypeChecks 23, unitsApiActivity 11, unitsRestoreLandlord
  32, placementsVoiceRouting 11, caseworkerRepoParity.integration 44,
  propertyContact 10, propertyContactHeir 17, propertyContactLookup 18,
  autoRoutingEligibleSingleSource 2, propertyContactLadderSingleSource 1)
  -> `EXIT:0`, `Test Files  11 passed (11)`, `Tests  175 passed (175)`, no
  `[dynamoAdmin]` line. Log `S2a-extra-neighbors.log`.
- `npm run smoke` -> `EXIT:0`, `smoke-dist: OK - 1673 import specifier(s)
  across 290 emitted file(s) resolve under plain Node.` Log
  `S2a-extra-smoke.log`.
- Plain-Node ESM load in both orders -> `EXIT:0` twice. Log
  `S2a-extra-esm-cycle.log`.
- `npx eslint` on the 15 touched files (`git diff --name-only
  --diff-filter=d cbbf3ac2..HEAD` filtered to code) -> `EXIT:0`, empty
  output. Log `S2a-extra-eslint.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`,
six S2a commits on top of cbbf3ac2 (this report is the seventh).

Next step for S2b: Task S2.7 (`restoreWithLandlord` swap re-runs the heir
function; `RosterHandoffOpts` is its third parameter), opening the second
mid-slice 500 window that S2.8 closes.
