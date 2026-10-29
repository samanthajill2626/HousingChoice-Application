# S8a slice report - The merge-gate scripts, tasks S8.1-S8.5 (WP1 B2a)

- Implementer: S8a child (Claude Opus 5.5), 2026-10-29.
- Branch `feat/wp1-b2-ranking-engine`, worktree `W:/tmp/wp1-b2-ranking-engine`.
  Range: 04c80495 (the S7 report, the commit before S8.1) .. e4d99015, plus
  this report's commit.
- Scope: plan section 12 - the slice head (Scope, Contradictions C1-C13,
  Cross-slice notes; plan 35514-35715) and tasks S8.1-S8.5 (plan
  35716-38491): the synthetic records and the nine swaps, the tolerance /
  noise / cap / control rules, the card adapter and the call plan, the
  verdict / record / CLI, and `--timing`. S8.6-S8.11 (env examples, gate
  sheet, RUNBOOK, GLOSSARY, issues, close) are S8b's; the S8 slice report
  (S8.11) is S8b's and links this file.
- Spec: D17 (all of it; D17.2 is the merge gate), D16. Rulings in force: PR1,
  PR7, PR25, PR29, PR41, PR45. Watch items: WI7, WI12, WI13. WORKLIST:
  section G (G6 especially), WL-S8-2 (the call greps), WL-S8-10, WL-S8-11,
  WL-S8-12.
- Verdict: five tasks, one commit each, each RED for its stated reason and
  then GREEN, plus one regression-pin test commit. The seven S8.1-S8.3
  files are byte-identical to their plan blocks (`cmp` against `sed -n` of
  the plan ranges). `report.ts`, the CLI and the S8.4/S8.5 test file are
  the plan's blocks plus S8.5's own edits plus the WORKLIST edits listed in
  section 6 (diffed line by line against the plan). No one-value test fix:
  every hand-worked value held. No QUESTION. Close evidence: the four test
  files 81 / 81 passed; `vitest list --filesOnly` collects all four; root
  `npm run typecheck` exit 0; eslint on all 11 files exit 0; ASCII 0 in
  every file and every commit message; the two allowed dry runs (key, token
  and base URL unset for the child) printed the plan and made no call.

## 1. Tasks and commits

| Task | Commit | Files |
|---|---|---|
| S8.1 synthetic records and the nine swaps | a561977f | `app/scripts/rankingCounterfactual/records.ts`, `swaps.ts`, `app/test/rankingCounterfactualData.test.ts` (all new) |
| S8.2 tolerance, noise, cap and control rules | a8477ebb | `app/scripts/rankingCounterfactual/evaluate.ts`, `app/test/rankingCounterfactualEvaluate.test.ts` (both new) |
| S8.3 card adapter and call plan | 549f0384 | `app/scripts/rankingCounterfactual/cards.ts`, `plan.ts`, `app/test/rankingCounterfactualPlan.test.ts` (all new) |
| S8.4 verdict, record, CLI (+ WL-S8-10, WL-S8-11, WL-S8-12) | 82e491cf | `app/scripts/rankingCounterfactual/report.ts`, `app/scripts/ranking-counterfactual-check.ts`, `app/test/rankingCounterfactual.test.ts` (all new) |
| S8.5 `--timing` (+ WL-S8-12 for the timing record) | ba30dcdb | the three S8.4 files |
| S8.5 follow-up: the dry-run pin (WL-S8-12) | e4d99015 | `app/test/rankingCounterfactual.test.ts` |
| report | this commit | `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/slices/S8a-report.md` |

File ownership: every file is PR2's S8 list
(`app/scripts/ranking-counterfactual-check.ts`,
`app/scripts/rankingCounterfactual/`) or a test file the plan's tasks name.
No other file was touched (`git diff --stat 04c80495..e4d99015` lists only
these 11 files). No app source under `app/src` changed.

## 2. Test commands and counts (every run, in order)

App form: `cd W:/tmp/wp1-b2-ranking-engine/app && npx vitest run test/<file>`
(foreground, hard timeout). No `AWS_*` variable is exported (names checked,
values never printed). No `npm ci`, `npm install` or `npm run db:start` (G1).
Nothing was left running (G7).

1. S8.1 RED `rankingCounterfactualData.test.ts`: 1 failed suite, no tests -
   "Cannot find module '../scripts/rankingCounterfactual/records.js'" (the
   stated reason; vitest 3.2.6 adds "Failed to load url", G4).
