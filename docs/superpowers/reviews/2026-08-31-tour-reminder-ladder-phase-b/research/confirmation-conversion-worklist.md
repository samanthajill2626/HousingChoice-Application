# Confirmation conversion worklist (run state - NOT committed)

Derived from research report A section 4 (unit) and report D sections 3-5 (e2e),
VERIFIED against the live tree at slice 3 (base @3307afe0). Categories:

- **cat1** - an immediate-send / force-send ride that stops working once the poll
  excludes `confirmation` (T7). CONVERTED IN SLICE 3 (T5/T6).
- **cat2** - asserts confirmation ARMS, or its ladder position. Left green; T9 owns it.
- **redesign** - the case's proof strategy dies with the kind. T9 owns it.
- **keep** - union / computeDueAt / catalog / repo-level pin. Unchanged, forever.

Outcome column: what slice 3 actually did.

---

## 1. `app/test/tourReminders.test.ts`

| test (`it` name) | cat | outcome |
|---|---|---|
| `armTourReminders creates all 4 reminder rows with correct dueAts` | cat2 | untouched |
| `does not auto-arm the no_show_checkin rung (manual send only)` | cat2 | untouched |
| late-evening tour arm dueAt pin | cat2 | untouched |
| en_route supersedes morning_of (arm kinds list) | cat2 | untouched |
| `a confirmation armed inside quiet hours is clamped to quiet-end, not sent at 'now'` | **redesign** | untouched - T9 |
| clamped-past-start arm kinds list | cat2 | untouched |
| retimed day_before arm kinds list | cat2 | untouched |
| `runDueTourReminders sends due rows and is idempotent` | **cat1** | CONVERTED: arm dropped; `createDueReminder(day_before, now0)` + `createDueReminder(morning_of, 2026-07-14T23:30Z)`; bodies now `rungBody('day_before'/'morning_of')` |
| `runDueTourReminders emits scheduled.updated per claimed rung` | **cat1** | CONVERTED: same two created rungs. NOTE the arm could NOT be kept here - a retimed tick would have superseded the still-armed confirmation, and a claim-skip ALSO emits `scheduled.updated`, breaking `toHaveLength(2)` |
| `claim-skips a due rung whose tenant has no 1:1 conversation` | **cat1** | CONVERTED: arm dropped; one `createDueReminder(day_before, now0)`; row now found by `reminderId`, local `confirmation` renamed `retired` |
| `claimSend stores the composed body on the row (and stays optional)` | keep | untouched (kind cosmetic, no poll ride) |
| `a rung whose scheduledAt is unusable is claim-skipped, NOT retried forever` | **cat1** | CONVERTED: direct-create kind `confirmation` -> `day_before` + a comment on why the gate is a no-op here (unparseable start) |
| `defers a due rung while 'now' is inside quiet hours ...` (morning_of) | keep | untouched |
| `defers a GROUP-routed rung as well ...` | **cat1** | CONVERTED: direct-create kind `confirmation` -> `day_before` |
| release supersession (both cases) | keep | untouched (day_before/morning_of already) |
| `cancelTourReminders` (`rows.find(kind==='confirmation')`) | cat2 | untouched - T9 |
| booked_too_late arm pins (3 cases) | cat2 | untouched |
| `listDue excludes sentAt and canceledAt rows` | **redesign** | untouched - T9 (its subject is "the confirmation row is the ONLY row due at now0") |
| `two concurrent runDueTourReminders calls over the same due row send exactly once` | **cat1** | CONVERTED: arm dropped; one `createDueReminder(day_before, now0)` |
| `a row canceled between listDue and the claim step fires zero sends` | **cat1** | CONVERTED: arm dropped; one created rung; `confirmRow` -> `pendingRow`, found by `kind==='day_before'` |
| `landlord_led tour with an open group ...` | **cat1** | CONVERTED: arm -> `createDueReminder(day_before, now0)`; 4 body/kind assertions re-pointed |
| `group sends draw one token per member from the shared A2P bucket` | **cat1** | CONVERTED (arm -> created rung) |
| `pm_team tour with an open group routes reminders to the group` | **cat1** | CONVERTED |
| `self_guided tour with a group thread set still sends ... 1:1` | **cat1** | CONVERTED + body assertion re-pointed |
| `landlord_led tour with no groupThreadId falls back to the tenant 1:1` | **cat1** | CONVERTED |
| `... groupThreadId points at a missing conversation ... D11 holds the rung UNCLAIMED` | **cat1** | CONVERTED + `held` found by `kind==='day_before'` |
| `... points at a non-relay_group conversation ... D11 skips it visibly` | **cat1** | CONVERTED + `skipped` found by `kind==='day_before'` |
| `landlord_led tour with a CLOSED group thread falls back to 1:1` | **cat1** | CONVERTED |
| `an sms_opt_out group member is skipped ...` | **cat1** | CONVERTED |
| `two concurrent ticks over the same group reminder ...` | **cat1** | CONVERTED |
| `a per-member adapter failure does not block other members ...` | **cat1** | CONVERTED + sentAt assertion re-pointed |
| `seedForceTour` kind param union | keep | untouched (the union member survives, spec 5) |
| `force-sends a pending rung DURING quiet hours ...` | **cat1 FORCE** | CONVERTED: `seedForceTour({kind:'day_before'})`; both `rungBody` expectations re-pointed |
| `force-sends a GROUP-routed rung through the relay announcement path` | **cat1 FORCE** | CONVERTED: `kind: 'day_before'` |
| `force-send REFUSES a rung targeting an off-roster tenant ...` | **cat1 FORCE** | CONVERTED: `kind: 'day_before'` |
| D11 section - 8 cases riding the arm-time confirmation | **cat1** | CONVERTED as a BLOCK: new `TICK_D11 = 2026-08-06T23:30:01.000Z` (1s past `DAY_BEFORE_D11`, the earliest LIVE rung) and `MORNING_OF_D11 = 2026-08-07T14:00:00.000Z`; every `rungOf(..., 'confirmation')` -> `'day_before'`; the "re-add lifts suppression" second tick moved from `DAY_BEFORE_D11` to `MORNING_OF_D11` (its first tick now consumes day_before) |
| `AT/AFTER tour start the wait is MOOT ...` | (slice 2) | untouched - already redesigned by T3 |
| `manual-only hold-back` describe | T7 | untouched |
| guards g3 / g3b (confirmation force-send with a throwing read) | **cat1 FORCE** | untouched ON PURPOSE - worklist R7 assigns them to **T9** (they must be re-derived, not merely re-pointed: force-send will refuse `kind_retired` before compose) |
| `computeDueAt.test.ts`, `tourCopy.test.ts` sites | keep | untouched |

