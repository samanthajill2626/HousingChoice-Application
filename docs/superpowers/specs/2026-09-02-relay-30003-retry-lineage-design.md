# Relay 30003 retry lineage - design

Branch: `feat/relay-30003-retry-lineage`
Worktree: `W:\tmp\relay-30003-retry-lineage`
Base: `main` @ `bb54fdaa`
Issues closed: `relay-30003-retry-lineage` (med),
`relay-30003-classified-transient-retrying` (low)
Issues filed by this mission: `relay-member-key-collapses-two-phones-one-contact`,
plus the inbound-display gap named in Sec 2.

Revision 5 (final), after adversarial review round 1 (two reviewers, 44 findings),
rounds 2 and 3 (13 each) and round 4, which changed no decision - the terminal
round. Adjudications are at
`docs/superpowers/reviews/2026-09-02-relay-30003-retry-lineage/spec-r1-adjudications.md`
and its `spec-r2-` and `spec-r3-` siblings.

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
- `app/src/repos/conversationsRepo.ts` - D16 needs a status-preserving bump and
  no such method exists: `touchLastActivity` writes `status = 'open'` in its
  primary branch and its status-free variant is a catch-branch fallback
  (`:1531-1578`). A new repo method is required, plus its caller.
- `app/src/routes/dev.ts` and the e2e lane env - the backoff injection seam.
- `dashboard/src/routes/contact/deliveryStatus.ts`,
  `dashboard/src/routes/contact/Timeline.tsx` including the `MessageBubble` and
  `StreamItem` prop plumbing,
  `dashboard/src/routes/conversation/useRelayThread.ts`,
  `dashboard/src/api/types.ts`,
  `dashboard/src/lib/messageTransport.ts:43-56` - the funnel every projected
  entry passes through.
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
  inbound (`twilio.ts:641`) and renders no VISIBLE rollup chip
  (`Timeline.tsx:837`, `:934-940`), so a sighted operator sees nothing at a
  glance when one leg of a member's message fails. Filed as its own issue on the
  founder's 2026-09-02 ruling; adding a chip to an inbound bubble needs copy the
  product has never written.

  **It does NOT follow that inbound sources render nothing.** Two of D21's three
  positions exist there: the per-recipient rows (`Timeline.tsx:948-951`) and a
  dedicated accessible-name recital built for exactly this case -
  `inboundRecipientName` (`:993-1004`, rendered `:1068-1070` as a hidden semantic
  group), which is the ONLY delivery information a screen-reader user gets from
  that bubble. Those two are IN scope on both directions. Leaving them out would
  ship a recital that recites `Undelivered - Phone unreachable (error 30003)`
  for ever on a leg whose retry delivered - a reader that actively contradicts
  the new rule, and strictly worse than today.
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
member-originated original an inbound one. An inbound row NEVER carries
`requestedTransport` (`messagesRepo.ts:913-915` forbids it), whatever its schema;
`twilio.ts:636-650` is the shape the fan-out drives today. The schema itself is
NOT fixed at 1 - it mirrors the original, for the reason in the transport-mode
paragraph below. `type` follows the original (`sms`/`mms`); the
message-level `delivery_status` is seeded `queued` and, as for every relay
source, is never advanced - the rollup is the honest surface (see D21).

**The seeded SLOT is specified too, and it is not the same question as the row.**
On a VERSIONED original the row's single-entry map seeds
`{ status: 'queued', requestedTransport: <intent>, transportAggregationState: 'planned' }`;
on a LEGACY original it seeds `{ status: 'queued' }` with no transport fields at
all.
The `planned` value is load-bearing: `setVersionedAggregationState` can only reach
`attempted` from `planned` (`messagesRepo.ts:3112-3114`, `:3126`) and throws
otherwise (`relayFanOut.ts:1418-1424`), so a slot seeded without it throws on the
very first retry send. The fan-out never hits this because its preflight seeds
`planned` (`relayFanOut.ts:1326-1339`) - and that preflight is OUTSIDE the range
D10 extracts.

Note the distinction, which is easy to invert: the inbound prohibition is on the
MESSAGE's `requestedTransport` (`messagesRepo.ts:913-915`), NOT on the slot's,
which is validated but permitted (`:922-937`). An inbound retry row's slot may and
must carry one.

