---
id: vitest-keyed-db-needs-bootstrap
title: Fresh worktree vitest runs 500 on /__dev/reseed until db:create runs under the worktree test key
type: debt
severity: low
status: resolved
resolved: 2026-07-02
area: infra
created: 2026-07-02
refs: app/vitest.config.ts, app/scripts/db-create.ts, app/test/globalSetup.ts, docs/issues/dynamodb-local-cross-worktree-test-contention.md
---

**Problem.** Since per-access-key DynamoDB Local databases (no `-sharedDb`), each worktree's
vitest runs use their own `hctest<hash>` key (`app/vitest.config.ts`) — a separate, initially
EMPTY database. Most integration tests create their own throwaway-prefix tables and are fine,
but tests that exercise `seedAll`/`resetLocalData` against the standard `hc-local-` tables
(e.g. `devOutbox.integration.test.ts`) fail with `ResourceNotFoundException` (reseed 500s)
until someone runs `npm run db:create` UNDER that key. Plain `npm run db:create` uses the
`local` key, so it silently "verifies" the wrong database. Hit for real on a fresh worktree
after merging the per-key change (2026-07-02).

**Workaround.** One-time per worktree:
`AWS_ACCESS_KEY_ID=$(node -e "import('./e2e/support/lane.mjs').then(m=>process.stdout.write(m.testAccessKeyId()))") AWS_SECRET_ACCESS_KEY=local npm run db:create`

**Suggested fix.** Make the bootstrap self-serve: either a vitest globalSetup that ensures the
`hc-local-` tables exist under the active key (cheap idempotent CreateTable), or make
`db:create` default to `testAccessKeyId()` when run outside the dev loop (respect-if-set,
mirroring vitest.config), or at minimum document the one-liner in README's hermetic-mode
section next to the per-key explanation.

**Resolution.** `app/test/globalSetup.ts` (wired into `app/vitest.config.ts` as `test.globalSetup`)
runs before any test file. It computes the active test key (same respect-if-set logic as
`vitest.config.ts`), probes DynamoDB Local for reachability, and calls `createAllTables(endpoint)`
(idempotent). Fail-soft: unreachable Docker → console.warn + return (pure-unit runs unaffected).
Non-local endpoints are refused with a warn (local-only guard). `db-create.ts` gained a CLI
guard so its top-level execution code no longer runs on import. `isLocalEndpoint` was exported for
reuse. Three tests in `app/test/globalSetupEnsure.test.ts` verify creation, idempotency, and the
non-local skip. `npm test` is now self-serve on a fresh worktree (Docker must be running for
integration tests).
