# Spec review R1-B findings

## 1. [BLOCKING] The prepared-send contract cannot satisfy pre-send persistence

What is wrong: Section 5.2 requires every outbound message to persist
`requested_transport` before the provider send starts (spec:173-176), but section
7.1 directs `sendMessage` to prepare, execute, and then append (spec:266-273).
The proposed prepared plan has no message identity, while the result supplies the
provider SID and timestamp only after execution (spec:229-240). No storage or
reconciliation protocol is specified for a pre-send record without those required
identifiers.

Evidence: `NewMessage` requires `providerSid` and `providerTs`
(`app/src/repos/messagesRepo.ts:602-607`), and `messages.append()` keys the row
from those values (`app/src/repos/messagesRepo.ts:1900-1914`). The current direct
path sends before appending (`app/src/services/sendMessage.ts:379-397`), and the
native group path likewise posts before it can append the returned message SID
(`app/src/services/groupSend.ts:625-656`). The same ordering applies to relay legs:
the job sends first and only then writes the slot and SID pointer
(`app/src/jobs/relayFanOut.ts:502-549`).

What it implies: a builder cannot meet the promised pre-send requested-transport
guarantee without inventing an identity/alias, provisional-row lifecycle, provider
failure treatment, and callback correlation scheme. Appending after send violates
the guarantee; appending before send is impossible with the specified message key.
The spec must choose and define one durable protocol before implementation.

## 2. [BLOCKING] Inbound relay fan-out has mutually exclusive presentation rules

What is wrong: Section 7.2 explicitly creates an inbound source row with outbound
fan-out slots (spec:285-287), and section 5.3 says message direction cannot stand
in for those leg fields (spec:199-201). Yet section 9.2 says every version-1
inbound carrier row ignores requested transport and displays only its own actual
transport (spec:396-405), while section 9.4 says recipient slots take precedence
and renders requested/actual aggregate state when an outbound slot exists
(spec:425-443). It never specifies which rule wins for this exact row shape.

Evidence: the existing relay inbound writer creates an `inbound` message with an
empty `delivery_recipients` map for later fan-out
(`app/src/routes/webhooks/twilio.ts:581-601`). Current Timeline code treats its
recipient delivery UI as outbound-only: both the aggregate and expanded-row gates
require `outbound` (`dashboard/src/routes/contact/Timeline.tsx:883-907`).

What it implies: implementation must either hide a real fan-out's leg transports,
override the locked inbound actual-only rule, or change the existing direction
gate. The presenter cannot be correctly implemented or tested until the spec says
whether an inbound relay bubble shows its inbound transport, its outbound fan-out
aggregate, both, or neither, and whether its recipient disclosure is permitted.

## 3. [HIGH] The per-recipient contract contradicts its suppression rule

What is wrong: Section 5.3 says both requested and actual transport are required
for every new outbound recipient leg (spec:190-201), and section 7.3 says every
native-group recipient slot carries requested MMS (spec:296-301). Section 9.4 then
says a `contact_opted_out` slot had no provider send and must not claim a transport
(spec:430-443). These are the same persisted recipient-slot shape, not two
different models.

Evidence: native group send builds a slot for every resolved member and writes a
suppressed member as `contact_opted_out` before the message is appended
(`app/src/services/groupSend.ts:595-617`, `app/src/services/groupSend.ts:626-648`).
Relay fan-out likewise converts a suppressed member's already-seeded slot into
`contact_opted_out` without a provider send (`app/src/jobs/relayFanOut.ts:443-482`).

What it implies: a builder has no valid field value for a suppressed slot. Storing
requested MMS contradicts the no-transport-claim rule; omitting it violates the
required-leg rule and can make generic expanded-row presentation report `Unknown`.
The spec must explicitly exclude suppressed slots from the outbound-leg requirement
and define their stored fields, or define a distinct requested-but-not-attempted
state and its presentation.