**The retry row's transport MODE follows the ORIGINAL's, and the original can be
LEGACY.** Every relay source written before 2026-09-02 is legacy
(`relayFanOut.ts:791-795` is where the mode is resolved). A retry row that always
seeded a versioned slot while mirroring a legacy original would drive the
extracted body down `markRecipient`'s blind whole-slot write (`:1436-1463`),
erasing the `planned` state this decision just mandated. So the mode is resolved
from the original and the slot is seeded to match it: versioned original,
versioned slot with `planned`; legacy original, legacy slot and no aggregation
state. A retry of an old message is the ordinary case, not an edge one - the
ladder exists precisely for messages that failed to land.

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
  This orders the retry after its original in the thread. The hazard it avoids is
  narrower than "the five-row window": `bumpKey` appends U+FFFF so that window's
  bound already excludes any newer row whatever its timestamp
  (`relayFanOut.ts:771-774`, `:1465-1473`). The real hazard is a DERIVED
  timestamp - at an identical `providerTs`, `<ts>#relayretry-...` sorts BELOW
  `<ts>#team-...` and `<ts>#system-...` and would land inside the window. Note
  that the docblock's standing assumption, "relay sources are inbound, one at a
  time", is weakened by a design that appends relay-source-shaped rows on a timer.

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
- **The digest's protection is partial, and the spec must not overclaim it.**
  `relayMemberKey` falls back to `phone#<E164>` for a contact-less member
  (`messagesRepo.ts:189-193`), and contact-less members are the normal shape in
  this repo's fixtures - this feature's own e2e builds two. On those, the member
  key beside the digest already publishes the destination. That exposure is
  PRE-EXISTING (`delivery_recipients` is member-keyed and already forwarded to the
  client) and is not fixed here. The digest is still correct for contact-keyed
  members, and it is still the right claim identity for both.

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

**D8. The trigger is narrow, and it gates on the SLOT'S POST-WRITE STATE - never
on whether this callback transitioned it.** A retry is claimed only for: a
delivery-status callback resolved through the relay pointer, passing D7, with
rungs remaining, where THIS CALLBACK's error code is 30003, the leg's slot after
this callback's write is terminal, and the slot's own error code is either 30003
or ABSENT.

Three parts of that sentence are load-bearing and none is obvious:

- **The read must be CONSISTENT.** `updateRecipientDeliveryStatus` returns a bare
  boolean (`messagesRepo.ts:3516`) and `getByTsMsgId` is eventually consistent
  (`:2960-2965`), so a naive re-read after the write intermittently sees the
  pre-write slot and claims nothing - a silent, load-dependent dropped retry that
  no test would reliably catch. The repo's own answer is `getMessageConsistent`
  (`:1885`), which six sibling mutators already use - but it is a PRIVATE closure
  inside the factory (above the `return {` at `:2085`) and is not on the
  `MessagesRepo` interface, so the webhook cannot call it as things stand. Either
  expose it on the interface or have the claim path go through a repo method that
  performs the consistent read internally. Do not substitute `getByTsMsgId`.
- **The CALLBACK's code, not only the slot's.** A code-less `failed` callback
  arriving first makes the slot terminal, which then blocks the 30003 callback's
  transition, so the 30003 is never written to the slot
  (`messagesRepo.ts:3459-3466`, `:3477-3481`). Gating on the stored code alone
  would refuse a real first failure.
- **The slot's code must still be 30003 or absent.** That is what keeps the
  30007 case closed: a leg that sent, took a terminal 30007, then received a
  contradictory 30003 has a slot reading 30007, so no claim.

**Gating on `transitioned` was considered and rejected, and the reasoning must
not be lost, because the obvious version of it is wrong twice over.**

- Its apparent justification does not exist. It would supposedly stop a late
  30003 claiming a retry for a leg the fan-out already closed as 30007
  (`relayFanOut.ts:1209-1216`) or opted-out (`:1127-1130`) - but neither leg was
  ever sent, so neither has a provider SID, so neither has a `relaysid#` pointer.
  `putRelaySidPointer` is called only on the success branch (`:1263-1267`), and
  the relay branch of `/status` is reachable only through a pointer. No callback
  can ever resolve to those slots.
- It would make a crash UNRECOVERABLE. The slot write happens at
  `twilio.ts:2466-2472` and a claim must follow it. A process death in between
  leaves the slot `undelivered` with no retry row; the redelivered callback then
  transitions nothing (`ALLOWED_PRIOR` admits `undelivered` only from
  `queued`/`sent`) and a transition-gated claim would refuse for ever. Gating on
  the slot's STATE instead, the redelivery reads terminal-plus-30003, claims, wins
  the create, and recovers the retry.

