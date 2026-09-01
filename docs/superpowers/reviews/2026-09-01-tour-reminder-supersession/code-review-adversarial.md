# Adversarial code review - feat/tour-reminder-supersession @65c19506

Reviewer: fresh-eyes adversarial pass. Merge base `f27aabbf`. Worktree
`W:\tmp\tour-reminder-supersession`. No commits made; two throwaway probe tests
were written, run, and deleted.

Method: read the full diff, then swept the whole repo for consumers/mutators of
every field, contract and event the diff touches; walked the concurrency claims
as concrete interleavings; reproduced two of them against the in-memory harness
(`app/test/helpers/twilioWebhookHarness.ts`) with `npx vitest run`.

Counts: 1 BLOCKING, 3 MAJOR, 4 MINOR, 5 NOTE.

---

## BLOCKING

### B1. Two concurrent reschedules can leave the tour scheduled with ZERO reminders - the compare-and-set does not fix the case it was built for

Evidence: **REPRODUCED** (throwaway vitest against the harness, deleted).

Sites:
- `app/src/routes/tours.ts:1240` - `await reminders.deleteSupersededForTour(tourId)`
- `app/src/routes/tours.ts:1266` - `await tours.setLadderIdIf(tourId, rotation, ladderId)`
- `app/src/repos/tourRemindersRepo.ts:469-506` - the sweep's ONLY filter is
  `r.sentAt === undefined`; it is generation-blind.
- `app/src/repos/toursRepo.ts:478-511` - `setLadderIdIf` guards only the POINTER write.

The PATCH re-arm is four store operations with no mutual exclusion:
`patch(rotation)` -> `sweep` -> `arm` -> `CAS(rotation -> ladderId)`. The CAS
protects step 4. Nothing protects step 2, and step 2 deletes every unsent rung of
the tour regardless of which generation wrote it.

Interleaving (A and B are two PATCHes on one tour):

