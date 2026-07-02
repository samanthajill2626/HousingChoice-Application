---
id: e2e-lane-cold-start-container-race
title: Concurrent e2e sessions race to docker-run the shared DynamoDB/MinIO containers from cold
type: debt
severity: low
status: open
area: infra
created: 2026-07-01
refs: scripts/e2e-session.mjs, scripts/db.mjs, scripts/s3.mjs
---

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
