# Message transport fidelity - design specification

Status: v3 - round 2 adjudicated; awaiting adversarial re-review and human gate
Date: 2026-08-31
Branch: `feat/message-transport-fidelity`
Worktree: `W:\tmp\message-transport-fidelity`
Base: `main` at `5ce9912f4df20af95ec7cd7c6c61e7ed726930ec`

## 1. Outcome

Every carrier-message bubble must report the transport the application requested
and, when the provider supplies trustworthy evidence, the transport that was
actually used.

The compact chip is:

- `SMS` when requested and actual agree, or while SMS is requested and actual is
  not known yet.
- `RCS` while RCS is requested and actual is not known yet.
- `RCS -> SMS` when an RCS request falls back to SMS.
- `RCS -> MMS` when an RCS request falls back to MMS.
- `RCS -> Mixed` when a multi-recipient send has complete actual evidence and
  different recipients used different transports.
- Actual only for inbound messages, because the application made no request.
- `Unknown` for a new inbound carrier message whose provider payload does not
  identify the transport.

When a multi-recipient send is expanded, each recipient row applies the same
requested/actual presentation to that recipient's leg.

An inbound relay source has two distinct observations on one bubble: the main
transport chip describes the inbound source only, while the expandable recipient
rows describe the outbound fan-out legs. Recipient slots never replace the main
chip on an inbound message.

This is an observability mission. It does not enable RCS, change routing, or alter
delivery behavior.

## 2. Why the current chip is wrong

The current `MessageType` union is doing several unrelated jobs:

- carrier-content shorthand (`sms` versus `mms`),
- non-carrier modality (`call` and `email`),
- media rendering and delivery-failure copy, and
- the text displayed as the message's transport.

That value is not generally provider-reported transport. Examples in the current
code include:

- `app/src/services/groupSend.ts` persists every outbound native group post as
  `type: 'sms'`, even though the Twilio Conversations rail is Group MMS.
- `app/src/services/sendMessage.ts` chooses `sms` or `mms` from whether media URLs
  are present.
- the inbound Twilio webhook branches choose `sms` or `mms` from media count.
- `dashboard/src/routes/conversation/useGroupThread.ts` creates optimistic group
  messages as `type: 'sms'`.
- `dashboard/src/routes/contact/Timeline.tsx` renders
  `msg.type.toUpperCase()` as the transport label.

The value is therefore application-authored content classification, not an
auditable statement of carrier transport. Renaming or widening `MessageType`
would also risk its legitimate call, email, media, and failure-copy consumers.

## 3. Locked product decisions

The following decisions were made during the approved brainstorm:

1. Cover every carrier-message surface: direct 1:1, broadcast-created 1:1,
   relay groups, native groups, inbound messages, retries, announcements,
   imports, seeds, projections, and optimistic UI state.
2. Show requested and actual transport when they differ. Show one value when
   they agree.
3. While actual is absent, show requested only. In particular, an outbound RCS
   request stays `RCS` until actual evidence arrives.
4. Inbound messages show actual only. They never receive a synthetic requested
   value.
5. A multi-recipient message shows `Mixed` only after every included recipient
   leg has actual evidence and at least two distinct actual transports exist.
   Pending evidence is not a transport and must not be called mixed.
6. Expanded multi-recipient delivery rows show each leg's requested and actual
   transport. An inbound relay source keeps its inbound-only main chip but may
   expose its outbound fan-out legs in this disclosure.
7. No migration or provider-history fetch is required.
8. Rows created before this contract keep the current legacy `type` display.
9. New inbound rows without transport evidence show `Unknown`; media presence is
   not transport evidence.
10. Optimistic bubbles carry an explicit local-only `optimistic: true` marker and
    show no transport label until a server refetch replaces them. The dashboard
    must not duplicate provider routing policy.
11. Keep `MessageType` and its current semantics. Add an independent transport
    model beside it.
12. The model is open to RCS even though RCS sending is not part of this mission.

## 4. Provider facts and evidence boundary

### 4.1 Programmable Messaging

Twilio's Message resource documents automatic RCS fallback to SMS or MMS when an
RCS sender is in a Messaging Service sender pool:

