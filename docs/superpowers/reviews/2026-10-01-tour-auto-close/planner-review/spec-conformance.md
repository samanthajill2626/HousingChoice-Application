# Planner review - spec conformance (feat/tour-auto-close)

- Date: 2026-10-04. Reviewer: independent spec-conformance reviewer for the
  planner (Claude Opus 5.5), READ-ONLY. No test, build, server, install or
  eslint run; nothing committed.
- Worktree `W:\tmp\tour-auto-close`, branch `feat/tour-auto-close`, HEAD
  16e1f6f0. Gated commit 28ac4012 (merge of main @71e532fb); the two commits
  above it (7ac2393c, 16e1f6f0) touch only `handback.md`. 0 behind main
  (`git rev-list --count HEAD..main` = 0); merge base = main tip 71e532fb.
- Contract: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`
  (APPROVED, with in-text amendments A-1, F1, F5).
- Claims checked: `docs/superpowers/reviews/2026-10-01-tour-auto-close/handback.md`
  (sections 1, 2, 5, 9-11), `research/worklist.md` (F1-F12, D-a..D-n),
  `code-review/adjudications-r1.md`, `self-qa.md`, and the gate logs under
  `.superpowers/sdd/` (read only).
- Method: `git diff main...HEAD` read in full for every code, test, e2e and
  doc file the branch touches (57 code/test/e2e files, 6 issue/doc files);
  every citation below was read at HEAD.

## Verdict

**CONFORMS.** Every decision and requirement in spec sections 2, 5-12 and 15
is delivered by code and pinned by tests. The four declared deviations (A-1,
F4, F3, F1/F5 text) are real, are recorded (A-1 / F1 / F5 in the spec text
itself, F3 / F4 in `research/worklist.md` and the handback), and break no
other spec guarantee. No section-4 non-goal was built. The handback's
checkable facts hold, with two stale counts. Findings: one LOW (spec text not
amended for F3 / F4), the rest NOTE.

## Findings

1. **[LOW] Spec text still states the pre-deviation rules at 7.4 / D9 and 8.4.**
   A-1, F1 and F5 were amended into the spec and tagged; F3 and F4 were not.
   Spec 8.4 (line 452) still reads "When the built patch contains `status` or
   `scheduledAt`, it also sets `lastMarkedAt`", while the code stamps only on a
   status that DIFFERS from the one read, or any new time
   (`app/src/routes/tours.ts:1161-1166`, ruling F4). Spec 7.4 (line 415-417)
   still says the nag is cleared when the owner "is absent", and D9 says the
   owner is checked "when recorded"; the code resolves the owner through
   `getOwner` (`app/src/services/relayCloseNag.ts:105-106`), so a legacy group
   carrying only `placementId` is placement-owned and NOT cleared (ruling F3).
   Both deviations are recorded (`research/worklist.md` F3, F4; handback
   section 5) and both are faithful to the spec's intent (5.2 defines the mark
   as a person CHANGING status or time; 11 says "stamps on status / time
   changes"; decision 4 says "the tour's OWN open relay group"). The gap is
   only that the contract now contradicts the code at two places a future
   reader will compare. Suggest tagging 7.4 and 8.4 the way 6.3 carries A-1.
2. **[NOTE] The clock treats a tour with NO `createdAt` as never due** -
   beyond the spec text (5.3 nulls only a "present but unparseable" instant).
   `app/src/lib/toursModel.ts:206-207`; pinned in
   `app/test/toursModel.test.ts` case 10 and labelled "Defensive (beyond the
   spec text)"; not declared in the handback. Conservative (it can only
   withhold a close) and unreachable through the sweep's list path
   (`createdAt` is the `byStatus` GSI range key, `app/src/lib/tables.ts:547-550`).
3. **[NOTE] The Closed-tab outcome badge is visual only.** The row link's
   `aria-label` ("Tour for X at Y", `dashboard/src/routes/tours/ToursPage.tsx:145`)
   hides both the pre-existing status badge and the new outcome badge
   (`:160-162`) from assistive tech, so spec 9.3's "read apart" holds visually
   only. Pre-existing pattern; ruling F9 accepted it as test guidance.
4. **[NOTE] Two handback counts are stale.** "7 slice reports" - eight are
   tracked under `slices/`; "66 ahead (67 with the records commit)" - the
   branch is now 68 ahead, with TWO docs-only records commits (7ac2393c,
   16e1f6f0) on top of the gated 28ac4012, both touching only `handback.md`.
   Every other figure checked matches (section 4 below).
5. **[NOTE] Gate 4 was red on the gated commit; its adjudication is
   UNVERIFIED here.** `.superpowers/sdd/final-gate4-e2e.log` shows exactly what
   the handback says ("1 failed", "308 passed (21.9m)", run #63
   `deleted-contact-resurfacing.spec.ts:67` timing out on the Inbox heading via
   `:49` / `:88`; `.done` = 1); the isolate run passed (`1 passed (18.3s)`,
   `.done` = 0) and the main-tip baseline shows `306 passed (17.3m)`. The
   feature's path does not touch that spec (it runs at #63, long before the
   feature specs at #189-#192, and the lean world has no tours). The cause the
   handback names (a stale foreign tab polling lane 7) cannot be confirmed from
   the repo; the planner's own e2e run is the decider.

## 1. Requirement walk (spec -> code -> test)

Status key: CONFORMS / DEVIATES (declared) / PARTIAL / MISSING.

### Section 2 - decisions

| # | requirement | status | evidence |
|---|---|---|---|
| 1 | scheduled-past / toured-no-outcome / no-show close 14 d after the clock start; requested, canceled, Needs placement left alone; never marks a no-show; clock floor (D3) | CONFORMS | `app/src/lib/toursModel.ts:162-231` (`AUTO_CLOSE_AFTER_MS`, `AUTO_CLOSE_STATUSES`, `autoCloseDueAtMs`, `isAutoCloseDue`); outcome / convertible / conversion exclusions `:202-205`; job never writes `no_show` (`app/src/jobs/tourAutoClose.ts` writes only via `autoCloseIf`) |
| 2 | reopen returns to the state it closed from; not-a-fit -> toured, outcome cleared; sends nothing, arms nothing; fresh two weeks; into toured opens Record outcome | CONFORMS | `reopenTargetFor` `toursModel.ts:253-259`; `reopenIf` `app/src/repos/toursRepo.ts:767-821` (REMOVE five attrs, SET `lastMarkedAt`); route `app/src/routes/tours.ts:1482-1525` (no arm, no send); hand-off `dashboard/src/routes/tours/TourDetail.tsx:598-603` |
| 3 | converted (finished or pending claim) never reopens; page keeps "View placement" | CONFORMS | `toursModel.ts:255`; condition `attribute_not_exists(#cp)` `toursRepo.ts:785`; `TourDetail.tsx:607-612` (View placement first), `reopenTargetOf` returns null for any `convertedPlacementId` string (`dashboard/src/routes/tours/tourReopen.ts:14`) |
| 4 | auto-close arms the 28-day nag (set-if-absent, open relay only); reopen clears a pending nag on the tour's own open group; activity on tour page, tenant AND landlord timelines, property | CONFORMS (clear: DEVIATES F3, see 2.3) | arm `tourAutoClose.ts:133-137` -> `relayCloseNag.ts:42-68`; clear `relayCloseNag.ts:84-113`, called `tours.ts:1517-1521`; shared writer `app/src/lib/tourEvents.ts` (tenant + landlord pins via `recordPersonMilestone`, `units#` + `tours#` audit rows) |
| 5 | Today lists no-shows | CONFORMS | `selectTodayPastTours` deleted (no reference left in `dashboard/src`); `useTodayPastTours.ts:161` labels `past` directly |
| 6 | plain rule, no grace period, no switch; handback says how to preview | CONFORMS | poll started unconditionally `app/src/worker.ts:537-570`; preview in handback section 6 and `RUNBOOK.md` "Tour auto-close (2026-10-01)" |
| 7 | "No outcome recorded" system-only | CONFORMS | `STAFF_TOUR_OUTCOMES` / `isStaffTourOutcome` `toursModel.ts:94-103`; PATCH validator `tours.ts:1022-1025`; dashboard `StaffTourOutcome` `dashboard/src/api/types.ts:916`, used by `patchTour` (`endpoints.ts:2678`) and the dialog (`TourModals.tsx` RecordOutcomeModal props) |
| defaults | 14 d = 336 h; Reopen on tour page only; Past intro sentence; "Closed automatically on <date>" | CONFORMS | `toursModel.ts:162`; "Reopen" appears only in `TourDetail.tsx` / `TourActionsMenu.tsx` / `TourModals.tsx` (+ the pre-existing relay-group reopen in `ConversationDetail.tsx`); intro `ToursPage.tsx:603`; card `TourDetail.tsx:845-856` |

### Section 5 - model

| req | status | evidence |
|---|---|---|
| 5.1 `TOUR_OUTCOMES` gains `no_outcome`, label | CONFORMS | `toursModel.ts:75`, `:84`; test `toursModel.test.ts` "contains exactly the three outcomes" |
| 5.1 `STAFF_TOUR_OUTCOMES` + guard; PATCH 400 lists two values | CONFORMS | `toursModel.ts:94-103`; `tours.ts:1022-1025`; test `toursApi.test.ts:407` |
| 5.1 repo `TourOutcome` re-exports the model's | CONFORMS | `toursRepo.ts:38`, `:49` (hand-copied union removed) |
| 5.2 three optional attributes; reopen removes two; nothing removes `lastMarkedAt` | CONFORMS | `TourItem` `toursRepo.ts:106-113`; `reopenIf` REMOVE list `:803`; `lastMarkedAt` not in `PATCH_ALLOWED` (`tours.ts:146`) or `POST_ALLOWED` (`:143`); only writers: PATCH `:1165`, reopen `:1504` |
| 5.3 status / outcome / convertible / conversion exclusions | CONFORMS | `toursModel.ts:202-205` |
| 5.3 clock start = latest of createdAt, non-empty scheduledAt, mark (`lastMarkedAt` else `updatedAt`); unparseable -> null | CONFORMS (+ finding 2) | `toursModel.ts:206-225`; once `lastMarkedAt` exists `updatedAt` is not read (`:218`); tests `toursModel.test.ts` cases 7-11 (legacy floor case 11 covers both directions and the "ignored once marked" rule) |
| 5.3 due = start + 14 d; due when `due <= now`, null-safe | CONFORMS | `toursModel.ts:226-231`; case 12 (inclusive boundary, NON_CANDIDATES at `MAX_SAFE_INTEGER`) |

### Section 6 - the sweep

| req | status | evidence |
|---|---|---|
| 6.1 `runTourAutoClose(nowIso, deps, opts?)`, `TOUR_AUTO_CLOSE_INTERVAL_MS = 15 min` | CONFORMS | `tourAutoClose.ts:40`, `:81-115` |
| 6.1 worker: own interval, code constant, `pollLoop.startPoll` directly, same logger + bootContext, bridged bus | CONFORMS | `worker.ts:25` (alias), `:537-570` (`appEvents`, `intervalMs: TOUR_AUTO_CLOSE_INTERVAL_MS`, `baseContext: bootContext`); every event is bridged (`app/src/lib/events.ts` `ALL_APP_EVENTS`); source pin `app/test/jobQueueWiring.test.ts` |
| 6.1 dev tick: path, `now` validation identical to tour-reminders tick, `tourIds` 1-50 non-empty strings, response shape, lazy injectable deps | CONFORMS | `app/src/routes/dev.ts:439-484` (cf. reminders tick `:409-417`); `DevRouterDeps.tourAutoCloseDeps` `:136`; tests `app/test/devTourAutoCloseTick.test.ts` (normalized now, scoping, 50 ids, defaults, 400s, absent when unmounted) |
| 6.2 candidates by status x3, paged; `isAutoCloseDue` filter; never the range read; `tourIds` -> consistent reads of only those | CONFORMS | `tourAutoClose.ts:72-79`, `:93`; `listByStatus` pages (`toursRepo.ts:418`); GSI projects ALL (`tables.ts:14`) |
| 6.3 SET status / outcome / autoClosedFrom / autoClosedAt / ladder / updatedAt | CONFORMS | `toursRepo.ts:748` |
| 6.3 CONDITION: exists, status, no outcome, no conversion, not convertible, scheduledAt and lastMarkedAt equal-or-absent | CONFORMS | `toursRepo.ts:710-727` |
| 6.3 never-marked read also conditions `updatedAt` (A-1 amendment) | DEVIATES - declared, in spec text | `toursRepo.ts:729-740`; see 2.1 |
| 6.3 undefined on CCFE; refuse non-candidate status up front; fresh rotation UUID; wall-clock stamps | CONFORMS | `toursRepo.ts:688`, `:758-764`; `tourAutoClose.ts:95`; `toursRepo.ts:689` |
| 6.3 harness fake: same method, same condition, synchronous | CONFORMS | `app/test/helpers/twilioWebhookHarness.ts:3468-3469` (`storedAsRead`), `:3629-3660`; parity file `app/test/toursRepoFakeConditions.test.ts` |
| 6.4 winner-only side effects, in order: sweep, writer (`tour_auto_closed`), nag arm (`'tour'`, wall clock), `tour.updated {closed}` + `scheduled.updated {tenantId}`; each best-effort with tourId | CONFORMS | `tourAutoClose.ts:104-110`, `:118-140`; `recordTourEvent` never throws (`personEvents.ts` guards, audit try/catch in `tourEvents.ts`); child logger adds tourId to the helper's lines (`:134`) |
| 6.4 summary; info only when closed or failed; one info per close with tourId + from; ids only | CONFORMS | `tourAutoClose.ts:90`, `:100-113` |
| 6.5 never sends / marks no-show / changes tenant status / touches placements / closes a decided, converted, convertible or non-candidate tour | CONFORMS | deps type has no adapter or send service (`tourAutoClose.ts:45-57`, annotated in `worker.ts:548`); tests `tourAutoClose.test.ts` "sends nothing", "silent by construction", "skips every non-candidate" |
| 6.6 concurrency; relay-open residual filed | CONFORMS | conditions above; PATCH precondition (section 8); `docs/issues/tour-relay-open-vs-auto-close-race.md` |

### Section 7 - reopen

| req | status | evidence |
|---|---|---|
| 7.1 `POST /api/tours/:tourId/reopen`, staff auth, empty body -> 400 `unknown field(s)` | CONFORMS | `tours.ts:1482-1493` (same router, same auth); tests `toursReopenApi.test.ts` "400 for any body field", "stays behind requireAuth" |
| 7.1 200 / 404 / 409 x4 table | CONFORMS | `tours.ts:1494-1507`, `:1524`; tests `toursReopenApi.test.ts:128-247`, `:455` |
| 7.2 target rules + order of refusals | CONFORMS | `toursModel.ts:253-259`; tests `toursModel.test.ts:305-` (incl. autoClosedFrom outside candidates refused) |
| 7.3 consistent read; SET status / `lastMarkedAt` = route clock / `updatedAt`; REMOVE five; condition closed + no conversion + outcome / autoClosedFrom equal-or-absent; ladder untouched; nothing armed | CONFORMS | `tours.ts:1494`, `:1504` (`getNow()`); `toursRepo.ts:785-803`; test "auto-closed from scheduled -> scheduled ... SILENT" asserts reminder rows unchanged, nothing sent, contacts / placements / roster actions unchanged, pointer kept |
| 7.4 side effects in order: writer `tour_reopened` ("Tour reopened"), nag clear (never throws), `tour.updated {target}` | CONFORMS (clear: DEVIATES F3) | `tours.ts:1508-1522`; `relayCloseNag.ts:84-113`; tests `toursReopenApi.test.ts:393-453`, `app/test/relayCloseNagClear.test.ts` |
| 7.5 behaves like any tour in its target status; clock restarts from the reopen | CONFORMS | status-driven CTA ladder / kebab guards unchanged; `lastMarkedAt` stamped; e2e "reopen returns it to Not marked and gives it a fresh two weeks" |

### Section 8 - staff PATCH

| req | status | evidence |
|---|---|---|
| 8.1 staff outcome guard, 400 text | CONFORMS | `tours.ts:1022-1025` |
| 8.2 consistent read before the guards | CONFORMS | `tours.ts:1034` |
| 8.3 `patch(..., { expectedStatus })`; CCFE -> consistent re-read -> 404 / 409 `tour_changed` + detail; before any side effect | CONFORMS | `tours.ts:1234-1252` (nothing with a side effect runs above `:1234` - read the whole handler `:986-1233`); repo `toursRepo.ts:469-474`; fake `twilioWebhookHarness.ts:3528-3533`; tests `toursApi.test.ts:470`, `:510`, `:532`, `:561`; existing parked-patch wrappers forward `opts` |
| 8.4 `lastMarkedAt = getNow()` in the same write | DEVIATES - F4 (declared, records only) | `tours.ts:1161-1166`; tests `toursApi.test.ts:606-668` (incl. "a same-status restatement is not a mark (ruling F4)") |
| 8.5 everything else unchanged; leaving closed only via reopen | CONFORMS | closed-terminal 409 `tours.ts:1054-1058` unchanged; exit gate `:1124-1127` unchanged; milestones / nag / emit `:1414-1471` unchanged (diff touches none of it) |

### Section 9 - dashboard

| req | status | evidence |
|---|---|---|
| 9.1 `TourOutcome` + label; `StaffTourOutcome`; `Tour` fields; `reopenTour`; milestone types; `patchTour` doc; mutation catalog | CONFORMS | `dashboard/src/api/types.ts:903-916`, `:949-955`, `:2528-2529`; `endpoints.ts:2665-2699`; `e2e/performance/mutationCatalog.ts` (+ test count 111) |
| 9.2 `reopenTargetOf` pure mirror | CONFORMS | `tourReopen.ts:12-20`; `tourReopen.test.ts` |
| 9.2 ONE Reopen per state: primary CTA, or kebab item only beside "Start placement"; none when converted | CONFORMS | ladder `TourDetail.tsx:606-646` (Reopen rung last, after View placement / Start placement); kebab gate `:713` (`reopenTarget !== null && convertible === true`) and `TourActionsMenu.tsx:93`, `:198-208`; matrix tests `TourDetail.test.tsx:938-` (four CTA states, convertible -> kebab only, converted / pending / bare closed / canceled -> none) |
| 9.2 confirm dialog: title, "Cancel" / "Yes, reopen", per-target body copy (byte-exact) | CONFORMS | `TourModals.tsx:439-490`; `tourReopen.ts:23-28` |
| 9.2 confirm -> `reopenTour`, apply, toured -> Record outcome; guarded `onClose` | CONFORMS | `TourDetail.tsx:598-603`, `:895-903`; test `TourDetail.test.tsx:1059` (Record outcome still open a tick later) |
| 9.2 dialog errors: 409 copy / generic copy | CONFORMS | `TourModals.tsx:39-46`, `:462` |
| 9.2 Outcome card for `no_outcome` | CONFORMS | `TourDetail.tsx:845-856`; test `:1122` |
| 9.2 every writing dialog maps 409 to the one constant | CONFORMS | `TourModals.tsx:106` (Book / Reschedule shared date dialog), `:240` (already toured), `:324` (Record outcome), `:398` (Cancel), `:462` (Reopen); tests `TourDetail.test.tsx:831-` (409 and non-409 per dialog), `TourModals.test.tsx` |
| 9.3 Closed-row outcome badge; Closed intro; Past intro sentence; Past selection unchanged | CONFORMS (+ finding 3) | `ToursPage.tsx:157-162`, `:603-605`; `useTours.ts` diff is comments + selector removal only; tests `ToursPage.test.tsx:647`, `:680`, Past intro pinned byte-exact `:784` |
| 9.4 selector removed; Past rows directly, cap 5, most recent first; no-show row "No show" without `?outcome=1`; heading unchanged; link rule; comments | CONFORMS | `useTodayPastTours.ts:33`, `:103-117`, `:161`; `Today.tsx:49` (heading), `:200-205`, `:244-259`; `pastState` `useTours.ts:264-270`; tests `Today.test.tsx:364`, `useTodayPastTours.test.tsx:78` |
| 9.5 tour-page labels + MILESTONE_TYPE; property labels keep the /tours link; contact timeline server-owned, no colour case | CONFORMS | `tourActivityFormat.ts:26-27`, `:77-78`; `listingFormat.ts:142-143` with link derivation `:163-166`; `Timeline.tsx` untouched; no type filter on the person feed (`app/src/routes/contactTimeline.ts:1364-1376`) |

### Section 10 - activity, events, chip

| req | status | evidence |
|---|---|---|
| 10.1 writer moved to a module with explicit deps; router, sweep, reopen call it; existing behavior unchanged | CONFORMS | `app/src/lib/tourEvents.ts`; router wrapper `tours.ts:253-261` (same three writes, same order, same guards); `app/test/tourEvents.test.ts` |
| 10.1 types in `ActivityEventType` + `TimelineMilestoneType`; same type for activity and audit; person labels | CONFORMS | `activityEventsRepo.ts:43-44`; `tourAutoClose.ts:43`, `:127-129`; `tours.ts:1508-1513` |
| 10.1 dev-tick rows stamped by the wall clock | CONFORMS | repos stamp their own time; the injected `now` only selects (`tourAutoClose.ts:87-93`) |
| 10.2 worker events reach the dashboard via the bridge; Past / Closed tabs do not subscribe | CONFORMS | `worker.ts:561` (`appEvents`, bridged); no new subscription in `ToursPage.tsx` |
| 10.3 chip: closed + `autoClosedFrom === 'toured'` -> "toured"; from scheduled / no_show -> none | CONFORMS | `app/src/lib/listingSendTour.ts:62`; `app/test/listingSendTour.test.ts:128-` |

### Section 11 - tests and e2e

| req | status | evidence |
|---|---|---|
| model truth table, `isAutoCloseDue`, `reopenTargetFor`, pins | CONFORMS | `toursModel.test.ts:167-` (staff pins), `:186-` (clock cases 1-12), `:305-` (reopen table) |
| repo (DynamoDB Local): `patch` expectedStatus win / lose; `autoCloseIf` wins and loses per term incl. the A-1 row; refuses non-candidates; `reopenIf` wins / removes / stamps / loses | CONFORMS | `toursRepo.integration.test.ts:578`, `:807` (race rows per term, both reads), A-1 rows, `:895`, `:1015`; fake parity `toursRepoFakeConditions.test.ts:29`, `:233`, `:323`, `:441` |
| job: due-only, never sends, nag rules, both events, lost write no side effects, side-effect failure continues, `tourIds` | CONFORMS | `app/test/tourAutoClose.test.ts:113-499` |
| routes: every 7.1 row; `no_outcome` 400; PATCH racing a close -> 409 and tour stays closed; stamps / no stamp; dev tick | CONFORMS | `toursReopenApi.test.ts`; `toursApi.test.ts:407-680`; `devTourAutoCloseTick.test.ts` |
| chip | CONFORMS | `listingSendTour.test.ts:128-` |
| dashboard matrix, dialog copy, guarded chain, 409 copy, Outcome card, badge, Today no-shows, labels | CONFORMS | files cited in section 9 rows; `tourActivityFormat.test.ts`, `listingFormat.test.ts` |
| e2e 1a-1c (`tourIds` on every tick, now-relative, nothing sent per party, afterEach decides) | CONFORMS | `e2e/tests/dashboard-next/tour-auto-close.spec.ts:172`, `:229`, `:287`; `tick()` always passes ids `:104-110`; afterEach `:168-170` |
| e2e 2 Today rewrite (header, title, counts, link text, capped order) | CONFORMS | `today-past-tours.spec.ts:1-22`, `:97-201` |
| e2e 3 no fixed-date spec changed | CONFORMS | `listing-activity.spec.ts` / `landlord-activity.spec.ts` not in the diff; no e2e spec writes a tour with a past `createdAt` |

### Section 12 - invariants and surfaces

- Closed is terminal except through reopen: PATCH 409s every change to a
  closed tour (status guard `tours.ts:1054`, exit gate `:1124`, time-only
  reschedule `:1111-1115`); reopen is the only status write out of closed.
  CONFORMS.
- `no_outcome` only from the sweep, always with `autoClosedAt` +
  `autoClosedFrom`, removed together by reopen: writers grep - only
  `toursRepo.ts` / `routes/tours.ts` / `jobs/tourAutoClose.ts` /
  `listingSendTour.ts` (read) / `toursModel.ts` mention the new names in
  `app/src`. CONFORMS.
- PATCH never writes on top of a status it did not read: `tours.ts:1234`.
  CONFORMS.
- Writer list (F1 text): verified `claimGroupThread`, `releaseGroupThreadClaim`,
  `setRoster`, `clearRoster` bump `updatedAt` (`toursRepo.ts:494-520`,
  `:624-683`) and are reached only from roster / relay routes,
  `services/rosterProvision.ts` and the roster-action poll; conversion
  claim / release / finalize `placements.ts:716`, `:750`, `:771`, `:778`.
  CONFORMS.
- Readers: Past / Today by status (unchanged selection), Closed tab
  (`useClosedTours`, updatedAt desc), `groupDead` derives from status
  (`dashboard/src/routes/tours/TourConversation.tsx:162`), chip (10.3), tour
  cards / Today board / roster job / reminders / conversion untouched.
  CONFORMS.
- Seeds: no seed data change (`app/src/lib/seed/history.ts` diff is comments
  only); F5 arithmetic spot-checked against `app/src/lib/seed/matrix.ts`
  (no-shows 3 / 5 days past, `updatedAt` = time + 30 min; scheduled 3 / 5
  days out; toured / closed carry outcomes). CONFORMS.

### Section 13 - rollout

No migration / env / infra in the diff. Preview, first-run effects and review
path are in handback sections 6-7 and `RUNBOOK.md` (Daily operations,
"Tour auto-close (2026-10-01)", plus the Worker-poll and poll-health notes);
the RUNBOOK's "Closed tab newest first puts the run's closes on top" matches
`useClosedTours`' `updatedAt` desc sort (`useTours.ts:137-141`). CONFORMS.

### Section 15 - issues and docs

| item | status | evidence |
|---|---|---|
| `past-tab-no-show-rows-need-an-exit` resolved by decision, what shipped | CONFORMS | frontmatter `status: resolved`, `resolved: 2026-10-04`; Resolution paragraph (registry convention, `docs/issues/README.md:85-86`) |
| `tours-patch-status-precondition` update block, stays open | CONFORMS | update block; `status: open`; its line refs (`tours.ts:1034`, `:1234`, `:1235-1249`, `:1443`, `toursRepo.ts:469-474`) re-checked at HEAD |
| new Tier-2 issue for the relay-open race | CONFORMS | `docs/issues/tour-relay-open-vs-auto-close-race.md` (+ F2 paragraph) |
| `tours-scheduled-range-query-unpaginated` note, no status change | CONFORMS | update block; refs re-derived and re-checked (`toursRepo.ts:399`, `:418`, `tours.ts:387`) |
| GLOSSARY entry (auto-close, "No outcome recorded", `lastMarkedAt`, reopen) | CONFORMS | `documentation/GLOSSARY.md` new entry |
| RUNBOOK deploy note on the first production run | CONFORMS | `RUNBOOK.md` "### Tour auto-close (2026-10-01): NOTHING is owed ..." |

All added lines in the branch diff are ASCII (checked with a non-ASCII grep
over `git diff main...HEAD`).

## 2. Declared deviations

### 2.1 A-1 - `autoCloseIf` also conditions on `updatedAt` for a never-marked read

- Real: `toursRepo.ts:729-740` (`#ua = :ua`, or `attribute_not_exists(#ua)`,
  only when the read has no `lastMarkedAt`); fake twin
  `twilioWebhookHarness.ts` autoCloseIf
  (`typeof tour.lastMarkedAt !== 'string' && !storedAsRead(t.updatedAt, ...)`).
- Recorded: spec 6.3 paragraph tagged "Changed 2026-10-04, ruling A-1", spec
  6.6 and 11 amended (6b4c01e4); `code-review/adjudications-r1.md`.
- Other guarantees: intact. It can only turn a close into a skip; for a
  never-marked tour `updatedAt` IS the 5.3 clock input, so a write that moves
  it postpones the due anyway; a marked read carries no `updatedAt` term, so
  roster edits / group opens cannot block a due close there (pinned by the
  "(PIN) ... still closes a MARKED tour" rows). No effect on exactly-once.

### 2.2 F4 - `lastMarkedAt` stamps on a status CHANGE or any new time

- Real: `tours.ts:1161-1166`.
- Recorded: `research/worklist.md` F4; handback section 5. NOT in the spec
  text (finding 1).
- Other guarantees: intact. Matches 5.2's definition ("a person changed the
  status or time") and 11's test wording; booking / revival auto-advance and
  any time change still stamp; outcome-only and same-status restatements
  (API-only; the dashboard never sends one) do not. With the PATCH
  precondition a restatement racing a sweep either lands on an unchanged tour
  (the close is correct) or is refused with 409.

### 2.3 F3 - the reopen nag-clear resolves the owner through `getOwner`

- Real: `relayCloseNag.ts:105-106`; `getOwner` legacy mapping
  `app/src/repos/conversationsRepo.ts:385-400`; test
  `relayCloseNagClear.test.ts:90`.
- Recorded: `research/worklist.md` F3; handback section 5. NOT in the spec
  text (finding 1).
- Other guarantees: intact; it narrows clearing to exactly decision 4's "the
  tour's own open relay group" and never clears another owner's nag.

### 2.4 F1 / F5 - spec text corrections

- Real and tagged: spec 5.3 ("Text corrected 2026-10-04, ruling F1") and 12
  (writer list "List completed 2026-10-04, ruling F1"; seeds "ruling F5").
- Verified against code (writers in section 12 above; seed arithmetic).
  No decision changed.

## 3. Non-goals (spec section 4) - none built

| non-goal | evidence |
|---|---|
| #6 blast filtering | no broadcast / audience file in the diff |
| filterable tour list, calendar | none in the diff |
| staff can pick "No outcome recorded" | staff guard server + client (section 2 row 7) |
| manual no-show exit | kebab / CTA guards unchanged for `no_show` (self-QA check 6 lists Reschedule, check-in, Open relay group only) |
| reopening canceled tours | `reopenTargetFor` refuses non-closed (`toursModel.ts:254`); test "canceled: no Reopen tour anywhere" |
| new relay group on reopen | reopen route opens nothing |
| server-derived close on not-a-fit | PATCH unchanged there |
| paginating `listByScheduledRange` | `toursRepo.ts:399-416` untouched |
| live refresh of Past / Closed | no new subscription in `ToursPage.tsx` |
| renaming the Today section | `Today.tsx:49` unchanged |
| GSI / table / infra | no `infra/`, `tables.ts` or Terraform file in the diff |
| env var | no new `process.env` read; `config.ts` diff is comments only |
| seed change | `seed/history.ts` diff is comments only; seed tests only reworded |

## 4. Handback factual claims

VERIFIED from the repo / logs:

- 66 commits ahead at 28ac4012, 0 behind main 71e532fb; commits after
  28ac4012 are docs-only (`handback.md`).
- "97 files (+15153 / -306)" = the diff excluding the handback itself; "57
  files (+5433 / -300)" for app / dashboard / e2e / scripts.
- Test-file counts 405 app (399 on main + 6 new) and 215 dashboard (213 + 2);
  gate-2 log shows 405 / 215 / 22 / 34 / 13 passed and 0 `[dynamoAdmin]`
  lines; gate-1 log has 0 `error TS`; gate-3 log has the quoted smoke line.
- Gate 4 figures and identities as quoted (finding 5); isolate and baseline
  results as quoted.
- Gate 5: 55 touched files; `final-gate5-compare.txt` NEW is empty; the two
  HEAD errors sit on lines last changed in 23f7d568 / aec497d0 (pre-branch);
  the base's third error (`TourOutcome` unused import) is the one D-a removed.
- Mutation catalog 111; GLOSSARY / RUNBOOK / issue edits as described; the
  two new issues cover 6.6 + F1's three open paths + F2, and AD-5 / AD-7 /
  AD-8; their spot-checked line refs are current.
- Fix wave 2 touched tests and docs only (3263c3d5, 7d3ec78e, 6b4c01e4,
  ec2d94e9, c084f943).
- Scratch worktree `W:\tmp\tour-auto-close-base` exists, detached at 71e532fb.
- "Nothing skipped" - matches the walk above.

STALE (finding 4): "7 slice reports" (8); "67 with the records commit" (68,
two records commits).

UNVERIFIED (not checkable read-only from the repo): the e2e failure's
environmental cause; the self-QA live measurements and screenshots; the R2
mutant tables and the orchestrator's hand-applied mutant; the eslint run
itself (only its saved compare output was read); lane 7 teardown.
