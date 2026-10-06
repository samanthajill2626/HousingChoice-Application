# Drift check S3-S7 (events, PATCH, sweep, reopen, chip) - findings

- Reader: read-only research child, 2026-10-01.
- Tree: `W:\tmp\tour-auto-close` @f319a306 (code identical to main @ae04122d;
  only docs commits on top, `git diff --stat ae04122d HEAD`).
- Inputs: spec sections 3, 6, 7, 8, 10, 12; plan S3 (705-811), S4 (815-915),
  S5 (919-1258), S6 (1262-1365), S7 (1369-1386).
- Byte-exact quotes for the implementer (closures, signatures, deps shapes,
  the roster-action block, the tick, the wrapper list):
  `.superpowers/sdd/research/ref-s3-s7-routes-jobs.md` (run state, gitignored).
- Method: every symbol located by name in the live tree; contracts read from
  the code, not the plan prose. `npx eslint` run on the 14 files these slices
  touch (baseline below). No suite was run, nothing was edited.

## Verdict

NO STOP. Every symbol S3-S7 builds on exists with the name, shape and (to
within a line or two) the anchor the plan quotes. 15 plan corrections below:
3 would fail a gate or a test if followed literally (1, 3, 6), the rest are
clarifications, traps and doc refreshes. 5 spec-level flags (R1-R5); the
invariant sweep confirms the spec-r3-b writer walk and adds two omissions to
the section 12 writer list.

## Plan corrections (plan says X -> tree has Y -> instruction becomes Z)

1. Task 4.2, the existing `toursRepo.patch` wrappers. Plan: change EVERY
   wrapper to `async (id, updates, opts) =>` and forward `opts`. Tree: six
   sites - `app/test/toursApi.test.ts:2044` and `:2122` (park AFTER the real
   write; the only two driven by the staff PATCH route), `:2242`
   (`async () => { throw ... }`, a zero-arg stub on the CREATE path, never
   restored), `:3302` (relay pointer-stamp failure, bound `realPatch`,
   restored `:3311`), `app/test/placementConvert.test.ts:307` and `:782`
   (conversion finalize - never passed opts). -> Forward `opts` at `:2044`
   and `:2122`; forwarding at `:3302` / `:307` / `:782` is harmless but
   optional; LEAVE `:2242` as `async () =>`. Giving it three unused params
   is a NEW `@typescript-eslint/no-unused-vars` error (eslint.config.mjs
   exempts only `_`-prefixed names), which fails gate 5 on a touched file.
   Predicted: no existing test turns red under the precondition (both parked
   tests park after their own write; nothing else interleaves PATCHes - the
   only `Promise.all` in toursApi.test.ts, `:2608`, races POST /relay).

2. Task 4.2 cases 1 and 3, wrapper/spy timing. Plan: create a tour with a
   past `scheduledAt`, then wrap `patch` "on its FIRST call" / spy on it.
   Tree: POST /api/tours itself calls `tours.patch(tour.tourId,
   { currentLadderId: ladderId })` (`app/src/routes/tours.ts:360`) whenever
   the arm wrote rows - a past date still writes `booked_too_late` skipped
   rows. -> Install the wrapper/spy only after the create resolves (or filter
   for calls that carry a third argument), else "first call" is the create's
   pointer write.

3. Task 6.1 case 3, converting through the route. Plan: PATCH toured, PATCH
   `{ outcome: 'move_forward', moveForward: true }`, POST
   `/api/placements/from-tour`. Tree: the conversion 404s unless the tenant
   CONTACT and the UNIT exist (`app/src/routes/placements.ts:675-682`,
   `tenant_not_found` / `unit_not_found`); BASE_CREATE_BODY's
   `contact-tenant-1` is NOT in `world.contacts` by default (the comment at
   `toursApi.test.ts:2271-2277` says so). -> Seed the tenant contact and
   `unit-abc` first (pattern `placementConvert.test.ts:43-57`), or write the
   finished state (`status: 'closed', convertedPlacementId: 'placement-x'`)
   through `world.toursMap` like the `pending:x` half of the case.

