# Fix wave 1 report - feat/primary-contact-integrity

Kind: FIX-WAVE REPORT (mission record). Branch
`feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
base 78e880bb (the R1 records commit). Fix list:
`code-review/R1-adjudications.md` section "Fix wave", items 1-5 (item 6, the
worklist-deltas 403 correction, was the orchestrator's and is not touched
here). Implementer: Claude Opus 5.5, alone in the worktree. Date: 2026-10-13.

Never run: `npm test` (full), `npm run e2e`, `npm run e2e:session`,
`npm run dev`, the human's live ports. DynamoDB Local (shared container) was
only used, never started, stopped, restarted or reseeded. `env | grep
'^AWS_'` printed nothing before every vitest run (grep exit 1). No background
command was left running. No behavior changed: the only non-comment code in
the wave is item 1's new test (proof in section 3).

## 1. Commits

| item | commit | subject |
|---|---|---|
| 1 | 5b6c3c7c | test(units): pin that an explicit Make primary appends no unit_primary_contact_assigned (code review R1 L2) |
| 2 | d06097bd | docs(comments): code review R1 comment and title fixes - a flagged row counts deleted or not; the property-contact header scoped to its readers; stale dashboard comments; sole-landlord wording retired |
| 3 + 4 | 9abe96ec | docs(issues,e2e): code review R1 - file the no-flag landlord delete gap and the liveness-read race; update relay-provision-includes-deleted-contacts and auto-routing-changes-not-named; selectors.md says the UI can reach zero primary |
| record | (this commit) | this report |

Every commit: bare `git status` read first, `MERGE_HEAD` absent (`test -e
"$(git rev-parse --git-path MERGE_HEAD)"` -> no-merge-in-progress), explicit
paths only, the `Co-Authored-By: Claude Opus 5.5` trailer. Nothing under
`.superpowers/`, no `docs/issues/INDEX.md` and no repro file was committed.

## 2. Item by item (line numbers at the tip)

### Item 1 - L2: an explicit Make primary appends no `unit_primary_contact_assigned`

- NEW test `app/test/unitsApiRosterAutoPrimary.test.ts:217-238`, "(h) (PIN)
  an explicit Make primary on an ownerless no-primary list appends
  unit_contact_added only - no unit_primary_contact_assigned": an ownerless
  property, one live landlord-typed seated row non-primary (the 470 Bolton
  shape), `POST /api/units/:id/contacts { primaryContact: true }` with the
  row's own role (exactly the no-primary box's "Make <Name> primary" write,
  spec 7.4). Asserts 200, the row flagged, the scalar set, ONE
  `unit_contact_added` `{ primaryContact: true }` without `autoPrimary`, and
  NO `unit_primary_contact_assigned`.
- Why a small test rather than one line in the existing "(h) (PIN) a
  requested primary ..." (the brief allowed either): on that test's shape a
  live landlord of record is the primary, so the automatic rule could never
  have fired and only the request flag is exercised. On this shape the rule
  WOULD have promoted the contact too, so it also catches a future
  derivation of `autoPrimary` from "the rule's conditions held" that the
  one-line assertion would miss. Plan contract 2.4 is the rule pinned.
- TDD: the test passed on its first run (the behavior was already right;
  `Tests 20 passed (20)`, `.superpowers/sdd/fixwave-item1-first-run.log`).
  RED by a temporary break of the condition - `if (autoPrimary)` ->
  `if (effectivePrimary)` at the `unit_primary_contact_assigned` append in
  `app/src/routes/units.ts` (now `:1477`): `Tests 1 failed | 19 passed (20)`,
  the failure exactly the new test, `expected [ { entityKey: 'units#u-h3',
  ...(5) } ] to deeply equal []` (`fixwave-item1-red.log`). The 19 that
  passed include the existing (h) PIN - the existing pins do not catch this
  break. Restored with the same Edit; `git diff --quiet -- app/src/routes/units.ts`
  -> no diff; GREEN `Tests 20 passed (20)` (`fixwave-item1-green.log`).

### Item 2 - comment-only edits (no code, no assertion changed)

- F3: `app/src/repos/unitsRepo.ts:1615-1622` (restoreWithLandlord, the
  `landlordWasPrimary` call site) and `app/src/routes/units.ts:589-594`
  (clearedLandlordHeir): "a live flagged row elsewhere is never displaced"
  -> a FLAGGED row elsewhere is never displaced, deleted or not; the rule
  reads the flag, never liveness; a soft-deleted contact still flagged there
  stays flagged until the next eligible write or the script (spec 4.7).
- F8: `app/src/lib/propertyContact.ts:11-17` header: "Every reader now walks
  the candidates here" -> every reader of the PROPERTY CONTACT; the readers
  that mean the landlord of RECORD (placement nudges, person events,
  related-property and landlord timelines, the dashboard's landlord tabs)
  stay on `unit.landlordId`, unchanged on purpose (spec 9.2). See W1.
- N6: `dashboard/src/routes/listing/rosterCopy.ts:1-4` - one sentence per
  shared answer, the 409 `unit_roster_conflict` AND the 503
  `roster_read_failed` (was "the same 409").
  `dashboard/src/routes/listing/useListing.ts:244-249` - setUnit applies in
  place without a refetch, but a restore applies its answer that way and
  THEN re-reads (ListingDetail `onRestore` and the restore dialog's
  `onRestored`, spec 7.5): no restore answer carries a propertyContact block,
  and a landlord restore can hand the primary off. The old line's non-ASCII
  dash went with it.
- Sole-landlord wording (S2b W1): `app/test/unitsApiRosterAutoPrimary.test.ts:148-155`
  is a block COMMENT, not a title (the brief's "test titles" at ~:150): "the
  restore's sole-landlord promotion uses" -> "the restore's hand-off uses
  (the earliest-added eligible contact takes over, primary-contact-integrity
  spec 4.3 / 4.6)". Titles in
  `app/test/unitsRepoRestoreWithLandlord.integration.test.ts` (the brief
  wrote `.int.test.ts`; the file is `.integration.test.ts`): `:192` "(no
  sole landlord-typed contact)" -> "(no eligible contact for the heir
  pick)"; `:247` "promotes the sole landlord-typed contact" -> "promotes the
  earliest-added eligible contact (the heir the caller picked)". Every other
  "sole-landlord" mention left in app/src, app/test and dashboard/src says
  the rule was REPLACED (historical, correct): `unitsRepo.ts:205`,
  `routes/units.ts:562`, `unitsRestoreLandlord.test.ts:574`,
  `unitsRestorePrimaryHandoff.test.ts:6`, `dashboard/src/api/endpoints.ts:1045`.

### Item 3 - issues (ASCII, template format, dated 2026-10-13)

- (a) L1 - `docs/issues/relay-provision-includes-deleted-contacts.md`:
  `updated: 2026-10-13`, `refs:` refreshed to the current lines, and an
  Update block (`:46-72`): the `memberFromContact` docblock was corrected by
  03b058e9 (`app/src/lib/rosterResolution.ts:200-220`); the property-contact
  route is closed by the shared lookup (857355d6; the default people list
  moved onto it in 03b058e9); the real subject stays open - `describeRoster`
  reachability `rosterResolution.ts:587-601` (`:619`, `:660`),
  `provisionMembersOf` `rosterProvision.ts:107-121`, `isMemberSuppressed`
  `relayAnnouncements.ts:64-101` (`:73`) never check `deleted_at`. Status
  stays `open`.
- (b) PRE-1 - `docs/issues/auto-routing-changes-not-named.md` (the issue that
  called the claim "API-only", `:57` and `:95-96`): Update block `:99-124`
  naming the dashboard path - on a property with no landlord of record the
  edit mode keeps the role select on a "(deleted)" row
  (`ListingDetail.tsx:1106-1131`), Landlord re-posts the row
  (`onSetContactRole`, `:569-577`), both claim checks are type-only
  (`routes/units.ts:1363-1369`; `unitsRepo.ts:1173`, `:1192`), the deleted
  contact becomes landlord of record (`unitsRepo.ts:1281`) and its row is
  then unremovable (409, `unitsRepo.ts:1343-1344`); plus the reviewer's other
  type-only paths (create, PATCH, `requireLandlordContact`
  `contactTypeGuards.ts:83-90`, the plain restore `routes/units.ts:2001-2007`).
  Behavior unchanged. See W4 on the PRE-1 / PRE-2 numbering.
- (c) NEW `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`
  (type `decision`, severity `med`, status `open`; see W5): F1 with the
  target filter `primaryHandoff.ts:86-89` and the re-check
  `unitsRepo.ts:1738-1740`; P1's fallback `propertyContact.ts:149-156`;
  `landlordWasPrimary` `unitsRepo.ts:865-868`; BY DESIGN per spec 4.6's last
  bullet; the four data shapes (legacy no-flag claims, the deploy-to-backfill
  window, an API demotion, a no-heir remove followed by a re-import that
  attaches a landlord); what staff see (the box's "This property's contact
  was deleted.", the next eligible write, the backfill); the recipe, with
  the caution that `landlordWasPrimary` alone is true for EVERY no-flag unit,
  so the reuse must also require `unit.landlordId === contactId`; the F5
  `ProjectionExpression` bullet.
- (d) NEW `docs/issues/roster-liveness-read-eventual-consistency.md` (type
  `improvement`, severity `low`, status `open`): the read
  (`propertyContact.ts:84-102` -> `contactsRepo.ts:1288-1290`, the BatchGet
  at `:978-980` without `ConsistentRead`) and its six write-deciding callers;
  accepted per spec 4.2 and ruling R13 (`plan-assembly-rulings.md:27`); the
  three shapes (stale image, with F4's no-replica interleaving and the
  never-retried `unknown` units; stale miss; F3's deleted flagged row not
  displaced, spec 4.7); the recipe (a `consistentRead` option on
  `getManyByIds` for the write-deciding callers, display reads may stay
  eventually consistent; a bounded retry for `unknown` units in the delete
  fan-out).
- `npm run issues`: `EXIT:0`, `[issues] 410 open, 207 closed, 617 total`
  (S5b's 408 + the two new), no warnings (`fixwave-issues.log`). INDEX is
  gitignored (`.gitignore:62`) and not committed.

### Item 4 - `e2e/support/selectors.md`

`:88` (the no-primary-box row): "The UI cannot reach this state" -> "The UI
CAN reach a property with no primary contact (Restore without a landlord,
then add only tenants); what it cannot build is the imported shape - an
ELIGIBLE contact left non-primary - which is why the dev seam exists." The
seed sentence and the fixture pointer are kept. See W2 on `:117`.

### Item 5 - the adversarial repro, run once

Copied byte-identical (`cmp`) to `app/test/r1Adversarial.repro.test.ts` after
the three content commits, run with the brief's command, then deleted;
`git status` -> "nothing to commit, working tree clean" before this report
was written. Log: `.superpowers/sdd/fixwave-repro.log`, `EXIT:1`,
`Tests 2 failed | 6 passed (8)` - exactly the reviewer's prediction.

| describe | test | outcome |
|---|---|---|
| R1-F1 | the shared rule (landlordWasPrimary) says that landlord IS the primary here | PASS |
| R1-F1 | hands the property to the eligible PM | FAIL (by design): `:89` `expected null to be 'c-pm'` - the GET block names nobody after the delete |
| R1-F2 | restore without a landlord promotes a contact deleted a moment ago | PASS (asserts the race outcome) |
| R1-F2 | an EC miss on a LIVE flagged primary lets an add displace it | PASS (asserts the race outcome) |
| R1-F3 | hands off to the eligible contact | FAIL (by design, spec 4.7): `:189` `expected null to be 'c-pm'` |
| R1-F4 | leaves the DELETED Q flagged although R is eligible | PASS (asserts the race outcome) |
| R1-F5 | a tenant who is on no contact list still costs a full consistent Scan | PASS |
| R1-PRE-1 | becomes the landlord of record and is then unremovable | PASS (pre-existing) |

## 3. Gate evidence (bare, from the worktree, logs under `.superpowers/sdd/`)

| gate | result | log |
|---|---|---|
| `npm run typecheck` (root, five workspaces: app src/scripts/tests, dashboard, e2e, fake-twilio, fake-twilio-web) | `EXIT:0`, 0 `error TS` lines | `fixwave-typecheck.log` |
| `cd app && npx vitest run test/unitsApiRosterAutoPrimary.test.ts test/unitsRepoRestoreWithLandlord.integration.test.ts` (every app test file touched) | `EXIT:0`, `Test Files 2 passed (2)`, `Tests 38 passed (38)` (20 + 18), 0 SKIPPED, 0 `[dynamoAdmin]` lines | `fixwave-vitest-app.log` |
| dashboard test files touched | none (the two dashboard files are comment-only source) | - |
| extra, not a gate: `cd dashboard && npx vitest run src/routes/listing/ListingDetail.test.tsx src/routes/listing/useListing.test.tsx src/routes/listing/RestoreLandlordDialog.test.tsx` (the tests loading the two touched modules) | `EXIT:0`, `Test Files 3 passed (3)`, `Tests 138 passed (138)` | `fixwave-vitest-dashboard-extra.log` |
| `npx eslint` on the 7 touched `.ts`/`.tsx` (= `git diff --name-only --diff-filter=d 78e880bb..HEAD -- '*.ts' '*.tsx'`) | `EXIT:0`, empty output. The known `TourDetail.tsx:342:85 react-hooks/purity` error is in a file this wave did not touch, so it does not appear | `fixwave-eslint.log`, `fixwave-touched-files.txt` |
| ASCII: `git diff -U0 78e880bb..HEAD` added lines vs `[^\x00-\x7F]` | none (grep exit 1; positive control matched) | `fixwave-ascii-eol.log` |
| line endings: `git ls-files --eol` on the 12 changed files | all `i/lf w/lf` | `fixwave-ascii-eol.log` |
| behavior: `git diff -U0 78e880bb..HEAD -- app/src dashboard/src`, changed lines that are not `//` comments | none (grep exit 1); the integration test diff is its two titles only | - |

