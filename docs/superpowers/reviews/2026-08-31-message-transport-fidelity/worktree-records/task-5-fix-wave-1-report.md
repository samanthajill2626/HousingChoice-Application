# Task 5 fix wave 1 report

## Commit

`439621a4 fix: preserve Relay preflight exclusions`

## Shipped

- Split the full sender-excluded current roster from a continuation's send roster.
  Versioned preflight now reconciles stale removed members only against the full
  current roster, while initialization, rejoin handling, and provider sends use
  the continuation-filtered set.
- Limit excluded-to-planned reopening to never-attempted, non-suppressed slots.
  A `failed` / `contact_opted_out` excluded slot retains its status, request, and
  error and never reaches provider handling.
- Added deterministic regressions for the continuation-omitted current member,
  preserved suppression, and valid non-suppressed rejoin path.
- The schema-absent branch was not changed; its existing continuation and held
  release regressions remain green.

## TDD proof

- RED: `npm run test -w @housingchoice/app -- test/relayFanOut.test.ts` exited 1
  with exactly the two new regressions failing: Carol was incorrectly changed to
  `excluded`, and Bob's suppressed slot was incorrectly changed to `planned`.
  The initial sandbox run encountered the brief's known Vite `.vite-temp` EPERM;
  the allowed execution environment produced the deterministic red result.
- GREEN: the same command exited 0: `1 passed`, `44 passed`.

## Verification

- `npm run typecheck -w @housingchoice/app`: exit 0.
- `git diff --check`: exit 0 before commit.
- No merge in progress before commit.
