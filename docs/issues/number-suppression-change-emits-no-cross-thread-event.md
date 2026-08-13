---
id: number-suppression-change-emits-no-cross-thread-event
title: A number's suppression change emits no event on the other threads that number is in
type: bug
severity: med
status: open
area: app
created: 2026-08-12
refs: dashboard/src/routes/conversation/GroupTextView.tsx, app/src/services/numberSuppression.ts
---

**Problem.** Suppression is scoped to a NUMBER, but the events that announce a
change to it are scoped to a CONVERSATION. When a member texts STOP to their own
1:1 thread, the keyword path records the opt-out against that 1:1 conversation
row and emits `message.persisted` / `conversation.updated` for that conversation
only. Every OTHER thread the same handset appears in - a native group text, a
relay group - learns nothing.

On the group-text thread this is visible and it is acted on: the member panel
and the header both read the number-scoped seam, so until something else happens
on that thread they keep showing the member as reachable and keep saying nobody
has opted out. That is the screen staff use to decide whether to text a group.
The reverse case is fine - a STOP sent INTO the group is filed on the group
thread and does tick it.

Fix wave 4 (item 3) BOUNDED this rather than closing it: `GroupTextView` now
re-reads its member panel on window focus and on a slow interval
(`MEMBERS_REFRESH_MS`), so the panel is at most that stale and returning to the
tab is always fresh. The polling is a mitigation, not the fix, and it costs N
contact reads per tick per open thread.

**Suggested fix.** Emit a number-scoped suppression event and fan it out to
every conversation that number participates in, so the existing per-thread SSE
subscribers refetch for the right reason. That needs a way to enumerate a
number's threads cheaply (the byParticipantPhone GSI covers 1:1; group and relay
rosters do not have an equivalent index today), so it is a server design with its
own shape rather than a patch. Once it lands, the poll in `GroupTextView` can go.