1. A: `tours.patch` writes `currentLadderId = R_A`.
2. B: `tours.patch` writes `currentLadderId = R_B`, and `scheduledAt = T_B`.
3. B: sweep (nothing of B's to lose), arm writes ladder `L_B`, CAS
   `R_B -> L_B` WINS. B returns 200 with a correct, live ladder.
4. A: sweep runs now - and **deletes `L_B`'s rows**, because they have no `sentAt`.
5. A: arm writes ladder `L_A`.
6. A: CAS expects `R_A`, finds `L_B`, loses. A logs
   `pointer write lost a concurrent reschedule` and returns 200.

End state, measured:

```
statusA: 200, statusB: 200
storedScheduledAt: T_B                      (B's time - correct)
pointer:  '31cef026-...'  == B's ladderId   (names a generation with NO rows)
rowLadderIds: [ '4c36ff88-...' ]            (A's ladder only)
rowsMatchingPointer: 0
totalRows: 3
```

The tour is `scheduled` for `T_B`, points at a ladder that does not exist, and
carries three rows that every send path refuses. **Nothing will ever fire.** Two
200s. The only log line is A's, and it says "*this* ladder is unpointed", which
describes the harmless half; nothing reports that the winner's ladder was
deleted. The panel shows `reminders: []` plus an `Earlier reminders (3)`
disclosure, which reads like a tour that was correctly retired.

This is precisely the outcome `setLadderIdIf`'s own docstring
(`app/src/repos/toursRepo.ts:202-212`) claims to prevent: *"two 200s, a silently
disarmed tour, no error."*

Why the existing test does not catch it: `app/test/toursApi.test.ts:1850`
("CONCURRENT RESCHEDULES") parks A **inside its arm**, i.e. past its own sweep.
Its comment says so - *"A's arm is parked past B's sweep, so neither sweep can
reach the other's rows"*. That is the benign half of the interleaving space. Park
A at its **sweep** instead and the branch's central safety property fails. The
test currently supplies false confidence.

The ordering comment at `app/src/routes/tours.ts:1228-1239` names the root cause
without following it through: *"It must therefore run BEFORE the arm: sweeping
after would delete the ladder we just armed, since the only filter is 'never
sent'."* Ordering is not a substitute for a predicate - it only works while there
is one writer.

Fix directions (either alone closes it):
- Give the sweep an exclusion: `deleteSupersededForTour(tourId, { exceptLadderId })`
  with a per-row condition `attribute_not_exists(ladderId) OR ladderId <> :except`,
  and move it AFTER the arm. A concurrent request's newer ladder then survives.
- Or make the sweep conditional on still owning the rotation: re-read
  `currentLadderId` immediately before the sweep (or fold the sweep behind a
  successful CAS) and abandon the whole re-arm when the rotation no longer
  stands, returning the winner's tour.

The same hole exists between a PATCH re-arm and `POST /api/placements/from-tour`
(`app/src/routes/placements.ts:799`), whose sweep is likewise generation-blind.

---

## MAJOR

### M1. "Send now" ignores an in-flight or stalled placement-conversion claim that the poll defers on

Evidence: traced (grep-verified: `pending:` appears in `app/src/jobs/tourReminders.ts`
only at :320, :842, :1127, :1132 - all inside `processReminderRow` or its
comments; `forceSendReminder` at :1722 has no such check).

`processReminderRow` (`app/src/jobs/tourReminders.ts:1128-1152`) defers every rung of
a tour carrying a `pending:` conversion sentinel. `forceSendReminder`
(`app/src/jobs/tourReminders.ts:1722-1830`) checks `kind_retired`, then reads the
tour, then checks `tour_missing` and `isSupersededRung` - and never looks at
`convertedPlacementId`.

Scenario: an operator opens the Reminders panel while a colleague converts the
tour, or at any time after a conversion crashed between `claimConversion` and
the finalize (the sentinel has no TTL - the branch says so at
`app/src/jobs/tourReminders.ts:318-322`). Send now composes and fires the rung. If the
conversion later succeeds on retry, a tenant has been texted "your tour is
tomorrow" for a tour that is now a placement.

This is a REGRESSION of the reordering, not pre-existing: before this branch
`from-tour` canceled the reminders at step 3, **before** `placements.create`
(`app/src/routes/placements.ts`, removed hunk), so `canceledAt` blocked
`claimSend` for the whole remainder of the conversion. The window is now the
entire conversion, and unbounded for a stalled one.

The same gap sits on the three preview surfaces: none of them consults the
sentinel, so `routes/tourReminders.ts`, `routes/contactTimeline.ts` and
`routes/relayGroups.ts` all keep promising "sends in Nh" for rungs the poll is
deferring. `lib/ladderPointer.ts:4-9` argues that a refusal reason must be shared
by all four sites; the second refusal reason this branch introduces has exactly
one enforcement site.

### M2. The `conversion_stalled` grace is measured from `dueAt`, so a rung deferred for quiet hours is retired IMMEDIATELY - under a false reason, terminally - by a perfectly healthy conversion

Evidence: traced.

- `app/src/jobs/tourReminders.ts:336-341` - `conversionClaimExpired(dueAt, now)` returns
  `now - Date.parse(dueAt) > CONVERSION_CLAIM_GRACE_MS` (1h).
- `app/src/jobs/tourReminders.ts:1133-1142` - on expiry, `claimSkipRow(row, 'conversion_stalled', ...)`
  plus `log.error('... STILL unresolved past the grace window - retiring')`.

The comment at :313-327 states the intent: bound how long we wait for the CLAIM.
The implementation bounds something else entirely, because the row carries no
claim-start stamp (the comment admits this). The predicate is therefore already
true at t=0 for any rung that has been pending for more than an hour past its
own due time - and that is a routine state, not an outage:

- A quiet-hours-deferred rung. The quiet-hours backstop leaves the row UNCLAIMED
  and re-lists it every tick until quiet-end, and the conversion check sits
  ABOVE it (`:1128` vs. the quiet-hours block below `:1170`). A `day_before`
  rung due 21:00 that is deferred to 08:00 is 1h+ overdue by 22:01.
- A rung waiting out `ROSTER_UNAVAILABLE_GRACE_MS` / `names_unavailable`.
- Any worker downtime (deploy, restart, DDB throttle) longer than an hour.

An operator then converts the tour. Within the few-millisecond claim window the
next poll tick stamps the rung `skippedAt` + `conversion_stalled` - terminal,
and `uncancel` cannot undo a `skippedAt` - and emits an ERROR log for a
conversion that is proceeding normally.

Harm ranking:
- Conversion succeeds: the finalize's sweep deletes the row anyway. Cost is a
  false ERROR page and a misleading log.
- Conversion FAILS (create throws -> `releaseConversionClaim`, the branch's own
  documented retryable path at `app/src/routes/placements.ts:691-706`): the tour
  goes back to normal, but the rung is permanently retired with
  `the placement conversion never finished` (`dashboard/src/api/types.ts:1377`).
  A rung that would have sent is gone, blamed on something that did not happen.

Fix: either stamp a claim-start time when `claimConversion` writes the sentinel
and measure from that, or measure from the poll's own first sighting, or (
cheapest) raise the bar to `max(dueAt, firstDeferralAt)` by refusing to expire a
rung whose deferral began this tick.

