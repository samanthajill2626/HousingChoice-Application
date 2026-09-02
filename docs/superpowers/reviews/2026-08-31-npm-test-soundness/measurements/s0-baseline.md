# S0 - contended baseline at the base commit

- Date: 2026-09-01
- Commit under test: `5ce9912f` (code; the branch tip `cf544c3b` differs from
  it by docs-only commits, so nothing that can move a test number changed)
- Worktree: `W:\tmp\npm-test-soundness`
- Scope of every run below: **`npm test` from the worktree root = FIVE
  workspaces** (app, dashboard, e2e, fake-twilio, fake-twilio-web), run through
  Git bash with stdout+stderr redirected to a file (non-TTY, same shape as the
  warm-up). Never `cd app && npx vitest run` - that is a different scope and
  is labelled as such wherever it appears (S5).
- Install: `npm install` in the worktree first (20s, 640 packages), then ONE
  warm-up `npm test` (EXIT 0, wall 285s) DISCARDED - it primed the transform
  cache so the measured runs do not pay a cold install or cold cache.
- Container: `hc-dynamodb-local`, up ~27h at start, never restarted by this
  mission.

## How "contended" was measured (read-only, no pruning)

A snapshot script (`.superpowers/sdd/snapshot.ps1`, run state, not committed)
taken IMMEDIATELY before and after every measured run records:

1. Other live vitest runs - by LISTING the machine-global marker directory
   (`os.tmpdir()/hc-vitest-runs`) and reproducing ALL THREE of
   `otherLiveRuns`' filters (`app/test/helpers/testRunRegistry.ts:93-125`)
   without its prune side effect: all-digit filename only (`:103`), pid alive
   (`:114`), marker younger than `MARKER_BACKSTOP_MS` = 6h (`:48`, `:109`).
   `otherLiveRuns()` itself was never called.
2. Non-MCP, non-Codex-runtime `node.exe` processes with their command lines
   (so neighbours can be attributed to a worktree), browser process count.
3. `docker stats --no-stream` CPU and RSS for `hc-dynamodb-local`, plus host
   CPU load.

A run whose before AND after snapshots show zero other live vitest runs and
no e2e/vitest neighbours is labelled QUIET. The residue-sweep MODE is
DERIVED from the snapshot (other live runs > 0 implies spare-young), for
BOTH sweeps - the way-in sweep from `globalSetup` (approximated by the
before snapshot) and the teardown sweep (approximated by the after snapshot).
`globalSetup` prints nothing when a sweep finds nothing, so the mode cannot
be read from the log; every measured run's log carried no `swept`/`spared`
line, i.e. both sweeps found nothing in every run.

## Runs

### Run 1 - label: CONTENDED at start, QUIET by the end (neighbours finished mid-run)

