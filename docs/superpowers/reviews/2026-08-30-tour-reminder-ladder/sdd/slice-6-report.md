# Slice S6 report - Task 7, the booked-too-late arm rules and the quiet-window warn

Branch `feat/tour-reminder-ladder`, worktree `W:/tmp/tour-reminder-ladder`.
Base at slice start: `123aa43a` (clean). One commit landed: **`f2908b1a`**.

---

## 1. Step 2 - the RED, per numbered case

`cd W:/tmp/tour-reminder-ladder/app && npx vitest run test/tourReminders.test.ts test/toursApi.test.ts`,
exit 1: `Test Files 2 failed (2) / Tests 9 failed | 255 passed (264)`.

Nine of the eleven new `it`s were red. Quoted from the run:

| case | verdict | the RED observed |
| --- | --- | --- |
| 1 | RED | `AssertionError: expected undefined to be 'booked_too_late' // Object.is equality` at `test/tourReminders.test.ts:1376` (`expect(dayBefore!.skipReason)`) |
| 2 | GREEN, by design | Asserts UNCHANGED arming exactly on the strict-`>` boundary; the plan declares it so. Kept because it pins the boundary the implementation could get wrong. |
| 3 | RED | `AssertionError: expected undefined to be defined` at `:1410` (`expect(dayBefore).toBeDefined()`) - the old code wrote NO row at all, which is the whole point of the ordering discriminator |
| 4 | RED | `AssertionError: expected undefined to be defined` at `:1432` (`expect(morningOf).toBeDefined()`) |
| 5 | RED on its caveat half, green on its subject | `TypeError: Cannot read properties of undefined (reading 'skipReason')` at `:1452`. The morning_of assertions above it (the case's actual subject - the strict-`>` rule-2 boundary) passed; the added research-6 caveat assertion (`day_before` IS `booked_too_late` in this fixture) is what went red. |
| 6 | RED on its caveat half, green on its subject | `TypeError: Cannot read properties of undefined (reading 'skipReason')` at `:1472`. Same shape as case 5: the same-day guard on `morning_of` passed; the added `day_before` caveat assertion was red. |
| 7a (reschedule) | RED | `AssertionError: expected undefined to be 'booked_too_late'` at `test/toursApi.test.ts:1326` |
| 7b (revival) | RED | `AssertionError: expected undefined to be 'booked_too_late'` at `test/toursApi.test.ts:1364` |
| 8 (warn) | RED | `AssertionError: expected [ 'tour created', ...(8) ] to include 'tour reminders: the 19:30 day_before ...'` at `:1500`. The `quiet_hours_superseded` half above it passed - `staleDayBefore` already existed. |
| 8 (negative) | GREEN, by design | Asserts NO warn and an unclamped 19:30 arm; nothing to break before the warn exists. Kept per the plan: `quietOffSettingsRepo()` would be a vacuous control, so this is the only fixture that separates "gated on `enabled`" from "outside the window anyway". |
| 9 | RED on its booked_too_late halves, GREEN on its en_route half | `TypeError: Cannot read properties of undefined (reading 'skipReason')` at `:1536`. The en_route assertions (`rows.map(kind)` has no `'en_route'`, plus the `'tour reminder skipped (dueAt in the past)'` log line) were satisfied before the implementation - exactly as the plan says: they are the SURVIVING pin of unchanged behaviour, not a new one. |

DEVIATION FROM THE PLAN'S PREDICTION, in the harmless direction: the plan expects
cases 5 and 6 to be green. Their SUBJECTS were. Both went red only on the
research-6 case-5 caveat assertion I chose to write down rather than leave as
prose (`day_before` is `booked_too_late` in both fixtures). Nothing in the plan's
red list is contradicted, and no case in the red list was green.

---

## 2. The exact new warn string

Single literal in `app/src/jobs/tourReminders.ts` (`armTourReminders`, after
pass 1):

```
tour reminders: the 19:30 day_before anchor is inside the org quiet window - every day_before will clamp to the tour morning and be retired as superseded
```

Log fields: `{ tourId, rawDayBefore, quietHoursStart: window.start, quietHoursEnd: window.end }`.
Guarded by `isQuietTime(rawDayBefore, window)`, which gates on `window.enabled`,
so a DISABLED window never warns (that is what case 8's negative half proves).
Per **A7** it fires once per ARM with no dedupe - booking, reschedule, revival
and three per `seed:live` run for an org with `quietHoursStart <= 19:30`.

The test asserts it as a two-part concatenation
(`'... quiet window - ' + 'every day_before ...'`) purely for line length; the
joined value is byte-identical to the source literal, which is what the red-then-
green transition proves.

---

## 3. Step 3 - the implementation

`app/src/jobs/tourReminders.ts`, all inside `armTourReminders` unless noted.

- **Pass 1 now keeps BOTH maps.** `raws` (what the rules compare) and `dues`
  (what gets stored, and what supersession compares). The comment states why
  `dues` is not a substitute: comparing the rules against it agrees whenever
  nothing clamps - which is most fixtures - and is wrong for every tour whose
  `day_before` clamps.
- **The 7.1 warn**, immediately after pass 1.
- **The booked-too-late branch**, placed IMMEDIATELY BEFORE `if (dueAt < now)`.
  Rule 1 `now > rawDueAt - 4h` for `day_before`; rule 2
  `sameDay && now > scheduledAt - 6h` for `morning_of`, with `sameDay` computed
  as `localDateOf(now, window.timezone) === tourLocalDate` (the same
  `readQuietHoursWindow`-resolved zone). Both boundaries strictly `>`. The row
  stores `dueAt` - the CLAMPED value - like every neighbouring arm-time skip
  row. Log line:
  `'tour reminder retired at arm (booked too late for this rung) - visible skipped row'`.
- The past-dueAt branch, the past-event branch, the supersession/`staleDayBefore`
  branch, `MANUAL_ONLY_REMINDER_KINDS` and `REMINDER_KINDS` are all UNTOUCHED.

---

## 4. Step 4 - re-derivation table

Zone facts: `America/New_York`; Jul = EDT (UTC-4). Default window
`[21:00, 08:00)` NY, END-EXCLUSIVE. `quietOff` = identity clamp.
Rule-1 cutoff = `rawDayBefore - 4h`; rule-2 cutoff = `scheduledAt - 6h`.

| site | assertion | old | new | one-line derivation |
| --- | --- | --- | --- | --- |
| `tourReminders.test.ts` Test 5 (same-day pm_team, now0 Jul 13 09:00Z, sched Jul 13 14:00Z, quietOff) | `day_before` present? | absent (silent past-dueAt drop) | VISIBLE row, `skipReason: 'booked_too_late'`, `dueAt '2026-07-12T23:30:00.000Z'` | raw = 19:30 EDT Jul 12 = 23:30Z; cutoff 19:30Z Jul 12 < now0, so rule 1 fires ahead of the drop; quietOff so clamped == raw |
| Test 5 | `morning_of` state | armed, `skippedAt` undefined | `skipReason: 'booked_too_late'`, `dueAt` UNCHANGED at `'2026-07-13T10:00:00.000Z'` | raw = 14:00Z - 4h = 10:00Z; sameDay (both local dates Jul 13); now0 09:00Z > 14:00Z - 6h = 08:00Z |
| Test 5 | `armedKinds` contains `morning_of` | yes | `not.toContain('morning_of')` | consequence of the row above |
| Test 5 | `en_route` / `confirmation` | armed | UNCHANGED | no rule guards either; 13:00Z and 09:00Z both clear |
| Test 5 | title + comments | "skips day_before when it is in the past" | retitled "retires BOTH day_before and morning_of as booked_too_late on a same-day tour" | the old title named a branch this fixture no longer reaches |
| `seedLive.test.ts` TOUR-A (sched Jul 15 14:00Z, seed now Jul 15 09:00Z, DEFAULT window ON) | `pending.map(kind).sort()` | `['en_route','morning_of']` | `['en_route']` | morning_of is now retired, en_route (13:00Z = 09:00 EDT, outside window) is the only live rung |
| TOUR-A | `morningOf.skippedAt` | `toBeUndefined()` | `morningOf.skipReason === 'booked_too_late'` | raw 10:00Z = 06:00 EDT is INSIDE the window so it clamps to 12:00Z, but the rule reads the RAW time: sameDay Jul 15, 09:00Z > 08:00Z |
| TOUR-A | `morningOf.dueAt` = `instantAtLocalTime(<today>, '08:00', tz)` | **UNCHANGED - kept verbatim (C14)** | UNCHANGED | rule 2 stores the CLAMPED value, which is still the 08:00-local instant |
| TOUR-A | `day_before` row | `toBeUndefined()` | `skipReason === 'booked_too_late'` | raw = 19:30 EDT Jul 14 = Jul 14 23:30Z; cutoff Jul 14 19:30Z < seed now Jul 15 09:00Z |
| TOUR-A | `confirmation.skipReason === 'quiet_hours_superseded'` | UNCHANGED | UNCHANGED | confirmation clamps to 12:00Z; supersession still consults `dues`, which still holds morning_of's clamped 12:00Z, and 12:00Z < 14:00Z |
| TOUR-A | `Items.length` `toBeGreaterThanOrEqual(1)` | UNCHANGED | UNCHANGED | the ladder went from 3 rows to 4 (day_before now exists); the bound still holds |
| TOUR-A | test title | "the in-window seed time collapses the ladder onto one 08:00-local rung" | "the same-day seed leaves only en_route live: both near rungs are booked_too_late and confirmation is superseded" | the surviving rung is en_route at 09:00 EDT, not an 08:00-local one - the old title was already imprecise and is now plainly false |
| `seedLive.test.ts` TOUR-B | every assertion | UNCHANGED | **UNCHANGED, passed unedited** | day_before cutoff Jul 15 19:30Z > seed now 09:00Z, and morning_of is not sameDay - neither rule fires |
| `tourRemindersApi.test.ts`, `relayApi.test.ts`, `contactTimeline.test.ts`, `devGating.test.ts`, `placementConvert.test.ts` | rung counts / ordered arrays | - | **no edit needed** | ran them explicitly; all green unedited. `tourRemindersApi` seeds rows directly rather than arming, so the rules never run there. |

### seedLive TOUR-A: how many lines actually moved

**Three assertion lines, not two**, and the mission's "exactly two" is C14's
wording rather than the plan's. Stated precisely so nobody re-diagnoses it:

- C14 constrains the PLAN's claim that "`:198-204` become `pending = ['en_route']`
  and a skipReason assertion". Within that range exactly TWO lines moved (the
  pending array and the `morningOf.skippedAt` -> `skipReason` flip) and the
  `morning_of` dueAt assertion **stayed exactly as is** - verified, it is still
  `instantAtLocalTime(FIXED_NOW_ISO.slice(0, 10), '08:00', QUIET_WINDOW.timezone)`.
- The plan states the third change SEPARATELY: "`:207` inverts", the
  `day_before`-is-absent assertion. It had to - `day_before` now writes a row,
  so `toBeUndefined()` is a hard red.

Comments and the test title around them were rewritten; no other assertion in
that file was touched.

**TOUR-B changed on ZERO lines and is green.**

---

## 5. A7-1: the four prose fixes, and where

All four in `app/src/jobs/tourReminders.ts`.

| id | surface | what was false | what it says now |
| --- | --- | --- | --- |
| (a) | module header, the `armTourReminders` bullet (was `:6-8`) | "Rows whose clamped dueAt is already in the past ..., lands at/after the tour start, or collides with a later rung's slot are silently skipped" - two of those three write VISIBLE rows | names the four visible retirements (past-event, supersession, stale day_before, booked-too-late) and says the ONE silent retirement left is past-dueAt, reachable after this change only for `en_route` and clamped rungs |
| (b) | `armTourReminders`'s own docblock | "A rung whose clamped dueAt is already past is skipped with no row (pre-existing rule)" - false for `day_before`/`morning_of` after this task | rewritten around "MOST arm-time retirements write a VISIBLE skipped row", names `booked_too_late`, states that the two rules run AHEAD of the silent drop and why, and adds that `now` is the ARM instant (booking / reschedule / revival) |
| (c) | the pass-2 rule list (was `:252-260`, `(a)`-`(d)`) | opened with "a skip creates NO row - the pre-existing past-dueAt precedent", which the next 40 lines contradicted twice | now opens "Rules (b) through (e) all write a VISIBLE skipped row; only (a) writes nothing at all", and carries a new **`(e)` booked-too-late** entry placed first with a pointer to the branch |
| (d) | `computeDueAt`'s `en_route` case comment | "its copy now says 'see you soon'" - the 2026-08-26 founder rewrite replaced that wording (the live entries are "can you please text me when you're on the way?" / "... will be headed that way shortly ...") | describes the actual copy and records parenthetically that the older gloss quoted a wording the rewrite replaced |

**A7-5** is also done: a paragraph on `claimSkipRow`'s docblock recording that
`reason` is the full union so the compiler cannot stop you, and that
`'booked_too_late'` is ARM-ONLY and must never be passed there.

**A7-3** is a comment inside case 6 saying `morning_of`'s RAW is EXACTLY `now`,
that the past-dueAt branch is `if (dueAt < now)` so the row survives armed
already-due, and that tidying that comparison to `<=` breaks the case.

**A7-4** is carried in case 8's `it` title ("... `staleDayBefore` retires it AND
the 7.1 warn names the cause") plus a block comment above it headed
"LOAD-BEARING TWICE OVER (A7-4)" explaining that after the retime
`staleDayBefore` can never fire under the DEFAULT window, so this case is that
rule's ONLY remaining coverage - do not delete it as an unusual org config.

**A7-2** is done: case 7's revival half is a NEW fixture (nothing reusable
existed) plus a new accessor - see the deviation below for the part A7-2 could
not have predicted.

