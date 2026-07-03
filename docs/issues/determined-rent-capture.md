---
id: determined-rent-capture
title: Capture the authority's determined rent at determine_rent (distinct from final_rent)
type: improvement
severity: med
status: open
area: app
created: 2026-07-03
refs: app/src/repos/placementsRepo.ts:126, app/src/services/statusTransition.ts:339
---

**Problem.** The diagram stamps `Determine rent → Awaiting rent acceptance` on the Team
recording the authority's determined rent amount — the amount the landlord then accepts.
Live audit confirmed **no capture today**: sending `rentDetermined` on that transition is
silently ignored (HTTP 200, no persist). This is **distinct from `final_rent`**, which is
the ACCEPTED amount already written onto the unit on the rent-acceptance exit
(`statusTransition.ts:339`, live-confirmed writing 1875). The landlord needs a recorded
determined amount to accept.

**Suggested fix.** First-class `rent_determined?: number` (finite > 0) on `PlacementItem`,
captured via the transition input + a money gate modal on the `determine_rent` exit
(mirroring the `finalRent` mode). Built by Approval & Move-in Tasks 2/3/4/7/8. See
[[approval-move-in-audit]].
