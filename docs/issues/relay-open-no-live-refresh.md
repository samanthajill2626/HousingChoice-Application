---
id: relay-open-no-live-refresh
title: A connect-when-ready relay group opening does not refresh the page (no SSE event)
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-15
refs: app/src/services/poolNumbers.ts:658, app/src/jobs/relayNumberReady.ts, app/src/services/groupRail.ts
---

**Problem.** When a relay group is created and no pool number is free, it opens
in `connecting` and its number is provisioned in the background. Minutes later a
Twilio Event Streams `number-registration.successful` event promotes the number
`warming -> active`, the group opens and the queued intro flushes. **Nothing
tells the open dashboard page that this happened**, so the staff member who
created the group sits on a "waiting for a number" view indefinitely and only
sees the result if they refresh by hand.

Observed live on prod 2026-08-15 (Cameron): the relay group provisioned
correctly - three pool numbers went `active`, the group reached
`relay_status: relay_group#open` with a `pool_number` assigned - but the page
still showed it waiting. The provisioning was healthy; only the notification was
missing, which initially read as a provisioning failure.

**Why it happens (deliberate, not an oversight).**
`app/src/services/poolNumbers.ts:658` routes readiness through the JOB queue and
says so explicitly:

> Connect-when-ready hand-off (D6): signal readiness via the JOB queue (NOT the
> SSE-facing appEvents bus).

That was the right call for the durability of the hand-off - a queue hiccup must
not undo the durable promote. But it means the promote path publishes nothing the
SSE bus can forward, and no other writer covers the gap.

**Why it matters more than it looks.** The whole premise of connect-when-ready is
that the group opens LATER, asynchronously. That is exactly the case where a user
cannot know to refresh, because there is no interaction to prompt one. The
feature's least-observable path is its most common one whenever the spare buffer
happens to be empty.

**Suggested fix.** Have the `relay.numberReady` job handler (the code that opens
the group and flushes the intro - i.e. AFTER the durable work has committed)
publish an appEvents event carrying the `conversationId`, so the existing SSE
plumbing wakes the thread and the relay-group views. Emitting from the handler
rather than from the promote keeps the durability property the comment is
protecting: the queue still owns the hand-off, and the SSE event is a
best-effort notification layered on top of work that already succeeded.

Check whether the relay-group list/detail views subscribe to the right event
shape, or whether a new event type is needed.

**Workaround until then.** Refresh the page. The underlying provisioning works.
