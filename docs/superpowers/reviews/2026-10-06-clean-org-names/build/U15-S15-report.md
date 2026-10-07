# U15 - S15 report (Tasks 15.1-15.3): the clean-org-names script and its RUNBOOK

- Implementer: U15 (Opus 5.5), 2026-10-07. Branch `feat/clean-org-names`, worktree `W:/tmp/clean-org-names`.
- Range: plan lines 28047-29736. Stopped after Task 15.3. Start state: clean tree at ba8a2190, no MERGE_HEAD.
- Files: `app/scripts/clean-org-names.ts` (new), `app/test/cleanOrgNames.test.ts` (new), `RUNBOOK.md`.
- DynamoDB Local was already up (container `hc-dynamodb-local`); not started, stopped or restarted. Test tables are
  throwaway `hc-test-<uuid>-` prefixes, deleted in `afterEach`. No AWS call, no dev/prod, no CLI invocation at all.

## Task 15.1 - 1884c305 feat(org-names): clean-org-names planners - the automatic mappings, pure (spec section 8)

- RED: `Cannot find module '../scripts/clean-org-names.js'` (file fails to load, no tests).
- GREEN: `npx vitest run test/cleanOrgNames.test.ts` 15/15, exit 0.
- Gates: `npm run typecheck` exit 0; `npx eslint` (2 files) exit 0; ASCII check 0 bytes on both new files.
- Divergences: none (plan code verbatim).

## Task 15.2 - 521d86f1 feat(org-names): clean-org-names run - dry run, apply under the rewrite lock, PARTIAL and failure reporting (spec section 8)

- RD-4 applied: replaced only the four IMPORT lines; the four-line comment header is kept.
- RED: 10 failed / 15 passed - every DynamoDB Local case `(0 , cleanOrgNames) is not a function` (or
  `buildCleanupDeps`), the stated reason (not exported).
- Plan code verbatim first: 22 passed / 3 failed - the three cases that read the RG-5 counter, each diff ONLY
  `- "contactsMissingTypeOrStatus": 0|2` (RG-5's RED, for its reason).
- GREEN after RG-5: 25/25, exit 0.
- Gates: typecheck exit 0; eslint exit 0; ASCII 0/0; `test/orgListsRetired.test.ts` (scans app/scripts + app/test) 3/3.
- Commit body names RG-5 (subject is the plan's).

## Task 15.3 - 2be5a883 feat(org-names): clean-org-names CLI and RUNBOOK - dry run before the deploy, apply right after (spec section 8)

- RED: 3 failed / 25 passed - `formatSummary is not a function`; `CLEANUP_ARGS` undefined (`Cannot read properties
  of undefined (reading 'values')`); the source-text test finds no CLI block.
- GREEN: `npx vitest run test/cleanOrgNames.test.ts test/stageClient.test.ts` 57/57, exit 0.
- Gates: typecheck exit 0; eslint (2 .ts files) exit 0; RUNBOOK added-line ASCII check 0; files 0/0.
  Final re-run orgListsRetired + cleanOrgNames + stageClient 60/60, exit 0.
- RUNBOOK: the plan's section inserted above `### Tour reminder supersession (2026-09-01) ...`; the
  `CANONICAL_AUTHORITY` paragraph replaced with the plan's text. Verified two claims in the plan's text against
  shipped code: `import-apply.ts:453` prints "organization names NOT written"; `listingFormat.ts:218` labels
  `org_name_cleanup` "Housing authority cleaned up".
- Commit body names RG-5 and RG-6 (subject is the plan's).

## Divergences from the plan (each with why)

1. RG-5 (worklist addition), in Tasks 15.2 + 15.3:
   - `CleanupResult.contactsMissingTypeOrStatus` (placed beside `leftovers`), zero in `emptyResult`. Counted in the
     contacts walk right after `contactsScanned`, BEFORE planning: a non-blank string `housingAuthority` or `agency`
     while `type` or `status` is not a non-empty string (helper `isIndexKey` = DynamoDB's index-key rule). The row is
     still planned and written exactly as before (the RG-5 test pins `recordsPlanned: 9` with a missing-type row).
   - Reported on the `done` / `COMPLETED WITH FAILURES` log line (`reportCleanupRun` fields, beside
     `leftoverValues`). Deliberately NOT in `flatCounts`, so the lock's stored `lastRewrite.counts` and the PARTIAL
     line are exactly the plan's ("do not change what the script writes"; the Settings status line renders every
     non-zero `counts` key, `orgCopy.ts:376-382`).
   - `formatSummary` prints it as its LAST line in both branches ("Contacts missing type or status but holding a
     housing authority or agency: N (expected 0 - Settings cannot see or rewrite them)"): the plan's early return
     in the no-leftovers branch became an if/else.
   - Tests: `contactsMissingTypeOrStatus: 0` added to the dry-run and apply whole-result `toEqual`s and to
     `SUMMARY_RESULT` (a required field of the typed fixture); ONE new DynamoDB Local test (two legacy rows counted,
     a blank-agency typeless row not); two assertions appended to the existing formatSummary test (no second test).
2. RUNBOOK step 1 gained one sentence describing that RG-5 summary line (and its `done`-line key) with "expected 0,
   report a non-zero count". Why: step 1 enumerates every printed line; an unexplained "expected 0" line is an
   operator gap. Beyond the letter of RG-6's "one sentence" - drop it if unwanted.
3. RG-6: the sentence closes RUNBOOK step 2 (the review with Sam). Verified against git:
   `f97b9fd3^:app/src/lib/housingAuthority.ts:48` maps `clayton` to 'Clayton County', a Jonesboro spelling in
   `orgStartingList.ts`.
4. Lane rehearsal SKIPPED: the plan rehearses "only if one is already running". `e2e/.artifacts/session.pid` names
   launcher 37124 (lane 13), which is not running. OWED in the orchestrator's self-QA lane:
   `npx tsx app/scripts/clean-org-names.ts --env local --lane <L>`, then `--apply` (the CLI block - `invokedDirectly`
   under tsx on Windows, lane resolution, the printed summary, exit codes - is pinned only by the source-text test).

No other divergence: every other line of plan code is verbatim, and no plan anchor failed.

## Out of scope noticed (no change)

- `dashboard/src/routes/orgs/orgCopy.ts:376-382` `rewriteCountsText` lists every non-zero key of
  `lastRewrite.counts`. The cleanup lock's counts (plan `flatCounts`) include the scan totals (`contactsScanned`,
  `unitsScanned`, `pointerRows`, `recordsPlanned`, ...), so after an apply the Settings status line reads as a long
  list of ~10-16 humanized counters. Accurate, cosmetic - worth one look during self-QA.
- Gate 5: eslint is clean (exit 0) on both new `.ts` files, so they need no baseline comparison. RUNBOOK.md is not
  linted.
