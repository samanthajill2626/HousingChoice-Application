# Spec-conformance review - feat/tour-reminder-supersession @65c19506

Reviewer: independent spec-conformance pass (merge base `f27aabbf`).
Contract: `docs/superpowers/specs/2026-09-01-tour-reminder-supersession-design.md`
(sections 3 and 6), the plan `docs/superpowers/plans/2026-09-01-tour-reminder-supersession.md`,
the work map `.superpowers/sdd/worklist.md` (S1-S11 + ORCHESTRATOR DECISIONS O1-O10).

Method: read the diff package, then verified every claim against the LIVE tree
(all line numbers below are live at 65c19506, not diff offsets). Slice reports
were consulted only AFTER forming a view of the code. One vitest run was made to
check the claims are not vacuous:
`npx vitest run test/ladderPointer.test.ts test/tourRemindersApi.test.ts test/placementConvert.test.ts`
-> 3 files, 85 tests, all green. No throwaway files were created; the tree is
`git status` clean apart from this report.

**Headline: 11 of 11 work-map items CONFORM; 18 of 18 acceptance criteria are
DELIVERED (one, #5, only by composition of two proven halves). No BLOCKING and
no MAJOR finding. One MINOR deviation (already self-flagged by the builder) and
six NOTEs.** This is the most completely spec-tracked branch I have reviewed in
this repo: every non-obvious ordering decision in the spec has a comment at the
code site naming the spec clause and the defect it prevents, and the tests are
built to fail under the wrong implementation rather than to pass under the right
one.

---

## A. Work-map conformance, S1-S11

| # | verdict | evidence (live tree) | deviations |
| --- | --- | --- | --- |
| S1 repo foundations | CONFORMS | `ladderId?` on the row `app/src/repos/tourRemindersRepo.ts:141` and on `create`'s input `:158`, copied by the conditional spread `:251`. `currentLadderId?` on the tour `app/src/repos/toursRepo.ts:120` with the D3 "never removed" argument written in. Claim guards: `attribute_exists(reminderId)` added to `claimSend` `:343`, `claimSkip` `:383`, `cancel` `:419`; `uncancel` untouched (it already requires `attribute_exists(canceledAt)`, `:445`). `deleteSupersededForTour` iface `:226`, impl `:469-507` - only filter is `r.sentAt === undefined` `:474`, `ConditionExpression: attribute_not_exists(#sentAt)` on the DELETE `:486`, `Promise.allSettled` with CCFE->debug / other->error `:497-505`, never rethrows. `setLadderIdIf` per O1: iface `toursRepo.ts:216`, impl `:478-511`, `attribute_exists(tourId) AND #cl = :expected` `:490`, `false` on CCFE `:500-505`. Pre-existing unused `GetCommand` import cleared (`tourRemindersRepo.ts:13-19`). Fakes: `setLadderIdIf` with REAL compare semantics `app/test/helpers/twilioWebhookHarness.ts:2901-2914`, `create` copies `ladderId` `:2964`, `deleteSupersededForTour` mirrors the single filter `:3031-3040`. | none |
| S2 armer stamps + returns | CONFORMS | `armTourReminders` returns `Promise<{ ladderId: string \| null; rows }>` `app/src/jobs/tourReminders.ts:426`; one `randomUUID()` per CALL `:431`; stamped on all four `create` sites `:544`, `:567`, `:600` (born-skipped), `:613`; `null` on the empty early return `:439` and on the all-skipped path `:623`. `ArmTourRemindersDeps` gained nothing. | none |
| S3 tour pointer writes | CONFORMS | CREATE: arm -> `tours.patch(tourId, { currentLadderId })` -> the 201 is built from the POST-patch tour `app/src/routes/tours.ts:347-371`; pointer-write failure is `log.error` `:366-369` (T3.6). PATCH: the `effectiveStatus`/`armable`/`rearmTrigger`/`terminal` derivation hoisted ABOVE the single write `:1191-1203`; rotation rides that patch `:1210-1211`; CAS after the arm `:1266`; winner folded into the response `:1270`, loser logs at error and re-reads `:1272-1279`; arm failure after rotation logs "tour is DISARMED" `:1255-1258`. | none |
| S4 seeds | CONFORMS | `live.ts:514-522` `pointTourAtLadder` (O6's re-Put of the same object) called after each of the three arms `:539`, `:554`, `:565`; `.length` -> `.rows.length` at all three log lines. `matrix.ts:978-986`: one deterministic `ladder-mx-<id>` per tour, `currentLadderId = upcoming ? ladderId : <ladderId>-rotated` (T4.5), stamped on all four raw row shapes `:1011`, `:1027`, `:1047`, `:1061`. `cast.ts:71-72` literal id helpers; `TOUR_TOURED` carries the ROTATED pointer `:777` over three stamped sent rows `:801`, `:811`, `:821`; `searchingTenant.tour` deliberately left bare as the pre-migration fixture `:524-526`. T4.4 (`performanceSeed`) closed as nothing-to-change in `S4.md`. | none |
| S5 refusal | CONFORMS | Tokens: `ReminderSkipReason` gains `superseded` `tourRemindersRepo.ts:100` and `conversion_stalled` `:108`; `ScheduledSuppressionReason` gains `superseded` ONLY `app/src/services/scheduledSendSuppression.ts:17` with the `discontinued`-precedent argument `:9-14`. Poll: deferral FIRST `jobs/tourReminders.ts:1130-1149` (prefix predicate `:1131-1132`, `conversion_stalled` past the O3 grace `:1134-1140`, unclaimed `return` inside it `:1148`), pointer check immediately below `:1165-1172`, BOTH above the batch-supersession stamp `:1199`. `CONVERSION_CLAIM_GRACE_MS` `:329` per O3. Send now per O4: ONE hoisted `toursRepo.get` `:1759-1761` passed on to target resolution, refusal immediately after `kind_retired` `:1785-1791`, `'superseded'` on `ForceSendRefusal` `:1686`. Copy census complete and asserted, not merely compiled - see the acceptance table for the surface-by-surface citations. | none |
| S6 three surfaces agree | CONFORMS | Shared predicate `app/src/lib/ladderPointer.ts:41-47` with the four-cell table in its docblock, called at all four sites: poll `jobs/tourReminders.ts:1165`, panel GET `routes/tourReminders.ts:747`, contact Upcoming `routes/contactTimeline.ts:1044`, group Upcoming `routes/relayGroups.ts:364`. All three surfaces rank `superseded` AHEAD of `discontinued`. Fixture hazard handled: `relayApi.test.ts` `seedTourGroup` sets the pointer from the armer's return. | none |
| S7 read grouping | CONFORMS | Partition `routes/tourReminders.ts:574-579`; `TourReminderEarlierView` per O5 `:182` (body optional, set ONLY from `sentBody` `:813`, never through `bodyFor`); sort `(sentAt ?? dueAt)` DESC with `reminderId` asc tie-break `:834-839`; `suppression` on the pending survivor only `:822`; `earlier` OMITTED when empty `:894`; `next` excludes `superseded` by reading the annotation `:857-862`. Both `.find(...)!` sites now 404 honestly: PATCH `:439-445` with the `scheduled.updated` emit HOISTED ABOVE the re-read `:427`, send-now `:518-524`. Client: `earlier` in `Committed` `RemindersPanel.tsx:202` and in both `setState` calls `:246`, `:263`; disclosure is a second child of `<Card>` OUTSIDE the empty short-circuit `:538-541`, raw `<details>` collapsed by default; action allowlist written out by state `:580-590` (upcoming -> Cancel only, aria-label `Cancel the earlier ...`); no body paragraph when `body` is undefined `:599`. | none |
| S8 conversion | CONFORMS | Nothing retires before the finalize; the reversible disarm is the existing `pending:` claim, argued at `app/src/routes/placements.ts:702-713`. Rotation minted above the try `:769` and folded INTO the finalize patch `:771-775` (one write). Sweep after, best-effort, never fails the 201 `:810-817`. Ordering comment rewritten `:692-700`; T8.5 stated at `:804-809`. | none |
| S9 tours.ts sweep | CONFORMS | Both sites swapped: re-arm `routes/tours.ts:1240` (rotate -> sweep -> arm -> CAS), terminal `:1295` (rotate -> sweep -> stop). `cancelTourReminders` / `cancelForTour` deleted from the job, the repo interface, the impl and the fake - I re-ran the grep myself over `app/ dashboard/ e2e/`: the only surviving hit is a historical comment at `app/test/tourReminders.test.ts:1929`. e2e re-pointed (see F1 for the one deviation). | ONE, self-flagged in `S9.md` 1a - see finding F1. |
| S10 Upcoming inside the scroll | CONFORMS | Markup: sentinel `dashboard/src/routes/contact/Timeline.tsx:2171`, block moved to the LAST child of `.stream` `:2178-2191` with section/heading/list nesting intact. CSS: `max-height`/`overflow-y`/`flex` and the `.upcoming` 767.98px block all deleted, O9's `margin-inline: calc(-1 * var(--sp-3))` added - and `.stream`'s inline padding really is `var(--sp-3)` (`Timeline.module.css:143`), so the full-bleed arithmetic is right. Anchor: pure `deriveStreamAnchor` `streamAnchor.ts:50-64` (direction, not slack, for `below`). All SIX writers converted: W1 `scrollToBottom` `Timeline.tsx:1887-1893`, W2 `handleStreamScroll` `:1895-1902` (clears the pill on `sentinel` OR `below`), W3 conversation switch `:1948-1958`, W4 prepend restore UNCHANGED `:1961-1967`, W5 growth pin `:1977-1989`, W6 `handleSend` `:2054`. Sentinel scroll is a rect DELTA, never `scrollIntoView` `:1877-1885`. `ResizeObserver` guarded, on the BLOCK only, keyed on the boolean not the array `:1907-1918`, feeding `blockResizeTick` into the EXISTING layout effect's deps `:1997` with `clusters`' key untouched. | none |
| S11 closing sweep | CONFORMS (no slice report - see F3) | I ran the sweep myself rather than trusting a report: `cancelForTour\|cancelTourReminders` over `app/ dashboard/ e2e/` returns one historical comment; all four e2e `Upcoming scheduled messages` region sites (`steps.ts:3595`, `steps.ts:3742`, `placements-page.spec.ts:205`, `tour-comms-pane.spec.ts:226`) and the five dashboard ones still resolve against the moved markup, because the region/list/card nesting was preserved. | no S11 report exists |

---

## B. Acceptance criteria 1-17 (as amended on-branch by O8)

| # | verdict | where it is proven |
| --- | --- | --- |
| 1 | DELIVERED | Route level, non-vacuously: `app/test/toursApi.test.ts:1793` "TWO RESCHEDULES" asserts absence BY reminderId (`world.tourRemindersMap.has(id) === false` for both dead generations), that the survivors are ONE ladder, and that a deliberately seeded SENT row survives - the last clause is what stops a sweep-everything bug from satisfying the test. Repo layer: `app/test/tourReminders.test.ts:642` (DDB Local). |
| 2 | DELIVERED | REPO layer against DynamoDB Local exactly as the spec demands: `app/test/tourReminders.test.ts:670` "a row that gains sentAt BETWEEN the list and the delete SURVIVES". |
| 3 | DELIVERED | DDB Local: `app/test/tourReminders.test.ts:524-572` - `claimSend` (with and without a `sentBody`), `claimSkip` and `cancel` each return false and leave NOTHING behind, verified by a raw `GetCommand`; plus `:572` proves the guard did not break the live path. |
| 4 | DELIVERED | Poll refusal `app/test/tourReminders.test.ts:5304` (DDB Local, asserts the row leaves `listDue` exactly once and emits). Send now 409 with its OWN copy: route `app/test/tourRemindersApi.test.ts:1788`, dashboard copy `dashboard/src/api/types.test.ts` PERMANENT_REFUSALS (asserts it is NOT the generic retry sentence) and `types.ts:1432`. Three surfaces: panel `tourRemindersApi.test.ts:982`, contact `app/test/contactTimeline.test.ts:1370`, group `app/test/relayApi.test.ts:1585` - each with an anti-vacuity current-generation rung beside it. `earlier[]` with Cancel and nothing else: `dashboard/src/routes/tours/RemindersPanel.test.tsx:1069`, `:1097`, `:1148`. |
| 5 | DELIVERED (by composition; no dedicated assertion) | The rows being gone is proven at the repo layer (crit. 2/3 above) and at the route layer (crit. 1); both Upcoming buckets read `listByTour`, so an emptied ladder yields an empty bucket by construction. There is no test that seeds a swept tour and asserts `upcoming: []` on either bucket. See finding F4 - I do not think this needs a new test, but the acceptance is the one whose proof is indirect. |
| 6 | DELIVERED | Terminal rotation present-and-unmatched: `app/test/toursApi.test.ts:1269`, `:1287`, `:1400`, `:1593`. Revival re-points at a NEW ladder: `:1733`. A legacy row not re-adopting is the `{}` vs `{currentLadderId}` cell, unit-pinned at `app/test/ladderPointer.test.ts:36`. |
| 7 | DELIVERED | `app/test/placementConvert.test.ts:692` (create throws) and `:716` (FINALIZE throws) both assert the ladder INTACT, the tour released and still scheduled, and nothing stamped. In-window deferral driven through the poll at `:750`; the grace-window retire and the FINALIZED-tour non-deferral at `app/test/tourReminders.test.ts:5424` and `:5458`. |
| 7a | DELIVERED | `app/test/placementConvert.test.ts:191` - the happy path asserts the rotated pointer and the deleted unsent rungs; code at `app/src/routes/placements.ts:771-775`. |
| 8 | DELIVERED | `app/test/toursApi.test.ts:1850` parks request A inside its arm so B completes underneath, then asserts BOTH generations are in the store, the pointer names one whose rows EXIST, and the loser logged once with the tourId. Real `ConditionExpression` proven separately at `app/test/toursRepo.integration.test.ts:476-530` (DDB Local, four cells including absent-pointer and missing-tour). |
| 9 | DELIVERED | Canceled rows are swept: `app/test/tourReminders.test.ts:642`. PATCH 404-not-500 with the emit preserved: `app/test/tourRemindersApi.test.ts:1496`; the emit is hoisted above the re-read at `app/src/routes/tourReminders.ts:427`. |
| 10 | DELIVERED, asserted on the RENDER | `dashboard/src/routes/tours/RemindersPanel.test.tsx:986` renders BOTH "No reminders armed." and the disclosure; `:781` and the allowlist at `RemindersPanel.tsx:580-590` give a canceled earlier rung no Restore. Server shape pinned at `app/test/tourRemindersApi.test.ts` (earlier[] describe, `reminders: []` + `next` undefined). |
| 11 | DELIVERED | Server: `app/test/tourRemindersApi.test.ts` "renders a body ONLY from the sentBody snapshot" asserts the bare row has NO `body` PROPERTY (not `''`). Client: `RemindersPanel.test.tsx:1120`. |
| 12 | DELIVERED | Read parity: `app/test/tourRemindersApi.test.ts:1026`; poll parity: `app/test/tourReminders.test.ts` "ANTI-VACUITY: a pre-migration pair (bare row, bare tour) still sends" (asserts an actual send, not merely the absence of a skip); per-surface legacy fixtures at `contactTimeline.test.ts:1408` and `relayApi.test.ts:1614`. Wire parity is structural: `earlier` is omitted when empty (`routes/tourReminders.ts:894`). Seeded fixture kept bare at `app/src/lib/seed/cast.ts:524`. |
| 13 | DELIVERED | Unit: `Timeline.test.tsx:1561` (opens on the newest MESSAGE, not the block), `:1634` (conversation switch lands on the sentinel). e2e, real layout: `e2e/tests/dashboard-next/upcoming-in-stream.spec.ts:201-216`. Post-send: `Timeline.tsx:2054` + the layout effect's `sentinel` branch. |
| 14 | DELIVERED, at NARROW_360 per O8 | `upcoming-in-stream.spec.ts:171` sets `NARROW_360`; `:194-199` proves the stream ACTUALLY overflows before anything else is asserted (the anti-vacuity probe the plan asked for); `:212-215` the block is not in the viewport at rest; `:218-245` scroll down reveals it, scroll up hides it. `WIDE_RESTORE` paired in a `finally`. |
| 15 | DELIVERED | e2e `upcoming-in-stream.spec.ts:247-287`: an inbound while standing on the block leaves the block's box within 2px AND holds the distance to the scroller's true bottom, with no pill. The short-block case (below by direction, not slack) is unit-pinned at `Timeline.test.tsx:1597` and `streamAnchor.test.ts:41`. Scrolled-above gets the pill and no jump: `Timeline.test.tsx:1614`, e2e `:289-301`. |
| 16 | DELIVERED (see NOTE F6 on where each half lives) | Relay-group through `ConversationDetail`, real browser: `upcoming-in-stream.spec.ts:289-315` - pill appears on an inbound while scrolled above, click lands on the newest message and the pill clears. Contact-thread half and the "dismisses on scroll to bottom" half are unit-level: `Timeline.test.tsx:1510`, `:1530`, and the clear at `Timeline.tsx:1901`. |
| 17 | DELIVERED | `app/test/seedLive.test.ts:465` asserts every seeded reminder row's `ladderId` equals its tour's `currentLadderId` (read from both tables), and `:490` that all three live tours carry a pointer and no two share a ladder. |

Proof-layer summary: 12 of 18 have a route- or repo-level automated proof;
the two conditional writes the plan singled out (T1.4's claim guard, T1.3's
compare-and-set) are proven against DynamoDB Local, not the fake, as required;
the four layout acceptances (13-16) are proven in a real browser at
`NARROW_360` with an explicit overflow probe. **No acceptance rests on live QA
alone.** T10.9's hand-driven phone QA remains the orchestrator's Phase 5 item
and is a belt-and-braces addition to e2e, not the only evidence for anything.

---

## C. Findings

### F1 - MINOR - the re-arm sweep's failure posture leaves a DISARMED tour with no "disarmed" log

`app/src/routes/tours.ts:1240` (and `:1295`)

The worklist's T9.1 says "Sweep failure on the re-arm path: log at error and
CONTINUE to arm (the rotation already refuses the old rows)". The code instead
calls the sweep bare, and argues the case at `:1235-1239`: the sweep swallows
per-row failures internally, so anything that escapes is the `listByTour` read
failing, and this handler's posture for an unexpected store failure is to throw.
That argument is sound as far as it goes, and the builder flagged the divergence
himself in `.superpowers/sdd/reports/S9.md` section 1a rather than burying it -
which is the right behaviour and most of why this is MINOR rather than MAJOR.

What it does not answer is the LOGGING half. The rotation has already committed
by the time the sweep runs (it rode the patch at `:1211`), so a throw here exits
the handler with a live `scheduled` tour whose pointer matches nothing and whose
ladder was never re-armed - precisely the state spec 3.2's "Interruption
posture" paragraph says "must be logged at error with the tourId". The arm
branch below DOES that (`:1255-1258`, "tour is DISARMED until the next
reschedule") and is covered by a test (`toursApi.test.ts:1915`); the sweep
branch reaches the identical end state and emits no such line - only whatever
the generic Express error path produces. The spec names steps 3 and 4 and not
step 2, so this is a gap in the spec's letter rather than a contradiction of it;
but the reader who hits this in production gets a 500 and no sentence telling
them the tour is now disarmed. The cheapest fix keeps the chosen posture: wrap
the two sweeps in `try { } catch (err) { log.error({ err, tourId }, '... sweep
failed after pointer rotation - tour is DISARMED until the next reschedule');
throw err; }`. Adjudication is the orchestrator's; either resolution is
defensible, but the log should not be lost with it.

### F2 - NOTE - `conversion_stalled` is measured from `dueAt`, so a long-overdue rung can be retired on the FIRST tick of a healthy conversion

`app/src/jobs/tourReminders.ts:329-340`, `:1134-1140`

O3 fixes the grace at one hour from `row.dueAt`, "exactly like `rosterWaitExpired`",
and the code implements that faithfully - so this CONFORMS-with-adjudication and
I am recording it, not reopening it. The consequence worth writing down: the
window is measured from the RUNG's due time, not from when the conversion claim
opened, so a rung that is already more than an hour overdue when a conversion
starts is `conversion_stalled` on its very first tick rather than deferred. Since
`skippedAt` is terminal (`tourRemindersRepo.ts:395`), a conversion that then
FAILS and releases its claim cannot bring that rung back - which is the shape
acceptance 7 exists to prevent ("a rung due inside the claim window is deferred,
not retired"). Reachability is genuinely low: the sentinel normally lives for the
duration of one HTTP request, so the poll has to tick inside that window AND find
a rung the previous hour of ticks failed to resolve. If it ever bites, the fix is
to measure the grace from the claim rather than from `dueAt`, which needs a
timestamp the sentinel does not currently carry.

### F3 - NOTE - the slice reports are in the gitignored `.superpowers/`, not in the committed reviews directory

`.superpowers/sdd/reports/S1.md` ... `S10.md`

`AGENTS.md` is explicit that slice reports belong in
`docs/superpowers/reviews/<date>-<branch>/` and are committed AS PRODUCED,
precisely because `.superpowers/` dies with the worktree - the 2026-08-21 sweep
that destroyed sixteen worktrees' review history is named in that same
paragraph. Right now `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/`
holds only the design-phase artifacts (spec rounds 1-5, plan rounds 1-2,
adjudications, research findings). The ten slice reports are worth keeping: S9's
section 1a is the only written record of finding F1's deviation, and S4/S5 carry
the census reasoning that the code comments compress. There is also no S11
report - I verified S11's greps myself rather than take it on trust, and they are
clean, but the absence should be stated in the handback rather than inferred.
This is an orchestrator action, not a code change.

### F4 - NOTE - acceptance 5 has no dedicated assertion

Both Upcoming buckets returning nothing for a cleanly swept ladder is true by
construction (they read `listByTour`, and the deletion is proven at the repo and
route layers), so I am not calling this PARTIAL. But it is the one acceptance
whose evidence is a composition of two other proofs rather than a test you can
point at, and if either half is later refactored - say a bucket starts reading a
projection or a cache - nothing fails. A four-line addition to
`contactTimeline.test.ts` (seed a tour, sweep it, assert `upcoming` is empty)
would close it cheaply. Optional.

### F5 - NOTE - two stale prose lines at the top of the reminders repo

`app/src/repos/tourRemindersRepo.ts:3` and `:8`

`:8` still reads "GSI byTour: hash=tourId - allows bulk cancel on
reschedule/cancel"; the bulk cancel is exactly what this branch deleted, and the
index now backs a bulk DELETE. `:3`'s row shape (`{ reminderId, tourId, kind,
dueAt, sentAt?, canceledAt? }`) does not name `ladderId`, which is the field the
whole feature turns on. The docblocks further down the file are excellent and
fully updated, so this is only the file header - but a header is what a new
reader reads first, and S9 made a deliberate pass over exactly this kind of prose
elsewhere in the file.

### F6 - NOTE - acceptance 16's two halves live at different layers

The spec asks for the pill "in a contact thread and in a relay-group thread
through `ConversationDetail`". The relay-group half is in a real browser
(`upcoming-in-stream.spec.ts:289-315`) and is the half that needed it - it is the
only render site carrying both a live Upcoming bucket and the pill. The contact
half is unit-only (`Timeline.test.tsx:1510`, `:1530`), and so is "dismisses on
scroll to bottom" (`Timeline.tsx:1901`; the e2e dismisses by clicking the pill,
not by scrolling). That split is defensible - the contact thread is the NO-BLOCK
case, which is the configuration jsdom can actually model, and the five
pre-existing pin tests were deliberately kept as that regression net - but the
handback should say so rather than let "acceptance 16: e2e" stand unqualified.

### F7 - NOTE - the layout effect does not re-run when the Upcoming block DISAPPEARS

`dashboard/src/routes/contact/Timeline.tsx:1907-1918`, `:1997`

I traced this because it looked like a hole and it is not, and the next reader
should not have to re-derive it. Block APPEARS: `hasUpcomingBlock` flips, the
observer effect re-runs, `ResizeObserver` fires its initial callback, and
`blockResizeTick` bumps the layout effect - covered. Block VANISHES (a reschedule
empties the bucket, `scheduled.updated` refetches): the observer disconnects and
no tick fires. For anchor `sentinel` this is harmless - the content shrinks, the
browser clamps `scrollTop`, and the sentinel is now the last child, so the clamp
lands where a re-pin would have. For anchor `below` there is a one-frame
cosmetic: `bottomGapRef` was measured with the block present, so the next growth
pin restores a gap that is now larger than the content warrants and the operator
sits slightly above the newest message until their next scroll event re-derives
the anchor to `sentinel` (with no block, `below` is unreachable by construction).
Not worth code; worth the sentence.

---

## What I checked and found nothing to say about

Recorded so a later reviewer does not repeat the work: the four-cell predicate
and its two asymmetric answers; the ordering of the deferral, the pointer check,
the batch-supersession stamp and the quiet-hours backstop in `processReminderRow`
(all four positions are argued in comments and all four match the spec); the
`superseded`-outranks-`discontinued` ranking on all three preview surfaces; the
copy census across both hand-mirrored dashboard unions, `SEND_NOW_ERROR_COPY`,
`suppressionLead`, `REMINDER_SUPPRESSION_LABELS`, `REMINDER_SKIP_REASON_LABELS`,
`ScheduledCard`'s `SUPPRESSION_COPY` and label ladder, and
`DeadlinesNudgesCard`'s compile-completeness entry with no chip branch (`:83`,
`:115`) - every unforced surface has an explicit assertion, including the
two-sided exact-set lists in `types.test.ts`; the `next` exclusion reading the
annotation rather than recomputing the predicate; the `earlier[]` sort's fixture,
which is built to fail under dueAt-either-direction and createdAt-either-direction;
the e2e `currentLadderList()` locator, which excludes the disclosure's `<ul>` by
CSS-module class using the same idiom `thread-history-paging.spec.ts` already
relies on; the negative-inline-margin arithmetic against `.stream`'s actual
padding; and the five non-goals in spec section 5, none of which is violated
(the one edit that touches a CURRENT-ladder action - hiding Send now for a
superseded rung, `RemindersPanel.tsx:439-441` - is unreachable after S7's
partition and is an explicit T5.2 task, not drift).

---

# Round 2 - re-review of fix wave 1 (@9af87a2c)

Re-read the amended spec sections (3.2 ownership-guarded sweep + terminal
TRANSITION, 3.3 grace basis + `conversion_in_progress`, acceptance 8) and
conformance-checked the nine-commit fix diff cold against them, then re-walked
acceptances 1, 6, 7, 7a, 8, 9 and 15 against the live tree.

Verification: `npx vitest run test/toursApi.test.ts test/tourRemindersApi.test.ts
test/placementConvert.test.ts test/tourReminders.test.ts
test/seedMatrixCoherence.test.ts` -> 5 files, 467 tests, all green. One
throwaway probe (`app/test/zzConformanceR2Probe.test.ts`) was written to
reproduce finding R2-1 and has been DELETED; the only untracked file left is
`app/test/zzAdvR2Tmp.test.ts`, which is not mine (the concurrent adversarial
reviewer's) and I have not touched it.

**Counts: 1 NEW BLOCKING (reproduced), 2 NEW MINOR, 1 NEW NOTE; 11 fix-wave
items verified CLOSED (F1, F5, F3, F7/m2, B1 re-arm, B1 conversion, M1, M2, M3,
m1, m3, m4); 0 STILL-OPEN from round 1.**

## 1. What my first pass MISSED

Worth stating plainly, because the pattern matters more than the list. I
verified that every clause the spec WROTE DOWN was implemented, and I did not
ask which behaviours had an unwritten twin. That is how all four majors got past
me:

- **B1** (generation-blind sweep deletes a concurrent winner's fresh ladder). I
  read the compare-and-set, satisfied myself it matched spec 3.2 step 4, and
  stopped - I checked the pointer WRITE was ordered, never that the DELETE
  between steps 2 and 3 was ordered. The sweep has no generation filter at all
  (`deleteSupersededForTour` filters on `sentAt` alone,
  `app/src/repos/tourRemindersRepo.ts:474`), which I had read and quoted
  approvingly in the S1 row of my own table. I had both halves and did not put
  them together.
- **M1** (Send now ignores the `pending:` sentinel). I traced the deferral in
  `processReminderRow` and the `superseded` refusal in `forceSendReminder`
  carefully, and never asked the symmetric question the spec itself asks about
  `superseded` ("it is a SEPARATE entry point and inherits nothing"): the
  deferral is a poll behaviour with no Send-now counterpart. My round-1 note
  that S5/O4 "conforms" was true clause-by-clause and blind to the gap between
  the clauses.
- **M2** (grace from `dueAt`). I FOUND this and under-rated it as a NOTE
  (round-1 F2), deferring to O3's wording. My reachability argument was wrong in
  a specific way: I reasoned about how long the sentinel lives and concluded the
  poll would rarely tick inside it, and never noticed that from `dueAt` alone
  the predicate is already TRUE at t=0 for any rung more than an hour past due -
  a quiet-hours deferral, a roster/names grace, an hour of worker downtime.
  Those are routine, not outages. The adversarial reviewer re-rated it MAJOR and
  was right; an O-decision's wording is not a reason to stop measuring
  reachability.
- **M3** (unrelated PATCH on an already-terminal tour). I explicitly considered
  the non-terminal, non-scheduled case (a PATCH to `requested`), concluded it
  was pre-existing behaviour, and moved on without doing the same walk for a
  PATCH that carries NO status on an ALREADY-terminal tour - the ordinary
  navigator exit gate, and the one that hits every completed tour.
- **m1** (echo bodies recompose). I read both echo paths for T7.8's 404 work and
  did not carry the LIST projection's "never recompose an earlier body" rule
  (which I had just praised) across to the single-row responses.

Re-walk of the acceptances the fix diff touches:

| # | round-2 verdict | evidence |
| --- | --- | --- |
| 1 | still DELIVERED | `app/test/toursApi.test.ts:1793` unchanged and green; the ownership read now sits in its path and passes (sequential reschedules always own their own rotation). |
| 6 | DELIVERED, and now correctly SCOPED | `app/src/routes/tours.ts:1212-1217` reads `patch['status']`; the new test "UNRELATED PATCH on an already-terminal tour rotates nothing and sweeps nothing" asserts the legacy `canceledAt` row, the sent row, the ABSENT pointer and the absent emit. See R2-2 for the residual door. |
| 7 | DELIVERED, materially strengthened | `conversionClaimExpired` now takes `tour.updatedAt` (`app/src/jobs/tourReminders.ts:351`, called `:1154`); paired tests "DEFERS a rung hours past due when the claim is FRESH" and "RETIRES the same rung once the CLAIM itself outlives the window" - the second is the anti-vacuity half and it is present. |
| 7a | DELIVERED | rotation still rides the finalize (`app/src/routes/placements.ts:769-775`); the sweep after it is now ownership-guarded `:817-830` with a test ("CONCURRENT REVIVAL: the post-finalize sweep is SKIPPED when another writer owns the ladder"). |
| 8 (amended) | **NOT DELIVERED as amended** - see R2-1. The re-arm half is delivered and well tested; the amended clause "no interleaving deletes the winner's freshly armed rows" is FALSE on the terminal path, which I reproduced. |
| 9 | DELIVERED | the 404 + emit path is untouched; the echo now refuses to recompose a superseded body (`app/src/routes/tourReminders.ts:453-461`, `:537-542`) with a test. |
| 15 | DELIVERED, hole closed | `prevHasBlockRef` (`dashboard/src/routes/contact/Timeline.tsx:1848-1852`) + re-derive at the effect top `:1949-1962` + `hasUpcomingBlock` in the deps `:2016`; test "re-derives the anchor when the block VANISHES under the operator". |

## 2. Cold conformance check of the new code

**Re-arm ownership guard - CONFORMS to amended 3.2 step 2, exactly.**
`app/src/routes/tours.ts:1254` re-reads, `:1255-1263` skips the sweep AND the
arm, logs at error with `tourId` / `rotation` / `storedLadderId`, and assigns the
winner's stored tour to the response. I checked the clause the spec does not
state and the report does: `ladderChanged` stays false on that branch (it is set
at `:1330`, inside the else), so the loser advertises no `scheduled.updated` -
correct, it changed nothing.

**Conversion ownership guard - CONFORMS.** `app/src/routes/placements.ts:817-830`
skips only the sweep and never the 201, matching the adjudication's narrowing and
the amended bullet in 3.2's conversion paragraph.

**`conversion_in_progress` copy surfaces - COMPLETE.** Union membership is
`ForceSendRefusal` only (`app/src/jobs/tourReminders.ts:1714`), which forces
nothing in the dashboard - there is no mirrored `ForceSendRefusal` union (I
grepped `dashboard/src`). The route mapping is code-agnostic
(`app/src/routes/tourReminders.ts:557` returns `result.reason` verbatim), so the
token reaches the wire. The one surface its membership IMPLIES is
`SEND_NOW_ERROR_COPY`, which has its own retry-flavoured sentence
(`dashboard/src/api/types.ts:1443-1449`) and a test asserting it is neither the
generic fallback nor the `conversion_stalled` sentence
(`dashboard/src/api/types.test.ts:172`). Correctly ABSENT from
`PERMANENT_REFUSALS`, from `ReminderSkipReason` and from
`ScheduledSuppressionReason` - the poll never stamps it and no preview surface
renders it. Nothing missing.

### R2-1 - NEW, BLOCKING - the TERMINAL sweep is not ownership-guarded; B1 is still live on that path

`app/src/routes/tours.ts:1344`

The fix wave guarded two of the THREE `deleteSupersededForTour` call sites. The
terminal branch still sweeps unconditionally, with no ownership read, no
try/catch and no log. That is not a residual window: the sweep can be delayed
arbitrarily after the terminal PATCH's rotation committed, and it then deletes
every unsent row on the tour regardless of generation.

I reproduced it rather than argued it. Throwaway probe, using the same parking
idiom the accepted B1 test uses (park request A between its patch write and its
sweep): A = `PATCH {status:'canceled'}`, B = `PATCH {scheduledAt}` running
underneath - which auto-advances a canceled tour back to `scheduled` at
`app/src/routes/tours.ts:1165-1171`, a first-class product flow - then A resumes
and sweeps. Measured end state:

```
status=scheduled  pointer=a2fe7a44-...  winner=a2fe7a44-...  rowsLeft=0
ownership errors=0
```

Two 200s, a live `scheduled` tour pointing at a ladder with ZERO rows, silently
disarmed, and not one error log from either request. That is byte-for-byte the
end state the adjudication called BLOCKING for B1 ("pointer names a ladder with
zero rows; two 200s; only the loser's log") - and worse by one, because here
there is no log at all. I rate it the way the same end state was already rated.

It is also a conformance failure against the amendment as written, twice over.
Spec 3.2 says "**Terminal transitions** ... run steps 1-2 and stop", and the same
amendment redefined step 2 as ownership-guarded - so the terminal path inherits
the guard by the spec's own sentence. And amended acceptance 8's new clause is
unqualified: "no interleaving deletes the winner's freshly armed rows". The fix
is the same shape as the two that landed: re-read, compare against `rotation`,
skip and log otherwise. The regression test is the probe above.

While in that branch: the comment at `:1343` still says "Same no-try/catch
posture as the re-arm branch", which the fix wave made FALSE - the re-arm sweep
acquired a try/catch and the F1 log at `:1280-1288`. Fix both in one edit.

### R2-2 - NEW, MINOR - "transition" is defined by the payload, not by a change, so an idempotent re-cancel still destroys pre-migration history

`app/src/routes/tours.ts:1212-1217`

**Conformance verdict first: the code CONFORMS.** The amendment says "A
TRANSITION means the PATCH explicitly carries a terminal `status`", and a repeat
`PATCH {status:'canceled'}` does carry one. So this is a challenge to the
amendment's wording and to the fix-wave report's justification for it, not a
claim that the implementation missed the spec.

The amendment's own rationale is "every pre-migration tour loses its surviving
reminder history on its first edit". A no-op re-PATCH to the same terminal status
is an edit that still does exactly that: `terminal` is true, `:1211` rotates the
pointer, and `:1344` hard-deletes the legacy `canceledAt` and pending rungs the
old tour-wide cancel left behind. The population is the same one M3 was filed to
protect - tours retired before this deploy, which have never been swept - and the
rotation additionally moves the tour out of the pre-migration cell permanently.
This codebase treats a no-op re-PATCH to the same status as a real, anticipated
event: the milestone emits immediately below carry idempotency guards for exactly
it (`:1375`, `effectiveStatus === 'scheduled' && currentStatus !== 'scheduled'`)
and the comment at `:1361-1362` says so in words. The narrower trigger is why
this is MINOR and not a re-open of M3.

The tightening is one clause - `patchedStatus !== undefined && patchedStatus !==
currentStatus` - and it reuses the idiom already in the file. If the orchestrator
prefers the simpler rule, the amendment should say WHY an idempotent re-cancel is
allowed to delete history, rather than resting on the claim in R2-3.

### R2-3 - CHALLENGE to fix-wave correction #3 (the claim is false)

`.superpowers/sdd/reports/fixwave-1.md:152-157`

The report defends the payload-based rule with: "The difference is a repeat
`PATCH {status:'canceled'}` on an already-canceled tour, which still rotates and
sweeps - **harmless (it deletes rows that are already gone)** and the simpler rule
to state."

The parenthetical is false for the only population that matters. Rows are
"already gone" only if a post-deploy terminal transition already swept them. On a
PRE-MIGRATION terminal tour nothing has ever swept - and after the M3 fix, an
unrelated PATCH deliberately never will - so its legacy rows are still there, and
the repeat status PATCH is precisely what deletes them. The fix wave's own M3
regression test builds that exact fixture (`app/test/toursApi.test.ts`,
"UNRELATED PATCH on an already-terminal tour ...": a pre-migration `toured` tour
holding a `canceledAt` row and a sent row) and proves the rows survive an
`{outcome, moveForward}` PATCH; send `{status:'toured'}` to that same fixture and
the canceled row is deleted. The conclusion (keep the simpler rule) may still be
the right call - but it needs a different argument, because this one would let a
reader believe the case is empty.

The report's other two corrections I checked and AGREE with: #1 (parking inside
`deleteSupersededForTour` lands in the accepted residual window, not the defect -
the test parks between the patch write and the sweep, which is the reviewer's
interleaving faithfully, and the pre-existing parked-arm test was kept), and #2
(`seedMatrix.test.ts` already pairs pointers per status GROUP; the genuinely
missing walk was row-side, and that is what `seedMatrixCoherence.test.ts`
gained).

### R2-4 - NEW, NOTE - the superseded echo sends `body: ''`, which the panel words as an outage

`app/src/routes/tourReminders.ts:459`, `:541`

The m1 fix is right and I verified it (no recompose). The fallback is
`after.sentBody ?? ''`, and `''` on the current-ladder renderer means "Preview
unavailable - this message cannot be composed right now"
(`dashboard/src/routes/tours/RemindersPanel.tsx:476-479`), while the LIST
projection deliberately OMITS the key for the same row so the disclosure renders
no paragraph at all (`app/src/routes/tourReminders.ts:813`, argued at
`dashboard/src/api/types.ts:1285-1293`). Unreachable today: neither client
handler renders the echoed `reminder` - both refetch
(`RemindersPanel.tsx:328-335`, `:353-364`). `viewOf` requires a `string` body, so
omitting is not free. Recorded so a future client that DOES render the echo does
not inherit a sentence blaming an outage that is not happening.

## 3. Closure of round-1 findings

| round-1 | verdict | evidence |
| --- | --- | --- |
| F1 (MINOR) - sweep failure leaves a disarmed tour unlogged | **CLOSED** on the re-arm path | `app/src/routes/tours.ts:1280-1288` logs "sweep failed after pointer rotation - tour is DISARMED ..." with the tourId, then rethrows - the posture I recommended. Test: "SWEEP FAILURE after the rotation is LOUD too". Not closed on the terminal path, but there the disarm IS the intended end state, so it folds into R2-1's guard rather than standing alone. |
| F2 (NOTE) = M2 | **CLOSED** | `app/src/jobs/tourReminders.ts:340-365`; the docblock no longer apologises for the basis. My round-1 severity was too low - see section 1. |
| F3 (NOTE) - slice reports gitignored | **CLOSED** | committed @4272c88d to `docs/superpowers/reviews/2026-09-01-tour-reminder-supersession/slice-reports/` (ten slice reports + `fixwave-1.md`). |
| F4 (NOTE) - acceptance 5 true by construction | accepted, no fix - agreed. |
| F5 (NOTE) - stale repo header prose | **CLOSED** | `app/src/repos/tourRemindersRepo.ts:3-12` now names `ladderId` in the row shape and says byTour backs the bulk DELETE, with the removed bulk CANCEL named as history. |
| F6 (NOTE) - acceptance 16's contact half is unit-only | accepted, routed to phase-5 live QA - agreed. |
| F7 (NOTE) = m2 | **CLOSED** | verified above (acceptance 15 row). The `upcoming` ARRAY is not in the deps - only the boolean - so the `GroupTextView` fresh-`[]` trap is respected. |

Also verified closed, from the adversarial list: m3 (the canceled matrix
`day_before` row is gone, `app/src/lib/seed/matrix.ts:1041-1050`, with the
row-side coherence invariant added) and m4 (retire-script comments,
`e2e/support/selectors.md`, both issue docs).

---

# Round 3 - re-review of fix wave 2 (@445b6b28)

Contract: the re-amended spec 3.2 (steps 1-4, transactional sweep, terminal
TRANSITION) and 3.3 (`conversionClaimedAt`, `conversion_in_progress` on all
three preview surfaces), plus `code-review-adjudications-r2.md`.

Verification, single-file runs only (the adversarial reviewer is live in this
worktree): `npx vitest run test/tourReminders.test.ts` -> 143/143 green, which
is the file carrying the DynamoDB-Local exercises of the real
`TransactWriteItems` sweep (rotating pointer mid-sweep, racing claim,
non-cancellation errors). Two throwaway probes were written to re-run my R2-1
and R2-2 reproductions and have been DELETED.

**Counts: 0 NEW BLOCKING, 0 NEW MAJOR, 0 NEW MINOR, 1 NEW NOTE. R2-1 CLOSED
(probe-verified), R2-2 CLOSED (probe-verified), R2-3 CLOSED, R2-4 STILL-OPEN
(NOTE, no action recommended). Amended acceptance 8: DELIVERED. All three
implementer deviations are within the spec's words or its plain intent - none is
drift.**

The design moved in the right direction and it is worth saying why: a
check-then-act ownership read was the wrong tool and failed twice for two
unrelated reasons (an eventually consistent GetItem; a caller that never got the
guard). Replacing it with a store-enforced condition removes the whole class
rather than the two instances. My R2-1 finding asked for a third copy of the
guard; the fix wave correctly declined that and made the guard unnecessary.

## 1. Conformance of the new code to amended 3.2 / 3.3

**Amended 3.2 steps 1-4 - CONFORMS**, clause by clause, at
`app/src/routes/tours.ts:1252-1352`:

| step | shipped | verdict |
| --- | --- | --- |
| 1 rotate, riding the patch | `:1220` unchanged (`patch['currentLadderId'] = rotation`) | CONFORMS |
| 2 arm | `:1268-1273`, moved above the sweep | CONFORMS |
| 3 CAS, loser reads CONSISTENTLY | `:1284` `setLadderIdIf`; loser logs at error and re-reads at `:1301` with `{ consistentRead: true }` | CONFORMS |
| 4 sweep IF WON, transactional, expected = the ladder just pointed at; current-ladder rows excluded; IF LOST no sweep | `sweepPointer` set only on the win (`:1291`) and on the no-rows cell; sweep at `:1338`; candidate filter `r.ladderId !== expectedPointer` at `app/src/repos/tourRemindersRepo.ts:509-511`; the loser's branch never assigns `sweepPointer` | CONFORMS |

The transaction itself (`tourRemindersRepo.ts:516-546`) pairs a `ConditionCheck`
on the TOUR's `currentLadderId` at TransactItems[0] with the guarded `Delete` at
[1], and the cancellation handling reads `CancellationReasons` POSITIONALLY -
[0] means a newer generation owns the tour (log info, `break`), [1] means the row
was claimed mid-sweep (log debug, `continue`), anything else logs at error and
continues. That positional dependence is real and is called out in the code
comment; it is correct as written.

I also checked the deployment half, because a store-enforced guard is exactly the
thing that passes every local gate and fails in prod on permissions:
`TransactWriteItems` needs `dynamodb:ConditionCheckItem` on the TOURS table, and
`infra/modules/ec2/main.tf:55` already grants it across all nine stack tables
plus their indexes. No Terraform change is owed.

**Terminal branch - CONFORMS to the amended wording exactly.**
`app/src/routes/tours.ts:1213-1218` is
`patchedStatus !== currentStatus && (patchedStatus === 'canceled' || ... )` -
"an explicit terminal `status` the tour does NOT already hold", both halves. The
sweep is the same transactional machinery with the rotation as the expected
pointer (`:1373`), wrapped in try/catch with a `log.error` naming the tourId and
a rethrow, and the stale "Same no-try/catch posture as the re-arm branch"
comment I flagged in R2-1 is gone.

**Conversion - CONFORMS.** `app/src/routes/placements.ts:810` passes
`rotatedLadderId` into the sweep inside the existing best-effort try/catch; the
eventually consistent ownership read that stood there is removed. The 201 still
stands on any sweep outcome.

**Amended acceptance 8 - DELIVERED.** I re-ran my round-2 reproduction (park a
terminal `PATCH {status:'canceled'}` between its patch write and its sweep; let a
revival `PATCH {scheduledAt}` complete underneath). Round 2 measured
`rowsLeft=0`; at this commit it measures:

```
R2-1 PROBE status=scheduled pointer=dc58ef9c-... winner=dc58ef9c-... rowsLeft=3
```

The winner's three rows survive, by identity, and the pointer names them. The
guarantee is now stronger than the amendment's own words: because the condition
rides each delete atomically, there is no residual window left to accept, and
the amendment correctly deleted the paragraph that used to name one.

**3.3 `conversionClaimedAt` - CONFORMS.** `claimConversion` writes the stamp on
the same conditional update as the sentinel (`app/src/repos/toursRepo.ts:477-491`)
and `releaseConversionClaim` REMOVEs both (`:502-514`), so a stamp can never
outlive the claim it describes. `conversionClaimExpired`
(`app/src/jobs/tourReminders.ts:350-372`) measures from
`max(dueAt, conversionClaimedAt ?? updatedAt)`. The fallback is right and its
scope is stated at the site: it covers a claim written before the stamp existed -
an in-flight conversion across the deploy - and nothing else. This closes my own
round-1 F2 properly, which the first fix did not: `updatedAt` is
last-touched-by-anything, so a tour edited more than once an hour made a STALLED
claim immortal, which is the unbounded deferral in a new costume.

**Send-now hidden, refetch delay not skipping - both CONFORM.**
`dashboard/src/routes/tours/RemindersPanel.tsx:467-469` adds
`conversion_in_progress` to the Send-now gate (the server answers 409, so the
button's only possible answer is a refusal). `nextReminderRefetchDelay`
(`:73-79`, `:99-101`) deliberately does NOT skip it - only `discontinued` and
`superseded` are skipped - which is the correct reading: those two are permanent
and this one resolves, and skipping it would leave "Converting" on screen after
the conversion landed. This is the trap the charge names and the code avoids it
with a comment saying why.

## 2. The implementer's three deviations

| # | deviation | verdict |
| --- | --- | --- |
| 1 | `ladderId === null` (the arm wrote no rows) sweeps against `rotation` | **Within the spec's INTENT; outside its words.** See R3-1 - the only new NOTE. |
| 2 | `conversion_in_progress` ordered BELOW `discontinued`, not "straight after `superseded`" | **Within the spec's words - and the better call.** 3.3 fixes no position. The suppression module's stated ladder is that the harder reason wins (`app/src/services/scheduledSendSuppression.ts:1-25`), and this is the only temporary member of the set: a chip reading "Converting" over a rung whose KIND will never send again would flip to the permanent truth minutes later. All four sites order it identically (`routes/tourReminders.ts:781-793`, `contactTimeline.ts:1053-1057`, `relayGroups.ts:364-374`, and the panel chip at `RemindersPanel.tsx:167-176`), which is the property that actually matters. Not drift. |
| 3 | "R2-1 is closed by fix 1, not by fix 2" | **Correct, and I verified it independently.** My probe passes because `deleteSupersededForTour` re-checks the pointer per row - fix 1's contract - and the terminal branch's ordering never changed. The reordering is right for its own reasons (it is what removes the reads), but it is not what closes R2-1, and the regression test cannot tell the two apart. Volunteering that a test proves less than it appears to is the behaviour I want to see in these reports, not a deviation to hold against it. |

### R3-1 - NEW, NOTE - the "arm produced no rows" cell is unspecified, and the code fills it correctly

`app/src/routes/tours.ts:1304-1313`, spec 3.2 step 4

Amended step 4 is written as a dichotomy - "IF the write WON: sweep ... IF the
write LOST: no sweep" - and there is a third cell: `ladderId === null`, where no
pointer write is attempted at all. The implementer sweeps against `rotation`,
which the tour is already holding from step 1 and which no row carries, so the
candidate filter excludes nothing and the ConditionCheck still refuses the sweep
if a concurrent writer has rotated since. I traced it and it is right in both
directions: safe (the guard is intact), and necessary (without it a re-arm that
arms nothing would leave the old ladder alive - the one case the old pre-arm
ordering covered for free, and a silent regression if it had been missed).

The code is not the problem; the spec is. Step 4 should name the cell in a
clause - "when the arm produced no rows the rotation is final and is what this
request sweeps for" - so the next implementer does not have to re-derive it, and
so a future reader cannot read the dichotomy as exhaustive and delete the branch.
Documentation only.

## 3. R2-1..R2-4 verdicts

| # | verdict | evidence |
| --- | --- | --- |
| R2-1 (BLOCKING) - terminal sweep ungated | **CLOSED** | `app/src/routes/tours.ts:1373` passes `rotation` into the transactional sweep, inside try/catch with a `log.error` and a rethrow. Probe-verified above: `rowsLeft=3`, pointer names the winner, where round 2 measured `rowsLeft=0` and zero logs. The stale `:1343` comment is gone. |
| R2-2 (MINOR) - repeat terminal status still swept | **CLOSED** | `:1213-1218` `patchedStatus !== currentStatus`. Probe: a repeat `PATCH {status:'toured'}` on a pre-migration `toured` tour holding a legacy `canceledAt` rung leaves the row present and the pointer ABSENT (`rowStillThere=true pointer=undefined`). The spec was amended to match ("a terminal `status` the tour does NOT already hold"), so wording and code now agree. |
| R2-3 (CHALLENGE) - fix-wave-1's "harmless" claim was false | **CLOSED** | The claim is retired by the fix rather than defended: the code now implements the tighter rule and the amended spec states it. `fixwave-2.md`'s own "Where the adjudication was imprecise" section does not repeat it. |
| R2-4 (NOTE) - superseded echo sends `body: ''` | **STILL-OPEN, no action recommended** | Unchanged at `app/src/routes/tourReminders.ts:460` and `:541`. Still unreachable (both client handlers refetch rather than render the echo), and `viewOf` requires a `string`, so omitting is not free. Carrying it forward as recorded residue is the right call; I am not asking for a fix. |

## 4. The `conversion_in_progress` census

Round 2 covered the SEND-NOW half (`ForceSendRefusal` + `SEND_NOW_ERROR_COPY`).
Fix wave 2 added the SUPPRESSION half, which is the wider one because
`ScheduledSuppressionReason` feeds three exhaustive maps. Walked independently:

**Forced (a missing entry fails typecheck) - all three present:**
- `REMINDER_SUPPRESSION_LABELS` - `dashboard/src/api/types.ts:1370-1373`
- `ScheduledCard`'s `SUPPRESSION_COPY` - `dashboard/src/routes/contact/ScheduledCard.tsx:42-47`
- `DeadlinesNudgesCard`'s `NUDGE_SUPPRESSION_LABELS` - `dashboard/src/routes/placements/DeadlinesNudgesCard.tsx:84-89`, compile-completeness only with no chip branch, matching the `superseded` precedent directly above it.

**Unforced (green proves nothing) - all present, each with an assertion:**
- app union + head comment - `app/src/services/scheduledSendSuppression.ts:15-26`
- dashboard hand-mirrored union - `dashboard/src/api/types.ts:1165-1172`
- `suppressionLead` -> `'On hold'` - `types.ts:1217`
- `types.test.ts` `SUPPRESSION_REASONS` hand-list (two-sided exact-set) - `:196`
- `ScheduledCard.scheduledLabel` -> `'On hold'` above the fire-time fall-through - `ScheduledCard.tsx:83`
- `RemindersPanel` `StateChip` -> `'Converting'`, in the `upcoming` tone rather than the muted `paused` tone the two permanent chips take - `RemindersPanel.tsx:167-176`
- `RemindersPanel` Send-now gate - `:467-469`
- `nextReminderRefetchDelay` NOT skipping it - `:73-79`
- all three preview surfaces short-circuit on the `pending:` PREFIX using the tour already in hand, no new read - `routes/tourReminders.ts:716-727` (hoisted once per request, not per row), `contactTimeline.ts:1053-1057`, `relayGroups.ts:364-374`

**Deliberately absent, and correctly so:** `ReminderSkipReason` (the poll defers,
it never stamps), `PERMANENT_REFUSALS` (the state resolves), and the `next`
exclusion at `routes/tourReminders.ts:895-897` - which excludes only
`discontinued` and `superseded`. That last one is a judgement call the report does
not name: a conversion-in-flight rung stays eligible for the "Next" tag, so the
panel can show "Next" beside a "Converting" chip. I think that is right on the
same temporary-vs-permanent argument the rest of the wave uses - the rung really
is the next one due once the claim resolves - and I raise it only so the choice is
on the record rather than inferred.

Nothing outside the round-1 census map turned up. The `earlier[]` projection needs
no entry: an earlier rung is `superseded`, which outranks this everywhere.
