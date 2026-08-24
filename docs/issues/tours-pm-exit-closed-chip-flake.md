---
id: tours-pm-exit-closed-chip-flake
title: "tours.spec.ts:152 PM-team exit-NO: 'Closed' header chip not visible within the 30s test budget (intermittent, passes solo)"
type: bug
severity: low
status: resolved
area: e2e
created: 2026-07-21
resolved: 2026-08-24
refs: e2e/tests/scenarios/tours.spec.ts:152
---

**Resolution (2026-08-24): contention-pair era, one sighting, five weeks of
clean runs since.** Filed 2026-07-21 as half of the documented "contention
pair"; the header 'Closed' chip is an SSE/refetch-driven render whose 30s
budget only ever lost on that era's machines. Zero recurrences across every
measured full run since - the 2026-08-23 pair and the 2026-08-24 runs
including two heavily contended ones - and the DynamoDB Local contention that
defined its era is fixed and soak-validated. REOPEN on the exact signature
(the header-scoped 'Closed' text invisible for 30s post-transition), and note
the keep-alive hardening (2026-08-24) also removed the strongest cause of a
stuck post-transition refetch.


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


**Observation (2026-07-21, during the unit-photo-transcode final gate battery).**
One full-suite run failed exactly this test:

    PM-team: same shape with the PM in the landlord slot -> exit NO
    Test timeout of 30000ms exceeded.
    expect(locator).toBeVisible() failed
    Locator: locator('header').filter({ hasText: 'Tour -' }).getByText('Closed', { exact: true })

Provenance points at a load-sensitive flake, not a regression:
- Same commit (f16285d4): the file passes 8/8 in a solo 2-file run minutes later
  (alongside matching-entry-points, 11/11 total).
- An earlier full-suite run of the same feature branch passed this test.
- The unit-photo-transcode diff touches photo upload/transcode surfaces only -
  no tours, placements, or status-chip code.
- The box carried a concurrent persistent e2e-session stack (another agent)
  during the failing run - the same contention pattern as
  matching-entry-points-property-first-e2e-flake and
  tour-reminders-panel-e2e-flake.

**Suggested fix.** If it recurs: check whether the close-tour transition's
chip render is waiting on an SSE/refetch that deserves an explicit wait in the
step helper, or simply extend that expect's timeout past the suite's 30s
budget with test.slow().
