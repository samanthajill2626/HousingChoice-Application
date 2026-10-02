# Drift check - S1 (model) and S2 (repo + harness fake)

- Date: 2026-10-01. Reader: read-only research child (no source or test edits).
- Tree: worktree `W:\tmp\tour-auto-close`, HEAD f319a306 = main @ae04122d plus
  docs-only commits (`git diff --stat ae04122d HEAD -- app dashboard e2e` is
  empty). Every contract below was read from the live code, not from the plan.
- Byte-exact quotes for each item are in the gitignored reference
  `.superpowers/sdd/research/ref-s1-s2-model-repo.md` (section numbers given as
  "ref 4i" and so on).
- Verdict: nothing makes an S1/S2 task impossible. There are 5 plan
  corrections (items 1-5), 7 heads-ups that change how a step is carried out
  (items 6-12), 6 spec gaps or risks (items 13-18), and the invariant-sweep
  result (items 19-21).

## A. Plan corrections (the plan says X -> the tree has Y -> the instruction becomes Z)

1. **Task 2.3, real repo: `isAutoCloseStatus` cannot go in the existing import.**
   The plan says "(Both files import `isAutoCloseStatus` from
   `lib/toursModel.js`; the repo already imports types from there.)". In the
   tree, toursRepo.ts:38 is a TYPE-ONLY import (`import type { TourType } ...`),
   and Task 2.1 keeps it type-only
   (`import type { AutoCloseStatus, TourOutcome, TourType }`). Adding the value
   `isAutoCloseStatus` to that list fails tsc with TS1361 ("cannot be used as a
   value because it was imported using 'import type'"). The instruction
   becomes: in Task 2.3, turn line 38 into a mixed import,
   `import { isAutoCloseStatus, type AutoCloseStatus, type TourOutcome, type TourType } from '../lib/toursModel.js';`
   and keep `export type { TourOutcome, TourType };`. This is safe:
   - routes/tours.ts:50-61 already uses the inline-`type` mixed style;
   - eslint.config.mjs has no consistent-type-imports rule;
   - toursModel.ts has no imports, so this creates no cycle;
   - the compiled toursRepo.js gains a real import of `dist/lib/toursModel.js`,
     which the smoke gate resolves.

2. **Task 1.1, routes/tours.ts imports: the two removals are mandatory, and a
   third unused import is already there.** The plan says to drop
   `isTourOutcome` / `TOUR_OUTCOMES` "if no longer used". In the tree, both are
   used ONLY at routes/tours.ts:1047-1048, so after the switch they are always
   unused and MUST go (import lines :52 and :56). Separately,
   `type TourOutcome` at routes/tours.ts:58 is ALREADY unused. The lint baseline
   on main is `58:8 '@typescript-eslint/no-unused-vars'`, and it is the only
   error across all seven S1/S2 files I linted (ref 12). No later plan task
   uses `TourOutcome` in that file: S6 uses `reopenTargetFor` and
   `AutoCloseStatus`. The instruction becomes:
   - replace `isTourOutcome` / `TOUR_OUTCOMES` with `isStaffTourOutcome` /
     `STAFF_TOUR_OUTCOMES` in the import statement;
   - the orchestrator decides line :58. Either drop it in the same statement
     edit (the file then lints clean), or leave it and NAME it in the handback as
     pre-existing (gate 5's merge-base run reports it too).

3. **Task 2.3, fake: the harness has no `toursModel` import at all.** grep
   finds no `toursModel` in twilioWebhookHarness.ts. The instruction becomes:
   add `import { isAutoCloseStatus } from '../../src/lib/toursModel.js';` to the
   harness import block (beside the toursRepo import at :153-157).

4. **Task 2.4 RED case 1: `read` must be the post-close item.** The plan says
   "a tour closed by `autoCloseIf` from scheduled: `reopenIf(read, 'scheduled',
   ...)`". In Task 2.3, `read` names the pre-close read. That read carries no
   `outcome` or `autoClosedFrom`, so reopenIf's equality terms become
   `attribute_not_exists(outcome)` / `attribute_not_exists(autoClosedFrom)`.
   Those terms fail against the closed row, and a CORRECT implementation then
   returns `undefined` and the case goes red. The instruction becomes: pass the
   item `autoCloseIf` returned (ALL_NEW), or re-read (`rawTour` / `get`) after
   the close. The same applies to the fake-parity copy of the case.

5. **Tasks 1.1-1.3: non-ASCII bytes sit inside the regions being edited.**
   - toursModel.ts carries U+2014 at :1, :22, :33 and :67, and U+2192 at :5 and
     :125.
   - The Task 1.3 header rewrite (:7-34) includes :22 and :33. Any line in
     :7-34 that is re-flowed or rewritten (notably :33, "...NOT handled here
     <U+2014>") must come out ASCII.
   - The Task 1.1 block replacement (:64-83) removes :67's em dash. The
     replacement is ASCII, so that is fine.
   - In toursModel.test.ts, every existing describe title uses U+2014 (:17,
     :41, :69, :93, :120, :126, :143). New titles must use " - " (the plan's
     titles already do), so do not clone an existing describe line as a
     template.
   - The anchors the plan names exist byte-for-byte:
     - toursModel.ts:31 "`closed` is the terminal for a finished-and-decided tour.";
     - toursModel.ts:117 "A `closed` tour is terminal.";
     - toursModel.test.ts:121 `it('contains exactly the two outcomes', ...)`,
       inside `describe('toursModel <U+2014> TOUR_OUTCOMES')` at :120.

## B. Heads-ups (the plan holds, but these change how a step is carried out)

6. **Task 2.1's "Grep app/ for other importers of `TourOutcome` from the repo"
   finds nothing.** I parsed all 31 static and 5 dynamic import sites of
   repos/toursRepo.js across app, e2e, scripts, dashboard and fake-twilio (ref
   5). Not one imports `TourOutcome`, `TourType` or `TourStatus` from the repo.
   The re-export survives only as the documented contract (toursRepo.ts:44-46),
   so the "still compiles" check reduces to `npm run typecheck`.

7. **Task 2.2, real `patch`: the plan's `conditions` snippet drops in as
   written.**
   - `names` and `values` exist at toursRepo.ts:394-395. The loop's
     placeholders are `#k<i>` / `:v<i>`, plus `#updatedAt` / `:updatedAt`, so
     there is no clash.
   - Insert the snippet after :412, replace the literal `ConditionExpression`
     at :422, add `opts` to the implementation signature at :387, and extend
     the interface doc at :191-197.
   - When `updates` carries `status`, two placeholders name the same attribute
     (`#k<i>` in SET, `#expectedStatus` in the condition). DynamoDB allows
     that; only overlapping UPDATE paths are illegal. The plan's first
     integration case exercises exactly this shape.

8. **Task 2.2, fake `patch`: drops in at twilioWebhookHarness.ts:3513-3517,
   but the check must come first.** The fake mutates the STORED object in
   place (:3518-3522), so the expected-status check must run before that loop.
   `TourConditionalCheckFailedException` IS the real SDK class: it aliases the
   repo's re-export (toursRepo.ts:626, which comes from
   `@aws-sdk/client-dynamodb` at :24). So the route's
   `err instanceof ConditionalCheckFailedException` (routes/tours.ts:46 import,
   :1241 check) matches it.

