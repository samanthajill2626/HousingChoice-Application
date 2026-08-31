# Independent adversarial review - feat/tour-reminder-ladder @85e78de8

Reviewer: independent, read-only, deliberately PLAN-BLIND and SPEC-BLIND. I read
no file under `docs/superpowers/plans/`, `docs/superpowers/specs/`,
`docs/superpowers/reviews/` or `.superpowers/`. I read `docs/issues/` only to
avoid re-filing what the branch already filed, and I say so where that changed a
severity.

Scope swept: `git diff main...HEAD -- app/ dashboard/ e2e/` plus the surrounding
code for every touched surface - `messages/tourCopy.ts`, `messages/catalog.ts`,
`messages/resolve.ts` (unchanged, but every tour message now flows through it),
`lib/tourContacts.ts`, `lib/localTime.ts`, `lib/quietHours.ts`,
`jobs/tourReminders.ts`, `routes/tourReminders.ts`, `routes/contactTimeline.ts`,
`routes/relayGroups.ts`, `routes/tours.ts`, `repos/tourRemindersRepo.ts`,
`lib/seed/{cast,live,matrix}.ts`, the dashboard panel/card/types, and the e2e
harness. I ran no test suite (the coordinator owns the gates).

One piece of context that scales every send-path severity below:
`MANUAL_ONLY_REMINDER_KINDS` (`app/src/jobs/tourReminders.ts:201-206`) contains
ALL FOUR auto-armed kinds, so in production the poll sends nothing today. What
this branch actually ships to a live operator is (a) the armed dueAt values,
(b) the panel's rendering of them, and (c) the hand-send paths. I weighted
findings accordingly - which makes the panel-noise finding the most important
one here, not the send-path ones.

---

## Findings

### 1. medium - `booked_too_late` rows accumulate without bound across re-arms, so a rescheduled same-day tour grows a wall of duplicate "Skipped - booked too late" rows

`armTourReminders` writes a NEW row per kind on every arm
(`app/src/jobs/tourReminders.ts:376`, `:398`, `:422`, `:435`) and never dedupes
against existing rows. The only cleanup on re-arm is `cancelTourReminders`, and
`cancelForTour`'s contract is explicitly "cancel all PENDING (not yet sent,
canceled, or skipped)" (`app/src/repos/tourRemindersRepo.ts:160`) - it cannot
touch a row born skipped. `routes/tours.ts:1176-1181` calls cancel-then-arm on
every reschedule AND on every status-only move into `scheduled`
(`rearmTrigger` at `routes/tours.ts:1172`). `listByTour`
(`app/src/repos/tourRemindersRepo.ts:199-209`) returns every row, and
`RemindersPanel` renders one `<li>` per row with no grouping
(`dashboard/src/routes/tours/RemindersPanel.tsx:310+`).

CONCRETE FAILURE SCENARIO. Org tz America/New_York, default quiet hours.
09:00 EDT: a navigator books a tour for 15:00 EDT the same day. Arm writes
`day_before` (booked_too_late), `morning_of` (booked_too_late), `confirmation`
(pending), `en_route` (pending) - 4 rows, 2 of them skipped. 09:20: the landlord
moves it to 16:00. `cancelForTour` cancels the two pending rows; the two skipped
rows are untouched; the fresh arm writes another `day_before`
(booked_too_late) and another `morning_of` (booked_too_late) plus two pending.
The Reminders panel now shows EIGHT rows for a four-rung ladder, four of them
reading "Skipped - booked too late for this reminder", two of them "Canceled".
A third reschedule takes it to twelve. None of the skipped rows carries a Send
now button (the panel gates that on `state === 'upcoming'`), so the operator
cannot act on any of them - they are pure noise on the surface this whole
feature exists to make honest.

