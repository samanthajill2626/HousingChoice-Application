---
id: relay-fanout-active-pass-cap-close-race
title: Relay duplicate can cap-close a source while its final pass is sending
type: bug
severity: high
status: deferred
area: app
created: 2026-09-02
refs: app/src/jobs/relayFanOut.ts:734, app/src/jobs/relayFanOut.ts:1093, app/src/repos/messagesRepo.ts:3373, app/src/services/relayQueuedMessages.ts:89
---

**Problem.** Two relay fan-out envelopes with different job IDs can act on the
same source concurrently. One worker can claim the final durable fan-out pass
and block after provider acceptance while the other receives `capped` and marks
the same nonterminal recipients `failed/transient_cap`. The first worker's
successful result can then be rejected as stale on a transport-schema-v1 row;
the legacy whole-slot writer can race in the opposite direction. Overlapping
queued-message flushes are one production-reachable duplicate producer because
the losing `queued_pending -> queued` transition still enqueues a fresh job.

The message-transport-fidelity post-main-sync review reproduced this with a
barrier test using two distinct job IDs. The test was intentionally not kept in
that branch because it is red until this issue is fixed. The detailed producer
inventory and rejected alternatives are recorded in
`docs/superpowers/reviews/2026-08-31-message-transport-fidelity/post-main-sync-adversarial.md`.

**Suggested fix.** Keep the existing exact-job-ID marker and add an optional,
source-level fan-out owner with an explicit recovery lease. Claim ownership and
the next durable pass atomically. A competing job must return `in_flight`
without consuming a pass, sending, or closing. A capped source may run the
existing close-B recovery only when no owner is active. Release must be
conditional on the current owner, and an expired owner's recovery semantics
must account for the unknown provider outcome. Cover both legacy and
transport-schema-v1 sources with barrier tests, plus lease expiry and stale-owner
release tests. No migration should be required.
