---
id: pool-numbers-admin-unbounded-inventory
title: GET /api/pool-numbers fetches all states + full group history unpaginated (unbounded as the pool ages)
type: debt
severity: low
status: open
area: app
created: 2026-07-18
refs: app/src/routes/poolNumbersAdmin.ts:220
---

**Problem.** The admin inventory route always fetches all three lifecycle
states (active, releasing, released) and, for EVERY pool-number record, its
entire relay-group history via an uncapped Promise.all over
conversations.getAllByPoolNumber (N+1 Queries, no concurrency limit, no
pagination). The released partition is retained forever as compliance
provenance, yet it is fetched on every page load even though the default
client filter hides released rows. This is a spec-accepted trade-off at
launch scale (spec section 3: numbers well under 100; non-goals: no
pagination UI) and is cheap today - but page latency grows without bound as
the pool ages, and at a few hundred numbers the uncapped concurrent-Query
fan-out risks SDK socket exhaustion / DynamoDB throttling. Raised by the
2026-07-18 adversarial review (finding 3).

**Suggested fix.** When the pool grows past launch scale: fetch only the
state(s) the caller asks for (a ?state= query param mirroring the filter
chips), lazy-load a number's group history on row expand, and/or cap the
join concurrency (p-limit-style batching). No schema change needed - both
GSIs already support the narrower reads.
