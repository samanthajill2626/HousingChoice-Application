# Adversarial code review r1 - feat/tour-auto-close

Branch feat/tour-auto-close, worktree W:\tmp\tour-auto-close, HEAD 339acd9d, merge base
ae04122d. Reviewed blind to the design spec, plans and earlier review records: intent below
is derived from code, tests and e2e specs only. Raw probe outputs live in
.superpowers/review/adversarial-r1-ref.md (gitignored). Line numbers are the live tree at
HEAD.

## 1. What the feature intends (reconstructed)

A worker poll (app/src/worker.ts:537-570, every 15 minutes, its own constant) runs
runTourAutoClose (app/src/jobs/tourAutoClose.ts). It lists every tour in scheduled, toured
and no_show through the byStatus GSI and closes, silently, each one that still has no
outcome, is not convertible and carries no conversion claim, once two weeks have passed
since its clock start: the latest of createdAt, scheduledAt and the "mark" - lastMarkedAt
(a new attribute PATCH stamps on a status change or any new time, and reopen stamps), or
updatedAt when no lastMarkedAt exists (app/src/lib/toursModel.ts:201-225). The close is one
conditional write (toursRepo.autoCloseIf) setting status closed, outcome no_outcome (a new
system-only outcome PATCH refuses), autoClosedFrom, autoClosedAt and a rotated reminder
pointer; only the winner runs best-effort side effects: never-sent reminder rows deleted,
tour_auto_closed pins on tenant and landlord plus units# and tours# audit rows (via the
extracted lib/tourEvents.ts writer), a 28-day relay close-nag on an open group, and
tour.updated / scheduled.updated events. PATCH now reads consistently and writes with an
expectedStatus precondition (409 tour_changed). A hermetic dev tick drives the same job
with an optional tourIds scope.

POST /api/tours/:tourId/reopen is the only way out of closed: an auto-closed tour returns to
autoClosedFrom, a person-decided one (not_a_fit / move_forward) to toured; converted tours
and closed tours with neither fact are refused. reopenIf removes outcome, moveForward,
convertible and the two autoClosed facts, stamps lastMarkedAt, arms nothing, records
tour_reopened and clears a pending close-nag on the tour's own group. The dashboard mirrors
the reopen rule (tourReopen.ts), offers Reopen as the primary CTA (or as the last kebab item
when Start placement holds the CTA), hands a reopen-into-toured straight to Record outcome,
shows the outcome as a badge on Closed rows, maps any 409 in a writing dialog to "reload",
and Today now lists the Past tab's no-shows because they no longer sit there for 90 days.
The listing-send chip counts a tour auto-closed from toured as "toured".

## 2. Findings

| id | severity | title | file:line |
|---|---|---|---|
| AD-1 | MEDIUM | The close does not condition on updatedAt, which IS the clock of every never-marked tour; a staff write that restarts that clock is overridden | app/src/repos/toursRepo.ts:700-722 |
| AD-2 | LOW | A reopened tour dated before the Past tab's 90-day window is on no Tours tab and not on Today until it auto-closes again | dashboard/src/routes/tours/useTours.ts:239-252 |
| AD-3 | LOW | The PATCH precondition comment claims more than the code: only status is conditioned | app/src/routes/tours.ts:1228-1232 |
| AD-4 | LOW | Past tab copy states the clock wrongly; the two-week rule is hard-coded in four strings across two codebases | dashboard/src/routes/tours/ToursPage.tsx:603 |
| AD-5 | LOW | reopen maps every person outcome to "toured", but PATCH lets a decided tour leave toured before it closes | app/src/lib/toursModel.ts:253-258 |
| AD-6 | LOW | The new 409 reaches the header-alert actions as raw machine text | dashboard/src/routes/tours/TourDetail.tsx:367 |
| AD-7 | NOTE | "A live tour's group must not nag" lives only in reopen; a PATCH revival never clears the nag a cancel armed | app/src/services/relayCloseNag.ts:84-112 |
| AD-8 | NOTE | reopenIf has no ABA guard (reopen, re-close with the same outcome, stale reopen lands again) | app/src/repos/toursRepo.ts:766-779 |
| AD-9 | NOTE | The first unattended run deletes pre-migration reminder history and arms every open group's nag for the same day | app/src/jobs/tourAutoClose.ts:110-123 |

