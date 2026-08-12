---
id: group-crosscheck-wiring-test-wall-clock-dependent
title: groupGuardrailWiring cross-check test fails after ~22:55 UTC (hard-coded sweep instant vs real clock)
type: bug
severity: med
status: resolved
area: app
created: 2026-08-11
updated: 2026-08-11
resolved: 2026-08-11
refs: app/test/groupGuardrailWiring.test.ts:111, app/src/services/groupCrossCheck.ts:237, app/src/repos/messagesRepo.ts:335
---

**Problem.** `test/groupGuardrailWiring.test.ts` > "WITHOUT the filing, the same
event alarms - which is what the wiring prevents" fails whenever the suite runs
late enough in the UTC day. The pending cross-check row's deadline is written as
REAL `now + GROUP_CROSSCHECK_GRACE_MS` (5 minutes, `groupCrossCheck.ts:237`),
but the sweep is then driven with the HARD-CODED instant
`'2026-08-11T23:00:00.000Z'`. Once the wall clock passes about 22:55 UTC the
deadline lands after that instant, the sweep finds nothing overdue, and the
assertion `expect(sweep.alarms).toHaveLength(1)` fails with `[]`.

Reproduced at 2026-08-12T00:11Z on a CLEAN `feat/group-texting` @7f1f29f5 (the
fix-wave-6 changes are not involved): the test fails identically with the branch
stashed. The neighbouring "an event then its classic filing leaves NOTHING to
alarm about" test asserts an EMPTY result, so it passes either way - which is
why only one of the pair goes red.

This is a false red on a real guardrail's wiring test, and (being time-of-day
dependent) it will read as a flake to whoever hits it next.

**Suggested fix.** Stop mixing a real clock with a fixed instant. Either inject
the clock the row is written with (the service already takes deps), or derive the
sweep instant from `Date.now() + GROUP_CROSSCHECK_GRACE_MS + 1` instead of
hard-coding a date. The same audit is worth doing across the group guardrail
suites for any other fixed 2026-08-11 instant compared against a real-clock
deadline.

**Root cause, confirmed by instrumentation.** The ledger rows were written from
the REAL clock and the sweep ran at a calendar literal - the two clocks were
never the same timeline. A probe at 2026-08-12T01:14Z printed the pending row as
`deadlineAt: 2026-08-12T01:19:35Z` with an EMPTY credit list, and the same sweep
returned `{scanned: 0, alarms: []}` at the hard-coded `2026-08-11T23:00:00.000Z`
and `{scanned: 1, alarms: [...]}` at a derived future instant. So the pending row
was always written correctly; `listDueRows` simply filtered it out because its
deadline sorted AFTER the literal `through`. The competing theory - that the
`railedGroup` setup banked a (rail, author) credit that swallowed the event - is
ruled out: that first inbound is filed BEFORE the rail is attached, so
`hasActiveGroupRail` is false and `recordClassicInbound` is never reached.

**Resolution.** Fixed by giving the whole scenario ONE clock rather than by
moving the literal forward. `makeWebhookHarness` now takes an optional
`groupCrossCheckNow: () => Date` (the same shape as the existing `toursNow` /
`placementsNow` / `poolNumbersNow` seams) and passes it to the world's
`createGroupCrossCheck`, so the webhooks stamp their grace deadlines from the
injected clock. Both T6.6(d) cross-check tests now pin `LEDGER_NOW` and sweep at
`LEDGER_NOW + GROUP_CROSSCHECK_GRACE_MS + 1s`, derived from the real exported
constant - so the scenario is identical at every wall-clock time and stays
correct if the grace window is ever retuned.

The sibling "an event then its classic filing leaves NOTHING to alarm about" had
the same latent defect and passed only by luck (it asserts an EMPTY result, which
a starved sweep also produces). It was fixed the same way AND strengthened: it
now also asserts the `group_crosscheck_event_matched` / `reason: filed` log line
fired exactly once and that `scanned === 0`, so an empty ledger can no longer
masquerade as a healthy match.

Revert-proof: with the `recordClassicInbound` call site in
`app/src/routes/webhooks/twilio.ts` temporarily replaced by a no-op, the match
test fails (`expected [ { ... } ] to deeply equal []`) while the other five pass;
the wiring was restored and all six pass again. `npm run typecheck` and
`npm test` both exit 0.
