# S5 build report - seeds, e2e, docs (U7)

Implementer: U7 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 18509585 (S1-S4 done; base 19607658). Plan
`docs/superpowers/plans/2026-10-12-caseworker-integrity.md` Tasks 5.1-5.9 and
the S5 slice gate, with orchestrator corrections C1-C10. No app or dashboard
source was edited. Findings only; code is cited by file:line at the tip.

Headline: 8 commits, one per task (5.2's sweep was clean, so no commit). Task
5.1's RED failed for the stub reason with the stated counts and its GREEN
passed as written. The seven new e2e cases passed on the first run, then all
four spec files (27 tests) passed twice, the second time as gate step 4. The
slice gate is green: every command exit 0, lint clean, coverage 88 paths all
listed, every ASCII check 0, `npm run issues` without a warning, clean tree.
No STOP condition was hit: no product behavior the e2e showed wrong, no
unlisted mutation surface or reader, every doc anchor matched exactly once.

## Per task

| Task | Commit | What it proved |
|---|---|---|
| 5.1 seed invariant test | 7f909843 | RED (stub checker): 6 failed, 6 - the four world cases on `placements checked: expected 0 to be greater than 0`, the two checker cases on `toEqual`. GREEN: 6/6. A scratch replica of the checker (not committed) counted, per world, tours/placements/live units/contact-list rows: lean 0/1/2/2, full 17/39/60/61, performance and performance-lean-fallbacks 50/51/15/18 - the planner's numbers - with zero violations and zero caseworkers in any seed (full: 74 contacts). ASCII 0, typecheck 0, eslint 0 |
| 5.2 W3 e2e sweep | none | CLEAN (below) |
| 5.3 caseworkers.spec.ts | d0a39375 | D2 through the edit form: tenant -> Landlord with an open placement and landlord -> Tenant while landlord of record of a live property are both refused, the sentence and View link shown inside the dialog, the draft kept (`aria-pressed`), nothing written; the edit form's own PATCH answers 409 `type_change_refused` with the one expected refusal for each (`e2e/tests/dashboard-next/caseworkers.spec.ts:622`, `:673`, `:695`), and a direct PATCH to partner is refused too (`:711`) |
| 5.4 property-roster.spec.ts | 7e9d098f | I4: the Add contact search offers the plain partner and never the caseworker sharing its last name; `POST /api/units/:id/contacts` answers 409 `contact_list_caseworker` and seats nothing. I3 restore: the plain restore answers 409 `restore_needs_landlord` with `landlordName` (read off the network, `e2e/tests/dashboard-next/property-roster.spec.ts:331`), the dialog says so; Cancel writes nothing; Restore without a landlord leaves it live and ownerless with the old landlord's row gone; Restore with this landlord seats the pick as `landlord` and drops the old row. The setup re-type of a deleted property's landlord is allowed (D2 counts live units only) |
| 5.5 placements-page + tour-auto-close | d6d526ff | I2 terminal exit: a Lost placement whose tenant became a landlord cannot move back from the placement page; the `role="alert"` bar reads the sentence, the pill stays Lost, a direct transition answers 409 `contact_not_tenant` / `contactKind: 'landlord'` and the stage stays `lost`. I2 tours: the Reopen dialog's POST answers 409 `contact_not_tenant` (`e2e/tests/dashboard-next/tour-auto-close.spec.ts:394`), its alert reads the sentence, no Record outcome dialog, the tour stays closed / not_a_fit; at the API a closed tour's reopen and a canceled tour's revive (PATCH `{ scheduledAt, status: 'scheduled' }`) are both refused and change nothing |
| 5.6 selectors.md rows | 10eec645 | five rows (`e2e/support/selectors.md:134-138`), directly after the Broadcast results row; the blank line and `## Narrow viewport` follow at :139-140 |
| 5.7 RUNBOOK | e5d0ab53 | `RUNBOOK.md:473` (accept fence, the importer, the hand-clear) and `:475` (reads, not locks, with C7's clause) |
| 5.8 three resolutions | 6242bfde | the three issues `status: resolved`, `resolved: 2026-10-12`, a Resolution paragraph each; the third corrected; C3, C4 and C9 applied (below) |
| 5.9 four new issues | 4115c30c | `placement-terminal-stage-exit-unguarded`, `import-bypasses-contact-type-rules`, `landlord-of-record-no-reassign-ui`, `unit-primary-contact-unchecked`; C2, C5 and C6 applied; `npm run issues` exit 0, the four listed open and the three closed in the gitignored INDEX.md |

Before every commit: the C10 ASCII checks, a separate bare `git status` read
and a MERGE_HEAD check (absent every time); explicit paths only. Logs:
`.superpowers/sdd/logs/s5-*` (run state).

## W3 sweep (Task 5.2): clean

The e2e tree is byte-identical to the base except `e2e/support/selectors.md`
(S4b's Q2 row), so the five plan greps return exactly the plan's call sites.
Re-read anyway: every `POST /api/tours` / `POST /api/placements` uses the lean
tenant or a contact created `type: 'tenant'`; the terminal exits move
`placement-0001` (Tasha, a tenant); every `POST /api/units` `landlordId` is
`contact-landlord-0001`, a contact created `type: 'landlord'`, or a scenario
contact made a landlord first (`teamCreatesLandlord` /
`teamTriagesUnknownToLandlord`, all eight `flow.landlordId()` callers checked);
the API contact-list adds (`relay-intro-variants.spec.ts:118`,
`roster-quiet-hours.spec.ts:197`, `tour-roster.spec.ts:141`) seat
landlord-typed PMs; of the 22 contacts PATCH sites in the specs (plus one
tenant-status PATCH, `scenarios/steps.ts:1808`) only `ai-run-log.spec.ts:338`
and `:492` (fresh unknowns, no records) and `caseworkers.spec.ts:252`
(`caseworker_use_conversion`, W6) change `type`; the caseworker fixtures
(`org-lists.spec.ts:700`, `partner-share.spec.ts:69`, contact-create) take no
seat, tour or placement; every suggestion Accept targets a contact created
`type: 'tenant'` and none is re-typed before its Accept. No fixture changed.
The four-spec runs (27 tests, twice) met none of the new codes.

## Orchestrator corrections

- C1: `e2e/tests/dashboard-next/placements-page.spec.ts:373` carries
  `lostReason: { category: 'tenant_withdrew' }` (the route's 400 rule,
  `app/src/routes/statusTransition.ts:187-196`). Nothing else in that test
  changed.
- C2: re-derived N = 1072 (`app/src/routes/units.ts`, "keeps the
  primary_contact scalar") and M = 839 (`app/src/repos/unitsRepo.ts`, "Keep the
  `primary_contact` scalar"). The issue cites `units.ts:1072` and
  `:1072-1075`, `unitsRepo.ts:839` and `:839-848`, and the stale comment
  `unitsRepo.ts:840-841` twice; each line was read. Every other ref in the four
  new issues sits in a file this branch never touched (checked by
  `git diff --stat 19607658`) and was read at its line.
- C3: the `tours-placements-no-contact-type-check` Resolution's landlord bullet
  says 409 `landlord_not_landlord`, a missing contact 404 `landlord_not_found`
  on unit create and PATCH, and the contact-list add's 404 `contact_not_found`.
- C4: `stale-suggestions-survive-contact-retype` stays `status: open`, gains
  `updated: 2026-10-12` (the registry's convention, after `created:`) and a
  "Partly addressed (2026-10-12)" paragraph linking
  `claimed-suggestion-accept-after-caseworker-conversion`; committed with 5.8.
- C5: `landlord-of-record-no-reassign-ui` drops "the only dashboard writer",
  says "no dashboard screen changes it on a live property afterwards", and
  carries the API-PATCH row-swap sentence (`units.ts` PATCH ->
  `unitsRepo.update`, `app/src/routes/units.ts:1536`). Its Suggested fix was
  reworded to match (see Divergences).
- C6: the `import-bypasses-contact-type-rules` bullet cites
  `apply.ts:1137-1144` (voucherSize, notes) and the gates: the stamp is read at
  `:1073` and gates type `:1110`, status `:1088` (via `preserveStatus`),
  housing authority `:1150`, agency `:1156`. "Related:
  `reimport-reverts-unknown-triage`" added (it exists, open). refs gained
  `apply.ts:1137`.
- C7: `RUNBOOK.md:475` names the placement transition's own window in one
  sentence: `transitionPlacement` reads the placement with
  `placementsRepo.getById` (`app/src/services/statusTransition.ts:408`; a
  GetCommand with no ConsistentRead, `app/src/repos/placementsRepo.ts:254-256`)
  before its tenant check (`:420`).
- C8: the stale "its title is S4's choice" comment is gone
  (`e2e/tests/dashboard-next/property-roster.spec.ts:325-327`); the selectors
  row names `getByRole('dialog', { name: 'Restore property' })` as the primary
  handle (`e2e/support/selectors.md:136`).
- C9: the refs line cites `app/src/services/statusTransition.ts:336`
  (`deriveTenantStatus`'s definition; it was :335).
- C10: every ASCII check ran from the worktree with an explicit cd, a
  `test -f || echo MISSING` per file and `git diff -U0 19607658` for edited
  files. All 0, no MISSING line.

## Selectors adjusted to a shipped render choice (CONTRACT ISSUE 5)

- The restore dialog is found by its bound title, `getByRole('dialog', { name:
  'Restore property', exact: true })` (`property-roster.spec.ts:327`), and its
  picker by its bound label, `getByRole('combobox', { name: 'Landlord', exact:
  true })` (`:424`) - plan ruling S4-8 and the S4b HANDOFF - instead of the
  plan's sentence filter and "the dialog's only combobox". Every restore test
  still asserts the sentence (`toContainText`), the third one added that line.
- No other selector differed: every plan name matched the shipped UI (edit
  form, kind picker, `TypeChangeRefusalList`, deleted banner, Restore buttons,
  option names, Reopen dialog, Placement stage menu, alert bar).

## Divergences from the plan

- Wire assertions added where a case drove a refusal in the UI without
  asserting the server's answer (the brief's binding rule: status + code AND
  the sentence): the edit form's PATCH for both refusals (`saveAndReadAnswer`,
  `caseworkers.spec.ts:622`), the plain restore's 409 `restore_needs_landlord`
  with `landlordName` (`restoreRefused`, `property-roster.spec.ts:331`, used by
  both restore tests and for the second Restore after Cancel), and the Reopen
  dialog's POST (`tour-auto-close.spec.ts:394`). Each is a
  `page.waitForResponse` on the page's own request. The placement case already
  had a direct API call and was left as the plan wrote it.
- The claimed-suggestion Resolution: the plan's "No repair step: #19 had not
  deployed anywhere" is false since main 794de277 (#19 DEPLOYED dev and prod
  2026-10-12, release 1.5.1; build-research README "Main moved"). It now says no
  repair step was built (spec D1.7, which assumed #19 was not live), that #19
  went live ahead of this fix, and that an authority written before this fix
  deploys stays until cleared by hand (the RUNBOOK console call).
- `import-bypasses-contact-type-rules`: with C6's bullet, the plan's "which
  covers converted caseworkers" became "for those four fields (not
  `voucherSize` or `notes`, above)", so the issue does not contradict itself.
- `landlord-of-record-no-reassign-ui`: the Suggested fix now describes ONE
  conditional write in `restoreWithLandlord`'s shape instead of "a PATCH of
  `landlordId`" plus row edits, matching C5's "not the bare PATCH".
- `placement-terminal-stage-exit-unguarded`: "lists every stage but the current
  one" became "offers": `StageMenu.tsx:155-172` lists the current stage too,
  disabled and marked "(current)".
- selectors.md rows: beyond the plan text, the edit-form row says the list is
  one `role="alert"` under the kind picker; the restore row carries the S4b
  traps (header Restore, the kebab item sharing the title text, portaled
  `<Full Name> Landlord` options, four non-exact "Restore" matches while the
  dialog is open, the dialog's `role="alert"`, `landlordName` on the 409); the
  placement row notes that a move out of Lost needs no prompt
  (`transitionGate.ts:21-30`).
- Run procedure: the plan's per-task "new tests, then the whole file" e2e
  steps ran as two combined invocations over the four specs (the seven new
  cases by `--grep`, then the four whole files) before the three e2e commits,
  then the gate's step 4 on the final tip - fewer lane boots, same coverage.
- Commit bodies carry one extra paragraph each where a correction landed (C1 in
  5.5, the restore selectors in 5.4 and 5.6, C7 in 5.7, C4 and the #19 deploy
  in 5.8, C2/C5/C6 in 5.9). Subjects are the plan's.

## Slice gate (bare, from the worktree, at 4115c30c)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | `npx vitest run test/seedContactTypeInvariants.test.ts` (app) | 0 | 1 file, 6 passed |
| 2 | `npm run typecheck` | 0 | five workspaces, 0 TS errors |
| 3 | `npx eslint` on the five S5 `.ts` paths | 0 | no output; `--print-config`: 46 rules, `@typescript-eslint/no-unused-vars` at error, on an e2e spec and the seed test |
| 3b | coverage: `git diff --name-only --diff-filter=d 19607658...HEAD -- '*.ts' '*.tsx'` | 0 | 88 paths, each in the S1 (plan :3253 + `app/test/aiRunVerdicts.test.ts`), S2 (:5558), S3 (:9188), S4 (:12614) or S5 list; none orphaned |
| 4 | `timeout 1200 npm run e2e -w @housingchoice/e2e -- <the four specs>` | 0 | caseworkers 6/6, property-roster 4/4, placements-page 12/12, tour-auto-close 5/5; 27 expected, 0 unexpected, 0 flaky, 0 skipped; 55.0 s |
| 5 | ASCII (C10) | - | 5 new files 0 each, no MISSING; 10 edited files, 631 added lines vs 19607658, 0; commit messages 18509585..HEAD 0 |
| 6 | `npm run issues` | 0 | no warning; 401 open, 202 closed, 603 total; `git status` clean, INDEX.md ignored (`.gitignore:62`) |

Earlier runs, same harness: the seven new cases alone 7/7 (22.8 s, exit 0),
then the four whole files 27/27 (60.0 s, exit 0). Lint needed no attribution
run (no error). No `[dynamoAdmin]` line in any S5 log (vitest or e2e).

## Surprising, or sub-threshold worries

- DynamoDB Local: I never started, stopped or restarted it. Each e2e launcher
  runs its own `db:start` ensure against the running container ("already
  running" in all three logs); none printed a prune line
  (`scripts/db.mjs:160`).
- After each Playwright teardown `e2e/.artifacts/session.pid` was left behind
  with its launcher dead and lane 6's four ports free (checked); the next
  launcher self-healed. Benign; listeners on other lanes belong to other
  worktrees and were left alone.
- The suite is quick here: 27 tests in about a minute. The setup polls
  (`deletedWithRetypedOwner`, `retypeToLandlord`, the placements re-type, the
  caseworkers preview polls) passed on their first or second try; their 10 s
  budget is the index-lag allowance (spec L1). On a loaded full-suite run a
  longer lag would fail at setup, never pass vacuously.
- Not proven end to end, by plan design: the Reschedule dialog's sentence for a
  refused revive (asserted at the API only; unit-tested in TourModals.test.tsx,
  S3 Task 3.13), and the contact-list refusal sentence (the picker hides the
  caseworker, so only a race or the API reaches 409 `contact_list_caseworker`;
  unit-tested in S4b).
- RUNBOOK merge: main 794de277 edits the same Caseworkers section (the heading
  at `RUNBOOK.md:450` and a new DEPLOYED paragraph after it); this branch edits
  `:473-475`. The hunks do not overlap, so the one main sync may merge
  cleanly, but both should be read together afterwards: main's paragraph says
  "Until it is live ..." of this fix, which stays true until it deploys.
- The date used in 5.8 and 5.9: 2026-10-12 (`date +%F` printed 2026-10-12).
