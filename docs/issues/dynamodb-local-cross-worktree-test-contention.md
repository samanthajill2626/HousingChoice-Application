---
id: dynamodb-local-cross-worktree-test-contention
title: Shared DynamoDB Local makes app test suites flake under concurrent worktree runs
type: debt
severity: low
status: resolved
area: app
created: 2026-07-02
refs: app/test/devOutbox.integration.test.ts, e2e/support/lane.mjs, scripts/db.mjs
---

**Problem.** All worktrees share ONE DynamoDB Local container (`:8000`). The e2e layer is
lane-isolated (`hc-local-<L>-` table prefixes), but the **Vitest integration suites** are
not throughput-isolated: when two or more agents/worktrees run `npx vitest run` (or a full
e2e boot seeds tables) at the same time, the container's single-threaded throughput is
shared and slow tests blow their 5s budgets.

**Observed (2026-07-02, tours-sequence build).** Repeatedly during concurrent agent work:
- `app/test/devOutbox.integration.test.ts` timed out (5s) in full-suite runs while a
  neighboring worktree ran its own suite/e2e; **passes solo in ~350ms** every time.
- One run had 6 files fail on pure 5s DynamoDB timeouts; a re-run after the competing
  runs drained was fully green. No code difference between red and green runs.

**Why it matters.** Agents (and humans) read these as real failures, burn time
re-verifying, and "green" gates get retried. It will bite harder as concurrent-worktree
development (the port-lane model) becomes the norm.

**Root cause (measured, 2026-07-02).** No artificial cap to raise: the container runs
uncapped (`mem=0 cpus=0`), already `-inMemory` (no disk/fsync in the path), and the Docker
VM has 31GB. The ceiling is **structural**: the container runs **`-sharedDb`**, which puts
EVERY lane's tables into ONE SQLite database inside the JVM — and SQLite permits **one
writer at a time per database**. All lanes' writes (plus every Vitest integration run)
serialize through a single write lock. Measured while two suites ran concurrently:
`docker stats` pinned at **~105% CPU** (one core saturated, the rest idle) — a beefier
machine cannot help while the write path serializes. The lane table-PREFIXES namespace
data correctly (no contamination, ever) but do not split the underlying database, so they
do not split the lock. Symptom shape confirmed repeatedly: 5s-budget integration tests
and the heaviest-query e2e specs (inbox feed, stuck at `status "Loading"`) time out under
a neighbor's run and pass solo in milliseconds.

**Decision (human, 2026-07-02): drop `-sharedDb` + per-lane access keys.** Without
`-sharedDb`, DynamoDB Local keeps a SEPARATE database per AWS access key — so the lane
launcher injecting `AWS_ACCESS_KEY_ID=hc-lane-<L>` (next to the `TABLE_PREFIX` it already
injects) gives each lane its own database and its own write lock; concurrency then scales
with lanes. The heavier alternative (a per-worktree container) also solves it and adds
JVM-CPU isolation, but the per-key split is the lighter setup and was chosen. To
implement (own branch, at a QUIET moment — changing the flag recreates the container and
wipes every lane's in-memory tables, so never while a neighbor's stack is live):
`scripts/db.mjs` (drop `-sharedDb`), `e2e/support/lane.mjs` + `scripts/e2e-session.mjs`
(inject the per-lane key into all children), Vitest integration harnesses (per-worktree
key, e.g. from the lane hash), and any ad-hoc tooling docs (inspection needs the lane's
key to see its data). Verify with two worktrees' suites running head-to-head.

**Mitigation applied (2026-07-02, tours branch):** `app/vitest.config.ts` raises
`testTimeout` to 15s for the app suites — these are timeouts under load, never hangs, so
the budget absorbs neighbor noise without masking real failures.

Until the structural fix lands: a lone red integration test in a full run that passes solo
should be treated as this contention, verified by the solo re-run, and noted — not "fixed".

**Resolution (2026-07-02, feat/dynamodb-lane-keys — merged to main).** `-sharedDb` dropped
from `scripts/db.mjs`; a legacy `-sharedDb` container is detected via `docker inspect`
args and recreated with a loud warning (that bounce already happened on the dev machine —
lane 0 was recreated + reseeded in place). Each e2e lane now injects its own access key
(`hclane<L>`, from `e2e/support/lane.mjs` → forced into every `scripts/e2e-session.mjs`
child so ambient `AWS_*` can't re-merge lanes) and each worktree's vitest run injects
`hctest<hash>` (`app/vitest.config.ts`, respect-if-set) — DynamoDB Local keeps a separate
database + SQLite write lock per **(access key, region)** pair. Two implementation notes
vs the decision above, both validated empirically on a throwaway container before
building: keys must be **alphanumeric** (`hc-lane-1` throws `UnrecognizedClientException`
once `-sharedDb` is off — hence `hclane<L>`), and **region is part of the store
identity**, so the launcher pins `AWS_REGION=us-east-1`. Verified with the prescribed
head-to-head: two worktrees ran the full 82-spec e2e suite simultaneously — 82/82 + 82/82,
zero timeout flakes, ~0.4m overhead vs solo, container CPU floating 8–80% instead of
pinning ~105%. The 15s `testTimeout` mitigation is retained as belt-and-braces.
Inspection docs updated (README + e2e/README): the access key now selects WHICH database
you see (`local` = dev loop; a lane's key is in `e2e/.artifacts/lane.json`).
