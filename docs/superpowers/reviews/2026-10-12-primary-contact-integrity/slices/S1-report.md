# S1 slice report - app lookup + heir

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 6c68f342.
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S1.1-S1.8 (sections 0-3 and the 3.2 rulings binding), plus the "S1
additions" in `research/worklist-deltas.md`. Implementer: Claude Opus 5.5,
alone in the worktree. Date: 2026-10-13.

Environment checks before the first vitest run: `env | grep '^AWS_'`
printed nothing (exit 1 - no AWS key exported). DynamoDB Local
(`hc-dynamodb-local`) was already Up; it was never started, stopped,
restarted or reseeded. `node_modules` was present, so the plan's `npm ci`
precondition was not needed.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S1.1 | c28493f5 | feat(app): lib/propertyContact - the shared automatic-routing rule and the roster liveness read (primary-contact-integrity S1.1) |
| S1.2 | 857355d6 | feat(app): one property-contact lookup - decidePropertyContact and resolvePropertyContact skip a deleted or missing contact (spec 4.1) |
| S1.3 | 71308064 | feat(app): the heir function and applyPrimary - one rule for every automatic primary choice (spec 4.3) |
| S1.4 | bcb6f834 | refactor(app): units routes use the shared automatic-routing eligibility rule from lib/propertyContact |
| S1.5 | e7710793 | fix(app): tour reminder and relay intro copy skip a deleted property contact via the shared lookup (spec 4.1) |
| S1.6 | 03b058e9 | fix(app): the default people list skips a deleted property contact and keeps the bare row on a failed read; correct the memberFromContact docblock (spec 4.1) |
| S1.7 | d95feb1e | fix(app): roster-open diagnostics read the property contact through the shared lookup, codes and texts unchanged per state (spec 4.1) |
| S1.8 | (none) | slice gate - no code change |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent,
explicit paths only, `Co-Authored-By: Claude Opus 5.5` trailer.
`npm run typecheck` after each task's commit: exit 0 every time (S1.1-S1.6
logs `.superpowers/sdd/S1-typecheck-S1.<n>.log`; the S1.8 gate typecheck ran
directly on the S1.7 commit with nothing in between).

## 2. Files touched

Source (5):

- `app/src/lib/propertyContact.ts` (NEW)
- `app/src/routes/units.ts` (ONLY the two import statements and the
  deleted `autoRoutingEligible` definition - ruling R2 alias, call sites
  byte-identical, `isDeleted as isContactDeleted` import dropped)
- `app/src/lib/tourContacts.ts`
- `app/src/lib/rosterResolution.ts`
- `app/src/services/rosterProvision.ts`

Tests (10): NEW `propertyContact.test.ts`, `propertyContactLookup.test.ts`,
`propertyContactHeir.test.ts`, `autoRoutingEligibleSingleSource.test.ts`,
`relayIntroPropertyContact.test.ts`,
`rosterPlanMaterializePropertyContact.test.ts`,
`rosterProvisionPropertyContact.test.ts`,
`propertyContactLadderSingleSource.test.ts`; EDITED `tourContacts.test.ts`,
`rosterResolution.test.ts` (all under `app/test/`).

`git diff --name-only --diff-filter=d main...HEAD` for source extensions
lists exactly these 15 files. No file outside the brief's list was edited.

## 3. Tests added and RED/GREEN evidence

Every new test file and every edit was checked byte-for-byte against the
plan's code block (`diff` of the plan's fenced lines against the file; the
plan's new_string blocks found exactly once in the edited source).

### S1.1 - `propertyContact.test.ts` (10 tests)

isAutoRoutingEligible: "is true for an existing, live, landlord-typed,
non-pointer contact"; "is false for a missing, soft-deleted, non-landlord or
routing-pointer contact". rosterContactIds: "lists every roster row in
order, then an OFF-roster landlord of record"; "de-duplicates a landlord of
record that already has a row"; "covers a landlord-only unit through its
DERIVED row (no stored roster)"; "drops an empty or absent landlordId".
readRosterContacts: "reads the de-duplicated, non-empty ids ONCE with
requireComplete"; "reads nothing at all for no usable ids"; "a RAW chunk
error is liveness UNKNOWN (ok: false), never a throw - logged with a count
only"; "an IncompleteBatchReadError is liveness UNKNOWN too (spec 4.2: BOTH
failure shapes)".

- RED: `Failed to load url ../src/lib/propertyContact.js` ...
  `Test Files  1 failed (1)`, `Tests  no tests`.
