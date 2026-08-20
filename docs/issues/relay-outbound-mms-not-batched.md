---
id: relay-outbound-mms-not-batched
title: A relay-group send with too many photos is refused instead of split across messages
type: improvement
severity: med
status: open
area: app
created: 2026-08-20
refs: app/src/routes/api.ts, app/src/lib/mmsBatching.ts, app/src/jobs/relayFanOut.ts
---

**Problem.** The 1:1 send path splits an over-budget set of attachments across
several carrier-sized messages (`planMmsBatches`, added 2026-08-20 for
[[outbound-mms-stalls-at-sent-with-no-receipt]]). The relay-group path does not.
It gets a guard instead: a relay send whose attachments will not fit ONE message
is refused with `attachments_too_large`.

Refusing is the right failure - the alternative is handing the carrier a message
it discards with no receipt, which is the bug that started this. But it IS a
behavior change. The per-message budget dropped from 5 MB to 1 MB in the same
change, so a photo drop that used to be accepted into a placement or tour group
(and then silently lost) is now visibly rejected. The founder sends 7-9 photos at
a time, so this will be hit.

**Why it was not batched with the 1:1 path.** A relay send is not one message -
it is a hub message plus a fan-out job that re-presigns per leg, seeds a
`delivery_recipients` map per member, and has a separate `queued_pending` path
for a connecting group. Splitting it means a hub message AND a fan-out per batch,
plus deciding how the per-batch delivery rollup presents as one send in the
timeline. `sendRelayTeamMessage` also writes its own HTTP response today, so it
would need to return an outcome before it could be looped.

**Suggested fix.** Refactor `sendRelayTeamMessage` to return an outcome rather
than write the response, then loop it over `planMmsBatches` the way the 1:1 path
does - body on the first batch only. Decide deliberately whether the batches
present as one logical send or several in the group timeline.
