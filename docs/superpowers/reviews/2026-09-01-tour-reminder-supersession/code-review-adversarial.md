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

---

# Round 2 - re-review of fix wave 1 (@9af87a2c, base @65c19506)

Inputs: the 9-commit fix diff, `code-review-adjudications.md`, and the
implementer's `.superpowers/sdd/reports/fixwave-1.md`. Method as round 1: read
the new code cold, walked interleavings, grepped consumers, reproduced where
cheap. One throwaway vitest was written, run and deleted. Nothing committed.

Counts: **6 NEW** (1 MAJOR, 3 MINOR, 2 NOTE), **3 STILL-OPEN**, **7 CLOSED**.

---

## 1. NEW findings

### NEW-1 (MAJOR). The ownership guard is a read-your-own-write on an EVENTUALLY CONSISTENT GetItem - so one uncontended reschedule can disarm the tour and return the old time

Evidence: **REPRODUCED** (throwaway vitest, deleted).

- `app/src/repos/toursRepo.ts:299-300` -
  `new GetCommand({ TableName: table, Key: { tourId } })`. No `ConsistentRead`.
  DynamoDB's default GetItem is eventually consistent and is documented as
  possibly not reflecting a recently completed write.
- `app/src/routes/tours.ts:1252` writes `currentLadderId = rotation` via
  `tours.patch`, then `:1254` reads it straight back with that same
  non-consistent get, and `:1255` compares the two.
- `app/src/routes/placements.ts:812` does the same after the finalize.

The guard's entire correctness rests on that read observing the write issued one
line earlier. It is not guaranteed to. And this repo plainly knows the
difference: `ConsistentRead: true` appears in `messagesRepo.ts` (:1801, :2135,
:3288, :3365, :3510), `extractionRepo.ts` (:602-:827),
`suggestionResolutionRepo.ts` (:502-:569), `aiRunsRepo.ts:233` and
`contactsRepo.ts:781`. `toursRepo.get` is not one of them, and the fix wave added
a correctness-critical caller without noticing.

Measured, with the post-patch read serving the pre-patch row exactly once and
**no concurrency at all**:

```
status: 200
responseScheduledAt: '2026-07-20T18:00:00.000Z'   <- the OLD time
storedScheduledAt:   '2026-07-21T18:00:00.000Z'   <- the NEW time
storedPointer:       '55f66c3d-...'               <- the rotation
ladderIdsNow:        [ '07f2083f-...' ]           <- the OLD ladder, unswept
rowsMatchingPointer: 0
totalRows: 3
```

The chain: the guard sees a mismatch, takes the loser branch
(`app/src/routes/tours.ts:1256-1262`), logs
`a concurrent reschedule owns this ladder` naming a competitor that does not
exist, skips **both** the sweep and the arm, and sets `tour = owner` - the stale
row - so the 200 tells the operator their reschedule did not happen. Meanwhile
the store holds the new `scheduledAt` and a pointer no row carries: the tour is
**disarmed**, and its surviving rungs still carry dueAts computed for the OLD
time.

Worse than round-1's B1 in two ways:

1. It needs no race. B1 required two overlapping requests; this is one request.
2. `ladderChanged` stays false on the loser branch (`app/src/routes/tours.ts:1330`
   is inside the `else`), so **no `scheduled.updated` is emitted**. The Reminders
   panel and both Upcoming buckets never refetch and keep rendering the old
   ladder as live - which agrees with the stale 200. Every surface tells the same
   false story, so nothing contradicts it and nothing prompts a retry.

No existing test can see this: every fake (`twilioWebhookHarness.ts:2801`,
DynamoDB Local) is strongly consistent by construction.

Fix, in preference order:
- Best: delete the check-then-act. Make the sweep itself generation-aware -
  `deleteSupersededForTour(tourId, { exceptLadderId })` with a per-row
  `attribute_not_exists(ladderId) OR ladderId <> :except` - which needs no read,
  has no window, and was the round-1 suggestion.
- Otherwise: `ConsistentRead: true` on this read. Either add it to
  `toursRepo.get` outright, or follow `contactsRepo.ts:781`'s opt-in flag idiom
  so only the two ownership call sites pay for it.
- Either way, the loser branch must not overwrite `tour` with an unvalidated
  read (see NEW-5).

