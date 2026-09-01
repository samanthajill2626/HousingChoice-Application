# Slice S5 report - Task 6, retime the ladder in `computeDueAt`

Branch `feat/tour-reminder-ladder`, worktree `W:/tmp/tour-reminder-ladder`.
Base at slice start: `f720c9a9` (clean). One commit landed: **`123aa43a`**.

---

## 1. Step 2 - the RED (quoted)

`cd app && npx vitest run test/computeDueAt.test.ts`, exit 1:

```
 FAIL  test/computeDueAt.test.ts > computeDueAt (raw - the caller clamps) > en_route is one hour before (unchanged)
TypeError: (0 , computeDueAt) is not a function
 test/computeDueAt.test.ts:39:12

 Test Files  1 failed (1)
      Tests  7 failed (7)
```

All seven cases failed with the same `TypeError` - the function is
module-private, exactly the predicted red.

After Step 3 the same command: `Test Files 1 passed (1) / Tests 7 passed (7)`,
exit 0.

---

## 2. Step 3 - the implementation

`app/src/jobs/tourReminders.ts`:

- `computeDueAt` is now `export function computeDueAt(...)`; its docblock says
  the return is RAW and UNCLAMPED and that the caller owns the clamp. The
  docblock's "the window is passed in because `morning_of` is anchored to the
  ORG's local day" was corrected to name `day_before` - that is now the only
  zone-anchored rung.
- `day_before` -> `instantAtLocalTime(shiftLocalDate(localDateOf(scheduledAt,
  window.timezone), -1), '19:30', window.timezone)`, with the plan's comment
  verbatim.
- `morning_of` -> `new Date(scheduled - 4 * 60 * 60 * 1000).toISOString()`,
  with the plan's comment verbatim.
- New import `import { shiftLocalDate } from '../lib/localTime.js';` (the file
  had no prior `localTime.js` import, so this is a new statement, not a merge -
  no `no-duplicate-imports` risk; eslint on the file is clean, see section 8).
- NOT touched: `MANUAL_ONLY_REMINDER_KINDS`, `REMINDER_KINDS`, the
  `confirmation` case, `en_route`, `no_show_checkin`, the clamp site.

---

## 3. Step 4 - the `seedLive.test.ts` twin

Per **C13**, the twin's signature is `computeDueAt(kind, scheduledAt, now)`
with `QUIET_WINDOW` closed over and `clampOutOfQuietHours` folded in at the
tail. I mirrored the two CASES only, not the plan's 4-arg fragments:

- `day_before` -> `instantAtLocalTime(shiftLocalDate(localDateOf(scheduledAt,
  QUIET_WINDOW.timezone), -1), '19:30', QUIET_WINDOW.timezone)`
- `morning_of` -> `new Date(scheduled - 4 * 60 * 60 * 1000).toISOString()`
- Added `import { shiftLocalDate } from '../src/lib/localTime.js';`
- Corrected the twin's docblock sentence that named `morning_of` as the
  org-local half of the rule; it now names `day_before`.

Nothing else in that file was touched: the local `REMINDER_KINDS` copy still
carries `confirmation`, and **every TOUR-A / TOUR-B assertion passed
unedited** - 15/15 green. That is the confirmation the mission asked for that
`computeDueAt` is right.

---

## 4. Step 5 - re-derivation table

Zone facts used throughout: `America/New_York`, Jan = EST (UTC-5),
Mar 6 = EST / Mar 9 = EDT (2026 spring-forward Mar 8), Jul/Aug = EDT (UTC-4).
Formulas: `day_before = 19:30 org-local on (tour local date - 1)`;
`morning_of = scheduledAt - 4h`. Default window = 21:00-08:00 NY (19:30 is
OUTSIDE it); `quietOff` = identity clamp.

### `app/test/tourReminders.test.ts`

