---
id: tour-reopen-edge-states
title: Tour reopen edge states - a decided tour that left toured reopens as toured, a PATCH revival keeps its cancel's close-nag, and reopenIf has no ABA guard
type: debt
severity: low
status: open
area: app/tours
created: 2026-10-04
refs: app/src/lib/toursModel.ts:253, dashboard/src/routes/tours/tourReopen.ts:12, app/src/routes/tours.ts:1051, app/src/routes/tours.ts:1124, app/src/routes/tours.ts:1134, app/src/services/relayCloseNag.ts:84, app/src/routes/tours.ts:1459, app/src/routes/tours.ts:1517, app/src/routes/relayGroups.ts:687, app/src/routes/relayGroups.ts:772, app/src/routes/today.ts:1001, app/src/repos/toursRepo.ts:785, app/src/routes/tours.ts:1504
---

**Reopen treats a recorded decision as proof of a visit (AD-5, low).** Filed
by the tour auto-close code review, round 1
(`docs/superpowers/reviews/2026-10-01-tour-auto-close/code-review/adversarial-r1.md`,
AD-5, AD-7 and AD-8; rulings in `adjudications-r1.md` beside it).
`reopenTargetFor` sends any closed tour that carries `not_a_fit` or
`move_forward` and no `autoClosedFrom` back to `toured`
(`app/src/lib/toursModel.ts:253-258`; the dashboard mirror
`dashboard/src/routes/tours/tourReopen.ts:12-20`), assuming a person-decided
tour was toured when it closed. PATCH does not enforce that: the exit gate
needs `toured` to SET an outcome (`app/src/routes/tours.ts:1124-1127`), but
nothing clears `outcome` / `moveForward` / `convertible` on a later status
move (the patch build, `routes/tours.ts:1134-1166`), and the transition guards
(`routes/tours.ts:1051-1106`) allow `toured -> no_show`, `toured -> canceled`
and a later move to `closed`. So through the API a decided tour can leave
`toured` and then close, and reopen marks as toured a visit that did not
happen. No dashboard path produces it (Cancel and Mark no-show are not offered
on a toured tour, `dashboard/src/routes/tours/TourDetail.tsx:110`, `:318`),
hence low. Suggested fix: refuse the reopen (409 `tour_reopen_unsupported`)
unless the outcome was recorded on the transition into `closed`, or clear
`outcome`, `moveForward` and `convertible` when PATCH moves a tour out of
`toured`.

**A PATCH revival keeps the close-nag its cancel armed (AD-7, pre-existing).**
Reopen is the only TOUR event that clears a group's pending relay close-nag
(`clearRelayCloseNagOnReopen`, `app/src/services/relayCloseNag.ts:84-113`, its
one caller `app/src/routes/tours.ts:1517`), because a live tour's group must
not prompt "close it?". (On the group itself, closing it clears the nag,
`app/src/routes/relayGroups.ts:687`, and the "Keep open" defer pushes it out
28 days, `:772`.) A cancel arms the same nag on the tour's open relay
group (`routes/tours.ts:1459-1464`), and a canceled tour revived by PATCH
(`{ status: 'scheduled' }`, or a new time that auto-advances it,
`routes/tours.ts:1143-1149`) never clears it, so 28 days after the cancel the
revived tour's group still surfaces on Today's relay groups to close (the due
filter does not look at the owner, `app/src/routes/today.ts:1001-1004`). The
asymmetry predates auto-close: the feature added the first tour-event clear,
not the arm.
Suggested fix: clear on revival with the same owner rule (only a standalone
group or the tour's own), when a PATCH moves a tour from `canceled` back to
`scheduled`.

**reopenIf has no ABA guard (AD-8, note).** `reopenIf` conditions on `closed`,
no conversion claim, and the `outcome` and `autoClosedFrom` the caller read
(`app/src/repos/toursRepo.ts:785-797`). Reopen A reads a closed `not_a_fit`
tour (`routes/tours.ts:1494`); reopen B lands, a person records `not_a_fit`
again and closes the tour; A's stale write (`routes/tours.ts:1504`) still
matches every term and reopens a tour that was just decided. It needs a stale
reopen request to outlive a complete reopen, decide and close cycle, so it is
not a real-time case. Suggested fix: also condition on the read's
`lastMarkedAt` (string or absent, like the other terms) - every reopen stamps
it (`toursRepo.ts:803`), so a request that slept through a reopen loses;
`updatedAt` equality would work too.