## 2. `app/test/tourRemindersApi.test.ts`

| site | cat | outcome |
|---|---|---|
| `seedComposedTour` rung (drove `runDueTourReminders(preview.dueAt)`) - report A `:1003,1025` | **cat1** | CONVERTED: kind `confirmation` -> **`morning_of`**, NOT `day_before`. `tour.morning_of` is the only LIVE kind whose template renders `{addressLine}`, and the case's anti-vacuity assertion is `preview.body).toContain('412 Sender Way NW')` - a `day_before` rung would have made that assertion fail. Sibling comment "far past the confirmation's" re-derived. |
| `:259`, `:595`, `:621`, `:1546` `{reason:'paused'}` | T7/T8 | untouched |
| `:411-424`, `:443-457`, `:473-482` quiet-hours fixtures on `confirmation` | T8 (R2) | untouched |
| `:1051-1138` `seedUncomposableTour` send-now | T7 | untouched (T7 owns the `kind_retired`-first precedence) |
| `:202/237/266`, `:290`, `:654`, `:1173`, `:1511/1541` | cat2 / keep | untouched |
| `seedSendNowTour` 2099 re-dating | (slice 2) | already landed @0172bf88 |

## 3. Files with NO slice-3 work (verified against the live tree)

| file | cat | owner |
|---|---|---|
| `app/test/toursApi.test.ts` (10 sites) | cat2 - all arm-result pins through `POST /api/tours` | T9 |
| `app/test/contactTimeline.test.ts` (17 sites) | cat2 read pins at `dueAt: 2099-...`; `:1263/:1291` are `paused` re-baselines | T8 (R2) / T7 |
| `app/test/relayApi.test.ts` (7 sites + three `toHaveLength(4)` ladder pins) | cat2 | T9 |
| `app/test/devGating.test.ts` (4 sites) | cat1 but **plan-assigned to T7** | T7 |
| `app/test/placementConvert.test.ts:78` | keep (kind incidental, nothing sends) | - |
| `app/test/seedLive.test.ts` (10 sites) | cat3 seed-result pins | T9 |

---

## 4. E2E (Task 6)

### 4.1 Code sites

| site | cat | outcome |
|---|---|---|
| `tours.spec.ts` landlord-led group arrival (`tickTourReminders()` + `expectReminderInGroup('confirmation')` + `expectReminderVisibleInGroupThread('confirmation')`) | **cat1** | CONVERTED to `justAfter(await flow.armedReminderDueAt('day_before'))` + `'day_before'`. The test ALREADY had a second, identical-vehicle `day_before` tick eight lines down, so the two blocks were MERGED into one: every assertion survives (group arrival x2 members + the dashboard-thread bubble), on one rung, with one tick instead of two |
| `tours.spec.ts` pm_team group arrival | **cat1** | CONVERTED, same vehicle |
| `tours.spec.ts` self-guided 1:1 arrival | **cat1** | CONVERTED, same vehicle |
| `tours.spec.ts` no-show setup 1:1 arrival | **cat1** | CONVERTED, same vehicle |
| `tours.spec.ts` reschedule re-arm proof (second `tickTourReminders()` pair) | cat2 redesign | untouched - T9 |
| `tours.spec.ts` past-tour retirement block | (slice 2) | already rewritten @0172bf88 |
| `scheduled-visibility.spec.ts` (5 confirmation sites) | cat2 redesign | untouched - T9 |
| `tour-roster.spec.ts:480-523` | cat2 redesign (R8) | untouched - T9 |
| `tour-no-show-checkin.spec.ts:77-89` | cat2 (comment bullet) | untouched - T9 |