### NEW-2 (MINOR). M2's grace now keys on `tour.updatedAt`, which EVERY tour write bumps - so a stalled claim on an active tour never expires

`app/src/jobs/tourReminders.ts:351-361`, consumed at `:1154`.

The premise checks out - `claimConversion` does bump `updatedAt`
(`app/src/repos/toursRepo.ts`, `SET #cp = :v, #updatedAt = :now`), so round-1's
M2 is genuinely fixed. But `updatedAt` is not a claim stamp; it is a
last-touched-by-anything stamp. Every `patch`, `setRoster`, `claimGroupThread`
and pointer rotation moves it forward, which means
`now - max(dueAt, updatedAt) > 1h` is false forever on any tour edited more than
once an hour.

The docstring calls that "the safe direction". It is safe for SENDING - nothing
fires - but the bound does not exist to prevent a send; the module header
(`app/src/jobs/tourReminders.ts:318-322`) says it exists because "an unbounded
deferral is the perpetual-'sending shortly' lie in a new costume". On an edited
tour the deferral is unbounded again and the lie is back, which matters because
of the interaction in challenge C3 below.

Suggested: have `claimConversion` write a dedicated `conversionClaimedAt` and
measure from `max(dueAt, conversionClaimedAt)`. It is one attribute in a write
that already exists, and it says what it means.

### NEW-3 (MINOR). `conversion_in_progress` reaches one of four sites, and now the panel visibly contradicts itself

`app/src/jobs/tourReminders.ts:1820-1841` refuses; nothing else consults the
sentinel. `forceSendReminder` has exactly one caller
(`app/src/routes/tourReminders.ts:508`), so the new token has no orphan consumer
and `SEND_NOW_ERROR_COPY` covers it (`dashboard/src/api/types.ts:1443-1449`) -
that part is clean.

What the fix produced is a self-contradicting row: during a claim the panel
renders the rung as `upcoming` with a live fire-time estimate and an ENABLED
"Send now" button whose only possible answer is 409 "try again once that
finishes". `lib/ladderPointer.ts:4-9` states the branch's own rule - a surface
must not promise what a send path refuses, because "a surface that decided this
for itself could show 'sends in 6 days' for a rung the poll refuses, which is
the exact lie the feature exists to end." `superseded` was given all four sites
for that reason. `conversion_in_progress` was given one.

The cheap version is not a fourth predicate: the panel GET already holds the
tour, so one `startsWith('pending:')` at `app/src/routes/tourReminders.ts:747`
(beside the `superseded` computation) would suppress the estimate and the button
on the surface an operator actually clicks from.

### NEW-4 (MINOR). The shipped M3 rule leaves a second door to the same data loss

`app/src/routes/tours.ts:1211-1216`: `terminal` now reads `patchedStatus`. That
closes the reported trigger, but an EXPLICIT terminal status on an
ALREADY-terminal tour still rotates and sweeps. `app/src/lib/toursModel.ts:12`
lists `* -> canceled` as legal and there is no same-status rejection, so
`PATCH {status:'canceled'}` on an already-canceled tour is a 200 that takes the
terminal branch.

The implementer calls this "harmless (it deletes rows that are already gone)".
That holds for a post-deploy tour. It does not hold for the exact population M3
was fixed to protect: a PRE-MIGRATION terminal tour still carrying the old
tour-wide cancel's `canceledAt` rungs. One redundant terminal PATCH hard-deletes
them - the same history loss, one door over.

My round-1 rule, `terminal && currentStatus !== effectiveStatus`, closes both
doors, is one clause longer, and states the actual intent ("a TRANSITION").

### NEW-5 (NOTE). The loser branch replaces the response tour with an unvalidated read

`app/src/routes/tours.ts:1262` - `if (owner !== undefined) tour = owner;`.
`owner` is whatever that read returned, with no check that it is newer than this
request's own patch return. Under NEW-1 it is demonstrably OLDER. Even with a
consistent read, building the response by wholesale replacement rather than by
merging the winner's pointer into `tour` makes the response's freshness depend
on a read this handler does not control.

### NEW-6 (NOTE). The guard adds unconditional store traffic to two hot paths