---

## 6. Verification

**Full app suite**, `cd W:/tmp/tour-reminder-ladder/app && npx vitest run`:

```
 Test Files  1 failed | 337 passed | 1 skipped (339)
      Tests  1 failed | 6033 passed | 9 skipped (6043)
```

The single failure is the KNOWN ENVIRONMENTAL signature, verbatim, for the
fourth slice running:

```
 FAIL  test/messaging.integration.test.ts > messaging repos against DynamoDB Local (throwaway prefix) > messagesRepo > getManyByTsMsgIds chunks past the 100-key BatchGetItem limit
Error: Test timed out in 60000ms.
```

Plain 60s timeout, ZERO assertion failures. Re-run of that FILE alone under a
clean access key
(`AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run test/messaging.integration.test.ts`):

```
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

exit 0. Environmental; not chased.

**Nothing self-skipped.** From the same full-suite log:

```
 v test/toursApi.test.ts (185 tests) 3463ms
 v test/tourReminders.test.ts (79 tests) 4179ms
 v test/seedLive.test.ts (15 tests) 2070ms
 v test/tourRemindersApi.test.ts (37 tests) 879ms
 v test/relayApi.test.ts (50 tests) 1181ms
 v test/contactTimeline.test.ts (47 tests) 871ms
 v test/devGating.test.ts (41 tests) 787ms
 v test/placementConvert.test.ts (15 tests) 407ms
 v test/computeDueAt.test.ts (7 tests) 30ms
