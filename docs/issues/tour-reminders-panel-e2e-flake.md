---
id: tour-reminders-panel-e2e-flake
title: "scheduled-visibility.spec.ts Part A (Reminders panel armed ladder) failed once intermittently after the c7c33a9 self-update change"
type: bug
severity: low
status: open
area: e2e
created: 2026-07-10
refs: e2e/tests/scenarios/scheduled-visibility.spec.ts:85, e2e/tests/scenarios/steps.ts:2962
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

**Suggested next step.** Owner of c7c33a9: re-check the Part A wait strategy
(is the assert racing the panel's own refresh?) and consider waiting on the
API state or a stable panel signal before asserting the row. If it never
recurs, close as one-off after a few more suite runs.