This is not purely pre-existing. On `main` the same reschedule wrote ZERO extra
rows, because a same-day booking's `day_before`/`morning_of` were dropped by the
silent past-dueAt branch. Turning that silent drop into a visible row is the
right call in isolation; doing it without an idempotency rule at the arm site is
what produces the wall. `past_event` had the same shape but was rare;
`booked_too_late` fires on every same-day booking, which is the founder's normal
case.

TEST BLIND SPOT that let this through: the new re-arm tests build their
assertion set with `skippedByKind` (`app/test/toursApi.test.ts:1246`), which is
`Object.fromEntries(... .map(r => [r.kind, r]))`. That collapses N rows of one
kind to 1 by construction, so cases 7a and 7b at `:1314` and `:1348` are
STRUCTURALLY incapable of seeing a duplicate no matter how many arms run. Both
tests happen to arm cleanly the first time, so the stacking case is never
reached either.

Fix shapes (not my call which): make `create` conditional on
`(tourId, kind, birth-skipped)` absence, or have the arm delete/replace prior
arm-time skip rows for the same kind, or have the panel collapse consecutive
same-kind terminal rows. Any of them is a design decision, which is why I am not
calling this blocking - but it should be a deliberate accept, not a discovery.

### 2. medium - the retimed `morning_of` copy says "today" for a tour it can fire the day BEFORE

`computeDueAt` now returns `scheduledAt - 4h` for `morning_of`
(`app/src/jobs/tourReminders.ts:144`), while the copy is
`"Hey {tenantFirstName}, looking forward to having you tour at {time} today. ..."`
(`app/src/messages/catalog.ts:157`). The old anchor was 08:00 ORG-LOCAL on the
tour's own local day, which made "today" true by construction. A pure -4h offset
does not: for any tour whose org-local start is between 00:00 and 03:59, T-4h
lands on the PREVIOUS local date.

CONCRETE FAILURE SCENARIO. Org tz America/New_York, quiet hours DISABLED (a
supported configuration - `quietHoursEnabled` is a real setting and the lean
e2e seed ships it off). A tour is booked three days out for Tue 02:00 EDT.
`morning_of` raw = Mon 22:00 EDT; no quiet window to clamp it; it is well ahead
of `now` and well before the tour start, so it arms and (on unpause, or via a
hand-send from the panel preview) composes: "Hey Alice, looking forward to
having you tour at 2:00 AM today. Does that still work for you?" - sent at 10pm
Monday about a Tuesday tour. The panel preview shows the same false sentence
today, with the ladder paused.

The default 21:00-08:00 window MASKS this: raw Mon 22:00 is inside the window,
clamps to Tue 08:00, which is `>= scheduledIso`, so the rung becomes a
`past_event` row and never sends. That is luck, not a guard - it depends
entirely on the org's quiet-hours setting, which the code elsewhere is careful
to say must not be constrained by one rung
(`app/src/jobs/tourReminders.ts:305-312`).

`day_before` has no equivalent problem: 19:30 on the shifted local date is
always the calendar day before, so "tomorrow" is always true. The defect is
specific to `morning_of` losing its local-day anchor.

### 3. low - the `morning_of` booked-too-late rule's same-local-date guard defeats its own stated purpose across local midnight

`app/src/jobs/tourReminders.ts:373` gates rule 2 on
`localDateOf(now, window.timezone) === tourLocalDate`. The comment above the
branch (`:346-352`) states the rule exists so "the MOST-late booking ... is
the one that would otherwise vanish without a trace". For a tour in the small
hours, the latest possible booking is on the PREVIOUS local date, and the guard
turns the rule off exactly there.

CONCRETE FAILURE SCENARIO. Org tz America/New_York, quiet hours disabled. Tour
Tue 01:00 EDT. Booked Mon 22:00 EDT (3 hours of notice - the most-late case).
`morning_of` raw = Mon 21:00 EDT, already behind `now`. Rule 2 does not fire
(`localDateOf(now)` = Mon, `tourLocalDate` = Tue). Execution falls to
`if (dueAt < now)` at `:390` - the silent drop - and the row is never created.
The operator gets a ladder with a gap and no explanation, which is the precise
outcome section 8 was written to eliminate.

