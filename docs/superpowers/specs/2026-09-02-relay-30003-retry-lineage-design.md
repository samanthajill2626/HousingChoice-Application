# Relay 30003 retry lineage - design

Branch: `feat/relay-30003-retry-lineage`
Worktree: `W:\tmp\relay-30003-retry-lineage`
Base: `main` @ `bb54fdaa`
Issues closed: `relay-30003-retry-lineage` (med),
`relay-30003-classified-transient-retrying` (low)
Issues filed by this mission: `relay-member-key-collapses-two-phones-one-contact`,
plus the inbound-display gap named in Sec 2.

Revision 2, after adversarial review round 1 (two reviewers, 44 findings). The
adjudications are at
`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/spec-r1-adjudications.md`.

Read `docs/issues/relay-30003-retry-lineage.md` first, including its
"Design knowledge from M5" section. This document does not restate it; it
decides against it.

## 1. The contradiction

A relay group message fans out one physical send per member. When a carrier
rejects one leg with error 30003 (unreachable handset), that member never
receives the message and nothing tries again. Where the dashboard shows
per-recipient delivery at all it is truthful about the failure - M5 removed the
false "will retry" promise - so the current state is a visible dead end: the
operator is told plainly that one person was missed and is offered nothing.

The server disagrees with itself about the same leg.
`TRANSIENT_RETRYING_DELIVERY_CODES` (`app/src/routes/webhooks/twilio.ts:301`)
still classifies 30003 as "still auto-retrying, not yet terminal", and
`isTerminalDeliveryFailure` (`:310`) reads it to log a failed relay leg at WARN
rather than ERROR - keeping it out of the `hc-<env>-error-logs` alarm and the
Recent Errors panel. No relay retry exists, so the recorded justification is
false. That is the second issue, and it is the server-side half of the same
contradiction: both halves are fixed here, together, because making a retry real
changes which of them is true.

**Why relay legs cannot reach the existing 1:1 ladder.** It is not merely that
the relay branch returns early. The 30003 arm (`twilio.ts:2711`) sits downstream
of a gate that requires a persisted message row for the provider SID
(`:2574-2589`), and a relay leg has none - it is a slot inside another message's
recipient map, reached through a `relaysid#` pointer. The ladder is structurally
unreachable, so this work branches inside `handleRelayRecipientStatus` rather
than extending that switch. `retrySend` is also unusable directly, and for a
stronger reason than "it would text the wrong number": `sendMessage` refuses a
relay conversation outright (`app/src/services/sendMessage.ts:297`,
`RelaySendNotSupportedError`) before `participant_phone` is ever read, and
`retrySend` catches the refusal and stops (`retrySend.ts:209-217`).

## 2. Scope

**In:**

- `app/src/routes/webhooks/twilio.ts` - the relay branch (claim, SSE) and the
  severity taxonomy.
- A new retry job under `app/src/jobs/`, its registration in
  `app/src/jobs/registerHandlers.ts` and the worker wiring.
- `app/src/jobs/relayFanOut.ts` - extraction of the per-leg send unit.
- `app/src/repos/messagesRepo.ts` - lineage fields and the media-pointer
  suppression for retry rows.
- The conversation bump caller for D13.
- `app/src/routes/dev.ts` and the e2e lane env - the backoff injection seam.
- `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/contact/Timeline.tsx` including the `MessageBubble` and
  `StreamItem` prop plumbing,
  `dashboard/src/routes/conversation/useRelayThread.ts`,
  `dashboard/src/api/types.ts`.
- All THREE hosts that mount the relay Timeline:
  `dashboard/src/routes/conversation/ConversationDetail.tsx:480`,
  `dashboard/src/routes/tours/TourConversation.tsx:467`,
  `dashboard/src/routes/placements/PlacementConversation.tsx:320`. The tour host
  passes a milestone-merged item list rather than the raw thread, so its sibling
  set differs and must be handled explicitly.
- `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`.

**Out - hard fences:**

- `services/relayAnnouncements.ts` behavior and every announcement caller,
  including `jobs/tourReminders.ts`. Announcements are never retried
  (`relayAnnouncements.ts:169-171`); D5 fences them out rather than changing
  that.
