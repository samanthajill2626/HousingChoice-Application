# Planner independent SPEC-CONFORMANCE review - feat/tour-reminder-supersession

Reviewer: the PLANNER's independent conformance reviewer, distinct from the
build-orchestrator's own battery. I did NOT read `code-review-*.md`,
`slice-reports/` or `self-qa.md`; I read `handback.md` only for its recorded
deviations, as instructed. Everything below is walked from the SPEC to the
CODE and back to the TEST.

Base: `feat/tour-reminder-supersession` @01924bc9 (merge of main), read-only at
`W:/tmp/tour-reminder-supersession`. Diff reviewed: `git diff main...HEAD`
excluding `docs/`. No suite was run (the planner holds the tree for gates), so
every claim here is a READ of source and test text, not an execution result.
Line numbers are against the blobs at HEAD (`git show HEAD:<path>`) - partway
through this review the working tree's `app/` and `dashboard/` directories
briefly disappeared under a concurrent operation, so the last verification pass
was done against git objects rather than the checkout.

**VERDICT: delivers-the-spec** - all four decisions, all six behavior sections
and all seventeen acceptance criteria are implemented, and sixteen of the
seventeen are pinned by a test that asserts what the criterion says. Five
findings, none blocking; the highest is a coverage gap on acceptance 5.

---

## Findings

1. **[MEDIUM] Acceptance 5 (Fixture B, clean sweep) is not encoded by any test.**
   Acceptance 4 (Fixture A - a sweep MISS) is proven three times over on the
   preview surfaces: `app/test/tourRemindersApi.test.ts:1057`,
   `app/test/contactTimeline.test.ts:1403`, `app/test/relayApi.test.ts:1615`.
   Acceptance 5's distinct claim - that after a CLEAN sweep "both Upcoming
   buckets return nothing for the superseded ladder, because the rows are gone"
   - has no counterpart. Neither `contactTimeline.test.ts` nor
   `relayApi.test.ts` ever builds a post-sweep world; both only build the
   surviving row. The A/B distinction the spec drew is asserted on one side
   only. The BEHAVIOR is safe by construction (both buckets read `listByTour` -
   `app/src/routes/contactTimeline.ts:982`, `app/src/routes/relayGroups.ts:227`
   - and the rows are deleted), and the DELETE itself is proven at three
   layers: `app/test/tourReminders.test.ts:685` (DynamoDB Local, by raw
   `GetCommand`), `app/test/toursApi.test.ts:1793` (route, by identity),
   `app/test/placementConvert.test.ts:267` (conversion, by identity). So this
   is a gap in evidence, not a defect. Cheapest close: one case in each of the
   two bucket suites that seeds a pointer-mismatched row, calls
   `deleteSupersededForTour`, and asserts the bucket comes back empty.

2. **[LOW] Acceptance 13's second clause ("the same after sending a message")
   is unproven.** Spec 3.6's fourth writer IS converted -
   `dashboard/src/routes/contact/Timeline.tsx:2121` writes
   `anchorRef.current = 'sentinel'` in `handleSend`, replacing the old
   `atBottomRef.current = true` - so the spec's writer list is satisfied. But
   no test drives send-then-grow with a block mounted: the anchor describe in
   `Timeline.test.tsx` never renders `canSend`, and
   `e2e/tests/dashboard-next/upcoming-in-stream.spec.ts` exercises inbound legs
   only. This was also untested on `main` (the post-send pin had no case
   there), so it is an inherited hole rather than a new one.

3. **[LOW] Acceptance 14's "shows more messages than `main`" is not measured.**
   `upcoming-in-stream.spec.ts:191-245` proves the structural consequence - the
   newest message sits at the fold, the block's top is at or below the
   scroller's bottom edge, and the scroller genuinely overflows - and 14's
   other clauses (scroll down reveals, scroll up removes, short thread shows
   it) are covered. A count comparison against `main`'s layout is not
   expressible in a single-branch e2e. Recorded so the clause is not read as
   independently proven; the CSS that causes it is
   `dashboard/src/routes/contact/Timeline.module.css:645-668` (the block's
   `max-height`, `overflow-y`, `flex` and the whole `max-width: 767.98px`
   override are gone).

