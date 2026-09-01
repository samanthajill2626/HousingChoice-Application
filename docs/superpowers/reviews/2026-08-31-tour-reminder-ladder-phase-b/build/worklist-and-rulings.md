# MERGED WORKLIST - Phase B build (orchestrator, from research A/B/C/D)

Byte-exact anchors and quoted code live in the four research reports; builders READ
the report(s) named for their task and this file. This file carries: (1) the
orchestrator's RULINGS on every drift flag, (2) per-task deltas the plan lacks.
Line numbers are TRUE as of @040465c8 (they shift as tasks land - locate by NAME).

Reports:
- A (job/repo/unit tests): `.superpowers/sdd/reports/research-A-job.md`
- B (routes/dashboard/seeds): `.superpowers/sdd/reports/research-B-surfaces.md`
- C (relay/catalog/interpolate): `.superpowers/sdd/reports/research-C-relay.md`
- D (sweep precedent/e2e harness): `.superpowers/sdd/reports/research-D-sweep-e2e.md`

## 0. Global corrections (apply everywhere)

- `ToursRepo` has `get(tourId)`, NEVER `getById` (`toursRepo.ts:131`). Every plan
  snippet saying `toursRepo.getById` is wrong; `Pick<ToursRepo,'get'>`. Live guard
  idiom is `if (!tour)`. `PlacementsRepo.getById` / `UnitsRepo.getById` are correct.
- `ForceSendRefusal` union is `jobs/tourReminders.ts:1299-1329` (plan: 1317-1330).
- `MessageId` union is `catalog.ts:28-78` (plan: 36-52).
- Worker poll is 30s (`config.ts:609`), not the 60s three comments claim
  (`steps.ts:1712`, `tour-roster.spec.ts:493`, `dev.ts:429`). Correct when touching.
- `resolve.test.ts` and `steps.ts` are pre-existing NON-ASCII files: ADDED lines ASCII only.
- Never add `DISCONTINUED_REMINDER_KINDS` to any deps object (not injectable).

## 1. ORCHESTRATOR RULINGS (adjudications - recorded, not re-arguable by builders)

