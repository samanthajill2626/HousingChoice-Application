---
id: e2e-blank-first-paint-at-sign-in
title: One e2e sign-in rendered a blank page for the full 15 s readiness budget (dev-server first paint), once in 4 full runs - evidence kept, not reproducible
type: bug
severity: low
status: open
area: e2e
created: 2026-10-07
refs: e2e/support/today.ts:44, e2e/tests/dashboard-next/placements-page.spec.ts:281, scripts/e2e-session.mjs:462
---

**Problem.** In the final gate run of `feat/clean-org-names` (tip 2dca0cf3, 2026-10-07
09:37, lane 13, 1 worker), test 153 `placements-page.spec.ts:281 mobile: the "Move to"
stage menu fits the window and scrolls internally` failed in its SIGN-IN step:
`expectTodayReady` (`e2e/support/today.ts:44`) waited 15 s for the Today heading after
"Continue as dev user" and the page never rendered. The failure screenshot is a completely
blank white viewport (390 x 844) - no app frame, no sidebar, no login page - and the
error-context snapshot holds no page tree. Everything around it was healthy:

- test 152, the same test at desktop width, signed in and passed 1.2 s earlier; test 154,
  the next mobile test with the same `devLoginAndReset`, passed 1.1 s later;
- the app server logged no error or warning in that window (only a routine
  `group_inbound_heartbeat_quiet`), and answered the dev-login requests;
- no other test in the run took more than 15 s; the run was 22.0 min against 19.9 min
  for the same suite on the previous tip;
- the same test passed on the previous tip (1.0 s), in the build's own gate run
  (850 ms), and alone on the failing tip (`npx playwright test
  tests/dashboard-next/placements-page.spec.ts`: 11 passed, this test 1.2 s);
- the commits between the two full runs touch no file on the Today page's path (a
  Settings CSS module, copy strings, the org-name normalizer the pickers import, a
  CLI script) - a module-level fault would have failed every test, not one.

So the browser got nothing to paint from the Vite dev server (`scripts/e2e-session.mjs:462`
serves source live, no build) for one fresh context and recovered by the next test. One
sighting in four full runs of this suite on 2026-10-06/07.

