# Tour list - plan research, app side: findings against the spec

Reader: app (server) research reader for the implementation plan, 2026-10-06.
Spec: `docs/superpowers/specs/2026-10-06-tour-list-design.md` (DRAFT 6),
checked against `feat/tour-list` @ df76f00a (= main @d839494a plus spec commits).
Scope: sections 3, 5, 7, 8 and the app bullets of 9. Read-only; no tests run.

Everything else the spec says about the app code checked out, including the
3.2 claim that the two harness literals (`twilioWebhookHarness.ts:2690`,
`:3470`) are the ONLY typed fakes a new repo method breaks (the full sweep is in
the reference, section 8), the 3.4 transition guards (`tours.ts:1051-1149`),
the 3.8 Today call (`today.ts:551`, message at `:412-415`), the cursor and limit
precedent (`placements.ts:172-221, 509-572`) and the contacts batch walk
(`contactsRepo.ts:849-904`).

Byte-exact code for every citation below:
`.superpowers/sdd/plan-research/app-reference.md` (gitignored reference).

## F1 (MEDIUM) - the route tests are only as faithful as a fake the spec does not specify

Section 9 asks route tests for each When's key condition and order, the budget
ending exactly at the D-to-U boundary and at a U status boundary (k-less
cursor), and the phase skips; 5.4 adds filtered over-reads and phantom pages.
Every tours route test runs through `makeWebhookHarness()` - no test constructs
`createToursRouter` directly - so these cases execute against the harness
fake of whatever new paged Query method the repo gains. The spec says nothing
about that fake's semantics, and the existing fake list reads do not model
DynamoDB at all: `listByScheduledRange` returns Map insertion order where the
GSI returns ascending `scheduledAt` (`twilioWebhookHarness.ts:3507-3513`), and
`listByStatus` only sorts ascending (`:3514-3519`).

The house rule for a fake behind a filtered, paged Query is written down twice
(`app/test/helpers/contactsPartitionFake.ts:3-24` and `:86-92`;
`app/test/helpers/unreadIndexFake.ts:1-39` and `:104-117`): Limit slices the
page BEFORE the FilterExpression (a filtered-out row still spends its slot); a
LastEvaluatedKey is returned whenever the page REACHED the Limit, not when rows
remain; rows come back in range-key order; the key is the full index-plus-table
key; and a resume key inside a range-key TIE is refused, because DynamoDB orders
tied rows by an opaque key-derived order
(`docs/issues/unread-index-fake-tie-order-is-not-the-services.md`). A fake that
filters before slicing, or mints a key only when rows remain, cannot exercise
5.4's fill, peek-row and phantom-page logic at all, and every call-count
assertion built on it is one Query short of production.

The plan should either specify the fake to that standard (with a fake-parity
case list kept in step with the DynamoDB Local cases, as
`app/test/toursRepoFakeConditions.test.ts:1-9` does for the conditional
writes), or run the budget, boundary and phantom-page cases on DynamoDB Local
only. Either way, fixtures must not put tied `scheduledAt` / `createdAt` values
at a page boundary.

## F2 (LOW) - "injectable through the router's deps" has no path from a test today

5.4 makes `QUERY_PAGE_LIMIT` and `MAX_QUERY_CALLS` injectable "through the
router's deps for tests". `createToursRouter` is only ever built by
`createApiRouter`, which forwards a fixed dependency list
(`app/src/routes/api.ts:938-961`), and the harness exposes no such option
(`HarnessOptions`, `twilioWebhookHarness.ts:4940-5061`). So the change also
touches `ApiRouterDeps`, the mount, and `HarnessOptions` - the precedent is
`unreadWalkLimit` (`api.ts:400-408`, forwarded at `:1198` and `:1218`; harness
`:5043-5049` -> `:5214-5216`) - or the tests mount the router on a bare
`express()` (precedents `app/test/contactTimeline.test.ts:1588-1628` with fakes,
`app/test/todayUnmatchedNonRegression.test.ts:79-134` with real repos on
DynamoDB Local). The section 9 DynamoDB Local tests with a tiny budget need one
of the two as well. The spec names neither `api.ts` nor the harness options.

## F3 (LOW) - the live seed's tour rows are invisible to a pure seed pin

8 (I2) and 9 promise "a seed pin asserts every seeded tour row has it". The
live seed's tour rows are built by `buildLiveStaticItems`
(`app/src/lib/seed/live.ts:102`), which is not exported (the module exports
only `LIVE_IDS`, `LIVE_GROUP_TEXT_ID` and `seedLive`, `live.ts:52, 87, 446`).
A pure pin in the house style (`app/test/seedRosterShape.test.ts:27-31`, lean
plus cast plus matrix) cannot see them; they are reachable only through
DynamoDB, where `app/test/seedLive.test.ts` already reads the tours table
(`:475, :500, :522`). The performance rows are already pinned
(`app/test/performanceSeed.test.ts:502-514`). The plan must either export the
live builder or extend `seedLive.test.ts`. (The live rows do carry the stamp
today, `live.ts:366, 378, 391`; this is about the pin covering them.)

## F4 (LOW) - 3.6 miscounts the unstamped rows

3.6 says "three full-profile rows lack it". The matrix requested branch emits
TWO rows (the `TOUR_STATUSES` loop runs rep 1..2, `app/src/lib/seed/matrix.ts:930-946`),
so four rows lack `_schedPartition`: the cast requested tour
(`app/src/lib/seed/cast.ts:548-561`), the cast toured tour (`cast.ts:799-817` -
the spec's `:799-812` stops before the object closes), and
`tour-mx-requested-01` / `-02`. The fix is unchanged; the pin must iterate
every row rather than count.

## F5 (LOW) - section 7 overstates "can no longer be truncated"

`queryAll` still stops at `DEFAULT_MAX_PAGES` = 100 and returns a PREFIX with
its own WARN (`app/src/lib/dynamoPaging.ts:18-20, 51-59`). In production (1 MB
pages) that cap is unreachable and is announced by `queryAll` itself, so
removing Today's `warnIfCapped('tours_today', ...)` stays right - and that call
never detected truncation anyway: it fires on a COUNT of 100 or more
(`app/src/routes/today.ts:412-415, 551`) over a read that has no Limit. Two
consequences for the plan: state the reason as "the cap moved into queryAll,
which warns", and keep the `pageLimit: 1` integration test's window under 100
tours (at one row per page, 101 rows would hit the cap and fail on a prefix).
That test file also shares ONE table across its cases
(`app/test/toursRepo.integration.test.ts:39-48`, all-time read at `:125`), so the
new window must not overlap the dates the other cases write.
