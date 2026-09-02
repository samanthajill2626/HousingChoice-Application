# S2 implementer brief - logCallSiteGuard: measure, then cut (M7)

Begin by using tools - do not reply until the work is committed.

You are the implementer for slice S2 of the "npm test soundness" mission, in
worktree `W:\tmp\npm-test-soundness` (branch `feat/npm-test-soundness`). Work
ONLY in that worktree; use ABSOLUTE paths and `cd W:\tmp\npm-test-soundness`
explicitly in EVERY shell command (the cwd resets between calls). Never touch
`W:\AI Projects\Housing Choice\HC Application` or any other `W:\tmp\*`
worktree.

## Read first, in this order

1. `W:\tmp\npm-test-soundness\AGENTS.md` (repo rules)
2. `W:\tmp\npm-test-soundness\docs\superpowers\specs\2026-08-31-npm-test-soundness-design.md`
   - section "Item 2" in full
3. `W:\tmp\npm-test-soundness\docs\superpowers\plans\2026-09-01-npm-test-soundness.md`
   - "Rules that apply to every slice" and section "S2" in full (S2.1-S2.5)
4. `W:\tmp\npm-test-soundness\.superpowers\sdd\worklist.md` - section 0 (drift
   flags 2, 20) and section 9 (every S2 anchor verified against the live tree)
5. `W:\tmp\npm-test-soundness\app\test\logCallSiteGuard.test.ts` (the file)

The spec is a contract. If a spec point looks wrong, STOP and report.

## Scope - exactly these files

- `app/test/logCallSiteGuard.test.ts` (modify)
- `docs/superpowers/reviews/2026-08-31-npm-test-soundness/measurements/s2-guard-cost.md`
  (NEW - the committed measurement record, ASCII)

Nothing else. Not `app/vitest.config.ts`, not `app/tsconfig.json`, not any
other test.

## S2.1 - instrument and measure (uncommitted instrumentation)

The `beforeAll` (`:140-143`) is exactly `buildProgram(true)` + `scanProgram`.
`ts.getPreEmitDiagnostics` is NOT in it - it runs inside the first `it`
(`:145`, the call at `:152-153`) under the global `testTimeout: 60_000`.

Add TEMPORARY timing (performance.now) that reports, per run:

- `buildProgram` total; `scanProgram` total; the health `it`'s
  `getPreEmitDiagnostics` total (time it separately from the rest of that
  `it`).
- Inside `scanProgram`, accumulated time AND call count for the three sites
  that do checker work: `:97` `checker.getShorthandAssignmentValueSymbol`
  (also count how many of those calls happened while `legal` was true - the
  wasted ones); `:106` `checker.getSymbolAtLocation`; and inside
  `isErrorTyped` (`:79-80`) `getTypeAtLocation` and `checker.typeToString`
  SEPARATELY (two accumulators - typeToString is its own expensive call).
- Do NOT instrument `isCatchDeclared` (`:74-77`) as a cost centre - it does no
  checker work.

Print the numbers with a greppable prefix (e.g. `[s2-timing]`) so they land
in the vitest output.

Run the file ALONE, 3 times, from `W:\tmp\npm-test-soundness\app`:
`npx vitest run test/logCallSiteGuard.test.ts` - bare, foreground, output
redirected to a file under `W:\tmp\npm-test-soundness\.superpowers\sdd\reports\`
then read. IMMEDIATELY before and after EACH run record the machine state
with the orchestrator's snapshot script:
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "W:\tmp\npm-test-soundness\.superpowers\sdd\snapshot.ps1" -Label s2-pre-run1-before`
(labels `s2-pre-runN-before` / `-after`, later `s2-post-runN-...`). The
number you measure becomes a PERMANENT budget, so a figure taken under
unrecorded load is worse than none. The box is currently CONTENDED by other
missions; record it and treat the result as an UPPER BOUND - do not wait for
quiet, do not fabricate quiet.

## S2.2 - cut the measured dominant cost. Decision tree, no improvisation

- If the eager symbol lookup at `:97` is material: hoist the `legal` test
  above `getShorthandAssignmentValueSymbol` and skip the checker call when
  `legal` is true. In the PROPERTY-ASSIGNMENT branch (`:101-111`) the checker
  call is ALREADY inside `!legal &&` - no change there, and the recursion into
  nested object literals at `:109` must still run REGARDLESS of `legal` (do
  not `continue` early).
- If `:106`'s `getSymbolAtLocation` is material: no remedy is pre-committed.
  STOP after measuring, write the record, and return the numbers as a
  decision for the orchestrator. Do not invent a filter.
