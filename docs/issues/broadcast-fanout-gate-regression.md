---
id: broadcast-fanout-gate-regression
title: Invalidated broadcast fan-out mainline regression attribution
type: bug
severity: low
status: resolved
area: app
created: 2026-09-01
refs: app/test/broadcastFanOut.test.ts:354, app/src/jobs/broadcastFanOut.ts
---

**Problem.** The first final-gate triage saw six `broadcastFanOut.test.ts` failures and
incorrectly classified them as a current-main regression because the test and job files
are byte-identical to main. That file-level comparison missed a changed dependency:
transport-fidelity routes the real send wrapper through `sendPreparedMessage`, while
these tests replace only legacy `adapter.sendMessage`.

**Resolution (2026-09-01).** A detached `7be40139` baseline passed all 25 broadcast
tests under a distinct clean DynamoDB key. The branch-only prepared-send seam is the
cause, so the transport-fidelity mission owns a narrow test-fixture correction. This
record remains only to prevent a future re-triage from repeating the invalid attribution.
