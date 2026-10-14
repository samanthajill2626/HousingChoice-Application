---
id: e2e-page-blank-spa-never-boots
title: A full-suite e2e navigation can leave the page blank with the SPA never booting (zero app requests)
type: bug
severity: low
status: open
area: e2e
created: 2026-10-13
refs: e2e/tests/scenarios/tours.spec.ts:217, e2e/scenarios/steps.ts:3858
---

**Sighting (2026-10-13, feat/last-heard-from @b8dc2181, full `npm run e2e`,
test 349 of 359).** `tours.spec.ts:217` ("self-guided: windows 1:1 ...") timed
out after 100s at its "Team offers tour windows" step: `page.goto` to
`/contacts/<id>` returned, then `getByRole('textbox', { name: 'Reply message' })`
never appeared. The failure screenshot is a completely BLANK page.

**Why it reads as environmental, not a code regression.**
- The app server log shows ZERO requests after the navigation: no `/me`, no
  `/config.json`, no contact reads - although every full navigation in the run
  (including the one two seconds earlier on the same test) calls `/me` and
  `/config.json` first. The dashboard bundle never ran, so no route or feature
  code executed.
- The 10 tests that ran after it on the same stack (350-359) all passed.
- The file passed in isolation right after (9/9, the scenario in 7.0s), and the
  same spec passed in an earlier full run of the same feature branch (359/359).
- No Vite message (dependency re-optimization, reload) was logged near it.

**What would decide it next time.** A TRACE: with `retries: 0` and
`trace: 'on-first-retry'` the gate run collects no network data, so whether the
document or a module request to the Vite server (lane web port) stalled cannot
be told from the artifacts. If it recurs, capture the browser's network log for
the stuck navigation (or run with `trace: 'retain-on-failure'`).

Artifacts of the sighting (gitignored, worktree-local):
`W:\tmp\last-heard-from\.superpowers\sdd\e2e-runs\final-20261013-190830\`.

**Artifacts moved (2026-10-13).** The feat/last-heard-from worktree was retired after
its merge. The run cited above is preserved at
`W:\tmp\_preserved-artifacts\last-heard-from-20261013\.superpowers\sdd\e2e-runs\final-20261013-190830\`,
with a SHA-256 manifest at `W:\tmp\_preserved-artifacts\last-heard-from-20261013\MANIFEST.sha256`
(13 files; paths relative to the run folder).
