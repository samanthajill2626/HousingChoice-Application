# Slice S8 report - Task 9: the e2e ladder mirror and the quiet-hours timing-contract rework

Branch `feat/tour-reminder-ladder`, worktree `W:\tmp\tour-reminder-ladder`.
Base commit at slice start: `7cbbe7d3` (clean, no `MERGE_HEAD`).
Commit produced: **`0f30c9b5`** - 6 files, +270 / -70, ONE commit.

Scope delivered: the plan's Task 9, Steps 1 through 5 and 7, complete, plus
worklist items A9-1 through A9-7. Step 6's FULL `npm run e2e` gate was reserved
for the parent per the mission block; targeted runs over every affected spec are
quoted in section 8 below.

---

## 1. `TourTimes` - before and after (Step 1)

BEFORE (`e2e/scenarios/steps.ts`):

```ts
export interface TourTimes {
  /** The raw datetime-local value the Book/Reschedule forms send ('YYYY-MM-DDTHH:mm'). */
  scheduledAtLocal: string;
  /** dueAt of each pre-computed rung, full-ms ISO - feed `justAfter(x)` to the tick. */
  dayBefore: string;
  enRoute: string;
  noShowCheckin: string;
}
```

AFTER:

```ts
export interface TourTimes {
  /** The raw datetime-local value the Book/Reschedule forms send ('YYYY-MM-DDTHH:mm'). */
  scheduledAtLocal: string;
  /** dueAt of each pre-computed rung, full-ms ISO - feed `justAfter(x)` to the tick.
   *  `day_before` is NOT here: since the 2026-08-26 retiming it fires at 19:30
   *  ORG-LOCAL, which no host-local helper can compute - read it back from the
   *  server with `Scenario.armedReminderDueAt('day_before')` instead. */
  morningOf: string;
  enRoute: string;
  noShowCheckin: string;
}
```

`timesFor` BEFORE / AFTER (the mirrored line only):

```ts
-    dayBefore: new Date(t - 24 * 3_600_000).toISOString(),
+    // FOUR hours before (founder retiming 2026-08-26, was 08:00 org-local on
+    // the tour's local day) - mirrors computeDueAt in
+    // app/src/jobs/tourReminders.ts. Move both together.
+    morningOf: new Date(t - 4 * 3_600_000).toISOString(),
```

### The `tourSchedule` docblock paragraph, inverted in the same voice

Old paragraph (removed):

> `morning_of` is deliberately NOT mirrored here (worklist A13): since the
> quiet-hours change it fires at 08:00 ORG-LOCAL (America/New_York) on the
> tour's local day, which this host-local helper cannot compute. The field it
> used to expose was 08:00 UTC and was never read by any spec, so it was
> removed rather than left as a wrong answer waiting to be used.

New paragraph (shipped):

> `day_before` is deliberately NOT mirrored here (the 2026-08-26 retiming
> INVERTED which rung can be): it now fires at 19:30 ORG-LOCAL
> (America/New_York) on the evening before the tour's local date, which this
> host-local helper cannot compute. Rather than leave a wrong answer waiting to
> be used, the field is gone - read the instant the server actually armed via
> `Scenario.armedReminderDueAt('day_before')` and drive the tick from that.
> `morning_of` made the opposite trip in the same retiming: it stopped being
> 08:00 org-local and became a plain `scheduledAt - 4h` offset, so it returns
> to the struct as `morningOf`.

The docblock's FIRST paragraph also carried a falsified premise
("day_before = sched-24h must beat the wall clock"). Replaced with the premise
that actually holds now: two days out, no booked-too-late rule can fire at any
time of day. Derivation: at `now + 48h`, `day_before`'s RAW is 19:30 on D-1,
which is between `now + 19.5h` (tour tod 23:59) and `now + 43.5h` (tour tod
00:00) - never inside the rule's `RAW - 4h` trigger; `morning_of`'s rule needs
the ARM instant on the tour's own local date, which +48h never is.

### `tourScheduleFullLadder` docblock arithmetic (re-checked)

The old inequality chain `day_before 14:00 D-1 < morning_of 08:00 D <
en_route 13:00 D < start` is replaced by
**`day_before 19:30 D-1 < morning_of 10:00 D < en_route 13:00 D < start 14:00 D`**
(spec 13.2 confirms this booking survives the new skip rules cleanly).

