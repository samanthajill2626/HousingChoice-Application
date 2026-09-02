# S6 - the sync, the five gates, and the post-fix arm

Date: 2026-09-01. Worktree `W:\tmp\npm-test-soundness`.

## The sync

One mainline sync, exactly once: `b4ba463a` merges `main` @ `1af02926` into
the branch. Main's advance since the base (`5ce9912f`) is the merged
tour-reminder-ladder Phase B plus records - 113 files, ~19k insertions - with
ZERO overlap on this mission's touched files (the only shared directory is
`docs/issues/`, all additive, no conflicts). No dependency files changed, so
no re-install was needed.

## The five gates - all on `b4ba463a`, bare, from the worktree, quiet tree

| gate | command | exit | evidence |
|---|---|---|---|
| 1 | `npm run typecheck` | **0** | all five workspaces; re-run from a pwd-verified worktree shell after a cwd-reset incident (below) |
| 2 | `npm test` | **0** (x3) | runs below; 0 failing files in any run |
| 3 | `npm run smoke` | **0** | `smoke-dist: OK - 1365 import specifier(s) across 239 emitted file(s) resolve under plain Node.` |
| 4 | `npm run e2e` (hard `timeout 1500` wrapper) | **0** | Playwright `262 passed (20.9m)`, wall 1255s, lane 11, no orphaned listener before start |
| 5 | `npx eslint <touched .ts files>` | **0** | file list from `git diff --name-only --diff-filter=d main...HEAD`: the six touched `.ts` files; ZERO errors reported, so no baseline attribution was needed (the merge-base baseline for the four pre-existing files was also clean, taken at S0 time) |

Gate-5 file list: `app/scripts/db-update-gsis.ts`, `app/src/lib/dynamoAdmin.ts`,
`app/test/dynamoAdminRetry.test.ts`, `app/test/logCallSiteGuard.test.ts`,
`app/test/setup/dynamoAccessKeyGuard.test.ts`, `app/test/staticSmoke.test.ts`.

Cwd-reset incident, recorded for honesty: the FIRST gate-1 invocation ran in a
shell whose working directory could not be trusted afterwards (a later command
in the same session demonstrably executed in the main checkout; nothing there
was staged, committed or left behind - verified). Gate 1 was re-run from a
`pwd`-verified worktree shell and is the figure above. All detached gate/run
scripts `cd` explicitly inside the script and were unaffected.

## The post-fix arm - 3 runs, label: QUIET

Same runner and snapshot method as S0. Every snapshot: **0 other live vitest
runs, 2-5 non-MCP node procs (an idle Playwright test-server and this
mission's transcript tail), container CPU 3.7-4.8%, host CPU 13-59%.** Both
residue sweeps in every run: solo mode, nothing swept.

| run | exit | wall | app | tests | skipped |
|---|---|---|---|---|---|
| 1 | 0 | 238s | 349 files | 6436 | 0 |
| 2 | 0 | 223s | 349 files | 6436 | 0 |
| 3 | 0 | 254s | 349 files | 6436 | 0 |

Other workspaces identical across runs: dashboard 183 files / 2871 tests, e2e
19 / 492, fake-twilio 34 / 240, fake-twilio-web 13 / 111.

## The S0/S6 pair - read it with ALL FOUR confounds, it is not a performance result

S0 (base, contended): 580 / 452 / 463s. S6 (post-fix): 238 / 223 / 254s.

1. **Different LOAD.** S0's runs were genuinely contended (a vitest neighbour
   plus one or two live e2e suites; host CPU up to 100%); S6's are QUIET.
   The machine went quiet because the neighbouring missions finished - load
   was not fabricated to match, per the protocol. **This is a mixed
   contended-vs-quiet pair and may NOT be used to close the anchor issue.**
2. **Different WORK.** The mission un-skipped staticSmoke's 9 `it`s, added
   the 22-case retry acceptance suite, and (c) PASSES because a fresh
   `dashboard/dist` is present; the merge added Phase B's suites. App files
   346+1 skipped -> 349, tests 6283+9 skipped -> 6436.
3. **Different CODE BASE.** S0 ran at `5ce9912f`; S6 at `b4ba463a`, which
   includes main's Phase B (113 files).
4. **Different CONTAINER STATE.** S0 ran against a container up ~27h;
   between S4 and S5 someone OUTSIDE this mission restarted it (RSS
   2.4 GiB -> 0.9 GiB), so S5/S6 ran against a fresh one.

What the pair DOES establish: `npm test` at the branch tip is green, three
times, with identical counts, on a quiet box - and nothing in the mission's
changes made the suite slower on comparable terms (the closest comparable
figure is the warm-up's 285s at `5ce9912f` on the old container, unlabelled).

## groupCrossCheck in this arm (the S4 loaded-arm tail)

Passed in all three runs (no failing file anywhere). Note the caveat recorded
in `s4-groupcrosscheck.md`: the loaded arm straddles S1 by construction - S0's
runs are pre-change, these are post-change - which is why the S7 strike is
narrow.

## Files

Run state (gitignored): `.superpowers/sdd/s6-run{1,2,3}.*`,
`.superpowers/sdd/s6/gate{1,3,4,5}-*.log`, `run-gate.sh`, `measure-run.sh`.