<https://www.twilio.com/docs/rcs/send-an-rcs-message>

The create response identifies message status, sender, recipient, media count,
and SID, but does not expose a dedicated actual-transport property. Twilio's
status callback contract does expose `ChannelPrefix`, described as the
channel-specific prefix identifying the messaging channel associated with the
message:

<https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url>

Therefore:

- requested transport comes from the provider adapter's transport intent;
- actual transport comes from an explicit provider observation such as
  `ChannelPrefix`;
- a callback without transport evidence may still advance delivery status but
  does not invent actual transport;
- a body, attachment list, `NumMedia`, SID prefix, or delivery status must not be
  used alone to infer actual transport.

### 4.2 Native group rails

The current HousingChoice native group rail is Twilio Conversations classic
Group MMS:

<https://www.twilio.com/docs/conversations-classic/group-texting>

The rail's endpoint contract is therefore authoritative provider-adapter
evidence for `mms` today. Both outbound posts and inbound messages identified by
the provider's native-group envelope record actual `mms`. This fact belongs in
the group adapter/normalizer, never in a UI component or generic message
service.

This does not claim that RCS can never support multiple recipients. Twilio's
RCS product is currently documented as business-agent messaging, and the newer
Bulk Messaging API documents multi-recipient sends, but the public material does
not establish a handset reply-all RCS group equivalent to the current Group MMS
rail. A future RCS group rail can return `rcs` through the same transport
contract without changing storage or presentation.

### 4.3 Evidence rule

Only code at a provider boundary may turn provider-specific fields or endpoint
guarantees into `MessageTransport`. Business services, repositories, API
projections, and dashboard code consume normalized values and never inspect
Twilio field names or infer channel from content.

## 5. Additive data contract

### 5.1 Transport vocabulary

Add the closed domain union:

```ts
export type MessageTransport = 'sms' | 'mms' | 'rcs';
```

The app owns the canonical domain definition. The dashboard mirrors the API
contract in its existing local API types because it cannot import from `app/`.
Tests pin the two unions to the same values.

Unknown is a presentation state, not a stored transport value. Unknown provider
prefixes remain absent and produce a structured warning.

### 5.2 Message fields

Add optional fields to `MessageItem` and every API/dashboard projection that can
carry a carrier message:

```ts
transport_schema_version?: 1;
requested_transport?: MessageTransport;
actual_transport?: MessageTransport;
```

Rules:

- Every carrier message newly written by runtime, import, or seed code after
  this feature has `transport_schema_version: 1`.
- An adapter intent establishes outbound `requested_transport` before the provider
  send begins. A message row stores that value atomically when the row can be
  created: after a direct/group provider result supplies the required SID and
  timestamp, or before enqueue for a relay source whose synthetic identity
  already exists.
- Inbound messages never have `requested_transport`.
- `actual_transport` is absent until the provider adapter or webhook normalizer
  supplies evidence.
- Current Group MMS adapter operations may supply `actual_transport: 'mms'`
  immediately because the invoked rail has only that transport.
- `type` remains required and retains all existing content/modality behavior.
- Calls and email do not receive carrier transport fields.

Imported history written after this feature is version 1 but carries neither
requested nor actual unless its source explicitly contains provider transport
evidence. It consequently presents `Unknown`. Existing imported history is not
rewritten and keeps its legacy `type` label.

### 5.3 Per-recipient fields

Extend each `delivery_recipients` entry additively:

```ts
requestedTransport?: MessageTransport;
actualTransport?: MessageTransport;
```

`requestedTransport` records the adapter-selected transport intent for every new
outbound leg slot. It may be present when a later consent, suppression, or guard
check prevents a provider call; requested intent is not evidence that an attempt
occurred. `actualTransport` is optional until provider evidence exists and is
always absent when no provider send occurred. A suppressed slot keeps its
requested intent plus its existing suppression status/error contract. The source
message may be an inbound relay message while its fan-out legs are outbound, so
message-level direction cannot substitute for leg-level requested transport.

The existing status, SID, error, sent timestamp, and delivered timestamp fields
are unchanged.

### 5.4 Compatibility discriminator

`transport_schema_version` is the only legacy discriminator:

- absent: render the existing uppercase `type` label;
- `1`: render only from normalized transport fields and the rules in section 9.

The UI must not decide that a row is legacy merely because its new fields are
absent. That would turn a genuinely unresolved new inbound message into a false
SMS or MMS claim.

Late callbacks do not upgrade schema-absent rows. Repository transport writes
are conditioned on `transport_schema_version = 1`, preserving the no-migration
and keep-legacy decisions.

## 6. Two-stage adapter contract

Requested transport must be available before actual transport and must also be
available for queued fan-out work. Long-lived jobs must still materialize fresh
media URLs immediately before each provider call. To satisfy both constraints
without moving provider policy into services, each carrier adapter exposes a
two-stage classify-then-prepare contract.

Conceptually:

```ts
interface MessageTransportIntent {
  requestedTransport: MessageTransport;
}

interface PreparedMessageSend extends MessageTransportIntent {
  params: SendMessageParams;
}

interface SendMessageResult {
  providerSid: string;
  status: DeliveryStatus;
  providerTs: string;
  actualTransport?: MessageTransport;
}
```

The transport-intent stage accepts durable message facts and provider
configuration only. It cannot contain presigned URLs or any other expiring send
material. The late preparation stage accepts that intent plus freshly
materialized provider parameters and returns the executable plan. The same
adapter owns both stages and executes the plan. Services may persist the
normalized `requestedTransport`, but may not construct or reinterpret it.

The intent makes requested transport known before execution; it does not require
a durable direct/group message row before Twilio returns the provider SID and
timestamp that form the existing row key. Direct and native-group messages keep
their current send/post-then-append ordering and persist the intent's requested
transport in that append. This mission adds no provisional identity, alias, or
failed-pre-send row lifecycle.

The Twilio Programmable Messaging adapter's current policy classifies SMS for
text-only sends and MMS for media sends. That policy is localized in the
adapter, covered by contract tests, and is the future seam where an enabled RCS
sender changes the requested transport. The console/fake adapter implements the
same domain contract without importing Twilio vocabulary.

The group Conversations port has an equivalent intent and late-preparation
contract. Its current Twilio implementation classifies and observes MMS because
it calls the Group MMS rail. A future rail can change that adapter result without
changing group services, persistence, or UI logic.

Transport intents are plain serializable data, not closures. An asynchronous
source persists the requested transport before enqueue; on execution the job
reclassifies from the current adapter and durable inputs, then prepares fresh
provider parameters immediately before each send. If the current classification
differs from the persisted requested transport, the job emits a structured
warning and continues the current send path. It does not rewrite the original
requested value or add a new refusal mode. Later actual provider evidence remains
the only authority for what transport was used.

## 7. Flow by message path

### 7.1 Direct 1:1 and broadcast recipients

`sendMessage` obtains a transport intent, prepares and executes the send, and
appends:

- schema version 1,
- the intent's requested transport,
- any actual transport returned by the adapter, and
- the unchanged legacy `type` selected for media/content behavior.

The append occurs after a successful provider call because the current key
requires the returned provider SID and timestamp. Requested transport was fixed
by the immutable intent before that call; it is not reverse-engineered afterward.

Broadcasts already create ordinary 1:1 message rows, so they inherit this path.
Manual 30003 retries create a new attempt and obtain a new intent; they do not
copy actual transport from the prior attempt. Existing `retry_of` lineage
remains.

### 7.2 Relay groups

For a team-authored relay message, the source message records schema version 1
and the common requested transport before the fan-out job is enqueued. Each
recipient slot is seeded with the same requested transport. A slot that is later
suppressed retains that intent and receives no actual transport; this records
what the application selected without claiming a provider attempt.

For an inbound relay source, the source message records inbound actual evidence
only. Every fan-out execution resolves the current roster where it does today,
so membership-at-execution and retry behavior remain unchanged. For each current
outbound leg, the adapter classifies transport from durable source facts. The job
creates or updates that recipient slot with immutable requested intent and its
current queued or suppressed state. An eligible leg then materializes fresh media
URLs immediately before late preparation and provider send. No recipient-set
snapshot, initialization marker, or prebuilt all-recipient send plan is added.

