# S2 build report - D2 type change refusal (U2)

Implementer: U2 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from f13d5e57 (S1 done; base 19607658). Plan
`docs/superpowers/plans/2026-10-12-caseworker-integrity.md` Tasks 2.1-2.8,
the slice gate, orchestrator corrections C1-C2 and the required mutant check.
Findings only; code is cited by file:line at 99c2e52d.

Headline: 9 commits (8 plan tasks + 1 mutant-gap test). Every RED failed for
the reason the plan states with the stated counts, every GREEN passed as
written, every plan anchor matched once, the slice gate is green (all exit
0), lint is clean, and W2/W6 hold. Mutant M4 survived every suite; the
missing test was added in its own commit and now kills it. No STOP condition
was hit: no unexpected importer, import cycle, contract mismatch with plan
section 2, or unlisted mutation surface or reader.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 2.1 contactKind | f4b0ea26 | 8 failed: `TypeError: (0 , contactKind) is not a function`; 68 existing passed | caseworkers 76/76; dashboard caseworkerRoleMirror 52/52 (leaf module, no new import) |
| 2.2 contactHoldings.ts + conversion rebuilt | f056de26 | baseline conversion 2 files / 105 green first; then the new file failed to load: `Failed to load url ../src/services/contactHoldings.js` (no tests ran) | contactHoldings 9/9; conversion + review API + contactTriage 3 files / 167; `tsc -p tsconfig.test.json` 0; `git diff --exit-code 19607658` on the two conversion test files 0; eslint 0 |
| 2.3 typeChangeRefusals | 108622a3 | 7 failed: `TypeError: (0 , typeChangeRefusals) is not a function`; the 9 Task 2.2 cases passed | 16/16; tsc 0; eslint 0 |
| 2.4 contacts PATCH 409 type_change_refused | 2e92fecc | Step 1 fixture swap green on the unchanged route (62/62). Then 23 failed (20 matrix pairs, soft-deleted-unit, order, the reads): `expected 200 to be 409` and `listByLandlord` never called; all 15 PINs passed | 4 files / 205 (new, contactTriage, both conversion suites); the other type-PATCH suites (aiRunVerdicts, contactEmailReaders, suggestions, contactStaffNotes) 4 files / 125; tsc 0; eslint 0 |
| 2.5 holdingRefusals.ts; dialog delegates | dff8f79e | baseline CaseworkerDialog 27/27 first; then `Failed to resolve import "./holdingRefusals.js"` | holdingRefusals + dialog 2 files / 34; dashboard tsc 0; dialog test file diff vs base exit 0; eslint 0; CaseworkersList (C2) 19/19 |
| 2.6 edit form + TypeChangeRefusalList | 7bd6e7b5 | 3 failed: the refusal sentences not found (the form showed the generic `Couldn't save` alert); 72 passed | 75/75; tsc 0; eslint 0 |
| 2.7 Unknown card | c01c9a47 | 2 failed: `Unable to find an accessible element with the role "alert"`; 12 passed (the PIN included) | 14/14; tsc 0; eslint 0 |
| 2.8 ContactDetail onTriage | 2e37bf6b | 3 failed: `findByText` never found the sentence (the rejection was swallowed); 122 passed (the existing "keeps Unknown actions retryable" included) | ContactDetail + UnknownFile 2 files / 139; tsc 0; eslint 0 |
| mutant gap (M4) | 99c2e52d | the new PIN is green on the real route (39/39) and red under M4 (`expected 409 to be 200`) | see the mutant table |

Where the code landed:
- `app/src/lib/caseworkers.ts:96` contactKind (no new import; leaf rule kept).
- `app/src/services/contactHoldings.ts`: `:19` OPEN_TOUR_STATUSES, `:26`
  ContactHoldingsDeps, `:33` TypeChangeRefusal, `:39` byId, `:42`
  openPlacementIds, `:56` openTourIds, `:68` landlordUnitIds, `:93`
  rosterUnitIds, `:123` typeChangeRefusals.
- `app/src/services/caseworkerConversion.ts:194` holdings (the same repo
  objects); `:224-239` collectRefusals on the shared readers,
  `deleted: 'any'` at `:229`. TERMINAL_STAGES, unitContacts and the private
  OPEN_TOUR_STATUSES are gone from the conversion (ruling S2-2).
- `app/src/routes/contacts.ts:111` import; `:1638-1654` the check, right
  after the caseworker 409 (`:1633-1637`) inside the classification block,
  before the D21 stamp, the org-name 422 and any write (ruling S2-5).