| test | assertion | old | new | derivation |
| --- | --- | --- | --- | --- |
| Test 1 `armTourReminders creates all 4 reminder rows with correct dueAts` | `day_before.dueAt` | `2026-01-19T20:00:00.000Z` | `2026-01-20T00:30:00.000Z` | sched Jan 20 20:00Z = 15:00 EST, local date Jan 20; -1 = Jan 19; 19:30 EST = 00:30Z Jan 20; outside window, unclamped; > now Jan 19 15:00Z |
| Test 1 | `morning_of.dueAt` | `2026-01-20T13:00:00.000Z` | `2026-01-20T16:00:00.000Z` | 20:00Z - 4h = 16:00Z = 11:00 EST, outside window |
| Test 1c (RETITLED) | `day_before` skipped `quiet_hours_superseded` | skipped row | ARMED `2026-01-20T00:30:00.000Z` | sched Jan 21 03:00Z = Jan 20 22:00 EST, local date Jan 20; -1 = Jan 19; 19:30 EST = Jan 20 00:30Z; 19:30 < 21:00 so no clamp; > now |
| Test 1c | `morning_of.dueAt` | `2026-01-20T13:00:00.000Z` | `2026-01-20T23:00:00.000Z` | 03:00Z - 4h = Jan 20 23:00Z = 18:00 EST, outside window |
| Test 1c | unskipped count | `2` | `3` | confirmation + day_before + morning_of; only en_route retires (`past_event`, unchanged) |
| Test 1c | `rows` length / `en_route` past_event | `4` / `2026-01-21T13:00:00.000Z` | UNCHANGED | en_route 02:00Z Jan 21 = 21:00 EST, inside -> clamps to Jan 21 08:00 EST = 13:00Z >= sched |
| Test 1d | `byKind['day_before']` | `toBeUndefined()` | ARMED `2026-01-20T00:30:00.000Z` | sched Jan 20 13:30Z = 08:30 EST, local date Jan 20; 19:30 EST Jan 19 = Jan 20 00:30Z > now Jan 19 15:00Z. **POLARITY INVERTED** |
| Test 1d | (A6-5) NEW counts pin | none existed | `4` rows / unskipped `['confirmation','day_before','en_route']` | morning_of raw 09:30Z = 04:30 EST inside -> clamps to 13:00Z = en_route's clamped slot; en_route is later -> morning_of `quiet_hours_superseded` (outcome unchanged, new derivation) |
| Test 1f | `day_before.dueAt` | `2026-01-19T13:00:00.000Z` | `2026-01-20T00:30:00.000Z` | sched Jan 20 12:30Z = 07:30 EST; 19:30 EST Jan 19 = Jan 20 00:30Z; outside window; > now Jan 18 15:00Z; clamped local date Jan 19 != tour date Jan 20 so no `staleDayBefore` |
| Test 1f | `['confirmation','day_before']` unskipped | - | UNCHANGED | morning_of raw 08:30Z = 03:30 EST -> clamps 13:00Z >= 12:30Z -> `past_event`; en_route raw 11:30Z -> clamps 13:00Z -> `past_event` |
| Test 1g (RETITLED) | `byKind['day_before']` | `toBeUndefined()` | ARMED `2026-01-20T00:30:00.000Z` | same sched as 1f, now Jan 19 15:00Z; Jan 20 00:30Z > now. **POLARITY INVERTED** |
| Test 1g | unskipped `.map(kind)` | `['confirmation']` | `['confirmation','day_before']` | creation order = `REMINDER_KINDS`, no sort |
| Test 1h (RETITLED, **not in plan/worklist**) | `day_before.dueAt` | `2026-01-20T03:00:00.000Z` | `2026-01-20T00:30:00.000Z` | Test 1c's tour under `quietOff`; 19:30 EDT... EST Jan 19 = Jan 20 00:30Z, clamp is identity |
| Test 1h | `morning_of.dueAt` | `2026-01-20T13:00:00.000Z` | `2026-01-20T23:00:00.000Z` | 03:00Z - 4h, no clamp. `rows` length 4 survives (four distinct instants, all future, all < sched) |
| Test 1i (**not in plan/worklist**) | `day_before` skipped `quiet_hours_superseded` | skipped row | ARMED `2026-01-20T00:30:00.000Z` | identical fixture + derivation to Test 1c; `failingSettingsRepo()` falls back to `DEFAULT_ORG_SETTINGS`, so the outcome must match 1c exactly |
| Test 1i | `morning_of.dueAt` / unskipped count | `2026-01-20T13:00:00.000Z` / `2` | `2026-01-20T23:00:00.000Z` / `3` | as Test 1c |
| **A6-1** Test 2 `runDueTourReminders sends due rows and is idempotent` | `pollAt` | `2026-07-14T10:01:00.000Z` | `2026-07-14T23:31:00.000Z` | sched Jul 15 10:00Z = 06:00 EDT Jul 15, local date Jul 15; -1 = Jul 14; 19:30 EDT = `2026-07-14T23:30:00.000Z`; quietOff. Tick must sit just after it |
| **A6-1** Test 2 | premise comments | "day_before 10:00Z / en_route 08:00Z" | day_before `2026-07-14T23:30:00.000Z`, morning_of `2026-07-15T06:00:00.000Z`, en_route `2026-07-15T09:00:00.000Z` | the old en_route gloss was ALREADY WRONG in the live tree (sched-1h is 09:00Z, not 08:00) - corrected |
| **A6-2** Test 2b `emits scheduled.updated per claimed rung` | both ticks (2 sites) | `2026-07-14T10:01:00.000Z` | `2026-07-14T23:31:00.000Z` | same fixture; both `toHaveLength(2)` assertions then survive unchanged |
| **A6-4** Test 3 `cancel + re-arm on reschedule` | `dayBefore.dueAt` | `2026-07-19T18:00:00.000Z` | `2026-07-19T23:30:00.000Z` | newSched Jul 20 18:00Z = 14:00 EDT Jul 20; -1 = Jul 19; 19:30 EDT = 23:30Z; quietOff. Both `toHaveLength(4)` survive (rule 1 not built yet) |
| Test 5 `armTourReminders skips day_before ... (same-day tour)` | `morning_of.dueAt` | `2026-07-13T12:00:00.000Z` | `2026-07-13T10:00:00.000Z` | sched Jul 13 14:00Z - 4h; > now0 09:00Z -> armed; quietOff |
| Test 5 | `day_before` absent | absent | UNCHANGED (absent) | 19:30 EDT Jul 12 = `2026-07-12T23:30:00.000Z` < now0 09:00Z -> silent past-dueAt drop |
| **A6-3** `DAY_BEFORE_D11` | const | `2026-08-06T18:00:00.000Z` | `2026-08-06T23:30:00.000Z` | `SCHEDULED_D11` Aug 7 18:00Z = 14:00 EDT Aug 7; -1 = Aug 6; 19:30 EDT = 23:30Z; quietOff. Consumed by the `runDueTourReminders(...)` tick and the `sentAt` assertion in `re-adding the tenant lifts the suppression for the NEXT rung`; that tick still catches day_before ALONE (morning_of Aug 7 14:00Z, en_route Aug 7 17:00Z are later) |

