---
id: contact-timeline-sse-refetch-unfiltered
title: useContactTimeline refetches the whole person feed on ANY org-wide message event
type: improvement
severity: med
status: open
area: dashboard
created: 2026-08-04
refs: dashboard/src/routes/contact/useContactTimeline.ts:318, dashboard/src/routes/contact/ContactCommsTab.tsx:47, app/src/routes/contactTimeline.ts:765, app/src/routes/contactTimeline.ts:801, app/src/routes/contactTimeline.ts:227
---

**Problem.** `useContactTimeline` subscribes to three SSE kinds with NO filtering
by contact or conversation:

```ts
useEventStream({
  onMessagePersisted: scheduleRefetch,
  onConversationUpdated: scheduleRefetch,
  onScheduledUpdated: scheduleRefetch,
});                                    // useContactTimeline.ts:318-324
```

So ANY message persisted anywhere in the org - a broadcast fan-out, another
navigator's reply, an inbound to an unrelated tenant - debounce-refetches
`GET /api/contacts/:id/timeline` for whichever contact feed is mounted. The
events already carry a conversationId, so the filter is available and unused.

That route is not cheap. It costs one `messages.listByConversation` per
conversation the contact owns (contactTimeline.ts:765-770) and, for a LANDLORD,
`units.listByLandlord` plus one `audit.listByEntity` per owned unit, capped at
`MAX_LANDLORD_UNITS = 25` (contactTimeline.ts:227, :801-820) - so up to N+25
queries per unrelated org event.

Pre-existing behavior inherited from the contact page, and the contact-comms-pane
spec's Performance note accepted this profile ("SSE-debounced refetch keeps dots
live, unchanged"). What that branch changed is the BLAST RADIUS: the tour and
placement hubs' 1:1 tabs now mount the same hook (ContactCommsTab.tsx:47) where
they previously cost ONE `getConversationMessages`, and those hubs are the
operator's most-open pages. Adjudicated OUT of the fix wave rather than risk
live-update UX in a fix pass.

**Suggested fix.** Filter the refetch to events whose `conversationId` is one
this contact owns - the hook already knows the set from the items it holds, and
an unknown id can fall back to a refetch so a brand-new thread still appears.
`onScheduledUpdated` can filter the same way once the event carries enough
context. Cheaper mitigation if filtering proves fiddly: widen the debounce for
hub-mounted panes, or coalesce per contactId across mounts.