### M3. Any unrelated PATCH on an already-terminal tour rotates the pointer and hard-deletes its surviving unsent rungs

Evidence: **REPRODUCED** (throwaway vitest, deleted).

Sites: `app/src/routes/tours.ts:1191` (`effectiveStatus = patch['status'] ?? currentStatus`),
`:1199-1203` (`terminal`), `:1211` (rotation written), `:1295` (sweep).

`terminal` is derived from the EFFECTIVE status, which for a PATCH that carries
no `status` is the tour's CURRENT one. So the exit-gate PATCH
(`{ outcome, moveForward }`, the normal navigator flow on a `toured` tour -
see `app/src/routes/tours.ts:1176`) takes the terminal branch: mints a fresh
`currentLadderId`, writes it, sweeps, and emits `scheduled.updated`.

Measured on a `toured` tour holding one pre-migration `canceledAt` rung and one
`sentAt` rung, then PATCHed with `{ outcome: 'move_forward', moveForward: true }`:

```
status: 200
pointerRotatedByUnrelatedPatch: true      (a NEW uuid on a tour nothing re-armed)
legacyCanceledStillThere: false           (HARD-DELETED)
legacySentStillThere:     true
remainingRows: [ 'legacy-sent' ]
```

Two consequences:

1. **Silent destruction of pre-migration reminder history.** Every tour retired
   before this deploy kept its rungs as `canceledAt` rows (the old
   `cancelForTour`). The first unrelated PATCH after deploy erases them all.
   Nothing was superseded here - the tour was already terminal and its ladder
   already dead - so the sweep's own justification ("an operator looking at a
   superseded ladder is looking at debris",
   `app/src/repos/tourRemindersRepo.ts:210-215`) does not apply. There is no
   migration note, no backfill and no RUNBOOK entry (see N5).
2. Pointer churn: an `updatedAt` bump, a pointer write and an SSE
   `scheduled.updated` on every note/outcome edit of every completed tour, in
   perpetuity.

Fix: gate the terminal branch on an actual TRANSITION -
`terminal && currentStatus !== effectiveStatus` - which is the same shape the
audit emits below it already use (`app/src/routes/tours.ts:1326-1337`).

---

## MINOR

### m1. The single-row PATCH and Send-now responses recompose a superseded rung's body against the tour's CURRENT schedule

Evidence: traced.

