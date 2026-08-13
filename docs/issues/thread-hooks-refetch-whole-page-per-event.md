---
id: thread-hooks-refetch-whole-page-per-event
title: Thread hooks re-read the entire open page on every SSE event instead of applying the delta
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/conversation/useRelayThread.ts:196, dashboard/src/routes/conversation/useRelayThread.ts:238, dashboard/src/routes/conversation/useGroupThread.ts:128, dashboard/src/routes/conversation/useGroupThread.ts:188, dashboard/src/routes/contact/useContactTimeline.ts:141, dashboard/src/routes/contact/useContactTimeline.ts:318, dashboard/src/routes/placements/usePlacements.ts:244
---

**Problem.** Every conversation-shaped hook answers an SSE event by re-fetching
the whole page it already has, then replacing its state wholesale. One new
inbound text costs a full re-read of up to 50 messages the client is already
holding, and the 49 unchanged rows are re-serialized, re-shipped, and
re-rendered to deliver one new bubble.

The pattern is identical in all three hooks:

```ts
const fetchNow = useCallback(async () => {
  const messages = await getConversationMessages(conversationId, opts, signal);
  setServerItems((prev) => mergeTimelineItems(prev, buildRelayItems(messages)));
}, [conversationId]);                             // whole page still re-READ
// ...
useEventStream({ onMessagePersisted: scheduleRefetch, ... });
```

- `useRelayThread` (useRelayThread.ts:196) additionally re-fetches the scheduled
  bucket on the same trigger, so each event is two round-trips.
- `useGroupThread` (useGroupThread.ts:128) is the same shape, one round-trip.
- `useContactTimeline` (useContactTimeline.ts:141) is the most expensive: its
  route fans out to one `messages.listByConversation` per conversation the
  contact owns, plus - for a landlord - `units.listByLandlord` and one
  `audit.listByEntity` per owned unit (capped at 25).

The events already carry the payload needed to do better. `usePlacements.ts:244`
is the in-repo counter-example: it wires `onPlacementUpdated` to an `applyEvent`
reducer that patches the row in place instead of refetching the list.

Cost scales with the surfaces mounted, not with the change: the tour and
placement hubs mount `useRelayThread` and `ContactCommsTab` at once, so a single
inbound message can trigger several full-page re-reads across one operator's
screen. The 300ms debounce coalesces bursts but does not reduce the per-refetch
payload.

UPDATE 2026-08-13 (feat/thread-history-paging): the wholesale REPLACE is gone.
Every fetch now merges by id through `dashboard/src/routes/shared/threadPaging.ts`,
so a refetch can no longer discard older pages the operator has loaded. What
remains - and what this issue is still about - is that each event re-READS the
whole page to deliver one bubble. The merge was written so a delta-applying hook
can replace the refetch without reworking the paging: keep the same single state
slice, just feed it a one-item delta instead of a 50-item page.

Related but distinct: [`contact-timeline-sse-refetch-unfiltered`](contact-timeline-sse-refetch-unfiltered.md)
covers WHICH events trigger a refetch (any org-wide message event refetches every
mounted contact feed). This issue is about HOW MUCH each refetch re-reads once it
is correctly triggered. Fixing both compounds: filter the trigger, then shrink
the work each surviving trigger does.

**Suggested fix.** Apply the event instead of re-reading the page, following the
`usePlacements` reducer precedent: on `message.persisted` for this conversation,
append/patch the single message the event describes. Keep a full refetch as the
fallback for events that cannot be applied cleanly (unknown id, a gap in
sequence, or the thread not yet loaded) so no state can silently drift.

If the event payload proves too thin to build a bubble from, the cheaper interim
is a bounded incremental read: refetch with a small `limit` (or an `after`
bound - not currently supported by
`GET /api/conversations/:id/messages`, which only pages backwards via `before`)
and merge by id - `mergeTimelineItems` already exists and is already wired into
all three hooks, so only the READ size would need to change. Adding an `after`
bound to that route would make the incremental read exact.
