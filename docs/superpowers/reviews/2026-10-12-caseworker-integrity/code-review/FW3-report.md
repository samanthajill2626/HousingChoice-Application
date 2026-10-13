# FW3 report - micro-wave after R3 (caseworker integrity)

Implementer: FW3 (Claude Opus 5.5), caseworker-integrity mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 0790e961. Brief
`.superpowers/sdd/briefs/FW3.md`; work order `R3-adjudications.md` rows
FW3-1..FW3-4. Code is cited by file:line at 71a49bc5 (the last commit before
this report).

Headline: four item commits plus this report. Both REDs failed for the
reviewer's predicted reason before their fix; both revert proofs went red on
exactly the new cases and were restored byte-identically (sha256 against a
pre-revert baseline). The gate is green. Behavior changed only in the restore
route's sole-landlord promotion; no dashboard code and no spec text changed.
Baseline before any edit: `unitsRestoreLandlord.test.ts` 24 / 24.

## Commits

| Item | Commit | RED (before the fix) | GREEN | Revert proof |
|---|---|---|---|---|
| FW3-1 (R3B-A1) | d7a01893 | 2 failed / 26: F3a received `primaryContact: true` for the deleted c-gone (promoted); F3b received `primaryContact: false` for c-pm (nobody promoted) | 26 / 26; app typecheck 0 | clause removed: 2 failed / 26 (F3a and F3b only); restored, sha256 `e6e05b3e42650df0d88f09f7fbb4734a769dfdd95cd4a03ec65e6c5155e3fe80` OK |
| FW3-2 (R3B-A3) | b29f6e13 | 1 failed / 27: F1 `expected 200 to be 409` (the injection ran - `added` is asserted true first - and the fake let the stale promotion through) | 27 / 27; app typecheck 0 | `expectContacts` back to `stored.contacts`: 1 failed / 27 (F1 only, `expected 200 to be 409`); restored, sha256 `a4c25449f6317de254cf14ce4feb9fd9d5a369e37e4a3bc9fa01ffe539bbd0f8` OK |
| FW3-3 (R3B-A5, R3D-A1..A5) | 5960f862 | docs / comments | eslint 0, ASCII 0 | n/a |
| FW3-4 (R3B-A2 / C-1, R3D-C2) | 71a49bc5 | new issue | `npm run issues` 0 | n/a |
| report | (this commit) | - | - | - |

Logs: `.superpowers/sdd/logs/fw3-*.log` (every run redirected with its exit
code echoed, never piped); hash baselines
`.superpowers/sdd/fw3-fw31-baseline.sha256`, `fw3-fw32-baseline.sha256`.

## FW3-1: a soft-deleted contact is not eligible

- `app/src/routes/units.ts:458`: `!isContactDeleted(contact)` in
  `soleLandlordToPromote`'s eligibility - the contacts repo's own test
  (`app/src/repos/contactsRepo.ts:369`, `deleted_at` non-empty), imported as
  `isContactDeleted` (`units.ts:66`) because the file already imports the
  units repo's `isDeleted`; the alias is the codebase's precedent
  (`app/src/services/orgRecords.ts:66`, `app/scripts/clean-org-names.ts:69`).
  Route only: the repo takes the decision as input, unchanged. The
  function's doc states the rule.
- Tests (`app/test/unitsRestoreLandlord.test.ts`): `:442` F3a - the only
  landlord-typed remaining row is a soft-deleted contact: 200, nobody
  promoted, no scalar, `landlordCleared` without `primaryPromoted`; `:457`
  F3b - one soft-deleted and one live landlord-typed row: the live c-pm is
  promoted (row flagged, scalar, `primaryPromoted { to: 'c-pm' }`). The
  describe block's header comment names the rule.

## FW3-2: one contact-list read for the decision and the write condition

- `app/src/routes/units.ts:1800`: `const listRead = stored.contacts;`, read
  once before the awaited type reads. It is `soleLandlordToPromote`'s input
  (`:1801`; the function now takes `listRead` and derives its rows as
  `unitContacts({ contacts: listRead, landlordId: clearedLandlordId })`,
  `:443` - the same landlordId-derived row when no list is stored) and
  `expectContacts` (`:1810`).
- Test `unitsRestoreLandlord.test.ts:531` (F1): `world.contactsRepo.getById`
  wrapped so staff B's add of a second landlord-typed contact (c-owner,
  through the fake's `addContact`) lands inside the route's read of c-pm's
  type: 409 `unit_roster_conflict`, the unit still deleted with landlordId
  and primary c-old, c-owner on the list unflagged, no `unit_restored`.
- Informational second mutant: only the decision half reverted
  (`unitContacts(unit)` in place of the `listRead` rows): 0 failed / 27. The
  function reads the list synchronously before its first await, so no test
  can separate the halves; the load-bearing half is `expectContacts` (the
  revert proof above). Restored; the sha256 matched the same baseline.

## FW3-3: comments and docs

1. `app/src/routes/units.ts:1119-1138`, the POST contacts route doc: 409
   `contact_list_caseworker` and `landlord_not_landlord` (from the route's
   checks or the roster write), `landlord_reassignment_required`,
   `unit_roster_conflict`; 404 `unit_not_found` and `contact_not_found` (a
   missing contact or a phone / email routing pointer id); auto-primary (a
   new seat typed landlord, no row marked primary, no landlord of record,
   even with `primaryContact` false or absent); the scalar routes nothing.