R1. **`beforeStart` / test `tourReminders.test.ts:3205` ("AT/AFTER tour start the
    wait ENDS") - KEEP the disjunct, FLIP the test.** With the past-tour gate first,
    a pre-tour rung reaching the D7 pending-open wait always has `now < scheduledAt`,
    so the "wait ends and the 1:1 fallback fires" escape is unreachable for pre-tour
    rungs (only a post-tour-dueAt row like no_show_checkin could take it). That is
    spec 6.1a's INTENT: a rung whose copy assumes the tour has not happened must not
    send after it has. Keep `beforeStart` as defence-in-depth (cost zero), rewrite its
    docblock to say the gate above is what makes the escape unreachable for pre-tour
    rungs. Redesign `:3205`: same setup, tick at `now === SCHEDULED_D11` -> assert the
    rung is claim-skipped `tour_already_passed`, `world.sent` empty. Rename the test.
R2. **`discontinued` outranks `contact_opted_out` / `sms_sending_disabled` / everything.**
    Spec 3.1a: discontinued is terminal and sits OUTSIDE the suppression ordering.
    A rung that never sends reads "no longer sent" whatever else is true. Fixtures
    that use `confirmation` as a GENERIC upcoming rung must be RE-POINTED to
    `day_before`/`morning_of` (never re-baselined to discontinued):
    `contactTimeline.test.ts:1218,1346-1350,1379,1402,1450,1478-1482,1518-1522,
    1555-1559,1595-1599,1621-1625,1645,1664,1687-1691`;
    `tourRemindersApi.test.ts:411-424,443-457,473-482`. Then ADD one explicit test
    per surface: a pending confirmation on an OPTED-OUT contact reads `discontinued`.
R3. **`routes/relayGroups.ts` GET `/api/conversations/:id/scheduled` (`:195-342`) is a
    FIFTH discontinued read surface** (spec's standing hazard predicted an unlisted
    reader). It projects pending tour rungs with NO suppression and renders through
    the same `ScheduledCard` in every relay thread, so a pause-era confirmation would
    keep promising "sends in Nh" there. RULED: in T8 add ONLY the discontinued
    suppression to that projection (`...(DISCONTINUED_REMINDER_KINDS.has(row.kind) &&
    { suppression: { reason: 'discontinued' } })`) - no other suppression evaluation
    is added there (that is the placement-twin issue's scope). Test in its API suite.
    `overdue` stays EXCLUDED there and on the timeline (spec 8.2) - and T15 must ADD
    both surfaces to `docs/issues/placement-nudge-overdue-invisible-on-card.md`,
    because the spec's claim that they are already named there is FALSE (D-D8).
R4. **`kind_retired` force-send refusal is an INLINE return** right after the row lookup
    (`~:1379`), matching the inline returns at `:1375/:1408/:1415` - `refuse` is
    declared at `:1420`, out of scope there. Do not hoist `refuse`.
R5. **Paused coverage is PRESERVED via the injection seams, not deleted.** With the
    default set empty, tests that assert `{reason:'paused'}` must INJECT a non-empty
    manual-only set through the existing seam (`manualOnlyKinds` /
    `manualOnlyReminderKinds` / `tourReminderManualOnlyKinds`) - that is what the seams
    are for now (plan T7 step 4). Tests asserting the PRODUCTION DEFAULT flip to the
    real answer (no suppression, or `quiet_hours`). `NO_MANUAL_HOLD_BACK` wrappers
    (`tourReminders.test.ts:72-75`, `tourRemindersApi.test.ts:161-174`) become no-ops:
    delete them and call the raw function.
R6. **`matrix.ts:983-992` seeds a SENT confirmation** (plan says pending). KEEP the row
    (historical, like `cast.ts`); rewrite comments `:879-881` and `:983` only.
R7. **guards g3/g3b (`tourReminders.test.ts:3666,3691`)** pin "confirmation renders no
    name -> names failure never blocks". Once confirmation is discontinued, force-send
    refuses `kind_retired` before compose, so these cannot ride confirmation. Builder
    (T9) derives: if any LIVE kind renders no name (check `reminderNamesUsed`), retarget;
    otherwise convert both into a direct unit test of the names-failure assessor with a
    synthetic no-name template so the "no name rendered" half stays pinned. Never
    silently drop the coverage; say what was done in the slice report.
R8. **`tour-roster.spec.ts:480-523` redesign (T9):** book the tour at the same horizon
    the suite already ticks far-future (`tourSchedule()` = +48h, as `tours.spec.ts` does),
    read `day_before`'s stored dueAt from the same GET and tick `justAfter` it; assert the
    `Skipped - tenant not on this roster's roster` chip on the `day_before` row. Re-derive
    the block's timing comment (its "far-future never belongs here" sentence was about
    the arm-instant trick, which no longer exists); fix the stale `steps.ts:3277` ref.
R9. **`e2e/tests/dashboard-next/relay-group-view.spec.ts:161,172`** are DASHBOARD-THREAD
    assertions; under spec 9.6 the one persisted bubble is the NEW MEMBER's NAKED intro.
    Retarget both to naked-intro copy (`You're now connected with` + the first name for
    :161; the count phrase for the nameless :172 - never delete :172). The group body
    (`Hey, adding <name> to the group.`) is asserted on an EXISTING member's fake outbox.
R10. **`{members}` split tripwires:** `contact-create-relay-group.spec.ts:203-215`
    (STANDALONE -> stays naked) is the correct home for the split trick - retarget its
    literal to `'{names}'` in T13. `tour-roster.spec.ts:237-282` asserts a TOUR preview:
    retarget its literal to `'{names}'` in T13 (keeps it green while routing is still
    naked), then in T14 rewrite the block wholly to resolved-copy assertions.
R11. **`RosterResolutionDeps` new picks (`tours`, `placements`, `settings`) are OPTIONAL**
    (like `actions?`) and absence degrades to `variant:'naked'` - `rosterEdits.test.ts`
    hand-builds the deps ~25 times. The production routes MUST wire them; the
    toursApi/placementsApi parity pins prove that through the real routes.
R12. **`expectReminderRung(kind,'upcoming')` (`steps.ts:3513`)** cannot see a SKIPPED row.
    T6 adds `.filter({ hasNotText: 'Skipped' })` to the 'upcoming' branch so every
    pending-rung assertion in the suite becomes a real one. Existing specs must stay
    green (nothing is skipped in them).
R13. **`SEND_NOW_ERROR_COPY.names_unavailable` ALREADY EXISTS** (`types.ts:1317-1318`).
    T2's test comment must not claim it is absent; do not add the key.
R14. **`seedLive.test.ts:55-84`** hand-mirrors `computeDueAt` and clamps every kind at
    `:83`; its docblock demands lockstep. T10 mirrors the en_route exemption there.
R15. **Chip ORDER in `RemindersPanel.StateChip`:** discontinued (T8) is inserted ABOVE
    paused; overdue (T12) is inserted BELOW discontinued and ABOVE paused - a discontinued
    rung is never "overdue". Pin with a component test.

## 2. Per-task deltas (in addition to the plan text)

T1 (interpolate) - report C s1. Append ONLY the `describe` (imports already at
  `resolve.test.ts:5-8`). Structural charset test iterates `MESSAGE_CATALOG`
  (`catalog.ts:105`). `catalog.test.ts:23`'s `tokensIn` uses `\w` - leave it.
T2 (tokens) - reports A s1 (union at 1299-1329), B s1. R13. `names_unavailable` is
  already a refusal member; add ONLY `tour_already_passed | kind_retired` there.
T3 (predicate + gate) - report A s1 (gate order table, forceSend structure), R1.
  `deps.toursRepo.get`. Hoist the tour read above `supersededInBatch`; thread `tour`
  into `resolveReminderTarget(row, deps, log, tour?)`. Pin: superseded-in-batch AND
  tour-missing -> `tour_missing`. Fix stale refs `tourReminders.ts:1381-1383`
  (":652/:673" -> true lines) and test comment `:3417` (":797" -> 952) if touched.
  `tours.spec.ts:282-288`: rewrite comment AND ADD a retirement assertion via
  `GET /api/tours/:id/reminders` (morning_of/en_route `state==='skipped'`,
  `skipReason==='tour_already_passed'`) - the existing absence assert is green either way.
  Also `tour-no-show-checkin.spec.ts:77-89`: leave for T9 (its confirmation bullet).
T4 (sweep) - report D s1 (frame, test idiom, key layout: bare `reminderId` hash, GSIs
  `byTour`/`byDueAt`, terminal attrs). `toursRepo.get` for the tour cache. RUNBOOK:
  model on `:262-285` (media content-type entry); state the sweep-then-deploy order and WHY.
T5 (unit vehicle) - report A s4 is the DERIVED classification (all cat1 rows with their
  6.1a-safe now/scheduledAt pairs). Write the worklist file the plan asks for by copying
  A s4 into `.superpowers/sdd/confirmation-conversion-worklist.md` with per-site outcome.
  Cat1 force-send rides (`:2523,:2851,:3240`) -> `seedForceTour` with a live kind.
  `devGating.test.ts:553-592` conversion is T7 (plan) - leave here.
T6 (e2e vehicle) - report D s3-s5. R12. Sites: `tours.spec.ts:130-133,199-200,242-244,
  279-280` cat1 -> `justAfter(await flow.armedReminderDueAt('day_before'))` + supersession
  expectation where a later rung's tick pulls earlier ones (ticking `day_before` - the
  EARLIEST live rung - pulls nothing; prefer it). Comment rewrites: `steps.ts:289-290,
  2035, 2248, 3596`, `steps.ts:1712` (60s->30s). Leave cat2/redesign sites
  (`scheduled-visibility.spec.ts:104-167,217-260`, `tours.spec.ts:290-300`,
  `tour-roster.spec.ts:480-523`, `tour-no-show-checkin.spec.ts:77-89`) for T9.
  Live-worker audit: record D s5.3/5.5 outcomes per spec in the conversion worklist.
