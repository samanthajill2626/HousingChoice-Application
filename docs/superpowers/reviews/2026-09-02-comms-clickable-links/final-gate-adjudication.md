# Final gate adjudication

## Final synchronized commit

The final code gate run was made after `d7bd29e0` merged local `main`
`d4298abe` into `feat/comms-clickable-links`. The merge had no conflict.

## Required gate evidence

- `npm run typecheck`: exit 0.
- `npm test`: exit 0. App: 359 files and 6741 tests; dashboard: 188 files and
  3030 tests; e2e unit: 20 files and 496 tests; fake Twilio: 34 files and 245
  tests; fake Twilio web: 13 files and 111 tests.
- `npm run smoke`: exit 0; "1396 import specifier(s) across 246 emitted file(s)
  resolve under plain Node."
- `npm run e2e`: exit 1, with 266 passed and one failure in
  `e2e/tests/dashboard-next/outbound-mms.spec.ts`. The failure was an existing
  outbound-MMS viewer test path, outside the feature's changed paths.
- Touched-file ESLint: raw exit 1 because `Timeline.tsx` has a pre-existing
  `react-hooks/set-state-in-effect` finding. The same finding is present at the
  recorded base (base line 1324; feature branch line 1328 only because the
  feature adds four earlier lines). Therefore the touched-line lint ratchet has
  no new errors.

## E2E attribution

The full suite's outbound-MMS failure was `trigger is not visible` while the
test arranged viewer scroll state. It is not reproducible in two independent,
hermetic focused runs on the synchronized feature branch:

- run 1: exit 0, 6 passed in 46.1 seconds;
- run 2: exit 0, 6 passed in 44.9 seconds.

The same file at original base `b45e6fdca1ca9fc986df02e9d7b768c6aad1de19`
fails independently (exit 1, 5 passed) in its viewer baseline assertion:
expected Timeline scroll top 512, received 500. That baseline symptom is
already described by the resolved
`docs/issues/e2e-image-viewer-scroll-flake.md` record. The current full-suite
trigger-visibility result is distinct, but it has no focused reproduction and
the feature does not change the outbound-MMS spec.

## Ruling

Do not treat either raw red result as a new feature defect: the E2E file is
red at base and green twice in isolation on the synchronized branch, while the
sole lint finding is exactly baseline. The final handback must retain both raw
exit codes and this evidence; it must not call either command green.
