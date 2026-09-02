# Task 13 final invariant audit - message transport fidelity

Date: 2026-09-01
Scope: read-only source and targeted-test inspection at `61c02428` before the final mainline sync. No broad suite or E2E command ran.

## Verdict

**CONFORMS.** No P1, P2, or P3 finding reached a concrete, reachable gap. The remaining unversioned `type` declarations are deliberate legacy, import, fixture, or non-carrier paths; no inspected v1 presentation flow derives transport from them.

## Mutation classification

| Surface | v1/requested transport | actual/status and result behavior | Result |
| --- | --- | --- | --- |
| Direct 1:1, broadcast, retry | `app/src/services/sendMessage.ts:384-428` classifies immediately before prepared provider send and appends v1 requested transport. Broadcast and retry use this service. | Adapter result can carry normalized actual; status callback later writes independently. | CONFORMS |
| Relay team source, including held source | `app/src/routes/api.ts:1693-1727,1800-1817` appends source/slots with requested intent. | Fan-out owns each leg's result evidence. | CONFORMS |
| Relay inbound and closed-group intake | `app/src/routes/webhooks/twilio.ts:620-634,995-1035` append v1 inbound with no requested fact. | Normalized inbound actual is optional. | CONFORMS |
| Native group source and slots | `app/src/services/groupSend.ts:607-686` appends v1 source plus each requested slot. | Group adapter fact is copied to source/non-suppressed slots. | CONFORMS |
| Native group inbound | `app/src/routes/webhooks/twilio.ts:1733-1746` appends v1 inbound. | Adapter rail fact supplies actual. | CONFORMS |
| Relay fan-out / continuation / suppression | Versioned preflight at `app/src/jobs/relayFanOut.ts:841-906` initializes and transitions only executable slots. | `applyRecipientSendResult` preserves request, first SID/time, actual and error fields. | CONFORMS |
| Persisted announcements | `app/src/services/relayAnnouncements.ts:193-220` creates v1 source/planned requested slots. | `:247-355` writes excluded/attempted/result facts through same primitive. | CONFORMS |
| Callbacks and group receipts | Status routes `twilio.ts:2433-2465,2517-2605`; receipt service `groupReceipts.ts:394-505`. | Status, actual, SID and SSE work independently. | CONFORMS |
| Repository boundary | `app/src/repos/messagesRepo.ts:894-935,2963-3348`. | Validates carrier/v1/inbound shape; conditional child-field writers protect concurrent evidence. | CONFORMS |

## Reader and renderer classification

| Reader / renderer | Evidence | Result |
| --- | --- | --- |
| Server/API projection | `app/src/routes/contactTimeline.ts:419-435` uses presence-preserving fields; raw conversation APIs return the stored message fields. | CONFORMS |
| Dashboard types and mappers | `dashboard/src/api/types.ts:1557-1559`; `buildTimelineFallback.ts:70-93`; `useRelayThread.ts:108-126`. | CONFORMS |
| Main transport chip | `dashboard/src/lib/messageTransport.ts:111-131` uses legacy `type` only for schema-absent rows; inbound is actual-only; outbound follows requested/pair/mixed rules. | CONFORMS |
| Recipient disclosure / aggregate | `dashboard/src/routes/contact/Timeline.tsx:796-800,836-844,882-921,1094-1100`. | Slots never replace an inbound relay source's main chip. | CONFORMS |
| Exclusions | The shared filtered recipient entries keep `contact_opted_out` rows and omit only excluded rows without that code. | CONFORMS |
| Optimistic UI | `useContactTimeline.ts:262-290`, `useGroupThread.ts:107-129`, `useRelayThread.ts:248-271` stamp `optimistic: true` with no v1 facts; presenter suppresses carrier label at `messageTransport.ts:114-117`. | CONFORMS |

## Evidence-boundary classification

