# Spec review r1-b - tour auto-close and reopen (DRAFT 1)

- Spec: `docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md` @ edc045c3
- Reviewer: adversarial, independent (spec + repo only)
- Scope: conflicts with current behavior, unenumerated surfaces, contradictions
- Everything below was read in the worktree. Line numbers are on edc045c3.

Verified as ACCURATE (no finding): section 3's descriptions of the PATCH guards
(`app/src/routes/tours.ts:1073-1149`), terminal rotation and sweep
(`:1221-1235`, `:1354-1390`), `recordTourEvent` (`:260-287`), close-nag arming
(`:1453-1458`, `app/src/services/relayCloseNag.ts:34-60`), conversion
(`app/src/routes/placements.ts:661`, `:771-775`), repo reads
(`app/src/repos/toursRepo.ts:347-385`), the poll wiring
(`app/src/jobs/pollLoop.ts:53-73`, `app/src/worker.ts:289-295`), the event
bridge (it forwards every `APP_EVENT_NAMES` entry, `app/src/lib/eventBridge.ts:45`,
`app/src/lib/events.ts:299-321`), GSI projection ALL
(`app/src/lib/tables.ts:14`), the seed claims (lean has no tours; matrix past
tours are 3-10 days old, `app/src/lib/seed/matrix.ts:911-916`; the performance
seed anchors on now and dates tours in the future,
`app/src/lib/seed/performance.ts:647-650`), and the three fixed `scheduledAt`
literals in `e2e/tests` (no others exist under `e2e/tests`, `e2e/fixtures`).

---

## F1. [MEDIUM] The sweep-vs-staff race guarantee (6.6) is false; a lost race leaves a tour no UI can act on

**What is wrong.** 6.6 says: "a staff write after the close meets the existing
closed-terminal 409". The PATCH handler is check-then-act: it reads the tour
with a default (eventually consistent) GetItem, runs every guard against that
read, then writes with a condition that only checks the tour exists. A sweep
close that lands between the read and the write - or that the EC read does not
yet reflect - is not refused; the PATCH's SET-merge lands on top of it.

**Evidence.**
- `app/src/routes/tours.ts:1057` - `tours.get(tourId)`, no `consistentRead`.
- `app/src/routes/tours.ts:1076-1080` - the closed-terminal 409 tests that read, not the store.
- `app/src/routes/tours.ts:1239` -> `app/src/repos/toursRepo.ts:422` - the write's only condition is `attribute_exists(tourId)`; `toursRepo.ts:397-412` SETs only supplied fields, so the sweep's `outcome`, `autoClosedAt`, `autoClosedFrom` survive.
- Same shape in the Past tab bulk runner: EC `getTour` then `patchTour` (`dashboard/src/routes/tours/ToursPage.tsx:436-448`), and in the relay open path (`app/src/services/rosterProvision.ts:151` guard, then `toursRepo.ts:432-446` `claimGroupThread`, whose condition has no status term).
- Spec section 8: "Everything else in the PATCH handler is unchanged" - forbids the only fix.

**What it implies.** Concrete outcome of "Mark toured" racing a close of a past
`scheduled` tour: status `toured`, `outcome: 'no_outcome'`, `autoClosedFrom: 'scheduled'`.
That tour has no Record outcome CTA (`TourDetail.tsx:595` requires `outcome === undefined`),
is dropped from the Past tab and Today (`useTours.ts:203`), is never closed
again (5.3: outcome present -> null), and cannot be reopened (7.1: not closed).
Only a raw API PATCH recovers it. Reschedule / Cancel / Mark no-show racing a
close produce the same `no_outcome`-on-a-live-tour state. Section 12's new
invariant ("a tour carrying `no_outcome` was closed by the sweep") is broken by
the same race. The window is small, but it sits on exactly the population the
sweep targets (tours at their 14-day boundary that staff are cleaning up).
Either make the PATCH write conditional on the status it read (a section 8
change the spec must own) or delete the 6.6 guarantee and state the residue.

## F2. [MEDIUM] The rollout preview and the "reappears by the existing rules" claim both assume the Past tab sees every candidate; it sees 90 days, one page

**What is wrong.** Section 13 tells the operator to preview the first
production run from "the Tours page Past tab's rows dated more than 14 days
ago ... plus toured Undated rows not changed in 14 days". The sweep reads every
page of every candidate status with no age bound (6.2). The Past tab reads only
`[90 days ago, end of today]`, and only one page of it.

