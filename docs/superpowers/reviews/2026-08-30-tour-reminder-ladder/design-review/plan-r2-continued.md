# Plan review - round 2 (continued reviewer C)

Reviewer: the round-1 plan reviewer, continued with prior context.
Scope: the REWRITTEN plan (12 tasks), the amended spec, and the adjudications.
Method: every claim about existing behavior carries file:line, verified in
`W:/tmp/tour-reminder-ladder` at `f88282a9`. Anything I could not check is
marked UNVERIFIED.

My round-1 findings are closed; I do not re-litigate them below except where a
fix introduced a new defect. The bulk of this report is new ground.

---

## Summary of what round 1 (all three reports) missed

One theme dominates, and it is exactly the class the coordinator named:
**an unenumerated READER of state the plan changes.**

`confirmation` is not merely a rung being turned off. It is the **universal test
vehicle for the entire tour-reminder corpus**, in both the app suite and the e2e
suite, *because its `dueAt` is `now`* (`app/src/jobs/tourReminders.ts:98`) - it
is the only rung that can be fired without time travel. Task 9 deletes it from
`REMINDER_KINDS` in five words and no task repairs the ~55 assertion sites that
depend on it. Nobody in round 1 grepped for it, including me.

---

## BLOCKING

### 1. Task 9 destroys the e2e suite's only "fire a reminder now" mechanism; three specs, 14 sites, one file in NO task

`e2e/scenarios/steps.ts:1917-1918` documents the harness contract:

> Omitting `now` uses the server wall clock (**fires the just-armed
> 'confirmation' rung**); pass `justAfter(times.<rung>)` to fire a future rung.

Remove `confirmation` from arming and `tickTourReminders()` with no argument
fires **nothing**. Every spec that used it to make a reminder go out
immediately silently stops proving anything, or times out.

Affected sites, none of which appear in Task 9's or Task 11's file lists:

| File | Lines | What breaks |
| --- | --- | --- |
| `e2e/tests/tour-roster.spec.ts` | `:498-499` | `reminders.find(r => r.kind === 'confirmation')` then **`throw new Error('the booking armed no confirmation rung')`** - a pre-written hard failure with that exact message |
| `e2e/tests/tour-roster.spec.ts` | `:519-521` | asserts the panel row `REMINDER_KIND_LABELS.confirmation` shows `Skipped - tenant_not_on_roster` - the whole D11 roster-removal proof is anchored on this rung |
| `e2e/tests/scenarios/scheduled-visibility.spec.ts` | `:106, :135, :178, :180, :189, :198` | `expectReminderRung('confirmation', 'next'\|'sent')`, `expectReminderTo1to1('confirmation', ...)`. `:106`'s `'next'` also assumes confirmation is the next-to-fire rung; after Task 9 that becomes `day_before` at 19:30 D-1 |
| `e2e/tests/scenarios/tours.spec.ts` | `:131, :133, :185, :229, :265, :285` | `expectReminderInGroup('confirmation', [tenant, owner])`, `expectReminderVisibleInGroupThread('confirmation')`, three `expectReminderTo1to1`. **This is the suite's group-routing proof** (`landlord_led`/`pm_team` -> pool number), and it rides entirely on confirmation |

`e2e/tests/tour-roster.spec.ts` is named by **no task in the plan.** It also
imports `REMINDER_SKIP_REASON_LABELS` from `dashboard/src/api/types.js`
(`tour-roster.spec.ts:62-65`), so the e2e workspace has a compile dependency on
the union Task 5 edits.

The repair is not mechanical. Each site must move to a different rung, and the
candidates are bad: `day_before` becomes 19:30 org-local (Task 11 correctly says
a host-local helper cannot compute it), `morning_of` becomes `-4h` (mirrorable,
but 4h out, so `justAfter` works), `en_route` `-1h`. Choosing per-spec and
re-deriving each tick instant is real design work that Task 11 does not scope
and Task 9 does not mention.

**Consequence if it ships:** Task 11 Step 6 runs `npm run e2e` and it is red for
reasons Task 11 never anticipated, ~20 minutes per iteration, with a builder who
has no context for why `confirmation` mattered.

### 2. `confirmation` is the default vehicle across ~40 sites in `app/test/tourReminders.test.ts`, and that file is in NO re-baseline task

