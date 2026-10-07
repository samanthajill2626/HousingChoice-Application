# Planner review - plan-blind adversarial pass - feat/tour-list @ 1b896aa4

Scope: `git diff a5eabcb3...HEAD -- . ":(exclude)docs/superpowers"` (71 files),
plus every consumer and mutator of the state it touches elsewhere in the repo.
Plan-blind: nothing under `docs/superpowers/` or `.superpowers/` was read.
Read-only: no suite, server, lane, build or install was run; every claim below
was checked against the code at the cited lines.

Verdict: no BLOCKING, HIGH or MEDIUM finding. Five LOW (one PLAUSIBLE).
Top two: F1 (the All tab's "every tour" rests on an unenforced stamp - a
read-side complement closes it at zero cost) and F2 (every render re-derives
every loaded row, per keystroke, up to ~5,050 rows).

## Checked and sound

1. Index writers. The repo's create stamps `_schedPartition` on every tour
   (`app/src/repos/toursRepo.ts:376`, since 1acb89a4). PATCH, reopen,
   auto-close, the claim/roster/pointer writes never REMOVE it or
   `scheduledAt` (PATCH cannot null a date: `isValidIso(null)` is false,
   `app/src/routes/tours.ts:1173`); PATCH cannot reach `requested`
   (`tours.ts:1219-1223`); `scheduled` always has a date (`tours.ts:1256-1264`).
   No dev seam or import writes the tours table (`tourRemindersRepo.ts:268` is
   a ConditionCheck only); deployed envs are never seeded (`RUNBOOK.md:872`).
   Every seed profile now stamps the partition and is pinned
   (`app/test/seedTourPartition.test.ts`, `app/test/seedLive.test.ts:510`).
2. GSI projection is ALL (`app/src/lib/tables.ts:14`), so the U-phase
   FilterExpressions see `scheduledAt` / `tourType`, and every row carries
   the fields `toTourListRow` reads.
3. Phase plan: D and U are disjoint (U filters dated rows; `requested` is never
   dated), and under the stamp invariant total for the five U_ORDER statuses.
4. Query construction (`toursRepo.ts:832-897`): every ExpressionAttributeName
   and Value is used in some expression (no "unused" ValidationException),
   reserved words are aliased, the `IN` list is never empty (D exists only
   when `dated.length > 0`), ExclusiveStartKey = index keys + table PK, all S.
5. Paging engine (`app/src/services/tourListPage.ts`): Limit-before-filter,
   LEK-at-Limit, the peek row, the overflow cursor after the last SENT row,
   the k-less cursor only ever for a U phase, the budget exit, and no phantom
   page after the last phase (`:120`). Traced the fill-exactly-at-batch-end,
   1 MB short page and exhausted-phase-when-full cases.
6. Cursor: shape, size (1,024 B) and well-formedness (lone surrogate) checks
   before any Query; fingerprint binding; `locate` partition/status checks;
   only the FIRST Query's ValidationException maps to 400. Tampering moves
   only the caller's own view (no authorization boundary inside the data), so
   an unsigned cursor is fine.
7. Bounds: a zone is required, no calendar rollover, years 0000-9999 only, so
   canonical-string order equals time order; the dashboard's local-day
   conversion (`tourListSelection.ts:88-103`) is DST-safe and clamps 9999;
   years 0000-0099 are refused client-side by `ymdParts`.
8. Route: registered before `/:tourId`; Express 5.2 forwards async throws to
   the error handler; the request logger logs `req.path` only, so the cursor
   and filters are never logged (`app/src/middleware/requestLogger.ts:37,61`);
   the info line carries counts; every 400 body is a static string.
9. Cost per request is bounded: at most 6 Queries (200 evaluated, or
   limit+1 when unfiltered) and 2 BatchGets of at most 100 keys with at most 3
   retries. Client loops are bounded: follow 10, walk 50 per session, restore 10.
10. `useAllTours`: one loader at a time, abort on mode or list change, stale
    guards (`forKey` and `cursor`), render-phase setState patterns idempotent
    under StrictMode, restart-once then dead.
11. URL / history: stamped REPLACE writes, POP adoption, the pending-navigation
    guard, the restore record bound to its list; TourDetail's `/tours/all?`
    prefix check cannot leave the SPA (`TourDetail.tsx:128-133`).