**Evidence.**
- `dashboard/src/routes/tours/useTours.ts:157-158` (`PAST_TAB_DAYS = 90`), `:179-183` (the window), `:243` (off-range toured rows only if touched inside the same 90 days).
- `app/src/repos/toursRepo.ts:347-364` - `listByScheduledRange` reads ONE page (spec section 3 says so; section 4 refuses to paginate it).
- Spec 6.2 - `listByStatus` x3, paged to exhaustion.
- Same root, a second claim: 7.5 ("it is 'Not marked' on the Past tab"), 9.3 and section 12 ("reopened tours come back by status - no change needed"). A reopened tour dated more than 90 days ago (any not-a-fit tour closed long ago, which the spec makes reopenable) is on neither the Past tab nor Today (`useTours.ts:198-250`, Today reuses the same loader, `useTodayPastTours.ts:144-147`).

**What it implies.** The first production run closes every no-outcome tour older
than 90 days without it ever appearing in the preview - with close-nags armed
on their open relay groups and timeline pins written (see F9). There is no
switch and no bulk reopen (decision 6, D7: reopen is one tour at a time on the
tour page), so an under-previewed run is repaired by hand. Separately, a staff
member who reopens an old not-a-fit tour and dismisses the chained Record
outcome dialog leaves a `toured` tour visible on no list until the sweep
re-closes it 14 days later. The preview text must state its 90-day blind spot
(or name an accurate source), and 7.5/9.3/12 must stop promising the Past tab
for tours older than its window.

## F3. [MEDIUM] Issue `past-tab-no-show-rows-need-an-exit` is marked resolved, but the mechanism does not deliver its fix, and decision 5 moves the unresolved rows onto Today

**What is wrong.** Section 15 resolves the issue. The issue's stated problem is
that staff have no way to say "done with this one", so "the tab cannot be
worked down to zero". Auto-close gives no staff exit; it shortens residency
from 90 to 14 days. Decision 5 then lists those rows on Today - whose heading is
"Past tours needing an outcome" - although a no-show cannot take an outcome.

**Evidence.**
- `docs/issues/past-tab-no-show-rows-need-an-exit.md` ("The tab cannot be worked down to zero"; "the missing piece is a way to say 'done with this one'"; recommended fix: Cancel on a no-show).
- Cancel is still UI-gated to requested/scheduled (`dashboard/src/routes/tours/TourDetail.tsx:99`); nothing in the spec changes it.
- No-shows cannot record an outcome: the exit gate requires `toured` (`app/src/routes/tours.ts:1146-1149`), and no dashboard control moves a no-show to toured (`TourDetail.tsx:301-313`: Reschedule and the no-show check-in only).
- Today heading `dashboard/src/routes/today/Today.tsx:47`; the file's own comments say no-shows are excluded because they had no exit (`Today.tsx:7-9`, `:220-224`; `useTours.ts:255-263`).

**What it implies.** For 14 days per no-show, the home queue carries a row staff
cannot clear - a no-show they have given up on keeps Today from ever reading
"All caught up" - under a heading that names an action the row cannot take.
Either keep the issue open (partially addressed: 90 -> 14 days) and say so, or
state that Today is accepted as un-clearable for no-shows and fix the heading
copy decision explicitly. The section-15 RESOLVED block as written would be
false.

## F4. [LOW] The Today change breaks an existing e2e spec that section 11 does not list

**What is wrong.** Section 11 enumerates the e2e work (one new spec, three
fixed-date moves, the perf catalog). It omits
`e2e/tests/dashboard-next/today-past-tours.spec.ts`, which pins the behavior
decision 5 reverses.

**Evidence.** `today-past-tours.spec.ts:2-3`, `:11-13` (header: "minus no-shows"),
`:115` (2 rows - becomes 3), `:121-122` (no-show absent from Today),
`:124` ("See all 3 on the Past tab" - with all 3 listed, `more` is false
(`Today.tsx:241`) and the link reads "Open the Past tab", `:255-257`),
`:170-180` (the capped order skips the 3-day-old no-show; with it included the
fifth row and the cut change). Unit pins also move: `useTours.test.ts:297-330`,
`Today.test.tsx`, `useTodayPastTours.test.tsx` (9.4's "tests change with it"
covers these, but not the e2e).

