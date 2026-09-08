# Spec review R2 - adjudications

Round 2, one continued reviewer (B), 13 findings against revision 2, plus its
answers to my three rejected remedies. Verdicts mine; severities the reviewer's.
"Changed a decision" is what drives the round loop.

Round 2 was worth running: it found a false premise underneath a founder ruling,
a hard throw on the first send, and a mechanism I introduced in revision 2 that
silently disabled its own clock.

---

**1. An inbound relay source DOES render an accessible-name recital (BLOCKING).**
ACCEPT. Changed a decision, and corrects a statement I made to the founder.
Verified independently: `inboundRecipientName` (`Timeline.tsx:993-1004`, rendered
`:1068-1070`) exists specifically so inbound relay sources expose the fan-out
facts through a hidden semantic group, and the per-recipient rows render too
(`:948-951`). So TWO of D21's three positions exist on a member-originated
source; only the visible chip is absent. Both round-1 reviewers and my
adjudication said otherwise.

The consequence is what makes this blocking, and it is not a scope question: under
revision 2, a member-originated leg whose retry DELIVERED would go on reciting
`Undelivered - Phone unreachable (error 30003)` for ever, because the original's
slot is never rewritten and the retry row is hidden on inbound sources. That is a
reader actively disagreeing with the new rule, on the one surface a screen-reader
user has - strictly worse than today, where the recital is at least true.

**The founder's ruling is unchanged in substance and now applied to the real
surface:** the contract reaches every position that exists, so the rows and the
recital carry the new states on BOTH directions. Only the visible chip is out of
scope, because on an inbound source there is no chip to move. The filed issue
narrows accordingly, from "shows nothing" to "has no visible chip".

**2. `unconfirmed` has no clock driver (BLOCKING).** ACCEPT, with the reviewer's
remedy. Changed a decision. Revision 2 correctly routed the new state around
`stalenessClockMs` - and thereby routed it around the only thing that makes a
time-derived state appear without a refetch: `tickerArmed` is computed from
`hasTickableLeg` over the RENDERED set (`Timeline.tsx:1851-1854`, `:798-812`), and
both of its predicates go through `stalenessClockMs`. The original's terminal leg
can never arm it, and D20 keeps the retry row out of `visible` entirely. So in the
exact case the state exists for - the stranded claim - `tickNow` is frozen and
`retrying` is computed once, for ever. The indefinite promise M5 removed comes
back one level down. The retry state now arms the ticker itself, via a retry-state
clause in `hasTickableLeg`, and the budget is named rather than implied.

**3. The seeded slot's shape is still unstated, and the first send throws
(BLOCKING).** ACCEPT. Changed a decision. My adjudication 2 claimed the shape
question was closed; it closed the ROW's half and not the SLOT's.
`setVersionedAggregationState` requires the slot to be `planned` before it can
reach `attempted` (`messagesRepo.ts:3112-3114`, `:3126`; throw at
`relayFanOut.ts:1418-1424`), and the fan-out only avoids this because its
preflight seeds `planned` OUTSIDE the range D10 extracts. The retry row's slot is
now specified as
`{ status: 'queued', requestedTransport: <intent>, transportAggregationState: 'planned' }`.
The reviewer's distinction is preserved in the spec because it is exactly the kind
a builder inverts: the inbound prohibition is on the MESSAGE's
`requestedTransport` (`messagesRepo.ts:913-915`), not on the SLOT's, which is
validated but permitted (`:922-937`).

**4 and 5. The transition gate's justification is unreachable, and the gate costs
recoverability (both HIGH).** ACCEPT both, and REPLACE the mechanism rather than
patch the reasoning. Changed a decision.

Finding 4 is right: `putRelaySidPointer` is called only on the success branch
(`relayFanOut.ts:1263-1267`), so a leg closed as 30007 or opted-out has no pointer
and can never produce a callback. The necessity argument I recorded in
adjudication 7 cites two unreachable scenarios.

Finding 5 is right and is the more serious half: gating on `transitioned` makes a
crash between the slot write (`twilio.ts:2466`) and the claim UNRECOVERABLE,
because the redelivered callback now finds a slot already `undelivered`,
transitions nothing, and refuses to claim. Before the gate, that redelivery would
have won the create and recovered the retry.

So the gate is dropped and replaced: **claim on the SLOT's post-write state, not
on whether this callback transitioned it** - the slot is terminal AND its error
code is 30003. This keeps the only reachable case the gate was protecting (a leg
that sent, took a terminal 30007, then received a contradictory 30003 - its slot
reads 30007, so no claim), and it restores recoverability (a crash-redelivery
finds `undelivered`/30003 and claims). Duplicate suppression was never the gate's
job anyway: D3's create already dedupes a repeated callback, since the same root,
destination and attempt yield the same digest.

