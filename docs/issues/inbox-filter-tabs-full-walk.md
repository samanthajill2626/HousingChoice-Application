---
id: inbox-filter-tabs-full-walk
title: Inbox unread/unknown filter tabs hydrate every open conversation when matches are sparse
type: debt
severity: low
status: open
area: app
created: 2026-08-03
updated: 2026-08-16
refs: app/src/routes/inbox.ts, app/src/lib/unreadFeed.ts
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

**Update (2026-08-16) - HALF of this is fixed; the issue STAYS OPEN for the
other half.**

- **UNREAD: RESOLVED.** The inbox-unread-index feature
  (`docs/superpowers/specs/2026-08-16-inbox-unread-index-design.md`, branch
  `feat/inbox-unread-index`) took the escalation rather than the cheap
  pre-filter: `filter=unread` no longer walks `byLastActivity` at all. It reads
  the new sparse `byUnread` GSI, so the tab hydrates only rows that are actually
  unread. Same read model backs the nav badge and Today's unread sections.
- **UNKNOWN: STILL OPEN, unchanged.** `filter=unknown` still walks
  `byLastActivity` and still needs the contact to decide `needsTriage`, so it
  hydrates every open conversation when matches are sparse - exactly as
  described above. The unread work did not touch that path, and a triage flag
  or second sparse index remains the escalation if it ever matters. Still
  file-and-watch: this issue tracks the unknown tab from here on.