- If `isErrorTyped`'s `getTypeAtLocation` / `typeToString` dominates: no
  remedy is pre-committed. Same - measure, record, return as a decision.
  (Do NOT "fix" the `||` short-circuits at `:98` / `:106`; they already
  short-circuit.)
- If `buildProgram` dominates: no remedy is pre-committed. Same - measure,
  record, return as a decision. (`createCompilerHost` has no type-checking to
  remove; `include: ["src"]` leaves no roots to narrow - worklist 9A/9B.)

If more than one site is material, apply the ONE pre-committed cut (the `:97`
hoist) if it applies, then return the rest as decisions.

## S2.3 - the health probe may NOT be hollowed out

`app/tsconfig.json` is `"include": ["src"]`, so every `app/src` file is a
program ROOT whether or not its imports resolve. `sourceCount > 50` does NOT
subsume the TS2307 check. Any cheaper replacement must be validated by
deliberately breaking module resolution and proving the probe still fails. If
you do not have such a replacement, leave `:145-157` alone. Do not touch it
speculatively.

## S2.4 - budget BOTH clocks

- Hook budget (the third argument at `:143`) >= 4x the NEW measured hook cost
  (your post-cut 3-run figure - use the SLOWEST of the three), ceiling 600s.
  If 4x exceeds 600s, STOP and report - do not ship a ten-minute hook.
- The health `it` runs under the global `testTimeout: 60_000`
  (`app/vitest.config.ts:60`) and carries a whole-program type-check. If your
  measurement puts it anywhere near 60s (say > 15s, i.e. 4x would exceed the
  global), give it an explicit per-test budget on the same 4x rule via the
  `it`'s third argument. Do not change `vitest.config.ts`.
- The shipped comments cite ONLY what this mission measured: the date
  (2026-09-01), the per-phase numbers, and the recorded machine state
  ("under contention from N concurrent vitest/e2e runs; upper bound"). Do
  not cite the inherited 196.2s / 179.1s figures as justification.

Fallback: if the cut does not bring the cost materially below ~196s, raise the
budget to >= 4x measured within the ceiling and record WHY the cut did not
help.

## S2.5 - verify, strip, commit

- File alone, 3 runs post-cut, snapshots before/after each, same procedure.
  Confirm the new cost is a small fraction of the new budget; confirm all
  three `it`s still pass (the canary positive control at `:159` MUST still be
  flagged - a cut that loses the canary is a wrong cut).
- REMOVE every line of instrumentation. The committed diff to
  `logCallSiteGuard.test.ts` contains only the cut and the budgets/comments.
- `cd W:\tmp\npm-test-soundness; npm run typecheck` (root), and
  `cd W:\tmp\npm-test-soundness; npx eslint app/test/logCallSiteGuard.test.ts`
  (fix only errors YOU introduced; the file is clean today).
- Commit (see discipline). Then write and commit the record.

DO NOT run the full `npm test`, `npm run e2e`, or `npm run smoke`. Do NOT
restart the DynamoDB Local container (this slice never touches it). Do NOT
set `E2E_CHILD_LOG_DIR`. Never end your turn with a background command
running - all runs foreground, redirected to a file.

## The record - `measurements/s2-guard-cost.md` (ASCII)

Per run, pre and post: wall clock of the file, hook total, buildProgram,
scanProgram, the five per-site accumulators with call counts (and the
`legal`-while-eager count), the health `it`'s diagnostics time, and the
snapshot summary (other live vitest runs, non-MCP node procs, dynamo cpu, host
cpu) before and after. Then: which site dominated, what cut was applied (or
why none), the budget arithmetic (measured -> x4 -> chosen -> ceiling check),
and every open decision for the orchestrator. `file:line` cites only; no
byte-exact code quotation in the committed record - verbose raw output goes to
`W:\tmp\npm-test-soundness\.superpowers\sdd\reports\s2-timing-raw.md`
(gitignored).

## Encoding / edit rules

- New and touched lines ASCII-only (the file is fully ASCII today - keep it
  so).
- Never rewrite a source file with a PowerShell `Get-Content | -replace |
  Set-Content` pipeline. Use the Edit tool.

## Commit discipline (verbatim repo rules)

- Bare `git status` before EVERY commit; check `.git/MERGE_HEAD` is absent.
  Stage EXPLICIT PATHS only - never `git add -A`. Other files may be dirty
  from the orchestrator's own work - leave them alone.
- Trailer on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

## Return

Reply with ONLY: commit hashes + one-liners; the pre-cut and post-cut
3-run tables (hook / build / scan / diagnostics, seconds); the dominant site
and the cut applied; the shipped budgets; the record path; the open decisions
for the orchestrator (one line each). No narration.
