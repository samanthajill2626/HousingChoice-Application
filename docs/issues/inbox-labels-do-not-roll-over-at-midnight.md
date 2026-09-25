---
id: inbox-labels-do-not-roll-over-at-midnight
title: An inbox row's time label rolls from "2:14 PM" to "Yesterday" only on the next re-render
type: debt
severity: low
status: open
area: dashboard/inbox
created: 2026-09-25
refs: dashboard/src/routes/inbox/InboxRow.tsx, dashboard/src/routes/inbox/inboxTime.ts
---

**Problem.** `InboxRow` computes its label at render time from `new Date()`.
A page left open across local midnight keeps showing a clock time for rows
that are now "Yesterday" until anything re-renders the list (a live update,
a navigation). The contact timeline's day dividers accept the same thing.
Accepted in the spec (section 4.2) rather than adding a periodic re-render.

**Suggested fix.** If it ever matters: one interval in `Inbox.tsx` that bumps
a `now` state at the next local midnight and every midnight after, passed to
`InboxRow` as a prop.