With default quiet hours the clamp pushes the same rung past the tour start and
it becomes a visible `past_event` row instead, so this is masked in the default
config. `app/test/tourReminders.test.ts` case 6 (`:1462`) covers the adjacent boundary
(`raw === now`, which survives) but not `raw < now`.

### 4. low - the booked-too-late predicate compares `now` lexicographically against a canonicalized ISO string, so a caller-injected non-canonical `now` inverts the rule

`app/src/jobs/tourReminders.ts:368-374` does
`now > new Date(...).toISOString()` twice. `toISOString()` always emits
`...:SS.sssZ`; `now` is whatever the caller passed. `armTourReminders`'s
production callers default to `new Date().toISOString()`
(`app/src/routes/tours.ts:251`), but `deps.now` is injectable and nothing
normalizes it at the boundary.

CONCRETE FAILURE SCENARIO. A caller (a future dev/admin route, a backfill
script, a test fixture) passes `now = '2026-07-22T19:29:00Z'` - one minute
BEFORE the cutoff, but ms-less. Compared against `'2026-07-22T19:30:00.000Z'`,
the strings diverge at index 17 (`2` vs `3`), so this one is fine; but pass
`now = '2026-07-22T19:30:00Z'` and the comparison diverges at index 19, where
`'Z'` (0x5A) beats `'.'` (0x2E), so `now > cutoff` is TRUE and the rung is
retired as booked_too_late at the exact instant the test at
`app/test/tourReminders.test.ts:1397` ("EXACTLY on the cutoff still arms")
asserts it must arm.

The pattern is pre-existing (`dueAt < now` at `:390` has the same dependency)
and the dev tick route normalizes its input, so I am not calling this more than
low. But the branch adds two more string comparisons against an
externally-supplied instant, and the cheap fix -
`const nowIso = new Date(now).toISOString()` once at the top of
`armTourReminders` - is one line.

### 5. low - unbounded unclaimed re-list on `ReminderNamesUnavailableError` (already filed; confirming independently)

Both send routes return without claiming when name resolution throws
(`app/src/jobs/tourReminders.ts:1037` for the 1:1 path,
`:1210` for the group path). A permanently failing contacts or units read
therefore re-lists the rung on every tick forever, never sent and never visibly
skipped. Its structural twin two screens above - the `roster_unavailable`
gate - was deliberately BOUNDED for exactly this reason
(`app/src/jobs/tourReminders.ts:984`), so the new code sits next to the
precedent it does not follow.

I found this independently and then checked `docs/issues/` before filing:
`docs/issues/tour-reminder-ladder-phase-b.md` item 7 describes it accurately,
names the `roster_unavailable` precedent, and ties the acceptance to the pause.
I agree with that framing and with the deferral. Recording it here only so this
review is not read as having missed it. Reachable in production only after the
manual-only filter is lifted.

### 6. low - the `morning_of` relabel to "4 hours before" is false for every in-flight row

`dashboard/src/api/types.ts:1251` relabels the kind to "4 hours before". Nothing
re-arms rows created before the retiming
(`docs/issues/tour-reminder-ladder-phase-b.md` item 6 confirms this and accepts
it for the timing), so a row armed last week still has
`dueAt = 08:00 org-local on tour day`.

CONCRETE FAILURE SCENARIO. A tour booked 2026-08-25 for 15:00 EDT on
2026-09-02 has a stored `morning_of` row at `2026-09-02T12:00:00.000Z`. After
this deploy the panel renders that row as `4 hours before ... sends in 7h`. The
label and the chip contradict each other on the same line, for one booking
horizon. Phase B item 6 anticipates the TIMING surprise but not the LABEL
contradiction, so nobody is currently primed for the support question.

### 7. low - `forceSendReminder`'s blanket catch turns a permanent bug into a "please try again"

