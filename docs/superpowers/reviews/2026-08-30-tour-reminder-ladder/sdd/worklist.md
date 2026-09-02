# WORKLIST - tour reminder ladder Phase A

Merged from six read-only research readers (research-1..6-*.md in this
directory). This file is an ADDENDUM to the plan, not a replacement.

**THE PLAN IS THE CONTRACT.** Where this file says nothing, follow the plan
verbatim. Where this file says CORRECTION, the plan's anchor or claim is wrong
against the live tree and THIS file wins. Where it says ADD, the plan omits a
surface that must be handled in the named task. Where it says ADJUDICATED, a
reader's claim was checked and settled - do not re-open it.

Read the reader report named beside an item for its byte-exact quotes.

---

## 0. Global facts confirmed against the live tree

- Branch tip `01550c91`, clean, docs-only. `node_modules` installed (exit 0).
  DynamoDB Local started (exit 0).
- The plan's line anchors are OVERWHELMINGLY accurate. Readers 2, 5 and 6 each
  verified long lists as exact. Only the deltas below are wrong.
- `TourReminderView.state` EXISTS (`app/src/routes/tourReminders.ts:133`,
  `'upcoming' | 'sent' | 'canceled' | 'skipped'`), so Task 9's
  `armedReminderDueAt` filter on `state === 'upcoming'` is safe. ADJUDICATED -
  reader 5 D2 flagged this as unverified; it is verified now.
- `QuietHoursWindow` fields are `enabled` / `start` / `end` / `timezone`
  (`app/src/lib/quietHours.ts:11-17`); `isQuietTime` gates on `enabled`
  (`:138`). Task 7's warn snippet is correct as written.

---

## 1. CORRECTIONS - plan anchors that are wrong

| id | Task | Plan says | LIVE (use this) | reader |
| --- | --- | --- | --- | --- |
| C1 | T5 | docblock carve-out at `jobs/tourReminders.ts:525-526` | the sentence spans **`:526-527`**; editing 525-526 truncates it mid-clause | R2 |
| C2 | T5 | D7 pending-open wait gated at `:770-782` | **`:771-783`** | R2 |
| C3 | T5 | `RemindersPanel.tsx` body line `~:352`, `<p className={styles.body}>{rung.body}</p>` | body `<p>` is **`:365-367`** and the className is a TEMPLATE: `` className={`${styles.body} ${rung.state === 'canceled' ? styles.struck : ''}`} `` - the quoted string does not exist | R4 |
| C4 | T5 | `ScheduledCard.tsx` reuses "a muted class" in its stylesheet | the sheet is `./Timeline.module.css` and it has **no `.muted`**; the only muted-ish class is `.scheduledSkipMuted` (`:719`), scoped by its own comment to the quiet-hours note. **ADD a new class matching the sheet's conventions** - do not reuse `.scheduledSkipMuted`, do not inline | R4 |
| C5 | T5 | case 14: "if no `ScheduledCard` test file exists..." | it EXISTS: `dashboard/src/routes/contact/ScheduledCard.test.tsx` (165 lines). Add the pin there too; the conditional is dead | R4 |
| C6 | T8 | `RemindersPanel.test.tsx:261`'s regex "keeps working" | it is `/Send Day before reminder now/i` and **FAILS** after the "the" insertion. It MUST be edited to `/Send the Day before reminder now/i`. Only `:517`'s `/reminder now$/` genuinely needs no edit | R4 |
| C7 | T4 S9 | contactTimeline `unitOnce` at `:859-870` (plan) / `:860-871` (spec) | the Map is `:859`, the arrow fn `:860-870`, `:871` blank. Plan is right, spec is off | R3 |
| C8 | T4 S13 | relayApi scheduled-bucket tests at `:1445-1502` | the `describe` opens `:1425`, seed helper `:1429-1455`, tests **`:1457-1592`** | R3 |
| C9 | T6 S5 | Test 1f preamble at `:396-398` | **`:395-398`** | R6 |
| C10 | T6 S5 | toursApi `:2727-2731` | the `day_before` assertion is at **`:2730`** (`:2727-2729` comments). **Corrected value: `'2026-07-24T23:30:00.000Z'`** (sched `2026-07-25T10:00Z` = 06:00 EDT Jul 25) - reader 6 derived it; surrounding `past_event` skips are unchanged | R6 |
| C11 | T10 S1 | matrix comments `:983-991` | the comment is `:984-985` and `:991` | R6 |
| C12 | T1 | append `import { shiftLocalDate } from '../src/lib/localTime.js';` to localTime.test.ts | the file ALREADY imports from that specifier at `:2`. **Merge into the existing import** - a second statement trips `no-duplicate-imports` under gate 5 | R1 |
| C13 | T6 S1/S4 | the `seedLive.test.ts` twin takes `(kind, scheduledAt, now, WINDOW)` | the TWIN is `computeDueAt(kind, scheduledAt, now)` with the window CLOSED OVER as `QUIET_WINDOW` (`:51`) and a clamp folded in at `:77`. Mirror the two CASES; the Step 3 fragments cannot be pasted verbatim | R6 |
| C14 | T6 S4 | seedLive TOUR-A: "`:198-204` become `pending = ['en_route']` and a skipReason assertion" (Task 7 Step 4) | only **`:199` and `:201`** change. **`:202-204` (the morning_of dueAt = 08:00-local assertion) STAYS EXACTLY AS IS** - rule 2 stores the CLAMPED value. Do not delete it | R6 |
| C15 | T4 S8 | "`resolveMessage` at `:43` - that line was its ONLY use" | true for CALLS, but the identifier also appears in the docblock PROSE at `:536`. Step 8 already rewrites `:532-537`; make sure the prose mention goes with the import | R3 |
| C16 | spec 8.1 | "assertions at `tourReminders.test.ts:1211`, `:356`, `:397`" | those are COMMENT lines. The assertions are `:1213`, `:359`, and the `it(` at `:394`. **The PLAN's own numbers are correct**; only the spec prose drifted | R2 |