```

Neither `seedLive.test.ts` nor `tourReminders.test.ts` printed its `SKIPPED`
warning; both ran their full case counts against DynamoDB Local. Counts moved
from S5's 183 -> 185 (`toursApi`, +2 = cases 7a/7b) and 70 -> 79
(`tourReminders`, +9 = cases 1-6, 8, 8-negative, 9). The one `skipped` FILE is
`test/staticSmoke.test.ts` (9 tests), which self-skips on a missing
`dashboard/dist` - pre-existing and unrelated.

**Typecheck**: `cd W:/tmp/tour-reminder-ladder && npm run typecheck` -> **exit 0**.

**Post-edit confirmation run** of the eight touched/adjacent suites together:
`Test Files 8 passed (8) / Tests 469 passed (469)`, exit 0.

**Lint** (proactive, not a slice gate): `npx eslint` on the five touched files ->
exit 0, no output.

**ASCII**: a scan of every ADDED diff line returned 0 non-ASCII characters. One
em dash slipped into a Test 5 banner comment during editing and was fixed before
commit.

**Not run, per the mission**: `npm run e2e` (RED by design until Task 9),
`npm test`, `npm run smoke`. **No file under `e2e/` was touched.**

---

## 7. Deviations, with reasoning

1. **THE BIG ONE - the in-memory fake tourRemindersRepo silently DROPPED
   `input.skipped`, so case 7 was unassertable as specified.**
   `app/test/helpers/twilioWebhookHarness.ts`'s `tourRemindersRepo.create`
   built its item without the real repo's
   `...(input.skipped !== undefined && { skippedAt, skipReason })` clause. Every
   arm-time skipped row - `past_event`, `quiet_hours_superseded` and now
   `booked_too_late` - therefore looked like a LIVE rung to every route-level
   suite. A7-2 assumes the data is there and asks only for "a new accessor";
   an accessor over a field the fake never writes returns nothing.
   **I mirrored the real repo's `create`** (with a comment recording the old
   behaviour) rather than moving case 7 out of `toursApi.test.ts`, because the
   plan and the mission both put it there and because Task 7's entire posture is
   "arm-time skips are VISIBLE" - a fake that erases them defeats the change it
   is meant to verify.
   **Knock-on, contained:** `toursApi.test.ts`'s `pendingRows` helper defined
   pending as "no `sentAt` and no `canceledAt`", which with the fix would have
   counted born-skipped rows as pending - and `cancelForTour` deliberately
   leaves skipped rows alone (they are already terminal), so
   `expect(pendingRows(...)).toHaveLength(0)` after a cancel could never reach
   zero. I tightened `pendingRows` with `&& r.skippedAt === undefined`, which is
   the honest definition the real `listDue` and the route's `'upcoming'` state
   both already use. No assertion was flipped; the three existing
   `toHaveLength(0)` cases pass unedited. Full suite green confirms nothing else
   depended on the old behaviour (the other two consumers,
   `tourRemindersApi.test.ts` and `placementConvert.test.ts`, seed rows through
   their own helpers or without `skipped`).
2. **Cases 5 and 6 were RED, not green.** Their subjects were green; the
   research-6 case-5 caveat, which I chose to encode as an assertion rather than
   a comment, was red. See section 1. I judged an assertion better than prose
   because the caveat is exactly the kind of thing a future reader would
   otherwise "discover" as a bug.
3. **Case 7 is two `it`s, not one** (`case 7a` reschedule, `case 7b` revival).
   The plan describes one case with two halves; splitting them keeps each
   failure message pointed at one mechanism.
4. **`skippedByKind` is a NEW accessor next to `pendingRows`** rather than a
   modification of it, per A7-2. It filters on `skippedAt !== undefined` and
   keys by kind. Both case-7 fixtures were chosen so the FIRST arm produces zero
   skipped rows (asserted explicitly, `expect(skippedByKind(...)).toEqual({})`),
   because `cancelForTour` cannot cancel a skipped row and a polluted first arm
   would leak into the post-re-arm assertion.
5. **Two test titles changed** beyond the plan's list: `tourReminders.test.ts`
   Test 5 and `seedLive.test.ts` TOUR-A's second case. Both titles asserted
   behaviour this task deletes ("skips day_before when it is in the past";
   "collapses the ladder onto one 08:00-local rung"), so leaving them would have
   been the re-baseline-without-retitling the mission forbids.

No re-derivation of mine DISAGREED with the plan's or research-6's stated value.
Every literal - the nine cases' instants, Test 5's two dueAts, TOUR-A's three
flips, TOUR-B's non-change - matched what I computed independently from the
fixtures.

---

## 8. Noticed, not fixed

- **The fake repo has a SECOND, still-live divergence I did not touch.** Its
  `create` ignores `input.sentAt`-style fields it never had, which is fine, but
  more importantly its `cancelForTour` mirrors the real one only because both
  exclude `skippedAt`. Now that the fake writes `skippedAt`, the two agree - but
  nothing TESTS that they agree. A drift guard on the fake (the `seedLive` twin
  idiom) would be cheap and is not in any task.
- **The mission's "TOUR-A changed on exactly two lines" is off by one.** Three
  assertion lines moved. Section 4 explains why C14 and the plan together
  actually say three; recorded so a reviewer does not read the third as
  unauthorised.
- **`tourReminders.test.ts`'s arm-section banner comment** (the `(a)`-`(d)`
  rule-letter list at the head of the quiet-hours block, and the `Test 1c`/`1h`/
  `1i` letter labels) is the same class of drift as A7-1's three source
  surfaces - S5's report flagged it and suggested Task 7 as the natural home.
  I fixed the FIVE surfaces the mission enumerated (A7-1's three plus the
  `en_route` comment plus `claimSkipRow`) and left the test-file banner alone:
  it is a fifth surface in a different file, its letters still map onto the
  branches it names, and widening the commit past the enumerated set is what the
  mission's stop-and-report rule exists to prevent. **Recommend Task 8 or 10
  pick it up.**
- **The 7.1 warn is per-arm with no dedupe** (A7, accepted as specified). For an
  org with `quietHoursStart <= 19:30` that is one WARN per booking, per
  reschedule, per revival, and three per `seed:live` run. Volume noted for the
  handback, as A7 asks.
- **The accepted mis-attribution is now live and observable.** In case 4's
  fixture `day_before` reports `booked_too_late` while its clamped time is also
  past; in seedLive TOUR-A `morning_of` reports `booked_too_late` while its
  clamped 08:00-local time is also at/before the tour. Both are spec 8.1's
  knowingly-accepted outcome. Comments in both places say so and say not to
  reorder.
- **`staleDayBefore` is now dead code under the DEFAULT window** (G11). Case 8
  is its only coverage and is labelled as such, but the rule itself is worth a
  registry note in Task 10 if nobody has filed one.
- **The e2e suite stays RED by design** and was not run. `e2e/` is untouched.

---

## 9. Commit

```
f2908b1a feat(tours): booked-too-late arm rules write visible rows; warn when 19:30 is quiet
```

5 files changed, 495 insertions(+), 50 deletions(-):

- `app/src/jobs/tourReminders.ts` (raw map, warn, rule branch, four prose fixes,
  `claimSkipRow` note)
- `app/test/tourReminders.test.ts` (cases 1-6, 8, 8-negative, 9; Test 5
  re-derived and retitled)
- `app/test/toursApi.test.ts` (cases 7a/7b, `skippedByKind`, `pendingRows`
  tightened)
- `app/test/seedLive.test.ts` (TOUR-A: three assertions, comments, title)
- `app/test/helpers/twilioWebhookHarness.ts` (fake `create` honours
  `input.skipped`)

Bare `git status` was read before staging (5 modified, nothing else);
`MERGE_HEAD` confirmed absent at
`W:/AI Projects/Housing Choice/HC Application/.git/worktrees/tour-reminder-ladder/MERGE_HEAD`
(this worktree's real git dir - `.git` here is a FILE, so a plain
`.git/MERGE_HEAD` check proves nothing). Explicit paths only, no `git add -A`.
Tree is clean at HEAD.