**What it implies.** Gate 4 fails on a spec the builder was never told to touch.
Add it to section 11.

## F5. [LOW] Section 10.2 misdescribes current behavior: the Past tab does not refetch on `tour.updated`

**What is wrong.** 10.2: "the tour page, Past tab and Today already refetch on
`tour.updated`". The Past tab has no event-stream subscription.

**Evidence.** No `useEventStream` / `onTourUpdated` in `dashboard/src/routes/tours/ToursPage.tsx` or `useTours.ts`. The subscribers are `useTour.ts:116-122`, `useTodayPastTours.ts:172-180`, `useToday.ts:152`, `useTourActivity.ts:85-91`, `RemindersPanel.tsx:319-325`.

**What it implies.** Rows the worker closes stay on an open Past tab until a
reload. Actions on them are guarded by the bulk runner's re-read
(`ToursPage.tsx:436-445` -> "Changed since the list loaded"), so the impact is
cosmetic - but the claim is wrong and a builder may rely on it in tests.

## F6. [LOW] 6.4 step 1 understates what the sweep deletes ("normally none")

**What is wrong.** `deleteSupersededForTour` deletes every NEVER-SENT row not on
the rotation - skipped and canceled rows included - not only pending rungs.

**Evidence.** `app/src/repos/tourRemindersRepo.ts:502-511` (filter is `sentAt === undefined && ladderId !== expectedPointer`; the comment says canceled and skipped rows are exactly what it removes). Every API-created past-dated tour carries a `booked_too_late` skipped row - the spec's own e2e recipe (section 11, item 1) creates one. Pre-migration tours carry `canceledAt` rows from the removed tour-wide cancel (`app/src/routes/tours.ts:1200-1220`).

**What it implies.** Consistent with every PATCH terminal transition, so not a
defect - but the first production run hard-deletes skipped/canceled reminder
history across the whole backlog, and the spec should say that instead of
"normally none".

## F7. [LOW] Three over-claims about which states can exist

**What is wrong / evidence.**
- 5.3: "an undated scheduled/no_show tour cannot exist through the API". It can: PATCH `{status:'no_show'}` on an undated `toured` tour passes every guard (`app/src/routes/tours.ts:1073-1128` refuses only from closed, into requested, out of requested, and into scheduled). That tour gets `null` forever (never closes) and is listed nowhere (the range read excludes undated, the off-range read takes only toured, `useTours.ts:241`).
- 6.3: "moveForward/convertible both absent on every candidate". PATCH `{moveForward:false}` on a toured tour writes `moveForward:false, convertible:false` with no outcome (`tours.ts:1173-1177`) - a candidate. The sweep leaves both on a `no_outcome` row.
- Section 1: "Any closed tour that did not become a placement can be reopened" contradicts 7.1/D6 (`tour_reopen_unsupported`).

**What it implies.** API-only residue; harmless today, but the model truth table
(section 11) should include these rows, and section 1 should match D6.

## F8. [LOW] CTA precedence for a closed, convertible, unconverted tour is unspecified

**What is wrong.** 9.2 makes a closed tour with outcome `move_forward` and no
`convertedPlacementId` reopenable and gives it the "Reopen tour" primary CTA.
The existing ladder puts "Start placement" ahead of every status rung for
`convertible === true`, and conversion gates on `convertible` alone.

**Evidence.** `dashboard/src/routes/tours/TourDetail.tsx:577-582`; `app/src/routes/placements.ts:661`. Such tours exist: the performance seed writes closed + move_forward + `convertible: true` (`app/src/lib/seed/performance.ts:660-664`), and PATCH `{status:'closed', outcome:'move_forward', moveForward:true}` produces one. `app/src/lib/seed/matrix.ts:1080-1087` already warns this state creates orphan placements.

