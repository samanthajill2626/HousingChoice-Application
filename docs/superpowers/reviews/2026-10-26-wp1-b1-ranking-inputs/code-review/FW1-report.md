# FW1 report - WP1 B1 code review R1 fix wave (implementer, 2026-10-27)

Scope: the binding list FW-1 .. FW-16 in `R1-adjudications.md` (this
directory). Base f24fe99e; head before this report c1e249f9. Nothing under
"By design" changed (ADV-4 apart from its comment, ADV-5, ADV-6, ADV-13,
ADV-14). Status: DONE - all 16 items.

## Commits

| Commit | Items |
|---|---|
| 9db3360a | FW-1 |
| d7193433 | FW-2 |
| cb76b4e6 | FW-5 |
| 486bccad | FW-3 (+ FW-15's closing-line bullet) |
| 53f26f28 | FW-4 |
| 50cd27da | FW-6 |
| 0313a80c | FW-11 (+ e2e/support/selectors.md:60) |
| fc905525 | FW-7, FW-8, FW-9, FW-10, FW-15 |
| ebdf6ba8 | FW-12 (+ selectors.md:60) |
| c1e249f9 | FW-13, FW-14, FW-16 |

## How RED and the reverted-fix proof were taken

Must-fixes: the test was written first and run against the unfixed code
(RED, reason read from the assertion that failed); the fix followed with
the test unchanged (GREEN). After each must-fix commit C, the fix's source
file(s) were overwritten with `git show C~1:<path>` (the tree minus exactly
that fix), the item's tests re-run with `-t`, then restored with
`git show HEAD:<path>`; `git status --short` was empty after every restore.
Every regression test failed with its fix reverted; the only passes in
those runs are tests marked PIN below (green on arrival by design).

Probe file and line references are `app/scripts/extraction-prompt-probe.ts`
(P) and `app/test/extractionPromptProbe.test.ts` (T) at c1e249f9.

## Must-fix items

### FW-1 (ADV-1 HIGH) - --baseline never passes on nothing measured

- Change: SideScore.measuredByCase, filled by scoreSide (P:679: a run is
  measured when its verdict is not `failed`); MIN_MEASURED_RUNS =
  MIN_GRADED_RUNS = 2 (P:667); compareDefaultSuites first fails every case
  with fewer than 2 measured runs on either side - "<case>: not measured on
  the branch|baseline (n of 3 runs returned a result; needs 2)" (P:696-703).
  A baseline truncation is a failed run, so it counts against the baseline's
  measured runs. Header `--baseline` text and the record's Rule line say so.
- Tests (T, describe "a case needs 2 measured runs on each side (FW-1)"):
  both sides all failed; baseline all failed while the branch missed every
  run; branch all failed while the baseline was ok only 1 of 3 (no drop rule
  fires); baseline truncations (1 measured); PIN: 1 failed call of 3 per side
  still passes. In "main --baseline": a stub driver failing every call ->
  exit 1, re-run, record "- Verdict: FAIL (after 2 attempt(s))" and a
  not-measured reason per case per side.
- RED: 5 failed - compareDefaultSuites returned pass=true ("expected true to
  be false"); main exited 0 ("expected +0 to be 1").
- Reverted fix: the same 5 fail; the PIN passes.

### FW-2 (ADV-2 MEDIUM) - an excluded verdict survives a malformed sibling

- Change: parseGraderOutput parses entry by entry (P:1011-1065): every
  problem is collected (message joins them with "; "), a well-formed entry
  judging a known item excluded is kept in `excluded`, a repeated id with
  conflicting verdicts keeps excluded (P:1057), no clean verdict of a
  malformed answer is kept. applyGrade (P:1074) puts kept verdicts on the
  items and keeps the raw text (`graderText`); the run stays UNGRADED.
  judgeCase counts every item that carries a verdict (P:1117), so the line
  fails its case. The record lists it under "Grader verdicts to review" with
  "[fails the case] [from an answer that did not parse: the run is not
  graded]" (P:1331) and prints each ungraded run's raw grader text, after
  asciiSafe, cut to RAW_GRADER_TEXT_MAX = 2000 characters and saying so
  (P:1173-1180, P:1389).
- Tests: parse keeps line-1 excluded beside an unknown id and a missing item;
  conflicting repeats keep excluded in both orders; a malformed answer keeps
  no clean verdict; applyGrade/judgeCase on the sub-reviewer scenario (run 1
  mosque line + omitted field item, runs 2-3 clean -> case FAIL, 2 graded, 1
  ungraded); the record lists the line for review, lists the skipped field
  item to read, carries the raw text; a 5030-character answer is cut and
  says so; main exits 1 on the scenario.
- RED: 7 failed - `parsed.excluded is not iterable`; the item had no verdict;
  the record said PASS; RAW_GRADER_TEXT_MAX undefined; main exited 0.
- Reverted fix: the same 7 fail.

### FW-3 (ADV-3 MEDIUM) - a --case comparison is PARTIAL

- Change: renderComparisonRecord takes `partial` (P:753): heading "(PARTIAL:
  one case, not a gate run)" (P:759), Verdict "... - PARTIAL (one case, not a
  gate run; it never counts)". Both suites print a "partial" header line on
  the console for --case (partialText, P:1618); the comparison also closes
  with it. RECORD_FILE_HEADER: "the latest full section of each suite is the
  one that counts - a PARTIAL section (one --case) never counts" (P:1583).
  FW-15's bullet landed here: a passing never-written --case run closes with
  "PASS on every automatic check (PARTIAL - one case, not a gate run; no
  sign-off)." (P:1751), not the sign-off request.