| | before (12:08:22) | after (12:18:08) |
|---|---|---|
| other live vitest runs (reproduced filter) | **1** (pid 79376 - the main checkout's `npm test --workspaces`) | 0 |
| e2e neighbours | 2 sessions: main checkout (`npm run e2e` + playwright test-server) and `W:\tmp\outbound-mms-scroll-flake` (`npm run e2e`) | 0 vitest, e2e stacks idle |
| non-MCP node procs | 26 | 19 |
| dynamo CPU / RSS | 126% / 2.32 GiB | 7.9% / 2.35 GiB |
| host CPU | 100% | 10% |
| derived sweep mode | way-in: spare-young | teardown: solo |

Result: **EXIT 0, wall 580s.** Failing files: **none.**

| workspace | files | tests | skipped | duration |
|---|---|---|---|---|
| app | 346 passed, 1 skipped (347) | 6283 passed | **9** | 487.59s (tests 815.67s) |
| dashboard | 183 | 2855 | 0 | 64.97s |
| e2e | 19 | 492 | 0 | 9.76s |
| fake-twilio | 34 | 240 | 0 | 3.19s |
| fake-twilio-web | 13 | 111 | 0 | 6.77s |

(The `Start-Process` launcher dropped the run's label argument, so its
artifacts were written unlabelled and renamed to `s0-run1.*` afterwards; the
run itself was unaffected.)

### Run 2 - label: CONTENDED by two live e2e suites, ZERO other vitest runs

| | before (12:19:10) | after (12:26:45) |
|---|---|---|
| other live vitest runs (reproduced filter) | 0 | 0 |
| e2e neighbours | 2 suites with ACTIVE Playwright workers: main checkout (`npm run e2e`, worker pid 77236) and `W:\tmp\outbound-mms-scroll-flake` (worker pid 14936), each with its app + worker + fake-twilio + vite stack | 1 suite still active (`outbound-mms-scroll-flake`); the main checkout's e2e finished mid-run |
| non-MCP node procs | 19 | 11 |
| dynamo CPU / RSS | 19.5% / 2.35 GiB | 42.6% / 2.38 GiB |
| host CPU | 34% | 36% |
| derived sweep mode | way-in: solo | teardown: solo |

Result: **EXIT 0, wall 452s.** Failing files: **none.**

| workspace | files | tests | skipped | duration |
|---|---|---|---|---|
| app | 346 passed, 1 skipped (347) | 6283 passed | **9** | 355.68s (tests 600.56s) |
| dashboard | 183 | 2855 | 0 | 66.50s |
| e2e | 19 | 492 | 0 | 9.44s |
| fake-twilio | 34 | 240 | 0 | 6.33s |
| fake-twilio-web | 13 | 111 | 0 | 7.92s |

Note the contention here is e2e traffic against the same DynamoDB Local
container and the same CPUs, not a vitest neighbour - so both of this run's
residue sweeps evaluated in SOLO mode even though the box was far from quiet.
The registry only counts vitest runs; "contended" and "spare-young" are not
the same predicate.

### Run 3 - label: CONTENDED by one live e2e suite, ZERO other vitest runs

| | before (12:27:14) | after (12:35:02) |
|---|---|---|
| other live vitest runs (reproduced filter) | 0 | 0 |
| e2e neighbours | 1 suite with an ACTIVE Playwright worker (`W:\tmp\outbound-mms-scroll-flake`, worker pid 14936) plus the main checkout's idle `test-server` | same suite still active |
| non-MCP node procs | 12 | 11 |
| dynamo CPU / RSS | 44.8% / 2.38 GiB | 21.9% / 2.41 GiB |
| host CPU | 87% | 47% |
| derived sweep mode | way-in: solo | teardown: solo |

Result: **EXIT 0, wall 463s.** Failing files: **none.**

| workspace | files | tests | skipped | duration |
|---|---|---|---|---|
| app | 346 passed, 1 skipped (347) | 6283 passed | **9** | 333.42s (tests 616.81s) |
| dashboard | 183 | 2855 | 0 | 97.61s |
| e2e | 19 | 492 | 0 | 10.77s |
| fake-twilio | 34 | 240 | 0 | 4.70s |
| fake-twilio-web | 13 | 111 | 0 | 8.33s |

## Summary of the baseline arm

| run | label | wall (5 workspaces) | app duration | app aggregate test time | failing files |
|---|---|---|---|---|---|
| 1 | contended: 1 vitest neighbour + 2 e2e suites at start; quiet at end | **580s** | 487.6s | 815.7s | none |
| 2 | contended: 2 e2e suites (1 by the end), 0 vitest neighbours | **452s** | 355.7s | 600.6s | none |
| 3 | contended: 1 e2e suite, 0 vitest neighbours | **463s** | 333.4s | 616.8s | none |

- **3/3 EXIT 0, zero failing files, identical counts every run** (app 346
  files + 1 skipped file, 6283 tests + 9 skipped; dashboard 2855; e2e 492;
  fake-twilio 240; fake-twilio-web 111).
- The load was real but it was NEVER a vitest neighbour for a whole run: run
  1 had one for its first part; runs 2 and 3 were loaded by concurrent
  Playwright suites (which hammer the same container and CPUs) with the
  registry at zero. So spare-young sweep mode can have applied only to run
  1's way-in sweep, and every sweep in every run found nothing (no
  `swept`/`spared` line in any log). The labels above say exactly which load
  was present; do not read "contended" as "vitest-contended".
- There is NO quiet arm of this commit in this record. The warm-up (285s
  wall, app 181s) was discarded by design - cold transform cache and no
  snapshot - and is not comparable. A QUIET figure for this scope, if one is
  wanted, has to be taken later and labelled as such.
- The anchor issue's 65s / 607s figures are `cd app && npx vitest run` scope
  (one workspace, and under the OLD one-database regime). Nothing here is
  comparable to them; S5 measures that scope separately.

## Per-run failing FILE lists

None in any run. The durable signal this arm carries is the wall clock and
the file counts; pass/fail on three runs proves only that nothing failed on
this box on this afternoon under this particular load.

## Files

Run state (gitignored, `W:\tmp\npm-test-soundness\.superpowers\sdd\`):
`s0-warmup.log`, `s0-run{1,2,3}.log`, `s0-run{1,2,3}.snap-{before,after}.txt`,
`snapshots.log`, `snapshot.ps1`, `measure-run.sh`.

## Skipped count (S3 confound, recorded per plan S0 step 5)

App workspace: **1 skipped FILE, 9 skipped TESTS** in every run - that is
`app/test/staticSmoke.test.ts`, whose both describes `skipIf(!built)` and
`dashboard/dist` does not exist in this worktree. S3 un-skips exactly those
nine `it`s, so the S0/S6 pair does not compare the same work. No other
workspace skipped anything.

## Warm-up (discarded, for context only)

EXIT 0, wall 285s, app 181.15s, same file/test counts as run 1. Not a
measurement - its cache was cold and its contention was not snapshotted.
