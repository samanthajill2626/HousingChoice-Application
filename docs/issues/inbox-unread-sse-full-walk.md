---
id: inbox-unread-sse-full-walk
title: Unread badge refetch walks every open conversation after each conversation event
type: bug
severity: high
status: open
area: app/inbox
created: 2026-08-14
refs: dashboard/src/app/UnreadContext.tsx:27, dashboard/src/app/UnreadContext.tsx:119, app/src/routes/inbox.ts:348
---

**Problem.** `UnreadProvider` fetches `GET /api/inbox?filter=unread&limit=100`
once per SPA boot and again after every debounced `conversation.updated` event.
The server currently walks the open-conversation partition to prove that read
conversations do not qualify. Against the imported local dataset, the pre-fix
badge request made 1,840 serial repository calls and had a five-repeat median of
20,161 ms. After the early-rejection fix, the same five-repeat workload still made
1,230 calls with a 1,771 ms median. The remaining contact and
contact-conversation lookups are still O(open conversations). This makes inbound
traffic multiply expensive work by the number of connected dashboards.

The displayed badge caps at `99+`, but the server response is not strictly capped
at 100 rows: the 100-contact limit is followed by additive relay and native-group
rows. Any replacement must preserve contact deduplication, deleted-contact
resurfacing, relay rows, and native-group unread.

**Suggested fix.** Write a separate design for a sparse unread index or equivalent
read model so Unread work is proportional to actual unread conversations rather
than all open conversations. The design must cover every unread zero-crossing
writer, existing-row backfill, GSI eventual consistency after SSE refetches,
multi-thread contact ordering and pagination, and the additive group/relay
semantics. Do not treat a page response limited to 30 contacts as the badge count.
