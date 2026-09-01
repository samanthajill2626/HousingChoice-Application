# Message transport fidelity - design specification

Status: v6 - APPROVED for implementation planning
Date: 2026-08-31
Revised: 2026-09-01
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
- `REQUESTED -> ACTUAL` for every unequal known SMS/MMS/RCS pair, including
  `RCS -> SMS` and `RCS -> MMS` fallback observations.
- `REQUESTED -> Mixed` when a multi-recipient send has complete actual evidence
  and different recipients used different transports, for any requested value.
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

The Message resource and callback contracts expose provider identifiers rather
than one dedicated actual-transport property. The status callback includes a
subset of standard fields such as `From` and `MessageSid`. Twilio documents
`ChannelPrefix` only as an additional property for RCS, WhatsApp, and other
messaging channels; it is not an SMS/MMS field and is not listed on the inbound
webhook:

<https://www.twilio.com/docs/messaging/api/message-resource#twilios-request-to-the-statuscallback-url>

<https://www.twilio.com/docs/messaging/guides/webhook-request>

Twilio separately documents two transport-bearing identifiers:

- a successfully delivered RCS message has `From: rcs:<SenderId>` in outbound
  status callbacks and fetched Message resources;
- a Twilio Message SID starts `SM` for a text message and `MM` for a media
  message.

<https://www.twilio.com/docs/rcs/send-an-rcs-message>

<https://help.twilio.com/articles/223134387>

The inbound webhook also documents optional `ChannelMetadata`; its JSON `type`
can explicitly identify `rcs` for a rich-channel message.

Therefore:

- requested transport comes from the provider adapter's transport intent;
- actual transport comes from a provider-boundary normalizer over the documented
  `From`, `MessageSid`, `ChannelPrefix`, `ChannelMetadata`, and known endpoint
  facts described below;
- a callback without transport evidence may still advance delivery status but
  does not invent actual transport;
- a body, attachment list, `NumMedia`, delivery status, conversation kind, or
  legacy `MessageType` must not be used to infer actual transport.

Normalization precedence is conservative:

1. Explicit RCS evidence wins: `From` beginning `rcs:`, recognized
   `ChannelMetadata.type: 'rcs'`, or an unambiguous RCS `ChannelPrefix` when it
   does not conflict with `From`.
2. On an inbound webhook routed to a known E.164 SMS/MMS number, `MM` identifies
   MMS and `SM` identifies SMS. A recognized rich-channel payload is handled by
   step 1 before SID inspection.
3. On an outbound message whose requested transport is SMS or MMS, the provider
   result/callback SID may immediately identify the actual SMS/MMS transport.
4. On an RCS-requested message, `SM`/`MM` is used as fallback evidence only when
   the same callback/resource also supplies a non-channel `From` sender. A SID
   alone cannot distinguish an early RCS resource from fallback.
5. Missing evidence leaves actual absent. Conflicting or unknown non-empty
   evidence leaves actual absent and emits one safe structured warning.

Twilio does not document whether automatic fallback retains the same Message SID
or the exact complete callback shape for every SMS/MMS fallback. That uncertainty
does not block the current SMS/MMS and Group MMS feature because RCS sending is
out of scope. Before RCS is enabled, the controlled provider probe tracked in
`docs/issues/rcs-fallback-transport-observation.md` must validate the adapter
normalizer against real fallback callbacks and fetched resources. Until then,
ambiguous RCS fallback evidence remains pending rather than guessed.

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

Unknown is a presentation state, not a stored transport value. Unknown or
conflicting provider evidence remains absent and produces a structured warning.

### 5.2 Message fields

Add optional fields to `MessageItem` and every API/dashboard projection that can
carry a carrier message:

```ts
transport_schema_version?: 1;
requested_transport?: MessageTransport;
actual_transport?: MessageTransport;
```

Rules:

- Every carrier message newly written by normal runtime code after this feature
  has `transport_schema_version: 1`.
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

Imported history remains schema-absent and keeps the legacy label unless the
import source carries explicit, provider-attributable transport evidence. Only a
row with such evidence is written as version 1. This avoids changing identical
historical provenance from `SMS` to `Unknown` merely because an import ran after
deployment.

### 5.3 Per-recipient fields

Extend each `delivery_recipients` entry additively:

