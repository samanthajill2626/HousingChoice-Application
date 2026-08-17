---
id: inbox-unread-sse-full-walk
title: Unread badge refetch walks every open conversation after each conversation event
type: bug
severity: high
status: resolved
area: app/inbox
created: 2026-08-14
resolved: 2026-08-16
refs: dashboard/src/app/UnreadContext.tsx, app/src/routes/inbox.ts, app/src/repos/conversationsRepo.ts, app/src/lib/tables.ts
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

**Resolution (2026-08-16).** Fixed by the inbox-unread-index feature
(`docs/superpowers/specs/2026-08-16-inbox-unread-index-design.md`, branch
`feat/inbox-unread-index`). The badge no longer reads the inbox page at all: a
sparse `byUnread` GSI on `conversations` (hash `unread_flag`, present only while
`unread_count > 0`) makes the walk proportional to actual unread rows, and the
provider fetches the dedicated `GET /api/inbox/unread-count` instead of
`GET /api/inbox?filter=unread&limit=100`. Contact deduplication, deleted-contact
resurfacing, relay rows and native-group unread all survive - the row collector
is shared with `filter=unread`, so the badge and the tab cannot disagree. The
client also decrements optimistically on mark-read, so an operator no longer
waits a server round trip to see the badge move
(`e2e/tests/dashboard-next/inbox-nav-badge.spec.ts` covers both). One-time ops
(GSI apply + `backfill-unread-flag.ts`) are recorded in `RUNBOOK.md`.
