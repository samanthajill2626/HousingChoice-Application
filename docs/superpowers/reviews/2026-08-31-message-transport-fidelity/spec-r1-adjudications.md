# Message transport fidelity spec review round 1 adjudications

Date: 2026-08-31
Spec revision before adjudication: `73e711b5`
Reports: `spec-review-r1-a-findings.md`, `spec-review-r1-b-findings.md`

Counts: 10 findings; 10 ACCEPT; 0 REJECT; 0 DEFER.

## Reviewer A

### A1. Optimistic bubbles have no defined way to suppress the legacy chip

Decision: ACCEPT.

The spec now defines a local-only `optimistic: true` marker, requires all three
optimistic writers to stamp and preserve it until server refetch, and gives that
marker precedence over the schema-absent legacy rule.

### A2. Inbound relay fan-out cannot establish the recipient set required for complete or Mixed transport

Decision: ACCEPT.

The first fan-out execution now resolves the roster and suppression state, builds
the complete slot map, and conditionally seeds it atomically before any provider
send. That captured map is the expected set for completeness and redelivery.

### A3. Inbound relay fan-out leg transport will be stored but cannot be rendered

Decision: ACCEPT.

The revised presentation contract explicitly allows recipient disclosure on an
inbound relay source. Its main chip remains inbound actual-only; expanded rows
show the independently outbound legs.

### A4. Group MMS actual transport is assigned to legs the provider never attempted

Decision: ACCEPT.

Only non-suppressed provider-attempted Group MMS slots receive requested/actual
transport. Suppressed slots retain status/error only and render no transport.

### A5. The recipient-leg contract both requires actual evidence and permits it to be absent

Decision: ACCEPT.

The contract now requires requested transport only for provider-attempted legs,
makes actual optional until evidence exists, and defines suppressed no-attempt
slots as carrying neither transport field.

### A6. The presentation matrix omits future or corrupt RCS disagreements

Decision: ACCEPT.

The partial table is replaced by a generic algorithm covering all nine known
SMS/MMS/RCS requested/actual pairs, including SMS -> RCS and MMS -> RCS.

### A7. The inventory misses a direct message-writing dev seam

Decision: ACCEPT.

`app/src/routes/dev.ts` is now an explicit implementation and test surface. Its
fixture defaults to version 1 and supports legacy only when the test requests it.

## Reviewer B

### B1. The prepared-send contract cannot satisfy pre-send persistence

Decision: ACCEPT.

The impossible durable pre-send-row claim is removed. The adapter fixes requested
transport in an immutable plan before execution, while direct/group rows retain
their existing send/post-then-append ordering because the returned SID and
timestamp form the key. No provisional-row protocol is introduced.

### B2. Inbound relay fan-out has mutually exclusive presentation rules

Decision: ACCEPT.

The main chip and recipient disclosure now have separate precedence rules: the
inbound source chip uses inbound actual only, while expanded rows describe the
outbound fan-out. Slots never replace an inbound main chip.

### B3. The per-recipient contract contradicts its suppression rule

Decision: ACCEPT.

Suppressed no-attempt slots are excluded from the transport-field requirement,
store neither requested nor actual, and retain their existing suppression copy.
