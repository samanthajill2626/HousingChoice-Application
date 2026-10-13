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

**Comparison.** The unchanged failing file passed 7/7 on the feature source in 45.3s, then 7/7 on detached synced main d8749158 in 42.0s. Both used `npm run e2e -w @housingchoice/e2e -- tests/scenarios/landlord-onboarding.spec.ts --trace on`. The feature branch was restored exactly afterward. These isolated passes do not establish a base failure, a known flake, or root cause, and do not replace the required full gate. The unchanged-source full rerun subsequently passed 337/337 in 23.2m (EXIT 0), including this scenario in 8.2s, with E2E_TRACE=1. Both full runs and all comparisons are recorded in [completion-gates-r2](../superpowers/reviews/2026-10-07-caseworkers/completion-gates-r2.md). The cause remains unresolved; this issue stays open.

**Preserved local artifacts.** In W:/tmp/caseworkers:

- `.superpowers/sdd/gates/FINAL2-e2e.{log,exit,result.json}` and `gates/artifacts/FINAL2-e2e-red-2026-10-08T21-29-29-480Z/` under `.superpowers/sdd/`.
- `.superpowers/sdd/checkpoints/FINAL2-landlord-isolated.{log,exit,command.json}`; preserved traces under `.superpowers/sdd/gates/artifacts/FINAL2-landlord-isolated-green-2026-10-08T21-31-45-682Z/`.
- `.superpowers/sdd/checkpoints/FINAL2-landlord-baseline.{log,exit,command.json}`; preserved traces under `.superpowers/sdd/gates/artifacts/FINAL2-landlord-baseline-green-2026-10-08T21-39-05-154Z/`.

**Next discriminator.** Retain a trace on a recurrence (`E2E_TRACE=1`), inspect the final document URL/status/body, main module and dependency outcomes, console errors, and whether /auth/me was attempted. Do not add child-log piping to this timing investigation or raise the test budget without evidence. Do not conflate this signature with placement-detail-bundle-fetch-stall. No production patch is justified by the current evidence alone.

**Planner review data point (2026-10-09).** Not recurred: a supplementary full
browser run on Linux (Chromium 141 substituted for the pinned build, local
harness patches; not a gate run) passed 337/337 and this scenario in 18.7s.
Non-reproduction only; the cause stays unresolved. See
`docs/superpowers/reviews/2026-10-07-caseworkers/planner-final-review.md`
section 3.3.

**Second sighting (2026-10-11, Windows, pinned Chromium 149, @e77fc543).** A
full gate run on a freshly restarted stack finished 337 passed / 1 failed:
`tests/scenarios/post-tour-application.spec.ts:249` waited 15 s for the
contact Details section's "Searching"; the screenshot is an entirely white
document and the page snapshot is empty. The same scenario passed in an
earlier full run that day; its file passed alone 3/3 (5/5 each) and the test
alone 1/1 (13.2 s). No trace (the gate does not set `E2E_TRACE=1`);
screenshot and video kept on Cameron's machine. Different scenario from the
first sighting, same signature: a blank document after contact navigation.
Record: `docs/superpowers/reviews/2026-10-07-caseworkers/windows-gates-2026-10-11.md`.

**Third sighting (2026-10-12 ~23:40 EDT, Windows, `fix/caseworker-integrity` @6b220900,
lane 6).** The same final gate run (344 passed / 2 failed, 27.9 min on a busy machine;
the three earlier full runs that evening were 345/345 in about 22 min):
`tests/scenarios/approval-and-move-in.spec.ts:242`, step "Team moves the placement ->
Lost", stopped on "the placement page did not finish loading (waited 20007ms of a 20s
budget)"; the screenshot is an entirely white document - a placement page this time,
not a contact page, so the signature is "a blank document after an in-app navigation".
The run's other failure was the sign-in twin (`e2e-blank-first-paint-at-sign-in`, third
sighting); 2672 TIME_WAIT sockets right after. Artifacts:
`W:\tmp\caseworker-integrity\.superpowers\sdd\logs\p6-e2e-artifacts\`. Isolation and the
clean re-run are recorded in the caseworker-integrity handback.
