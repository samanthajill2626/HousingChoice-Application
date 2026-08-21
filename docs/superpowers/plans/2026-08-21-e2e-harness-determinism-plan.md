<!-- HISTORICAL-RECORD -->
> **HISTORICAL RECORD - completed, merged, and frozen (2026-08-21).** This document
> describes how this work was *designed/planned at the time of writing*. The work shipped to
> `main` and its feature branch + worktree were deleted during worktree cleanup. **This file
> is NOT current documentation, and the live code may have drifted from it. Do not treat it as
> authoritative guidance on how the system should be built or how it behaves today.** For
> current truth read the code and the living docs (e.g. `RUNBOOK.md`, `e2e/README.md`,
> `docs/issues/_CLUSTERS.md`). Kept only as a point-in-time record of intent.

# Plan - C6 wave 1: E2E / test harness determinism

Branch: `fix/e2e-harness-determinism` (worktree `W:\tmp\e2e-harness-determinism`)
Base: `main` @ `e0fb96e1`. Written 2026-08-21.

No spec. Every issue in this cluster prescribes its own remedy at the shape
level; what was missing was ordering and the shared primitive S3 introduces.

## Issues in scope

| sev | issue | slice |
|---|---|---|
| high | `e2e-lane-allocation-cross-worktree-race` | S3 |
| med | `broadcast-fanout-tests-blow-default-hooktimeout` | S1 |
| med | `npm-test-dynamodb-local-contention` | S2 |
| med | `e2e-lane-tables-stale-schema` | S4 |
| low | `e2e-session-lane-mismatch` | S5 |
| low | `e2e-lane-cold-start-container-race` | S6 |

## The thing that makes this one branch

Four of the six are the same missing primitive: **there is no machine-global
record of who owns a lane and what state it is in.** `e2e/.artifacts/lane.json`
and `session.pid` are repoRoot-relative, so they are PER-WORKTREE - they can
tell you about your own session and structurally cannot arbitrate between two
worktrees. Lanes are TCP ports, which are a machine-global resource. The
registry has to be too.

Once a shared per-lane record exists, three more issues become consumers of it
rather than separate designs: what schema the lane's tables are at (S4), which
lane a filtered Playwright run should reuse (S5), and whether a launcher is
allowed to reap a port (inside S3).

## Findings that already change the issue records

Verified in this worktree before planning, both to be corrected in S2:

- **`seedProfile.integration.test.ts` is already fixed.** The issue says it
  "crosses the global `testTimeout: 15_000` (`app/vitest.config.ts:16`)". That
  config now reads `testTimeout: 60_000` at line 27, AND the named test carries
  its own `240_000` budget at `seedProfile.integration.test.ts:138`. `seedLive`
  likewise carries two `120_000` budgets. Suites C and D of the merged umbrella
  are remediated; the issue text is stale.
- **`hookTimeout` is genuinely still unset.** `app/vitest.config.ts` raises
  `testTimeout` only, so `afterEach` hooks still run on Vitest's 10s default
  while the tests they clean up after get 60s. That is exactly the defect
  `broadcast-fanout-tests-blow-default-hooktimeout` describes, and it is live.

## Slices

### S0 - baseline (DONE)

Bare `npm test` on the untouched branch @ `e0fb96e1`:

```
app        1 failed | 317 passed | 1 skipped (319 files) - 5654 tests passed
dashboard  168 passed | e2e 17 passed | fake-twilio 33 passed | scripts 13 passed
```

The one failure is `test/groupCrossCheck.test.ts > ... > a filing for a
DIFFERENT author does not clear this author event` - suite A of the contention
umbrella. B, C and D did not reproduce; `broadcastApi` was green too, so S1 is
preventive rather than baseline-clearing.

**This is the number the final gate is compared against: 1 failing file, that
file.** Not zero.

### S1 - hook budget + poison-proof reset

`broadcast-fanout-tests-blow-default-hooktimeout`. Two edits, no design:

1. `app/vitest.config.ts` - add `hookTimeout: 60_000` beside `testTimeout`,
   with a comment saying why the two must move together.