```ts
export type TransportAggregationState = 'planned' | 'attempted' | 'excluded';

requestedTransport?: MessageTransport;
actualTransport?: MessageTransport;
transportAggregationState?: TransportAggregationState;
```

`requestedTransport` records the adapter-selected transport intent for every new
outbound leg slot. It may be present when a later consent, suppression, or guard
check prevents a provider call; requested intent is not evidence that an attempt
occurred. `actualTransport` is optional until provider evidence exists and is
always absent when no provider send occurred. A suppressed slot keeps its
requested intent plus its existing suppression status/error contract. The source
message may be an inbound relay message while its fan-out legs are outbound, so
message-level direction cannot substitute for leg-level requested transport.

`transportAggregationState` is transport-presentation bookkeeping for outbound
multi-recipient legs, not provider evidence and not a routing instruction:

- `planned`: the leg belongs to a roster resolved for a fan-out execution but no
  provider invocation has begun;
- `attempted`: the application reached the provider-call boundary for the leg;
- `excluded`: no provider call should count for this leg because it was removed
  before attempt or suppressed.

The field is optional on single-recipient rows and source-time relay slots that
have not yet been reconciled by a worker.

A preflight-created recipient slot starts with required delivery status `queued`.
An `excluded` slot with `contact_opted_out` keeps the existing not-sent
presentation. An `excluded` never-attempted member with no suppression code is
omitted from delivery aggregation and expanded recipient rows. The existing SID,
error, sent timestamp, and delivered timestamp fields are otherwise unchanged.

### 5.4 Compatibility discriminator

`transport_schema_version` is the only legacy discriminator:

- absent: render the existing uppercase `type` label;
- `1`: render only from normalized transport fields and the rules in section 9.

The UI must not decide that a row is legacy merely because its new fields are
absent. That would turn a genuinely unresolved new inbound message into a false
SMS or MMS claim.

Late callbacks do not upgrade schema-absent rows. Repository transport writes
are conditioned on `transport_schema_version = 1`, preserving the no-migration
and keep-legacy decisions. Delivery status, SID pointers, retries, and sends are
not conditioned on that field.

Every relay execution branches explicitly by source schema:

- schema version 1 uses transport initialization, aggregation preflight, and
  child-field transport result writes;
- schema absent skips all transport-only preflight/writes and follows the exact
  pre-feature fan-out/result path, including in-flight SQS jobs, continuations,
  and later release of `queued_pending` holds.

A schema-absent transport write is a recorded compatibility no-op, never a
preflight failure. Only a real failure while updating a version-1 source may
abort before sends.

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

For relay fan-out, the durable classification input is the attachment set the
worker can actually forward, not the legacy `type` and not raw source
`mediaUrls` that the worker does not replay. Stable adapter configuration such as
media-store availability is also an input. If attachments cannot be freshly
materialized at execution, the executable intent is text-only SMS; a different
source-time intent is preserved and reported as classification drift while the
existing body-only send continues.

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
recipient slot known at source creation is seeded with the same requested
transport. A slot that is later suppressed retains that intent and receives no
actual transport; this records what the application selected without claiming a
provider attempt. Source-time slots do not enter transport aggregation until a
worker resolves them against a current execution roster.

For an inbound relay source, the source message records inbound actual evidence
only.

For a schema-absent relay source, every transport-specific step in the remaining
section is bypassed. The worker resolves the current roster, checks suppression,
sends, persists delivery results, creates SID pointers, and schedules
continuations exactly as it does before this feature.

Every relay fan-out execution resolves the current roster where it does today,
so membership-at-execution and retry behavior remain unchanged. Before
the first provider send of an execution, a transport preflight conditionally
creates every missing current-member slot and marks every never-attempted current
candidate `planned`; an existing `attempted` slot stays attempted. For a
team-authored or persisted-announcement source, a new slot copies the immutable
source requested transport. For an inbound source, the adapter first classifies
transport from durable source facts and the new slot stores that intent.
Initializers succeed only when the member slot is absent; on a race, the job
reads and preserves the existing slot and requested value. Every newly created
slot has delivery status `queued`.

The same preflight changes a previously `planned`, never-attempted slot to
`excluded` when that member is no longer in the current execution roster. A
later re-add may change `excluded` back to `planned`. An `attempted` slot is never
excluded later, because it represents a provider call that must remain part of
the aggregate even if membership subsequently changes. A partial preflight
failure aborts before any provider send, so the presenter cannot observe a
completed subset while undiscovered current recipients remain.

