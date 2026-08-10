---
id: abandoned-journal-pii-until-next-contact-read
title: An abandoned resolution journal keeps its PII snapshot until that contact's suggestions are read again
type: decision
severity: low
status: open
area: app/suggestion-resolution
created: 2026-08-09
refs: app/src/services/suggestionResolution.ts:469, app/src/routes/suggestions.ts:101, app/src/lib/tables.ts:522
---

**Problem.** An ACTIVE `resolve#<contactId>#<target>` journal holds the whole
`SuggestionItem` snapshot (the suggested phone number, address or free-text
value) plus the replay plan's patch and audit payload. Completion scrubs all of
it - `makeCompletedResolution` keeps only ids, action and a completion time - but
only completion scrubs it.

Recovery is deliberately LAZY. The only driver is a read of that same contact's
suggestions (`routes/suggestions.ts:101` -> `recoverAbandoned`) or a later
resolution request for the same target. So a journal abandoned by a crash on a
contact nobody opens again - a soft-deleted contact, an inactive tenant, a
duplicate created by import - retains its snapshot indefinitely. The
`ai_extraction` table declares no `ttlAttribute` (`lib/tables.ts:522-560`), by
design.

**Decision (accepted residual).** This is accepted, not overlooked. The worklist
constraints for this branch forbid a TTL on `ai_extraction` and forbid new
infrastructure (no sweeper job, no scheduled scan, no new table or index), and
the operator-visible half of the problem - a crashed action that no card can
resume - is fully fixed by the lazy hook. The remaining exposure is a small
number of rows in an internal table that no API, GSI or pending list can return
(`resolve#` rows carry neither `ownerContactId` nor `_pendingPartition`).

**Revisit if** a periodic sweep is ever sanctioned: the worker already has a poll
loop and could complete expired journals for every contact, or a TTL could be
added to `ai_extraction` if the table's other row kinds (`sugg#`, `dism#`,
`due#`) can tolerate one - the permanent dismissal tombstones in particular must
NOT expire, so a table-wide TTL is not a drop-in.