Each fan-out result is applied through child-field repository updates that
preserve requested intent and concurrent status fields. It can populate immediate
actual evidence. A later Programmable Messaging status callback can populate or
refine that slot's actual transport via the existing SID pointer.

The inbound source's main chip always follows the inbound actual-only rule. Its
recipient disclosure is allowed even though the source direction is inbound and
shows the outbound slots created by current and prior executions. Those slots are
progressive disclosure, not a frozen completeness set. Their aggregate never
replaces or rewrites the inbound main chip.

Relay announcements that persist a source message use the same intent,
late-preparation, and child-field result contract. Non-persisted system sends
remain outside message-chip scope.

### 7.3 Native groups

`groupSend` obtains the group adapter's transport intent before the provider
post. New source messages and every recipient slot carry requested MMS. Because the
current rail is exclusively Group MMS, the successful provider result supplies
actual MMS for the source and every non-suppressed, provider-attempted slot.
Suppressed slots retain requested MMS and carry no actual transport because
Twilio creates no leg for them.

Inbound native-group messages are normalized as actual MMS from the native
group envelope and have no requested value.

Group delivery receipts continue to own per-recipient delivery status and SID.
They may also carry normalized actual evidence when the provider supplies it.
The receipt service must not derive transport from the channel message SID.

### 7.4 Other inbound messaging

The Twilio webhook normalizer reads an explicit `ChannelPrefix` when present.
Recognized SMS, MMS, and RCS prefixes become actual transport. Missing evidence
leaves actual absent. Unknown non-empty prefixes leave actual absent and emit a
structured warning containing safe identifiers and the unknown prefix, never
message content or phone numbers.

All inbound runtime branches, including matched 1:1, unmatched/unknown, relay,
and native group, write schema version 1. Media handling continues to use the
legacy content fields and is unaffected by the transport result.

### 7.5 Optimistic UI

Optimistic carrier messages are not provider facts. Every optimistic message hook
stamps the local-only `optimistic: true` field. For `sms`/`mms` rows, the presenter
checks it before the schema-version/legacy rules and renders body/media/delivery
pending state but no transport chip. Optimistic email keeps its `EMAIL` modality
label. Resolving a POST may replace the temporary ID and status but keeps the
marker; only a server refetch replaces or deduplicates that local row with a
transport-bearing persisted row. The marker is never part of the API contract
and is never sent to the server.

## 8. Repository update semantics

### 8.1 Requested transport

Requested transport is immutable once the row or recipient slot exists. A retry
is a new provider attempt and therefore a new row or slot send observation.

Initial message appends and recipient-slot seeds write requested transport in
the same operation as the rest of the new item/slot. No later generic update may
replace it. Requested transport may survive a later suppression result because it
records adapter intent, not proof of provider invocation.

### 8.2 Actual transport state machine

Allowed actual transitions are:

- absent -> observed transport;
- same value -> idempotent no-op;
- `rcs` -> `sms` or `mms`, representing provider fallback observed after an
  earlier RCS observation.

Every other conflicting transition is refused. The stored value is preserved
and a structured warning records provider SID, message key or recipient key,
current transport, and attempted transport. It never logs message content or a
phone number.

### 8.3 Independent evidence writes

Transport evidence and delivery status are independent state machines. A
duplicate or out-of-order callback that cannot advance delivery status may still
add actual transport. Conversely, a callback without transport evidence may
still advance status.

The status webhook and group receipt service emit the existing live-update event
when either state machine makes a real write. They emit nothing when both are
no-ops.

### 8.4 Concurrency

Repository methods update only the relevant child field:

- message `actual_transport` without rebuilding the message;
- `delivery_recipients.<member>.actualTransport` without rebuilding the slot.

They must preserve concurrent status, SID, error, timestamp, and transport
writes. Conditional expressions enforce the state machine against the value in
DynamoDB, not a stale read. A conditional race is re-read and classified as
idempotent, allowed fallback, or conflict.

The existing whole-slot `setRecipientDelivery` may be used only for true initial
slot creation. Add a send-result repository operation (conceptually
`applyRecipientSendResult`) for relay fan-out and persisted announcement success
and failure paths. It updates only status, SID, sent timestamp, error, and actual
transport child fields under the existing forward-status and new actual-
transport state machines; it never replaces the slot or requested transport.
Callback paths continue using child-field updates only.

