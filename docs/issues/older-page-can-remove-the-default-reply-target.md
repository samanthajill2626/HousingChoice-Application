---
id: older-page-can-remove-the-default-reply-target
title: A merged older page can take the composer's default reply target away
type: bug
severity: low
status: open
area: dashboard
created: 2026-08-13
refs: dashboard/src/routes/contact/replyTargets.ts:48, dashboard/src/routes/contact/replyTargets.ts:50, dashboard/src/routes/contact/useContactTimeline.ts:427
---

**Problem.** `buildReplyTargets` picks `defaultConversationId` from the contact's
phone map first. When that resolves nothing - the thread's numbers are not on the
contact record - it falls back to "if the timeline contains exactly ONE
conversation id, send into that" (`replyTargets.ts:50-57`). The fallback is
computed from the timeline items currently held, and history paging now grows
that set on demand: clicking "Load older messages" can introduce a SECOND
conversation id for the same contact, `ids.size === 1` stops holding, and
`defaultConversationId` flips from a working id back to `null`.

The primary pick rule is NOT affected (it is last-wins over the phone map and was
checked independently). Only the no-phone-match fallback is, and only for a
contact whose numbers are absent from the contact record AND who has more than
one thread. That shape is narrow but it is exactly the shape the fallback exists
for.

**Failure story.** A landlord contact was created from an inbound text, so their
number is on the conversation but never got written onto the contact record. The
navigator opens the contact, sees the transcript, and can reply - the fallback
resolved the single conversation. They click "Load older messages" to check what
was agreed last month; the older page carries a message from a second, older
conversation with the same person. The composer's implicit target disappears and
the reply they were mid-way through composing can no longer be sent, with no
explanation on screen. Scrolling back is not a fix: the merged item set never
shrinks, so the only recovery is a page reload.

Pre-existing in shape - the fallback has always been a function of what happened
to be loaded - but newly REACHABLE, because before paging the held item set could
not grow by operator action.

**Suggested fix.** Make the fallback stable against growth: remember the id it
resolved on the first page and keep using it unless it is no longer present at
all, or resolve the default from the NEWEST conversation in the timeline rather
than requiring uniqueness. Either way the composer should never lose a target it
already had while the operator is only reading further back.