One extra GetItem per re-arm PATCH (`app/src/routes/tours.ts:1254`) and per
conversion (`app/src/routes/placements.ts:812`). The cost is small; it is worth
naming only because it buys a guarantee it does not currently deliver (NEW-1),
and because the generation-aware-sweep alternative costs zero reads.

---

## 2. Adjudication challenges

**C1 - B1's accepted residue is described by its harm, not its mitigation.**
The adjudication accepts the ownership-read-to-sweep window because "its end
state fires nothing, one side logs at error, and the next reschedule repairs
it". Firing nothing IS the defect. B1's whole finding was a live `scheduled`
tour with zero reachable rungs and no operator-visible signal; the residual end
state is byte-for-byte that, just rarer. "The next reschedule repairs it"
assumes someone reschedules, which nothing prompts them to do. And the window is
not ms-scale in the way the acceptance implies once NEW-1 is on the table. A
generation-aware sweep removes the window instead of shrinking it and was
available; I would not accept this residue.

**C2 - the adjudication was wrong about B1's test parking point; the implementer
was right.** The adjudication directed the regression test to park request A "at
its SWEEP". That is inside the window the same paragraph accepts, so the test
could only ever encode the residue as expected behaviour or fail permanently.
Parking A between its rotation and its ownership read is the faithful
translation of my reported interleaving. Deviation 1 in `fixwave-1.md` is
correct and should be recorded as an adjudication error, not an implementer
deviation.

**C3 - M1's preview-surface ACCEPT-RECORD leans on a cap that M2's fix removed.**
The acceptance reads: "the promise-during-claim window is milliseconds on the
happy path and capped by the grace window on a crashed one." After @a6890024 the
grace window restarts on every tour write (NEW-2), so on a crashed claim against
an edited tour there is no cap - the three preview surfaces promise "sends in
Nh" indefinitely. The two residues were adjudicated independently and interact:
fixing M2 as specified invalidated M1's acceptance rationale. Re-decide them
together (NEW-2's `conversionClaimedAt` restores the cap and makes the original
acceptance sound again).

**C4 - M3's "simpler rule to state" costs a second data-loss door.** See NEW-4.
Deviation 3 in `fixwave-1.md` is accurate about what changed; I disagree that
the difference is harmless.

**C5 - agreements, recorded so they are not re-litigated.** Deviation 2 (m3's
invariant belongs in `seedMatrixCoherence.test.ts` as a row-side walk, the group
pairing already existing in `seedMatrix.test.ts`) is right. N1, N2, N3 and N4
remain correctly accepted - N3's risk class genuinely improved with the bounded
row count, and N4's reachability is as narrow as adjudicated. S5's
`names_unavailable` residue is an honest outcome under an imperfect token.

---

## 3. Round-1 verdicts against the fixed code

| # | round-1 severity | verdict | note |
| --- | --- | --- | --- |
| B1 | BLOCKING | **STILL-OPEN (MINOR as a race; MAJOR via NEW-1)** | Window narrowed from patch->sweep to read->sweep; end state unchanged. Check-then-act, not a conditional write. See C1. |
| M1 | MAJOR | **CLOSED (send path) / STILL-OPEN (preview surfaces)** | `app/src/jobs/tourReminders.ts:1830-1841` refuses correctly and is ordered below `superseded` as specified. Surfaces: NEW-3, C3. |
| M2 | MAJOR | **CLOSED** | Premise verified: `claimConversion` does bump `updatedAt`. `max(dueAt, updatedAt)` with NaN-answers-false is correct. Residual: NEW-2. |
| M3 | MAJOR | **CLOSED for the reported trigger** | `app/src/routes/tours.ts:1215-1216` reads `patchedStatus`; the exit-gate PATCH no longer rotates or sweeps. Second door: NEW-4. |
| m1 | MINOR | **CLOSED** | Both echoes (`app/src/routes/tourReminders.ts:459`, `:540`) take `after.sentBody ?? ''` under `isSupersededRung`, covering the PATCH 200/409 and the send-now 200/409 alike. |
| m2 | MINOR | **CLOSED** | `prevHasBlockRef` + `hasUpcomingBlock` in the deps re-derive on both mount and unmount, ahead of the branch logic and ahead of the conversation-switch early return. The `upcoming` array identity stayed out of the deps. |
| m3 | MINOR | **CLOSED** | The canceled matrix tour no longer pushes a canceled rung; the sent confirmation and rotated pointer remain, which is the producible shape. |
| m4 | MINOR | **CLOSED** | All named prose sites updated. |
| N1-N4 | NOTE | accepted as adjudicated | See C5. |
| N5 | NOTE | **CLOSED** | RUNBOOK section added @9af87a2c. |

