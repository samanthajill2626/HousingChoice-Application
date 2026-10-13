# S1 build report - D1 accept fence (U1)

Implementer: U1 (Claude Opus 5.5), caseworker-integrity build mission,
2026-10-12. Worktree `W:\tmp\caseworker-integrity`, branch
`fix/caseworker-integrity`, from d0c2fcf2 (base 19607658). Plan
`docs/superpowers/plans/2026-10-12-caseworker-integrity.md` Tasks 1.1-1.10,
the slice gate, the orchestrator corrections C1-C3 and the planner-ruled
Task 1.11. Findings only; code is cited by file:line at 1a6b140b.

Headline: 11 commits, every RED failed for the reason the plan states, every
GREEN passed as written, the slice gate is green (all exit 0), lint is clean,
and all 8 mutants were killed. No STOP condition was hit: no unexpected
importer, import cycle, contract mismatch or unlisted surface beyond the
already-ruled RF1-F1.

## Per task

| Task | Commit | RED observed | GREEN |
|---|---|---|---|
| 1.1 consistent plan read (+ C1) | 958d6e64 | 1 failed: `expected [ 'c1' ] to deeply equal [ 'c1', { consistentRead: true } ]` | 3 files / 92 tests (reclassification, aiRunVerdicts, suggestionAcceptOrgList) |
| 1.2 tenant-only accept refused before the claim | f72b1fe2 | 11 failed: `TENANT_ONLY_TARGETS is not iterable`; 200 -> 409 for the six fact targets and the three kinds; status 400 -> 409 (allowlist answered first). 2 PINs passed | 4 files / 125 tests |
| 1.3 classification_revision in the guard | 49550fd9 | 11 failed: 7x `expected undefined to deeply equal { exists: false }`, 1x `{ exists: true, value: 3 }`, B read and B sweep wrote `'Atlanta Housing Authority'`, the generic re-type wrote `3`. 3 neutral PINs passed | 4 files / 139 tests |
| 1.4 effectiveGuard + guardMismatchIsClassification | aeffb146 | every case: `(0 , effectiveGuard) is not a function` / `(0 , guardMismatchIsClassification) is not a function` | 2 files / 27 tests; typecheck exit 0 |
| 1.5 the three real-repo sites (DynamoDB Local) | d1b8a8e5 | 3 failed on DynamoDB Local (suite not skipped): moved-on and tie `superseded_by_human_edit` vs `_reclassification`; legacy `committed`. 3 PINs passed | 4 files / 154 tests; typecheck exit 0 |
| 1.6 the fake reads effectiveGuard | 9cdf65ff | 5 failed: fake moved-on and tie (one refusal answer), fake legacy `committed`, fake source pin (`.plan.guard` count 1), FakeWorld legacy read wrote the authority. Repo pin and PINs passed | 5 files / 169 tests; typecheck exit 0 |
| 1.7 409 suggestion_contact_reclassified | c6a5095a | 7 failed: real A x3 `promise resolved "{ completedNow: true, ... }" instead of rejecting`; FakeWorld A x4 `expected 200 to be 409`. 6 PINs passed (FakeWorld address/phone, real B read, B sweep, both legacy) | 7 files / 187 tests; typecheck exit 0 |
| 1.8 route emit | 7d106ef0 | 1 failed: `expected 0 to be 1`; the not-a-tenant no-emit PIN passed | 3 files / 132 tests |
| 1.9 dashboard copy | 65e248bf | 2 failed: the vocabulary test (reclassified copy equals the generic fallback) and the new exact-sentence test (generic fallback) | 1 file / 39 tests |
| 1.10 dashboard refetch (+ C2) | 928fd4a1 | 1 failed: `refetches on a SERVER suggestion_contact_reclassified` - spy called 1 time, not 2; the not-a-tenant PIN passed | 2 files / 159 tests |
| 1.11 HA chip on a non-tenant (planner-ruled) | 1a6b140b | 1 failed on the unchanged handler: the plain accept spy was called 0 times (the chip rendered and was clicked; the review ran instead); the TENANT PIN passed | 2 files / 161 tests; typecheck exit 0 |

Where the code landed:
- `app/src/services/extraction/runTypes.ts:28` TENANT_ONLY_TARGETS (leaf module,
  ruling S1-1); re-exported at `app/src/services/suggestionResolution.ts:34`.
- `app/src/services/suggestionResolution.ts:812` consistent plan read;
  `:825` the plan-time 409 `suggestion_contact_not_tenant` (accept only,
  before buildPlan); `:221` withClassificationFence, used at the status,
  housingAuthority and EXTRACTABLE guards `:309`, `:368`, `:391` (address
  guard untouched); `:503`, `:616` the refusedByReclassification flag;
  `:895` the 409 `suggestion_contact_reclassified`, checked before the
  field-edit answer.
