# Spec review R3 - adjudications

Round 3, one continued reviewer, 13 findings against revision 3 - eight marked
CHANGES-DECISION by the reviewer, five WORDING. All accepted. Revision 4 is the
result.

The reviewer also answered the two questions I put to it about the mechanisms I
invented in revision 3, and both answers are worth recording: it found NO path
where a terminal/30003 slot produces a wrong claim (the digest neutralises
repeats, the 30007 case closes, cross-member races are safe behind the child-field
guard), and it confirmed the inbound recital CAN express the new states with no
extra plumbing, because `orderRecipientRows` feeds all three
`recipientSummaryName` sites from the same entries. So the two shapes hold; what
round 3 found is that their INPUTS were unspecified.

**1. The state gate never says where the post-write state comes from (BLOCKING).**
ACCEPT. `updateRecipientDeliveryStatus` returns a bare boolean
(`messagesRepo.ts:3516`) and `getByTsMsgId` is eventually consistent
(`:2960-2965`), so the obvious build re-reads and intermittently sees the pre-write
slot - a load-dependent dropped retry that no test catches reliably.
`getMessageConsistent` (`:1885`) exists for this and six sibling mutators already
establish the precedent. Specified.

**2. `unconfirmed` covered only half the ways a ladder goes quiet (BLOCKING).**
ACCEPT, and this is the third time this design has nearly reintroduced M5's
falsehood. Revision 3 defined `unconfirmed` as "never reached `sent`", which
leaves a rung that DID send and got no receipt reading `retrying` for ever.
Both halves are now specified, sharing one budget so two horizons cannot drift.
The reviewer also notes the new ticker clause is the FIFTH non-termination in a
predicate whose docblock enumerates four shipped bugs on that axis - the spec now
requires that docblock to be extended rather than left stale.

**3. `retryState` cannot be smuggled into `status` (HIGH).** ACCEPT. `DeliveryStatus`
is closed and `presentDeliveryStatus` returns null outside it
(`deliveryStatus.ts:128-141`), so an overloaded `status: 'retrying'` renders as NO
state on the row and recital, while `presentRelayDelivery`'s counters
(`:410-414`) drop the leg from both buckets and emit a neutral `delivered 3/4`
that reads like a message still in flight. The projection now carries `retryState`
as its own field and every consumer branches on it explicitly.

**4. The ticker clause forces the join to THREAD level (HIGH).** ACCEPT.
`hasTickableLeg` runs over `visible` with `(item, tickNow)` only
(`Timeline.tsx:798`, `:1851-1854`), and D20 has already filtered the retry rows
out of `visible` - so the state cannot be computed inside a bubble from its own
props. The join is now explicitly thread-level, over all items including hidden
retry rows, which is also where D20's filter lives. This resolves a contradiction
between D18 and D19 that I introduced.

**5. The original can be LEGACY transport (MEDIUM).** ACCEPT. Every relay source
written before 2026-09-02 is legacy (`relayFanOut.ts:791-795`), and a retry row
that always seeded a versioned slot while mirroring a legacy original would drive
the extracted body down `markRecipient`'s blind whole-slot write (`:1436-1463`),
erasing the `planned` state revision 3 had just mandated. The mode now follows the
original. Worth stating that this is the ORDINARY case, not an edge one: a retry
ladder exists precisely for older messages.

**6. A legitimate 30003 does not always leave the slot terminal-plus-30003
(MEDIUM).** ACCEPT. A code-less `failed` callback arriving first makes the slot
terminal and thereby blocks the 30003 callback's transition, so the 30003 is never
written (`messagesRepo.ts:3459-3466`, `:3477-3481`) and a state-only gate refuses
a real first failure. The gate now reads THIS CALLBACK's code, requires the slot
to be terminal, and requires the slot's own code to be 30003 or ABSENT - which
keeps the 30007 case closed while admitting the code-less-first case.

**7. One unreadable source row costs both the retry and the truth about it
(MEDIUM).** ACCEPT. D7's fence is deliberately fail-closed, so a transient read
miss permanently declines the claim, and D23 then logs that leg ERROR - correct in
kind, wrong in cause, and it will read as a carrier failure. Recorded in Sec 9 so
the next person diagnosing such an alarm starts in the right place. Not fixed: a
fence that can fail open onto the tour-reminder ladder is the worse trade.

**8. D23 left the middle undecided (MEDIUM).** ACCEPT. Decision: a fan-out or team
leg that ends terminally logs ERROR whether or not a ladder ran, including claims
declined for a missing `To` or an unreadable source. The distinction that matters
is the PRODUCT the leg belongs to, not whether the ladder happened to start, and
the founder's estimate is stated to cover that whole set. Announcement legs still
keep WARN.

**9-13. Wording (LOW).** All accepted and applied: the message-level chip removed
from D19's consumer list (it is excluded by Sec 5 and unreachable for any retry
state anyway); D17 corrected from three wire fields to D11's four; two "terminal
ERROR of D22" references corrected to D23; the test list renumbered (it ran
1..12, 15, 16, 13, 14); and `dashboard/src/lib/messageTransport.ts:43-56` added to
the In-list as the funnel every projected entry passes through.

---

## Round verdict and the convergence call

Thirteen findings, all accepted, eight changing a decision. On count alone that
argues for a fourth round; on CHARACTER it argues the opposite, and the character
is what the stop rule is actually about.

Rounds 1 and 2 moved architecture: what a retry IS, which guard defeats which
duplicate, whether the display contract exists at all on the dominant case,
whether a gate makes a crash unrecoverable. Round 3 moved none of that. It
confirmed both mechanisms invented in revision 3 are sound in shape and then
specified their inputs: which read to use, which enum field to put a new state in,
where the join sits, which transport mode to mirror. Every one is an
implementation detail that a plan must pin down and none reopens a decision made
in an earlier round.

Round 4 runs as the confirmation pass, not as an expected source of new
architecture. If it changes a decision, the design goes to the founder as a
decision with the open findings, per the four-round cap.