---

## 2. ADJUDICATED - reader claims checked and settled. Do not re-open.

- **A1. Reader 5 D6 is WRONG.** It claims the `tours.spec.ts:134` margin collapses
  to 60 seconds at wall-clock tod ~23:31. Recomputed: `tourSchedule()` books
  `now + 48h` at the same time-of-day `T` on day D. `day_before` fires 19:30 on
  D-1; `morning_of` fires `T - 4h` on D, which lands on D-1 only when `T < 04:00`,
  and the WORST case in that band is `T = 00:00` giving `morning_of` at 20:00 D-1
  - **30 minutes after the tick, exactly as the plan states**. At `T = 23:31`,
  `23:31 - 4h = 19:31 on D`, a full day after the tick, not D-1. The plan's
  margin claim stands. Still write the plan's host-zone honesty comment.
- **A2. The segment assertion is DELETED, not kept.** The adjudications file's
  round-2 ruling ("this is a design constraint") was REVERSED by the final spec
  (section 5, commit bb4b0475) and by the mission block. Delete
  `analyzeSms(body).segments === 1`; keep the ASCII assertion; measure and
  report at Task 11 Step 7 as a cost note only.
- **A3. Nudge accessible names are DELIBERATELY NOT CHANGED.** Task 8 inserts
  "the" into the two REMINDER aria templates only. `DeadlinesNudgesCard.tsx:273`
  / `:284`, `e2e/support/selectors.md:73` and
  `e2e/tests/dashboard-next/placements-page.spec.ts:216-226` keep
  `Send <label> nudge now` / `Cancel <label> nudge`. Rationale: the relabel's
  knock-on is scoped to the rung whose LABEL changed; sweeping a sibling panel's
  grammar is scope creep, and `selectors.md:93` already pins
  `Send the relay group now`, so "the" is house-acceptable on one side without
  forcing the other. RECORD THIS IN THE HANDBACK so a reviewer does not read it
  as a missed sweep. (R4 G4, R5 G9.)
