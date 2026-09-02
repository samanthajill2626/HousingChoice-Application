# Research A - tour reminders JOB + repo + unit tests (plan Tasks 3, 5, 7, 10, 11)

Base: worktree `W:\tmp\tour-reminder-ladder-phase-b`, branch `feat/tour-reminder-ladder-phase-b`, main @ec32170a.
All line numbers below were re-derived from the live tree by NAME. Paths are repo-relative
under `W:\tmp\tour-reminder-ladder-phase-b\`.

---

## 1. Anchor verification - `app/src/jobs/tourReminders.ts` (1551 lines)

| symbol / block | TRUE line(s) | plan says | verdict |
|---|---|---|---|
| `ReminderNamesUnavailableError` class | `97-102` (docblock `88-96`) | - | ok |
| `computeDueAt` signature | `117-122`; body `123-156` | Task 3 "place predicate near computeDueAt" | ok |
| `LADDER_ORDER` docblock | `158-164` | T10 `:158-164` | **exact** |
| `LADDER_ORDER` const | `165-171` | - | ok |
| `MANUAL_ONLY_REMINDER_KINDS` docblock | `173-200` | T7 `:173-206` | **exact** (set is `201-206`) |
| `MANUAL_ONLY_REMINDER_KINDS` set literal | `201-206` | T7 | ok |
| `readQuietHoursWindow` | `213-229` | - | ok |
| `REMINDER_KINDS` (+ its `no_show_checkin` note `231-234`) | `235-240` | T9 `:235-240` | **exact** |
| `ArmTourRemindersDeps` | `242-251` | - | ok |
| `armTourReminders` | `273-441` | - | ok |
| arm loop pass-1 clamp (`dues.set(...)`) | `303-307`; the clamp line is **`306`** | T10 `:303-307` | **exact** |
| 7.1 day_before-in-window warn | `318-329` | - | ok |
| booked-too-late branch | `367-388` | - | ok |
| silent past-dueAt drop | `390-393` | - | ok |
| past_event branch | `394-410` | - | ok |
| `const myOrder` (arm) | `411` | - | ok |
| `supersededBySlot` | `412-417` | T10 `:412-417` | **exact** |
| `staleDayBefore` | `418-419` | - | ok |
| supersede/stale skip-row write | `420-434` | - | ok |
| `RunDueTourRemindersDeps` | `469-564` | - | ok |
| `manualOnlyKinds?` dep + docblock | docblock `470-476`, field **`477`** | T7 | ok |
| `runDueTourReminders` | `581-631` | - | ok |
| poll due-row filter | `manualOnly` **`602`**, `dueRows` filter **`603`**, `heldBack` `604-610`, early return `611` | T7 `:602-603` | **exact** |
| one settings read per tick | `617` | - | ok |
| `claimSkipRow` docblock | `633-643` (3rd para `640-643`) | T3 step7 `:640-643` | **exact** |
| `claimSkipRow` fn | `644-657` | - | ok |
| `composeBodyForRow` | `683-736` (docblock `659-682`) | - | ok |
| `ReminderResolutionFailure` type | `742-746` | - | ok |
| `tenantRosterGate` | `764-787` | - | ok |
| `ReminderTarget` type | `790-793` | - | ok |
| `resolveReminderTarget` signature | `802-806` | T3 (gains `tour?`) | ok |
| ... its tour fetch | **`807`** `const tour = await deps.toursRepo.get(row.tourId);` | plan snippet used `.getById` then self-corrects | see drift D2 |
| ... tour-missing skip reason | `808-814`, returns `{ unresolvable: 'tour_missing' }` at **`813`** (no `tenantId`) | T3 "mirror its claim-skip reason exactly" | ok |
| ... contact fetch / `contact_missing` | `828-835` | - | ok |
| ... `contact_no_phone` | `838-845` | - | ok |
| ... `no_conversation` | `848-856` | - | ok |
| `processReminderRow` | `861-1109` | - | ok |
| `const myOrder` (poll) | **`888`** | T3 step6 "above the supersededInBatch block (`:888`)" | **exact** |
| `supersededInBatch` | `889-894`; skip at `895-902` | - | ok |
| `isQuietTime` backstop | `910-916` | T10 `:910-916` | **exact** |
| target resolve + unresolvable claim-skip | `922-935` | - | ok |
| group-route branch | `937-940` | - | ok |
| D7 pending-open / `beforeStart` docblock | `944-951`; code `952-964`, `beforeStart` at **`956`** | T3 step7 `:944-951` | **exact** |
| roster gate `unavailable` + `rosterWaitExpired` | `976-997`, `rosterWaitExpired` at **`984`** | T11 "mirror `:984-991`" | **exact** |
| roster gate `off` | `998-1005` | - | ok |
| compose call + catches (1:1) | `1025-1045`; `ReminderNamesUnavailableError` catch **`1037-1043`** | T11 `:1037-1043` | **exact** |
| `claimSend` (1:1) | `1053` | - | ok |
| `resolveUsableGroup` | `1128-1162` | - | ok |
| `sendGroupReminder` | `1180-1248`; compose catch `1195-1218`; ledger-7 acceptance comment **`1204-1209`**; names catch **`1210-1216`** | T11 `:1205-1216` / `:1205-1209` | off by 1 (harmless) |
| `announceGroupReminder` | `1261-1286` | - | ok |
| `ForceSendRefusal` union | **`1299-1329`** (`export type` at 1299, last member `\| ReminderResolutionFailure;` at 1329) | T2 `:1317-1330` | **WRONG - drift D1** |
| `ForceSendResult` | `1331-1339` | - | ok |
| `forceSendReminder` | `1364-1549` | - | ok |

### `processReminderRow` gate order (live, top to bottom)

| # | gate | lines | outcome |
|---|---|---|---|
| 1 | `supersededInBatch` (later same-tour rung in the batch) | `888-902` | claim-skip `quiet_hours_superseded` |
| 2 | `isQuietTime(now, window)` backstop | `910-916` | **return unclaimed** (no stamp) |
| 3 | `resolveReminderTarget` -> `'unresolvable' in target` | `922-935` | claim-skip `target.unresolvable` |
| 4 | `target.route === 'group'` -> `sendGroupReminder`, return | `937-940` | (group path) |
| 5 | D7 pending open_group + `beforeStart` (`now < tour.scheduledAt`) | `952-964` | **return unclaimed** |
| 6 | `tenantRosterGate` === `'unavailable'` -> `rosterWaitExpired` | `976-997` | claim-skip `roster_unavailable` past grace, else return unclaimed |
| 7 | `tenantRosterGate` === `'off'` | `998-1005` | claim-skip `tenant_not_on_roster` |
| 8 | compose (`composeBodyForRow`) | `1025-1045` | `UncomposableReminderError` -> claim-skip `invalid_schedule`; `ReminderNamesUnavailableError` -> return unclaimed |
| 9 | `claimSend` + emit + send | `1053-1108` | - |

### `forceSendReminder` structure (live)

| step | lines | note |
|---|---|---|
| `listByTour(tourId)` + `rows.find(...)` | `1373-1374` | bare read, uncontained by design |
| row absent -> `{ outcome:'refused', reason:'tour_missing' }` | **`1375`** | INLINE return - `refuse` NOT yet in scope |
| terminal row -> `not_pending` | `1376-1378` | |
| `resolveReminderTarget` inside try/catch -> `names_unavailable` | `1400-1409` | inline return at `1408` |
| `'unresolvable' in target` -> refused | `1410-1416` | inline return at `1415` |
| **`const refuse = (...)` DECLARED** | **`1420-1426`** | everything above uses inline returns |
| kill switch | `1427` | |
| 1:1 gates: roster, opt-out, deleted, consent | `1428-1450` | |
| `readQuietHoursWindow` (compose zone only) | `1458` | |
| compose + `invalid_schedule` / `names_unavailable` refusals | `1459-1482` | |
| `claimSend` | `1484` | |
| emit `scheduled.updated` | `1493` | |
| group announce / 1:1 send | `1495-1548` | |

### `ForceSendRefusal` - byte-exact current union (comments elided)

```ts
export type ForceSendRefusal =
  | 'sms_sending_disabled'
  | 'contact_opted_out'
  | 'contact_deleted'
  | 'no_consent'
  | 'tenant_not_on_roster'
  | 'roster_unavailable'
  | 'invalid_schedule'
  | 'names_unavailable'
  | ReminderResolutionFailure;
