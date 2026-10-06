# Spec-conformance review r1 - tour auto-close and reopen

- Branch `feat/tour-auto-close`, worktree `W:\tmp\tour-auto-close`, HEAD
  339acd9d (54 commits over merge-base ae04122d).
- Reviewer: spec-conformance, round 1, 2026-10-04. Read-only on the
  repository; this file is its only product.
- Contract: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`
  (APPROVED). Plan: `docs/superpowers/plans/2026-10-01-tour-auto-close-reopen.md`
  (section 1 strings, section 2 work map, section 12 watch items). Binding
  rulings: `docs/superpowers/reviews/2026-10-01-tour-auto-close/research/worklist.md`
  (F1-F12, D-a..D-n).
- Method: read the spec, plan, worklist and the full diff package
  (`.superpowers/review/diff-full.md`, every code, test, e2e and docs hunk;
  slice reports for provenance only), then checked every claim against the
  live tree at HEAD. After the gate-4 marker existed, ran one throwaway
  probe file (9 probes, section 5); raw output is in
  `.superpowers/review/spec-conformance-r1-ref.md`.

## 1. Verdict

CONFORMS. No BLOCKING, HIGH or MEDIUM finding. Three LOW (one missing log
field, two test-coverage gaps whose behavior the probes show is already
right) and three NOTE. Every plan-section-1 string and constant is in the code
byte for byte; every work-map task S1-S10 is done; S11 (the one main sync -
main is 18 commits ahead with 4 overlapping files - then all five gates on the
merged HEAD, live self-QA and the handback) is still owed, and the pre-sync
gate 4 run finished red on two specs outside this feature's surface that need
a main-baseline comparison (SC-4).

## 2. Findings

| id | severity | title | file:line |
|---|---|---|---|
| SC-1 | LOW | A failed relay close-nag arm during the sweep is logged without the tourId (spec 6.4) | `app/src/jobs/tourAutoClose.ts:123` (log line `app/src/services/relayCloseNag.ts:66`) |
| SC-2 | LOW | No test pins that the sweep arms the nag ONLY on an OPEN relay group (spec 11, Job) | `app/test/tourAutoClose.test.ts:285` |
| SC-3 | LOW | Spec 11's "undated of each candidate status" model case omits `scheduled` | `app/test/toursModel.test.ts:254` |
| SC-4 | NOTE | S11 owed: main is 18 commits ahead (4 files overlap); the pre-sync gate 4 run is red on two out-of-surface specs | `dashboard/src/routes/listing/listingFormat.ts:116-126` (+3 files); `e2e/tests/dashboard-next/a2p-compliance.spec.ts:132`, `contact-detail.spec.ts:161` |
| SC-5 | NOTE | Harness fake compares four fields by identity; the store branches on string vs absent | `app/test/helpers/twilioWebhookHarness.ts:3637-3638`, `:3661-3662` |
| SC-6 | NOTE | Ruling F3 residual: an owner with a type but no id resolves unowned and its nag is cleared | `app/src/services/relayCloseNag.ts:105-106` |

**SC-1 (LOW) - the sweep's nag-arm failure carries no tourId.** Spec 6.4's
heading: "each step best-effort; a failure is logged with the tourId and the
run continues". Step 1 (`tourAutoClose.ts:111-115`) logs `tourId`; step 2
goes through `recordTourEvent`, whose audit lines log `tourId`
(`app/src/lib/tourEvents.ts:48`, `:53`) and whose timeline writes log
`refId` = the tourId (`app/src/lib/personEvents.ts:96`, `:107`). Step 3 calls
the shared `armRelayCloseNagIfOpen`, whose catch logs `conversationId` only
(`relayCloseNag.ts:66`). Reproduction (probe P6): a due tour linked to an open
relay group, `conversationsRepo.getById` rejecting for that group ->
`runTourAutoClose` closes the tour (`closed: 1`, the run continues - correct)
and the ERROR line `relay close-nag arm failed (best-effort)` has
`conversationId` and no `tourId`. Impact: on the first production run a failed
arm has to be traced from conversation to tour by hand; no behavior is
affected. Smallest fix, one line at the call site, no change to the shared
helper: `logger: log.child({ tourId: tour.tourId })` at
`tourAutoClose.ts:123` (pino `Logger`, `app/src/lib/logger.ts:14`; nothing in
`app/src` uses `.child` yet, so an optional log-fields argument on the helper
is the alternative). Same shape, not required by spec 7.4, on the reopen
route's clear (`relayCloseNag.ts:111`).

**SC-2 (LOW) - "only on an open relay group" is unpinned.** Spec 11 (Job):
"arms the nag only on an open relay group without a nag". The job test at
`tourAutoClose.test.ts:285` pins an open group without a nag (armed) and an
open group with one (kept). Nothing pins that a CLOSED relay group, or a
non-relay thread named by `groupThreadId`, stays un-nagged: not at job level,
and `armRelayCloseNagIfOpen` has no direct unit test in `app/test` (no file
names it; `toursApi.test.ts:297-325` arm only open groups). The behavior is
right today (probe P3: one due tour linked to a closed relay group, one to an
open `tenant_1to1` thread; both close, neither conversation gains
`close_nag_next_at`). Smallest fix: add the P3 case to
`tourAutoClose.test.ts`.

**SC-3 (LOW) - undated `scheduled` is not in the model table.** Spec 11
(Model) lists "undated of each candidate status". Case 9
(`toursModel.test.ts:254`) loops over `toured` and `no_show` only - the plan's
Task 1.2 case 9 narrowed it - so no committed test shows an undated
`scheduled` row counting from its creation, which is what spec 5.3's "No
status-specific undated branch" requires. Probe P1:
`autoCloseDueAtMs({ status: 'scheduled', createdAt })` and the same with
`scheduledAt: ''` both return createdAt + 14 days - behavior correct,
unpinned. Smallest fix: add `'scheduled'` to the case-9 status list.

**SC-4 (NOTE) - S11 still owed, and main has moved.** `git rev-list --count
HEAD..main` = 18 (main @71e532fb, the Properties available view). Files
changed on both sides since ae04122d: `dashboard/src/routes/listing/listingFormat.ts`
and its test (this branch adds two `TOUR_LABELS` rows and a test),
`documentation/GLOSSARY.md` (this branch's entry at `:312-331`) and
`e2e/support/selectors.md` (the tick row at `:109`) - expect textual overlap
in the sync. Gates already green are all on the PRE-SYNC HEAD 339acd9d:
typecheck exit 0, `npm test` exit 0 (every feature test file ran, the 54-case
DynamoDB integration file included, 0 `[dynamoAdmin]` lines), smoke exit 0,
and gate 5 shows only the two pre-existing errors the slice reports name
(`TourDetail.tsx:326` react-hooks/purity - `:311` at base;
`useTours.ts:128` react-hooks/set-state-in-effect - `:126` at base; the
branch also removed the base's `routes/tours.ts:58` unused import, D-a).
Gate 4 on the pre-sync HEAD finished RED (exit 1 at 14:28:24): 306 passed,
2 failed - `e2e/tests/dashboard-next/a2p-compliance.spec.ts:132` and
`e2e/tests/dashboard-next/contact-detail.spec.ts:161`, both a 60 s timeout in
their own `devLogin` waiting for the "Continue as dev user" button (run
tests #2 and #59). No feature code is on that path and this feature's four
e2e tests (#188-#191) passed, but AGENTS.md treats a named-spec failure as a
regression to diagnose, so the main-baseline comparison is owed before gate 4
can count. Owed: the one main sync, then all five
gates on the merged HEAD, P5 self-QA, and the handback items (a)-(d) of plan
S11 step 4 (preview recipe, first-run effects, the D3/D5/D8/D12/D14 list, "no
infra/post-merge ops").

**SC-5 (NOTE) - fake equality is identity, not the store's string branch.**
The real conditions use field equality when the read value is a string and
`attribute_not_exists` otherwise (`app/src/repos/toursRepo.ts:711-722`,
`:766-778`); the fake uses `t.x !== tour.x` for `scheduledAt`, `lastMarkedAt`,
`outcome` and `autoClosedFrom`. For every string-or-absent value they agree,
and those are the only shapes any writer produces (the repo `patch` REMOVEs
nulls, `toursRepo.ts:433-450`; the routes accept ISO strings and allowlisted
values only). The one divergence - the same non-string value (e.g. `null`)
on both the read and the row - lets the fake win where the store refuses; it
is unreachable from the sweep (the model returns null for such a row,
`toursModel.ts:209-211`, `:219-221`) and from the reopen route. So the fake is
not looser on any reachable state, which is the watch item (plan 12); the
S1-S2 report's mutant table killed every fake mutant. Optional hardening:
mirror the string branch in the fake.

**SC-6 (NOTE) - F3 residual.** `clearRelayCloseNagOnReopen` resolves the
owner through `getOwner` (ruling F3), which maps an `owner` that has a type
but no string id to `{ type: null }`
(`app/src/repos/conversationsRepo.ts:385-394`), so such a group's nag is
cleared, where spec 7.4's literal rule skips any non-null owner type. No
writer creates that shape. The orchestrator already carries it as a
sub-threshold handback note (progress.md, S5 line); conformant to F3.

## 3. Work map (plan section 2)

| slice | task | status | evidence (live tree) |
|---|---|---|---|
| S1 | 1.1 outcomes + staff guard (+ old 4.1) | CONFORMS (+D-a) | `app/src/lib/toursModel.ts:75-103`; validator `app/src/routes/tours.ts:1022-1025`; import list `:51-62` drops `isTourOutcome` / `TOUR_OUTCOMES` / `TourOutcome`; tests `app/test/toursModel.test.ts:128`, `:167`; `app/test/toursApi.test.ts:407` |
| S1 | 1.2 two-week clock | CONFORMS | `toursModel.ts:162-231`; tests `toursModel.test.ts:208-303` (cases 1-12) |
| S1 | 1.3 reopen target + lifecycle header | CONFORMS | `toursModel.ts:253-259`; header `:16-18`, `:34-39`; canReschedule comment `:137-138`; tests `toursModel.test.ts:305` |
| S2 | 2.1 types + attribute docs | CONFORMS | `app/src/repos/toursRepo.ts:49`, `:106`, `:109`, `:113` |
| S2 | 2.2 patch expectedStatus | CONFORMS (+D-b) | `toursRepo.ts:173-182`, `:221`, `:433`, `:463-468`; fake `app/test/helpers/twilioWebhookHarness.ts:3514-3528`; tests `app/test/toursRepo.integration.test.ts:578` (+2 PINs), `app/test/toursRepoFakeConditions.test.ts:29` (+2 PINs) |
| S2 | 2.3 autoCloseIf | CONFORMS | `toursRepo.ts:298`, `:679-746`; fake `harness:3623-3650`; tests integration `:631-786`, fake `:78-235` |
| S2 | 2.4 reopenIf | CONFORMS | `toursRepo.ts:308`, `:748-801`; fake `harness:3652-3678`; tests integration `:830-915`, fake `:278-362` |
| S3 | 3.1 activity types | CONFORMS | `app/src/repos/activityEventsRepo.ts:43-44`; `dashboard/src/api/types.ts:2528-2529`; doc comments `routes/tours.ts:418-421`, `app/src/routes/units.ts:163-164`, `types.ts:2924-2925` |
| S3 | 3.2 shared writer | CONFORMS (+D-c) | `app/src/lib/tourEvents.ts:1-55` (`activityEvents` required `:19`); delegation `routes/tours.ts:128`, `:255-261`; test `app/test/tourEvents.test.ts` |
| S4 | 4.1 | folded into 1.1 | - |
| S4 | 4.2 consistent read, precondition, 409 | CONFORMS (+D-d) | `routes/tours.ts:1034`, `:1232`, `:1233-1250`; the two staff-PATCH wrappers forward `opts`; tests `toursApi.test.ts:470`, `:510`, `:532`, `:561` |
| S4 | 4.3 lastMarkedAt stamp | DEVIATES-BY-RULING F4 | `routes/tours.ts:1161-1166`; tests `toursApi.test.ts:606-680` (F4 case `:668`) |
| S5 | 5.1 nag-clear helper | DEVIATES-BY-RULING F3 (+D-e) | `app/src/services/relayCloseNag.ts:17-23`, `:71-113` (`getOwner` `:105`); test `app/test/relayCloseNagClear.test.ts` (legacy `placementId` case) |
| S5 | 5.2 job | CONFORMS (+D-f) | `app/src/jobs/tourAutoClose.ts:1-126`; test `app/test/tourAutoClose.test.ts` (plan cases 1-11 all present) |
| S5 | 5.3 worker | CONFORMS | `app/src/worker.ts:526-570` (own interval through `startPollLoop` `:565-569`, annotated deps `:548`, bridged `appEvents` `:561`) |
| S5 | 5.4 dev tick | CONFORMS (+D-g) | `app/src/routes/dev.ts:134-136`, `:431-484`; test `app/test/devTourAutoCloseTick.test.ts`; seam rows `e2e/support/selectors.md:109`, `e2e/README.md:588-589` |
| S6 | 6.1 reopen route | CONFORMS (+D-h) | `routes/tours.ts:12`, `:1473-1517`; PATCH guard wording `:1044-1045`, `:1055`; test `app/test/toursReopenApi.test.ts` (plan cases 1-13 + 401/403 `:491`) |
| S7 | 7.1 listing chip | CONFORMS | `app/src/lib/listingSendTour.ts:9-23`, `:62`; tests `app/test/listingSendTour.test.ts:129-170` |
| S8 | 8.1 api types, client, catalog | CONFORMS | `types.ts:903-916`, `:949-955`; `dashboard/src/api/endpoints.ts:2665-2700`; `e2e/performance/mutationCatalog.ts:132`; count `e2e/performance/mutationCatalog.test.ts:375-376` (111) |
| S8 | 8.2 pure module | CONFORMS | `dashboard/src/routes/tours/tourReopen.ts:1-28`; test `tourReopen.test.ts` |
| S8 | 8.3 kebab item | CONFORMS | `TourActionsMenu.tsx:1-14`, `:47-48`, `:90-106`, `:198-208`; test `TourActionsMenu.test.tsx` Reopen describe |
| S8 | 8.4 ReopenTourModal | CONFORMS | `TourModals.tsx:439-487`; test `TourModals.test.tsx:39-128` |
| S8 | 8.4b 409 copy in every writing dialog | CONFORMS (+D-i) | `TourModals.tsx:35-46`; catches `:106`, `:240`, `:324`, `:398`, `:462`; tests `TourDetail.test.tsx:582`, `:831` |
| S8 | 8.5 tour page | CONFORMS (+D-j) | `TourDetail.tsx:28-34`, `:296`, `:353`, `:587-603`, `:637-646`, `:713-714`, `:845-857`, `:896-903`; tests `TourDetail.test.tsx:938-1150` |
| S8 | 8.6 Tours page | CONFORMS | `ToursPage.tsx:26-33`, `:157-162`, `:601-606`; tests `ToursPage.test.tsx:647`, `:666`, `:680`, `:777` |
| S8 | 8.7 Today lists no-shows | CONFORMS (+D-k) | `selectTodayPastTours` gone from every workspace; `useTours.ts:10-13`, `:254-260`; `useTodayPastTours.ts:1-33`, `:147-166`; `Today.tsx:1-14`, `:190-195`, `:223-227`; tests `useTodayPastTours.test.tsx:78`, `Today.test.tsx:364`, `useTours.test.ts` cap pin |
| S8 | 8.8 activity labels + seed comments | CONFORMS | `tourActivityFormat.ts:26-27`, `:77-78`; `listingFormat.ts:112-126`; `app/src/lib/seed/history.ts:78-96`, `:702-707`, `:849-856`; `seedTourTrails.test.ts`, `seedHistory.test.ts` comments and title |
| S9 | 9.1 Today spec rewrite | CONFORMS | `e2e/tests/dashboard-next/today-past-tours.spec.ts` |
| S9 | 9.2 new spec | CONFORMS | `e2e/tests/dashboard-next/tour-auto-close.spec.ts` (every tick passes `tourIds`) |
| S10 | 10.1 GLOSSARY | CONFORMS | `documentation/GLOSSARY.md:312-331` |
| S10 | 10.2 issues | CONFORMS (+D-m) | section 7 |
| S10 | 10.3 RUNBOOK | CONFORMS (+D-m) | `RUNBOOK.md:405-419`, under `## Daily operations` (`:21`), immediately before `### Tour reminder supersession` (`:420`) |
| S10 | D-n spec text F1 / F5 | CONFORMS | spec `:227-239`, `:646-655`, `:680-694` |
| S11 | main sync, five gates, self-QA, handback | OWED | SC-4 |

