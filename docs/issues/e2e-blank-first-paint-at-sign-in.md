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

**Suggested fix.** Nothing to fix from one sighting. On a recurrence: keep the video (it
shows whether the dev-login click navigated at all), read the Vite child's stdout with
`E2E_CHILD_LOG_DIR` set (a content question, so the flag is appropriate - AGENTS.md), and
check whether the blank context coincides with a Vite dependency re-optimization or a
full-reload message. If it recurs at mobile widths only, look at the viewport change
before `page.goto`. Do not add this to any re-run list: a sign-in that paints nothing is
a dev-server event, and `reuseExistingServer`'s commit-match adoption means a stale
orphaned stack would show the same symptom - check for one first.