2. `app/src/repos/unitsRepo.ts:58-70` (`UnitContact`), `:327-338`
   (`UnitItem.primary_contact`), `:501-505` (addContact's interface doc):
   aligned with the note above the roster write (`:982-990`). The touched
   lines are ASCII: a phone glyph (`UnitContact`) and an em dash
   (`primary_contact`) on rewritten lines became plain text.
3. `dashboard/src/api/endpoints.ts:1029-1045`, `restoreUnit`: the revision-5
   sole-landlord promotion (one remaining live landlord-typed contact; a
   soft-deleted one does not count; render the answer's roster) and, for
   `{ landlordId: null }`, 409 `unit_roster_conflict` as "the contact list
   changed between the server's read and its write - nothing restored".
4. `e2e/support/selectors.md:136`: the second-alert examples are the two
   that can show beside the landlords load error - `The property contacts
   changed - try that change again.` and `Couldn't restore - please try
   again.`.
5. `docs/issues/contact-type-refusal-copy-edge-cases.md`: all 30 citations
   checked by printing each cited line; 14 re-pointed (4 frontmatter, 10
   body), 16 still right. One was missing from R3D-A5's list:
   `RestoreLandlordDialog.test.tsx:63` -> `:64` (moved by FW2-6, d1d94fdb).
6. `docs/issues/listing-detail-dialogs-survive-property-navigation.md`: the
   FW2-5 note corrected in place (the guard fixes the permanent spinner
   only; what still lands is summarized, with R3-dashboard.md A2 as the
   pointer for each location); R3 dashboard A1 appended (scenario, three
   consequences, LOW rationale, fix direction, the probe's cases inverted
   as regression tests); refs gain `ListingDetail.tsx:407`, `:1425`. Every
   A1 code claim was re-read at the head before filing
   (`ListingDetail.tsx:306`, `:407-410`, `:430`, `:471-478`, `:1425-1428`,
   `:1429-1443`; `useListing.ts:168`; `App.tsx:271`).

## FW3-4: the new issue

`docs/issues/restore-without-landlord-can-leave-nobody-reachable.md` - type
`decision`, severity low, area app, created 2026-10-12, open. Shape 1
(R3B-A2 / C-1) with the reviewer's one-disjunct fix for `next === null`
(route gate `units.ts:445-447`, repo `oldWasPrimary` `unitsRepo.ts:1292-1293`,
fake `twilioWebhookHarness.ts:3145-3146`) recorded for Cameron's ruling;
shape 2 (R3D-C2), the missing copy, set beside the Remove confirm's ruled
sentence (`ListingDetail.tsx:542`). Every ref resolved by printing the cited
line.

## Gate (bare, from the worktree, at 71a49bc5)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app `npx vitest run` unitsRestoreLandlord, unitsRepoRestoreWithLandlord.integration, unitsApiRoster, unitsApiRosterTypeChecks, unitsApiRosterAutoPrimary | 0 | 5 files, 110 passed: 27, 18 (DynamoDB Local), 25, 23, 17 |
| 2 | dashboard `npx vitest run src/api/endpoints.test.ts` | 0 | 1 file, 51 passed |
| 3 | `npm run typecheck` | 0 | all 5 workspaces |
| 4 | `npx eslint` units.ts, unitsRepo.ts, unitsRestoreLandlord.test.ts, endpoints.ts (every touched .ts; no .tsx touched) | 0 | no output |
| 5 | ASCII, `git diff -U0 0790e961` added lines | - | 8 touched files: 0 non-ASCII bytes, none MISSING (each file has added lines in the diff); the new issue file, whole file: 0; commit messages 0790e961..HEAD: 0 |
| 6 | `npm run issues` | 0 | 404 open, 203 closed, 607 total; no warnings |

No `[dynamoAdmin]`, SKIPPED or ENOBUFS line in any log. DynamoDB Local was
not started, stopped or restarted; no Docker command; no `AWS_*` variable
set (none in the environment); no full `npm test`, no e2e.

## Noticed, not fixed

1. Spec section 4 "Restore" (revision 5) still reads "a contact typed
   `landlord`" without the soft-deleted exclusion FW3-1 implements; R3
   backend C-2 recommended saying so in the spec, and the brief named no
   spec edit.
2. `restoreUnit`'s doc still omits the 404 `unit_not_found` R3D-A4 also
   mentioned (FW3-3 item 3 named two clauses).
3. FakeWorld fidelity in general: the harness's `unitsRepo.getById` still
   returns the live map object (`app/test/helpers/twilioWebhookHarness.ts:2839-2841`),
   so another route that reads a unit field again after an await can diverge
   from production in the fake the same way; FW3-2 closes the restore
   route's window only. The reviewer's R1 (the real router on DynamoDB
   Local) was not added (not in the brief).
4. FW3-3's commit message says "13 moved" for the re-derived refs; the count
   is 14 (item 5 above).
5. The restore route's header line (`app/src/routes/units.ts:1697`) still
   lists only "404 when missing" (the block below it states the 409s); it
   was not in FW3-3's list and carries a non-ASCII arrow.
