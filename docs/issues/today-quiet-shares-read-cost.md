---
id: today-quiet-shares-read-cost
title: Every Today load re-runs the Follow up core for Quiet shares - a properties walk, two Queries per property and a consistent contacts BatchGet - with no cache
type: improvement
severity: low
status: open
area: app/today
created: 2026-10-24
refs: app/src/routes/today.ts, app/src/services/followUps.ts, app/src/services/quietShares.ts, app/src/repos/toursRepo.ts, app/src/repos/listingSendsRepo.ts, app/src/lib/unreadFeed.ts, dashboard/src/routes/today/useToday.ts, dashboard/src/routes/today/useTodayPastTours.ts
---

**Problem.** Today's Quiet shares section (tracker #31, spec
`docs/superpowers/specs/2026-10-23-today-checklist-design.md` 6.1 and 6.5)
computes its rows on every GET /api/today by running the Follow up core,
`collectWaitingFollowUps` (`app/src/services/followUps.ts`): the
available-properties walk (capped at 100 properties), two Queries per
property that has recent sends (10-way concurrency), and one contacts
BatchGet - read CONSISTENTLY on Today's call (`consistentRead: true`, so a
refetch triggered by a stamp's event sees the stamp), which costs twice the
read units of the Follow up tab's eventually consistent read. Today refetches
on every placement, conversation, suggestion, tour and contact event,
debounced 300 ms (`dashboard/src/routes/today/useToday.ts`), and each staff
send now emits one more event (spec 7.3), so a busy hour with Today open in
several tabs multiplies these reads. No cache was added (spec 6.5).

Two details of those per-property reads: the listing-sends Query
(`listingSends.listByUnit`, `app/src/repos/listingSendsRepo.ts`) is paged to
exhaustion and reads EVERY listed send the property ever had - the 14-day
lookback is applied after the read - so it grows with a property's share
history; the tours byUnit Query runs only for a property with a send inside
the lookback.

Tours to book (spec 5.4) adds one more read per load: `tours.listByStatus('requested')`
over the byStatus GSI (`app/src/repos/toursRepo.ts`) pages the WHOLE
requested partition, uncapped by design - no age limit, no cap, no WARN, no
row dropped (worklist WL-11; the `app/src/routes/today.ts` header says so).
The `requested` status is never auto-closed, so the partition grows with
every undecided request (prod 13 at design time).

Measured in the test harness by the build (S4 report, watch item WI7,
`docs/superpowers/reviews/2026-10-23-feat-today-checklist/slices/S4-report.md`;
the committed read-count case in `app/test/todayApi.test.ts`): one Today
load over three available properties, two of them with a share in the last
14 days, and one requested and one today tour on the same property, made
`{ deadlinesDue: 1, placementsByStage: <non-terminal stages>,
toursByRange: 1, relayOptOut: 1, unreadPages: 1, triagePages: 1,
aiPending: 1, relayGroups: 1, toursRequested: 1, unitLabels: 1,
unitsWalk: 1, sendsByUnit: 3, toursByUnit: 2, recipientBatch: 1 }`. Per
load that is: 1 units byStatus page per 100 available properties; 1
listing-sends Query per available property; 1 tours byUnit Query per
property with a share in the last 14 days; 1 contacts BatchGet (DynamoDB
pages it per 100 keys); 1 requested-tours Query, paged to completion; and 1
unit GetItem per distinct tour property (memoized per request). Prod holds
tens of available properties (spec 6.5), so a load is tens of small
Queries.

The unread walk grew too (plan PR92): Today's unread pass now keeps only
`unknown_1to1` threads (spec 4), so it no longer stops at its 100-row cap
and reads the byUnread index up to its raw budget (`UNREAD_WALK_LIMIT`,
2000 items, `app/src/lib/unreadFeed.ts`) on every load and every refetch;
the "underfilled" WARN (`today_unread_walk_truncated`, at most one per 5
minutes) fires whenever the index holds more than that budget. Measured:
the WI7 load read 1 unread page (`unreadPages: 1`, pages of 100), and the
S4 byUnread budget case (a walk budget of 2 over five unknown threads)
read 1 page.

Past tours needing an outcome (spec 5.3) adds client-side reads (code
review R1A-3, fix wave 1). The section labels EVERY Past row - spec 5.3
requires it, so "Show all N" counts only the rows Today qualifies (deleted
tenants excluded) - and so each Today mount point-reads every listed tenant
(`GET /api/contacts/:id`) and every listed property (`GET /api/units/:id`),
all in flight at once (`dashboard/src/routes/today/useTodayPastTours.ts`).
Every `tour.updated` then re-reads every listed tenant, for their delete
state (properties stay memoized for the page's lifetime; tenants
deliberately do not), debounced 300 ms. Every tour create now emits
`tour.updated` (spec 8) - including a requested tour, which can never be a
Past row - so each Interested click and each tour create re-reads the whole
tenant list in every open Today tab. The Past window is 90 days
(`PAST_TAB_DAYS`, `dashboard/src/routes/tours/useTours.ts`) of undecided
tours, so the cost grows with exactly the backlog the section exists to
show. Scale: prod held about 23 Past rows at design time (spec 5.3) - about
23 tenant plus 23 property reads per mount and about 23 tenant reads per
tour event; the review's probe measured a 60-row Past list at 60 + 60 reads
per load and 60 per `tour.updated`. Spec 5.3 accepts this cost. If it
grows: skip the reload for a `tour.updated` whose tour is not on screen and
is `requested` (it cannot enter Past), or have the server return the Past
rows already named and filtered for deleted tenants (the Today route
already memoizes contact reads). Labeling only the shown rows is not an
option: "Show all N" would then count rows Today does not qualify.

Not a cost, but the same reads (plan PR90, WI8, worklist WL-12): Tours to
book reads the tours byStatus GSI, and Quiet shares reads the units byStatus
and tours byUnit GSIs. A GSI cannot be read consistently, so the single
refetch after a tour create can miss a not-yet-propagated index entry - a
new request not yet in Tours to book, or an Interested person still in
Quiet shares - until the next event or a reload: the same residue Today
carries for `conversation.updated` over the byUnread GSI. Listing sends is
a base-table Query read WITHOUT ConsistentRead, so the Not interested
drop-off (no event; the remount refetch) can read the pre-decline row once
- same residue class. No mechanism was added. DynamoDB Local is always
consistent, so no e2e run is proof of prod liveness here. A cache (below)
must not widen this window.

**Suggested fix.** Only if load grows (Today p95, or consumed read units on
the units, listing_sends and contacts tables): a short-lived per-process
cache of the core's rows (tens of seconds), dropped on share, outcome, tour
and contact events, so a burst of refetches reads once. Today's consistent
contacts read must stay behind it (or the cache must be keyed past a stamp)
so a staff send still drops the person on the next refetch. Measure first
with `npm run perf:pages` on the hermetic target; the `-- hosted-dev` target
is human-invoked only.
