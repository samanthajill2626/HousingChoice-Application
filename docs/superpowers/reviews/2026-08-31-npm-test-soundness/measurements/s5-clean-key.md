# S5 - what the clean-key recipe actually does now, plus the TTL probe

Date: 2026-09-01. Worktree `W:\tmp\npm-test-soundness`.

## The finding is established by READING, the measurement only dates it

`app/test/setup/dynamoAccessKey.ts:120` (`accessKeyForTestFile`) returns an
explicitly exported `AWS_ACCESS_KEY_ID` for EVERY test file, before either
per-file branch. So `AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` does not
buy a clean database - it collapses all ~53 integration suites onto ONE
database and one `queueLock`, which is the OLD arm of the experiment that
justified per-file keys (446-509s loaded vs 75-95s, per the anchor issue).
The recipe in `AGENTS.md` therefore recommends the worse configuration while
describing it as the clean one.

## Measurement - 2 runs per arm, interleaved, ONE commit

- **Scope: app workspace only** (`cd app; npx vitest run`), matching the
  recipe's own scope. NOT comparable to the five-workspace S0/S6 numbers.
- **Both arms at commit `09d624e9`** (recorded by the runner before arm 1).
- Order interleaved (default, key, default, key) so drifting neighbour load
  cannot land wholly on one arm.
- Snapshots (same read-only method as S0) before and after every run.

| run | arm | exit | wall | app files | tests | skipped |
|---|---|---|---|---|---|---|
| 1 | default (per-file keys) | 0 | 231s | 348 passed | 6318 | 0 |
| 2 | explicit `hccleanrun001` | 0 | 189s | 348 passed | 6316 | **2** |
| 3 | default | 0 | 190s | 348 passed | 6318 | 0 |
| 4 | explicit `hccleanrun001` | 0 | 165s | 348 passed | 6316 | **2** |

- The 2-test skip delta in the key arms is `dynamoAccessKeyGuard.test.ts:308`
  standing down its per-file assertions under an explicit key - expected, per
  the spec, not a failure.
- Load labels: 0 other live vitest runs throughout; ONE e2e suite
  (`W:\tmp\participant-snapshot-refresh`) was live beside runs 1-3 and
  finished during run 4 (its after-snapshot drops to 2 non-MCP node procs);
  host CPU 39-82%, container CPU 4-31%.

## Read the numbers with their confounds - they do NOT contradict the code reading

On this afternoon the explicit-key arm was not slower; it was slightly faster
(189/165s vs 231/190s), tracking the DECLINING e2e neighbour load across the
interleave rather than the key scheme. Three confounds, all recorded rather
than assumed away:

1. **The container had been RESTARTED ~25 minutes before the arms** by someone
   outside this mission (`docker ps`: "Up 25 minutes", RSS 2.4 GiB -> 0.9 GiB;
   this mission never touches the container). Both arms therefore ran against
   a FRESH container: no residue in any database, database count reset. The
   anchor's 607s-vs-65s contrast was measured on a database carrying 116
   residue tables - a state that cannot exist here.
2. **`sweepLedgerResidue` runs on the way IN** (`globalSetup`), so even on an
   old container the residue effect the recipe was written against has no
   residue to beat. Both sweeps in every run here evaluated in SOLO mode
   (registry empty at every snapshot) and found nothing to sweep.
3. **The shared-lock contention that per-file keys removed needs LOAD to
   show** - the anchor's own A/B needed a load rig (8 transaction + 8 put
   writers) to produce 446-509s on one database. Two quiet-ish runs cannot
   and did not reproduce it, and nothing here re-argues per-file keys; the
   point is only that the recipe's "clean database" story is structurally
   wrong under per-file keys.

**Conclusion for S7:** the recipe is superseded because of what the CODE says
it does (one shared database), not because of these wall clocks. The rewrite
must not claim the explicit key is slow on a quiet box - it measurably was
not, today - but that it silently restores the one-database regime and skips
2 guard assertions, while buying nothing a clean container does not already
provide.

## The TTL probe - run AFTER the arms, clean slate per arm, container left as found

Method (throwaway script `.superpowers/sdd/s5-ttl-probe.ts`, run state, not
committed): in a process with `DYNAMO_DISABLE_TTL` UNSET - exactly the
condition `globalSetup` runs under, since vitest `test.env` reaches workers
only - call the exported `ensureKeyedLocalTables()` under the worktree test
key, then `DescribeTimeToLive` on a table whose spec CARRIES `ttlAttribute`
(`messages`, `tables.ts:231`) and on a no-TTL control (`contacts`), then
`dropKeyedLocalTables()`. Repeat from a clean slate with the flag SET. The
drop between arms is what makes the contrast real: without it, `ensureTable`
short-circuits on `ResourceInUseException` and arm 2 would describe a table
arm 1 already enabled TTL on.

| arm | `DYNAMO_DISABLE_TTL` in the process | `hc-local-messages` | `hc-local-contacts` (control) |
|---|---|---|---|
| 1 | unset | **ENABLED, attribute `expires_at`** | DISABLED |
| 2 | `"1"` | DISABLED | DISABLED |

Both arms: 22 tables created from empty, 23 dropped after (the 23rd is the
legacy dev-outbox drop), 0 `hc-local-` tables left under the key. The
container was left as found.

**Result: the claim HOLDS.** `globalSetup` -> `createAllTables` ->
`ensureTable` -> `enableTtlIfNeeded` really does enable TTL on the shared
TTL-bearing `hc-local-` tables on every `npm test`, because the flag that
vitest.config sets for workers never reaches the globalSetup process. The
control row is what makes a DISABLED reading meaningful: only 4 of 22 specs
carry `ttlAttribute`, so probing any other table would read DISABLED in both
arms and prove nothing. S7.2's first new issue is filed on this result.

## Files

Run state (gitignored): `.superpowers/sdd/s5/` (`commit.txt`, four run logs +
snapshots, `summary.txt`, `ttl-probe-arm{1,2}.log`), scripts
`.superpowers/sdd/s5-arms.sh`, `.superpowers/sdd/s5-ttl-probe.ts`.
