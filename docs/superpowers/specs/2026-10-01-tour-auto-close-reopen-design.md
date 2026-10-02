# Tour auto-close and reopen - design

- Date: 2026-10-01
- Branch: `feat/tour-auto-close` (worktree `W:\tmp\tour-auto-close`, cut from main @ae04122d)
- Source: Sam's improvement #18 (remaining part), HousingChoice Improvements Tracker
- Status: DRAFT 1 - under adversarial review. Per Cameron's instruction of
  2026-10-01 the planner approves this spec itself after the review rounds;
  every decision the planner took alone is listed in section 14.

## 1. Summary

A tour that still has no outcome two weeks after its date closes on its own,
with a new outcome "No outcome recorded". Nothing is sent to anyone when that
happens. Any closed tour that did not become a placement can be reopened, to
record a different outcome or to reschedule it. The Today page starts listing
no-shows, because they now leave the list on their own.

Why it matters: improvement #6 (built later) keeps a tenant out of property
blasts while they have a past tour with no outcome, until that tour closes.
The auto-close is the exit that keeps such a tenant from being left out for
long. This change does NOT build #6 or the filterable tour list.

## 2. Decisions (Cameron, 2026-10-01 - "go with your recommendations")

1. **What closes.** Tours never marked toured (status `scheduled`, date
   passed), toured tours with no outcome, and no-shows close exactly 14 days
   (336 hours) after the tour time. An undated toured tour (marked "already
   toured" with the date left blank) closes 14 days after it was last changed.
   Left alone: `requested` tours (no date), `canceled` tours, and "Needs
   placement" tours (toured, move-forward recorded, no placement created).
   The platform never marks anyone a no-show by itself.
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
   the tour page, the tenant timeline and the property activity.
5. **Today lists no-shows** (the filter that hid them goes away).
6. **Rollout.** The plain rule; no grace period and no on/off switch. Deploy
   timing is Cameron's. The handback says how to preview what the first
   production run will close.
7. **"No outcome recorded" is system-only.** Staff cannot pick it; the
   Record outcome dialog keeps its two choices.

Accepted defaults: "two weeks" is exactly 14 days after the tour time;
Reopen lives on the tour page only; the Past tab intro gains one sentence
("Tours with no outcome close on their own two weeks after their date.");
an auto-closed tour shows "Closed automatically on <date>" instead of the
"Moving forward: No" line.

## 3. How tours work today (verified on main @ae04122d)

- Statuses `requested | scheduled | toured | no_show | canceled | closed`
  (`app/src/lib/toursModel.ts:37-44`); outcomes `move_forward | not_a_fit`
  (`toursModel.ts:69-83`). `toursRepo.ts:51-52` carries a hand-copied
  `TourOutcome` union, not derived from the model.
- `PATCH /api/tours/:tourId` (`app/src/routes/tours.ts:1011-1467`):
  - a closed tour refuses every status change with 409 (`:1076-1080`);
  - the exit gate (outcome / moveForward) is accepted only on a toured tour
    (`:1146-1149`), which is what makes a closed tour's outcome immutable;
  - outcome is validated with `isTourOutcome` (`:1047-1049`);
  - a terminal transition (`canceled | closed | toured | no_show`) rotates the
    reminder-ladder pointer in the same write and sweeps unsent rungs
    (`:1221-1235`, `:1354-1390`), then emits `scheduled.updated`;
  - lifecycle activity is written by `recordTourEvent` (`:260-287`), a closure
    inside `createToursRouter`: a person milestone for tenant and landlord
    (`lib/personEvents.ts`), a `units#<unitId>` audit row and a
    `tours#<tourId>` audit row, each best-effort;
  - Cancel or "Not a fit" arms the relay close-nag (`:1453-1458`,
    `services/relayCloseNag.ts:34-60`, 28 days, set-if-absent, open relay
    groups only);
  - every PATCH emits `tour.updated` (`:1463`).
- The PATCH guard does NOT require an outcome to close: `{status:'closed'}` is
  accepted from scheduled, toured, no_show or canceled (`:1073-1128`), and
  `{status:'closed', moveForward:true}` closes a toured tour as convertible
  with no outcome. No dashboard path does either: the Record outcome dialog
  always sends outcome AND moveForward and adds `status:'closed'` only for
  not-a-fit (`dashboard/src/routes/tours/TourDetail.tsx:531-562`,
  `TourModals.tsx:298-301`). So closed-without-outcome tours can exist only
  from direct API use.
- Conversion (`app/src/routes/placements.ts:644-789`) claims the tour with a
  `pending:<uuid>` sentinel in `convertedPlacementId`, creates the placement,
  then writes `status closed + convertedPlacementId + rotated ladder` in one
  update (`:771-775`). It gates on `convertible === true` only (`:661`).
- Reads: `listByStatus` (`app/src/repos/toursRepo.ts:366-385`) pages to
  exhaustion on the `byStatus` GSI (hash `status`, range `createdAt`; includes
  undated tours). `listByScheduledRange` (`:347-364`) reads ONE page and the
  `byScheduledAt` GSI excludes undated tours (issue
  `tours-scheduled-range-query-unpaginated`).
- Worker polls run through `startPoll` (`app/src/jobs/pollLoop.ts:53-73`,
  wired in `app/src/worker.ts` around `:289-350`) on
  `config.workerPollIntervalMs` (default 30000, `lib/config.ts:609`). The app
  process starts no polls. Dev tick seams live in the APP process
  (`app/src/routes/dev.ts`, e.g. `POST /__dev/tour-reminders/tick` at
  `:405-426`, optional `body.now`). Worker events reach the dashboard SSE
  through the event bridge (`lib/events.ts:294-325`, `lib/eventBridge.ts`).
- The hermetic e2e lane runs the REAL worker on a 30 s poll
  (`e2e/playwright.config.ts:184`, `scripts/e2e-session.mjs:247-252`).
- Dashboard:
  - Tours page tabs Active / Past / Closed (`ToursPage.tsx:569-595`). Past
    selection: `selectPastTours` + `selectOffRangeTours`
    (`useTours.ts:198-250`). Closed tab: closed + canceled, rows show date,
    status and type only (`ToursPage.tsx:124-158`, `:778-799`).
  - Today's "Past tours needing an outcome": `useTodayPastTours` uses the
    Past tab's loader, then `selectTodayPastTours` drops no-shows because they
    had no way off the list (`useTours.ts:252-263`), cap 5.
  - Tour page: primary CTA ladder has nothing for a closed unconverted tour
    (`TourDetail.tsx:570-601`); the Outcome card shows the outcome label and
    "Moving forward: Yes/No" (`:790-806`).
- Activity vocabulary: `ActivityEventType` (`app/src/repos/activityEventsRepo.ts:31-59`)
  mirrored by `TimelineMilestoneType` (`dashboard/src/api/types.ts:2495-2517`);
  labels in `dashboard/src/routes/tours/tourActivityFormat.ts:14-23` (tour
  page), `dashboard/src/routes/listing/listingFormat.ts:114-121` (property;
  an unknown type loses its /tours link), colour in
  `dashboard/src/routes/contact/Timeline.tsx` (around `:428-444`). The person
  timeline label is server-owned and passed through.
- The listing-send "tour chip" (`app/src/lib/listingSendTour.ts:50-57`) treats
  an unconverted closed tour as no signal.
- No-shows have no exit today (issue `past-tab-no-show-rows-need-an-exit`):
  the tour page offers Reschedule and the no-show check-in only; Cancel is
  shown for requested/scheduled (`TourDetail.tsx:92-99`).

## 4. Goals and non-goals

Goals: sections 5-11.

Non-goals (do NOT build): #6 blast filtering; the filterable tour list; a
calendar; letting staff pick "No outcome recorded"; reopening canceled tours
(already revivable through Reschedule); a new relay group for a reopened tour
whose group was closed; server-derived close on not-a-fit (issue
`tour-outcome-close-not-backend-enforced` stays open); paginating
`listByScheduledRange`; any GSI, table or infra change; any seed change.

## 5. Model changes

### 5.1 Outcome

- `TOUR_OUTCOMES = ['move_forward', 'not_a_fit', 'no_outcome']`,
  label `no_outcome: 'No outcome recorded'`.
- New `STAFF_TOUR_OUTCOMES = ['move_forward', 'not_a_fit']` +
  `isStaffTourOutcome`. The PATCH route validates with the STAFF guard, so
  `{outcome:'no_outcome'}` is a 400 whose text lists the two staff values.
- `toursRepo.ts`'s hand-copied `TourOutcome` union imports the model's type
  instead (or gains the member) so the two cannot drift.

### 5.2 New optional tour attributes (no migration, no GSI change)

| attribute | written by | meaning |
|---|---|---|
| `autoClosedAt` | auto-close | ISO instant the sweep closed the tour |
| `autoClosedFrom` | auto-close | the status it closed from: `scheduled`, `toured` or `no_show` |
| `reopenedAt` | reopen | ISO instant of the latest reopen |

Reopen removes `autoClosedAt` and `autoClosedFrom`; nothing removes
`reopenedAt` (only a later reopen overwrites it).

### 5.3 The two-week clock (pure, in `toursModel.ts`)

`AUTO_CLOSE_AFTER_MS = 14 * 24 * 60 * 60 * 1000`.

`autoCloseDueAtMs(tour)` returns the epoch-ms instant a tour becomes due, or
`null` when it is not a candidate at all:

- candidate statuses: `scheduled`, `toured`, `no_show`; anything else -> null;
- `outcome` present -> null (covers "Needs placement" and any decided tour);
- `convertible === true` -> null; `convertedPlacementId` is any string
  (including a `pending:` claim) -> null;
- clock start = `scheduledAt` when present, else `updatedAt` (only an undated
  toured tour reaches this branch; an undated scheduled/no_show tour cannot
  exist through the API, and gets null defensively);
- `reopenedAt`, when present and LATER than the clock start, replaces it;
- due = clock start + `AUTO_CLOSE_AFTER_MS`. Unparseable instants -> null.

A tour is closed by the sweep when `due <= now`.

## 6. The auto-close sweep

### 6.1 Where it runs

- New job module `app/src/jobs/tourAutoClose.ts` exporting
  `runTourAutoClose(nowIso, deps)`.
- Worker: started beside the other polls in `worker.ts`, on its OWN
  interval constant `TOUR_AUTO_CLOSE_INTERVAL_MS = 15 * 60 * 1000` (a code
  constant, not an env var). The worker's local `startPoll` wrapper
  (`worker.ts:289-295`) binds `config.workerPollIntervalMs` for every call
  site, so this poll goes through `jobs/pollLoop.ts`'s `startPoll` with its
  own `intervalMs` (or the wrapper gains an optional interval argument) -
  same logger, same `bootContext`. A two-week rule does not need a 30 s cadence, and the longer
  interval keeps the e2e lane's real worker from closing spec-created tours
  every 30 s.
- Dev seam: `POST /__dev/tour-auto-close/tick` in `app/src/routes/dev.ts`,
  hermetic-only like its siblings, optional `body.now` (ISO; validated and
  normalized exactly like the tour-reminders tick), deps built to mirror the
  worker. Response: the run summary (6.4).

### 6.2 Candidates

`listByStatus('scheduled')`, `listByStatus('toured')`,
`listByStatus('no_show')` (each pages to exhaustion), filtered by
`autoCloseDueAtMs(tour) !== null && due <= now`. Never the scheduled-range
read (one page, no undated tours).

### 6.3 The close write (one conditional update per tour)

New repo method `toursRepo.autoCloseIf(tour, { nowIso, rotation })`:

- SET `status = 'closed'`, `outcome = 'no_outcome'`,
  `autoClosedFrom = <tour.status as read>`, `autoClosedAt = nowIso`,
  `currentLadderId = rotation`, `updatedAt = nowIso`;
- CONDITION: `status = <status as read>` AND `attribute_not_exists(outcome)`
  AND `attribute_not_exists(convertedPlacementId)` AND `updatedAt = <updatedAt
  as read>`;
- returns the updated item, or `undefined` on `ConditionalCheckFailedException`
  (a staff change landed between the read and the write - the staff change
  wins, the sweep skips the tour this run and re-evaluates it next run).

`rotation` is a fresh UUID: the pointer then names a ladder no row carries,
which is how "no live ladder" is expressed (same as the PATCH terminal
branch). The sweep never touches `moveForward` or `convertible` (both absent
on every candidate).

### 6.4 After a won close (each step best-effort; a failure is logged with the tourId and the run continues)

1. `tourReminders.deleteSupersededForTour(tourId, rotation)` - removes any
   never-sent rung (normally none: every rung is before the tour time).
2. The shared tour-event writer (section 10.1) with type `tour_auto_closed`.
3. `armRelayCloseNagIfOpen(deps, tour.groupThreadId, 'tour')`.
4. Emit `tour.updated` `{ tourId, status: 'closed' }` and
   `scheduled.updated` `{ contactId: tenantId }`.

Summary returned (and logged at info ONLY when `closed > 0`):
`{ scanned, due, closed, lost }`. One info line per closed tour with
`tourId` and `from` status. PII: ids only.

### 6.5 What the sweep never does

It never sends a message, never calls a messaging adapter, never marks a
no-show, never changes tenant status, never touches placements, and never
closes a tour with an outcome, a conversion (claimed or finished), a
`convertible` flag, or status requested/canceled/closed.

### 6.6 Concurrency

Two sweeps (worker + dev tick, or two workers) can race; the condition makes
the close exactly-once and only the winner runs 6.4. A staff PATCH racing the
sweep: whichever write lands first wins; a staff write after the close meets
the existing closed-terminal 409 (the operator reloads and sees the closed
tour with Reopen).

## 7. Reopen

### 7.1 API

`POST /api/tours/:tourId/reopen` - staff route (same auth posture as the
other tour routes), empty body (any field -> 400 `unknown field(s)`).

| result | when |
|---|---|
| 200 `{ tour }` | reopened |
| 404 `tour_not_found` | no such tour |
| 409 `tour_not_closed` | status is not `closed` |
| 409 `tour_converted` | `convertedPlacementId` is any string (finished or `pending:`) |
| 409 `tour_reopen_unsupported` | closed with no `autoClosedFrom` and no `not_a_fit`/`move_forward` outcome (API-only legacy rows) |
| 409 `tour_changed` | the conditional write lost to a concurrent change |

### 7.2 Target status

- `autoClosedFrom` when present (`scheduled`, `toured` or `no_show`);
- else `toured` when `outcome` is `not_a_fit` or `move_forward`;
- else refuse (`tour_reopen_unsupported`).

### 7.3 The write (new repo method `toursRepo.reopenIf(tour, target, nowIso)`)

- SET `status = target`, `reopenedAt = nowIso`, `updatedAt = nowIso`;
  REMOVE `outcome`, `moveForward`, `convertible`, `autoClosedAt`,
  `autoClosedFrom`;
- CONDITION: `status = 'closed'` AND `attribute_not_exists(convertedPlacementId)`
  AND `updatedAt = <updatedAt as read>`;
- the read before it is a CONSISTENT read.
- `currentLadderId` is left as is (it names no live rows). No reminder is
  armed - not even when the target is `scheduled`, whose time is in the past.

### 7.4 Side effects (best-effort, never fail the 200)

1. Shared tour-event writer with type `tour_reopened`.
2. Clear the close-nag: when `tour.groupThreadId` names a conversation that is
   a `relay_group`, `status === 'open'`, has `close_nag_next_at`, and whose
   `owner` (when recorded) is `{ type: 'tour', id: tourId }`:
   `conversationsRepo.setCloseNagNextAt(id, null)`.
3. Emit `tour.updated` `{ tourId, status: target }`.

No message, no reminder, no tenant-status change, no placement change, no
roster change. The PATCH route is NOT changed to allow leaving `closed`:
reopen is the only way out.

### 7.5 After a reopen

The tour behaves exactly like any tour in its target status: toured ->
Record outcome; no_show -> Reschedule / no-show check-in; scheduled (past) ->
Mark toured / Mark no-show / Reschedule, and it is "Not marked" on the Past
tab. The two-week clock restarts from `reopenedAt` (5.3).

## 8. Staff PATCH changes

Only: validation uses `isStaffTourOutcome` (5.1). Everything else in the
PATCH handler is unchanged, including the closed-terminal 409 and the exit
gate on toured.

## 9. Dashboard

### 9.1 Types and API client (`dashboard/src/api/`)

- `TourOutcome` gains `'no_outcome'`; `TOUR_OUTCOME_LABELS.no_outcome =
  'No outcome recorded'`.
- `Tour` gains optional `autoClosedAt`, `autoClosedFrom`, `reopenedAt`.
- New `reopenTour(tourId): Promise<Tour>` (POST `/api/tours/:tourId/reopen`).
- `TimelineMilestoneType` gains `tour_auto_closed` and `tour_reopened`.
- The Record outcome dialog keeps exactly two choices (unchanged).

### 9.2 Tour page (`TourDetail.tsx`)

- Reopenable = status `closed`, no `convertedPlacementId` string, and
  (`autoClosedFrom` set OR outcome is `not_a_fit`/`move_forward`) - the
  server's 7.1/7.2 rule.
- Primary CTA on a reopenable tour: "Reopen tour". It opens a confirm dialog
  that says where the tour goes and that nothing is sent:
  - to toured: "This tour goes back to Toured so you can record a different
    outcome. Nothing is sent."
  - to no_show: "This tour goes back to No show so you can reschedule it.
    Nothing is sent."
  - to scheduled: "This tour goes back to Not marked so you can mark it
    toured or a no-show, or reschedule it. Nothing is sent."
  On confirm: `reopenTour`, apply the returned tour; when the new status is
  `toured`, open the Record outcome dialog (as Mark toured does). An error
  stays in the dialog. A converted tour keeps "View placement" and shows no
  Reopen.
- Outcome card for `no_outcome`: "Outcome: No outcome recorded" and
  "Closed automatically on <short date of autoClosedAt>" in place of
  "Moving forward". Other outcomes unchanged.

### 9.3 Tours page (`ToursPage.tsx`)

- Closed tab rows: a closed tour with an outcome shows the outcome label as
  one more badge (so "No outcome recorded" and "Not a fit" read apart).
- Closed tab intro: "Tours that ended - converted into a placement, closed as
  not a fit, closed automatically with no outcome, or canceled."
- Past tab intro: append "Tours with no outcome close on their own two weeks
  after their date."
- Past selection is unchanged; a reopened tour reappears by the existing
  rules.

### 9.4 Today

`selectTodayPastTours` no longer drops no-shows (Today lists the Past tab's
rows, capped at 5, most recent first). A no-show row shows "No show" and
links to the tour page without `?outcome=1`. Its comment and tests change
with it.

### 9.5 Activity rendering

- Tour page (`tourActivityFormat.ts`): `tour_auto_closed` -> "Closed
  automatically: no outcome recorded after two weeks"; `tour_reopened` ->
  "Tour reopened"; pin colours `tour_auto_closed -> tour_outcome`,
  `tour_reopened -> tour_scheduled`.
- Property (`listingFormat.ts` TOUR_LABELS): "Tour closed automatically: no
  outcome recorded after two weeks", "Tour reopened" (keeps the /tours link).
- Contact timeline: the server-owned labels in 10.1; `Timeline.tsx` colour
  cases for the two new types.

## 10. Activity, events and the close-nag

### 10.1 The shared tour-event writer

`recordTourEvent` moves out of the `createToursRouter` closure into a module
(for example `app/src/lib/tourEvents.ts`) taking explicit deps
`{ activityEvents, units, audit, log }`. The router, the sweep and the reopen
route all call it. Existing callers' behavior is byte-for-byte unchanged
(same three writes, same order, same best-effort guards).

New types (added to `ActivityEventType`, persisted as both the activity type
and the audit `event_type`):

| type | person-timeline label |
|---|---|
| `tour_auto_closed` | "Tour closed automatically: no outcome recorded after two weeks" |
| `tour_reopened` | "Tour reopened" |

Rows written by the dev tick are stamped with the wall clock, not the
injected `now` (`auditRepo` and `personEvents` stamp their own time).
Accepted: tests assert on state and labels, not activity timestamps.

### 10.2 Events

`tour.updated` and `scheduled.updated` from the worker reach the dashboard
through the existing event bridge; the tour page, Past tab and Today already
refetch on `tour.updated`.

## 11. Tests and e2e

- Model: `autoCloseDueAtMs` truth table (each status, outcome present,
  convertible, converted, `pending:` claim, undated toured, reopenedAt later
  and earlier than the date, exact 14-day boundary, unparseable instants);
  `TOUR_OUTCOMES` / labels / `STAFF_TOUR_OUTCOMES` pins.
- Repo (DynamoDB Local): `autoCloseIf` wins on an untouched candidate and
  loses on each of: status changed, outcome set, conversion claimed,
  updatedAt changed. `reopenIf` wins, removes the five attributes, sets
  `reopenedAt`, and loses on a converted / changed tour.
- Job: closes only due candidates; never sends (no messaging dep exists in
  its deps); arms the nag only on an open relay group without a nag; emits
  both events; a lost write runs no side effects; a side-effect failure does
  not stop the run.
- Route: every 7.1 row; PATCH `{outcome:'no_outcome'}` is 400; existing
  closed-terminal pins still hold.
- Dashboard: reopen CTA visibility matrix (auto-closed from each status,
  not-a-fit, converted, pending claim, closed with no outcome), dialog copy,
  chaining into Record outcome, Outcome card for no_outcome, Closed-tab badge,
  Today includes no-shows, activity labels.
- e2e (new spec, now-relative dates, accessibility-first selectors):
  1. Create a tour dated 20 days ago via the API (the create texts nobody:
     past-dated rungs are written as `booked_too_late` skipped rows); drive
     `POST /__dev/tour-auto-close/tick`; the tour is closed with "No outcome
     recorded" - assert the END STATE, because the lane's real worker may
     close it first; the Closed tab shows the badge; the tour page shows
     "Closed automatically on"; nothing was sent (fake Twilio thread store
     unchanged for the tenant and landlord).
  2. Reopen it from the tour page: back to "Not marked" on the Past tab; a
     tick at the current time leaves it open; a tick with `now` 15 days ahead
     closes it again.
  3. A toured tour closed as "Not a fit": Reopen lands in Record outcome.
  4. A no-show dated within two weeks is listed on Today.
- Existing fixed-date e2e specs that a real sweep could race are moved to
  now-relative dates inside the two-week window:
  `e2e/tests/dashboard-next/listing-activity.spec.ts:118` (2026-09-15, then
  canceled - a sweep landing between create and cancel turns the cancel into
  a 409), `:237` (2026-10-01, asserts a "Tour scheduled" chip) and
  `e2e/tests/dashboard-next/landlord-activity.spec.ts:97` (2026-09-20, then
  canceled). These are the only fixed `scheduledAt` literals under
  `e2e/tests` and `e2e/fixtures` on main @ae04122d.
- The performance profiler's mutation catalog
  (`e2e/performance/mutationCatalog.ts`) gains the new `reopenTour` client
  function (its AST two-way match fails otherwise).

## 12. Invariants and every surface

Invariant changed: "closed is terminal" becomes "closed is terminal except
through `POST /reopen`". Invariant added: "a tour carrying `no_outcome` was
closed by the sweep and carries `autoClosedAt` + `autoClosedFrom` until a
reopen removes all three".

Writers of tour status/outcome after this change: tour create (POST), PATCH
(unchanged except validation), conversion finalize (`placements.ts:771`),
relay/roster routes (status untouched), the sweep (new), reopen (new), seeds
(unchanged), dev reseed (unchanged). Nothing else may write `no_outcome`,
`autoClosedAt`, `autoClosedFrom` or `reopenedAt`.

Readers that must agree with the new states:

- Past tab / Today selection (`useTours.ts`): auto-closed tours are `closed`
  and drop off; reopened tours come back by status - no change needed.
- Closed tab (`useClosedTours`): lists auto-closed tours; badge per 9.3.
- Tour page CTA ladder, kebab guards, Outcome card, conversation pane
  (`groupDead` for closed) - per 9.2; a reopened tour is no longer
  `groupDead`.
- Listing-send chip (`listingSendTour.ts`): an auto-closed tour is an
  unconverted closed tour -> no chip (unchanged rule, same as not-a-fit).
- Today server board (`app/src/routes/today.ts:540-567`): scheduled only -
  unaffected.
- Roster actions job (`jobs/rosterActions.ts:164-173`): a closed tour retires
  pending roster actions as `owner_canceled` - unchanged (a pending action on
  a tour 14+ days past its date is not a real case).
- Tour reminders job: refuses rows of a rotated ladder - unchanged.
- Conversion route: an auto-closed tour is not convertible - unchanged.
- Contact timeline Upcoming walk (`contactTimeline.ts:1080-1194`): reminder
  rows only - unchanged.
- Seeds: full-profile tours are all inside two weeks except the cast's
  convertible tour (`app/src/lib/seed/cast.ts:799-817`), which the candidate
  rule excludes (convertible). Lean has no tours. No seed change.
- Activity vocabularies: section 9.5 / 10.1 (+ `history.ts` seed
  vocabulary is NOT extended - no auto-closed tours are seeded).

## 13. Rollout and #6

- No migration, no infra, no env var. The new attributes are optional. The
  change ships with the next app + worker deploy.
- First production run: about 15 minutes after the new worker starts, every
  tour that is already more than two weeks past with no outcome closes,
  silently, with relay close-nags armed on their open groups (they surface on
  Today about four weeks later). Preview beforehand: the Tours page Past tab's
  rows dated more than 14 days ago, minus "Needs placement" rows; plus toured
  "Undated" rows not changed in 14 days. Each closed tour can be reopened.
- For #6: auto-close is the exit for "past tour with no outcome". #6 must
  decide explicitly how a `requested` (undated) tour counts, because nothing
  closes those.

## 14. Decisions the planner took alone (overnight)

- D1 Reopen is a dedicated `POST /reopen`, not a PATCH extension: PATCH keeps
  its closed-terminal 409, and a PATCH into toured/no_show/scheduled would
  re-emit "Tour took place" / "Marked no-show" / "Tour scheduled" milestones
  and (into scheduled) arm a ladder for a past time.
- D2 Three new optional attributes (`autoClosedAt`, `autoClosedFrom`,
  `reopenedAt`) instead of inferring from activity rows.
- D3 Undated toured clock = `updatedAt` (as the Past tab already does for
  those rows); the dated clock ignores `updatedAt`, so unrelated writes never
  postpone a dated tour.
- D4 Sweep interval 15 minutes (code constant), candidate read by status.
- D5 Conditional writes on `updatedAt` equality for both the close and the
  reopen.
- D6 Legacy closed tours with neither provenance nor a decided outcome are
  refused (`tour_reopen_unsupported`) rather than guessed.
- D7 Reopen asks for confirmation in a dialog; it is on the tour page only.
- D8 The listing-send chip rule is unchanged (auto-closed = no chip).
- D9 Close-nag clear on reopen checks the group's owner when recorded.
- D10 No seed changes; e2e creates past-dated tours through the API.
- D11 Fixed-date e2e specs move to now-relative dates.

## 15. Issue registry

- Resolve `docs/issues/past-tab-no-show-rows-need-an-exit.md` (add a
  RESOLVED block pointing at this spec; status closed).
- Note on `tours-scheduled-range-query-unpaginated.md` that the sweep reads
  by status, not by range (no change to its status).
- GLOSSARY: add an entry for tour auto-close / "No outcome recorded" /
  reopen.
