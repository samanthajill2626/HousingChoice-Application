# U7 report - S7 second half (Tasks 7.5-7.8 + worklist RG-2)

- Implementer: U7 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 31232e9a (U6 report) through ae5772b1 - 5 commits (one per
  task, plus the RG-2 amendment as its own commit right after Task 7.5).
  Worktree clean after the last commit. Nothing left running.
- Next: S8 Task 8.1 (the importer). S7 is complete; the S7 hand-offs (S11
  dashboard, S10 deletions, S14 accept-dialog spec) stand as the plan wrote
  them - nothing in them was done here.

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 7.5 | 72f69ef0 feat(org-names): extraction apply resolves housing authorities against the org list | 14 failed / 196 passed (5 files): drop-reason pin "expected [ 'dismissed_before', ...(11) ] to deeply equal [ 'agency_not_authority', ...(12) ]"; spelling "expected 'Dekalb County Housing' to be 'DeKalb County Housing Authority'"; 'Atlanta (AHA)' kept as-is; 'Hope Atlanta' WRITTEN ("expected [ { id: 'c1', ... } ] to have a length of +0 but got 1"); the 3 job cases (spy args / "not to be called"). Both PINs green | 210/210 (5 files) | typecheck 0; neighbours (DraftGuard, Schema, ContactTriage, aiRunVerdicts, Ops, Adapter) 192/192 (0) |
| RG-2 | 4f7be1ef fix(org-names): pre-deploy dismissals keyed on a spelling still suppress the full name | 3 failed / 91 passed: each "expected [ 'housingAuthority' ] to deeply equal []" (suggested under the entry name despite the tombstone); both PINs green | 219/219 (Apply, RunTypes, Job, StaffNotes, Decisions, DraftGuard) | typecheck 0 |
| 7.6 | 808b7ca6 feat(org-names): suggestion journal rows carry the accept valueKey | 3 failed / 30 passed: "(0 , resolutionValueKey) is not a function" (2 unit + the integration case; DynamoDB Local up, suite ran, not skipped). The 4 marked pins green | 33/33 (unit + integration) | typecheck 0; fake consumers (aiRunVerdicts, suggestions, recovery) 99/99 (0) |
| 7.7 | ca8dfbfc feat(org-names): a housingAuthority accept writes a list name or is refused before the claim | 4 failed / 75 passed: "expected 'Atlanta (AHA)' to be 'Atlanta Housing Authority'" + three "expected 200 to be 422" (Metro HA, AHA, Hope Atlanta). PIN and the edited aiRunVerdicts crash-after-claim case green | 138/138 (AcceptOrgList, aiRunVerdicts, suggestions, recovery, journalSweep, devJournalSweepTick) | typecheck 0 |
| 7.8 | ae5772b1 feat(org-names): suggestion accept takes a list value; a different value re-accept is 409 | 8 failed / 9 passed: candidate "expected 422 to be 200"; not-from-suggestion "expected { field: 'housingAuthority', ...(4) } to deeply equal { error: 'value_not_from_suggestion' }"; pets value "expected 200 to be 422"; blank "expected 200 to be 400"; journal-row + re-accept 'expected 200 "OK", got 422'; both claim-race cases rejected with "SuggestionResolutionError: org_not_on_list" (RC-1). 4 PINs green | 118/118 (AcceptOrgList, suggestions, aiRunVerdicts, repo unit) | typecheck 0; neighbours (recovery, journalSweep, devJournalSweepTick, repo integration) 65/65 (0) |

Final sweep after the last commit: all 17 suites this unit touched or
neighbours, one run, 481/481 (exit 0). Typecheck = root `npm run typecheck`,
run bare. Logs: `.superpowers/sdd/u7-t7<n>-{red,green,typecheck}.log`,
`u7-rg2-*.log`, `u7-t7<n>-neighbours.log`, `u7-final.log`.

Task 7.7 Step 0 preconditions all held: `createOrgNamesService` /
`OrgNamesService.read` (`app/src/services/orgNames.ts:206`, `:183`); exactly
one `createOrgNamesService(` in `api.ts` (`:723`, built from the ONE
`orgListRepo` local `:716`); the harness passes `orgListRepo:
world.orgListRepo` (`twilioWebhookHarness.ts:5201`, inside `api: {` at
`:5182`) and the fake serves the starting list on its first read. The
suggestions mount did not already pass `orgNamesService`, so it was added
once.

