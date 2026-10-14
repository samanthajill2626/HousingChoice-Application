# Fix wave 3 - implementer B report: F2 + F5a + F5b (the no-flag landlord delete hand-off, consistent restore reads, the Delete-dialog sentence)

Branch `feat/primary-contact-integrity`, worktree `W:\tmp\primary-contact-integrity`,
base `e0b1b5aa` (implementer A's report commit). Contract: findings F2, F5a
and F5b of `planner-review/fix-wave-findings.md`, plus the "Orchestrator
additions" of the brief `.superpowers/sdd/fixwave3-brief-B.md`.
Implementer: Claude Opus 5.5. Strict TDD per item (red log, then green log);
explicit-path commits. F1 / F3 (implementer A) and F4 (no change) were not
touched.

## Commits

| # | Hash | Item | One-liner |
|---|---|---|---|
| 1 | `f18ac75f` | F2 code + tests | fix(units): deleting the landlord of record of a no-flag roster hands off |
| 2 | `fc7607de` | F5a code + tests | fix(units): the restore paths read contact liveness strongly consistent again |
| 3 | `b5561c2c` | F5b copy + pin | fix(contact): the Delete dialog's hand-off sentence says "when someone can" |
| 4 | `4e430a6e` | docs | spec 4.2 / 4.4 / 4.6 / 7.6 / 10 and the two issues (F2 + F5a + F5b + orchestrator additions) |
| 5 | (this file) | records | docs(records): this report |

## F2 - the shared predicate and its three call sites

- `app/src/repos/unitsRepo.ts:900` - NEW exported pure
  `contactIsPrimaryToHandOff(unit, contactId)`, next to `landlordWasPrimary`
  (:876); docblock :881-899. The landlord of record (non-empty `landlordId`)
  -> `landlordWasPrimary(unitContacts(unit), contactId)`; anyone else -> their
  row is the flagged primary. Never reads the scalar; the derived landlord row
  of a landlord-only unit counts as flagged (behavior as before).
- Call site 1, the Scan: `app/src/services/primaryHandoff.ts:97`
  (`if (contactIsPrimaryToHandOff(unit, contactId)) summary.targets.push(...)`).
- Call site 2, the repo re-check: `app/src/repos/unitsRepo.ts:1781-1784`, on
  `handOffPrimaryFrom`'s consistent re-read, so a lost write's retry
  (`attempt()` again) re-checks it too; `not_primary` otherwise.
- Call site 3, the FakeWorld mirror: `app/test/helpers/twilioWebhookHarness.ts:3312`
  (import :120). No copies of the rule remain in the three places.
- Unchanged, as ruled: `chooseHeir` with the deleted contact excluded and
  never read, `applyPrimary`, `landlordId` untouched, the
  `unit_primary_contact_assigned { reason: 'handoff_on_delete', from }` row,
  no heir -> nothing, unknown -> logged and skipped.
- No new import edge: primaryHandoff.ts and the harness already imported
  `repos/unitsRepo.js`; the predicate uses only unitsRepo-local functions.

## F2 - tests

- Pure predicate: `app/test/landlordWasPrimary.test.ts:47` (5 cases: no-flag
  landlord of record on and off the list; not the landlord of record,
  ownerless and empty `landlordId`; a flagged row elsewhere wins; the flagged
  row is the contact; landlord-only derived row).
- Service (FakeWorld): `app/test/primaryHandoffService.test.ts:282` - the
  ruling's shape (`landlordId: c-ll`, `[c-ll landlord, c-pm pm]`, delete c-ll
  -> c-pm flagged, scalar c-pm, `landlordId` kept, ONE `handoff_on_delete`
  row from c-ll) :289; negative "landlord of record is SOMEONE ELSE" :323;
  negative "a FLAGGED row wins" :343; re-check "gained a flagged row between
  the Scan and the hand-off -> not_primary, nothing written" :364.
- Route (FakeWorld): `app/test/contactDeletePrimaryHandoff.test.ts:229` - the
  same shape through `DELETE /api/contacts/c-ll`, plus a second no-flag unit
  where c-ll is merely a seated pm (left byte-identical).