- **A4. Reader 4 D9 warns the plan's grep `"Cancel Day before"` / `"Restore"`
  returns only NUDGE hits.** Correct, and per A3 those must NOT be edited. Run
  the grep to confirm coverage, then leave the nudge hits alone.
- **A5. `e2e/tests/tour-roster.spec.ts` is NOT under `tests/scenarios/`.** The
  plan's citation is path-less so it survives; do not go looking in the wrong
  directory. That file is READ for a pattern, not modified.
- **A6. Reader 3 D10** disputes the spec's aside that `relayGroups.ts:258` is
  "not a tour-reminder route surface". Reader 3 is right on substance - it is the
  ONLY surface rendering landlord-led GROUP copy to a client - which is exactly
  why the plan gives it a dedicated name pin (T4 S13 case 4) and a withhold pin
  (T5 case 6). No plan change; the spec aside is a wording nit.
- **A7. Reader 2 G6** (the 7.1 warn fires once per arm, incl. seeds) - ACCEPTED
  AS SPECIFIED. Spec 7.1 asks for an arm-time warn; it only fires for an org with
  `quietHoursStart <= 19:30`, which is not the default. No dedupe. Note the
  volume in the handback.
- **A8. Reader 2 G4** (`claimSkip` now accepts an arm-only reason) - do NOT build
  a narrowed subtype. Add a one-line comment at `claimSkipRow` saying
  `booked_too_late` is ARM-ONLY and must never be passed here. Cheap, in scope.
- **A9. Reader 3 G6** (PATCH/send-now echoes now pay contact reads) - ACCEPTED.
  Per-request, not per-rung, so spec 10's batching rule holds. Handback note.
- **A10. `getById` reads stay eventually-consistent** (no `consistentRead`),
  matching `resolveReminderTarget`. Deliberate. Handback note. (R1 G12.)

---

## 3. ADD - surfaces the plan omits, assigned to a task

### Task 4 (catalog, composer, compose paths)

- **A4-1 (R3 D8).** `routes/tourReminders.ts` does **NOT** import `UnitItem`
  today (only `ToursRepo`/`TourItem` `:56`, `UnitsRepo` `:58`). Step 7's
  `let unit: UnitItem | undefined;` needs a NEW type import.
- **A4-2 (R3 D9).** Step 10's relayGroups snippet must ALSO declare
  `let unitReadFailed = false;` and set it in the unit catch. Task 5's snippet
  consumes it; as written the two do not compile together.
- **A4-3 (R3 G9).** `app/src/routes/api.ts:966-968` wires the relay router's
  contacts from `deps.contactsRepoForRelay` FIRST, falling back to
  `deps.contactsRepo`. Any relayApi test injecting a throwing contacts repo
  (T4 S13 case 4, T5 case 6) MUST use `contactsRepoForRelay` or it silently
  exercises a different repo.
- **A4-4 (R1 G11).** In the new "token declarations" test loop, also assert
  `expect(MESSAGE_CATALOG[id].channel).toBe('sms')`. `messageCatalogAscii.test.ts`
  filters on `channel !== 'sms'` (`:20`, `:33`), so a new entry with the wrong
  channel escapes BOTH the ASCII and GSM-7 guards - the guards spec 5 leans on
  as its reason for dropping the segment budget.
- **A4-5 (R1 G5).** The exhaustive matrix test must also assert no literal token
  survives: `expect(body, label).not.toMatch(/\{[A-Za-z]/)`. `interpolate`
  silently drops vars that are not DECLARED, so a typo in a var key
  (`addresLine`) leaves the token in the body with nothing else catching it.
- **A4-6 (R1 D11/G3).** `app/test/tourCopy.test.ts:109`'s `it` title is
  "OUR copy is ASCII **and single-segment** with the seeded address". Deleting
  the segment assertion leaves the title lying. RENAME it.
- **A4-7 (R1 D9/D10).** Step 1's deletion ranges undercount: the `:22-49` pins
  also need their enclosing `describe` (`:14`), the `addr` const (`:15`) and the
  token-contract comment (`:17-21`); and the address-shape tests at `:77-105`
  are superseded by the new "address shapes" describe.
