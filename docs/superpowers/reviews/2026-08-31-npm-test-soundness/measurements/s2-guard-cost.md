# S2 - logCallSiteGuard cost measurement and budget record

Date: 2026-09-01. Worktree `W:\tmp\npm-test-soundness`, branch
`feat/npm-test-soundness`, measured at tip `38c167a6`; shipped at `30642595`.

Scope label: **one file, one workspace** - `cd W:\tmp\npm-test-soundness\app`
then `npx vitest run test/logCallSiteGuard.test.ts`, bare and foreground. This
is NOT the five-workspace `npm test` scope of the S0 baseline and the two must
never be compared side by side.

Method: temporary `performance.now()` instrumentation, never committed, removed
before the shipped commit. Machine state snapshotted with
`.superpowers/sdd/snapshot.ps1` immediately before and after every timed run.
Verbose raw output: `.superpowers/sdd/reports/s2-timing-raw.md` (gitignored).

## Headline: the anchor's premise does not hold on this box

The M7 anchor carries "measured 2026-08-26 the file ran **196.2s ALONE** on a
clean key", and item 2 is framed as a self-defeating 180s budget. Measured
today the same file runs **10.1s wall, 6.5s in the hook** - a ~19x wall / ~28x
hook discrepancy, stable to within 2% across three runs on a QUIET box. The
budget at `logCallSiteGuard.test.ts:143` is therefore already ~27x the solo
cost, not ~0.9x. **See "Open decisions" 1.**

## Pre-cut, 3 runs (instrumented), seconds

| run | wall | hook | buildProgram | scanProgram | health `it` | of which diagnostics |
|---|---|---|---|---|---|---|
| 1 | 10.15 | 6.562 | 5.655 | 0.908 | 2.487 | 2.486 |
| 2 | 10.13 | 6.456 | 5.522 | 0.934 | 2.585 | 2.584 |
| 3 | 10.09 | 6.525 | 5.605 | 0.920 | 2.461 | 2.460 |
| slowest | 10.15 | **6.562** | 5.655 | 0.934 | **2.585** | 2.584 |

Per-site accumulators inside `scanProgram` (identical to 3 significant figures
on all three runs; call counts identical exactly):

| site | `file:line` | seconds | calls | note |
|---|---|---|---|---|
| `getShorthandAssignmentValueSymbol` | `:97` | 0.004 | 1217 | **284 of them while `legal` was true** - the wasted ones |
| `getSymbolAtLocation` | `:106` | 0.003-0.004 | 272 | already inside `!legal &&` |
| `getTypeAtLocation` | `:79` (in `isErrorTyped`) | 0.734-0.748 | 1204 | |
| `typeToString` | `:80` (in `isErrorTyped`) | 0.019-0.020 | 1204 | |

`isCatchDeclared` (`:74-77`) was deliberately NOT instrumented - it does no
checker work.

Health `it` fixed observations, all three runs: `sourceCount=239`,
`getPreEmitDiagnostics` returned **0** diagnostics.

### Supplementary probe - `buildProgram` sub-split (1 run, snapshotted)

Added after runs 1-3 because a two-way build/scan split cannot support a
`buildProgram` remedy decision:

| phase | seconds | share of `buildProgram` |
|---|---|---|
| config parse + `createCompilerHost` + the two host overrides | 0.016 | 0.3% |
| `ts.createProgram` (241 root names) | **4.814** | 87% |
| `program.getTypeChecker()` | 0.698 | 13% |
| (`buildProgram` total that run) | 5.530 | |

## Which site dominated

1. **`buildProgram` dominates the hook**: 5.52-5.66s of 6.46-6.56s = **85-86%**.
   Within it, **`ts.createProgram` is 4.81s = 75% of the whole hook** and ~48%
   of the file's wall clock. That is parse plus module resolution of 241 roots
   and every reachable `.d.ts`. `getTypeChecker()` is not free either (0.70s).
2. **`scanProgram` is 0.91-0.93s = 14-15%** of the hook, and 80% of THAT is
   `getTypeAtLocation` (0.73-0.75s over 1204 calls).
3. **The health `it`'s `getPreEmitDiagnostics` is 2.46-2.58s** - a whole-program
   type-check the hook never pays for, i.e. the single largest cost outside the
   hook and ~25% of the file's wall clock.
4. **The eager site the spec pre-committed a cut for is immaterial.** `:97`
   costs **4 milliseconds** across 1217 calls - 0.06% of the hook, 0.4% of
   `scanProgram`. The 284 wasted calls are real but each is ~3 microseconds.

## What cut was applied: NONE, and why

The decision tree in the plan (S2.2) and brief routes each site:

- `:97` eager `getShorthandAssignmentValueSymbol` - the ONE pre-committed
  remedy. **Does not apply: not material** (4ms). Hoisting `legal` above it
  would save ~1ms of a 6500ms hook while adding diff to a guard whose value is
  that it is easy to read. Declined on the measurement, not on taste.
