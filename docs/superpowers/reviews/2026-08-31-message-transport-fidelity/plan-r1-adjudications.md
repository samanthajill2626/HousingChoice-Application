# Plan review round 1 adjudications - message transport fidelity

Date: 2026-09-01
Plan under review: `docs/superpowers/plans/2026-09-01-message-transport-fidelity.md`
Reviewed commit: `bf4feb04`
Reviewers: R1-A and R1-B

## Outcome

All five unique findings are accepted. The duplicate nonexistent-status-type
finding is adjudicated once and credited to both reports. The plan is revised
before round 2; no product code was changed.

## A1 - Status callback normalized before stored request was available

Severity: HIGH
Decision: ACCEPT

The original Task 4 ordering was internally inconsistent. RCS fallback cannot be
normalized without the stored request, while the current status handler resolves a
direct message or relay SID pointer only after parsing the callback. The revised
plan distinguishes inbound from status handling. Status processing completes the
existing MessageSid lookup/retry first, then reads direct
`requested_transport` or resolves the relay source through
`messages.getByTsMsgId(ptr.conversationId, ptr.tsMsgId)` and the addressed slot.
Only then does the provider-boundary normalizer receive raw callback fields. Tests
now compare identical callback evidence under RCS, SMS/MMS, and absent request
contexts.

## A2 - Full-profile cast messages omitted

Severity: HIGH
Decision: ACCEPT

`app/src/lib/seed/index.ts` merges `castItems()` into the full world, and
`app/src/lib/seed/cast.ts` contains carrier messages. The revised Task 8 owns
`cast.ts` and requires every cast carrier row to use the explicit declaration
helper unless a fixture is deliberately named and asserted as legacy. Existing
full-profile seed tests own the red/green proof.

## A3/B3 - Nonexistent `RelayRecipientStatus`

Severity: MEDIUM
Decision: ACCEPT

The repository uses the existing `DeliveryStatus` union. The plan now types
`RecipientSendResultPatch.status` as `DeliveryStatus`; its tests retain explicit
accepted-to-queued, forward-only, and metadata-independent behavior.

## B1 - Inbound relay sender could receive a permanent planned slot

Severity: HIGH
Decision: ACCEPT

The preflight candidate set must match the current send set, not the raw roster.
The current worker excludes `senderKey` and applies continuation recipient filters
before sending. The revised global constraint and Task 5 define preflight as all
eligible recipients after those exact filters. An inbound sender gets no slot, does
not appear in disclosure, and cannot hold aggregation pending. A stale source-time
sender slot is reconciled out rather than recreated.

## B2 - Fake signer controls did not reach the real callback engine

Severity: HIGH
Decision: ACCEPT

The signer alone cannot prove the fake-provider control path. The revised Task 8
also owns `fake-twilio/src/engine/types.ts`, `engine.ts`, optional control-route
validation, engine/control tests, and the e2e `setDeliveryOutcome` DTO. The stored
thread message supplies default `From`/`To`; explicit delivery-profile evidence may
override those and add RCS-only channel fields. Tests must carry the fields through
the control route, scheduled signed callback, and signer. A direct signer test is
only supplemental.

## Round 2 targets

The continuing reviewers should re-attack the five remedies in the revised plan
and search for newly exposed gaps, especially source-slot reconciliation,
status-callback relay reads, cast-world completeness, and fake profile validation.