Existing relay slots are never recreated for a continuation. A transient failure
remains queued and a continuation resends through the same member-key slot,
preserving the current one-slot-per-recipient delivery status, SID pointer, and
callback routing model. This mission introduces no per-attempt relay history.

After the slot and suppression checks, an eligible leg materializes fresh media
URLs immediately before late preparation. Immediately before invoking the
provider, the job changes `planned` to `attempted`; a crash at that boundary is
conservatively pending until actual evidence arrives. A suppressed leg changes
to `excluded` through the existing per-member suppression path. No routing
snapshot or prebuilt all-recipient send plan is added.

Each fan-out result is applied through child-field repository updates that
preserve requested intent and concurrent status fields. It can populate immediate
actual evidence. A later Programmable Messaging status callback can populate or
refine that slot's actual transport via the existing SID pointer.

The inbound source's main chip always follows the inbound actual-only rule. Its
recipient disclosure is allowed even though the source direction is inbound and
shows the outbound slots created by current and prior executions. Those slots are
progressive disclosure, not a frozen completeness set. Their aggregate never
replaces or rewrites the inbound main chip.

Each persisted relay announcement is itself a transport execution even though it
runs in-process rather than through the fan-out worker. Its initial append seeds
every roster slot with requested intent, delivery status `queued`, and aggregation
state `planned`. The existing per-member loop changes a suppressed slot to
`excluded`, changes a leg to `attempted` immediately before `adapter.sendMessage`,
and applies the child-field result operation afterward. Non-persisted system
sends remain outside message-chip scope.

### 7.3 Native groups

`groupSend` obtains the group adapter's transport intent before the provider
post. New source messages and every recipient slot carry requested MMS. Because the
current rail is exclusively Group MMS, the successful provider result supplies
actual MMS for the source and every non-suppressed, provider-attempted slot.
Suppressed slots retain requested MMS and carry no actual transport because
Twilio creates no leg for them. Non-suppressed native-group slots store
`attempted`; suppressed slots store `excluded`.

Inbound native-group messages are normalized as actual MMS from the native
group envelope and have no requested value.

Group delivery receipts continue to own per-recipient delivery status and SID.
They may also carry normalized actual evidence when the provider supplies it.
The receipt service must not derive transport from the channel message SID.

### 7.4 Other inbound messaging

The Twilio webhook normalizer applies section 4.1's evidence precedence. Inbound
RCS may be identified by recognized `ChannelMetadata`; ordinary inbound messages
to known phone-number endpoints use the documented `SM`/`MM` Message SID
semantics. Status callbacks normalize `From`, SID, and any non-conflicting RCS
channel fields. Missing evidence leaves actual absent. Unknown or conflicting
non-empty evidence leaves actual absent and emits a structured warning containing
safe identifiers and enum/prefix values, never content or phone numbers.

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

Requested transport is immutable once the row or recipient slot exists. Retry
storage follows the existing path contract: a manual direct 30003 retry creates a
new message row and new requested intent, while a relay continuation reuses its
existing member slot and original requested intent. No new retry identity or
per-attempt relay observation is introduced.

Initial message appends and recipient-slot seeds write requested transport in
the same operation as the rest of the new item/slot. No later generic update may
replace it. Requested transport may survive a later suppression result because it
records adapter intent, not proof of provider invocation.

### 8.2 Aggregation state machine

Allowed aggregation transitions are:

- absent -> `planned` or `excluded`;
- `planned` -> `attempted` or `excluded`;
- `excluded` -> `planned` when a never-attempted member rejoins a later current
  execution roster;
- same value -> idempotent no-op.

`attempted` is terminal. It means the application reached the provider-call
boundary, not that the provider accepted the message and not that any particular
transport was used. Only `actualTransport` makes the latter claim.

### 8.3 Actual transport state machine

Allowed actual transitions are:

- absent -> observed transport;
- same value -> idempotent no-op;
- `rcs` -> `sms` or `mms`, representing provider fallback observed after an
  earlier RCS observation.

One stale ordering is expected rather than conflicting: when requested transport
is RCS and stored actual is SMS or MMS, a later RCS observation is a superseded
pre-fallback callback. It is an idempotent no-op logged at info/debug level, not a
warning. The same transition on a non-RCS request remains a conflict.

