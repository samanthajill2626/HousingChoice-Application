# Task 8 fix-wave 1 rereview - 6e827ae0

Verdict: CONFORMS / PASS

Scope: cold, read-only review of the F1-F4 fix commit `6e827ae0`, its live
implementation and focused regression tests. No source edits were made.

## Finding resolution

- F1 CONFORMS. `app/src/lib/seed/cast.ts:18-43` removes
  `msg-cast-milu-003` from the explicit inbound-SMS declaration and adds it to
  the explicit inbound-MMS declaration. `declareCastMessageTransport` still
  selects only a predeclared ID-to-fact map; it does not inspect message type,
  body, media, or conversation data. `app/test/castMessageTransport.test.ts:5-15`
  now proves every full-cast MMS/media row is versioned with actual MMS,
  including the photo row at `cast.ts:1246-1257`.
- F2 CONFORMS. `e2e/fixtures/fakeTwilio.ts:39-44` accepts precisely omitted or
  `rcs`, and `postInboundSms` invokes it before composing/signing the webhook
  form at `:73-86`. The typed input is likewise narrowed to that union. The
  focused test covers omitted/`rcs` acceptance and `sms`/`mms` rejection at
  `e2e/support/fakeTwilioChannelPrefix.test.ts:4-11`; inspection confirms the
  exercised validator is on the helper's execution path. The independent fake
  engine control continues to reject non-RCS evidence at
  `fake-twilio/src/engine/engine.ts:166-171`.
- F3 CONFORMS. The shared declaration guard rejects a versioned outbound row
  without requested transport at `app/src/lib/seed/messageTransport.ts:40-43`.
  The dev endpoint applies the same boundary rule before its put at
  `app/src/routes/dev.ts:884-903`; `app/test/devMessageTransportFixture.test.ts:61-71`
  covers the rejected request and no-write outcome. The companion seed test
  retains allowed unresolved inbound and legacy outbound cases.
- F4 CONFORMS. `fake-twilio/web/src/api/types.ts:16-29` exactly mirrors the
  engine `DeliveryProfile.transportEvidence` shape at
  `fake-twilio/src/engine/types.ts:21-34` (optional from, to, channelPrefix,
  and object-or-string channelMetadata). The web client passes that typed
  profile to the same control endpoint.

## Test and lint review

- The new F1/F2/F3 tests are focused on the resolved failure modes and would
  fail with the corresponding complete fix reverted.
- `git diff --check 6e827ae0^ 6e827ae0` was clean.
- Exact changed-file ESLint reproduced only four pre-existing `cast.ts`
  unused-variable errors at lines 79, 102, 103, and 427. They are outside this
  diff and match the fix-wave report; every other changed file produced no
  lint diagnostics. No new lint error found.

No new finding identified in the fix diff. Task 8 may proceed.
