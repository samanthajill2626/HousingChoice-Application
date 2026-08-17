---
id: unread-deleted-contact-probed-twice-per-page
title: A resurface-eligible deleted contact costs two message probes per unread page request
type: debt
severity: low
status: open
area: app/inbox
created: 2026-08-16
refs: app/src/lib/unreadFeed.ts, app/src/routes/inbox.ts
---

**Problem.** Filed from the spec-conformance review of
`feat/inbox-unread-index` (finding 4 - spec-conformant, so a follow-up rather
than a defect in the shipped work).

Layer 2 (`collectUnreadRows`) probes `messages.listByConversation(convId,
{limit: 1})` to decide whether a deleted contact's thread resurfaces, and then
DISCARDS the result. `buildContactRow`'s own resurfacing loop probes again
through `latestMessageOf`. Spec 4.5 says presentation "reuses maxConv's latest
message as today" - inside `buildContactRow` it does, but the collector's probe
is not threaded into hydration.

Cost: two message reads per resurface-eligible deleted contact per page request
instead of one. The two probes can also DISAGREE, because they are differently
scoped - the collector probes the thread the INDEX yielded, hydration probes the
contact's participant-GSI threads (see also adversarial finding 5, the badge /
page hydration-disagreement note). A disagreement is a drop-and-refill, not a
correctness bug: the row simply does not render and the fill loop replaces it.

**Suggested fix.** Thread the collector's probe result through the candidate into
hydration so `buildContactRow` reuses it instead of re-reading. Worth doing with
[`unread-fill-loop-query-amplification`](./unread-fill-loop-query-amplification.md),
since both are read-amplification on the same path.
