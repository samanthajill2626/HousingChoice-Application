> **FINDINGS HALF ONLY.** Extracted 2026-09-01 from `research-6-tests-seeds-docs.md`, which was 77-87%
> byte-exact quotation of code git holds at the commits cited here. Only the DRIFT
> (plan/spec vs the live tree) and GAPS (what the change breaks that the plan omits)
> sections are kept. The reference half was not committed.

## DRIFT

Where the plan's stated line numbers / quoted strings / claimed derivations do not match the live tree.

### D-1. Line numbers — ACCURATE (verified exactly)

`app/src/jobs/tourReminders.ts:89-118` (computeDueAt), `:248-251` (pass 1), `:261` (tourLocalDate), `:262-314` (pass 2), `:266` (past-dueAt branch); `app/src/routes/tours.ts:350` and `:1178`; `app/test/seedLive.test.ts:53-78` (twin), `:84` (REMINDER_KINDS), `:180-208`/`:198-204`/`:207` (TOUR-A), `:219-246` (TOUR-B); `app/test/tourReminders.test.ts:174-228`, `:275-324`, `:322`, `:323`, `:329-361`, `:359`, `:394-432`, `:427`, `:437-463`, `:459`, `:462`, `:1191-1237`, `:1213`, `:1218-1229`; `app/test/toursApi.test.ts:1411-1414`, `:1449-1450`, `:1593-1594`; `app/test/devGating.test.ts:451-452`; `app/test/tourRemindersApi.test.ts:237`; `app/src/lib/seed/matrix.ts:930`, `:958`, `:995-999`; `app/src/lib/seed/cast.ts:768-797`; `documentation/tours-sequence-writeup.md:104-120` / `:108-120`; `docs/issues/tour-reminders-panel-e2e-flake.md:112`.

### D-2. Line numbers — OFF

| plan says | live | delta |
|---|---|---|
| Task 6 Step 5, Test 1f: "the preamble at `:396-398`" | the preamble comment block is `:395-398` | starts one line earlier |
| Task 6 Step 5, toursApi "`:2727-2731`" | the `day_before` assertion is at **`:2730`**; `:2727-2729` are comments; `:2726` is the `confirmation` assertion | one-line offset |
| Task 10 Step 1: "comments `:983-991`" | the comment is `:984-985` and `:991`; `:983` is `if (upcoming) {` and `:986-994` is the push | imprecise but harmless |
| **Spec 13** (not the plan): "`cast.ts:768-795`" | the array literal closes at `:797` | the last two lines of the block are outside the cited range |
| **Spec 10** (not the plan): "`routes/tours.ts:349`" | the call is at `:350` | off by one (the plan corrects it) |

### D-3. Quoted strings / claimed shapes that do not match

1. **`seedLive.test.ts` twin signature.** Plan Task 6 Step 1 writes the new unit test against `computeDueAt(kind, scheduledAt, now, WINDOW)` and Step 3 supplies raw-only `case` bodies. The **twin** is `computeDueAt(kind, scheduledAt, now)` with the window closed over as `QUIET_WINDOW` (`:51`) and a clamp folded in at `:77`. Step 4's "mirror the two cases exactly" is right in intent, but the code fragments in Step 3 cannot be pasted verbatim into the twin.

2. **Plan Task 7 Step 3's warn snippet** references `window.start` / `window.end`. Live `QuietHoursWindow` (`app/src/lib/quietHours.ts:11-17`) — verify the field names before pasting; the file exports `quietHoursWindowOf` and `isQuietTime(nowIso, window)` (`:137`), which is the API the snippet uses correctly.

3. **`docs/issues/tour-reminders-panel-e2e-flake.md` frontmatter is not terminated after `refs:`.** The plan describes it as a normal issue file ("Body edit only - status stays resolved") and does not warn that the frontmatter block runs to `:28` and swallows a comment + a paragraph. Any inserted line matching `^word:` inside `:12-27` will silently become a bogus frontmatter field.

4. **`tourcopy-messageid-cast-unguarded.md`'s Suggested fix (`:48-51`) references `tour.<kind>_no_address` twins**, which spec 6.4 removes. The plan's Resolution paragraph will sit directly under a now-false Suggested fix.

### D-4. Arithmetic re-derivation — every plan-asserted dueAt