T7 (DISCONTINUED + unpause) - reports A s1/s5, B s6, D s5. R4, R5. FULL file list:
  `jobs/tourReminders.ts`, `routes/dev.ts:405-423` (tour block ONLY - `:622` is the
  placement twin, DO NOT TOUCH), seam docblocks `routes/api.ts:391-398`,
  `routes/contactTimeline.ts:112-118`, `routes/tourReminders.ts:107-117`,
  `app/test/helpers/twilioWebhookHarness.ts:3930-3936`; tests `tourReminders.test.ts`
  (`:3279-3385` manual-only describe -> inject a set; `:3288-3295` membership assert ->
  assert EMPTY + DISCONTINUED holds confirmation), `devGating.test.ts:461-467,521-592`
  (first tick sends nothing; day_before at `2026-07-14T23:30Z`), `tourRemindersApi.test.ts
  :259,595,621,1546` (R5), `contactTimeline.test.ts:1243,1263,1291,1297` (R5),
  `tourRemindersApi.test.ts:1051-1138` (send-now on uncomposable confirmation now refuses
  `kind_retired` FIRST - pin that precedence, and move the invalid_schedule case to a live
  kind), e2e `quiet-hours.spec.ts:96-112,356-369,398-403` (EXACT inversion: QUIET_NOTE
  visible, PAUSED_NOTE absent; delete PAUSED_NOTE + the precedence prose). FULL app suite.
T8 (read surfaces) - report B s2-s5. R2, R3, R15. Three exhaustive Records: `types.ts
  :1259-1268`, `ScheduledCard.tsx:19-33`, `DeadlinesNudgesCard.tsx:64-73`; label functions
  `RemindersPanel.tsx:116-118`, `ScheduledCard.tsx:52-59`, `DeadlinesNudgesCard.tsx:100-101`
  (add the branch + docblock: unreachable today). Timeline reminder call site is
  `contactTimeline.ts:1001-1006` (short-circuit ahead of `suppressionFor`). Plus
  `routes/relayGroups.ts:266-336` per R3. Re-point the R2 fixtures. Component tests for
  the two chips. `steps.ts:3432` regex: leave (a discontinued card now fails loudly).