Neither reproduced round-1 defect survives in its reported form: the round-1 B1
probe (park A at its sweep) now hits the ownership guard, and the round-1 M3
probe (exit-gate PATCH on a terminal tour) no longer touches the rows. What
replaced B1's race is NEW-1's single-request version of the same end state.

---

# Round 3 - re-review of fix wave 2 (@445b6b28, base @9af87a2c)

Inputs: the 6-commit fix diff, `code-review-adjudications-r2.md`, and
`.superpowers/sdd/reports/fixwave-2.md`. Walked the new sweep's interleavings
cold before reading either adjudication. No throwaway needed this round - the
round-2 probes are settled by reading the shipped control flow (below). Nothing
committed.

Counts: **4 NEW** (1 MAJOR, 3 NOTE), **0 STILL-OPEN**, **10 CLOSED**
(NEW-1..NEW-6, C1..C4).

## 1. The transactional sweep - interleavings walked

`app/src/repos/tourRemindersRepo.ts:502-577`. Two filters (`sentAt === undefined`
and `ladderId !== expectedPointer`), then one `TransactWriteItems` per candidate
pairing a `ConditionCheck` on the TOUR's `currentLadderId` with the `Delete`.

All four named interleavings come out correct:

- **CAS-loser late sweep** (my original B1). A patch(R_A) -> B patch(R_B), arm
  L_B, CAS wins, sweep(L_B) -> A arm L_A, A CAS(R_A) LOSES so `sweepPointer`
  stays null (`app/src/routes/tours.ts:1289-1300`) and A sweeps nothing. End:
  pointer L_B with live L_B rows; A's rows are unpointed debris. The reverse
  order is also correct - A sweeps first, its ConditionCheck fails on B's
  pointer, it breaks having deleted nothing, and B's sweep then removes both
  older generations.
- **Terminal vs revival.** T patch(R_T, canceled) -> V patch(R_V, scheduled),
  arm L_V, CAS wins -> T sweep(R_T) is refused at item 0 and breaks. V's fresh
  ladder survives - the R2-1 defect. Reverse order: V's CAS loses to T's
  rotation, V sweeps nothing, T's sweep(R_T) removes the original ladder AND
  L_V. Both end states are self-consistent.
- **Conversion vs revival.** Reachable only in principle: `from-tour` requires a
  `toured` + convertible tour, and `canReschedule('toured')` is false
  (`app/src/routes/tours.ts:1112-1116`), so the revival 409s before it can
  patch. Recorded, not a finding.
- **Claim mid-sweep.** The poll stamps `sentAt` between `listByTour` and the
  delete -> item 1 cancels, `continue`, the send survives. When BOTH cancel,
  item 0 is tested first and breaks, which is the right precedence (the pointer
  moved, so the rest of this sweep has no mandate anyway).

Checked and clean, so they are not re-investigated later:

- **IAM.** `dynamodb:ConditionCheckItem` is already granted
  (`infra/modules/ec2/main.tf:55`), so the cross-table transaction is not an
  AccessDenied waiting for the first deploy. This was my leading suspicion.
- **Table naming.** `tourRemindersRepo.ts:268` uses
  `tableName('tours', deps.env)`, byte-identical to `toursRepo.ts:271`, so the
  new cross-table reference cannot diverge from the lane prefix.
- **Transact limits.** Two items per transaction, one transaction per row -
  nowhere near the 100-item / 4 MB caps.
- **The fake** (`app/test/helpers/twilioWebhookHarness.ts:3042-3060`) mirrors both
  filters and stops on a pointer mismatch. Its per-row re-check is atomic in
  practice (no `await` in the loop body), so it does not diverge on the paths it
  can model. What it cannot model is the subject of R3-1.
- **Suppression census.** `conversion_in_progress` reaches all four sites -
  `routes/tourReminders.ts:792`, `routes/contactTimeline.ts:1059`,
  `routes/relayGroups.ts:380`, and the dashboard's three exhaustive Records
  (`types.ts:1373`, `ScheduledCard.tsx:47`, `DeadlinesNudgesCard.tsx:89`) plus
  `RemindersPanel.tsx:175,469`. No enumeration left behind.