4. Task 3.2, what exactly to replace. Plan: replace "the closure body
   (`:260-287`)". Tree: `tours.ts:252-259` is the closure's 8-line comment
   and `:260-287` a HOISTED `async function recordTourEvent`. -> Replace
   `:252-287` (comment + declaration) with the plan's 2-line comment and
   const arrow. The const is safe: nothing calls it while the factory runs
   (the call sites are inside handlers - `:382`, `:1420-1443`). Drop the
   `recordPersonMilestone` import at `tours.ts:127`: its ONLY use is `:266`.

5. Task 3.2, `PersonMilestoneDeps`. Plan: "If not exported, export it".
   Tree: exported, `app/src/lib/personEvents.ts:48-58`:
   `activityEvents?: Pick<ActivityEventsRepo, 'record'>` (OPTIONAL - absent
   means `recordPersonMilestone` returns at `:82` and writes NEITHER pin),
   `units: Pick<UnitsRepo, 'getById'>`, `log: Logger`. -> Nothing to export.
   `TourEventDeps extends PersonMilestoneDeps` inherits the optional field,
   so the shared writer accepts deps without it and silently drops both
   pins. Optional hardening in the PA3 spirit: re-declare
   `activityEvents: Pick<ActivityEventsRepo, 'record'>` as REQUIRED on
   `TourEventDeps` (all three callers always have it - router `:241-242`,
   sweep, reopen).

6. Task 5.1, header range, test home, deps typing. Plan: header
   `relayCloseNag.ts:1-14`; "the existing relayCloseNag test file"; a fake
   repo with two spies. Tree: header is `:1-16` (PII line `:16`); NO unit
   test file covers the service (only route-level arm tests,
   `toursApi.test.ts:297-326`) -> create `app/test/relayCloseNagClear.test.ts`.
   `ArmRelayCloseNagDeps.conversationsRepo` is the FULL `ConversationsRepo`
   (`relayCloseNag.ts:20-25`), so a two-spy object passed to a helper typed
   with `ArmRelayCloseNagDeps` FAILS typecheck. -> Cast in the test
   (`as unknown as ConversationsRepo`) or type the new helper's deps as
   `{ conversationsRepo: Pick<ConversationsRepo, 'getById' | 'setCloseNagNextAt'>; logger?: Logger }`.
   Owner shape confirmed, no adaptation needed:
   `owner?: { type: 'tour' | 'placement' | null; id?: string }`
   (`conversationsRepo.ts:223`).

7. Task 5.4, test template. Plan: pattern on `devJournalSweepTick.test.ts`.
   Tree: that file injects hand-written STUB deps into
   `buildApp({ config, devRouter: createDevRouter({ config, journalSweepDeps }) })`
   (`:81-84`). The world-fake shape is `app/test/devGating.test.ts:477-516`
   (tour-reminder tick) and `:851-879` (roster tick):
   `createDevRouter({ config, logger, <x>Deps: { ...world.* } })` then
   `makeWebhookHarness({ world, devRouter })`. /__dev routes need no origin
   secret or cookie (mounted before the origin gate AND before the body
   parsers, `app/src/app.ts:124-127` - hence the per-route `json()`). -> Use
   the devGating shape. In `dev.ts` every factory the lazy deps need is
   already imported (`:34`, `:38`, `:39`, `:56`, `:63`, `:69`; `appEvents`
   `:71`; `json` `:7`); the only new import is `runTourAutoClose` +
   `type TourAutoCloseDeps`.

8. Task 5.2, event capture (optional simplification). Plan: a fresh
   `createEventBus()` whose emits the test records. Tree: exported
   (`app/src/lib/events.ts:340`), but `createFakeWorld()` already builds a
   bus (`twilioWebhookHarness.ts:576`) and records every `tour.updated` /
   `scheduled.updated` in order into `world.emitted` (`:577-584`) - the idiom
   `toursApi.test.ts:1048` asserts with. -> `events: world.events`, assert on
   `world.emitted`.

9. Task 5.3, the poll-list pin and stale counts. Plan: "If a test pins the
   worker's poll list or count ... extend it". Tree: none does. The only test
   reading worker.ts is `jobQueueWiring.test.ts:133-138` (source must contain
   `configureJobQueues`); worker.ts self-executes on import, so the new block
   is covered by typecheck only (the e2e lane's real worker first ticks 15
   minutes after boot - setInterval, `pollLoop.ts:60-72`). -> Nothing to
   extend. Refresh what a seventh poll makes wrong: `worker.ts:285-288`
   ("the six call sites" - the new poll bypasses the wrapper),
   `pollLoop.ts:4-17` ("five poll loops") and `:23` (the `intervalMs` doc,
   "Shared WORKER_POLL_INTERVAL_MS cadence."), `lib/config.ts:600-603`
   ("the FIVE stateless polls that share it").

