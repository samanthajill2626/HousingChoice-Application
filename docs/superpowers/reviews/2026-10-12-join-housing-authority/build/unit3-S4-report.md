# Build unit 3 (S4) report - backfill script, its test, the RUNBOOK entry

Implementer: Opus 5.5, 2026-10-12. Worktree W:/tmp/join-housing-authority, branch
feat/join-housing-authority, starting tip f11cda1b. Plan Tasks 4.1-4.6 (plan lines
4804-7324), spec D10/D11, build-research corrections S4-F1 and S4-F2.

Files: `app/scripts/backfill-join-housing-authority.ts` (new, 727 lines),
`app/test/backfillJoinHousingAuthority.test.ts` (new, 1388 lines), `RUNBOOK.md`
(+39 / -0). Nothing else touched.

The script was NEVER run against any environment. The only executions of the script
file were (a) imports by the vitest file and (b) the plan's child-process test, which
exits 2 on a usage error before any target is resolved.

## Per task

| Task | Commit | RED seen (counts) | GREEN (file: tests) |
|---|---|---|---|
| 4.1 rules | e5df123c | suite failed to load: `Cannot find module '../scripts/backfill-join-housing-authority.js'` / `Failed to load url ... Does the file exist?` (0 tests ran) | 35 passed / 35 |
| 4.2 report | 1bb3a8c0 | 5 failed / 35 passed: `formatBackfillReport is not a function` (4), `backfillExitCode is not a function` (1) | 40 passed / 40 |
| 4.3 reads | 59cf393c | 14 failed / 40 passed: `checkBackfillList` (9), `readWholeHistory` (1), `leftOutReasonFor` (1), `buildBackfillDeps` (3) not a function; no SKIPPED line | 54 passed / 54 |
| 4.4 run | 59bab925 | 11 failed / 54 passed: all 11 `runJoinAuthorityBackfill is not a function` | 65 passed / 65 |
| 4.5 CLI | 58dd1734 | 9 failed / 65 passed: `main` not a function (6), `parseSkipList` (1), `Cannot read properties of undefined (reading 'values')` from the undefined `BACKFILL_ARGS` (1), child process `{"status":0,"stderr":""}` expected 2 (1) - exactly the plan's predicted reasons | 74 passed / 74 |
| 4.6 RUNBOOK | 74080f5e | docs task (no RED); anchor grep -c = 1; `git diff --numstat` = `39 0`; new heading at RUNBOOK.md:450, previous heading Organization names cleanup (:422), next heading Caseworkers (:489, unchanged); all seven quoted messages found in the script; added lines ASCII (0); no CR on added lines | n/a |

Every task: app `npm run typecheck` exit 0 after GREEN; ASCII check 0 on both new
files; separate bare `git status` read showing only the task's files; MERGE_HEAD check
("no merge in progress", the rules' `git rev-parse --git-path` form); explicit-path
`git add`; trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## End-of-unit verification (at HEAD 74080f5e)

- `app/test/backfillJoinHousingAuthority.test.ts` with real DynamoDB Local (shared
  `hc-dynamodb-local`, untouched): 1 file passed, 74 passed / 74, 0 skipped (no `|
  skipped` in the summary, no skip markers, no `[backfillJoinHousingAuthority]
  SKIPPED` line). The three `describe.skipIf(!reachable)` blocks all ran.
- `app/test/cleanOrgNames.test.ts`: 39 passed / 39 (shares helpers; unchanged).
- Extra cheap invariant check: `app/test/setup/dynamoAccessKeyGuard.test.ts` +
  `app/test/orgListsRetired.test.ts` (both scan every app test/script file):
  2 files, 19 passed / 19.
- `npm run typecheck` from the worktree root: exit 0.
- `npx eslint app/scripts/backfill-join-housing-authority.ts app/test/backfillJoinHousingAuthority.test.ts`
  from the worktree root: exit 0, empty output.
- No `[dynamoAdmin]` line in any run's output (AGENTS.md reopen trigger: clean).
- No `\u` sequence in either new file or added RUNBOOK lines (fixed-string grep 0).

## Divergences from the plan text

1. RUNBOOK "Cost:" line uses the S4-F2 wording ("then per candidate not named in
   `--skip` one audit-history Query per 100 events plus one that comes back empty")
   - RUNBOOK.md:485. Directed by the brief/adjudications.
2. The slice header's "SKIPPED ... start db" instruction was ignored per S4-F1; the
   shared container was up throughout and was never started/stopped/restarted.
3. MERGE_HEAD check and `git -C` path forms per the rules file (S5S6-F1/F2), not the
   plan's `.git/worktrees/...` / backslash forms.
4. Mechanics only (content identical to the plan): the "append at the end of the
   file" steps were done by writing each plan block to a scratch file and `cat >>`
   onto the target, because a single Bash command with the 4.3 block inline exceeded
   the Bash tool's command size and failed to parse (nothing was written by that
   failed attempt - verified with `git diff --stat` before retrying). Import-block
   replacements used the Edit tool. All code and test text is the plan's verbatim.

No other divergence: every exported name in plan section 2.5 and the slice's
additive list exists with the plan's signature; `BackfillDeps` carries `doc` and
`env` (AR-2).

## "Matches the plan but..." (findings for the reviewer)

1. The child-process test passes `--env dev --bogus`
   (app/test/backfillJoinHousingAuthority.test.ts:1380). It is safe today because
   `parseStageArgs` refuses the unknown `--bogus` before `main` resolves any target,
   so no account guard, STS call or table read happens. But its safety rests
   entirely on that refusal: a future change that tolerated unknown arguments would
   turn this test into a real `--env dev` DRY RUN (account guard on the
   `housingchoice` profile, then a consistent Scan of dev contacts) from inside
   `npm test`. Read-only, but it is exactly the "agent runs it against dev" the spec
   forbids. A sturdier argv would be one that cannot resolve a real target even if
   parsing loosened (for example no `--env` at all, which is also a usage error).
   Left as the plan wrote it; reviewer's call.
2. `warnIfNameLeftList` runs only when `report.written > 0`
   (app/scripts/backfill-join-housing-authority.ts:601). Matches spec D10 ("after an
   apply that wrote"); an apply where every target was SKIPPED gets no re-check,
   which is correct (nothing was written to strand).
3. `invokedDirectly` (app/scripts/backfill-join-housing-authority.ts:715) relies on
   the `endsWith('<SCRIPT_NAME>.ts')` branch on Windows (`import.meta.url` is
   `file:///W:/...` while argv[1] is `W:\...`). Same form as clean-org-names; the
   child-process test proves it fires under `node --import tsx`.
4. Accepted edges the plan already lists (verification notes, plan 7323) still hold
   and were not re-litigated: `deleted_at: ''` lists as a target and skips on every
   apply; a re-sign-up landing between a lead's history read and its write is not
   guarded.

## Next step

Unit 3 is complete and committed (6 commits, e5df123c..74080f5e). Next per AR-8:
S5 (Tasks 5.1-5.3). The hermetic-lane rehearsal of this script is the
orchestrator's Task 6.3a. This report is written but NOT committed (orchestrator
commits it).
