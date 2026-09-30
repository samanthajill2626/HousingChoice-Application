# Gate runs - feat/today-past-tours

All five completion gates, run bare from `W:\tmp\today-past-tours` by a
detached script (one gate after another, exit codes captured; logs in the
worktree's gitignored `.superpowers/sdd/gates*/`). Main did not move during the
mission (f93b7381 is the merge base and still main's tip), so no sync was
needed.

## Final run - HEAD d40d02ed (2026-09-30 13:07-13:30)

| Gate | Exit | Reading |
|---|---|---|
| 1 `npm run typecheck` | 0 | clean |
| 2 `npm test` | 1 | ONE failing file: `e2e/support/maintenancePage.test.ts` (2 cases) - "Terraform >=1.15 must be on PATH. spawnSync terraform ENOENT". Terraform is not installed on the new PC; the file is untouched by this branch. Everything else green: app 399 files / 8109 tests, dashboard 211 / 3593, e2e workspace 20 of 21 files / 497, two small workspaces 34 / 275 and 13 / 111. No `[dynamoAdmin]` line. |
| 3 `npm run smoke` | 0 | clean |
| 4 `npm run e2e` | 1 | 292 passed, 6 failed, 7 did not run (19.4 min). The new `today-past-tours.spec.ts` PASSED in the full suite. Failures: maintenance-page (Terraform, as above), contact-create:157, and four late scenarios (participant-names:21, post-tour-application:107 and :183, sending-unit:76) during a stretch where the dashboard's proxy logged `connect EADDRINUSE 127.0.0.1:9401` - see the comparison below. |
| 5 `npx eslint <branch files>` | 1 | 6 errors, ALL pre-existing: each is present, at the same line, when main's copy of the file is linted (baseline by `git show main:<file> \| npx eslint --stdin`): `useToday.test.tsx:4` x2 (unused type imports), `collect.test.ts:1218` x2 (unused args), `TourDetail.tsx` (react-hooks/purity, main line 304), `useTours.ts:126` (set-state-in-effect in useClosedTours). The branch adds none. |

## e2e: four full runs compared by failing FILE

| Run | Passed | Failed files (besides maintenance-page) | Socket errors seen |
|---|---|---|---|
| Branch @82ea97a3 | 292 | a2p-compliance, contact-create, landlord-onboarding, scenarios/tours (x2) | `net::ERR_ADDRESS_IN_USE` (browser) |
| Branch @d955c00f | 293 | contact-detail, approval-and-move-in, post-tour-application (x2) | `net::ERR_ADDRESS_IN_USE` (browser) |
| **main @f93b7381 (baseline, separate worktree)** | 292 | recording-range, participant-names, post-tour-application (x2) | `net::ERR_ADDRESS_IN_USE`, `net::ERR_NO_BUFFER_SPACE` (browser) |
| Branch @d40d02ed (final) | 292 | contact-create, participant-names, post-tour-application (x2), sending-unit | `connect EADDRINUSE 127.0.0.1:9401` (dashboard proxy -> app) |

Reading: every run, main included, loses 4-5 different files, late in the run
and mostly in the long scenario specs, alongside Windows socket-exhaustion
errors. The only file that fails in every run is maintenance-page (Terraform).
No failing file is shared by all branch runs, and the ones the final branch run
shares with main (participant-names, post-tour-application) failed on main
too. The machine's TCP dynamic range is the Windows default (49152, 16384
ports) and 5.5k-9.9k sockets sat in TIME_WAIT after each run - consistent with
ephemeral-port exhaustion under the suite's load. Changing that is a system
setting: Cameron's call.

## The final run's failing files, re-run ALONE on the branch

One run of the four files together (`npm run e2e -w e2e -- <files>`): 13
passed, 1 failed (2.2 min).

- participant-names:21, post-tour-application (all 5 tests incl. :107 and
  :183), sending-unit (both tests): PASS alone - their full-suite failures
  were load, as the comparison above shows.
- contact-create:157 ("editing a contact can LINK an existing contact"):
  FAILED alone too, so it was run alone repeatedly on both sides:
  - main @f93b7381: pass, fail, fail, fail (same timeout each time);
  - branch: pass, fail.
  It is a PRE-EXISTING failure on main that shows on a re-run in the same lane
  (the spec does not reseed). Filed
  `docs/issues/contact-create-link-relationship-e2e-fails-on-rerun.md` (med).
  The branch touches neither contacts nor that dialog.

Verdict: no gate failure is attributable to this branch.