## 9. Presentation contract

Add one pure dashboard presenter used by Timeline and every message host that
reuses its bubbles. It receives the message, its local optimistic marker, and,
for multi-recipient sends, the recipient slots.

### 9.1 Legacy and non-carrier rows

| Row | Chip |
| --- | --- |
| Local carrier row with `optimistic: true` | no transport chip |
| Schema version absent | Existing `type.toUpperCase()` |
| Email | `EMAIL` |
| Call | `CALL` |

Calls and email keep their current labels because they are modalities rather
than the carrier transports governed by this feature.

### 9.2 Version 1 inbound carrier rows

| Actual | Chip |
| --- | --- |
| SMS | `SMS` |
| MMS | `MMS` |
| RCS | `RCS` |
| Absent | `Unknown` |

Requested transport is ignored on inbound even if malformed data contains it.
For an inbound relay source, this table governs the main chip; outbound leg
transport appears only inside the recipient disclosure.

### 9.3 Version 1 outbound single-recipient rows

The presenter uses one complete algorithm rather than a partial matrix:

1. Requested known, actual absent -> requested only.
2. Requested and actual equal -> the value once.
3. Requested and actual differ -> `REQUESTED -> ACTUAL` for every combination in
   the three-by-three SMS/MMS/RCS matrix.
4. Requested absent, actual known -> actual only.
5. Both absent -> `Unknown`.

This includes `SMS -> RCS` and `MMS -> RCS` for future or corrupt API data even
though the current repository state machine would refuse those actual
transitions. No normalized known pair falls through to `Unknown` or a blank chip.

### 9.4 Version 1 outbound multi-recipient rows

On an outbound message, recipient slots take precedence over message-level
actual transport when at least one slot exists. On an inbound relay source, the
main chip remains inbound actual-only and slots affect only the progressively
populated recipient disclosure.

- For outbound sources, the recipient slots initialized with the source message
  are the expected set. Until every non-suppressed slot in that set has actual
  evidence, the main chip shows only the message's requested transport.
- Once complete, one distinct actual transport uses the single-recipient table.
- Once complete, two or more distinct actual transports use `Mixed` as actual.
- A suppressed slot (`contact_opted_out`) is excluded from completeness and
  actual aggregation because no provider send occurred. It retains requested
  intent but has no actual transport.
- A genuinely failed provider attempt remains included. If it has no actual
  evidence, the aggregate remains pending rather than inventing a channel.
- If no requested transport is present, complete mixed evidence shows `Mixed`;
  otherwise malformed/incomplete data follows the `Unknown` rule.

Expanded recipient rows are allowed for both outbound multi-recipient sources and
inbound relay sources. They use their own requested/actual fields. A suppressed
row keeps its existing suppression copy and renders requested transport only;
the suppression state makes clear that no provider attempt occurred. Inbound
relay slots appear progressively and are never used to decide the main chip.

### 9.5 Copy and layout

Transport labels are technical protocol names and remain uppercase. The arrow is
the ASCII sequence ` -> `, matching the repository's ASCII-only rule. `Mixed`
and `Unknown` use title case.

The existing metadata line keeps phone and timestamp behavior. Only the first
transport fragment changes. No new tooltip or second chip is required.

## 10. API and projection propagation

All message readers return the additive fields unchanged:

- conversation message endpoints;
- contact Timeline assembled and fallback readers;
- relay and native group thread projections;
- broadcast result message projections where present;
- SSE-triggered refetch paths;
- dashboard API types and local mapping functions.

Mapping code must use presence-preserving spreads. It must not default transport
from `type`, media, conversation kind, or author.

The message-persisted SSE payload does not need to carry transport because its
contract already triggers a refetch. Tests must prove a transport-only callback
write emits the event so an open thread updates live.

## 11. Fake provider and seed support

The fake Twilio status-callback controls gain an optional provider channel field
that produces the real webhook name `ChannelPrefix`. Existing fixtures without
it remain valid and exercise unresolved actual transport.