Checks on every commit: bare `git status` read first as its own command, no
`.git/worktrees/clean-org-names/MERGE_HEAD`, explicit paths only, ASCII
subject + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer
(verified with `git log --format=%(trailers)`). New file
`suggestionAcceptOrgList.test.ts`: `tr -d` count 0; edited files: 0
non-ASCII bytes in added `git diff` lines. No `\u`-escape line touched
(escape-line counts unchanged: aiRunVerdicts 4, repo 2, fake 4).
DynamoDB Local was already up; never started, stopped or restarted.

## Divergences from the plan / worklist

- None in the plan's code. Every plan block (new text of every edit, the
  created test file, every appended/inserted case) was checked present
  EXACTLY ONCE, byte for byte, in its target file with a containment script
  over the plan's line ranges; the larger blocks were copied from the plan
  with `sed`/a line-splice script rather than retyped. Replace-alls hit the
  stated counts (6 `await applyExtraction(deps, {` - step 1 before step 3;
  exactly 2 `coercedValue: coerced.value,`); the post-7.5 grep shows only
  the two `coerced.value` uses inside the new gate.
- RG-2 (orchestrator ruling) - done as its own commit right after Task 7.5
  (the dispatch allows either), so its RED is clean: on the pre-7.5 code the
  ruling's raw-text case would already be green (the old normalizer suggested
  that text verbatim). Implemented exactly as ruled: `putSuggestionSafe(deps,
  s, alsoDismissedAs = [])` checks the own key first, then each distinct
  `normalizeSuggestionValue(target, alt)` key differing from it, first hit =
  `dismissed_before` with the same debug line; `s` is stored as is; only the
  housingAuthority `match` branch passes `[String(coerced.value),
  ...resolved.entry.spellings]`; writes unchanged. Tests
  (`app/test/extractionApply.test.ts`, last describe): the ruling's two RED
  cases ('Atlanta (AHA)' tombstone vs a suggested 'Atlanta Housing
  Authority'; tombstone on the model's own text 'Housing Authority of the
  City of Atlanta') and its PIN (a 'DCA' tombstone does not suppress
  Atlanta), PLUS two additions: a RED case whose dismissed raw text
  ('atlanta housing authority.') is no spelling, so only the raw-text alias
  catches it (the ruling's own raw-text example is itself a spelling, so it
  could not prove the raw-text half), and a PIN that a WRITE of a list match
  never consults dismissals (pins the ruling's "writes unchanged").
- RC-1 confirmed, no code change: at Task 7.8 RED the two claim-race cases
  fail on 422 `org_not_on_list` from the Task 7.7 text check (one rejects
  instead of resolving, the other 422 instead of 409), not on a missing
  export.
- Task 7.6 RED: the integration case's second stated reason (the claim drops
  `valueKey`) is masked by the import TypeError, which fires first; GREEN
  proves both (claimed journal and completed row carry the key).
- RG-1: accepted residual, no change (Task 7.7 recovery comments as the plan
  wrote them).

## Out of scope, noticed (no change made)

1. Lint (not a gate here; `npx eslint` on the 18 files of
   `31232e9a..HEAD`): 3 errors, ALL pre-existing - identical when the same
   files are linted at 31232e9a via `git show | npx eslint --stdin`:
   - `app/test/extractionApply.test.ts:5:10` no-unused-vars `beforeEach` -
     also present at the merge base d839494a; NOT yet on the worklist's S17
     gate-5 baseline list - add it.
   - `app/src/jobs/extraction.ts:22:20` `defaultLogger` and
     `app/test/extractionJob.test.ts:23:3` `WINDOW_CHAR_BUDGET` - already
     named by U6.
2. RG-2 residual (within the ruling's chosen scope): the alias keys are
   PREFLIGHT reads only - the atomic writer fence inside
   `extractionRepo.putSuggestion` (`app/src/repos/extractionRepo.ts:568`,
   dismissal key at `:606` / `:652`) checks only the suggestion's own key.
   An alias-keyed dismissal landing between the preflight and the put (a
   pre-deploy alias-text chip dismissed in the same instant a run re-suggests
   the name) is not caught. Cost: one GetItem per distinct key - Atlanta's
   suggest path reads up to 7, the cap is 22 (own + raw + 20 spellings); a
   failure of any read is the existing best-effort `repo_error` drop.
3. `lib/housingAuthority.ts` now has one importer left,
   `app/src/lib/import/apply.ts:41` (S8 moves it, S10 deletes the module) -
   matches the S7 hand-off.