10. Task 7.1, the module text. Plan: add the case to the header PRECEDENCE
    list (`listingSendTour.ts:9-16`). Tree: two more texts state the old
    rule - the header's "Disqualifying" sentence (`:17-18`, "an UNCONVERTED
    'closed' yield no signal") and `qualifyingState`'s doc (`:46-49`). ->
    Update all three. Test builder `tour()` (`listingSendTour.test.ts:17-27`)
    types overrides as `Partial<TourItem>`, so `outcome: 'no_outcome'`
    type-checks only after S1/S2 (S7 lands after them - fine). Callers feed
    ALL of a pairing's tours, no status prefilter (`contacts.ts:1172-1180`,
    `units.ts:958-966`), so no reader change is needed beyond the function.

11. Tasks 6.1 and 3.1, ASCII on edited comment lines. Tree: `tours.ts:1`,
    `:5`, `:6`, `:8`, `:10`, `:11` (route list arrows / dash), `:1077`
    ("closed is fully terminal" + em dash), `units.ts:158` and `:164`
    (around the Task 3.1 list) carry non-ASCII. -> ADD a new ASCII line for
    `POST /api/tours/:tourId/reopen` rather than editing the arrow lines; any
    line that is edited must become fully ASCII. The list lines themselves
    (`units.ts:159-163`, `tours.ts:442-452`, `dashboard/src/api/types.ts:2897-2900`)
    are ASCII.

12. Task 6.1, auth case. Plan: none for the new route. Tree: the posture is
    inherited (`app.ts:211-225` csrfOrigin + session + `requireAuth()` on
    /api; `routes/api.ts:937-960` mounts the tours router at /tours), and
    `toursApi.test.ts:4078-4091` pins 403/401 for a GET only. -> Add one case
    to `toursReopenApi.test.ts`: POST `/api/tours/x/reopen` with the origin
    secret and no session -> 401 (makes spec 7.1's "same auth posture"
    executable).

13. Task 6.1 case 12, the parking flag. Plan: wrap `reopenIf` so its FIRST
    call awaits a complete second POST /reopen. Tree: the second request's
    `reopenIf` goes through the SAME wrapper. -> Set the `parked` flag before
    awaiting (as `toursApi.test.ts:2042-2052` does), or the inner call parks
    too and the test deadlocks.

14. Lint baseline for the touched files (informational for gate 5).
    `npx eslint` over tours.ts, dev.ts, worker.ts, listingSendTour.ts,
    relayCloseNag.ts, activityEventsRepo.ts, personEvents.ts, units.ts,
    toursRepo.ts, toursModel.ts, toursApi.test.ts, listingSendTour.test.ts,
    devJournalSweepTick.test.ts, twilioWebhookHarness.ts at f319a306: ONE
    error, pre-existing - `tours.ts:58` `'TourOutcome' is defined but never
    used`. Task 1.1 rewrites that import block (and must drop
    `isTourOutcome` / `TOUR_OUTCOMES` once unused, `tours.ts:52`, `:56`). ->
    Drop `type TourOutcome` in that same edit, or name it as pre-existing in
    the handback.

15. Doc nit, S5/S6. `events.ts:231-237` (TourUpdatedEvent) lists its
    emitters (PATCH, POST /relay, conversion) -> add the sweep and the
    reopen route.

## Confirmations (anchors and contracts that hold)

- recordTourEvent closure `tours.ts:260-287` closes over `activityEvents`
  (`:241-242`), `units` (`:239`), `audit` (`:240`), `log` (`:231`) - exactly
  the plan's `{ activityEvents, units, audit, log }`.
  `ConditionalCheckFailedException` is imported at `:46` from
  `@aws-sdk/client-dynamodb` - the class `toursRepo.ts:626` re-exports and
  the harness fake throws, so `instanceof` holds in tests.
  `ActivityEventType` (`:79`) stays used by the delegating arrow.
