---
id: inbox-restore-shows-row-read-after-mark-unread-jump
title: Marking a contact or thread unread jumps to an inbox that first shows that row as read, for one round trip
type: improvement
severity: low
status: open
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/contact/ContactDetail.tsx:399, dashboard/src/routes/conversation/ThreadUnreadToggle.tsx:189, dashboard/src/routes/inbox/useInbox.ts, dashboard/src/routes/inbox/inboxListStore.ts
---

**Problem.** After a successful mark-unread, the contact page
(`ContactDetail.tsx:399`) and the thread pages' unread toggle
(`ThreadUnreadToggle.tsx:189`) call `navigate('/inbox')` - a PUSH whose whole
purpose is to show the operator that row, now unread. Since
`feat/inbox-rows-timestamps` the Inbox remounts from its in-memory store
(spec `2026-09-25-inbox-rows-timestamps-design.md` 5.8): it paints the
snapshot saved when the operator OPENED that row, and opening a row marks it
read, so that snapshot folded the mark-read patch in (`useInbox.ts`,
`snapshotOf` in the unmount save). The row therefore renders READ until the
mount reconcile (a head read) lands and flips it back: one round trip.

This is the symmetric case of the staleness spec 5.8 accepts (a return after
the operator marked a row read shows the pre-mark count for one round trip),
but it lands on the one navigation meant to show that row unread. Found at
build review (AD-13); left out of that mission's scope by the Task 7b ruling
that nothing outside the Inbox page changes for navigation.
`e2e/tests/dashboard-next/inbox-mark-unread-header.spec.ts` stays green because
it waits for the row to flip.

**Suggested fix.** Have those two call sites correct the snapshot before they
navigate: patch the row's `unreadCount` in the stored list for the key the
Inbox will mount (`/inbox` is the All tab at the default limit), through a
small `inboxListStore` helper, or drop that key's snapshot so the Inbox loads
fresh. Either keeps the instant restore everywhere else.