- `app/test/contactTriage.test.ts:748-761` fixture swap (seat on `u-cw-race`,
  conversion answers `caseworker_on_roster`; ruling S2-3).
- `dashboard/src/lib/holdingRefusals.ts`: `:35` TYPE_CHANGE_LANDLORD_SENTENCE,
  `:39` refusalCopyByKind, `:70` typeChangeRefusalCopy, `:99`
  typeChangeRefusalsFrom; `dashboard/src/routes/contact/CaseworkerDialog.tsx:66-77`
  refusalCopy delegates per code.
- `dashboard/src/routes/contact/TypeChangeRefusalList.tsx:14` (the one shared
  component, `role="alert"` at `:16`; ruling S2-1 as amended by R1 row 4).
- `dashboard/src/routes/contact/ContactEditForm.tsx:184` state, `:268`
  cleared on a kind change, `:498` cleared on save, `:531-533` the catch,
  `:609` rendered under the KindPicker.
- `dashboard/src/routes/contact/UnknownFile.tsx:33` TriageError, `:65` prop,
  `:155-165` render under the Mark as actions.
- `dashboard/src/routes/contact/ContactDetail.tsx:206` state, `:292` reset in
  the contactId effect, `:673-691` onTriage (generation guard `:686`),
  `:1199` passed to UnknownFile.

## Orchestrator corrections

- C1 (RB-C1): every ASCII check ran from the worktree with an explicit cd,
  a `test -f || echo MISSING` per new file, and
  `git diff -U0 19607658 -- <edited files> | grep '^+'` for edited files, in
  each task and at the gate. All printed 0, no MISSING line.
- C2 (RB-N3): `src/routes/contacts/CaseworkersList.test.tsx` ran in the
  gate's dashboard line (19/19) and once after Task 2.5.

## Divergences from the plan

- Code and tests of Tasks 2.1-2.8: none. Every Before anchor matched exactly
  once and every After is the plan's text.
- Added commit 99c2e52d (brief: a mutant no test kills is a test gap). The
  plan's "(PIN) the stored type re-sent is not a type change"
  (`app/test/contactTypeChangeRefusals.test.ts:230`) seeds a tenant holding a
  placement and a landlord holding a unit; the rule never refuses a type over
  holdings that type may keep, so a check run on a re-sent type answers 200
  there too and the PIN cannot see M4. The new PIN (`:242`) seeds a partner
  holding all three kinds (records from before the rule, spec L2), re-sends
  `type: 'partner'` and expects 200 with no holding read.
- Gate form: each vitest and typecheck command ran with its output
  redirected to a file under `.superpowers/sdd/logs/` and `echo $?` after it
  (a redirect, never a pipe), so the exit code is the command's own and the
  run's tail could be filtered afterwards. Same command line otherwise.
- After 99c2e52d, gate step 1 was re-run on the final tip (below); the other
  gate steps are unaffected by a test-only change to a file they already
  covered (that file was linted, typechecked and ASCII-checked at 0).
- No good divergence found (nowhere was the live code better than the plan).