Not counted (already filed by the authors, confirmed real): relay open vs auto-close and
reopen vs conversion (docs/issues/tour-relay-open-vs-auto-close-race.md); the client
stale-list window (docs/issues/tours-patch-status-precondition.md).

### AD-1 (MEDIUM) - the close ignores the clock input of every never-marked tour

Evidence. autoCloseDueAtMs takes the mark from lastMarkedAt, else from updatedAt
(app/src/lib/toursModel.ts:218); its own comment says unrelated writes that bump updatedAt
move the clock until a lastMarkedAt exists (:214-217). autoCloseIf conditions on status,
outcome, convertedPlacementId, convertible, scheduledAt and lastMarkedAt - never updatedAt
(app/src/repos/toursRepo.ts:700-722); the fake mirrors it (app/test/helpers/
twilioWebhookHarness.ts:3623-3640). Yet the repo docstring promises a write "ONLY while every
field the due decision read is unchanged" (toursRepo.ts:289-297) and the job header promises
"a staff change that lands between our read and our write wins" (tourAutoClose.ts:10-11).
Never-marked is not a legacy corner: create never stamps lastMarkedAt, so every tour booked
at creation and never marked - the "Not marked" population the sweep exists for - runs on
updatedAt. Writes that move it without stamping a mark: roster plan edits (setRoster /
clearRoster), the relay open (claimGroupThread + pointer patch), and a same-status PATCH
restatement (tours.ts:1161-1166 stamps only on a status change or a time).

Interleaving. (1) The sweep lists candidates from the byStatus GSI - eventually consistent,
so the item can already be up to the replication lag old (toursRepo.ts:412-431); the read
says due. (2) A person resets or edits the tour's roster plan (or opens its group): updatedAt
moves, and under the rule the tour now has two fresh weeks. (3) autoCloseIf(staleRead) - every
conditioned field is unchanged, so the close lands and the side effects run
(tourAutoClose.ts:90-102).

Reproduction (probe 1, deleted): against DynamoDB Local, a toured tour with no lastMarkedAt;
read; isAutoCloseDue(read, now) true; clearRoster 1.2 s later; isAutoCloseDue(stored, now)
false; autoCloseIf(read) -> {"status":"closed","outcome":"no_outcome"}. The same through the
whole runTourAutoClose on the harness fake: dueAtWrite false, summary closed 1.

Blast radius. A tour a person just worked on closes as "No outcome recorded" (timeline pins
on both parties, close-nag armed) and has to be reopened. The window is GSI lag plus the time
from the run's list to that tour's write - sub-second in steady state, tens of seconds while
the first run works through the backlog. Rare, recoverable, but it falsifies the module's
stated concurrency guarantee, and the parity suite agrees with the hole rather than catching
it (both implementations skip the term).

Smallest fix. When the read carries no lastMarkedAt, add updatedAt equality to the condition
(`#ua = :ua` from the read) in autoCloseIf and in the fake, plus one integration and one
parity case ("an unrelated write moved updatedAt on an unmarked tour"). The ms-collision
caveat the docstring cites only weakens this extra term; it cannot make the guard looser
than today. Correct the two comments either way.

### AD-2 (LOW) - a reopened old tour vanishes from every list

Evidence. Active reads [start of today, +30 days] and keeps scheduled only
(useTours.ts:48-54, 71, 80). Past reads the byScheduledAt range [90 days ago, end of today]
plus status=toured kept only when undated or dated after the window (useTours.ts:181-185,
317-318, 239-252). Closed reads closed + canceled (useTours.ts:133-134). Today's section is
the Past rows (useTodayPastTours.ts:146-166). Reopen returns a tour to scheduled / toured /
no_show with its original date (routes/tours.ts:1480-1517) and no date window check.
Auto-close sits on the Closed tab indefinitely, and the first run closes tours dated months
back, so reopening one older than 90 days is a normal path.

