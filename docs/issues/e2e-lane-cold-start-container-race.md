---
id: e2e-lane-cold-start-container-race
title: Concurrent e2e sessions race to docker-run the shared DynamoDB/MinIO containers from cold
type: debt
severity: low
status: resolved
area: infra
created: 2026-07-01
resolved: 2026-08-21
refs: scripts/db.mjs, scripts/s3.mjs
---

**Resolution (2026-08-21, `fix/e2e-harness-determinism`).** `ensureDbStarted`
and `ensureS3Started` now treat a losing `docker run` as success rather than a
boot failure. Both classify the conflict (`is already in use by container`,
`Conflict. The container name`, `port is already allocated`, `address already in
use`) and fall through to the readiness wait they already had - the same posture
as their existing `already running` branch, extended to cover the
in-flight-start window. `docker start` gets the same tolerance, for two starters
that both saw `stopped`.

Chose this over the suggested lockfile: the containers are already idempotent by
name, so the conflict IS the signal that another starter won, and there is
nothing left to serialize. A lock would add a file that can be orphaned to fix a
race the daemon already arbitrates.

The warm-first workaround in `e2e/README.md` remains good practice (it avoids
the wait entirely) but is no longer required for correctness.

**Problem.** E2E port-lane isolation lets multiple worktrees run `npm run e2e`
concurrently on distinct per-lane ports (verified: two lanes coexist fine once the
shared containers are up). But the DynamoDB Local (`:8000`) and MinIO (`:9000`)
containers are single shared instances that each session "ensures" at boot. If two
sessions start **from cold at the same instant** (both containers down), they race to
`docker run` the same container name — the loser hits a name/port conflict and that
session fails to boot (observed: one lane's session hung/failed at "ensuring MinIO"
while the other was mid-`docker run`). Narrow: it only bites when the containers are
down AND two starts land within the same moment; it self-corrects on a re-run, and
does not affect the lane isolation itself.

**Workaround (documented in e2e/README.md).** Warm the containers once before kicking
off several concurrent runs: `npm run db:start && npm run s3:start` (both idempotent —
"already running" once up), then start the e2e runs.

**Suggested fix (if it ever becomes annoying).** Make the container-ensure
concurrency-safe: a lightweight cross-process lock (e.g. a lockfile in the OS temp dir)
around the `docker run`, or treat the "container name already in use / port in use"
docker error as "another starter won — wait for it to become ready" instead of failing.
Mirror how `db:start` already handles the "already running" case, extended to cover the
in-flight-start window. YAGNI for now — the warm-first workaround is sufficient.