4. **[LOW] The poll orders the conversion-claim deferral ABOVE the pointer
   check; the panel and Send now order `superseded` above
   `conversion_in_progress`.** `app/src/jobs/tourReminders.ts:1164` (defer)
   sits above `:1198` (superseded), while
   `app/src/jobs/tourReminders.ts:1826` (superseded) sits above `:1846`
   (conversion) and `app/src/routes/tourReminders.ts:771-800` ranks
   `superseded` first. Spec 3.3 asserts that precedence only for the human path
   and the surfaces (`tourRemindersApi.test.ts:1959` pins it there), and the
   poll's inversion is deliberate and argued in the code: a deferral stamps
   NOTHING, so answering the claim first cannot terminally mislabel a rung. The
   visible consequence is narrow - a rung that is BOTH superseded AND on a tour
   with a STALLED claim is eventually retired `conversion_stalled` while the
   panel chip for it read `Replaced`. Cosmetic, and the safer direction.

5. **[LOW] Sweep-failure posture returns 500 for a reschedule that already
   committed.** `app/src/routes/tours.ts:1344-1352` and `:1378-1388` log at
   error with the tourId - exactly what spec 3.2's interruption posture
   requires - and then RETHROW. By that point the patch, the arm and the
   pointer CAS have all landed, so the operator sees a failure for a mutation
   that succeeded; `ladderChanged` never becomes true, so the
   `scheduled.updated` nudge (`:1397`) is skipped and the live surfaces stay
   stale until their next refetch. The same rethrow in the TERMINAL branch
   persists the status change and the rotation before 500-ing. The handback
   records this as an adjudicated orchestrator ruling; it is faithful to the
   spec's INTENT (the spec demands the loud log and says nothing about the
   status code), and the surviving state is the named, benign "refused but
   visible in `earlier[]`" residue - `toursApi.test.ts:2203` asserts exactly
   that end state.

---

## D1-D4

- **D1 (supersession DELETES).** `deleteSupersededForTour`
  (`app/src/repos/tourRemindersRepo.ts:502`). Candidate filter is
  `r.sentAt === undefined && r.ladderId !== expectedPointer` (`:509`) -
  pending, operator-canceled and skipped alike; only `sentAt` survives. The
  tour-wide cancel is GONE from the interface and both fakes: no
  `cancelForTour` / `cancelTourReminders` reference survives anywhere under
  `app/`, `dashboard/` or `e2e/` except one historical comment at
  `app/test/tourReminders.test.ts:2032`. Proven at
  `app/test/tourReminders.test.ts:685` against DynamoDB Local by raw
  `GetCommand`, including that the sent row keeps its `sentBody`.
- **D2 (sent rungs survive in storage, not in the default view).** The
  partition at `app/src/routes/tourReminders.ts:586-591` moves them to
  `earlier[]`; the panel renders it inside a `<details>` with no `open`
  (`dashboard/src/routes/tours/RemindersPanel.tsx:567`).
  Collapsed-by-default gets its own case
  (`RemindersPanel.test.tsx:1040`) rather than passing vacuously.
- **D3 (pointer lives on the TOUR, NEVER removed).** `currentLadderId` declared
  at `app/src/repos/toursRepo.ts:120` with the never-clear rule stated. No call
  site passes `null`: the writers are `patch({ currentLadderId: ladderId })` on
  create (`app/src/routes/tours.ts:360`), `patch['currentLadderId'] = rotation`
  riding the re-arm/terminal patch (`tours.ts:1235`),
  `currentLadderId: rotatedLadderId` inside the conversion finalize
  (`app/src/routes/placements.ts:774`), plus the CAS `setLadderIdIf`
  (`toursRepo.ts:527`). The four-cell truth table lives ONCE in
  `app/src/lib/ladderPointer.ts:41-47` and matches spec 3.4 exactly, including
  the ABSENT-pointer / SET-`ladderId` cell answering TRUE. Terminal rotation is
  asserted PRESENT-and-unmatched, never cleared, for all four statuses
  (`toursApi.test.ts:1758`).