Reproduction (probe 2, deleted): a tour dated 2026-06-01 reopened on 2026-10-04 to no_show
or toured is before pastToursDateRange.from (2026-07-06) and toursDateRange.from, is dropped
by selectOffRangeTours, and is neither closed nor canceled.

Blast radius. The tour is reachable only by direct link or the tenant / property tours card
for 14 days, then closes again with no_outcome. The reopen-to-toured flow opens Record
outcome at once (mitigates); a dismissed dialog or a reopen-to-no_show "to reschedule later"
loses the tour from view. Smallest fix: have Reopen land the operator on the tour page with
a note, or let the Past tab's off-range read also keep live tours whose lastMarkedAt is
inside the window (the touched clock selectOffRangeTours already uses).

### AD-3 (LOW) - the precondition comment overclaims

Evidence. routes/tours.ts:1228-1231 says a concurrent "another PATCH, a conversion, the
auto-close sweep" between read and write "is refused instead of merged on top"; the write
conditions on status only (:1232, toursRepo.ts:463-468). The issue update in
docs/issues/tours-patch-status-precondition.md repeats the claim. A same-status PATCH (exit
gate without status, reschedule) and a conversion claim (claimConversion keeps status) merge
exactly as before.

Reproduction (probe 3, deleted): two exit gates on one toured tour, the second landing
between the first's read and write: both 200, stored outcome move_forward, and the tour's
trail holds two tour_outcome rows ("not a fit" and "moved forward"). Pre-existing behavior;
the defect is the comment a future reviewer will rely on. Fix: say "a concurrent STATUS
change"; if the wider guarantee is wanted, condition the exit gate on attribute_not_exists
(outcome) as well.

### AD-4 (LOW) - the rule as told to staff, and where the rule is copied

Evidence. The Past tab intro says tours close "two weeks after their date or their last
update" (ToursPage.tsx:603). The clock is the latest of creation, date and the last MARK:
for a marked tour a roster edit, group open or outcome edit is an "update" that does not
restart it; creation is omitted. Staff will read "touching it keeps it open". The two weeks
also live in AUTO_CLOSE_AFTER_MS (toursModel.ts:162), TOUR_AUTO_CLOSED_LABEL
(tourAutoClose.ts:35), listingFormat.ts:124, tourActivityFormat.ts:26 and this intro - five
places, two codebases, no test linking the strings to the constant. Related naming: Today's
heading "Past tours needing an outcome" (Today.tsx:49) now heads No show rows whose next step
is a reschedule. Fix: "two weeks after their date, or after they were last marked or
reopened"; derive the copy or pin it in one cross-surface test.

### AD-5 (LOW) - "a person-decided closed tour was toured" is assumed, not enforced

Evidence. reopenTargetFor sends any closed tour carrying not_a_fit / move_forward to toured
(toursModel.ts:253-258; mirror tourReopen.ts:12-20). The exit gate needs status toured to
SET an outcome (tours.ts:1124), but nothing clears it on a later status move, and the guards
(tours.ts:1051-1106) allow toured -> no_show, toured -> canceled, canceled / no_show ->
scheduled and any -> closed. API path: toured + not_a_fit -> no_show (or canceled ->
rescheduled) -> closed -> reopen = "Toured" for a booking that never happened. No dashboard
path produces it (CANCELABLE and canMarkNoShow exclude toured, TourDetail.tsx:110, 318), so
LOW. Fix: refuse (tour_reopen_unsupported) unless the outcome was recorded on the
transition into closed, or clear outcome / moveForward / convertible when PATCH moves a
tour out of toured.

### AD-6 (LOW) - the new 409 shown as a machine code

Evidence. TOUR_CHANGED_COPY covers the dialogs only (failureCopy, TourModals.tsx:44). Mark
toured / Mark no-show run through runDirect, which renders ApiError.message
(TourDetail.tsx:367), built as code + " (" + detail + ")" (dashboard/src/api/client.ts:80);
Start placement does the same (:499). Before this branch a 409 there needed two humans; now
the background sweep produces it on any stale tour page. Fix: route runDirect and
handleConvert through the same failureCopy mapping.

