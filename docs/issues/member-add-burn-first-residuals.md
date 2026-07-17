---
id: member-add-burn-first-residuals
title: Member-add burn-first ordering has two benign residuals (false 409 on racing identical adds; crash window can wedge one phone for one group)
type: debt
severity: low
area: app
created: 2026-07-17
refs: app/src/routes/relayGroups.ts:280
---

## What

Fix-wave-2 W1 made member-add burn the phone on the group's pool number
BEFORE mutating the roster (with `ever_member_phones` provenance for
re-adds). The burn and the roster write hit two different tables, so the
pair is deliberately NOT atomic; the chosen ordering fails CONSERVATIVE
(a crash can leave a phone burned-but-unrostered, which blocks reuse but
can never mis-route or leak). Two residuals follow, both verified benign
by the wave-2 re-verify reviewer:

1. Two truly-concurrent IDENTICAL adds (double-click): both pass the
   participant dedupe and the provenance short-circuit, both race
   burnClaim; the loser receives a false `phone_conflict_on_number` 409
   even though the member IS being added to this very group by the winner.
   Net state is correct (member added once); only the loser's error copy
   is wrong, and the dialog does not refetch on this code.
2. A crash in the sub-ms window between the burn and the roster write
   leaves the phone burned on the number but absent from BOTH participants
   and `ever_member_phones` - re-adding that phone to that group then 409s
   forever. Staff remedy: start a new group text with that person (fresh
   number). No data corruption, no routing impact.

## Fix direction (if it ever bites)

(1) On burnClaim refusal, re-read the group and return success/no-op when
the phone is by-then a participant or in `ever_member_phones` (turns the
racing loser into an idempotent win). (2) The wedge case could self-heal
the same way if the refusal handler also consulted the pool record's
burn provenance - or simply document the new-group remedy (current state).