- **D3a (the CALLER owns the pointer write).** `armTourReminders` returns
  `{ ladderId, rows }` (`app/src/jobs/tourReminders.ts:455`), `ladderId` null
  exactly when `created.length === 0`. `ArmTourRemindersDeps` has no
  `toursRepo`. All five call sites (`tours.ts:347`, `tours.ts:1270`,
  `lib/seed/live.ts:535/550/561`) write the pointer themselves.
- **D4 (the block moves inside the scroll at every width).** `Timeline.tsx`
  renders `<section class=upcoming>` as the last child of `.stream` (`:2247`),
  after a zero-height sentinel (`:2238`); the old sibling placement is deleted.
  No width branch remains in the CSS. "At the bottom" means the newest MESSAGE
  via `scrollToSentinel` (`Timeline.tsx:1914`).

## 3.1 Arm time

One `ladderId` minted per CALL (`jobs/tourReminders.ts`, inside
`armTourReminders` at `:455`), stamped on ALL four create sites including the
three born-skipped ones (`:577`, `:600`, `:633`, `:646`). A UUID, not a
timestamp, for the injected-constant-clock reason the spec gives; the arm
describe at `tourReminders.test.ts:857` deliberately pins the SAME `now` across
two arms, so a timestamp-derived id would fail its second case and only its
second case.

## 3.2 Ordering - all four paths verified against the CODE, not the comments

- **CREATE** (`tours.ts:332-376`): `tours.create` -> `armTourReminders`
  (`:347`) -> `tour = await tours.patch(..., { currentLadderId })` (`:360`).
  The 201 is built from the REASSIGNED `tour`, so it carries the post-arm
  pointer. A timeless create writes no pointer (the `ladderId !== null` guard).
  Both pinned: `toursApi.test.ts:1672` (201 body AND stored row) and `:1690`
  (absent, never an empty string).
- **RE-ARM** (`tours.ts:1235`, then `:1258-1353`): step 1 rotation RIDES the
  single patch write (`patch['currentLadderId'] = rotation` sits ABOVE
  `tours.patch`); step 2 arm (`:1270`); step 3
  `tours.setLadderIdIf(tourId, rotation, ladderId)` (`:1300`); step 4 sweep
  ONLY when `sweepPointer !== null` (`:1329`), which is set to `ladderId` on a
  WON compare (`:1305`), left null on a LOST one, and set to `rotation` when
  the arm produced no rows (`:1327`). That is the spec's order literally,
  including the "sweep against the step-1 rotation anyway" branch. The loser
  re-reads with `{ consistentRead: true }` (`:1317`) before answering.
- **TERMINAL** (`tours.ts:1354-1391`): rotate (same patch) then sweep against
  `rotation` (`:1378`), and STOP - no arm on this branch. `terminal` is
  computed from `patch['status']`, not `effectiveStatus`, AND requires
  `patchedStatus !== currentStatus` (`:1222`), so an unrelated PATCH on an
  already-terminal tour and a repeat of the same terminal status both rotate
  and sweep NOTHING. Both doors pinned on pre-migration fixtures:
  `toursApi.test.ts:1850` (the navigator exit gate on a `toured` tour) and
  `:1902` (a repeat `{status:'canceled'}`), each asserting the legacy rows
  survive untouched, the pointer stays ABSENT, and no `scheduled.updated`
  fires.
- **CONVERSION** (`placements.ts:691-828`): the pre-finalize
  `cancelTourReminders` call is DELETED; nothing touches the ladder before the
  finalize. The rotation rides the finalize patch itself (`:769-775`), and the
  sweep follows with `expectedPointer = rotatedLadderId` (`:818`),
  best-effort. The ordering comment at `:693-701` matches the code it sits
  above. Acceptance 7's two failure paths and the deferral window are each
  their own test (`placementConvert.test.ts:747`, `:771`, `:805`).
- **Interruption posture**: each of the four failure points logs at error WITH
  the tourId - `tours.ts:368` (create pointer write), `:1288` (arm after
  rotation), `:1309` (lost CAS), `:1348` / `:1385` (sweep). Each has a test
  asserting exactly ONE such line carrying the tourId
  (`toursApi.test.ts:2239`, `:2164`, `:1950`, `:2203`).

## 3.2 step 4 - the transactional sweep, and DynamoDB Local semantics

