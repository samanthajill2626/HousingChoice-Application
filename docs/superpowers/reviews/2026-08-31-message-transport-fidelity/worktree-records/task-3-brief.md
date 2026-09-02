# Task 3: versioned transport persistence

## Scene

The domain evidence and adapter-intent contracts are committed. This slice makes
their versioned transport facts durable without clobbering unrelated delivery
state under retries, callbacks, or legacy rows.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 3)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\implementation-drift-worklist.md`
- Existing contract: `app/src/lib/messageTransport.ts` and prior slice record
  `docs/superpowers/reviews/2026-08-31-message-transport-fidelity/task-1-domain-evidence-slice-report.md`.

## Scope and ownership

Own only the persistence slice and its focused tests:

- `app/src/repos/messagesRepo.ts`
- new `app/test/messagesRepo.transport.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts` only if a helper needs an additive
  type fixture for this test
- repo fakes/types only where app typecheck proves they need a compatible,
  additive update.

Do not modify callers, service routes, status callbacks, projections, dashboard
code, seeds, imports, or fake Twilio behavior. Those are later sequential
slices.

## Binding contract

Add the versioned camel/snake mapping described by the approved spec:

```
NewMessage: transportSchemaVersion?: 1; requestedTransport?: MessageTransport;
  actualTransport?: MessageTransport
MessageItem: transport_schema_version?: 1; requested_transport?: MessageTransport;
  actual_transport?: MessageTransport
RelayRecipientDelivery: requestedTransport?: MessageTransport;
  actualTransport?: MessageTransport;
  transportAggregationState?: TransportAggregationState
```

Add a narrow outcome union
`updated | idempotent | stale | conflict | legacy_noop | missing` and narrow
patch shapes for a recipient's status, SID, sent time, error code, and actual
transport. Implement only the plan's repository APIs:

- `setMessageActualTransport`
- `initializeRecipientDelivery`
- `setRecipientTransportAggregationState`
- `setRecipientActualTransport`
- `applyRecipientSendResult`

Use conditional, narrow DynamoDB updates: never whole-slot replacements. Each
independent field must survive an interleaving with another update. A queued
same-status result can still add metadata/actual transport. Success at the same
status clears a transient error but does not replace an existing first SID or
sent time. Terminal error protection and non-regression are required. Schema
absent / legacy rows are safe `legacy_noop` and do not create transport fields.
Validate the versioned transport type at the persistence boundary.

Do not infer rail facts, fabricate a `ChannelPrefix`, or change the adapter
contract. Preserve explicit casts. All newly added prose/test names are ASCII.

## TDD proof

Begin with failing tests. The focused test file must exercise append mapping,
validation, legacy/missing behavior, actual and aggregation writes, initialization
without overwrite, conditional/conflicting races, independence of concurrent
status/SID/error/timestamp/actual/aggregation writes, queued same-status metadata,
success error cleanup with first SID/time preservation, and terminal error
protection.

Run, record in the report, and keep green after the commit:

```
npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run slow aggregate gates or e2e. If a command hits the known Vite cache
EPERM before execution, report it distinctly and retry in the allowed environment;
do not mislabel it as a product failure.

## Commit/report discipline

Read bare `git status` and `.git/MERGE_HEAD` before committing. Stage explicit
paths only, never `git add -A`. Commit the implementation and tests as:

`feat: persist versioned message transport facts`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Do not commit the raw
report. Write a concise report to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-3-report.md` with
red/green commands and counts, files, commit hash, exported contract, and any
unexpected importer or plan mismatch. Stop and report rather than extending scope.
