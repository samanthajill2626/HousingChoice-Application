---
id: relay-thread-unfiltered-sse-resorts-paged-history
title: useRelayThread refetches on every org-wide message event and re-sorts the whole paged transcript
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/conversation/useRelayThread.ts:363, dashboard/src/routes/conversation/useRelayThread.ts:274, dashboard/src/routes/conversation/useGroupThread.ts:294, dashboard/src/routes/shared/threadPaging.ts:43
---

**Problem.** Two costs that used to be bounded now scale with how far back the
operator has paged.

1. **Unfiltered trigger.** `useRelayThread` wires `onMessagePersisted` and
   `onConversationUpdated` straight to `scheduleRefetch`
   (`useRelayThread.ts:363-369`). `/api/events` is one ORG-WIDE firehose, so a
   message to any conversation in the org refetches this thread.
   `useGroupThread` already drops non-matching events with a one-line filter
   (`useGroupThread.ts:294-300`, `event.conversationId !== conversationId`);
   the relay hook never got it.
2. **Unbounded merge.** Before history paging, a refetch was
   `setServerItems(buildRelayItems(messages))` - O(page). It is now
   `mergeTimelineItems(prev, fresh)`, which builds a `Map` over every HELD item
   plus the page and re-sorts the union (`threadPaging.ts:43-51`). The held set
   grows by up to 50 rows per "Load older messages" click and is never trimmed,
   so the per-event cost grows with the session rather than staying flat.

The two compound: on a busy org, an operator who has paged a long relay thread
several screens back pays a full re-read of 50 messages AND a re-sort of
thousands of held items for every unrelated inbound message anywhere in the org.

**Failure story.** A navigator opens a relay group during an outreach push,
clicks "Load older messages" a dozen times to find a landlord's earlier answer
(~600 held items), and leaves the tab open. Unrelated inbound texts arrive at a
few per second across the org. Each one costs this tab a 50-message HTTP read it
does not need plus a 600-item map-and-sort, on a 300ms debounce. The page grows
janky while the operator is doing nothing but reading.

Related, and deliberately NOT duplicated here:

- [thread-hooks-refetch-whole-page-per-event](./thread-hooks-refetch-whole-page-per-event.md)
  covers the READ cost (re-fetching a whole page to deliver one new bubble) in
  all three hooks. It does not cover the MERGE cost, which is new with paging.
- [contact-timeline-sse-refetch-unfiltered](./contact-timeline-sse-refetch-unfiltered.md)
  covers the same unfiltered-trigger defect on the contact timeline. This one is
  its relay-thread twin; the cheap half of the fix is identical.

**Suggested fix.** Two independent steps, the first cheap:

1. Give `useRelayThread` the `onThreadEvent` filter `useGroupThread` already has.
   That alone removes the org-wide amplification.
2. Bound the merge: either apply the SSE delta instead of re-reading the page
   (the related issue above), or cap the held transcript, or keep an id set
   alongside the item array so a refetch that introduces nothing new can skip the
   re-sort entirely.
