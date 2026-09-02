# Task 8 fix wave 1 report

Commit: `6e827ae0 fix: validate explicit fixture transport`

## Findings resolved

- F1: `msg-cast-milu-003` is now declared in the explicit inbound-MMS list. The cast regression asserts every MMS/media scenario is versioned with `actual_transport: 'mms'`.
- F2: direct e2e inbound helper input accepts only omitted or `rcs` ChannelPrefix and rejects fabricated `sms`/`mms` values before signing the callback.
- F3: shared seed declaration validation rejects versioned outbound messages with no requested transport; the dev fixture route returns 400 for that input. Versioned unresolved inbound and legacy outbound remain valid.
- F4: fake-web `DeliveryProfile` mirrors engine `transportEvidence`.

## Red-first evidence

- Before the implementation, `app/test/castMessageTransport.test.ts` observed `msg-cast-milu-003` with `actual_transport: 'sms'`, and `app/test/seedMessageTransport.test.ts` observed versioned outbound without a request being accepted.
- Before the implementation, `e2e/support/fakeTwilioChannelPrefix.test.ts` observed fabricated `sms` and `mms` prefixes being accepted.

## Focused verification

- `app: npx vitest run test/castMessageTransport.test.ts test/seedMessageTransport.test.ts test/devMessageTransportFixture.test.ts` - exit 0, 3 files / 12 tests.
- `e2e: npx vitest run support/fakeTwilioChannelPrefix.test.ts` - exit 0, 1 file / 4 tests.
- `app: npm run typecheck` - exit 0.
- `e2e: npm run typecheck` - exit 0.
- `fake-twilio/web: npm run typecheck` - exit 0.
- Exact changed-file ESLint - no new errors. `app/src/lib/seed/cast.ts` retains four pre-existing unused-variable errors at 79, 102, 103, and 427; lint of every other changed file exits 0.