**What it implies.** Two builders will order the rungs differently. Say which
wins (and whether reopen's REMOVE of `convertible` is the intended way out).

## F9. [LOW] The first run's activity burst and copy are not described; decision 4 understates the surfaces

**What is wrong.** The shared writer (10.1) records a person milestone for the
tenant AND the unit's landlord, plus two audit rows. Decision 4 names "the tenant
timeline" only. On the first production run every backlog tour gets "Tour
closed automatically: no outcome recorded after two weeks" dated the deploy
day - including tours closed months after their date.

**Evidence.** `app/src/lib/personEvents.ts` (`recordPersonMilestone` writes tenant then landlord); `app/src/routes/tours.ts:260-287`. Section 13 describes the close-nag burst but not the timeline-pin burst.

**What it implies.** Landlords with many old tours (PM companies) see a wall of
same-day pins; the "after two weeks" wording is false for the backlog. Say so in
section 13, or accept it explicitly.

## F10. [LOW] D8 is presented as "unchanged", but it removes the "Toured" signal for tours that did happen

**What is wrong.** Section 12/D8: "an auto-closed tour is an unconverted closed
tour -> no chip (unchanged rule, same as not-a-fit)". The rule is unchanged; its
output changes for every toured-with-no-outcome tour, whose "Toured" chip
disappears from both rosters on the first sweep.

**Evidence.** `app/src/lib/listingSendTour.ts:52-56`; read by `app/src/routes/contacts.ts:1174` and `app/src/routes/units.ts:960`. The chip spec's own rationale for the converted floor ("a converted tour necessarily happened; Toured is the honest floor", `docs/superpowers/specs/2026-07-10-listing-response-tour-chip-design.md:148-149`) applies equally to `autoClosedFrom: 'toured'`, which this spec stores.

**What it implies.** A planner-alone decision with a visible regression on the
property "Sent to tenants" roster. Fine to keep, but call it a change.

## F11. [LOW] A backdated "Mark already toured" is born already due

**What is wrong.** Decision 1's clock is the tour time. "Mark already toured"
accepts any past time with no warning, so recording a visit that happened more
than 14 days ago yields a tour the next sweep (<= 15 min) closes as "no outcome
recorded after two weeks" if the chained Record outcome dialog is dismissed.

**Evidence.** `dashboard/src/routes/tours/tourTime.ts:37-43` (warns only on FUTURE times); `TourDetail.tsx:521-530` (chains into Record outcome, which is dismissible). Requested tours never auto-close, so a weeks-old requested tour marked "already toured" with its real date is the ordinary case.

**What it implies.** "Tour took place" and "Closed automatically ... after two
weeks" minutes apart; recovery is a reopen. Not enumerated or tested. State it
(or decide the clock should not start before the toured transition).

## F12. [LOW] The e2e "tick with now 15 days ahead" is lane-global

**What is wrong.** Section 11 item 2 drives the dev tick with `now` 15 days
ahead. The tick closes every live tour due by then - any scheduled/toured/no-show
tour dated before about tomorrow - not only the spec's own.

**Evidence.** Spec 6.2 (candidates are every tour of three statuses). Item 4's no-show "dated within two weeks" is closed by that tick if it already exists. The suite is serial (`e2e/playwright.config.ts:140-141`).

**What it implies.** Order the steps (or reseed) so item 4's fixture is created
after item 2's tick; say so in the spec.

## F13. [LOW] Chaining Reopen into Record outcome repeats a documented modal-slot trap

**What is wrong.** 9.2: on confirm, apply the tour and open Record outcome "as
Mark toured does". If the reopen confirm is a `modal` slot whose dialog calls
`onConfirm` then `onClose`, a flat `setModal(null)` closes the outcome dialog
the instant it opens.

**Evidence.** `dashboard/src/routes/tours/TourDetail.tsx:820-829` (the guarded close that `MarkAlreadyTouredModal` needed for exactly this), `TourModals.tsx:218-219` (every modal in that file calls `onConfirm` then `onClose`; also `:84-85`, `:298-302`, `:375-376`).

**What it implies.** Name the guard in 9.2 so it is not rediscovered in self-QA.

## F14. [LOW] Widening the dashboard `TourOutcome` lets the client type-check a PATCH the server refuses

**What is wrong.** 9.1 adds `'no_outcome'` to the dashboard `TourOutcome`;
`patchTour` types its `outcome` field with that union.

**Evidence.** `dashboard/src/api/endpoints.ts:2668-2675`; `dashboard/src/api/types.ts:900`.

**What it implies.** The client compiles `patchTour(id, { outcome: 'no_outcome' })`,
which the server 400s (5.1). Type the PATCH with a staff-only union, mirroring
`STAFF_TOUR_OUTCOMES`.
