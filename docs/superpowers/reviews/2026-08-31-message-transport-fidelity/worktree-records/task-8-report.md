# Task 8 report: explicit non-live transport fixtures

## Shipped

- Evidence-free imports remain schema-absent; the integration regression test pins absence of version, requested, and actual transport fields.
- Added `withSeedTransport`, which accepts only an explicit legacy/versioned declaration, copies only declared facts, rejects inbound requested transport, and does not inspect type, body, media, or conversation kind.
- Lean and full cast carrier rows now declare transport facts explicitly. Lean includes ordinary SMS, native Group MMS despite legacy `type: 'sms'`, pending RCS, RCS-to-SMS fallback, complete mixed recipients, unresolved inbound, and one named legacy fixture.
- Performance carrier rows explicitly declare SMS or native Group MMS facts. The live and matrix layers prove they generate zero carrier rows.
- The dev message fixture defaults to versioned inbound SMS, supports validated legacy/versioned requested/actual inputs, rejects invalid transports and inbound requested facts, keeps `dev-*` SIDs, and still writes no pointer item.
- Fake Twilio carries explicit From/To/ChannelPrefix/ChannelMetadata through inbound and scheduled signed status callbacks. Metadata objects serialize once; strings pass through unchanged. SMS/MMS ChannelPrefix values are rejected, while explicit `rcs` is supported.
- Fake Programmable Messaging SIDs are provider-shaped SM/MM plus 32 hex digits. The directly affected Conversations fixture assertions were updated to the provider-shaped contract.
- E2E fake helpers expose the same inbound and delivery-outcome transport controls.

## TDD evidence

- Initial app focused command: exit 1 on missing seed declarations/dev controls (seedData, seedMatrix, performanceSeed, and dev fixture failures); import compatibility already passed as intended.
- Initial fake focused command: exit 1 on absent signer/engine/control propagation.
- Additional red proof: fake focused command exit 1 when SMS ChannelPrefix was still accepted by signer and control.

## Final verification

- `npm run test -w @housingchoice/app -- test/seedData.test.ts test/seedLive.test.ts test/seedMatrix.test.ts test/performanceSeed.test.ts test/performanceSeed.integration.test.ts test/importApply.integration.test.ts test/devMessageTransportFixture.test.ts`: exit 0; 7 files passed.
- `npm run test -w @housingchoice/fake-twilio -- test/signer.test.ts test/engine.test.ts test/control.test.ts`: exit 0; 3 files, 36 tests passed.
- `npm run typecheck -w @housingchoice/app`: exit 0.
- `npm run typecheck -w @housingchoice/fake-twilio`: exit 0.
- `npm run typecheck -w @housingchoice/e2e`: exit 0.
- `git diff --check`: exit 0.
- Added-line ASCII scan: clean.
- Commit: `e924b412 test: make transport evidence explicit in fixtures`.

## Scope notes

- `app/src/lib/import/apply.ts`, `app/src/lib/seed/live.ts`, and `app/src/lib/seed/matrix.ts` required no runtime edits: imports intentionally remain unchanged and the live/matrix layers author no message rows. Their focused tests pin those contracts.
- No broad gate or Playwright run was performed, per Task 8 brief.
