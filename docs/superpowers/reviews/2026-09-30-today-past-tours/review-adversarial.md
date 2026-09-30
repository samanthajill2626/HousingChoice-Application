# Adversarial review - feat/today-past-tours @82ea97a3

Reviewer: independent, plan-blind (diff + repo + standing charter only; no
spec, plan or planner reasoning), read-only, model opus. Findings as returned;
the planner's rulings are in `adjudications.md` beside this file.

Totals: blocking 0, high 0, medium 2, low 11 (confirmed), plus 2 plausible.

## CONFIRMED

**M1 (medium) - Today now runs an all-history tours read plus up to 10 point
reads on every visit and on every tour.updated.** `useTodayPastTours.ts:114`
calls `usePastTours(true)`, which issues `getTours({status:'toured'})`
(`useTours.ts:319-322`) -> `listByStatus`, paging the whole byStatus GSI
partition (`toursRepo.ts:366+`). Claim: recording an outcome does not change
status (the PATCH only sets outcome/moveForward, `tours.ts:1172-1177`), so the
read grows with all history. `labelRows` builds its caches per call
(`useTodayPastTours.ts:64,88`), so every reload re-reads up to 5 contacts and
5 units. The reload fires on ANY tour.updated (`:139-148`), including roster
emitters (`tours.ts:904`, `rosterActions.ts:161`, `rosterProvision.ts:468`)
and conversion (`placements.ts:900`). The client also duplicates the server's
deleted-tenant rule (`app/src/routes/today.ts:376-380`). Suggested: assemble
server-side, or at minimum cache names in a ref, filter reloads by event, and
drop the status=toured read on the landing page.

**M2 (medium) - `npm run perf:pages` contract for '/' not updated.**
`TODAY_GETS` (`e2e/performance/routes.ts:268-273`) lacks `/api/tours
['status']`, `/api/contacts/:contactId`, `/api/units/:unitId`;
`TODAY_TERMINAL` (`routes.ts:380-385`) does not know the new list. The perf
seed has 50 tours across every status (`app/src/lib/seed/performance.ts:41,
1197`), so the Today sample issues these GETs; unknown shapes are marked
required with `forceUnmatched` (`collect.ts:398-402`) and feed
`unmatched_api` / `unexpected_endpoint` (`report.ts:315,337`). Ledger
citations for '/' (`routes.ts:696`, terminals['/']) are stale; the citation
test checks format only. Suggested: conditional TODAY_GETS entries, the list
in TODAY_TERMINAL, a BACKGROUND_REFRESH_DECLARATIONS row for the tour.updated
reload, refreshed citations.

**L1 (low-medium) - one tour can show in both "Tours today" and the new
section after a live change.** `useToday.ts:142-148` does not listen to
`onTourUpdated`; the new hook does. A tour today at 9:00 marked toured at
10:00 in another tab gains a "Needs outcome" row while Tours today (server
keeps `scheduled` only, `today.ts:549`) still lists it. Suggested: add
`onTourUpdated: scheduleRefetch` to useToday.

**L2 (low) - the debounce test proves nothing.**
`useTodayPastTours.test.tsx:152-159` fires both events in one `act()`; React
batches the two `setEpoch` calls, so the call count passes with or without the
debounce. Suggested: fake timers, events in separate acts, assert no reload
inside the window and exactly one after.

**L3 (low) - "See all N on the Past tab" does not match the Past tab.**
`total` excludes no-shows (`useTours.ts:261-263`, `useTodayPastTours.ts:128`)
while the Past tab lists them; the new e2e asserts "See all 6" and lands on 7
rows. `total` also counts deleted tenants Today hides. Suggested: neutral copy,
or count what the destination shows.

**L4 (low, design) - Needs-outcome rows can be crowded out.** Off-range toured
rows sort after ALL range rows (`useTours.ts:327`); with 5+ dated rows they
never reach Today, and stale Not marked rows fill the slots. Suggested: rank
Needs outcome first, or interleave off-range rows by date.

**L5 (low) - Today can render blank while the section labels.** Empty queue,
no nags, section loading: no spinner and no "All caught up"
(`Today.tsx:254,269`) for three round-trip stages. Suggested: Spinner.

**L6 (low) - failure isolation is one-directional.** The section renders only
inside the `status === 'ready'` map (`Today.tsx:289-306`); a queue error hides
a loaded section.

**L7 (low) - stale after an SSE reconnect or across midnight.** No `onOpen`
reload (`useTodayPastTours.ts:139-148`); missed events are not replayed and
today's scheduled tours do not become Past rows at midnight. useToday has the
same gap.

**L8 (low) - the new e2e spec has no failure-path cleanup.** The `decide` loop
runs only at the end (`today-past-tours.spec.ts:141-146`); a mid-test failure
leaves up to 8 undecided tours for the next spec. Suggested: track ids at
describe scope, decide in afterEach/afterAll.

**L9 (low, inherited) - the 90-day range read is single-page.**
`listByScheduledRange` has no LastEvaluatedKey loop (`toursRepo.ts:347-364`),
ascending, so the most recent tours drop past ~1 MB. Pre-existing on the Past
tab; now on the landing page.

**L10 (low) - the back arrow differs by which Today row opened the tour.**
Server "Tours today" rows link to `/tours/:id` with no state ("Back to
tours"); the new rows say "Back to Today" (`Today.tsx:51`,
`TourDetail.tsx:104`).

**L11 (low, informational) - lane pollution now shows on Today.** Earlier specs
leave past tours that appear on Today later: `tour-no-show-checkin.spec.ts:91-94`
(a tour 26h ago never decided), `listing-activity.spec.ts:237` (hardcoded
2026-10-01, a Not marked row from 2026-10-02), `tours-page.spec.ts:398-403` (a
tomorrow tour marked toured -> off-range Needs outcome). Swept Today role-name
queries (Open, Tour, Past, Today, Tasha, heading/list names): no current
collision; `expectTodayReady` is exact-match. A future "All caught up" or
unscoped Today link assertion would depend on lane history.

Checked and clean: the date-helper move (ToursPage uses all three; no other
callers); BACK_TARGETS (only Today and the Past tab set state.back); the
?outcome=1 strip keeps router state; added lines ASCII; useEventStream shares
one EventSource.

## PLAUSIBLE (not verified)

**P1 (low-medium) - perf readiness may time out** when the queue is empty but
past tours exist (no TODAY_TERMINAL alternative matches); in-flight section
GETs during a NAV_TODAY navigation may be attributed to the destination.

**P2 (low) - rows may clip at mid-width.** In the 561-700px container band,
`.when` (nowrap, ~150px) + `.tag` + a non-shrinking `.who` can clip long names
and hide the property (`Today.module.css:120-126,176-181`); the e2e checks only
360px.