```

### Both `ReminderNamesUnavailableError` catch sites

| route | lines | current body |
|---|---|---|
| 1:1 (`processReminderRow`) | `1037-1043` | `log.warn(...)` then bare `return;` |
| group (`sendGroupReminder`) | `1210-1216` | same warn string, bare `return;`, preceded by the ledger-item-7 acceptance comment at `1204-1209` |

Warn string is IDENTICAL at both sites and is asserted verbatim by
`app/test/tourReminders.test.ts:3497-3498` (`DEFER_WARN`):
`'tour reminder: name resolution read failed - leaving the rung unclaimed for the next tick'`

### `rosterWaitExpired`

- import: `app/src/jobs/tourReminders.ts:56` -> `import { isOnRoster, resolveRoster, rosterWaitExpired } from '../lib/rosterResolution.js';`
- only usage today: `:984`
- definition: `app/src/lib/rosterResolution.ts:107-112`; `ROSTER_UNAVAILABLE_GRACE_MS = 60 * 60 * 1000` at `:100`
- semantics: `now - due > GRACE` (strict `>`), unparseable either side -> `false`.

### `runDueTourRemindersDeps` - what is injectable

Required: `tourRemindersRepo`, `toursRepo`, `contactsRepo`, `conversationsRepo`, `unitsRepo`,
`sendMessageService`, `settingsRepo`, `adapter`, `messagesRepo`.
Optional: `manualOnlyKinds?`, `pendingRosterActionsRepo?`, `tokenBucket?`, `events?`, `logger?`.
**`DISCONTINUED_REMINDER_KINDS` must NOT be added here** (plan T7 says so explicitly).

---

## 2. Repo contract - `app/src/repos/tourRemindersRepo.ts` (431 lines)

`ReminderKind` (`:29-34`), byte-exact:

```ts
export type ReminderKind =
  | 'confirmation'
  | 'day_before'
  | 'morning_of'
  | 'en_route'
  | 'no_show_checkin';
```

`ReminderSkipReason` (`:38-78`), byte-exact members in order (docblocks elided):

```ts
export type ReminderSkipReason =
  | 'no_conversation'
  | 'contact_missing'
  | 'contact_no_phone'
  | 'tour_missing'
  | 'quiet_hours_superseded'
  | 'past_event'
  | 'tenant_not_on_roster'
  | 'roster_unavailable'
  | 'invalid_schedule'
  | 'booked_too_late';
