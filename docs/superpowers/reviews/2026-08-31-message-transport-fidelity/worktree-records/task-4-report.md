# Task 4 report - direct sends, inbound rows, and status callbacks

## Commit

- `eea8a4fe7a8fbadf57371bf16d7c30f106d3f896 feat: record transport on direct message flows`

## Shipped

- Direct sends now classify immutable requested transport before late preparation
  and provider execution. Successful rows append schema version 1, requested
  transport, and provider-returned actual transport when present. Existing
  `type`, media, audit, SSE, broadcast, retry, and no-provisional-row behavior is
  unchanged.
- Authenticated inbound Twilio traffic is normalized once from provider fields at
  the webhook boundary. Ordinary, relay, closed-group, unknown-conversation, and
  fail-open carrier rows append schema version 1 plus normalized actual only.
  Native group rows append authoritative actual MMS even when text-only. No
  inbound path appends requested transport.
- Direct and relay status callbacks resolve stored request context before
  normalization. Delivery status and actual transport write independently, and
  the existing SSE event fires once when either write changes state. Legacy rows
  retain delivery transitions while transport writes return `legacy_noop`.
- Conflict warnings contain provider SID, request/transport enums, evidence
  source, and sanitized schemes only. SMS/MMS tests do not fabricate
  `ChannelPrefix`.

## TDD and verification

- First sandboxed Vitest attempt: exit 1 before test start on the documented Vite
  `.vite-temp` EPERM. The same command was rerun in the allowed environment.
- Direct-send red proof: exit 1, 5 failing and 28 passing tests. Failures were
  absent schema/request/actual fields, missing classify/prepare calls, and the
  old send path bypassing the injected prepared-send failure.
- Complete focused red proof: exit 1, 14 failing and 211 passing tests across the
  five required files. Failures covered all new direct, inbound branch, direct
  status, relay status, native-group, legacy, and SSE assertions.
- Final required focused command: exit 0, 5 files and 225 tests passed.
- `npm run typecheck -w @housingchoice/app`: first exit 1 on the newly narrowed
  adapter fake contract in `scheduledSendSuppression.test.ts`; after the additive
  fake update, final exit 0.
- Compatibility fake check: exit 0, 1 file and 23 tests passed.
- Focused ESLint over all nine touched TypeScript files: exit 0.
- `git diff --check`: exit 0. Added-lines ASCII check: clean.

## Files

- `app/src/services/sendMessage.ts`
- `app/src/routes/webhooks/twilio.ts`
- `app/test/sendMessage.test.ts`
- `app/test/twilioSmsWebhook.test.ts`
- `app/test/twilioStatusWebhook.test.ts`
- `app/test/relayWebhook.test.ts`
- `app/test/groupTextWebhook.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`
- `app/test/scheduledSendSuppression.test.ts`

## Compatibility decisions and scope notes

- `twilioWebhookHarness.ts` is outside the five named test files but is the shared
  adapter fake used by their direct-send, retry, and echo integrations. Once
  `sendMessage` consumed `CarrierMessageSender`, seven focused tests failed at
  runtime until this fake implemented classify/prepare/sendPrepared. The change
  mirrors the already-shipped adapter contract and is test-only.
- `scheduledSendSuppression.test.ts` is outside the core list but its direct-send
  fake became structurally invalid for the same required adapter intersection.
  App typecheck failed with TS2322 until that fake received the additive carrier
  methods; its 23-test file was then run green.
- No unexpected production importer, dependency cycle, or spec/plan contract
  mismatch was found. No relay fan-out, announcements, native-group outbound,
  seeds/dev/imports, projections, dashboard, or fake-provider controls were
  changed.
