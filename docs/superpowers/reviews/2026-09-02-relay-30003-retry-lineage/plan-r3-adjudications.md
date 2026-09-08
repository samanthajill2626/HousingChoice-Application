# Plan review R3 - adjudications

Round 3 on the plan, one continued reviewer, 7 findings: none blocking, ONE
changing a decision, six wording. All accepted. Plan revision 4 is the result.

The reviewer answered the three things I asked it to attack: the reorder holds and
it could not break it; the transport-mode change is correct and nothing else in
the job needed the root row; and leaving the escalation alone was right on the
question it was asked - finding 1 is a DIFFERENT question that the reversal
surfaced rather than caused.

**1. "Unchanged in code" is not unchanged in behavior (MEDIUM, changes a
decision).** ACCEPT, and this is the finding that justified the round. Round 2 had
me revert my own scoping instruction and leave `flagPlacementAttention` untouched.
But every rung's callback re-enters the same handler, so a three-rung ladder
reaches `twilio.ts:2526` FOUR times - and each call rewrites `attention.at` with a
fresh timestamp (`:420`), re-emits `placement.updated` (`:427`) and logs another
`placement_escalation` (`:428`). The triage clock a human reads would reset at
+60s, +180s and +420s, and the leg would look newly-failed each time. My pinning
test posted a single callback, so it could not have seen it.

Neither of the two answers already considered is right. Deferring the escalation
deletes three of four terminal escalations; leaving it alone resets the clock
three times. The third answer is one condition: **escalate on the ROOT's callback
only** - skip when the source row is itself a retry row. Exactly one escalation
per failed leg, at the same moment as today, no clock resets, nothing deleted.
Both tests are in the plan: the pin, and the ladder-walking regression that is the
only thing able to catch this.

**2-4. Three citations that stop a literal builder (MEDIUM, wording).** ACCEPT
all. Task 4 was pointed at `mediaPointers.integration.test.ts`, which builds a
messages repo and never constructs a conversation - the third phantom-or-wrong
harness citation in three rounds, and the reason the plan now names
`relayRepos.integration.test.ts` with the line numbers where it already drives
`setRelayStatus`. That same call takes THREE required arguments including
`expectedCurrent` (`conversationsRepo.ts:850-854`), so the plan's two-argument
version would have made Task 4's red a typecheck error on the wrong symbol. And
"resolve the transport MODE from the retry row" was right about the row but silent
about the INTENT: the versioned arm carries a `MessageTransportIntent` the fan-out
computes via `adapter.classifyMessageTransport` and never stores, so the retry job
must classify afresh rather than read a field.

**5-6. The renumber left four stale cross-references (MEDIUM, wording).** ACCEPT.
Each resolved to a real but wrong task, which is the worst kind. Also the decision
to leave `flagPlacementAttention` alone had not propagated to the File Structure
section or Task 12's Files block - now both describe the one condition that is
actually changing.

**7. The coherence claim was stated absolutely (LOW, wording).** ACCEPT. It holds
for the PRODUCT and not for the BRANCH: the pinning e2e asserts the old copy until
Task 14 renames it, so gate 4 is red from Task 8 until then. That is not fixable
by ordering - the spec it pins and the presenter it tests cannot both be right
mid-branch - so the plan now says to run gate 4 at Task 14 and at the end, not
between.

## Round verdict

One decision changed, and it was a second-order consequence of a round-2
reversal rather than anything architectural. The remaining six are citations and
cross-references. Round 4 is the confirmation pass and the last one under the cap.