This feature does not implement fake RCS sending; the existing RCS 501 seams
remain. A synthetic status callback is sufficient to prove normalization and
fallback persistence.

Lean/full seeds and generated performance messages written after this feature
carry schema version 1. Seed scenarios include:

- text-only native group message: legacy `type: 'sms'`, requested MMS, actual
  MMS, proving the chip ignores the misleading legacy field;
- requested RCS with actual absent;
- requested RCS with actual SMS;
- complete multi-recipient RCS with mixed RCS/SMS actuals;
- new inbound without evidence -> `Unknown`;
- an explicit schema-absent legacy row -> legacy `SMS` or `MMS`.

The importer writes schema version 1 and only maps transport evidence explicitly
present in the import source. Its existing `type` selection remains for content
compatibility but never becomes transport evidence.

## 12. Implementation surfaces

The implementation plan must enumerate and test at least these surfaces. File
names can move if the plan discovers a tighter owner, but no listed behavior may
be silently omitted.

### App

- `app/src/repos/messagesRepo.ts`: domain type, message/recipient fields,
  conditional child-field writers including the non-replacing producer-result
  operation, append mapping, fake repository parity.
- `app/src/adapters/messaging.ts`: durable transport-intent classification,
  late send preparation, Twilio and console policy, callback-prefix normalizer.
- `app/src/adapters/groupConversations.ts`: group intent, late post preparation,
  and Group MMS actual evidence.
- `app/src/services/sendMessage.ts`: direct/broadcast/retry persistence.
- `app/src/services/groupSend.ts`: native group source and slots.
- `app/src/jobs/relayFanOut.ts`: per-leg requested/actual transport.
- `app/src/services/relayAnnouncements.ts`: persisted announcements.
- `app/src/services/groupReceipts.ts`: transport updates independent of status.
- `app/src/routes/webhooks/twilio.ts`: inbound and status callback normalization
  across direct, unknown, relay, and native group branches.
- `app/src/routes/api.ts`, `app/src/routes/contactTimeline.ts`, and other message
  projections: presence-preserving propagation.
- `app/src/lib/import/apply.ts` and seed modules: versioning and explicit
  scenarios.

### Dashboard

- `dashboard/src/api/types.ts`: mirrored contract.
- a new pure transport presenter and focused matrix tests.
- `dashboard/src/routes/contact/Timeline.tsx`: metadata transport fragment.
- contact Timeline fallback and group/relay mapping hooks: propagation.
- `dashboard/src/routes/conversation/useGroupThread.ts`: remove optimistic SMS
  transport claim and stamp the explicit optimistic marker.
- `dashboard/src/routes/conversation/useRelayThread.ts` and
  `dashboard/src/routes/contact/useContactTimeline.ts`: stamp and preserve the
  same optimistic marker until server refetch.
- per-recipient delivery presentation: transport beside each expanded leg.

### Fake and browser harness

- fake Twilio status callback input/output for `ChannelPrefix`.
- hermetic seed support for group MMS and RCS fallback presentation.
- focused browser coverage on the real dashboard/API stack.
- `app/src/routes/dev.ts` extraction-message fixture: version 1 fields and
  explicit requested/actual fixture inputs, including an intentional legacy
  option only when a test asks for legacy behavior.

The plan must begin with a fresh codebase inventory because this list is a
design-time map, not permission to assume no other writer or projection exists.

## 13. Verification contract

### 13.1 Focused implementation proof

Before full completion gates, add and run targeted tests for:

1. Pure presenter matrix: pending, agreement, fallback, inbound unknown, legacy,
   all nine known requested/actual pairs, partial multi-recipient evidence,
   complete uniform evidence, mixed evidence, optimistic suppression, inbound
   relay leg disclosure, and suppression.
2. Adapter intent and late preparation: current text, media, and Group MMS
   policies; RCS-ready normalization; fresh per-leg media parameters; no service
   or dashboard attachment-only inference.
3. Webhook normalization: recognized case variants, missing prefix, unknown
   prefix warning, and Group MMS envelope evidence.
4. Direct, broadcast, retry, relay, announcement, native-group, inbound,
   import, seed, and dev-fixture writers.
5. Repository actual state machine: absent, duplicate, RCS fallback, refused
   conflicts, schema-absent legacy row, and unknown row/slot.