Sites: `app/src/routes/tourReminders.ts:460`, `:470` (PATCH cancel/restore),
`:539`, `:550` (send-now 200 and 409). All call
`viewOf(after, bodyFor(after, tour, ...))`.

`TourReminderEarlierView` exists for exactly one reason, stated at
`app/src/routes/tourReminders.ts:164-175`: `bodyFor` recomposes live for any row
without a `sentAt`+`sentBody` pair, and for a superseded generation that means
"printing a sentence about a schedule that never existed". The list GET is
careful about this. The two single-row responses are not, and both are reachable
on an earlier rung: the disclosure's Cancel button
(`dashboard/src/routes/tours/RemindersPanel.tsx:579-588`) hits the PATCH path, and
the send-now 409 `superseded` refusal echoes the same recomposed view.

Invisible today only because `onToggleCanceled`
(`dashboard/src/routes/tours/RemindersPanel.tsx:321-338`) discards the response
and refetches. The API contract is still wrong, and any second consumer that
renders the echoed view gets the lie the branch set out to end.

### m2. Timeline: when the Upcoming block unmounts while the operator is standing on it, the next message jumps the stream and suppresses the "New messages" pill

Evidence: traced.

Sites: `dashboard/src/routes/contact/Timeline.tsx:1845` (`bottomGapRef`),
`:1861-1868` (the ResizeObserver effect, keyed on `hasUpcomingBlock`),
`:1981-1986` (the `below` branch), `:1997` (deps: `clusters`, `resetScrollKey`,
`paging?.olderPagesLoaded`, `blockResizeTick` - no `upcoming` / `hasUpcomingBlock`).

Walk:
1. Operator scrolls down onto the Upcoming block. `anchorRef = 'below'`,
   `bottomGapRef = scrollHeight - scrollTop`, which INCLUDES the block's height.
2. A `scheduled.updated` refetch empties `upcoming` - which is this feature's own
   commonest event, since a reschedule/terminal/convert now DELETES the rows the
   bucket was rendering. The `<section>` unmounts.
3. The ResizeObserver effect cleans up (`ro.disconnect()`); nothing calls
   `setBlockResizeTick`, and the layout effect has no dep that changed, so no
   re-pin runs. `anchorRef` is still `'below'` and `bottomGapRef` is stale by the
   block's height.
4. The next inbound message arrives. The layout effect takes the `'below'`
   branch: `el.scrollTop = el.scrollHeight - bottomGapRef.current`, which lands
   roughly one block-height too high, scrolling the operator UP and away from the
   newest message - and `setHasNewBelow(false)` on the same line suppresses the
   pill that exists for precisely this situation.

Self-corrects on the operator's next scroll, so it is a nuisance rather than a
loss, but it is a new one: pre-branch the block lived outside the scroller and
its unmount could not desynchronise the anchor.

Fix: add `hasUpcomingBlock` to the layout effect's dep list (the anchor's
derivation already takes it as an input), or re-derive `anchorRef` from
`currentAnchor(el)` at the top of the layout effect rather than trusting the
value cached at the last scroll event.

### m3. The demo seed models a state the product can no longer produce: a `canceledAt` rung on a superseded generation

Sites: `app/src/lib/seed/matrix.ts:984-986` (a canceled tour points at
`${ladderId}-rotated`) and `:1037-1052` (its `day_before` row keeps the unrotated
`ladderId` AND a `canceledAt`).

That row is superseded and canceled at once. In production
`app/src/routes/tours.ts:1295` hard-deletes exactly that row on the terminal
transition, so the demo world shows a "Canceled" chip inside `Earlier reminders`
that the real product erases. Either seed it as deleted (omit the row) or seed
the pointer un-rotated for that tour; as written the seed teaches operators and
e2e authors a shape that cannot occur.

