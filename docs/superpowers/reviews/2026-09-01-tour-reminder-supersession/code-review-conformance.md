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
