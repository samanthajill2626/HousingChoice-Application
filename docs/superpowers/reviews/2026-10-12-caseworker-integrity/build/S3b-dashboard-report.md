# S3b build report - D3 / I2 dashboard: the contact-type copy and team members (U4)

Implementer: U4 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from 550f86bd (S1, S2 and the S3 backend half done;
base 19607658). Plan `docs/superpowers/plans/2026-10-12-caseworker-integrity.md`
Tasks 3.11-3.18 (the DASHBOARD half of slice S3), orchestrator correction C1,
the full S3 slice gate and the required mutant check (M1-M9). No `app/` file
was edited. Findings only; code is cited by file:line at 3ce049f3 (the last
code commit).

Headline: 8 commits, one per plan task. Every RED failed for the reason the
plan states, every GREEN passed as written, every plan anchor matched exactly
once, and no step needed rework. The full S3 gate is green: both vitest runs
and typecheck exit 0, eslint reports exactly the two named baseline errors and
nothing else (confirmed at the merge base), the coverage check prints 63
paths that are all listed, and every ASCII check prints 0. All nine required
mutants (plus five extras) were killed by the slice's tests, so no gap test was
added. No STOP condition was hit: no contract mismatch with plan section 2 or
the backend HANDOFF, no RED for the wrong reason, no GREEN that needed changes,
no unlisted mutation surface or reader.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 3.11 contactTypeErrors.ts | d61533fa | the file failed to load: `Failed to resolve import "./contactTypeErrors.js" from "src/lib/contactTypeErrors.test.ts"`; no tests ran | 19/19; eslint 0 |
| 3.12 TourDetail | 3d52f3cb | `-t "contact-type refusals"`: 3 failed (125 skipped); the header alert read `contact_not_tenant`, `contact_not_tenant` and `tenant_not_found` (err.message) | TourDetail 128/128, the three W7 tests the plan names included; eslint: only the baseline `react-hooks/purity` (now :342) |
| 3.13 TourModals failureCopy | d76b20b7 | 3 failed, 9 passed (12): Reopen and Reschedule `contact_not_tenant` read "This tour changed since the page loaded - reload and try again."; Reopen 404 read "Couldn't reopen the tour - please try again."; both PINs passed | TourModals + TourDetail 2 files / 140; eslint 0 |
| 3.14 ScheduleTourForm | 68ada7da | `-t`: 2 failed; both alerts read the fixed "Couldn't schedule the tour ... please try again." | 30/30; eslint: only the baseline `react-hooks/set-state-in-effect` (now :242) |
| 3.15 PlacementCreateForm | 3ed6d5f0 | `-t`: 2 failed; both alerts read the fixed "Couldn't create the placement ... please try again." | 16/16; eslint 0 |
| 3.16 PlacementsPage | 16c4d075 | `-t`: 1 failed (the alert read "That move was rejected. The placement kept its stage."); the PIN passed | 11/11; eslint 0 |
| 3.17 PlacementDetail | cefc0571 | `-t`: 1 failed (`findByText` for the sentence timed out; the `role="alert"` bar held the fixed "That move was rejected ... please try again."); the PIN passed | 42/42; eslint 0 |
| 3.18 TenantFile | 3ce049f3 | 1 failed, 4 passed (5): the team-member case found the "Schedule a tour" button; the PIN passed | TenantFile + ContactDetail + files 3 files / 175; eslint 0 |

Before its commit every task ran the C1 ASCII checks (0, no MISSING line) and
eslint on its two files. Logs: `.superpowers/sdd/logs/s3b-*.log` (run state).

Where the code landed:
- `dashboard/src/lib/contactTypeErrors.ts`: phrase table `:13`, fallback phrase
  `:23`, `contactTypeErrorMessage` `:26` (non-ApiError -> null `:27`; the five
  codes `:29-43`; `default` -> null `:44`).
- `dashboard/src/routes/tours/TourDetail.tsx`: import `:59`; `runDirect`
  `:383`; `handleConvert` (Start placement) `:515-517`; `confirmOutcome`'s
  from-tour `:591-594`.