- `:106` `getSymbolAtLocation` - not material (4ms). No remedy needed.
- `isErrorTyped`'s `getTypeAtLocation` (0.74s) - the largest site inside
  `scanProgram`, but 11% of the hook. **No remedy pre-committed**; and every
  obvious candidate (skipping the type query, caching by node, narrowing to
  catch-declared symbols only) trades away what the guard proves. Returned as a
  decision, not acted on.
- `typeToString` (0.019s) - immaterial. Note it runs only when
  `type.getSymbol()?.getName() !== 'Error'`, i.e. on essentially all 1204 calls
  here, and is still cheap.
- `buildProgram` / `ts.createProgram` - **dominates, and no remedy is
  pre-committed** (worklist 9A/9B confirm `include: ["src"]` and
  `rootDir: "src"` leave no roots to narrow, and `createCompilerHost` has no
  type-checking to remove). Returned as a decision.

**S2.3 health probe: untouched.** No cheaper replacement was proposed, so none
was validated by breaking module resolution, so `:145-157` stays exactly as it
was. A comment was added at the TS2307 filter recording why `sourceCount`
cannot subsume it (every `app/src` file is a program root regardless of
resolution; a program that resolved nothing still counts 239).

## Budget arithmetic

Hook (`logCallSiteGuard.test.ts:143`):

```
slowest measured hook, 3 runs   6.562 s
x4 (the plan's floor)          26.248 s
chosen                        180.000 s  (UNCHANGED)
ceiling check                 180 s <= 600 s  OK
floor check                   180 s >= 26.248 s  OK, with ~27x headroom
```

The rule is `>= 4x`, a FLOOR, not a target. 180s satisfies it, so the budget
needs no change and **must not be reduced to 26s**. The failure this budget
exists for is `Hook timed out in 180000ms` inside a full `npm test`, where this
worker builds a whole TypeScript program while every sibling worker saturates
the box. A solo figure is a **lower bound** on the loaded cost, so sizing the
budget at 4x solo would red on load constantly. That reasoning is now in the
file so the next reader cannot mistake the headroom for slack.

Health `it` (`:145`, under the global `testTimeout: 60_000`,
`app/vitest.config.ts:60`):

```
slowest measured, 3 runs        2.585 s   (2.909 s post-strip, see below)
x4                             11.636 s
global testTimeout             60.000 s
```

4x is comfortably inside the global, and the measurement is nowhere near the
brief's ">15s" trigger, so **no explicit per-test budget was added**. The file
records the threshold at which one would be.

`app/vitest.config.ts` was NOT touched (worklist drift flag 20: `hookTimeout`
is globally 60_000, which is exactly why this hook carries its own third
argument; any new budget must stay an explicit argument).

## Post-strip verification, 3 runs (instrumentation removed)

| run | wall | health `it` | canary `it` | allowlist `it` | exit |
|---|---|---|---|---|---|
| 1 | 10.06 | 2.497 | pass (0ms) | pass (0ms) | 0 |
| 2 | 10.42 | 2.688 | pass (0ms) | pass (0ms) | 0 |
| 3 | 11.21 | 2.909 | pass (0ms) | pass (0ms) | 0 |

3/3 `it`s green on every run, **including the canary positive control at
`:159`** - a cut that lost the canary would be a wrong cut, and there was no
cut to lose it. Cost is 6% of the hook budget and 5% of the global test timeout.

Gates on the shipped state: `npm run typecheck` (root, bare) exit 0 across all
five workspaces; `npx eslint app/test/logCallSiteGuard.test.ts` exit 0 with no
output. The file is byte-checked pure ASCII (0 bytes > 127).

## Machine state, every timed run

Snapshot script reproduces `otherLiveRuns`' three filters without pruning.
Container is `hc-dynamodb-local`; this slice never touched it.

| label | other live vitest runs | non-MCP node procs | container CPU | host CPU |
|---|---|---|---|---|
| pre-run1-before | 0 | 2 | 7.69% | 20% |
| pre-run1-after | 0 | 2 | 7.70% | 10% |
| pre-run2-before | 0 | 2 | 7.63% | 14% |
| pre-run2-after | 0 | 2 | 7.56% | 9% |
| pre-run3-before | 0 | 2 | 9.48% | 14% |
| pre-run3-after | 0 | 2 | 8.13% | 11% |
| pre-run4-split-before | 0 | 2 | 9.13% | 18% |
| pre-run4-split-after | 0 | 2 | 10.21% | 26% |
| post-run1-before | 0 | 2 | 7.97% | 24% |
| post-run1-after | **1** | **8** | 7.96% | 27% |
| post-run2-before | 0 | 2 | 8.13% | 42% |
| post-run2-after | 0 | 5 | 7.91% | 30% |
| post-run3-before | 0 | 5 | 10.47% | 26% |
| post-run3-after | 0 | 4 | 8.55% | 33% |

The two constant non-MCP node processes are another worktree's idle Playwright
`test-server` and this mission's own transcript tail - neither runs vitest.
Browser process count was 89 throughout and is background, not load.

**All four PRE-cut runs are QUIET (0 other live runs at both ends).** The
figures that became the budget were therefore NOT taken under contention, which
is better than the brief's upper-bound fallback allowed for.