Task 10 ("app-suite re-baseline") lists `tourRemindersApi`, `contactTimeline`,
`devGating`, `relayAnnouncements`, `toursApi`, `relayApi`, `messages/catalog`,
`RemindersPanel`. It **omits `app/test/tourReminders.test.ts`**, which Tasks 6,
7, 8 and 9 all write INTO but only ever ADD to.

Sites that break structurally (the rung the test drives ceases to be armed), not
by copy or timing:

- `:431` `expect(...).toEqual(['confirmation', 'day_before'])` - ordered exact match
- `:462` `expect(rows.filter(r => r.skippedAt === undefined).map(r => r.kind)).toEqual(['confirmation'])`
- `:591, :701, :1163, :1179, :1404, :1858, :1906` - `rows.find(r => r.kind === 'confirmation')` after `armTourReminders`, then dereferenced
- `:1216` `expect(armedKinds).toContain('confirmation')`
- `:1263` `expect(forThisTour1[0]!.kind).toBe('confirmation')`
- `:2678, :2700, :2730, :2742, :2775, :2791, :2805, :2812, :2825, :2882` - the **entire D11 roster-gate block** via `rungOf(tour.tourId, 'confirmation')`
- `:2972` loops `['confirmation','day_before','morning_of','en_route']`

Also outside Task 10's list: `app/test/toursApi.test.ts:1410, :1448, :1592,
:2727` (`expect(byKind['confirmation']?.dueAt).toBe(FIXED_NOW)` - the `?.` means
these fail by comparing `undefined`, not by throwing, so the failure message is
uninformative) and `app/test/relayApi.test.ts:1476, :1492, :1502, :1584`.

Task 10 Step 3's instruction - "re-baseline each failing expectation **to the
new copy, timing and label**" - is the wrong instruction for these. There is no
new copy or timing to re-baseline to; the row does not exist. A builder
following Step 3 literally will start deleting assertions.

### 3. Task 8's TDD red state is not red - the first test passes before any implementation

`resolveReminderTarget` reads the tenant contact with **no try/catch**:

```
app/src/jobs/tourReminders.ts:646
  const contact = await deps.contactsRepo.getById(tour.tenantId);