## 4. Clause walk (spec 5-13)

| clause | status | evidence |
|---|---|---|
| 5.1 `TOUR_OUTCOMES` + `no_outcome` label | CONFORMS | `toursModel.ts:75`, `:84`; dashboard `types.ts:903`, `:909` |
| 5.1 staff list + guard; PATCH 400 lists the two | CONFORMS | `toursModel.ts:94-103`; `routes/tours.ts:1022-1025` |
| 5.1 repo `TourOutcome` re-exports the model | CONFORMS | `toursRepo.ts:49` |
| 5.2 three optional attributes, their writers | CONFORMS | `toursRepo.ts:106-113`; written only at `:729`, `:784`, `routes/tours.ts:1165` (grep of `app/src`) |
| 5.2 reopen removes `autoClosed*`; nothing removes `lastMarkedAt` | CONFORMS | `toursRepo.ts:784`; `PATCH_ALLOWED` `routes/tours.ts:146` cannot carry it |
| 5.3 constants | CONFORMS | `toursModel.ts:162`, `:166` |
| 5.3 non-candidate status -> null | CONFORMS | `:202` |
| 5.3 outcome present (any value) -> null | CONFORMS | `:203` (P2: `null` outcome -> null) |
| 5.3 `convertible === true` -> null; false / absent fine | CONFORMS | `:204` |
| 5.3 any `convertedPlacementId` string -> null | CONFORMS | `:205` (P2: `''` -> null) |
| 5.3 start = latest(createdAt, non-empty scheduledAt, lastMarkedAt else updatedAt) | CONFORMS | `:206-223` |
| 5.3 present but unparseable -> null | CONFORMS | `:207`, `:211`, `:221`; a MISSING createdAt -> null is plan Task 1.2 case 10 |
| 5.3 due = start + 14 d; `due <= now`, null-safe | CONFORMS | `:224`, `:228-231` |
| 6.1 job module, signature, interval constant | CONFORMS | `tourAutoClose.ts:32`, `:73-78` |
| 6.1 worker: own interval, same logger + bootContext, bridged bus | CONFORMS | `worker.ts:565-569`; bridge `:45-58`; bus `:561` |
| 6.1 worker deps hold no messaging adapter or send service | CONFORMS | `worker.ts:548-563` (8 fields, annotated); compile pin `tourAutoClose.test.ts:370` |
| 6.1 dev tick, hermetic-only | CONFORMS | `dev.ts:457`; absent unmounted `devTourAutoCloseTick.test.ts:156` |
| 6.1 `now` validated + normalized exactly like the reminders tick | CONFORMS | `dev.ts:460-466` vs `:410-418` (same code, same 400 text) |
| 6.1 `tourIds` 1..50 non-empty strings; 400 otherwise | CONFORMS | `dev.ts:468-480` |
| 6.1 `tourIds` scope, each read consistently | CONFORMS | `tourAutoClose.ts:64-68` |
| 6.1 response body; deps lazy + injectable | CONFORMS | `dev.ts:483`; `:136`, `:439-456` |
| 6.2 three `listByStatus` reads, null-safe filter, never the range read | CONFORMS | `tourAutoClose.ts:69`, `:85` |
| 6.3 `autoCloseIf` SET list | CONFORMS | `toursRepo.ts:729` |
| 6.3 condition: exists, status, no outcome, no conversion, convertible not true, scheduledAt and lastMarkedAt equal-or-absent | CONFORMS | `toursRepo.ts:704-722` |
| 6.3 undefined on condition failure; other errors rethrown | CONFORMS | `:739-745` |
| 6.3 up-front refusal of a non-candidate status | CONFORMS | `:681-682` |
| 6.3 fresh UUID; moveForward / convertible untouched; wall-clock stamps | CONFORMS | `tourAutoClose.ts:87`; `toursRepo.ts:683`, `:729` |
| 6.3 fake: SAME condition, synchronous | CONFORMS (SC-5) | `harness:3623-3650` |
| 6.4 order: reminder sweep, writer, nag arm, two emits | CONFORMS | `tourAutoClose.ts:110-126` |
| 6.4 each step best-effort, failure logged WITH tourId, run continues | PARTIAL (SC-1) | step 3 logs `conversationId` only |
| 6.4 summary; info only when closed or failed > 0; one info per close; ids only | CONFORMS | `:82-105` |
| 6.5 never sends, marks, touches tenant status or placements | CONFORMS | deps `tourAutoClose.ts:37-49` |
| 6.6 sweep vs sweep: exactly once, winner-only side effects | CONFORMS | `:96-103` |
| 6.6 sweep read, staff change, sweep write: skip | CONFORMS | P4, P5 (the real fake condition, no stub) |
| 6.6 PATCH read, close, PATCH write: 409 `tour_changed`, stays closed | CONFORMS | `routes/tours.ts:1232-1250`; `toursApi.test.ts:470` |
| 6.6 relay-open race deferred to an issue | CONFORMS | `docs/issues/tour-relay-open-vs-auto-close-race.md` |
| 7.1 route, staff auth, empty body / unknown field(s) 400 | CONFORMS | `routes/tours.ts:1480-1491`; auth `toursReopenApi.test.ts:491` |
| 7.1 error table (200, 404, four 409s) | CONFORMS | `:1492-1516` |
| 7.2 target order (not closed, converted, autoClosedFrom, decided, refuse) | CONFORMS | `toursModel.ts:253-259` |
| 7.3 consistent read; SET / REMOVE; field-equality condition | CONFORMS | `routes/tours.ts:1492`; `toursRepo.ts:766-778`, `:784` |
| 7.3 lost write -> 409 `tour_changed`; fake mirrors; pointer untouched; nothing armed | CONFORMS | `routes/tours.ts:1503-1505`; `harness:3652-3678`; rows-unchanged `toursReopenApi.test.ts:249` |
| 7.4 writer, nag clear (owner rule), emit target | CONFORMS / F3 | `routes/tours.ts:1507-1514`; `relayCloseNag.ts:84-113` |
| 7.4 never fails the 200; no message / reminder / tenant / placement / roster change | CONFORMS | writers never throw (`personEvents.ts:72-109`, `tourEvents.ts:41-54`, `relayCloseNag.ts:109-112`); `toursReopenApi.test.ts:249` |
| 7.5 behaves as target status; clock restarts at the reopen | CONFORMS | `routes/tours.ts:1502` + `toursModel.ts:218` |
| 8.1 staff outcome guard | CONFORMS | `routes/tours.ts:1022-1025` |
| 8.2 consistent read before the guards | CONFORMS | `:1034` |
| 8.3 precondition; re-read -> 404 / 409 + exact detail; before any side effect | CONFORMS | `:1232-1250` |
| 8.3 fake mirrors; wrappers forward the third argument | CONFORMS (+D-d) | `harness:3522-3528` |
| 8.4 stamp `lastMarkedAt` | DEVIATES-BY-RULING F4 | `:1161-1166` - a same-TIME reschedule also stamps, inside F4's "or patch.scheduledAt is present" (orchestrator note) |
| 8.5 the rest unchanged; leaving closed only via reopen | CONFORMS | closed guard `:1054-1058`, exit gate `:1124-1127`; P8 |
| 9.1 types, `StaffTourOutcome`, `reopenTour`, milestone types, doc fix, catalog | CONFORMS | `types.ts:903-955`, `:2528-2529`; `endpoints.ts:2665-2700`; `mutationCatalog.ts:132` |
| 9.2 `reopenTargetOf` mirrors 7.2 | CONFORMS | `tourReopen.ts:12-20` |
| 9.2 ONE Reopen control per state | CONFORMS | CTA rung `TourDetail.tsx:637-646` after the convertible rung `:613-618`; kebab only when `convertible === true` `:713` |
| 9.2 dialog: title, Cancel / Yes, reopen, three bodies | CONFORMS | `TourModals.tsx:469`, `:474`, `:477`; `tourReopen.ts:23-28` |
| 9.2 confirm: apply, toured -> Record outcome, guarded onClose | CONFORMS | `TourDetail.tsx:598-603`, `:896-903` |
| 9.2 reopen errors: 409 copy / generic copy | CONFORMS | `TourModals.tsx:44-46`, `:462` |
| 9.2 Outcome card for `no_outcome` | CONFORMS | `TourDetail.tsx:845-857` |
| 9.2 409 copy in every writing dialog, one constant | CONFORMS | `TourModals.tsx:39`, `:106`, `:240`, `:324`, `:398`, `:462` |
| 9.3 Closed badge; both intros; Past selection unchanged | CONFORMS | `ToursPage.tsx:157-162`, `:601-606`; `selectPastTours` untouched |
| 9.4 selector removed; Past rows direct; no-show row; heading + link rule; comments | CONFORMS | `useTodayPastTours.ts:147-166`; `Today.tsx:49`, `:205`, `:259` |
| 9.5 tour-page labels + MILESTONE_TYPE; property labels keep /tours link; contact timeline neutral | CONFORMS | `tourActivityFormat.ts:26-27`, `:77-78`; `listingFormat.ts:124-125`; `Timeline.tsx:428-444` unchanged |
| 10.1 writer module, explicit deps, three callers, type = activity + audit type | CONFORMS (+D-c) | `tourEvents.ts`; `routes/tours.ts:255-261`, `:1507-1512`; `tourAutoClose.ts:116-122` |
| 10.1 dev-tick rows wall-clock | CONFORMS | no `now` reaches `personEvents` or `auditRepo` |
| 10.2 worker events bridged; tour page + Today refetch | CONFORMS | `worker.ts:45-58`, `:561` |
| 10.3 chip: closed + `autoClosedFrom === 'toured'` -> toured | CONFORMS | `listingSendTour.ts:62` |
| 12 invariants (closed terminal except reopen; `no_outcome` carries both facts; PATCH never writes over an unread status) | CONFORMS | `routes/tours.ts:1054-1058`, `:1232`; `toursRepo.ts:729`, `:784` |
| 12 writers list | CONFORMS | only `toursRepo.ts:729`, `:784`, `routes/tours.ts:1150`, `:1165` write these fields; other tour writes (`placements.ts:771`, `rosterProvision.ts:398`, `routes/tours.ts:334`) touch none |
| 12 readers | CONFORMS | Past / Today (9.4); Closed (9.3); tour page incl. `groupDead` from status (`TourConversation.tsx:162`); chip (10.3); the contact timeline reads every activity type (`contactTimeline.ts:1363-1377`); unit activity lifts `tourId` for any type (`units.ts:218`); cards, board, roster job, reminders, conversion, Upcoming walk unchanged |
| 12 seeds | CONFORMS | no seed data change (`history.ts` comments only); perf seed anchored at now (`e2e/performance/config.ts:310`), so no lane tour is due mid-run |
| 13 no migration, infra, env var | CONFORMS | no `infra/`, `tables.ts` or `.env*` change; `config.ts` comment only |
| 13 first-run text + preview | CONFORMS / OWED | `RUNBOOK.md:405-419`; the handback copy is S11 |
| 4 non-goals | CONFORMS | none built (no Past / Closed subscription, no GSI, no seed data, no rename, no manual no-show exit) |

