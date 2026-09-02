# Task 4 implementation review - `eea8a4fe`

Scope reviewed: direct sends, all reachable inbound filing branches, direct and
relay status callbacks, their repository update contracts, provider normalizer,
and the Task 4 focused test fakes.

## Required finding

### P1 - Native-group inbound actual transport is fabricated in the generic webhook

`app/src/routes/webhooks/twilio.ts:1732-1745` appends every detected native-group
message with the literal `actualTransport: 'mms'`. No group adapter or
native-group normalizer is consulted on this inbound path. The Task 4 plan requires
native-group branches to use the group adapter's authoritative MMS evidence, and
the approved design section 4.2 says the group-rail fact belongs in the group
adapter/normalizer rather than generic webhook/business logic.

This happens to match the current rail, but it makes the generic SMS webhook the
authority. A future native rail, an adapter-level safety check, or a changed
provider group endpoint can return different/no evidence while the stored row will
still assert MMS. The existing regression test only asserts the hard-coded stored
value (`app/test/groupTextWebhook.test.ts:402-408`), so it cannot distinguish an
adapter-owned observation from the fabricated literal.

Reproduction: replace the current Group MMS adapter/normalizer's inbound result
with an absent or non-MMS observation (or inject a fake that records/returns it),
then POST the existing signed `groupParams()` fixture. The route never calls that
seam and persists `actual_transport: 'mms'` unconditionally. Add a test proving the
native-group branch consumes only the adapter-owned authoritative observation; raw
`OtherRecipients`, media count, ordinary SMS normalizer output, and a receipt SID
must not originate it.

Required remediation: expose/use the native-group adapter or a dedicated
provider-boundary group normalizer for the inbound observation, retain the current
MMS result only when that authority supplies it, and extend the signed webhook test
to prove the dependency. Keep ordinary direct/relay normalization separate.

## Conforming checks

- Direct service classification precedes preparation/execution and persists the
  immutable requested value plus only returned actual evidence
  (`app/src/services/sendMessage.ts:384-421`). Provider failure occurs before the
  append (`:394-398`), so no provisional row is created.
- All reachable ordinary inbound, relay, and closed-relay append paths now set
  schema version 1 and copy only the normalized inbound actual value
  (`app/src/routes/webhooks/twilio.ts:619-633`, `994-1034`, `2176-2200`).
  They do not write requested transport.
- Direct and relay status paths resolve stored request context before invoking the
  normalizer (`app/src/routes/webhooks/twilio.ts:2432-2448`, `2516-2595`), then
  independently attempt delivery and actual writes. They emit one SSE event when
  either operation writes and none when both are no-ops (`:2495-2511`, `:2635-2647`).
- Callback evidence is kept at the provider boundary, and the Task 1 normalizer
  does not manufacture SMS/MMS `ChannelPrefix` evidence. The fake supports the
  new classify/prepare/send contract (`app/test/helpers/twilioWebhookHarness.ts:3614-3639`).

## Focused verification

Attempted the permitted Task 4 focused command:

```text
npm run test -w @housingchoice/app -- test/sendMessage.test.ts test/twilioSmsWebhook.test.ts test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts test/groupTextWebhook.test.ts
```

It did not start tests: Vitest failed while writing
`app/node_modules/.vite-temp/vitest.config.ts.timestamp-...mjs` with Windows
`EPERM` (exit 1). This is an environment/file-lock failure, not a test assertion
result; no code was changed for it.

PARTIAL/NEEDS_FIX
