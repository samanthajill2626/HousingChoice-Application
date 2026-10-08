---
id: e2e-blank-document-after-contact-navigation
title: Full browser gate stalls on a blank document after contact navigation
type: bug
severity: med
status: open
area: e2e/navigation
created: 2026-10-08
refs: e2e/scenarios/steps.ts:1411, e2e/tests/scenarios/landlord-onboarding.spec.ts:119
---

**Problem.** A complete Caseworkers browser gate on implementation e0da8da3 finished 336 passed / 1 failed. The landlord onboarding scenario waited 100000 ms for Mark as Landlord after reloading its already-resolved contact. The saved screenshot is an entirely white document, not a rendered contact of the wrong kind. All eight preceding scenario steps total 2338 ms; the triage step alone lasted 101154 ms. No classification PATCH was reached.

**Evidence.** The last preceding contact/timeline requests completed, then SSE disconnected. The server log contains no fresh browser auth/API request before the timeout. This supports localization to navigation/app bootstrap, but does not establish document delivery, module delivery, module evaluation, browser state, or a root error as the cause. The failing run had screenshot/video but no browser trace because retries are zero and normal capture was on-first-retry. Video has not been decoded. See [the committed diagnosis](../superpowers/reviews/2026-10-07-caseworkers/landlord-gate-diagnosis.md) for exact references and limitations.

**Comparison.** The unchanged failing file passed 7/7 on the feature source in 45.3s, then 7/7 on detached synced main d8749158 in 42.0s. Both used `npm run e2e -w @housingchoice/e2e -- tests/scenarios/landlord-onboarding.spec.ts --trace on`. The feature branch was restored exactly afterward. These isolated passes do not establish a base failure, a known flake, or root cause, and do not replace the required full gate. Full-run rerun evidence belongs in the mission's completion-gates-r2 record when complete.

**Preserved local artifacts.** In W:/tmp/caseworkers:

- `.superpowers/sdd/gates/FINAL2-e2e.{log,exit,result.json}` and `gates/artifacts/FINAL2-e2e-red-2026-10-08T21-29-29-480Z/` under `.superpowers/sdd/`.
- `.superpowers/sdd/checkpoints/FINAL2-landlord-isolated.{log,exit,command.json}`; preserved traces under `.superpowers/sdd/gates/artifacts/FINAL2-landlord-isolated-green-2026-10-08T21-31-45-682Z/`.
- `.superpowers/sdd/checkpoints/FINAL2-landlord-baseline.{log,exit,command.json}`; preserved traces under `.superpowers/sdd/gates/artifacts/FINAL2-landlord-baseline-green-2026-10-08T21-39-05-154Z/`.

**Next discriminator.** Retain a trace on a recurrence (`E2E_TRACE=1`), inspect the final document URL/status/body, main module and dependency outcomes, console errors, and whether /auth/me was attempted. Do not add child-log piping to this timing investigation or raise the test budget without evidence. Do not conflate this signature with placement-detail-bundle-fetch-stall. No production patch is justified by the current evidence alone.
