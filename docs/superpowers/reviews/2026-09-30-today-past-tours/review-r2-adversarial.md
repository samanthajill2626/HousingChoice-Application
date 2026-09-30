# Adversarial re-review (round 2) - feat/today-past-tours @d955c00f

Same reviewer as round 1, continued, under the RE-REVIEW CHARGE (what did we
all miss; the fixes are new code; contest the rejections). Read-only, ran
nothing. Findings as returned; rulings in `adjudications-r2.md`.

Totals: blocking 0, high 0, medium 0, low-medium 1, low 5 new (confirmed),
2 plausible. Concedes all three round-1 rejections (M1, L4, L6).

## New findings - CONFIRMED

**N1 (low-medium) - the section lands late and pushes "AI suggestions to
review" down under the pointer.** `PastToursSection` renders nothing while
idle (`Today.tsx:216-217`) and sits just above AI suggestions
(`Today.tsx:306`). The queue needs one round trip; the section three stages
(tour reads, contacts, units). A click aimed at an AI suggestion can land on a
past-tour row (a Needs-outcome row opens Record outcome). The settling
spinner covers only an empty queue. Suggested: reserve the space with a
heading + fixed-height skeleton while idle when other content shows.

**N2 (low) - the new perf background declaration makes four common shapes
background refresh on EVERY surface.** `BACKGROUND_SHAPES` is global
(`collect.ts:93-95`) and `#roleFor` ignores the surface (`collect.ts:404-406`),
so after load an exact repeat of `/api/tours?from&to`, `/api/tours?status`,
`/api/contacts/:contactId` or `/api/units/:unitId` becomes
`background_refresh` on `/contacts/:contactId`, `/listings/:unitId`,
`/tours`, `/tours/:tourId`, `/placements/:placementId` - leaving
`apiRequestCount` and the readiness quiet window (`collect.ts:447-456`). A
post-load refetch regression on those pages would vanish from perf numbers.
It buys nothing: perf samples block writes, so no tour.updated fires while
sampling; and the ledger is "deliberately ... not a permissive endpoint list"
(`collect.ts:56-59`). Suggested: scope declarations to a surface, or drop this
one with a note.

**N3 (low) - tour.updated now refetches the whole queue, unfiltered, and some
emitters are background jobs.** `useToday.ts:152` refetches /api/today (whose
contact hydration fans out, `docs/issues/today-contact-hydration-fan-out.md`)
on every tour.updated, on top of the section reload (2 list reads + up to 10
point reads; the name caches live per call, `useTodayPastTours.ts:65,88`).
`rosterActions.ts:159-162` emits from a worker, bridged across processes
(`events.ts:309-321`), so "one small burst per human action" does not hold:
a morning batch of deferred roster applies seconds apart costs every open
Today tab the full refetch per tour. Suggested: filter useToday's refetch to
listed tourIds or status scheduled; keep the name cache in a ref.

**N4 (low) - the L10 fix is incomplete.** The relay close-nag "Open" link to
`/tours/:ownerId` (`nagOpenHref`, `Today.tsx:~101`) carries no router state,
so its back arrow still says "Back to tours". Suggested: pass BACK_TO_TODAY
when `ownerType === 'tour'`.

**N5 (low) - the afterEach cleanup has a leak window.** The first three ids
join the cleanup list only after both PATCHes succeed
(`today-past-tours.spec.ts:104`); a failed PATCH leaves all three undecided
for the next spec. Suggested: add each id right after its createTour.

**N6 (low) - Today ignores `reloadFailed`.** `useTodayPastTours.ts:114` takes
only status, past, reload; after a failed live reload the old rows stay with
no sign (a decided tour keeps reading "Needs outcome"), where the Past tab
shows a notice (`ToursPage.tsx:489-493`). Suggested: surface a one-line
"could not refresh" note.

## The fixes, reviewed as new code

L1 correct (real test, `useToday.test.tsx:168-178`; cost is N3). L2 correct
and no longer vacuous (separate acts, releases the Date pin per
`src/test/setup.ts:27-29`). L3 correct (deps `[pastStatus, eligible,
pastCount]`; the Past tab lists every `past` row, `ToursPage.tsx:544-556`;
e2e asserts 3, 7, and 7 Past rows). L5 correct (both branches tested; see
P-b). L8 sound apart from N5. L10 correct for queue rows; gap is N4. M2/P1
consistent; citations checked against the files (`useTodayPastTours.ts:54`,
`:136-151`, `useToday.ts:126-153`, `Today.tsx:35-47,220-250,267-280`); side
effect is N2. P2 CSS correct by reading (specificities, source order, the 560
and 760 blocks do not conflict; the 880px check is non-vacuous).

## Round-1 rejections contested

M1 CONCEDE (not a fit closes the tour, `TourDetail.tsx:537-541`, conversion
closes it too; the per-event cost point returns as N3). L4 CONCEDE (product
ruling; off-range last is the Past tab's rule). L6 CONCEDE.

## PLAUSIBLE (not verified)

**P-a (low) - the 880px check assumes an expanded sidebar.** A collapsed rail
(`AppFrame.module.css:46-48`) would leave a ~768px pane, above 760, and the
check would quietly test the one-line layout. Suggested: assert the pane
width or the sidebar state.

**P-b (low) - the settling spinner can spin forever on an empty queue.** The
client `request` helper has no timeout (`dashboard/src/api/client.ts:146`);
one stalled getContact/getUnit in `labelRows` leaves an otherwise empty Today
spinning. Suggested: a per-lookup timeout falling back to raw ids.
