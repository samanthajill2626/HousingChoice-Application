# Message transport fidelity design - spec review round 1 A

Scope: adversarial design review of the draft before implementation. Existing-code claims are cited only where verified in the reviewed worktree.

## 1. [BLOCKING] Optimistic bubbles have no defined way to suppress the legacy chip

What is wrong:

The spec requires no transport label on optimistic bubbles until a persisted row supplies requested transport (spec 3.10 and 7.5), but says `transport_schema_version` is the only legacy discriminator and an absent version renders the legacy `type.toUpperCase()` label (spec 5.4 and 9.1). The proposed presenter receives only a message and slots (spec 9), with no transient/optimistic input to override that rule.

Evidence:

All three optimistic writers create ordinary `TimelineMessage` values with `type: 'sms'` or `type: 'mms'` and no transport fields: `dashboard/src/routes/conversation/useGroupThread.ts:107-128`, `dashboard/src/routes/conversation/useRelayThread.ts:239-266`, and `dashboard/src/routes/contact/useContactTimeline.ts:262-310`. Their resolve paths replace only ID/status, not a transport-bearing message (`useGroupThread.ts:134-149`, `useRelayThread.ts:273-289`, `useContactTimeline.ts:316-332`). `MessageBubble` currently renders directly from `msg.type` at `dashboard/src/routes/contact/Timeline.tsx:815-824`.

Implication:

Following the only-discriminator rule displays SMS/MMS on optimistic bubbles and violates a locked decision. Define a transient presentation input and its refetch lifecycle, or narrow the legacy-discriminator rule to persisted rows. The builder cannot correctly choose between the current rules.

## 2. [BLOCKING] Inbound relay fan-out cannot establish the recipient set required for complete or Mixed transport

What is wrong:

The spec permits aggregate transport only after every included recipient leg has actual evidence (spec 3.5 and 9.4), and requires inbound relay sources to retain independent outbound-leg transport (spec 5.3 and 7.2), but never defines the expected leg set for that path.

Evidence:

The inbound relay writer deliberately seeds `deliveryRecipients: {}` and defers member resolution to the job (`app/src/routes/webhooks/twilio.ts:581-600`). The job reads the current roster and writes a slot only after each individual send returns (`app/src/jobs/relayFanOut.ts:443-509` and `538-549`). After the first actual observation, the map cannot distinguish one completed recipient from the entire fan-out. Pre-seeding at webhook time would change the documented current behavior of resolving membership at job time.

Implication:

Define an immutable expected-leg set and when it is captured, or a separate pending aggregate for dynamically created inbound-relay legs. Without it, the complete/Mixed guarantee cannot coexist with current fan-out semantics.

## 3. [HIGH] Inbound relay fan-out leg transport will be stored but cannot be rendered

What is wrong:

The design covers inbound relay source messages whose fan-out legs are outbound (spec 5.3:199-200 and 7.2:285-291) and requires expanded recipient rows to present each leg's requested/actual transport (spec 3.6 and 9.4:441-443). The existing shared Timeline hides those rows for an inbound source.

Evidence:

`deliveredSummary` is gated by `outbound` at `dashboard/src/routes/contact/Timeline.tsx:882-898`, and `showRecipients` has the same gate at `Timeline.tsx:899-907`. An inbound relay source is forced through inbound message-level presentation and its outbound legs have no rendered row.

Implication:

Decide whether inbound relay source bubbles expose outbound fan-out rows, or remove that path from the per-leg observability guarantee. Field propagation alone cannot make the required leg transport visible.

## 4. [HIGH] Group MMS actual transport is assigned to legs the provider never attempted

What is wrong:

The native-group flow gives actual MMS to every recipient slot after a Group MMS post (spec 7.3:298-301), but the presentation contract says a suppressed slot made no provider send and must not claim transport (spec 9.4:434-443).

Evidence:

Existing group delivery code records that Twilio creates no message record and no receipt for a suppressed participant (`app/src/services/groupDelivery.ts:5-21`) and seeds `{ status: 'undelivered', errorCode: 'contact_opted_out' }` (`groupDelivery.ts:49-61`). Group send uses that slot at `app/src/services/groupSend.ts:595-617`.

Implication:

Writing actual MMS to every slot fabricates evidence for a suppressed recipient, while omitting it violates the stated native-group flow. Specify that only provider-attempted non-suppressed legs receive rail evidence.

## 5. [HIGH] The recipient-leg contract both requires actual evidence and permits it to be absent

What is wrong:

Spec 5.3 requires both requested and actual transport for every new outbound recipient leg. That conflicts with actual transport being absent until provider evidence exists (spec 5.2:177-181), relay slots being seeded before fan-out (spec 7.2:281-291), pending slots without actual evidence (spec 9.4:430-437), and optional `actualTransport?` in the send result (spec 6:235-240).

Implication:

The data contract cannot be consistently typed or written. Required requested transport, optional actual evidence, and a separate no-attempt/suppressed shape must be specified.

## 6. [MEDIUM] The presentation matrix omits future or corrupt RCS disagreements

What is wrong:

The outcome says to show requested and actual transport whenever they differ (spec 1:11-29 and 3.2). The single-recipient matrix defines RCS-to-SMS, RCS-to-MMS, SMS-to-MMS, and MMS-to-SMS, but not SMS-to-RCS or MMS-to-RCS (spec 9.3:407-423). It also says the presenter is generic so corrupt or future data remains visible, and expressly keeps the model RCS-ready (spec 3.11-12).

Implication:

Implementers can show an undocumented arrow, collapse to RCS, or fall through to Unknown for the same normalized data. Complete the 3x3 requested/actual matrix or define a generic fallback algorithm.

## 7. [MEDIUM] The inventory misses a direct message-writing dev seam

What is wrong:

The locked scope says to cover dev seams (spec 3.1), and new carrier rows written by runtime, import, or seed code must have schema version 1 (spec 5.2:171-187). The implementation inventory names imports and seeds but not the dev router (spec 12:503-538).

Evidence:

`POST /__dev/extraction/message-fixture` directly writes a `MessageItem` with `type: 'sms'` via `PutCommand`, bypassing `messagesRepo.append`, at `app/src/routes/dev.ts:812-866`. It permits inbound and outbound directions and normal message readers can return the item.

Implication:

This new row renders as legacy SMS unless the spec declares it an intentional legacy-fixture exception or requires version 1 plus appropriate transport fields. The current spec directs both outcomes and gives the builder no choice.
