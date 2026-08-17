---
id: seen-set-max-equals-max-inbox-limit
title: SEEN_SET_MAX equals MAX_INBOX_LIMIT, so the unread paging affordance disappears at limit=100
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/routes/inbox.ts
---

**Problem.** Filed from the spec-conformance review of
`feat/inbox-unread-index` (finding 6).

`MAX_INBOX_LIMIT = 100` and `SEEN_SET_MAX = 100` are the same number. The unread
cursor carries the seen-set of contact ids emitted so far, and the server refuses
to mint a cursor whose seen-set exceeds `SEEN_SET_MAX` (the decoder rejects one
too, so the two bounds are deliberately matched). A client requesting
`?filter=unread&limit=100` against an unread-heavy dataset therefore gets page 1,
and page 2 is impossible the moment 101 contacts have been consumed: the response
comes back `truncated: true` with no cursor.

Nothing ships broken. The spec sized the depth cap for the dashboard's limit of
30 ("~4 pages"), and the dashboard never asks for 100. But the two constants
being equal means the paging affordance silently disappears at exactly the
maximum limit the route advertises, and neither constant's comment mentions the
other.

Note the fix wave narrowed the blast radius: the depth cap no longer fires on a
page that also exhausted the supply, so `limit=100` over a <=100-contact unread
feed is a clean natural end. The interaction above still holds past 100 - and
the narrowing is not complete, because a page that FILLS at the same moment the
supply runs out still misses the natural-end arm:
[`unread-load-more-empty-on-exact-multiple`](./unread-load-more-empty-on-exact-multiple.md).

**Suggested fix.** Cheapest: a comment at each constant naming the interaction.
Better: raise `SEEN_SET_MAX` above `MAX_INBOX_LIMIT` (the cursor is base64url
JSON, so the size cost is bounded and measurable), or clamp `filter=unread` to a
limit strictly below the depth cap so at least one more page is always
reachable.