- `dashboard/src/routes/tours/TourModals.tsx`: import `:32`; file-head comment
  `:26-29` (see Divergences); `failureCopy` `:44-54` (helper first `:51-52`,
  then today's 409 rule `:53`). It serves all six dialogs; only Reschedule (a
  canceled tour) and Reopen can receive the codes.
- `dashboard/src/routes/tours/ScheduleTourForm.tsx`: import `:52`; early return
  `:330-335`; the fallback `:336` untouched.
- `dashboard/src/routes/placements/PlacementCreateForm.tsx`: import `:38`; early
  return `:252-257`; the fallback `:258` untouched.
- `dashboard/src/routes/placements/PlacementsPage.tsx`: import `:33`; the move
  catch `:96-99`.
- `dashboard/src/routes/placements/PlacementDetail.tsx`: import `:56`; the new
  `.catch` `:403-411` (null rethrows to the untouched fixed-copy catch `:412`).
- `dashboard/src/routes/contact/TenantFile.tsx`: `isTenant` `:169`; the two
  gates `:325` ("+ Schedule") and `:353` ("+ Start placement"). ContactDetail's
  wiring (`ContactDetail.tsx:1230-1231`) is unchanged.
- New tests: `contactTypeErrors.test.ts:13`, `TourDetail.test.tsx:2343`,
  `TourModals.test.tsx:136`, `ScheduleTourForm.test.tsx:642`,
  `PlacementCreateForm.test.tsx:338`, `PlacementsPage.test.tsx:185`,
  `PlacementDetail.test.tsx:910`, `TenantFile.test.tsx:107` (37 tests).

## C1 - ASCII checks

Every check ran from the worktree with an explicit `cd`, a `test -f || echo
MISSING` per file, `tr -d '\11\12\15\40-\176' < f | wc -c` per new file and
`git diff -U0 19607658 -- <edited files> | grep '^+'` through the same `tr` for
edited files, in each task and at the gate. All printed 0; no MISSING line. At
the gate: 2 new files 0 each; 14 edited files, 418 `+` lines, 0 non-ASCII
bytes. Ruling S3-4 held: the three em-dash fallback lines
(`ScheduleTourForm.tsx:336`, `PlacementCreateForm.tsx:258`,
`PlacementDetail.tsx:412`) are not among the 17 removed lines and are
byte-unchanged; the tests match them by ASCII prefix.

## Divergences from the plan

- Task 3.13: the file-head comment of `TourModals.tsx` said a 409 in every
  dialog reads TOUR_CHANGED_COPY, which the task makes false. It now names the
  contact-type exception (`:26-29`, comment only, ASCII). The commit carries one
  extra body paragraph saying so; its subject is the plan's.
- Mutants: five extras beyond M1-M9 (M5b, M5c, M6b, M8b, M9b), all killed.
- Per-task eslint runs, the merge-base lint baseline and a post-mutant re-run
  are extra, for the record.
- Gate form: each vitest, typecheck and eslint run redirected its output to a
  file under `.superpowers/sdd/logs/` and echoed `$?` (a redirect, never a
  pipe), as in S2 and S3a. Command lines otherwise exactly the plan's.
- Each task's Step 5 used C1's ASCII form instead of the plan's
  `grep -P '[^\x00-\x7F]'` (by instruction).
- Code and tests: none. Every old_string matched exactly once and every
  new_string is the plan's text. No good divergence found (nowhere was the live
  code better than the plan).

## Slice gate (bare commands, from the worktree, at 3ce049f3)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest, the plan line 9177 command exactly (20 files) | 0 | 20 files, 596 passed (same as S3a) |
| 2 | dashboard vitest, the plan line 9178 command exactly (10 files) | 0 | 10 files, 433 passed (396 before this half + 37 new) |
| 3 | `npm run typecheck` | 0 | all five workspaces, no TS error |
| 4 | `npx eslint` on the full S3 list of plan line 9188 (34 paths) | 1 | exactly 2 errors, both baseline (below) |
| 5 | coverage: `git diff --name-only --diff-filter=d 19607658...HEAD -- '*.ts' '*.tsx'` | 0 | 63 paths, each in the S1 (plan line 3253 + `app/test/aiRunVerdicts.test.ts`), S2 (5558) or S3 (9188) list; none missing |
| 6 | C1 ASCII over all 16 files this half created or edited | - | 0 everywhere, no MISSING |