### `app/test/toursApi.test.ts`

| assertion | old | new | derivation |
| --- | --- | --- | --- |
| `day_before` (SCHEDULED_AT block) | `2026-07-14T18:00:00.000Z` | `2026-07-14T23:30:00.000Z` | sched Jul 15 18:00Z = 14:00 EDT Jul 15; -1 = Jul 14; 19:30 EDT = 23:30Z; outside default window |
| `morning_of` (same block) | `2026-07-15T12:00:00.000Z` | `2026-07-15T14:00:00.000Z` | 18:00Z - 4h = 10:00 EDT, outside window |
| `day_before` (NEW_SCHEDULED block) | `2026-07-19T18:00:00.000Z` | `2026-07-19T23:30:00.000Z` | newSched Jul 20 18:00Z = 14:00 EDT; 19:30 EDT Jul 19 = 23:30Z |
| `day_before` (BOOKED_AT block) | `2026-07-14T18:00:00.000Z` | `2026-07-14T23:30:00.000Z` | identical fixture to the SCHEDULED_AT block |
| **C10** `day_before` (NEW_SCHED / PATCH-revival block) | `2026-07-24T12:00:00.000Z` | `2026-07-24T23:30:00.000Z` | FIXED_NOW Jul 13 12:00Z (08:00 EDT), NEW_SCHED Jul 25 10:00Z = 06:00 EDT Jul 25; -1 = Jul 24; 19:30 EDT = 23:30Z; OUTSIDE [21:00, 08:00) -> unclamped; > FIXED_NOW; clamped local date Jul 24 != Jul 25 so no `staleDayBefore`; 23:30Z Jul 24 < 10:00Z Jul 25 so not past-event |
| **C10** the neighbouring comment | claimed "06:00 EDT, INSIDE the default quiet window" | rewritten | that claim is now FALSE - 19:30 local is outside the default window. The `confirmation` assertion above it and the surrounding `past_event` behaviour for morning_of / en_route are UNCHANGED (morning_of raw Jul 25 06:00Z = 02:00 EDT inside -> clamps 12:00Z >= 10:00Z; en_route raw 09:00Z = 05:00 EDT inside -> clamps 12:00Z) |

