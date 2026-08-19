---
id: relay-single-live-conversation-per-pair
title: Should a pair of people ever have more than one live relay conversation at a time
type: decision
severity: low
status: open
area: app
created: 2026-08-18
refs: app/src/services/relayGroupDuplicates.ts:109, docs/superpowers/specs/2026-08-17-duplicate-relay-group-warning-design.md
---

**Problem.** The duplicate-relay-group warning tells an operator that the people
they are about to group already have a live relay group, and then lets them
create a second one anyway. That is the right behavior for a warning, but it
sidesteps the larger product question it exposes: should a given set of people
ever have two live relay conversations at all?

From a tenant's or landlord's side the CONVERSATION is the item, not the tour or
the placement it was opened from. They are talking to a person, and it does not
matter what about. If that framing is right, then the eventual correct behavior
is not "warn about the second group" but "route the new context INTO the
existing group" - the operator picks the existing thread, the new tour or
placement is attached to it, and no second masked number is ever handed out.

The warning is deliberately the smaller change. It costs nothing to reverse and
it buys the evidence for this decision: if operators routinely click through the
warning, they need two threads and the answer is no. If they routinely back out
and go find the existing group, they wanted routing and did it by hand.

**Suggested fix.** Not built, deliberately. Deciding this needs a product call
first, and then it is a substantially larger change than the warning: relay
groups would need to carry more than one owner, the tour and placement roster
paths would need an "attach to existing thread" branch, and the activity/audit
model would have to explain a thread that belongs to two things at once. Revisit
once there is real usage data behind the warning.