```

### Key layout for Task 4's Scan (verified against `app/src/lib/tables.ts:426-438`)

| aspect | value |
|---|---|
| table name | `tableName('tourReminders', env)` (`repo :170`) - prefix `TABLE_PREFIX` + `tourReminders` |
| PK (hash) | **`reminderId`** (S). NO sort key. `Key: { reminderId }` everywhere (`:262-265`, `:303-304`, `:335-336`, `:365-366`, `:401-402`) |
| GSI `byTour` | hash `tourId` (S), no range |
| GSI `byDueAt` | hash `_reminderPartition` (S, fixed literal `'reminders'`), range `dueAt` (S, ISO) |
| item id format | `reminder-${randomUUID()}` (`:177`) |
| terminal attrs | `sentAt`, `sentBody`, `canceledAt`, `skippedAt`, `skipReason` |

A Scan therefore needs no key projection games: every page item already carries
`reminderId`, `tourId`, `kind`, `dueAt`, `_reminderPartition`, `createdAt`.

### `create()` on a PAST `dueAt`

`create` (`:174-197`) writes `input.dueAt` VERBATIM. It does no `now` comparison, no clamp,
no drop. Its only condition is `attribute_not_exists(reminderId)`.
**The plan's premise for Task 5's `createDueReminder` vehicle is CORRECT**: only
`armTourReminders` drops a past-due rung (`jobs/tourReminders.ts:390-393`).

`create` with `skipped` births the row already terminal (`:182-185`), which is what keeps it
out of `listDue` (`:221` filter requires `attribute_not_exists(#skippedAt)`).

---

## 3. TOURS REPO getter

- Interface: `app/src/repos/toursRepo.ts:131` -> `get(tourId: string): Promise<TourItem | undefined>;`
- Impl: `:266` `async get(tourId) {`
- **There is NO `getById` on `ToursRepo`.**
- The deps member the job uses is `toursRepo` (`jobs/tourReminders.ts:487`), called as
  `await deps.toursRepo.get(row.tourId)` at **`:807`**.
- Plan Task 3 step 6's code block writes `deps.toursRepo.getById(row.tourId)` and then flags
  it in prose. The correct line is `const tour = await deps.toursRepo.get(row.tourId);`
- Also note `resolveReminderTarget` tests `if (!tour)`, not `if (tour === undefined)`.
  Either compiles; keep the existing idiom.

---

## 4. Confirmation conversion inventory (plan Task 5 step 1)

Categories: **cat1** = an immediate-send / force-send ride that STOPS WORKING once the poll
excludes `confirmation` (Task 7) - convert. **cat2** = asserts it arms / its ladder position -
leave green now, Task 9 re-baselines. **keep** = union / computeDueAt / catalog / repo-level
pin, unchanged. **redesign** = the case's proof strategy dies with the kind.

### 4a. `app/test/tourReminders.test.ts` (88 lines mention `confirmation`)

| line(s) | test (its `it` line) | what it does | cat | 6.1a precondition of the replacement |
|---|---|---|---|---|
| 222,227,228 | `:199` all-4-rows arm | pins `rows).toHaveLength(4)` + confirmation dueAt = now | cat2 | - |
| 285 (`toHaveLength(4)`) | `:262` no_show guard | arm-count pin | cat2 | - |
| 338 | `:311` late-evening tour | arm dueAt pin | cat2 | - |
| 358,401,403,410 | `:366` en_route supersedes morning_of | arm kinds list `['confirmation','day_before','en_route']` | cat2 | - |
| 414-437 (whole case) | `:416` "a confirmation armed inside quiet hours is clamped to quiet-end" | the case's SUBJECT is confirmation's arm-time clamp | **redesign** | dies with arming; Task 9 must re-point at another rung or delete |
| 483 | `:444` clamped-past-start | arm kinds list | cat2 | - |
| 526 | `:499` retimed day_before | arm kinds list | cat2 | - |
| 643,656,659,664,666 | `:602` "sends due rows and is idempotent" | arms, ticks `now0+1min` for the confirmation ride, ticks again for day_before | **cat1** | `now0=2026-07-13T10:00Z`, `scheduledAt=2026-07-15T10:00Z` - `createDueReminder(..., 'day_before', now0)` is safely `< scheduledAt` |
| 719 | `:679` emits `scheduled.updated` | same two-tick shape | **cat1** | same pair as above |
| 768,775-788 | `:737` claim-skip `no_conversation` | ticks `pollAt=2026-07-13T10:01Z` on the armed confirmation | **cat1** | `scheduledAt=2026-07-15T10:00Z`; any dueAt <= pollAt works |
| 806 | `:798` `claimSend` stores body | calls `repo.claimSend` DIRECTLY, no poll | **keep** | kind is cosmetic |
| 866 | `:834` `invalid_schedule` claim-skip | direct `repo.create` + poll at `2026-01-05T15:00:01Z` | **cat1** | `scheduledAt` corrupted to `'not-an-instant'` AFTER create -> `retiredByTourStart` returns `false` (unparseable), so `invalid_schedule` still wins. Swap kind to `day_before` only |
| 989 | `:960` group-routed quiet defer | direct create, poll `2026-01-15T09:00Z` | **cat1** | `scheduledAt=2026-01-15T20:00Z`, dueAt `08:00Z` - fine |
| 1236-1254 | `:1219` `cancelTourReminders` | `rows.find(r => r.kind==='confirmation')` on an ARMED ladder | cat2 | after T9 that find returns `undefined`; re-baseline to `day_before` |
| 1301-1302 | `:1266` booked_too_late same-day | `armedKinds).toContain('confirmation')` | cat2 | - |
| 1427 | `:1407` booked-too-late case 3 | arm pin | cat2 | - |
| 1544,1546,1547 | `:1527` booked-too-late case 9 | arm pin (`dueAt == now`) | cat2 | - |
| 1573-1579 | `:1556` `listDue` excludes sent/canceled | asserts the confirmation row is the ONLY row due at `now0` | **redesign** | after T9 nothing arms at `now0`; rebuild on a directly-created row |
| 1634 | `:1608` two concurrent polls | arms then ticks at `now0` | **cat1** | `now0=2026-07-13T16:00Z`, `scheduledAt=2026-07-15T16:00Z` |
| 1718 | `:1683` cancel-then-claim race | arms, `listDue(now0)`, finds the confirmation row | **cat1** | `now0=2026-07-13T17:00Z`, `scheduledAt=2026-07-15T17:00Z` |
| 1939,1948,1961,1968,1975,1976 | `:1906` landlord_led group route | arms, ticks `now0`, asserts group body = `rungBody('confirmation', ...)` | **cat1** | `now0=2026-08-01T10:00Z`, `scheduledAt=2026-08-03T18:00Z` |
| (no literal) | `:1982` A2P token bucket | ticks `now0` - rides the same confirmation rung | **cat1** | `now0=2026-08-01T10:00Z`, sched `2026-08-03T18:00Z` |
| (no literal) | `:2026` pm_team group | ticks `now0` | **cat1** | `now0=2026-08-01T11:00Z`, sched `2026-08-03T19:00Z` |
| 2107 | `:2069` self_guided w/ group thread | ticks `now0`, asserts confirmation body | **cat1** | `now0=2026-08-01T12:00Z`, sched `2026-08-03T20:00Z` |
| (no literal) | `:2113` no groupThreadId fallback | ticks `now0` | **cat1** | `now0=2026-08-01T13:00Z`, sched `2026-08-03T21:00Z` |
| 2175 | `:2144` missing group conv, D11 unclaimed | ticks `now0`, `rows.find(kind==='confirmation')` | **cat1** | `now0=2026-08-01T14:00Z`, sched `2026-08-03T22:00Z` |
| 2223 | `:2191` non-relay_group conv | ticks `now0` | **cat1** | `now0=2026-08-01T14:30Z`, sched `2026-08-03T22:30Z` |
| (no literal) | `:2232` CLOSED group | ticks `now0` | **cat1** | `now0=2026-08-01T15:00Z`, sched `2026-08-03T23:00Z` |
| (no literal) | `:2275` opted-out group member | ticks `now0` | **cat1** | `now0=2026-08-01T16:00Z`, sched `2026-08-04T18:00Z` |
| (no literal) | `:2328` concurrent group ticks | ticks `now0` twice | **cat1** | `now0=2026-08-01T17:00Z`, sched `2026-08-04T19:00Z` |
| 2417 | `:2374` per-member adapter failure | ticks `now0`, `rows.find(kind==='confirmation')` | **cat1** | `now0=2026-08-01T18:00Z`, sched `2026-08-04T20:00Z` |
| 2499 | `seedForceTour` param type union | helper signature | keep | - |
| 2544,2557,2570 | `:2523` force-send during quiet hours (headline) | `forceSendReminder` on a `confirmation` row | **cat1 (FORCE)** | `seedForceTour`: `scheduledAt=2026-02-11T20:00Z`, `dueAt=2026-02-11T13:00Z`, `FORCE_NOW=2026-02-10T09:00Z` - safe for any kind |
| 2879 | `:2851` force-send GROUP-routed rung | force-send on `confirmation` | **cat1 (FORCE)** | same seedForceTour pair |
| 2996-2999 | `:2982` D11 self_guided off-roster | poll at `NOW_D11`, reads the confirmation rung | **cat1** | `NOW_D11=2026-08-05T10:00Z`, `SCHEDULED_D11=2026-08-07T18:00Z`, `DAY_BEFORE_D11=2026-08-06T23:30Z` -> tick at `2026-08-06T23:30:01Z` |
| 3018,3019 | `:3002` fallback door | same | **cat1** | same |
| 3048,3049,3050 | `:3022` group-reaching rung still sends | same | **cat1** | same |
| 3060 | `:3053` re-add lifts suppression | same | **cat1** | same |
| 3093,3109 | `:3078` unreadable roster unclaimed | same | **cat1** | same |
| 3123,3130,3143 | `:3112` roster grace bound | reads the confirmation rung's dueAt, ticks `dueAt +/- 61min` | **cat1** | on `day_before`: pastGrace = `2026-08-07T00:31Z` < `SCHEDULED_D11` - OK |
| 3200-3202 | `:3182` D7 pending open WAITS | poll at `NOW_D11` | **cat1** | same |
| (no literal) | `:3205` "AT/AFTER tour start the wait ENDS" | polls at `now === SCHEDULED_D11` and asserts the 1:1 fallback FIRES | **BREAKS under Task 3** - see drift D4 | - |
| (no literal) | `:3223` a RESOLVED open imposes no wait | poll at `NOW_D11` | **cat1** | same |
| 3253 | `:3240` force-send off-roster refusal | force-send `confirmation` | **cat1 (FORCE)** | seedForceTour pair |
| 3290,3311,3339,3373 | `:3279` whole `manual-only hold-back` describe | asserts `MANUAL_ONLY_REMINDER_KINDS` membership + hold-back behaviour | **Task 7 rewrite/delete** | - |
| 3666-3689 | `:3666` guard g3 confirmation force-send SENDS | force-send `confirmation`, unit read throwing | **cat1 (FORCE)** - see drift D8 | `NF_SCHEDULED=2026-03-12T18:00Z`, `NF_DUE=2026-03-11T15:00Z`, `NF_POLL=2026-03-11T15:01Z` |
| 3691-3713 | `:3691` guard g3b same, property read | same | **cat1 (FORCE)** - see drift D8 | same |

### 4b. `app/test/tourRemindersApi.test.ts` (15 sites)

| line(s) | what | cat |
|---|---|---|
| 202,237,266 | GET states test: seeded SENT confirmation, asserts sort order | cat2 (kind list) |
| **259** | `expect(r.suppression).toEqual({ reason: 'paused' })` for every upcoming rung | **re-baseline (T7/T8) - not in the plan's list** |
| 290 | seeded SKIPPED confirmation row (`no_conversation`) | keep |
| **411-424** | `rem-quiet-overdue` kind `confirmation`, asserts `{reason:'quiet_hours'}` | **breaks under T8** (discontinued outranks quiet) - convert kind or re-baseline |
| **443-457** | `rem-quiet-before` kind `confirmation`, asserts `suppression` UNDEFINED | **breaks under T8** - same |
| **473-482** | `rem-quiet-staleheld` kind `confirmation`, asserts `suppression` UNDEFINED | **breaks under T8** - same |
| 654 | terminal (sent) confirmation, asserts no suppression | keep |
| **595, 621** | `{reason:'paused'}` on `day_before` / `en_route` rungs | **re-baseline (T7)** |
| 1003, 1025 | `seedComposedTour` confirmation rung driven by `runDueTourReminders(preview.dueAt, deps)` | **cat1** (`scheduledAt` far future; `dueAt=2026-01-10T10:00Z`) |
| 1051, 1066, 1138 | `seedUncomposableTour` pending confirmation; send-now expects `invalid_schedule` | **cat1** - under T7 force-send would refuse `kind_retired` first |
| 1173 | `expect(pending.kind).toBe('confirmation')` on the degraded GET | cat2 |
| 1511, 1541 | 4-rung panel pin incl. confirmation body | cat2 |
| **1546** | `expect(rung.suppression).toEqual({reason:'paused'})` for ALL FOUR rungs | **re-baseline (T7/T8)** |

### 4c. `app/test/toursApi.test.ts` (10 sites)

`1341,1343,1378,1507,1508,1546,1547,1695,2828,2830` - all ARM-result pins through the
`POST /api/tours` route (`confirmation dueAt === FIXED_NOW`). **All cat2** (Task 9).

### 4d. `app/test/contactTimeline.test.ts` (17 sites)

All READ-surface sites: rows created at `dueAt: '2099-01-05T10:00:00.000Z'` (never polled).
`1114,1218,1226,1348,1379,1402,1450,1480,1520,1534,1557,1571,1597,1623,1645,1664,1689` - **cat2 / read pins**.
`1263` and `1291` assert `suppression).toEqual({ reason: 'paused' })` -> **re-baseline under T7/T8**
(these are the two cases that call `makeGatherHarness(undefined, MANUAL_ONLY_REMINDER_KINDS)` at
`:1243` and `:1297`).

### 4e. `app/test/relayApi.test.ts` (7 sites)

`1477,1493,1494,1503,1585,1676` plus three `expect(scheduled).toHaveLength(4)` ladder pins
(`:1469`, `:1581`, `:1679`). **cat2** - Task 9 re-baselines 4 -> 3.
`1493-1503` calls `claimSend` DIRECTLY (repo-level), so it is a kind swap only, not a poll ride.
**`relayApi.test.ts` is NOT in the plan's Task 9 file list.**

### 4f. `app/test/devGating.test.ts` (4 sites)

`462` (`CONFIRMATION_BODY`), `522`, `558`, `588`. The `:553` case ticks at `FIXED_NOW` and
asserts `world.sent[0] === CONFIRMATION_BODY`. **cat1**, covered by plan Task 7 step 3.
`FIXED_NOW=2026-07-13T14:00Z`, `SCHEDULED_AT=2026-07-15T18:00Z`, day_before armed at
`2026-07-14T23:30Z` - a `day_before` ride at `2026-07-14T23:31Z` is safe.

### 4g. `app/test/placementConvert.test.ts` (1 site)

`:78` - a pending confirmation row created purely to prove cancel-on-convert. **keep**
(the kind is incidental; nothing sends).

### 4h. `app/test/seedLive.test.ts` (10 sites)

`51,59,91,179,186,195,217,218,242,254` - seed-result pins. **cat3 (Task 9)**.
`:217-218` asserts `confirmation` is born `quiet_hours_superseded`; `:91` and `:254` are
expected-kind arrays.

### 4i. KEEP-UNCHANGED (confirmed)

- `app/test/computeDueAt.test.ts:14-15` - raw table pin; `computeDueAt` keeps its case.
- `app/test/tourCopy.test.ts:75-78,116,147,163-165,183-197,249,269` - catalog/copy pins;
  the catalog entries and the `ReminderKind` union both survive.

---

## 5. Every reader of `manualOnlyKinds` / `manualOnlyReminderKinds` / `MANUAL_ONLY_REMINDER_KINDS`

### Production (`app/src`)

| path:line | form | note |
|---|---|---|
| `app/src/jobs/tourReminders.ts:201` | the SET definition | T7 empties it |
| `app/src/jobs/tourReminders.ts:473-477` | `manualOnlyKinds?` dep + docblock | T7 rewrites the docblock |
| `app/src/jobs/tourReminders.ts:589,602-603` | the ONE poll read | T7 adds the discontinued disjunct |
| `app/src/routes/tourReminders.ts:70` | `import { MANUAL_ONLY_REMINDER_KINDS, ... }` | |
| `app/src/routes/tourReminders.ts:110-117` | `manualOnlyKinds?` seam + docblock | plan says `:110` - **exact** |
| `app/src/routes/tourReminders.ts:173` | `const manualOnlyKinds = deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS;` | |
| `app/src/routes/tourReminders.ts:589` | `const paused = manualOnlyKinds.has(row.kind);` | T8 chip branch |
| `app/src/routes/contactTimeline.ts:84` | import | |
| `app/src/routes/contactTimeline.ts:115-118` | `manualOnlyReminderKinds?` seam + docblock | plan says `:115` - **exact** |
| `app/src/routes/contactTimeline.ts:813,827` | interface field + destructure | **plan does not name these two** |
| `app/src/routes/contactTimeline.ts:1005` | `manualOnlyReminderKinds.has(row.kind)` - THE consuming call | **plan does not name `:1005`; it names `:1091`** |
| `app/src/routes/contactTimeline.ts:1091` | `deps.manualOnlyReminderKinds ?? MANUAL_ONLY_REMINDER_KINDS` | |
| `app/src/routes/contactTimeline.ts:1308` | forwards it into the sub-builder | **plan does not name it** |
| `app/src/routes/api.ts:391-398` | `tourReminderManualOnlyKinds?` seam + docblock (field at `:398`) | plan says `routes/api.ts:389` - **off by ~2 to 9; drift D3** |
| `app/src/routes/api.ts:829` | `manualOnlyReminderKinds: deps.tourReminderManualOnlyKinds` (timeline) | |
| `app/src/routes/api.ts:938` | `manualOnlyKinds: deps.tourReminderManualOnlyKinds` (tour route) | |
| `app/src/routes/dev.ts:406-422` | the DELIBERATE DIVERGENCE comment (`406-419`) + `manualOnlyKinds: new Set()` at **`421`** | plan says `:404-422` - close; the override is at `421` |
| `app/src/routes/dev.ts:622` | `manualOnlyKinds: new Set()` - **PLACEMENT NUDGES, NOT tours. DO NOT TOUCH.** | |
| `app/src/routes/placementNudges.ts:104,202,411` | `MANUAL_ONLY_NUDGE_KINDS` twin - out of scope | |

### Tests / e2e the plan does NOT name

| path:line | form | consequence of T7 |
|---|---|---|
| `app/test/helpers/twilioWebhookHarness.ts:3930-3936` | `tourReminderManualOnlyKinds?` harness option + docblock citing "the production hold-back" | docblock becomes false - rewrite with the other seams |
| `app/test/contactTimeline.test.ts:17` | `import { MANUAL_ONLY_REMINDER_KINDS }` | |
| `app/test/contactTimeline.test.ts:1139,1163` | `makeGatherHarness(..., manualOnlyReminderKinds = new Set())` | |
| `app/test/contactTimeline.test.ts:1243,1297` | passes the REAL set; asserts `{reason:'paused'}` at `1263`,`1291` | must re-baseline |
| `app/test/tourReminders.test.ts:45,72-75` | `NO_MANUAL_HOLD_BACK` wrapper | wrapper becomes a no-op; keep or delete deliberately |
| `app/test/tourReminders.test.ts:3288-3295` | asserts all four auto-armed kinds ARE in the set | **fails the moment the set is emptied** |
| `app/test/tourRemindersApi.test.ts:161-174` | same `NO_MANUAL_HOLD_BACK` wrapper | |
| `e2e/tests/scenarios/quiet-hours.spec.ts:96-112` | `QUIET_NOTE` / `PAUSED_NOTE` constants, with a comment saying the specs return to `QUIET_NOTE` "the moment `MANUAL_ONLY_REMINDER_KINDS` is emptied" | **`:368-369` and `:402-403` assert `PAUSED_NOTE` visible + `QUIET_NOTE` absent - both FLIP under Task 7.** Plan defers this to Task 10 step 4, but the trigger is Task 7 |

---

## 6. Test rig idioms - `app/test/tourReminders.test.ts` (3715 lines)

Suite gate: `describe.skipIf(!reachable)('tourReminders against DynamoDB Local', ...)` at `:130`.
Real DynamoDB Local repos for tours + reminders (`:138-139`); everything else is an in-memory
`createFakeWorld()` (`:142`, from `./helpers/twilioWebhookHarness.js`).

### The fake world / rig (`:1825-1853`)

```ts
  function createGroupTestRig(opts: { failFor?: string[] } = {}) {
    const world = createFakeWorld();
    const spy = createAdapterSpy(opts);
    const send = createSendMessageService({ logger, adapter: world.adapter, ... });
    const deps = {
      tourRemindersRepo: tourReminders,
      toursRepo: tours,
      contactsRepo: world.contactsRepo,
      conversationsRepo: world.conversationsRepo,
      unitsRepo: world.unitsRepo,
      messagesRepo: world.messagesRepo,
      sendMessageService: send,
      adapter: spy.adapter,
      settingsRepo: quietOff,
      logger,
    };
    return { world, deps, groupSends: spy.sends };
  }
```

`runDeps` (the file-level shared deps, `:164-182`) is the same shape wired to the file-level
shared `world`.

### Driving a tick

```ts
const NO_MANUAL_HOLD_BACK: ReadonlySet<ReminderKind> = new Set();          // :72
function runDueTourReminders(now: string, deps: RunDueTourRemindersDeps): Promise<void> {
  return runDueTourRemindersRaw(now, { manualOnlyKinds: NO_MANUAL_HOLD_BACK, ...deps });  // :73-75
}
```

`await runDueTourReminders('2026-07-13T10:01:00.000Z', runDeps);` (`:644`). Clocks are ALWAYS
injected ISO strings; nothing reads the wall clock. The `manual-only hold-back` describe
(`:3279-3385`) is the only place that calls `runDueTourRemindersRaw` directly.

### Stubbing a repo to THROW (`:3459-3470`)

```ts
      if (opts.throwing === 'unit') {
        rig.world.unitsRepo.getById = async () => {
          throw new Error('units unavailable');
        };
      } else {
        const boom = opts.throwing === 'tenant' ? tenantId : landlordId;
        const realGetById = rig.world.contactsRepo.getById.bind(rig.world.contactsRepo);
        rig.world.contactsRepo.getById = async (contactId: string) => {
          if (contactId === boom) throw new Error('contacts unavailable');
          return realGetById(contactId);
        };
      }
```

Log assertions use the shared `logCapture` with a `from` index (`:3490-3493`):

```ts
    function msgsSince(from: number): unknown[] {
      return logCapture.lines.slice(from).map((l) => l['msg']);
    }
```

### Quiet-hours config shape (`app/test/helpers/settingsStub.ts`)

```ts
export type SettingsReadRepo = Pick<SettingsRepo, 'getOrgSettings'>;              // :20
export function stubSettingsRepo(over: Partial<OrgSettings> = {}): SettingsReadRepo   // :23  (quiet hours ON, 21:00-08:00 America/New_York)
export function quietOffSettingsRepo(): SettingsReadRepo                          // :32  ({ quietHoursEnabled: false })
export function failingSettingsRepo(): SettingsReadRepo                           // :37
export function quietNowSettingsRepo(): SettingsReadRepo                          // :86  (window always contains the wall clock)
export function quietLaterSettingsRepo(): SettingsReadRepo                        // :113
export function isoHoursFromNow(hours: number): string                            // :53
```

In `tourReminders.test.ts`: `const quietOff = quietOffSettingsRepo();` (`:148`) and
`const quietOnDeps = <T extends object>(deps: T) => ({ ...deps, settingsRepo: stubSettingsRepo() });` (`:900`).

### Force-send rig (`:2435-2518`)

`makeForceSendSpy()` (`:2435`) returns `{ service, sent }`;
`seedForceTenant(world, {contactId, phone, convId, now, consent?, contactOptOut?, convOptOut?, deletedAt?})` (`:2459`);
`seedForceTour({tenantId, unitId, kind, tourType?})` (`:2496`) creates
`scheduledAt: '2026-02-11T20:00:00.000Z'` + `dueAt: '2026-02-11T13:00:00.000Z'`;
`FORCE_NOW = '2026-02-10T09:00:00.000Z'` (`:2517`), `SEEDED_AT = '2026-02-09T15:00:00.000Z'` (`:2518`).

### Body expectations

`rungBody(kind, scheduledAt, tourType = 'self_guided', names = {})` (`:115-128`) composes via
the production `composeTourReminderBody` - never a literal.

---

## 7. Skip-reason writers / readers (invariant sweep)

**Writers of `skippedAt`/`skipReason` on reminder rows (app-wide):**

| site | reason |
|---|---|
| `jobs/tourReminders.ts:376-381` (arm `create({skipped})`) | `booked_too_late` |
| `jobs/tourReminders.ts:398-403` | `past_event` |
| `jobs/tourReminders.ts:422-427` | `quiet_hours_superseded` |
| `jobs/tourReminders.ts:900` via `claimSkipRow` | `quiet_hours_superseded` |
| `jobs/tourReminders.ts:933` | `target.unresolvable` (`tour_missing`/`contact_missing`/`contact_no_phone`/`no_conversation`) |
| `jobs/tourReminders.ts:989` | `roster_unavailable` |
| `jobs/tourReminders.ts:1003` | `tenant_not_on_roster` |
| `jobs/tourReminders.ts:1034` (1:1) and `:1201` (group) | `invalid_schedule` |
| `repos/tourRemindersRepo.ts:296-326` | the only DB write (`claimSkip`) |

`claimSkip` has exactly ONE caller: `claimSkipRow` (`jobs/tourReminders.ts:651`). No route, no
script, no seed writes a reminder skip today.

**Readers of `skipReason`:**

| site | note |
|---|---|
| `app/src/routes/tourReminders.ts:148` (view type), `:347` (`viewOf` projection), `:607` (GET projection) | the ONLY app-side projection |
| `dashboard/src/api/types.ts:1208-1223` (wire union), `:1272` (`REMINDER_SKIP_REASON_LABELS`) | |
| `dashboard/src/routes/tours/RemindersPanel.tsx:103` | `REMINDER_SKIP_REASON_LABELS[rung.skipReason]` |
| `dashboard/src/routes/tours/RemindersPanel.test.tsx:142,167,515` | fixtures |
| `dashboard/src/api/types.test.ts:95-...` | `SKIP_REASONS` completeness |

**`app/src/routes/contactTimeline.ts` does NOT project `skipReason` at all** (grep: zero hits).
So a `tour_already_passed` retirement is invisible on the contact timeline - it will simply
drop out of the Upcoming bucket. Neither the spec nor the plan mentions this; if Phase B wants
the timeline to explain the sweep's retirements, that is an unlisted surface.

---

## 8. DRIFT FLAGS

**D1 [blocking-ish] `ForceSendRefusal` anchor is wrong.** Plan Task 2 says
`app/src/jobs/tourReminders.ts:1317-1330`; the union is at **`1299-1329`** (`:1317` is inside the
`roster_unavailable` docblock). Task 7 repeats `:1317-1330`. Locate by name.

**D2 [correctness] `toursRepo.get`, not `getById`.** Plan Task 3 step 6's code block writes
`deps.toursRepo.getById(row.tourId)` and corrects it only in prose. TRUE:
`toursRepo.ts:131` declares `get(tourId)`; the live call is `jobs/tourReminders.ts:807`
`await deps.toursRepo.get(row.tourId)`. Also the live guard is `if (!tour)`, not
`if (tour === undefined)`.

**D3 [minor] seam anchors off.** `routes/api.ts` seam docblock is `391-397`, field `398` (plan:
`:389`). `routes/dev.ts` tour override is at `421` inside the comment block `406-419` (plan:
`:404-422`). `steps.ts` helpers: `armedReminderDueAt` `2016-2030`, `tickTourReminders` docblock
`2032-2037`, fn `2038-2046` (plan: `:2013-2046`, `:2034-2038`).

**D4 [BLOCKING] Task 3's past-tour gate KILLS an existing green test and makes the D7
`beforeStart` branch dead code.** `app/test/tourReminders.test.ts:3205` ("AT/AFTER tour start
the wait ENDS") polls at `now === SCHEDULED_D11` on a rung whose `dueAt` is `NOW_D11`
(< scheduledAt) and asserts `rig.world.sent.length > 0`. Under `retiredByTourStart`
(`dueAt < startIso && now >= startIso`) that rung is claim-skipped `tour_already_passed`
BEFORE reaching the D7 branch. More generally: every rung that can reach the D7 wait has
`dueAt < scheduledAt`, so the `beforeStart` escape at `:956` becomes UNREACHABLE. The plan's
Task 3 step 7 says only "the beforeStart docblock's 'can never be held past the tour' sentence
now holds because of THIS gate; say so" - it does not notice the branch is now dead, nor that
the test must be redesigned or deleted. **Decide explicitly: delete the `beforeStart` disjunct
(and its test) or keep it as defence-in-depth with a comment saying the gate makes it
unreachable.**

**D5 [HIGH] Task 7's `kind_retired` guard CANNOT use `refuse`.** The plan says
"refuses immediately after the row lookup - CHECK where the local `refuse` helper is declared".
Verified: `refuse` is declared at **`:1420`**, AFTER target resolution. The row lookup is at
`:1373-1378`. To get the stated precedence (`kind_retired` > `tour_already_passed` >
`names_unavailable`) the guard must be an INLINE
`return { outcome: 'refused', reason: 'kind_retired' };` at ~`:1379`, matching the existing
inline returns at `:1375`, `:1408`, `:1415`. Alternatively hoist `refuse` above the row lookup -
but it closes over `row.kind`, so hoisting requires restructuring. Say which.

**D6 [HIGH] Emptying `MANUAL_ONLY_REMINDER_KINDS` breaks 8 `{reason:'paused'}` assertions the
plan never enumerates**, none of them confirmation-specific:
`app/test/tourRemindersApi.test.ts:259,595,621,1546`, `app/test/contactTimeline.test.ts:1263,1291`,
and the e2e flip at `e2e/tests/scenarios/quiet-hours.spec.ts:368-369,402-403` (PAUSED_NOTE ->
QUIET_NOTE - the file's own `:96-112` comment predicts it). Plus
`app/test/tourReminders.test.ts:3288-3295` asserts the four kinds ARE in the set. Add these to
Task 7's file list; the plan defers the e2e half to Task 10 step 4, which runs AFTER Task 9's
full-suite checkpoint.

**D7 [HIGH] Task 8's `discontinued` branch breaks three quiet-hours preview tests the plan does
not name.** `app/test/tourRemindersApi.test.ts:411-424`, `:443-457`, `:473-482` seed
`kind: 'confirmation'` rungs and assert `{reason:'quiet_hours'}` / `undefined`. With
`discontinued` placed FIRST in the route ternary those all become `{reason:'discontinued'}`.
Cheapest fix: swap those three fixtures to `day_before` (they are quiet-hours tests, not
confirmation tests).

**D8 [MEDIUM] Task 9 silently deletes 6.3b coverage.** `guard g3` (`:3666`) and `guard g3b`
(`:3691`) exist BECAUSE confirmation's copy renders no name - they pin
`assessNamesReadFailure`'s "no name rendered -> never blocked" half. Converting them to
`day_before` makes them byte-duplicates of `g1`/`g2`. Decide: keep the rows as directly-created
`confirmation` rows (force-send would then refuse `kind_retired`, so the assertion must flip),
or accept the coverage loss and say so in the handback.

**D9 [MEDIUM] Two files carrying `confirmation` ladder pins are missing from Task 9's list.**
`app/test/relayApi.test.ts` has three `expect(scheduled).toHaveLength(4)` ladder assertions
(`:1469`, `:1581`, `:1679`) plus an expected-kind array at `:1585`; the plan lists relayApi only
under Task 5's "possibly touched". Also `app/test/toursApi.test.ts:1341-1378,1507,1546,1695,2828`
are arm-count/dueAt pins that Task 9 must re-derive (the plan mentions toursApi only in Task 14).

**D10 [LOW] Stale in-code line references the builders will trip on.**
`jobs/tourReminders.ts:1381-1383` cites "the tour (:652) ... the tenant contact (:673)" - TRUE
lines are `807` and `828`. `app/test/tourReminders.test.ts:3417` cites
"jobs/tourReminders.ts:797" for the D7 presence gate - TRUE line is `952`. Any task touching
those blocks should correct them rather than propagate them.

### Verified-correct plan claims (no action)

- `repo.create` does NOT drop a past-due row (`tourRemindersRepo.ts:174-197`) - Task 5's
  vehicle premise holds.
- Reminder rows are keyed on a bare `reminderId` hash key, no sort key; GSIs `byTour` and
  `byDueAt` (`_reminderPartition` = `'reminders'`, range `dueAt`) - Task 4's Scan is a plain
  table Scan with no key trickery.
- `rosterWaitExpired` is already imported at `:56`; Task 11 needs no new import.
- The poll's manual-only filter is read at exactly ONE place (`:602-603`), as the spec claims.
- `tours.spec.ts` cat-4 site: TRUE block is `e2e/tests/scenarios/tours.spec.ts:281-288`
  (comment `281-286`, tick `287`, absence assert `288`) - the plan's `:283-287` is close enough
  to locate.
