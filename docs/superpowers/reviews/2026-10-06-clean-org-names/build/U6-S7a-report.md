# U6 report - S7 first half (Tasks 7.1-7.4)

- Implementer: U6 (Claude Opus 5.5), 2026-10-06.
- Worktree `W:/tmp/clean-org-names`, branch `feat/clean-org-names`.
- Range: after 7fdee189 (U5 report) through ad80763f - 4 commits, one per
  task. Worktree clean after the last commit. Nothing left running.
- Next: S7 Task 7.5 (apply resolves housingAuthority; carries the worklist
  RG-2 amendment).

## Per task

| task | commit | RED (one line) | GREEN | fast gates (exit) |
|---|---|---|---|---|
| 7.1 | f3ec9ce8 feat(org-names): render the organization list block for the extraction prompt | suite failed to load: "Cannot find module '../src/services/extraction/orgListBlock.js'" | extractionOrgListBlock 11/11 | typecheck 0 |
| 7.2 | b8afd54a feat(org-names): the extraction job reads the org list once per run and records its fingerprint | 4 failed / 84 passed: get "expected spy to be called 1 times, but got 0"; fingerprint "expected undefined to be '2093739e...'"; throwing get "expected { processed: 1, failed: 0 } to deeply equal { processed: 0, failed: 1 }"; WARN never called. The 3 (PIN)s green; DraftGuard 4/4 green (harness edit inert) | extractionJob + extractionJobDraftGuard 88/88 | typecheck 0 |
| 7.3 | b015c932 feat(org-names): the organization list block rides in the extraction user content | 3 failed / 165 passed: adapter and placement cases "expected -1 to be greater than -1" (no block in the content); job case "expected undefined to be 'ORGANIZATION LIST...'". PINs green (empty-block exact shape; run-window round trip 15/15 with a real block) | adapter + schema + runWindow + job 168/168 | typecheck 0; neighbours (DraftGuard, Apply, Decisions, Ops, RunTypes, Address, extractionRepo unit, OrgListBlock) 182/182 (0) |
| 7.4 | ad80763f feat(org-names): the extraction system prompt describes the organization list block | 2 failed / 35 passed: "expected 'You extract facts...' not to contain 'Jonesboro (JHA)'" (old vocabulary still in the prompt) and "... to contain 'an ORGANIZATION LIST block'" | extractionSchema 37/37 | typecheck 0 (run though no type changed); S7 files + systemStatus.service + systemStatusNaming 230/230 (0) |

Typecheck = root `npm run typecheck`, run bare, output to
`.superpowers/sdd/u6-t7<n>-typecheck.log`. Test logs:
`.superpowers/sdd/u6-t7<n>-red.log` / `-green.log` (plus
`u6-t73-neighbours.log`, `u6-t74-neighbours.log`).

Checks on every commit: bare `git status` read first as its own command, no
`.git/worktrees/clean-org-names/MERGE_HEAD`, explicit paths only, ASCII
subject + `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer
(verified with `git log --format=%(trailers)`). New files
(`orgListBlock.ts`, `extractionOrgListBlock.test.ts`): `tr -d` count 0;
edited files: 0 non-ASCII bytes in added `git diff` lines. No `\u`-escape
line was touched (`aiRunsRepo.ts` edit at `:54` only). DynamoDB Local not
needed (all unit suites); never started, stopped or restarted.

Lint preview (not a gate here): `npx eslint` on the 13 files this unit
touched (`7fdee189..HEAD`) reports 2 errors, BOTH pre-existing - identical
when the same files are linted at 7fdee189 (`--stdin` of `git show`), and
both files are unchanged between the merge base d839494a and 7fdee189:
- `app/src/jobs/extraction.ts:22:20` no-unused-vars `defaultLogger`
- `app/test/extractionJob.test.ts:23:3` no-unused-vars `WINDOW_CHAR_BUDGET`
Not fixed (unrelated). The worklist's S17 gate-5 baseline list does not name
them yet - add them there for the handback.

## Divergences from the plan

None. Both created files and every inserted/appended test block are
byte-identical to the plan's fenced blocks (checked with `diff` against
`sed -n` extracts of the plan: 7.1 test 10269-10433 and module 10442-10604;
7.2 append 10741-10855; 7.3 appends 11085-11102, 11161-11201, 11247-11255;
7.4 tests 11388-11421). Every source edit is the plan's text and each anchor
matched exactly once as TEXT; the 7.3 replace-all hit exactly the 8 input
literals (`:33, :38, :85, :120, :141, :156, :182, :207`). `dev.ts` had no
earlier `createOrgListRepo` import, so the import line was added. Line drift
only: the `driver.extract` anchor sat at `extraction.ts:586` after Task 7.2;
the harness anchors in `extractionJob.test.ts` sat 4-10 lines below the plan
numbers after the inserted imports/constants.

Wiring check (plan 3.4b): `ExtractionJobDeps` is constructed only in
`worker.ts`, `routes/dev.ts` and the two harnesses - all four now pass
`orgListRepo`; no test passes `extractionTickDeps`; `ExtractionInput`
literals exist only in the three named test files plus the job.

## Out of scope, noticed (no change made)

1. `app/test/extractionAdapter.test.ts:1-5` - the header says the Anthropic
   driver's request path is "deliberately NOT exercised here" except for the
   F9 malformed-response guards; the new D8 describe at the end of the file
   now also checks request shaping (block placement, static system prompt).
   Cosmetic comment staleness.
2. No pinned prompt-fingerprint value exists anywhere (e2e
   `ai-run-log.spec.ts:400` checks the 12-hex format only), so the one-time
   fingerprint change in 7.4 breaks nothing - confirmed by grep.