- Tests: --baseline --case states-voucher -> heading, verdict, console;
  never-written --case console (pass and fail) and no sign-off text; the
  header constant. PIN: a full comparison carries no PARTIAL.
- RED: 3 failed (console lacked PARTIAL; heading unmarked; header text).
- Reverted fix: the same 3 fail; the 2 PINs (this and the old never-written
  --case record test) pass.

### FW-4 (ADV-9 LOW) - the same-checkout guard compares canonical paths

- Change: canonicalRoot (P:1558): path.resolve, then
  realpathSync.native when the path exists, then lower-case on win32;
  runComparison compares the two canonical roots (P:1766). The platform is a
  new injected CLI dep `platform` (P:1546, default process.platform) so the
  test runs on any OS.
- Tests: on win32, `--baseline` = the branch root upper-cased -> exit 2, the
  usage message, no driver, no record; canonicalRoot folds case on win32
  only.
- RED: exit 0 instead of 2; canonicalRoot not a function.
- Reverted fix: both fail.

### FW-5 (ADV-10 LOW) - "clean" naming a kind is malformed

- Change: in parseGraderOutput a "clean" entry whose kind is a string other
  than "none" is a problem "item <id>: a \"clean\" verdict names kind
  \"<kind>\"" (P:1045) and is kept in `cleanNamingKind`; applyGrade sets
  `cleanButKind` on the item (P:1087); the run is UNGRADED. The record lists
  the item under "Lines the grader did not judge" as "not graded - the grader
  answered \"clean\" but named the kind <kind> [read it]" and on its run
  line (cleanButKindText, P:1237).
- Tests: the parse (message, kept kind, nothing excluded); applyGrade +
  judgeCase (ungraded, no verdict, the kind on the item, 0 of 3 graded); the
  record lines.
- RED: 3 failed ("a clean verdict naming religion parsed as clean"; run
  'graded'; record line absent).
- Reverted fix: the same 3 fail.

### FW-6 (ADV-11 LOW) - the commit is read before the first call and after the last

- Change: runNeverWritten reads gitInfo before loading the code (P:1675)
  and again after the pool (P:1724); checkoutChanged (P:1201) on the commit
  or the dirty flag fails the suite with "the checkout changed during the
  run (<before> before the first call, <after> after the last) - re-run it
  on a checkout nothing changes", printed on the console; the record keeps
  "- Commit: <before>" and adds "- Commit after the last call: <after> - the
  checkout changed during the run" (P:1307) only when they differ.
- Tests: event order git, extract x N, git (exactly two reads); a changed
  commit -> exit 1 and both commits recorded; a flipped dirty flag -> exit 1.
- RED: 3 failed (first event 'extract'; exit 0 twice).
- Reverted fix: the same 3 fail.

