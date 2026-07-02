import { defineConfig } from 'vitest/config';

// The DynamoDB-Local integration suites share ONE local container across every
// concurrent worktree (see docs/issues/dynamodb-local-cross-worktree-test-contention.md):
// `-sharedDb` puts all lanes in one SQLite store with a single write lock, so a
// neighboring worktree's full e2e run can stretch a normally-sub-second test past
// vitest's 5s default. These are timeouts under load, never hangs — a generous
// budget keeps `npm test` honest on a busy machine without masking real failures
// (a genuine hang still fails, just 10s later). The structural fix (per-lane
// access keys → per-lane databases) is tracked in the issue above.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
