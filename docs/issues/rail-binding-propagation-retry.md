---
id: rail-binding-propagation-retry
title: Fresh group rails read back as roster-incomplete before Twilio bindings propagate
type: improvement
severity: low
status: open
area: app
created: 2026-08-13
refs: app/src/services/groupRail.ts:459, app/src/adapters/groupConversations.ts:359
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
