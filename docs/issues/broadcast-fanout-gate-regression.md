---
id: broadcast-fanout-gate-regression
title: Broadcast fan-out retries fail on current main
type: bug
severity: med
status: open
area: app
created: 2026-09-01
refs: app/test/broadcastFanOut.test.ts:354, app/src/jobs/broadcastFanOut.ts
---

**Problem.** `npm test` on the message-transport-fidelity synced branch reproduces six
`broadcastFanOut.test.ts` failures: 429 continuation enqueueing, terminal transient
failure, 30007 and 30005 failure handling, next-attempt backoff, and transient-defer
event emission. Both the test and implementation are byte-identical to merged `main`,
so this feature must not modify them. The failures leave the root completion gate red.

**Suggested fix.** Reproduce the six cases on a clean, non-overlapping DynamoDB Local
test run at current `main`, identify the changed broadcast send/error boundary, and
restore the documented continuation and derived-event contracts with red/green proof.