- `app/src/repos/suggestionResolutionRepo.ts:168` union member;
  `:439` attributeMatches (contactMatchesGuard unchanged in behavior);
  `:465` CLASSIFICATION_GUARD_KEYS; `:480` effectiveGuard; `:495`
  guardMismatchIsClassification; site 1 `:862-863`, site 2 `:893`, the
  classification-first refusal `:902`, site 3 `:907`, both refusal returns
  `:927`, `:936`. `.plan.guard` occurs 0 times (pinned).
- `app/test/helpers/suggestionResolutionFake.ts:21-22` imports both
  functions; `:193` stores `superseded_by_human_edit` for both refusals;
  `:344-347` effectiveGuard + classification-first answer.
- `app/src/routes/suggestions.ts:228` emit condition.
- `dashboard/src/api/types.ts:1697`, `:1701` the two sentences.
- `dashboard/src/routes/contact/ContactDetail.tsx:727` refetch list;
  `:820-834` onAcceptSuggestion and its comment (Task 1.11).

## Orchestrator corrections and the planner-ruled addition

- C1 (RA-N2), in 958d6e64: the comments at
  `app/test/aiRunVerdicts.test.ts:645-651` and `:658-659` now call the plan
  read consistent and say the pinned race is an edit after that read and
  before the fenced write (inside the `claimed` boundary hook). No assertion
  changed (74/74 green). The file is in the S1 lint list.
- C2 (RA-N1), in 928fd4a1: the test comment at
  `dashboard/src/routes/contact/ContactDetail.test.tsx:702-709` now says
  "these four" and "for both refused accepts (a field edit or a
  reclassification)". No assertion changed. The literal substitution leaves
  two parentheticals back to back in that sentence - cosmetic only.
- C3 (RB-C1): every ASCII check in this slice ran from the worktree with an
  explicit cd, a `test -f || echo MISSING` per new file, and
  `git diff -U0 19607658 -- <edited files> | grep '^+'` for edited files.
  All printed 0, no MISSING line (gate numbers below).
- Task 1.11 - planner-ruled addition, Q1/RF1-F1 (1a6b140b). On a contact not
  typed `tenant`, Accept on a `housingAuthority` chip skips "Is this really
  new?" and sends the plain accept, so the server answers 409
  `suggestion_contact_not_tenant` and the chip shows Task 1.9's sentence
  (`ContactDetail.tsx:820-834`, comment says why). Implemented as "review
  only when the target is housingAuthority AND the contact is a tenant, else
  the plain accept" - the same predicate as the ruling's
  `contact.type !== 'tenant'` skip. Tests in the housing-authority review
  describe: `ContactDetail.test.tsx:2538` (TEAM MEMBER, close-name text
  "Atlnta Housing": no dialog, checkOrgText not called, the accept call is
  exactly the identity triple with no value, the D1 sentence on the chip,
  updateContact never called, Dismiss enabled) and `:2564` (PIN: a TENANT
  with the same text still opens the review). The rest of the describe's
  tenant review cases stay green unchanged. This also removes RF1-F1's side
  effect (a list entry added by "Add it as new" for an accept the server then
  refuses) for non-tenants, since the dialog no longer opens for them.

## Divergences from the plan

- None in code or tests for Tasks 1.1-1.10: every old_string matched
  uniquely, both replace_all edits hit the stated counts (3 and 7), and the
  plan's grep checks held (`plan\.guard` 1, `\.plan\.guard` 0).
- Commit messages for 958d6e64 and 928fd4a1 carry one extra sentence each
  naming C1 / C2; 1a6b140b is the added Task 1.11 commit.
- The plan places Task 1.11's test either in the HA review describe or beside
  the not-a-tenant PIN; it is in the HA review describe, with an explicit
  TENANT PIN added beside it (the brief allowed keep-or-add).
- Gate step 3's first bare run produced output too large for the tool, which
  persisted it without showing the exit status; it was re-run once with
  output redirected to a file to record the real exit code. Both runs:
  2 files / 161 tests passed.
- No good divergence found (nowhere was the live code better than the plan).

## Slice gate (all bare, from the worktree)

