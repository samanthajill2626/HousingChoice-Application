---
id: placement-relay-no-atomic-claim
title: Placement relay provisioning has no atomic claim and links its thread best-effort
type: bug
severity: med
status: open
area: app
created: 2026-08-05
refs: app/src/routes/placements.ts:1049, app/src/routes/tours.ts:861
---

**Problem.** `POST /api/placements/:placementId/relay` guards one-thread-per-
placement with a plain READ (`item.group_thread` -> load -> refuse 409 when the
conversation is open or connecting) and never claims the slot. Two overlapping
POSTs can both pass that check-then-act guard, both buy a pool number, and
orphan the first thread. The tours route solved exactly this with an atomic
claim (`tours.claimGroupThread(tourId, "provisioning:<tourId>")`, conditional on
`attribute_not_exists(groupThreadId)`, released on failure); the placement route
never got the same treatment.

The second half of the same gap: after provisioning succeeds, the
placement -> thread link write is BEST-EFFORT - a failure is logged and
swallowed, and the route still returns 201:

```
try {
  updatedPlacement = await placements.update(placementId, { group_thread: conversation.conversationId });
} catch (err) {
  log.error({ ... }, 'placement relay: linking group_thread failed - relay created');
}
```

So a crash or a throw there leaves a live relay group with no pointer on the
placement. The conversation's own `placementId` back-reference still resolves
it, but nothing on the placement side does.

Pre-existing, and OUT OF SCOPE for the contact-rosters mission - recorded here
because rosters made the failure mode worth naming. With rosters, consumption of
the plan is gated on that link write SUCCEEDING, so a link failure correctly
leaves the plan in place: the placement has no pointer, the resolver is still in
plan mode, and dropping the plan would strand the operator's roster. A crash
BETWEEN the pointer write and the plan delete leaves a stale plan that is INERT
by precedence (participants win whenever the pointer is set, spec D1) - that
leftover is not a bug and must never be defensively merged back in.

**Suggested fix.** Mirror the tours route: add `claimGroupThread` /
`releaseGroupThreadClaim` equivalents to `placementsRepo` (conditional on
`attribute_not_exists(group_thread)`), claim BEFORE `provisionRelayGroup`,
release on failure, and stamp the real conversation id over the sentinel on
success. That makes the pointer write part of the claim rather than a
best-effort tail, and the 409 for the race loser lands before any number is
bought. Do NOT redesign the resolution/consumption flow around it - only the
claim.