T9 (stop arming) - reports A s4 (cat2 list), B s7 (seeds + seedLive pins), D s4.
  R6, R7, R8. File list ADDS: `relayApi.test.ts:1469,1581,1585,1679`, `toursApi.test.ts
  :1341-1378,1507-1508,1546-1547,1695,2828-2830`, `seedLive.test.ts:86-95,168-259`,
  `live.ts:9-12,504-513,522-527,536-537`, `lean.ts:420-427`, `tourReminders.test.ts
  :414-437 (redesign), :1219-1254, :1556-1579 (redesign)`, e2e redesigns
  `scheduled-visibility.spec.ts:104-167,217-260` (D s4.3 has the derivation),
  `tours.spec.ts:290-300` (second re-arm proof - rebuild on day_before like its twin),
  `tour-roster.spec.ts:480-523` (R8), `tour-no-show-checkin.spec.ts:77-89` (drop the
  bullet), `quiet-hours.spec.ts:57-61` (rewrite the parenthetical), `steps.ts:289-290`
  if T6 did not. `REMINDER_KIND_LABELS.confirmation` STAYS (types.ts:1247, steps.ts:246).
  FULL app suite; the orchestrator runs the FULL e2e after this slice.
T10 (en_route + widening) - report A s1 (exact anchors), B s3-s4 (estimate disjuncts
  `routes/tourReminders.ts:561-564`; timeline REMINDER call site `:1001-1006`, never
  inside `quietFor` `:1305` / `suppressionFor` `:845`). R14 (`seedLive.test.ts:83`).
T11 (names bound) - report A s1: sites `:1037-1043` and `:1210-1216`; ledger-7 comment
  `:1204-1209`; `DEFER_WARN` string asserted at test `:3497-3498` - keep it verbatim for
  the inside-the-hour branch.
T12 (overdue) - report B s3 (`nowIso` block-scoped at `:529` - each builder computes its
  own), R15, R3 (issue body addition may land here or T15).
T13 (relay catalog) - report C s2-s3, s7. R10. `composeConnectionSentence` has ZERO code
  importers; four PROSE mentions to fix (`groupTitle.ts:60`, `relayGroupDuplicates.ts:11`,
  `groupTitle.test.ts:88`, `relayGroupDuplicates.test.ts:322`). member_added UNTOUCHED.
  Extend `catalog.test.ts:62-70` editable pin to the four new ids. Derive the byte-identity
  literal by RUNNING the pre-change composer first.
T14 (resolver + split) - report C s3-s7 (five call sites: `tours.ts:936,967`,
  `placements.ts:1262,1292`, `relayGroups.ts:372`; `addedMemberKey` is `relayMemberKey`,
  NOT a contactId - resolve `addedContactId` via `roster.find(m => relayMemberKey(m) ===
  payload.addedMemberKey)?.contactId`; `TourItem.scheduledAt` is OPTIONAL; `formatLocal*`
  THROW on unparseable -> wrap). R9, R10, R11. Pins to add to the plan's list:
  `toursApi.test.ts:4133-4135`, `relayApi.test.ts:296` (verify unchanged), `:1046,:1052`,
  `relayFanOut.test.ts:648` (row body !== leg body under 9.6), `rosterEdits.test.ts:488-495`,
  `rosterActionsPoll.test.ts:297-315` (check needles), `relayAnnouncements.test.ts` (add
  the bodyFor-omitted byte-identity case), e2e `roster-quiet-hours.spec.ts:485-486`
  (two DIFFERENT copies now), `relay-group-view.spec.ts:161,172` (R9). Switch
  `resolve.test.ts` probe to `relay.member_added_role`. Delete `ANONYMOUS_JOINED_LABEL`.
  FULL app suite; the orchestrator runs the FULL e2e after this slice.
T15 (docs) - report D s6. Ledger `docs/issues/tour-reminder-ladder-phase-b.md` ->
  resolved 2026-08-31 with the nine-row list; `tourCopy.ts:172-175` TODO re-point;
  R3 issue-body addition; `founder-handback-items.md`; `npm run issues`.

## 3. Sub-threshold notes for the handback (not build work)
- `routes/contactTimeline.ts` does not project `skipReason`; a `tour_already_passed`
  retirement simply leaves the Upcoming bucket. Consistent with the bucket's contract.
- `routes/dev.ts:965` replay-intros (`persist:false`) will replay VARIANT intros for
  seeded tour/placement-owned groups at boot; nothing asserts on it.
- `catalog.test.ts:23` `tokensIn` (`\w`) is broader than interpolate's charset; the T1
  structural test closes the gap.