Related: `app/test/seedMatrixCoherence.test.ts` has no invariant pairing a seeded
row's `ladderId` with its tour's `currentLadderId`, so a future edit to
`matrix.ts:980-986` can silently make the whole seeded world read as superseded
with no test failure.

### m4. Stale prose that now names removed functions and superseded mechanisms

- `app/scripts/retire-paused-tour-reminders.ts:30-32, 194-198, 277-279, 287-290`
  enumerate the concurrent-writer set as "sent/canceled/skipped". **Deleted** is
  now a fourth outcome, and it is exactly what `attribute_exists(reminderId)` at
  `:206` defends against - a clause that was near-decorative before this branch
  and is now load-bearing. The code is correct; the comments hide why.
  Its own test (`app/test/retirePausedTourReminders.test.ts`) has zero coverage
  for that clause.
- `docs/issues/tour-reminder-unclaimed-skip-no-conversation.md:58` names
  `cancelForTour`, which no longer exists.
- `docs/issues/paused-reminder-rows-grow-listdue-without-bound.md:24-27` states
  that rescheduling "cancels its pending rungs, which does stamp `canceledAt`".
  It now deletes them. (The issue's conclusion still holds - the branch
  strengthens it.)
- `e2e/support/selectors.md:73` pins "the two reminder aria sentences"; the
  branch adds a third (`Cancel the earlier <Kind> reminder`,
  `dashboard/src/routes/tours/RemindersPanel.tsx:585`) plus the
  `Earlier reminders (N)` summary, and `RemindersPanel.tsx:580-587` cites that
  file as the authority. Line `:75` ("every other suppression reason still reads
  *Will be skipped*") is now wrong for `paused`, `discontinued` and `superseded`.

---

## NOTE

### N1. A retire-script sweep mislabels a superseded survivor as `tour_already_passed`

`app/scripts/retire-paused-tour-reminders.ts:80-97` plans from
`Pick<TourReminderItem, ...>` without `ladderId` and never reads the tour's
`currentLadderId`. A superseded pending survivor (a sweep miss) on a past tour is
therefore stamped `tour_already_passed` rather than `superseded`, and surfaces in
`earlier[]` chipped "Skipped - the tour had already happened" instead of
"Replaced". Strictly safer (retired either way), cosmetic only, but it means the
skipReason on such a row is not trustworthy as a cause.

### N2. `deleteSupersededForTour` calls `this.listByTour` and never rethrows

`app/src/repos/tourRemindersRepo.ts:470`. Two consequences worth pinning:
- A destructured extraction (`const { deleteSupersededForTour } = repo`) breaks
  on `this`. No such site exists today; a lint rule or an explicit closure would
  make it structural.
- The method logs per-row failures and returns normally
  (`app/src/repos/tourRemindersRepo.ts:492-505`), so a partially swept ladder is
  invisible to both callers. `app/src/routes/tours.ts:1236-1239` argues that
  anything escaping is a list-read failure; that is true, but it also means a
  half-swept ladder returns 200 and reads to the operator as history under
  `Earlier reminders` rather than as an incomplete retirement.

### N3. `listByTour` is unpaginated (1 MB silent cap) and is now the input to a DELETE

`app/src/repos/tourRemindersRepo.ts:265-275` - single `QueryCommand`, no
`LastEvaluatedKey` loop, inherited by `deleteSupersededForTour`, the panel GET
and `forceSendReminder`. Named as an accepted non-goal at `:224`. Recording it
because the branch changes the consequence class: a truncated page used to mean
"the panel showed fewer rows", and now also means "the sweep silently skipped
rows it will never revisit". The risk is genuinely lower than before (the hard
delete bounds a tour's row count to sent rungs + current ladder, where the old
soft cancel grew without bound), so this is not a regression - just no longer
purely a read concern.

### N4. A zero-row arm on a reschedule leaves an unexplained empty panel

