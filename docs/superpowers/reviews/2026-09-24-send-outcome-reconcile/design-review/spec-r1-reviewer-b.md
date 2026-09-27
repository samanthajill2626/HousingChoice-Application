# Spec review R1 - reviewer B (adversarial)

Spec: `docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`
(commit 66f2a363 on `feat/send-outcome-reconcile`, cut from main@685f2ede).

Method: every claim about current behavior below was checked against the
file:line cited. Anything not verifiable from the repo is marked UNVERIFIED.
No file other than this one was edited; no suite or server was run.

Severity key: BLOCKING = the build cannot proceed correctly as specified;
HIGH = ships a defect of the class this branch exists to remove (double text,
stranded recipient, silent loss); MEDIUM = wrong or missing rule a builder will
trip on; LOW = worth a sentence.

---

## 1. [BLOCKING] A broadcast's post-send bookkeeping failure becomes a confirmed double text

**What is wrong.** In `broadcastFanOut` the per-recipient `try` wraps not just
`sendMessage` but the writes AFTER a successful send: `recordRecipient` (slot
`sent`), `bumpStats`, the progress emit and `tokenBucket.acquire`
(`app/src/jobs/broadcastFanOut.ts:413-447`; catch at `:490`). A DynamoDB throttle
on `setRecipient` after Twilio accepted the text lands in that catch as a plain
AWS error. The spec routes every error the classifier "cannot place" to
`unknown` (D2) and hands `unknown` to the reconcile job (D7). The reconcile then
lists the recipient's messages and, per D13, "drop[s] any whose SID we already
hold (a `sid#` message pointer ... resolves)". `sendMessage` already appended
the row, and `append` writes the `sid#` pointer in the same transaction
(`app/src/repos/messagesRepo.ts:10-13`). So the real message is discarded as
"ours", no survivor remains, the window closes `never_sent` (D13), and D16
re-drives the recipient: a second text.

**Evidence.** broadcastFanOut.ts:413-447, :490, :505; messagesRepo.ts:10-13;
spec D2, D7, D13, D16.

**What it implies.** The spec's own rules turn the most common transient fault
(DynamoDB throttle / TransactionInProgress, the trigger in
`accepted-send-lost-when-append-fails`) into the double text the invariant in
Sec 1 forbids. The spec must state that ONLY an error thrown by the send call
itself (the D3 typed errors) is classified, and that a failure after
`sendMessage` returned carries a known SID and is completed or adopted with that
SID, never looked up. "Where a line goes belongs to the plan" does not cover
this: it is a classification decision, and the spec's D2/D13 combination
decides it wrongly.

---

## 2. [BLOCKING] The `never_sent` re-drive is unbuildable as specified: no slot hand-off, and the shared pass cap usually refuses it

**What is wrong.** D16 re-drives a `never_sent` recipient by enqueueing a
`broadcast.send` / `relay.fanOut` continuation "for that one recipient under the
existing pass cap". Three facts in the code break this:

1. The pass counter is ONE per broadcast / per relay source
   (`broadcastsRepo.ts:650-689`, `messagesRepo.ts:3515-3560`, cap 3). The
   re-drive pass claims a rung like any pass (`broadcastFanOut.ts:335-351`,
   `relayFanOut.ts:1114-1135`). The reconcile window is ~5 minutes; the main
   ladder is over in ~15-30 seconds. In the canonical ambiguous-outcome scenario
   (a Twilio outage) D9 brakes every pass and the ladder runs to rung 3, so
   EVERY re-drive gets `capped`. Even without an outage, three `never_sent`
   recipients on one broadcast take rungs 2, 3 and then `capped`.
2. A capped pass runs close B over its `pending` set, which is exactly the
   re-driven recipient. D8 says the cap-closes SKIP `send_unconfirmed` slots.
   If the verdict handler leaves the code in place, the slot is skipped, stays
   `queued` forever with no owner (the reconcile already ended), and the
   broadcast is never finalized - the anchor's own symptom ("row left
   `sending`"), recreated by the fix. If the handler rewrites the code first,
   close B stamps `transient_cap` and the "re-drive" never re-sends anything.
   The spec does not say which; D7 says the slot is "OWNED by its reconcile job
   until the verdict lands" and never says what the `never_sent` verdict writes.
