# Task 1 report - domain and Twilio evidence normalizer

## Status

Complete on `feat/message-transport-fidelity` at
`4f5d2fcaf9280829323cc0e5c0d6ed4df0725ae7`.

## TDD proof

The first sandboxed attempt at the focused command exited 1 before Vitest could
load because Vite could not create `app/node_modules/.vite-temp` (`EPERM`). I
re-ran the same bare command with the required filesystem permission so the red
result tested the intended missing production modules.

Expected red command:

```text
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
EXIT 1
Test Files  2 failed (2)
Tests  no tests
Cannot find module '../src/lib/messageTransport.js'
Cannot find module '../src/adapters/twilioMessageTransport.js'
```

Final focused green command on the committed tree:

```text
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
EXIT 0
Test Files  2 passed (2)
Tests  49 passed (49)
```

Final app typecheck on the committed tree:

```text
npm run typecheck -w @housingchoice/app
EXIT 0
tsc -p tsconfig.json --noEmit && tsc -p tsconfig.scripts.json && tsc -p tsconfig.test.json
```

## Shipped contract

- Added `TRANSPORT_SCHEMA_VERSION`, the closed `MESSAGE_TRANSPORTS` tuple,
  `MessageTransport`, and `TransportAggregationState` without changing
  `MessageType`.
- Added `decideActualTransportWrite(current, attempted, requested)` with absent,
  idempotent, RCS fallback, stale RCS callback, and conflict classifications.
- Added `decideTransportAggregationWrite(current, attempted, actualTransport?)`
  with the approved absent/planned/attempted/excluded transitions. `attempted` is
  terminal, and an excluded slot with actual evidence cannot return to planned.
- Added pure `normalizeTwilioTransportEvidence(input)` at the provider adapter
  boundary. It recognizes only documented RCS `From`, RCS `ChannelMetadata`,
  unambiguous RCS `ChannelPrefix`, and valid SM/MM Message-resource SIDs under
  the approved direction/request/endpoint guards.
- RCS evidence precedes SID inspection. Inbound SID classification requires an
  E.164 `To`; RCS fallback classification requires a stored RCS request, E.164
  `From`, and no channel field. SMS/MMS outbound classification requires stored
  SMS/MMS request context.
- Conflicts return only safe SID prefixes and channel schemes. The normalizer
  performs no logging, exposes no address suffix, and downgrades unauthenticated
  conflicts to missing evidence. Non-provider fixture SIDs remain quiet missing
  evidence.
- The SID comment records all four locked provider references and explicitly
  states that SM/MM classify Message-resource creation, not general delivery
  transport.

## Files

- `app/src/lib/messageTransport.ts`
- `app/src/adapters/twilioMessageTransport.ts`
- `app/test/messageTransport.test.ts`
- `app/test/twilioMessageTransport.test.ts`

All added lines passed an ASCII-only scan. The staged diff passed
`git diff --cached --check` before commit.

## Commit

```text
4f5d2fcaf9280829323cc0e5c0d6ed4df0725ae7 feat: add normalized message transport evidence

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

## Decisions and concerns

- Downstream persistence should use the exported transition classifiers rather
  than duplicating their state logic.
- `NormalizedTransportEvidence.source` remains a string as specified; callers
  should branch on `kind` and normalized transport, treating source as safe
  observability context rather than routing policy.
- No unexpected importer, dependency cycle, or contract mismatch was found.
- No product concern remains. The only execution issue was the initial sandbox
  cache-directory `EPERM`; the valid red and both final checks completed with the
  required permission.