Every other conflicting transition is refused. The stored value is preserved
and a structured warning records provider SID, message key or a sanitized
recipient identity, current transport, and attempted transport. Relay and
announcement paths use the existing `logSafeMemberKey` representation and never
log a raw `phone#<E164>` map key, message content, or phone number.

### 8.4 Independent evidence writes

Transport evidence and delivery status are independent state machines. A
duplicate or out-of-order callback that cannot advance delivery status may still
add actual transport. Conversely, a callback without transport evidence may
still advance status.

The status webhook and group receipt service emit the existing live-update event
when either state machine makes a real write. They emit nothing when both are
no-ops.

### 8.5 Concurrency

Repository methods update only the relevant child field:

- message `actual_transport` without rebuilding the message;
- `delivery_recipients.<member>.actualTransport` without rebuilding the slot;
- `delivery_recipients.<member>.transportAggregationState` under its own state
  machine without rebuilding the slot.

They must preserve concurrent status, SID, error, timestamp, and transport
writes. Conditional expressions enforce the state machine against the value in
DynamoDB, not a stale read. A conditional race is re-read and classified as
idempotent, allowed fallback, or conflict.

Source-time recipient slots remain part of the atomic initial message append.
Replace later unconstrained whole-slot writes with a conditional operation
(conceptually `initializeRecipientDelivery`) that creates a member slot only
when it is absent and otherwise returns or re-reads the existing slot. It is used
for current-roster members first discovered by any relay execution and never
replaces requested intent, status, or callback pointers.

Add conditional aggregation operations for the all-current-member preflight,
the reconciliation of stale never-attempted `planned` slots, and the immediate
pre-provider `attempted` transition. They update only the aggregation child field
and abort the execution before any send if the current-roster preflight cannot be
completed.

Add a send-result repository operation (conceptually
`applyRecipientSendResult`) for relay fan-out and persisted announcement success
and failure paths. It updates only status, SID, sent timestamp, error, and actual
transport child fields; it never replaces the slot or requested transport.

The result operation treats status and metadata independently:

- an allowed forward status advances;
- the same status is an idempotent status no-op but still writes eligible SID,
  `sentAt`, error, and actual fields;
- an already-more-advanced status never regresses, but eligible absent-only SID,
  `sentAt`, and actual evidence may still land;
- SID is absent-only, actual follows section 8.3, and transient error data cannot
  overwrite a terminal delivery outcome.

This explicitly covers the common Messaging Service provider result `accepted`,
which maps to internal `queued` and is applied to a slot already seeded `queued`.
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

- For outbound sources, slots whose aggregation state is `planned` or `attempted`
  are the expected set. State-absent and `excluded` slots do not participate.
  Until every participating non-suppressed slot has actual evidence, the main
  chip shows only the message's requested transport.
- Once complete, one distinct actual transport uses the single-recipient table.
- Once complete, two or more distinct actual transports use `Mixed` as actual.
- A suppressed slot (`contact_opted_out`) is excluded from completeness and
  actual aggregation because no provider send occurred. It retains requested
  intent, stores aggregation state `excluded`, and has no actual transport.
- A genuinely failed provider attempt remains included. If it has no actual
  evidence, the aggregate remains pending rather than inventing a channel.
- If no requested transport is present, complete mixed evidence shows `Mixed`;
  otherwise malformed/incomplete data follows the `Unknown` rule.
- If no slot participates, the outbound chip shows requested transport only.

Expanded recipient rows are allowed for both outbound multi-recipient sources and
inbound relay sources. They use their own requested/actual fields. A suppressed
row keeps its existing suppression copy and renders requested transport only;
the suppression state makes clear that no provider attempt occurred. Inbound
relay slots appear progressively and are never used to decide the main chip. An
`excluded` row without `contact_opted_out` represents a removed never-attempted
member and is omitted from both delivery aggregation and disclosure.

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

The fake Twilio status-callback controls gain documented `From` and `MessageSid`
inputs. They may also carry RCS-only `ChannelPrefix`; inbound fixtures may carry
documented `ChannelMetadata`. Existing fixtures without new evidence remain valid
and exercise unresolved actual transport. The fake must not emit synthetic
`ChannelPrefix=sms` or `ChannelPrefix=mms` payloads that Twilio does not document.

