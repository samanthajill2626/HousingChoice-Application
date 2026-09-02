# Task 11 fix-wave 2 report

## Scope and closure

- Corrected collapsed recipient-summary accessibility so the parent
  `transport_schema_version` gates transport facts in both rollup and all-opted-out
  chip names. Schema-absent Relay and native Group rows now retain exact legacy
  copy; version-1 unresolved recipient facts retain `Unknown`.
- Replaced the stale inbound Relay no-list assertion with progressive recipient
  disclosure of the available outbound leg. This confirms the already-approved
  rendering and introduces no new production behavior.
- No e2e, route, or unrelated scope changes.

## TDD evidence

- Initial requested focused run inside the sandbox stopped before tests with a
  Vite temporary-config `EPERM`; rerunning the identical command with normal
  worktree filesystem access reached the tests.
- Red: `npm run test -w @housingchoice/dashboard -- src/routes/contact/Timeline.test.tsx src/routes/contact/Timeline.delivery.test.tsx` exited 1: 2 files failed, 5 tests failed, 152 passed, 157 total. The failures proved the legacy collapsed names appended `Unknown`; the rewritten inbound Relay disclosure assertion passed against existing approved rendering.
- Green: the identical focused command exited 0: 2 files passed, 157 tests passed.
- `npm run typecheck -w @housingchoice/dashboard` exited 0.
- `git diff --check` exited 0 before commit.

## Files and commit

- `dashboard/src/routes/contact/Timeline.tsx`
- `dashboard/src/routes/contact/Timeline.test.tsx`
- `dashboard/src/routes/contact/Timeline.delivery.test.tsx`
- `6270d2cb fix: align recipient transport accessibility`
