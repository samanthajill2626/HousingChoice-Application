# S7 report - e2e, the five gates, self-QA, the gate-run sheet (WP1 B1)

S7.1-S7.3 (the three e2e specs) were built by the S7 e2e child:
`S7-e2e-report.md` in this directory. S7.4-S7.6 were the orchestrator's;
this report quotes their results. Times are UTC.

## S7.4 - one main sync, then the five gates

- Sync: `git merge main` at 89016353 printed "Already up to date." - main
  is still d0e2c2d8 (0 commits behind); no merge commit, no lockfile
  change, so no `npm ci` was needed (D7-S7-7).
- Battery at **89016353** (started 2026-10-27T22:51:51Z, finished
  23:11:24Z), each bare from W:\tmp\wp1-b1-ranking-inputs, output to
  `.superpowers/sdd/gates-p6/`:
  - `npm run typecheck` - EXIT=0.
  - `npm test` (run as `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL timeout 1500 npm test`;
    neither variable nor any AWS_* is exported here - belt and braces for
    PR1) - EXIT=0. App 545 files: 11772 passed, 1 skipped; dashboard 272
    files: 5633 passed; e2e workspace 22 files: 509 passed; 34 files: 275
    passed; 13 files: 111 passed. 0 `[dynamoAdmin]` lines.
  - `npm run smoke` - EXIT=0: "smoke-dist: OK - 1760 import specifier(s)
    across 306 emitted file(s) resolve under plain Node."
  - `npm run e2e` (under `timeout 2700`) - EXIT=0: "383 passed (16.5m)".
  - Gate 5, `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
    with the git part pinned to the worktree: the list holds 87 files (not
    empty); EXIT=0, no output - no lint error in any touched file.
- An earlier battery at 67d877cc (before review) was also all green:
  typecheck 0, npm test 0 (app 545 / 11710 + 1 skipped), smoke 0, e2e 0
  (383 passed, 16.3m), gate 5 0 (87 files). No gate was red at any point;
  nothing flaked; no re-run was needed.
- PR14: the S3.8 / S4.7 fixture-only payload migrations (ai-run-log.spec.ts
  marker, caseworkers.spec.ts and conversation-fact-extraction.spec.ts
  noteLines) all ran green in both full e2e runs.

## S7.5 - live self-QA

`self-qa.md` (committed in 89016353). Four flows were
measured in a real browser at 360-1440 px. One B1 defect was found and fixed
before the final battery: SQA-1, the run detail's 64-character properties
sent fingerprint spilled past its "Notes lines" region in the narrow detail
column (fdae5623: `.countList { overflow-wrap: anywhere; }`, a CSS source
pin and an e2e geometry assertion, both RED first).

## S7.6 - the gate-run command sheet

`gate-run-commands.md` in this directory: Cameron's commands for the
never-written suite and the `--baseline` comparison as built (after review
fix waves FW1-FW4), naming 89016353 as the measured code, the run order, the
git and endpoint preconditions, the reading order of the record, and the
deviations to rule on at sign-off. No agent ran either command against a
real model (PR1); `never-written-test.md` does not exist on the branch.
