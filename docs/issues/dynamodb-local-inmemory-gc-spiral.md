---
id: dynamodb-local-inmemory-gc-spiral
title: The -inMemory container's JVM-heap ratchet ended in GC-spiral stalls that failed BOTH soak lanes at the same instant - replaced with SQLite-on-tmpfs
type: bug
severity: high
status: resolved
area: tooling
created: 2026-08-24
resolved: 2026-08-24
refs: scripts/db.mjs, app/test/dbArgs.test.ts
---

**Found by the dual-suite soak, and adjudicated by the human to the right
standard: a degraded container may make testing SLOWER, never RED.**

**The failure (soak round 2, 2026-08-24).** Both lanes - two isolated
worktrees, separate access keys, separate databases - failed the SAME test at
the SAME wall-clock instant: lane A a `page.goto` 30s hang, lane B a raw
`page.request.get` 30s hang with no browser involved. Two isolated lanes
stalling together means a SHARED resource stalled, and the only shared
stateful resource is the one DynamoDB Local JVM. Checked immediately after:
**5.9 GiB RSS, 124% CPU, while idle** - up from 2.5 GiB that morning.

**The mechanism.** `-inMemory` keeps every table in the JVM heap, and deletes
never return the memory (measured previously: `DeleteTable` reclaimed ~4 MiB
of a 300 MiB write; databases can never be dropped at all). A heavy
multi-agent day ratchets the heap until the collector enters a spiral whose
stop-the-world pauses stall every lane's requests at once. Round 1 of the
same soak was 506/506 green; the soak itself pushed the container over the
edge between rounds.

**The fix, with the intermediate step that measurement killed.**

| shape | app suite | data footprint | failure mode under pressure |
|---|---|---|---|
| `-inMemory` (old) | ~65-90s | JVM heap, ratchets forever | silent GC spiral, 30s stalls |
| `-dbPath` on container disk | **405s** (~5x - fsync) | disk files | rejected on speed |
| `-dbPath` on tmpfs + `-Xmx2g` (new) | **72.9s, 329/329** | **19 MB / 55 files** after a full suite | loud: tmpfs size cap (6g) errors writes; heap cap OOMs visibly |

The tmpfs shape keeps every property at once: memory-speed writes; the data
OUT of the JVM heap (kernel tmpfs - freed files return RAM instantly, and
SQLite reuses freed pages so a file stabilises at peak working set, never
cumulative); a capped heap so pressure fails LOUDLY instead of slowly; and
stop-wipes-data semantics identical to what the repo always documented.

**Operational changes riding along (scripts/db.mjs):**

- `containerArgsAreStale` now flags `-inMemory` (and the hour-lived plain-disk
  sh-wrapper interim shape) for automatic recreate on the next `db:start` -
  the same self-deploying rollout as the 2026-07-02 `-sharedDb` migration.
  Substring matching for legacy markers, element-exact for the required flags;
  `app/test/dbArgs.test.ts` pins all five shapes.
- The 3-day stale-uptime WARNING (which could only plead for an operator
  restart) is replaced by `pruneOrphanedDatabases`: db:start deletes per-key
  database FILES untouched for 7+ days - orphans of deleted worktrees and
  dead lanes, previously unreclaimable without a restart. Safe by mtime: live
  lanes touch their files every run. Best-effort, never blocks a boot.

**What this deliberately does not claim:** GC stalls of the old size cannot
recur, but tmpfs is still finite (6g) and the heap cap is real - both now fail
VISIBLY at their limits. If a future workload legitimately needs more, raise
the numbers in scripts/db.mjs with a measurement, not by reverting to
-inMemory.