## 2. NEW findings

### R3-1 (MAJOR). The mechanism the whole B1/NEW-1 fix rests on has no test that exercises it

The decisive lines are the positional cancellation decode at
`app/src/repos/tourRemindersRepo.ts:551-568`: `reasons[0]` means "a newer
generation owns this tour, STOP", `reasons[1]` means "this one row was sent,
keep it and continue". Those two branches are the entire difference between a
correct sweep and B1 coming back.

Neither is tested, in any form:

- No `tourRemindersRepo.integration.test.ts` exists. Both other Transact users
  in this repo have one - `aiRunsRepo.integration.test.ts`,
  `suggestionResolutionRepo.integration.test.ts` - so this departs from the
  repo's own convention for exactly the path where it matters most.
- `CancellationReasons` and `TransactionCanceledException` appear NOWHERE under
  `app/test`. The only test contact with the new code is
  `app/test/tourReminders.test.ts:762` and `:806`, which `instanceof`-match the
  command on a stubbed `doc.send` - they assert that a transaction was sent, not
  what happens when one is cancelled.
- The fake cannot cover it and the implementer says so
  (`twilioWebhookHarness.ts:3048-3052`): it is strongly consistent by
  construction, so no harness test can ever produce either cancellation.

To be fair to the code: I read the decode as CORRECT. AWS returns one
`CancellationReasons` entry per `TransactItems` entry, positionally aligned,
with `Code: 'None'` for items that did not cause the cancellation, so indexing
[0] and [1] is right, and the comment at `:539-542` states that dependency
explicitly. This is a coverage finding, not a defect claim.

It still earns MAJOR because both failure modes are silent and opposite. A wrong
[0] read keeps sweeping while the pointer names another generation - B1, exactly
as reproduced in round 1. A wrong [1] read aborts the remaining ladder on a
benign mid-sweep claim, leaving debris that reads as history. Neither surfaces
as an error; the sweep logs and returns normally in both. An integration test
against DynamoDB Local that (a) rotates the pointer between two candidate rows
and asserts the second survives, and (b) stamps `sentAt` on a candidate and
asserts the sweep continues past it, would pin both and costs one file.

### R3-2 (NOTE). The ConditionCheck makes the sweep SAFE, not COMPLETE

`deleteSupersededForTour` builds its candidate list from `listByTour`
(`app/src/repos/tourRemindersRepo.ts:265-275`), a Query on the `byTour` GSI - and
a GSI can never be read consistently, so the list is eventually consistent by
construction. A row written moments earlier can be missed. That is harmless
(the missed row is unpointed and refused by every send path) and both routes
already word their failure logs as "survives... until the next sweep". Recording
it only because the docstring's "no interleaving can delete a row while the
pointer names another generation" is a safety guarantee and reads like a
completeness one.

### R3-3 (NOTE). The crash residue grew by one generation

The sweep moved below the arm and the CAS (`app/src/routes/tours.ts:1264-1330`).
A process death between the arm and the CAS now leaves BOTH the old generation
and the freshly armed one unpointed, where the old sweep-then-arm order left
only one. The pointer refuses both, so nothing fires and nothing is lost - the
cost is a longer `earlier[]` on the next panel load. The arm-failure branch is
documented at `:1272-1281`; this crash window is not.

### R3-4 (NOTE). Two smaller costs, named so they are not surprises

- Write cost: one `TransactWriteItems` per candidate row, two items across two
  tables, and transactional writes bill at 2x. A five-rung sweep goes from five
  conditional deletes to five two-item transactions. Immaterial at this scale,
  worth knowing before anyone reuses the shape on a hot loop.
- `app/src/jobs/tourReminders.ts:369` falls back to
  `tour.conversionClaimedAt ?? tour.updatedAt`. A claim taken BEFORE this deploy
  has no stamp, so NEW-2's behaviour persists for that population until those
  claims resolve. Correct choice (there is nothing better to fall back to) and a
  draining set.

## 3. The three deviations