### `app/test/devGating.test.ts` (**A6-6**)

| site | old | new |
| --- | --- | --- |
| `fires the due rows at the supplied now` second tick | `2026-07-14T18:01:00.000Z` | `2026-07-14T23:31:00.000Z` |
| `normalizes a milliseconds-less now` request body | `2026-07-14T18:01:00Z` | `2026-07-14T23:31:00Z` |
| same test, echoed normalized value | `2026-07-14T18:01:00.000Z` | `2026-07-14T23:31:00.000Z` |
| `armTourViaRoute` docblock ("day_before = T-24h") | prose | now names 19:30 EDT Jul 14 |

Derivation: FIXED_NOW Jul 13 14:00Z, SCHEDULED_AT Jul 15 18:00Z (14:00 EDT
Jul 15) -> day_before = 19:30 EDT Jul 14 = `2026-07-14T23:30:00.000Z`. Verified
safe: 19:30 EDT is outside the fire-time quiet window so no defer; the new
`morning_of` is `2026-07-15T14:00:00.000Z`, later than both ticks, so neither
batch changes shape (the ms-less test still sees `[DAY_BEFORE_BODY]` alone,
with confirmation retired by release supersession as before). The BODY
constants self-heal through the composer. All 41 tests green.

### `app/test/seedLive.test.ts`

No assertion re-derived. TOUR-A and TOUR-B passed unedited, as the plan and
research-6 both predicted (TOUR-A day_before raw Jul 14 23:30Z is still past
`FIXED_NOW` Jul 15 09:00Z -> still silently dropped until Task 7; TOUR-A
morning_of raw Jul 15 10:00Z = 06:00 EDT clamps to the same 12:00Z the old
08:00-local rung had; TOUR-B tracks through the twin).

---

## 5. A6-1..A6-6: all handled

| id | where | status |
| --- | --- | --- |
| A6-1 | `tourReminders.test.ts`, Test 2 `runDueTourReminders sends due rows and is idempotent` - `pollAt` moved to `2026-07-14T23:31:00.000Z`, premise comments rewritten (including the already-wrong en_route gloss) | DONE |
| A6-2 | `tourReminders.test.ts`, Test 2b `emits scheduled.updated per claimed rung` - both ticks moved to `2026-07-14T23:31:00.000Z`; both `toHaveLength(2)` assertions untouched and green | DONE |
| A6-3 | `tourReminders.test.ts`, `DAY_BEFORE_D11` -> `2026-08-06T23:30:00.000Z`, docblock rewritten | DONE |
| A6-4 | `tourReminders.test.ts`, Test 3 `cancel + re-arm on reschedule` -> `2026-07-19T23:30:00.000Z` | DONE |
| A6-5 | `tourReminders.test.ts`, Test 1d - NEW assertions: `rows` length 4 and unskipped kinds `['confirmation','day_before','en_route']`, with a comment saying why this case in particular gets a pin | DONE |
| A6-6 | `devGating.test.ts` - all three literals plus the `armTourViaRoute` docblock | DONE |

C9 (Test 1f preamble line number) and C10 (toursApi anchor + corrected value)
were both applied; C13 governed the twin edit. C14 belongs to Task 7 and was
not touched.

---

## 6. The retitles

Two required, plus one I judged mandatory on the same rule.

1. **Test 1c**: `a day_before clamped onto the morning_of slot is superseded
   (no day_before row)` ->
   `a late-evening tour retires en_route past the event, and the retimed
   day_before arms clear of the window`.
   Its block comment now records that the day_before-clamp scenario requires
   `quietHoursStart <= 19:30`, which Task 7's warn test pins.
2. **Test 1g**: `a rung whose clamped dueAt is still in the past is skipped
   (past-dueAt rule)` ->
   `the retimed day_before arms where the old -24h anchor fell past due (the
   other rungs stay past_event)`.
   It carries the required COVERAGE NOTE: the silent past-dueAt drop loses its
   last day_before-based coverage here, the two remaining rungs are
   `past_event` (a different branch), and the replacement pin is **Task 7's
   case 9 - an en_route booked inside its own one-hour lead time** (named, not
   line-numbered), with an explicit "do not leave the branch trusting this
   comment".
