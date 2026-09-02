# Task 5: transport-aware Relay fan-out with exact legacy compatibility

## Scene

Direct paths now write versioned transport evidence. This slice adds immutable
source intent and recipient evidence to Relay source/fan-out execution, while a
schema-absent source must follow the exact previous worker path with no transport
calls whatsoever.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 5 in full)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\implementation-drift-worklist.md`
- `.superpowers\sdd\phase1-live-worklist.md`
- Delivered contracts in `app/src/lib/messageTransport.ts`,
  `app/src/adapters/messaging.ts`, `app/src/repos/messagesRepo.ts`, and Task 3/4
  slice records under `docs\superpowers\reviews\2026-08-31-message-transport-fidelity\`.

## Scope and ownership

Own only:

- `app/src/routes/api.ts`
- `app/src/jobs/relayFanOut.ts`
- `app/src/services/relayQueuedMessages.ts` only when current main's signature
  requires explicit type propagation; do not change release behavior
- `app/test/relayApi.test.ts`
- `app/test/relayFanOut.test.ts`
- `app/test/relayQueuedMessages.test.ts` only if current typecheck proves a
  propagation update is needed
- required full test fakes only where focused tests/typecheck demand additive
  contract compatibility.

Do not change persisted announcements, native Group MMS, direct webhooks, non-live
writers, projections, UI, or database persistence methods.

## Binding contract

### Source creation

- In open and connecting relay POST branches, derive adapter-owned requested intent
  from the exact durable forwardable attachments plus stable media-store
  availability. Never use legacy `type`, body, or expiring URLs.
- Persist `transportSchemaVersion: 1`, requested transport on source and every
  source-time recipient slot before enqueue/held persistence. Source-time slots
  have no aggregation state.
- Do not put intent in the job payload. Preserve queued/queued_pending, synthetic
  SID, body/media, audit, SSE, enqueue payload, and no-provider-call route behavior.

### Worker hard branch

- Immediately after source read, schema-absent source runs an exact extracted or
  retained legacy path. No classification, initialization, aggregation, transport
  write, or provider-contract change may be reachable from legacy jobs, including
  continuation and queued_pending flush.
- Version 1 must preflight once before provider call zero. The eligible set is the
  byte-for-byte existing sender-exclusion plus continuation-key-filtered set only.
  Initialize absent eligible slots, reconcile only never-attempted stale planned
  slots, and never recreate/source an inbound sender. Real preflight failure aborts
  before provider call; `legacy_noop` does not.
- Suppressed legs: planned to excluded, immutable request preserved, existing
  suppression status/error retained, no actual, no provider call. Nonsuppressed
  legs become attempted immediately before provider call.
- Reclassify at execution from durable attachments/current stable media condition.
  On drift, safe warning only (no raw phone/member key), preserve durable request,
  and use existing body/media send. Generate fresh signed URLs only after request
  selection and immediately before prepare/send.
- Apply v1 results with `applyRecipientSendResult`; do not call unconstrained
  `setRecipientDelivery`. Accepted queued success writes first SID/time/actual and
  clears transient error without moving queued. Preserve callback pointers and
  continuation enqueue behavior.

## TDD proof

Start with failing real route and deterministic worker tests. Cover open/connecting
source intent, text/media/unavailable media store, exact schema-absent legacy
compatibility (including continuation/held release), v1 read-before-write,
preflight filtered eligible roster, initialize/reconcile/exclude/suppression,
attempt timing, drift, fresh URLs, child-field result preservation, and safe logs.

Run and report:

```
npm run test -w @housingchoice/app -- test/relayApi.test.ts test/relayFanOut.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run aggregate gates/e2e. Treat Vite `.vite-temp` EPERM before test start as
environmental, then re-run in the allowed environment for red/green proof.

## Commit/report discipline

Read bare `git status` and `.git/MERGE_HEAD`; stage explicit paths only. Commit:

`feat: track transport across relay fanout`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Report red/green counts,
the exact legacy boundary proof, preflight roster rule, files, commit, and any
unexpected importer/contract issue at
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-5-report.md`.