**(a) R2-1 closed by generation-scoping rather than by reordering - SOUND, and
the implementer is right against the adjudication.** I walked terminal-vs-revival
in both orders above. What refuses the cross-generation delete is the
`ConditionCheck` alone; the terminal branch would be safe with its original
ordering, exactly as `fixwave-2.md` imprecision 1 says. The reordering is
independently right (it is what let the ownership reads go), but it is not what
closes R2-1, and the regression test cannot separate the two. Record the
adjudication as imprecise here, not the implementer.

**(b) Sweeping against the rotation when the re-arm produced `ladderId === null`
- SOUND.** `app/src/routes/tours.ts:1302-1310`. With no rows armed there is no
CAS, so the pointer is still `rotation`; every unsent row carries something else,
so all of them are candidates; the ConditionCheck passes because the rotation is
what the tour holds. It restores precisely the coverage the pre-arm sweep gave
for free, and it is the one cell "if the write won / if the write lost" does not
name. Also note this now DELETES the old ladder in the case my round-1 N4
flagged, so N4's "empty, unexplained panel" is reached deliberately rather than
by omission - unchanged in severity, better understood.

**(c) `conversion_in_progress` ordered BELOW `discontinued` - SOUND for the
operator.** Verified at `app/src/routes/tourReminders.ts:783-799` and
`dashboard/src/routes/contact/ScheduledCard.tsx:82-90`: it sits below the two
PERMANENT reasons and above the evaluator and `paused`. Both halves are right. A
temporary reason must not mask a permanent one, or the chip flips from
"On hold" to "No longer sent" minutes later and the first reading was a lie.
And it must outrank the evaluator, because the poll defers this rung unclaimed
whatever the recipient's opt-out or quiet-hours state - an estimate there would
describe a send nobody is attempting. The obvious reading the adjudication
invited (straight after `superseded`) would have been wrong; imprecision 3 is
correctly called.

## 4. Round-2 verdicts against the fixed code

| # | verdict | evidence |
| --- | --- | --- |
| NEW-1 (MAJOR) | **CLOSED** | Both ownership reads deleted (`routes/tours.ts`, `routes/placements.ts:810-818`); the guard is now server-side inside the transaction, so there is no read to be stale. The one surviving read-your-own-write - the CAS-loser response re-read - takes `{ consistentRead: true }` (`routes/tours.ts:1298`), backed by the new opt-in at `repos/toursRepo.ts:325-334`. My round-2 probe (serve the post-patch read stale once) can no longer reach a wrong branch: nothing branches on that read. |
| NEW-2 (MINOR) | **CLOSED** | `conversionClaimedAt` written beside the sentinel by `claimConversion` (`repos/toursRepo.ts:477-490`), removed with it by `releaseConversionClaim` (`:502-514`), mirrored in the fake (`twilioWebhookHarness.ts:2895,2907`), consumed at `jobs/tourReminders.ts:369`. `updatedAt` no longer extends the window. Residue: R3-4. |
| NEW-3 (MINOR) | **CLOSED** | All four sites now short-circuit; census above. |
| NEW-4 (MINOR) | **CLOSED** | `patchedStatus !== currentStatus` (`routes/tours.ts:1214-1220`) - a repeat `{status:'canceled'}` no longer rotates or sweeps, so the pre-migration terminal tour's legacy rungs survive both doors. |
| NEW-5 (NOTE) | **CLOSED** | The loser branch's re-read is consistent; the branch that overwrote `tour` from an unvalidated read is gone entirely. |
| NEW-6 (NOTE) | **CLOSED (moot)** | Both added reads were removed. Net store traffic on the re-arm path is now BELOW @9af87a2c and equal to @65c19506, with the guarantee actually delivered. |
| C1 | **CLOSED** | There is no residual ownership-read-to-sweep window, because there is no ownership read. The thing I declined to accept no longer exists. |
| C2 | **upheld** | See deviation (a) - and the adjudication has now been imprecise in the implementer's favour twice on this same fix. |
| C3 | **CLOSED** | Both halves resolved together, as asked: the cap is real again (NEW-2) and the surfaces annotate rather than promise (NEW-3). M1's preview residue is no longer an accepted residue at all. |
| C4 | **CLOSED** | See NEW-4. |

No round-1 or round-2 finding remains open. The single item I would still gate
on is R3-1: the branch's central data-loss defence is, today, argued rather than
tested.