Evidence (gitignored run state, kept while the worktree exists): the full gate log
`W:\tmp\clean-org-names\.superpowers\sdd\final2-g4.log` and the extracts in
`.superpowers\sdd\final2-g4-failure\` (the error block and the neighbouring test lines).
The screenshot (viewed: blank white) and the video were cleared by the isolated re-run
before they could be copied - Playwright empties `e2e/.artifacts/test-results` at each
start, so on a recurrence copy that folder BEFORE any re-run.

**Second sighting, same day (2026-10-07 ~11:40, merged tip 98971183, lane 13).** Test 324 of
329, `tours.spec.ts:407` (the page-arc scenario), failed at its sign-in `page.goto` with
`net::ERR_NO_BUFFER_SPACE` - Windows refused to open the socket (WSAENOBUFS: the system lacked
buffer space or an ephemeral port). The run was the machine's FIFTH full e2e run of the day
beside four full `npm test` runs and a parallel mission's gates, each opening tens of
thousands of short-lived connections. That names the likely cause of the morning's blank
page too: a navigation whose connection never opened paints nothing, and Playwright reports
it as "element not found" when the page stays empty. Treat both as one environmental class
- socket/port exhaustion late in a long run on a heavily used machine - not as a spec or
branch regression. Artifacts kept this time: `.superpowers/sdd/final4-g4-failure/`.

**Suggested fix.** Nothing to fix in the suite from two sightings; the cure is
operational: let the sockets drain (Windows holds TIME_WAIT for 120 s) before another full
run, and avoid stacking several full gate runs back to back on one machine. Check
`Get-NetTCPConnection | Group-Object State` before a re-run; a TIME_WAIT count in the
thousands or a dynamic-port pool near exhaustion (`netsh int ipv4 show dynamicport tcp`)
means wait. If it recurs with a healthy socket table, read the Vite child's stdout with
`E2E_CHILD_LOG_DIR` set (a content question). On a recurrence: keep the video (it
shows whether the dev-login click navigated at all), read the Vite child's stdout with
`E2E_CHILD_LOG_DIR` set (a content question, so the flag is appropriate - AGENTS.md), and
check whether the blank context coincides with a Vite dependency re-optimization or a
full-reload message. If it recurs at mobile widths only, look at the viewport change
before `page.goto`. Do not add this to any re-run list: a sign-in that paints nothing is
a dev-server event, and `reuseExistingServer`'s commit-match adoption means a stale
orphaned stack would show the same symptom - check for one first.

**Third sighting (2026-10-12 ~23:30 EDT, Windows, `fix/caseworker-integrity` @6b220900,
lane 6).** The branch's FINAL gate run (its fourth full e2e of the evening, on a machine
also running other missions' gates) finished 344 passed / 2 failed in 27.9 min against
22.0-22.5 min for the three earlier full runs, which were 345/345. One failure is this
signature: `tests/dashboard-next/inbox-comms.spec.ts:20` waited the whole 60 s test
budget for "Continue as dev user" at sign-in; the screenshot is an entirely white
document. Socket table right after: 2672 TIME_WAIT, 302 established (dynamic pool
16384). The other failure is the contact-navigation twin
(`e2e-blank-document-after-contact-navigation`, third sighting). Artifacts copied before
any re-run: `W:\tmp\caseworker-integrity\.superpowers\sdd\logs\p6-e2e-artifacts\`
(screenshots, videos, error contexts). Isolation and the clean re-run are recorded in
`docs/superpowers/reviews/2026-10-12-caseworker-integrity/handback.md`.

**Fourth sighting (2026-10-19 ~01:45 EDT, Windows, `feat/matching-blast-rules` @994be540,
lane 10).** Same final gate run as the contact-navigation twin's eleventh sighting (361
passed / 2 failed, 21.9 min): `tests/scenarios/post-tour-application.spec.ts:270`, step
"App: the voucher deadline surfaces on the Today board", stopped in `expectTodayReady`
(`e2e/support/today.ts:44`, via `e2e/scenarios/steps.ts:3118`) - the Today heading never
rendered in 15 s; the screenshot is an entirely white page. No `net::ERR_*` line in the run
log; 2127 TIME_WAIT sockets right after the run. The file passed in isolation (5/5; with
`settings.spec.ts` in the same isolation run, 8/8 in 57.7 s), and the full re-run of the same commit passed 363/363.
Artifacts: `W:\tmp\matching-blast-rules\.superpowers\gates\final\e2e-artifacts\`.

**Fifth and sixth sightings (2026-10-19, Windows, `feat/matching-blast-rules`, lane 10).**
Run `fw2` on e1c2bbe8 (09:46-10:14 EDT; 1 failed / 362 passed, 24.9 min, overlapping a
reviewer's single-file vitest runs): `tests/tour-roster.spec.ts:183` waited 3 min for
"Continue as dev user" on an entirely white page. Run `final2-e2e-2` on 4f608a40 (11:04-11:30
EDT, `E2E_TRACE=1`): `tests/scenarios/tenant-onboarding.spec.ts:159` waited 100 s for the
same button, white page. Both are the sign-in face of the port-exhaustion mechanism the
contact-navigation twin's twelfth/thirteenth sightings caught in the log (`[vite] http proxy
error ... connect EADDRINUSE 127.0.0.1:10001`). The next full run of 4f608a40 passed 364/364.
Artifacts: `W:\tmp\matching-blast-rules\.superpowers\gates\fw2\e2e-artifacts\`,
`...\final2-e2e-2\e2e-artifacts\` (with a trace).

**Seventh sighting (2026-10-20 ~10:51 EDT, Windows, `fix/voucher-size-prompt` @1c8d2380,
lane 7).** The branch's first full gate run, after a full `npm test` on the same machine:
364 passed / 1 failed in 20.4 min. `tests/flows/voice-extraction.spec.ts:155` waited the
whole 60 s test budget for "Continue as dev user"; the screenshot is an entirely white
page. The test before it in the same file had signed in and passed 815 ms earlier. No
`net::ERR_*` or EADDRINUSE line in the run log (only the routine startup `/__dev/ping` proxy
error); 2541 TIME_WAIT sockets right after the run. The branch changes only extraction
prompt text, a CLI script and unit tests - the e2e stack runs the fake extraction driver,
which takes only the prompt's fingerprint, never its text, and the failure came before
any extraction step. The file passed in isolation (4/4, this test 964 ms).
Artifacts: `W:\tmp\voucher-size-prompt\.superpowers\gates\e2e-artifacts\`.
The full re-run of 452189c0 (Cameron asked for `db:stop`/`db:start` and
`s3:stop`/`s3:start` first; 1110 TIME_WAIT at its start, no other test runner on the
machine) passed 365/365 in 19.5 min - yet still logged one `[vite] http proxy error:
/api/tours/<id>/activity` with `connect EADDRINUSE 127.0.0.1:9701` about 17 min in (that
test recovered and passed), and 3687 TIME_WAIT right after. So the connect failures come
from churn WITHIN one run, not from state left by earlier runs or the containers: a
restart cannot prevent them. The residual browser -> Vite and Vite -> app connection churn
the 2026-09-30 proxy keep-alive fix left unchased is the lead.

**Measured diagnosis (2026-10-20).** The churn is measured and attributed in
`docs/superpowers/reviews/2026-10-20-e2e-connection-churn/diagnosis.md`: 96% of a full
run's ~24,000 short-lived loopback connections are browser -> Vite and Vite -> app, each
closed because the browser cancelled an API request that was already on the wire, and 81%
of those cancels are React StrictMode's dev double mount. A NetLog of a green 70-test run
caught a browser connect failing with WSAEADDRINUSE at only 2,890 TIME_WAIT, so these
failures need no exhausted pool. Proposed fix (awaiting Cameron's go): defer a signalled
fetch's dispatch one microtask in `dashboard/src/api/client.ts`.
**Eighth sighting**, in that work (full `npm run e2e` with the measurement hook, main
1d7a4667, lane 4, 364 passed / 1 failed, 20.9 min):
`tests/dashboard-next/maintenance-page.spec.ts:22` "502 GET recovers with GET home at width
320" waited 15 s for "Sign in with Google" after the maintenance page's home link; entirely
white page. Vite served the document and 9 modules in 15 ms, then the browser never asked
for `react-dom_client.js` and the app saw no request; ~2,000 TIME_WAIT at that moment. That
spec intercepts requests with `page.route`, which cannot be excluded for this one.