## 4. Noticed (not blocking, not changed)

- W1. `app/src/lib/propertyContact.ts:15-17` still says every AUTOMATIC
  primary choice, "auto-primary" included, "goes through chooseHeir". Auto-
  primary goes through `decideAutoPrimary` (`app/src/repos/unitsRepo.ts:347-361`)
  and shares only the eligibility rule; it never calls `chooseHeir` (a write
  for X never promotes another contact). Pre-existing wording, not on the
  fix list; it was re-wrapped only because the F8 fix shares its line. A
  one-clause fix if wanted.
- W2. `e2e/support/selectors.md:117` (the Dev seam row) still says "The only
  way to reach the state"; its own reason clause (an eligible add is made
  primary at once) limits it to the eligible shape, so it is not wrong, but
  it reads like the sentence `:88` just corrected. Left alone ("one
  clause").
- W3. The spec itself, 9.2, still says "A live flagged row elsewhere is never
  displaced"; the code comments now say flagged, deleted or not (spec 4.7 is
  the accurate statement). The approved spec was not edited.
- W4. Numbering: the adjudication's "PRE-1" (the dashboard claim path) is the
  SECOND bullet of `R1-adversarial.md` section 4 (labelled PRE-2 there; PRE-1
  there is the placement-nudge routing); the repro's describe for it is
  named "R1-PRE-1". The issue update cites it as "PRE-1 - R1-adversarial.md
  section 4, its R1-PRE-1 repro".
- W5. The brief's "severity low-medium" is not a schema value
  (`scripts/issues.mjs` accepts high | med | low and warns otherwise): the
  F1 issue says `med` (the reviewer's MEDIUM) and states low-medium in its
  body. Types chosen: `decision` for F1 (a spec amendment for Cameron),
  `improvement` for F2/F3/F4.
- W6. The F1 recipe has one trap worth repeating to whoever implements it:
  `landlordWasPrimary(roster, X)` is true for ANY X when nothing is flagged,
  so dropping it into the Scan's filter unrestricted would make every
  no-flag unit a target of every contact delete. The issue spells out the
  restricted predicate.
- W7. `unitsApiRosterAutoPrimary.test.ts` now has 20 tests (S2b's gate counted
  19).