Lint: the two errors are the pre-existing baseline named in plan section 0,
NOT fixed here (out of scope; `docs/issues/lint-backlog-repo-wide.md`):
- `dashboard/src/routes/tours/TourDetail.tsx:342:85` `react-hooks/purity` -
  `Date.now()` in the `startPassed` computation (was :341; +1 from the import).
- `dashboard/src/routes/tours/ScheduleTourForm.tsx:242:7`
  `react-hooks/set-state-in-effect` - `setTourType(DEFAULT_TOUR_TYPE);` in the
  unit-picked effect (was :241; +1 from the import).
The section-0 merge-base run (base = 19607658) on the same 34 paths: base
`TourDetail.tsx` prints exactly its one error (`:341:85`, same rule, same
flagged source text) and base `ScheduleTourForm.tsx` its one (`:241:7`, same);
the 19 other existing files lint clean at base (rc 0); the 14 files new on the
branch have no baseline and lint clean on it. Nothing else is S3's.

No `[dynamoAdmin]` line in the app gate log. DynamoDB Local was already up; it
was not started, restarted or stopped. No `AWS_*` variable was exported.

## Mutant check

Each mutant was applied and reverted with the Edit tool; the sha256 of the
eight mutable files was checked against a pre-mutant baseline after every
revert (all OK). Every mutant ran the full 10-file dashboard gate list (433
tests). After the last revert `git status` was clean and `git diff --stat`
empty; a post-mutant re-run passed 433/433.

| Mutant | Where | Tests that went red (of 433) |
|---|---|---|
| M1 null for contact_not_tenant | `contactTypeErrors.ts:34` | 15 in 7 files: the 7 helper `contact_not_tenant` cases (6 kinds + the fallback), TourDetail status change + Start placement, TourModals Reopen + Reschedule 409, ScheduleTourForm 409, PlacementCreateForm 409, PlacementsPage sentence, PlacementDetail sentence |
| M2 generic sentence for an unknown code (W7) | `contactTypeErrors.ts:44-45` | 26 in 7 files: the 5 helper null cases that are ApiErrors; the new PINs (TourModals x2, PlacementsPage, PlacementDetail); and pre-existing W7 tests - ScheduleTourForm and PlacementCreateForm `on an API error keeps the dialog open...`, TourModals `a 409 ApiError (any reopen refusal)...` and `any other rejection...`, and 13 TourDetail tests (the three the plan names, the seven `a 409 in a writing tour dialog` cases, both Mark already toured failure cases, the Reopen failure case) |
| M3 unknown reads "a unknown" | `contactTypeErrors.ts:19` | 1: `contact_not_tenant with contactKind unknown` |
| M4 failureCopy asks the helper after the 409 rule | `TourModals.tsx:51-53` | 2: TourModals Reopen and Reschedule 409 `contact_not_tenant`. The Reopen 404 case survives by design (a 404 is not a 409) |
| M5 Start placement mapping dropped | `TourDetail.tsx:516` | 1: `Start placement refused as contact_not_tenant...` |
| M5b (extra) outcome-then-convert mapping dropped | `TourDetail.tsx:592` | 1: `move-forward whose conversion finds the contact gone...` |
| M5c (extra) runDirect mapping dropped | `TourDetail.tsx:383` | 1: `a status change refused as contact_not_tenant...` |
| M6 PlacementDetail catch always rethrows | `PlacementDetail.tsx:409` | 1: `a lost placement moved back to an active stage...` |
| M6b (extra) that catch swallows a non-type error instead of rethrowing | `PlacementDetail.tsx:409` | 1: only the new `(PIN) any other rejected move keeps the fixed copy` - that PIN is load-bearing |
| M7 PlacementsPage mapping dropped | `PlacementsPage.tsx:98` | 1: `a move refused as contact_not_tenant...` |
| M8 team member gets both actions | `TenantFile.tsx:169` | 1: `a team member gets neither action...` |
| M8b (extra) only the "+ Start placement" gate dropped | `TenantFile.tsx:353` | 1: same test (each button is asserted on its own) |
| M9 ScheduleTourForm mapping dropped (branch never taken) | `ScheduleTourForm.tsx:331` | 2: both ScheduleTourForm refusal tests |
| M9b (extra) the same in PlacementCreateForm | `PlacementCreateForm.tsx:253` | 2: both PlacementCreateForm refusal tests |

