---
id: tour-relay-open-vs-auto-close-race
title: A relay group opened in the same instant a tour auto-closes can land on the closed tour (the open checks status on a read; claimGroupThread has no status condition)
type: debt
severity: low
status: open
area: app/tours
created: 2026-10-04
refs: app/src/services/rosterProvision.ts:150, app/src/services/rosterProvision.ts:335, app/src/repos/toursRepo.ts:502, app/src/routes/tours.ts:1552, app/src/routes/tours.ts:883, app/src/jobs/rosterActions.ts:144, app/src/repos/toursRepo.ts:685, app/src/routes/placements.ts:716, app/src/repos/toursRepo.ts:546
---

**Problem.** Deferred by the tour auto-close design (spec
`docs/superpowers/specs/2026-10-01-tour-auto-close-reopen-design.md`, section
6.6). Every way to open a tour's relay group checks the tour's status on a
READ, and the write that claims the group slot does not check it again:

- `tourOpenGuard` (`app/src/services/rosterProvision.ts:150-164`) refuses a
  `canceled` or `closed` tour (409 `tour_not_active`) - judged on the tour
  object it is handed;
- `openTourGroup` (`rosterProvision.ts:294`) re-applies that guard to the same
  object (:303), then claims the slot with `claimGroupThread(tourId,
  'provisioning:<tourId>')` (:335), whose condition is only
  `attribute_exists(tourId) AND attribute_not_exists(#gt)`
  (`app/src/repos/toursRepo.ts:502`) - one thread per tour, no status term.

Three paths reach `openTourGroup`, each on its own read of the tour:

1. `POST /api/tours/:tourId/relay`, the immediate open
   (`app/src/routes/tours.ts:1552`): an eventually consistent `tours.get`
   (:1558), the guard (:1567), the open (:1652).
2. apply-now, `POST /api/tours/:tourId/roster/pending/:actionId/apply-now`
   (`routes/tours.ts:883`): `applyTourRosterAction`
   (`app/src/jobs/rosterActions.ts:589`) -> `loadTourOwner` (:144; the read
   :148, its closed check :171) -> `openTourGroup` (:156).
3. The worker's roster-action poll (`startPoll('roster action', ...)`,
   `app/src/worker.ts:436` -> `runDuePendingRosterActions`,
   `jobs/rosterActions.ts:616`) and its hermetic dev tick `POST
   /__dev/roster-actions/tick` (`app/src/routes/dev.ts:545`): the same
   `applyTourRosterAction`, for a quiet-hours open a person confirmed, applied
   at quiet-end.

The sweep's close (`toursRepo.autoCloseIf`, `toursRepo.ts:685`) does not look
at `groupThreadId` either. So when the sweep closes a tour (two weeks past its
clock start, no outcome) inside the window between an open's read and its
pointer write, both writes win: the group is provisioned (a pool number
assigned, its intro queued to the members) and `groupThreadId` lands on a tour
that is already closed. The close armed no relay close-nag - the slot was
empty, or held the `provisioning:` sentinel, which names no conversation - so
the new group stays open with nothing on Today prompting anyone to close it.
Reopening the tour brings it back with the group attached.

Same class as two staff racing today (a relay open racing a staff Cancel or
"Not a fit" close has the same shape). Rare here: the open has to coincide
with the sweep's 15-minute tick on a tour that is two weeks past its clock
start with no outcome. Hence low.

**Suggested fix.** A status condition on the claim: `claimGroupThread` adds
`AND #st <> :canceled AND #st <> :closed` (the `tourOpenGuard` rule), and on a
condition failure the open re-reads consistently to tell
`relay_already_provisioned` (a pointer exists) from `tour_not_active` (the tour
died) - the way PATCH tells 404 from `tour_changed`. That closes the
read-to-claim window. A shorter claim-to-pointer window (provisioning, seconds)
would remain, where a close still wins; closing it too needs the sweep to skip
a tour whose slot holds a `provisioning:` sentinel (`autoCloseIf` gains
`(attribute_not_exists(#gt) OR NOT begins_with(#gt, :prov))`; the tour is
re-checked on the next run).

**Related: reopen racing a conversion (ruling F2 of the same review,
deferred here).** It needs a closed, unconverted tour that still carries
`convertible: true` and an outcome - a state only the API creates (PATCH `{
outcome: 'move_forward', moveForward: true, status: 'closed' }` on a toured
tour; no dashboard path does). The conversion (`POST
/api/placements/from-tour`, `app/src/routes/placements.ts:644`) gates on an
eventually consistent read of `convertible === true` (:656, :661), then claims
with `claimConversion` (:716), whose condition is only `attribute_exists(tourId)
AND attribute_not_exists(#cp)` (`app/src/repos/toursRepo.ts:546`) - no status
and no `convertible` term. A reopen (`reopenIf`: status back to toured,
`outcome` / `moveForward` / `convertible` removed) that lands between that read
and that claim is silently overridden: the claim wins, the placement is
created, and the finalize (`placements.ts:771-775`) closes the tour again as
converted. The end state is coherent - a closed tour converted into a real
placement, which is what the conversion asked for - but the reopen the
operator saw succeed is undone without a word, and the converted tour carries
no outcome. The other order is safe: `reopenIf` requires
`attribute_not_exists(convertedPlacementId)`, so a reopen after the claim
answers 409. Same class as today's PATCH `{ moveForward: false }` racing a
conversion. Suggested fix: `AND #cv = :true` on `claimConversion`'s condition,
so a conversion whose `convertible` was removed after its read loses the claim
(409 `tour_already_converted` today; a consistent re-read could answer
`tour_not_convertible` instead).
