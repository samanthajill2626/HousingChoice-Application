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

**How OFTEN that ceiling is paid, which is the other half of the number.** Once
per operator CLICK on a create-or-preview action - never on a page load. All
three call sites are action handlers: the tour hub's [Open relay group]
(`TourDetail.tsx:346-351`), the placement hub's
(`PlacementDetail.tsx:306-311`), and the contact file's create-relay-group modal
(`CreateRelayGroupModal.tsx:295-330`, which previews on the operator's own
press). Nothing fetches a preview on mount, on render, on an SSE event, or on a
poll, so the scan cannot be driven by traffic - only by a human deciding to open
a group. That materially lowers the urgency: the worst case is 40 Queries on a
screen the operator is already waiting on, at human click rate, not 40 Queries
multiplied by page views. It also means the mitigation lever is the WALK, not a
cache - there is no repeat-read pattern to cache against.

This is accepted for now: opening a relay group is a rare, human-initiated
action on relays-only partitions that are sparse today, and the cost is paid
once per preview on a screen the operator is already waiting on. It is recorded
because it is not "one bounded query", and because it is measurable today rather
than hypothetically: `app/src/lib/seed/performance.ts` builds up to 1,000 relay
groups, and the performance workload already drives both affected preview
endpoints against that seed.

**Past the ceiling the failure is not only a MISS - it can be a WORSE ANSWER.**
Recorded because it is not obvious and a reviewer had to argue it. The OPEN
partition is scanned first. If that walk hits the page budget without matching
and the CONNECTING walk then matches, the operator is shown the connecting
group - "already have a relay group being connected", link and all - while an
OPEN group with the same roster may have been sitting past the truncation point
unseen. The tie-break exists precisely to stop a fresh connecting shell
outranking a live thread, and an incomplete OPEN walk defeats it by accident.

The warning is still true (that connecting group really is a duplicate) and
nothing is gated on it, which is why this is not a defect in the detector -
returning a match found rather than discarding it is the specified behavior. But
it does mean the honest description of the ceiling is "past 2,000 groups per
partition the warning degrades in quality, not just in coverage", and it is one
more reason the walk is the right lever to fix rather than the copy.

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