**6. The close-code projection has five derivation sites, not one (HIGH).**
ACCEPT, with the reviewer's shape. Changed a decision. The reason is derived
independently by `presentRelayDelivery`, three `recipientSummaryName` call sites
and the per-recipient row, three of which read `row.slot.errorCode` raw, and
whether a reason renders at all is gated on `presentLegDelivery`'s `isFailure` -
which must move in BOTH directions for the retrying and delivered-on-retry states.
"Through the same join" understated it fivefold. The design now projects once onto
the ENTRIES, producing an effective `{status, errorCode}` per member key, and every
downstream consumer reads the projected set instead of a raw slot. That single
change also delivers finding 1 and finding 8.

**7. D20's predicate needs the original's direction, which is not on the wire
(HIGH).** ACCEPT. Changed a decision. Neither default is safe: default-render
produces the duplicate member message the predicate exists to prevent;
default-hide drops half the approved contract on first load of a busy thread. The
original's direction becomes a fifth stored value and reaches the wire, so the
predicate is self-contained and the orphan case decides correctly with no lookup.
The spec also names where the filter lives - Timeline's `visible` memo, the only
point all three hosts converge - and flags the tour host's milestone-merged list.

**8. Revision 2 deleted the row and recital copy revision 1 specified (HIGH).**
ACCEPT. Changed a decision - a regression I introduced in the rewrite. D19's table
is chip strings only while Sec 5 still claims three positions move together, so a
build could satisfy the table with the chip alone and leave the other two reciting
the old string. The row and recital grammar is restored, and test intention 12 now
has something to assert at all three positions.

**9. The member key can itself be a phone number (MEDIUM).** ACCEPT.
`relayMemberKey` falls back to `phone#<E164>` (`messagesRepo.ts:189-193`), and
contact-less members are the normal shape in this repo's fixtures - including this
feature's own e2e. So D11's "no handset number is among them" was false, and for a
contact-less member the digest hides nothing the neighbouring field already
publishes. The exposure is PRE-EXISTING (`delivery_recipients` is member-keyed and
already forwarded) and is not fixed here; the spec now says the protection is
partial and why it is still worth having for contact-keyed members.

**10. The alarm estimate omits the fenced legs (MEDIUM).** ACCEPT. Changed a
decision. Revision 1 put "no retry was claimed at all" in the ERROR set; revision 2
dropped the phrase and left every announcement and tour-reminder rung undecided -
they reach the same severity site and today all log WARN. Decision: **fenced legs
keep WARN.** Alarming a tour-reminder rung from a mission whose scope explicitly
fences that file out is precisely the kind of unrequested blast radius this design
exists to avoid, and it is the same omission class as the 21610 carve-out round 1
caught. The founder's sign-off question is correspondingly narrowed to fan-out and
team legs only.

**11. The transient self-continuation is under-specified (MEDIUM).** ACCEPT.
Changed a decision. I created a second ladder (5s/10s, its own budget) inside a job
whose stated ladder is 60/120/240, and said only "bounded by". The spec now states
who claims the budget, what happens on `capped`, which backoff the re-enqueue uses,
and whether that seam is injectable for the e2e. The reviewer independently
verified the budget claim itself is sound - the retry row is a different message,
so no continuation budget is shared.

**12. Sec 2 omits `conversationsRepo.ts` and cites the wrong decision (MEDIUM).**
ACCEPT. There is no status-free bump to call: `touchLastActivity` writes
`status = 'open'` in its primary branch and its status-free variant is a
catch-branch fallback (`conversationsRepo.ts:1531-1578`), so a NEW repo method is
required and the file was not in scope at all. Added, along with the reviewer's
observation that a status-free bump on a closed group re-sorts it within the
`closed` partition of the `(status, last_activity_at)` GSI - the correct behavior
and the observable difference from doing nothing. The D13/D16 cross-reference is
fixed.

**13. Two smaller items (LOW).** ACCEPT both. (a) A delivered outbound MMS retry
renders its attachments in two bubbles - correct behavior for a genuine second
send, but a visible consequence of D13 plus D20 that the spec should state, since
"adds no rows to the media gallery" passes while a reviewer sees a duplicate.
(b) D3's wall-clock rationale is right for the wrong reason: `bumpKey`'s U+FFFF
bound excludes newer rows regardless, and the real hazard is that at an identical
timestamp `relayretry-` sorts below `team-`/`system-`. Corrected, along with the
note that the fan-out's "relay sources are inbound, one at a time" assumption is
weakened by a design that appends relay-source-shaped rows on a timer.

---

## The reviewer's answers to my rejected remedies

- **Adjudication 2** (inbound viability): CONCEDED by the reviewer, having
  verified it independently. My ruling stands; its seeded-slot half did not, which
  is finding 3.
- **Adjudication 10** (derived retry state over a per-slot clock): the reviewer
  accepts the shape and shows it broke the re-render driver. Both are right; the
  remedy is finding 2's ticker clause.
- **Adjudication 11** (projection over a D16 exception): the reviewer agrees
  projection is the better branch because it preserves the founder's
  one-bubble-on-failure contract, and shows the specification was fivefold short.
  Finding 6.

## Round verdict

13 findings, all accepted; 10 changed a decision, two of them mechanisms rather
than wording. Round 3 required. This is round 3 of a hard cap of 4 - if round 3
still changes decisions, the design goes to the founder as a decision rather than
into another round.