12. ToursPage split: TourListsView keeps one element at one position for
    Active/Past/Closed, so the perf ledger's passive-navigation assumption
    (`e2e/performance/routes.ts:760-762`) still holds; the module-level Past
    batch store (`ToursPage.tsx:324-351`) is unaffected; `/tours/all` is in the
    route-registry exclusion. Only App.tsx and tests import ToursPage.
13. Wording: no "Not booked" remains in app, dashboard or e2e; the replaced e2e
    assertions keep their cardinality ("Needs booking" replaces it 1:1 for
    requested rows only).
14. Today: dropping the `tours_today` cap WARN is right (`warnIfCapped` and
    `GROUP_FETCH_LIMIT` are still used elsewhere); the new test filters on the
    real message text ("hit the cap", `today.ts:414`), so it can fail.
15. Infra and deploy: no table or GSI change; CloudFront `/api` is
    CachingDisabled; no WAF; the API serves the dashboard, so the two deploy
    together. Added lines are ASCII-only.

## Already filed - seen, not re-raised

`tours-date-range-reads-unbounded-span`, `harness-date-range-fake-ignores-sched-partition`,
`tours-all-server-side-search`, `tours-tabs-load-every-contact-for-names`,
`tours-closed-tab-loads-every-tour`, `tour-no-show-without-date`,
`tours-all-live-updates`, `tour-list-restore-anchor-trackpad-swipe`,
`error-handler-logs-router-relative-path`.

One severity note on the first: the unbounded walk is this branch's change,
and at scale its risk is availability, not only cost - one request can
materialize up to ~100 MB of items in the API process and serialize them as
one JSON body, blocking that container's event loop. Unreachable at today's
volume, but the interim bound the issue suggests (`maxPages` for the two
callers) is one line, and see F4 before reaching for the knob beside it.

## Findings

### F1 - LOW - The All tab's "every tour" depends on an unenforced stamp; the undated filter is not the complement of the date index

What: phase D reads byScheduledAt, whose membership is "has `_schedPartition`
AND `scheduledAt`". Phase U keeps a status's rows with
`attribute_not_exists(scheduledAt)` only. A row with a date but no partition
is in NEITHER phase, so it is missing from every All-tab view - Any time with
no filters included - with no signal. `scheduled` has no U phase at all.

Evidence: `app/src/repos/toursRepo.ts:869-872` (the U filter);
`app/src/lib/tourListQuery.ts:27` (U_ORDER), `:238-240` (notExists for every
status but requested); the fake mirrors it (`app/test/helpers/tourListIndexFake.ts:91`, `:132`).

Who holds such rows: no deployed writer today (F1 is defense in depth). A
local DynamoDB Local stack seeded before fa24547b does - the cast's toured
tour (`cast.ts:805`, dated 2026-05-10) and any pre-branch matrix request
booked later. A future writer (the pending M1.6 import, a backfill script, a
raw put in a dev seam) reopens it silently.

Scenario: a local stack seeded at a5eabcb3 and not reseeded; All tab, Any
time, Toured chip -> the cast's toured tour is not listed, while the tenant
file's Tours card lists it.

