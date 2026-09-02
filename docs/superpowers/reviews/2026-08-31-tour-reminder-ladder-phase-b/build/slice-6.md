# Slice 6 report - Tasks 10, 11, 12

Branch `feat/tour-reminder-ladder-phase-b`. Three commits, all green.

| commit | subject |
|---|---|
| `821596c8` | feat(reminders): en_route quiet-hours exemption; supersession predicate widened |
| `ff2ea469` | feat(reminders): one-hour names bound at both unclaimed-return sites |
| `6e153c83` | feat(reminders): derived overdue flag on both view builders |

## Gate / test runs

| command | exit | result |
|---|---|---|
| `app: npx vitest run test/tourReminders.test.ts` (after T10) | 0 | 100 passed |
| `app: npx vitest run tourReminders/tourRemindersApi/contactTimeline/seedLive` (T10) | 0 | 211 passed |
| `app: npx vitest run test/tourReminders.test.ts` (after T11) | 0 | 106 passed |
| `app: npx vitest run tourRemindersApi/contactTimeline/seedLive` (after T11) | 0 | 111 passed |
| `app: npx vitest run test/tourRemindersApi.test.ts` (after T12) | 0 | 48 passed |
| `dashboard: npx vitest run src/routes/tours src/api` (after T12) | 0 | 363 passed |
| `npm run typecheck` (root, after each task) | 0 | clean |
| `e2e: npx tsc --noEmit -p .` (after T10, after T12) | 0 | clean |
| `app: npx vitest run` (FULL, end of slice) | 0 | **6344 passed, 9 skipped; 347 files passed, 1 skipped** |

No Playwright was run (orchestrator owns e2e).

**Gate 5 (lint, branch files only):** 6 errors reported across the branch's files, and all six
are PRE-EXISTING - baseline-compared by running the same eslint invocation on the same five
paths in the `main` checkout, which reports the identical six (`live.ts` overdueAt/followUpAt,
`matrix.ts` DEADLINE_TYPES, `tourRemindersRepo.ts` GetCommand, `relayGroups.ts` resolveMessage,
`ScheduledCard.tsx` react-hooks/purity; only line numbers shifted). **None of them is in a file
this slice touched.** The 6 warnings are pre-existing unused `eslint-disable` directives in
three e2e specs. Zero new errors from slice 6.

---

## Task 10 - en_route quiet-hours exemption + widened supersession

### Shipped

**Site 1, arm-time** (`app/src/jobs/tourReminders.ts`, pass 1 of `armTourReminders`):
`dues.set(kind, kind === 'en_route' ? raw : clampOutOfQuietHours(raw, window));` with the
founder-decision comment (Sam 2026-08-31; no floor on the tour hour; the exemption lives at
the CALL SITE because `clampOutOfQuietHours` is shared with the placement ladder and the
timeline). The helper itself is untouched.

**Site 2, fire-time backstop** (`processReminderRow`):
`if (row.kind !== 'en_route' && isQuietTime(now, window))`, with a sentence stating that the
past-tour gate ABOVE it is what now bounds the catch-up backlog (removing that gate would make
the exemption unsafe).

**Site 3, the panel ESTIMATE** (spec 6 addendum), at both tour surfaces and never inside a
shared helper:
- `app/src/routes/tourReminders.ts`: `suppressionOf` gains a third parameter `quietExempt`;
  the quiet disjuncts become `!quietExempt && (...)`. The call site passes
  `row.kind === 'en_route'`. Opt-out / kill switch / manual mode still ride the shared
  evaluator.
- `app/src/routes/contactTimeline.ts`: `suppressionFor` gains a 5th parameter
  `quietExempt = false` (`quietNow: !quietExempt && quietFor(dueAt)`); ONLY the REMINDER call
  site inside the tour walk passes `row.kind === 'en_route'`. `quietFor` is untouched and the
  placement-nudge call site is unchanged - pinned by a test that asserts the nudge in the same
  fixture still chips `quiet_hours`.

**`supersededBySlot`** widened to the plan's exact predicate
`otherDue !== undefined && otherDue <= dueAt && otherDue < scheduledIso` with its comment.
`supersededInBatch` UNTOUCHED.

**`LADDER_ORDER` docblock REWRITTEN.** The old "clamping can only push an EARLIER rung forward
onto a later one's slot" sentence is deleted and replaced with the inequality rationale
(equality was a proxy that held only while every rung clamped to the same window edge; the
exemption breaks the coincidence; do not narrow it back).

**R14 mirror**: `app/test/seedLive.test.ts`'s hand-written `computeDueAt` now returns
`kind === 'en_route' ? raw : clampOutOfQuietHours(raw, QUIET_WINDOW)`. No seedLive dueAt pin
needed re-deriving - the live seed's tours put no en_route inside the window (suite green
unchanged).