- Native group-text receipts and the existing 1:1 retry/collapse behavior. The
  presenter is shared; that is not a reason to change them. In particular
  `stalenessClockMs` is NOT modified (D18).
- **The rollup chip's `outbound` gate.** A member-originated relay source is
  inbound (`twilio.ts:641`) and renders no rollup chip and no accessible-name
  recital (`Timeline.tsx:837`, `:934-940`), so the dominant relay case shows
  nothing about who received a message. The retry ships for BOTH directions;
  the visible contract lands only where a rollup renders today. Filed as its own
  issue on the founder's 2026-09-02 ruling.
- The relay member-key scheme. One contact on two numbers still collapses into
  one delivery slot. Filed as
  `relay-member-key-collapses-two-phones-one-contact`; D3 works around it.
- Any status-polling or missed-callback reconciliation sweep. The issue excludes
  it; Sec 9 records what that leaves exposed.
- `ALLOWED_PRIOR` and the forward-only status machine. Untouched - the whole
  point of D1 is that nothing needs promoting.

## 3. Decisions: the claim and the ladder

**D1. A retry is a NEW source message row, not a promotion of the failed leg.**
The failed slot is never rewritten. The retry row carries its own single-entry
recipient map whose leg runs `queued -> sent -> delivered` - transitions the
status machine already permits - so no exception to `ALLOWED_PRIOR` is created
and a late callback from an older attempt still cannot regress anything. This is
the decision that dissolves the state machine three of M5's review rounds failed
to converge, and it is only available because the founder approved a display
contract that permits a second bubble (Sec 5).

**D2. The retry row MIRRORS its original's `direction`, `author` and
`relay_sender_key`.** Both resulting shapes already exist in the product and
neither is invented here: a team original yields an outbound retry row, a
member-originated original an inbound one. An inbound row carries
`transportSchemaVersion: 1` and NO `requestedTransport`
(`messagesRepo.ts:913-915` forbids it; `twilio.ts:636-650` is the shape the
fan-out drives today). `type` follows the original (`sms`/`mms`); the
message-level `delivery_status` is seeded `queued` and, as for every relay
source, is never advanced - the rollup is the honest surface (see D21).

**D3. The claim is the row's `sid#<providerSid>` pointer, created atomically
with the row.** `append` runs a transaction whose index 1 is that pointer, and
attributes a dedupe to index 1 ONLY (`messagesRepo.ts:2295-2306`); a condition
failure on the row's own key at index 0 is logged and RETHROWN (`:2374-2388`).
So the claim must be carried by a deterministic provider SID, not by a
deterministic sort key.

- The provider SID is `relayretry-<digest>-<n>`, where `<digest>` is the first
  16 hex characters of the SHA-256 of `<root tsMsgId>|<destination E164>` and
  `<n>` is the attempt number. Sixteen characters is fixed here deliberately: a
  collision does not error, it dedupes, which would silently convert a real
  retry into a reported claim-loss.
- The SID contains no `#` (`splitTsMsgId` splits on the first one,
  `messagesRepo.ts:204-209`) and no phone number.
- `providerTs` is a WALL CLOCK taken at claim time, not derived from the root.
  This orders the retry after its original in the thread and keeps it out of the
  fan-out's five-row source-read window (`relayFanOut.ts:771-779`, whose docblock
  assumes relay sources arrive one at a time).

A duplicate callback, a redelivered callback and two concurrent callbacks all
lose this create and return `deduped: true`, claiming nothing.

**D4. A duplicate QUEUE delivery is defeated by a job-execution marker, not by
the claim.** The claim lives in the webhook; the retry JOB performs no create, so
an SQS redelivery would re-send with nothing to lose. The retry job therefore
calls `putJobExecutionMarker` before any send, exactly as
`relayFanOut.ts:732-744` and `retrySend.ts:129-146` do. The two guards are
distinct and both are required: **the create defeats duplicate CALLBACKS, the
marker defeats duplicate DELIVERIES.**

