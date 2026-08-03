---
id: inbox-filter-tabs-full-walk
title: Inbox unread/unknown filter tabs hydrate every open conversation when matches are sparse
type: debt
severity: low
status: open
area: app
created: 2026-08-03
refs: app/src/routes/inbox.ts:346, app/src/routes/inbox.ts:522
---

**Problem.** The inbox pager walks the byLastActivity GSI in chunks and applies
`passesFilter` AFTER fully hydrating each row (contact lookup, the contact's
conversations, latest message, placement label - about 4-6 DynamoDB calls per
conversation). The default "all" view is fine: it stops after one page (~25 rows)
regardless of total history. But the `unread` and `unknown` filter tabs keep
walking until the page fills or the stream is exhausted - with 1,000 open
conversations and only 3 unread, the Unread tab hydrates nearly all 1,000
(roughly 4-6k queries, multiple seconds). Not a problem at current scale;
becomes a UX issue as open-conversation count grows into the hundreds.

**Suggested fix.** Cheap first step: for `filter=unread`, skip hydration when the
raw conversation's `unread_count` is 0/absent (the counter already lives on the
conversation item, so the pre-filter costs nothing). The `unknown` filter needs
the contact to decide `needsTriage`, so it cannot pre-filter the same way; if it
ever matters, a sparse GSI (or denormalized triage flag on the conversation) is
the escalation. No urgency - file-and-watch.