The docblock keeps the 00:00-08:00 flake history but now labels it HISTORY and
states that the retiming RETIRED that particular flake (`morning_of` is a pure
`-4h` offset, so it cannot outrun a start more than four hours away at any wall
clock) - while recording the fixed hour's NEW load-bearing role: it makes every
rung instant identical run to run, which is what quiet-hours test (2) anchors
its stored window to. Its closing advice ("keep plain `tourSchedule()` for
quiet-hours flows") is inverted, since that advice described the pre-retime
contract.

---

## 2. `armedReminderDueAt` - the exact implementation as shipped (Step 2)

Placed on `Scenario`, immediately above `tickTourReminders`. Shipped verbatim as
the plan wrote it:

```ts
  /** [App] The ARMED dueAt of one rung, read back from the reminders API.
   *  Since the 2026-08-26 retiming, day_before fires at 19:30 ORG-LOCAL the
   *  night before - a host-local mirror cannot compute it (the same reason
   *  morningOf once left TourTimes), so specs drive ticks from the value the
   *  server actually stored: correct by construction at any wall clock. */
  async armedReminderDueAt(kind: ReminderKind): Promise<string> {
    const tour = this.requireActiveTour();
    const res = await this.page.request.get(`${NEXT}/api/tours/${tour.tourId}/reminders`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = (await res.json()) as {
      reminders: Array<{ kind: ReminderKind; dueAt: string; state: string }>;
    };
    const rung = body.reminders.find((r) => r.kind === kind && r.state === 'upcoming');
    if (rung === undefined) {
      throw new Error(`armedReminderDueAt: no upcoming '${kind}' rung on tour ${tour.tourId}`);
    }
    return rung.dueAt;
  }
```

Verified against the live route rather than assumed: `TourReminderView` really
carries `state: 'upcoming' | 'sent' | 'canceled' | 'skipped'`
(`app/src/routes/tourReminders.ts:143`) and the response really is
`{ reminders, next? }` (`:637-639`) - the worklist's global-facts adjudication of
reader 5 D2 holds.

---

## 3. Per-spec changes and the derivation behind each new tick instant

### `e2e/tests/scenarios/scheduled-visibility.spec.ts` (Step 3, A9-2, A9-3, A9-4)

Two ticks repointed, both to
`justAfter(await flow.armedReminderDueAt('day_before'))`:

- **(a)+(b)**, the fires-and-leaves-Upcoming test.
- **(d)**, the opted-out suppression test.

DERIVATION for both. The booking is `tourScheduleFullLadder()` - 14:00 local, two
days out - so the armed instants are `day_before` 19:30 D-1, `morning_of` 10:00
D, `en_route` 13:00 D, start 14:00 D. At `justAfter(19:30 D-1)` neither
`morning_of` nor `en_route` is due, so release supersession has no LATER rung to
retire the asserted one with. `confirmation` (dueAt = the arm instant) IS in the
batch, but it is EARLIER in `LADDER_ORDER`, so supersession retires IT and leaves
`day_before` to send - the shape verified directly in
`app/src/jobs/tourReminders.ts:883-896`.

HONEST ABOUT THE ZONE (written into the comment, per the plan): `timesFor` builds
its instants from HOST-local datetime strings while 19:30 is ORG-local, so the
ordering argument assumes host zone == `ORG_TIMEZONE`. That assumption is
PRE-EXISTING harness-wide (this file already says so around its rung-preview
comment) and **no assertion anywhere in `e2e/` enforces the host TZ**. The TICK
itself does not depend on it - it is read back from the server - only the
"nothing supersedes" margin does.

**A9-2 (the `tourSchedule(72)` reschedule path, absent from the plan)** -
re-derived explicitly in a comment rather than assumed, and it survives:
- the OLD `day_before` row was pending, so the reschedule cancels it and the
  `expectReminderRung('day_before', 'canceled')` assertion rides that row;
- the FRESH ladder arms in full off `now + 72h`: `day_before`'s RAW is 19:30 the
  evening before that date, ~2.8 days out, far outside the `RAW - 4h` trigger,
  and `morning_of`'s rule needs the arm instant on the tour's own local date,
  which +72h never is;
- `next` is the earliest-dueAt UPCOMING row
  (`routes/tourReminders.ts:613-616`, verified - it is `find` over a dueAt-ascending
  sort, not a hardcoded kind), the fresh `confirmation`'s dueAt is the re-arm
  instant (= now), and the OLD confirmation is `sent` rather than upcoming. So
  `expectReminderRung('confirmation', 'next')` still holds.

**A9-3 (the one changed ROW LOCATOR text)** - `expectReminderRung('morning_of',
...)` now filters on `'4 hours before'`. Task 8 shipped the label; I verified the
card carries no OTHER "4 hours" text: `grep "4 hours\|four hours"` over
`dashboard/src/api/types.ts`, `RemindersPanel.tsx` and `app/src/messages/catalog.ts`
returns the label itself plus two RemindersPanel COMMENT lines (not rendered);
`grep "hour" app/src/messages/catalog.ts` returns **zero** hits, and the nearest
skip-reason label is `roster_unavailable`'s "gave up after an hour". Recorded in
a comment at the assertion.

**A9-4 (the `no_show_checkin` zero-rows assertion)** - re-derived in a comment
rather than assumed, and it holds for a stronger reason than "it is manual":
`no_show_checkin` is absent from `REMINDER_KINDS` entirely, so the arm loop never
reaches a skip rule for it and cannot produce a `booked_too_late` row for it. The
comment names the direction of the hazard explicitly (`booked_too_late` makes
near-term ladders LONGER, not shorter) and records that a 14:00 booking two days
out trips neither booked-too-late rule.

### `e2e/tests/scenarios/tours.spec.ts` (Step 3, adjudication A1)

One tick repointed, same call shape. DERIVATION, written into the comment and
following A1 rather than the overturned reviewer claim: `tourSchedule()` books
`now + 48h`, i.e. the same time-of-day `T` on day D. `day_before` fires 19:30 on
D-1; the next rung, `morning_of`, fires `T - 4h` on D, which lands back on D-1
only when `T < 04:00`, and the WORST case in that band is `T = 00:00` giving
20:00 on D-1 - **30 minutes after the tick**. At `T = 23:31`, `T - 4h` is 19:31
on D, a full day clear, not the 60-second collision reader 5 D6 claimed. The
comment states the counter-example explicitly so nobody re-derives the wrong one,
and carries the same HOST-ZONE honesty note (the 30-minute worst case is thin,
and it compares a HOST-local booking time against an ORG-local 19:30).

`times.enRoute` and `times.noShowCheckin` elsewhere in this file are untouched
and still valid; their batches are unchanged in shape by the retiming (at
`justAfter(enRoute)` the earlier rungs are all due together and `en_route` is the
latest, so it still survives supersession).

### `e2e/tests/scenarios/quiet-hours.spec.ts` (Step 4, A9-1)

- **`bookedSelfGuidedTour`** now books `tourScheduleFullLadder(2)` instead of
  `tourSchedule()`, and returns `{ tenant }` only (its `times` had no remaining
  reader, so the `TourTimes` type import went with it). Its docblock is rewritten
  to say why the fixed 14:00 is the right anchor now and that the old advice
  steering quiet-hours flows to the now-relative booking described the PRE-RETIME
  contract.
- **`QUIET_AROUND_DAY_BEFORE`** ADDED (17:30-21:30, enabled), with the plan's
  docblock. `windowAroundNow()` and `orgLocalHhMm()` are NOT deleted;
  `windowAroundNow`'s docblock gains a "TEST (3) ONLY since 2026-08-26" line so
  nobody sweeps it as dead.
- **Test (2)** stores `QUIET_AROUND_DAY_BEFORE` after arming with quiet OFF,
  reads `const dueAt = await flow.armedReminderDueAt('day_before')`, defers at
  `justAfter(dueAt)` and releases at `Date.parse(dueAt) + 5 * 3_600_000`. The
  `PAUSED_NOTE` / `QUIET_NOTE` assertions are unchanged.
- **Test (3)** keeps `putQuietHours(request, windowAroundNow())` untouched, with
  a new comment saying it is deliberately NOT switched and why.

### `e2e/tests/tour-no-show-checkin.spec.ts` (Step 5, A9-6, A9-7)

- **Header** (A9-6): "arms the reminder ladder, but the reminder poll never
  sends the 'may have missed your tour' check-in" was doubly false (the copy no
  longer says that, and the tour arms no PENDING rung). Rewritten to state that a
  past-dated tour arms NO pending rung at all and that `no_show_checkin` is not
  even considered - it is absent from `REMINDER_KINDS`.
