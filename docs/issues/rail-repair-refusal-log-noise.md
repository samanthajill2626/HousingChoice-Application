---
id: rail-repair-refusal-log-noise
title: Twilio 50386/50437 "participant already exists" refusals log as WARN during rail repair, though nothing acts on them
type: debt
severity: low
status: open
area: app
created: 2026-09-01
refs: app/src/adapters/groupConversations.ts:563, app/src/services/groupRail.ts:613
---

**Problem.** The 2026-08-13 dev migration of 132 imported group threads produced
**178 `group_rail_participant_add_failed` WARN lines** carrying Twilio 50386 /
50437 ("participant already exists"). Those members were on the rail all along;
their messaging bindings were still provisioning, which made the rail read short
and drove a repair that then tried to re-add people who were already there.

The propagation half of that is fixed - see
[`rail-binding-propagation-retry`](./rail-binding-propagation-retry.md) - so the
repair fires far less often. This issue is the LOG half, which was deliberately
not touched (spec D18 of
`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`).

**This is log classification only. It changes no behavior, and that is the whole
point of filing it rather than shipping it.** Traced end to end:

- The refusals are raised per member in
  `app/src/adapters/groupConversations.ts:563-566`, which pushes a
  `GroupParticipantFailure` into its return array AND logs
  `group_rail_participant_add_failed` at WARN.
- The caller, `app/src/services/groupRail.ts:613-622`, collects those failures,
  logs a second WARN summarising the count and the distinct error codes
  (`group_rail_repair_partial`), and then **discards them**: completeness is
  re-derived from an authoritative `fetchParticipants` re-read, never from the
  repair's own return value. That is the design (spec D15) and it is correct -
  an add can "succeed" and still leave a shape Twilio will not bind.

So special-casing 50386/50437 in the SERVICE would alter no outcome whatsoever.
A change that reads like a fix but cannot change a single decision is worse than
no change: the next reader has to re-derive that it is inert.

**Suggested fix.** Treat it as what it is - a logging taxonomy problem in the
ADAPTER. `groupConversations.ts:563-566` should log an "already exists" refusal
at DEBUG (or drop it, since the failure record still reaches the caller's
report) while keeping WARN for refusals that mean something. Weigh two things
first:

- the failure record must still be returned unchanged - the caller's report is
  not a log sink and the migration report is a cutover gate;
- `group_rail_repair_partial` in the service summarises `errorCodes`, so if the
  adapter goes quiet the service line becomes the only surviving trace of a
  refusal. Decide deliberately whether that line stays WARN.

`app/src/adapters/groupConversations.ts` is not edited by
`feat/retry-counter-durable`, which is why this is filed rather than fixed
there.