## Surprising, or sub-threshold worries

- `TourDetail.tsx:383` (`runDirect`) cannot receive an I2 refusal today: it
  serves Mark toured / Mark no-show on a SCHEDULED tour, an open-to-open move
  the server never checks (S3a HANDOFF). The mapping is defensive, as planned
  (CONTRACT ISSUE 1); its test mocks a refusal the server cannot send there.
- `ToursPage.tsx:478` bulk Mark toured is not a copy site (it PATCHes only after
  re-reading `scheduled`, `:466-468`). A tour canceled between that re-read and
  the PATCH would be a revive; for a non-tenant the server refuses it and the
  row shows its fixed "The update failed". Race-only, correctly refused;
  recorded only (matches RC reference section 7).
- The PlacementsPage refusal is reachable: the Closed view renders the
  StageMenu on lost / moved_in rows (`PlacementsPage.tsx:206-213`). The unit
  test drives collect_rta -> review_rta (a move the server never refuses); it
  pins the mapping, not reachability, as the plan wrote it.
- `contactTypeErrors.ts` imports `ApiError` from `../api/client.js` (plan text)
  while `holdingRefusals.ts` uses `../api/index.js`. Same class (the barrel
  re-exports it, and every touched test mocks the barrel with importActual +
  spread); a test that mocked `api/client.js` itself would break `instanceof`.
  None does.
- Stale-but-true comments left alone: `TourModals.test.tsx:1-9` ("a 409 says
  reload" describes the ReopenTourModal block, still true for its codes) and
  the TenantFile `onStartPlacement` prop doc ("Only the tenant view wires
  this.", false before this branch since ContactDetail wires team members too;
  true in outcome now that TenantFile gates it).
- The `tenant` phrase ("a tenant") is unreachable from the server today
  (`contactKind` is never `tenant`); kept per plan section 1.
- The ContactDetail "Run AI extraction" tests print React act() warnings on
  stderr (pre-existing, noted in the S2 report). The documented
  ScheduleTourForm flake (`docs/issues/schedule-tour-form-test-flake.md`) did
  not appear in any run.

## HANDOFF for the S4 implementer (contactTypeErrors.ts as shipped)

- Module `dashboard/src/lib/contactTypeErrors.ts`; ONE export:
  `contactTypeErrorMessage(err: unknown): string | null`. The phrase table and
  fallback phrase are module-private. From a route file:
  `import { contactTypeErrorMessage } from '../../lib/contactTypeErrors.js';`
  (the form S4's plan text already uses at plan lines 11560, 11853, 12370).
- It decides on `err.code` alone (never `err.status`) and only for an
  `ApiError` (from `api/client.js`, the class `api/index.js` re-exports);
  anything else (plain Error, string, undefined) is null.
- Sentences: `contact_not_tenant` "Tours and placements are for tenants. This
  contact is <phrase>." (phrase from `body.contactKind`: a tenant, a landlord,
  a partner, a caseworker, a team member, not classified yet; missing or
  unrecognized -> "not a tenant"); `tenant_not_found` "That contact no longer
  exists."; `landlord_not_landlord` "Only a landlord can be a property's
  landlord of record."; `landlord_not_found` "That landlord no longer
  exists."; `contact_list_caseworker` "Caseworkers can't be on a property's
  contact list." All ASCII, pinned verbatim in `contactTypeErrors.test.ts`.
- Null for every other code, including `restore_needs_landlord` (the restore
  dialog branches on it itself), `unit_roster_conflict` and
  `landlord_reassignment_required`, so `runRosterWrite` keeps its own copy for
  those. Like `failureCopy` (`TourModals.tsx:51-53`), map the helper BEFORE any
  catch-all 409 rule.
- Site patterns used here, for reuse: `helper ?? <existing fallback>` when the
  fallback is an expression (TourDetail, PlacementsPage); an early return before
  an untouched fallback line when that line carries non-ASCII (ScheduleTourForm,
  PlacementCreateForm); a preceding `.catch` that rethrows on null
  (PlacementDetail).
