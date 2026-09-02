---
id: quiet-hours-e2e-fails-inside-its-own-window
title: The quiet-hours scenario spec fails gate 4 for roughly four hours every evening
type: bug
severity: high
status: resolved
area: e2e
created: 2026-09-01
refs: e2e/tests/scenarios/quiet-hours.spec.ts:433, e2e/tests/scenarios/quiet-hours.spec.ts:161, e2e/tests/scenarios/quiet-hours.spec.ts:405
---

**Problem.** `scenarios/quiet-hours.spec.ts` test (3) ("Send now ... even inside
the quiet window") asserts that the `day_before` reminder row shows NO
quiet-hours note:

```
await expect(row.getByText(QUIET_NOTE)).toHaveCount(0);   // :433
```

That assertion is **wall-clock dependent and fails for a wide band every
evening.**

- `windowAroundNow()` (:161) stores a quiet window of `[now - 2h, now + 2h]` in
  org-local time.
- The `day_before` rung is fixed at **19:30 org-local**
  (`tourScheduleFullLadder`).
- The panel's estimate for a FUTURE rung asks whether the rung's own `dueAt`
  falls inside an occurrence of the stored window.

So whenever the suite runs at an org-local time within about two hours of 19:30
- roughly **17:30 to 21:30** - the stored window contains 19:30, the panel
renders the quiet note, and `toHaveCount(0)` fails with `Received: 1`.

Observed 2026-09-01 at 20:16 EDT: `262 passed, 1 failed`, gate 4 exit 1. The
same branch's earlier runs, outside that band, were 263/263 twice.

**This is the spec's own documented hazard, inverted.** The comment above the
assertion (:415-427) explains at length that asserting `QUIET_NOTE` here "would
be a coin flip on the hour", because `windowAroundNow()` only covers 19:30 when
the suite happens to run between 17:30 and 21:30. That reasoning is correct -
but the conclusion drawn from it was to assert the OPPOSITE, which is the same
coin flip with the same odds, just failing on the complementary hours.

The comment also records why it reads this way now: before the 2026-08-26
retiming the rung was ~24h out and landed at the same local time as the window,
"and the pause then masked the breakage". Removing the pause (2026-08-31)
unmasked it.

**Not a flake.** It is deterministic given the hour - it will fail every run in
that band and pass every run outside it. `AGENTS.md`'s named-flake list is
empty, and this should not be added to it: the remedy is to remove the time
dependency, not to excuse the failure.

**Why it matters.** Gate 4 is a required completion gate for every branch. Any
mission whose e2e run lands in the evening band gets a red gate that has nothing
to do with its own change, and the natural response - re-run and see it pass -
teaches people that gate 4 is noisy. It cost one triage cycle on
`feat/retry-counter-durable` on 2026-09-01 to attribute.

**Suggested fix.** Make the assertion independent of the hour. Options, roughly
in order of preference:

1. Anchor the stored window to the RUNG rather than to `Date.now()` for this
   assertion, the way test (2) already does, and keep a wall-clock window only
   for the Send-now BYPASS the test actually exists to prove. The two needs are
   different and are currently served by one window.
2. Assert the note's state as a FUNCTION of whether 19:30 falls in the stored
   window, so the test is correct at every hour rather than at most hours.
3. Failing both, pin the suite's clock for this spec.

Do not simply flip the assertion back to `QUIET_NOTE` - the comment at :415-427
already explains why that is equally wrong, and the next person to run outside
the band would flip it back.

**Related.** Landed with the tour-reminder ladder work
(`feat/tour-reminder-ladder-phase-b`, merged @1af02926); the retiming and the
pause removal that unmasked it are both referenced in the spec's own comment.

**Resolution (2026-09-01, `fix/quiet-hours-spec-window`).** Option 1: test (3)
now stores TWO windows in sequence because it proves two different things. The
panel assertions run under the rung-anchored `QUIET_AROUND_DAY_BEFORE` (as
test (2) already did) and assert `QUIET_NOTE` PRESENT - deterministic at any
hour, and the honest narrative: the panel promises a deferral, then a human
overrides it. `windowAroundNow()` is re-stored just before the Send-now click,
serving only the wall-clock bypass premise, with no note assertion after the
switch. Verified with the single spec run at 20:57 EDT - inside the band that
failed - plus the spec's own comments updated to forbid asserting a rung note
under a wall-clock-anchored window.
