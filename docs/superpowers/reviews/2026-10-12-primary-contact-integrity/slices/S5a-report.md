# S5a slice report - script, repo write and dev seam (S5.1-S5.5)

Kind: SLICE REPORT (mission record). Branch `feat/primary-contact-integrity`,
worktree `W:\tmp\primary-contact-integrity`, base 6643b6b7 (S4b report).
Plan: `docs/superpowers/plans/2026-10-13-primary-contact-integrity.md`
Tasks S5.1-S5.5 (sections 0-3 and the 3.2 rulings binding; R3, R22 and R23
applied), plus the "S5 additions" of `research/worklist-deltas.md` that fall
in S5.1-S5.5. Tasks S5.6-S5.12 (e2e specs, docs, completion gates) are the
next dispatch and were NOT started. Implementer: Claude Opus 5.5, alone in
the worktree. Date: 2026-10-13.

Environment checks before the first vitest run: `env | grep '^AWS_'`
printed nothing (exit 1 - no key exported). DynamoDB Local
(`hc-dynamodb-local`) was already Up; it was never started, stopped,
restarted or reseeded (the plan's `npm run db:start` was not run - see D5).
No `npm test`, `npm run e2e`, `npm run e2e:session` or `npm run dev` was
run. The script was never run against anything but DynamoDB Local (no
`--env dev` / `--env prod` execution). No background command was left
running.

## 1. Commits

| task | commit | subject |
|---|---|---|
| S5.1 | 08f7de11 | feat(units): assignPrimaryIfCurrent - the one-time primary script's conditional write (no re-read, no retry) |
| S5.2 | b6ff0938 | feat(scripts): assign-primary-contacts planner - targets, scalar alignment and counts from the shared heir function |
| S5.3 | dd5ee6c8 | feat(scripts): assign-primary-contacts run - consistent Scan, conditional writes, backfill audit events, counts and summary |
| S5.4 | f69d6636 | feat(scripts): assign-primary-contacts CLI - --env dev\|prod, dry run by default, --apply, exit codes 0/1/2 |
| S5.5 | a155f3b9 | feat(dev): /__dev/fixtures/zero-primary-property - a NEW property with no primary contact and no landlord of record, for e2e |

Every commit: gating bare `git status` read first, `MERGE_HEAD` absent
(`git rev-parse --git-path MERGE_HEAD`), explicit paths only, the plan's
subject, the `Co-Authored-By: Claude Opus 5.5` trailer. The S5.4 commit
carries one extra body line naming the added integration test (D2). `npm run
typecheck` (root, all five workspaces) on each task's tree: exit 0, 0 `error
TS` lines every time (logs `.superpowers/sdd/S5a-typecheck-S5.<n>.log`; run
after GREEN and before the commit, on exactly the committed content).

## 2. Files touched

Source (4):

- `app/src/repos/unitsRepo.ts` - ONLY the additive `assignPrimaryIfCurrent`
  interface member (after `rewriteAcceptedAuthorities`, with its docblock)
  and its implementation (after `rewriteAcceptedAuthorities`'s), ruling R22.
- `app/test/helpers/twilioWebhookHarness.ts` - ONLY the fake's
  `assignPrimaryIfCurrent` (after the fake's `rewriteAcceptedAuthorities`).
- `app/scripts/assign-primary-contacts.ts` (NEW).
- `app/src/routes/dev.ts` - the unitsRepo import line, the
  `zeroPrimaryFixtureRepos` dep, and the new route after the org-fixture
  route.

Tests (6, all NEW, under `app/test/`): `unitsRepoAssignPrimary.integration.test.ts`,
`assignPrimaryContacts.plan.test.ts`, `assignPrimaryContacts.run.test.ts`,
`assignPrimaryContacts.cli.test.ts`, `assignPrimaryContacts.integration.test.ts`
(the S5 addition, D2), `devZeroPrimaryFixture.test.ts`.

`git diff --stat 6643b6b7..HEAD` (before this report): exactly these 10
files, 1974+ / 1-. No file outside the brief's list was edited; nothing under
`app/src/lib/seed*`.

## 3. Tests and RED/GREEN evidence

Method: the NEW test files and the NEW script were created by byte-exact
extraction of the plan's fenced blocks (`sed -n` over plan lines 17643-17818,
17979-18157, 18173-18307, 18354-18735, 19157-19296, 19504-19676). S5.3 step
3b and S5.4 step 3b are pure tail appends (each old_string is the file's
last lines AND the first lines of its new_string - both checked with `diff`),
so the rest of each new_string (plan 18796-19113, 19361-19449) was appended
byte-exactly. Every other edit used the Edit tool. Afterwards a script
counted every plan new_string / new-file block in its target: each found
exactly once (logs in the session; re-checkable by line range).

### S5.1 - `unitsRepoAssignPrimary.integration.test.ts` (6 tests)

"unitsRepo.assignPrimaryIfCurrent - an error that is not a lost condition":
"is thrown, never reported as skipped". "unitsRepo.assignPrimaryIfCurrent
against DynamoDB Local": "writes the contact list and the scalar while
landlordId and contacts are as read"; "aligns the scalar alone when the
contact list is written back unchanged"; "skips after ONE attempt - nothing
written - when the contact list changed after the read"; "skips when a
landlord of record was set after the read"; "skips a unit that no longer
exists, and creates nothing".

- RED: `Test Files  1 failed (1)`, `Tests  6 failed (6)` - `TypeError:
  units.assignPrimaryIfCurrent is not a function` (4) and `TypeError:
  repo.assignPrimaryIfCurrent is not a function` (2: the throwing-client case
  and the counting-repo case). No SKIPPED line. As the plan predicts.
- GREEN: `Test Files  1 passed (1)`, `Tests  6 passed (6)`.

### S5.2 - `assignPrimaryContacts.plan.test.ts` (13 tests)

"planUnitPrimary - targets (spec section 8)": "470 Bolton: no primary, no
landlord of record, one live landlord-typed contact -> that contact"; "a
DELETED flagged primary next to a live landlord of record -> the landlord;
from names the deleted contact"; "a MISSING flagged primary (hard-deleted by
an import retraction) counts as not live"; "no landlord: the EARLIEST-added
eligible contact - a deleted one, a tenant and a caseworker before it are
skipped"; "an OFF-ROSTER landlord of record and no flagged row -> the
landlord, who gains a landlord row"; "a soft-deleted UNIT is planned like a
live one (the script reads them all)". "planUnitPrimary - a live primary
stays; only the scalar may be aligned": "a live flagged primary whose scalar
is absent or names someone else -> align, the contact list unchanged"; "a
live flagged primary whose scalar agrees -> unchanged"; "a landlord-only
unit (no stored contact list: the DERIVED landlord row is primary) is left
alone, whatever its scalar"; "a live flagged primary that is NOT eligible (a
tenant made primary by hand) is not replaced". "planUnitPrimary - counted,
never written": "noHeir: no live contact and no live landlord of record";
"noEligible: live contacts exist, but only a tenant and a caseworker";
"unknown: the contact read failed - even for a unit that would otherwise be
fine".

- RED: `Error: Cannot find module '../scripts/assign-primary-contacts.js'
  imported from ...` / `Failed to load url ../scripts/assign-primary-contacts.js`;
  `Test Files  1 failed (1)`, `Tests  no tests`.
- GREEN: `Test Files  1 passed (1)`, `Tests  13 passed (13)`. No S1
  contract mismatch (chooseHeir / applyPrimary answered exactly as the plan
  assumes).

### S5.3 - `assignPrimaryContacts.run.test.ts` (10 tests)

"assignPrimaryContacts - dry run": "counts and lists every outcome and writes
NOTHING"; "pages through the Scan: two units a page reaches the same
result". "assignPrimaryContacts - apply": "assigns each target its heir in
ONE conditional write with one backfill audit event, and aligns the scalar
with none"; "is idempotent: a re-run of a completed apply plans nothing and
writes nothing"; "a unit changed after the read is SKIPPED - never
overwritten, no audit event - and left for a re-run"; "a failed contact read
is UNKNOWN in BOTH shapes - never "deleted": nothing written for that unit,
exit 1"; "a write that fails (not a lost condition) is counted and the run
goes on; exit 1"; "an audit append that fails after the write landed is
counted, never thrown; exit 0 at WARN"; "a Scan failure ABORTS with a
PARTIAL report and rethrows". "assignPrimaryContacts - what it prints and
logs": "prints counts and unit ids only - never a name - and so do its log
lines".

- RED: `Test Files  1 failed (1)`, `Tests  10 failed (10)` - `TypeError: (0
  , assignPrimaryContacts) is not a function` (vite-node's spelling of the
  plan's predicted TypeError).
- GREEN (with the S5.2 file): `Test Files  2 passed (2)`,
  `Tests  23 passed (23)`.

### S5.4 - `assignPrimaryContacts.cli.test.ts` (11 tests) and `assignPrimaryContacts.integration.test.ts` (1 test, the S5 addition)

CLI, "assign-primary-contacts CLI": 6x "exits 2 on the usage error %j:
nothing resolved, nothing run" (`[]`, `["--apply"]`, `["--env","staging"]`,
`["--env","dev","--dry-run"]`, `["--env","dev","--lane","2"]`,
`["--env","dev","--apply","--apply"]`); "dry run by default, against the
resolved stage; the summary is printed and the client destroyed"; "--apply
writes; --lane reaches a local stage"; "exits 1 with nothing run when the
target cannot be resolved"; "exits 1 when the run throws, naming the
failure, and still destroys the client"; "exits 1 when the run completed
with failures, 0 when it completed clean".

Integration, "assign-primary-contacts - the real wiring against DynamoDB
Local": "a dry run, an --apply and a re-run, end to end: a 470 Bolton unit
gets its only contact as the primary". It calls `main` with ONLY
`resolveStage` (plus the print and log sinks) injected, so the DEFAULT `run`
- `assignPrimaryContacts(buildAssignDeps(stage, log), opts)` - builds every
repo on the stage. The stage is a throwaway `hc-test-<uuid>-` prefix in the
file's own DynamoDB Local database (the per-file key from
`app/test/setup/dynamoAccessKey.ts`; no key exported), behind a recording
doc client. It pins: the dry run sends exactly `ScanCommand <units>`,
`BatchGetCommand <contacts>` (the Scan with `ConsistentRead: true` and no
FilterExpression), writes nothing, exit 0, the client destroyed once; the
apply sends those plus `UpdateCommand <units>` and `PutCommand
<audit_events>`, all on the stage prefix, stores the flag and the scalar
(`c-mark`), no `landlordId`, a fresh `updated_at`, and ONE audit item
`{ entityKey: 'units#u-bolton', event_type: 'unit_primary_contact_assigned',
payload: { contactId: 'c-mark', reason: 'backfill' } }` with no `actorId`;
the re-run plans 0 and sends only the two reads; no printed or logged line
names the contact.

- RED: `Test Files  2 failed (2)`, `Tests  12 failed (12)` - every failure
  `TypeError: (0 , main) is not a function`.
- GREEN (all four script files): `Test Files  4 passed (4)`,
  `Tests  35 passed (35)` (plan: 3 files / 34 tests, plus the 1 added).
- Mutation check of the added test (non-gate evidence, both reverted before
  the commit - the committed script is the plan text, re-verified by block
  count, and `git diff` vs S5.3 was 96 insertions, 0 deletions): (a)
  `createAuditRepo({ doc, logger })` (no stage env) FAILS it - the trace
  shows `PutCommand hc-local-audit_events` instead of the stage prefix; (b)
  `createContactsRepo({ env, logger })` (no stage doc) FAILS it - the dry
  run exits 1. Logs `S5a-S5.4-mutation-env.log`, `S5a-S5.4-mutation-doc.log`.

### S5.5 - `devZeroPrimaryFixture.test.ts` (13 tests)

"POST /__dev/fixtures/zero-primary-property": "creates a NEW property with
no landlord of record and the contacts as non-primary rows, in order";
"never touches an existing property"; 8x "refuses %s with 400 and creates
nothing" (no street, a blank street, no rows, an empty rows list, six rows,
a row without a contactId, the landlord role, a repeated contact); "answers
404 for a contact that does not exist, and creates nothing"; "logs the unit
id and the row count - never the street or a name"; "is absent when the dev
router is not mounted".

- RED: `Test Files  1 failed (1)`, `Tests  12 failed | 1 passed (13)` -
  `AssertionError: expected 404 to be 201` (2), `expected 404 to be 400`
  (1 printed; vitest groups the identical 400-case errors), `expected {} to
  deeply equal { error: 'contact_not_found', ...(1) }`, `expected undefined
  to match object { unitId: undefined, rows: 1 }`; only "is absent when the
  dev router is not mounted" passed. 404, NOT the delta's 403 - see D1.
- GREEN (with devOrgFixture 15, devGating 41): `Test Files  3 passed (3)`,
  `Tests  69 passed (69)`.

## 4. Shipped contracts (exact) for the e2e slice and the RUNBOOK

### 4.1 `UnitsRepo.assignPrimaryIfCurrent` (`app/src/repos/unitsRepo.ts:781` interface, `:1558` implementation)

```ts
assignPrimaryIfCurrent(
  unit: UnitItem,
  next: { contacts: UnitContact[]; primaryContact: string },
): Promise<'written' | 'skipped'>;
```

ONE call of the unchanged private `updateRosterIfCurrent(unit, { contacts:
next.contacts, primary_contact: next.primaryContact })`: SET contacts, the
scalar and `updated_at`, conditioned on `attribute_exists(unitId)` AND
landlordId / contacts exactly as `unit` holds them (attribute_not_exists
when the read had none). `ConditionalCheckFailedException` -> `'skipped'`
(also for a unit that no longer exists - nothing is created); any other
error is thrown; no retry, no re-read. INFO `unit primary contact assigned
(script)` `{ unitId, primaryContact, rosterSize }`. The API-test fake
(`app/test/helpers/twilioWebhookHarness.ts:3121`) mirrors it: `'skipped'`
when the unit is missing, `landlordId !==` the read's, or contacts are not
`isDeepStrictEqual` to the read's; else copies the rows, sets the scalar and
`updated_at`.

### 4.2 The dev seam `POST /__dev/fixtures/zero-primary-property` (`app/src/routes/dev.ts:1293`)

Hermetic-only: inside `createDevRouter`, which only `lib/devRoutes.ts`
loads (DEV_AUTH_ENABLED, NODE_ENV not production, a DynamoDB Local
endpoint), mounted by `app.ts` before the origin-secret validator - so no
`x-origin-verify` header and no session are needed, and the dashboard dev
server proxies `/__dev` (`dashboard/vite.config.ts:114`), so an e2e spec
calls it like `e2e/fixtures/orgFixture.ts:121`:
`request.post('/__dev/fixtures/zero-primary-property', { data })`.
`json()` is scoped to the route. Real repos by default (lazy, like the org
fixture); tests inject `zeroPrimaryFixtureRepos`.

Body: `{ street: string; rows: Array<{ contactId: string; role: 'pm' |
'owner' | 'other' }> }`.

Answers, checked in this order (the first failure answers; nothing is
created on any refusal):

| condition | status | body |
|---|---|---|
| `street` not a string, or blank after trim | 400 | `{ "error": "street must be a non-empty string" }` |
| `rows` not an array, empty, or more than 5 entries | 400 | `{ "error": "rows must be an array of 1 to 5 entries" }` |
| a row (in order) whose `contactId` is not a non-empty string | 400 | `{ "error": "each row needs a non-empty contactId" }` |
| that row's `role` is not `pm` / `owner` / `other` (`landlord` included) | 400 | `{ "error": "each row role must be pm, owner or other" }` |
| that row repeats an earlier `contactId` | 400 | `{ "error": "a contactId may appear once" }` |
| a row's contact has no record (first in row order) | 404 | `{ "error": "contact_not_found", "contactId": "<id>" }` |
| otherwise | 201 | `{ "unitId": "<new unit id>" }` |
| dev router not mounted (any deployed env) | 404 | (Express default) |

The created unit (real repo `create`, `unitId` `unit-<uuid>`): `status:
'setup'`, `address: { line1: <street trimmed>, city: 'Atlanta', state:
'GA', zip: '30314' }`, `contacts` = the rows in the order given, each
`{ contactId, role, primaryContact: false }` (no name/company), NO
`landlordId` attribute, no `primary_contact`, no `accepted_authorities`,
`created_at` / `updated_at` stamped by `create`. It never reads or writes an
existing unit; the next reseed's `clearTable` removes it. INFO `dev
zero-primary-property fixture created` `{ unitId, rows }` (never the street
or a name). The existence check is `contactsRepo.getById`, which also
returns a SOFT-DELETED contact (see worry W2).

### 4.3 The script `app/scripts/assign-primary-contacts.ts`

Invocation (from the repo root, like `clean-org-names.ts`):

```
npx tsx app/scripts/assign-primary-contacts.ts --env dev              # dry run
npx tsx app/scripts/assign-primary-contacts.ts --env dev --apply      # write
npx tsx app/scripts/assign-primary-contacts.ts --env prod             # then prod, dry first
npx tsx app/scripts/assign-primary-contacts.ts --env prod --apply
```

Flags (`parseStageArgs`, `ASSIGN_ARGS = { values: [], flags: ['--apply'] }`):
`--env local|dev|prod` (required); `--lane <L>` (positive integer, `--env
local` only - a hermetic e2e lane; a bare `--env local` is the human's live
local stack); `--apply` (write; absent = DRY RUN). Unknown arguments, a
repeated argument, a value missing or starting with `--`, and `--lane` with
dev/prod are usage errors. dev/prod resolve through `resolveStageClient`:
the `housingchoice` profile, the account guard, the pinned regional
endpoint, and a refusal while any `AWS_ENDPOINT_URL*` variable is set.

Exit codes (`main` resolves to them; `process.exitCode` when run directly):

- `2` - usage error. Prints the USAGE text to stderr (`Usage: npx tsx
  app/scripts/assign-primary-contacts.ts --env local|dev|prod [--lane <L>]
  [--apply]` + two lines); nothing resolved, nothing read.
- `1` - (a) the target could not be resolved (account guard, STS, an ambient
  `AWS_ENDPOINT_URL*`): ERROR `assign-primary-contacts - FAILED before the
  run started (no table was read or written)`; (b) the run threw - a Scan
  failure ABORTS with an ERROR `... - PARTIAL result: the run ABORTED ...`
  (the counters so far) and then ERROR `assign-primary-contacts - FAILED:
  <message>`; (c) the run completed with failures - `unknown > 0` (a unit's
  contact read failed, in either shape) or `writeFailed > 0` (a write failed
  other than a lost condition; it may or may not have landed): the summary
  is still printed, then WARN `... - COMPLETED WITH FAILURES ...`.
- `0` - the run completed. Includes units skipped on their condition
  (`skippedOnCondition > 0`) and audit appends that may not have landed
  (`auditFailed > 0`), both reported at WARN `... - done: N unit(s) changed
  while the run worked (re-run to finish them) and M audit event(s) may not
  have been written`; a clean run logs INFO `... - done` (with ` (DRY RUN -
  nothing written)` on a dry run).

Once resolved, the stage client is destroyed whatever happens. Output: the
printed summary (console.log) and pino JSON lines; ids and counts only,
never a name, phone or street.

Counts (`AssignResult`; every count is also a field of the final log line):
`unitsScanned`, `deletedUnits`, `targets`, `targetsOnDeletedUnits`,
`assigned`, `scalarAligned`, `skippedOnCondition`, `writeFailed`, `noHeir`,
`noEligible`, `unknown`, `unchanged`, `auditFailed`; id lists
`targetUnitIds`, `alignedUnitIds`, `noEligibleUnitIds`, `unknownUnitIds`,
`skippedUnitIds`, `failedUnitIds` (`noHeir` is a count only). `targets` and
the id lists are what the run PLANNED (both modes); `assigned` is what an
apply wrote; `scalarAligned` is what a dry run would align and an apply
aligned. Each assigned primary appends ONE `unit_primary_contact_assigned`
`{ contactId, reason: 'backfill', from? }` (`from` = the flagged contact it
replaced, when there was one; no `actor`); a scalar alignment appends
nothing.

Sample summary (the shipped `formatAssignSummary` on the run test's
seven-unit world), dry run:

```
Primary contacts - DRY RUN, nothing written:
  Properties scanned: 7 (1 soft-deleted)
  Would get a primary contact: 3 (1 on soft-deleted properties)
  primary_contact field would be aligned with the flagged primary: 1
  No heir - no live contact and no live landlord of record (nothing to do): 1
  No eligible contact - only a tenant or a caseworker is live (choose one on the property page): 1
  Unknown - a contact read failed (re-run): 0
  Already fine: 1
Properties that would get a primary contact: u-bolton, u-deleted-primary, u-soft-deleted
Properties whose primary_contact field would be aligned: u-stale-scalar
Properties with no eligible contact (open each one and choose a primary contact): u-only-tenant
Properties that could not be decided (re-run): none
```

The apply adds `  Primary contacts assigned: N`, `  Skipped - the property
changed after the run read it (re-run): N`, `  Writes that FAILED (re-run
the dry run to see): N`, `  Audit events that may not have been written: N
(expected 0)` and the two id lines `Properties skipped because they changed
(re-run): ...` / `Properties whose write failed: ...`; its header is
`Primary contacts - APPLIED:` and the planned lines read `Planned a primary
contact` / `Properties planned for a primary contact` / `Properties planned
for a primary_contact field alignment`. Idempotent: after a completed apply
the next run plans 0 (proven on DynamoDB Local by the integration test).

### 4.4 Import cycle (ruling R3)

TypeScript-AST check (top-level statements walked, function / arrow /
method / class bodies skipped as deferred, types erased; log
`S5a-extra-cycle-check.log`): `unitsRepo.ts` value imports from
propertyContact [applyPrimary, chooseHeir, rosterContactIds] - top-level
reads NONE; `propertyContact.ts` from unitsRepo [unitContacts] - NONE; the
script imports at TOP LEVEL, as function references only, [applyPrimary,
chooseHeir, readRosterContacts, rosterContactIds] from propertyContact and
[createUnitsRepo, isDeleted as isUnitDeleted, unitContacts] from unitsRepo
(plus type-only names) - NONE read at top level (every use is inside a
function body); `dev.ts` imports [createUnitsRepo] (plus the type-only
CreateUnitInput, UnitContact) from unitsRepo and nothing from
propertyContact - NONE. Negative control: the same checker flags
`unitsRepo.ts:60 LISTING_STATUSES` and `:63 SHAREABLE` (the known statusModel
reads). Neither the script nor `dev.ts` is imported by a cycle module.

## 5. Divergences from the plan text

- D1 (research delta wrong, plan right). S5.5's RED answered 404, not the
  403 the worklist delta (S3-F2) predicted. `app/src/middleware/originSecret.ts:45`
  exempts EVERY `/__dev/` path from the origin-secret check
  (`if (req.path.startsWith('/__dev/')) { next(); return; }`), so an
  unmatched `/__dev` path falls through to Express's 404 whether or not a
  dev router is mounted; the delta read only the 403 branch at `:62`. The
  plan's own wording (`expected 404 to be 201` / `404 to be 400`) matched.
  No code impact.
- D2 (S5 addition c). The ONE DynamoDB-Local real-wiring test is a fourth
  script test file, `app/test/assignPrimaryContacts.integration.test.ts`,
  written RED with S5.4 (it needs `main`) and committed in the S5.4 commit
  (the plan names two files for that commit), with one body line naming the
  delta. Script tests: 4 files / 35 tests instead of the plan's 3 / 34.
- D3 (method). New files by byte-exact extraction; S5.3 3b and S5.4 3b as
  byte-exact tail appends (section 3, "Method"). Every plan block verified
  present exactly once.
- D4. The plan's per-task typecheck is `cd app && npm run typecheck`; the
  root `npm run typecheck` (all five workspaces, a superset) ran instead, per
  the brief.
- D5. `npm run db:start` (S5.1 step 2) was not run: DynamoDB Local was
  already Up and is a shared container (the brief forbids touching it).
- D6. The S5.4 optional lane rehearsal was not run (the brief forbids
  `npm run e2e:session`); the integration test (D2) runs the same default
  wiring against DynamoDB Local.
- D7 (plan text, no code). Plan line 17604 says `ListUnitsOpts.consistentRead`;
  S2 shipped `consistentRead` on `list`'s own parameter. The script calls
  `deps.units.list({ deleted: 'any', consistentRead: true, ... })` through
  `Pick<UnitsRepo, 'list' | ...>` and compiles against the shipped shape;
  `ListUnitsOpts` was not touched (delta S5 (b)).

No code divergence: every plan code block landed byte-identical, every
predicted RED matched (D1 aside, where the plan was right), every GREEN
matched its expected counts.

## 6. Worries for the orchestrator (non-blocking)

- W1. The fake's `assignPrimaryIfCurrent` has no test of its own: no route
  calls it (it exists so the fake satisfies `UnitsRepo`). Its guard
  compares `landlordId` with `!==`, so an absent attribute and an own
  `undefined` compare equal, where the real guard keys on own-property
  presence - harmless for every caller today.
- W2. The seam's existence check (`contactsRepo.getById`) accepts a
  SOFT-DELETED contact. Fine for a dev seam (the spec creates live contacts
  through `POST /api/contacts`), but a spec that wants a deleted row must
  delete the contact through the API after creating the property.
- W3. The seam does not enforce a run-unique street (the plan leaves that to
  the spec); two specs passing the same street get two properties with one
  address.
- W4. The seam's 404 carries `contactId` (`{ error: 'contact_not_found',
  contactId }`), unlike the org fixture's bare `{ error: 'contact_not_found' }`
  - as the plan writes it.
- W5. Real-environment cost, for the RUNBOOK: one consistent full Scan of
  units, then per unit ONE sequential BatchGet (no concurrency) and, on
  apply, up to one conditional write and one audit Put. Hundreds to low
  thousands of units means that many sequential round trips - seconds to a
  minute or two; nothing is held (no lock).
- W6. Checked, no action: every unit the script writes has a stored,
  non-empty contact list (a landlord-only unit plans `unchanged` or
  `noHeir`, an empty ownerless one `noHeir`), so `updated_at` - which
  `updateRosterIfCurrent` stamps - is only ever set on units a roster write
  already stamped; the importer's `attribute_not_exists(updated_at)`
  ownership line (`lib/import/apply.ts`) does not move (plan CONTRACT ISSUE
  1).
- W7. `npm run smoke` (gate step) rebuilt the gitignored `app/dist/`.

## 7. Interim gate (bare, output under `.superpowers/sdd/`, real exit codes)

1. `env | grep '^AWS_'` -> nothing printed, `EXIT:1` (no key exported). Log
   `S5a-gate-aws-env.log`.
2. `cd W:/tmp/primary-contact-integrity && npm run typecheck` -> `EXIT:0`;
   0 `error TS` lines; all five workspaces ran (app: `tsc -p tsconfig.json
   --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json`;
   dashboard; e2e; fake-twilio; fake-twilio-web). Log `S5a-gate-typecheck.log`.
3. `cd app && npx vitest run` on the 6 test files this dispatch created plus
   3 neighbors (devOrgFixture and devGating - the plan's S5.5 GREEN set - and
   primaryHandoffParity.integration, the fake-vs-real parity pin for the
   edited harness) -> `EXIT:0`; `Test Files  9 passed (9)`,
   `Tests  119 passed (119)`; 0 `[dynamoAdmin]` lines; 0 SKIPPED lines. Per
   file: unitsRepoAssignPrimary.integration 6, assignPrimaryContacts.plan 13,
   assignPrimaryContacts.run 10, assignPrimaryContacts.cli 11,
   assignPrimaryContacts.integration 1, devZeroPrimaryFixture 13 (the six
   created: 54 tests); devOrgFixture 15, devGating 41,
   primaryHandoffParity.integration 9. Log `S5a-gate-vitest.log`.
4. `npm run smoke` -> `EXIT:0`, `smoke-dist: OK - 1676 import specifier(s)
   across 291 emitted file(s) resolve under plain Node.` Log
   `S5a-gate-smoke.log`.
5. `npx eslint` on the 10 code files of `git diff --name-only --diff-filter=d
   6643b6b7..HEAD` (`S5a-touched-files.txt`: the script, unitsRepo.ts,
   dev.ts, the harness and the six tests) -> `EXIT:0`, empty output. No
   baseline comparison needed. Log `S5a-gate-eslint.log`.
6. ASCII: `git diff 6643b6b7..HEAD -U0 -- app | grep -nP '^\+.*[\x80-\xFF]'`
   -> no output, grep `EXIT:1` (the pass). Log `S5a-gate-ascii.log`.

`git status` after the gate: clean on `feat/primary-contact-integrity`,
five S5a commits on top of 6643b6b7 (this report is the sixth).

Next step: Task S5.6 (plan line 19850) - the e2e specs, building on the
seam contract in 4.2.