3. **Test 1h** (DEVIATION, see section 9): `with quiet hours disabled nothing
   is clamped, and morning_of is still 08:00 org-local` ->
   `with quiet hours disabled nothing is clamped, and day_before is still
   19:30 org-local`. The title asserted a fact the retime deletes. The property
   under test (a DISABLED window must not disable the timezone anchor) is
   unchanged; only which rung carries the anchor moved.

---

## 7. Verification

**Full app suite**, `cd W:/tmp/tour-reminder-ladder/app && npx vitest run`:

```
 Test Files  1 failed | 337 passed | 1 skipped (339)
      Tests  1 failed | 6022 passed | 9 skipped (6032)
```

The single failure is the KNOWN ENVIRONMENTAL signature, verbatim:

```
 FAIL  test/messaging.integration.test.ts > messaging repos against DynamoDB Local (throwaway prefix) > messagesRepo > getManyByTsMsgIds chunks past the 100-key BatchGetItem limit
Error: Test timed out in 60000ms.
```

Plain 60s timeout, ZERO assertion failures - the third slice in a row.
Re-run of that FILE alone under a clean access key
(`AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run test/messaging.integration.test.ts`):

```
 Test Files  1 passed (1)
      Tests  18 passed (18)
```

exit 0. Environmental, not chased further.

The one `skipped` file is `test/staticSmoke.test.ts` (9 tests), which
self-skips on a missing `dashboard/dist` - pre-existing and unrelated.

**No self-skip in any target file.** From the same full-suite log:

```
 ✓ test/toursApi.test.ts (183 tests) 3982ms
 ✓ test/tourReminders.test.ts (70 tests) 5071ms
 ✓ test/devGating.test.ts (41 tests) 1004ms
 ✓ test/seedLive.test.ts (15 tests) 2482ms
 ✓ test/computeDueAt.test.ts (7 tests) 31ms
```

Neither `seedLive.test.ts` nor `tourReminders.test.ts` printed its `SKIPPED`
warning; both ran their full case counts against DynamoDB Local.

Post-commit confirmation run of the five touched suites together:
`Test Files 5 passed (5) / Tests 316 passed (316)`, exit 0.

**Typecheck**: `cd W:/tmp/tour-reminder-ladder && npm run typecheck` ->
**exit 0** (app `tsconfig.json` + `tsconfig.scripts.json` +
`tsconfig.test.json`, dashboard, e2e, fake-twilio, fake-twilio-web all clean).

**Not run, per the mission**: `npm run e2e` (expected RED from this task until
Task 9), `npm test`, `npm run smoke`. No file under `e2e/` was touched.

---

## 8. Lint and ASCII

`npx eslint` on the six touched/created files -> **exit 0, no output**. Run
proactively, not as a slice gate; no baseline diff was needed since the result
is clean.

ASCII: a scan of every ADDED diff line plus the whole new test file returned
**0 non-ASCII characters**. One slipped in during editing (a `->` written as a
Unicode arrow in a Test 5 comment) and was fixed before commit. Pre-existing
non-ASCII elsewhere in `tourReminders.test.ts` and `seedLive.test.ts` was left
alone, per the touched-lines-only rule.

---

## 9. Deviations, with reasoning