```

A thrown read propagates out of `resolveReminderTarget`, out of
`processReminderRow`, and lands in the per-row catch at
`app/src/jobs/tourReminders.ts:490-497` (`log.error(... 'unexpected error
processing row')`). So **today, already**: nothing sends, `sentAt` is unset,
`skippedAt` is unset.

The plan's first test asserts exactly those three things
(`plan:546-549`). It is green on `main`. Step 2 - "Run and watch them fail" -
will not fail.

Two bad outcomes, both likely: the builder concludes the semantics already exist
and writes no code, leaving `failed` dead (**the precise defect finding B4 was
raised to fix, re-created by its own fix**); or they thrash trying to make a
passing test fail.

Three further problems in the same test block:

- `tourRig(...)` does not exist. The file's helper is `createGroupTestRig()`
  (`app/test/tourReminders.test.ts:832, 887, 942, 989, 1033, 1590, 1666, 1710,
  1753, 1797`).
- On a `landlord_led`/`pm_team` tour, `resolveReminderTarget` takes the GROUP
  route at `:639-643` and **never reads the tenant contact at all**. The group
  path's name resolution is a genuinely new read, and the plan's fixture cannot
  reach its failure mode.
- The READ-path test (`plan:558-561`) is written as `await request(app).get(...)
  ...;` with a literal ellipsis. It is a sketch, not code.

**What the test should pin instead:** that the *name resolution* failure - not
any contacts failure - leaves the rung unclaimed, distinguished from the
absence path which must still send. That requires failing `resolveTourContactNames`
specifically, which means the fixture has to fail the UNIT read or fail the
contact read only on the property-contact id.

---

## HIGH

### 4. `tourType` threading through the e2e `TourReminderContext` is owned by no task, and the property-contact name is never mentioned

`e2e/scenarios/steps.ts:139-143`:

```ts
export interface TourReminderContext {
  scheduledAt: string;
  timezone: string;
  address?: string;
}
```

`tourReminderBody(kind, ctx)` (`:172-179`) calls the composer. Task 4 makes
`tourType` REQUIRED, so this interface and `tourReminderContext(unit, times)`
(`:164`) must both grow a `tourType`. **Task 4 Step 5 says only "update the five
call sites"; Task 11 Step 5 mentions only "the SEEDED tenant's first name."**
Neither says `tourType`.

This is not cosmetic. `expectReminderInGroup` (`:1933`) is used only for
`landlord_led`/`pm_team` tours and `expectReminderTo1to1` (`:1974`) for
`self_guided`. If the context carries a default or the wrong tour type, an
`en_route` expectation composes the wrong variant and the assertion fails with a
body-mismatch that looks like a copy bug.

Equally missing: `en_route_landlord_led` interpolates
`{propertyContactFirstName}`. The e2e expectation must therefore carry the
seeded **landlord/PM's** first name too. Task 11 Step 5 names only the tenant.

### 5. Spec section 12 contradicts the amended section 7.3

`docs/superpowers/specs/...-design.md:415-418` still reads:

> 1. Whether to exempt `en_route` from quiet hours... **The hook is built here
>    but stays empty**; enabling it is section 7.3's two sites.

Section 7.3 (`:236-243`) now says the hook is CUT and NOT built. A builder
reading section 12 will look for the hook, not find it, and either build it
(violating the cut) or file a bug. This is the coordinator's own standing
question 3, confirmed unfixed.

### 6. Nothing is FILED for the deferred hook

Task 12 stamps two issues **resolved** and files nothing for the thing being
deferred. Per `AGENTS.md` ("Issue, TODO, and known-problem tracking"), a
cross-cutting deferral is a tier-2 `docs/issues/<slug>.md` or at minimum a
tier-1 `TODO(<issue-slug>):` marker at the two sites.

As it stands the only record that an 8-9am tour gets **no reminder at all**
(spec 7.2) and that a fix was designed and deferred lives in a dated spec
section. There is no marker at `app/src/jobs/tourReminders.ts:250` or `:729`,
which is where the next person will be standing.

### 7. `documentation/tours-sequence-writeup.md` states the ladder verbatim and no task touches `documentation/`

`documentation/tours-sequence-writeup.md:110-119`:

```
| `confirmation` | immediately, at booking | "Your tour is confirmed." |
| `day_before`   | 24h before              | day-before reminder |
| `morning_of`   | 08:00 UTC on the tour day | morning-of reminder |
...are skipped (except `confirmation`, which is ...)
```

Every row is falsified by this change; line 112 is *already* stale (it has been
08:00 org-local since the quiet-hours change). No task in the plan modifies
anything under `documentation/`.

### 8. An existing test HARD-GATES the segment count that Task 12 treats as a measurement

`app/test/tourCopy.test.ts:109-118`:

```ts
for (const kind of ['confirmation', 'day_before', 'morning_of', 'en_route'] as const) {
  const body = composeTourReminderBody({ ...base, kind, address: '350 Boulevard SE, Atlanta, GA 30312' });
  expect(body).not.toMatch(NON_ASCII);
  expect(analyzeSms(body).segments).toBe(1);
}
```

Spec section 5 says to "state the **accepted** segment count per rung in the
handback"; Task 12 Step 8 says "Measure ... and report the number." **There is
no accepting a 2-segment `morning_of`** - this assertion fails the build.

I counted the new `tour.morning_of` at 141 GSM-7 characters with a 5-character
first name and that address, leaving **19 characters of headroom** before the
160-character single-segment boundary. That is real but thin: a 24-character
first name trips it. The gate is Task 4 Step 7, not Task 12 Step 8, and nobody
says so - so a builder who trips it will most plausibly "fix" it by relaxing
`toBe(1)`.

Note also this loop needs `tourType` added (Task 4 owns the file, so it will be
touched - but the plan's Task 4 Step 1 describes only ADDING tests).

---

## Contesting the adjudications

### 9. The exemption-hook CUT: reachability claim VERIFIED, justification OVERSTATED

**The claim checks out.** `processReminderRow` is called from exactly one place:

```
app/src/jobs/tourReminders.ts:489   await processReminderRow(row, now, window, dueRows, deps, log);
```

inside `runDueTourReminders`, downstream of the manual-only filter:

```
app/src/jobs/tourReminders.ts:470-478
  const manualOnly = deps.manualOnlyKinds ?? MANUAL_ONLY_REMINDER_KINDS;
  const dueRows = allDueRows.filter((r) => !manualOnly.has(r.kind));
  ...
  if (dueRows.length === 0) return;
```

`forceSendReminder` (`:1156`) is a separate function and does **not** call
`processReminderRow`. With all four auto-armed kinds in
`MANUAL_ONLY_REMINDER_KINDS` (`:163-168`), `dueRows` is always empty in
production and the `isQuietTime` backstop at `:729` is unreachable. **Confirmed.**

**But the recorded justification is over-broad, in a way that matters.** The
hook has two sites. Site 2 is unreachable. **Site 1 - the arm-time clamp at
`:250` - is fully reachable in production today**, because arming is unaffected
by the pause: `armTourReminders` is called on every booking
(`app/src/routes/tours.ts:350`) and every reschedule (`:1178`) regardless of
`MANUAL_ONLY_REMINDER_KINDS`. So "untestable, unreachable" is true of one site
and false of the other.

**Was the cut right?** On balance yes, and for a reason the adjudication does
not give: an arm-time-only exemption is not merely inert, it is *actively
misleading* - it would write an unclamped 07:00 dueAt that the panel presents as
the real send time while nothing can fire it. Half the hook is worse than none.
That is a better argument than "unreachable" and it survives the site-1
correction.

**What the cut is not:** free. It makes spec 7.2 ("for an 8am tour... both born
SKIPPED") permanent in Phase A with no in-code marker - see finding 6. Record
the cut properly and it is fine; record it as "unreachable" and the next reader
will re-derive site 1 and reopen the question.

### 10. One accept I think was too generous: my own round-1 M3

I raised that Task 3's token rule over-applied `where` to
`tour.confirmation_no_address`. The planner accepted and excluded BOTH twins
(plan Task 4, `:279-281`), plus added an assertion. That is right.

But the accept propagated a **wrong premise of mine**: I described it as
"harmless at runtime." It is harmless *given the current composer*, because
`idFor` only selects a `_no_address` id when `street.length === 0`, so `where`
is never passed. The assertion the planner added
(`expect(...vars).not.toContain('where')`) pins the *declaration*, not the
*behavior*. If a future edit reintroduces `{where}` into the
`confirmation_no_address` template, the ASCII/dead-token guards will not catch
it and the new assertion will fail with a message about declarations rather than
about leaking an address. Low consequence, but the test's name ("the leak
guard") over-claims what it guards.

---

## MEDIUM

### 11. Rule-1 precedence inside the arm loop is under-specified

Task 7 says only "evaluated BEFORE the existing past-dueAt branch at `:266`."
Precedence against the two other `day_before`-reachable retirements is
undefined:

- `past_event` at `:270` (`dueAt >= scheduledIso`) - tests the **clamped** value
- `staleDayBefore` at `:294-295` - tests the **clamped** value

Rule 1 tests the **raw** value. Two builders placing the branch differently (top
of loop vs. immediately above `:266`) produce different `skipReason`s for the
same row under a non-default `quietHoursStart`. At the default 21:00-08:00 the
cases do not collide, so **no test in the plan distinguishes them** - the
ambiguity ships silently and surfaces on the first org that changes the setting.

State the precedence explicitly: `booked_too_late` > `past_event` >
`quiet_hours_superseded`, or whichever is intended.

### 12. `booked_too_late` makes near-term ladders LONGER, and Task 10's guidance is directionally silent

Previously a past-dueAt `day_before` wrote **no row** (`:266-269`, bare
`continue`). Spec 8.1 changes it to a **visible** row. So short-notice bookings
gain a row rather than losing one.

`app/test/tourRemindersApi.test.ts:237` asserts an exact ordered array:
`expect(reminders.map(r => r.kind)).toEqual(['confirmation','day_before','morning_of'])`.
Task 10 Step 3 says only "the new skip rules **may** legitimately change it -
re-derive rather than force a number." A builder re-deriving needs to know the
count can go **up**, which is the counter-intuitive direction.

### 13. Task 4's composer sketch omits the line most likely to be wrong

The sketch (`plan:318-327`) shows `nameVars` and the `no_show_checkin` early
return, then stops. It never shows the final call, which must merge:

```ts
resolveMessage(id, { ...nameVars, when: `${date} at ${time}`, time,
                     ...(street.length > 0 && { where: street }) }, overrides)
```

Today's line is `tourCopy.ts:71-75` and passes no name vars. Omit the spread and
**every** entry whose default uses `{tenantFirstName}` throws in strict mode
(`app/src/messages/resolve.ts:36-38`). Self-catching via the Task 4 tests, so
MEDIUM not HIGH - but it is the one line the sketch leaves to inference.

### 14. Task 4 Step 1 says "include ... PLUS these two" - it never says to DELETE the old assertions

`app/test/tourCopy.test.ts` currently pins the OLD copy verbatim at `:23-25`
(`'Hey, your tour is set for Thu, Jul 23 at 3:00 PM at 412 Oak St Apt 2.'`),
`:28-31`, `:34+`, `:42`, `:47`, `:54-60`. Task 4 Step 7 expects that file to
PASS. A builder who only ADDS tests, as Step 1 literally instructs, gets a red
suite full of old-copy failures and no instruction covering them.

### 15. `shiftLocalDate` throws the wrong error class on a malformed-but-present component

`plan:167-171`: `'2026-ab-23'.split('-').map(Number)` yields `[2026, NaN, 23]`.
`NaN !== undefined`, so the guard passes; `Date.UTC(2026, NaN, 23)` is `NaN` and
`new Date(NaN).toISOString()` throws a raw `RangeError`, not the intended
`shiftLocalDate: unparseable local date` error. Only reachable from
`localDateOf` output today (`app/src/lib/quietHours.ts:122`), which is
well-formed, so the consequence is a confusing stack trace in a future misuse.
Add `Number.isFinite` to the guard.

---

## Verified clean - recorded so nobody re-raises them

- **Task 2 `shiftLocalDate` arithmetic is CORRECT** on all four plan cases.
  `Date.UTC(2028, 2, 0)` -> 2028-02-29 (2028 is a leap year); `Date.UTC(2026, 0, 0)`
  -> 2025-12-31; `Date.UTC(2026, 7, 0)` -> 2026-07-31. `app/test/localTime.test.ts`
  exists, so "Modify" is the right verb. Note `localDateOf`/`instantAtLocalTime`
  live in `quietHours.ts`, not `localTime.ts`, so Task 6 Step 4 imports from two
  modules and `jobs/tourReminders.ts` gains its first `localTime.js` import -
  fine, just unremarked.
- **Task 4's exhaustive `idFor` switch will compile without a trailing return.**
  Proven by precedent in the same file: `computeDueAt`
  (`app/src/jobs/tourReminders.ts:96-117`) is a 5-case switch over the same
  `ReminderKind` union with return type `string` and no trailing return.
- **Task 7's concrete instants are ARITHMETICALLY CORRECT.** Tour
  `2026-07-23T19:00Z` = Thu Jul 23 15:00 EDT. `day_before` raw = 19:30 EDT Jul 22
  = `2026-07-22T23:30:00.000Z`; minus the 4h lead = `2026-07-22T19:30:00.000Z`
  (= 15:30 EDT), matching the plan's comment. Rule 2 cutoff = 19:00Z - 6h =
  `2026-07-23T13:00:00.000Z`. Both strict-`>` framings are right, and
  `localDateOf('2026-07-23T13:00Z','America/New_York')` = `2026-07-23`, so the
  `sameDay` guard resolves correctly.
- **Spec section 5 copy is byte-verified pure ASCII** (no U+2019 apostrophes) -
  I checked every character of spec lines 95-103 programmatically. So
  `app/test/messageCatalogAscii.test.ts` will pass on a verbatim transcription.
  Flagging only that this guard exists and appears in **no** task list and in no
  spec section 13 list; a curly apostrophe pasted from any other source would
  fail it with a clear message.
- **No event or activity surface carries reminder skip reasons.**
  `app/src/lib/events.ts:275`'s `skipReason` belongs to aiRuns, not tours. Clean.
- **`RemindersPanel.tsx:103` already degrades safely** on an unknown skip reason:
  `rung.skipReason !== undefined ? REMINDER_SKIP_REASON_LABELS[rung.skipReason] : undefined`,
  then `reason !== undefined ? \`Skipped - ${reason}\` : 'Skipped'`. A newer
  server sending `booked_too_late` to an older cached bundle renders "Skipped",
  not a crash. No finding.
- **Seed profiles survive Task 9.** `app/src/lib/seed/cast.ts:771-789` and
  `app/src/lib/seed/matrix.ts:976` create `confirmation` rows **directly** via
  seed items, not via `armTourReminders`, and the kind stays legal everywhere.
  `app/src/lib/seed/lean.ts:108, 136, 165` gives contacts real `firstName`s, so
  e2e bodies greet by name rather than "there".
- **The composer call-site enumeration remains complete** (re-grepped): four in
  `app/src`, one in `e2e/scenarios/steps.ts`, plus the no-show draft bypass.
- **Task 4's `tourType`-required decision is right** and its stated reason
  (a default silently gives a landlord-led tour self-guided wording) is the
  correct one.

---

## Does a context-free builder produce the spec?

Walking each spec decision to its task: **no**, in four places.

| Spec | Delivered by | Verdict |
| --- | --- | --- |
| 5 copy | Task 4 | Yes |
| 6 / 6.1 / 6.2 tokens, resolver, helper | Tasks 1, 3, 4 | Yes |
| 6.3 absence | Tasks 3, 4 | Yes |
| 6.3 **read FAILURE** | Task 8 | **No** - the red state is not red (finding 3); a builder may write nothing |
| 6.4 no-declare | Task 4 Step 1 | Yes (assertion over-claims, finding 10) |
| 7 timing | Tasks 2, 6 | Yes |
| 7.1 warn | Task 7 Step 4 | Yes |
| 7.2 8am tours retire | (consequence) | Stated in spec, **no marker in code** (finding 6) |
| 7.3 hook | CUT | Cut is defensible; spec 12 contradicts it (finding 5) |
| 8 skip rules | Task 7 | Yes, but precedence undefined (finding 11) |
| 8.1 visible rows | Task 7 Step 3 | Yes |
| 8.2 new reason | Task 5 | Yes |
| 9 restructure / 9.1 matrix | Task 4 | Yes |
| 9.2 both throw sites | Task 4 Step 5 | Yes |
| 9.3 in-flight rows | Task 12 Step 9 | Yes (handback only, by design) |
| 9.4 dead comment | Task 9 | Yes |
| 10 batching | Task 8 Step 4 | Partially - "Assert the read count in a test" with no fixture named |
| 11 relabel | Tasks 10, 11 | Yes |
| 13 e2e marker invariant | Task 11 Step 3 | Yes |
| 13 seeded-name coupling | Task 11 Step 5 | **Partially** - tenant only; `tourType` and property-contact name missing (finding 4) |
| 14 gates | Task 12 | Yes |

Plus the two whole surfaces no spec section or task covers: the e2e
`confirmation` dependency (finding 1) and the app-suite `confirmation`
dependency (finding 2).

### Untestable steps

- **Task 8 Step 2** - red state is green (finding 3). The headline instance.
- **Task 8 Step 4** - "Assert the read count in a test" names no rig, no
  counter, and no target number. `contactTimeline`'s Upcoming bucket walks three
  parallel index-backed walks (`app/src/routes/contactTimeline.ts:744+`); a
  builder has to invent both the instrumentation and the expected value, which
  means the assertion will encode whatever they built rather than what the spec
  wanted.
- **Task 9 Step 1** - "arming creates no `confirmation` row" is genuinely red
  and genuinely green afterward. Sound. It is the ~55 sites it breaks that are
  the problem, not the test.
- **Task 12 Step 8** - "measure and report" is not a gate; the real gate already
  exists and is stricter (finding 8).

### Ordering and false independence

The rewritten header wisely dropped the round-1 claim that every task is green
on its own. But the actual sequencing hazard is now this: **Tasks 9 and 10 do
not run e2e, and Task 11 - which does - is not scoped to own the breakage Task 9
caused.** So the suite is red from the end of Task 9 through Task 11 Step 6, and
the person who has to diagnose it is the one task that was told its job was the
`timesFor` mirror. Either fold the `confirmation` e2e repair into Task 9 (my
preference - it is that task's blast radius) or restate Task 11's scope to
include it explicitly.

Second: Task 7 introduces `booked_too_late` rows that change ladder counts; Task
10 re-baselines counts; Task 11 then reworks e2e specs that assert on ladder
contents. A count that Task 10 re-derives can be re-invalidated by Task 11's
choice of which rung to tick. Sequencing Task 11 before Task 10 would avoid it,
or Task 10 should re-run after Task 11.