- DynamoDB Local: `app/test/unitsRepoHandOffPrimary.integration.test.ts:393`
  (the ruling's shape against the real repo) and :414 (a lost write whose
  retry re-reads a newly flagged row -> `not_primary`; 1 lost write, 2
  consistent unit reads).
- Parity table: `app/test/primaryHandoffParity.integration.test.ts:185`,
  :194, :203 (the shape; not the landlord of record; flag wins) - fake and
  real agree, and each equals its expected outcome.

Evidence (all logs under `W:\tmp\primary-contact-integrity\.superpowers\sdd\`):
- Red on the unchanged code: 11 failed / 48 passed (59), 5 files -
  `fixwave3-B-F2-red.log` (5 x "contactIsPrimaryToHandOff is not a
  function"; 6 x no hand-off on the no-flag shape / no retry). The 4 guard
  pins (service and parity negatives) pass on the old code by construction:
  it targeted no no-flag unit at all.
- Green: 59/59 - `fixwave3-B-F2-green.log`.
- Guard pins' teeth: two deliberately wrong predicates, then restored
  byte-for-byte (sha256 identical) - "landlordWasPrimary alone": 4 failed /
  55 passed (the "someone else" pin at the pure, service, route and parity
  layers) `fixwave3-B-F2-mutantA-red.log`; "the landlord of record always":
  4 failed / 55 passed (flag-wins pure and service, both re-check pins)
  `fixwave3-B-F2-mutantB-red.log`; after restore 59/59
  `fixwave3-B-F2-green-restored.log`, at commit 59/59
  `fixwave3-B-F2-green-commit.log`.
- Neighbors (every other app test that deletes a contact through the route):
  5 files 77/77 `fixwave3-B-F2-neighbors.log`.

## F2 - docs, issue and comment sweep

- Spec 4.6 "Delete the contact" bullet
  (`docs/superpowers/specs/2026-10-12-primary-contact-integrity-design.md:329-359`):
  targets = the flagged primary, OR the landlord of record when no row is
  flagged (the shared predicate named); landlord of record never changed; the
  re-check uses the same predicate.
- Spec 4.6 last bullet (:376-386) rewritten: restore and delete now AGREE.
- Spec 9.2: checked - it does not restate the asymmetry; unchanged.
- `docs/issues/primary-handoff-no-flag-landlord-delete-gap.md`: `status:
  resolved`, `resolved: 2026-10-13` (:6, :9); `refs:` moved to the fix sites;
  "What staff see meanwhile" (:68) brought to the F1 box rule (orchestrator
  addition); dated Resolution naming `f18ac75f` (:111).
- Comments swept: `app/src/services/primaryHandoff.ts:6-29` (header) and
  :52-57 (`targets`); `app/src/repos/unitsRepo.ts:298-303`
  (`PrimaryHandOffResult`), :827-851 (`handOffPrimaryFrom`), :859-875
  (`landlordWasPrimary` now names the delete use);
  `app/src/routes/contacts.ts:2293-2302`;
  `dashboard/src/routes/contact/ContactDetail.tsx:140-145` (in the F5b commit);
  two test-file headers.
- GLOSSARY primary-contact bullet: no sentence contradicts the new rule
  ("when the primary is ... deleted ... the HEIR takes over"); unchanged.
- `npm run issues`: exit 0 (`fixwave3-B-issues.log`).

## F5a - consistent restore reads

- `app/src/repos/contactsRepo.ts:761` - `getManyByIds(ids, { requireComplete?,
  consistentRead? })` (doc :753-757); `batchGetByIds` takes `consistentRead`
  (:996, doc :982-984) and spreads `ConsistentRead: true` into the contacts
  table's `RequestItems` entry of EVERY request it sends - each chunk and
  each UnprocessedKeys retry (:1018); impl passes it through (:1339-1344).
  Default unchanged (no `ConsistentRead` key at all).
- `app/src/lib/propertyContact.ts:92-110` - `readRosterContacts(contacts, ids,
  logger?, opts = {})`: `consistentRead: true` reaches `getManyByIds` only
  when asked (:107); every three-argument caller compiles and calls exactly
  as before (`{ requireComplete: true }`).
- `app/src/routes/units.ts:706-713` (`clearedLandlordHeir`, the "Restore
  without a landlord" heir pick) and :2434 (the `readContacts` handed to
  `restoreWithLandlord` for the swap's hand-off) ask for it; comments
  :679-682, :2417-2420. Unchanged, eventually consistent: `enrichRosterView` :653, the
  roster write :1747, the remove route :1858, the delete fan-out
  (`primaryHandoff.ts:110`), the backfill script (`assign-primary-contacts.ts:315`).
- FakeWorld `getManyByIds(contactIds, _opts)`
  (`app/test/helpers/twilioWebhookHarness.ts:2302-2313`) mirrors the
  signature; the options are ignored (in memory is complete and consistent).
- Pins: NEW `app/test/contactsRepoConsistentBatchRead.test.ts:56` (captured
  BatchGet inputs: ConsistentRead when asked; on a second chunk and an
  UnprocessedKeys retry; absent by default, with `requireComplete` alone and
  with `false`; never on the display reads); `app/test/propertyContact.test.ts:107`
  (the pass-through, only when asked); `app/test/unitsRestoreLandlord.test.ts:584`
  (the PIN, now "ONE complete, strongly consistent batch read") and the swap
  case :151 (new assertions :156-164: `['c-pm', 'c-new']` with
  `consistentRead: true`; every complete read of each request is
  consistent); DynamoDB Local acceptance
  `app/test/contactsRepo.integration.test.ts:193`.
- `docs/issues/roster-liveness-read-eventual-consistency.md`: dated Update
  naming `fc7607de` (:101) - the restore paths read consistently again (the
  regression against `main` is closed); add, remove, the delete fan-out and
  the script stay eventually consistent; stays OPEN, narrowed; `updated:`
  and `refs:` updated (:9-10).
- Spec 4.2 (:201-206): one sentence, as its own bullet.

Evidence: red 5 failed / 67 passed (72), 4 files - `fixwave3-B-F5a-red.log`
(3 x no ConsistentRead in the request / pass-through, 2 x restore reads
without `consistentRead`); the DynamoDB Local acceptance pin passes on the
old code by construction (the runtime ignored the option) and is an
acceptance pin, not a behavior red. Green 72/72 `fixwave3-B-F5a-green.log`.
Neighbors (every app test file naming `getManyByIds`, `readRosterContacts`,
`restoreWithLandlord` or a restore route): 32 files 718/718
`fixwave3-B-F5a-neighbors.log`.

## F5b - the Delete dialog sentence

- `dashboard/src/routes/contact/ContactDetail.tsx:146-147` - the new copy,
  exactly as ruled; comment :140-145 says why ("when someone can": no heir,
  no change) and what the server targets.
- `dashboard/src/routes/contact/ContactDetail.test.tsx:3114-3115` - the pin
  (and the describe's comment :3107-3112).
- Spec 7.6 (:663-673). The plan and the records were not edited. A sweep of
  live `*.ts`, `*.tsx`, `*.md`, `*.json` (outside the plan, the review
  records and `.superpowers/`) finds the old sentence nowhere.

Evidence: red 2 failed / 133 passed (135) `fixwave3-B-F5b-red.log`; green
135/135 `fixwave3-B-F5b-green.log`.

## Orchestrator additions (F1 rule in two more spec sentences)

- Spec 4.4 (:292-296): the 470 Bolton sentence - not typed landlord ->
  the no-eligible line plus "Choose a primary" (the line alone for a
  caseworker); the one-click names an `autoEligible` row only.
- Spec 10 (:846-849): the box's one-click is pinned to the `autoEligible`
  flag; a sole contact not typed landlord gets the line plus "Choose a
  primary" (a caseworker: the line alone).
- The no-flag issue's "What staff see meanwhile" (above).
- `docs/issues/restore-without-landlord-can-leave-nobody-reachable.md`: left
  alone, as ruled.

## Verify commands (bare, redirected; on the committed tip `4e430a6e`, tree clean)

| Command | Exit | Result | Log |
|---|---|---|---|
| app vitest (the brief's 10 files + `contactsRepoConsistentBatchRead.test.ts` + `propertyContact.test.ts`) | 0 | 12 files, 171/171 (no suite skipped) | `fixwave3-B-verify-app.log` |
| dashboard vitest `ContactDetail.test.tsx` | 0 | 135/135 | `fixwave3-B-verify-dashboard.log` |
| `npm run typecheck` | 0 | all workspaces | `fixwave3-B-typecheck.log` |
| `npm run smoke` | 0 | 1705 specifiers across 296 emitted files resolve | `fixwave3-B-smoke.log` |
| `npx eslint` on the 18 touched `.ts`/`.tsx` | 0 | no output | `fixwave3-B-eslint.log` (list `fixwave3-B-touched-files.txt`) |
| `npm run issues` | 0 | 416 open / 209 closed | `fixwave3-B-issues.log` |

Baselines before any edit: app 11 files 150/150, dashboard 135/135
(`fixwave3-B-baseline-app.log`, `fixwave3-B-baseline-dashboard.log`).
Not run, per the brief: the full `npm test`, any `npm run e2e`.

## Divergences from the findings / brief (with rationale)

1. More F2 pins than listed: the pure predicate cases, a second DynamoDB
   Local case (the lost write's retry re-check - the only place the RETRY
   path, not just the first read, meets the new predicate), parity rows for
   both negatives, and a route-level negative folded into the route case.
2. The two guard negatives cannot go red on the old code (it targeted no
   no-flag unit); their teeth were shown against two deliberately wrong
   predicates instead, then the file was restored byte-for-byte before the
   commit.
3. Not named in the brief: a `readRosterContacts` pin in
   `app/test/propertyContact.test.ts` (the lib-level pass-through) and a
   DynamoDB Local acceptance case in `contactsRepo.integration.test.ts`
   (BatchGetItem accepts the per-table `ConsistentRead`); both files are in
   the verify run.
4. The pin file is new (`contactsRepoConsistentBatchRead.test.ts`), as the
   brief anticipated, although `app/test/contactsBatchIncomplete.test.ts`
   already captures BatchGet inputs for `getRecipientDisplaysByIds` (the
   worklist's "no contactsRepo test pins the BatchGet input" missed it); that
   file is about incomplete reads, so the new concern got its own file.
5. The spec 4.4 and 10 sentences name the caseworker case (the line alone,
   no button), which the orchestrator's paraphrase of the F1 rule left out;
   spec 7.4's fourth case says so.
6. The resolved issue's "What staff see meanwhile" paragraph keeps its last
   sentence (the dialog did not hold for this shape before the fix); the
   Resolution says it holds now.
7. One docs commit for F2 + F5a + F5b + the orchestrator additions (the
   brief's "your docs commit"); the code commits stay one item each.

## Noticed, not touched (the orchestrator's eye; nothing blocking)

- Spec 9.2's parenthetical lists `landlordWasPrimary`'s users as
  `restoreWithLandlord`, the restore route and the fake; the delete hand-off
  now also uses it, through `contactIsPrimaryToHandOff`. 9.2 does not
  restate the asymmetry, so per the brief it was left as is.
- Spec 4.2's previous bullet still cites `contactsRepo.ts:979` (pre-merge
  anchor) for "the batch read is eventually consistent"; true of the default
  and of the delete fan-out it describes, and the new bullet scopes the
  restore exception.
- Spec 10's P3 "delete:" test list does not name the no-flag landlord case.
- The parity table observes state only, so "the landlord of record always
  counts" passes its flag-wins row (re-flagging the flagged row is a no-op
  write); the service pin catches it through `targets` and the audit row.
- `docs/issues/contact-list-rule-duplication-and-fake-drift.md` (open) tracks
  rules hand-copied into the FakeWorld; the delete hand-off's re-check is now
  shared (one fewer copy). Its Update block does not say so.
- The restore CLEAR path's repo write applies the route's `promote` and never
  calls `readContacts`, so the consistent `readContacts` is exercised by the
  swap; the clear's consistent read is `clearedLandlordHeir`'s (both pinned).

Reference notes (anchors, exact copy, the mutant procedure):
`.superpowers/sdd/fixwave3-B-reference.md` (gitignored).
