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
    testTimeout: 15_000,
    env: {
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? testAccessKeyId(),
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? 'local',
    },
    // Auto-bootstrap the hc-local- tables under the active test key before
    // any test runs. Fail-soft: if Docker is down the setup warns and returns;
    // pure-unit runs are unaffected. See app/test/globalSetup.ts.
    globalSetup: './test/globalSetup.ts',
  },
});