### FW-11 (CONF-1 LOW) - an unparseable portion is refused, never a clear

- Change: the portion keeps type="number" (spec D2, PR26) - adjudication
  option (b). ContactEditForm keeps the dollars controls' DOM nodes
  (dashboard/src/routes/contact/ContactEditForm.tsx:296, ref at :955) and at
  Save passes every key whose `validity.badInput` is true (:489-491) to
  buildTenantMatchingPatch, which now takes an optional `unparseable` set
  and refuses such an entry with tenantMatchingDollarsInvalid before the
  unchanged/clear checks (dashboard/src/routes/contact/tenantMatchingInputs.ts:117-124).
  A ref, not onChange: React fires no change when a badInput entry leaves
  the value '' as it was, so state alone cannot see it.
  e2e/support/selectors.md:60 now says the form refuses fractions, negatives,
  out-of-range numbers AND unparseable entries (unit-tested, not driven in
  e2e).
- Tests: ContactEditForm.test.tsx:2218-2241 (stubbed `validity` {badInput:
  true}): stored 900 + bad entry -> alert with the server's copy, no update;
  nothing stored + bad entry -> alert, no update, form not closed.
  tenantMatchingInputs.test.ts:92: the pure refusal, stored and not.
- RED: 3 failed ("Unable to find role=alert" x2; the builder returned ok
  with the clear).
- Reverted fix: the same 3 fail.

## Should-fix items

- FW-7 (ADV-7 part): CaseVerdict/SuiteVerdict.ungradedItems (P:1124);
  ungradedNote (P:1160) appended to the record's Verdict line and printed on
  the console after the verdict (P:1758): "N ungraded run(s) holding M
  line(s) - read them under 'Lines the grader did not judge'". M = the items
  listed in that section (lines and field values). No grader retry. Test in
  T ("the console and the Verdict line state ungraded runs").
- FW-8 (ADV-12 part): endpointOf (P:569) reads the INJECTED env only: the
  host of ANTHROPIC_BASE_URL via the URL parser (never userinfo, path or
  query; "default" when unset or blank; "ANTHROPIC_BASE_URL is set but is not
  a URL" otherwise) and whether ANTHROPIC_AUTH_TOKEN is non-empty (yes/no).
  Printed under the key by all three suites (P:583) and in both records
  (P:588). Tests: endpointOf; never-written and comparison print and record
  it with no userinfo, path, query or token text; the plain suite prints
  "default; ... no". ANTHROPIC_API_KEY was never read, printed or exported.
- FW-9 (ADV-8): control-assistance-animal carries plantedFact "The tenant
  sees a therapist, who wrote the letter for the emotional support dog."
  (app/scripts/extractionProbeNeverWritten.ts:350); the field's doc says
  why; scoring reads `role`, never plantedFact, so it stays a control scored
  on the dog line and no separate field was needed. The record prints it
  with "(stated in this control by design; it is still scored as a
  control)". Pins updated: extractionProbeNeverWritten.test.ts:78 and T's
  grader-request counts. Case hashes and the grader fingerprint are
  unchanged by construction (neither includes a planted fact).
- FW-10 (ADV-15): the request-blocks test asserts exit 0 and one request per
  case; the interleaved test asserts the call order (branch, baseline per
  run, case by case) through a new harness `calls` list.
- FW-12 (CONF-6): maxLength dropped from the three text controls and the
  unused TENANT_MATCHING_TEXT_MAX import removed (ContactEditForm.tsx:921-930
  comment). Pin flipped to "no maxlength" (ContactEditForm.test.tsx:2139);
  new case :2143 - 501 characters refused with the server's copy, 500 inside
  spaces saved trimmed. selectors.md:60 says so. Note: that new case passes
  with maxLength present too (a programmatic value is never cut by
  maxlength); the pin is the regression guard.
- FW-13 (CONF-3): RUNBOOK.md:1519-1540 - the gate is BOTH commands; the
  comparison also fails on a case not measured on either side and on any
  branch truncation.
- FW-14 (CONF-4): docs/issues/extraction-fields-to-notes.md:47-52.
- FW-15 (CONF-7): withRecorded finds dollars inputs through the list
  (DOLLARS_INPUTS, P:457; no max_tenant_portion literal left in P); the
  closing line is in FW-3; "recognized" (P:176), "labeled"
  (AiRunsSection.test.tsx:324, tenant-matching-inputs.spec.ts:64).