## Slice gate (bare commands, from the worktree)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest: caseworkers, contactHoldings, caseworkerConversion, caseworkerReviewApi, contactTriage, contactTypeChangeRefusals | 0 | 6 files, 297 passed; re-run at 99c2e52d: 6 files, 298 passed |
| 2 | dashboard vitest: holdingRefusals, CaseworkerDialog, ContactEditForm, UnknownFile, ContactDetail, caseworkerRoleMirror + C2 CaseworkersList | 0 | 7 files, 319 passed |
| 3 | `npm run typecheck` | 0 | all five workspaces (app incl. scripts and tests) |
| 4 | `git diff --exit-code 19607658 -- app/test/caseworkerConversion.test.ts app/test/caseworkerReviewApi.test.ts dashboard/src/routes/contact/CaseworkerDialog.test.tsx` | 0 | no output (W2: the conversion's test files are unedited) |
| 5 | `npx eslint` on the 18 S2 files (plan line 5558) | 0 | no output; `--print-config` shows the rules apply (47 app entries with `@typescript-eslint/no-unused-vars` at error; 63 dashboard entries incl. 17 `react-hooks/*`) |
| 6 | ASCII (C1) | - | 7 new files: 0 each, no MISSING; 432 added lines across the 13 edited files (S1's ContactDetail lines included): 0 |
| 7 | coverage: `git diff --name-only --diff-filter=d 19607658...HEAD -- '*.ts' '*.tsx'` | 0 | 30 paths, every one in S1's list (plan line 3253 + aiRunVerdicts.test.ts) or S2's |

Lint attribution: none needed - eslint reported nothing, so the section-0
baseline run was not required. No pre-existing error to name in these 18
files.

No `[dynamoAdmin]` line appeared in any of the slice's 40 run logs (tasks,
gate, mutants). DynamoDB Local was already up; it was not started,
restarted or stopped.

## Mutant check

Each mutant was applied and reverted with the Edit tool; sha256 of all five
mutated files was checked against a pre-mutant baseline after every revert
(all OK). After the last revert `git status` was clean and `git diff --stat`
empty.

| Mutant | Suites run | Tests that went red |
|---|---|---|
| M1 typeChangeRefusals reads no placements (`contactHoldings.ts:130-132` removed) | contactHoldings, contactTypeChangeRefusals, contactTriage, caseworkerConversion, caseworkerReviewApi | 22 / 221: unit to partner, unknown, team_member, to landlord, "reads only the kinds"; the 16 route matrix pairs with a non-tenant target; the route order case |
| M2 landlord read `deleted: 'any'` (`:138`) | same five | 9 / 221: unit every-kind x3, to tenant, "soft-deleted unit and seat never refuse", "reads only the kinds"; route "only the live unit is named", "(PIN) only a soft-deleted unit may change type", "the reads" |
| M3 type check before the caseworker 409 (W6) | contactTypeChangeRefusals, contactTriage, both conversion suites | 1 / 205: "(PIN) the caseworker 409 still wins" |
| M4 check run whenever `type` is in the body (`contacts.ts:1644`) | the four above + aiRunVerdicts, contactEmailReaders, suggestions, contactStaffNotes | SURVIVED: 8 files / 330 green. Gap -> 99c2e52d. Re-run with the new PIN: 1 / 331 red (that PIN, `expected 409 to be 200`) |
| M5 conversion landlord read `deleted: false` (`caseworkerConversion.ts:229`) | conversion, review API, contactTriage, contactHoldings, contactTypeChangeRefusals | 5 / 221, all in `caseworkerConversion.test.ts`: `:169` (landlord of record + roster seat, soft-deleted included) and the four cases of `:268` (refusal read contracts) |
| M6a tour ids reversed in typeChangeRefusals | same five as M1 | 5 / 221: unit every-kind x3, to landlord; route order case |
| M6b landlord kind emitted first | same five as M1 | 16 / 221: unit every-kind x3; the 12 route matrix pairs targeting partner, unknown or team_member; route order case |
| M7 edit form resets the kind on a refusal | ContactEditForm | 1 / 75: "keeps the draft ..." (`aria-pressed` on Landlord) |
| M8 onTriage `.catch(() => {})` | ContactDetail, UnknownFile | 3 / 139: the three new ContactDetail cases (`ContactDetail.test.tsx:559`, `:584`, `:595`) |

## Surprising, or sub-threshold worries

- Two behaviors Task 2.8's goal states have no test (extra probes, not in
  M1-M8, reverted; no test added - outside the brief's mutant list and the
  plan's tests): dropping the reset in the contactId effect
  (`ContactDetail.tsx:292`) and dropping the generation guard (`:686`) both
  leave ContactDetail 125/125 green. A test would navigate from one unknown
  contact with a failure shown to another, and reject a Mark as after the
  navigation. Offered as a follow-up.
- `TypeChangeRefusalList` renders only while the edit form's Type block is
  open (`ContactEditForm.tsx:609`); a type change is only possible there, so
  this matches the plan's comment. The list is cleared by any KindPicker
  onChange (`:268`), a role-only pick included (the plan's third edit-form
  case relies on that), not only by a change of type.
- A body that is both a refused type change and an off-list org name answers
  409 `type_change_refused` (ruling S2-5; unpinned by design).
- On the Unknown card, a previous Mark as failure stays visible while the
  Mark as Caseworker dialog is open (the dialog does not clear it). Cosmetic.
- The dashboard gate prints React act() warnings from the "Run AI
  extraction" describe of `ContactDetail.test.tsx`, which this slice does not
  touch; stderr noise, every test passes (same as S1).
- The type check adds index reads to every real type change (a Mark as on
  the Unknown card included): placements + tours for a non-tenant target,
  live landlord units for a non-landlord target; never the roster Scan
  (pinned by "the reads" and M2). L1 applies as documented.