Smallest fix (read-side, zero extra reads, distinct from the PATCH stamping
the design rejected): make the U filter the exact complement of index
membership within the status partition -
`attribute_not_exists(#sat) OR attribute_not_exists(#sp)` - mirror it in
`tourListIndexFake.ts:132`, and add one mirror case (a dated row without the
partition comes back from its status's U phase). `scheduled` stays uncovered;
say so in the docblock rather than add a seventh phase.

### F2 - LOW (PLAUSIBLE magnitude) - Every render re-derives every loaded row, including every keystroke

What: `views` is recomputed for ALL loaded rows on every render
(`dashboard/src/routes/tours/AllToursView.tsx:386`). `rowView` calls
`whenLabel` -> `formatDate` + `formatTime` (`tourTime.ts:62-77`), each a
`toLocale*String('en-US', {...})`; with explicit locales and options V8
builds a new formatter per call (its cache covers the no-argument form only).
`search()` sets `chosen` on every keystroke (`AllToursView.tsx:338-343`), so
each keystroke re-formats every loaded row and reconciles the list. After a
search walk the hook can hold ~5,050 rows (`useAllTours.ts:28-32`: 50 + 50 x
100); during the walk each landed page re-derives every row so far
(quadratic over the walk).

Scenario: a few thousand tours, a walk completes, the user refines the search
text: each keystroke formats ~10,000 dates on the main thread before the
input updates. Not measurable at today's volume (hundreds of tours).

Smallest fix: `useMemo` the views on `[data.rows, data.contacts, data.units]`
(typing changes only `chosen`), and module-level `Intl.DateTimeFormat`
instances in `tourTime.ts` (the Past and Closed tabs format the same way).
Measure with a 5,000-row fixture before and after.

### F3 - LOW - Every return from a tour page to a SEARCHED All list re-runs the whole search walk

What: the list lives in `useAllTours` state and dies with AllToursView on the
route change. A row link carries `q` in its back URL
(`AllToursView.tsx:381-382`, `:619`); on the return mount `walk` is true from
the URL (`:262`, `:301`), and walk outranks restore
(`useAllTours.ts:225-238`). So each return reloads page 1 and walks to
completion or 50 requests, and the restore anchor waits for the whole walk
(`restoreOutcome` stays 'pending' while walking, `useAllTours.ts:322-329`).

Scenario: staff search "Smith" under Any time and open each of 8 matching
tours in turn with the back arrow: 8 full walks of rows the browser already
had. With ~3,000 tours a walk is ~30 requests plus the undated tail
(`tourListPage.ts:20-26`), so ~250 requests and a "Searching..." wait on
every return. `tours-all-server-side-search` prices one walk, not the
repetition of this natural workflow.

Fix: file it beside `tours-all-server-side-search`. Options: keep the last
list (rows, maps, cursor, list key) in a module-scoped cache with a short TTL,
reused when a restore record for the same list arrives (the Past batch store,
`ToursPage.tsx:324`, is the house precedent for state that outlives the view);
or server-side search, which removes the walk.

### F4 - LOW - The test knob on `listByScheduledRange` reads as a page cap and does the opposite

What: `opts.pageLimit` (`toursRepo.ts:203-210`, `:417-425`) sets each Query's
Limit; `queryAll` still walks every page and stops only at 100 pages
(`dynamoPaging.ts:20`, `:26-28`). The filed fix for the unbounded walk is
"pass a small maxPages" - the knob beside it is named `pageLimit` and does the
reverse: `{ pageLimit: 10 }` turns one 1 MB Query into up to 100 Queries and
returns a silent prefix of 1,000 rows, flagged only by a WARN. That WARN goes
to the module default logger, not the repo's (`toursRepo.ts:342` vs the bare
`queryAll(doc, ...)` at `:418`; `dynamoPaging.ts:35`).

Scenario: a later bound-the-walk fix writes
`listByScheduledRange(from, to, { pageLimit: 10 })` -> ten times the round
trips and truncation at 1,000 rows instead of a bound.

Smallest fix: rename it to say what it is (`queryLimitForTests`) or move it to
`RepoDeps` as a test seam; pass `{ logger: log }` to `queryAll` here (and in
`queryGsi`, same pattern).

### F5 - LOW - Duplicated logic that will drift

What and evidence:
- `unitsRepo.getDisplaysByIds` (`app/src/repos/unitsRepo.ts:581-618`) is a
  line-for-line copy of `contactsRepo`'s `batchGetByIds`
  (`contactsRepo.ts:849-890`): dedupe, 100-key chunks, 4 attempts at
  25/50/100 ms, a thrown chunk counted as unprocessed - minus `requireComplete`.
  A later fix to one (jitter, a stricter mode) misses the other.
- The All route is spelled in four places: `App.tsx:244`, `ToursPage.tsx:612`,
  `AllToursView.tsx:79`, `TourDetail.tsx:122` (the back-arrow allowlist). A
  rename that misses TourDetail silently sends the back arrow to Active.
- The "unmodified primary click" predicate is written twice
  (`AllToursView.tsx:442`, `ToursPage.tsx:641`).

Smallest fix: a shared BatchGet walk in `lib/` (the `dynamoPaging.ts`
precedent) used by both repos; one exported path constant; one
`isPlainPrimaryClick(e)` helper.
