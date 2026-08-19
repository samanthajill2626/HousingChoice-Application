---
id: update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible
title: The updateCallStatus fake mirrors the real conditional write, so a broken real repo passes the whole suite
type: debt
severity: med
status: open
area: app
created: 2026-08-19
refs: app/src/repos/messagesRepo.ts, app/test/helpers/twilioWebhookHarness.ts, app/test/messagesRepo.callTranscript.test.ts
---

**Problem.** Every voice-webhook test drives the FAKE `updateCallStatus` in
`app/test/helpers/twilioWebhookHarness.ts`, which hand-mirrors the real repo's
forward-only `ConditionExpression` semantics. Nothing in the suite exercises the
real repo's version of that logic, so the two can silently diverge and the suite
will not notice.

This was demonstrated, not theorised, while adding an optional
`expectedPriorCallStatuses` narrowing to `updateCallStatus` (2026-08-19). Two
mutation probes:

1. Narrowing removed from the FAKE only -> the new regression test goes RED.
2. Narrowing removed from the REAL repo only -> the test stays GREEN, exit 0.

Probe 2 is the finding. A correctness change to the real conditional write - the
thing that actually protects a live call from being terminated by a redelivered
webhook - can be reverted or broken outright and every gate stays green.

The standing convention that the fake mirrors the real semantics 1:1 is recorded
at `app/test/messagesRepo.callTranscript.test.ts:2-6`. The convention is
reasonable; the problem is that it is enforced only by whoever remembers it.

**Suggested fix.** Give `updateCallStatus` at least one integration test against
DynamoDB Local covering the transition matrix the ConditionExpression encodes:
a forward transition commits, a regressing one is a no-op, an unknown CallSid is
a no-op, and an `expectedPriorCallStatuses` narrowing refuses a prior outside the
intersection. That is the smallest thing that would have failed under probe 2.

Note the tension with `npm-test-red-on-main-dynamodb-local-contention`: new
DynamoDB Local integration suites are exactly what is currently flaking under
full-suite load. Worth landing alongside, or after, whatever fixes that.
