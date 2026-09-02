# Task 4: direct sends, inbound rows, and status callbacks

## Scene

Tasks 1-3 ship the transport evidence, adapter intent/result, and conditional
persistence contracts. This slice propagates those contracts through direct
outbound sends and the authenticated Twilio inbound/status boundaries without
changing relay fan-out, announcements, native-group outbound, or non-live data.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 4)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\implementation-drift-worklist.md`
- `.superpowers\sdd\phase1-live-worklist.md`
- current source contracts `app/src/lib/messageTransport.ts`,
  `app/src/adapters/messaging.ts`, `app/src/adapters/twilioMessageTransport.ts`,
  `app/src/repos/messagesRepo.ts`.

## Scope and ownership

Own Task 4 only:

- `app/src/services/sendMessage.ts`
- `app/src/routes/webhooks/twilio.ts`
- `app/test/sendMessage.test.ts`
- `app/test/twilioSmsWebhook.test.ts`
- `app/test/twilioStatusWebhook.test.ts`
- `app/test/relayWebhook.test.ts`
- `app/test/groupTextWebhook.test.ts`
- the already-existing direct/broadcast/retry test files reached by Task 0's
  live sweep, only where a failing assertion proves an additive contract update.

Keep later ownership untouched: relay source/fan-out/announcements, native Group
MMS outbound/receipts, imports/seeds/dev/fake controls, projection/dashboard code.
Do not replace existing legacy behavior or broaden types into unrelated services.

## Binding behavior

### Direct outbound

- Classify from durable forwardable-media facts before preparation/execution.
- Append `transportSchemaVersion: 1`, immutable `requestedTransport`, and returned
  `actualTransport` only when the adapter returns it. Keep legacy `type`, media,
  status, audit, SSE, retry, and failure behavior unchanged.
- No provisional row when preparation/provider send fails. A retry creates its own
  new requested/actual evidence, never copying actual from a predecessor.

### Authenticated inbound

- Normalize the exact provider evidence (`From`, `To`, `MessageSid`,
  `ChannelPrefix`, `ChannelMetadata`) at the authenticated provider boundary;
  store only normalized actual on every new carrier row and never requested.
- Ordinary E.164 `SM` is SMS, `MM` is MMS, explicit RCS may be RCS; missing or
  conflict leaves actual absent. Do not infer from body/media/type/status.
- Preserve branch behavior for ordinary, relay, closed-group, native-group, and
  unknown-conversation inbound handling. Native group uses the adapter-owned
  authoritative MMS fact even for text-only, but do not implement Task 7 outbound
  work in this slice.

### Status callbacks

- Never normalize at handler entry. Resolve the stored direct message or relay
  recipient/source first, then normalize with its stored request.
- Keep direct status and actual transport writes independent. Status can advance
  without actual and actual can land when status is same/refused. One SSE event
  when either state write succeeds; none when both no-op.
- Schema-absent direct/relay rows retain legacy status behavior and receive quiet
  `legacy_noop` transport handling. Missing/system/unknown callbacks retain current
  ack/log behavior without invented facts.
- RCS fallback/stale/conflict must use the Task 1 state machine. Safe warnings
  only: IDs/enums/schemes, never phone numbers or raw channel address. No fake
  `ChannelPrefix` for SMS/MMS.

## TDD proof

Write failing focused tests before code. Cover text/media/broadcast/retry direct
paths, direct no-row failure, every named inbound branch, status-vs-actual
independence, stored-request fallback classification, legacy compatibility, and
SSE/no-op behavior. Include negative assertions for no inbound requested and no
fabricated channel prefix.

Run and record exact outcomes:

```
npm run test -w @housingchoice/app -- test/sendMessage.test.ts test/twilioSmsWebhook.test.ts test/twilioStatusWebhook.test.ts test/relayWebhook.test.ts test/groupTextWebhook.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run aggregate gates/e2e. If Vite `.vite-temp` EPERM happens before Vitest
starts, report it separately then use the allowed environment for red/green proof.

## Commit/report discipline

Read bare `git status` and `.git/MERGE_HEAD` before committing; stage exact paths
only and never `git add -A`. Commit as:

`feat: record transport on direct message flows`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Write TDD counts,
commit, files, compatibility decisions, and unexpected importer/contract issues to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-4-report.md`.
Do not commit that raw report. Stop on an unexpected cycle or mismatch rather than
spilling into later work.