This feature does not implement fake RCS sending; the existing RCS 501 seams
remain. Provider-normalizer tests use documented payload shapes. Presenter and
browser fixtures may directly author normalized RCS fallback domain values to
prove the UI contract, but that is not represented as live Twilio fallback proof.

Lean/full seeds and generated performance messages written after this feature
carry schema version 1 and explicit normalized actual transport because the seed
is the hermetic fake provider. Ordinary inbound/outbound SMS rows therefore stay
`SMS` rather than making the demo and lean worlds `Unknown`-dominated. The
byte-stable lean world changes once as part of this feature and is then pinned by
its existing tests. Seed scenarios include:

- text-only native group message: legacy `type: 'sms'`, requested MMS, actual
  MMS, proving the chip ignores the misleading legacy field;
- requested RCS with actual absent;
- requested RCS with actual SMS;
- complete multi-recipient RCS with mixed RCS/SMS actuals;
- new inbound without evidence -> `Unknown`;
- an explicit schema-absent legacy row -> legacy `SMS` or `MMS`.

The importer writes schema-absent legacy rows unless the import source explicitly
contains provider-attributable transport evidence. When evidence exists it may
write version 1 and normalized actual transport. Its existing `type` selection
remains for content compatibility but never becomes transport evidence.

## 12. Implementation surfaces

The implementation plan must enumerate and test at least these surfaces. File
names can move if the plan discovers a tighter owner, but no listed behavior may
be silently omitted.

### App

- `app/src/repos/messagesRepo.ts`: domain type, message/recipient fields,
  conditional child-field writers including aggregation preflight and the
  non-replacing producer-result operation, append mapping, fake repository
  parity.
- `app/src/adapters/messaging.ts`: durable transport-intent classification,
  late send preparation, Twilio and console policy, and documented
  From/SID/channel-metadata normalizers.
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

- fake Twilio status/inbound callback input/output for documented `From`,
  `MessageSid`, `ChannelMetadata`, and RCS-only `ChannelPrefix` evidence.
- hermetic seed support for group MMS and RCS fallback presentation.
- focused browser coverage on the real dashboard/API stack.
- `app/src/routes/dev.ts` extraction-message fixture: version 1 fields and
  explicit requested/actual fixture inputs, including an intentional legacy
  option only when a test asks for legacy behavior.

The plan must begin with a fresh codebase inventory because this list is a
design-time map, not permission to assume no other writer or projection exists.
The independent v5 review observed substantial `main` drift through `f27aabbf`;
all plan citations and call sites must be refreshed against then-current `main`,
not copied from this spec's original base.

## 13. Verification contract

### 13.1 Focused implementation proof

Before full completion gates, add and run targeted tests for:

1. Pure presenter matrix: pending, agreement, fallback, inbound unknown, legacy,
   all nine known requested/actual pairs, partial multi-recipient evidence,
   complete uniform evidence, mixed evidence, optimistic suppression, inbound
   relay leg disclosure, and suppression.
2. Adapter intent and late preparation: current text, effective forwardable relay
   attachments, no-media-store body-only behavior, and Group MMS policies;
   RCS-ready normalization; fresh per-leg media parameters; no service or
   dashboard inference from legacy `type`.
3. Webhook normalization: inbound `ChannelMetadata`, RCS `From`, E.164 fallback
   `From` plus `SM`/`MM`, current SMS/MMS SID evidence, missing evidence,
   conflicting evidence warning, and Group MMS envelope evidence. Tests must
   prove `ChannelPrefix=sms|mms` is never required or fabricated.
4. Direct, broadcast, retry, relay, announcement, native-group, inbound,
   import, seed, and dev-fixture writers.
5. Repository actual state machine: absent, duplicate, RCS fallback, refused
   conflicts, schema-absent legacy row, and unknown row/slot.
6. DynamoDB Local concurrency: simultaneous status, SID, error, requested, and
   actual transport writes plus aggregation-state transitions on one recipient
   slot preserve every field; producer results never whole-slot replace seeded
   intent. Include provider `accepted` mapped to an already-`queued` slot and
   prove SID, `sentAt`, error, and actual still persist without status regression.