- GREEN: `Test Files  1 passed (1)`, `Tests  10 passed (10)`.

### S1.2 - `propertyContactLookup.test.ts` (18 tests)

17 table cases, each run through BOTH decidePropertyContact and
resolvePropertyContact (same answer, same reads in order): live flagged
primary found / landlord never read; zero-primary falls back to the live
landlord; landlord-only unit via the derived row, read once; DELETED primary
skipped to the live landlord; primary with NO record skipped like a deleted
one; deleted primary + deleted landlord -> nobody deleted; deleted SOLE
primary, no landlord -> nobody deleted; deleted landlord-only unit is ONE
candidate, read once; no flagged row and no landlord -> nobody none, nothing
read; EMPTY-STRING landlordId never read; flagged row with EMPTY contactId is
no candidate; primary IS the tenant -> is_tenant before any read; deleted
primary then landlord IS the tenant -> is_tenant; no tenant given / EMPTY
tenant id -> no tenant test; THROWING primary read stops the walk
(read_failed names it); deleted primary + THROWING landlord read ->
read_failed names the landlord. Plus "logs the failed candidate with ids
only and returns read_failed".

- RED: `TypeError: (0 , decidePropertyContact) is not a function` /
  `(0 , resolvePropertyContact) is not a function`;
  `Test Files  1 failed (1)`, `Tests  18 failed (18)`.