Sub-threshold items the orchestrator already holds, confirmed and not
re-raised: a same-time reschedule stamps `lastMarkedAt` (F4 wording); the dev
tick does not dedupe `tourIds` (a duplicate reads twice, the second write
counts as `lost`); reopen's 409s carry no `detail` (spec 7.1 shows none; the
dialog copy is fixed).

## 5. Test coverage (spec section 11)

| spec 11 bullet | covered by | verdict |
|---|---|---|
| Model: each status / outcome / convertible / converted / pending claim | `toursModel.test.ts:213`, `:219`, `:225`, `:231`, `:236` | covered |
| Model: undated of each candidate status | `:254` (toured, no_show) | PARTIAL - SC-3 (P1) |
| Model: lastMarkedAt before / after; legacy floor; mark beats updatedAt | `:241`, `:276` | covered |
| Model: created after the date; exact boundary; unparseable | `:248`, `:294`, `:266` | covered |
| Model: isAutoCloseDue false for non-candidates; reopenTargetFor; pins | `:294`, `:305`, `:128`, `:167` | covered |
| Repo: patch expectedStatus wins / loses | integration `:578` (+PINs); fake `:29` | covered |
| Repo: autoCloseIf wins; loses on each of six changes; refuses non-candidate | integration `:631`, `:663`, `:689`, `:738` (8 rows), `:772`; fake `:78-235` | covered |
| Repo: reopenIf wins, removes five, sets lastMarkedAt; loses on converted / changed | integration `:830`, `:860`, `:892` (7 rows), `:905`; fake `:278-362` | covered |
| Repo: matching fake unit test | `toursRepoFakeConditions.test.ts` | covered |
| Job: closes only due candidates | `tourAutoClose.test.ts:119`, `:167`, `:178`, `:230` | covered |
| Job: never sends (no messaging dep) | `:356`, compile pin `:370` | covered |
| Job: nag only on an open relay group without a nag | `:285` (open only) | PARTIAL - SC-2 (P3) |
| Job: emits both events; lost write no side effects; side-effect failure; tourIds | `:119`, `:245`, `:261`, `:316`, `:333`, `:385` | covered |
| Routes: every 7.1 row | `toursReopenApi.test.ts:129`, `:139`, `:154`, `:182`, `:203`, `:220`, `:249`, `:455` | covered |
| Routes: PATCH `no_outcome` 400 | `toursApi.test.ts:407` (PIN by design - guards the model-without-validator half-revert) | covered |
| Routes: PATCH racing a close -> 409, stays closed | `:470` | covered |
| Routes: lastMarkedAt on status / time, not outcome-only | `:606`, `:619`, `:633`, `:650` (+F4 `:668`) | covered |
| Routes: dev tick validation + scoping | `devTourAutoCloseTick.test.ts:131`, `:143`, `:97`, `:110` | covered |
| Routes: existing closed-terminal pins hold | `toursApi.test.ts:328`, `:1461`, `:2690`, `:3816` (green in gate 2) | covered |
| Chip: from toured -> toured; scheduled / no_show -> none | `listingSendTour.test.ts:129`, `:136` | covered |
| Dashboard: reopen CTA / kebab matrix (all eight states) | `TourDetail.test.tsx:957` loop, `:984`, `:1005` loop | covered |
| Dashboard: dialog copy, Yes reopen, guarded chain, Record outcome 409 | `TourModals.test.tsx:39`, `:52`; `TourDetail.test.tsx:1059`, `:831` | covered |
| Dashboard: Outcome card, Closed badge, Today no-shows, labels | `TourDetail.test.tsx:1122`; `ToursPage.test.tsx:647`; `useTodayPastTours.test.tsx:78`, `Today.test.tsx:364`; `tourActivityFormat.test.ts:23`, `:79`; `listingFormat.test.ts:224` | covered |
| e2e 1a / 1b / 1c | `tour-auto-close.spec.ts:172`, `:229`, `:287` | covered (passed in gate 4, tests 189-191) |
| e2e 2 Today rewrite | `today-past-tours.spec.ts:97` | covered (passed, test 188) |
| e2e 3 no fixed-date spec changed | none in the diff stat | covered |