7. API/projection and dashboard hook propagation.
8. Transport-only callback updates emit the existing live refetch event.
9. Relay behavior parity: all executions use membership-at-each-execution; the
   all-current-member aggregation preflight finishes before the first provider
   send; a member added after source append participates; a member removed before
   attempt is excluded; continuations reuse the same slot and callback pointer;
   media is materialized per leg immediately before send; suppressed slots retain
   requested-only intent; and queued classification drift warns but still sends.
10. Legacy relay compatibility: a schema-absent queued team source, inbound
    source, continuation, and `queued_pending` hold released after deployment all
    fan out through the pre-feature path with no transport writes or new abort.
11. Preflight/disclosure: a dynamically created slot starts `queued`; a removed
    never-attempted excluded slot is hidden; a suppressed excluded slot retains
    the existing not-sent row; persisted announcements perform planned,
    attempted, excluded, and result transitions.
12. Import/seed/logging: evidence-free imports remain schema-absent, ordinary
    seeds author normalized actual transport, and no warning logs raw
    `phone#<E164>` member keys.

### 13.2 Browser proof

Hermetic Playwright coverage must prove at least:

- a text-only native group bubble displays `MMS`, not its legacy `type: 'sms'`;
- a pending RCS request displays `RCS`;
- an RCS fallback displays `RCS -> SMS`;
- a complete mixed multi-recipient send displays `RCS -> Mixed` and expanded
  rows identify each recipient's transport;
- outbound relay add/remove membership races do not create a false completed
  transport or a permanently pending never-attempted leg;
- an inbound relay source keeps its inbound main chip while its expanded rows
  show outbound leg transports;
- a schema-absent message keeps its legacy label;
- a version 1 inbound message without evidence displays `Unknown`;
- the optimistic group bubble does not briefly claim SMS before refetch.

The RCS fallback browser rows are normalized domain fixtures. They prove storage
and presentation, not the still-unverified live Twilio fallback callback shape.

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

- Unknown or conflicting non-empty provider evidence produces one structured
  warning and no transport write.
- Conflicting actual transitions produce a structured warning and preserve the
  stored value.
- Missing channel evidence is expected and produces no warning by itself.
- Queued classification drift produces a structured warning, preserves the
  original requested value, and continues the existing send path.
- An aggregation preflight failure aborts before provider sends and follows the
  current job retry/error path; it cannot expose a falsely complete subset.
- Schema-absent sources bypass transport preflight entirely and cannot fail or
  delay because of transport metadata.
- Provider payload names remain at adapter/webhook boundaries.
- Logs contain safe IDs, enum values, and error codes only; no bodies or phone
  numbers.
- Transport write failures are not swallowed. The webhook follows its current
  retry/error response contract so provider redelivery can recover.
- Presentation never hides a malformed known value behind the legacy `type`.

## 15. Out of scope

- Enabling or configuring RCS senders.
- Implementing the RCS Content API or fake RCS engine.
- Claiming production RCS fallback observation is verified before the controlled
  callback/resource probe in `docs/issues/rcs-fallback-transport-observation.md`.
- Replacing the native Group MMS rail.
- Claiming that Twilio Bulk Messaging is a native handset reply-all group.
- Migrating, backfilling, or fetching provider history for existing messages.
- Replacing or redefining `MessageType`.
- Changing media rendering, delivery status semantics, retry policy, Inbox
  behavior, consent, suppression, or provider routing.
- Terraform, deployment, environment mutation, or production data changes.

## 16. Acceptance criteria

The mission is complete only when all of the following are true:

1. No new carrier-message chip derives transport from `MessageType`, media, or
   conversation kind. Twilio-specific `From`, `SM`/`MM` SID, channel metadata,
   and rail facts are normalized only at provider boundaries.
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
11. Relay membership races and continuation retries preserve the current routing,
    one-slot-per-member, and callback-pointer behavior while every newly
    discovered leg records requested intent before provider handling.
12. Outbound aggregation includes current-roster additions, excludes members
    removed before attempt, permanently retains attempted legs, and never calls a
    partial execution complete.
13. Schema-absent relay sources preserve pre-feature send, retry, continuation,
    status, and callback behavior without transport writes.
14. Same-status provider results preserve status while still recording eligible
    SID, timestamp, error, and actual evidence.
15. Evidence-free imports retain legacy labels, ordinary seeds carry explicit
    fake-provider evidence, and persisted announcements participate in transport
    aggregation.
