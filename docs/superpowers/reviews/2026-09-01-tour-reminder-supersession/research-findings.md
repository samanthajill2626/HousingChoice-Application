# Research findings - what the live tree holds that the spec/plan got wrong

Date: 2026-09-01. Branch `feat/tour-reminder-supersession` @38b1295f.
Four read-only readers (repo+seeds, jobs+routes, dashboard, tests+e2e) swept the
tree before any code was written. This file holds only CORRECTIONS and GAPS;
verified-correct citations and byte-exact quotes stayed in the worktree's run
state. None of these invalidates a decision; several change WHERE a task lands.

## Corrections to the plan's slicing

1. **S2's return-shape change breaks the build in S2, not S11.** The arm
   return is consumed as an array at 17 sites: `app/src/lib/seed/live.ts:519`,
   `:533`, `:543` (`.length` inside `console.log`) and 14 `const rows = await
   armTourReminders(...)` bindings in `app/test/tourReminders.test.ts`. Vitest
   strips types, so only `npm run typecheck` sees it. Re-pointed inside S2.
2. **`app/test/relayApi.test.ts` fails at S6, and the plan never names it.**
   `seedTourGroup` (`:1440-1461`) arms through the REAL armer against a tour it
   wrote by hand with no pointer. Once S2 stamps rows, that is a pointer
   MISMATCH (row stamped, tour bare), not the pre-migration exemption (both
   bare), so `relayGroups.ts:226` suppresses all three rungs and `:1477`
   `toHaveLength(3)` fails. General hazard: any test that arms for real but
   writes its tour by hand.
3. **`app/test/toursApi.test.ts:1587` is the one HARD S9 failure and it is
   outside the plan's cited range** (`:1229-1246`). After a terminal transition
   plus sweep the tour has zero unsent rows, so `expect(after.length)
   .toBeGreaterThan(0)` fails. Its neighbours at `:1546`, `:1699`, `:2834-2836`
   and the `pendingRows` filter at `:1233-1240` pass VACUOUSLY - green and
   meaningless, with names that still say "cancels". The comment at
   `:1229-1232` documents the old contract as fact.
4. **T1.4 has no host file.** `app/test/tourReminders.test.ts` reaches DynamoDB
   Local but imports no raw `@aws-sdk/lib-dynamodb` command; there is no
   `tourRemindersRepo.integration.test.ts`. `attribute_exists(reminderId)` has
   ZERO coverage today - `retirePausedTourReminders.test.ts` proves only the
   `attribute_not_exists` clauses (via an injected-doc race at `:282-297`).
5. **T3.3's real ConditionExpression cannot be proven where the plan implies.**
   `toursApi.test.ts` and `placementConvert.test.ts` are in-memory fakes only
   (`placementConvert.test.ts:9-10` says so). The compare-and-set is proven at
   the repo layer against DynamoDB Local; the interleaving test stays
   route-level against a fake that must therefore compare for real.
6. **T9.3 as written is not expressible in `e2e/`.** Nothing under `e2e/`
   constructs a DynamoDB client or repo; every reminder read is
   `GET /api/tours/:id/reminders` (`steps.ts:2053`, `:2071`, `:2134`).
   Acceptance 1 (a storage claim) is proven in `app/test`.
7. **The plan's S11 grep tokens return ZERO hits across `e2e/`.** The e2e
   contract is encoded in rendered copy (`Canceled`) and the reschedule verbs,
   not in `cancelForTour` / `canceledAt`. A builder following the grep literally
   ships a red `scheduled-visibility.spec.ts:268`.
8. **T4.1's ordering blocker is inside `seedLive`, not `seedAll`.**
   `live.ts:459-468` Puts the three tour rows itself, 20 lines before the first
   arm at `:514`. The fix has to be inside `seedLive`.
9. **T4.4 resolves to nothing.** `performanceSeed.ts:167` is a READER bundle;
   the writer's table set (`TABLE_BASES` `:47-56`) has no reminders key.
10. **T4.5's terminal set is concrete: nine tours.** `matrix.ts` produces eight
    (toured/no_show/canceled/closed x 2 reps, each with a sent `confirmation`
    plus a sent-or-canceled `day_before`); `cast.ts:755-768` `TOUR_TOURED`
    carries a 3-row all-sent ladder feeding the byte-stable e2e world, so any
    seeded `ladderId` there must be a literal constant. Rotating its pointer
    moves all three rows behind the disclosure, bodyless (seeds write no
    `sentBody`, `:774-779`) - consistent with acceptance 11 but a visible change
    in the e2e world nobody wrote down.

## Corrections to the spec

11. **Acceptance 14 says 390px; T10.7 (PB-11, accepted) mandates `NARROW_360`
    (360px).** Amended to 360 on-branch.
12. **Section 3.6 still lists FIVE scroll writers; there are six.** The pill's
    own `scrollToBottom` (`Timeline.tsx:1840-1846`) was added to the plan at
    PA-5/PB-3 but never to the spec. Amended on-branch. The same paragraph cites
    acceptance 12 where it means 13.
