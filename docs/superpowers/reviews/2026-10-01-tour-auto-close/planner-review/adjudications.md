# Planner independent review - adjudications (2026-10-04)

The planner's own review after the orchestrator's handback (feature-mission
phase 6). Two fresh read-only reviewers on Opus - spec-conformance
(`spec-conformance.md`) and plan-blind adversarial (`adversarial.md`) - plus
the planner's own gate battery and a read of the riskiest diffs.

## Planner gate battery (HEAD 16e1f6f0 = gated merge 28ac4012 + two records commits; bare, from the worktree)

| gate | exit | evidence |
|---|---|---|
| 1 `npm run typecheck` | 0 | `.superpowers/planner-gates/g1-typecheck.log` |
| 2 `npm test` | 1 | app "Test Files 1 failed / 404 passed (405)"; dashboard 215/215; e2e workspace 22/22; 34/34; 13/13; 0 `[dynamoAdmin]` lines. The one failure: `app/test/tourRemindersApi.test.ts` "earlier[] - the read partition (S7) > orders by (sentAt ?? dueAt) DESC with reminderId as the tie-break" - the REGISTERED open issue `tour-reminders-earlier-tie-break-test-ms-race` (a test that builds "identical" timestamps from two clock reads); the file is untouched by this branch; re-run ALONE three times: 69/69 passed, exit 0 each (`g2-rerun-1..3.log`). The orchestrator's full `npm test` on the same code (28ac4012) was exit 0. Ruled: the known flake, not this branch. |
| 3 `npm run smoke` | 0 | "smoke-dist: OK - 1552 import specifier(s) across 270 emitted file(s) resolve under plain Node." |
| 4 `npm run e2e` (forced to lane 12, away from the lane-7 stale browser tab) | 0 | "309 passed (17.2m)" - including `deleted-contact-resurfacing.spec.ts`, the one file the orchestrator's lane-7 run lost: its environmental ruling is confirmed. |
| 5 eslint (branch's .ts/.tsx/.js files vs main) | 1 | exactly the 2 PRE-EXISTING errors on untouched lines (`TourDetail.tsx:326:85` react-hooks/purity, `useTours.ts:128:5` react-hooks/set-state-in-effect) - 0 NEW, matching the orchestrator's baseline compare (the branch removed one pre-existing error). |

## Spec-conformance reviewer - verdict CONFORMS

| # | finding | ruling |
|---|---|---|
| 1 LOW | Spec text still stated the pre-deviation rules for F4 (lastMarkedAt stamp) and F3 (nag-clear owner) | ACCEPT - spec 8.4 and 7.4 amended with tagged "as built 2026-10-04" notes (this commit) |
| 2 NOTE | Missing `createdAt` -> never due (beyond the spec text) | ACCEPT as is - pinned by a test; can only hold a close back; `createdAt` is the byStatus GSI range key, so the sweep never sees such a row |
| 3 NOTE | The Closed-tab outcome badge is hidden from assistive tech by the row link's aria-label (as the status badge already was) | ACCEPT as is (ruling F9); not new behavior |
| 4 NOTE | Handback counts stale (8 slice reports, 68 ahead) | ACCEPT - corrected in the planner verdict |
| 5 NOTE | The gate-4 environmental ruling could not be verified from the repo | RESOLVED by the planner's clean-lane run (309/309) |

## Adversarial (plan-blind) reviewer - no BLOCKING

| # | finding | ruling |
|---|---|---|
| 1 MEDIUM | Two clock meanings: a never-marked tour's clock moves on ANY write (the `updatedAt` fallback), a marked tour's only on a status/time change or reopen; booked tours stay never-marked, so this is not only a legacy floor | NOT A DEFECT - the accepted design of spec round 3 R3-1 (it can only postpone a close, never strand one or close one early). Raised to Cameron as an OPTION: stamp `lastMarkedAt` at create so every post-deploy tour ignores unrelated writes and the fallback becomes truly legacy-only (a small create-route change + tests) |
| 2 LOW | A reopened tour older than 90 days is on no Tours list and quietly re-closes in 14 days | ACCEPT as is (spec 7.5, orchestrator AD-2) |
| 3 LOW | The Past tab intro ("...or their last update") overstates what moves a marked tour's clock | ACCEPT as a copy question for Cameron (orchestrator AD-4) |
| 4 LOW | Pending roster actions survive an auto-close (skipped with "this tour was canceled" if due while closed; fire after a reopen) | ACCEPT as is (spec 12 roster-actions note; a deferred action is at most hours old, and firing it after a reopen is what the staff member asked for) |
| 5 LOW | Header one-click 409s show raw codes; the Past bulk runner reports a server 409 as "The update failed" instead of "Changed since the list loaded" | ACCEPT as is (spec 8 / D14 scope - dialogs only); listed for Cameron as polish |
| 6 LOW | No stop / dry-run / bulk-undo for the first production run | ACCEPT - decision 6 (Cameron: no switch); the pre-deploy preview and per-tour Reopen are the controls |
| 7 NOTE | A quiet or all-lost sweep logs nothing at info | ACCEPT as is (F12 known); listed for Cameron |
| 8 NOTE | Side effects run after the write, unordered against a reopen, and are lost on a crash between | ACCEPT as is (best-effort design, same as the PATCH route's side effects) |
| 9 NOTE | "Silent by construction" is pinned on dependency names / a regex | ACCEPT as is; the reviewer's call-graph trace confirms silence today |
| 10 NOTE | Rules duplicated between app and dashboard can drift | ACCEPT as is (the codebases share no code; the e2e is the cross-check) |
| 11 NOTE | `isTourOutcome` has no caller in app/src and now accepts `no_outcome` | ACCEPT as is; listed for Cameron (a future validator must use `isStaffTourOutcome`) |
| 12 NOTE | Wording: the Reopen dialog says "Not marked" while the header badge says "Scheduled"; contact/property tour lists show only "Closed"; RUNBOOK "five" polls | ACCEPT as is; listed for Cameron as copy polish |
| 13 NOTE | Re-traced the issues the branch filed; agrees with their severities | - |

## Verdict

No BLOCKING or HIGH finding; one MEDIUM that is an accepted design choice
(offered to Cameron as an option). No fix wave. MERGE-READY at the head that
carries this record, UNMERGED (human gate).