The state gate still closes the one reachable contradiction - a leg that sent,
took a terminal 30007 DLR, then received a second, contradictory 30003 DLR: its
slot reads 30007, so no claim. And duplicate suppression was never this gate's
job: D3's create already dedupes a repeated callback, since the same root,
destination and attempt yield the same digest.

Note this is NOT M5's constraint 2 in either form. That trap is a claim gated on
a transition of the SAME slot every rung, which after rung 1 never transitions
again. Here each rung owns its own row and slot, and the gate reads state rather
than transition.

A synchronous 30003 at send time is not a trigger; it is not in `TRANSIENT_CODES`
and reaches the loop body's rethrow (`:1247`).

**D9. Every attempt re-runs the relay send gates, and a refusal ends the chain.**
Before sending: the group is still open; the member is still on the roster and
the digest of their current number still matches the digest this ladder was
claimed against; the member is not suppressed or opted out. A refusal writes a
terminal state on the retry leg with a close code naming the gate that refused,
claims no further rung, and emits the terminal ERROR of D23. This is what makes
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

This is a SECOND ladder inside the retry job, with a different budget and a
different backoff from the 60/120/240 retry ladder, so it is specified rather than
implied - all four of its parts live outside the extracted range and none of them
comes for free:

- The retry job itself calls `claimFanoutPass` against the RETRY row before
  re-enqueueing (the fan-out's own call is at `relayFanOut.ts:1097-1114`).
- On `capped` the job closes the retry leg terminally with the transient-cap code
  and emits the D23 terminal ERROR. `closeRelay` is a nested closure
  (`relayFanOut.ts:1060`) and is not callable from here, so the close is written
  directly, as in D14.
- The re-enqueue uses the fan-out's transient backoff shape, not the retry
  ladder's: `fanOutBackoffMs` yields 5s then 10s (`relayFanOut.ts:91-100`).
- A transient re-enqueue does NOT consume a retry rung. The rung is already
  claimed; this is the same rung trying again.

Both backoffs are injectable through the job's deps (Sec 7), or the e2e cannot
drive either.

Reusing `relay.fanOut` itself with a one-member recipient list was considered and
rejected - see Sec 10.

**D11. The retry row carries five lineage values; four reach the wire.** Stored:
the root message id, the member key of the leg being retried, the attempt number,
the DIGEST of the destination, and the ORIGINAL'S DIRECTION. The member key is
what the presenter joins on - it must match the original's slot map. The digest is
the claim identity and the changed-number gate.

The original's direction is stored because D20's render predicate needs it and
nothing else supplies it: the original may not be loaded (D22), and there is no
per-message lookup. Carrying it makes the predicate self-contained, so an orphaned
retry decides correctly with no fallback guess - and neither guess is safe
(default-render produces the duplicate member message the predicate exists to
prevent; default-hide drops half the approved contract on first load).

The raw destination is never stored, because
`GET /api/conversations/:id/messages` returns stored rows AS-IS
(`api.ts:2148-2199`) - so anything on the row reaches every browser on every relay
thread load, whatever the projector forwards. The four fields that reach the wire
are the root id, the member key, the attempt number and the original's direction.
**This is not a claim that no handset number reaches the client**: for a
contact-less member the member key IS `phone#<E164>`, and that is pre-existing (see
D5). It is a claim that this design adds none.

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

**D14. An enqueue failure closes the retry leg terminally**, with `enqueue_failed`
rather than the cap's `transient_cap`, and emits the terminal ERROR of D23. Using
one code for both would tell an operator retries ran when none did - M5's D10, and
the reason `relayFanOut` closes on `enqueue_failed` while `retrySend` does nothing.
`closeRelay` is a nested closure (`relayFanOut.ts:1060`) and is not reusable from
outside without extraction; this design writes the close directly rather than
extracting it.

**D15. The close codes are enumerated, and every one gets operator copy.** An
unmapped code falls through to `Delivery failed (error <code>)`
(`deliveryStatus.ts:731-733`), printing an app-invented token as if it were a
carrier error number - the exact defect `INTERNAL_CODE_REASONS`
(`deliveryStatus.ts:688-692`) exists to fix. So here they are, with their copy;
all four are D9's gate refusals, added to that map in the same change:

| Code | Operator copy |
|---|---|
| `retry_group_closed` | `Not retried - group closed` |
| `retry_member_removed` | `Not retried - no longer in this group` |
| `retry_number_changed` | `Not retried - number changed since` |
| `retry_opted_out` | `Not retried - opted out` |

**D14 needs no new code.** `enqueue_failed` and `transient_cap` already exist in
that map and already carry exactly D14's rationale in their docblock
(`deliveryStatus.ts:671-681`) - inventing a third for the retry ladder would
split one meaning across two tokens.

**D16. The live-surface effects are named separately, and only some fire.**
"Bump" is four distinct things and they are decided one at a time:

- **Last activity / inbox ordering:** fires after a SUCCESSFUL send, on the
  founder's 2026-09-02 ruling. **But not through a call that writes `status`.**
  `touchLastActivity` sets `status = 'open'` on any non-group-text conversation
  (`conversationsRepo.ts:1531-1560`), and the bump runs 60-240 seconds after
  D9's open-group gate - so a group closed during the backoff would be
  resurrected to `open` by its own retry, contradicting the "this group chat is
  now closed" message already sent and re-arming every open-gated path. There is
  no existing method to call: the status-free variant at `:1577-1578` is the
  CATCH-branch fallback, reached only when the condition fails, so a new repo
  method is required (Sec 2). Note the correct and intended consequence: the
  `byLastActivity` GSI is keyed `(status, last_activity_at)`
  (`conversationsRepo.ts:632`, `:699`), so a status-free bump on a closed group
  re-sorts it within the `closed` partition rather than moving it to `open`. That
  re-sort is the observable difference from doing nothing.
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

**D17. The four wire-bound lineage fields of D11 are added to `TimelineMessage`
and to the relay projector.** The raw row's unknown top-level fields do not survive the client
projectors, each of which spreads a fixed field list
(`useRelayThread.ts:69-135`, `contactTimeline.ts:406-464`,
`buildTimelineFallback.ts:64-104`). The precedent for adding one is
`imported_from`. `RelayRecipientDelivery` is NOT changed - no per-leg retry state
is stored on a slot, which is what keeps D1's promise that the failed slot is
never rewritten.

## 5. Decisions: the display contract

Approved by the founder on 2026-09-02. The rollup chip, its accessible-name
recital and the per-recipient row move together (M5's D21); the message-level
chip stays excluded.

**The contract applies to every position that EXISTS, on both source directions.**
An outbound source has all three. An inbound source has two - the per-recipient
rows and `inboundRecipientName`'s recital - and those two carry the new states
exactly as they carry today's. Only the visible chip is out of scope on an inbound
source, because there is no chip there to move (Sec 2).

**D18. A per-member RETRY STATE is derived at the join, and staleness is not
touched.** The presenter is given the recipient ENTRIES (with their keys - the
call site currently discards them at `Timeline.tsx:937`) and the retry rows that
reference this message. From those it derives, per member key, one of:
`retrying`, `delivered-on-retry`, `terminal`, or `unconfirmed`.

`unconfirmed` has TWO halves and both are required, because a ladder can go quiet
in two different places:

- a rung that never reached `sent` within `STALE_SENT_AFTER_MS` of the RETRY ROW's
  own `at` - the stranded claim; and
- a rung that DID reach `sent` and never received a receipt within
  `STALE_SENT_AFTER_MS` of its `sentAt` - the ordinary missing-DLR case.

Specifying only the first would leave a sent-but-unacknowledged rung reading
`retrying` for ever, which is the same falsehood M5 removed and the one this
design has now nearly reintroduced twice. `STALE_SENT_AFTER_MS`
(`deliveryStatus.ts:58`) is the module's only staleness budget and is reused for
both halves so two horizons cannot drift apart.

This deliberately does NOT go through `stalenessClockMs`: that helper is shared
with native group text, which Sec 2 fences out, and its refusal to age a `queued`
leg is deliberate and documented (`deliveryStatus.ts:191-201`). It also could not
express this - `bubbleClocks` yields ONE clock per bubble
(`Timeline.tsx:734-742`), and this state must be computed from one row's clock and
rendered on another's.

**But severing from that helper also severs from the only re-render driver, and
the retry state must therefore arm the ticker itself.** `tickerArmed` is computed
from `hasTickableLeg` over the RENDERED set (`Timeline.tsx:1851-1854`, `:798-812`)
and both its predicates route through `stalenessClockMs`. The original's failed
leg is terminal and can never arm it; the retry row is hidden by D20 and is not in
`visible` at all. So without an explicit clause, `tickNow` is frozen in exactly
the case this state exists for - Sec 9's stranded claim, where no SSE arrives and
no item changes - and `retrying` would be computed once and never recomputed. That
is the indefinite promise M5 removed, reintroduced one level down. `hasTickableLeg`
gains a retry-state clause so a live retry keeps the ticker running until it
resolves.

Two consequences of that clause, both of which must be honored:

- **It forces the join to THREAD level.** `hasTickableLeg` is called with
  `(item, tickNow)` over `visible` (`Timeline.tsx:798`, `:1851-1854`), and D20 has
  already filtered the retry rows OUT of `visible`. So the per-member retry state
  cannot be computed inside a bubble from its own props; it is computed once at
  the thread level, over all items including the hidden retry rows, and passed
  down - which is also where D20's own filter lives. D19's projection consumes
  that same thread-level result rather than re-deriving it.
- **It adds a FIFTH non-termination to a predicate whose docblock enumerates
  four** (`Timeline.tsx:788-812`, run-condition doc at `:1801-1815`). That
  docblock is the record of four shipped bugs on this exact axis. The new clause
  must terminate - a retry state resolves to `delivered-on-retry`, `terminal` or
  `unconfirmed` in bounded time - and the docblock must be extended to say so,
  not left describing four.

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
code's copy when a gate refused or the enqueue failed. Without that an operator
whose retry was refused because the number changed would read exactly the same
string as one whose cap ran out.

**The projection happens at THREAD level, onto the recipient ENTRIES, and nothing
downstream reads a raw slot.** The join produces, per member key, an effective
`{status, errorCode}` PLUS a separate `retryState` field - `retrying`,
`delivered-on-retry`, `terminal` or `unconfirmed`. `presentRelayDelivery`,
`orderRecipientRows` and every `recipientSummaryName` call consume that derived
set.

**It has TWO lifetimes, and collapsing them into one memo re-breaks D18.** The
LINEAGE half - which retry rows reference which member, and how each one's own leg
ended - changes only when the item set changes, so it may be memoized on `items`
like `visible` (`Timeline.tsx:1788-1800`). The TIME-DERIVED half - the two
`unconfirmed` horizons - must recompute against `tickNow`. A single
`useMemo(..., [items])` would freeze exactly the half the ticker clause was added
to drive, restoring both failures D18 exists to prevent while looking correct in
every test that asserts a final state.

**`retryState` is a separate field and must NOT be smuggled into `status`.**
`DeliveryStatus` is a closed union and `presentDeliveryStatus` returns null for
anything outside it (`deliveryStatus.ts:128-141`), so an overloaded
`status: 'retrying'` renders as NO state at all on the row and the recital, while
`presentRelayDelivery`'s counters (`:410-414`) match neither `delivered` nor
`failed` and silently drop the leg from both buckets - producing a neutral
`delivered 3/4` that looks like a message still in flight. Every consumer branches
on `retryState` explicitly; `status` keeps only values the union already admits.

**Projecting once is not a convenience.** The original's failure reason is
derived INDEPENDENTLY in FOUR places - the rollup
chip's own reason (`deliveryStatus.ts:420-427`), the rollup's accessible name
(`Timeline.tsx:959-968`, recomputing per row at `:593-597`), the inbound recital
(`:993-1004`), and the per-recipient row (`:1112-1115`) - three of which read `row.slot.errorCode`
directly, and all of which render a reason only when `presentLegDelivery` returns
`isFailure: true` (`deliveryStatus.ts:508-545`). So a projected state must move
BOTH the code and the failure-ness, and for `retrying` and `delivered-on-retry`
the failure-ness moves the other way.

Patch the rollup alone and the recital and the row keep reciting
`Undelivered - Phone unreachable (error 30003)` beside a chip that says otherwise -
M5's D21 violation exactly, and on an inbound source the recital is the only
position there is.

**The other two positions get their own grammar, stated here so a build cannot
satisfy the table with the chip alone.** The per-recipient row and the recital
recite the same fact in the row's voice:

| Retry state | Row and recital |
|---|---|
| `retrying` | `Retrying - Phone unreachable (error 30003)` |
| `delivered-on-retry` | `Delivered on retry` |
| `terminal` | `Undelivered - <reason>` (today's, with the close-code reason where one applies) |
| `unconfirmed` | today's not-confirmed row copy |

Neither position can express the first two today: the row's copy comes from
`presentLegDelivery` plus `deliveryReason` (`Timeline.tsx:1095`, `:1112-1115`),
the recital's from the same pair inside `recipientSummaryName` (`:593-597`), and
`presentDeliveryStatus` is exhaustive over `DeliveryStatus`
(`deliveryStatus.ts:139-141`). D19's projected `retryState` - NOT its
`{status, errorCode}`, which keeps only values the closed union already admits -
is what gives them an input they can express.

**A bubble can hold more than one retry state at once**, and the chip must compose
them rather than pick one: two members can fail the same message, one retrying
while the other is terminal. `presentRelayDelivery` already composes two
categories in one label (`deliveryStatus.ts:433-436`,
`delivered N/M - K failed, J not confirmed`), and the new states extend that same
comma-joined shape in a fixed order - failed, retrying, not confirmed - with
zero-count categories omitted. `on retry` is a suffix on the delivered count, not
a category, so it composes independently.

The cap-exhausted string is today's, unchanged. Every other string is new and is
scoped behind a retry-aware option on `RelayDeliveryOptions`
(`deliveryStatus.ts:351`), so the shared all-delivered label `Delivered N/N` -
capital, success-toned, and also serving native group text and the broadcasts
routes - does not move.

**D20. A retry row renders ONLY when its leg delivered AND its original was
outbound**, both read from the retry row's own stored lineage (D11) so the
predicate never depends on the original being loaded. A failed attempt records
durably but earns no bubble: the thread shows what reached someone, and a failed
retry reached no one. An inbound original's retry renders nothing, which is what
stops an inbound retry row appearing as a duplicate member message - it would
otherwise carry the same raw body, sender key and author as the original (D2, D12).

The filter lives in Timeline's `visible` memo (`Timeline.tsx:1787-1799`), the one
point all three hosts converge. The tour host feeds that memo a milestone-merged
list rather than the raw thread (`TourConversation.tsx:463-467`), so the filter
must be correct against a mixed item list, not just a message list.

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

**A fan-out or team leg that ends terminally logs ERROR whether or not a ladder
ran.** That includes the middle cases: a claim declined because `To` was missing
or malformed (D5), or because the source row could not be read (D7). Those are
real dead ends for a real tenant - the distinction that matters is the PRODUCT the
leg belongs to, not whether the ladder happened to start. The founder's
sign-off estimate covers that whole set.

**The legs D7 fences out keep WARN.** Announcements - relay intro, member-added,
group-closed and every tour-reminder rung - reach the same severity site
(`twilio.ts:2500-2511`) through the same pointers, and no retry is ever claimed
for them, so a rule of "ERROR whenever no retry was claimed" would turn every one
of them into an alarm. Alarming a tour-reminder rung from a mission whose scope
fences that file out is exactly the unrequested blast radius this design exists to
avoid. The attempt-aware ERROR applies to fan-out and team legs only.

**The terminal ERROR is emitted by whoever observes the terminal state.** Gate
refusal (D9), enqueue failure (D14) and the transient cap (D10) generate no
further callback, so the webhook handler that owns the severity decision never
runs again - the retry JOB emits those. Cap exhaustion is observed by the callback
handler. The stranded claim of Sec 9 is observed by nobody and stays a recorded
residual.

The shared `TRANSIENT_RETRYING_DELIVERY_CODES` set keeps its current values for
the 1:1 and native-group-text paths, which this branch does not touch - but its
comment is rewritten to stop asserting something the repo has already disproven
for group text: `sendMessage` throws `GroupTextSendNotSupportedError`
(`sendMessage.ts:294-297`), so a group-text 30003 retry is enqueued and never
sends. The rewritten comment names that exception and points at
`group-text-30003-leg-retry-promise-unverified` rather than implying the set is
correct everywhere.

**This raises alarm volume and needs the founder's sign-off at the spec gate.** A
terminally undelivered relay FAN-OUT OR TEAM leg begins reaching
`hc-<env>-error-logs` and the Recent Errors panel, where today it is silent.
Announcement legs and 21610 opt-outs are excluded. The set being approved is
**every fan-out or team leg that ends terminally on 30003** - whether the ladder
ran to its cap, was refused at a gate, or was never claimed at all because `To`
was missing or the source row could not be read. It is NOT limited to legs a
ladder actually ran for. The alternative - keep WARN and
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
   callback whose source row cannot be read claims nothing - D7's fence is
   fail-CLOSED, and that refusal is permanent (Sec 9).
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
9. A transient send error (429/30022) re-enqueues the SAME rung, consumes no
   retry rung, and closes terminally with the transient-cap code when the retry
   row's own pass budget caps.
10. MMS retries re-presign, preserve the original leg copy byte for byte when the
    sender's display name has changed between attempts, store the RAW body on the
    row, and add no rows to the media gallery.
11. A retry row does not carry `retry_of`, and the original bubble still renders
    beside a delivered retry.
12. Presenter: all four states of D19 at EVERY position that exists, with the
    arithmetic and the close-code projection - the chip, the rollup recital, the
    per-recipient row, AND `inboundRecipientName` on a member-originated source.
    **The inbound recital is its own test**: a member-originated leg whose retry
    delivered must stop reciting `Undelivered`, and nothing but this test covers
    the only delivery information a screen-reader user gets from that bubble. A
    non-delivered retry renders no bubble; an inbound original renders no retry
    bubble even when its retry delivered. The shared `Delivered N/N` label and
    native group text are unchanged.
13. The claim emits an SSE, so the chip reads `1 retrying` without waiting a
    backoff interval; the post-send bump does not write `status`, proven by a
    group closed mid-backoff staying closed.
14. Severity: WARN while claimed, ERROR when terminal, 21610 still carved out,
    and the 1:1 and native-group-text paths unchanged.
15. A stranded claim - a retry row created whose send never happens - reaches
    `unconfirmed` on screen with NO other thread activity and no refetch. Freezing
    the ticker is the failure mode; a test that lets another leg age proves
    nothing.
16. A crash between the slot write and the claim is RECOVERED by the redelivered
    callback: the slot already reads terminal/30003, so the state gate still
    claims. A transition gate would fail this test, which is why it exists.
17. The slot-code-ABSENT clause of D8 is exercised, not assumed reachable: a
    code-less terminal callback landing first (`canceled` maps to `failed` with no
    code, `adapters/messaging.ts:567-569`) must not stop the following 30003 from
    claiming.
18. A LEGACY original produces a legacy retry row and slot, and its send does not
    take the versioned path. Every relay source written before 2026-09-02 is
    legacy, so this is the ordinary case for an old message, not an edge one.
19. The ticker TERMINATES: a resolved retry stops arming it. Asserting that
    `unconfirmed` eventually appears is not the same test, and the four
    non-terminations already recorded in `hasTickableLeg`'s docblock are why this
    one is stated separately.

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

No infrastructure, dependency or migration work, and nothing is owed in a
deployed environment. The only environment touch is the e2e lane's backoff
override (Sec 2, Sec 7), which is lane-local and never set in dev or prod. Every
new field is
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
nothing sends, and a duplicate callback correctly declines to claim again (the
create is already lost). The leg renders `unconfirmed` rather than a permanent
`retrying` - which D18's ticker clause is what actually delivers - but the send is
genuinely lost and no ERROR is emitted, because nobody observes it. Closing this
needs the reconciliation sweep the issue puts out of scope. Recorded, not fixed.

The EARLIER window, between the slot write and the claim, is deliberately
recoverable: D8 gates on the slot's state rather than on this callback's
transition, so a redelivered callback reads terminal/30003 and claims. That choice
is what keeps the two windows from compounding.

**One unreadable source row costs both the retry and the truth about it.** D7's
fence is fail-closed, so a transient read miss on the source (`twilio.ts:2449`)
declines the claim permanently - no later callback re-opens it - and D23 then logs
that leg ERROR. The alarm is correct in kind (the leg IS a dead end) but wrong in
cause: it will read as a carrier failure when it was our read. Accepted as the
price of a fence that cannot fail open onto the tour-reminder ladder, and recorded
so the next person diagnosing such an alarm starts in the right place.

**A delivered outbound MMS retry shows its attachments in two bubbles.** D13
suppresses the media-POINTER rows, so the gallery index is correct, but each
bubble renders its own `media_attachments` (`Timeline.tsx:1036`). This is
arguably right - a retry IS a second send that carried the photo again - but it is
a visible consequence of D13 plus D20 and is recorded so nobody reads
"adds no rows to the media gallery" as "looks identical in the thread".

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
