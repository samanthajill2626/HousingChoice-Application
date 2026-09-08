# Plan review R2 - adjudications

Round 2 on the plan, one continued reviewer, 12 findings: none blocking, three
changing a decision, nine wording. All accepted. Plan revision 3 is the result.

The reviewer also did what I asked and attacked the reorder directly: it could
not break it in the expected direction (no task forward-references, no collision
between Tasks 7 and 9, the parallel claim holds), and it verified the seven
helper-to-harness mappings I had asserted without checking - five held, two did
not.

**1. Scoping `flagPlacementAttention` would DELETE three escalations (HIGH,
changes a decision).** ACCEPT, and REVERT my instruction entirely. I had told the
builder to defer the human escalation until no retry is live. But gate refusal,
enqueue failure and transient cap all end inside the JOB with no further callback,
and `flagPlacementAttention` is a closure inside `createTwilioWebhookRouter`
(`twilio.ts:412`, called only at `:2526` and `:2700`) that the job cannot reach -
so three of the four terminal outcomes would simply never escalate. Losing an
escalation is strictly worse than sending one early. The function is left exactly
as it is, with a test pinning today's behavior and a comment recording why, and
the premature-escalation observation is filed rather than fixed.

**2. The reorder MOVED the incoherent window rather than closing it (MEDIUM,
changes a decision).** ACCEPT. Round 1 caught retry rows rendering unfiltered;
moving the filter forward fixed that but left a second window between the claim
and the presenter, where a delivered retry renders `Delivered 1/1` in success
green beside an original still reading `1 failed - Phone unreachable (error
30003)` - two bubbles contradicting each other about one message. The reviewer's
proposed order is adopted: the ENTIRE display (Tasks 5-10) now precedes the entire
server claim path (Tasks 11-13). The new coherence argument is also stronger
because it no longer depends on reading the task list carefully: before Task 12 no
retry row exists anywhere, so every display task is provably inert.

**3. The transport mode must come from the RETRY row, not the ROOT (MEDIUM,
changes a decision).** ACCEPT. `sendOneRelayLeg` writes the RETRY row, and
`applyRecipientSendResult` checks THAT row's schema (`messagesRepo.ts:3240`). The
retry row was already seeded to mirror the root at creation time, so reading the
mode from itself is both correct and simpler - and it removes a requirement that
the root ROW be readable, which would have added a close path for a row the job
needs only as a string.

**4-12. Wording, all accepted.** The harness citation was a phantom for the second
time (`messagesRepo.integration.test.ts` does not exist either; the real one is
`mediaPointers.integration.test.ts`, which I verified). Task 7 never said the
filter reads delivered-ness from the row's own slot rather than the join - and
with the join now landing first, the wrong answer had become the tempting one.
`hasTickableLeg` had no stated signature for its new input. Task 10's
`renderTourConversation({items})` does not exist (the suite uses `renderConvo`
plus an api mock). Task 8's fenced-product test called an unimportable
`presentLegDeliveryOnMain`. Intention 7 was still proven once despite my
adjudication claiming otherwise - now a ladder-walking unit test. Plus the
adapter-versus-module spy boundary, an import specifier, and the log-capture call
site that keeps its handle.

## Round verdict

Three decisions changed, all narrow, none architectural. Round 3 is the
confirmation pass.
