# WORKLIST - feat/tour-reminder-supersession (merged from research A/B/C/D)

Run state (ignored). Byte-exact quotes live in `.superpowers/sdd/research/{A-repo-seeds,B-jobs-routes,C-dashboard,D-tests-e2e}.md`;
this file is the slice-by-slice task map and the orchestrator's decisions. Cite as `A#1.8` = research A section 1.8.
Line numbers are LIVE at branch @38b1295f; they will drift as slices land - re-locate by NAME.

Spec: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
Plan: `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md`
Findings record (drift, committed): `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/research-findings.md`

## Slice-order safety property (re-derived against the live tree)

Nothing deletes until everything that refuses a superseded rung exists.
- S1-S7 write NO delete caller. `deleteSupersededForTour` exists from S1 but has zero callers until S8.
- Refusers that must exist before S8: poll pointer check (S5 T5.3), Send-now refusal (S5 T5.5), three preview surfaces (S6),
  read partition (S7). All land before S8.
- S8's own backstop: rotation INSIDE the finalize patch (T8.3) - a sweep-missed row on a converted tour is refused by S5, never sent.
- `cancelTourReminders` STAYS at tours.ts:1190/:1208 and placements.ts:716 through S3-S7; S8 replaces the placements site, S9 the two tours sites.
- S10/S11 are layout/test work and do not touch the property.
Any reordering must re-derive the four bullets above and record the derivation in progress.md.

## ORCHESTRATOR DECISIONS (spec-vs-tree calls; both readings honor intent - recorded, not reopened)

