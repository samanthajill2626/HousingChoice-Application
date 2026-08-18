---
id: standalone-relay-group-no-reachable-floor
title: POST /api/relay-groups has no two-reachable-members floor, so the contact file can mint a half-roster group
type: bug
severity: med
status: open
area: app/relay
created: 2026-08-17
refs: app/src/routes/relayGroups.ts:301-354, app/src/services/relayProvisioning.ts:69, app/src/lib/rosterResolution.ts:393, app/src/lib/rosterResolution.ts:596, app/src/services/rosterProvision.ts:218, app/src/services/rosterEdits.ts:495-531
---

**Problem.** Every OWNER path enforces a floor before a relay group may exist:
`canOpenGroup` is a first-class field meaning ">= 2 reachable members on DISTINCT
numbers, and no thread yet" (`rosterResolution.ts:393`, computed at `:596` off
the phone set built while each member's reachability is decided). The tour and
placement paths refuse below it with a named reason
(`rosterProvision.ts:218,247` - "this tour roster has fewer than two reachable
members"), and the tour UI disables the open and prints it
(`e2e/support/selectors.md`: "The relay group was not opened - two reachable
members are needed.").

`POST /api/relay-groups` has no such floor. It rejects an empty array and
de-dupes by phone (`relayGroups.ts:304-321`), then hands the list straight to
`provisionRelayGroup` (`relayProvisioning.ts:69`), which buys/claims a pool
number and opens the thread. Reachability is never consulted:
`buildStandaloneOpenPreview` computes it per member and returns a count
(`rosterEdits.ts:495-531`) and nothing refuses on it. Before this feature the
route described itself as "the test scaffold; the product path is POST
/api/placements/:placementId/relay" (`relayGroups.ts:322-326`); the
contact-file create promotes the scaffold to a product path without carrying the
product path's invariant with it.

The dashboard cannot cover for it: `CreateRelayGroupModal`'s `canCreate` is a row
count (`added.length >= 1`), which is honest - the client does not know who is
opted out. So the floor has to be the server's.

**Reproduced** (re-review, client-side against a server answering one reachable +
one opted-out leg): the confirm dialog is entirely HONEST - it lists "Marcus
Bell - not receiving - opted out" and says "1 recipient will receive this." -
and then lets the operator open the group anyway. A pool number is taken for a
masked thread whose only reachable member is the contact the page was started
from, who can now text a number whose fan-out reaches nobody.

**Suggested fix.** Server first, in one change:

1. Return a `canOpen`-equivalent (distinct reachable phones >= 2) from
   `buildStandaloneOpenPreview` - it already has the inputs.
2. Refuse in `POST /api/relay-groups` with a typed error the dashboard can map,
   in the same shape as the existing create refusals.
3. Disable the confirm on the preview's new field, with the owner path's reason
   copy ("two reachable members are needed").

**Deliberately NOT done on `feat/contact-create-relay-group`.** The spec for that
feature (6.3) pins `POST /api/relay-groups` unchanged, and adding a refusal to a
live create route is a contract change for its other callers (the test scaffold
usage, and anything that posts directly to a first-class authenticated API). It
is filed here for a human to sequence rather than smuggled into a UI branch.