`app/src/jobs/tourReminders.ts:1400-1408` wraps
`resolveReminderTarget` in a catch that maps ANY throw to
`refused: 'names_unavailable'`, whose operator copy is
"...so nothing was sent - please try again."
(`dashboard/src/api/types.ts:1317-1318`). The intent (never 500 a hand send) is
right, and it logs `err`. But a non-transient throw - a `TypeError` from a
future refactor, a permanently unmarshallable contact row - now presents to the
navigator as a transient, and they will retry indefinitely with no signal that
retrying is pointless. Diagnosable from logs; invisible from the UI.

### 8. low - stale premise in the comment that justifies the gate/compose ordering

`app/src/jobs/tourReminders.ts:1011` still reads "composing is PURE (a unit read
+ composeTourReminderBody, which does no I/O)". After this branch,
`composeBodyForRow` performs a unit read plus up to two contact reads
(`:694-726`). The ordering CONCLUSION it defends is still correct, but the
premise a future reader will lean on is now false - and the whole point of that
paragraph is to stop someone re-deriving the order from scratch.

### 9. low - "Preview unavailable" can appear on a rung that genuinely sent

`bodyFor` returns the `sentBody` snapshot only when one exists
(`app/src/routes/tourReminders.ts:285`); a sent row WITHOUT a snapshot falls
through to the withhold check and can return `''`, which the panel now renders
as "Preview unavailable - this message cannot be composed right now."
(`dashboard/src/routes/tours/RemindersPanel.tsx:383-386`). Rows with no snapshot
are not hypothetical: `app/src/lib/seed/cast.ts:774-779` states outright that
seeds write NO `sentBody`, and legacy pre-snapshot rows exist by the same
argument the snapshot field's docblock makes
(`app/src/repos/tourRemindersRepo.ts:130-135`).

CONCRETE FAILURE SCENARIO. During a contacts-table outage, a navigator opens a
demo/seeded tour whose `morning_of` rung sent months ago. The row shows
"Preview unavailable" under a "Sent" chip, implying something is wrong with a
message that already went out. Cosmetic, narrow, and only during an outage.

---

## Surfaces I checked and found clean

Recording these so the next reviewer does not re-walk them.

- **Token re-expansion through `interpolate()`.** Real vector, correctly closed
  at the right layer. `inertName` (`app/src/lib/tourContacts.ts:79-81`) strips
  braces from every name before it can reach `resolveMessage`, and the
  substitution ORDER in `TOUR_NAME_VARS` (`app/src/messages/catalog.ts:100-103`)
  puts `when`/`time` ahead of the names and `where`/`addressLine` behind them,
  so the unsanitized address cannot be re-expanded either. I verified the claim
  by hand against `interpolate`'s loop (`app/src/messages/resolve.ts:31-43`) for
  every one of the six tour entries. The unauthenticated
  `POST /public/housing-fair` `firstName` path the docblock cites is a genuine
  reachable source, so this was worth closing.
- **Every composer call site.** Exactly six in app code plus the e2e harness
  (`grep composeTourReminderBody`), all updated to pass `tourType` and `names`;
  no surviving `resolveMessage('tour.*')` call anywhere, so the newly-declared
  `{tenantFirstName}` cannot hit the strict-mode throw from a missed site.
- **Every reader/writer of `ReminderSkipReason`.** New member is carried into
  the dashboard union, the label map, and a test
  (`dashboard/src/api/types.test.ts:97-127`) that deliberately hand-duplicates
  the app union as plain strings to catch the one drift direction the `Record`
  type cannot. `claimSkip` is correctly documented as never taking the arm-only
  reason.
- **DST and calendar arithmetic.** `shiftLocalDate`
  (`app/src/lib/localTime.ts:69-77`) is pure UTC string arithmetic and cannot
  drift; `instantAtLocalTime`'s two-pass convergence handles the transition; the
  spring-forward assertions at `app/test/computeDueAt.test.ts:25-34` are correct
  (2026-03-08 IS the US transition date) and would catch a fixed-offset
  regression.