| Step | Command (short) | Exit | Counts |
|---|---|---|---|
| 1 | app vitest: suggestionReclassification, suggestionReclassificationGuard, suggestionResolutionRepo.integration, suggestionReclassification.integration | 0 | 4 files, 105 tests passed (DynamoDB Local suites ran, not skipped) |
| 2 | app vitest: aiRunVerdicts, suggestions, suggestionAcceptOrgList, suggestionResolutionRecovery, suggestionResolutionRepo, journalSweep, caseworkerConversion, caseworkerReviewApi | 0 | 8 files, 256 tests passed |
| 3 | dashboard vitest: api/types.test.ts, routes/contact/ContactDetail.test.tsx | 0 | 2 files, 161 tests passed |
| 4 | `npm run typecheck` | 0 | all five workspaces (app incl. scripts and tests) |
| 5 | ASCII (C3) | - | 3 new files: 0 each, no MISSING; 477 added lines across the 11 edited files: 0 |
| 6 | `npx eslint` on the 14 S1 files (plan list + aiRunVerdicts.test.ts) | 0 | no output; `--print-config` confirmed rules apply (46 app, 63 dashboard) |
| 7 | coverage: `git diff --name-only --diff-filter=d 19607658...HEAD -- '*.ts' '*.tsx'` | 0 | 14 paths, exactly the 14 in the lint list |

No `[dynamoAdmin]` line appeared in any run of this slice (gate, per-task or
mutant). DynamoDB Local was already up; it was not started, restarted or
stopped.

Lint attribution: none needed - eslint reported no error, so the section-0
baseline run was not required. No pre-existing error to name in these 14
files.

## Mutant check

Each mutant was applied and reverted with the Edit tool; sha256 of all four
mutated files was checked against a pre-mutant baseline after every revert
(all OK). After the last revert `git status` was clean and
`git diff --stat` empty. Every mutant was killed; no test gap, so no extra
commit.

| Mutant | Suites run | Tests that went red |
|---|---|---|
| M1 commit condition (repo :863) on the raw plan guard | repo integration, reclassification integration, guard, reclassification | DynamoDB Local legacy case (`committed`); real-repo legacy recovery (authority written); repo source pin. 3 failed / 105 |
| M2 stale-vs-mismatch re-check (repo :893) on the raw guard | same four | DynamoDB Local legacy case (`stale`); real-repo legacy recovery (`recovered: 0`); repo source pin. 3 / 105 |
| M3 mismatch ConditionCheck (repo :907) on the raw guard | same four | DynamoDB Local legacy case (`stale` - the ConditionCheck on the raw guard is cancelled, the journal stays `claimed`); real-repo legacy recovery (`recovered: 0`); repo source pin. 3 / 105 |
| M4 fake on the raw guard (fake :344) | guard, reclassification, aiRunVerdicts | fake legacy case (`committed`); FakeWorld legacy read (authority written); fake source pin. 3 / 140 |
| M5 effectiveGuard without the caseworker_conversion fallback | the four S1 app suites | 11 / 105: the 7 effectiveGuard legacy units, DynamoDB Local legacy case, real-repo legacy recovery, fake legacy case, FakeWorld legacy read |
| M6 guardMismatchIsClassification always false | the four S1 app suites | 18 / 105: repo moved-on, tie, legacy; real A x3; 4 classification units; fake moved-on, tie, legacy; FakeWorld A x4; the reclassification emit test |
| M7 resolve() without the plan-time not-a-tenant refusal | the four S1 app suites | 11 / 105: all ten Task 1.2 refusal cases and the Task 1.8 no-emit PIN |
| M8 route emit without suggestion_contact_reclassified | reclassification, aiRunVerdicts, suggestions | 1 / 132: the Task 1.8 reclassification emit test |

The DynamoDB Local legacy case (`app/test/suggestionResolutionRepo.integration.test.ts:572`)
kills M1, M2 and M3 individually, each with a distinct wrong answer
(`committed`, `stale`, `stale`), so all three real-repo sites are observable
behaviorally, not only through the source pin.

## Surprising, or sub-threshold worries

- Task 1.11 decides on the page's contact state. A page that loaded a
  contact as a tenant still runs the review if the contact is re-typed to a
  team member elsewhere before the click, and the review's close-name path
  then writes the authority by contacts PATCH (no server-side type gate for
  that field - RF1-F2b, I1 is scoped to accepts). The reverse staleness only
  sends a plain accept to a tenant, which answers as today (accepted on an
  exact list name, else 422 `org_not_on_list`). Narrow window; noted, not
  filed.
- Commits d1b8a8e5 through 9cdf65ff carry the known RA-N4 intermediate state
  (a requester's own reclassified accept answers 200 `completedNow: true`,
  nothing written); c6a5095a closes it.
- The dashboard gate prints React act() warnings from the "Run AI extraction"
  describe of `ContactDetail.test.tsx`, which this slice does not touch;
  they are stderr noise, every test passes.
- `CLASSIFICATION_GUARD_KEYS` stays exported as the plan writes it (RA-N7);
  nothing imports it.
- With #19 deployed (build-research README "Main moved"), the legacy
  fallback is load-bearing for production journals claimed by the old code;
  M1-M3 and M5 show the DynamoDB Local legacy case would catch a regression
  at any of the three sites or in the fallback itself.