### 4.2 Comment / docblock sites in `e2e/scenarios/steps.ts`

| site | outcome |
|---|---|
| `ReminderKind` union member, `REMINDER_BODY_MARKERS.confirmation`, `REMINDER_KIND_LABELS.confirmation` | KEEP - the kind and its catalog entry both survive (spec 5) |
| `tourSchedule` docblock (confirmation sentence) | REWRITTEN - names `day_before` as the earliest live rung, read via `armedReminderDueAt` |
| `tickTourReminders` docblock | REWRITTEN - the future-rung idiom is the PRIMARY use |
| `teamReschedulesTour` docblock (re-arm proof "asserted by a fresh confirmation") | REWRITTEN - rides `day_before` |
| `requireTourReminderContext` docblock ("verified: tours.spec.ts asserts confirmation/day_before") | REWRITTEN - re-derived against the converted spec |
| ARRIVAL-not-trigger comment "60s" | CORRECTED to 30s (`WORKER_POLL_INTERVAL_MS` default 30000) |
| `expectReminderRung` 'upcoming' branch | R12 - `.filter({ hasNotText: /Skipped/ })` added + docblock. **A REGEXP, not the string R12 names**: Playwright's string `hasNotText` is case-INSENSITIVE, so `'Skipped'` would also have excluded the genuinely-upcoming rung whose PREDICTION note reads "Will be skipped - contact opted out" (`api/types.ts` `suppressionNote`). The terminal chip is capital-S "Skipped - <reason>"; a case-sensitive `/Skipped/` separates them. No current spec asserts 'upcoming' on a "Will be skipped" row, so this is a latent trap closed, not a green-again fix |

### 4.3 LIVE-WORKER AUDIT (T6 step 2a)

The rule: a rung a spec leaves PENDING and asserts `upcoming` must ride a
far-future fixture, never a near-now one, because T7 makes the lane's real
worker (30s poll, `config.ts` default 30000 - NOT the 60s three comments claim)
a live wall-clock sender.

| spec | pending-rung assertions | fixture dueAt offset | verdict | change |
|---|---|---|---|---|
| `scheduled-visibility.spec.ts` | `('day_before','upcoming')` x3, `('morning_of','upcoming')`, `('en_route','upcoming')`, `expectUpcomingItem(day_before body)`, `(d)` opted-out card note | `tourScheduleFullLadder()` = 14:00 local D+2; day_before 19:30 D+1 (~1.8d), morning_of 10:00 D+2 (~2d), en_route 13:00 D+2 | **SAFE** | none. The two `('confirmation', ...)` sites are near-now but die at T9 anyway |
| `tours.spec.ts` | after conversion: `day_before` is SENT, not pending; no rung is asserted upcoming | `tourSchedule()` = now+48h | **SAFE** | none beyond the conversion |
| `quiet-hours.spec.ts` | `('day_before','upcoming')` after the DEFER tick | `tourScheduleFullLadder(2)`, both ticks pass an explicit `now` | **SAFE from the clock** | none here. Its `PAUSED_NOTE` pair breaks at **T7**, not on the clock - report D D1 |
| `tour-roster.spec.ts` | `Skipped - tenant not on roster` chip (a SKIPPED assertion, not upcoming) | booking at now+5d | **SAFE** | none - T9 redesigns the block onto `day_before` (~4d out) |
| `tour-no-show-checkin.spec.ts` | count assertion after a wall-clock tick; tour is 26h in the PAST | past tour | **SAFE - strengthened** | none. T3's gate means nothing can fire |
| `relay-number-lifecycle` / `approval-and-move-in` / `post-tour-application` | no reminder-state assertions (they only `tourSchedule()` a booking) | now+48h | **SAFE** | none |

Verified, not copied, from report D s5.5. One addition report D s5.5 makes and
this slice enforces: **the only construct that would race the 30s worker is a
directly-created NEAR-NOW due row** (the T5 unit vehicle). No e2e conversion in
this slice reaches for that shape - every converted site rides
`justAfter(armedReminderDueAt('day_before'))` off a `tourSchedule()` booking,
whose earliest live rung is ~19-24h out.

Residual hazard NOT closed by fixtures (report D s5.4): `expectReminderRung(kind,
'upcoming')` could not see a SKIPPED row, so a rung the live worker retired would
still satisfy an 'upcoming' assertion. R12's `.filter({ hasNotText: 'Skipped' })`
closes it for the whole suite; landed in this slice.