### AD-7 (NOTE) - the nag-clear rule has one writer

clearRelayCloseNagOnReopen exists because a live tour's group must not prompt "close it?"
(relayCloseNag.ts:84-112, called only at tours.ts:1513). A cancel arms the same nag
(tours.ts:1457-1462) and the canceled -> scheduled revival is a PATCH that never clears it,
so a revived tour's group still surfaces on Today 28 days later (today.ts:1001-1004 does not
look at the owner). Pre-existing, but the new code now states the rule; apply it on revival
too or note the asymmetry.

### AD-8 (NOTE) - reopenIf has no ABA guard

reopenIf conditions on closed, no conversion, and outcome / autoClosedFrom equality
(toursRepo.ts:766-779). Reopen A reads closed not_a_fit; B reopens, records not_a_fit and
closes again; A's stale write still matches and reopens a tour B just decided. Two humans
within one request's window - NOTE. Conditioning on the read's lastMarkedAt (or updatedAt)
closes it.

### AD-9 (NOTE) - the first run, unattended

The first poll (15 minutes after the worker boots) closes the whole stale backlog in one
pass. Per closed tour, afterClose deletes every never-sent reminder row whose ladderId is not
the new rotation (tourAutoClose.ts:110-115, tourRemindersRepo.ts:509-511) - for tours marked
toured / no_show before the supersession migration that is the old tour-wide cancel's
canceledAt history, the population the M3 / R2-2 comments (tours.ts:1186-1216) protect from
no-transition sweeps. A person's toured -> closed PATCH sweeps the same rows, so this is
parity, but here it is en masse with nobody looking. Every open group linked to a closed
tour is armed for now + 28 days (tourAutoClose.ts:123), so the whole batch reaches Today's
"Relay groups to close" on one day. Worth an explicit go / no-go and a dry-run count before
the first deploy.

## 3. Consumer / mutator sweep