UNCOVERED bullets: 0. PARTIAL sub-items: 2 (SC-2, SC-3).

Would the regression tests fail with the feature reverted? Evidence per area:
the slice reports' one-line mutant tables (S1-S2: 34 mutants, 33 killed plus 1
equivalent on DynamoDB Local; S3-S4 10/10; S5 17/17; S6-S7 10/10; S8a 11, one
type-only survivor pinned in 02c92a56; S8b 10/10), plus probe P7: with the
route's precondition stripped (the pre-feature call shape), the race in
`toursApi.test.ts:470` returns 200 and leaves the row `toured` with outcome
`no_outcome` and `autoClosedFrom: 'scheduled'` - so that test fails on a
revert, and it shows exactly the invariant the precondition holds. The tests
marked (PIN) pass on unchanged code by design and say so in their titles.

Throwaway probes (`app/test/zz-review-spec-1.test.ts`, created after the
gate-4 marker, run alone with `npx vitest run` from `app/`, exit 0, 9 of 9
passed, then deleted):

| probe | claim | result |
|---|---|---|
| P1 | an undated `scheduled` tour (no `scheduledAt`, and `''`) is due at createdAt + 14 d (spec 5.3, 11) | holds - SC-3 is coverage only |
| P2 | `outcome: null` and `convertedPlacementId: ''` are not candidates; `isAutoCloseDue(..., NaN)` is false | holds |
| P3 | a due tour linked to a CLOSED relay group, and one linked to an open `tenant_1to1` thread: both close, neither gets `close_nag_next_at` | holds - SC-2 is coverage only |
| P4 | a person mark landing between the sweep's list read and its write: `{ due: 1, closed: 0, lost: 1 }`, no pin, audit row or emit (real fake condition, no stub) | holds (spec 6.6) |
| P5 | a status change in the same window also loses | holds |
| P6 | a rejecting `getById` during the nag arm: the run closes the tour and continues; the ERROR line has `conversationId`, no `tourId` | confirms SC-1 |
| P7 | PATCH race with the precondition stripped (pre-feature call shape): 200, row becomes `toured` + `no_outcome` + `autoClosedFrom` | the committed race test would fail on a revert |
| P8 | PATCH on an auto-closed tour: status toured / no_show / scheduled+time, time alone, both exit-gate decisions - each 409, row unchanged | holds (spec 8.5, 12) |
| P9 | `{ status: 'closed', moveForward: true }` from toured (closed, convertible, no outcome) -> reopen 409 `tour_reopen_unsupported` | holds (spec 7.1 last-but-one row) |