1. **Two red tests beyond the enumerated set** - `tourReminders.test.ts`
   Test 1h (`with quiet hours disabled ...`) and Test 1i (`a settings read
   failure still clamps ...`). Neither the plan's Step 5 nor the worklist's
   A6-1..A6-6 names them; the full-file run showed 12 failures where the two
   documents together predict 10. Both are direct, mechanical consequences of
   the retime on fixtures the enumerated tests already cover (1h is Test 1c's
   tour under `quietOff`; 1i is Test 1c's tour with a failing settings repo),
   so I re-derived them from the fixtures rather than stopping. Every value is
   in the section 4 table. **This is an addendum to the worklist's Task 6 block
   worth carrying forward: call them A6-7 (Test 1h) and A6-8 (Test 1i).**
2. **A third retitle (Test 1h)**, beyond the two the mission named. Its title
   asserts `morning_of is still 08:00 org-local`, which the retime makes false;
   leaving it would have been exactly the "re-baseline without retitling" the
   mission forbids. Reasoning recorded in section 6.
3. **Test 1f's preamble was rewritten rather than re-pointed.** The plan
   expects it to keep citing a "pinned instead" test and asks that the citation
   move to Task 7's replacement. On reading it, the preamble's actual claim is
   about why `now` is two days out rather than one - and after the retime that
   distance no longer matters at all (day_before is future from either arm
   instant). Re-pointing the citation would have preserved a sentence whose
   premise is gone, so I restated it as historical and noted that the two-day
   distance now only keeps this fixture distinct from Test 1g. Test 1g itself
   carries the full Task-7-case-9 forward reference the plan asked for.
4. **Test 1c's rename is descriptive of the surviving behaviour**, not a
   removal. The fixture no longer demonstrates day_before supersession under
   the DEFAULT window, so the test now names what it does still prove (a 10pm
   tour's en_route retiring `past_event`) and its comment records where the
   lost scenario went (Task 7's `quietHoursStart <= 19:30` warn test).
5. **Commit message needed an amend.** The first `git commit` used PowerShell
   here-string syntax (`@'...'@`) inside the Bash tool, which is not heredoc
   syntax there, so a stray `@` landed as the subject line's first token
   (`bbbef96a`). Amended immediately with a proper heredoc; the final commit is
   `123aa43a` with the plan's exact Step 7 subject and the required
   `Co-Authored-By: Claude Opus 4.5` trailer. No other content changed.

No re-derivation of mine DISAGREED with the plan's or the worklist's stated
value. Every named literal - including C10's corrected
`2026-07-24T23:30:00.000Z` and A6-1..A6-4's values - matched what I computed
independently from the fixtures.

---

## 10. Noticed, not fixed

- **`tourReminders.test.ts` Test 2's en_route comment was already wrong before
  this slice** (`sched - 1h` glossed as `2026-07-15T08:00:00.000Z`; it is
  `09:00:00.000Z`). The worklist flagged it; I corrected it as part of
  rewriting that comment block, since I was rewriting the line anyway.
- **The `Test 1c` / `Test 1h` / `Test 1i` numbering in the file's section
  comments is now slightly off-name** - the labels are `Test 1c - (c) a clamped
  day_before loses its slot to morning_of` style banners above each `it`. I
  updated the banner text where I retitled, but the letter labels (1c, 1g, 1h)
  and the rule-letter cross-references `(a)-(d)` in the section header at the
  top of the arm-time block still describe the OLD rule distribution. Task 7
  already owns three stale prose surfaces in `jobs/tourReminders.ts` (A7-1) and
  adds a fifth rule `(e)`; this test-file header is the same class of drift and
  is the natural place to fix it in that task. Left alone here to keep the
  retime commit to its scope.
- **`Test 1c`'s remaining premise** - the comment about the 2h -> 1h en_route
  move putting the rung exactly at 21:00 EST - is still accurate and was kept.
- **Task 7 will invert Test 5 and seedLive TOUR-A again.** Test 5 carries a
  plain comment saying so (not a `TODO(...)` marker, per the plan's note that
  those need registry slugs here). seedLive was deliberately left untouched
  beyond the twin, so TOUR-A's inversion is entirely Task 7's (C14 applies
  there: only the pending-list and skipReason lines move; the morning_of
  clamped-dueAt assertion stays).
- **The e2e suite is now RED by design** and was not run. `e2e/` is untouched.

---

## 11. Commit

```
123aa43a feat(tours): retime day_before to 19:30 org-local and morning_of to T-4h
```

6 files changed, 233 insertions(+), 113 deletions(-):

- `app/src/jobs/tourReminders.ts` (modified)
- `app/test/computeDueAt.test.ts` (created)
- `app/test/seedLive.test.ts` (modified - twin only)
- `app/test/tourReminders.test.ts` (modified)
- `app/test/toursApi.test.ts` (modified)
- `app/test/devGating.test.ts` (modified)

Bare `git status` was read before staging (5 modified, 1 untracked, nothing
else); `MERGE_HEAD` confirmed absent at
`W:/AI Projects/Housing Choice/HC Application/.git/worktrees/tour-reminder-ladder/MERGE_HEAD`
(this worktree's real git dir - `.git` here is a file, so a plain
`.git/MERGE_HEAD` check reports "Not a directory" and proves nothing).
Explicit paths only, no `git add -A`. Tree is clean at HEAD.
