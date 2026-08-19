---
id: relay-duplicate-detection-scan-cost
title: Duplicate detection walks both live relay partitions to exhaustion on every preview
type: debt
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/services/relayGroupDuplicates.ts:109, app/src/repos/conversationsRepo.ts:415
---

**Problem.** `findOpenGroupWithSamePhones` answers "is there a live group with
exactly these members" by querying the sparse `byRelayStatus` GSI for the OPEN
partition and then the CONNECTING one, and comparing rosters in code. There is
no index for "group by exact participant set", so proving ABSENCE means walking
both partitions to exhaustion.

The page budget is 100 items x 20 pages per partition
(`RELAY_LIST_PAGE_LIMIT` / `RELAY_LIST_MAX_PAGES`, `conversationsRepo.ts:415`),
so the ceiling is up to 40 Queries and 4,000 items per preview - and the
NO-DUPLICATE case, which is the common one, ALWAYS pays the maximum, because a
full walk is exactly what proves there is nothing there.

This is accepted for now: opening a relay group is a rare, human-initiated
action on relays-only partitions that are sparse today, and the cost is paid
once per preview on a screen the operator is already waiting on. It is recorded
because it is not "one bounded query", and because it is measurable today rather
than hypothetically: `app/src/lib/seed/performance.ts` builds up to 1,000 relay
groups, and the performance workload already drives both affected preview
endpoints against that seed.

**Suggested fix.** If it becomes hot, add an index on a participant-set hash - a
sorted, joined digest of the roster phones, written on group create and on every
roster mutation, queried directly instead of scanned. That is schema work (a new
persisted attribute plus a GSI plus a backfill) and was deliberately excluded
from the warning feature, which adds no table, no index and no stored field.

Two cheaper mitigations worth considering first: cap the walk at a page budget
lower than the repo default for this caller specifically (detection already
degrades to silence on an incomplete scan, so a short walk is a legal answer),
or skip detection entirely for rosters above a size that never duplicates in
practice.
