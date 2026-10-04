# Tour auto-close and reopen - design

- Date: 2026-10-01
- Branch: `feat/tour-auto-close` (worktree `W:\tmp\tour-auto-close`, cut from main @ae04122d)
- Source: Sam's improvement #18 (remaining part), HousingChoice Improvements Tracker
- Status: APPROVED (planner, 2026-10-01, per Cameron's overnight authority)
  after three adversarial rounds; round 3 changed no decision. Per Cameron's
  instruction of 2026-10-01 the planner approves this spec itself;
  every decision the planner took alone is listed in section 14, and the
  review rulings are in
  `docs/superpowers/reviews/2026-10-01-tour-auto-close/design-review/adjudications.md`.

## 1. Summary

A tour that still has no outcome two weeks after its date closes on its own,
with a new outcome "No outcome recorded". Nothing is sent to anyone when that
happens. A closed tour that did not become a placement can be reopened, to
record a different outcome or to reschedule it (the only exceptions are
closed tours written directly through the API with no record of how they
closed - section 7.2). The Today page starts listing no-shows, because they
now leave the list on their own.

Why it matters: improvement #6 (built later) keeps a tenant out of property
blasts while they have a past tour with no outcome, until that tour closes.
The auto-close is the exit that keeps such a tenant from being left out for
long. This change does NOT build #6 or the filterable tour list.

## 2. Decisions (Cameron, 2026-10-01 - "go with your recommendations")

1. **What closes.** Tours never marked toured (status `scheduled`, date
   passed), toured tours with no outcome, and no-shows close 14 days after the
   tour time. An undated toured tour closes 14 days after it was last changed.
   Left alone: `requested` tours (no date), `canceled` tours, and "Needs
   placement" tours (toured, move-forward recorded, no placement created).
   The platform never marks anyone a no-show by itself. (Refined by the
   planner after review - section 5.3 and D3: the clock never starts before
   the tour was created or last marked by a person - or, for a tour nobody
   has marked since this feature shipped, last changed - so a visit recorded
   late still gets its two weeks.)
2. **What reopen returns to.** The state the tour was in when it closed:
   toured with no outcome, no-show, or scheduled with a past date (the Past
   tab's "Not marked"). A tour closed as "Not a fit" returns to toured with
   its outcome cleared. Reopen never sends anything and never arms reminders;
   rescheduling afterwards works as it does today. A reopened tour gets a
   fresh two weeks before it can auto-close again. Reopening into toured
   opens Record outcome straight away.
3. **Converted tours.** Reopen is refused for a tour that became a placement
   (and for one whose conversion is in flight). The tour page keeps "View
   placement"; if the placement falls through, staff change the placement.
4. **Relay close-nag and activity.** The auto-close arms the 28-day relay
   close-nag exactly as Cancel and "Not a fit" do (set-if-absent, open relay
   group only). Reopen clears a pending nag on the tour's own open relay
   group; the next close arms it again. Activity entries: "Closed
   automatically: no outcome recorded after two weeks" and "Tour reopened", on
   the tour page, the tenant's AND the landlord's timelines (every tour event
   writes both) and the property activity.
5. **Today lists no-shows** (the filter that hid them goes away).
6. **Rollout.** The plain rule; no grace period and no on/off switch. Deploy
   timing is Cameron's. The handback says how to preview what the first
   production run will close (section 13).
7. **"No outcome recorded" is system-only.** Staff cannot pick it; the
   Record outcome dialog keeps its two choices.

Accepted defaults: "two weeks" is exactly 14 days (336 hours); Reopen lives
on the tour page only; the Past tab intro gains one sentence (worded to
match the clock floor: "Tours with no outcome close on their own two weeks
after their date or their last update."); an auto-closed tour shows "Closed
automatically on <date>" instead of the "Moving forward: No" line.

## 3. How tours work today (verified on main @ae04122d)

- Statuses `requested | scheduled | toured | no_show | canceled | closed`
  (`app/src/lib/toursModel.ts:37-44`); outcomes `move_forward | not_a_fit`
  (`toursModel.ts:69-83`). `app/src/repos/toursRepo.ts:51-52` carries a
  hand-copied `TourOutcome` union, not derived from the model.
- `PATCH /api/tours/:tourId` (`app/src/routes/tours.ts:1011-1467`):
  - reads the tour with an EVENTUALLY CONSISTENT get (`:1057`), runs every
    guard on that read, and writes through `toursRepo.patch`, whose only
    condition is `attribute_exists(tourId)` (`toursRepo.ts:387-430`). A
    concurrent change between the read and the write is not refused (issue
    `tours-patch-status-precondition`);
  - a closed tour refuses every status change with 409 (`:1076-1080`);
  - the exit gate (outcome / moveForward) is accepted only on a toured tour
    (`:1146-1149`), which is what makes a closed tour's outcome immutable;
  - outcome is validated with `isTourOutcome` (`:1047-1049`);
  - a terminal transition (`canceled | closed | toured | no_show`) rotates the
    reminder-ladder pointer in the same write and sweeps unsent rungs
    (`:1221-1235`, `:1354-1390`), then emits `scheduled.updated`;
  - lifecycle activity is written by `recordTourEvent` (`:260-287`), a closure
    inside `createToursRouter`: a person milestone for the tenant AND the
    unit's landlord (`lib/personEvents.ts`), a `units#<unitId>` audit row and
    a `tours#<tourId>` audit row, each best-effort;
  - Cancel or "Not a fit" arms the relay close-nag (`:1453-1458`,
    `services/relayCloseNag.ts:34-60`, 28 days, set-if-absent, open relay
    groups only);
  - every PATCH emits `tour.updated` (`:1463`).
- The PATCH guard does NOT require an outcome to close: `{status:'closed'}` is
  accepted from scheduled, toured, no_show or canceled (`:1073-1128`), and
  `{status:'closed', moveForward:true}` closes a toured tour as convertible
  with no outcome. `{moveForward:false}` alone on a toured tour writes
  `moveForward:false, convertible:false` with no outcome (`:1173-1177`). An
  undated `no_show` is reachable (requested -> canceled -> no_show, or undated
  toured -> no_show). No dashboard path produces any of these: the Record
  outcome dialog always sends outcome AND moveForward and adds
  `status:'closed'` only for not-a-fit (`dashboard/src/routes/tours/TourDetail.tsx:531-562`,
  `TourModals.tsx:298-301`).
- Conversion (`app/src/routes/placements.ts:644-789`) claims the tour with a
  `pending:<uuid>` sentinel in `convertedPlacementId`, creates the placement,
  then writes `status closed + convertedPlacementId + rotated ladder` in one
  update (`:771-775`). It gates on `convertible === true` only (`:661`).
- Reads: `listByStatus` (`toursRepo.ts:366-385`) pages to exhaustion on the
  `byStatus` GSI (hash `status`, range `createdAt`; includes undated tours).
  `listByScheduledRange` (`:347-364`) reads ONE page and the `byScheduledAt`
  GSI excludes undated tours (issue `tours-scheduled-range-query-unpaginated`).
- Every repo write stamps `updatedAt` with the wall clock
  (`new Date().toISOString()`, millisecond resolution).
- Worker polls run through `startPoll` (`app/src/jobs/pollLoop.ts:53-73`); the
  worker's local wrapper (`app/src/worker.ts:289-295`) binds
  `config.workerPollIntervalMs` (default 30000, `lib/config.ts:609`) for all
  six existing polls. The app process starts no polls. Dev tick seams live in
  the APP process (`app/src/routes/dev.ts`, e.g. `POST
  /__dev/tour-reminders/tick` at `:405-426`, optional `body.now`). Worker
  events reach the dashboard SSE through the event bridge
  (`lib/eventBridge.ts:45`, `lib/events.ts:294-325`).
- The hermetic e2e lane runs the REAL worker beside the app
  (`scripts/e2e-session.mjs`), on the 30 s poll.
- Dashboard:
  - Tours page tabs Active / Past / Closed (`ToursPage.tsx:569-595`). Past
    selection: `selectPastTours` + `selectOffRangeTours`
    (`useTours.ts:198-250`), a 90-day window, one range page plus a
    `status=toured` read. Closed tab: closed + canceled, rows show date,
    status and type only (`ToursPage.tsx:124-158`, `:778-799`). Neither tab
    subscribes to `tour.updated`.
  - Today's "Past tours needing an outcome": `useTodayPastTours` uses the
    Past tab's loader, then `selectTodayPastTours` drops no-shows because they
    had no way off the list (`useTours.ts:252-263`), cap 5. The section's
    link reads "See all N on the Past tab" when rows were cut, otherwise
    "Open the Past tab" (`Today.tsx:241`, `:255-257`). It refetches on
    `tour.updated` (`useTodayPastTours.ts:172-180`).
  - Tour page: the primary CTA ladder puts "View placement" (converted) and
    "Start placement" (`convertible === true`) before any status rung and has
    nothing for a closed unconverted tour (`TourDetail.tsx:570-601`); the
    Outcome card shows the outcome label and "Moving forward: Yes/No"
    (`:790-806`). Every modal in `TourModals.tsx` calls `onConfirm` then
    `onClose`; the "already toured" dialog's close is a guarded functional
    update so it does not shut the Record outcome dialog it chains into
    (`TourDetail.tsx:820-829`).
- Activity vocabulary: `ActivityEventType` (`app/src/repos/activityEventsRepo.ts:31-59`)
  mirrored by `TimelineMilestoneType` (`dashboard/src/api/types.ts:2495-2517`);
  labels in `dashboard/src/routes/tours/tourActivityFormat.ts:14-23` (tour
  page), `dashboard/src/routes/listing/listingFormat.ts:114-121` (property;
  an unknown type loses its /tours link); colour in
  `dashboard/src/routes/contact/Timeline.tsx:428-444` (unknown types are
  neutral). The person timeline label is server-owned and passed through.
- The listing-send "tour chip" (`app/src/lib/listingSendTour.ts:50-57`, read by
  `routes/contacts.ts` and `routes/units.ts`) shows "Toured" for a toured tour
  or a CONVERTED closed tour, and nothing for any other closed tour.
- No-shows have no exit today (issue `past-tab-no-show-rows-need-an-exit`):
  the tour page offers Reschedule and the no-show check-in only; Cancel is
  shown for requested/scheduled (`TourDetail.tsx:92-99`). Sam decided on
  Sep 30 that the two-week close covers it (no manual exit).

## 4. Goals and non-goals

Goals: sections 5-11.

Non-goals (do NOT build): #6 blast filtering; the filterable tour list; a
calendar; letting staff pick "No outcome recorded"; a manual "done" exit for
no-shows; reopening canceled tours (already revivable through Reschedule); a
new relay group for a reopened tour whose group was closed; server-derived
close on not-a-fit (issue `tour-outcome-close-not-backend-enforced` stays
open); paginating `listByScheduledRange`; live refresh of the Past / Closed
tabs; renaming the Today section; any GSI, table or infra change; any env
var; any seed change.

## 5. Model changes

### 5.1 Outcome

- `TOUR_OUTCOMES = ['move_forward', 'not_a_fit', 'no_outcome']`,
  label `no_outcome: 'No outcome recorded'`.
- New `STAFF_TOUR_OUTCOMES = ['move_forward', 'not_a_fit']` +
  `isStaffTourOutcome`. The PATCH route validates with the STAFF guard, so
  `{outcome:'no_outcome'}` is a 400 whose text lists the two staff values.
- `toursRepo.ts`'s hand-copied `TourOutcome` union re-exports the model's
  type instead, so the two cannot drift.

### 5.2 New optional tour attributes (no migration, no GSI change)

| attribute | written by | meaning |
|---|---|---|
| `autoClosedAt` | auto-close | wall-clock ISO instant the sweep closed the tour |
| `autoClosedFrom` | auto-close | the status it closed from: `scheduled`, `toured` or `no_show` |
| `lastMarkedAt` | staff PATCH, reopen | the latest instant a person changed the tour's status or time, or reopened it |

Reopen removes `autoClosedAt` and `autoClosedFrom`. Nothing removes
`lastMarkedAt` (a later mark or reopen overwrites it).

### 5.3 The two-week clock (pure, in `toursModel.ts`)

`AUTO_CLOSE_AFTER_MS = 14 * 24 * 60 * 60 * 1000`.
`AUTO_CLOSE_STATUSES = ['scheduled', 'toured', 'no_show']`.

`autoCloseDueAtMs(tour)` returns the epoch-ms instant a tour becomes due, or
`null` when it is not a candidate:

- status not in `AUTO_CLOSE_STATUSES` -> null;
- `outcome` present (any value) -> null (covers "Needs placement" and any
  decided tour);
- `convertible === true` -> null (`false` or absent is fine);
- `convertedPlacementId` is any string (finished or a `pending:` claim) -> null;
- clock start = the LATEST of: `createdAt`; `scheduledAt` when it is a
  non-empty string; and the MARK - `lastMarkedAt` when present, otherwise
  `updatedAt`. Any of these present but unparseable -> null. (No
  status-specific undated branch: an undated candidate of any status uses
  `createdAt` and the mark.)
- due = clock start + `AUTO_CLOSE_AFTER_MS`.

Why `updatedAt` stands in when `lastMarkedAt` is absent: no row written
before this feature ships carries `lastMarkedAt` (there is no migration), and
a tour staff marked toured or no-show in the two weeks before the deploy
must not close on the first run. For such a row `updatedAt` is never earlier
than its last mark. Once a person marks, reschedules or reopens a tour after
the deploy, `lastMarkedAt` exists and unrelated writes (a roster edit, a
group open) no longer move its clock.

The fallback is not limited to pre-deploy rows: create does not write
`lastMarkedAt`, so ANY tour no person has marked yet (a booked-ahead tour
never marked toured is the common case) counts from its last change of any
kind. Writers of a tour's `updatedAt` are all person-triggered or at create
time (spec review round 3), apart from this sweep's own close. One of them
runs in the background: the worker's roster-action poll
(`jobs/rosterActions.ts`) and its hermetic dev tick apply a group open a
person confirmed during quiet hours - setting `groupThreadId`, clearing the
`roster` plan and bumping `updatedAt`, once per confirmed action, never
status, outcome or the date. (Text corrected 2026-10-04, ruling F1: it used
to say background jobs only read tours.) So the fallback can postpone a close
(a group opened or a roster edited after the date) but never keep a tour open
forever or close one early. Accepted.

A tour is due when `due <= now`. Consequences: a tour booked ahead closes 14
days after its time; a tour marked toured, a no-show or rescheduled after its
date gets 14 days from that mark; a tour created after its own date (an API
create with a past time) gets 14 days from its creation; a reopened tour gets
14 days from the reopen; a tour nobody has marked since the deploy gets 14
days from its last change of any kind.

## 6. The auto-close sweep

### 6.1 Where it runs

- New job module `app/src/jobs/tourAutoClose.ts` exporting
  `runTourAutoClose(nowIso, deps, opts?)` and
  `TOUR_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000`.
- Worker: started beside the other polls in `worker.ts` on that interval (a
  code constant, not an env var). The local `startPoll` wrapper binds the
  shared interval, so this poll calls `jobs/pollLoop.ts`'s `startPoll`
  directly with its own `intervalMs` (same logger, same `bootContext`), or
  the wrapper gains an optional interval argument. The worker's `events` bus
  is the one its other polls emit on (bridged to the app).
- Dev seam: `POST /__dev/tour-auto-close/tick` in `app/src/routes/dev.ts`,
  hermetic-only like its siblings. Body (both optional):
  - `now`: ISO datetime, validated and normalized exactly like the
    tour-reminders tick (400 `now must be a valid ISO 8601 datetime`);
  - `tourIds`: a non-empty array of at most 50 non-empty strings (400
    otherwise). When present the sweep considers ONLY those tours (each read
    consistently), so a spec cannot close another spec's tours.
  Response 200 `{ ok: true, now, scanned, due, closed, lost, failed }`. Deps
  are built lazily to mirror the worker and are injectable through
  `DevRouterDeps`.

### 6.2 Candidates

Without `tourIds`: `listByStatus('scheduled')`, `listByStatus('toured')`,
`listByStatus('no_show')` (each pages to exhaustion), filtered by
`isAutoCloseDue(tour, nowMs)` (null-safe: a non-candidate is never due - do
NOT compare `autoCloseDueAtMs(...)` to `now` directly, `null <= n` is true in
JavaScript). Never the scheduled-range read (one page, no undated tours).

### 6.3 The close write (one conditional update per tour)

New repo method `toursRepo.autoCloseIf(tour, rotation)`:

- SET `status = 'closed'`, `outcome = 'no_outcome'`,
  `autoClosedFrom = <tour.status as read>`, `autoClosedAt = <wall clock>`,
  `currentLadderId = rotation`, `updatedAt = <wall clock>`;
- CONDITION (field equality, never `updatedAt` equality - two writes in one
  millisecond carry the same stamp): `attribute_exists(tourId)` AND
  `status = <status as read>` AND `attribute_not_exists(outcome)` AND
  `attribute_not_exists(convertedPlacementId)` AND
  (`attribute_not_exists(convertible)` OR `convertible <> true`) AND
  `scheduledAt` equal to the value read (or `attribute_not_exists` when it was
  absent) AND `lastMarkedAt` equal to the value read (or absent likewise);
- returns the updated item, or `undefined` on `ConditionalCheckFailedException`
  (something changed between the read and the write - the change wins, the
  sweep skips the tour this run and re-evaluates it next run);
- refuses up front (returns `undefined`, no write) when the status it was
  handed is not a candidate status - defense in depth for the `tourIds` path,
  which reads tours of any status.

Never-marked tours: when the tour as read carries no `lastMarkedAt`, the
condition ALSO requires `updatedAt` equal to the value read
(`attribute_not_exists(updatedAt)` if the read had none). For such a tour
`updatedAt` is the clock's mark (5.3), so an unrelated write (roster edit,
group open) that lands between the read and the write has restarted the
clock: the close loses, and the sweep re-evaluates the tour next run. The
term is limited to never-marked tours because once `lastMarkedAt` exists the
clock ignores `updatedAt`, and conditioning on it there would let a roster
edit or a group open block a due close it does not postpone. Residual: two
writes in one millisecond carry the same stamp, so a racing write stamped in
the same millisecond as the write the read saw goes undetected and the close
lands - a false negative of the guard. The term can only turn a close into a
skip, never a skip into a close. (Changed 2026-10-04, ruling A-1 in
code-review/adjudications-r1.md: this paragraph used to accept that race as a
residual, on the grounds that millisecond stamps make `updatedAt` equality
unsound; the code review reproduced it on DynamoDB Local. This amends the
CONDITION bullet above, whose "never `updatedAt` equality" now holds for
marked tours only.)

`rotation` is a fresh UUID: the pointer then names a ladder no row carries,
which is how "no live ladder" is expressed (same as the PATCH terminal
branch). The close leaves `moveForward` / `convertible` as they are (a
candidate can carry `false` for both, never `convertible: true`). The
injected `now` decides only WHICH tours are due; every stamp is wall clock.

The in-memory `toursRepo` in `app/test/helpers/twilioWebhookHarness.ts` gets
the same method with the SAME condition, evaluated synchronously.

### 6.4 After a won close (each step best-effort; a failure is logged with the tourId and the run continues)

1. `tourRemindersRepo.deleteSupersededForTour(tourId, rotation)` - deletes
   every never-sent reminder row of the old ladder, skipped and canceled
   history rows included (the same as every PATCH terminal transition;
   `tourRemindersRepo.ts:502-511`).
2. The shared tour-event writer (section 10.1) with type `tour_auto_closed`.
3. `armRelayCloseNagIfOpen({ conversationsRepo, logger }, tour.groupThreadId,
   'tour')` (wall clock).
4. Emit `tour.updated` `{ tourId, status: 'closed' }` and
   `scheduled.updated` `{ contactId: tenantId }`.

Summary returned: `{ scanned, due, closed, lost, failed }` (`failed` = the
close write threw something other than a condition failure). Logged at info
ONLY when `closed > 0` or `failed > 0`, plus one info line per closed tour
with `tourId` and `from`. PII: ids only.

### 6.5 What the sweep never does

It never sends a message (its deps contain no messaging adapter or send
service), never marks a no-show, never changes tenant status, never touches
placements, and never closes a tour with an outcome, a conversion (claimed or
finished), `convertible: true`, or status requested/canceled/closed.

### 6.6 Concurrency

- Sweep vs sweep (worker + dev tick, or two workers): the condition makes the
  close exactly-once; only the winner runs 6.4.
- Sweep read, then a staff change, then the sweep write: the condition fails
  (status, outcome, date, mark or conversion changed, and, for a never-marked
  tour, an unrelated write that moved `updatedAt` (ruling A-1)); the sweep
  skips.
- Staff PATCH read, then the close, then the PATCH write: refused by the
  PATCH's new status precondition (section 8) with 409 `tour_changed`; the
  tour stays closed and reopenable.
- Residual, DEFERRED to an issue: the relay-open path checks the tour's
  status on a read and `claimGroupThread` has no status condition, so a group
  opened in the same instant a 14-day-old tour closes can land on the closed
  tour. Same class as two staff racing today.

## 7. Reopen

### 7.1 API

`POST /api/tours/:tourId/reopen` - staff route (same auth posture as the
other tour routes), empty body (any field -> 400 `unknown field(s): ...`).

| result | when |
|---|---|
| 200 `{ tour }` | reopened |
| 404 `tour_not_found` | no such tour |
| 409 `tour_not_closed` | status is not `closed` |
| 409 `tour_converted` | `convertedPlacementId` is any string (finished or `pending:`) |
| 409 `tour_reopen_unsupported` | closed with no `autoClosedFrom` and no `not_a_fit` / `move_forward` outcome (API-only rows) |
| 409 `tour_changed` | the conditional write lost to a concurrent change |

### 7.2 Target status (pure `reopenTargetFor(tour)` in `toursModel.ts`)

- `autoClosedFrom` when it is a candidate status (`scheduled`, `toured`,
  `no_show`);
- else `toured` when `outcome` is `not_a_fit` or `move_forward`;
- else refuse (`tour_reopen_unsupported`).
- (Checked first: not closed -> `tour_not_closed`; any `convertedPlacementId`
  string -> `tour_converted`.)

### 7.3 The write (new repo method `toursRepo.reopenIf(tour, target, nowIso)`)

- The read before it is CONSISTENT.
- SET `status = target`, `lastMarkedAt = nowIso` (the route's clock),
  `updatedAt = <wall clock>`; REMOVE `outcome`, `moveForward`, `convertible`,
  `autoClosedAt`, `autoClosedFrom`;
- CONDITION (field equality): `attribute_exists(tourId)` AND `status =
  'closed'` AND `attribute_not_exists(convertedPlacementId)` AND `outcome`
  equal to the value read (or absent) AND `autoClosedFrom` equal to the value
  read (or absent);
- returns the updated item, or `undefined` on a condition failure (-> 409
  `tour_changed`). The harness fake mirrors the condition.
- `currentLadderId` is left as is (it names no live rows). No reminder is
  armed - not even when the target is `scheduled`, whose time is in the past.

### 7.4 Side effects (best-effort, never fail the 200)

1. Shared tour-event writer with type `tour_reopened`.
2. Clear the close-nag (new helper beside `armRelayCloseNagIfOpen` in
   `services/relayCloseNag.ts`): when `tour.groupThreadId` names a
   conversation that is a `relay_group`, `status === 'open'`, carries
   `close_nag_next_at`, and whose `owner` is absent, has a null type, or is
   `{ type: 'tour', id: tourId }`: `conversationsRepo.setCloseNagNextAt(id,
   null)`. Never throws. (As built 2026-10-04, ruling F3: the owner is
   resolved through `getOwner(conversation)` like every other owner reader,
   so a legacy group that carries only `placementId` counts as
   placement-owned and is NOT cleared; a malformed `owner: { type: 'tour' }`
   with no id resolves to unowned and IS cleared.)
3. Emit `tour.updated` `{ tourId, status: target }`.

No message, no reminder, no tenant-status change, no placement change, no
roster change.

### 7.5 After a reopen

The tour behaves exactly like any tour in its target status: toured ->
Record outcome; no_show -> Reschedule / no-show check-in; scheduled (past) ->
Mark toured / Mark no-show / Reschedule, and "Not marked" on the Past tab.
The two-week clock restarts from the reopen (`lastMarkedAt`). A reopened tour
dated more than 90 days ago (or dropped by the one-page range read) is on no
list - it is reached from its own page or the contact / property tour cards,
and closes again 14 days later if nothing is recorded.

## 8. Staff PATCH changes (`app/src/routes/tours.ts`)

1. Outcome validation uses `isStaffTourOutcome`; the 400 text lists
   `move_forward, not_a_fit`.
2. The read before the guards is CONSISTENT (`tours.get(tourId, {
   consistentRead: true })`).
3. The main write carries a precondition on the status that read returned:
   `toursRepo.patch(tourId, patch, { expectedStatus: currentStatus })`
   (`ConditionExpression: attribute_exists(tourId) AND status = :expected`).
   On `ConditionalCheckFailedException` the route re-reads consistently:
   tour missing -> 404 `tour_not_found`; otherwise 409 `{ error:
   'tour_changed', detail: 'This tour changed while you were saving - reload
   and try again.' }`, before any side effect runs. (The tour page shows an
   `ApiError` as `<error> (<detail>)`, like every other 409 today -
   `dashboard/src/api/client.ts:75-83` - so the detail is not standalone
   copy.) The harness fake mirrors
   the precondition. Existing tests that wrap `world.toursRepo.patch` to park
   a request (the concurrent-reschedule and terminal-vs-revival tests in
   `app/test/toursApi.test.ts`) forward the new third argument.
4. When the built patch contains `status` or `scheduledAt`, it also sets
   `lastMarkedAt = getNow()` (the router's injected clock), in the same write.
   (As built 2026-10-04, ruling F4: the stamp fires on an ACTUAL status
   change, or whenever the patch carries `scheduledAt` - a same-status
   restatement such as a repeated `{ status: 'toured' }` does not restart the
   clock; a same-time reschedule does, as a deliberate person action.)
5. Everything else (closed-terminal 409, exit gate on toured, ladder
   rotation, milestones, close-nag) is unchanged. Leaving `closed` is possible
   only through `POST /reopen`.

`patch`'s `opts` is optional, so every other caller (conversion finalize,
create's pointer write, tests) is unchanged.

## 9. Dashboard

### 9.1 Types and API client (`dashboard/src/api/`)

- `TourOutcome` gains `'no_outcome'`; `TOUR_OUTCOME_LABELS.no_outcome =
  'No outcome recorded'`.
- New `StaffTourOutcome = 'move_forward' | 'not_a_fit'`; `patchTour`'s
  `outcome` and the Record outcome dialog's decision use it, so the client
  cannot type-check a request the server refuses.
- `Tour` gains optional `autoClosedAt`, `autoClosedFrom`, `lastMarkedAt`.
- New `reopenTour(tourId): Promise<Tour>` (POST `/api/tours/:tourId/reopen`).
- `TimelineMilestoneType` gains `tour_auto_closed` and `tour_reopened`.
- `patchTour`'s doc comment stops claiming `{ outcome, moveForward }` closes
  the tour (only not-a-fit with `status: 'closed'` does).
- `e2e/performance/mutationCatalog.ts` gains the `reopenTour` entry (its AST
  two-way match fails otherwise).

### 9.2 Tour page (`TourDetail.tsx`, `TourActionsMenu.tsx`, `TourModals.tsx`)

- `reopenTargetOf(tour)` in a small pure module mirrors 7.2 (null when not
  reopenable).
- ONE placement per state: "Reopen tour" is the PRIMARY CTA when the tour is
  reopenable and the ladder has nothing else; on a closed, unconverted tour
  with `convertible: true`, "Start placement" stays primary (existing order)
  and "Reopen tour" is the kebab's item instead. Never both at once. A
  converted tour shows "View placement" and no Reopen anywhere.
- Reopen opens a confirm dialog (title "Reopen tour", buttons "Cancel" /
  "Yes, reopen" - the confirm must not share the header button's name: the
  shared Modal does not make the page inert, and Playwright names match by
  substring) whose body says where the tour goes and that nothing is sent:
  - to toured: "This tour goes back to Toured so you can record a different
    outcome. Nothing is sent."
  - to no_show: "This tour goes back to No show so you can reschedule it.
    Nothing is sent."
  - to scheduled: "This tour goes back to Not marked so you can mark it
    toured or a no-show, or reschedule it. Nothing is sent."
  On confirm: `reopenTour`, apply the returned tour; when the new status is
  `toured`, hand the modal slot to Record outcome. The dialog's `onClose`
  MUST be the guarded functional update the "already toured" dialog uses
  (`setModal((m) => (m === 'reopen' ? null : m))`, `TourDetail.tsx:820-829`)
  or it shuts the outcome dialog the instant it opens. An error stays in the
  dialog: a 409 reads "This tour changed since the page loaded - reload and
  try again."; anything else "Couldn't reopen the tour - please try again."
- Outcome card for `no_outcome`: "Outcome: No outcome recorded" and the line
  "Closed automatically on <short date of autoClosedAt>" in place of "Moving
  forward". Other outcomes unchanged.
- Every tour dialog that writes - Book / Reschedule (the shared date
  dialog), Mark already toured, Record outcome, Cancel, and Reopen: an
  `ApiError` with status 409 (the tour closed or changed while the dialog
  was open - `illegal_exit_gate`, `illegal_status_transition`,
  `tour_changed`) shows "This tour changed since the page loaded - reload
  and try again." instead of its "Couldn't ... - please try again." (a retry
  cannot succeed). Other errors keep each dialog's existing copy. One shared
  constant.

### 9.3 Tours page (`ToursPage.tsx`)

- Closed tab rows: a closed tour with an outcome shows the outcome label as
  one more badge (so "No outcome recorded" and "Not a fit" read apart).
- Closed tab intro: "Tours that ended - converted into a placement, closed as
  not a fit, closed automatically with no outcome, or canceled."
- Past tab intro: append "Tours with no outcome close on their own two weeks
  after their date or their last update."
- Past selection is unchanged; a reopened tour inside the Past window
  reappears by the existing rules (7.5 caveat beyond it).

### 9.4 Today

- `selectTodayPastTours` is removed (Today lists the Past tab's rows, capped
  at 5, most recent first); `useTodayPastTours` uses the Past rows directly.
- A no-show row shows "No show" and links to the tour page without
  `?outcome=1` (existing `Today.tsx` behavior for non-toured rows).
- The heading stays "Past tours needing an outcome". The link rule is
  unchanged ("See all N on the Past tab" only when rows were cut).
- Accepted consequence of decision 5: a no-show sits on Today for up to 14
  days after its last mark, and "All caught up" does not show meanwhile.
- The comments that encode the old rule change with it: `Today.tsx` (header
  and the past-tours section), `useTodayPastTours.ts` (header and the "what
  Today leaves out" note), `useTours.ts` (around the removed selector).

### 9.5 Activity rendering

- Tour page (`tourActivityFormat.ts`): `tour_auto_closed` -> "Closed
  automatically: no outcome recorded after two weeks"; `tour_reopened` ->
  "Tour reopened"; MILESTONE_TYPE maps each to itself.
- Property (`listingFormat.ts` TOUR_LABELS): "Tour closed automatically: no
  outcome recorded after two weeks", "Tour reopened" (keeps the /tours link).
- Contact timeline: the server-owned labels in 10.1; no colour case (neutral
  is right for both).

## 10. Activity, events, the listing chip

### 10.1 The shared tour-event writer

`recordTourEvent` moves out of the `createToursRouter` closure into a module
(for example `app/src/lib/tourEvents.ts`) taking explicit deps
`{ activityEvents, units, audit, log }`. The router, the sweep and the reopen
route all call it. Existing callers' behavior is unchanged (same three
writes, same order, same best-effort guards, tenant and landlord copies).

New types (added to `ActivityEventType` and `TimelineMilestoneType`,
persisted as both the activity type and the audit `event_type`):

| type | person-timeline label |
|---|---|
| `tour_auto_closed` | "Tour closed automatically: no outcome recorded after two weeks" |
| `tour_reopened` | "Tour reopened" |

Rows written by the dev tick are stamped with the wall clock, not the
injected `now` (`auditRepo` and `personEvents` stamp their own time).

### 10.2 Events

`tour.updated` and `scheduled.updated` from the worker reach the dashboard
through the event bridge. The tour page and Today refetch on `tour.updated`;
the Past and Closed tabs do not (out of scope: a loaded list; its actions
meet the 409s).

### 10.3 Listing-send chip

`listingSendTour.ts` `qualifyingState`: a `closed` tour with
`autoClosedFrom === 'toured'` counts as "toured" (the visit happened; only
the decision is missing - the same honest-floor reasoning as the converted
case). A tour auto-closed from `scheduled` or `no_show` shows no chip, like
any unconverted closed tour.

## 11. Tests and e2e

- Model: `autoCloseDueAtMs` truth table (each status; outcome present;
  `convertible` true / false; converted; `pending:` claim; undated of each
  candidate status; `lastMarkedAt` before and after the date; with NO
  `lastMarkedAt`, `updatedAt` after the date floors the clock and before it
  does not; with `lastMarkedAt` present, a later `updatedAt` is IGNORED;
  created after the date; the exact 14-day boundary; unparseable instants);
  `isAutoCloseDue` false for every non-candidate; `reopenTargetFor` table;
  `TOUR_OUTCOMES` / labels / `STAFF_TOUR_OUTCOMES` pins.
- Repo (DynamoDB Local, `app/test/toursRepo.integration.test.ts`): `patch`
  with `expectedStatus` wins / loses; `autoCloseIf` wins on an untouched
  candidate and loses on each of: status changed, outcome set, conversion
  claimed, `convertible: true`, `scheduledAt` changed, `lastMarkedAt` changed,
  and, for a never-marked tour, an unrelated write that moved `updatedAt`
  (ruling A-1); it refuses a non-candidate status without writing;
  `reopenIf` wins, removes the five attributes, sets `lastMarkedAt`, and loses
  on a converted / changed tour. A matching unit test drives the harness fake
  through the same cases.
- Job: closes only due candidates; never sends (no messaging dep exists);
  arms the nag only on an open relay group without a nag; emits both events;
  a lost write runs no side effects; a side-effect failure does not stop the
  run; `tourIds` scoping.
- Routes: every 7.1 row; PATCH `{outcome:'no_outcome'}` is 400; PATCH racing
  a close returns 409 `tour_changed` and leaves the tour closed; PATCH stamps
  `lastMarkedAt` on status / time changes and not on outcome-only patches;
  the dev tick's validation and scoping; existing closed-terminal pins hold.
- Listing chip: auto-closed from toured -> "toured"; from scheduled /
  no_show -> no chip.
- Dashboard: reopen CTA / kebab matrix - exactly ONE "Reopen tour" control
  per state (auto-closed from each status, not-a-fit, convertible-unconverted
  -> kebab only, converted, pending claim, closed with no outcome), dialog
  copy and its "Yes, reopen" confirm, chaining into Record outcome with the
  guarded close, the Record outcome dialog's 409 copy, Outcome card for
  `no_outcome`, Closed-tab badge, Today includes no-shows, activity labels.
- e2e:
  1. NEW `e2e/tests/dashboard-next/tour-auto-close.spec.ts` (now-relative
     dates, accessibility-first selectors, every tick passes `tourIds`):
     a. Create a tour dated 20 days ago via the API (the create texts nobody;
        past-dated rungs are `booked_too_late` skipped rows, which the close
        deletes - do not assert on them afterwards). A tick at the current
        time does NOT close it (created today: the clock starts at
        creation). A tick with `now` 15 days ahead closes it with "No
        outcome recorded"; the Closed tab shows the badge; the tour page
        shows "Closed automatically on"; nothing was sent to the tenant or
        the landlord (fake Twilio thread store).
     b. Reopen it from the tour page ("Reopen tour", then the dialog's "Yes,
        reopen" - scope dialog controls to the dialog): the dialog says "Not
        marked"; the tour is back on the Past tab as "Not marked"; a tick
        scoped to it closes it again only after the reopen's two weeks (tick
        at now + 1 day: open; at now + 15 days: closed).
     c. A toured tour closed as "Not a fit": Reopen lands in Record outcome.
     Every tour the spec creates is closed or decided in `afterEach`.
  2. REWRITE `e2e/tests/dashboard-next/today-past-tours.spec.ts` for no-shows
     on Today: the header comment, the "minus no-shows" title, the row counts
     (the no-show is now a row, with its "No show" state and a link to its
     tour), the link text (with every row shown it reads "Open the Past tab",
     not "See all N"), and the capped-list order.
  3. No fixed-date spec needs a change: a tour created during a run is not
     due until 14 days after its creation, so the lane's real worker never
     closes one (`listing-activity.spec.ts:118`, `:237` and
     `landlord-activity.spec.ts:97` stay as they are).

## 12. Invariants and every surface

Invariants changed / added:

- "Closed is terminal" becomes "closed is terminal except through `POST
  /reopen`" (PATCH still refuses every change to a closed tour).
- A tour carrying `no_outcome` was closed by the sweep and carries
  `autoClosedAt` + `autoClosedFrom` until a reopen removes all three. Held by:
  the PATCH status precondition (a PATCH that read a pre-close status cannot
  merge onto the closed row), the staff outcome guard (PATCH can never write
  `no_outcome`), and reopen's single write.
- PATCH never writes on top of a status it did not read.

Writers of tour status / outcome / the new attributes after this change:
tour create (POST; status only), PATCH (status precondition, `lastMarkedAt`),
conversion finalize (`placements.ts:771`, unchanged; its tours are never
candidates - `convertible: true`), the conversion claim and release
(`placements.ts:716`, `:750`, `:778`; `convertedPlacementId` and
`conversionClaimedAt` only, status untouched), the sweep (new), reopen (new),
roster / relay routes and the worker's roster-action poll with its dev tick
(a person-confirmed deferred group open; status untouched), seeds and dev
reseed (unchanged). Nothing else may write `no_outcome`, `autoClosedAt`,
`autoClosedFrom` or `lastMarkedAt`. (List completed 2026-10-04, ruling F1.)

Readers that must agree with the new states:

- Past tab / Today selection (`useTours.ts`, `useTodayPastTours.ts`):
  auto-closed tours are `closed` and drop off; reopened tours come back by
  status inside the window; no-shows now reach Today (9.4).
- Closed tab (`useClosedTours`, `ToursPage.tsx`): lists auto-closed tours;
  badge per 9.3.
- Tour page CTA ladder, kebab guards, Outcome card, conversation pane
  (`groupDead` for closed): per 9.2; a reopened tour is no longer `groupDead`.
- Listing-send chip (`listingSendTour.ts`): per 10.3.
- Contact / property / listing tour cards (`TenantFile.tsx:339`,
  `LandlordFile.tsx:219`, `ListingDetail.tsx:1088`): status label only ->
  "Closed"; no change.
- Today server board (`app/src/routes/today.ts:540-567`): scheduled only -
  unaffected.
- Roster actions job (`jobs/rosterActions.ts:164-173`): a closed tour retires
  pending roster actions as `owner_canceled` - unchanged (a pending action on
  a tour 14+ days past its last mark is not a real case).
- Tour reminders job and Send now: refuse rows of a rotated ladder -
  unchanged.
- Conversion route: an auto-closed tour is not convertible - unchanged.
- Contact timeline Upcoming walk (`contactTimeline.ts:1080-1194`): reminder
  rows only - unchanged.
- Seeds: lean has no tours (e2e uses lean). In the full-profile demo world,
  if a worker runs and nobody marks them, seven seeded tours auto-close: the
  matrix's `no_show` pair about 9 and 11 days after a full reseed (past
  `createdAt` / `scheduledAt`, `app/src/lib/seed/matrix.ts:911-916`,
  `:957-963`, marked half an hour after their time, `:1071`), its two
  scheduled tours about 17 and 19 days after (dated 3 and 5 days out,
  `:907-910`, `:953-956`), and `live.ts`'s three scheduled tours (today, +1
  and +2 days on the seed clock, `app/src/lib/seed/live.ts:357-396`) about
  14, 15 and 16 days after - two of those carry the live relay group's
  `groupThreadId`, so the first of them to close arms its close-nag.
  Acceptable for a demo world. The matrix's other tours carry an outcome or a
  non-candidate status; the cast's two tours are never candidates (one
  requested, `app/src/lib/seed/cast.ts:548-561`; the old convertible one,
  `:799-817`, `convertible: true`). No seed change. (Text corrected
  2026-10-04, ruling F5: it used to name only the matrix's no-show tours.)
- Activity vocabularies: 9.5 / 10.1 (`history.ts`' seed vocabulary is NOT
  extended - no auto-closed tours are seeded).

## 13. Rollout and #6

- No migration, no infra, no env var. The new attributes are optional. The
  change ships with the next app + worker deploy.
- First production run, about 15 minutes after the new worker starts: every
  tour that is already more than two weeks past its date (or its creation)
  with no outcome closes, silently. With it:
  - "Tour closed automatically" pins dated the run day on each tour's tenant
    AND landlord timelines, the property activity and the tour activity
    (a landlord with many old tours sees a burst);
  - every never-sent reminder row of those tours (skipped / canceled history)
    is deleted, as on any manual close;
  - relay close-nags are armed on their open relay groups and surface on
    Today about four weeks later;
  - a tenant's "Toured" chip stays only where the tour had been marked toured.
- Preview before deploying (the Past tab is live in production since Sep
  28): the Past tab rows dated more than 14 days ago, minus "Needs placement"
  rows and minus any row a person changed in the last 14 days (marked
  toured / no-show, rescheduled - those keep the rest of their two weeks);
  plus "Undated" rows last changed more than 14 days ago (no screen shows
  that date - roster edits and outcome-only patches move it without a
  history row - so this part of the preview errs safe: it may predict closes
  that will not happen). BLIND SPOT: the Past tab
  covers 90 days and one page of the range read, so older candidates (tours
  from before early July with no outcome) close without appearing there -
  they are on no list today either. Review after the run: the Closed tab,
  newest first, shows each auto-closed tour with the "No outcome recorded"
  badge; any of them can be reopened from its page.
- For #6: auto-close is the exit for "past tour with no outcome". #6 must
  decide explicitly how a `requested` (undated) tour counts, because nothing
  closes those.

## 14. Decisions the planner took alone (overnight)

- D1 Reopen is a dedicated `POST /reopen`, not a PATCH extension: PATCH keeps
  its closed-terminal 409, and a PATCH into toured/no_show/scheduled would
  re-emit "Tour took place" / "Marked no-show" / "Tour scheduled" milestones
  and (into scheduled) arm a ladder for a past time.
- D2 Three new optional attributes (`autoClosedAt`, `autoClosedFrom`,
  `lastMarkedAt`) instead of inferring from activity rows.
- D3 THE CLOCK FLOOR (refines decision 1 - worth Cameron's eye): the clock
  starts at the latest of the tour time, its creation and the last time a
  person marked, rescheduled or reopened it (`lastMarkedAt`; for a tour
  nobody has marked since the deploy, its last change, `updatedAt`). Without
  it, "Mark already toured" with a real date three weeks back (or "Mark
  toured" on day 13, or a mark made the week before the deploy) closes the
  tour within 15 minutes - before anyone can record the outcome. Cost: a tour
  marked toured or no-show after its date closes 14 days after that mark
  rather than 14 days after the date.
- D4 Sweep interval 15 minutes (code constant), candidates read by status.
- D5 Concurrency by field-equality conditions on the close and the reopen,
  plus a status precondition (and a consistent read) on every staff PATCH,
  answering 409 `tour_changed`.
- D6 Legacy closed tours with neither provenance nor a decided outcome are
  refused (`tour_reopen_unsupported`) rather than guessed.
- D7 Reopen asks for confirmation ("Yes, reopen"); it is the primary CTA when
  nothing else is, and the kebab item only when "Start placement" holds the
  primary slot (a convertible tour) - one placement per state.
- D8 The listing-send chip keeps "Toured" for a tour auto-closed from toured.
- D9 The close-nag clear on reopen checks the group's owner when recorded.
- D10 No seed changes; e2e creates tours through the API and scopes every
  tick with `tourIds`.
- D11 The dev tick takes an optional `tourIds` list.
- D12 The Today heading stays "Past tours needing an outcome" (a rename is a
  copy option for Cameron / Sam, not built).
- D13 No manual exit for no-shows (Sam's Sep 30 decision); the issue closes
  by that decision.
- D14 Every writing tour dialog maps a 409 to "This tour changed since the
  page loaded - reload and try again." (the auto-close makes that refusal
  likelier at the two-week boundary, where Today now sends staff to
  reschedule no-shows).

## 15. Issue registry and docs

- `docs/issues/past-tab-no-show-rows-need-an-exit.md`: status resolved, with
  a RESOLVED block that says it closed BY DECISION (Sam, Sep 30: the two-week
  auto-close covers it; no manual exit) and what shipped (no-shows leave the
  Past tab and Today 14 days after their last mark).
- `docs/issues/tours-patch-status-precondition.md`: update block - the
  server-side window is closed (consistent read + status precondition, 409
  `tour_changed`); the client's stale-list window (a list loaded minutes
  ago) remains, guarded by the bulk runner's re-read. Status stays open.
- New issue (Tier 2) for the deferred relay-open race (6.6).
- `docs/issues/tours-scheduled-range-query-unpaginated.md`: note that the
  sweep reads by status, not by range (no status change).
- `documentation/GLOSSARY.md`: an entry for tour auto-close, "No outcome
  recorded", `lastMarkedAt` and reopen.
- `RUNBOOK.md`: a short note under deploy notes on the first production run
  of the auto-close (what it does, how to review it; no operator step).
