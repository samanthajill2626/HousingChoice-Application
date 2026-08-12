---
id: group-crosscheck-wiring-test-wall-clock-dependent
title: groupGuardrailWiring cross-check test fails after ~22:55 UTC (hard-coded sweep instant vs real clock)
type: bug
severity: med
status: open
area: app
created: 2026-08-11
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