| # | decision | why |
| --- | --- | --- |
| O1 | T1.3 ships as a NARROW method `setLadderIdIf(tourId, expected, next): Promise<boolean>` on `ToursRepo`, condition `attribute_exists(tourId) AND #cl = :expected`, `false` on CCFE (never throws for a lost compare). | Matches the repo's own single-attribute conditional-write idiom (`claimConversion` / `releaseConversionClaim`, A#2.3, A#2.5). An `expectedLadderId` option on `patch` would collide with the generated `#k${i}` keys and widen every caller. |
| O2 | T1.4 lives in `app/test/tourReminders.test.ts`'s existing DDB-Local describe (`:232`); it gains `GetCommand`/`DeleteCommand` imports from `@aws-sdk/lib-dynamodb`. T3.3's real ConditionExpression proof lives in `app/test/toursRepo.integration.test.ts`. The route-level interleaving test (two reschedules) lives in `toursApi.test.ts` against the FAKE, which therefore needs REAL compare semantics. | D#2.3, D#3. Route suites are fake-only; the fake's claim methods already return false on a missing row. |
| O3 | T5.4's stuck-conversion token is `conversion_stalled` (`ReminderSkipReason` only - it is a poll claim-skip, never a suppression). Grace: own constant `CONVERSION_CLAIM_GRACE_MS = 60 * 60 * 1000`, measured from `row.dueAt` exactly like `rosterWaitExpired` (`lib/rosterResolution.ts:110-115`). | Plan says name it and follow the bounded-wait pattern; no name was given. |
| O4 | T5.5: HOIST one `deps.toursRepo.get(tourId)` in `forceSendReminder` right after the row lookup (`:1618-1623`) and pass the tour into `resolveReminderTarget` (it already accepts a pre-fetched tour, B#1c #6) - ONE read total. The `superseded` refusal sits immediately AFTER `kind_retired` (`:1632-1638`), keeping the existing "kind_retired first" precedence comment intact. | B#1d, B#9.8. Zero extra reads; precedence argument preserved. |
| O5 | T7.6/T7.7: server emits `earlier: TourReminderEarlierView[]` where `TourReminderEarlierView = Omit<TourReminderView, 'body'> & { body?: string }`; `body` is set ONLY from `sentBody` (never composed). The dashboard mirrors the type and renders NO body paragraph when `body` is undefined (NOT the "Preview unavailable" copy). Actions are derived CLIENT-side by state per spec 3.4 table; no server `actions` field. | B#4d, B#9.7: `bodyFor` recomposes live and its header forbids single-copy edits - a separate projection is the only honest shape. |
| O6 | T4.1: pointer set INSIDE `seedLive` AFTER each arm - mutate the same tour object that was Put and re-Put it (or one `UpdateCommand`); implementer says which. T4.4 closes as NOTHING TO CHANGE (performanceSeed writes no reminder rows, A#6.4). T4.5: ROTATE every seeded terminal tour's pointer (8 matrix + cast `TOUR_TOURED`) to a deterministic literal that no row carries; all seed `ladderId`s are deterministic literals (e.g. `ladder-mx-<tourId>`, `ladder-cast-<slug>`), never `randomUUID()`. | A#6.1-6.3. Terminal-with-matching-pointer is a state production cannot produce post-feature; rotating exercises acceptance 6/10 in the demo world. cast is byte-stable. |
| O7 | T9.3 / acceptance 1 is proven in `app/test`: repo-layer delete semantics in T1.5's DDB-Local tests + a route-level `toursApi.test.ts` case (two reschedules against the fake; the fake store holds exactly one generation's unsent rows). e2e `scheduled-visibility.spec.ts` asserts the old rung is ABSENT from the panel (from `reminders[]` AND `earlier[]`). | D#4e: nothing under `e2e/` can read DynamoDB. Storage claim proven at the storage layer. |
| O8 | Spec acceptance 14 amended to `NARROW_360` (360px); spec 3.6 amended to SIX writers (adds `scrollToBottom`). | PB-11 and PA-5/PB-3 were accepted in the plan but never amended upstream - the PB2-1 lesson (spec first). |
| O9 | T10.2 visuals: keep the block full-bleed inside `.stream` via negative inline margins (`margin-inline: calc(-1 * var(--sp-3))`) so it reads as the stream's footer strip, not an inset card; trim the doubled gap. Verify LIVE in Phase 5 and revisit there if it reads wrong. | C#4.3 G1/G2 - a design polish call within scope, checked by eye. |
| O10 | S11 work is folded into the slice that breaks each test (S2: array bindings; S6: relayApi fixture; S8: placementConvert; S9: toursApi/tourReminders/e2e; S10: Timeline.test). S11 itself becomes the closing GREP + sweep for stragglers. | A test left red across a slice boundary hides the next slice's regressions. |

---

## S1 - Repo foundations (no callers; additive)

Files: `app/src/repos/tourRemindersRepo.ts`, `app/src/repos/toursRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/tourReminders.test.ts`, `app/test/toursRepo.integration.test.ts`.

- T1.1 `ladderId?: string` on `TourReminderItem` (A#1.3, `:94-121`, NO index signature) and on `create`'s inline input type (A#1.4 `:128-133`); `create` copies it via the conditional-spread idiom (A#1.5 `:204-207`).
- T1.2 `currentLadderId?: string` on `TourItem` (A#2.1). NOTE `[key: string]: unknown` at `toursRepo.ts:105` means `patch({ currentLadderId })` compiles TODAY and so does a typo - the declaration is documentation; every S3/S4/S8 test asserts on the STORED row.
- T1.3 per O1: `setLadderIdIf` declared after `releaseConversionClaim` (`:183`), implemented after `:443`; `UpdateExpression 'SET #cl = :next, #updatedAt = :now'`. RED FIRST in `toursRepo.integration.test.ts` (skeleton D#2.2): stored value differs -> returns false AND the stored row is unchanged (raw `GetCommand`); matches -> true and the row carries `next`. Real ConditionExpression against DDB Local.
- T1.4 RED FIRST in `tourReminders.test.ts` DDB describe (A#7.3 has the exact test body): create -> raw `DeleteCommand` -> `claimSend` returns false AND raw `GetCommand` finds NOTHING. Watch it FAIL on main's code (stub resurrects). Then add `attribute_exists(reminderId) AND ` (bare key, no alias - A#4) to `claimSend` `:291-292`, `claimSkip` `:327-328`, `cancel` `:359-360`. Do NOT touch `uncancel` (`:389-396`). Also cover claimSkip and cancel against a deleted row.
- T1.5 `deleteSupersededForTour(tourId): Promise<void>` on the interface (after `cancelForTour` `:183`) - skeleton = `cancelForTour` (A#1.9) with `DeleteCommand` + `ConditionExpression: 'attribute_not_exists(#sentAt)'`; the ONLY filter is `r.sentAt === undefined` (NOT the `pending` triple at `:412-414`). CCFE -> debug, other errors -> `log.error` and continue (copy the CODE at `:446`, not the lying comment at `:438`). Tests (DDB Local): pending/canceled/skipped deleted; sent kept; a row that gains `sentAt` between list and delete survives (drive it by `claimSend` inside the test, e.g. via an injected doc wrapper - precedent D#2.5 `retirePausedTourReminders.test.ts:288-297` - or by claiming before calling the sweep with a pre-listed set). Import `DeleteCommand` in the lib-dynamodb block and DELETE the unused `GetCommand` import at `:14` (pre-existing lint error; name it in the slice report).
- T1.6 fakes (`twilioWebhookHarness.ts`): (1) fake `TourRemindersRepo` (`:2930`) gains `deleteSupersededForTour` (delete every map row for the tour with no `sentAt`); (2) fake `create` (`:2931-2954`) copies `ladderId` - read the scar comment `:2939-2945` first; (3) leave the claim methods' missing-row `false` alone (`:2972-2975` etc.); (4) fake `ToursRepo` (`:2801`) gains `setLadderIdIf` with REAL compare semantics: synchronous check-and-set, returns false when `t.currentLadderId !== expected` (precedent `claimConversion` `:2878-2892`). `cancelForTour` STAYS in the fake and the real repo until S9.
- Still-compiles list: only the two fakes implement either interface (A#3.4). `tourReminders.test.ts:2738` spreads the real repo - inherits.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/tourReminders.test.ts test/toursRepo.integration.test.ts test/retirePausedTourReminders.test.ts`.
- Does NOT: touch any caller, jobs, routes, seeds, dashboard.

## S2 - Armer stamps and returns `{ ladderId, rows }`

Files: `app/src/jobs/tourReminders.ts`, `app/src/lib/seed/live.ts` (3 lines), `app/test/tourReminders.test.ts` (14 bindings), `app/src/routes/tours.ts` (2 discards - unchanged semantics).

- T2.1 RED: all rows of one call share `ladderId`; two calls differ; born-skipped rows carry it too. Assert on returned rows.
- T2.2 mint `randomUUID()` once per call (`:377-383`); pass `ladderId` to all FOUR `create` calls `:491`, `:513`, `:545`, `:558` (B#1a). The silent skip at `:505-508` writes nothing.
- T2.3 return type `Promise<{ ladderId: string | null; rows: TourReminderItem[] }>`; `ladderId: null` when `rows.length === 0` (both the `:388-392` early return and the all-skipped loop). `ArmTourRemindersDeps` gains NOTHING.
- Still-compiles (B#1b): `live.ts:519/:533/:543` `.length` -> `.rows.length`; `tourReminders.test.ts` array bindings at `:318, :382, :437, :483, :549, :587, :643, :686, :723, :1437, :1518, :4593, :4691, :4727` -> destructure `{ rows }`. Discards (`tours.ts:350/:1191`, `relayApi.test.ts:1454`, `tourReminders.test.ts:1330/:1347/:1382/:3109/:3461`) compile unchanged.
- Fast gates: `npm run typecheck` (THE gate here); `cd app && npx vitest run test/tourReminders.test.ts test/seedLive.test.ts`.

## S3 - Tour pointer writes (cancelTourReminders STAYS)

Files: `app/src/routes/tours.ts`, `app/test/toursApi.test.ts` (new cases), `app/test/toursRepo.integration.test.ts` (if CAS proof still owed).

- T3.1 CREATE `:294-370`: after the arm (`:349-354`) capture `{ ladderId }`; if non-null `tours.patch(tourId, { currentLadderId })` and respond with the POST-patch tour (`patch` returns ALL_NEW, A#2.2 `:357-361`). RED: 201 body `currentLadderId` === every armed row's `ladderId` (read `world.tourRemindersMap`). Pointer-write failure -> `log.error({ err, tourId }, ...)` (T3.6 - stamped rows with no pointer are REFUSED post-S5, not exempt; loud).
- T3.2 PATCH: hoist the `effectiveStatus` / `armable` / `rearmTrigger` derivation (`:1180-1185`) ABOVE the single write at `:1164` (B#2b - the one structural edit). When `armable && rearmTrigger` OR terminal (`canceled|closed|toured|no_show`), mint `rotation = randomUUID()` and set `patch['currentLadderId'] = rotation` BEFORE `:1164`. Then (re-arm branch) `cancelTourReminders` stays at `:1190`, arm, then T3.3.
- T3.3 after the arm: `if (ladderId !== null) { const won = await tours.setLadderIdIf(tourId, rotation, ladderId); if (!won) log.error({ tourId, rotation, ladderId }, 'tour reminders: pointer write lost a concurrent reschedule - ladder unpointed'); }`. RED (route-level vs fake): two interleaved reschedules -> the tour's pointer names a ladder whose rows EXIST in the fake store; loser logs at error (logCapture). The real ConditionExpression is proven by S1's T1.3 test.
- T3.4 terminal: rotation only (no arm, no sweep yet; cancel stays at `:1208`). RED: after a terminal patch, `world.toursMap.get(id).currentLadderId` is PRESENT and matches no row.
- T3.5 response: `:1284 res.json({ tour })` must carry the FINAL pointer - after T3.3 splice `tour = { ...tour, currentLadderId: ladderId }` when won (or re-read). CREATE 201 likewise (T3.1).
- T3.6 logging (B#1g idiom): arm failure after rotation -> `log.error({ err, tourId }, 'tour reminders: arm failed after pointer rotation - tour is DISARMED')`. Test with logCapture.
- `rosterProvision.ts:398` audited INERT (SET-merge of `groupThreadId`), B#7b.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/toursApi.test.ts test/tourRemindersApi.test.ts test/toursRepo.integration.test.ts`.

## S4 - Seeds (must land before S5)

Files: `app/src/lib/seed/live.ts`, `matrix.ts`, `cast.ts`; tests `app/test/seedLive.test.ts`, `seedMatrix.test.ts`, `seedMatrixCoherence.test.ts`, `seedCast*.test.ts` (locate by grep).

- T4.1 per O6: after each of `:514/:528/:538`, when `ladderId !== null`, set `tour.currentLadderId` on the SAME object and re-Put (or UpdateCommand). RED: after `seedLive`, every reminder row's `ladderId` === its tour's `currentLadderId` (read both tables raw).
- T4.2 `matrix.ts` (A#6.2): one deterministic `ladderId` per tour across `:990-998` (sent confirmation) and `:1005-1013` / `:1024-1032` / `:1037-1045` (day_before variants); `tour['currentLadderId']` set on the literal `:974-984`. For the 8 TERMINAL tours (toured/no_show/canceled/closed x2) set the pointer to a DIFFERENT deterministic literal (rotated). Assert: scheduled tours -> both rows CURRENT; terminal tours -> pointer present and matching no row.
- T4.3 `cast.ts:780-808`: stamp the three sent rows with a literal `ladderId`; `TOUR_TOURED` (`:755-768`, terminal) gets a rotated literal pointer. `searchingTenant.tour` stays bare (pre-migration fixture, acceptance 12). Note the consequence: TOUR_TOURED's three rows become `earlier[]` and (no `sentBody`, `:774-779`) render bodyless - consistent with acceptance 11; confirm no e2e asserts their body text (D#4f says none).
- T4.4 CLOSED: `performanceSeed.ts` writes no reminder rows (A#6.4). Say so in the slice report.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/seedLive.test.ts test/seedMatrix.test.ts test/seedMatrixCoherence.test.ts` + any cast seed test.

## S5 - Refusal

Files: `app/src/repos/tourRemindersRepo.ts` (union), `app/src/services/scheduledSendSuppression.ts`, `app/src/jobs/tourReminders.ts`, `dashboard/src/api/types.ts`, `dashboard/src/api/types.test.ts`, `dashboard/src/routes/contact/ScheduledCard.tsx`, `dashboard/src/routes/tours/RemindersPanel.tsx`, `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx`, tests.

- T5.1 add `'superseded'` and `'conversion_stalled'` (O3) to `ReminderSkipReason` (append after `:92`, one JSDoc each, A#1.2); add `'superseded'` ONLY to `ScheduledSuppressionReason` (`:9-11`) + the head comment's caller list; evaluator body untouched (B#6). Add both tokens to `claimSkipRow`'s docblock taxonomy (`:790-801`).
- T5.2 census - the checklist is C#1.4, walk it TWICE. `superseded`: U1 `types.ts:1147` -> forces E1 `:1286`, E3 `ScheduledCard.tsx:19`, E4 `DeadlinesNudgesCard.tsx:64` (compile-completeness entry only, comment like `:73-77`; NO chip branch, `:103-109`); U2 `types.ts:1223` -> forces E2 `:1301`; manual: U5 `types.ts:1181` suppressionLead, U3 `SEND_NOW_ERROR_COPY` `:1327` (409 entry with its OWN sentence), U9/U11/U12 `types.test.ts:98/:142/:157`, U14 `RemindersPanel.tsx:85` (refetch skip), U15 `:136` chip, U16 `:397` Send-now gate (hide for superseded), U17 `:453` tone, U6 `ScheduledCard.tsx:57` (ABOVE `paused` and above `overdue`, comment why), U20 `:127`. `conversion_stalled`: U2 -> E2; U3; U9; U11. Do NOT widen `NUDGE_SKIP_REASON_LABELS` (`DeadlinesNudgesCard.tsx:48`, separate union). Assertion per unforced surface: extend `types.test.ts` hand-lists (they are two-sided exact-set tests) and add a `RemindersPanel.test.tsx` case that a superseded rung shows the label text and no Send now.
- T5.3 poll: in `processReminderRow` between `:1065` and `:1067` (B#1c) - DEFERRAL FIRST then POINTER CHECK, both above the batch-supersession stamp at `:1085`: `const mismatch = tour.currentLadderId !== undefined ? row.ladderId !== tour.currentLadderId : row.ladderId !== undefined;` -> `claimSkipRow(row, 'superseded', ...)`. Exempt: tour has NO attribute AND row has no `ladderId`. Comment the position (POSITION IS BEHAVIOUR). Tests: mismatch skipped `superseded`; legacy exempt sends; a stamped row on a pointerless tour is REFUSED (T3.6's case).
- T5.4 deferral: predicate `typeof tour.convertedPlacementId === 'string' && tour.convertedPlacementId.startsWith('pending:')`; inside grace -> `return` UNCLAIMED (log.info); past `CONVERSION_CLAIM_GRACE_MS` from `row.dueAt` -> `log.error` + `claimSkipRow(row, 'conversion_stalled', ...)`. Tests: in-window deferred (nothing stamped, re-listed next tick); past window retired with the token; a FINALIZED tour (real placement id) is NOT deferred.
- T5.5 per O4: hoist tour read; `superseded` refusal after `kind_retired`; add `'superseded'` to `ForceSendRefusal` (`:1538-1574`). Route mapping is automatic (409 with raw code, `routes/tourReminders.ts:482-487`). Test in `tourRemindersApi.test.ts`: 409 `{ error: 'superseded' }`; dashboard `sendNowErrorMessage('superseded')` returns the specific sentence (types.test.ts PERMANENT_REFUSALS).
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/tourReminders.test.ts test/tourRemindersApi.test.ts`; `cd dashboard && npx vitest run src/api/types.test.ts src/routes/tours/RemindersPanel.test.tsx src/routes/contact/ScheduledCard.test.tsx` (if exists).

## S6 - Three preview surfaces agree

Files: `app/src/routes/tourReminders.ts` (GET projection `:619-675`, short-circuit `:642-648`), `app/src/routes/contactTimeline.ts` (`:1029-1037`), `app/src/routes/relayGroups.ts` (`:343-345`), `app/test/relayApi.test.ts` (fixture), tests for each.

- Shared predicate: export a pure `isSupersededRung(row, tour): boolean` (mismatch per T5.3, with the pre-migration exemption) from a small module (e.g. `app/src/lib/ladderPointer.ts`) and use it at all FOUR sites (poll + three surfaces) so they cannot disagree. Unit-test the predicate's four cells (pointer x ladderId present/absent).
- T6.1 panel GET: pending + superseded -> `suppression: { reason: 'superseded' }` ahead of the `discontinued` arm (`:642-648`), and it is NOT eligible for `next` (`:686-688`). (S7 then moves such rows into `earlier[]`; keep `suppression` on them.)
- T6.2 contactTimeline `:1029-1037`: a ternary arm ahead of `discontinued`; the tour is in hand (`:980`).
- T6.3 relayGroups `:343-345`: second exception spread, justified in the `:336-342` voice; tour at `:221`.
- Fixture hazard (D#1.4): `relayApi.test.ts` `seedTourGroup` `:1440-1461` arms for real against a hand-made tour -> set `currentLadderId` from the armer's return or `:1477` fails. Audit every test that arms for real and writes its tour by hand (`tourReminders.test.ts` creates via `tours.create` and never points - each affected case needs the pointer or asserts refusal deliberately).
- One RED per surface on the same mismatch fixture + one legacy (bare tour, bare rows -> NOT suppressed) per surface.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/tourRemindersApi.test.ts test/contactTimeline.test.ts test/relayApi.test.ts test/tourReminders.test.ts`.

## S7 - Read grouping, `earlier[]`, disclosure, allowlist, 404s

Files: `app/src/routes/tourReminders.ts`, `dashboard/src/api/types.ts` (`TourRemindersPage` `:1258-1270`), `dashboard/src/api/endpoints.ts` (`:2506` doc), `dashboard/src/routes/tours/RemindersPanel.tsx` (+ `.module.css`, `.test.tsx`), `app/test/tourRemindersApi.test.ts`.

- T7.1 partition with the shared predicate: CURRENT -> `reminders[]` (feeds `next`); EARLIER -> `earlier[]`.
- T7.2 `earlier[]` sort: `(sentAt ?? dueAt)` DESC, tie `reminderId` asc.
- T7.6/T7.7 per O5: `TourReminderEarlierView` projection - state, stamps, skipReason, `suppression` (superseded when pending), `body` only from `sentBody`. Export the type; mirror in `types.ts`.
- T7.3 disclosure as a second child of `<Card>` at `RemindersPanel.tsx:472` (OUTSIDE the ternary, C#2.1); raw `<details>/<summary>` (no shared component, C#2.5) - collapsed by default (T7.4); summary text like `Earlier reminders (N)`. Add `earlier` to `Committed` (`:175-189`) and BOTH `setState` calls (`:215-222`, `:228-235`) - G3. RED: zero current + two sent earlier -> "No reminders armed." AND the disclosure both render; assert on the RENDER.
- T7.5 allowlist by state (client): sent -> none; upcoming -> Cancel only, aria-label `Cancel the earlier ${kindLabel} reminder` (distinct from the current-ladder name, G4); canceled -> none; skipped -> none. Reuse `onToggleCanceled` for the Cancel (PATCH). Body: render none when `body` undefined (no "Preview unavailable").
- Chip: `StateChip` handles a superseded earlier rung via U7/U15 (already done in S5 - verify it renders the label, not "sends in").
- T7.8 `:395` and `:462`: `after === undefined` -> 404 `{ error: 'reminder_not_found' }`; on the PATCH path keep the `scheduled.updated` emit (`:416`) when `won` (hoist the emit above the undefined check or guard the 404 branch with the emit). Tests: deleted-between-write-and-reread -> 404 + emit observed.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/tourRemindersApi.test.ts`; `cd dashboard && npx vitest run src/routes/tours/RemindersPanel.test.tsx src/api/types.test.ts`.

## S8 - Conversion (FIRST slice that deletes)

Files: `app/src/routes/placements.ts`, `app/test/placementConvert.test.ts`.

- T8.1 remove the `cancelTourReminders` call at `:715-720` (and its release wrapper); AFTER the finalize succeeds call `reminders.deleteSupersededForTour(tour.tourId)` in a try/catch that `log.error`s and never fails the 201 (T8.4).
- T8.3 mint `const rotatedLadderId = randomUUID()` above the finalize `try`; finalize patch at `:758` becomes `{ status: 'closed', convertedPlacementId: created.placementId, currentLadderId: rotatedLadderId }`. Update the ordering comment `:692-698` (steps 3-6) and add the T8.5 comment (no `scheduled.updated`; post-S8 the stale rows are DELETED not canceled).
- T8.2 RED both failure paths: `create` throws / finalize throws -> tour keeps every rung, pointer unchanged, nothing stamped `superseded`; a rung due inside the claim window is deferred (drive the poll against the fake with the sentinel present).
- Success path RED: pointer rotated (present, matches no row), unsent rows GONE from `world.tourRemindersMap`, sent rows remain. Re-point `:50/:107-111` (name + assertion, D#1.3); import `cancelTourReminders` at `:53` goes away here.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/placementConvert.test.ts test/placementsApi.test.ts test/placementsRelay.test.ts`.

## S9 - tours.ts swaps cancel for the sweep; old wrapper removed

Files: `app/src/routes/tours.ts`, `app/src/jobs/tourReminders.ts`, `app/src/repos/tourRemindersRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`, `app/test/toursApi.test.ts`, `app/test/tourReminders.test.ts`, `e2e/tests/scenarios/scheduled-visibility.spec.ts`, `e2e/scenarios/steps.ts`, `e2e/tests/scenarios/tours.spec.ts` (comments).

- T9.1 replace both `cancelTourReminders` sites (`:1190`, `:1208`) with `reminders.deleteSupersededForTour(tourId)`; order: rotate (in the patch) -> sweep -> arm -> CAS. Sweep failure on the re-arm path: log at error and CONTINUE to arm (the rotation already refuses the old rows).
- T9.2 grep `cancelTourReminders|cancelForTour` across app/ e2e/ dashboard/; expected: `jobs/tourReminders.ts:570-586`, `repos/tourRemindersRepo.ts:183/:410-450`, fake `:3011-3024`, tests `tourReminders.test.ts:49/:1339/:1371/:1396/:1753/:1890`, comment `toursApi.test.ts:1231`. A hit outside this list = STOP and report. Delete function + interface member + fake member.
- Re-points (D#1.1, D#1.2): `tourReminders.test.ts:1313` -> sweep then exactly the fresh ladder; `:1371` -> becomes a `deleteSupersededForTour` route-driven case or is dropped as duplicate of T1.5 (say which); `:1713`, `:1839` swap vehicle to `tourReminders.cancel`. `toursApi.test.ts`: `:1587-1588` HARD -> rows ABSENT + pointer rotated; `:1254`, `:1268`, `:1546`, `:1699`, `:2834-2836` vacuous -> assert absence + pointer; fix comment `:1229-1232`; `:1315` add a current-ladder filter. T9.3 (O7): two reschedules -> fake store holds exactly one generation's unsent rows; pointer matches them.
- e2e: `scheduled-visibility.spec.ts:268` -> assert `morning_of` of the OLD ladder is absent (add an `expectReminderRungAbsent`-style verb in steps.ts; rewrite the `:245-261` comment); `steps.ts:3612-3645` docblock prose fixed, `:3656`/`:3661` filter kept (hand-cancel still exists); `tours.spec.ts:315-320` comment.
- Fast gates: `npm run typecheck`; `cd app && npx vitest run test/toursApi.test.ts test/tourReminders.test.ts test/tourRemindersApi.test.ts`; e2e for the touched specs is run in Phase 3 (do not run the full suite here).

## S10 - Upcoming block inside the scroll (independent of S1-S9)

Files: `dashboard/src/routes/contact/Timeline.tsx`, `Timeline.module.css`, new `dashboard/src/routes/contact/streamAnchor.ts` + `.test.ts`, `Timeline.test.tsx`, e2e (new spec or extension in `tour-roster.spec.ts` / `relay-group-view.spec.ts`), `e2e/scenarios/steps.ts` (verify `:3595/:3677` chains).

- T10.1 move `:2102-2111` to be the LAST child of `.stream` (closes `:2089`), after a zero-height sentinel `<div data-testid="stream-sentinel" aria-hidden="true" />` placed after the clusters map. Keep `aria-label`/heading/list nesting (`region > upcomingList > card` - the four e2e `> div > div` chains depend on it, D#4a). Update the stale prose at `Timeline.tsx:235-237`, CSS `:640-642`, `:149-155` (G6).
- T10.2 CSS: delete `max-height` `:652`, `overflow-y` `:653`, `flex` `:645`; delete the phone block `:661-667` (the `.upcoming` one of THREE 767.98px blocks); per O9 negative inline margins + gap trim. Leave `.stream` `:110-147`, `.streamWrap` `:66-77`, `.newPill` `:79-108`.
- T10.3 `deriveStreamAnchor({ sentinelBottom, viewportBottom, hasBlock }): 'sentinel' | 'below' | null` - pure numbers; `below` = sentinelBottom < viewportBottom (direction, any amount) and only when `hasBlock`; `sentinel` = 0 <= sentinelBottom - viewportBottom <= 48; `null` otherwise. No block: `below` unreachable -> identical to `isAtBottom` (48px slack against true bottom). Unit-test all bands + small-block + no-block.
- T10.4/T10.5 replace `atBottomRef: boolean` with `anchorRef: 'sentinel' | 'below' | null` and convert the SIX writers (C#3.1): W1 `scrollToBottom` `:1840-1846` -> scroll sentinel to bottom edge, anchor `sentinel`; W2 `handleStreamScroll` `:1851-1853` -> re-derive; clear pill when `sentinel` or `below`; W3 conversation-switch `:1888-1891` -> scroll to sentinel, anchor `sentinel`; W4 prepend restore `:1900` UNCHANGED; W5 growth pin `:1911-1913` -> `sentinel` => scroll sentinel to edge; `below` => preserve distance from true bottom; `null` => pill if grew; W6 `handleSend` `:1976` -> anchor `sentinel`. Sentinel scroll = `el.scrollTop = sentinel.offsetTop + sentinel.offsetHeight - el.clientHeight` (no `scrollIntoView` - it can scroll ancestors).
- T10.6 `ResizeObserver` on the block ONLY, guarded (`typeof ResizeObserver !== 'undefined'`, precedent `TourConversation.tsx:356-359`), feeding a `blockHeightTick` state that is a dep of the layout effect alongside `[clusters, resetScrollKey, paging?.olderPagesLoaded]` (`:1920`); NOT `upcoming` (fresh `[]` at `GroupTextView.tsx:451`). Test with a drivable fake (`vi.stubGlobal`, precedent `TourConversation.test.tsx:585-606`) - the global stub at `src/test/setup.ts:42-48` never fires (G5).
- Timeline.test.tsx `:1410/:1436/:1468` re-point (D#1.6): mock the sentinel's geometry (`offsetTop`/`offsetHeight` via `Object.defineProperty`, or `getBoundingClientRect` spy - precedent `StatusMenu.test.tsx:178`) so "pins to bottom" means the sentinel lands at the viewport edge; `:1423/:1455` re-express via anchor `null`/`sentinel`. Keep all five as the NO-BLOCK regression net. Add block-present cases: standing on the block + growth -> no scroll, no pill; scrolled above -> pill.
- T10.7/T10.8 e2e at `NARROW_360` + `WIDE_RESTORE` pairing (D#4b): a relay-group thread through `ConversationDetail` with a live Upcoming bucket (tour-owned relay group - `tour-roster.spec.ts` already has the ladder + viewport imports; or `relay-group-view.spec.ts`). Assert: opening lands with the sentinel visible and the block NOT within the viewport when messages overflow (probe `scrollHeight > clientHeight + 1` and the region's boundingBox vs viewport); scroll to bottom reveals the block; scroll up hides it; inject an inbound while ON the block -> `scrollTop` unchanged (poll, tolerate fractional - `thread-history-paging.spec.ts:149-151`) and no pill; scrolled above -> pill appears, click -> lands on newest message and pill clears. Use `page.setViewportSize`, never `test.use`.
- T10.9 live phone QA is Phase 5 (orchestrator).
- Fast gates: `npm run typecheck`; `cd dashboard && npx vitest run src/routes/contact/Timeline.test.tsx src/routes/contact/streamAnchor.test.ts src/routes/conversation/ConversationDetail.test.tsx`.

## S11 - Closing sweep

- Grep `cancelForTour|cancelTourReminders|canceledAt` (app/test, dashboard tests) AND `Canceled|reschedul` (e2e) - the e2e half of the plan's grep returns zero by construction (D#1.5).
- Confirm the four e2e Upcoming-region sites still resolve (`steps.ts:3595/:3677`, `placements-page.spec.ts:205`, `tour-comms-pane.spec.ts:226`) and the five dashboard ones (`Timeline.test.tsx:1030-1059`, `ConversationDetail.test.tsx:291/:322`).
- Anything still encoding the old contract that the slices above missed.

## Deliverables owned by the orchestrator (not a slice)

- Research findings record (committed). Spec amendments O8 (committed).
- Adjudication + slice reports -> `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/` as produced.
- Issues to file if surfaced: none yet.
- Handback names the pre-existing lint error cleared at `tourRemindersRepo.ts:14`.
