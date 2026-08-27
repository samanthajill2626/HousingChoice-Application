---
id: tour-reminders-panel-e2e-flake
title: "scheduled-visibility.spec.ts Reminders panel - a rare rung-visibility timing flake (the 08:00 wall-clock half is CLOSED)"
type: bug
severity: low
status: resolved
area: e2e
created: 2026-07-10
resolved: 2026-08-24
updated: 2026-08-26
refs: e2e/tests/scenarios/scheduled-visibility.spec.ts:103, e2e/tests/scenarios/scheduled-visibility.spec.ts:132, e2e/scenarios/steps.ts:3242
---

<!--
  FRONTMATTER DELIMITER RESTORED 2026-08-26. The closing `---` was missing after
  `refs:`, so scripts/issues.mjs parsed everything down to the stray `---` that
  used to sit below the paragraph as frontmatter - the HTML comment and the
  "Remaining scope" paragraph included. It survived only because no line in
  there happened to match `^word:`; any future body line starting `Note:` at
  column 0 would have become a bogus field.
-->
  TITLE CORRECTED 2026-08-21. It still advertised the DETERMINISTIC 08:00
  wall-clock failure, which `150fbfa4` closed on 2026-08-05 ("full-ladder
  assertions book a 14:00-local tour - kills the 00:00-08:00 wall-clock flake").
  The stale title actively misled a reader on 2026-08-21 into declaring that
  AGENTS.md's "re-run once" rule could never clear this issue - a claim that was
  wrong, and that came from reading the title instead of the body directly
  below it. Severity dropped med -> low to match the real remaining scope.
-->

**Remaining scope: a rare timing flake, and re-running IS the right response.**
Two sightings, 2026-07-10 and 2026-08-03, both a Reminders-panel rung not
visible inside its 10s budget under full-suite load, both on branches with zero
intersection with tours. Not reproduced since 2026-08-05 across a 204-pass gate
run and four per-file runs.

**Resolution (2026-08-24).** The remaining scope after the 08:00 half closed
was a rare confirmation-rung visibility race: two sightings (2026-07-10,
2026-08-03), and ZERO recurrences in the ~20 full gate runs since 2026-08-05 -
through the degraded-container era, the contention fixes, and two heavily
contended 2026-08-24 runs. This issue's own guidance was that re-running is
the correct response to what remained; what remains no longer occurs. REOPEN
on the signature (a Reminders-panel rung row invisible inside its 10s budget,
on a branch with no tours intersection) - and per the title's own history,
read THIS body before concluding anything from the title.


**Measurement (2026-08-23, `fix/test-hardening-wave2`).** Did NOT reproduce.
Two full `npm run e2e` runs on the same commit: 251 passed / 2 failed (21.5m)
then 253 passed (19.0m). This spec passed in BOTH, as did every other issue on
the C6/C11 flake list. The two failures in run 1 were different specs, both new
and both filed separately.

Deliberately NOT closed on that. Two green runs cannot prove an intermittent
failure absent, and this issue's own history is of a spec that passes repeatedly
and then does not. Recorded so the next person has a dated data point rather
than a re-measurement to redo - and note the DynamoDB Local contention that
several of these were filed under has since been fixed, so a recurrence now
means something different than it did before.


**Update (2026-08-05, feat/tour-reminder-details).** Status of the two halves:

- The DETERMINISTIC half (morning_of never armed before 08:00 org-local) was
  CLOSED before this branch: suggested fix (a) landed at `150fbfa4`
  (`tourScheduleFullLadder()` books Part A at 14:00 org-local, spec line :86).
  A morning_of failure in Part A is therefore a REAL regression now, not this
  issue.
- The CONFIRMATION-race half (2026-08-03 sighting) stays OPEN and is the only
  remaining scope. Not reproduced since: this branch's gate run (204 passed)
  and four per-file runs were all green.
- Refs refreshed: `expectReminderRung` moved to `e2e/scenarios/steps.ts:3242`;
  Part A rung asserts are `scheduled-visibility.spec.ts:103-106`, the
  post-tick asserts `:132-133`. Part A also now asserts the day_before rung's
  COMPOSED preview body (address + org-local time), added by
  feat/tour-reminder-details.

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

    "App: Reminders panel shows '4 hours before' as upcoming"   (spec line 98)
    [label renamed from 'Morning of', 2026-08-26]

An immediate ISOLATED re-run of the same file failed identically (4 passed,
1 failed, same rung). The app's own log gives the answer:

    "kind":"morning_of","dueAt":"2026-08-06T12:00:00.000Z",
    "msg":"tour reminder skipped (quiet-hours clamp lands at/past tour start)"

The rung is never armed, so no listitem exists and no wait strategy could ever
make the assertion pass. Mechanism (post quiet-hours, 2026-08-03):

- `bookedSelfGuidedTour` books the tour at `tourSchedule()` = **now + 48h**, so
  the tour's org-local TIME OF DAY equals the wall clock's time of day.
- `computeDueAt('morning_of')` was then **08:00 ORG-LOCAL on the tour's local
  day** (app/src/jobs/tourReminders.ts, the 4am-text fix), NOT `scheduled - Nh`.
- `armTourReminders` skip rule (b): `if (dueAt >= scheduledIso) continue`.

So whenever the suite ran between local **midnight and 08:00**, the tour landed
at (say) 02:07 local and morning_of landed at 08:00 local the SAME day - six
hours AFTER the tour start - and was correctly skipped. The run above was at
02:07 America/New_York. Outside that window the rung armed and Part A passed,
which is exactly why this read as an intermittent flake for a month: the
suite usually runs during the day.

The 2026-08-03 `Confirmation` sighting has a different shape (confirmation's
dueAt is arm-time `now`, which rule (b) cannot skip), so that one may still be
a genuine race - keep this issue open for both.

**THE MECHANISM ABOVE IS HISTORY, AND THE ROLES ARE NOW REVERSED (2026-08-26,
`feat/tour-reminder-ladder`).** Read the four paragraphs above as a record of
what happened on 2026-08-04, not as current behaviour:

- `morning_of` is no longer anchored to 08:00 org-local. It is a pure
  `scheduledAt - 4h` OFFSET, so it can never land after the tour start and the
  midnight-to-08:00 failure band described above cannot recur for that rung.
  The quoted log line at the top of this sighting is preserved as evidence and
  is no longer reproducible.
- `day_before` took over the wall-clock sensitivity: it is now anchored to
  **19:30 org-local the evening before** the tour's local date. It is the rung
  whose presence depends on the wall clock the suite runs at, and on the org's
  quiet window (an org whose window contains 19:30 retires every `day_before`
  as superseded, with a warn naming the cause).
- Two new arm-time rules retire `day_before` and `morning_of` as VISIBLE
  `booked_too_late` rows when a tour is booked too close to them, so a
  short-horizon booking now produces MORE rows, not fewer.
- The operator label for `morning_of` is `4 hours before`, not `Morning of`.

**Suggested next step (spec-side, NOT product-side - the skip is correct
behavior). REWRITTEN 2026-08-26; the original (b) is now backwards.** Part A's
tour is already booked at a fixed org-local afternoon time (`150fbfa4`, option
(a) below), which is what closed the deterministic half. What remains, if this
ever reopens: (a) keep booking Part A at a fixed org-local afternoon time rather
than `now + 48h`, so every rung is armable at any wall clock; and (b) if a rung
assertion has to be dropped for wall-clock dependence, it is the `day_before`
one - NOT `morning_of`, which is now a pure offset - and the right fix there is
the one Task 9 of the ladder change shipped: read the ARMED `dueAt` back from
the reminders API and drive the tick from that, rather than computing 19:30
host-side. Owner = scheduled-visibility / quiet-hours. Deliberately NOT changed
by the contact-comms-pane branch (different feature, judgment call).
