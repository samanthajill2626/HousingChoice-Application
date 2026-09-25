# Cameron's rulings for the retry send window (2026-09-24)

The decisions this mission implements, recorded so a builder can tell a ruling
from a proposal. Recorded by the planner session from the conversation of
2026-09-24.

## The anchor - relay-30003 open question Q4

As recorded on `main` @`cd8e8ddd`
(`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/founder-rulings-2026-09-24.md`,
Q4 row), after research showed the real risk:

> Superseded by a narrower rule once the research showed the real risk: nothing
> re-sends a text more than 15 minutes after the original went out. A late 30003
> (a carrier giving up after holding a text for hours or days) otherwise
> triggers a retry of out-of-context content, because neither retry path checks
> the message's age. A declined retry shows as a plain failed attempt. Alarm
> thresholds unchanged.

Cameron's own words when agreeing: "I agree with a 15-minute-or-so retry limit,
and then it shows a failed attempt. That way, we don't get the out-of-context
issues." Real 30003s have occurred in production.

## Brainstorm answers

1. **The window measures when a retry GOES OUT, not when the failure arrives.**
   "Really, the timer should be about something going out ... not about the
   failure arriving." The number is his call to leave open: "You can make it 15
   minutes, 20 minutes, 30 minutes. I don't care." 15 was chosen.
2. **Scope includes all five pieces:** the relay ladder, the one-to-one chain,
   treating a declined 30003 as a real failure, promising "will retry" on screen
   only when a retry is actually scheduled, and native group text (stop anything
   that promises or queues a retry that can never send).
3. **The manual Retry guard (option 1 of two offered):** hide the manual Retry
   button while an automatic retry is scheduled, and have the server refuse a
   manual retry during that wait, so an old open browser tab cannot double-send
   either. (Option 2, rejected: leave the button and accept the occasional double
   text.)
4. **Process:** the full feature pipeline (`/abt:feature-mission`); spec approval
   in writing after adversarial review.
