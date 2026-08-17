import { defineConfig } from 'vitest/config';
import { testAccessKeyId } from '../e2e/support/lane.mjs';

// DynamoDB Local integration isolation. The shared local container serves a
// SEPARATE database (and SQLite write lock) per (accessKeyId, region) — see
// docs/issues/dynamodb-local-cross-worktree-test-contention.md. This config
// gives THIS worktree's vitest runs their own key (hctest<hash>), so `npm
// test` no longer serializes behind a neighboring worktree's e2e run (nor
// behind the dev loop's 'local' store). Respect-if-set: an explicitly
// exported AWS_ACCESS_KEY_ID still wins.
export default defineConfig({
  test: {
    // Timeouts under cross-worktree load are contention, never hangs — keep a
    // generous budget (belt-and-braces alongside the per-key isolation; this
    // mirrors the feat/tours-sequence mitigation and must survive the merge).
    //
    // Raised 15s -> 60s (feat/ai-run-log). The per-key isolation above stops
    // THIS worktree contending with a NEIGHBOR, but every integration suite in
    // this worktree shares that one key, so they share one DynamoDB Local
    // database and its single SQLite write lock. This branch took the count
    // from 23 to 26 (aiRunsRepo, extractionRepo, suggestionResolutionRepo) and
    // `npm test` then failed 4 runs out of 4 - a DIFFERENT integration suite
    // each time, always a 15s timeout, every one green when run alone, and the
    // whole suite green under --no-file-parallelism. That is the write lock
    // starving whoever asks last, not a hang, so the budget is what has to
    // move. Serializing instead costs 2min -> 5min for every future run.
    testTimeout: 60_000,
    env: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? testAccessKeyId(),
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
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
  },
});
