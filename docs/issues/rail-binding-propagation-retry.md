---
id: rail-binding-propagation-retry
title: Fresh group rails read back as roster-incomplete before Twilio bindings propagate
type: improvement
severity: low
status: open
area: app
created: 2026-08-13
updated: 2026-09-01
refs: app/src/services/groupRail.ts:334, app/src/services/groupRail.ts:585, app/src/services/groupRail.ts:638, app/src/services/groupSend.ts:381, app/src/services/groupSend.ts:425, app/src/adapters/groupConversations.ts:563
---

**Problem.** ensureGroupRail validates a freshly created rail by reading its
participants back immediately, but Twilio populates each participant's
messaging binding ASYNCHRONOUSLY. Seconds-old rails therefore read back as
"short of the roster", which triggers the repair path on nearly every create:
the 2026-08-13 dev migration of 132 imported group threads logged 81
group_rail_participants_incomplete warnings, 178 group_rail_participant_add_failed
refusals (Twilio 50386/50437 "participant already exists" - the members were
there all along, their bindings were still provisioning), and 2 rails recorded
rail_failed with "rail participants do not cover the roster" even though a
direct API read minutes later showed both rails active with every member bound.
The convergent re-run healed both, so the cost is operator alarm (a wall of
level-40 warnings plus false failures on a step whose report is the cutover
gate) and one wasted repair round-trip per rail, not data damage.

**Suggested fix.** Treat a fresh create's incomplete read-back as propagation,
not damage: before entering the repair path for a rail created in this same
call, re-read participants after a short delay (one or two bounded retries).
Only members still unbound after that are worth a repair attempt, and only
members refused by the repair are worth a rail_failed. Per-member "already
exists" refusals (50386/50437) during repair should be treated as success
pending re-read rather than logged as refusals.

**Partial resolution (2026-09-01) - STATUS STAYS `open`.** The ladder shipped on
`feat/retry-counter-durable` (design
`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`, D13-D18)
for THREE of the five callers. The defect remains live on the other two, so this
file is not closed.

What shipped. `app/src/services/groupRail.ts:334` (`reReadUntilBound`) re-reads
participants after `[500, 1500]`ms, stopping as soon as nothing is missing, and
returns the new list; the handler reassigns `participants`, `participantMap` and
`missing` together. It is wired at BOTH reads that can conclude damage - the
post-create validation read (`:585`) and the post-repair read (`:638`) - because
the two false `rail_failed` records in the 2026-08-13 migration were written
after the POST-REPAIR read, so laddering only the first would have left the
headline symptom reachable. Point 1 sits in no pre-existing try, so it ships
with its own catch: a throwing re-read must not escape and strand the
`rail_creating` claim.

Opted in EXPLICITLY, per caller, never inferred: `app/src/jobs/groupRail.ts:65`,
`app/src/lib/import/convertGroups.ts:436` (where the harm occurred), and
`app/scripts/rail-verify.ts:206`.

**The authority model is unchanged.** The re-read is still the only source of
completeness and nothing is derived from the create's per-member failures - an
add can succeed and still leave a shape Twilio will not bind. This fixes a
TIMING false alarm and nothing else.

**Deliberately still live - `services/groupSend.ts:381` (the inline send-time
backstop) and `:425` (`healRail`).** Both are reached from a staff HTTP request,
and every variant that laddered them either leaked the `rail_creating` claim or
required editing fenced `repos/conversationsRepo.ts`. They build today's
two-field request and behave exactly as they did before.

**Excluded, filed separately.** The ADOPT path faces the same propagation window
and is excluded (its read-back is the only source of roster truth) -
[`rail-adopt-path-binding-propagation`](./rail-adopt-path-binding-propagation.md).
No 50386/50437 handling was added: repair failures are already collected and
discarded, so handling them would change no behavior, and the refusal LOG LINES
come from a file this branch does not edit -
[`rail-repair-refusal-log-noise`](./rail-repair-refusal-log-noise.md).

**`rail-verify.ts`'s opt-in is largely INERT, by design.** That script iterates
only threads that already carry a `twilio_conversation_sid`, so each one either
short-circuits on the fast path with no Twilio call or is ADOPTED - and an
adopted rail ladders on neither read. The only path that reaches
`wasAdopted === false` there is the dead-adoptee delete-and-recreate branch,
which is also the only case where its rail is seconds old. It keeps the flag
because that one path is exactly the one that needs it.

**Cost.** The ladder is bounded per POINT, not per CALL: both points can fire in
one call, so a rail whose bindings never propagate spends up to +4s of wall
clock and 4 extra Twilio reads. On the 2026-08-13 shape (81 of 132 threads
reading short) the HAPPY case alone - one rung, one read - adds roughly 40s to a
migration run. Confirm the import runner's per-row budget against that before
the next bulk conversion.