- **`CHECKIN_PHRASE` comment**: the phrase is now the TAIL of the body, not the
  whole of it. The comment says so and re-argues why it remains a valid ABSENCE
  marker (still present in every variant of the rung, still unique to it among
  the five bodies), and records that the phrase now lives in exactly two places
  repo-wide.
- **The PATCH comment** (the plan's `:64`): replaced with the full five-rung
  derivation for `scheduledAt = now - 26h`, quiet hours OFF, arm instant `now`:
  `confirmation` dueAt = the arm instant, which is at/after the past start, so it
  is born a VISIBLE `past_event` row (NOT pending, and the spec nowhere says
  "confirmation still fires"); `day_before` RAW = 19:30 the evening before the
  tour's local date, ~2 days ago, far past `RAW - 4h`, so a VISIBLE
  `booked_too_late` row; `morning_of` RAW = start - 4h = 30h ago and its rule
  needs the ARM on the tour's OWN local date, which a 26h step always crosses, so
  it takes the one SILENT drop and writes no row; `en_route` = start - 1h, the
  same silent drop. **NOTHING is pending.**
- **Half 1** (A9-6, A9-7): the "The four legit rungs may land 1:1 (unasserted
  noise)" premise is deleted - it is false now, and it was the sentence that made
  the derivation unfalsifiable. Added an assertion that the tick sent **nothing
  at all**, so a wrong derivation fails loudly:

```ts
  const outboundBefore = (await getOutboundTo(request, { to: tenant.phone })).length;
  await flow.tickTourReminders();
  await flow.expectNoOutboxMessageContaining(tenant, CHECKIN_PHRASE);
  expect(
    (await getOutboundTo(request, { to: tenant.phone })).length,
    'the tick must send nothing at all - no rung of this tour is pending',
  ).toBe(outboundBefore);
```

  A count comparison rather than a `since`-filtered read, deliberately: it is
  immune to any sub-millisecond boundary between the captured instant and a
  message stamped in the same millisecond.
- **Half 2** (A9-7): the `toHaveValue(new RegExp(CHECKIN_PHRASE))` becomes the
  EXACT prefill `` `Hi ${tenant.firstName}! ${CHECKIN_PHRASE}` ``, built FROM
  `CHECKIN_PHRASE` so the phrase stays two literals, not three. This is the
  positive proof of the Task 4 name threading: a `/phrase/` match cannot see the
  name at all. Matches the catalog default
  `'Hi {tenantFirstName}! Do you need to reschedule?'` byte for byte.

### `e2e/tests/dashboard-next/tour-comms-pane.spec.ts` (A9-5)

Comment only. The `toHaveCount(1)` near-miss is recorded at the assertion: the
new `day_before` and `morning_of` copies share the head "Hey <Name>," AND the
tail "Does that still work for you?", and the count survives only because the
middles still differ ("confirming your tour tomorrow at <t>." vs "looking forward
to having you tour at <t> today."), so the whole `day_before` body is not a
substring of the `morning_of` card. The comment names the fix if that gap ever
closes (narrow the filter to the card's body element, do not loosen the count).

---

## 4. How the rewritten timing contract keeps its wall-clock-independence promise

The shipped header text (`quiet-hours.spec.ts`), quoted in full:

```
// TIMING CONTRACT (the part that makes this deterministic at ANY wall clock).
// The PROMISE is unchanged by the 2026-08-26 retiming. What changed is that the
// two send tests now anchor their stored window DIFFERENTLY, because they prove
// different things:
//   - Test (2) (defer + release) needs the RUNG's dueAt inside the stored window
//     at tick time. day_before now fires at 19:30 ORG-LOCAL the evening before
//     the tour - a FIXED local time of day - so a fixed org-local window around
//     it contains it at ANY wall clock: QUIET_AROUND_DAY_BEFORE. The old trick
//     ("day_before is ~24h out, so it lands at the same local time of day as
//     windowAroundNow()") died with the sched-24h offset.
//   - Test (3) (Send now) needs the WALL CLOCK inside the stored window: the
//     panel's suppression estimate for an already-due rung and the force-send's
//     quiet-hours BYPASS are both wall-clock facts, and the test never ticks. It
//     KEEPS windowAroundNow() (a 4-hour window centred on now, in ORG-local
//     time, so the host's own timezone is irrelevant). Re-anchoring it to the
//     rung would leave no window over the wall clock and so nothing for the
//     bypass to bypass - a vacuous proof at every wall clock outside
//     17:30-21:30 org-local.
//   - No tick instant is ever computed host-side. 19:30 is ORG-local and this
//     host-local file cannot compute it, so BOTH of test (2)'s ticks are derived
//     from the dueAt the SERVER armed (Scenario.armedReminderDueAt): correct by
//     construction. The defer tick is 1s past it (19:30:01 org-local, inside the
//     window) and the release tick 5h past it (00:30 org-local, outside it) -
//     with margin for a DST shift either way.
//   - The ladder is armed with quiet hours OFF so the stored dueAts are
//     UN-CLAMPED (the legacy row shape the fire-time backstop exists for);
//     arming under an enabled window would clamp them out of it and there would
//     be nothing left to defer.
//   - Only ONE rung of the tour is ever due in an ASSERTED tick. This bullet
//     used to argue that the assertions ride day_before because it is "the LAST
//     due rung, which nothing can supersede" - the retiming FALSIFIED that. At
//     19:30 the evening before, day_before is the EARLIEST rung of the ladder,
//     exactly the kind release supersession retires. The argument is now about
//     the TICK INSTANTS, not the rung order: the booking is
//     tourScheduleFullLadder(2) (14:00, two days out), so the next rung up,
//     morning_of, is due 10:00 on TOUR DAY - after the defer tick (19:30:01 the
//     evening before) AND after the release tick (00:30 tour day). No later rung
//     is ever in either batch, so nothing supersedes day_before. (confirmation,
//     whose dueAt is the arm instant, IS in the defer batch - but it is EARLIER
//     in the ladder, so supersession retires IT and leaves day_before pending,
//     which is exactly what the "still upcoming" assertion reads.)
```

**Why test (2) is wall-clock independent.** Every quantity it depends on is
either fixed in ORG-local terms or read back from the server:
- the stored window is a constant, `[17:30, 21:30)` org-local;
- the rung's dueAt is 19:30 org-local on a calendar day derived from the booking,
  which the SERVER computed and the spec READS - the spec never computes it;
- the defer tick is `dueAt + 1s`, i.e. 19:30:01 org-local, unconditionally inside
  that window;
- the release tick is `dueAt + 5h`, i.e. 00:30 org-local, unconditionally outside
  it (and 4.5h clear of the 21:30 edge, more than any DST shift);
- the panel chip assertions ride `paused`, which is a property of the KIND and
  outranks everything; the negative `QUIET_NOTE` assertion is now a REAL
  precedence proof at every hour, because the estimate's quiet disjunct
  (`dueAt > now && isQuietTime(dueAt, window)`,
  `routes/tourReminders.ts:560-564`) is satisfied unconditionally - the dueAt is
  ~1.5 days in the future and sits inside the stored window by construction.
  Under the old wall-clock anchoring that was true only by coincidence of the
  hour.

**Why test (3) is wall-clock independent.** It stores a window CENTRED on the
wall clock, so "the clock is inside a stored window" is true by construction at
any hour, and it drives no tick at all. Its assertions are the panel chip
(`paused` outranks `quiet_hours`) and a force-send that must go out anyway. Had
it been re-anchored to the rung, the wall clock would sit outside the stored
window at every hour outside 17:30-21:30 org-local and the bypass would have
nothing to bypass - the proof would pass vacuously most of the day. Keeping
`windowAroundNow()` is what preserves the promise here, not what breaks it.

---

## 5. Worklist confirmations

| item | status |
| --- | --- |
| **A9-1** | DONE. The supersession bullet is rewritten with the new argument (tick instants, not rung order): the release tick at dueAt + 5h is 00:30 on tour day, still before `morning_of` at 10:00, so nothing supersedes. The bullet explicitly names that `day_before` is now the EARLIEST rung, i.e. exactly the one supersession can retire, so nobody re-derives the dead claim. |
| **A9-2** | DONE. `tourSchedule(72)` reschedule path re-derived explicitly (not assumed) in a comment; `confirmation` stays `next` because `next` is the earliest-dueAt UPCOMING row and the fresh confirmation's dueAt is the re-arm instant. Both assertions survive. |
| **A9-3** | DONE. Row locator verified: the only rendered "4 hours" in the Reminders card is the label itself. `grep "hour"` over the message catalog returns zero. Recorded in a comment. |
| **A9-4** | DONE. Zero-rows re-derived from `REMINDER_KINDS` membership rather than from "it is manual", with the LONGER-not-shorter direction of the `booked_too_late` hazard named in the comment. |
| **A9-5** | DONE. Near-miss recorded as a comment at the `toHaveCount(1)`, including the shared head and tail and the reason the count still holds. |
| **A9-6** | DONE. All four falsified prose sites updated: the file header, the `CHECKIN_PHRASE` comment, the PATCH derivation, and Half 1's "The four legit rungs may land 1:1". |
| **A9-7** | DONE. Three literals reduced to two - the exact prefill is built from `CHECKIN_PHRASE`. Half 1 gained the "the tick sent nothing at all" assertion (an outbound-count comparison across the tick). |
| **A9-9** | **DELIBERATELY NOT BUILT.** `expectReminderRung`'s state union is untouched: no `'skipped'` member added, no new verb for `booked_too_late`. Phase A owes no e2e proof of it. A later slice files the gap. |
| A9-8 | Not mine (assigned to the Task 4 suite run). My change touches no route source, so no `collect.ts` fingerprint can move because of it. Left alone. |

Binding constraints honoured: `MANUAL_ONLY_REMINDER_KINDS` and `REMINDER_KINDS`
are untouched (the ladder stays paused; a green e2e proves the MACHINERY only,
because the dev tick route injects an empty manual-only set). Nothing outside
`e2e/` was edited. Every changed premise was RE-DERIVED, not re-baselined.

---

## 6. ASCII and lint

Every added line is ASCII. Verified mechanically over the staged diff, not by
eye:

```
$d = git diff -U0 -- e2e/; $d | ? { $_ -match '^\+' -and $_ -notmatch '^\+\+\+' -and ($_ -cmatch '[^\x00-\x7F]') }
-> ALL ADDED LINES ASCII
```

The first pass caught one violation and it is worth recording: re-emitting an
UNCHANGED comment line inside an edited block makes it an ADDED line, and this
file's pre-existing em dash rode along in `TourTimes`'s `dueAt` docblock. Fixed
to a hyphen.

Gate 5 over the six touched files:

```
npx eslint e2e/scenarios/steps.ts e2e/tests/scenarios/scheduled-visibility.spec.ts \
  e2e/tests/scenarios/tours.spec.ts e2e/tests/scenarios/quiet-hours.spec.ts \
  e2e/tests/tour-no-show-checkin.spec.ts e2e/tests/dashboard-next/tour-comms-pane.spec.ts
EXIT=0
  6 problems (0 errors, 6 warnings)
```

All six warnings are `Unused eslint-disable directive (no problems were reported
from 'no-console')` on the pre-existing `E2E_PAUSE` blocks of three spec files -
untouched lines, pre-existing, not mine.

---

## 7. Typecheck

```
npm run typecheck        EXIT=0     (.artifacts/t9-typecheck-1.log, before the em-dash fix)
npm run typecheck        EXIT=0     (.artifacts/t9-typecheck-2.log, final, as shipped)
```

---

## 8. Targeted Playwright runs (Step 6, the parts that are mine)

Lane hygiene first. `e2e/.artifacts/session.pid` held a STALE launcher pid
(37300) from an earlier slice; the process was dead and no listener survived on
lane 10's ports (10001/10011/10021/10031). Cleared it the documented way before
starting, so nothing could be adopted by `reuseExistingServer`:

```
npm run e2e:stop
EXIT=0
[e2e-stop] no running session found; retained state is stale or absent - nothing to stop
```

Both runs were launched from inside the e2e workspace, unpiped, redirected to a
file, with the real exit code read from `$?`.

### Run 1 - `.artifacts/e2e-t9-1.log`

```
cd W:/tmp/tour-reminder-ladder/e2e
npx playwright test tests/scenarios/quiet-hours.spec.ts
REAL EXIT=0

  3 passed (25.9s)
```

All three: (1) Settings round-trip, (2) Defer + release, (3) Send now.

### Run 2 - `.artifacts/e2e-t9-2.log`

```
cd W:/tmp/tour-reminder-ladder/e2e
npx playwright test tests/scenarios/scheduled-visibility.spec.ts \
                    tests/scenarios/tours.spec.ts \
                    tests/tour-no-show-checkin.spec.ts \
                    tests/dashboard-next/tour-comms-pane.spec.ts
REAL EXIT=0

  19 passed (2.4m)
```

Per-test, quoted from the log:

```
  ok  1 tour-comms-pane.spec.ts:190 self-guided tour: the Tenant tab shows this tour Upcoming reminders ... (2.7s)
  ok  2 tour-comms-pane.spec.ts:266 viewing the Tenant tab clears the tenant WHOLE inbox row ... (4.8s)
  ok  3 tour-comms-pane.spec.ts:402 SMS sends from the tour Tenant tab ... (1.8s)
  ok  4 tour-comms-pane.spec.ts:452 an email exchanged with the tenant renders on the tour page Tenant tab ... (2.2s)
  ok  5 scheduled-visibility.spec.ts:96  Part A - the tour Reminders panel renders the armed ladder + NEXT rung (5.5s)
  ok  6 scheduled-visibility.spec.ts:161 (a)+(b) tour reminder: future item -> tick -> leaves Upcoming, sends 1:1 (5.6s)
  ok  7 scheduled-visibility.spec.ts:209 (c) reschedule: tick a rung -> panel states -> cancels + re-arms (5.1s)
  ok  8 scheduled-visibility.spec.ts:254 (d) suppression: opted-out tenant -> will-be-skipped -> tick sends nothing (4.1s)
  ok  9 scheduled-visibility.spec.ts:292 (e) tenant nudge: Awaiting receipt -> Upcoming nudge -> tick -> sent 1:1 (6.7s)
  ok 10 tours.spec.ts:96  landlord-led: interest -> group negotiation -> booked -> group reminders -> exit YES (17.8s)
  ok 11 tours.spec.ts:172 PM-team: same shape with the PM in the landlord slot -> exit NO (14.6s)
  ok 12 tours.spec.ts:212 self-guided: windows 1:1 -> booked -> 1:1 reminders -> ID gate -> toured (10.3s)
  ok 13 tours.spec.ts:262 no-show: booked -> no auto check-in -> logged no-show -> rescheduled (6.1s)
  ok 14 tours.spec.ts:306 activity coverage: booked + toured tour pins land on the tenant timeline (6.5s)
  ok 15 tours.spec.ts:325 activity coverage: a canceled tour pins on the tenant timeline (5.5s)
  ok 16 tours.spec.ts:342 already toured: requested -> marked toured -> nothing armed -> exit NO (6.6s)
  ok 17 tours.spec.ts:369 page arc: create -> book -> group tab fans out -> tenant 1:1 -> outcome YES (15.2s)
  ok 18 tours.spec.ts:415 mobile: the tour page opens on Details with the primary CTA in-viewport (4.9s)
  ok 19 tour-no-show-checkin.spec.ts:44 no_show_checkin is not auto-sent; staff send it manually with prefilled copy (3.9s)
```

22 tests green across the five affected spec files, zero failures, zero flaky,
zero retries. No app or dashboard file was touched to get there.

**Step 6's FULL `npm run e2e` is the parent's**, per the mission block.

---

## 9. Commit (Step 7)

Bare `git status` read first; the worktree gitdir is
`W:/AI Projects/Housing Choice/HC Application/.git/worktrees/tour-reminder-ladder`
(the worktree's `.git` is a FILE, so `ls .git/MERGE_HEAD` misleads - resolved via
`git rev-parse --absolute-git-dir`) and `MERGE_HEAD` is absent there. Six explicit
paths staged, no `git add -A`.

```
0f30c9b5 fix(e2e): drive day_before ticks from the armed dueAt; invert the TourTimes mirror
 6 files changed, 270 insertions(+), 70 deletions(-)
```

Trailer: `Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>`.

---

## 10. Deviations from the plan, with reasoning

- **D1. `bookedSelfGuidedTour` in `quiet-hours.spec.ts` returns `{ tenant }`,
  not `{ tenant; times }`.** After the rework neither test reads `times` (test
  (2) reads the dueAt back from the server, test (3) never ticks), so the field
  was dead and the `type TourTimes` import with it. Keeping an unread return
  member would have left a second, host-computed source of ladder times sitting
  in the file that the timing contract exists to keep out.
- **D2. A sixth file, `tour-comms-pane.spec.ts`, is in the commit.** The plan
  lists five. A9-5 requires a near-miss comment in this file, so the worklist -
  which outranks the plan on additions - puts it in Task 9's scope.
- **D3. Two extra edits inside the plan's files.** (a) `tourSchedule`'s FIRST
  docblock paragraph, not just the `morning_of` one: its parenthetical
  "day_before = sched-24h must beat the wall clock" was a premise the retiming
  falsified, and the RE-DERIVE rule applies to it. (b) `windowAroundNow`'s
  docblock gained a "TEST (3) ONLY" line - the plan is emphatic that it must not
  be deleted, and an undocumented single-caller helper is exactly what a later
  sweep deletes.
- **D4. Half 1's "sent nothing at all" is a COUNT COMPARISON across the tick,
  not a `since`-filtered read.** A9-7 does not prescribe a form. The count is
  immune to a message stamped in the same millisecond as a captured `since`
  boundary; the `since` form is not.
- **No deviation on the margin.** A1 was followed; the plan's 30-minute
  worst-case claim was re-derived independently and stands.

---

## 11. Noticed and NOT fixed

- **No assertion anywhere in `e2e/` enforces the host timezone.** The whole
  harness assumes host zone == `ORG_TIMEZONE` (America/New_York) whenever it
  compares a host-local booking time against an org-local rung instant. This
  slice STATES the assumption in both margin comments rather than fixing it, per
  the plan. It is pre-existing and harness-wide. A one-line
  `expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(ORG_TIMEZONE)`
  in `preflight.ts` would close it, and would have turned a class of silent
  wrong-margin failures into one loud boot error - worth its own decision, since
  it would also refuse to run for a contributor on another zone.
- **`tour-roster.spec.ts:495-503` is the un-promoted twin of
  `armedReminderDueAt`.** It open-codes the same read-back for `confirmation` in
  a Scenario-free dialect. Left exactly as it is (A5 says that file is read for
  the pattern, not modified), but it is now a duplicate of a shipped verb.
- **`quiet-hours.spec.ts`'s `QUIET_NOTE` is still structurally unreachable on a
  tour rung** while the ladder is paused - `paused` outranks `quiet_hours`, so
  every positive assertion the constant could back is a negative one. Unchanged
  by this slice and deliberately kept (the file already documents it), but the
  rung-anchored window now makes the negative assertion meaningful at every wall
  clock rather than only at some, which is a real strengthening worth noticing
  when Phase B empties `MANUAL_ONLY_REMINDER_KINDS` and the positive assertion
  comes back.
- **The e2e suite still exercises an automatic send path production does not
  have.** The dev tick route injects an empty manual-only set. Every "the rung
  fired" assertion in these specs proves the MACHINERY, not the shipped
  behaviour. Stated here because a green Task 9 is the most likely thing to be
  mistaken for "the ladder works now".
- **Three `Unused eslint-disable directive` warnings x2 files** in the
  `E2E_PAUSE` blocks of the three scenario specs. Pre-existing, on untouched
  lines, not fixed (fixing unrelated lint in a shared repo is its own change).