- GREEN (with S1.1's file): `Test Files  2 passed (2)`,
  `Tests  28 passed (28)`.

### S1.3 - `propertyContactHeir.test.ts` (17 tests)

chooseHeir (10): unknown on a failed read; live landlord wins ahead of an
earlier eligible row; landlord NOT type-tested; OFF-roster landlord is the
heir with addLandlordRow; deleted/missing/EXCLUDED landlord falls to the
earliest-added eligible row; never picks tenant-typed, caseworker or
pointer rows; skips deleted, record-less and excluded rows; the heir if a
landlord PRIMARY were removed never names the landlord; none
no_live_candidate; none no_eligible_candidate. applyPrimary (7): flags
exactly the heir and returns the scalar; APPENDS the off-roster landlord
row; never duplicates an existing row; null clears every flag and the
scalar; keeps name/company and never mutates its input; THROWS for an heir
with no row and addLandlordRow false; composes with chooseHeir.

- RED: `TypeError: (0 , chooseHeir) is not a function` (11) /
  `(0 , applyPrimary) is not a function` (5); `Tests  17 failed (17)`.
- GREEN (three files): `Test Files  3 passed (3)`, `Tests  45 passed (45)`.

### S1.4 - `autoRoutingEligibleSingleSource.test.ts` (2 tests)

"no module outside lib/propertyContact.ts defines it"; "lib/propertyContact.ts
does define it (the pin is not vacuous)".

- RED: `expected [ 'routes\units.ts' ] to deeply equal []`;
  `Tests  1 failed | 1 passed (2)`.
- GREEN (with unitsApiRosterAutoPrimary 19, unitsApiRosterTypeChecks 23,
  unitsApiRoster 25, unitsRestoreLandlord 32): `Test Files  5 passed (5)`,
  `Tests  101 passed (101)`.

### S1.5 - `tourContacts.test.ts` (edited; 15 tests) and `relayIntroPropertyContact.test.ts` (4 tests)

tourContacts: existing "resolves the roster PRIMARY and the tenant, first
and full names" now asserts `propertyContact`; new "a DELETED primary is
skipped: the names and the en-route body come from the landlord of record";
"a deleted SOLE primary with no landlord of record is NO property contact
(reason deleted)"; "a primary with NO record (an import retract
hard-deletes) falls through to the landlord like a deleted one"; "exposes
the shared lookup answer for every outcome - and none at all without a
unit". relayIntro: "a DELETED primary: the tour intro names the landlord of
record, never the deleted contact"; "a DELETED primary: the placement intro
does the same"; "a deleted SOLE primary with no landlord of record: the
general intro, never naming it"; "a primary with NO record falls through to
the landlord of record".

- RED: tourContacts `15 tests | 5 failed`; relayIntro `4 tests | 4 failed`
  (`expected 'Dana' to be 'Marcus'`, `expected 'tour' to be 'naked'`,
  `expected 'naked' to be 'tour'`); `Tests  9 failed | 10 passed (19)`.
- GREEN (with tourCopy 27, relayFanOut 152, tourRemindersApi 69,
  contactTimeline 65, rosterEdits 22): `Test Files  7 passed (7)`,
  `Tests  354 passed (354)`.

### S1.6 - `rosterResolution.test.ts` (edited; +5 tests) and `rosterPlanMaterializePropertyContact.test.ts` (2 tests)

rosterResolution new describe: "a DELETED primary is not on the list - the
live landlord of record takes its slot"; "a deleted SOLE primary with no
landlord of record leaves the tenant alone - never the deleted phone"; "a
primary with NO record is skipped like a deleted one (the importer
hard-deletes)"; "a deleted primary, then the landlord IS the tenant: the
tenant alone, one slot"; "(PIN) a THROWING property-contact read keeps the
BARE row for that candidate and never falls through". Materialize: "a
DELETED primary is never written into the plan - the landlord of record
is"; "(PIN) a THROWING property-contact read keeps the candidate as a bare
entry - the plan never loses it".

- RED: rosterResolution `34 tests | 4 failed` (the PIN green before and
  after, as planned); materialize `2 tests | 1 failed`;
  `Tests  5 failed | 31 passed (36)`.
- GREEN (with rosterEdits 22, toursApi 230, placementsApi 56,
  placementsRelay 23, rosterActionsPoll 29, placementNudges 39,
  tourRemindersApi 69): `Test Files  9 passed (9)`,
  `Tests  504 passed (504)`. No pre-existing test failed on the stated
  behavior change, so nothing needed the plan's STOP-and-report.

### S1.7 - `rosterProvisionPropertyContact.test.ts` (12 tests) and `propertyContactLadderSingleSource.test.ts` (1 test)

Tour (7): none -> "unit has no landlord (cannot resolve landlord)"; deleted
SOLE primary -> "landlord contact not found"; deleted primary AND deleted
landlord -> "landlord contact not found"; deleted primary resolves PAST it
to the live landlord (no refusal); (PIN) live primary without a phone ->
"landlord contact has no phone"; (PIN) is_tenant -> the too-thin text;
(PIN) a THROWING read is thrown out as the SAME error. Placement (5): (PIN)
none -> landlord_unreachable; deleted SOLE primary -> landlord_unreachable;
deleted primary resolves PAST it (no refusal); (PIN) is_tenant ->
relay_member_unresolvable; (PIN) a THROWING read is re-thrown. Ladder: "no
module outside lib/propertyContact.ts re-derives it".

- RED: rosterProvision `12 tests | 3 failed` (the two tour "deleted"
  cases answered `this tour roster has fewer than two reachable members`;
  the placement "deleted" case answered `relay_member_unresolvable`);
  ladder `1 test | 1 failed` listing exactly
  `services\rosterProvision.ts: primaryContact === true\)\?\.contactId\s*\?\?`;
  `Tests  4 failed | 9 passed (13)`.
- GREEN (with toursApi 230, placementsApi 56, placementsRelay 23,
  rosterActionsPoll 29): `Test Files  6 passed (6)`,
  `Tests  351 passed (351)`. The four named API tests passed UNCHANGED
  (verbose `-t` run): toursApi "400 relay_member_unresolvable naming the
  tenant when the tenant contact has no phone" and "... names each missing
  rung of the resolution ladder"; placementsRelay "400s when the tenant has
  no phone on file (never a half-roster relay)" and "400s when the unit
  landlord has no phone on file".

## 4. `app/src/lib/propertyContact.ts` as shipped - exported surface

Byte-identical to plan contract 2.1 (no signature drift). Top level holds
only imports, `function` declarations and `type` aliases (ruling R3).
Imports: VALUE `isDeleted` from `../repos/contactsRepo.js`, VALUE
`unitContacts` from `../repos/unitsRepo.js`, VALUE default `logger` from
`./logger.js` (types `ContactItem`, `ContactsRepo`, `UnitContact`,
`UnitItem`, `Logger`).

```ts
export function isAutoRoutingEligible(contact: ContactItem | undefined): boolean;

export type RosterContactsRead =
  | { ok: true; byId: Map<string, ContactItem> }
  | { ok: false };

export async function readRosterContacts(
  contacts: Pick<ContactsRepo, 'getManyByIds'>,
  ids: Iterable<string | undefined>,
  logger?: Logger,
): Promise<RosterContactsRead>;

export function rosterContactIds(unit: Pick<UnitItem, 'contacts' | 'landlordId'>): string[];

export type PropertyContactResult =
  | { kind: 'found'; contactId: string; contact: ContactItem }
  | { kind: 'nobody'; reason: 'none' | 'deleted' | 'is_tenant' }
  | { kind: 'read_failed'; candidateId: string };

export function decidePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  lookup: (contactId: string) => { ok: true; contact: ContactItem | undefined } | { ok: false };
}): PropertyContactResult;

export async function resolvePropertyContact(args: {
  unit: Pick<UnitItem, 'contacts' | 'landlordId'>;
  tenantId?: string;
  contactsRepo: Pick<ContactsRepo, 'getById'>;
  logger?: Logger;
}): Promise<PropertyContactResult>;

export type HeirResult =
  | { kind: 'heir'; contactId: string; addLandlordRow: boolean }
  | { kind: 'none'; why: 'no_live_candidate' | 'no_eligible_candidate' }
  | { kind: 'unknown' };

export function chooseHeir(args: {
  roster: readonly UnitContact[];
  landlordId: string | undefined;
  exclude?: string;
  read: RosterContactsRead;
}): HeirResult;

export function applyPrimary(
  roster: readonly UnitContact[],
  heir: { contactId: string; addLandlordRow: boolean } | null,
): { contacts: UnitContact[]; primaryContactScalar: string | null };
```

Behavior notes S2/S3 build on (all pinned by the tests above):

- `readRosterContacts` makes exactly ONE
  `getManyByIds(uniqueNonEmptyIds, { requireComplete: true })` call, and
  ZERO calls for an empty id list (S1-F8; R15 tolerates it). Any throw ->
  `{ ok: false }` plus one WARN `property contact: roster liveness read
  failed - liveness unknown` with `requested` (count). Never throws.
- `rosterContactIds` = every `unitContacts()` row in order, then an
  off-roster `landlordId`; de-duplicated; empty ids dropped.
- `resolvePropertyContact` reads LAZILY (landlord only when the primary was
  skipped); a throw -> WARN `property contact: candidate read failed -
  lookup stops` with `candidateId`, answered `read_failed`. Never throws.
  A flagged row whose `contactId` is `''` is no candidate (falls to the
  landlord).
- `chooseHeir`: `exclude` counts as not live at every step; on
  `{ ok: true }` an id absent from `byId` is MISSING - so the read must be
  of the same unit snapshot, refreshed per attempt.
- `applyPrimary` THROWS `applyPrimary: heir <id> has no roster row and
  addLandlordRow is false` (R4a); the appended landlord row carries no
  name/company (R4b).
- `ResolvedTourNames.propertyContact?: PropertyContactResult`
  (`app/src/lib/tourContacts.ts:39`) is PRESENT exactly when a unit was
  passed (R1); `propertyReadFailed === (propertyContact?.kind ===
  'read_failed')`.
- `routes/units.ts:87` imports `isAutoRoutingEligible as
  autoRoutingEligible` (R2); call sites `:455` (soleLandlordToPromote) and
  `:1231` (add route) unchanged.

## 5. Divergences from the plan text

1. S1.6 docblocks, from the worklist deltas (the plan's own edits were
   applied verbatim first; these are additional):
   - `memberFromContact` docblock (`app/src/lib/rosterResolution.ts:200-220`,
     S1-F6): the plan's closing sentence ("The property DEFAULT below never
     adds one as its property contact") became a separate paragraph saying
     the default skips a soft-deleted OR record-less (missing) candidate,
     never adding either (not even as a bare row), and that only a THROWN
     property-contact read keeps a bare row there.
   - `RosterResolutionDeps` docblock (`rosterResolution.ts:137-169`,
     S3-F8): a new docblock on `contacts` describing the contact read
     (memberFromContact, describeRoster's names / removed-contact roles /
     opt-outs, the preview composer's names, and the DEFAULT's lazy read
     through resolvePropertyContact); and the omitted-reads sentence now adds
     that the tour and placement OPEN previews report it through
     `introFallback` reasons including `lookup_failed` (spec 5.1). See
     worry W1.
   - The S1.6 commit carries one extra body line naming the deltas; the
     subject is the plan's.
2. S1.8 step 3 (the whole app workspace `npx vitest run`) was NOT run: the
   mission brief forbids the full suite and defines the slice gate as
   typecheck plus the touched test files. Steps 1, 2 (the plan's 24-file
   list, a superset of the 10 touched files) and 4 (eslint) were run. An
   extra `npm run smoke` was run as evidence for the new module's ESM
   imports (not part of the gate).
3. Per the brief, `npm run typecheck` also ran after every task's commit
   (the plan asks for it only at S1.8). All exit 0.
4. The plan's `npm ci` precondition was skipped: dependencies were
   installed (`node_modules/vitest/package.json` present).

No code divergence: every plan code block landed byte-identical, every
predicted RED matched the plan's description, every GREEN matched its
expected counts.

## 6. Worries for the orchestrator (non-blocking)

- W1. The `RosterResolutionDeps` docblock now describes S3.1's
  `introFallback` / `lookup_failed` reporting before S3 lands (the delta
  assigned it to S1 because S1 is the only slice that owns
  `rosterResolution.ts`). S3's reviewer should confirm the sentence at
  `rosterResolution.ts:162-166` against the shipped S3.1 rules; if they
  differ, S3 needs explicit leave to touch that docblock.
- W2. Logging shape changed on a THROWN property-contact read: the lookup
  WARNs once with `err` (`property contact: candidate read failed - lookup
  stops`), then each caller logs its own line WITHOUT `err` -
  `tour names: property contact read failed` (it used to carry `err`), and
  the default roster's `roster resolution: property contact read failed -
  bare row kept` (the old line for that path was `roster resolution:
  contact read failed - bare row kept`, with `err`). The rosterProvision
  diagnostics re-throw the same error after the lookup's WARN, so the
  route/poller logs it again. Anything keyed on the old message for the
  default branch would miss it.
- W3. Known consequence (S1-F6), relevant to S4 and live self-QA: a plan
  materialized while its primary was live, whose primary is later
  soft-deleted, now reads `customized: true` in describeRoster (the default
  no longer equals the plan).
- W4. Read count: whenever the flagged primary is soft-deleted or has no
  record, every reader now makes one more `getById` (the landlord of
  record). By design (lazy walk); a healthy property costs the same reads.
- W5. Checked, no action: S2.8's "no bare `autoRoutingEligible`" grep will
  not trip on the two comments that still name it
  (`routes/units.ts:1122`, `:1196`) - S2.4 (d) replaces that whole add-route
  region including its comment block, and S2.8 (b) deletes
  `soleLandlordToPromote` with its docblock (`:428`). Still owed by S2:
  `repos/unitsRepo.ts` `ContactListFacts.autoPrimaryEligible` docblock
  points at routes/units.ts `autoRoutingEligible` (planner note); by S5.8:
  `e2e/scenarios/steps.ts:38-41` (S1-F1).
- W6. The extra smoke run left a gitignored `app/dist/` in the worktree;
  gate 3 rebuilds it anyway.

## 7. S1.8 slice gate (bare, output to `.superpowers/sdd/`, real exit codes)

1. `cd W:/tmp/primary-contact-integrity && npm run typecheck`
   -> `EXIT:0`; 0 `error TS` lines; all five workspaces ran (app: src,
   scripts and tests). Log `S1.8-gate-typecheck.log`.
2. `cd app && npx vitest run` on the plan's 24 files -> `EXIT:0`;
   `Test Files  24 passed (24)`, `Tests  926 passed (926)`; no
   `[dynamoAdmin]` line. Per file: propertyContact 10, propertyContactLookup
   18, propertyContactHeir 17, autoRoutingEligibleSingleSource 2,
   propertyContactLadderSingleSource 1, tourContacts 15,
   relayIntroPropertyContact 4, rosterResolution 34,
   rosterPlanMaterializePropertyContact 2, rosterProvisionPropertyContact
   12 (the 10 S1 files: 115 tests); unitsApiRosterAutoPrimary 19,
   unitsRestoreLandlord 32, unitsApiRosterTypeChecks 23, unitsApiRoster 25,
   toursApi 230, placementsApi 56, placementsRelay 23, tourRemindersApi 69,
   tourCopy 27, relayFanOut 152, rosterEdits 22, contactTimeline 65,
   rosterActionsPoll 29, placementNudges 39 - all passed, 0 failed, 0
   skipped. Log `S1.8-gate-vitest.log`.
3. Whole app workspace: NOT RUN (brief; divergence 2).
4. `npx eslint` on the 15 S1 files -> `EXIT:0`, empty output (log
   `S1.8-gate-eslint.log`, 0 bytes). No baseline comparison needed.
5. Extra: `npm run smoke` -> `EXIT:0`, `smoke-dist: OK - 1671 import
   specifier(s) across 290 emitted file(s) resolve under plain Node.`

`git status` after the gate: clean on `feat/primary-contact-integrity`,
seven S1 commits on top of 6c68f342 (this report is the eighth commit).
