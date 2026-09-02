# Plan review r2 A - message transport fidelity

Verdict: PASS - implementation may launch.

Counts: BLOCKING 0, HIGH 0, MEDIUM 0, LOW 0.

## Result

No actionable findings. The revised plan is concrete enough to implement the
approved transport-fidelity design without changing the specified legacy routing,
delivery, suppression, media, or provider-evidence boundaries.

## Round-1 finding disposition

1. RESOLVED - status callback normalization no longer precedes the lookup that
supplies requested intent. Task 4 resolves a direct source or relay SID pointer,
reads the direct message or addressed recipient slot, and only then calls the
provider-boundary normalizer with raw callback facts and the resolved request
(plan Task 4.2-4.4, lines 613-667). This is implementable against the existing
lookup sequence in `app/src/routes/webhooks/twilio.ts:2406-2434` and the existing
point-read method in `app/src/repos/messagesRepo.ts:1236`.

2. RESOLVED - Task 8 explicitly owns `app/src/lib/seed/cast.ts`, requires every
carrier `castItems()` row to use the declaration helper unless it is a named,
asserted legacy fixture, and owns the existing full-profile seed tests (plan Task
8, lines 963-1041). This covers the current full-profile merge of `castItems()`
identified in the round-1 review.

3. RESOLVED - `RecipientSendResultPatch.status` now uses the existing
`DeliveryStatus` union (plan Task 3, lines 489-495), and the contract tests retain
the queued-status metadata and forward-transition cases (lines 525-534).

## Attacked but not broken

- The relay preflight is now defined over the exact sender- and continuation-
filtered candidate set, initializes only absent eligible slots, and reconciles a
source-time sender slot out before sending (plan Task 5, lines 729-803). This
matches the current worker's sender and continuation filtering in
`app/src/jobs/relayFanOut.ts:434-448`.
- The fake-provider evidence path is no longer signer-only. Task 8 owns the fake
engine types, scheduled callback, control route when validation is needed, tests,
and the e2e DTO; its callback defaults are based on the stored outbound message's
real `from` and `to` fields (plan Task 8, lines 977-987 and 1060-1095). Current
fake messages retain those fields at `fake-twilio/src/engine/types.ts:30-45` and
the engine schedules callbacks from the stored outbound message path at
`fake-twilio/src/engine/engine.ts:425-502`.
- Native Group MMS, versioned/legacy dev fixtures, explicit seed worlds, and one
hermetic browser spec each have an owned task and focused red/green checks (plan
Tasks 7, 8, and 12). The plan does not rely on fabricated SMS/MMS `ChannelPrefix`
evidence.
