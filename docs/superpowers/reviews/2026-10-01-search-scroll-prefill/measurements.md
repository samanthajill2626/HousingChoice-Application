# Two intermittent e2e failures - measurements (2026-10-01)

Machine: the new Windows 11 PC. Every run is `npm run e2e -w e2e -- --grep ...`
(a hermetic lane that reseeds at startup). Root causes: `diagnosis.md` beside
this file.

## contact-create.spec.ts:157 ("editing a contact can LINK ...")

| Tree | How | Result |
| --- | --- | --- |
| main @8c7921ea | 6 separate standalone runs | P P P F P P |
| main @8c7921ea | instrumented copy, `--repeat-each 15` | 14 P, 1 F (late scroll dismissed the list) |
| main @8c7921ea | real spec, `--repeat-each 40` (test timeout 20s) | 36 P, 4 F - all four the same "no Marcus Bell option" wait |
| fix/search-scroll-prefill (component fix) | real spec, `--repeat-each 40` | 40 P, 0 F |

At the main rate (4 in 40), 40 clean repeats by chance is about 0.9^40 = 1.5%.

The 2026-09-30 history (main, alone, P F F F in one worktree) is in
`docs/superpowers/reviews/2026-09-30-today-past-tours/gate-runs.md`.

## a2p-compliance.spec.ts:323 (re-include step)

| Tree | How | Result |
| --- | --- | --- |
| main, full suites 2026-09-30 | 7 full runs | 2 F at the re-include exact-value check |
| main @8c7921ea | forced interleave (prefill committed between fill's select and insertText) | 3 of 3 produce prefill + typed text, the exact failing shape |
| main @8c7921ea | control: wait for the prefill, then fill | 3 of 3 replace it |
| main @8c7921ea | forced interleave of the SECOND write (draft POST held; its `?cta=text` re-seed committed between select and insertText) | 3 of 3 end `?cta=text` + typed text |
| fix/search-scroll-prefill (spec waits for `?cta=text`) | real test alone, `--repeat-each 10` | 10 P, 0 F |

The standalone failure rate on main was never measured (the two sightings were
in full suites), so the 10 clean repeats show the new wait is always satisfied
rather than proving the race gone; the forced interleaves are the proof that
both writes are hazards, and the wait is ordered after both.

## app vitest `maxWorkers` (raised 4 -> 10)

Cameron asked for more test parallelism on the new 24-core PC. The only CPU
cap in the test stack is `maxWorkers` in `app/vitest.config.ts` (set to 4 on
2026-08-26 on the old 16-thread box; see
`docs/issues/npm-test-runner-rpc-starves-under-concurrent-e2e.md`). Dashboard
vitest is uncapped (23 forks here), the Docker VM sees all 24 CPUs, and the
DynamoDB Local container has no CPU limit. e2e `workers: 1` is structural (one
shared lane), not a CPU setting.

Quiet box (CPU ~4% before), `npx vitest run --maxWorkers=N` in app/, order
4-8-12-16-16-12-8-4. Vitest's reported Duration; all runs 399 files, 8109
passed / 1 skipped, exit 0, 0 `Timeout calling`, 0 `[dynamoAdmin]`:

| maxWorkers | run 1 | run 2 |
| --- | --- | --- |
| 4 | 76.8s | 84.8s |
| 8 | 45.0s | 51.0s |
| 12 | 35.4s | 40.2s |
| 16 | 34.5s | 37.9s |

12 is the knee. Shipped: 10 - Cameron's call to stay below the knee and leave
cores for the suites other worktrees run side by side. Proof under load was
run at 12 (config `maxWorkers: 12`, no CLI flag), which bounds 10 - fewer
workers only lighten the coordinator's load - with two full `npm run e2e`
suites running from two worktrees
(W:\tmp\e2e-rerun-diag at main, and this worktree). CPU sampled every 5s:

| Load | Runs | Result | app Duration | dashboard Duration | CPU |
| --- | --- | --- | --- | --- | --- |
| 2 e2e only (baseline) | - | - | - | - | avg 25% |
| 2 e2e + `npm test` | 3 back to back | all exit 0; 0 RPC timeouts, 0 unhandled, 0 `[dynamoAdmin]` | 63.4s / 67.2s / 71.8s | 33.9s / 33.3s / 33.4s | avg 63%, peak 95% |
| 2 e2e + 2 concurrent `npm test` (one per worktree, both at 12) | 2 | both exit 0; same zero counts | 139.7s / 138.4s | 42.7s / 43.5s | avg 65%, 18/40 samples >= 90%, peak 100% |

The two concurrent runs share one DynamoDB Local, which is why their app
suites take ~2x; still green, and still under the old 4-worker quiet figure x2.

Both load e2e suites: 305 passed, 0 failed, 19.6m each (17.2m alone at gate
time) - the extra `npm test` load cost them time, not correctness.

### The first 10-worker timing was invalid - DynamoDB Local had degraded

After the load runs, two quiet runs at the shipped 10 (config, no flag) took
73.4s / 78.2s - all green, exit 0, 0 RPC timeouts - but a re-check at 8 then
took 80.8s against 45.0s / 51.0s earlier. The container, not the worker
count, had slowed ~1.7x: `docker stats` showed it at 1.92-1.96 GiB, right at
the JVM's `-Xmx2g` cap, at ~3% CPU while idle, 555 threads, 102 database
files (177 MB on the 6 GB tmpfs). Only a restart resets it, and a restart
wipes the shared container (lane 0 included); Cameron approved one (below).
Cause analysis - the heap guess above turned out WRONG - is in
`docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md`.

10 ships on the bracket: 8 (45-51s) and 12 (35-40s) measured on a healthy
container, 12 proven under load, and 10 green twice even on the degraded one.

### After a restart (Cameron's go): the clean 10-worker numbers

Container restarted (`npm run db:stop` + `db:start`; 217 MiB, 67 threads, 0
databases). Interleaved, quiet box, all exit 0, 0 RPC timeouts:

| Run | maxWorkers | Duration | Container after (databases / threads / memory) |
| --- | --- | --- | --- |
| 1 | 8 | 45.41s | 67 / 383 / 844 MiB |
| 2 | 10 | 38.20s | 69 / 391 / 938 MiB |
| 3 | 8 | 45.44s | 71 / 400 / 997 MiB |
| 4 | 10 | 40.24s | 73 / 409 / 1.02 GiB |

So 10 = 38-40s against 4 = 77-85s: about half the time. The database count
climbing by 2 per run is a leak in `globalSetupEnsure.test.ts`; the follow-up
experiments (40 empty databases, one e2e suite, a dual-worktree app run) are
in `docs/issues/dynamodb-local-slows-after-sustained-concurrent-load.md`.