2. `app/test/broadcastApi.test.ts:124` - move `_resetForTests()` into a
   `finally` so a timed-out drain cannot poison the following tests. This is
   the cascade the issue calls out: one real cause reported as three failures.

Independent of everything else. Lands first so the baseline delta is readable.

### S2 - correct the contention record

`npm-test-dynamodb-local-contention`. Rewrite against what S0 actually shows:
mark suites C and D remediated with the evidence above, keep A
(`groupCrossCheck`) and B (`unreadIndexRepo.integration`) only if the baseline
still reproduces them, and re-point the remedy list. If the baseline is green,
say so and downgrade rather than leaving a med issue describing a fixed state.

Docs-only. No code.

### S3 - the lane lease (the high)

New `e2e/support/laneLease.mjs`. Design:

- **Registry:** `path.join(os.tmpdir(), 'hc-e2e-lanes')`, one file per lane,
  `lane-<L>.json`. Temp-dir cleaners are an accepted risk: a lost lease costs a
  re-probe, never a wrong answer.
- **Acquire:** `writeFileSync(file, body, { flag: 'wx' })` - an atomic
  exclusive create on both Windows and POSIX, which is the whole point. On
  `EEXIST`, read the holder; if its pid is dead, compare-before-delete (re-read,
  verify the token is byte-identical to what we just read, unlink, retry once);
  if alive, move to the next lane.
- **Body:** `{ ownerToken (32 hex), pid, gitDir, lane, acquiredAt, appCommit,
  schemaHash }`. `schemaHash` is S4's hook.
- **Staleness:** pid-liveness is the precise signal; a 24h TTL backstops a
  recycled pid.
- **Wire into `resolveLane()`:** a lane qualifies when it probes free AND the
  lease is acquired. Same walk, one more condition.
- **Release:** only when the on-disk token matches ours. Cleanup releases the
  matching lease and nothing else.
- **Gate the destructive path:** `prepareOwnedPort` currently calls `killPort`
  for any non-profiler launcher. That is the step that can kill another
  worktree's Vite, and it becomes conditional on holding the lease.
- **Bind-failure fallback:** on a real `EADDRINUSE` at spawn, release, bump,
  retry - converting the residual TOCTOU from "boot fails" to "auto-recover".
  This is the merged `e2e-lane-probe-bind-toctou` remedy.

**The trap, and it is worse than "the child must adopt" (corrected while
reading the code).** `lane.mjs` is not called in-process by anyone who then
holds the lane. BOTH callers spawn it as a short-lived child and read its
stdout:

- `e2e/playwright.config.ts:16` - `execFileSync(node, [laneMjs])` at config load
- `scripts/e2e-session.mjs:49-51` - the same `execFileSync`, again

So the process that resolves the lane **exits immediately**. A lease stamped
with `process.pid` inside `resolveLane()` is stale by pid-liveness the instant
it is written, and the next probe would reclaim it from its rightful owner. A
naive implementation passes every unit test and then hands two worktrees the
same lane under load - the exact bug this slice exists to fix, reintroduced by
its own fix.

The lease therefore needs TWO phases:

1. **Reserve** - `lane.mjs` atomically `wx`-creates
   `{ ownerToken, state: 'reserved', reservedByPid, reservedAt }` and prints
   `ownerToken` in its JSON. Its pid is expected to die.
2. **Claim** - the long-lived session launcher rewrites the record to
   `{ state: 'held', pid: launcherPid }`, but ONLY if the on-disk token matches
   the one it was handed. That is the handoff.

Staleness differs per state: a `held` lease is reclaimable when its pid is dead;
a `reserved` lease is reclaimable when its reserver is dead AND it is older than
a grace window. The window must exceed the gap between reserve and claim -
Playwright's `webServer.timeout` is 180s, so 120s is too tight for the
config-load path. Use the webServer timeout as the floor.

Token flow: `lane.mjs` stdout -> `playwright.config.ts` -> `E2E_LANE_TOKEN` in
`webServer.env` alongside `E2E_LANE` -> `e2e-session.mjs` -> the override branch
of `resolveLane()` ADOPTS on a token match instead of reserving again.

