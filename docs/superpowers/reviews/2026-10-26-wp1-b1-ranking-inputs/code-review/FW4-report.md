# FW4 report - WP1 B1 code review R4 fix wave (implementer, 2026-10-27)

Scope: the binding list FW4-1 and FW4-2 in `R4-adjudications.md` (this
directory); source findings R4-1, R4-2, R4-3 in `R4-review.md`; FW3-3 (in
`FW3-report.md`) as the check mirrored. Base a6d1a373. Nothing else changed.
Status: DONE - both items.

## Commits

| Commit | Items |
|---|---|
| f04f1bb8 | FW4-1 |
| cee9cb00 | FW4-2 |
| (this report) | records |

## How RED and the reverted-fix proof were taken

- Every app vitest run was prefixed `env -u ANTHROPIC_API_KEY -u AI_EXTRACTION_MODEL`
  (G1). No probe run, no API call; ANTHROPIC_API_KEY was never read or printed.
- RED: the new tests were written first and run against the unfixed code; the
  reason was read from each failing assertion. GREEN: the fix, tests unchanged.
- Reverted-fix proof: after GREEN, the fix was disabled with the Edit tool, the
  same file re-run, then restored with the Edit tool (no marker left; grep
  checked, exit 1 = no match) and re-run green.

## FW4-1 (R4-1 LOW) - the --baseline comparison: no readable commit, no certificate

What changed (`app/scripts/extraction-prompt-probe.ts`, HEAD lines):
- `:1851-1862` in `runComparison`, after both sides' git reads and the
  dry-run branch, BEFORE the drivers are created (`:1863`): the sides whose
  commit is `GIT_FAILED` are collected; if any, the run prints a blank line,
  then per such side "FAIL: git could not read the commit of <root> - no
  certificate.", then "Nothing was sent and no record written; re-run where
  git can read <root>[ and <root>].", and returns 1. No driver, no call, no
  record. `GIT_FAILED` and `gitInfoOf` are FW3-3's, unchanged.
- The dry run is unchanged (it returns before the check, as in FW3-3).

Tests (`app/test/extractionPromptProbe.test.ts`, HEAD lines):
- `:8` `import path from 'node:path'` (the expected root is
  `path.resolve(<root>)`, as the script prints it, so the test holds on
  win32 and Linux).
- `:1569-1629` new describe "a side whose commit git could not read fails
  the run (FW4-1)" inside `main --baseline`, through the injected git runner
  (`refusingOn`: every command on the chosen side exits 128, the other side
  reads as usual):
  - `:1582` the branch side refusing: exit 1, no driver created, no call, no
    record; the branch's FAIL line printed, the baseline's not; "Nothing was
    sent and no record written" printed (RED).
  - `:1595` the baseline side refusing: the same, sides swapped (RED).
  - `:1608` git that cannot start (throws): exit 1, no driver, no record,
    BOTH sides' FAIL lines printed (RED).
  - `:1621` PIN a dry run with git refusing both sides still exits 0, prints
    "Dry run: nothing was sent.", creates no driver, writes nothing (no
    existing comparison test had an unreadable git; green on arrival).

RED (extractionPromptProbe only): exit 1, 3 failed / 132 passed (135). Each
of the three: "expected +0 to be 1" - the comparison ran every stub call and
PASSED on an unreadable commit (R4-1's mechanism). The PIN passed on arrival.
GREEN: exit 0, 135 / 135.

Reverted-fix proof: the check's condition made unreachable
(`unreadable.length < 0`) -> exit 1, the same 3 failed / 132 passed, each
"expected +0 to be 1". Discrimination check: the check limited to the
branch side (`[sides[0]].filter(...)`) -> exit 1, 2 failed / 133 passed: the
baseline test ("expected +0 to be 1") and the both-sides test (the baseline's
FAIL line missing); the branch test passed. Restored -> exit 0, 135 / 135.

Divergences (name each):
1. The message is the ruling's two sentences on two lines: one "FAIL: git
   could not read the commit of <root> - no certificate." line PER unreadable
   side, then one "Nothing was sent and no record written; re-run where git
   can read <root(s)>." line (FW3-3's own message also spans two lines, split
   at its ';'). Why: R4-1's two triggers - git absent from PATH, git refusing
   the network drive both checkouts sit on - fail BOTH sides, and naming only
   the first would have Cameron fix one and re-run into the other. The
   ruling's exact words are all present; a grep for the ruling's whole quoted
   string on ONE line will not find it.
