---
id: update-call-status-fake-mirrors-real-so-a-broken-repo-is-invisible
title: The updateCallStatus fake mirrors the real conditional write, so a broken real repo passes the whole suite
type: debt
severity: med
status: resolved
area: app
created: 2026-08-19
resolved: 2026-08-21
refs: app/test/updateCallStatus.integration.test.ts, app/src/repos/messagesRepo.ts:2208, app/test/helpers/twilioWebhookHarness.ts:1121
---

**Resolution (2026-08-21, `fix/test-suite-hardening`).**
`app/test/updateCallStatus.integration.test.ts` - 8 cases against real DynamoDB
Local, covering exactly the matrix the ConditionExpression encodes: a forward
transition commits and stamps its fields, a regressing one is a no-op, a second
terminal is a no-op, an unknown CallSid is a no-op, nothing transitions into
`ringing`, and all three arms of the `expectedPriorCallStatuses` narrowing
(commits when it includes the prior, refuses when it excludes it, and cannot
WIDEN past what the machine allows).

Deliberately small. The fake keeps carrying the volume of the voice-webhook
suite; this proves the thing the fake is imitating.

**Re-ran the original mutation probes to prove the test actually bites** - a new
test that has never failed is worth nothing, which is the whole premise of this
issue:

| probe: break the REAL repo | before | now |
|---|---|---|
| remove the `expectedPriorCallStatuses` narrowing | **GREEN, exit 0** | **1 failed** |
| remove the forward-only `ConditionExpression` | (untested) | **6 failed** |
| restore (byte-identical) | - | 8 passed |

The first row is the finding this issue was filed on. It now fails.

**What this does NOT do:** it does not make the fake faithful. The fake still
hand-mirrors the real semantics and can still drift; what changed is that the
drift can no longer hide, because the real implementation is now pinned
independently. Making mirrors self-checking rather than remembered is the wider
C11 theme - see `sw-mirror-test-pins-literals-not-behaviour` for the same shape
in the service worker.

The tension the issue flagged - "new DynamoDB Local integration suites are
exactly what is currently flaking under full-suite load" - was resolved first,
deliberately: `npm-test-dynamodb-local-contention` was root-caused (a TTL time
bomb) and fixed before this landed, so this suite is not being added to a
flaking gate.

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
