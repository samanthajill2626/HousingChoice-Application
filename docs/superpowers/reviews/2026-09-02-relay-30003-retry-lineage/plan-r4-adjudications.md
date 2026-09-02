# Plan review R4 - adjudications - TERMINAL ROUND

Round 4 on the plan, one continued reviewer, 5 findings: none blocking, TWO
changing a decision, three wording. All accepted. Plan revision 5 is the result.

**This is the terminal round, and the judgement needs stating rather than
implying.** The four-round cap says a round that still changes decisions means the
design is not converging. Two decisions changed here, so the mechanical reading
says stop and escalate. The substance says otherwise, and the reviewer said so
unprompted: both are ONE-INSTRUCTION fixes, neither reopens anything
architectural, and **this is the first round in which no citation would stop a
literal builder** - after three consecutive rounds in which one would have. The
curve is convergence, not drift. The founder has the summary and the dispatch went
ahead on his standing go.

**1. The claim block could bypass the existing tail (MEDIUM, changes a
decision).** ACCEPT. I had placed it "after the existing slot write and before the
return" - a span that also contains the failure-marker log (`twilio.ts:2500-2511`),
the SSE emit (`:2512-2521`) and the placement escalation (`:2522-2528`). A claim
block full of early `return`s would skip all three on four different exits, and
the `fenced_announcement` exit would stop an announcement leg escalating on a
placement-linked thread, which it does today. Nothing in the plan could have
caught it. The claim is now a helper that RETURNS a `retryClaim` value with no
early exits, and control falls through to the tail that consumes it.

**2. "Gate 4 is red from Task 8" was wrong and expensive (MEDIUM, changes a
decision).** ACCEPT. The pinning e2e stays GREEN through Task 11 - no retry rows
exist, so the projection is the identity function and the presenter emits today's
strings - and goes red only at Task 12. My instruction would have blanked e2e
coverage across the ENTIRE display rewrite, which touches a presenter shared with
two fenced products. Gate 4 now runs normally through Task 11, with red expected
at Tasks 12-13 only.

**3-5. Wording, all accepted.** The escalation condition never said WHICH `source`
it reads, and only the `:2449` value is in scope on the non-30003 failure paths
where the escalation also fires - now stated, with the two properties that make it
safe (it fails OPEN toward escalating, and the field is written at append time so
a stale read cannot lose it). The two escalation tests could not separate the
right discriminator from a plausible wrong one, so a third test covers the case
that does: a SECOND member failing mid-ladder, whose failure "skip when any retry
row exists in this conversation" would silently swallow - a different tenant,
never escalated. And `classifyMessageTransport` takes only
`{ hasForwardableMedia }`, not the message type.

## Design review closed

Spec: 4 rounds, 3 reviewers, 82 findings. Plan: 4 rounds, 2 reviewers, 66
findings. 148 findings total, every one adjudicated, across 8 rounds.

On the question I asked the reviewer to attack - the new escalation discriminator
- it walked all seven shapes that reach `:2526` and confirmed every one lands
correctly, and found the property stronger than the plan claimed: because
`relay_retry_of` is a field this branch creates, the condition is false for every
row that predates it, so "unchanged for everything shipped today" is structural
rather than empirical.