**D5. The ladder is keyed on the DESTINATION PHONE from the callback's `To`, and
stored only as a digest.** `params['To']` is in scope at the relay branch
(`twilio.ts:2457`) and is the member's own handset for this send path
(`relayFanOut.ts:1169` through the adapter's `messages.create`). It is not used
for lineage today: the relay branch passes `direction: 'outbound'` into
`normalizeTransportEvidence`, whose `to` is read only on the inbound branch
(`twilioMessageTransport.ts:145-155`), so it is neither validated nor persisted.

- Keying on the destination rather than on `relayMemberKey` keeps a retry
  unambiguous about which handset it is retrying even where two of a contact's
  numbers have collapsed into one slot.
- `To` is normalised and validated as E164 before use. **Missing or malformed
  means DO NOT CLAIM** - it must never silently mint a different digest and thus
  a parallel ladder.
- Only the DIGEST is stored (see D11). The changed-number gate compares digests;
  the retry job reads the number it actually sends to from the live roster.

**D6. Attempt numbering, cap and backoff match the 1:1 policy exactly**: up to
three retries at 60s, 120s and 240s (`retrySend.ts:37`, `:39-42`). Matching
rather than diverging is what lets this inherit the standing quiet-hours position
unchanged - `quiet-hours-ungated-automated-paths` already recommends accepting
automatic delivery retries as an explicit exemption because the ladder puts the
last attempt about seven minutes after the original send. That decision does not
need reopening, and this design does not reopen it.

**D7. The fence is POSITIVE.** Claim only when the source row is PRESENT, carries
a `relay_sender_key`, and that key is not the system value. A negative test fails
open: `source` is `MessageItem | undefined` at `twilio.ts:2449` and the handler
already tolerates undefined, so a transient read miss on an announcement's source
row would pass "must not be system" and claim a retry against a tour-reminder
rung. `SYSTEM_SENDER_KEY` has one writer (`relayAnnouncements.ts:239`), the single
append behind all four announcement callers, so the positive test cleanly
separates fan-out and team legs from announcement legs. The test asserts the
VALUE, not the imported constant. A retry row inherits the original's sender key
(D2), so its own failures continue the same chain.

**D8. The trigger is narrow, and it IS gated on the slot transition.** A retry is
claimed only for: a delivery-status callback resolved through the relay pointer,
reporting a failure, carrying error code 30003, passing D7, with rungs remaining,
AND where `updateRecipientDeliveryStatus` actually transitioned the slot
(`twilio.ts:2466-2472`).

**This looks like M5's constraint 2 and is not, and the reason must not be lost.**
Constraint 2 says a claim gated on the transition caps the ladder at rung 1 -
true when every rung writes the SAME slot, because after the first failure the
slot is already `undelivered` and nothing transitions. Under D1 each rung lands
on its OWN row's fresh slot, which always transitions. The gate is therefore safe,
and it is also necessary: it is what stops a late 30003 callback claiming a retry
for a leg the fan-out already closed for a different cause - a 30007 marked
failed synchronously (`relayFanOut.ts:1209-1216`) or an opted-out leg (`:1127-1130`).
A synchronous 30003 at send time is not a trigger; it is not in `TRANSIENT_CODES`
and reaches the loop body's rethrow (`:1247`).

**D9. Every attempt re-runs the relay send gates, and a refusal ends the chain.**
Before sending: the group is still open; the member is still on the roster and
the digest of their current number still matches the digest this ladder was
claimed against; the member is not suppressed or opted out. A refusal writes a
terminal state on the retry leg with a close code naming the gate that refused,
claims no further rung, and emits the terminal ERROR of D22. This is what makes
acceptance criterion 8 true.

**D10. The per-leg send is EXTRACTED from the fan-out and shared, not
reimplemented.** The loop body at `relayFanOut.ts:1118-1269` carries the
transport-fidelity machinery merged on 2026-09-02 - the prepare/send split, the
aggregation-state writes, the refusal and transient-code arms. A retry job that
reimplemented it would fork code that is hours old. The extraction is
behavior-preserving and the existing relay suites are its proof.

**Its transient arm needs an owner.** The extracted body defers a 429 or 30022 to
a continuation that lives OUTSIDE the extracted range (`:1227-1246`, continuation
at `:1097-1114`), which the retry job does not have - the leg would sit `queued`
and the chain would end silently. Ending the chain on a rate-limit is the wrong
answer for the code that most means "try again". **On a transient send error the
retry job re-enqueues the SAME rung**, bounded by the retry row's own
`claimFanoutPass` budget. That budget is legitimate and unshared: the retry row is
a different message, so M5's constraint 5 holds.

Reusing `relay.fanOut` itself with a one-member recipient list was considered and
rejected - see Sec 10.

**D11. The retry row carries four lineage values; three reach the wire.** Stored:
the root message id, the member key of the leg being retried, the attempt number,
and the DIGEST of the destination. The member key is what the presenter joins on -
it must match the original's slot map. The digest is the claim identity and the
changed-number gate.

The raw destination is never stored, because
`GET /api/conversations/:id/messages` returns stored rows AS-IS
(`api.ts:2148-2199`) - so anything on the row reaches every browser on every
relay thread load, whatever the projector forwards. The three fields that reach
the wire are the root id, the member key and the attempt number; no handset
number is among them.

**D12. The retry sends the original outbound representation, with the raw body
stored and the leg copy stored separately.** The product rule is explicit
(`relayAnnouncements.ts:122-143`): the row body is what is PERSISTED, previewed
and inherited by the inbox preview, while the sender prefix belongs to the
outbound LEG only, applied by `composeRelayBody` (`relayFanOut.ts:192-196`,
applied at `:998`) and never persisted. Storing the composed body on the retry
row would show two different strings for one logical message and rewrite the
inbox preview. So the retry row stores the RAW body, and the exact leg copy is
stored separately and sent verbatim - which meets the actual goal, never
re-resolving a sender whose display name changed between attempts.

**D13. Attachments are re-presigned on every attempt, and a retry row writes no
media-pointer rows.** A presigned URL is never replayed
(`relayFanOut.ts:1160-1167`, `retrySend.ts:149-176`). But `append` writes one
UNCONDITIONED media-pointer row per attachment keyed by the row's own `tsMsgId`
(`messagesRepo.ts:261-279`, `:2286-2290`), and that index IS the "Media from
comms" gallery - so a three-rung ladder would triple a photo in it. Retry rows
must suppress those pointers while still carrying the durable `s3Key`s they
re-presign from.

**D14. An enqueue failure closes the retry leg terminally**, with a close code
distinct from cap-exhausted, and emits the terminal ERROR of D22. Reusing one
code would tell an operator retries ran when none did - M5's D10, and the reason
`relayFanOut` closes on `enqueue_failed` while `retrySend` does nothing.
`closeRelay` is a nested closure (`relayFanOut.ts:1060`) and is not reusable from
outside without extraction; this design writes the close directly rather than
extracting it.

**D15. The close codes are enumerated, and every one gets operator copy.** An
unmapped code falls through to `Delivery failed (error <code>)`
(`deliveryStatus.ts:731-733`), printing an app-invented token as if it were a
carrier error number - the exact defect `INTERNAL_CODE_REASONS`
(`deliveryStatus.ts:688-692`) exists to fix. Every code this design introduces -
the gate refusals of D9 and the enqueue failure of D14 - is added to that map
with its copy, in the same change.

**D16. The live-surface effects are named separately, and only some fire.**
"Bump" is four distinct things and they are decided one at a time:

- **Last activity / inbox ordering:** fires after a SUCCESSFUL send, on the
  founder's 2026-09-02 ruling. **But not through a call that writes `status`.**
  `touchLastActivity` sets `status = 'open'` on any non-group-text conversation
  (`conversationsRepo.ts:1531-1560`), and the bump runs 60-240 seconds after
  D9's open-group gate - so a group closed during the backoff would be
  resurrected to `open` by its own retry, contradicting the "this group chat is
  now closed" message already sent and re-arming every open-gated path.
- **SSE:** fires when the CLAIM lands, not only after the send. The failure
  callback emits `message.persisted` at `twilio.ts:2512` and nothing else was
  emitted until the send, so the chip would read `1 failed` for the whole first
  backoff interval - a false terminal state, for at least 60 seconds, on the
  surface this feature exists to make truthful.
- **Unread counts:** unchanged. A machine retry of a message already delivered
  to the thread is not new unread traffic.
- **Push:** never. A retry must not ring staff devices for machine-initiated
  traffic.

## 4. Decisions: what a retry looks like on the wire

**D17. Three lineage fields are added to `TimelineMessage` and to the relay
projector.** The raw row's unknown top-level fields do not survive the client
projectors, each of which spreads a fixed field list
(`useRelayThread.ts:69-135`, `contactTimeline.ts:406-464`,
`buildTimelineFallback.ts:64-104`). The precedent for adding one is
`imported_from`. `RelayRecipientDelivery` is NOT changed - no per-leg retry state
is stored on a slot, which is what keeps D1's promise that the failed slot is
never rewritten.

## 5. Decisions: the display contract

Approved by the founder on 2026-09-02. The rollup chip, its accessible-name
recital and the per-recipient row move together (M5's D21); the message-level
chip stays excluded. **The contract applies to sources that render a rollup
today, i.e. outbound ones** - see Sec 2's fence.

**D18. A per-member RETRY STATE is derived at the join, and staleness is not
touched.** The presenter is given the recipient ENTRIES (with their keys - the
call site currently discards them at `Timeline.tsx:937`) and the retry rows that
reference this message. From those it derives, per member key, one of:
`retrying`, `delivered-on-retry`, `terminal`, or `unconfirmed`.

`unconfirmed` is a rung that has not reached `sent` within the budget, measured
from the RETRY ROW's own `at`. This deliberately does NOT go through
`stalenessClockMs`: that helper is shared with native group text, which Sec 2
fences out, and its refusal to age a `queued` leg is deliberate and documented
(`deliveryStatus.ts:191-201`). It also could not express this - `bubbleClocks`
yields ONE clock per bubble (`Timeline.tsx:734-742`), and this state must be
computed from one row's clock and rendered on another's.

**D19. The four end states, with the arithmetic stated.** `failed > 0` is the
FIRST branch (`deliveryStatus.ts:416`), so without explicit arithmetic every
state below collapses into today's failure string.

| Retry state | Counted as | Original bubble | Retry bubble |
|---|---|---|---|
| `retrying` | subtracted from `failed`, added to a new retrying count | `delivered 3/4 - 1 retrying` (danger, not success) | none |
| `delivered-on-retry` | subtracted from `failed`, added to `delivered` | `delivered 4/4 - 1 on retry` | `delivered 1/1 on retry` |
| `terminal` | left in `failed` | `delivered 3/4 - 1 failed - <reason>` | none |
| `unconfirmed` | subtracted from `failed`, added to `not confirmed` | `delivered 3/4 - 1 not confirmed` | none |

`<reason>` is the carrier reason when the cap was exhausted, and the D15 close
code's copy when a gate refused or the enqueue failed - **projected onto the
ORIGINAL's presentation through the same join**, because the refused retry row
has no bubble of its own to carry it. Without that projection an operator whose
retry was refused because the number changed would read exactly the same string
as one whose cap ran out.

The cap-exhausted string is today's, unchanged. Every other string is new and is
scoped behind a retry-aware option on `RelayDeliveryOptions`
(`deliveryStatus.ts:351`), so the shared all-delivered label `Delivered N/N` -
capital, success-toned, and also serving native group text and the broadcasts
routes - does not move.

**D20. A retry row renders ONLY when its leg delivered AND its original is
outbound.** A failed attempt records durably but earns no bubble: the thread
shows what reached someone, and a failed retry reached no one. An inbound
original renders no rollup at all, so its retry renders nothing either - which is
also what stops an inbound retry row appearing as a duplicate member message.

This is a new predicate, NOT a reuse of `retry_of`. **The retry row must not
carry `retry_of` at all.** It is the natural field to reach for, it is already
projected by the relay projector (`useRelayThread.ts:101`), and stamping it would
add the ORIGINAL to `supersededIds` and delete the original bubble from the
thread (`Timeline.tsx:1787-1799`) - inverting the contract exactly.

**D21. "Retrying" appears only where a retry was actually claimed**, derived from
a retry row, never from the error code. The retry bubble's own message-level chip
is not specified beyond today's behavior: relay source rows never advance their
message-level `delivery_status`, so a retry row inherits that pre-existing
quirk and it is not fixed here.

**D22. An orphaned retry bubble reads honestly.** Thread history pages 50
newest-first (`threadPaging.ts:30`), so a retry can render before its original has
loaded. The `on retry` suffix is what keeps that bubble from reading as a phantom
second send. The reverse case - original loaded, retry not - falls back to today's
copy: stale, not false.

## 6. Decisions: the log taxonomy

**D23. The relay severity call becomes attempt-aware ON TOP of the existing
non-failure carve-out, not instead of it.** A relay leg logs at WARN while a
retry is actually claimed, and at ERROR once the chain is terminal.

**21610 keeps its carve-out.** `isTerminalDeliveryFailure` carves out both 30003
and 21610 (`twilio.ts:294-314`), the latter being a provider-side opt-out - "the
platform working, not a failure". A purely attempt-aware predicate would turn
every relay opt-out into an alarm, which is a strictly larger increase than the
one this section asks the founder to approve.

**The terminal ERROR is emitted by whoever observes the terminal state.** Gate
refusal (D9) and enqueue failure (D14) generate no further callback, so the
webhook handler that owns the severity decision never runs again - the retry JOB
emits those. Cap exhaustion is observed by the callback handler. The stranded
claim of Sec 9 is observed by nobody and stays a recorded residual.

The shared `TRANSIENT_RETRYING_DELIVERY_CODES` set keeps its current values for
the 1:1 and native-group-text paths, which this branch does not touch - but its
comment is rewritten to stop asserting something the repo has already disproven
for group text: `sendMessage` throws `GroupTextSendNotSupportedError`
(`sendMessage.ts:294-297`), so a group-text 30003 retry is enqueued and never
sends. The rewritten comment names that exception and points at
`group-text-30003-leg-retry-promise-unverified` rather than implying the set is
correct everywhere.

**This raises alarm volume and needs the founder's sign-off at the spec gate.** A
terminally undelivered relay leg begins reaching `hc-<env>-error-logs` and the
Recent Errors panel, where today it is silent. The alternative - keep WARN and
rewrite the comment to say "a single relay leg is not alarm-worthy at this
volume" - is honest and cheaper, and the issue offers both. The recommendation is
attempt-aware, because after this change a terminal relay failure is a real dead
end for a real tenant and nothing else will surface it.

## 7. What must be proven

Test intentions. The plan owns seams and mechanics.

1. A forward relay 30003 callback claims exactly one retry and enqueues it.
   **Must fail on `main`** - nothing is claimed there.
2. **Two guards, tested separately.** A duplicate or concurrent CALLBACK loses
   the create and sends nothing. A duplicate JOB DELIVERY is stopped by the
   execution marker. A test that exercised only the create would pass while the
   queue hazard shipped live.
3. The ladder reaches rung 3 and stops. **Assert three retries, not "a retry
   happened"** - the weaker assertion is what M5's constraint 2 passes.
4. An announcement leg claims nothing, including a tour-reminder rung - AND a
   callback whose source row cannot be read claims nothing (the fail-open case).
5. A gate refusal - group closed, member removed, number changed, opted out -
   sends nothing, ends the chain, and shows the refusal reason on the ORIGINAL's
   presentation. The changed-number case is its own test: it is what D5's digest
   exists for.
6. An enqueue failure still reaches a terminal state, with a close code distinct
   from cap-exhausted, and both codes render as prose rather than as
   `Delivery failed (error <token>)`.
7. Other members receive no duplicate send, on every rung.
8. A delivered retry cannot be regressed by a late callback from an older
   attempt.
9. A transient send error (429/30022) re-enqueues the same rung and does not
   consume a retry rung, bounded by the retry row's own budget.
10. MMS retries re-presign, preserve the original leg copy byte for byte when the
    sender's display name has changed between attempts, store the RAW body on the
    row, and add no rows to the media gallery.
11. A retry row does not carry `retry_of`, and the original bubble still renders
    beside a delivered retry.
12. Presenter: all four states of D19 at all three positions, with the arithmetic
    and the close-code projection; a non-delivered retry renders no bubble; an
    inbound original renders no retry bubble. The shared `Delivered N/N` label and
    native group text are unchanged.
13. The claim emits an SSE, so the chip reads `1 retrying` without waiting a
    backoff interval; the post-send bump does not write `status`, proven by a
    group closed mid-backoff staying closed.
14. Severity: WARN while claimed, ERROR when terminal, 21610 still carved out,
    and the 1:1 and native-group-text paths unchanged.

**E2E (hermetic).** `relay-30003-no-retry-promise.spec.ts` is UPDATED, not
replaced - it is the checklist for what the new copy must satisfy, and its
negative assertions all survive. The flow: arm one leg to fail 30003, send, watch
the chip go retrying, let the retry land, and assert the original reads
`delivered 2/2 - 1 on retry` beside a second bubble reading
`delivered 1/1 on retry`, with the reachable member having received the body
exactly once. The fake's delivery arming is one-shot per destination, so the
retry naturally lands clean as the next message to that handset.

The 60-second first rung needs the backoff to be injectable. There is no
precedent for a worker-side dev seam - the backoffs are bare module functions
(`retrySend.ts:39-42`, `relayFanOut.ts:91-100`) and no env override exists - so
the backoff is injected through the retry job's existing deps object with the
lane supplying the value. **This is configuration, not structural absence**, and
the spec says so plainly; production keeps 60/120/240.

## 8. Post-merge obligations

No infrastructure, dependency, environment or migration work. Every new field is
optional and self-creating; a message row written before this branch has no
lineage fields and reads as an original.

Owed at handback:

1. Both issues closed with Resolution stamps; `npm run issues` re-run.
2. `relay-member-key-collapses-two-phones-one-contact` left OPEN, with this
   branch's two workarounds recorded in it.
3. The inbound-display gap filed as its own issue, with the three affected hosts
   named.
4. `quiet-hours-ungated-automated-paths` NOT closed, but annotated: relay retries
   now exist and inherit its item-3 recommendation unchanged.

## 9. Risks and residual exposures

**A crash between the claim and the enqueue strands a retry.** The row exists,
nothing sends, and a duplicate callback correctly declines to claim again. The
leg renders `unconfirmed` rather than a permanent `retrying`, so the display
stays honest, but the send is genuinely lost and no ERROR is emitted - nobody
observes it. Closing this needs the reconciliation sweep the issue puts out of
scope. Recorded, not fixed.

**The member-key collapse is worked around, not fixed.** Where two of a contact's
numbers share one slot, the retry knows exactly which handset it is retrying but
displays against a slot that already conflated two legs. The display was already
wrong in that case; this does not make it worse.

**Hidden retry rows dilute thread paging.** Every attempt appends a real row and
D20 renders almost none of them, while `hasOlder` is a full-page heuristic
(`useRelayThread.ts:167-186`). A group with several unreachable handsets can fill
part of a 50-row page with rows that render nothing, so "Load older" grows the
transcript by less than a page. Bounded at three hidden rows per failed leg.

**The first observable `To` arrives at `sent`.** The fake emits no callback for
the initial `queued` transition (`fake-twilio/src/engine/engine.ts:500-501`),
which is fine for a failure callback but means nothing in-repo exercises a
callback with `To` absent. D5's "missing means do not claim" is therefore
unit-tested rather than exercised end to end.

## 10. Alternatives rejected

**In-place promotion** - a per-member attempt map on the source row, an explicit
scoped exception to `ALLOWED_PRIOR`, effective status stored on the slot. This is
the issue file's own suggested fix and what M5 could not converge. It requires
the nested-map seeding pattern, an exception to a rule that exists to stop late
callbacks un-failing legs, and it yields one bubble - contradicting the approved
display contract. Rejected on all three counts.

**Reuse `relay.fanOut` with a one-member list.** On a synthetic single-recipient
source it double-prefixes the body (`composeRelayBody`, `:992-998`), can silently
send nothing when the sender-key filter removes the target (`:1019`), re-reads the
source through a five-row window rather than a point get (`:771-779`), and drops
the retry silently on a closed group (`:757`). Four behavior changes inside the
hottest relay path, inherited by every ordinary send, to save one extraction.

**A dedicated claim item** (a `relayretry#` row with a conditional `ADD`,
mirroring the `relaysid#` pointer) - a clean fallback if the append transaction
had carried no usable claim. It does: the `sid#` pointer at index 1 is exactly
that mechanism, already built and already the thing `append` reports dedupes on.
A second item would have to be kept consistent with the row for no gain.
