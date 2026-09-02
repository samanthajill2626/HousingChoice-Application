---
id: rail-adopt-path-binding-propagation
title: An ADOPTED group rail faces the same Twilio binding-propagation window and is deliberately excluded from the re-read ladder
type: improvement
severity: low
status: open
area: app
created: 2026-09-01
refs: app/src/services/groupRail.ts:513, app/src/services/groupRail.ts:552, app/src/services/groupRail.ts:583, app/src/services/groupRail.ts:637
---

**Problem.** `feat/retry-counter-durable` added a bounded re-read ladder so a
freshly CREATED rail whose Twilio messaging bindings have not propagated yet is
not mistaken for a rail that is short of its roster
([`rail-binding-propagation-retry`](./rail-binding-propagation-retry.md), spec
D13-D14). Both ladder points are gated on `!wasAdopted`
(`groupRail.ts:583` and `:637`), so an ADOPTED rail ladders on NEITHER read.

That exclusion is a deliberate decision (spec D17), not an oversight - but the
window it declines to cover is real. `ensureGroupRail` adopts an existing
Conversation by UniqueName (`groupRail.ts:513`) and then reads its participants
(`:552`). If that adoptee is itself seconds old - another process created it and
crashed, or two workers raced the same thread - its bindings are provisioning
exactly as a self-created rail's would be, and the same short read drives the
same repair round-trip and the same false `rail_failed`.

**Why it was excluded.** For an adopted rail the read-back is the ONLY source of
roster truth. On the create path the ladder is bounded by a fact the code
already knows - this rail was created in THIS call, moments ago, so a short list
is more likely propagation than damage. An adopted rail carries no such fact:
it may be seconds old or months old, and a ladder that waits on every adopt
would add latency to the overwhelmingly common case where the rail is simply
missing a member who really was never added. Widening the change there deserves
its own evidence rather than riding on the create path's.

**What a fix needs before it is worth making.**

1. **Evidence that the adopt window is actually hit.** The 2026-08-13 migration
   evidence (81 incomplete-roster warnings, 178 refusals, 2 false `rail_failed`)
   is all CREATE-path. Nobody has shown an adopt-path instance. A log query for
   `group_rail_participants_incomplete` on a call that adopted, correlated
   against the adoptee's `dateCreated`, would settle it.
2. **An age signal.** The obvious gate is "ladder only when the adoptee is
   younger than N seconds", which needs the Conversation's own creation
   timestamp to be carried on the adapter's ref (it is not today) - a port
   change, not a service change.
3. **A latency budget.** The ladder is bounded per POINT, not per call: both
   points can fire, so an adopt that laddered would add up to +4s and 4 Twilio
   reads to a path reached from a staff HTTP request in some callers.

Until those exist, the exclusion stands and this file records the exposure so
the next reader does not have to re-derive that it was a choice.
