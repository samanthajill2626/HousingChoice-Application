# Message transport fidelity plan review R1-B

Verdict: FAIL for implementation launch.

Counts: 0 BLOCKING, 2 HIGH, 1 MEDIUM.

## 1. [HIGH] Relay preflight creates a permanently pending sender slot for inbound sources

What is wrong: Task 5 requires preflight to initialize and mark `planned` "every
current member" before any send (plan:721-729), then requires every version-1
current-roster member to be initialized (plan:780-784). That includes the sender
of an inbound relay source. The existing sender is deliberately excluded from the
set of recipients which ever reaches the suppression, attempted, and result paths.
The newly created sender slot therefore remains queued/planned forever and appears
in the inbound relay disclosure as a recipient who was never a recipient.

Evidence: the approved spec says the worker still resolves membership where it does
today (spec:418-425), but current `relayFanOut` derives recipients by excluding
`payload.senderKey` (`app/src/jobs/relayFanOut.ts:398-405`,
`app/src/jobs/relayFanOut.ts:434-438`). All subsequent sends iterate only that
filtered collection (`app/src/jobs/relayFanOut.ts:443-455`). Inbound relay messages
are persisted with an empty delivery map before that job runs
(`app/src/routes/webhooks/twilio.ts:581-601`). The plan's aggregation presenter
treats `planned` as incomplete (plan:1248-1259), so the invented slot cannot
self-heal.

Remedy: define the preflight candidate set as the exact eligible-recipient set
(current roster after the existing sender and continuation recipient-key filters),
not all current members. Add an inbound-relay test proving the sender gets no slot,
is absent from the recipient disclosure, and cannot keep the disclosure pending.

## 2. [HIGH] The fake callback plan cannot carry the evidence it promises to test

What is wrong: Task 8 only names the fake signer and describes extending its
`BuildStatusInput` with `from`, `to`, `channelPrefix`, and `channelMetadata`
(plan:942-961, 1031-1052). The existing fake status-callback control stores only a
`DeliveryProfile`; it has no fields for any of that evidence, and the engine calls
the signer with only SID, status, and error code. Extending the signer alone leaves
the normal delivery-outcome/control path unable to emit the documented callback
shapes. This defeats the promised signed fake status-callback proof for RCS,
fallback, and conflict behavior.

Evidence: `DeliveryProfile` has only kind, stall/fail state, and error code
(`fake-twilio/src/engine/types.ts:20-28`). `MessagingEngine.setDeliveryOutcome()`
stores that profile unchanged (`fake-twilio/src/engine/engine.ts:167-169`), and its
scheduled callback passes only `messageSid`, `status`, and optional `errorCode` to
`buildStatusParams` (`fake-twilio/src/engine/engine.ts:495-502`). The approved spec
requires fake status callback input/output for documented `From`, `MessageSid`,
`ChannelMetadata`, and RCS-only `ChannelPrefix` (spec:795-800).

Remedy: add the optional safe evidence controls to `DeliveryProfile` and the
control-route DTO, propagate them through the engine to `buildStatusParams`, and
add engine/control tests proving they survive the real signed callback path. Keep
the direct signed fixture only as an additional harness, not the substitute for the
fake-provider control contract.

## 3. [MEDIUM] The repository interface names a type that does not exist

What is wrong: Task 3's proposed `RecipientSendResultPatch` declares
`status: RelayRecipientStatus` (plan:487-493), but the repository's existing slot
uses `DeliveryStatus` and there is no `RelayRecipientStatus` declaration in the
repository. A literal implementation of the plan fails typecheck before the
repository contract can be exercised.

Evidence: `RelayRecipientDelivery.status` is declared as `DeliveryStatus`
(`app/src/repos/messagesRepo.ts:142-149`), and repository delivery update methods
also take `DeliveryStatus` (`app/src/repos/messagesRepo.ts:1312-1364`). A repository
search finds no `RelayRecipientStatus` symbol.

Remedy: change the produced interface to `status: DeliveryStatus` (or explicitly
introduce and prove an equivalent alias before use), then make the Task 3 contract
test compile against the exported public method signature.
