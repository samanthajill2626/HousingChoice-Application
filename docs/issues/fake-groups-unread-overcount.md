---
id: fake-groups-unread-overcount
title: "Fake phones: group unread badge counts fan-out LEGS, not transcript entries"
type: improvement
severity: low
status: resolved
area: fake-twilio
created: 2026-07-07
resolved: 2026-08-24
refs: fake-twilio/web/src/state/useFakePhones.ts:107, fake-twilio/src/engine/engine.ts:307
---

**Resolution (2026-08-24, `fix/test-suite-wave3`).** Took the suggested fix:
`mergeEvent` now bumps unread by the number of NEW transcript-entry ids in the
incoming snapshot (diffed against the held one), never by `lastActivityAt`
advancing. Fan-out legs that collapse into one entry count once; delivery-slot
ticks count zero; a first-seen group counts the entries it arrives with (all
genuinely unseen - and an empty first snapshot now counts 0 where the old rule
counted 1).

Probed against the OLD rule: the new burst-collapse test fails `expected 2 to
be 1` - the filed symptom verbatim - and the empty-first-snapshot test fails
`expected 1 to be +0`. Restored, 25/25 in the file, 111/111 across the web
workspace.

The noted accepted corner (a removed member lingering until the next outbound
burst) is unchanged - it was a bound on roster staleness, not on unread.


**Problem (review finding, 2026-07-07 — cosmetic).** Every fan-out leg calls
`observeOutboundLeg`, which advances the group's `lastActivityAt` and emits one
`group.updated`. The web's `mergeEvent` bumps `groupUnreadByPool` whenever
`lastActivityAt` advanced and the group isn't selected — so an N-member burst
that correctly COLLAPSES into one transcript entry (identical body: exactly
what `relay.intro` and team replies send) bumps the unread badge **N times**.
One team reply to a 2-member group shows unread "2"; an 8-member group would
show "8". Status-callback ticks are correctly suppressed (they don't advance
`lastActivityAt`); only the append path over-counts. Initial page load is
unaffected (`refresh` doesn't touch unread).

**Suggested fix.** Bump unread on a NEW transcript-entry id (diff the incoming
snapshot's entries against the held one — `group.updated` carries the whole
snapshot), not on `lastActivityAt` advancing. Related accepted corner (noting,
not fixing): a removed member lingers past the spec's "one message" bound when
subsequent replies produce no fan-out burst (e.g. a group shrunk to one member)
— staleness is really bounded by the next OUTBOUND BURST; a team reply clears
it.
