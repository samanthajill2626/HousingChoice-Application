---
id: backfill-unread-flag-pointer-prefix-copy
title: backfill-unread-flag keeps its own copy of the conversations-table pointer prefixes
type: debt
severity: low
status: open
area: app/scripts
created: 2026-09-25
refs: app/scripts/backfill-unread-flag.ts:60, app/src/lib/unreadFeed.ts:108
---

**Problem.** `app/scripts/backfill-unread-flag.ts:60` declares its own
`POINTER_PREFIXES = ['phone#', 'email#', 'token#']` to recognize the pointer
partitions (phone/email claims, reply tokens) in the conversations table. The
authoritative list is `POINTER_PARTITION_PREFIXES` in `app/src/lib/unreadFeed.ts`,
which share-skip-fix exported (2026-09-25) so its census could import it. A
future pointer shape added to one list and not the other would let the backfill
treat a pointer item as a conversation.

**Suggested fix.** Import `POINTER_PARTITION_PREFIXES` from
`../src/lib/unreadFeed.js` and delete the local copy (the way
`app/scripts/conversation-automation-census.ts` does).