6. DynamoDB Local concurrency: simultaneous status, SID, error, requested, and
   actual transport writes to one recipient slot preserve every field; producer
   results never whole-slot replace seeded intent.
7. API/projection and dashboard hook propagation.
8. Transport-only callback updates emit the existing live refetch event.
9. Relay behavior parity: inbound retries use membership-at-each-execution,
   media is materialized per leg immediately before send, suppressed slots retain
   requested-only intent, and queued classification drift warns but still sends.

### 13.2 Browser proof

Hermetic Playwright coverage must prove at least:

- a text-only native group bubble displays `MMS`, not its legacy `type: 'sms'`;
- a pending RCS request displays `RCS`;
- an RCS fallback displays `RCS -> SMS`;
- a complete mixed multi-recipient send displays `RCS -> Mixed` and expanded
  rows identify each recipient's transport;
- an inbound relay source keeps its inbound main chip while its expanded rows
  show outbound leg transports;
- a schema-absent message keeps its legacy label;
- a version 1 inbound message without evidence displays `Unknown`;
- the optimistic group bubble does not briefly claim SMS before refetch.

Use the repository's hermetic e2e lane only. Do not test against the human's
live dashboard ports.

### 13.3 Feature-mission completion gates

After implementation, independent review, and review fixes, sync the latest
`main` once and run the required bare commands from the feature worktree:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. targeted ESLint over every changed TypeScript/JavaScript file relative to
   `main...HEAD`, using baseline comparison for pre-existing errors

The design baseline already ran bare `npm test` against reachable DynamoDB Local
at base `5ce9912f` and exited 0:

- app: 346 files passed, 1 skipped; 6,283 tests passed, 9 skipped;
- dashboard: 183 files and 2,855 tests passed;
- e2e workspace unit suites: 19 files and 492 tests passed;
- fake Twilio: 34 files and 240 tests passed;
- fake Twilio web: 13 files and 111 tests passed.

## 14. Failure and observability behavior

- Unknown non-empty provider channel values produce a structured warning and no
  transport write.
- Conflicting actual transitions produce a structured warning and preserve the
  stored value.
- Missing channel evidence is expected and produces no warning by itself.
- Queued classification drift produces a structured warning, preserves the
  original requested value, and continues the existing send path.
- Provider payload names remain at adapter/webhook boundaries.
- Logs contain safe IDs, enum values, and error codes only; no bodies or phone
  numbers.
- Transport write failures are not swallowed. The webhook follows its current
  retry/error response contract so provider redelivery can recover.
- Presentation never hides a malformed known value behind the legacy `type`.

## 15. Out of scope

- Enabling or configuring RCS senders.
- Implementing the RCS Content API or fake RCS engine.
- Replacing the native Group MMS rail.
- Claiming that Twilio Bulk Messaging is a native handset reply-all group.
- Migrating, backfilling, or fetching provider history for existing messages.
- Replacing or redefining `MessageType`.
- Changing media rendering, delivery status semantics, retry policy, Inbox
  behavior, consent, suppression, or provider routing.
- Terraform, deployment, environment mutation, or production data changes.

## 16. Acceptance criteria

The mission is complete only when all of the following are true:

1. No new carrier-message chip derives transport from `MessageType`, media, SID
   prefix, or conversation kind.
2. Every new carrier runtime writer stamps schema version 1.
3. Every newly persisted outbound message or leg slot stores adapter-owned
   requested transport, including a slot later suppressed before provider send;
   only provider evidence may populate actual transport.
4. Every explicit provider transport observation can update actual transport
   without depending on a delivery-status transition.
5. Requested transport is immutable and conflicting actual observations cannot
   corrupt stored evidence.
6. Multi-recipient message and recipient-row presentation follows the locked
   rules, including progressive inbound relay disclosure, outbound-source
   expected-slot completeness, suppression, pending, and mixed states.
7. Existing schema-absent rows display exactly as they do today.
8. Calls and email retain their current labels and behavior.
9. Targeted tests, browser proof, full feature-mission gates, and independent
   review all pass with recorded evidence.
10. Merge, deployment, and production rollout remain human-owned.