- **A4-8 (R5 G11).** The `TourContactNames` re-export in `tourCopy.ts` MUST be
  the erased form `export type { TourContactNames } from '../lib/tourContacts.js';`.
  `e2e/scenarios/steps.ts:37` is a VALUE import of this module, so any
  non-`export type` form drags the AWS SDK into the harness bundle.
- **A4-9 (R5 D14).** `teamCreatesLandlord` (`steps.ts:1088`) ALSO writes
  `this.activeTenant` (`:1106-1111`) with the LANDLORD's name. Today every
  tour-creating spec makes the landlord first, so `activeTenant` is the tenant at
  tour-creation time - but it is ordering luck. Add a comment at the
  `tenantFirstName: this.activeTenant?.firstName` line naming the hazard.
- **A4-10 (R1 G4).** The composer's new `.trim()` now applies to `confirmation`
  and `no_show_checkin` too. No rendered output changes (their defaults have no
  stray whitespace). Handback sentence only.
- **A4-11 (R3 G3).** Step 8 adds `readQuietHoursWindow(settings, log)` to the
  no-show draft handler. Verify `toursApi.test.ts`'s `makeWebhookHarness()`
  actually wires a settings repo on this mount - if not, the route
  default-constructs a real DynamoDB SettingsRepo in unit tests.
- **A4-12 (R3 G7).** `viewOf`'s docblock (`:262-265`) says the body needs "async
  unit/settings reads" - it now needs async CONTACT reads too. Update it.
- **A4-13 (R3 G8).** `TourRemindersRouterDeps.unitsRepo`'s docblock (`:91-95`)
  says "ONE unit read, TWO consumers". It now has THREE, and per Task 5 a failed
  read can BLOCK a send. Update it in the same change as the jobs-side twin.
- **A4-14 (R1 G9).** `app/test/messages/resolve.test.ts:17` carries a comment
  describing the tour entries as a class ("every tour.* default ..."). Re-read it
  after the catalog rewrite and correct it if false. Not in the plan's file list.
- **A4-15 (R1 G2).** `services/rosterProvision.ts:525` is a THIRD copy of the
  primary-contact rule and it is the one WITHOUT the empty-string guard
  (`?? unit.landlordId` bare). PRE-EXISTING, OUT OF SCOPE - do not fix it. Flagged
  so a builder who greps instead of following the `:233` citation does not copy
  the wrong line. File nothing; mention in the handback.

### Task 5 (failure semantics)

- **A5-1 (R3 G5).** Containing `resolveTenantSuppression` flips the GET route's
  log field `suppressed:` (`routes/tourReminders.ts:510-518`) from true to false
  during a contacts outage, with no other signal. Add a distinguishing field
  (e.g. `suppressionEstimateFailed: true`) to that log line in the same change.
- **A5-2 (R3 G1).** `relayGroups.ts` has NO `sentBody` snapshot branch
  (`:250-252` says so). The withhold branch is unconditionally first there, so
  the three copies now differ in branch ORDER. The DUPLICATED SHAPE comments must
  say that, not claim all three are identical.
- **A5-3 (R3 G2).** `namesOnce` is keyed by `unitId` only, while
  `assessNamesReadFailure` takes `tourType`, and the timeline walk admits tours
  of DIFFERENT types at the SAME unit. Safe today (the resolver does not branch on
  tour type; only the flags are memoized, and the assessor is called per-tour).
  Add a comment saying exactly that, so a future resolver that does branch on
  tour type cannot silently cross-contaminate.
- **A5-4 (R3 G4).** The draft handler gains a THIRD terminal shape. Its docblock
  (`:539-541`) claims two. Update it.
- **A5-5 (R2 G5).** `forceSendReminder:1167` returns `reason: 'tour_missing'`
  when the ROW is missing - misleading, but PRE-EXISTING and only reachable on a
  delete race. OUT OF SCOPE. Handback note only.

### Task 6 (retiming) - FOUR RED TESTS THE PLAN DOES NOT LIST