2. S8.1 GREEN: 17 passed (17). `npx tsc -p tsconfig.scripts.json` exit 0;
   eslint on the three files exit 0.
3. S8.2 RED `rankingCounterfactualEvaluate.test.ts`: "Cannot find module
   '../scripts/rankingCounterfactual/evaluate.js'" (stated reason).
4. S8.2 GREEN: 14 passed (14). tsc scripts exit 0; eslint exit 0.
5. S8.3 RED `rankingCounterfactualPlan.test.ts`: "Cannot find module
   '../scripts/rankingCounterfactual/cards.js'" (stated reason).
6. S8.3 GREEN: 14 passed (14). tsc scripts exit 0; `npx tsc -p
   tsconfig.test.json` exit 0; eslint exit 0.
7. S8.4 RED `rankingCounterfactual.test.ts` (the plan's test plus the
   WL-S8-12 cases, written first): "Cannot find module
   '../scripts/ranking-counterfactual-check.js'" (stated reason).
8. S8.4 against the VERBATIM plan `report.ts` + CLI (before any WORKLIST
   edit): 27 passed, 3 failed of 30 - every plan case green; the three
   WL-S8-12 cases red for their own reasons ("recordTargetProblem is not a
   function"; exit 0 instead of 2 for an unwritable --out; the verdict not
   printed when the append throws). The import-runs-nothing case was green
   (a pin: the plan's guard already holds).
9. S8.4 after the WORKLIST edits: 29 passed, 1 failed of 30 - my own new
   default check: Windows opens a DIRECTORY for append without an error, so
   `recordTargetProblem(<a directory>)` returned undefined. Fixed in the new
   code (an existing path that is not a file is refused before the open) and
   that one case now expects /is not a file/ (it is a WL-S8-12 case I wrote,
   not a plan value).
10. S8.4 GREEN: 30 passed (30). eslint exit 0; tsc scripts exit 0; tsc test
    exit 0.
11. Dry run (the brief's exact command, see section 9): exit 0, no call.
12. S8.5 RED (the plan's three cases appended, then two WL-S8-12 timing
    cases): 3 failed, 32 passed of 35. Failing for the stated reason: the
    plan's first two timing cases ("expected ... length of 3 but got 42";
    the check record written instead of the timing record) and the timing
    append-failure case (42 calls). Green at RED: the plan's `--timing
    --dry-run` case (D8-3: S8.4's dry-run branch already prints "Dry run: no
    call made." and returns 0) and my timing pre-check case (main's --out
    check precedes the mode split, so it already covered `--timing`).
13. S8.5 GREEN: 35 passed (35). eslint exit 0; tsc scripts and test exit 0.
14. Timing dry run (the brief's prefix, `--timing --dry-run`): exit 0, no call.
15. The four files together: 4 files, 80 passed (17 + 14 + 14 + 35).
16. Root `npm run typecheck` (bare, worktree root): exit 0 (app src, scripts
    and test configs; dashboard; e2e; fake-twilio; fake-twilio-web).
17. `npx vitest list --filesOnly` (app): exit 0, 601 files, all four new
    files listed (test/rankingCounterfactual.test.ts,
    rankingCounterfactualData, rankingCounterfactualEvaluate,
    rankingCounterfactualPlan). app/vitest.config.ts has no `include`
    override, so the default `**/*.{test,spec}.?(c|m)[jt]s?(x)` collects
    `app/test/*.test.ts` - no silent zero.
18. The dry-run pin (e4d99015): 36 passed (36). Negative probe (not
    committed): moving the --out check above the dry-run branch turned it
    red ("expected [ ...(2) ] to deeply equal []"); reverted with
    `git checkout --` of that one file.
19. Final, the four files together: 4 files, 81 passed (17 + 14 + 14 + 36).
20. eslint on all 11 files (the plan's S8.11 list minus S8.6's
    `rankingEnvExamples.test.ts`): exit 0. `--print-config` on the CLI shows
    the TypeScript rule set applies to `app/scripts` (not an ignored file).

## 3. Watch items

- WI7 (no test or agent-run script reaches the network or reads
  `ANTHROPIC_API_KEY`; the real-model script is unit-tested with stub drivers
  only) - HOLDS.
  - Every CLI test drives `main` through `CheckCliDeps` with a stub driver
    (`StubDriver` answers through the production `parseRankingText`) and an
    injected env (`{ ANTHROPIC_API_KEY: 'sk-test-not-a-real-key-wxyz' }` or
    `{}`); no test builds `createRankingDriver` or imports the SDK.
  - `git grep -n "process\.env" -- 'app/test/rankingCounterfactual*.test.ts'`:
    no hit (exit 1) - the test header was reworded "from the process
    environment" (D8-2; section 6). In the scripts the one hit is the CLI's
    `defaultDeps` (`ranking-counterfactual-check.ts:197`, `env:
    process.env`) - Cameron's real run, never a test.
  - `git grep -n "createRankingDriver\|new Anthropic\|@anthropic-ai/sdk" --
    'app/test/rankingCounterfactual*.test.ts'`: no hit.
  - Importing the CLI runs nothing: `main` is behind the compile check's
    guard (`import.meta.url === pathToFileURL(process.argv[1]).href`); a test
    re-imports the module fresh (`vi.resetModules()`) with console spies and
    asserts no output and no exit code. Under tsx the guard IS true (the dry
    runs printed). The import graph builds no client: the SDK client is
    constructed only inside `AnthropicRankingDriver`'s constructor.
  - G6 / PR1: no agent ran the CLI without `--dry-run`; both dry runs ran
    with `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u
    ANTHROPIC_BASE_URL`, so the child saw none of the three ("key (not
    read)", "endpoint default", "ANTHROPIC_AUTH_TOKEN set: no"). No
    `ANTHROPIC_*` value was read, echoed or printed; no `printenv`.
- WI12 (one card definition) - HOLDS. `git grep -n "tenantCard(\|propertyCard("
  -- app/scripts` lists only `app/scripts/rankingCounterfactual/cards.ts:65`
  (`tenantCard(contact, ctx)`) and `:72` (`propertyCard(unit, ctx)`) - C1:
  the one script module that touches S3's card code. The S8.3 test rebuilds a
  prepared tenant's card through the production `tenantCard` and compares.
- WI13 (one cap function) - HOLDS. `git grep -n "capOf(" -- app/scripts`
  lists only `app/scripts/rankingCounterfactual/evaluate.ts:75` (`return
  capOf({`), reached through `runCapped`, which the CLI's `runOne` calls per
  run with that run's own output.

## 4. WORKLIST items

- G1: no `npm ci` / `npm install` / `npm run db:start`. Done.
- G2: every plan code block was copied byte-exact with `sed -n
  '<first>,<last>p'` (the S8.1 / S8.4 / S8.5 tests, `plan.ts`, `report.ts`
  and the CLI carry backslash escapes); the S8.5 test and `report.ts`
  appends went in with `sed -n ... >>`. Checked with `grep -nF '\'` (escapes
  intact) and `tr -d '\11\12\15\40-\176' | wc -c` = 0. My own edits went
  through the Edit tool (no `\u` escape in any of them; a Write probe in
  scratch confirmed `\n` and `\x20` survive it).
- G3: no comment contradicts a ruling. `records.ts`'s C3 comment states
  PR45 correctly (accommodation only); `evaluate.ts` feeds unlawful flags per
  field to `capOf` (no item grouping is claimed). `report.ts`'s header now
  says exactly what the record holds (WL-S8-11).
- G4: every RED confirmed for its stated reason; the two cases green at RED
  in S8.5 are recorded in section 2 item 12 (D8-3 and a pin).
- G5: no shared constant re-spelled (the plan's own literals only).
- G6: section 3, WI7.
- G7: every command foreground with a hard timeout; none left running.
- WL-S8-1: the dry-run command form was used exactly (S8.11 runs it again).
- WL-S8-2: the WI7 / WI12 / WI13 greps were run in the call form; results in
  section 3. S8.11's `rankingEnvExamples.test.ts` does not exist yet (S8.6).
- WL-S8-10: DONE. The CLI header (`ranking-counterfactual-check.ts:21-28`)
  names THREE controls (PR25, PR41), C3 included. (The plan's own scope
  bullet about PR39 is plan text, not a file of this range.)
- WL-S8-11: DONE in code. `report.ts:10-17` says what the record holds: per
  base pair and direction every run's score and each group's cap COUNT - a
  swap row carries no per-run cap and no flags; per control every run's
  score with its flag and cap counts; the ungraded runs; calls, tokens and
  cost; no raw model text. The CLI header points there. The gate sheet's
  reading notes (S8.7) are S8b's and must use the same wording.
- WL-S8-12: DONE, with a test for each half (and the timing record too):
  - Before the first call: `main` asks `deps.checkRecordTarget(out)` (default
    `recordTargetProblem`) for every real run, after the key check and before
    any plan line or driver. The default refuses a missing directory, a path
    that exists and is not a file, and a file that will not open for append
    (it opens and closes the file with flag 'a', which creates it EMPTY when
    absent - the truest "can append" probe on Windows, where `access(W_OK)`
    ignores directory ACLs). Refusal: exit 2, "<problem>. No call made.", no
    driver built. Tests: `rankingCounterfactual.test.ts` "the default check
    refuses a missing directory and a directory named as the file, and
    accepts a writable path" (a real temp dir), "an --out the record cannot
    be written to is refused BEFORE the first call: exit 2, no driver, no
    call", and for `--timing` "an --out the record cannot be written to is
    refused before the first timing call (exit 2, no driver)".
  - After the calls: the append is tried (`tryAppendRecord`); on failure the
    CLI still prints "Verdict: X" and the reasons, then the error, then "The
    record was NOT saved. Here it is in full - paste it into <out>:" and the
    whole record (every table) line by line on stdout, and exits 1 - also on
    a PASS. Tests: "a record append that fails after the calls prints the
    verdict and the table to stdout, then exits 1" and "a timing record
    append that fails prints the timing table to stdout and exits 1".
  - A dry run never asks the check (writes nothing, in either mode): the
    pin "a dry run never checks or touches --out, in either mode".
- WL-S8-3 .. WL-S8-9, WL-S8-13 .. WL-S8-16: S8b's (S8.6-S8.11).

## 5. Contradictions C1-C13 as built

- C1: `rankingCounterfactual/cards.ts` is the only script file that touches
  S3's code (`tenantCard`, `propertyCard`, `propertyFacts`, `tenantMissing`,
  `propertyMissing`; contexts `{ now: COUNTERFACTUAL_NOW, seenMax: 8, seen:
  [] }` and `{ orgEntries: <starting list, cf-org-N ids>, landlordCard:
  false, landlord: null }`).
- C2 / PR25: every control runs three times in EACH direction and must pass
  in each (`evaluateCheck` builds one ControlVerdict per control and
  direction).
- C3 / PR25: every call holds one version of the subject at `c1` plus the
  same two fillers built for the base tenant (pinned: variant handles 2-3
  equal base handles 2-3; no batch holds two versions of one tenant).
- C4: nine swaps (children and marital status two, credit and income one).
- C5: every address swap keeps city and zip (pinned).
- C6: an ungraded call fails the gate and is listed; no stage-two call for
  that pair and direction; no retry.
- C7: stage one compares with group A's first three runs; stage two reads
  the extended group shared by the noise check and every swap.
- C8: 0 PASS / dry run; 1 FAIL or DECIDE; 2 usage or no key. Extended by
  WL-S8-12 (section 4): 2 also for an --out that cannot be written (no call),
  1 also when the record append fails after the calls.
- C9: the estimate prices 4 characters a token in and 2,500 tokens a call out
  on `DEFAULT_AI_PRICE_TABLE`; the record carries actual usage.
- C10: `--concurrency` (default 4, positive integer).
- C11: `COUNTERFACTUAL_REQUEST` = `{ low, 16000, 120000 }`, pinned to
  `loadConfig({ CF_ORIGIN_SECRET, NODE_ENV: 'development' })` (green).
- C12: `--out` required except with `--dry-run`, each run APPENDS a dated
  section; what it holds is worded per WL-S8-11 (section 4).
- C13: C1's property records the Pets item in two keys; the PR29 case
  ("never capped whatever Pets key the model flags or fails", four pairings),
  the PR41 C3 cases and the PR45 case (a Pets-key accommodation with a
  failed `qualifications` is not capped) are green.

## 6. Deviations from the plan text

All sanctioned by the WORKLIST or D8's corrections; no plan value changed.

- `app/test/rankingCounterfactual.test.ts`:
  - Header: "reads ANTHROPIC_API_KEY from process.env" -> "from the process
    environment" (comment only; D8-2's correction, so S8.11's WI7 grep
    prints nothing), plus three sentences naming the WL-S8-12 and
    import-guard cases.
  - Imports: `mkdtempSync`, `readFileSync`, `rmSync` (node:fs), `tmpdir`
    (node:os), `path`, `vi`, and `recordTargetProblem` from the CLI.
  - The harness's deps gain `checkRecordTarget: () => undefined` (OUT,
    `W:/counterfactual-test/record.md`, is not a real directory; without
    the stub every real-run case would be refused by the new pre-check).
  - Added describes: "the --out record (WORKLIST WL-S8-12)" (4 cases),
    "importing the CLI runs nothing (main is guarded)" (1), and after the
    plan's `--timing` block "the --timing record (WORKLIST WL-S8-12)" (2).
    Every plan case is byte-identical and green.
- `app/scripts/rankingCounterfactual/report.ts`: the header's last line
  replaced by the WL-S8-11 wording (8 comment lines). Code identical to the
  plan (S8.4 block + S8.5 append).
- `app/scripts/ranking-counterfactual-check.ts`, beyond S8.5's own six edits
  (all applied as written; `runTiming` diffed against plan 38414-38460 -
  only the append lines differ, below):
  - WL-S8-10: the header names three controls.
  - WL-S8-12: header text for `--out`, `--dry-run` ("writes nothing") and the
    exit codes; imports `closeSync`, `openSync`, `statSync` and `dirname`,
    `resolve`; `CheckCliDeps.checkRecordTarget`; exported
    `recordTargetProblem(file)`; `tryAppendRecord` and `printUnsavedRecord`;
    `runCheck` and `runTiming` append through them; `main` checks --out
    after the key check for every non-dry run.
- Choices the WORKLIST left open (not questions; Cameron may overrule):
  the pre-check exits 2 (the usage class: nothing was called; D8-13 proposed
  2), the append failure exits 1 (the gate's record is missing even on a
  PASS), and the pre-check creates an empty record file when none exists.
- The MERGE_HEAD check used the brief's `test -e "$(git -C ... rev-parse
  --git-path MERGE_HEAD)"` form (printed `ok` before every commit) instead
  of the plan's `ls`; equivalent.
- The extra regression-pin commit (e4d99015) is test-only.

## 7. QUESTIONS

None.

## 8. For the handback (Cameron)

- Before the first paid call the check now proves the `--out` record can be
  appended to; if the file does not exist it is created EMPTY at that point.
  A run from a checkout without the records directory (main before the
  merge) is refused with exit 2 and no call.
- If the append still fails after the calls, the verdict and the full
  record are printed to the terminal and the exit is 1 even on a PASS: paste
  the printed record into the record file.
- What the record holds (WL-S8-11): scores per run, cap COUNTS per group,
  control flag and cap counts, ungraded runs, calls / tokens / cost. A swap
  row shows no per-run cap and no flags.
- The timing estimate ($0.15) uses C9's planning figure of 2,500 output
  tokens a call; a 40-candidate batch will likely write more. Its ceiling is
  RANKING_MAX_OUTPUT_TOKENS (16000) a call: about 3 x 16000 x $10/M = $0.48
  out plus about $0.08 in, so under $0.60 for the three timing calls.

## 9. For S8b (S8.6-S8.11) - what S8a shipped

- CLI: `app/scripts/ranking-counterfactual-check.ts`. Flags (exact):
  - `--model <id>` REQUIRED, no fallback: `claude-sonnet-5-5` or
    `claude-opus-5-5` (`RANKING_SUPPORTED_MODELS`; a priced model).
  - `--out <record.md>` REQUIRED unless `--dry-run`; appends a dated section;
    checked before the first call (directory exists, file opens for append,
    created empty when absent).
  - `--concurrency <n>` positive integer, default 4 (the check only; timing
    runs one at a time).
  - `--dry-run` builds the requests, prints the plan, calls nothing, reads no
    key, never touches `--out` (with or without `--timing`).
  - `--timing` instead of the check: P1's property with 40 synthetic tenants,
    3 runs, one at a time.
  - Usage text (printed on a usage error):
    `usage: npx tsx app/scripts/ranking-counterfactual-check.ts --model <id> --out <record.md> [--concurrency 4]`,
    `... --model <id> --timing --out <record.md>`,
    `... --model <id> --dry-run [--timing]`.
- Exit codes: 0 PASS, a dry run, or a timing run whose three calls all
  answered; 1 FAIL or DECIDE (the record's "- Verdict:" line says which), a
  timing call that failed, or a record append that failed after the calls
  (verdict and full record on stdout); 2 a usage error, `ANTHROPIC_API_KEY`
  unset (real run), or an `--out` that cannot be written (no call made).
- The dry run as run here (the WL-S8-1 command, exit 0):

  ```
  ranking-counterfactual-check - model claude-sonnet-5-5; key (not read); endpoint default; ANTHROPIC_AUTH_TOKEN set: no
  Rubric r1, examples e1, prompt fingerprint 33e406a60079c1b829b123dbb27d63599bb4ced7e66934550a2793ce13e4bce9 (28926 system characters)
  Suite: 6 base pairs x 2 directions, 9 swaps (name, address, children, marital_status, credit_income, religion, disability, sogi, authority), 3 controls
  Planned calls, stage one: 414 (estimated $16.80 on claude-sonnet-5-5)
  Stage two, only for misses: at most 660 more calls (estimated at most $26.78)
  Dry run: no call made.
  ```

  Timing dry run (the same prefix, `--timing --dry-run`, exit 0):

  ```
  ranking-counterfactual-check --timing - model claude-sonnet-5-5; key (not read); endpoint default; ANTHROPIC_AUTH_TOKEN set: no
  Planned calls, timing: 3 batches of 40 candidates (estimated $0.15 on claude-sonnet-5-5)
  Dry run: no call made.
  ```

  The gate sheet's numbers: stage one 414 calls, about $16.80 by the
  built-in estimate (spec D17's "10-20 dollars" holds); stage two at most 660
  more, at most about $26.78; timing 3 calls, about $0.15 estimated (ceiling
  in section 8). In Cameron's shell the first line shows the HOST of
  `ANTHROPIC_BASE_URL` "(from ANTHROPIC_BASE_URL)" when it is set - the only
  command that prints an endpoint (WL-S8-8: the compile check prints none).
- Record headings S8.7 can quote: "## Counterfactual fair-housing check -
  <ISO time>", "- Verdict: PASS|FAIL|DECIDE", "### Base pairs", "#### <P> -
  <about> - <direction>", the swap table "| Swap | Stage | Base scores |
  Variant scores | Mean move | Base capped | Variant capped | Verdict |",
  "### Controls", "### Ungraded runs", the closing line "Cameron: (PASS, or
  your decision, with the date)"; timing: "## Batch timing - <ISO time>" and
  "| Run | Outcome | Latency ms | Input tokens | Output tokens | Candidates
  scored |". A DECIDE pair's swap verdicts read "... (reported only)".
- S8.11's lists: the eslint / ASCII file list in plan 39554-39558 is
  correct for S8a's files (11 files; add S8.6's `rankingEnvExamples.test.ts`
  and the gate sheet). The WI7 grep (D8-2 form) prints nothing from the four
  counterfactual tests; WI12 prints only `cards.ts:65` and `:72`; WI13 only
  `evaluate.ts:75` (section 3).
- Exports beyond the plan's: `recordTargetProblem(file): string | undefined`
  and `CheckCliDeps.checkRecordTarget` (the CLI). Everything else is the
  plan's (`COUNTERFACTUAL_REQUEST`, `SCRIPT_NAME`, `TIMING_CANDIDATES` 40,
  `TIMING_RUNS` 3, `parseCheckArgs`, `keyTail`, `endpointLine`, `runOne`,
  `main`; `rankingCounterfactual/`: the Cross-slice block's names plus
  `plan.ts` `DEFAULT_SUITE`, `DIRECTIONS`, `SUBJECT_HANDLE` 'c1',
  `planStageOne`, `planStageTwo`, `worstCaseStageTwoCalls`,
  `estimateCostUsd`, `pairBatch`, `pairRuns`, `gradedRuns`, `allGraded`;
  `report.ts` `evaluateCheck`, `renderCheckRecord`, `renderTimingRecord`,
  `asciiSafe`; `cards.ts` `prepareTenant`, `prepareProperty`,
  `counterfactualOrgEntries`; `evaluate.ts` the constants and rules).
- The record path in the gate sheet (plan 38887-38888,
  `docs/superpowers/reviews/2026-10-28-wp1-b2-ranking-engine/counterfactual-check.md`,
  relative to the worktree root) passes the pre-check from the worktree
  root; the file appears empty before the first call.

## 10. Untrimmed input

None new. `--model` and `--out` are trimmed (`parseCheckArgs`), the key is
trimmed before use, `--concurrency` goes through `Number` (surrounding
spaces tolerated) and must be a positive integer. The synthetic records are
fixed data.