Release reuses the compare-before-delete idiom `scripts/e2e-stop.mjs:44-47`
already uses for `session.pid` / `lane.json`: re-read, verify byte-identical to
what we wrote, then unlink. That is in-repo prior art, not a new pattern.

Generalize `scripts/lib/profilerOwnership.mjs` rather than inventing a second
token vocabulary - it already has the 32-hex token shape and identity-proof
assertions, just no filesystem exclusion.

### S4 - stale lane schema

`e2e-lane-tables-stale-schema`. Stamp a hash of the `lib/tables.ts` GSI set into
the lease record at boot. On mismatch, drop and recreate that lane's
`hc-local-<L>-*` tables under the lane's own access key before seeding - lane
data is hermetic and reseeded, so recreate is always safe. Log the recreate
loudly; a silent one would hide real drift.

### S5 - lane stickiness for filtered runs

`e2e-session-lane-mismatch`. `playwright.config.ts` prefers a live session's
lane: read `e2e/.artifacts/lane.json`, and if its `launcherPid` is alive AND it
holds the matching lease, use that lane instead of free-probing. Print the exact
`E2E_LANE=<n>` export line in the session-ready banner either way.

### S6 - cold-start container race

`e2e-lane-cold-start-container-race`. In `scripts/db.mjs` / `scripts/s3.mjs`,
treat docker's "container name already in use" / "port is already allocated" as
"another starter won - wait for ready" rather than a failure. Mirrors the
`already running` path each script already has, extended to cover the
in-flight-start window.

## Gates - RESULTS

All three run bare from this worktree, AFTER the single `main` sync
(`a51afb7d`, clean merge, zero overlapping files, no dependency change):

| gate | result |
|---|---|
| `npm run typecheck` | GREEN, five workspaces |
| `npm test` | 1 failing file - `groupCrossCheck.test.ts` - **identical to the S0 baseline**; 317 passed, 1 skipped; dashboard 168 / e2e 18 / fake-twilio 33 / scripts 13 all green |
| `npm run e2e` | **251 passed (17.8m), 0 failed** |

`npm test` is adjudicated by FILE against the S0 baseline, per the repo rule,
not against zero. Same file failing before and after this branch = no
regression. The failing CASE differed between the two runs, which is that
suite's documented signature.

Both e2e runs also served as the feature test for S3/S4/S5: lane 15 was
reclaimed from a dead run's `held` lease on boot, `db:update-gsis` reported
`0 index(es) added, 22 table(s) already current`, and the ready banner printed
the reuse line.

### Failures along the way, and what they were

1. **70 specs, `E2E_LANE=15 is held by another live run`.** The adoption trap in
   the one path not enumerated: Playwright re-loads its config in EVERY test
   worker. Fixed by exporting the token for workers AND by moving the refusal
   out of `lane.mjs` into the launcher - lane.mjs DESCRIBES, the launcher OWNS.
2. **Preflight stale-server abort.** Self-inflicted: a commit landed while the
   suite was booting, so its session was one commit behind the checkout. The
   guard was right. Do not commit during an e2e run.
3. **`unreadIndexRepo.integration` (suite B).** Known flake, re-run alone
   23/23 green in 1.089s. Recorded in the umbrella issue with its evidence.
4. **`groupCrossCheck` (suite A).** Same file as baseline. Investigating it
   produced a genuinely new finding - it fails ALONE sometimes, so isolation is
   not a reliable green and the suite has real latency-dependent assertions.

`npm run e2e` matters more than usual here - S3 and S5 change how every run
acquires its lane, so the suite is both the gate and the feature test.

## Risk

The one to watch is S3 breaking the Playwright -> session handoff (the adoption
trap above). Mitigation: unit tests for the lease module covering acquire /
contend / stale-reclaim / adopt-by-token / release-wrong-token, plus one real
`npm run e2e` before handback.

Sixteen live worktrees against `MAX_LANES = 16` means collisions are near
certain, not theoretical - which is the argument for doing this at all, and
also means the e2e gate here shares a machine with whatever else is running.
