# S4 - groupCrossCheck: measured, not rewritten

- Date: 2026-09-01, immediately after S0 and BEFORE any code edit (S1 changes
  `ensureTable` / `deleteTableIfExists`, which sit in this file's own setup
  path at `app/test/groupCrossCheck.test.ts:75` and `:79` - both arms below
  are on the UNMODIFIED code at `5ce9912f`).
- `app/test/groupCrossCheck.test.ts` was NOT edited.
- Scope label: **SOLO arm = `cd app && npx vitest run test/groupCrossCheck.test.ts`**
  (one file, its own vitest process). **LOADED arm = the file's result inside
  S0's three full `npm test` runs** (five workspaces), and later S6's three
  post-fix runs.

## Solo arm - 10 consecutive runs

Snapshot (same read-only method as S0) immediately before each run; one after
the tenth.

| run | result | file duration | wall (process) | other vitest runs | e2e neighbour | dynamo CPU | host CPU |
|---|---|---|---|---|---|---|---|
| 01 | 26/26 pass | 20.4s | 25s | 0 | 1 active (`outbound-mms-scroll-flake` Playwright worker) | 24.8% | 46% |
| 02 | 26/26 pass | 21.9s (vitest) | 25s | 0 | 1 active | 45.6% | 45% |
| 03 | 26/26 pass | 20.4s | 23s | 0 | 1 active | 27.7% | 60% |
| 04 | 26/26 pass | 22.9s | 26s | 0 | 1 active | 38.0% | 46% |
| 05 | 26/26 pass | 21.5s | 26s | 0 | 1 active | 35.9% | 59% |
| 06 | 26/26 pass | 22.3s | 25s | 0 | 1 active | 15.3% | 46% |
| 07 | 26/26 pass | 16.9s | 20s | 0 | 1 active | 32.7% | 40% |
| 08 | 26/26 pass | 13.4s | 17s | 0 | none (QUIET) | 8.7% | 27% |
| 09 | 26/26 pass | 15.7s | 18s | 0 | none (QUIET) | 7.3% | 16% |
| 10 | 26/26 pass | 15.0s | 18s | 0 | none (QUIET) | 8.8% | 25% |

(File duration is vitest's per-file figure; runs 02/05 show the run's
`Duration` line where the file line was not captured. Runs 01-07 ran while
one e2e suite was still live; the neighbour finished between runs 07 and 08,
so runs 08-10 are QUIET. The file is ~35% faster quiet than beside one e2e
suite, and green in both states.)

**0 failures in 10 runs. All 26 cases passed every time.** The vitest
reporter prints only the slower cases individually, so the per-run logs name
14 of the 26; the full 26 are the `it` blocks at
`app/test/groupCrossCheck.test.ts:238-678`.

## Loaded arm - S0's three full runs (pre-change)

`groupCrossCheck.test.ts` passed in all three S0 runs (no failing file in any
run; see `s0-baseline.md` for the per-run load labels: run 1 contended by a
vitest neighbour and two e2e suites, runs 2-3 by e2e suites only). The
post-change half of this arm is S6's three runs, recorded there.

## What this settles and what it does not

Neither arm failed. Per the plan, that IS the deliverable: the anchor issue's
"make the ordering/window assertions robust to latency" remedy for suite A
can be struck in S7 - **narrowly**.

- The anchor records two specific failing cases:
  `a filing for a DIFFERENT author does not clear this author event` (`:327`)
  and `a would-be alarm whose classic filing DID land is reconciled QUIETLY,
  not alarmed` (`:385`). Both ran 10 times solo and 3 times loaded here
  without failing.
- The TTL time-bomb fix was diagnosed against a THIRD case,
  `a DUPLICATE redelivery of the same IM SID is deduped, not double-counted`
  (`:292`). It also ran 13 times green.
- The anchor's 2026-08-18 observations name two further cases (`RAPID
  SAME-AUTHOR messages match one-for-one, in order` `:308`, and `ONE lost
  filing reconciles ONE row ...` `:432`); both were green in all 13 runs.

Evidence covers every case in the file, 13 runs deep, on one afternoon. It
does NOT cover: a vitest neighbour for a whole run (S0 run 1 had one for its
first part only), a genuinely degraded container, or the specific 2026-08-21
`waiting for a lock` signature, which no run here produced. The strike text
in S7 must say that, and must note that the loaded arm straddles S1 by
construction (S0 pre-change, S6 post-change) - the exact hazard that moved
the solo arm ahead of S1.

## Files

Run state (gitignored): `W:\tmp\npm-test-soundness\.superpowers\sdd\s4\`
(`run01..10.log`, `run01..10.snap-before.txt`, `after-run10.snap.txt`,
`summary.txt`), script `.superpowers/sdd/s4-solo.sh`.
