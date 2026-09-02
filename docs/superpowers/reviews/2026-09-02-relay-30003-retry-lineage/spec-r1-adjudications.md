# Spec review R1 - adjudications

Round 1, two independent reviewers (A and B), 23 + 21 findings against
`docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` @ `484059cb`.

Verdicts are mine. Severity labels are the reviewers'. "Changed a decision"
marks findings that altered what gets built, added or removed a surface, or
moved an invariant - that is what drives the round loop, not severity.

A scope ruling from the founder arrived between round 1 and this adjudication
and resolves part of two blocking findings: **the feature ships the retry for
both source directions, but the visible contract lands only where per-recipient
delivery is rendered today (team-originated sends). The inbound display gap is
filed as its own issue, not annexed here.**

---

## Blocking

**1. Duplicate JOB delivery is unguarded (A1, B5).** ACCEPT. Changed a decision.
The claim is an `append` in the WEBHOOK; the retry JOB performs no create, so an
SQS redelivery re-sends. Every job in this repo that must not double-send
carries `putJobExecutionMarker` before the send (`relayFanOut.ts:732-744`,
`retrySend.ts:129-146`) and the spec named none. The spec now requires the
marker as the job-side guard, states that the create defeats duplicate
CALLBACKS while the marker defeats duplicate DELIVERIES, and the test intention
is split so it cannot pass by exercising only the create.

**2. The retry row's shape is unspecified (A2, B1).** ACCEPT the finding, REJECT
its stated remedy. Changed a decision.

The finding is right that `direction`, `author`, `type`, message-level
`delivery_status` and the seeded slot's transport shape were all unstated, and
that the display contract turns on `direction`.

A2's sub-claim that three constraints "force `direction: 'outbound'`" is WRONG,
and I verified it: today's inbound relay source is appended with
`transportSchemaVersion: TRANSPORT_SCHEMA_VERSION` and no `requestedTransport`
(`twilio.ts:636-650`), and the fan-out drives exactly that row through
`persistRelayRecipientResult` and `setVersionedAggregationState` every day. Only
`requestedTransport` is forbidden on an inbound row
(`messagesRepo.ts:913-915`) - schema 1 and a versioned slot are not. So an
inbound retry row is viable and needs no invented shape.

The decision: **a retry row mirrors its original's direction, author and
sender key.** Both resulting shapes are already proven by existing rows. Nothing
novel is minted, and A2(b)'s "outbound bubble labelled with a member's name"
never arises.

**3. The display contract does not exist for member-originated sends (A2, B2).**
ACCEPT. Changed a decision, by founder ruling. The rollup chip and its
accessible-name recital are gated on `outbound` (`Timeline.tsx:837`, `:934-940`),
and a member-originated relay source is inbound (`twilio.ts:641`), so for the
dominant relay case two of the three render positions do not exist. The retry
ships for both directions; the visible contract is scoped to sources that render
a rollup today; a retry row renders ONLY when it delivered AND its original is
outbound, so an inbound retry never appears as a duplicate member message. The
gap is filed separately.

---

## Accepted - mechanism corrections

**4. The claim is the SID pointer, not the row's own key (A7, B4).** ACCEPT.
Changed a decision. `append` attributes a dedupe strictly to index 1, the
`sid#<providerSid>` pointer (`messagesRepo.ts:2295-2306`); a condition failure on
the row's own key is rethrown (`:2374-2388`). The spec cited `:2220` and called
it the claim. Corrected, and `providerTs` is now specified as a wall clock at
claim time - deterministic only in the SID. That keeps the retry ordered after
its original and out of the fan-out's five-row source window
(`relayFanOut.ts:771-779`).

**5. The fence fails open on a missing source (A4, B19).** ACCEPT. Changed a
decision. `source` is `MessageItem | undefined` at `twilio.ts:2449` and the
handler already tolerates undefined, so `source?.relay_sender_key !== 'system'`
is true for a read miss - enough to claim a retry against a tour-reminder rung.
The fence is now POSITIVE: claim only when the source row is present AND carries
a sender key AND that key is not the system value. Test the missing-source case.
B19's narrower point (the test is on the VALUE, not the imported constant) is
folded into the test intention.

**6. `To` is unvalidated and may be absent (B20, Sec 9).** ACCEPT. The relay
branch passes `direction: 'outbound'` into the normalizer, whose `to` is read
only on the inbound branch (`twilioMessageTransport.ts:145-155`), so nothing on
this path has ever validated it. Missing or non-E164 `To` now means DO NOT CLAIM
rather than minting a different digest.

**7. The claim's relationship to `transitioned` was unspecified (B17).** ACCEPT.
Changed a decision, and the reasoning matters because it looks like M5's trap and
is not. M5's constraint 2 says a claim gated on the slot transition caps the
ladder at rung 1 - true when every rung writes the SAME slot. Under D1 each rung
lands on its OWN row's fresh slot, which always transitions, so the trap does not
apply. Gating on the transition is therefore safe AND necessary: it is what stops
a late 30003 callback claiming a retry for a leg the fan-out already closed for a
different cause (30007 at `relayFanOut.ts:1209-1216`, opt-out at `:1127-1130`).
The spec now states the gate and why it is not constraint 2.