9. **S4 heads-up: there are six patch wrappers, not two.** Spec section 8 names
   two tests that wrap `world.toursRepo.patch`. The tree has six assignments
   with an `(id, updates)` or zero-argument signature:
   - toursApi.test.ts:2044 (concurrent reschedule, reaches PATCH);
   - toursApi.test.ts:2122 (terminal-vs-revival, reaches PATCH);
   - toursApi.test.ts:2242 (zero-argument throwing replacement);
   - toursApi.test.ts:3302 (relay route; restored at :3311);
   - placementConvert.test.ts:307 and :782 (conversion, which passes no opts).

   A two-parameter wrapper is assignable to the three-parameter type, so
   typecheck will NOT flag a dropped `opts`. Task 4.2's grep covers all six;
   only :2044 and :2122 matter for the precondition.

10. **Task 2.2 parity file (optional upgrade, orchestrator's call).** The plan
    puts the same cases in two parallel files (the integration test plus a new
    `toursRepoFakeConditions.test.ts`). The repo has an established parity
    idiom that runs ONE script step by step through the real repo AND a fresh
    fake world and compares the answers:
    - twilioWebhookHarnessSendAttempts.integration.test.ts (header :1-21);
    - twilioWebhookHarnessRepoAdditions.integration.test.ts;
    - unreadIndexFakeMirror.integration.test.ts.

    Copied case lists can drift; a single script cannot. The plan's two-file
    form still works: `createFakeWorld()` is exported at :506 and takes no
    arguments.

11. **For S5 test design: `create` ignores a supplied `updatedAt`.** Both
    implementations stamp `updatedAt = now` after spreading the input (real
    toursRepo.ts:303-309, fake :3469-3475). Both honor `createdAt`, `tourId`
    and `status`, and pass every other field through (`lastMarkedAt`,
    `autoClosedFrom`, `outcome`, and so on). A freshly created tour with no
    `lastMarkedAt` is therefore never due before wall clock + 14 days. S2 does
    not care (`autoCloseIf` checks field equality only). S5 job tests must
    either inject `now` at or after wall clock + 14 days, or seed through
    `world.toursMap` / `lastMarkedAt`.

12. **Integration-test conventions.**
    - Append new cases at the END of the describe (it closes at :569), after the
      `rawTour` helper, which is declared mid-describe at :455-460. Assert stored
      rows through `rawTour`.
    - Take `ConditionalCheckFailedException` by dynamic import (:279, :372,
      :389).
    - Do not add the `hc:dynamo-lane shared` marker. The per-file key is
      automatic (vitest.config.ts:159, dynamoAccessKey.ts:153-157) and the file
      mints its own `hc-test-<uuid8>-` prefix (:40).
    - Every `npx vitest run` in app/, including the pure-model runs of Tasks
      1.x, executes globalSetup.ts:69-88. That setup THROWS without DynamoDB
      Local unless `ALLOW_SKIP_DYNAMO_TESTS=1` is set.

## C. Spec gaps and risks

13. **Spec 5.3: "background jobs only read tours" is not true.** The worker's
    roster-actions poll writes tours. Its path is worker.ts:433 ->
    jobs/rosterActions.ts:631 applyTourRosterAction -> :148-156 openTourGroup
    -> services/rosterProvision.ts:335 claimGroupThread, :398 patch
    `{ groupThreadId }`, and :424 clearRoster. Those calls write
    `groupThreadId`, REMOVE `roster`/`rosterVersion`, and bump `updatedAt` when
    a deferred quiet-hours group open is applied. The hermetic dev tick at
    dev.ts:497 reaches the same path. It never writes status or outcome. For a
    tour with no `lastMarkedAt` it can only POSTPONE a close, once per queued
    action, so the spec's conclusion still holds. It is, however, a second
    entry point to the deferred relay-open race in 6.6. The new Tier-2 issue
    (spec 15) should name both routes/tours.ts:1594 and the worker's deferred
    open, and the spec 12 writer list should say "roster / relay routes and the
    roster-actions poll".

14. **Spec 12's writer list omits the conversion CLAIM and RELEASE.**
    - placements.ts:716 `claimConversion` writes `convertedPlacementId =
      'pending:<uuid>'` and `conversionClaimedAt`.
    - placements.ts:750 and :778 `releaseConversionClaim` REMOVE both.

    This is harmless: the clock, `autoCloseIf` and `reopenIf` all exclude any
    `convertedPlacementId` string, and a release only restores the pre-claim
    toured + convertible shape. It is a completeness fix to the list only.

15. **Reopen vs Start placement (S6, low).** Conversion gates on an EVENTUALLY
    consistent read of `convertible === true` (placements.ts:656-664), and
    `claimConversion`'s condition (toursRepo.ts:484) has no `convertible` or
    `status` term. A reopen, which REMOVES `convertible`, can land between that
    read and the claim. The conversion then proceeds on the just-reopened tour,
    and finalize closes it as converted with no outcome. `reopenIf` itself is
    safe (`attribute_not_exists(convertedPlacementId)`). It only matters for a
    closed, unconverted tour still carrying `convertible: true`, which only the
    API can create. It is the same class as today's PATCH `{moveForward:false}`
    racing a conversion. Accept it, or file it; the fix would be
    `AND #cv = :true` on `claimConversion`, which is outside S1/S2.

16. **S4, low: a same-status restatement restarts the clock.** Spec 8.4 stamps
    `lastMarkedAt` on any patch carrying `status`, including same-status
    restatements, which PATCH accepts: `toured -> toured` and
    `no_show -> no_show` pass every guard at routes/tours.ts:1073-1128. A
    restatement restarts the two-week clock with no real mark. No dashboard
    path sends one. If wanted, key the stamp on `patch.status !== currentStatus`
    or on a `scheduledAt` change.

17. **Spec 12's seed bullet is incomplete (informational).**
    - Besides the matrix's two no-shows, its upcoming `scheduled` tours
      (matrix.ts:907-909, dated 3 and 5 days out and never marked) become due
      about 17 and 19 days after a full reseed.
    - live.ts's three tours (today, +1, +2) become due about 14-16 days after
      reseed.
    - The perf seed anchors to `now` with future dates (seed/performance.ts:
      645-666), so none of its tours are due at boot.

    All of this is still "acceptable for a demo world"; only the RUNBOOK and
    GLOSSARY wording is affected.

18. **Seed-trail label (latent).** lib/seed/history.ts:800-813 labels any
    outcome other than `move_forward` as "Tour outcome - not a fit", and :970
    emits `tour_outcome` for any outcome. The module is seed-only (imported only
    by seed/index.ts:23 and seed/live.ts:44), and no seed writes `no_outcome`
    (spec D10), so this is unreachable today. Note only.

## D. Invariant sweep (spec section 12)

19. **Writers.** No unnamed writer of `status`, `outcome`, `convertible` or
    `scheduledAt` exists in app/src. The only writers are:
    - POST create (routes/tours.ts:335);
    - the PATCH main write (routes/tours.ts:1239);
    - conversion finalize (placements.ts:771);
    - seeds (seed/index.ts:153, seed/live.ts:516-524, performanceSeed.ts:106 and
      :219).

    Every other tours write touches only `currentLadderId`, `roster`,
    `groupThreadId` or the conversion claim: routes/tours.ts:360, :632, :633,
    :742, :1300; placements.ts:716, :750, :778; rosterProvision.ts:335, :364,
    :398, :401, :424. tourRemindersRepo.ts:526 only condition-checks the tours
    table, and app/scripts only `get` tours. The unnamed-writer flags are item
    13 (worker) and item 14 (claim and release). The full table with fields is
    in ref 9.

20. **Readers to re-check against `no_outcome`, `autoClosedFrom` and reopen**
    (full table in ref 10):
    - routes/tours.ts:1076-1080 (closed-terminal 409): unchanged.
    - routes/tours.ts:1437 `outcomeNewlySet`: after a reopen removes `outcome`,
      a re-record emits `tour_outcome` again (intended).
    - services/rosterProvision.ts:150-158 `tourOpenGuard`: a reopened tour that
      still carries `groupThreadId` answers `relay_already_provisioned`
      (spec non-goal).
    - jobs/rosterActions.ts:166-173: actions retired while the tour was closed
      do not come back after a reopen (spec-accepted).
    - lib/listingSendTour.ts:50-57: S7.
    - placements.ts:661/:669: no status gate; auto-closed and reopened tours are
      not convertible.
    - routes/today.ts:549-553: scheduled only, unaffected.
    - lib/seed/history.ts: item 18.

    The tour activity projection (routes/tours.ts:170-189) passes ANY
    `event_type` through, so the two new types need no server whitelist change.

21. **Widening `TourOutcome` is typecheck-safe and the staff guard is
    sufficient.**
    - The only app/ importers of the outcome symbols are routes/tours.ts
      (:52, :56, :58) and toursModel.test.ts (:5-15).
    - The only exhaustive `Record<TourOutcome, ...>` in app/ is the model's own
      `TOUR_OUTCOME_LABELS`, which Task 1.1 replaces. No switch or `never` check
      runs over `TourOutcome`.
    - `isTourOutcome` has exactly one caller (routes/tours.ts:1047).
    - POST cannot write `outcome` (`POST_ALLOWED`, routes/tours.ts:142). Seeds
      write literals (cast.ts:807, matrix.ts:1078, performance.ts:661; the last
      one's `satisfies TourItem` at :667 still compiles).

    Switching only the PATCH validator therefore closes every staff path. The
    Task 1.1 PIN holds: today's 400 text, "outcome must be one of:
    move_forward, not_a_fit" (routes/tours.ts:1048), already contains the
    asserted substring. The dashboard's hand-copied union
    (dashboard/src/api/types.ts:899-906) is S8's.

## E. Anchors confirmed unchanged (no action)

These anchors hold exactly as the plan states them:

- toursModel.ts: :7-34 (lifecycle), :37-44 / :46 (statuses and `TourStatus`,
  declared well before the end-of-file append point at :128), :64-83
  (outcomes), :109-128 (reschedulability).
- The plan's `as const satisfies readonly X[]` shape has precedent at
  services/extraction/schema.ts:47. The toolchain is TypeScript 5.9.3.
- toursRepo.ts: :51-52, :66-140 (`TourItem`; `convertible` at :102;
  `currentLadderId` :120, `groupThreadId` :84, `moveForward` :100, `createdAt`
  :137, `updatedAt` :138, `scheduledAt` :77). `convertedPlacementId` is NOT a
  declared field: it is reached through the index signature at :139 as
  `unknown`.
- toursRepo.ts methods: `get` with `{ consistentRead }` :175 / :325-337;
  `listByScheduledRange` :347-364 (one page); `listByStatus` :366-385 (paged);
  `patch` :387-430; factory `createToursRepo(deps: RepoDeps = {})` :269 with
  `doc` / `table` / `log` at :270-272 (`logger` option).
- Precedents: `setLadderIdIf` :527-560 (lost condition -> `false` +
  `log.debug`) and `setRoster` :562-607 (`ALL_NEW` inside try/catch).
- Harness: the `toursRepo` fake :3457-3613 with map `toursMap` :3461; `get`
  without an opts parameter by design (:3486-3490); `createFakeWorld` :506.
  World fields: `toursMap` :430, `toursRepo` :431, `failAuditAppendFor` :470,
  `sent` :300, `events` :380; `emitted` :382 records both `tour.updated` and
  `scheduled.updated` (:582-583).
- The only `ToursRepo` implementers are `createToursRepo` and the harness fake.
  The other typed uses are `Pick<ToursRepo, 'get'>` (relayFanOut.ts:371,
  rosterResolution.ts:156) and a spread over the real repo
  (tourReminders.test.ts:5607).
- routes/tours.ts: :1047-1049 (validation), :1057 (eventually consistent get),
  :1076-1080, :1146-1149, :1237-1246 (main write, CCF -> 404).
