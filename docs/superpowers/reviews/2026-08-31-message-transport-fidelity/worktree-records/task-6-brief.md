# Task 6: transport-aware persisted Relay announcements

## Scene

Task 5 establishes the Relay version-1 execution contract. Apply that same
immutable-intent, planned/attempted/excluded, and child-field result behavior to
persisted announcements only; `persist: false` legs-only announcements stay exactly
legacy and must not invent a source or aggregation object.

## Read

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- approved spec and Task 6 plan in `docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md` and `docs\superpowers\plans\2026-09-01-message-transport-fidelity.md`
- Task 2/3/5 contracts and slice reports.

## Own

- `app/src/services/relayAnnouncements.ts`
- `app/test/relayAnnouncements.test.ts`
- announcement fake/caller only where typecheck requires a minimal additive carrier
  sender contract update.

Do not modify Relay fan-out, direct/webhooks, Group MMS, seeds, projections, or UI.

## Contract

For persisted announcements, classify once before append; store version 1 requested
SMS on source and queued requested/planned recipient slots. Suppression transitions
to excluded before provider handling, preserves current suppression status/error,
and has no actual. A leg transitions attempted immediately before prepared send.
Accepted queued results store SID, first sent time, actual and clear transient
errors through `applyRecipientSendResult`; duplicates preserve concurrent child
state. Use the normal recipient slot aggregate, no parallel announcement state.
Logs must never include raw phones/phone keys. `persist:false` remains legs-only and
does not create transport fiction.

## TDD/checks

Start failing test first for persisted two-recipient, suppression, attempt timing,
accepted/retry preservation, aggregate compatibility, safe logs, and persist-false.
Run:

```
npm run test -w @housingchoice/app -- test/relayAnnouncements.test.ts
npm run typecheck -w @housingchoice/app
```

No broad gates/e2e. Record Vite pre-start EPERM separately and retry allowed env.

Read bare status/MERGE_HEAD, stage explicit paths, commit:
`feat: track transport on relay announcements`
with the required Codex trailer. Report at
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-6-report.md`.