- **Ladder chronological order vs `LADDER_ORDER`.** I checked whether the
  retiming could invert the ladder and break `supersededBySlot` / release
  supersession. It cannot: 19:30 on D-1 precedes T-4h for every tour time of
  day, including tours after local midnight.
- **PII in logs.** Clean. `resolveTourContactNames` logs `tenantId` /
  `unitId` / `propertyContactId` only; `ReminderNamesUnavailableError`'s message
  carries `tourId` and `kind`; no composed body reaches a log line or the audit
  payload (`app/src/routes/tourReminders.ts:454-458`).
- **Failure vs absence.** Genuinely distinguished, and the distinction is
  DERIVED from the catalog rather than hand-mirrored
  (`reminderNamesUsed` / `assessNamesReadFailure`,
  `app/src/messages/tourCopy.ts:176-263`). The tripwire test at
  `app/test/tourCopy.test.ts:241` pins the invariant that makes the dead
  `tokenBlanked` disjunct safe. This is the strongest part of the branch.
- **The contact-timeline `namesOnce` memo keyed on `unitId` only** while the
  assessor also takes `tourType` - the caveat is documented at
  `app/src/routes/contactTimeline.ts:936-943` and the reasoning holds today
  (the resolver does not branch on tour type; the assessor is called per tour).
- **The `createFakeWorld` fix** at
  `app/test/helpers/twilioWebhookHarness.ts:2929-2939` is a real catch: the fake
  repo was silently dropping `input.skipped`, which made every arm-time skip row
  look like a live rung to every route-level suite. Worth flagging as a positive
  because it means route tests written before this branch were reading a
  fictional world.
- **Test quality generally is high.** `app/test/tourReminders.test.ts`
  case 3 (`:1407`) is a genuine ORDERING discriminator - it fails if the
  booked-too-late branch is moved below the past-dueAt drop - and case 9
  (`:1527`) exists specifically to keep the silent branch covered after every
  other assertion of it inverted. Case 8's negative control at `:1509` reasons
  explicitly about why the obvious control would be vacuous. The
  `assertion-cannot-pass-by-reading-the-wrong-field` construction in
  `dashboard/src/routes/tours/TourDetail.test.tsx:627-648` (code and message set
  to the same string, deliberately) is the right instinct.

## Biggest worry

Not any single defect - it is that the arm path grew a third row-producing rule
without ever growing an idempotency rule, and the tests that cover the new rule
were written with an accessor (`skippedByKind`) that cannot observe the
duplication. The branch is meticulous about what a row MEANS and careless about
how many of them there are. With the ladder paused, the panel IS the product,
and a same-day tour rescheduled twice turns the panel into eight rows the
operator cannot act on. That is the shape of thing this repo's own history says
gets found in production rather than in review.

Second on the list is finding 2 - a message that says "today" about tomorrow is
the kind of copy defect that is embarrassing rather than expensive, and it is
alive only because a quiet-hours default happens to swallow it.

## Would you merge this?

Yes, with one condition and one follow-up.

The condition: make a CONSCIOUS decision about finding 1 before merge, and if
the decision is "accept for now", file it as an issue with the reschedule
scenario written out - do not let it ride on the belief that the case-7 tests
cover it, because they cannot. A one-line fix is also available (drop the
duplicate at `create` time, or filter same-kind arm-time skip rows in the panel
projection).

The follow-up: finding 2 should be fixed or explicitly accepted by whoever owns
the copy, since it is a wrong statement of fact in a tenant-facing SMS. It is
not merge-blocking while the ladder is paused, but it must not survive the
unpause.

Everything else on the list is low, several of the lows are already filed by the
branch itself, and the engineering quality of the failure-semantics work is
above the bar - the catalog-derived `assessNamesReadFailure` with its tripwire
test is the right answer to a problem most branches would have hand-mirrored and
desynced within a month.