3. The re-drive spends a rung the main ladder may still need, and it is a new
   producer of concurrent `relay.fanOut` envelopes for the same source - the
   precondition of the deferred `relay-fanout-active-pass-cap-close-race`. Sec 2
   says this branch "does not touch the pass claim"; the re-drive does.

**Evidence.** broadcastsRepo.ts:650-689; messagesRepo.ts:3515-3560;
broadcastFanOut.ts:274-311, :335-351; relayFanOut.ts:1081-1135; spec D7, D8,
D9, D16, Sec 2 out-list; docs/issues/relay-fanout-active-pass-cap-close-race.md.

**What it implies.** The builder must invent the hand-off state and the cap
semantics, and either choice as written produces a stranded slot or a re-drive
that never sends in the scenario it exists for. The E2E spec
(`drop_before_create` on one broadcast recipient) passes only because it has a
single unknown and an unspent ladder, so it will not catch this. The spec needs
an explicit rule: what the verdict writes before re-driving, whether the
re-drive consumes the shared rung or has its own budget, and what a capped
re-drive writes.

---

## 3. [HIGH] D11's "a redelivery re-runs it safely" is false: the reconcile's enqueues are neither conditional nor idempotent

**What is wrong.** D11 drops the run-once marker on the grounds that "every
write it makes is conditional or idempotent (D15)". But three of the reconcile's
effects are ENQUEUES: the next-check continuation (D13), the `never_sent`
re-drive of `broadcast.send` / `relay.fanOut` / `relay.retryLeg` (D16). An SQS
redelivery of a reconcile run that already enqueued (handler threw after the
enqueue, DeleteMessage failed, worker killed before delete, or a >120s run -
the consumer has no visibility heartbeat, `app/src/adapters/sqsJobConsumer.ts`
has no ChangeMessageVisibility) enqueues again under a fresh jobId. Two check
chains run in parallel and each can reach `never_sent`; two re-drives each
clear their own marker, find the slot non-terminal and send. Both send sites
skip only a TERMINAL slot (`broadcastFanOut.ts:362`, `relayFanOut.ts:1322`).

The repo already documents this exact trap for the relay retry rung:
`docs/issues/relay-retry-stranded-claim-window.md`, "WARNING - do not fix it by
re-enqueueing ... a rung that is merely delayed in the queue ... would be
enqueued a second time under a new job id, clear its own marker, find the slot
still non-terminal, and text the member twice." D16's relay-retry-rung arm
("enqueue the same `relay.retryLeg` rung") is that fix.

