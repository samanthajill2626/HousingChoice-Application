---
id: tour-reminders-panel-e2e-flake
title: "scheduled-visibility.spec.ts Part A (Reminders panel armed ladder) fails DETERMINISTICALLY when the suite runs before 08:00 org-local - the morning_of rung is legitimately never armed"
type: bug
severity: medium
status: open
area: e2e
created: 2026-07-10
updated: 2026-08-04
refs: e2e/tests/scenarios/scheduled-visibility.spec.ts:85, e2e/tests/scenarios/scheduled-visibility.spec.ts:140, e2e/tests/scenarios/steps.ts:2962
---

**Observation (2026-07-10, during the remove-conversation-assignment review).**
One full-suite e2e run failed exactly one test:

    Part A - the tour Reminders panel renders the armed ladder + NEXT rung on /tours/:id
    Error: expect(locator).toBeVisible() failed / element(s) not found
    at steps.ts:2962 (await expect(row.first()).toBeVisible({ timeout: 10_000 }))

Provenance points at a flake, not a regression:
- The failing area is the tour Reminders panel, which main's freshest commit
  (c7c33a9 "fix(tours): Reminders panel updates itself when a rung fires")
  had JUST modified. The branch under review changed only inbox/assignment
  code - zero file or behavior intersection with tours.
- The same suite passed 127/127 on the branch's parent commit, and an
  immediate full-suite re-run on the SAME commit passed 127/127.

So: 1 failure in 3 full runs, only in the run following c7c33a9's arrival.
Likely a timing hole in the panel's new self-update path (the ladder row not
yet rendered within 10s under full-suite load), or cross-spec state.

**Sighting (2026-08-03, feat/relay-area-code-preference planner gate).**
One full-suite run on `5800f541` failed exactly one test - the same Reminders
panel, a different rung assertion:

    scheduled-visibility.spec.ts:140 - (c) reschedule: tick a rung -> panel states
    -> reschedule cancels + re-arms a fresh ladder
    "Reminders panel shows Confirmation as next"
    Error: expect(locator).toBeVisible() failed (timeout)

196/197 passed. Provenance again points at a flake, not a regression: the branch
under review changed only relay pool-number buying (config + adapter + warm
ladder + fake-twilio), which has zero intersection with tours or reminders, and
the orchestrator's TWO full-suite e2e runs on the SAME commit were both green
(196/196 pre-main-sync, 197/197 post-sync). So the panel assertion has now
failed twice, in two different runs, on two different rung rows - consistent
with the panel's self-refresh racing the assert rather than a specific rung's
logic. Log: `.superpowers/sdd/planner-gate-e2e.log` (gitignored, session-local).

**Sighting + ROOT CAUSE (2026-08-04, feat/contact-comms-pane Slice 6 e2e gate).**
The third sighting is NOT a race, and it reproduces SOLO. Full suite on
`28a92974`: 203 passed, 1 failed - Part A again, this time on

    "App: Reminders panel shows 'Morning of' as upcoming"   (spec line 98)

An immediate ISOLATED re-run of the same file failed identically (4 passed,
1 failed, same rung). The app's own log gives the answer:

    "kind":"morning_of","dueAt":"2026-08-06T12:00:00.000Z",
    "msg":"tour reminder skipped (quiet-hours clamp lands at/past tour start)"

The rung is never armed, so no listitem exists and no wait strategy could ever
make the assertion pass. Mechanism (post quiet-hours, 2026-08-03):

- `bookedSelfGuidedTour` books the tour at `tourSchedule()` = **now + 48h**, so
  the tour's org-local TIME OF DAY equals the wall clock's time of day.
- `computeDueAt('morning_of')` is now **08:00 ORG-LOCAL on the tour's local
  day** (app/src/jobs/tourReminders.ts, the 4am-text fix), NOT `scheduled - Nh`.
- `armTourReminders` skip rule (b): `if (dueAt >= scheduledIso) continue`.

So whenever the suite runs between local **midnight and 08:00**, the tour lands
at (say) 02:07 local and morning_of lands at 08:00 local the SAME day - six
hours AFTER the tour start - and is correctly skipped. The run above was at
02:07 America/New_York. Outside that window the rung arms and Part A passes,
which is exactly why this has read as an intermittent flake for a month: the
suite usually runs during the day.

The 2026-08-03 `Confirmation` sighting has a different shape (confirmation's
dueAt is arm-time `now`, which rule (b) cannot skip), so that one may still be
a genuine race - keep this issue open for both.

**Suggested next step (spec-side, NOT product-side - the skip is correct
behavior).** Either (a) book Part A's tour at a fixed org-local afternoon
time instead of `now + 48h` so every rung is armable at any wall clock, or
(b) drop the `morning_of` rung assertion from Part A (it is the one rung whose
presence is wall-clock dependent) and pin the skip explicitly elsewhere. Owner
= scheduled-visibility / quiet-hours. Deliberately NOT changed by the
contact-comms-pane branch (different feature, judgment call).