- FW-16 (ADV-4 comment): app/src/services/extraction/apply.ts:265-272 says
  what the postal filter drops and why a written line may now carry an
  address (feedback lines name sent properties; PR50). Comment only.

The FW-7/FW-8/FW-9 tests (7) also fail with fc905525's two source files
reverted.

## Divergences (each deliberate)

1. FW-2: "Lines the grader did not judge" now lists the items of an ungraded
   run that carry NO verdict (PR55 said every item). An item a partly
   malformed answer judged excluded is under "Grader verdicts to review"
   instead, so no item reads both "excluded" and "not graded". The parse
   message names every problem, not only the first (the existing regex
   tests still match).
2. FW-5: an item with a malformed entry is no longer ALSO reported as "no
   verdict for <id>" (only ids with no entry at all are "missing"). "Listed
   for review with the kind it named" is read as the "[read it]" list - the
   item has no verdict, so it does not fail its case by itself; the run
   counts against the 2-of-3 bar. A clean entry with no kind (or a non-string
   kind) still reads as clean, as before.
3. FW-6: gitInfo is read before loadBranchModules, so a dry run now makes
   one git read (prints nothing). The after-commit record line appears only
   on a change; an unchanged run's record format is as before.
4. FW-8: also printed by the plain default suite (it writes no record).
5. FW-13: the RUNBOOK sentence also says a --case re-run writes a PARTIAL
   section that never counts (FW-3) - one clause beyond the item.
6. FW-15: the probe now has ONE runtime import from app/src -
   `TENANT_MATCHING_INPUTS` from this checkout's leaf module
   app/src/lib/tenantMatchingInputs.ts. With --repo / --baseline it is still
   this checkout's list; it only types a recorded default-suite value, and
   no default case is a dollars field. The WI16 greps (S6.10 Step 5) are
   unaffected.
7. Reverted-fix proofs restored files with `git show <rev>:<path> > <path>`
   (byte-exact; clean status after each), not the Edit tool.

## Risks

- FW-11 is unit-tested with a stubbed `validity`; real-browser badInput
  behavior is from the HTML rule, not observed (no e2e in this wave). The
  pre-existing number inputs (rent min / max, payment standard, voucher
  size) keep the class - the orchestrator files it.
- FW-9 changes the grader's user content for one case, so any never-written
  record made before c1e249f9 is stale; none exists yet (CONF-2).
- The extraction prompt (prompt.ts) and the grader fingerprint inputs are
  untouched.

## Commands (all exit codes as shown)

- Every app vitest run was prefixed `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`.
  The probe was never run; no API call was made.
- Baseline: probe tests, 2 files, 106 passed, exit 0.
- RED runs: FW-1 5 failed, FW-2 7, FW-5 3, FW-3 3, FW-4 2, FW-6 3, FW-11 3 -
  each exit 1. Reverted-fix runs: the same counts failed, each exit 1.
- `npm run typecheck` (bare, root): exit 0 before every commit that changed
  a type or signature, and on the final tree.
- `npx eslint` on the 11 .ts/.tsx files the wave touched: exit 0.
- ASCII: `git diff -U0 f24fe99e..HEAD | grep '^+' | tr -d '\11\12\15\40-\176' | wc -c` -> 0;
  no touched file holds a `\u` escape before or after.
- Final, app: extractionPromptProbe.test.ts 119 (was 90),
  extractionProbeNeverWritten.test.ts 16, extractionApply.test.ts 121 -
  256 passed, exit 0.
- Final, dashboard: ContactEditForm.test.tsx 131, tenantMatchingInputs.test.ts
  10, tenantMatchingInputsMirror.test.ts 5, AiRunsSection.test.tsx 41 - 187
  passed, exit 0.
- Not run, per the dispatch: root `npm test`, `npm run smoke`, any e2e.

## Next step (orchestrator)

Run the completion gates on the head, re-check gate 5 against main, file the
pre-existing number-input class (CONF-1), and refresh the gate-run commands
sheet: both records now carry an "API endpoint" line, and the comparison
fails on a case not measured on either side.