All derivations below are independent, from the fixture's `scheduledAt` / `now` / window. America/New_York; Jan = EST (UTC−5), Jul/Aug = EDT (UTC−4); DST 2026 spring-forward = **Mar 8** (Mar 1 2026 is a Sunday; second Sunday = Mar 8) — the plan's transition date is correct.

#### Task 6 Step 1 (the new `computeDueAt.test.ts`)

| assertion | recomputed | verdict |
|---|---|---|
| `confirmation(TOUR=2026-07-23T19:00Z, NOW)` → `NOW` | trivially `NOW` | **AGREE** |
| `day_before(2026-07-23T19:00Z)` → `2026-07-22T23:30:00.000Z` | tour = 15:00 EDT Thu Jul 23 (Jul 23 2026 **is** a Thursday); local date Jul 23; day-before = Jul 22; 19:30 EDT = 23:30 UTC | **AGREE** |
| `day_before(2026-01-20T20:00Z)` → `2026-01-20T00:30:00.000Z` | 15:00 EST Jan 20; day-before Jan 19; 19:30 EST = 00:30 UTC Jan 20 | **AGREE** |
| `day_before(2026-03-09T16:00Z)` → `2026-03-08T23:30:00.000Z` | Mar 9 is post-transition → 12:00 EDT; day-before Mar 8; 19:30 on Mar 8 is EDT → 23:30 UTC Mar 8 | **AGREE** |
| `day_before(2026-03-06T16:00Z)` → `2026-03-06T00:30:00.000Z` | Mar 6 pre-transition → 11:00 EST; day-before Mar 5; 19:30 EST = 00:30 UTC Mar 6 | **AGREE** (and the plan's "19:30 EST Mar 5" gloss is right) |
| `morning_of(TOUR)` → `2026-07-23T15:00:00.000Z` | 19:00Z − 4h | **AGREE** |
| `en_route(TOUR)` → `2026-07-23T18:00:00.000Z` | 19:00Z − 1h | **AGREE** |
| `no_show_checkin(TOUR)` → `2026-07-23T19:30:00.000Z` | 19:00Z + 30m | **AGREE** |

#### Task 6 Step 5

**Test 1** — sched `2026-01-20T20:00Z` (15:00 EST), now `2026-01-19T15:00Z` (10:00 EST), window 21:00-08:00 ON.
- `day_before` → 19:30 EST Jan 19 = `2026-01-20T00:30:00.000Z`; 19:30 < 21:00 so outside the window, unclamped. **AGREE.**
- `morning_of` → 20:00Z − 4h = `2026-01-20T16:00:00.000Z` = 11:00 EST, outside window. **AGREE** (plan's "11:00 EST, unclamped" is right).
- All four slots distinct → `:197` `toHaveLength(4)` survives. Plan does not say so explicitly; it holds.

**Test 1c** — sched `2026-01-21T03:00Z` (Jan 20 22:00 EST, local date **Jan 20**), now `2026-01-19T15:00Z`, window ON.
- `day_before` → 19:30 EST Jan 19 = `2026-01-20T00:30:00.000Z`, outside window, unclamped, > now → **ARMS**. **AGREE.**
- `morning_of` → 03:00Z − 4h = `2026-01-20T23:00:00.000Z` = 18:00 EST Jan 20, outside window → **ARMS**. **AGREE.**
- `en_route` → 03:00Z − 1h = `2026-01-21T02:00:00.000Z` = 21:00 EST, **inside** window → clamps to Jan 21 08:00 EST = `2026-01-21T13:00:00.000Z` ≥ scheduledIso → `past_event`. **AGREE** (unchanged).
- `staleDayBefore` does not fire: clamped local date Jan 19 ≠ tour local date Jan 20. No slot collisions.
- `:322` `toHaveLength(4)` **survives**; `:323` becomes `toHaveLength(3)` (confirmation, day_before, morning_of). **AGREE.**

**Test 1d** — sched `2026-01-20T13:30Z` (08:30 EST), now `2026-01-19T15:00Z`, window ON.
- `day_before` → `2026-01-20T00:30:00.000Z` > now → `:359` `toBeUndefined` **inverts to armed**. **AGREE.**
- `morning_of` → 13:30Z − 4h = `2026-01-20T09:30:00.000Z` = 04:30 EST, **inside** window → clamps to `2026-01-20T13:00:00.000Z`. **AGREE.**
- `en_route` → `2026-01-20T12:30:00.000Z` = 07:30 EST, inside → clamps to the same `13:00:00.000Z`; en_route is the later rung → morning_of superseded. Outcome unchanged. **AGREE.**
- Counts 4 rows / 3 unskipped: **AGREE** — but see GAP-6: **there is no length or filter assertion in Test 1d to re-derive.**

**Test 1f** — sched `2026-01-20T12:30Z` (07:30 EST), now `2026-01-18T15:00Z`, window ON.
- `day_before` → `2026-01-20T00:30:00.000Z`, outside window, > now, local date Jan 19 ≠ Jan 20, < scheduledIso → **ARMS**. `:427` becomes `'2026-01-20T00:30:00.000Z'`. **AGREE.**
- `morning_of` → `2026-01-20T08:30:00.000Z` (03:30 EST) → clamps to `13:00:00.000Z` ≥ 12:30Z → `past_event`. **AGREE** (unchanged).
- `en_route` → `2026-01-20T11:30:00.000Z` (06:30 EST) → clamps to `13:00:00.000Z` → `past_event`. Unchanged.
- `:429-431` `['confirmation','day_before']` **survives unchanged**. Plan does not say so; it holds.

**Test 1g** — sched `2026-01-20T12:30Z`, now `2026-01-19T15:00Z`, window ON.
- `day_before` → `2026-01-20T00:30:00.000Z` > now → arms; `:459` inverts. **AGREE.**
- `morning_of` / `en_route` → both clamp to `13:00Z` ≥ 12:30Z → `past_event`. Unchanged.
- `:462` (unsorted `.map`, iteration order = `REMINDER_KINDS`) → `['confirmation', 'day_before']`. **AGREE.**

**Test 5 (Task-6 interim)** — sched `2026-07-13T14:00Z` (10:00 EDT), now0 `2026-07-13T09:00Z` (05:00 EDT), **quietOff**.
- `day_before` → 19:30 EDT Jul 12 = `2026-07-12T23:30:00.000Z` < now0 → past-dueAt silent drop → still absent, `:1213` still green in Task 6. **AGREE.**
- `morning_of` → 14:00Z − 4h = `2026-07-13T10:00:00.000Z` > now0 → armed. **AGREE.**
- `en_route` 13:00Z unchanged; no collision (10:00 vs 13:00). **AGREE.**

**toursApi `:1411-1414`** — FIXED_NOW `2026-07-13T14:00Z` (10:00 EDT), sched `2026-07-15T18:00Z` (14:00 EDT), window ON.
- `day_before` → 19:30 EDT Jul 14 = `2026-07-14T23:30:00.000Z`, outside window. **AGREE.**
- `morning_of` → `2026-07-15T14:00:00.000Z` (10:00 EDT), outside window. **AGREE.**
- `en_route` `2026-07-15T17:00:00.000Z` unchanged; four distinct slots. **AGREE.**

**toursApi `:1449-1450`** — FIXED_NOW `2026-07-13T15:00Z`, NEW_SCHEDULED `2026-07-20T18:00Z` (14:00 EDT).
- `day_before` → 19:30 EDT Jul 19 = `2026-07-19T23:30:00.000Z`. **AGREE.**

**toursApi `:1593-1594`** — FIXED_NOW `2026-07-13T14:00Z`, BOOKED_AT `2026-07-15T18:00Z`. Identical fixture to `:1411`. → `2026-07-14T23:30:00.000Z`. **AGREE.**

**toursApi `:2730`** (plan cites `:2727-2731`) — FIXED_NOW `2026-07-13T12:00Z` (08:00 EDT), NEW_SCHED `2026-07-25T10:00Z` (**06:00 EDT** Jul 25), window ON.
- Plan gives no value, only "re-derive". **Corrected value: `'2026-07-25...' → no — `'2026-07-24T23:30:00.000Z'`.** Derivation: tour local date Jul 25; day-before Jul 24; 19:30 EDT = 23:30 UTC Jul 24; 19:30 local is **outside** [21:00, 08:00) → unclamped; > FIXED_NOW; clamped local date Jul 24 ≠ Jul 25 so no staleDayBefore; 23:30Z < 10:00Z Jul 25 so not past-event. **AGREE with the plan's claim that its comment about "06:00 EDT, INSIDE the default quiet window" is now false**, and the corrected literal is `'2026-07-24T23:30:00.000Z'`.
- Surrounding skips unchanged: `morning_of` raw = `2026-07-25T06:00:00.000Z` (02:00 EDT, inside window) → clamps to `2026-07-25T12:00:00.000Z` ≥ 10:00Z → `past_event` (same as today); `en_route` raw `2026-07-25T09:00:00.000Z` (05:00 EDT, inside) → clamps to `12:00Z` → `past_event`. The parenthetical at `:2729` stays true. **AGREE.**

**devGating** — FIXED_NOW `2026-07-13T14:00Z`, SCHEDULED_AT `2026-07-15T18:00Z`.
- New `day_before` = 19:30 EDT Jul 14 = `'2026-07-14T23:30:00.000Z'`. **AGREE.**
- Consequently `:561` → `'2026-07-14T23:31:00.000Z'`, `:575` → `'2026-07-14T23:31:00Z'`, `:577` → `'2026-07-14T23:31:00.000Z'`. Verified safe: 19:30 EDT is outside the fire-time quiet window (no defer); `morning_of` moves to `2026-07-15T14:00:00.000Z` so it is still not in either tick's batch; `:552`'s FIXED_NOW tick still catches confirmation alone. **AGREE** with the plan's direction; the plan just never states the three literals.

#### Task 7 Step 1 (the nine new cases)

| case | plan's instants | recomputed | verdict |
|---|---|---|---|
| 1 | cutoff `2026-07-22T19:30Z` (15:30 EDT); now `…19:30:00.001Z` → skip; dueAt `2026-07-22T23:30:00.000Z` | raw = 19:30 EDT Jul 22 = 23:30Z; 23:30Z − 4h = 19:30Z ✓; quietOff so clamped == raw ✓; morning_of 15:00Z / en_route 18:00Z arm ✓ (rule 2 not sameDay: now local Jul 22 ≠ tour local Jul 23) | **AGREE** |
| 2 | now `…19:30:00.000Z` → arms (strict `>`) | equal, not greater ✓ | **AGREE** |
| 3 | now `2026-07-23T14:00Z` (10:00 EDT) → day_before AND morning_of both visible `booked_too_late` | rule 1: 14:00Z Jul 23 > 19:30Z Jul 22 ✓; rule 2: local dates both Jul 23 ✓ and 14:00Z > 13:00Z (=19:00Z−6h) ✓ | **AGREE** |
| 4 | now `2026-07-23T16:00Z` "booked 3h out"; morning_of visible; en_route arms | 19:00Z − 16:00Z = 3h ✓; rule 2 fires ✓; en_route 18:00Z > 16:00Z ✓ | **AGREE** |
| 5 | now `2026-07-23T13:00Z` = exact cutoff → morning_of arms | 19:00Z − 6h = 13:00Z, strict `>` fails ✓; morning_of raw 15:00Z > now so no past-dueAt ✓ (note day_before **is** booked_too_late in this fixture — plan doesn't assert it, harmless) | **AGREE** |
| 6 | tour `2026-07-24T05:00Z` (Jul 24 01:00 EDT), now `2026-07-24T01:00Z` (Jul 23 21:00 EDT) → morning_of arms | local dates Jul 24 vs Jul 23 differ ✓; gap 4h < 6h lead ✓ | **AGREE**, with a caveat: `morning_of` raw = 05:00Z − 4h = `2026-07-24T01:00:00.000Z` = **exactly `now`**. The past-dueAt branch is `if (dueAt < now)`, so it survives — but the row is armed already-due (`listDue` is `dueAt <= now`). The plan does not mention this; a builder who "tidies" the boundary to `<=` breaks the case. |
| 7 | reschedule/revival | see D-5 below | **AGREE on mechanism, DISAGREE on fixture reuse** |
| 8 | `quietHoursStart: '19:00'`, now `2026-07-20T12:00Z`; day_before raw 23:30Z inside window → clamps to `2026-07-23T12:00:00.000Z` (08:00 EDT tour day) → `quiet_hours_superseded` + warn | window [19:00, 08:00) contains 19:30 ✓; next 08:00 local after 19:30 EDT Jul 22 = 08:00 EDT Jul 23 = 12:00Z ✓; that local date (Jul 23) == tour local date → `staleDayBefore` ✓; rule 1 does **not** pre-empt (cutoff Jul 22 19:30Z > now Jul 20 12:00Z) ✓ so the staleDayBefore path is genuinely reachable; confirmation at 08:00 EDT = quiet-END, end-exclusive → unclamped ✓ | **AGREE** |
| 9 | now `2026-07-23T18:30Z` (14:30 EDT); en_route no row + the log line; day_before/morning_of visible; confirmation armed; 3 rows | en_route raw 18:00Z < 18:30Z → `:266`/`:267` silent drop, log msg is byte-exact `'tour reminder skipped (dueAt in the past)'` ✓; rule 1 ✓; rule 2 (sameDay Jul 23, 18:30Z > 13:00Z) ✓; confirmation dueAt = 18:30Z < 19:00Z scheduledIso → not past-event ✓ | **AGREE** |

#### Task 7 Step 4

**Test 5 (post-rules)** — sched `2026-07-13T14:00Z`, now0 `2026-07-13T09:00Z`, quietOff.
- `day_before`: cutoff = `2026-07-12T23:30Z` − 4h = `2026-07-12T19:30:00.000Z`; now0 Jul 13 09:00Z > that ✓ → visible `booked_too_late`, dueAt `2026-07-12T23:30:00.000Z`. **AGREE.**
- `morning_of`: sameDay (now0 = 05:00 EDT Jul 13 == tour local Jul 13) ✓; 09:00Z > `2026-07-13T08:00:00.000Z` (14:00Z − 6h) ✓ → visible `booked_too_late`, dueAt `2026-07-13T10:00:00.000Z`. **AGREE.**
- `en_route` 13:00Z and `confirmation` still arm. **AGREE.**

**seedLive TOUR-A (post-rules)** — sched `2026-07-15T14:00Z` (10:00 EDT), now `2026-07-15T09:00Z` (05:00 EDT), **DEFAULT window ON**.
- `day_before`: raw `2026-07-14T23:30:00.000Z`; cutoff `2026-07-14T19:30:00.000Z` < now ✓ → visible `booked_too_late`. `:207` inverts. **AGREE.**
- `morning_of`: raw `2026-07-15T10:00:00.000Z` (06:00 EDT) inside window → clamped `2026-07-15T12:00:00.000Z`; sameDay ✓; 09:00Z > 08:00Z ✓ → visible `booked_too_late` with dueAt still `12:00:00.000Z`. **AGREE.**
- `confirmation`: raw = now 09:00Z (05:00 EDT) inside window → clamps to `12:00:00.000Z`; supersession consults `dues` (`:288-293`), which still holds morning_of's `12:00:00.000Z` and `12:00Z < 14:00Z`, so confirmation is retired `quiet_hours_superseded`. `:206` **survives**. **AGREE** — and this is precisely the cosmetic "superseded by a skipped rung" the plan's Phase-B item 8 records.
- `en_route`: raw `2026-07-15T13:00:00.000Z` (09:00 EDT), outside window → armed.
- `:199` becomes `['en_route']`. **AGREE.**
- **Refinement:** the plan writes "`:198-204` become `pending = ['en_route']` and a skipReason assertion." In fact **only `:199` and `:201` change**; the dueAt assertion at `:202-204` (`morningOf.dueAt === instantAtLocalTime(<today>, '08:00', tz)`) is still exactly right, because rule 2 stores the CLAMPED value. Do not delete it.

**seedLive TOUR-B (post-rules)** — sched `2026-07-16T14:00Z`, now `2026-07-15T09:00Z`, DEFAULT window ON.
- `day_before` raw = 19:30 EDT Jul 15 = `2026-07-15T23:30:00.000Z`; cutoff `2026-07-15T19:30Z` > now `09:00Z` → **arms**; outside window, unclamped; local date Jul 15 ≠ Jul 16.
- `morning_of` raw `2026-07-16T10:00:00.000Z` (06:00 EDT) inside window → clamps `2026-07-16T12:00:00.000Z`; not sameDay → arms.
- `en_route` `2026-07-16T13:00:00.000Z`; `confirmation` clamps to `2026-07-15T12:00:00.000Z`. Four distinct slots, all pending.
- `:239` `toBe(4)` and `:240-245` the sorted four-kind array both **survive**; `:248`'s twin-parity loop reproduces both new values (the twin clamps identically). **AGREE — TOUR-B is unaffected.**

**Task 6 Step 4's "TOUR-A/TOUR-B stay green after this task" claim** — verified independently: at Task 6 (rules not yet landed) TOUR-A's `day_before` raw `2026-07-14T23:30Z` < now `2026-07-15T09:00Z` → past-dueAt silent drop, `:207` green; `morning_of` clamps to the same `12:00Z`, `:202-204` green; confirmation superseded, `:206` green; pending `['en_route','morning_of']`, `:199` green. **AGREE.**

#### Task 10 Step 1 (the matrix canceled-row ordering trap)

Plan claim: under the 19:30 anchor `canceledAt = scheduledMs − 6h` "FAILS for any past tour whose inherited local time-of-day is earlier than 01:30".

Derivation: let `T` = the tour's local time-of-day in hours. `dayBeforeDueAt` is 19:30 local on (local date − 1), i.e. `(24 − 19.5) + T = 4.5 + T` hours before `scheduledAt`. The invariant needs `canceledAt ≥ dueAt`, i.e. `6 ≤ 4.5 + T`, i.e. `T ≥ 1.5 h = 01:30`. So it fails **strictly below 01:30 local** (equality at exactly 01:30 passes, since the test uses `toBeLessThanOrEqual`). **AGREE.**

Plan claim: the pinned-NOW coherence test cannot see it. Verified: `NOW = 2026-07-03T12:00:00.000Z` = **08:00 EDT**, so every matrix tour inherits `T = 08:00`, comfortably ≥ 01:30. Concretely for `canceled` rep 1 (off = 5): sched = Jun 28 12:00Z, `canceledAt` = Jun 28 06:00Z, new `dueAt` = 19:30 EDT Jun 27 = Jun 27 23:30Z ≤ Jun 28 06:00Z ✓. Rep 2 (off = 7): sched Jun 26 12:00Z, canceledAt Jun 26 06:00Z, dueAt Jun 25 23:30Z ✓. **AGREE.**

Plan's proposed fix `Math.max(scheduledMs − 6h, Date.parse(dayBeforeDueAt) + HOUR_MS)` — checked: since `dueAt` is `(4.5 + T)` hours before the tour and `T ≥ 0`, `dueAt + 1h` is `(3.5 + T)` hours before the tour, always strictly before `scheduledAt`. So the fix never pushes `canceledAt` past the tour. **AGREE.**

Also verified the plan's new parity comment claim ("Upcoming matrix tours sit 3-5 days out, so this instant is always in the future at seed time"): upcoming `dueAt` = `now + 3d − (4.5 + T)h`, minimum `now + 3d − 4.5h` at `T = 0` → always future. The `:474` `toBeGreaterThan(NOW_MS)` and the `:458` live-fire filter both hold at any reseed clock. **AGREE.**

#### Task 10 Step 2 (cast.ts)

Plan: `day_before` → `'2026-05-09T23:30:00.000Z'` (19:30 EDT May 9); `morning_of` → `'2026-05-10T14:00:00.000Z'` (T−4h), for tour `2026-05-10T18:00:00.000Z` = 14:00 EDT May 10.
- 19:30 EDT May 9 = 23:30 UTC May 9 ✓. 18:00Z − 4h = 14:00Z ✓. Ordering `CW (May 8 10:05Z) ≤ May 9 23:30Z ≤ May 10 14:00Z ≤ 18:00Z` ✓. **AGREE.**

---

## GAPS

Surfaces this change breaks that the plan does not name.

### GAP-1 — `tourReminders.test.ts` **Test 2** (`:531-599`) will go red and is in no task's file list

Arm `now0 = '2026-07-13T10:00:00.000Z'`, `scheduledAt = '2026-07-15T10:00:00.000Z'`, `quietOff`. Tick 2 fires at `pollAt = '2026-07-14T10:01:00.000Z'` (`:580`) on the premise (`:575`) that `day_before` is `'2026-07-14T10:00:00.000Z'`. After the retime `day_before` is `'2026-07-14T23:30:00.000Z'`, so that tick catches nothing: `:584 toHaveLength(2)`, `:587 toContain(rungBody('day_before', …))`, and `:594 dayBefore?.sentAt` all fail. Fix: move `pollAt` to `'2026-07-14T23:31:00.000Z'` and rewrite the comments at `:575-579`. (Bonus: `:576`'s "en_route ('2026-07-15T08:00:00.000Z')" is **already wrong** in the live tree — `sched − 1h` is `09:00:00.000Z` — and the new `morning_of` lands at `'2026-07-15T06:00:00.000Z'`, so both need restating.)

### GAP-2 — `tourReminders.test.ts` **Test 2b** (`:606-657`) breaks identically

Same fixture pair; `:648` and `:653` tick at `'2026-07-14T10:01:00.000Z'` and `:649`/`:654` assert `expect(emitted).toHaveLength(2)`. Only one event will be emitted. Not in any task's file list.

### GAP-3 — `tourReminders.test.ts` **`DAY_BEFORE_D11`** (`:2635`) is a derived constant nobody re-derives

```ts
2634:  /** day_before = scheduled - 24h, with quiet hours off (no clamping). */
2635:  const DAY_BEFORE_D11 = '2026-08-06T18:00:00.000Z';
```
`SCHEDULED_D11 = '2026-08-07T18:00:00.000Z'` (14:00 EDT Aug 7). New value: 19:30 EDT Aug 6 = **`'2026-08-06T23:30:00.000Z'`**. Consumed at `:2753` (`runDueTourReminders(DAY_BEFORE_D11, …)`) and `:2757` (`expect(dayBefore?.sentAt).toBe(DAY_BEFORE_D11)`) — the test `re-adding the tenant lifts the suppression for the NEXT rung` (`:2735`) goes red at `:2754 toHaveLength(1)`.

### GAP-4 — `tourReminders.test.ts` **reschedule Test 3** (`:1087-1139`) pins a `day_before` dueAt

`:1134 expect(dayBefore?.dueAt).toBe('2026-07-19T18:00:00.000Z');` with `newScheduledAt = '2026-07-20T18:00:00.000Z'` (14:00 EDT), `now0 = '2026-07-13T11:00:00.000Z'`, quietOff. New value: 19:30 EDT Jul 19 = **`'2026-07-19T23:30:00.000Z'`**. Rule 1 does not fire (cutoff Jul 19 19:30Z ≫ now0), so `:1110`/`:1130` `toHaveLength(4)` both survive. The plan's Task 6 Step 5 enumerates Tests 1, 1c, 1d, 1f, 1g and 5, but **not** Test 3.

### GAP-5 — the `documentation/tours-sequence-writeup.md` **paragraph the plan rewrites is a different one than the table's neighbours**

The plan's Step 4 replacement table drops the "Purpose" wording for `confirmation` from `"Your tour is confirmed."` to `"Your tour is set."`, which is right for the new copy — but `:97-102` immediately above still says *"the booking-time [AUTO] text already says 'confirmed'"*, and `:119-120` still says *"Rungs whose time is already past when armed are skipped"*, which after Task 7 is only true for `en_route`/clamped rungs. The plan's "extend the paragraph below it" covers `:116-120`, but not the `:97-102` blockquote.

### GAP-6 — Test 1d has no count assertion to re-derive

Plan Step 5's Test-1d bullet ends "re-derive any length/filter assertion in the test to those values." There is none (`:329-361` asserts only four `byKind` lookups). Harmless, but it means the plan's stated 4-rows/3-unskipped outcome will go **unpinned** unless the builder adds an assertion. Since Test 1d is the case whose *premise* the retime most changes (`day_before` flips from silently-dropped to armed), leaving it unpinned is a real coverage loss.

### GAP-7 — no plan step touches `docs/issues/scheduled-message-visibility.md:33-34`

That is a **live registry file** (not frozen research) stating the old ladder verbatim: `` `day_before` (−24h), `morning_of` (08:00 day-of), `en_route` (−2h) ``. `en_route (−2h)` has been wrong since 2026-08-18 and the plan does not fix it either. Same class as the flake-issue repro step the plan *does* fix.

### GAP-8 — `docs/issues/tour-reminders-panel-e2e-flake.md`'s **root-cause narrative** survives the label edit

The plan only edits `:112`. After Task 6, `:117-118`, `:125-126`, `:129-131` and especially `:143` ("drop the `morning_of` rung assertion from Part A — it is the one rung whose presence is wall-clock dependent") are all false: `morning_of` becomes a pure `−4h` offset, and `day_before` becomes the wall-clock-sensitive rung. AGENTS.md treats this resolved issue as a live reopen trigger, so a false "suggested next step" is exactly the failure mode the plan's `:112` edit exists to prevent.

### GAP-9 — `docs/issues/tour-reminders-panel-e2e-flake.md`'s frontmatter is unterminated

Body edits inside `:12-27` land **inside** the parsed YAML block. `scripts/issues.mjs:33` will pick up any line matching `^word:` as a frontmatter field and could shadow `id`/`status`. The plan tells a builder to edit `:112` (safely below `:28`), but the bracketed-note instruction plus a possible dated header is exactly the kind of edit that drifts upward. Worth fixing the stray delimiter in the same pass.

### GAP-10 — `app/src/lib/seed/live.ts:515` and `:524-525` already state "all 5 rungs should arm"

False since `no_show_checkin` became manual-only. The plan's Step 3 grep target region (`:478-530`) does cover them, but the plan's instruction — "the ladder description must name the new timings and say four auto-armed rungs plus the manual no-show check-in" — is written as if only the docblock at `:7-9` carries the count. A builder following the literal grep (`"5-rung\|ladder"`) will hit `:9`, `:25`, `:366`, `:433`, `:478`, `:481`, `:483` and **miss `:515`/`:524`, which say "5 rungs" without the words "5-rung" or "ladder"**.

### GAP-11 — `app/src/lib/seed/cast.ts:753`'s comment already contradicts its own block

`// Tour: toured, outcome move_forward, convertible (no reminder rows — all sent already)` sits directly above three reminder rows. The plan's Step 2 only says "Update the `:768` comment."

### GAP-12 — matrix.ts gains its first `repos/settingsRepo` import into a pure-generator module

`app/test/seedMatrixCoherence.test.ts` calls `matrixItems(NOW)` at **module top level** (`:32`), with no Docker and no `skipIf`. Adding `import { DEFAULT_ORG_SETTINGS } from '../../repos/settingsRepo.js'` pulls `@aws-sdk/lib-dynamodb` into that import graph. It is almost certainly already there via `'../../repos/placementDeadlinesRepo.js'` (`:26`), but the plan should say so rather than leave a builder to discover a cold-start cost or a cycle. Related: `app/test/seedMatrix.test.ts`, `app/test/seedTourTrails.test.ts`, `app/test/seedProfile.integration.test.ts` and `app/test/performanceSeed.test.ts` all import matrix/seed modules and are not in any task's file list — none currently pins a ladder instant (verified by grep), but they are the blast radius of a new import.

### GAP-13 — the revival half of Task 7 case 7 has no usable existing fixture

`toursApi.test.ts:1273-1283` (`status-only revival {status:'scheduled'} on a canceled tour re-arms off the stored time`) uses `ARM_NOW = '2026-07-13T14:00:00.000Z'` against `BASE_CREATE_BODY.scheduledAt = '2026-07-15T10:00:00.000Z'` — a two-day horizon, so neither rule fires and no chip appears. The plan says "assert on whichever revival fixture the file already has, or add one with its idioms"; in practice **a new fixture is mandatory**, and the file's `pendingRows` helper (`:1228-1231`) only counts pending rows, so a `booked_too_late` assertion also needs a new accessor. Note also that under the new ladder this test's tour arms `day_before` at `2026-07-14T23:30:00.000Z` where it previously armed at the clamped `2026-07-14T12:00:00.000Z` — the `toBeGreaterThan(0)` assertions survive either way, so nothing here goes red; the gap is purely missing coverage.

### GAP-14 — `docs/research/message-catalog-worklist.md:23-26` pins the OLD tour body strings

Not a test, but it is the working doc the catalog rewrite (Task 4) is executed against. After Task 4 every quoted default there is wrong. Task 10 does not list it.