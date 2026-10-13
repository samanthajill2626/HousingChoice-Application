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

**Third sighting (2026-10-12, Windows, feat/join-housing-authority @67cd745c).** A full
gate run (`timeout 2700 npm run e2e`, no trace) finished 339 passed / 1 failed in 21.9m:
`tests/scenarios/landlord-onboarding.spec.ts:190` ("inbound text -> not a fit ->
parked"), step "App relays the lead to Team (Unknown tab, by phone)"
(`e2e/scenarios/steps.ts:627`) waited 15 s for the Unknown tab's link to the new
contact's phone after `page.goto('/contacts/unknown')`; the screenshot is an entirely
white document. The branch touches neither that page nor that flow. The file passed
alone on the same tree right after (7/7, 47.0s, the test 5.2s, `E2E_TRACE=1`).
Artifacts (screenshot, video, error-context) kept in that worktree under
`.superpowers/sdd/e2e-results-run1/`. Same signature, third scenario. Record:
`docs/superpowers/reviews/2026-10-12-join-housing-authority/code-review/R1-adjudications.md`.

**Fourth sighting - WITH A TRACE (2026-10-12, Windows, feat/join-housing-authority @83766228,
`E2E_TRACE=1 timeout 2700 npm run e2e`).** 339 passed / 1 failed (29.3m):
`tests/scenarios/landlord-onboarding.spec.ts:230` ("property intake ..."), step "App:
landlord lead is interested" (`e2e/scenarios/steps.ts:1478`) - after a `page.goto` back to the
contact page, the Details section never rendered; the screenshot is an entirely white
document. The file passed alone right after (7/7, 1.0m, the test 5.9s). The retained trace
(kept in that worktree at `.superpowers/sdd/e2e-results-fw1/scenarios-landlord-onboard-94546-...-chromium/trace.zip`)
answers the issue's next discriminator:
- the document for `/contacts/<id>` loaded 200 and its module graph started loading;
- ONE module request, `GET /src/api/index.ts` (Vite dev server, the lane's dashboard port),
  FAILED (status -1), and the console logged
  `Failed to load resource: net::ERR_NO_BUFFER_SPACE` at that moment;
- no `/auth/me` or API request followed - a failed static import stops the whole module
  graph, so React never mounted: the blank document.
`ERR_NO_BUFFER_SPACE` is Windows WSAENOBUFS (the socket layer is out of buffer space or
ephemeral ports). A dev-mode page load is about 1650 unbundled requests here, the suite runs
for 25+ minutes, and other worktrees' suites share the machine; right after the isolated
re-run `netstat -ano` counted 1928 sockets in TIME_WAIT. Leading hypothesis, not yet
proven: socket/ephemeral-port exhaustion on the Windows host under sustained dev-server load
makes one module fetch fail, which blanks the page. It fits all four sightings (different
scenarios, same signature, never on Linux, never alone). Next: on a recurrence, read the
trace's failing request and console line first; consider measuring TIME_WAIT/ephemeral-port
use during a full run, and whether keep-alive between Chromium and Vite (and Vite's proxy,
see the vite-proxy-keepalive history) reduces the churn. No production code is implicated.

**Fifth and sixth sightings - both with traces, same mechanism (2026-10-12, Windows,
feat/join-housing-authority @0f589643, the next full gate run, 338 passed / 2 failed, 30.6m).**
`tests/dashboard-next/pool-numbers-admin.spec.ts:132` (a VA opening Today right after
dev-login - so not only contact navigation) and `tests/scenarios/sending-unit.spec.ts:102`
(a `page.goto` to a contact page). In each trace exactly one module request failed with
status -1 and the console logged `net::ERR_NO_BUFFER_SPACE` at that instant -
`/node_modules/.vite/deps/react-router-dom.js` in the first, `/src/app/EnvironmentIdentity.tsx`
in the second - and nothing rendered. Both files passed alone right after (4/4, 47.4s).
Socket state on the host: 3662 sockets in TIME_WAIT just after the run (TCP dynamic range
49152 + 16384), most of them toward this lane's dashboard and app ports (9411, 9401) and
another worktree's lane running at the same time (10411, 10401); they drained below 600
within about 4.5 minutes. The signature is broader than the title: any dev-mode page load
whose module graph loses one fetch to WSAENOBUFS goes blank. Retitling is left to whoever
picks the issue up.
