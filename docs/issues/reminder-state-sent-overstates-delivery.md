---
id: reminder-state-sent-overstates-delivery
title: A reminder rung reads "Sent" (and now quotes a body) when a post-claim refusal delivered nothing
type: bug
severity: low
status: open
area: app+dashboard
created: 2026-08-06
refs: app/src/jobs/tourReminders.ts:682, app/src/routes/tourReminders.ts:137, app/src/repos/tourRemindersRepo.ts
---

**Problem.** `claimSend` IS the `sentAt` stamp - it is written BEFORE the
outbound send, deliberately, so two concurrent poll ticks cannot double-send.
When the send that follows is REFUSED (`SendRefusedError` - opt-out, breaker,
manual mode), the claim is kept on purpose and never retried
(`jobs/tourReminders.ts:682`, documented at `:370`). Nothing was delivered.

But the row now has `sentAt`, and `stateOf` derives state from exactly that:

```ts
if (row.sentAt !== undefined) return 'sent';     // routes/tourReminders.ts:137
```

So the Reminders panel shows the rung as **Sent**, and the contact timeline drops
it out of Upcoming, for a message the tenant never received. There is no
`refused` state and no stamp distinguishing "claimed and delivered" from "claimed
and refused".

**Why file it now.** The imprecision is PRE-EXISTING - it has been true since
claim-before-send landed. What changed with feat/tour-reminder-details is that
the panel now renders `sentBody` beside that chip, so the UI states not merely
THAT we sent something but exactly WHAT we sent. A navigator reading
`Sent - Aug 5, 3:50 PM` above `Tour confirmed at 350 Boulevard SE ... at 3:00 PM`
will reasonably conclude the tenant has that text. If the send was refused, they
are wrong in a way that affects what they do next - they will not follow up.

The repo is already careful about the narrow version of this: `sentBody`'s own
doc comment says it is "the body composed for the send that claimed this row" and
explicitly NOT proof of delivery. That protects the next engineer. It does not
protect the navigator reading the screen.

**Reachability.** Live. `SendRefusedError` is raised by ordinary, expected
conditions - a contact who opted out between arming and firing, a tripped
per-conversation breaker, manual mode. This is not an exotic path.

**Suggested fix (sketch).** Either:

1. Record the refusal on the row (a `refusedAt` + `refusalCode`, written in the
   same place the current code logs and returns), derive a distinct `refused`
   state, and give it its own chip - the honest option, and it reuses the
   skip-reason label machinery that already exists; or
2. At minimum, stop rendering `sentBody` for a rung whose send was refused, so
   the UI does not quote a message that was never delivered.

Option 1 is preferred: "Sent" and "we tried and were refused" are different facts
a navigator acts on differently, and the system already knows which happened at
the moment it happens.

**Provenance.** Raised as a NOTE by the planner's plan-blind adversarial pass
during the feat/tour-reminder-details merge review, 2026-08-06. Not fixed on that
branch: the underlying state model predates it, and changing what `sentAt` means
touches the concurrency guarantee three review passes had just verified.