**Evidence.** spec D11, D13, D16; relayRetryLeg.ts:350-359 (marker is per
jobId); broadcastFanOut.ts:362; relayFanOut.ts:1322; infra/modules/jobs/main.tf:36
(120s visibility); the issue file above. Test intention 6 ("re-drives exactly
once") runs one delivery and cannot see this.

**What it implies.** Either the reconcile keeps a marker and gets its retry some
other way, or every enqueue is gated by a conditional state transition on the
slot (and the spec must then close the flip-then-crash window that gating
opens). As written, "throw to retry" plus unconditional enqueues re-creates the
double text the marker exists to prevent.

---

## 4. [HIGH] The classifier rule "reads `code` then `status`, exactly as `errorCodeOf` does" cannot implement D1's 4xx/5xx split

**What is wrong.** D1 keys `rejected` on "any Twilio 4xx with a code other than
20429" and `unknown` on "any 5xx". The mechanism D1 prescribes reads `code`
FIRST and falls back to `status` only when `code` is absent
(`errorCodeOf`, `broadcastFanOut.ts:163-172`; `relayFanOut.ts:1647-1656`;
`providerErrorCode`, `messaging.ts:546-555`). twilio-node's `RestException`
sets BOTH: `status` = HTTP status, `code` = the body's Twilio code
(`node_modules/twilio/lib/base/RestException.js:4-21`, twilio 6.0.2). A Twilio
5xx carries a Twilio code in its JSON body, so a code-first reader sees e.g.
"20500" and never learns it was a 5xx. Whether that lands in `rejected` or
`unknown` then depends on an implementation detail the spec does not state -
and landing in `rejected` is exactly the D2 trap Sec 11 warns about (a text that
may have gone out, marked Failed with a Retry).

**Evidence.** RestException.js:4-21; broadcastFanOut.ts:163-172; spec D1 table
vs D1 prose.

**What it implies.** The spec must require the classifier to read `status` as a
first-class input (5xx or absent status => never `rejected`), not "exactly as
errorCodeOf". Test intention 1 should include a 5xx RestException with a
Twilio code.

---

## 5. [HIGH] MAX_HOP_COUNT = 10 is not budgeted, and the reconcile's own enqueue failure has no verdict path

**What is wrong.** Every `enqueue` from inside a job adds a hop; beyond 10 it
throws "runaway job loop guard" (`app/src/jobs/jobs.ts:37`, `:164-171`;
hopCount carried by `dispatchJob`, `:308`). D13 schedules every re-check as a
continuation job, so each check spends a hop. A broadcast chain already spends
hops 1-3 on its ladder (route -> pass 1 -> 2 -> 3), the reconcile starts at hop
4, a ~5 minute backoff window is ~6 checks (hops 4-9), and the `never_sent`
re-drive is hop 10. Relay sources flushed by `relayQueuedMessages` start deeper
(`app/src/services/relayQueuedMessages.ts:93` enqueues from a job context). One
more check, or one more ladder rung, and the re-drive or the next check throws.
The spec fences `jobs.ts` (Sec 2), so the cap cannot move. D14 gives a verdict
only for the PASS's enqueue throwing; the reconcile's own enqueue throwing is,
under D11, a job throw: five redeliveries, five `job failed` ERROR lines
(`jobs.ts:331-340`), DLQ, and the slot left `queued`/`send_unconfirmed` with no
owner and the broadcast never finalized.

**Evidence.** jobs.ts:37, :164-171, :308, :331-340; spec D11, D13, D14, Sec 2.

**What it implies.** The spec must state the hop budget as a constraint on the
check schedule and give the reconcile's own enqueue failure a terminal write
(unresolved), as D14 does for the pass.

---

## 6. [HIGH] Broadcast finalize now has N concurrent writers, is not idempotent, and nothing guarantees it runs at all

**What is wrong.** Today exactly one pass chain is in flight per broadcast, so
"my `transientRemaining` is empty" at `broadcastFanOut.ts:631` meant "done". This
branch adds N reconcile handlers (D16 "After any verdict write ... the handler
finalizes") and N re-drive passes, each of which is an ordinary `broadcast.send`
pass whose trailing finalize (`:631`) runs regardless of other chains. D8 only
stops a pass that sees a `send_unconfirmed` slot; a re-driven slot (or a main
ladder still holding 429-deferred slots) is plain `queued`. So:

- premature finalize: a re-drive pass marks the broadcast `sent` while another
  chain still has queued recipients;
- duplicate side effects: `finalize` appends a `broadcast_sent` unit-audit row
  every time it runs (`broadcastFanOut.ts:683-689`) and `flipStatus` is
  unconditional (`broadcastsRepo.ts:446-472`), so each writer adds another
  "sent" entry on the property's Activity card;
- lost finalize: the handoff is check-then-skip on both sides using
  `getById`, which is eventually consistent (`broadcastsRepo.ts:403-406`). The
  pass reads the reconcile's slot as still open and skips; the reconcile reads
  the pass's last slot as still open and skips; nobody finalizes and the
  broadcast stays `sending` - the anchor symptom again.

Sec 5 asks the plan to show finalize is "safe to reach from two writers"; the
mechanism has more than two, and safety (no double effect) is only half - the
spec states no liveness rule (at least one finalize, on a consistent read).

**Evidence.** broadcastFanOut.ts:631, :667-701; broadcastsRepo.ts:403-406,
:446-472; spec D8, D16.

---

## 7. [HIGH] Adoption status is wrong in the common cases: known-SID skips the read, `queued` strands broadcast slots, and the list-to-pointer gap loses receipts

**What is wrong.**

- D13 says a known SID (`SendAcceptedNotRecordedError`) needs "no lookup",
  yet D15 justifies reading the provider status precisely because "Receipts
  that arrived BEFORE the adoption were dropped by the fenced webhook". The
  known-SID case has the same dropped receipts (the webhook retries once after
  2.5s then drops, `routes/webhooks/twilio.ts:313`, `:3213-3227`) and the
  append has already burned its retries, so it adopts the create-time status
  (almost always `queued`) and freezes there.
- `mapTwilioStatus` maps `accepted`/`queued`/`sending` to `queued`
  (`messaging.ts:558-574`). Under A2P throughput limits a message can sit
  queued at Twilio for seconds to minutes, i.e. at list time. D16's broadcast
  row lists only `sent`/`delivered`/`failed`. A broadcast slot adopted `queued`
  is non-terminal (`isTerminal`, `broadcastFanOut.ts:133-137`), so the verdict
  handler never finalizes, no pass ever lists it again, and the receipt rollup
  never finalizes broadcasts (`rollIntoBroadcast`, twilio.ts:3557-3687): stuck
  `sending`. The existing fan-out never writes a dispatched broadcast slot as
  `queued` for exactly this reason (comment at twilio.ts:3569-3574: "it must NOT
  start at 'queued', a continuation pass re-sends queued slots").
- A broadcast slot adopted `sent` from Twilio's `sent` needs `carrierSentAt`
  stamped; otherwise `deriveBroadcastStats` counts it `sending` and the row
  reads "Sending..." until a later DLR, forever on carriers that send none
  (broadcastsRepo.ts:235-242; the stamp is only written by the webhook,
  twilio.ts:3619-3645).
- A receipt arriving between the list read and the pointer write is dropped
  and never redelivered (the webhook acks 200 on an unknown SID), so the slot
  freezes at the listed status. D15's forward-only rule protects against
  regression but not against this gap.

**Evidence.** spec D13, D15, D16; messaging.ts:558-574; broadcastFanOut.ts:133-137;
twilio.ts:313, :3213-3227, :3557-3687; broadcastsRepo.ts:216-265.

**What it implies.** The spec needs: a status fetch for the known-SID case, a
broadcast-specific adoption mapping (dispatched => `sent`, Twilio `sent` =>
`sent` + `carrierSentAt`), and an ordering rule (pointer first, then re-read)
that closes the receipt gap.

---

## 8. [HIGH] The anchor is declared closed while the same strand remains reachable on every recipient; Sec 9 mis-files the residue as "before the first send"

**What is wrong.** Sec 9 files "a database failure before the first send in
either fan-out (outside the per-recipient try)". Those calls are not before the
FIRST send - they run for EVERY recipient, outside the try:

- broadcast: `resolveContact`, the no_contact / skip / no_consent
  `recordRecipient` + `bumpStats`, `createOrGetByParticipantPhone`
  (`broadcastFanOut.ts:366-410`);
- relay: `isMemberSuppressed` reads, `tokenBucket.acquire`, media `presign`,
  `setVersionedAggregationState` (`relayFanOut.ts:1324-1382`), and the
  post-send `persistRelayRecipientResult` + `putRelaySidPointer`
  (`relayFanOut.ts:1450-1467`).

Any of them throwing on recipient 3 of 800 still exits the loop, is suppressed
by the marker, and strands 4..800 silently - precisely the anchor's described
failure. The relay post-send pair is also the relay form of
`accepted-send-lost-when-append-fails` (provider accepted, slot and pointer not
written), for a caller Sec 2 names as an adopter, yet D3's typed errors cover
only `sendMessage`.

**Evidence.** broadcastFanOut.ts:366-410; relayFanOut.ts:1324-1382, :1450-1467;
docs/issues/throw-for-redelivery-defeated-by-job-marker.md; spec Sec 1 table
("closes"), Sec 9.

**What it implies.** Either scope the claim honestly ("closes the send-error
throw; per-recipient non-send throws remain, filed as ...") with a correct
description, or handle them. As written, the follow-up issue will be scoped to
pre-loop reads and the anchor will be closed with its symptom live.

---

## 9. [MEDIUM] Adoption bypasses every side effect the status webhook runs on a terminal status

**What is wrong.** D15 adopts "an already-failed one as failed with its error
code" but D16 lists only slot/row writes and a stats bump. The webhook, on a
transitioned terminal status, also: claims the relay 30003 retry ladder
(`twilio.ts:3000-3007`), enqueues the 1:1 30003 `retrySend`
(`:3350-3369`), flags `sms_unreachable` on 30005/30006 (`:3371+`), records
21610 suppression (`:3470+`), raises placement attention (`:3338-3340`), emits
the `delivery_failed` marker feeding the DeliveryFailures metric
(`:3279-3289`, relay `:3045+`) and the SSE `message.persisted`. An adopted leg
that Twilio already reports `undelivered`/30003 therefore never gets its retry
ladder; an adopted 30006 never flags the landline.

The broadcast adopt also omits what the fan-out does after a successful send:
the `listing_sent` milestone and the `listingSends.recordSend` row
(`broadcastFanOut.ts:453-489`, which feed "Sent to tenants" / "Properties
sent"), and the inbox touch, audit row and SSE emits `sendMessage` makes
(`sendMessage.ts:432-448`). D16's "the write `sendMessage` would have made"
covers only the row.

**Evidence.** as cited; spec D15, D16.

---

## 10. [MEDIUM] D7's slot "ownership" is declared but not enforced at either send site

**What is wrong.** D7 says a `send_unconfirmed` slot is OWNED by its reconcile
job; D8 enforces that only at the cap-closes and the continuation payload. The
send paths skip only terminal slots (`broadcastFanOut.ts:362`,
`relayFanOut.ts:1322`), and the slot stays `queued` for the whole ~5 minute
window. Any duplicate full-roster envelope in that window sends to it again
while the reconcile may also adopt the original. A production-reachable
duplicate producer already exists (overlapping `relayQueuedMessages` flushes,
per `relay-fanout-active-pass-cap-close-race`). Today the equivalent window for
a 429-deferred slot is seconds; this widens it to minutes.

**Evidence.** broadcastFanOut.ts:362; relayFanOut.ts:1322; relayQueuedMessages.ts:93;
the deferred issue file; spec D7, D8.

**What it implies.** The send loops must skip `send_unconfirmed` unless the pass
is the re-drive for that key - which is the same hand-off decision finding 2
says is missing.

---

## 11. [MEDIUM] `sentAt` on an unconfirmed slot contradicts the field's contract and D15

**What is wrong.** D7 writes "the attempt start as its `sentAt`". The dashboard
documents relay `sentAt` as "the PROVIDER's timestamp, written only by the two
relay send paths after a real send returned"
(`dashboard/src/routes/contact/deliveryStatus.ts:153-158`), and the retry join
treats a parseable `sentAt` as proof the rung reached sent
(`relayRetryJoin.ts:184-197`). On versioned rows `applyRecipientSendResult`
writes `sentAt` with `if_not_exists` (`messagesRepo.ts:3422-3426`), so:

- D15's "the provider's creation time as the send time" is silently dropped;
- after a `never_sent` re-drive the new send's provider timestamp is also
  dropped, the leg keeps the ~5-minute-older attempt clock, and staleness
  ("Queued/Sent - not confirmed") fires ~5 minutes early.

`BroadcastRecipient` has no `sentAt` field at all (`broadcastsRepo.ts:118-138`),
so D7's rule adds an unmentioned field to the broadcast slot.

**Evidence.** as cited; spec D7, D15.

---

## 12. [MEDIUM] Unenumerated reader: the relay retry join projects an unresolved rung onto the ROOT leg as a hard failure

**What is wrong.** D16's relay-retry-rung `unresolved` writes the RETRY row
`failed` + `send_unconfirmed`. `projectOneLeg` step 4 then copies the last
rung's close code onto the ROOT slot and marks it `terminal`
(`dashboard/src/routes/contact/relayRetryJoin.ts:405-415`; `failed` is a
terminal rung status, `:90-93`). The root's status is `undelivered` (it failed
30003 - that is why a ladder exists). D20 and D21 key on "a `failed` slot with
`send_unconfirmed`", so this leg stays in K (`deliveryStatus.ts:483-488`, hard
failed + terminal), the chip reads "1 failed", `isFailure: true` offers Retry,
and the reason is the D20 "Couldn't confirm ... Check the conversation before
resending" text - a Retry beside a sentence saying the text may have gone out.
The row (`presentLegDelivery` falls through to `presentDeliveryStatus('undelivered')`,
`deliveryStatus.ts:766-769`) shows "Undelivered", also a failure.

**Evidence.** relayRetryJoin.ts:90-93, :405-415; deliveryStatus.ts:483-488,
:766-769; spec D16, D20, D21 ("three render positions").

**What it implies.** D20/D21 must key on the code alone (as `contact_opted_out`
already does, `deliveryStatus.ts:449`, `:689`) and name the retry-join
projection as a fourth position.

---

## 13. [MEDIUM] D11 and D13 disagree about what a failed lookup does

**What is wrong.** D11: "a throw inside it is a real retry, and five failures
reach the DLQ". D13: "Provider unreachable for the whole window (every check
threw): `unresolved`". If a failed `listMessages` propagates (D11), SQS
redelivers the SAME check after the 120s visibility timeout, five times, then
DLQ - the check-number window never advances and `unresolved` is unreachable,
and each attempt logs a `job failed` ERROR (`jobs.ts:331-340`), contradicting
"exactly one ERROR" per unresolved verdict (D16). If it is caught and scheduled
as the next check, D11's rationale does not apply to the provider path at all.

**Evidence.** spec D11, D13, D16; jobs.ts:331-340; infra/modules/jobs/main.tf:36,41.

---

## 14. [MEDIUM] `date_created` has one-second resolution; a sub-second "clock allowance" discards the real orphan

**What is wrong.** D13 keeps listings "created at or after the attempt start
minus a small clock allowance". Twilio returns `date_created` as an RFC 2822
string, deserialized by the SDK with `rfc2822DateTime`
(`node_modules/twilio/lib/rest/api/v2010/account/message.js:200`) - whole
seconds. The fake does the same (`fake-twilio/src/routes/rest.ts:66`,
`toUTCString()`). An attempt started at 12:00:01.900 whose message is stamped
12:00:01 is filtered out by any allowance under one second, the window closes
`never_sent`, and the recipient is re-driven: a double text. The spec does not
state the lower bound, and hermetic tests would pass or fail depending on where
in the second the send lands.

**Evidence.** message.js:200; rest.ts:66; spec D13, D17.

---

## 15. [MEDIUM] Load-bearing Twilio behaviors the reported spike did not establish (UNVERIFIED)

**What is wrong.** Sec 1 reports the spike verified idempotency-key behavior and
list lag for a just-created message. D13/D17 additionally depend on:

- List ORDER and the one-page bound: D17 says "newest first, bounded to one
  page". Twilio's Messages list is ordered by DateSent (the only date filter
  the SDK exposes is `DateSent`, message.js:476-480); where a
  created-but-not-yet-sent message (null DateSent) sorts is UNVERIFIED. For a
  To/From pair with more than one page of history (a relay pool number and an
  active member; the business number and a long-running tenant) the orphan may
  be off page 1, which reads as `never_sent` - a double text.
- Body round-trip: the hash match assumes the listed `body` equals the string
  sent. If the Messaging Service applies Smart Encoding or any other body
  transformation, the stored body differs (UNVERIFIED either way) and every
  orphan with a curly quote, em dash or emoji - common in relay and
  operator-typed broadcast copy - fails to match and is re-sent.

**What it implies.** Both need spike evidence recorded in the spec before the
`never_sent` arm (the only arm that can double-text) is built on them.

---

## 16. [MEDIUM] D12 carries only a digest, but D13/D17 need clear To/From - and the spec never says where they come from

**What is wrong.** D12 puts the recipient and sender in the payload "as the
digest form the relay retry claim already uses". That digest is
`sha256(rootTsMsgId|E164)` truncated (`app/src/lib/relayRetryClaim.ts:25-30`):
one-way, and keyed by a relay root message id that broadcast and 1:1 owners do
not have. D17's `listMessages({ to, from, createdAfter })` needs the clear
numbers. The reconcile must therefore re-resolve them from the owner (roster
member, contact, conversation `participant_phone`, pool number, business
number) and compare digests, as `relayRetryLeg` does (`relayRetryLeg.ts:534-546`).
The spec does not say so, and does not say what happens when the member was
removed, the phone changed, or the 1:1 sender is unset (dev: `sendMessage.ts:383`
falls back to no `from`). Separately, a broadcast owner reference is a
contactKey, which is `phone#<E164>` for contact-less recipients
(`broadcastsRepo.ts:163-165`) - a phone in the clear, contradicting D12.

---

## 17. [MEDIUM] `never_sent` means two different things, and `retrySend` is underspecified

**What is wrong.** For the fan-outs `never_sent` is trusted enough to re-send
(D16). For `retrySend` the same verdict "ERROR and end the chain ... a second
automated attempt after an ambiguous one is not worth a double text" - i.e. the
spec does not trust it there. One of the two is wrong; if the verdict can be
wrong, the fan-out re-drive is a double-text path. The log level also
conflicts: D16 says `never_sent` logs WARN, the `retrySend` row says ERROR.
Sec 4 says the kinds apply to `retrySend` "with the variant in D13"; the
variant is in D16, and D5 (mark the recipient failed), D6 (join
`transientRemaining`) and D9 (brake) have no meaning for a single-message job
with no slot and no continuation set. Test intention 8 covers only `found` and
`never_sent`.

**Evidence.** spec Sec 4 intro, D5, D6, D9, D16; retrySend.ts:194-229.

---

## 18. [MEDIUM] D9 brakes on `retryable` outcomes, where its cost rationale does not apply

**What is wrong.** D9's justification is the 30-second SDK timeout per
`unknown` recipient (confirmed: `RequestClient.js` default timeout 30000). A
`retryable` outcome (20429, ECONNREFUSED) returns fast. Braking on it defers the
whole untried remainder; with the broadcast ladder at 10s then 20s
(`broadcastFanOut.ts:92-94`) and relay at 5s then 10s, a throttle burst lasting
~30 seconds that hits the first three sends of each pass closes most of the
audience `transient_cap` without ever attempting them. Without the brake those
recipients would each be tried and most would succeed as the limit resets.

**Evidence.** spec D9; broadcastFanOut.ts:80-94; relayFanOut.ts:83-101.

---

## 19. [MEDIUM] D22 plus D9: an outage broadcast with zero confirmed sends finalizes `sent`

**What is wrong.** D22 routes unresolved recipients to `unconfirmed` so that
"finalize's all-failed rule does not read an all-unconfirmed broadcast as
failed". In the scenario D9 exists for, the result is not all-unconfirmed: three
unknowns per pass become `unconfirmed`, and the braked remainder closes
`transient_cap` (`failed`). `finalize`'s rule is `stats.failed >= total`
(`broadcastFanOut.ts:690`); failed is total minus the unconfirmed few, so the
broadcast is marked `sent` - the list pill says "Sent" and the Failed filter
hides it - although not one text is known to have gone out.

**Evidence.** broadcastFanOut.ts:690-693; spec D9, D22, test intention 10.

---

## 20. [MEDIUM] Sec 1's invariant is a slogan the mechanism does not deliver

- "nobody is ever texted twice": `never_sent` is inferred from absence over a
  bounded ~5 minute window, during the incidents (outage, timeouts) when
  Twilio's list lag is least known. A message that surfaces after the window
  and the re-drive both deliver. The honest statement is "not texted twice
  unless the provider's list lags beyond the window" (plus findings 1, 3, 10,
  14, 15).
- "never by asking staff to guess": the `unresolved` copy tells staff to
  "Check the conversation before resending" (D20), but an unresolved
  broadcast/relay send has no message row, so the conversation cannot show it.
- "Every recipient ... reaches a terminal state": besides the D14 crash window
  (acknowledged), a reconcile that reaches the DLQ (D11) leaves its slot
  `queued`/`send_unconfirmed` with no owner and its broadcast `sending`; the
  spec names the alarm (Sec 10) but not the stranded state or its recovery.

---

## 21. [MEDIUM] "D15 makes that harmless" is false for alerting, and the E2E `accept_then_drop` expectation cannot be met

**What is wrong.** Sec 2 accepts that the fenced webhook drops a callback for an
unheld SID at ERROR and calls it harmless. Every `found` adoption is preceded by
such callbacks (the first check is at least 5 seconds after the send; receipts
typically land within seconds), each logged at ERROR after one 2.5s retry
(`twilio.ts:313`, `:3222-3225`). The `hc-<env>-error-logs` burst alarm fires at
5 errors in 300s (`infra/modules/observability/main.tf:150-176`), so two
adopted messages page an operator for a condition the platform resolved - while
D16 deliberately logs `found` at INFO. In the hermetic lane, fake-twilio fires
the whole callback progression at 0/150/300 ms (`fake-twilio/src/engine/delivery.ts:29-31`),
so for `accept_then_drop` every receipt precedes the adoption and is dropped;
the E2E expectation "ends with the leg delivered and its receipt routed" is not
reachable by the mechanism (the status can only come from the list read).

---

## 22. [LOW] Kill-switch handling is ambiguous and D23's "new code" is not new

There are two `SmsSendingDisabledError` classes. The wrapper's extends
`SendRefusedError` with code `sms_sending_disabled` (`sendMessage.ts:89-93`) and
is thrown before the adapter (`:286-289`); the broadcast catch turns every
`SendRefusedError` into `skipped` (`broadcastFanOut.ts:491-503`), and D3 says
`SendRefusedError` is unchanged - yet D5 says the kill-switch is recorded
`failed` with `sms_sending_disabled`. The adapter's class has no `code` or
`status` (`messaging.ts:383-388`), so a classifier that "reads code then
status" places it `unknown`, not `rejected`, without an explicit instanceof
rule. D23 lists `sms_sending_disabled` among codes "this branch writes"; it is
already written on broadcast skipped slots (`broadcastFanOut.ts:495`) and
already has copy in `ScheduledCard.tsx:24`, `DeadlinesNudgesCard.tsx:65`,
`api/types.ts:1356`.

## 23. [LOW] D4 would count connection failures as throttles

D4 fires `send_throttled` "on the retryable provider codes"; D1's `retryable`
includes ENOTFOUND/ECONNREFUSED/EAI_AGAIN. The SendThrottled alarm's description
reads a hit as a TPS-budget breach (`infra/modules/observability/main.tf:223-225`).
Restrict the marker to 20429/429/30022.

## 24. [LOW] Smaller inaccuracies

- Sec 1: the relay fan-out recognises 30007 and 429/30022 only, not 30005/30006
  (`relayFanOut.ts:1409-1446`).
- D2: "the cost of a wrong `unknown` is one reconcile lookup" - it is a window
  of checks, a held-open slot/broadcast for ~5 minutes, and a re-drive.
- D11: "the only path in the app where throw to retry is true" - inbound email
  ingestion already relies on redelivery to the DLQ (`app/src/services/inboundEmail.ts:18-25`, `:416-420`).
- The spec cites review history in `design-review/`; that directory was empty
  at review time, so the spec must stand alone.
- Scope omits `BroadcastStats` literals in `app/src/lib/seed/matrix.ts:1219,1247`
  and `app/src/lib/seed/performance.ts:995-1041`, and the typed SSE payload in
  `app/src/lib/events.ts:149`, all of which see the new `unconfirmed` bucket.