## 6. Scope (beyond the spec and the plan)

No behavioral extra outside the spec and plan surface. Listed for the record:

- Reopen route answers 400 `body must be a JSON object` to a non-object body
  (`routes/tours.ts:1483-1486`) - not in the 7.1 table, but in plan Task 6.1
  and the same shape as the sibling POST / PATCH.
- Copy extra: the Reopen confirm reads `Reopening...` while busy
  (`TourModals.tsx:477`), mirroring Cancel's `Canceling...`.
- Defensive extras: the kebab item needs both `canReopen` and `onReopen`
  (`TourActionsMenu.tsx:93`); the clock refuses a missing `createdAt` (plan
  case 10).
- Docs beyond spec 15 / plan S10: a bullet in
  `documentation/tours-sequence-writeup.md:170-173` (accurate); two RUNBOOK
  additions outside the deploy entry - the "Worker poll cadence" paragraph and
  the polls-list bullet (accurate: the first tick is one interval after boot,
  `app/src/jobs/pollLoop.ts:62-75`; the poll-error line is `:73`).
- Comment-only edits: `pollLoop.ts`, `app/src/lib/config.ts`,
  `app/src/lib/events.ts`, `app/src/routes/units.ts`, `history.ts`.
- Tests: all additive. `TourModals.test.tsx` is a new file where D-i expected
  the 8.4 tests page-level in `TourDetail.test.tsx`; both exist, no conflict.

