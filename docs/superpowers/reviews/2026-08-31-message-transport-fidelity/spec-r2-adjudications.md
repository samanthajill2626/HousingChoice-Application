# Message transport fidelity design - round 2 adjudications

Spec reviewed: v2
Reviewer: spec review round 2 A
Findings: 6

Disposition counts:

- ACCEPT: 6
- REJECT: 0
- DEFER: 0

## 1. Relay source seeding contradicts late suppression

Disposition: ACCEPT

The underlying conflict is valid. The v3 contract defines requested transport
as adapter-selected intent, not proof that the provider was invoked. A slot may
therefore retain requested transport when a later suppression check prevents the
send, while actual transport remains absent. This preserves the existing late
suppression race and avoids deleting an immutable field.

This remedy supersedes the round-1 A4, A5, and B3 remedy that said a suppressed
slot carries neither requested nor actual transport. It preserves the accepted
round-1 concern: suppression must never fabricate actual provider evidence.

## 2. Post-send whole-slot writes erase transport evidence

Disposition: ACCEPT

The repository contract now requires a child-field producer-result operation for
relay fan-out and persisted announcement success and failure paths. It updates
status, SID, sent timestamp, error, and actual transport without replacing the
slot or requested intent. Whole-slot `setRecipientDelivery` is limited to true
initial slot creation.

## 3. Captured inbound relay recipients change routing

Disposition: ACCEPT

The inbound expected-set capture is removed. Every fan-out execution continues
to resolve the current roster, exactly preserving membership-at-execution and
retry behavior. The inbound source chip reports only inbound actual transport;
outbound slots are progressive disclosure and do not need a frozen completeness
set.

## 4. Empty captured map has no initialization state

Disposition: ACCEPT

The capture mechanism is removed, so no map sentinel or initialization marker is
needed. An empty inbound recipient map remains the current ordinary state and
later executions continue to resolve current membership.

## 5. Prebuilt inbound plans can expire media URLs

Disposition: ACCEPT

The adapter contract is split into durable transport-intent classification and
late executable-plan preparation. Intent contains no presigned URLs. Relay jobs
materialize fresh media parameters for each leg immediately before preparing and
executing that send.

## 6. Plan mismatch refusal changes delivery behavior

Disposition: ACCEPT

A queued classification mismatch now emits a structured warning but continues
the current send path. It preserves the original requested intent, never
fabricates actual transport, and introduces no new refusal mode.

## Resulting invariant

Transport capture is observational. It may add metadata and warnings, but it
does not freeze rosters, move suppression checks, reuse expiring media material,
or refuse a send that the current system would attempt.
