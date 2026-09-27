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

## Spec-gate answers (2026-09-25, on draft 5)

His words, then what changed in draft 6.

1. **Copy:** "For my todos, yes i approve the text." All four strings in the
   spec's section 7 stand.
2. **A late 30003 after a human action:** "the former not-retried verbiage is
   better, but if that creates a whole lot of work just for that one rare case,
   you can use the new copy if it's much easier to implement." It is not much
   work - the claim already closes a rung it created (`closeRetryLegEnqueueFailed`)
   - so draft 6 keeps "Not retried - group closed" and its siblings, shown at
   once (spec D3).
3. **The promise is decided at once:** "I don't want it to NOT say will retry,
   then LATER that pops up after an amount of time. We should be able to know
   immediately if we are going to attempt a retry or not, regardless of it's
   actually QUEUED for retry." Draft 6: the relay claim records its decision on
   the rung it creates (D3); the one-to-one webhook decides before it writes the
   failure and writes `retry_due_at` in the same conditional write (D3a, D7); a
   failed read now attempts the retry AND shows it, reversing draft 5's
   schedule-without-a-stamp.
4. **The reverse guard:** "The dropped guard is fine, I would rather err on the
   side of a double-text than a message not delivered at all."
5. **Sequencing:** agreed with share-skip-fix's planner - its Branch A first, then
   this branch, then send-outcome-reconcile. Its Stage 1 / `retrySend`-adoption
   split (2026-09-25) is recorded in the spec's section 5.

## Mission brief and answers after Branch A merged (2026-09-25)

1. **The retry follows the original send.** His brief: "Decide in your spec
   whether the retry carries the original send's automated flag (and
   recipient); say which," under his standing rule quoted in
   `docs/issues/ai-mode-switch-gates-all-automation.md`: "If somebody sends a
   message, I want it to be retried until it's exhausted or fails." The planner
   decided both (spec D14) and put it to him as a question; he gave the go
   without objecting.
2. **Sync:** "Don't skip the final merge for this, do another one if it moves
   before you're done." `main` was merged into the branch at `f49a2fe9`; it is
   merged again before handback if it has moved.
3. **Review of the post-gate drafts:** "Yes you can review the other drafts
   inside the plan review." Drafts 6 and 7 get no fifth spec round; the plan
   reviewers' brief names the changed decisions.
4. **Standing instruction:** the final handback ends with a "Relay for SOR"
   section - one fenced, ASCII-only block with full W:\ paths - carrying Branch
   A's five items for send-outcome-reconcile unchanged plus this branch's own
   hand-off (see the mission's handback when it is written).