These are in `app/test/tourReminders.test.ts` and go red on the retime. All four
must be re-derived in Task 6, and the file is already in Task 6's `git add` list.

- **A6-1 (R6 GAP-1). Test 2 (`:531-599`).** Arm now0 `2026-07-13T10:00:00.000Z`,
  sched `2026-07-15T10:00:00.000Z`, quietOff. Tick 2 fires at
  `'2026-07-14T10:01:00.000Z'` (`:580`) on the premise (`:575`) that `day_before`
  is `'2026-07-14T10:00:00.000Z'`. New `day_before` is
  **`'2026-07-14T23:30:00.000Z'`** -> that tick catches nothing and `:584`,
  `:587`, `:594` all fail. Move `pollAt` to `'2026-07-14T23:31:00.000Z'` and
  rewrite `:575-579`. NOTE `:576`'s en_route comment is ALREADY WRONG in the live
  tree (`sched - 1h` is `09:00:00.000Z`, not `08:00`), and new `morning_of` is
  `'2026-07-15T06:00:00.000Z'`.
- **A6-2 (R6 GAP-2). Test 2b (`:606-657`).** Same fixture; `:648`/`:653` tick at
  `'2026-07-14T10:01:00.000Z'` and `:649`/`:654` assert two emitted events. Same
  fix.
- **A6-3 (R6 GAP-3). `DAY_BEFORE_D11` (`:2635`).** `'2026-08-06T18:00:00.000Z'`
  with `SCHEDULED_D11 = '2026-08-07T18:00:00.000Z'` (14:00 EDT). New value
  **`'2026-08-06T23:30:00.000Z'`**. Consumed at `:2753` and `:2757`; the test at
  `:2735` goes red at `:2754`.
- **A6-4 (R6 GAP-4). Reschedule Test 3 (`:1087-1139`).** `:1134` pins
  `day_before` `'2026-07-19T18:00:00.000Z'` for `newScheduledAt`
  `'2026-07-20T18:00:00.000Z'`, quietOff. New value
  **`'2026-07-19T23:30:00.000Z'`**. Rule 1 does not fire, so both
  `toHaveLength(4)` assertions survive.
- **A6-5 (R6 GAP-6).** Test 1d has NO length/filter assertion to re-derive. Since
  1d is the case whose premise the retime most changes (day_before flips from
  silently-dropped to armed), ADD one pinning 4 rows / 3 unskipped.
