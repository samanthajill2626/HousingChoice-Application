# Message transport fidelity design - spec review round 2 A

Scope: adversarial re-review of the v2 specification and round-1 adjudications. All existing behavior below was verified in the reviewed worktree.

## 1. [BLOCKING] Relay source seeding still contradicts the late suppression rule

What is wrong:

The revised contract correctly says a suppressed no-attempt slot carries neither transport field (spec 5.3:208-213 and 7.3:332-337). It still requires every team-authored relay source to seed every recipient slot with requested transport before enqueue (spec 7.2:304-306). Those conditions cannot both hold because suppression is intentionally evaluated later in the fan-out job, not before the source is persisted. The same unresolved shape exists for persisted relay announcements, which the spec says use the same slot contract (spec 7.2:327-328).

Evidence:

The open team-send route builds a queued slot for every roster member and persists it before enqueue at `app/src/routes/api.ts:1761-1810`. The job checks `isMemberSuppressed` only after it reads that source and begins each leg at `app/src/jobs/relayFanOut.ts:443-482`. Persisted announcements likewise append queued slots for every roster member at `app/src/services/relayAnnouncements.ts:183-208`, then discover suppression only in the per-member loop at `relayAnnouncements.ts:230-249`.

Implication:

For an opted-out member, the builder must either write requested transport before knowing it is a no-attempt slot, later delete an immutable requested value, or change when suppression is evaluated. The first two violate locked rules and the third changes an established send/suppression race. Define an explicit requested-but-not-attempted state or a safe pre-enqueue suppression protocol before implementation.

## 2. [HIGH] Existing post-send slot writes will erase the newly seeded transport evidence

What is wrong:

The revised spec says requested transport is immutable, actual/status/SID writes preserve one another, and repository methods update only child fields (spec 8.1:371-378 and 8.4:405-418). It leaves `setRecipientDelivery` as the initial seed but does not specify a replacement result writer for the two paths that currently use that whole-slot method after a provider outcome. Adding requested/actual fields to the seed without changing those paths loses the fields immediately.

Evidence:

`messagesRepo.setRecipientDelivery` executes `SET delivery_recipients.#mk = :d`, replacing the entire slot at `app/src/repos/messagesRepo.ts:2766-2786`. Relay fan-out calls it after a successful provider result with only status/SID/sentAt at `app/src/jobs/relayFanOut.ts:538-549`, and on every failure path at `relayFanOut.ts:510-530` and `572-576`. Persisted relay announcements do the same after success and failure at `app/src/services/relayAnnouncements.ts:281-303` through `markSlot` at `relayAnnouncements.ts:325-333`.

Implication:

The advertised immutable requested transport and immediate actual evidence are not durable unless the design names a child-field send-result writer, its conditional behavior, and every replacement call site. The listed callback-only child-field rule is insufficient because these are producer-result writes, not callbacks.

## 3. [HIGH] The captured inbound relay recipient set changes routing despite the stated no-routing-change guarantee

What is wrong:

To satisfy the earlier completeness finding, v2 requires the first inbound relay fan-out execution to capture a roster-derived map and forbids later jobs from replacing it from a later roster read (spec 7.2:308-316). The outcome and non-goals still say this mission does not change routing or delivery behavior (spec 1:36-37 and 15:677-680). This is an actual routing change for a job that fails after capture but before some/all sends: later membership mutations no longer affect the redelivery.

Evidence:

Current fan-out deliberately resolves current membership at every execution so a mid-thread removal takes effect immediately (`app/src/jobs/relayFanOut.ts:398-400`), builds recipients from that roster at `relayFanOut.ts:434-438`, and a failed job can be delivered again after the source remains queued (`relayFanOut.ts:524-535`). The revised captured-map rule replaces that behavior for inbound source retries.

Implication:

Either authorize and document the routing semantic change, or define a completeness mechanism that preserves current membership-at-execution behavior. Calling the new snapshot "exactly where it does today" does not preserve the behavior after the new durable capture point.

## 4. [HIGH] An empty captured relay map is indistinguishable from the existing uninitialized map

What is wrong:

The v2 mechanism relies on an atomically seeded map as the durable expected-leg-set marker (spec 7.2:311-316), but the inbound relay source already persists an empty `delivery_recipients` map before fan-out. An empty expected set is valid when the only current roster member is the inbound sender, so `{}` cannot distinguish "not initialized; resolve roster" from "initialized; zero outbound legs; adopt it." No separate initialization/version field or map sentinel is specified.

Evidence:

The inbound writer persists `deliveryRecipients: {}` at `app/src/routes/webhooks/twilio.ts:581-600`. Fan-out excludes the sender from the recipient roster at `app/src/jobs/relayFanOut.ts:434-438`. A one-member relay group is allowed because creation requires only a non-empty member array at `app/src/routes/relayGroups.ts:383-388`, and removal can permit the final member to be removed unless an optional guard is enabled at `app/src/services/relayMembers.ts:325-330`.

Implication:

A redelivery after a zero-leg capture can reclassify the map as uninitialized and fan out the old inbound text to a newly added member, violating the new immutable-set rule. Specify a distinct durable capture marker and its conditional write semantics; the map alone cannot serve both roles.

## 5. [HIGH] Preparing every inbound relay leg before the first send conflicts with the current per-leg fresh-media contract

What is wrong:

V2 requires the inbound job to prepare every eligible send before it seeds the complete map and before the first provider send (spec 7.2:308-314). A prepared plan contains `SendMessageParams` (spec 6:241-252), which includes media URLs. The current relay contract intentionally produces those URLs one leg at a time immediately before send because a paced or retried fan-out must never receive an expired URL. The spec provides no separate immutable transport-classification plan versus late-bound executable send plan.

Evidence:

Current fan-out states that media is presigned fresh for each leg at send time so a paced roster or continuation never uses an expired URL, then passes those URLs straight to the adapter at `app/src/jobs/relayFanOut.ts:490-509`. Team source rows deliberately persist durable attachment keys rather than presigned URLs for the same reason at `app/src/routes/api.ts:1796-1799`.

Implication:

Executing the prebuilt plans can regress MMS delivery through expired URLs; rebuilding them later means the initially prepared plan was not the plan executed and reopens the requested-transport mismatch problem. Define a two-stage adapter contract in which immutable transport classification is separated from late media materialization, or state exactly how one plan preserves fresh URLs across paced/retried legs.

## 6. [HIGH] Refusing a queued send on plan mismatch contradicts the no-delivery-behavior-change claim

What is wrong:

The spec says the mission does not alter delivery behavior (spec 1:36-37), yet requires a recreated queued plan that differs from the persisted requested transport to refuse the send (spec 6:277-281). That inserts a new failure mode into relay delivery rather than merely recording observability data.

Evidence:

The current fan-out executes the adapter send for each eligible recipient without any persisted-transport mismatch refusal at `app/src/jobs/relayFanOut.ts:485-509`. A policy/configuration change between enqueue and execution therefore has no current transport-gated refusal.

Implication:

The design must either declare this as an intentional delivery-policy change with an operator recovery path, or preserve delivery behavior by recording the mismatch while executing under a defined policy. It cannot accurately promise both a refusal and unchanged delivery behavior.