`tourRemindersRepo.ts:518-546`: every delete is a `TransactWriteCommand` whose
item 0 is a `ConditionCheck` on the TOURS table (`'#cl = :expected'`, `:525`)
and item 1 the `Delete` guarded by `attribute_not_exists(sentAt)` (`:538`).
Sequential, not `Promise.allSettled`, because a lost pointer check must STOP
the rest. The decode is positional on `CancellationReasons`:
`[0] === 'ConditionalCheckFailed'` -> info + `break` (`:552`);
`[1] === 'ConditionalCheckFailed'` -> debug + `continue` (`:563`); anything
else -> error + continue. That is spec 3.2 step 4 word for word, including the
exclusion of the caller's own generation from the candidate set.

BOTH decode branches are driven by REAL DynamoDB Local cancellation payloads,
which is the thing a hand-rolled fake could not prove:
`app/test/tourReminders.test.ts:716` (a concurrent `claimSend` between the
Query and the delete - the survivor keeps `sentAt` AND `sentBody`, and the
OTHER unsent rows still go, which proves `continue` and not `break`) and `:747`
(a concurrent `toursRepo.patch` rotation mid-sweep - exactly two candidates
survive, an INFO line names "newer generation", and zero level-50 lines are
emitted). `:800` covers the third arm (an injected throw -> one error line, the
rest still swept) and `:833` the empty tour. The in-memory fake mirrors the
semantics honestly and says so
(`app/test/helpers/twilioWebhookHarness.ts:3078`): a synchronous per-row
re-check of the pointer that RETURNS (stops) on a mismatch.

**The claim guards.** `attribute_exists(reminderId)` added to `claimSend`
(`tourRemindersRepo.ts:376`), `claimSkip` (`:416`) and `cancel` (`:452`);
`uncancel` already required `attribute_exists(canceledAt)` and is untouched.
Proven at the repo layer against DynamoDB Local by deleting the row out from
under each call - `tourReminders.test.ts:577`, `:584`, `:591`, `:598` - each
asserting BOTH `false` AND that the raw item is STILL undefined afterwards
(i.e. no attribute-only stub sprang into existence). `:605` is the anti-vacuity
twin proving the live path still claims.
`app/scripts/retire-paused-tour-reminders.ts` is the cited precedent and gains
only comments; its guard was already there and is now load-bearing.

## 3.3 What refuses a superseded rung

- Poll claim-skips with the new token (`jobs/tourReminders.ts:1198-1204`).
  Position verified in the ACTUAL order of `processReminderRow`: `tour_missing`
  (`:1134`) -> `tour_already_passed` (`:1142`) -> conversion claim (`:1164`) ->
  pointer (`:1198`) -> `supersededInBatch` (`:1226`) -> quiet hours (`:1243`).
  That satisfies every positional MUST the spec states (below the past-tour
  gate, above the batch block, above the quiet-hours backstop). Test:
  `tourReminders.test.ts:5407` - stamped `superseded`, nothing sent, exactly
  one `scheduled.updated` for THIS contact, and it leaves `listDue` exactly
  once.
- Send now refuses 409: `jobs/tourReminders.ts:1831` returns
  `{ outcome:'refused', reason:'superseded' }`, and
  `routes/tourReminders.ts:562` maps every refusal to `res.status(409)`. Test:
  `tourRemindersApi.test.ts:1885` asserts 409, `error === 'superseded'`, the
  rung still `upcoming`, ZERO sends, and no `sentAt`/`skippedAt`/`canceledAt`
  written - a refusal that never retires. `:1907` is the anti-vacuity twin.
- Conversion claim: DEFERRED inside the window with NOTHING stamped
  (`jobs/tourReminders.ts:1164-1180`), retired `conversion_stalled` past it.
  Grace runs from `max(dueAt, conversionClaimedAt)` with `updatedAt` as a
  documented fallback (`conversionClaimExpired`, `:361`; the constant at
  `:328`); `claimConversion` writes the stamp beside the sentinel
  (`toursRepo.ts:472`) and `releaseConversionClaim` REMOVEs both (`:496`).
  Four tests separate the three possible bases:
  `tourReminders.test.ts:5492` (defer, then send once released), `:5527`
  (retire past the window, LOUD, one error line with the tourId), `:5594`
  (five hours overdue but freshly claimed -> DEFER; a `dueAt`-only basis would
  have retired it), `:5626` (same rung, stale claim, `updatedAt` = now ->
  RETIRE; an `updatedAt` basis never would). `:5652` covers the pre-deploy
  fallback.