## 7. Docs (spec section 15)

- `docs/issues/past-tab-no-show-rows-need-an-exit.md`: `status: resolved`,
  `resolved: 2026-10-04`, a `**Resolution (2026-10-04, feat/tour-auto-close).**`
  paragraph saying it closed BY DECISION (Sam, Sep 30) and what shipped
  (no-shows leave the Past tab and Today 14 days after their last mark; Today
  lists them meanwhile). Matches the README lifecycle (status + resolved +
  Resolution note) and D-m.
- `docs/issues/tours-patch-status-precondition.md`: update block - server
  window closed (consistent read, status precondition, 409 `tour_changed`),
  client stale-list window remains (bulk runner's re-read); `status: open`
  kept. Its line refs (`routes/tours.ts:1034`, `:1232`, `:1233-1247`,
  `toursRepo.ts:463-468`) are accurate.
- NEW `docs/issues/tour-relay-open-vs-auto-close-race.md`: valid frontmatter
  (id = filename, `type: debt`, `severity: low`, `status: open`, `area`,
  `created: 2026-10-04` = the S10 run day per D-m, `refs`); names all three
  open paths (F1) and carries the F2 reopen-vs-conversion paragraph with a
  suggested fix. Every cited line was spot-checked against the tree
  (`routes/tours.ts:883`, `:1544`, `:1550`, `:1559`, `:1644`;
  `toursRepo.ts:496`, `:540`, `:679`; `rosterProvision.ts:150`, `:294`,
  `:303`, `:335`; `rosterActions.ts:144`, `:148`, `:156`, `:171`, `:589`,
  `:616`; `worker.ts:436`; `dev.ts:545`; `placements.ts:656`, `:661`,
  `:716`, `:771`) - all accurate.
- `docs/issues/tours-scheduled-range-query-unpaginated.md`: note that the
  sweep reads by status, status unchanged; refs accurate
  (`toursRepo.ts:393`, `:412`; `routes/tours.ts:387`).
- `documentation/GLOSSARY.md:312-331`: one entry covering auto-close, "No
  outcome recorded", `lastMarkedAt` and Reopen, with the code/data names.
- `RUNBOOK.md:405-419`: placed per D-m. The preview recipe matches spec 13
  clause for clause (rows dated more than 14 days ago, minus Needs placement,
  minus rows a person changed in the last 14 days, plus Undated rows last
  changed more than 14 days ago, the errs-safe caveat, the 90-day / one-page
  blind spot). It does NOT repeat the "two no-shows" claim F5 corrected (no
  seed claim at all). Its extra warning that a live `npm run dev` runs the
  worker against the real `hc-dev-` tables is accurate (`scripts/dev.mjs:3`,
  `:541`).
- Spec text corrections F1 / F5 landed (D-n) and change no decision.
- All added lines across the whole diff are ASCII (0 non-ASCII added lines).

## 8. What I could not verify, and why

- Gate 4 (`npm run e2e`) is the orchestrator's run; I read its log only
  (`.superpowers/sdd/gate4-e2e.log`): red with the two out-of-surface
  failures in SC-4. I did not diagnose them (screenshots and traces under
  `e2e/.artifacts/test-results/`), and could not tell from the log alone
  whether they reproduce on main.
- The lane worker's real 15-minute poll: the worker booted about 14:06:32,
  so its first auto-close tick fell about 14:21:32. The captured log holds no
  `tour auto-close poll error` and no worker-originated close (the three
  `tour closed automatically` lines all carry dev-tick request ids). That is
  consistent with a clean nothing-due tick, but a no-op tick is silent by
  design, so the logs cannot prove it fired (F12; the orchestrator's self-QA
  owns the observation). The auto-close spec's own dev-tick closes landed at
  14:21:11-14:21:17, just before that tick; each of its tours was by then
  closed, decided or freshly reopened (`lastMarkedAt` = now), and every other
  lane tour was created during the run, so none could be due.
- Route and job behavior against the REAL store end to end: the route and
  job tests use the harness fake; the DynamoDB Local integration file covers
  the repo conditions (54 cases, green in gate 2) and the e2e covers the full
  stack. I ran no DynamoDB probe of my own.
- The production first run (how many tours, preview accuracy): not
  observable here.
- Gates 1-3 and 5: read from the orchestrator's logs, not re-run (the brief
  forbids it). Typing of my probe file was not checked (vitest strips types).