**Four new tests** (`app/test/tourReminders.test.ts`, own November 2026 timeline so nothing
collides with another test's rows):
1. arm-time: 04:00-local tour -> en_route stored RAW at 03:00 local, asserted in-window via
   `isQuietTime`; morning_of clamps to 08:00 and is `past_event`; day_before is the unclamped
   control.
2. fire-time: two DIFFERENT tours (same-tour rungs would hit `supersededInBatch` and hide the
   deferral) - the en_route sends mid-window, the day_before is left unclaimed and still in
   `listDue`.
3. REGRESSION (08:30 double-send): armed the evening before; en_route raw 07:30, morning_of
   clamped 08:00 and born `quiet_hours_superseded`; en_route is the only pending rung.
4. NO-OP pin: quiet hours off, ordinary afternoon tour, three rungs strictly increasing, zero
   skips. (This one was GREEN before the implementation - correct for a no-op pin.)

**Step 4 - `e2e/tests/scenarios/quiet-hours.spec.ts` re-read end to end: NOTHING NEEDED
RE-BASELINING, and I am saying so explicitly.** Both send tests ride `day_before`, which is
not exempt; the ladder is armed with quiet hours OFF so no rung is clamped; `en_route`
(13:00 tour day) is in neither batch and is never asserted. No comment in the file reasons
about `en_route` AND quiet hours. I added ONE defensive bullet to the file's TIMING CONTRACT
recording that riding `day_before` is now load-bearing - re-anchoring either test onto
`en_route` would make the deferral the file exists to prove structurally impossible.

### Deviated / divergences (all trusting the FILE over the plan, per the brief)

1. **FIVE existing arm cases needed re-deriving, not the zero the plan implies.** Every one is
   a real consequence of the exemption, and each was re-derived from the instants rather than
   flipped:
   - **Test 1c** (10pm tour): en_route raw is 21:00 local EXACTLY - the first minute of the
     window - so it used to clamp to the next 08:00 and be `past_event`. It now arms at its raw
     instant and the whole ladder is live. The test's premise ("retires en_route past the
     event") is gone, so it is renamed and its docblock records the change. **This is a real
     product change worth the founder's eye: a 10pm tour now gets a 9pm "on the way" text where
     it previously got none.** It follows directly from the approved exemption, but Sam was
     told about the 8am case, not this one - it belongs beside the 04:00 handback item.
   - **Test 1d** (08:30 tour): outcome unchanged (morning_of still superseded) but by the
     WIDENED predicate rather than equality, and en_route's dueAt moves 13:00Z -> 12:30Z.
     Renamed ("clamped onto the morning_of slot" is now false).
   - **Tests 1f and 1g** (07:30 tour): en_route no longer joins morning_of on the past-event
     branch; it arms raw. Live-kind lists updated.
   - **Test 1i** (settings-read failure): **RE-POINTED to a different fixture.** On Test 1c's
     10pm tour the only clamped rung was en_route, so after the exemption every assertion there
     would have been identical with the window enabled or disabled - a vacuous pass on a test
     whose entire job is to fail if the fallback ever became "no quiet hours". It now rides Test
     1g's 07:30 tour, where morning_of's clamp is the discriminating assertion.
2. **Deliberate overlap:** re-derived Test 1d and my new REGRESSION test cover the same 08:30
   scenario at different arm instants (1d arms the morning before, so day_before arms; the
   regression arms the evening before, so day_before is `booked_too_late` and en_route is the
   sole survivor). Kept both - the brief required the four tests written fully, and the
   regression's framing ("ONE text goes out") is the one a reader will look for.
3. **Added one extra guard the brief did not ask for**
   (`tourRemindersApi.test.ts`: "an en_route rung is exempt from quiet hours ONLY - opt-out
   still suppresses it"). It exists to stop a future "simplification" into skipping the
   evaluator entirely for `en_route`.
4. Threading choice: both route sites take a PRE-COMPUTED boolean parameter rather than the
   kind, so neither shared helper learns about reminder kinds. The brief explicitly allowed
   either.

---

## Task 11 - the one-hour names bound at BOTH sites

### Shipped

Both `ReminderNamesUnavailableError` catch sites (`processReminderRow` 1:1, `sendGroupReminder`
group) gained the plan's exact shape: `rosterWaitExpired(row.dueAt, now)` ->
`log.error(... 'tour reminder: name resolution STILL failing past the grace window - retiring
(claim-skipped)')` -> `claimSkipRow(row, 'names_unavailable', now, deps, tour.tenantId)`.
The inside-the-hour `log.warn` string is byte-identical at both sites (it is asserted verbatim
as `DEFER_WARN`). The GROUP site's ledger-item-7 ACCEPTANCE comment is replaced by the
discharge, which also records why that site is the one that matters most. Force-send is
untouched.

**Six tests** in a new `describe('the one-hour names bound (spec 7)')` nested inside the
existing name-failure describe (so `nameFailRig`, `rowOf`, `msgsSince`, `DEFER_WARN` and the
NF_* instants are in scope): each route x (a) inside the hour -> unclaimed, DEFER_WARN, still
in `listDue`; (b) past the hour (`dueAt + 61min`, since `rosterWaitExpired` is a strict `>`)
-> `skipReason: 'names_unavailable'`, the retire ERROR logged, and gone from `listDue` (the
"exactly once" proof); (c) force-send at the same late instant still refuses
`names_unavailable` and leaves the row pending. All rung dueAts stay BEFORE the tour so the
live past-tour gate is a no-op.

### Divergence

**The group fixture deletes the tenant's 1:1 conversation after seeding it.** Without that,
all three GROUP cases would pass identically if the relay group were unusable and routing
quietly fell back to the 1:1 - i.e. they would prove the 1:1 bound twice and the group bound
never. With no 1:1 thread to fall back TO, a routing failure claim-skips `no_conversation`,
which every assertion catches. Recorded in the fixture's docblock.

---

## Task 12 - the derived `overdue` flag

### Shipped

- `overdue?: boolean` on `TourReminderView` in `app/src/routes/tourReminders.ts` and on the
  dashboard twin in `dashboard/src/api/types.ts`, with spec 8.1's docblock verbatim.
- BOTH builders set it, each computing its OWN `nowIso`: `viewOf` (PATCH echo) and the GET
  list projection (`listNowIso`, declared beside the projection). The GET route's existing
  `nowIso` stays block-scoped inside `self_guided && hasUpcoming` and was NOT lifted; a
  comment at each site says why.
- `state === 'upcoming' && row.dueAt < nowIso`, conditional-spread omitted when false.
- Panel (`RemindersPanel.tsx`): a new branch BELOW discontinued and ABOVE paused returns an
  amber `Overdue` chip, replacing the `sendRelative` promise. The suppression note is rendered
  by the row (not the chip), so it composes automatically.
- Route tests: past-due upcoming -> `overdue: true`; future -> no key (`not.toHaveProperty`);
  sent and skipped rungs with deep-past dueAts -> no key; PATCH cancel echo -> no key, restore
  echo -> `overdue: true`. All dueAts are `isoHoursFromNow(+/-N)`: "past" and "future" are the
  subject, so a fixed date literal would silently become a no-op on some clocks.
- Panel tests (4): the chip replaces the promise; it renders alongside a `quiet_hours` note;
  ORDER pinned on BOTH boundaries - discontinued+overdue reads "No longer sent" (R15), and
  overdue+paused chips "Overdue" while keeping the "Paused - send manually" note.
- Spec 8.2 exclusions stand: nothing added to `contactTimeline.ts` or `relayGroups.ts`.

### Deviated - step 3, the e2e assertion: **took route (b), no assertion. Derivation:**

Route (a) is ALSO unreachable, for the same reason (b) is. The quiet-hours spec's deferred
`day_before` is pending after the in-window tick, but it is **not past-due**: the tick is a
TIME-INJECTED dev call, while `overdue` is computed against the server's WALL CLOCK, and the
rung's stored dueAt is 19:30 org-local the evening before a tour booked two days out - i.e.
genuinely in the future. Asserting `Overdue` there would fail outright. And the general case
holds as the brief predicted: under a live 30s worker a pending rung with a real past dueAt is
exactly what the worker sends. Booking closer to `now` to manufacture one buys a
wall-clock-dependent flake. I recorded this reasoning as a comment where the assertion would
have gone (`quiet-hours.spec.ts`, beside the QUIET_NOTE assertion) so the next reader does not
add a flaky one, and pinned `overdue` on the route and the chip instead.

---

## Open worries - not blocking, your eye

1. **The 10pm-tour behaviour change (Test 1c) is a founder-visible consequence** that the spec
   does not name. Spec 6.1 records the 04:00 tour ("no floor on the tour hour") and the 8am
   tour; the mirror case at the TOP of the day is that any tour from ~21:00 local onwards now
   gets an en_route inside the window where it previously got nothing. Same decision, same
   direction, but T15's handback list should probably say it in one sentence.
2. **`overdue` ordering vs `paused` is untested against production reality** because
   `MANUAL_ONLY_REMINDER_KINDS` is empty - the overdue+paused test injects the suppression
   through the view. That is the only way to reach it today; noting it so nobody reads that
   test as evidence the production panel can produce the combination.
3. **The T10 fire-time test's poll sweeps every other pending row in the shared DynamoDB
   table** (the file's convention: pick a timeline nothing else occupies). It is last in the
   file, its own November timeline is clean, and `runDueTourReminders` isolates per-row errors,
   so it is safe - but a future test inserted AFTER it on an earlier timeline would be affected
   by it, not the other way round.
4. `viewOf` now calls `new Date()` per PATCH/send-now response (three call sites in one
   handler can therefore see up to three distinct instants). Harmless for a boolean that flips
   at a rung's dueAt, and spec 8.2 explicitly prefers it over lifting a shared clock, but it is
   the kind of thing a reviewer notices.