**One post-strip window was contended and it is informative.** From
`post-run1-after` onward the neighbouring worktree
`W:\tmp\participant-snapshot-refresh` ran `npx vitest run test/todayApi.test.ts`
with four tinypool workers. The health `it` tracks it exactly: 2.497 -> 2.688 ->
2.909s and wall 10.06 -> 10.42 -> 11.21s. A **single light neighbour costs ~11%**
on this file. Extrapolating from one point is not evidence, but it is the only
direct load datum this slice produced, and it says the ~28x multiplier implied
by the anchor's 180s timeout needs a much heavier load than one neighbour.

## Open decisions for the orchestrator

1. **The 196.2s anchor figure is unreproducible here (10.1s wall / 6.5s hook,
   3 runs, QUIET).** Item 2's premise - an intrinsically ~196s file on a 180s
   budget - does not hold at `38c167a6`. Decide whether S7 re-states or retires
   that number, and whether item 2's issue text still describes a live defect.
   Confound to weigh: these runs followed S0's warm-up plus three full
   `npm test` runs, so the OS file cache was hot for `app/src` and
   `node_modules/typescript`; a cold-cache run was not taken (it cannot be, on
   this box, without evicting cache other slices depend on).
2. **`buildProgram` dominates (85-86% of the hook; `ts.createProgram` alone is
   75%) and no remedy is pre-committed.** Returned as required. The sub-split
   says any remedy must attack `createProgram`'s parse plus module resolution
   of 241 roots - not the compiler host (16ms) and not the checker handle
   (0.70s). Options exist but all are out of this slice's scope: a `ts` document
   registry or incremental `.tsbuildinfo` reuse, or hoisting the program into a
   vitest global setup shared across files (only this file needs one today).
3. **`isErrorTyped`'s `getTypeAtLocation` is 0.74s / 1204 calls - the largest
   in-scan site, 11% of the hook - and no remedy is pre-committed.** Returned
   as required. Flagged because any remedy trades against what the guard
   proves; recommend declining rather than inventing one, since 0.74s buys the
   whole Error-typed half of the check.
4. **The `:97` hoist the spec pre-committed was measured and DECLINED at 4ms.**
   If the orchestrator wants it shipped anyway as a correctness-neutral tidy-up,
   say so - it is a three-line change and I have the measurement to say it buys
   ~1ms. Not shipped on my own judgment.
5. **The health `it` at 2.46-2.91s is 25% of the file and is NOT covered by the
   hook budget.** It has no explicit per-test budget and does not need one at
   this size, but it is the second-largest single cost in the file and the one
   most exposed to load (it is the only clock that moved when a neighbour
   appeared). Worth a line in S6's post-fix comparison.
6. **This slice shipped comments, not a cut.** If the mission's handback needs
   S2 to have changed behaviour, that expectation should be reset now: the
   measurement says there is nothing material to cut inside the file, and the
   only lever with real leverage (`createProgram`) has no pre-committed remedy.

## Addendum: logCallSiteGuard inside the S0 full runs (added 2026-09-01, planner fix wave)

Everything above is the SOLO scope (one file, one workspace). The "31.5s worst
loaded" figure that `logcallsiteguard-hook-budget-equals-its-own-cost.md:52-54`
and the mission handback cite - the one the unchanged 180s hook budget is
~5.7x - is NOT from that scope: it is this file's own per-file duration line
INSIDE the four full `npm test` runs of S0, which
until now lived only in gitignored run state (`.superpowers/sdd/s0-warmup.log`,
`s0-run{1,2,3}.log`). Quoted here so the provenance is committed. The lines as
the runs printed them, with the leading tick and the ANSI colouring stripped:

```
test/logCallSiteGuard.test.ts (3 tests) 12608ms     <- s0-warmup.log
test/logCallSiteGuard.test.ts (3 tests) 31527ms     <- s0-run1.log
test/logCallSiteGuard.test.ts (3 tests) 9972ms      <- s0-run2.log
test/logCallSiteGuard.test.ts (3 tests) 13408ms     <- s0-run3.log
```

| S0 run | this file | machine state, per `s0-baseline.md`'s snapshot |
|---|---|---|
| warm-up | 12.6s | unlabelled (the warm-up carries no snapshot table) |
| run 1 | **31.5s** | CONTENDED at start: host CPU 100%, 1 other live vitest run (the main checkout's `npm test --workspaces`) plus 2 e2e suites; QUIET by the end |
| run 2 | 10.0s | CONTENDED by two live e2e suites, ZERO other vitest runs (host CPU 34%) |
| run 3 | 13.4s | CONTENDED by one live e2e suite, ZERO other vitest runs |

Read it as the load curve it is, not as four samples of one thing: the only run
with a competing VITEST neighbour is the only run above 14s, and it is 3.1x the
quietest of the four. That is the direct evidence behind sizing the hook budget
well above 4x the solo cost (see "Budget arithmetic"), and it is a stronger
version of the single-neighbour ~11% datum in the post-strip window above.
