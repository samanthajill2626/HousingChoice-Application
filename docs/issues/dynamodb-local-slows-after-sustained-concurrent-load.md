---
id: dynamodb-local-slows-after-sustained-concurrent-load
title: DynamoDB Local stays ~1.7x slower after an hour of concurrent e2e + npm test load, with its JVM at the -Xmx2g cap
type: bug
severity: med
status: open
area: test-infra
created: 2026-10-01
refs: scripts/db.mjs, app/vitest.config.ts, docs/superpowers/reviews/2026-10-01-search-scroll-prefill/measurements.md
---

**Problem.** On the new 24-core PC, after about an hour of heavy test load on
the shared `hc-dynamodb-local` container (started 12:40 that day), every
DynamoDB-backed run got slower and STAYED slower once the load was gone. The
load, in order: a 40-repeat contact-create run per worktree, a full gate
`npm test` + e2e, eight quiet app-suite timing runs, then two full e2e suites
from two worktrees at once with three `npm test` runs and then two concurrent
`npm test` runs on top.

Same command, same worktree, quiet box both times
(`npx vitest run --maxWorkers=8` in app/):

- before the load: 45.0s and 51.0s
- after the load: 80.8s (every test still green)

It was already creeping earlier: in the interleaved 4-8-12-16-16-12-8-4
timing, every setting's second run was 7-17% slower than its first.

The total in-test time per run nearly doubled (about 120-170s to 299s), so
the time went into waiting on the database, not into the worker pool. At the
same moment `docker stats` showed the container at 1.92-1.96 GiB of memory,
right at its JVM cap (`-Xmx2g`), using ~3% CPU while idle, with 555 threads.
It held 102 per-key database files totalling 177 MB on its 6 GB tmpfs, so
neither the disk nor the database count is anywhere near a limit.

Why it matters: this is the workload the repo now runs routinely - several
worktrees overlapping e2e suites and `npm test` - and a silently slower
database is how load-sensitive tests start blowing their budgets, which then
reads as flakiness. The 2026-08-24 move to a disk-backed tmpfs was meant to
make "restart to reclaim memory" unnecessary by construction (scripts/db.mjs
header); this sighting says something still accumulates.

**UNVERIFIED cause.** Heap pressure near `-Xmx2g` (GC working hard on every
request) fits the shape - slow at idle-level CPU, memory pinned at the cap -
but it was not measured: the image ships no `jstat`/`jcmd`, and the container
was not restarted to compare. A per-database object retained for every key
ever opened (one per test FILE, per lane) would grow with use and never shrink
within an uptime, which would fit too.

**Suggested next steps.**
1. Reproduce cheaply: restart the container (this WIPES it, lane 0 included),
   time `npx vitest run --maxWorkers=8` in app/, apply the same load, time it
   again, and record the container's memory at each step.
2. If the heap is the cause, measure `-Xmx4g` (the PC has 64 GB) under the
   same load before changing `scripts/db.mjs` - its stale-args check recreates
   a container with different JVM args, which also wipes it.
