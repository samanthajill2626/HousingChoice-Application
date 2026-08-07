---
id: relay-add-double-announce-race
title: Racing adds of the same member can announce "X joined" twice (stale wasMember snapshot)
type: bug
severity: low
status: open
area: app
created: 2026-08-06
refs: app/src/services/relayMembers.ts:167
---

**Problem.** `addMemberToRelay` computes `wasMember` from a PRE-READ snapshot
of the conversation while the underlying `addMember` write is idempotent
under optimistic concurrency. Two adds of the same member racing each other -
now concretely reachable as an operator force-add racing the quiet-hours
poller tick, since the deferral engine added a second automated writer - can
BOTH observe `wasMember: false`, so both enqueue `RELAY_MEMBER_ADDED_JOB` and
both record an `added_to_group_text` milestone: the group receives "X joined"
twice and the timeline shows the join twice. Pre-existing shape (the stale
read predates contact-rosters); the new automated writer raises its
probability from "two operators double-click" to "any deferred add applied
near a manual one". Found by the contact-rosters planner review (P5),
adjudicated FILE - restructuring relayMembers this late was declined.

**Suggested fix.** Derive `changed` from the MUTATE result rather than the
stale read - e.g. have `conversations.addMember` return whether the phone was
actually appended (or compare the returned participants against the input),
and enqueue the announcement + milestone only when the write itself reports a
change. That makes the announcement exactly-once per membership transition
regardless of who races whom.