- PATCH: outcome validation `:1047-1049`; read `:1056-1057` (eventually
  consistent today); `const currentStatus = current.status as TourStatus;`
  `:1063` (the plan's name is the real name); closed-terminal 409
  `:1076-1080`; exit gate `:1146-1149`; `const patch: Record<string, unknown>`
  `:1156`; `patch['scheduledAt']` `:1159`, `patch['status']` `:1160` and the
  booking/revival auto-advance `:1165-1171`; outcome `:1172`;
  moveForward/convertible `:1173-1177`; `effectiveStatus` `:1191`;
  terminal + rotation `:1221-1235`; main write `:1237-1246`; arm/sweep
  `:1248-1390`; `scheduled.updated` `:1396-1398`; milestones `:1400-1445`;
  close-nag `:1447-1458`; `tour.updated` `:1463`. Clock dep: `getNow`
  (`:248`, `deps.now ?? wall clock`; harness `toursNow` reaches it via
  `api.ts:945`).
- `get(tourId, opts?: { consistentRead?: boolean })` (`toursRepo.ts:175`,
  impl `:325-337`; already used by the route at `tours.ts:1317`); the fake
  ignores the option by design (`twilioWebhookHarness.ts:3485-3493`).
  `patch` writes any non-undefined key generically (`toursRepo.ts:397-409`)
  and `PatchTourInput` is an index-signature type (`:115-118`, `:139`,
  `:157-159`), so `patch['lastMarkedAt'] = getNow()` compiles and persists.
- Insert points: consistent read replaces `:1057`; the precondition
  try/catch replaces `:1237-1246`; the `lastMarkedAt` stamp goes after
  `:1177` and before the comment at `:1179`.
- Route style `router.patch('/:tourId', ...)` `:1011`,
  `router.post('/:tourId/relay', ...)` `:1494`; names in scope for reopen:
  `tours` `:233`, `conversations` `:236-237`, `events` `:247`, `log` `:231`,
  `getNow` `:248`. Global `express.json` (`app.ts:136`) runs before /api, so
  the reopen route needs no parser; a POST with no body leaves `req.body`
  undefined (Express 5) - the plan's `?? {}` covers it.
- `ActivityEventType` `activityEventsRepo.ts:31-59` (`'tour_converted'`
  `:42`, then `'stage_changed'` `:43`). No exhaustive
  `Record<ActivityEventType | TimelineMilestoneType, ...>` and no `never`
  switch anywhere (dashboard maps are `Record<string, ...>`;
  `Timeline.tsx:428-444` has a default), so Task 3.1 typechecks before S8.
  The contact timeline does not filter activity rows by type
  (`contactTimeline.ts:1363-1377`); `LANDLORD_FEED_TYPES` (`:331-336`) gates
  property-AUDIT rows only, so the landlord gets the new pins with no reader
  change. The unit activity route projects every audit row
  (`units.ts:1250-1264`), no type allowlist.
- conversationsRepo: `close_nag_next_at?: string` `:282`;
  `getById(conversationId: string): Promise<ConversationItem | undefined>`
  `:550`; `setCloseNagNextAt(conversationId: string, at: string | null):
  Promise<void>` `:908` (impl `:2216-2228`, existence-conditional, null ->
  REMOVE; the fake mirrors it at harness `:997-1002`). Fake
  `createRelayGroup` honors `owner` and opens with a pool number
  (harness `:835-874`).
- `deleteSupersededForTour(tourId: string, expectedPointer: string):
  Promise<void>` (`tourRemindersRepo.ts:255`; impl `:502` calls
  `this.listByTour`, so it must be called as a method - the plan does). The
  fake re-checks the pointer per row (harness `:3704-3724`).
- `startPoll(pollName, run, deps: StartPollDeps)` with
  `{ logger, intervalMs, baseContext?, schedule?, now? }` (`pollLoop.ts:21-73`).
  worker: `const { startPoll: startPollLoop } = await import('./jobs/pollLoop.js');`
  `:24`; wrapper `:289-295`; roster block `:388-434` (lazy `await import`,
  every repo `({ logger })`, `events: appEvents` from a lazy
  `./lib/events.js` import, the bridged bus); `bootContext` `:33`.
- dev.ts: `DevRouterDeps` `:104-137`; tour-reminders tick `:365-426` (400
  text `now must be a valid ISO 8601 datetime`, normalized with
  `new Date(body.now).toISOString()`); roster tick deps `:467-486` use
  `events: appEvents`; `log` `:187`; hermetic-only = the whole router is
  loaded only by `lib/devRoutes.ts` `maybeLoadDevRouter` (devAuthEnabled,
  nodeEnv !== 'production', dynamodbEndpoint set) from `index.ts:106`.
- events.ts: `ScheduledUpdatedEvent { contactId?: string }` `:227-229`;
  `TourUpdatedEvent { tourId: string; status: string }` `:238-241`.
- Tests: `authed()` `toursApi.test.ts:48-59`; `BASE_CREATE_BODY` `:61-66`
  (tenant `contact-tenant-1`, unit `unit-abc`); landlord `c-ll` only via the
  LOCAL helpers `seedUnit` `:485-497` / `seedUnitWithLandlord` `:674-682`
  (not exported - copy them); nothing-sent record is `world.sent` (e.g.
  `:4607`); `tour.updated` via `world.emitted.filter(...)` `:1048`, payload
  `toEqual({ tourId, status })` `:1058`; no_outcome PIN home: describe
  'PATCH /api/tours/:tourId' (`:205-420`), beside 'returns 400 for invalid
  status / outcome values' `:387-401` (other exit-gate tests `:228`, `:260`,
  `:1198`). Reminder rows are seeded with
  `world.tourRemindersRepo.create({ tourId, kind, dueAt, ladderId? })` and a
  SENT row via `claimSend(id, iso)` (`tourReminders.test.ts:316-344`);
  `tourRemindersApi.test.ts` exists. `units.ts:157-166` doc as quoted.