- Send now also refuses a claim in flight (`jobs/tourReminders.ts:1846-1853`),
  409 `conversion_in_progress`, test `tourRemindersApi.test.ts:1928`; the
  PREFIX (not string-ness) is the predicate, pinned by `:1947`.
- **The three preview surfaces all consult the sentinel AND the pointer**,
  through the ONE shared `isSupersededRung`: panel
  (`routes/tourReminders.ts:771`, with the suppression ladder at `:774-800`),
  contact timeline (`routes/contactTimeline.ts:1053`), relay group
  (`routes/relayGroups.ts:374`). The ordering is identical on all three
  (superseded > discontinued > conversion_in_progress > evaluator). Tests:
  `tourRemindersApi.test.ts:1057` / `:979` / `:1028`;
  `contactTimeline.test.ts:1403` / `:1374`; `relayApi.test.ts:1615` / `:1648`
  (the relay case also releases the claim and asserts every promise comes
  BACK, which is what makes "reversible disarm" a proven property rather than
  a comment).
- **Copy and type surfaces - all five, including the two that would have
  compiled green.** Forced by exhaustive maps: `REMINDER_SKIP_REASON_LABELS`
  and `REMINDER_SUPPRESSION_LABELS` (`dashboard/src/api/types.ts`),
  `NUDGE_SUPPRESSION_LABELS`
  (`dashboard/src/routes/placements/DeadlinesNudgesCard.tsx`, label-only with
  no chip branch, following the spec's own `discontinued` precedent),
  `SUPPRESSION_COPY` (`dashboard/src/routes/contact/ScheduledCard.tsx`). NOT
  forced and done anyway: the dashboard's hand-mirrored `skipReason` union and
  `SEND_NOW_ERROR_COPY`. The latter is pinned by a test that asserts the copy
  is NOT the generic fallback sentence (`dashboard/src/api/types.test.ts:151`
  and the `conversion_in_progress` case beside it), which is the only way that
  surface can fail loudly.

## 3.4 Read grouping

Partition at `routes/tourReminders.ts:586-591` uses the shared predicate.
`reminders[]` keeps its shape and alone feeds `next` (`:893`, which ALSO keeps
the belt-and-braces `superseded` exclusion even though the partition makes it
unreachable). `earlier[]` (`:841`) sorts by `(sentAt ?? dueAt)` DESCENDING with
`reminderId` ASCENDING as tie-break; the fixture at
`tourRemindersApi.test.ts:1168` is deliberately built so that dueAt-ASC,
dueAt-DESC, createdAt-ASC and createdAt-DESC each produce a DIFFERENT answer,
and it asserts the exact four-element order. `earlier` is OMITTED when empty
(`:930`), so a pre-migration tour's response is byte-identical to main's
(`tourRemindersApi.test.ts:1125`).

Actions allowlisted BY STATE, written out rather than inherited
(`RemindersPanel.tsx:605-620`, aria-label at `:613`): only `state ===
'upcoming'` renders a button, and it is Cancel, under the distinct name
`Cancel the earlier <Kind> reminder`. `RemindersPanel.test.tsx:1057` asserts
EXACTLY ONE button exists in the whole disclosure across all four states, and
that no Send-now and no Restore appears; `:1105` pins the accessible-name
collision the shared name would create; `:1133` proves the Cancel routes
through the same handler. The disclosure is a SECOND CHILD of the Card, outside
the empty-ladder ternary (`RemindersPanel.tsx:566` vs the
`reminders.length === 0` branch at `:403`), and `:1022` asserts "No reminders
armed." and the disclosure render TOGETHER - acceptance 10. Body: snapshot or
nothing, never a recompose (`routes/tourReminders.ts:841` builds the earlier
view without `bodyFor`, and the PATCH and send-now echoes take the same rule at
`:459` and `:540`); the panel renders no paragraph at all for an absent body
(`RemindersPanel.tsx:627`). Acceptance 11 is pinned twice:
`tourRemindersApi.test.ts:1230` (`not.toHaveProperty('body')`) and
`RemindersPanel.test.tsx:1156`.

## 3.5 Pre-migration rows - the exemption on EVERY pointer surface

One predicate, six consumers, each with its own legacy case:

| surface | code | legacy test |
| --- | --- | --- |
| poll | `jobs/tourReminders.ts:1198` | `tourReminders.test.ts:5445` (it SENDS) |
| send now | `jobs/tourReminders.ts:1826` | implicit but anti-vacuous: `seedSendNowTour` builds a pre-migration pair, so every send-now happy path (`tourRemindersApi.test.ts:1714`, `:1907`, `:1947`) would 409 if the exemption were missing |
| panel preview | `routes/tourReminders.ts:771` | `tourRemindersApi.test.ts:1101` |
| contact Upcoming | `routes/contactTimeline.ts:1053` | `contactTimeline.test.ts:1441` |
| group Upcoming | `routes/relayGroups.ts:374` | `relayApi.test.ts:1683` |
| read grouping | `routes/tourReminders.ts:589` | `tourRemindersApi.test.ts:1125` (`earlier` ABSENT, not `[]`) |

The INTERRUPTION cell (a stamped row on a pointerless tour) is refused rather
than exempt, per `ladderPointer.ts:46` and `tourReminders.test.ts:5464`. The
pure table has its own unit file (`app/test/ladderPointer.test.ts`). No
backfill anywhere; `RUNBOOK.md:310-317` states so, correctly - `ladderId` is a
plain attribute and both `tourReminders` GSIs already project ALL.

## 3.6 Upcoming placement - six writers and the three-valued anchor

All six writers converted, read from the source rather than the comments:

1. growth pin - `Timeline.tsx:2040-2052`: `sentinel` -> `scrollToSentinel`;
   `below` -> `el.scrollTop = el.scrollHeight - bottomGapRef.current`
   (distance from the TRUE bottom preserved); `null` -> no scroll, pill on
   growth. Exactly the spec's table.
2. conversation-switch reset - `:2019` calls `scrollToSentinel(el)`, replacing
   `scrollTop = scrollHeight`.
3. the pill's `scrollToBottom` - `:1927-1928` calls `scrollToSentinel` and
   writes the anchor.
4. post-send pin - `:2121` writes `anchorRef.current = 'sentinel'`.
5. pill-clear condition - `:1938` clears on `anchorRef.current !== null`, i.e.
   on `sentinel` OR `below`, never on true-bottom.
6. prepend restore - `:2029` untouched (`el.scrollTop += el.scrollHeight -
   anchor`), as the spec requires.

The anchor derivation (`dashboard/src/routes/contact/streamAnchor.ts:50-64`)
matches the table: `delta > 48` -> `null`; `delta < 0 && hasBlock` -> `below`
(direction, not slack); everything else -> `sentinel`. **One deliberate
widening, and it is faithful**: with `hasBlock` false a negative delta returns
`sentinel` rather than `below`. The spec defines `below` as "the operator is on
the block", which is unreachable without one, and the code preserves the old
`isAtBottom` semantics exactly for block-less threads -
`streamAnchor.test.ts:56-66` pins that reproduction value by value, and `:41`
pins the sub-48px block case the spec calls out by name.

The re-pin signal tracks HEIGHT via a `ResizeObserver` on the block
(`Timeline.tsx:1948`), and `blockResizeTick` + `hasUpcomingBlock` are both in
the layout effect's deps (`:2064`). The `upcoming` ARRAY is never a dep
anywhere - I read every occurrence of the identifier in the file; both effects
key on the boolean, which is the `GroupTextView` fresh-`[]` trap the spec
names. `.stream` keeps `overflow-anchor: none` (`Timeline.module.css:142`) and
the pill still hangs off `.streamWrap` (`Timeline.tsx:2260`). The block's
`max-height`, `overflow-y`, `flex` and the whole phone override are deleted
(`Timeline.module.css:645-668`).

The one behavior beyond the spec is the UNMOUNT-only re-derive
(`Timeline.tsx:1999`), added because the block vanishing is this feature's
commonest event and a stale `below` would scroll the operator away from the
newest message. It is asymmetric on purpose - the MOUNT flip must NOT
re-derive, or a same-commit delivery reads `scrollTop` 0 and pills on open -
and both directions have a test (`Timeline.test.tsx:1649` mount, `:1672`
unmount). A strengthening consistent with 3.6's intent, not a deviation from
it.

jsdom coverage is honest about its limits: the anchor DERIVATION is a pure unit
file, and `Timeline.test.tsx` models `getBoundingClientRect` explicitly
precisely because jsdom's all-zero rects would make every case pass vacuously -
and the first five cases pass no `upcoming` prop at all, so they stand as the
no-block regression net. The real arithmetic is asserted geometrically in a
real engine at `e2e/tests/dashboard-next/upcoming-in-stream.spec.ts`, including
the explicit "does this box scroll at all" probe (`:193-198`) that stops a
short thread satisfying everything for the wrong reason.

## Acceptance criteria - the test that proves each

| # | proven by | assertion strength |
| --- | --- | --- |
| 1 | `toursApi.test.ts:1793` | by IDENTITY (`tourRemindersMap.has(id) === false`, per row), plus a deliberately seeded SENT row so "a sweep that deletes everything" cannot satisfy it |
| 2 | `tourReminders.test.ts:716` (DynamoDB Local) | the raced row keeps `sentAt` AND `sentBody`; the other unsent rows still go |
| 3 | `tourReminders.test.ts:577`, `:584` | `claimSend` false AND the raw item still ABSENT (no stub) |
| 4 | `tourRemindersApi.test.ts:1057` + `:1885` + `contactTimeline.test.ts:1403` + `relayApi.test.ts:1615` + `types.test.ts:151` + `RemindersPanel.test.tsx:1057` + `tourReminders.test.ts:5407` | Fixture A end to end: poll claim-skip, 409 with its OWN copy, three surfaces suppressed BEFORE dueAt, `earlier[]` with Cancel and nothing else |
| 5 | - | **finding 1**: the delete is proven, the two Upcoming buckets' post-sweep emptiness is asserted nowhere |
| 6 | `toursApi.test.ts:1758` (all four statuses) + `:1733` | pointer PRESENT and unmatched; rows swept; the revival arms onto an EMPTY table, so it can adopt nothing |
| 7 | `placementConvert.test.ts:747`, `:771`, `:805` | `expectLadderIntact` checks every row by identity AND that no rung is stamped `superseded`; the claim-window case drives the REAL poll through a parked conversion and asserts nothing stamped and the rung still in `listDue` |
| 7a | `placementConvert.test.ts:282` | rotated pointer present, different from the old one, matching NO surviving row, and echoed in the 201 |
| 8 | `toursApi.test.ts:1950` + `:2014` + `:2097` + `placementConvert.test.ts:291` | winner's rows survive BY IDENTITY; loser logs exactly one error line; loser's response comes from the CONSISTENT re-read (it asserts `scheduledAt === FARTHEST`, not just the pointer) |
| 9 | `tourRemindersApi.test.ts:1593` + `:1627` | 404 WITH the emit when the write won; NO emit when the write lost |
| 10 | `RemindersPanel.test.tsx:1022` + `:1057` | both rendered together on an empty ladder; no Restore on a canceled earlier rung |
| 11 | `tourRemindersApi.test.ts:1230` + `RemindersPanel.test.tsx:1156` | `body` key ABSENT (not `''`), and no paragraph rendered |
| 12 | the five legacy cases tabulated in 3.5 | each asserts the pre-feature ANSWER, not merely "no crash" |
| 13 | `upcoming-in-stream.spec.ts:191-217` + `Timeline.test.tsx:1561` + `:1634` | opening lands on the newest message with the block below the fold, measured. **Second clause untested - finding 2** |
| 14 | `upcoming-in-stream.spec.ts:191-245` | overflow probe, block below the fold at rest, revealed on scroll down, hidden on scroll up. **"more messages than main" not measured - finding 3** |
| 15 | `upcoming-in-stream.spec.ts:247-288` + `Timeline.test.tsx:1578` + `:1597` + `streamAnchor.test.ts:41` | zero yank measured in PIXELS and by the true-bottom gap; no pill; the sub-48px block has its own unit and pure case |
| 16 | `upcoming-in-stream.spec.ts:289-316` (relay group through ConversationDetail) + `Timeline.test.tsx:1614` (contact-thread shape) | pill lights from above, dismisses, and the click lands on the newest MESSAGE rather than the block |
| 17 | `seedLive.test.ts:465` + `:490` | every seeded row's `ladderId` EQUALS its tour's pointer, walked from the ROW side, with a non-empty guard so it cannot pass on an empty table |

## Seeds, script and runbook

`lib/seed/live.ts` writes the pointer from the armer's return via a re-Put of
the same object (all three live tours are `scheduled`, so none takes a rotated
pointer), and `pointTourAtLadder` refuses to point at a null ladder.
`lib/seed/matrix.ts:980-986` derives one deterministic `ladderId` per seeded
ladder and rotates it for terminal tours; the canceled tour's `canceledAt`
`day_before` ROW is deleted (`:1041`) because a superseded-and-canceled row is
a shape production can no longer produce - a genuinely good catch - and
`seedMatrixCoherence.test.ts:506` walks the pairing from the ROW side so a
derivation edit cannot silently make the whole demo world read superseded
(`:529` pins the canceled-tour shape). `lib/seed/cast.ts` stamps literal ids
(byte-stable world), keeps `searchingTenant` as the deliberate pre-migration
fixture, and rotates the toured tour's pointer. `performanceSeed` writes no
reminder rows at all - only `cast.ts`, `live.ts` and `matrix.ts` mention
`tourReminders` under `app/src/lib/seed/` - so the handback's T4.4
"nothing to change" is correct. `RUNBOOK.md:310-317` correctly says nothing is
owed: no backfill, no Terraform, no GSI update.

## Deviations recorded in the handback - my judgement

- **T4.4 (performanceSeed: nothing to change)** - CORRECT, verified directly.
- **S9 sweep-failure posture = handler rethrow, not log-and-arm** - faithful to
  intent (spec 3.2 demands the loud log with the tourId, which the code does),
  with the caveat in finding 5.
- **T9.3 proven in `app/test` because e2e cannot read DynamoDB** - correct, and
  the e2e verb was reshaped honestly rather than weakened:
  `expectReminderRungAbsent(kind, state)` exists precisely because "no
  morning_of at all" would be FALSE after a re-arm, and `e2e/scenarios/steps.ts`
  says so at length. `currentLadderList()` scopes to the non-`earlierRows`
  `<ul>` so opening the disclosure cannot silently widen every rung assertion
  in the suite - a real hazard the change created and closed.
- **W3/W1 scroll writes are a rect DELTA, not `offsetTop`** - faithful and
  better. Spec 3.6 requires the writes to TARGET the sentinel and specifies no
  formula; `offsetTop` would have carried the "Load older messages" row's
  height as a silent constant error because `.stream` is not positioned. The
  delta form reads the SAME two numbers the anchor is derived from, so the
  write and the derivation cannot disagree.

## What I could NOT verify

- No suite was run: every green/red claim in the handback's gate section is
  UNVERIFIED by me.
- IAM for `ConditionCheckItem` on the tours table in the deployed environments
  - UNVERIFIED. The handback says it was checked and already granted; I have no
  access to confirm, and a missing grant would fail EVERY sweep at runtime
  while every local suite stayed green (DynamoDB Local does no authorization).
  Worth one explicit confirmation before the deploy.
- Whether the four pre-existing e2e sites that resolve the Upcoming region by
  role and name still pass now that the section lives inside an overflow
  container. I confirmed all four use `getByRole('region', { name: 'Upcoming
  scheduled messages' })` with no structural path from `.streamWrap`
  (`e2e/scenarios/steps.ts:3608`, `:3755`,
  `e2e/tests/dashboard-next/placements-page.spec.ts:205`,
  `e2e/tests/dashboard-next/tour-comms-pane.spec.ts:226`) and that Playwright's
  `toBeVisible()` is true for an element merely scrolled out of an overflow
  container - but that is a reading, not a run.