**8. The transient send arm has no continuation (B16).** ACCEPT. Changed a
decision. The extracted loop body defers a 429/30022 to a continuation that lives
outside the extracted range (`relayFanOut.ts:1227-1246`), which the retry job does
not have - the leg would sit `queued` and the chain would end silently. Ending
the chain on a rate-limit is the wrong answer for the one code that most means
"try again". The retry job now re-enqueues the SAME rung on a transient send
error, bounded by the retry row's own `claimFanoutPass` budget - legitimate
because the retry row is a different message, so no continuation budget is
shared (M5's constraint 5 holds).

---

## Accepted - display

**9. Rows 2 and 4 need cross-row arithmetic the spec never stated (A6, B11).**
ACCEPT. Changed a decision. `failed > 0` is the FIRST branch
(`deliveryStatus.ts:416`), so with the original's slot left at `undelivered` all
four states collapse to today's failure string. The spec now states the full
arithmetic - which legs are subtracted from `failed`, which are added to
`delivered`, and the tone each state carries - rather than only D17's single
subtraction.

**10. D18 cannot be expressed by the presenter, and would edit a fenced helper
(A5, B9).** ACCEPT the findings, REJECT the mechanism I had chosen. Changed a
decision. `stalenessClockMs` is shared with native group text, which Sec 2 fences
out, and its `queued` silence is deliberate and documented
(`deliveryStatus.ts:191-201`); worse, `bubbleClocks` yields ONE clock per bubble
(`Timeline.tsx:734-742`), so ageing the retry's slot while presenting on the
original's chip has nowhere to put a per-slot clock.

The replacement does not touch staleness at all: the join computes a per-member
RETRY STATE from the retry rows themselves - which the presenter is already being
given - and a rung that has not reached `sent` within the budget, measured from
the retry row's own `at`, yields `unconfirmed`. `stalenessClockMs` is untouched,
the fence holds, and no per-slot clock is needed.

**11. Terminal close codes have no reader (A3, B10).** ACCEPT the finding, REJECT
A3's remedy. Changed a decision. A refused or enqueue-failed retry leg lands on a
bubble D16 never renders, so D12's stated purpose was unachievable by its own
mechanism. A3 proposes an exception to D16; I take the other branch - the close
code is projected onto the ORIGINAL's presentation through the same join that
already carries the retry state, so a refused chain reads its refusal reason
instead of the bare carrier reason, and the "one bubble on failure" contract the
founder approved is preserved. New internal codes are enumerated with their
`INTERNAL_CODE_REASONS` copy (A19, B10), so none can print as
`Delivery failed (error <token>)`.

**12. Nothing forbade stamping `retry_of` (A8).** ACCEPT. Changed a decision. It
is the natural field to reach for, it is already projected by the relay projector
(`useRelayThread.ts:101`), and stamping it would delete the ORIGINAL bubble
(`Timeline.tsx:1787-1799`). The prohibition is now explicit and pinned by a test.

**13. New strings collide with a shared success label (A18, B11).** ACCEPT. The
all-delivered branch emits `Delivered N/N`, capital and success-toned, from a
function also serving native group text and broadcasts. The new strings are
scoped behind a retry-aware option so no fenced product's copy moves.

**14. There are three relay render surfaces, not one (B3).** ACCEPT. Changed a
decision - this is the unenumerated-reader class the charter exists for, and I
verified it: `useRelayThread` feeds `ConversationDetail.tsx:480`,
`TourConversation.tsx:467` and `PlacementConversation.tsx:320`, and the tour host
passes a milestone-merged item list rather than the raw thread. All three are now
in scope, with the tour host's different sibling set called out.

**15. The retry row's message-level chip is unspecified (A20).** ACCEPT. Stated,
with the note that a stuck message-level status is pre-existing for relay team
sends and is not fixed here.

**16. Hidden retry rows dilute thread paging (A16).** ACCEPT as a recorded
consequence, not a design change. `hasOlder` is a full-page heuristic
(`useRelayThread.ts:167-186`), so hidden rows make "Load older" grow the
transcript less than a page. Bounded at three rows per failed leg. Recorded in
risks.

---

## Accepted - correctness and hygiene

**17. The inbox bump can REOPEN a closed group (A10).** ACCEPT. Changed a
decision, and the sharpest finding of the round. `touchLastActivity` writes
`status = 'open'` on any non-group-text conversation
(`conversationsRepo.ts:1531-1560`), and the bump runs 60-240s after the gate
check - so a group closed during the backoff is resurrected by its own retry,
contradicting the "this group chat is now closed" message already sent. The bump
must not write status.

**18. The chip reads "1 failed" for a whole backoff interval (A11, B14).**
ACCEPT. Changed a decision. The failure SSE fires at `twilio.ts:2512` and nothing
was emitted when the claim landed, so the surface this feature exists to make
truthful would show a false terminal state for at least 60 seconds. The claim now
emits `message.persisted` itself. B14's second half - that "bump" lumped four
distinct effects together - is accepted with it: last-activity, SSE, unread and
push are now named separately, and push is explicitly NOT fired for a machine
retry.

**19. PII: the raw route passthrough puts the destination on the wire (B6).**
ACCEPT. Changed a decision, and it resolves A12/B18's four-fields-versus-three
contradiction at the same time. `GET /api/conversations/:id/messages` returns
stored rows as-is (`api.ts:2148-2199`), so a stored destination E164 reaches
every browser regardless of what the projector forwards. The destination is now
stored ONLY as a digest; the changed-number gate compares digests, and the retry
job reads the number it must send to from the live roster. Three lineage fields
reach the wire and no handset number is among them.

**20. An MMS retry duplicates media-gallery rows (A13).** ACCEPT. `append`
writes one unconditioned media-pointer row per attachment keyed by the row's own
`tsMsgId` (`messagesRepo.ts:261-279`, `:2286-2290`), and that index IS the
gallery - so a three-rung ladder triples a photo. Retry rows must not write media
pointers.

**21. The 21610 carve-out would be dropped (B7).** ACCEPT. Changed a decision.
`isTerminalDeliveryFailure` carves out BOTH 30003 and 21610, the latter being
"the platform working, not a failure" (`twilio.ts:294-314`). A purely
attempt-aware predicate turns every relay opt-out into an alarm - strictly more
than the increase the founder was asked to approve. The relay predicate keeps the
21610 carve-out; "attempt-aware INSTEAD of code-aware" was the wrong framing and
is corrected to attempt-aware ON TOP of the existing non-failure carve-out.

**22. The terminal ERROR is undeliverable for three failure modes (B8).**
ACCEPT. Changed a decision. Gate refusal, enqueue failure and the stranded claim
generate no further callback, so the handler that owns the severity decision
never runs again and the chain ends with only the WARN that claimed it. The retry
JOB now emits the terminal ERROR for the two modes it can observe; the stranded
claim remains a recorded residual, since observing it needs the reconciliation
sweep the issue puts out of scope.

**23. D22 preserved a justification already proven false for group text (A9).**
ACCEPT. `sendMessage` throws `GroupTextSendNotSupportedError`
(`sendMessage.ts:294-297`) so a group-text 30003 retry never sends - the shared
set's comment is false there too. The rewritten comment names the exception and
points at `group-text-30003-leg-retry-promise-unverified` rather than claiming
the set is correct.

**24. The persisted body must stay raw (A15, B12).** ACCEPT the finding, and
B12's fix over my own. Changed a decision. The product rule is explicit
(`relayAnnouncements.ts:122-143`): the row body is what is persisted, previewed
and inherited by the inbox preview, while the prefix belongs to the outbound LEG
only. Storing the composed body would show two different strings for one logical
message and rewrite the inbox preview. The retry row now stores the RAW body and
the resolved leg copy separately, which meets D10's actual goal - never
re-resolving a renamed sender - without inverting the rule.

**25. Sec 2's In-list understated the surfaces (A14, B3).** ACCEPT. Added: the
worker/job registration, the backoff seam, the bump caller, the three Timeline
hosts, and the bubble prop plumbing.

**26. The backoff seam has no in-repo precedent (B15).** ACCEPT. Changed a
decision. The backoffs are bare module functions with no injection point, and
"gated exactly as the other dev seams are" was not achievable - those are HTTP
routes. The backoff is now injected through the job's existing deps object, with
the lane supplying the override; the spec says plainly that this is
configuration, not structural absence, and that production keeps 60/120/240.

**27. `retrySend` is refused, not misrouted (A17, B13).** ACCEPT. `sendMessage`
throws `RelaySendNotSupportedError` before `participant_phone` is read
(`sendMessage.ts:297`). The conclusion stands; the premise was wrong and would
have sent a builder hunting a hazard that does not exist. Corrected.

**28. Citation errors (A22, A23, B21).** ACCEPT all. `TRANSIENT_RETRYING_DELIVERY_CODES`
is at `:301` not `:286` - inherited verbatim from the pre-merge issue file, which
is exactly the re-verification the spec's own base line claims to have done. Also
corrected: `:2590` to `:2574-2589`, the tourReminders import line, `buildTsMsgId`,
`retrySend.ts:148`, and D3's "discarded today" to "not used for lineage today".

**29. The digest width is unspecified (A21).** ACCEPT. Hash and width are now
fixed in the spec, since a collision dedupes a real retry into a silent
claim-loss.

---

## Round verdict

44 findings, 44 accepted in substance, 3 with a different remedy than the
reviewer proposed (2, 10, 11). Twenty-two changed a decision. Round 2 is
therefore required - this is nowhere near the terminal round.