- Conversion finalize `placements.ts:771-775`: `tours.patch(tour.tourId,
  { status: 'closed', convertedPlacementId, currentLadderId })`, no opts;
  its gate is `convertible !== true -> 409` (`:661`).
- Task 5.2's CLOCK TRAP is mandatory, not advisory: the fake `create`
  overwrites a supplied `updatedAt` (`...restInput` then `updatedAt: now`,
  harness `:3469-3475`) but honors `createdAt` (`:3474`).

## Spec gaps and risks

R1. (LOW, wording) Spec 5.3 and the round-3 headline say "background jobs
    only read tours". The roster-action WORKER poll writes tours: it applies
    a person-confirmed deferred open through `openTourGroup`
    (`worker.ts:394-434` -> `jobs/rosterActions.ts:156` ->
    `services/rosterProvision.ts:335`, `:364`, `:398`, `:401`, `:424`:
    claimGroupThread / releaseGroupThreadClaim / patch `{ groupThreadId }` /
    clearRoster), bumping `updatedAt`. spec-r3-b's table already counted it
    (one write per deferred action, postpone-only), so the clock conclusion
    stands. Two consequences for S10: section 12's writer list should name
    this poll (status untouched) and the conversion claim/release
    (`placements.ts:716`, `:750`, `:778`); and the new Tier-2 relay-open-race
    issue (6.6) should name all three open paths - POST /:tourId/relay
    (`tours.ts:1594`), apply-now (`tours.ts:919`), and the worker poll / dev
    roster tick (`rosterActions.ts:156`).