13. **Section 4's writer list omits two writers**: `routes/tourReminders.ts:390-391`
    (the operator PATCH's `cancel` / `uncancel` - the only operator write, and
    what `earlier[]`'s Cancel reaches) and `seed/index.ts:149-157` (the actual
    `PutCommand` landing cast's and matrix's raw rows). It also omits
    `services/rosterProvision.ts:398`, a `tours.patch(tourId, { groupThreadId })`
    that is SET-merge and cannot clear the pointer - audited inert.
14. **The tour CREATE path is worse than section 4 says.** `tours.ts:338`
    captures the tour before the arm and NOTHING re-reads it; the conversion
    path DOES re-read (`placements.ts:861`), so its 201 carries the pointer for
    free. T3.5's two halves are asymmetric.
15. **"The placement-nudge card's map" (3.3) is ambiguous between two maps.**
    `NUDGE_SUPPRESSION_LABELS` (`DeadlinesNudgesCard.tsx:64`) is forced by
    `superseded`; `NUDGE_SKIP_REASON_LABELS` (`:48`) is keyed on a SEPARATE
    `NudgeSkipReason` union and must NOT be widened.

## Gaps neither document covers

16. **`forceSendReminder` has no tour in hand where the refusal belongs.** The
    row is read at `jobs/tourReminders.ts:1618`; the tour only exists after
    `resolveReminderTarget` (`:1662`). A `superseded` check beside
    `kind_retired` (`:1632`) needs the tour read hoisted (one read total, since
    `resolveReminderTarget` accepts a pre-fetched tour).
17. **T7.7 contradicts `bodyFor`.** `routes/tourReminders.ts:281-338`
    recomposes LIVE for exactly the no-`sentBody` row T7.7 wants blank, and its
    header (`:262-280`) forbids changing containment in one of three copies.
    `earlier[]` needs its own projection, not a `bodyFor` call.
18. **`RemindersPanel.tsx:76-94` `nextReminderRefetchDelay`** takes
    `{ reason: string }` structurally and would keep a 20s overdue poll running
    on a superseded rung; its `discontinued` skip at `:85` is the precedent.
19. **Copy census (two-probe method): 4 exhaustive constructs, 22 unforced**
    (20 actionable; `DeadlinesNudgesCard` `StateChip` and
    `NUDGE_SKIP_REASON_LABELS` are do-not-touch). The two probes reach DISJOINT
    construct sets - `discontinued` finds the suppression surfaces,
    `tour_already_passed` the skip-reason and 409 surfaces. Both are needed.
20. **`Timeline.module.css` has THREE `767.98px` media blocks, not two** (`:156`
    `.stream`, `:661` `.upcoming` - the one to delete, `:1012` `.replyTarget`).
21. **`.stream`'s `padding: var(--sp-3)` and `gap: var(--sp-2)` change the moved
    block's look**: the dashed `border-top` and surface background stop bleeding
    to the panel edges, and the gap doubles against `.upcoming`'s own padding.
    A design decision the docs did not make (resolved: full-bleed via negative
    inline margins, to be checked live).
22. **The global no-op `ResizeObserver` stub** (`dashboard/src/test/setup.ts:42-48`)
    makes any T10.6 re-pin unit test pass vacuously unless a drivable fake is
    stubbed in (precedent `TourConversation.test.tsx:585-606`).
23. **`earlier[]` must reach `RemindersPanel`'s local `Committed` state**
    (`:175-189`) in BOTH `setState` calls, or a failed refetch leaves stale
    earlier rows beside a cleared ladder.
24. **The disclosure's Cancel button needs a distinct accessible name** -
    `"Cancel the ${kindLabel} reminder"` (`:413`) would collide with a
    current-ladder rung of the same kind (strict-mode e2e violation the file's
    own comment at `:381-389` records).
25. **`TourItem` carries `[key: string]: unknown` (`toursRepo.ts:105`)**, so
    `patch({ currentLadderId })` compiles today and so does a typo. The
    typechecker will never catch a pointer-key misspelling; tests assert on the
    stored row.
26. **A pre-existing lint error sits on the import line S1 must edit**:
    `tourRemindersRepo.ts:14` `'GetCommand' is defined but never used`. Cleared
    in S1; named here so a gate-5 baseline comparison does not read it as new.
27. **e2e has zero coverage of the "New messages" pill or thread scroll position.**
    The only usable idiom is `thread-history-paging.spec.ts:109-163`, whose
    `:149-151` note (fractional `scrollTop` vs integer `scrollHeight`) governs
    every T10.7 assertion.

## Line drift (harmless, recorded so nobody re-diagnoses it)

`cancelTourReminders` in `tours.ts` is at `:1190` / `:1208` (brief said
`:1177` / `:1195`); "POSITION IS BEHAVIOUR" is `jobs/tourReminders.ts:1035`;
the PATCH response is `tours.ts:1284`; `RemindersPanel.tsx:346` is the length
test and `:347` the string, and the disclosure's insertion point is `:472`; the
fake `create` literal is `twilioWebhookHarness.ts:2933-2951`, its scar comment
`:2939-2945`; `steps.ts:3615-3661` cites the docblock, the contract lines are
`:3656` and `:3661`; `placementConvert.test.ts:78-79` is the fixture, the
assertion is `:107-111`. The post-send pin at `Timeline.tsx:1976` did NOT
drift.