| Source | Evidence and boundary | Result |
| --- | --- | --- |
| Provider evidence | `app/src/adapters/twilioMessageTransport.ts:99-172`: RCS metadata/From/prefix precede SID; inbound SM/MM requires E.164 `To`; outbound RCS fallback requires non-channel E.164 `From`. | CONFORMS |
| Missing/conflicting evidence | Same normalizer returns missing/conflict; webhook logs safe conflict facts at `twilio.ts:349-367` and does not write actual. | CONFORMS |
| Non-evidence | Body, attachment list, `NumMedia`, status, conversation kind, and legacy `type` are never passed to actual-transport writers. Their remaining use is content/media/failure behavior. | CONFORMS |
| Group MMS authority | `groupConversations.ts:38-46,806-838` owns the Group MMS fact; webhook calls that adapter boundary at `twilio.ts:1742`; receipt only corroborates/conflicts at `groupReceipts.ts:394-442`. | CONFORMS |
| Fake provider | `e2e/fixtures/fakeTwilio.ts:39-45,102-145`, `fake-twilio/src/engine/engine.ts:167-169`, and `signer.ts:32-76,205-220` accept only explicit `rcs` ChannelPrefix. | CONFORMS; no fabricated SMS/MMS prefix. |

## Watch items with reachability proof

| Watch item | Concrete proof | Result |
| --- | --- | --- |
| Schema-absent Relay legacy path | Dispatcher branches before classification at `relayFanOut.ts:415-419` into `runLegacyRelayFanOut` (`539-545`); legacy result uses only `setRecipientDelivery` (`956-990`). Tests spy continuation and held release at `relayFanOut.test.ts:166-193,432-450`; repo no-op contract at `messagesRepo.transport.test.ts:137-167`. | CONFORMS |
| Stored request before status normalization | Relay gets stored slot request at `twilio.ts:2433-2449`; direct resolves stored message before normalize at `2517-2595`. `twilioStatusWebhook.test.ts:151-176` proves request-dependent classification and legacy status preservation. | CONFORMS |
| Preflight eligible set | Current roster then continuation restriction at `relayFanOut.ts:597-603`; exact recipients initialize before first send at `851-906` then send loop begins at `638-708`. Removed never-attempted slots alone become excluded. | CONFORMS |
| Independent status/write | Direct/relay status then actual calls are separate (`2450-2465,2596-2605`); receipt actual/status/SID are independent (`434-505`); SSE condition is `transitioned || transportUpdated` (`2496-2505,507-535`). Test: `twilioStatusWebhook.test.ts:106-126`. | CONFORMS |
| Same-status transient cleanup | `messagesRepo.ts:3221-3308` fills absent SID/time/actual and clears transient error without status regression. Tests: `messagesRepo.transport.test.ts:302-439`. | CONFORMS |
| Group MMS fact authority | Adapter is the only producer; receipt cannot originate actual. Regression anchor: `groupReceipts.test.ts:477+`. | CONFORMS |
| No fabricated ChannelPrefix | Fake/helper rejects `sms` and `mms`; normalizer conflicts other nonempty prefixes at `twilioMessageTransport.ts:114-116`. | CONFORMS |
| Excluded-no-code hide only | Timeline's shared included-entry filter feeds rows and aggregate, retaining `contact_opted_out` suppression rows. | CONFORMS |
| Optimistic suppression until refetch | All three optimistic producers have marker/no transport facts, and the pure presenter returns null before legacy/v1 rendering. Contact hook tests prove pre/post-refetch state at `useContactTimeline.test.tsx:284-355`. | CONFORMS |

## Seeds, import, and dev seams

`app/src/lib/seed/messageTransport.ts:32-62` forces explicit legacy versus v1 declarations and rejects v1 outbound-without-requested and inbound synthetic requests. It is used by cast (`cast.ts:13-52,1537`), lean (`lean.ts:279-389`), and generated performance rows (`performance.ts:927-984`). Lean includes pending RCS, fallback, mixed, unknown inbound, and explicit legacy rows. Import remains schema-absent at `app/src/lib/import/apply.ts:406-432`, appropriate because the imported record shape has no provider-attributable transport evidence. Dev fixture validates legacy/v1 declarations and uses `append` for callback-addressable SIDs at `app/src/routes/dev.ts:823-1017`.

## Finding log

- P1: none.
- P2: none.
- P3: none.
- CONFORMS: all mutation, reader, evidence, legacy, and UI watch categories.

This verdict applies to the current feature head. The final mainline sync must recheck any conflicted transport owner rather than treating this pre-sync snapshot as proof of the merged tree.
