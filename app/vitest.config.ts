import { defineConfig } from 'vitest/config';
import { testAccessKeyId } from '../e2e/support/lane.mjs';
import { LEDGER_ENV_VAR, ledgerDir } from './test/helpers/dynamoKeyLedger.js';

// DynamoDB Local integration isolation. The shared local container serves a
// SEPARATE database - with its own locks - per (accessKeyId, region); see
// docs/issues/dynamodb-local-cross-worktree-test-contention.md.
//
// The key is chosen PER TEST FILE, in the `setupFiles` hook below, because a
// per-WORKTREE key still put all 53 integration suites in one database behind
// one `queueLock`. app/test/setup/dynamoAccessKey.ts carries the mechanism, the
// measurements, and the opt-in for the suites that must keep the worktree key.
// Respect-if-set: an explicitly exported AWS_ACCESS_KEY_ID still wins.
export default defineConfig({
  test: {
    // CAP THE POOL. Unset, vitest defaults maxThreads to availableParallelism()
    // - 16 threads on a 16-core box - which leaves the MAIN process no core to
    // run on. That process is what answers worker RPCs, and birpc's bundled
    // timeout is 60s, so under any external load it starves and the run dies
    // with `[vitest-worker]: Timeout calling "onTaskUpdate"`. Vitest then exits
    // NON-ZERO with ZERO failing tests, which reads as a broken test that does
    // not exist. See docs/issues/npm-test-runner-rpc-starves-under-concurrent-e2e.md.
    //
    // 4 is measured, not guessed. All four runs, 336 files / 5977 tests:
    //
    //   quiet box, 16 threads   249.8s   0 errors   exit 0
    //   quiet box,  4 threads   253.1s   0 errors   exit 0   (+1.3%)
    //   under load, 16 threads  347.8s   1 error    exit 1   <- the failure
    //   under load,  4 threads  361.7s   0 errors   exit 0
    //
    // So the parallelism above 4 was buying ~nothing even on an idle box: this
    // suite is bound by DynamoDB Local I/O, not CPU. It was only ever costing
    // the coordinator its core. Raising this number is not a speed win; it is a
    // way to reintroduce the false red.
    poolOptions: { threads: { maxThreads: 4 } },
    // Timeouts under cross-worktree load are contention, never hangs — keep a
    // generous budget (belt-and-braces alongside the per-key isolation; this
    // mirrors the feat/tours-sequence mitigation and must survive the merge).
    //
    // Raised 15s -> 60s (feat/ai-run-log), when the key was per-WORKTREE and
    // every integration suite in the worktree therefore shared one DynamoDB
    // Local database and its locks. That branch took the count from 23 to 26
    // and `npm test` failed 4 runs out of 4 - a DIFFERENT integration suite
    // each time, always a 15s timeout, every one green when run alone, and the
    // whole suite green under --no-file-parallelism.
    //
    // The key is now per FILE (setupFiles below), which removes that shared
    // lock rather than waiting it out. The generous budget stays: it still
    // covers cross-worktree load and slow seeds, and raising it was never what
    // fixed the contention.
    testTimeout: 60_000,
    // hookTimeout MUST move with testTimeout. Vitest defaults hooks to 10s, and
    // raising only testTimeout left the heaviest cleanup in the suite on the
    // SHORTER budget: broadcastApi.test.ts seeds 60+ recipients, defers the
    // fan-out into InProcessOutboundQueueAdapter, and drains it in afterEach -
    // the slowest thing in the file, running on 10s while its tests had 60s.
    // That failed on main, not just on branches (proved detached at d59bd76b).
    // Note this class is NOT the DynamoDB Local contention issue: these tests
    // use an in-memory FakeWorld and never touch the container, so the
    // per-access-key isolation above does nothing for them.
    // See docs/issues/broadcast-fanout-tests-blow-default-hooktimeout.md.
    hookTimeout: 60_000,
    env: {
      // NOTE: AWS_ACCESS_KEY_ID is deliberately NOT set here. `test.env` is one
      // value for the whole run, and the whole point is that it varies per test
      // FILE - setupFiles is the only hook that runs once per file, before the
      // file builds its clients. These two carry the inputs it needs.
      HC_TEST_WORKTREE_ACCESS_KEY: testAccessKeyId(),
      // Where app/src/lib/dynamo.ts records which DynamoDB Local databases were
      // actually opened, so globalSetup/globalTeardown can sweep the throwaway
      // tables a crashed suite left in a PER-FILE database - which the teardown's
      // own key structurally cannot see. Set here and nowhere else: unset means
      // no recording, which is what every deployed path gets.
      // See app/test/helpers/dynamoKeyLedger.ts.
      [LEDGER_ENV_VAR]: ledgerDir(),
      ...(process.env.AWS_ACCESS_KEY_ID
        ? { HC_TEST_EXPLICIT_ACCESS_KEY: process.env.AWS_ACCESS_KEY_ID }
        : {}),
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
      // NO TTL REAPER IN TESTS. Services derive `expires_at` from their
      // INJECTED clock, so any suite that pins a past date writes rows that are
      // born already expired - and DynamoDB Local really does reap them, on its
      // own schedule, mid-test. The failure is intermittent and only starts on
      // the date the pinned clock plus the retention window falls behind real
      // time, which makes it look like load flakiness for as long as it takes
      // someone to do the arithmetic.
      //
      // groupCrossCheck lost that bet on 2026-08-18 (pinned 2026-08-11, 7-day
      // window) and aiRunsRepo.integration is set to lose it on 2026-11-04
      // (pinned 2026-08-06, 90-day window). Setting this once here immunises
      // every integration suite, including the ones nobody has written yet -
      // ~60 ensureTable call sites that would otherwise each have to remember.
      //
      // ACCURATE SCOPE (corrected by adversarial review 2026-08-23): this flag
      // does not DISABLE TTL, it declines to ENABLE it. On a table that already
      // has TTL on - from an earlier run under the same key - the reaper keeps
      // running, and DynamoDB Local reaps a born-expired row in about 2 seconds.
      // So the immunity is real for a fresh table and NOT retroactive.
      //
      // The two known fuses are independently safe regardless: groupCrossCheck
      // injects cleanupMs, and aiRunsRepo.integration mints a fresh table per
      // run. The residual is a FUTURE suite that pins a past clock AND uses the
      // shared hc-local- tables on a machine carrying residue - and one clean
      // run heals it.
      //
      // Nothing asserts that TTL is ENABLED on a live table, so this costs the
      // suite nothing. db:create, the e2e lanes and every deployed path leave
      // the flag unset and keep the reaper.
      // See docs/issues/npm-test-dynamodb-local-contention.md.
      DYNAMO_DISABLE_TTL: '1',
    },
    // Auto-bootstrap the hc-local- tables under the active test key before
    // any test runs. Fail-soft: if Docker is down the setup warns and returns;
    // pure-unit runs are unaffected. See app/test/globalSetup.ts.
    // The tables are dropped again after the run - but NOT via a
    // `globalTeardown` option: Vitest has none, and setting one here is
    // silently ignored (verified 2026-08-16 - the tables survived the run).
    // Vitest takes its teardown from the FUNCTION globalSetup RETURNS, so the
    // cleanup is wired inside globalSetup.ts itself.
    globalSetup: './test/globalSetup.ts',
    // Runs once per test FILE, before the file is imported and therefore before
    // it constructs any DynamoDB client (the SDK resolves credentials at client
    // CONSTRUCTION, so this is the last moment that can still decide which
    // database the file reaches). Gives each file its own DynamoDB Local
    // database - its own queueLock, its own per-table locks - at no runtime
    // cost. See app/test/setup/dynamoAccessKey.ts.
    //
    // This depends on vitest's default `isolate: true`: the module registry is
    // reset between files, so the getDocumentClient() singleton in
    // app/src/lib/dynamo.ts is rebuilt under the new key rather than carried
    // over from the previous file in the same worker. test/setup/
    // dynamoAccessKeyGuard.test.ts pins that.
    setupFiles: ['./test/setup/dynamoAccessKey.ts'],
  },
});