2. A third test beyond the two the row names: git that cannot start, both
   sides named. It is R4-1's first trigger and the only test of the
   both-sides message.
3. Like FW3-3, the check sits after the header lines, so the console shows
   "branch <root> @ unknown (git failed), prompt ..." before the FAIL line;
   and a `--case` (PARTIAL) comparison fails the same way (it would write a
   record too).

Not changed: R4-1's "related, not new" note (a never-written run whose
checkout is dirty before the first call certifies a labeled dirty commit) -
outside the row; the script header's exit-code list ("1 a check failed, or
the run ... failed" already covers it, as FW3-3 left it); RUNBOOK (it names
the two gate commands only, no git-failure behavior - grepped).

## FW4-2 (R4-2 INFO, R4-3 INFO) - two accepted costs in rule 4 (comment only)

What changed (`app/src/services/extraction/apply.ts:318-328`, the
`filterNoteLines` doc comment, rule 4's "Accepted costs", now citing R3- and
R4-adjudications), two costs added after the existing three:
- a retry of a run that hit the cap appends the lines the cap kept out of
  run 1, at most another MAX_NOTE_LINES (spec D4 puts the guard BEFORE the
  cap, so the lines run 1 wrote are dropped there and no longer take cap
  slots) - R4-2;
- "same day" means the same month and day of ANY year (the prefix,
  `[Auto - <MMM D>]`, carries no year), so a flip back to identical words on
  an exact anniversary is dropped - R4-3. The file's own `<MMM D>` notation
  (the `prefix` field doc) is used rather than the adjudication's `<Mon D>`.
The existing sentences are kept word for word, re-wrapped around the insert;
"A dropped line never takes a cap slot." stays last.

RED / reverted-fix proof: not applicable - no behavior change, so no test
can go red. Proof it is comment only: every changed line of the cee9cb00 diff
starts with ` *` (count of non-comment changed lines: 0). extractionNoteLines,
extractionApply and extractionPromptProbe green after it (below).

Observation, not changed (outside the row): the For-Cameron cost (1) in
R4-adjudications - a re-read OLDER view written as the newest line for a
home - is covered in the code comment only by its mechanism ("a model line
repeated verbatim on a later date is written again"); the plain statement
lives in the For-Cameron note the orchestrator carries to the handback.

## Commands (exit codes as shown)

| Command | Result |
|---|---|
| vitest `extractionPromptProbe` - FW4-1 RED | exit 1, 3 failed / 132 passed (135) |
| same - FW4-1 GREEN | exit 0, 135 / 135 |
| same - check unreachable (fix reverted) | exit 1, 3 failed / 132 passed |
| same - check on the branch side only | exit 1, 2 failed / 133 passed |
| same - restored | exit 0, 135 / 135 |
| `npm run typecheck` (bare, root) before the FW4-1 commit and after FW4-2 | exit 0 each, 0 TS errors, 5 workspaces |
| `npx eslint` on the FW4-1 files; then over every touched .ts (`git diff --name-only --diff-filter=d a6d1a373 -- '*.ts' '*.tsx'`: the probe, its test, apply.ts) | exit 0 each |
| final vitest `extractionPromptProbe`, `extractionNoteLines`, `extractionApply` (after FW4-2) | exit 0, 284 / 284 (135 + 25 + 124) |
| ASCII: `git diff -U0 a6d1a373 HEAD \| grep '^+' \| tr -d '\11\12\15\40-\176' \| wc -c` (and per item before each commit) | 0 |
| `\u` escapes in the touched files (`grep -cF '\u'`) | 0, as at base |

Not run (per the dispatch): root `npm test`, `npm run e2e`, the probe.

## Next step (orchestrator)

A fresh reviewer on a6d1a373..HEAD, if the loop rule asks for one. Open for a
ruling only if wanted: divergence 1 of FW4-1 (the message on a per-side line
plus one closing line).
