---
id: older-page-can-remove-the-default-reply-target
title: A second conversation in the timeline locks the contact composer read-only
type: bug
severity: med
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/contact/replyTargets.ts:48, dashboard/src/routes/contact/replyTargets.ts:50, dashboard/src/routes/contact/ContactCommsPane.tsx:145, dashboard/src/routes/contact/useContactTimeline.ts:427
---

**Problem.** `buildReplyTargets` picks `defaultConversationId` from the contact's
phone map first. When that resolves nothing - none of the contact's own numbers
has a thread among the items currently held - it falls back to "if the timeline
contains exactly ONE conversation id, send into that" (`replyTargets.ts:50-57`).
The fallback is computed from whatever items happen to be loaded, so as soon as a
SECOND conversation id appears in that set, `ids.size === 1` stops holding and
`defaultConversationId` flips from a working id back to `null`.

**It does not merely lose a default target - it locks the composer.**
`ContactCommsPane.tsx:145` reads

```ts
const canSend = (sendConvId !== null || target !== undefined) && !deleted;
```

`target` is `defaultPhone(contactPhones(contact))`, which is `undefined` exactly
when the contact record carries no phone number at all - and that is precisely the
shape the fallback exists for (the numbers are on the conversation but were never
written onto the contact record). So for the contact this defect is about,
`sendConvId` going null takes `canSend` to false: Send greys out, and because the
merged item set never shrinks, a page reload is the only recovery.

The near-miss variant is quieter but still wrong. If the contact DOES have a
number on record that simply has no thread in the loaded page, `target` is
defined, so `canSend` stays true - but `sendConvId` is null, and `onSend`
(`ContactCommsPane.tsx:219-221`) then calls `ensureContactConversation`, which
sends into the primary number's 1:1 rather than the thread the operator is
looking at. Silently replying in a different thread.

The primary pick rule is NOT affected (it is last-wins over the phone map and was
checked independently). Only the no-phone-match fallback is.

**Pre-existing and already self-triggering; paging adds a second trigger.** The
contact timeline is a SERVER-MERGED feed across all of the contact's threads, not
one conversation. Before this branch, one inbound message on a second thread
already put a second `conversationId` into the newest page, and the very next
debounced SSE refetch flipped the same fallback to null with no operator action
whatsoever. History paging does not make this reachable - it adds an
operator-initiated way to reach it, on top of the ambient one that has always
been there. Filed against paging only because that is where it was found.

**Failure story.** A landlord contact was created from an inbound text, so their
number is on the conversation but never got written onto the contact record. The
navigator opens the contact, sees the transcript, and can reply - the fallback
resolved the single conversation. They click "Load older messages" to check what
was agreed last month; the older page carries a message from a second, older
conversation with the same person. Send greys out mid-draft with no explanation
on screen, and scrolling back does not restore it. The same navigator hits the
identical dead composer without touching the control if that second thread simply
receives an inbound while the page is open.

**Suggested fix.** Make the fallback stable against growth: remember the id it
resolved on the first page and keep using it unless it is no longer present at
all, or resolve the default from the NEWEST conversation in the timeline rather
than requiring uniqueness. Either way the composer must never lose a target it
already had while the item set is only growing. Whatever the pick rule, a
contact with a resolvable thread should not reach a state where `canSend` is
false with no on-screen reason.
