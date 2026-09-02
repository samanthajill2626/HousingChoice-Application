# Task 4 fix wave 1: adapter-owned native-group inbound rail fact

## Scene

The Task 4 review accepted one P1: generic webhook code writes literal MMS for a
native-group inbound row instead of consuming the provider adapter's authoritative
Group MMS rail fact. Correct this ownership boundary without extending into Task 7
outbound group sending or receipts.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md` (Group MMS authority)
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Tasks 2, 4, and 7 boundaries)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-4-direct-webhook-review-findings.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-4-direct-webhook-review-adjudications.md`

## Scope

Own only the smallest boundary fix in:

- `app/src/adapters/groupConversations.ts`
- `app/src/routes/webhooks/twilio.ts`
- `app/test/groupTextWebhook.test.ts`
- an existing group adapter test only if necessary to test/export the authoritative
  provider-boundary fact.

Use an adapter-owned authority/normalizer, not a new generic webhook literal. A
dependency injection seam is permitted when needed to prove that route behavior
consumes the authority. Keep the current native-group MMS result, keep legacy
`type` content behavior, and do not derive rail fact from `OtherRecipients`,
body/media, receipt SID, or ordinary Twilio SMS normalizer evidence.

Do not change group outbound, group receipts, direct/relay status, seeds, or UI.

## TDD and verification

First add a failing signed native-group webhook test that distinguishes the
adapter-owned observation from route fabrication. Then implement the narrow fix.
Run and report:

```
npm run test -w @housingchoice/app -- test/groupTextWebhook.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run broad gates/e2e. Classify an initial Vite `.vite-temp` EPERM as
pre-execution environment failure and rerun in the allowed environment for proof.

## Commit/report

Read bare `git status` and `.git/MERGE_HEAD`; stage explicit paths only. Commit:

`fix: source native group transport from adapter`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Report red/green counts,
the exact authority seam, files, and any scope issue at
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-4-fix-wave-1-report.md`.
