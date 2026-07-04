---
id: relay-group-view-stale-open-composer
title: Relay group view composer stays enabled if another operator closes the group (header not live-refreshed)
type: bug
severity: low
status: open
area: dashboard
created: 2026-07-04
refs: dashboard/src/routes/conversation/ConversationDetail.tsx, dashboard/src/routes/conversation/useRelayThread.ts
---

**Problem.** `ConversationDetail` fetches the conversation header once and only updates
`status` locally on *this* client's own close/reopen. `useRelayThread`'s SSE
subscription (`onConversationUpdated`) refetches **messages**, not the header. So if
**another** operator closes the group while you're viewing it, your composer stays
enabled until you reload. It degrades gracefully — a send then fails server-side with
`409 relay_closed`, rendered as "This relay group is closed — reopen it to send." — so
there is no data corruption and no send leaks through; it's a stale-open UI window, not
a correctness bug.

**Suggested fix.** Have the group view also refetch (or patch) the header on the
`conversation.updated` SSE event for its own id, mirroring how it already refetches
messages — so `status` (and pool number on reopen) reflect live. Surfaced by the
adversarial review of feat/relay-group-view (2026-07-04).