R2. (LOW, not in 6.6) Reopen racing a conversion on a closed, unconverted,
    `convertible: true` tour (API-made or performance-seed state; spec 9.2
    then offers Start placement AND the Reopen kebab item). Conversion reads
    `convertible` (`placements.ts:656-672`), then claims with NO status /
    convertible condition (`toursRepo.ts:484`) and finalizes with only
    `attribute_exists` (`toursRepo.ts:422`). A reopen landing between the
    read and the claim wins its own write (toured, outcome/convertible
    removed, `tour_reopened` pinned), then the finalize closes the tour as
    converted anyway: the reopen's 200 is silently overridden. The reverse
    order is refused (reopenIf's `attribute_not_exists(convertedPlacementId)`).
    End state is coherent (converted, placement exists); worth one line in
    the deferred-race issue.

R3. (LOW) Spec 7.4 / Task 5.1 read `conversation.owner` directly, so a group
    carrying only the LEGACY `placementId` back-reference and no `owner`
    (`conversationsRepo.ts:205-216`) counts as "owner absent -> clear". The
    repo's own `getOwner(conv)` (`:385-400`) maps that to a placement.
    Practically unreachable for an unconverted tour (tour groups are created
    with `owner: { type: 'tour', id }`, `rosterProvision.ts:356`); using
    `getOwner` would be more faithful but deviates from the spec's literal
    text - planner's call, not a blocker.

R4. (LOW, accepted by the spec's wording) The `lastMarkedAt` stamp keys on
    `patch['status'] !== undefined`, which is also true for a same-status
    restatement (`{ status: 'toured' }` on a toured tour is legal and 200,
    `tours.ts:1073-1128`, set at `:1160`): an API-only no-op restatement
    gives the tour a fresh two weeks. No dashboard action does this.

R5. (INFO) The worker block has no automated coverage (correction 9). The
    e2e lane's real worker will tick the sweep about 15 minutes into a long
    run with the wall clock; nothing seeded is due then (lean has no tours;
    full-profile tours are at most 10 days past and the toured / no-show ones
    at most 6, `seed/matrix.ts:911-916`; the performance seed anchors at run
    time - `e2e/performance/config.ts:310` - with offsets at or after the
    anchor, `seed/performance.ts:646-649`), which matches spec 11.3.

## Invariant sweep (E)

Writers of tour `status` / `outcome` / `convertible` / `convertedPlacementId`
/ `scheduledAt` in app/src today (every ToursRepo write call site was grepped;
`app/scripts/*` only read tours):

| writer | file:line | fields | trigger |
|---|---|---|---|
| POST create | `routes/tours.ts:335` (+ pointer patch `:360`) | status (scheduled/requested), scheduledAt; `:360` currentLadderId only | person |
| PATCH main write | `routes/tours.ts:1239` | status, scheduledAt, outcome, moveForward, convertible, currentLadderId (+ lastMarkedAt after S4) | person |
| PATCH CAS | `routes/tours.ts:1300` (`setLadderIdIf`) | currentLadderId | person |
| conversion claim / release | `routes/placements.ts:716`, `:750`, `:778` | convertedPlacementId (+ conversionClaimedAt) | person |
| conversion finalize | `routes/placements.ts:771-775` | status closed, convertedPlacementId, currentLadderId | person |
| relay open (route, apply-now, WORKER poll) | `services/rosterProvision.ts:335`, `:364`, `:398`, `:401`, `:424` via `tours.ts:1594`, `tours.ts:919`, `jobs/rosterActions.ts:156` | groupThreadId, roster (status untouched) | person, or the roster-action poll applying a person-confirmed deferral |
| roster plan edits | `routes/tours.ts:632-633`, `:742` | roster, rosterVersion | person |
| seeds / dev reseed | `lib/seed/live.ts:516-523` (re-Put), matrix/cast via `resetLocalData` | whole items | dev only |
| NEW sweep | `toursRepo.autoCloseIf` (S2) from `jobs/tourAutoClose.ts` | status closed, outcome no_outcome, autoClosedFrom/At, currentLadderId | worker poll / dev tick |
| NEW reopen | `toursRepo.reopenIf` (S2) from POST /:tourId/reopen | status, lastMarkedAt; REMOVE outcome, moveForward, convertible, autoClosedAt, autoClosedFrom | person |

Background calls (jobs/, services/) that write a tour at all: ONLY the relay
open inside `services/rosterProvision.ts` (`:335`, `:364`, `:398`, `:401`,
`:424`) when reached from the roster-action poll (`jobs/rosterActions.ts:156`,
worker `:433`, dev tick `dev.ts:497`). `jobs/tourReminders.ts` reads only
(`:1051`, `:1128`, `:1802`); `jobs/relayFanOut.ts` reads only (`:460`);
`lib/rosterResolution.ts` holds `Pick<ToursRepo, 'get'>`;
`lib/performanceSeed.ts:156` is a reader set. No background writer touches
status, outcome, scheduledAt, convertible or convertedPlacementId, and none
recurs without a person, so the legacy `updatedAt` floor still only
postpones (spec-r3-b holds). Nothing outside the sweep and reopen can write
`no_outcome`, `autoClosedAt`, `autoClosedFrom`; `lastMarkedAt` is written by
PATCH and reopen only - but note `toursRepo.patch` is generic (index-signature
input), so the "nothing else may write" rule is a convention enforced by
review, not by the type system.