| state / value / event | writers | readers | agrees? |
|---|---|---|---|
| status closed | PATCH tours.ts:1232; conversion finalize placements.ts:771; sweep toursRepo.ts:679; exit only via reopenIf toursRepo.ts:748 | PATCH guard tours.ts:1054; reopenTargetFor toursModel.ts:253; open guard rosterProvision.ts:151; roster-action poll rosterActions.ts:171; deriveTourSignal listingSendTour.ts; dashboard tourReopen.ts:13, TourDetail.tsx:335, ToursPage.tsx:160, useTours.ts:80/133/164 | yes; a deferred roster action that meets an auto-closed tour dies as owner_canceled and a reopen does not revive it (by design of "dead") |
| outcome no_outcome | sweep only; removed by reopenIf; PATCH refuses tours.ts:1022 | autoCloseDueAtMs; reopenTargetFor; TourDetail.tsx:845; ToursPage.tsx:160; TOUR_OUTCOME_LABELS (app + dashboard types.ts:906); tourReopen.ts:18; seeds history.ts:805-811 (never see it) | yes |
| autoClosedFrom / autoClosedAt | sweep; removed by reopenIf | reopenTargetFor / tourReopen; listingSendTour.ts (toured floor); TourDetail.tsx:851; e2e | yes |
| lastMarkedAt | PATCH tours.ts:1161-1166 (also on a restated identical time); reopenIf | autoCloseDueAtMs toursModel.ts:218; autoCloseIf condition toursRepo.ts:717-722; dashboard type | yes (doc says "changed", code stamps any time) |
| updatedAt (now a clock input) | every tour write: create, patch, claim/release group + conversion, setLadderIdIf, setRoster / clearRoster, autoCloseIf, reopenIf | autoCloseDueAtMs fallback; useClosedTours sort; selectOffRangeTours useTours.ts:241 | NO - autoCloseIf ignores it (AD-1) |
| currentLadderId | create follow-up tours.ts:334; PATCH :1224; setLadderIdIf; conversion; sweep rotation; reopen leaves it | reminder send paths; deleteSupersededForTour ConditionCheck tourRemindersRepo.ts:525-531 | yes |
| convertible / moveForward | PATCH exit gate; removed by reopenIf | conversion placements.ts:661; autoCloseDueAtMs / autoCloseIf; TourDetail CTA + kebab; needsPlacement useTours.ts:189 | yes, except the filed claimConversion race |
| close_nag_next_at | arm: PATCH cancel / not a fit tours.ts:1457-1462, placements, sweep tourAutoClose.ts:123; clear: reopen tours.ts:1513, group close relayGroups.ts:687; defer relayGroups.ts:772 | today.ts:1001-1004 (no owner filter); arm (set-if-absent); clear (owner-checked) | partly - revival never clears (AD-7); arm checks no owner, clear does (safe today: groupThreadId only ever names the tour's own group outside seeds) |
| never-sent reminder rows | deleteSupersededForTour from PATCH, conversion, sweep | RemindersPanel; listDue | yes (parity); first-run scale AD-9 |
| activity tour_auto_closed / tour_reopened | lib/tourEvents.ts via sweep and reopen | contactTimeline.ts (pass-through); Timeline.tsx:428-444 (neutral pin); tourActivityFormat.ts:26-27, 77-78; listingFormat.ts:124-125; units.ts projection (open set); seeds TOUR_EVENT_TYPES (subset) | yes |
| tour.updated / scheduled.updated | PATCH, relay, conversion, roster actions, sweep (worker via bridge; app via tick), reopen | useTour, useToday (debounced), useTodayPastTours (300 ms), RemindersPanel, useRoster, ContactCommsTab, ScheduledCard | yes |
| 409 tour_changed | tours.ts:1243-1247 | TourModals failureCopy; runDirect / handleConvert (raw, AD-6); bulk Mark toured ("The update failed"); e2e decide() | partly (AD-6) |
| POST /api/tours/:id/reopen | - | dashboard reopenTour; mutation catalog; e2e; requireAuth via api.ts mount (route test 401 / 403) | yes |
| POST /__dev/tour-auto-close/tick | - | e2e spec; selectors.md; dev-router gate | yes |
| Today past rows (no-show filter removed) | useTodayPastTours.ts:146-166 | Today.tsx:49 heading; today-past-tours e2e | depends on the server keeping no_show in AUTO_CLOSE_STATUSES - no test links the two codebases |

## 4. Test gaps

- Nothing starts the worker: deleting the worker.ts block or binding it to
  WORKER_POLL_INTERVAL_MS keeps every gate green. The e2e drives only the dev tick.
- The production candidate path (listByStatus over the eventually consistent GSI, unscoped
  run) never runs against DynamoDB Local; the tick path reads by id with consistentRead.
- The parity suite has no "unrelated write moved updatedAt" case, so fake and store agree on
  the AD-1 hole.
- The e2e "nothing is sent" check uses a self-guided tour with no relay group and a fixed 2 s
  sleep; a regression that sent on the group path could not show (false pass only).
- No test covers a reopened tour's list visibility (AD-2), the reopen ABA (AD-8), or a
  decided tour that left toured before closing (AD-5).
- Mutations checked in my head and caught: due boundary < vs <=; each autoCloseIf / reopenIf
  condition term (integration races); expectedStatus dropped; the lastMarkedAt stamp OR /
  restatement; canReopen's convertible term; the Today no-show filter; tourIds scoping;
  consistent reads; autoClosedFrom-over-outcome order. Not caught: worker wiring, and AD-1.

## 5. Could not verify

- First-run volume in production (stale backlog size, open groups linked, pre-migration
  reminder rows) - needs a read-only count against prod data.
- Real byStatus GSI lag under load (sizes AD-1's window) and how many worker processes run.
- Whether the spec means roster edits / group opens to restart an unmarked tour's clock
  (deliberately not read); the code comment says they do, and AD-1 is judged on that.
- The e2e gate run reported 2 failures outside the tours specs (a2p-compliance.spec.ts:132,
  contact-detail.spec.ts:161); every tours spec passed. Not investigated.

Throwaway probes (created, run, deleted): app/test/zz-review-adv-1.test.ts,
dashboard/src/routes/tours/zz-review-adv-2.test.ts, app/test/zz-review-adv-3.test.ts.