- **A6-6 (R6, devGating).** The plan says "grep and re-derive" but never states
  the literals. They are: `:561` -> `'2026-07-14T23:31:00.000Z'`,
  `:575` -> `'2026-07-14T23:31:00Z'`, `:577` -> `'2026-07-14T23:31:00.000Z'`.
  Verified safe (19:30 EDT is outside the fire-time quiet window; new
  `morning_of` `2026-07-15T14:00:00.000Z` is not in either tick's batch).

### Task 7 (skip rules + warn)

- **A7-1 (R2 G1/G2/G3). Three stale prose surfaces inside
  `app/src/jobs/tourReminders.ts` that no task edits.** All three describe the
  arm-time skip behaviour this task adds a fifth rule to, and all three already
  open with the FALSE claim "a skip creates NO row":
  - the module header `:1-32` (specifically `:6-8`),
  - `armTourReminders`'s docblock `:215-225`,
  - the pass-2 rule list `:252-260` ((a)-(d), which needs an (e)).
  Fix all three in Task 7. They are the readers a founder-facing question lands on.
- **A7-2 (R6 GAP-13). Task 7 case 7's revival half needs a NEW fixture.**
  `toursApi.test.ts:1273-1283` books two days out, so neither rule fires and no
  chip appears. Its `pendingRows` helper (`:1228-1231`) only counts PENDING rows,
  so a `booked_too_late` assertion needs a new accessor too. Write both.
- **A7-3 (R6, case 6 caveat).** In case 6, `morning_of` raw is EXACTLY `now`
  (`2026-07-24T01:00:00.000Z`). The past-dueAt branch is `if (dueAt < now)`, so
  the row survives - but it is armed already-due. Say so in a comment; a builder
  who "tidies" that boundary to `<=` breaks the case.
- **A7-4 (R2 G11).** After the retime, `staleDayBefore` (`:294-295`) can never
  fire under the DEFAULT window - case 8 (`quietHoursStart: '19:00'`) becomes its
  ONLY coverage. Label case 8 in its test name as load-bearing for
  `staleDayBefore` itself, not only for the WARN, so nobody deletes it as "an
  unusual org config".
- **A7-5 (A8 above).** One-line comment at `claimSkipRow` (`jobs:508`):
  `booked_too_late` is ARM-ONLY, never a claim-time reason.

### Task 8 (relabel)

- **A8-1 (C6).** Edit `RemindersPanel.test.tsx:261`'s regex.
- **A8-2 (R4 D8 / R5 D13).** The `"reminder now"` grep also hits
  `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:41-42`, which is PROSE
  quoting the template, not a locator. Reword it; do not "update the pin".
- **A8-3 (A3).** Leave every nudge aria name alone.
- **A8-4 (R5 G5).** `steps.ts:3368-3376` filters reminder rows by
  `REMINDER_KIND_LABELS[kind]` via Playwright `hasText`, a substring match over
  the WHOLE listitem (which includes the composed body). `'Morning of'` could not
  collide; `'4 hours before'` is prose-shaped. Confirm no rung body contains
  "4 hours" (the new copy does not) and add a comment recording the changed
  collision profile.
- **A8-5 (R4 G6).** Task 8 changes the label and Task 10 fixes
  `docs/issues/tour-reminders-panel-e2e-flake.md:112`, which quotes it. That is
  two commits apart. ACCEPTED - the tree is self-consistent again by Task 10, and
  splitting registry work out of Task 8 is the plan's deliberate shape.

### Task 9 (e2e)

- **A9-1 (R5 G1). The timing contract's supersession bullet
  (`quiet-hours.spec.ts:35-38`) is FALSIFIED and Step 4's rewrite instruction does
  not name it.** It argues the assertions ride `day_before` because it is "the
  LAST due rung, which nothing can supersede". After the retime `day_before` at
  19:30 D-1 is unambiguously the EARLIEST rung - exactly the one release
  supersession can retire. Rewrite that bullet with the new argument (the release
  tick at dueAt + 5h is still before `morning_of` at 10:00 on tour day).
- **A9-2 (R5 G3).** `scheduled-visibility.spec.ts:186` reschedules with
  `tourSchedule(72)` and asserts panel states at `:188-189`. Not in Task 9's
  analysis. `confirmation` (dueAt = arm instant) stays earliest so `:189`
  survives, but re-derive it explicitly rather than assuming.
- **A9-3 (R5 G4).** `scheduled-visibility.spec.ts:108` is the one e2e site whose
  ROW LOCATOR text changes ("Morning of" -> "4 hours before"), via
  `REMINDER_KIND_LABELS`. Covered by Task 8 Step 4, but verify the card has no
  other "4 hours" text.
- **A9-4 (R5 G5).** `scheduled-visibility.spec.ts:110-118` asserts
  `no_show_checkin` has ZERO rows. Still true (manual-only, never armed) - but
  re-derive it, because `booked_too_late` makes ladders LONGER.
- **A9-5 (R5 G6).** `tour-comms-pane.spec.ts:230-237` asserts `toHaveCount(1)`
  filtering by a full composed `day_before` body. The new `day_before` and
  `morning_of` copies SHARE the head "Hey <Name>," and the tail "Does that still
  work for you?" - the day_before body is still not a substring of the
  morning_of body, so the count holds. Record it as a near-miss in a comment.
- **A9-6 (R5 D15).** `tour-no-show-checkin.spec.ts`'s falsified prose is wider
  than the plan's `:28-31` and `:64`: also `:6-8` (the header's "arms the reminder
  ladder") and `:71-74` (Half 1's "The four legit rungs may land 1:1").
- **A9-7 (R5 G7/G8).** The no-show phrase now exists as THREE literals
  (`steps.ts:196`, `tour-no-show-checkin.spec.ts:32` `CHECKIN_PHRASE`, and the new
  exact prefill at `:97-99`). Consolidate to two: keep the marker and
  `CHECKIN_PHRASE`, and build the exact prefill from `CHECKIN_PHRASE`.
  Additionally, Half 1's derivation ("NOTHING is pending, the tick fires
  NOTHING") is asserted only against `CHECKIN_PHRASE`, so a wrong derivation
  fails SILENTLY - add an assertion that the tick sent nothing at all.
- **A9-8 (R5 G10).** `e2e/performance/*` pins `/api/tours/:tourId/reminders` as a
  required route and `collect.ts:63` fingerprints its SOURCE
  (`CONTRACT_SOURCE_LEDGER.background.tourReminders`). The route source changes in
  Task 4/5. **CHECK `e2e/performance/collect.test.ts` in the Task 4 suite run**;
  if the fingerprint is pinned, it must be regenerated. Nobody owned this.
- **A9-9 (R5 G12).** `expectReminderRung`'s state union (`steps.ts:3374`) has NO
  `'skipped'` member, so no Scenario verb can assert a skipped rung. Phase A owes
  NO e2e proof of `booked_too_late` (spec 13 owes a unit test on the LABEL only),
  so DO NOT widen it here. Record the gap as bullet (c) of the new
  `tour-reminder-zero-primary-e2e-gap.md` issue (Task 10).

### Task 10 (seeds, prose, registry)

- **A10-1 (R6 GAP-7).** `docs/issues/scheduled-message-visibility.md:33-34` is a
  LIVE registry file stating the old ladder verbatim
  (`day_before (-24h), morning_of (08:00 day-of), en_route (-2h)`). The `-2h` has
  been wrong since 2026-08-18. Fix it - same class as the flake-issue repro step.
- **A10-2 (R6 GAP-8).** In `docs/issues/tour-reminders-panel-e2e-flake.md`, the
  plan edits only `:112`. Also false after Task 6: `:117-118`, `:125-126`,
  `:129-131` and especially `:143` ("drop the `morning_of` rung assertion - it is
  the one rung whose presence is wall-clock dependent"). After the retime
  `morning_of` is a pure offset and `day_before` is the wall-clock-sensitive rung.
  AGENTS.md treats this resolved issue as a live REOPEN TRIGGER, so a false
  suggested-next-step is the exact failure the `:112` edit exists to prevent.
- **A10-3 (R6 GAP-9).** That same file's frontmatter is UNTERMINATED - the block
  runs to `:28`. `scripts/issues.mjs:33` reads any `^word:` line inside it as a
  field. Fix the missing delimiter in the same pass, and keep edits below `:28`.
- **A10-4 (R6 GAP-10).** `seed/live.ts:515` and `:524-525` say "all 5 rungs
  should arm" (false since `no_show_checkin` became manual-only) WITHOUT the words
  "5-rung" or "ladder", so the plan's literal grep misses them.
- **A10-5 (R6 GAP-11).** `seed/cast.ts:753`'s comment says
  "no reminder rows - all sent already" directly above three reminder rows. Fix it
  alongside `:768`.
- **A10-6 (R6 GAP-5).** In `documentation/tours-sequence-writeup.md`, also fix
  `:97-102` (a blockquote saying the booking text "already says 'confirmed'") and
  `:119-120` ("Rungs whose time is already past when armed are skipped" - after
  Task 7 that is only true for `en_route` and clamped rungs).
- **A10-7 (R6 D3.4).** `tourcopy-messageid-cast-unguarded.md`'s Suggested fix
  (`:48-51`) references the `tour.<kind>_no_address` twins that spec 6.4 removes.
  The new Resolution paragraph would sit under a false suggestion - strike or
  annotate it.
- **A10-8 (R6 GAP-14).** `docs/research/message-catalog-worklist.md:23-26` quotes
  the OLD tour body strings. Add a one-line dated stale banner; do not rewrite a
  research artifact.
- **A10-9 (R6 GAP-12).** Adding `DEFAULT_ORG_SETTINGS` to `matrix.ts` gives that
  pure generator its first `repos/settingsRepo` import.
  `app/test/seedMatrixCoherence.test.ts:32` calls `matrixItems(NOW)` at MODULE TOP
  LEVEL with no Docker and no `skipIf`. The SDK is almost certainly already in
  that graph via `placementDeadlinesRepo` (`:26`) - VERIFY, and if it is not,
  hoist the timezone constant rather than importing the repo.
- **A10-10 (A9-9).** Widen the new e2e-gap issue to cover three bullets:
  (a) zero-primary has no e2e path, (b) the harness cannot compose an exact
  landlord-led `en_route` body, (c) `expectReminderRung` cannot assert a SKIPPED
  rung at all, so `booked_too_late` has no e2e verb.
- **A10-11 (R4 G1).** Add a coverage test to `dashboard/src/api/types.test.ts`
  modelled on its existing `SERVER_CODES` pattern (`:9-24`, `:29-35`): enumerate
  the ten skip reasons LITERALLY and assert each has a label. The `Record` type
  only catches "member added, label missing"; nothing catches "app added a reason,
  dashboard union never touched". The file's own comment already states the
  idiom ("Listed here rather than imported from the map so that DELETING an entry
  from the map is a test failure"). Cheap, and it is the guard Task 3's rationale
  promises but does not deliver.

---

## 4. OUT OF SCOPE - found, deliberately not fixed

Record each in the handback; do NOT fix on this branch.

- `services/rosterProvision.ts:525` - primary-contact rule without the
  empty-string guard (R1 G2).
- `RemindersPanel.tsx:189` - renders `err.message` RAW for the LIST fetch, the
  same hazard Task 5 fixes in `TourDetail.tsx:345` (R4 G3). Load-shaped, so the
  send map is wrong for it; a real fix needs its own copy decision.
- `TourDetail.tsx:305, 366, 411, 426` - four more raw-`err.message` catches
  (R4 G9).
- `RemindersPanel.tsx:103` - the skip chip has no `?? rawReason` fallback, unlike
  its siblings at `:318` and `ScheduledCard.tsx:85` (R4 G2).
- `dashboard/src/api/types.ts:2391` - `TimelineScheduled.reminderKind` is a THIRD
  hand-duplicated kind union (R4 G10).
- `forceSendReminder:1167` - `tour_missing` on a missing ROW (R2 G5).
- `contactTimeline.ts:892-895` - a `RunDueTourRemindersDeps` fabricated by CAST
  without `contactsRepo`; safe today because it only feeds `resolveUsableGroup`,
  but it is the one place a compose path could get `undefined.getById` (R2 G10).
- `lib/performanceSeed.ts:167` wires a tourReminders repo nothing writes (R2 G8).

---

## 5. Slice order (Phase 2)

Sequential, one implementer child each, commit per plan task.

| slice | tasks | note |
| --- | --- | --- |
| S1 | T1, T2, T3 | three small TDD tasks, three commits |
| S2 | T4 Steps 1-5 | catalog + composer + composer tests (red-to-green in one file pair) |
| S3 | T4 Steps 6-16 | every call site + harness + test threading + FULL e2e + ONE commit covering all of T4 |
| S4 | T5 | failure semantics, five consumers |
| S5 | T6 | retiming (+ the four unlisted red tests A6-1..A6-4) |
| S6 | T7 | skip rules + warn + the three stale docblocks |
| S7 | T8 | relabel |
| S8 | T9 | e2e rework |
| S9 | T10 | seeds, prose, registry |

S2 and S3 share Task 4's single commit: S2 leaves the tree RED (the composer's
new signature breaks every call site) and MUST NOT commit. S3 finishes and
commits the whole task. Stated explicitly because it is the one place the
"commit after every task" rule does not mean "commit after every child".

e2e RED WINDOW: green at the end of S3; expected RED from S5 until S8 closes it.
Do not run the e2e gate between them.