`app/src/jobs/tourReminders.ts:617-621` returns `ladderId: null` when the arm wrote
nothing, so `app/src/routes/tours.ts:1261` skips the CAS and the tour keeps the
rotation placeholder. Because the sweep ran first, the old rows are gone too:
`reminders: []`, no `earlier`, no skip rows, no explanation. Pre-branch the old
generation would still have been visible as canceled rows. Narrow (it needs
every kind to hit the silent past-dueAt drop rather than the visible
`past_event` / `booked_too_late` skips), but the failure mode is "the panel says
nothing at all".

### N5. No RUNBOOK entry for this deploy

`RUNBOOK.md` carries a detailed entry for the Phase B sweep (`:287-302`) and
nothing for this one. Worth a line stating (a) that no backfill is required
because pre-migration pairs are exempt (`app/src/lib/ladderPointer.ts:42-46`),
(b) that the one-time retire sweep and the new hard delete are independent, and
(c) - if M3 is not fixed - that pre-migration canceled rungs will be destroyed on
the first PATCH of each terminal tour.

---

## Areas hunted that came back clean

Recorded so a later reader does not re-walk them.

- **Deleted contracts.** No live reference to `cancelForTour` or
  `cancelTourReminders` survives anywhere in `app/`, `dashboard/`, `e2e/` or
  `scripts/`. `armTourReminders`'s new `{ ladderId, rows }` shape has exactly
  four call sites, all updated (`routes/tours.ts:347`, `:1243`,
  `lib/seed/live.ts` x3).
- **Repo implementations.** Exactly three (`repos/tourRemindersRepo.ts`,
  `test/helpers/twilioWebhookHarness.ts:2944`, and a spread at
  `test/tourReminders.test.ts:3269`). All carry `deleteSupersededForTour`; none
  carries `cancelForTour`. No MSW handler, e2e stub server or dashboard mock
  exists.
- **Token enumerations.** Both new `skipReason` tokens (`superseded`,
  `conversion_stalled`) and the new `ScheduledSuppressionReason` (`superseded`)
  are present at every enumeration site on both sides of the wire, all lookups
  either compile-exhaustive `Record`s or `?? reason` fallbacks. No blank or
  `undefined` render path found.
- **Resurrection races.** `claimSend` / `claimSkip` / `cancel` all gained
  `attribute_exists(reminderId)` (`app/src/repos/tourRemindersRepo.ts:335-341`,
  `:380-384`, `:411-415`), which is the correct guard now that rows are deleted -
  `UpdateItem` would otherwise create an attribute-only stub. `uncancel` needs no
  change (`attribute_exists(canceledAt)` cannot hold on a missing item).
  `retire-paused-tour-reminders.ts:206` already had it.
- **Table/GSI.** `ladderId` is a plain attribute; both `tourReminders` GSIs
  project `ALL` (`app/src/lib/tables.ts:426-438`,
  `infra/modules/dynamodb/main.tf:57`), so `listByTour` and `listDue` both return
  it. Had `byTour` been `KEYS_ONLY`, `isSupersededRung` would have judged the
  entire world superseded. No terraform or `db-update-gsis` run is needed.
- **Security.** No new routes, no change to any authz gate, no new payload field
  accepted from a client (`currentLadderId` and `ladderId` are server-minted
  only). New log lines carry ids, kinds and ISO stamps - no phone numbers, no
  bodies. Every new condition expression narrows rather than widens.
- **The scroll change, for views with no block.** `deriveStreamAnchor` with
  `hasBlock: false` reproduces the old `isAtBottom` bands
  (`dashboard/src/routes/contact/streamAnchor.ts:50-63`); the pin's landing point
  shifts by `--sp-3 - --sp-2` = 4px because the sentinel sits above `.stream`'s
  bottom padding and below the flex `gap`. Not worth reporting on its own.
  GroupTextView's `[]` literal is handled by keying the ResizeObserver effect on
  the boolean (`Timeline.tsx:1868`).
