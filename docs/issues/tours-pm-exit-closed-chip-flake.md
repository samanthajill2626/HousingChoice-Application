---
id: tours-pm-exit-closed-chip-flake
title: "tours.spec.ts:152 PM-team exit-NO: 'Closed' header chip not visible within the 30s test budget (intermittent, passes solo)"
type: bug
severity: low
status: open
area: e2e
created: 2026-07-21
refs: e2e/tests/scenarios/tours.spec.ts:152
---

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
  matching-entry-points-picker-click-flake and tour-reminders-panel-e2e-flake.

**Suggested fix.** If it recurs: check whether the close-tour transition's
chip render is waiting on an SSE/refetch that deserves an explicit wait in the
step helper, or simply extend that expect's timeout past the suite's 30s
budget with test.slow().
