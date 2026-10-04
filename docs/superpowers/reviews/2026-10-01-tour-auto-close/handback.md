# Handback - tour auto-close and reopen (Sam's improvement #18, remaining part)

- Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`, cut from main
  @ae04122d; main synced ONCE (merge commit 28ac4012 of main @71e532fb, the
  Properties available view, 18 commits; one conflict in GLOSSARY's tail, both
  entries kept). Records: `docs/superpowers/reviews/2026-10-01-tour-auto-close/`
  (tracked: research, 7 slice reports, 2 review rounds, 2 adjudications, 2
  fix-wave reports, self-QA, this handback).
- Orchestrator: Claude Fable 5.1, resumed 2026-10-04 13:18 after the 2026-10-02
  orchestrator and its C7 child died on the account's weekly usage limit (INFRA
  tier; nothing lost - every slice had committed as it went). Children on Opus:
  6 pre-resume implementers, 2 implementers, 3 reviewers, 2 fix waves. Failure
  budget used: 0 of 4; one free infra recovery.
- Scratch baseline worktree `W:\tmp\tour-auto-close-base` (detached at main's
  tip 71e532fb, `npm ci` done) - MINE; delete only on Cameron's go. Lane 7 of
  this worktree was stopped with `npm run e2e:stop` (tables dropped).

## MERGE VERDICT

MERGE-READY @28ac4012 (the merge commit; every gate below ran on it) plus the
docs-only records commit on top, on `feat/tour-auto-close`
(`W:\tmp\tour-auto-close`), 0 behind main @71e532fb, 66 ahead (67 with the
records commit), UNMERGED (human gate). NO infra / post-merge ops. One e2e
file outside the feature failed once in the final full run and passed alone
(section 2); the full main-tip baseline in the scratch worktree ran "306
passed (17.3m)", exit 0 - the failure is adjudicated environmental (a stale
foreign browser session was polling the branch's lane throughout; details in
section 2). Cameron may want one more `npm run e2e` on the branch with that tab
closed before merging; nothing in the feature's surface is implicated.

## 1. Work map - shipped / deviated / skipped

| slice | item | state | where |
|---|---|---|---|
| S1 | 1.1 `no_outcome` + staff-only PATCH guard (old 4.1 folded) | SHIPPED | `app/src/lib/toursModel.ts`, `routes/tours.ts` validator |
| S1 | 1.2 two-week clock (`autoCloseDueAtMs`, `isAutoCloseDue`) | SHIPPED | `toursModel.ts` |
| S1 | 1.3 `reopenTargetFor` + lifecycle header | SHIPPED | `toursModel.ts` |
| S2 | 2.1-2.4 repo types, `patch` expectedStatus, `autoCloseIf`, `reopenIf` + the harness fake | SHIPPED; DEVIATED by ruling A-1 (`autoCloseIf` also conditions on `updatedAt` for a never-marked tour - section 5) | `app/src/repos/toursRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts` |
| S3 | 3.1 activity types, 3.2 shared writer `lib/tourEvents.ts` | SHIPPED | `activityEventsRepo.ts`, `lib/tourEvents.ts`, dashboard `types.ts` |
| S4 | 4.2 consistent read + status precondition + 409 `tour_changed`; 4.3 `lastMarkedAt` stamp | SHIPPED; 4.3 DEVIATED by ruling F4 (stamps on a status CHANGE or any new time, not on a same-status restatement) | `routes/tours.ts` |
| S5 | 5.1 nag clear helper (F3: owner via `getOwner`), 5.2 `jobs/tourAutoClose.ts`, 5.3 worker poll (own 15-min constant), 5.4 dev tick with `tourIds` | SHIPPED | `services/relayCloseNag.ts`, `jobs/tourAutoClose.ts`, `worker.ts`, `routes/dev.ts` |
| S6 | 6.1 `POST /api/tours/:tourId/reopen` | SHIPPED | `routes/tours.ts` |
| S7 | 7.1 listing-send chip (auto-closed from toured counts as "Toured") | SHIPPED | `lib/listingSendTour.ts` |
| S8 | 8.1-8.8 dashboard (types / client / mutation catalog 111, `tourReopen.ts`, kebab item, `ReopenTourModal`, 409 copy in every writing dialog, tour page, Tours page badge + intros, Today lists no-shows, activity labels) | SHIPPED | `dashboard/src/...`, `e2e/performance/mutationCatalog.ts` |
| S9 | 9.1 Today spec rewrite, 9.2 `tour-auto-close.spec.ts` | SHIPPED | `e2e/tests/dashboard-next/` |
| S10 | 10.1 GLOSSARY, 10.2 issues (resolve / update / new), 10.3 RUNBOOK; spec text F1 / F5 | SHIPPED | `documentation/GLOSSARY.md`, `docs/issues/*`, `RUNBOOK.md`, the spec |
| S11 | sync, gates, self-QA, handback | this document | - |

Nothing skipped. Non-goals untouched (no #6, no filterable list, no seed change,
no GSI / table / env var / infra change, no manual no-show exit, no rename).

## 2. Gates on the FINAL commit 28ac4012 (bare, from the worktree, real exit codes)

| gate | exit | evidence |
|---|---|---|
| 1 `npm run typecheck` | 0 | all 5 workspaces (`final-gate1-typecheck.log`) |
| 2 `npm test` | 0 | Test Files 405/405 (app) + 215/215 (dashboard) + 22/22 + 34/34 + 13/13; 83 s; 0 `[dynamoAdmin]` lines (`final-gate2-test.log`) |
| 3 `npm run smoke` | 0 | "smoke-dist: OK - 1552 import specifier(s) across 270 emitted file(s) resolve under plain Node." |
| 4 `npm run e2e` | 1 | "308 passed (21.9m)", "1 failed": `tests/dashboard-next/deleted-contact-resurfacing.spec.ts:67` (run #63) - `expect(getByRole('heading', { name: 'Inbox' })).toBeVisible()` timed out after 15 s at spec `:49` via `:88` (expectTashaHidden, step 2). The feature's own four e2e tests (#189-#192: today-past-tours, tour-auto-close x3) passed. 0 `ERR_ADDRESS_IN_USE` / `ERR_NO_BUFFER_SPACE`, 0 `[dynamoAdmin]`. ISOLATION, same file alone on the branch: "1 passed (18.3s)", exit 0 (`final-gate4-isolate.log`). The feature changes nothing on that spec's path (no inbox / contact / conversation file; the only `today/` change is the past-tours section). MAIN-TIP BASELINE (full suite at 71e532fb in `W:\tmp\tour-auto-close-base`, lane 15, 16:57-17:14): exit 0, "306 passed (17.3m)" (main has 306 tests; the branch 309 = main + the three new tour-auto-close tests), the deleted-contact spec green among them (`base-e2e.log`). ADJUDICATION: environmental. The file is untouched by the feature and green alone on the branch; the branch's run on lane 7 was being polled about 2400 times by a stale foreign browser session (user-0002, `GET /api/inbox/unread-count`, the tab C7 first noticed) - load on exactly the inbox surface that timed out - which the baseline's lane 15 did not have. |
| 5 eslint (55 touched files vs the main tip, normalized, `-f json`) | 0 NEW | HEAD 2 errors, both pre-existing and on untouched lines: `dashboard/src/routes/tours/TourDetail.tsx:326:85` react-hooks/purity, `dashboard/src/routes/tours/useTours.ts:128:5` react-hooks/set-state-in-effect; base 3 - the branch REMOVED `app/src/routes/tours.ts` unused `TourOutcome` (D-a). `final-gate5-compare.txt` |

Pre-sync battery on 339acd9d (before review), for the record: typecheck 0;
`npm test` 0 (405 + 213 + 22 + 34 + 13); smoke 0; e2e exit 1 - 306 passed / 2
failed in 22.0 min (`a2p-compliance.spec.ts:132`, `contact-detail.spec.ts:161`,
both a 60 s `devLogin` timeout at runs #2 and #59; the two files alone: "31
passed (37.9s)" exit 0); eslint 0 NEW. Four full-suite runs today: the two
branch runs each lost one or two different unrelated files to a page-load
timeout (every one green alone), the main-tip baseline on a lane without the
foreign tab was clean - the pattern this PC has shown since 2026-09-30, with a
plausible local cause this time.

Files touched vs main: 97 (+15153 / -306 lines, records included); code, tests,
e2e and scripts: 57 files (+5433 / -300).

## 3. Commits (66 over main; hash + one-liner, by slice)

- Design (pre-build): edc045c3..f319a306 spec drafts / rounds, plan v1-v4.
- Research: 55d5555d records (4 drift files, worklist F1-F12 / D-a..D-n).
- S1 f0b4789e b18f8937 ca8536b7; S2 f5eeb7e8 f81955fb 52ea34d2 4f911c9e (+ b0138a36 report).
- S3 377a67e8 6e018720; S4 85c332da 95ea9e7d (+ 880bd64c report).
- S5 3ad64af6 8abdaec8 594f0def 003c1a7c (+ 764a0485 report).
- S6 9d50e1cb; S7 d266536d (+ 65442533 report).
- S8a d4ffffef de119593 01531a50 28ca84f7 90393eca 02c92a56 (+ 04e5a084); S8b e6dfa8a7 f65eb32d 04e88501 f766acad (+ 1f047d83).
- S9 e971fb84 f128f37e (+ a6b8098a); S10 5760b162 a81bbcca 14f179c3 4398e43a (+ 339acd9d).
- Review R1 records 91ba43c4; fix wave 1 e95622a6 e2501b09 9a444d07 02b13963 b1018603 a83417a5 78be74c4 (+ 0278e8ea).
- Review R2 records 608c3947; fix wave 2 3263c3d5 7d3ec78e 6b4c01e4 ec2d94e9 (+ c084f943).
- Self-QA record 8e9b788f; merge of main 28ac4012; records (this handback) on top.

## 4. Review record

- R1 spec-conformance (Opus; full package + spec / plan / rulings): CONFORMS;
  SC-1..3 LOW, SC-4..6 NOTE. `code-review/spec-conformance-r1.md`.
- R1 adversarial (Opus; PLAN-BLIND, code package only): AD-1 MEDIUM, AD-2..6
  LOW, AD-7..9 NOTE. `code-review/adversarial-r1.md`.
- `code-review/adjudications-r1.md`: A-1 = fix AD-1 as a recorded deviation;
  fix SC-1 / SC-2 / SC-3 / SC-5 and the AD-3 comments; file AD-5 / 7 / 8; accept
  AD-2 (spec 7.5), AD-4 (section 2 copy), AD-6 (F7), AD-9 (spec 13), SC-6 (F3).
- Fix wave 1 (8 commits): `code-review/fix-wave-1-report.md`.
- R2 FRESH re-reviewer (Opus; misses first, fix diff as new code, challenge
  the rulings, then realness): no runtime defect; R2-1 MEDIUM - the new
  `updatedAt` term masked 7 of 8 DynamoDB Local race rows (6 killed mutants had
  revived); R2-2 / R2-3 doc notes; the F12 worker-wiring dispute ACCEPTED (the
  repo already pins worker.ts by source text). `code-review/re-review-r2.md`,
  `adjudications-r2.md`.
- Fix wave 2 (5 commits, tests + docs only): every race row isolates its own
  term on a MARKED read, a raw-write row isolates the first-mark term, a
  source-text pin guards the worker's auto-close block; mutant tables in
  `code-review/fix-wave-2-report.md`. Orchestrator check: both race files green;
  one hand-applied real-repo mutant (status term dropped) turned exactly one row
  red ('the status changed', marked read); file restored byte-identical.

## 5. Decisions taken alone - for Cameron's eye (each reversible)

Planner-alone (spec section 14) that change your literal rules:
- D3 the clock FLOOR: the two weeks count from the LATEST of the tour time, its
  creation and the last time a person marked / rescheduled / reopened it
  (`lastMarkedAt`; `updatedAt` for a tour nobody has marked since the deploy) -
  a visit recorded late still gets its two weeks; cost: a tour marked after its
  date closes 14 days after the mark, not the date.
- D5 every staff PATCH reads consistently and refuses a concurrent STATUS change
  with 409 `tour_changed`.
- D8 the listing-send chip keeps "Toured" for a tour auto-closed from toured.
- D12 Today's heading stays "Past tours needing an outcome" although it now heads
  "No show" rows too (copy option).
- D14 every writing tour dialog maps ANY 409 to "This tour changed since the page
  loaded - reload and try again."

Orchestrator-alone:
- A-1 (2026-10-04, accepted by the planner): `autoCloseIf` ALSO conditions on
  `updatedAt` when the tour as read carries no `lastMarkedAt` - for such a tour
  `updatedAt` is its clock, so a roster edit or group open racing the close now
  wins (the sweep skips and retries in 15 min) instead of being overridden. Spec
  6.3 had accepted that race as a residual; the plan-blind reviewer reproduced
  it on DynamoDB Local. The term can only turn a close into a skip; the spec
  text was corrected and tagged. REVERSE by deleting the `#ua` branch in
  `toursRepo.ts` autoCloseIf and its twin in the harness fake.
- F4: `lastMarkedAt` stamps on a status CHANGE or any new time - a same-status
  API restatement does not restart the clock (a same-TIME reschedule does).
- F3: the reopen nag-clear resolves the group owner through `getOwner`, so a
  legacy group carrying only `placementId` stays placement-owned.
- F1 / F5: spec TEXT corrections (the worker's roster-action poll does write
  tours; the local demo world has seven auto-close candidates, not two).
- D-a..D-n: build-level choices, in `research/worklist.md`.

## 6. Spec decision 6 - the PRE-DEPLOY PREVIEW (run it on the production Past tab)

Rows the first run will close = the Past tab's rows dated more than 14 days ago,
MINUS "Needs placement" rows (toured, move-forward recorded, no placement),
MINUS any row a person changed in the last 14 days (marked toured / no-show,
rescheduled - those keep the rest of their two weeks), PLUS "Undated" rows last
changed more than 14 days ago (no screen shows that last-change date, and roster
edits / outcome-only patches move it without a history row, so this part errs
SAFE: it may predict closes that will not happen). BLIND SPOT: the Past tab covers
90 days and one page of the range read, so older candidates (tours from before
early July with no outcome) close without appearing there - they are on no list
today either. Review after the run: the Closed tab, newest first, shows each
auto-closed tour with the "No outcome recorded" badge; any of them can be
reopened from its page. (Also in RUNBOOK.md, "Tour auto-close (2026-10-01)".)

## 7. What the first production run does (about 15 minutes after the new worker starts)

Every tour already more than two weeks past its clock start with no outcome
closes, silently (nothing is sent to anyone). With it: "Tour closed
automatically" pins dated the run day on each tour's tenant AND landlord
timelines, the property activity and the tour activity (a landlord with many old
tours sees a burst); every never-sent reminder row of those tours (skipped /
canceled history) is deleted, as on any manual close; relay close-nags are armed
on their open relay groups and surface on Today about four weeks later; a
tenant's "Toured" chip stays only where the tour had been marked toured.

LOUD: `npm run dev` WITHOUT `--local` runs a worker on your machine against the
REAL `hc-dev-` tables and the auto-close poll always starts, so a 15-minute local
live session on ANY checkout carrying this feature performs the dev environment's
first run BEFORE the dev deploy (RUNBOOK says so).

## 8. Post-merge ops

NONE: no migration, no env var, no GSI / table change, no Terraform. Ships with
the next app + worker deploy; deploy timing is Cameron's.

## 9. Issues filed / resolved

- RESOLVED `past-tab-no-show-rows-need-an-exit` (by decision: Sam, Sep 30).
- UPDATED `tours-patch-status-precondition` (server window closed for STATUS
  changes; the same-status window and the client's stale-list window remain),
  `tours-scheduled-range-query-unpaginated` (the sweep reads by status).
- NEW `tour-relay-open-vs-auto-close-race` (spec 6.6 + F1's three open paths +
  F2 reopen-vs-conversion), `tour-reopen-edge-states` (AD-5 a decided tour that
  left toured reopens as toured; AD-7 a PATCH revival keeps its cancel's
  close-nag; AD-8 reopenIf ABA).

## 10. Not blocking - your eye

- Pre-existing lint errors on touched files (untouched lines, baseline):
  `TourDetail.tsx:326:85` react-hooks/purity, `useTours.ts:128:5`
  react-hooks/set-state-in-effect.
- The worker's auto-close poll: wiring pinned by a source-text test only;
  `pollLoop` logs nothing on a quiet tick, so a lane with nothing due cannot show
  it fired (the live lane's 16:28 poll left 0 lines and no `poll error`). The
  dev tick drives the same job end to end.
- A reopened tour dated more than 90 days ago is on no list until it closes
  again (spec 7.5 accepts; AD-2).
- The Past tab intro's "two weeks after their date or their last update" is a
  simplification of the clock (section 2's accepted copy; AD-4).
- Header-alert direct actions (Mark toured / Mark no-show / Start placement)
  show a 409 as raw `ApiError` text; only dialogs carry the D14 copy (spec 8.3;
  F7 / AD-6).
- Reopen's 409 bodies carry no `detail` (the dialog copy is fixed anyway).
- The dev tick does not dedupe `tourIds` (a duplicate id counts as `lost`).
- A same-TIME reschedule stamps `lastMarkedAt` (a person action - left as is).
- The first run acts on the whole backlog at once and deletes pre-migration
  never-sent reminder history exactly as a manual close does (AD-9; spec 13).
- After a reopen the tour page's `tour.updated` refetch is an eventually
  consistent GET and can briefly repaint the pre-reopen row (F6; pre-existing).
- A closed tour holding a `pending:` conversion claim renders "View placement" to
  `/placements/pending:x` (F11; pre-existing).
- No test links Today's no-show listing to the server's `AUTO_CLOSE_STATUSES`
  (the two codebases share no code; the e2e is the cross-codebase check).
- A stale Chrome tab (session user-0002) kept polling lane 7's dashboard port
  through every run today; harmless, not mine to close.
- RUNBOOK still says "five" shared polls and "60-second" in older paragraphs
  (pre-existing wording).
- The e2e harness: the two branch runs today each lost ONE or TWO unrelated
  specs to a 15-60 s page-load timeout, every one green alone and none in the
  files this feature touches; the main baseline on another lane was clean. A
  stale browser session (user-0002) polled lane 7's inbox unread count about
  2400 times during the branch run - close that tab (it is on
  127.0.0.1:9711) before the next lane-7 run, and consider whether the harness
  should refuse a lane with foreign connections.

## 11. Self-QA

`self-qa.md`: 17 measured checks on lane 7 (screenshots `.playwright-mcp/qa-01..16`):
the scoped ticks (`due 0` at the real now, three closes at +15 d), the Closed tab
intro + five badges, the Outcome card and one Reopen control, reopen into
scheduled / toured (Record outcome hand-off, guarded) / no_show, the convertible
tour's kebab-only Reopen beside "Start placement", a not-a-fit reopen then
decide again, the stale Record-outcome dialog's 409 copy verbatim, the live close
on an open page without reload (window marker survived), Today 3 rows then 5 of 6
with "See all 6 on the Past tab", the Past tab, tenant / landlord timelines (5 +
4 pins) and property activity (3 + 2, each linking `/tours/<id>`), and an EMPTY
fake-Twilio store (nothing sent all session).

## 12. Open questions for Cameron

- A-1 (section 5): keep the `updatedAt` guard for never-marked tours? (Recommended: yes.)
- D12: rename Today's section now that it lists no-shows? (Copy only.)
- AD-4: tighten the Past tab intro to "two weeks after their date, or after they
  were last marked or reopened"? (Copy only.)
- AD-5: should PATCH clear a recorded outcome when a tour leaves `toured`, or
  should reopen refuse such tours? (Filed; API-only path today.)
