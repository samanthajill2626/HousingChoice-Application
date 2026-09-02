# Task 3 follow-up correction: queued successful error cleanup

## Scene

The cold review of Task 3 fix wave 1 found one new P1. Keep this correction
strictly limited to the queued successful result that must clear a stale transient
error, while preserving all terminal-diagnostic protections just introduced.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md` (section 8.6)
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 3)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-3-fixwave-1-rereview-findings.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-3-fixwave-1-rereview-adjudications.md`

## Scope

Own only `app/src/repos/messagesRepo.ts`,
`app/test/messagesRepo.transport.test.ts`, and
`app/test/helpers/twilioWebhookHarness.ts` where parity requires it. Do not touch
any caller/service/UI/seed/projection code.

## Binding correction

Twilio `accepted` is a successful provider result that maps to internal `queued`.
A slot `{ status: 'queued', errorCode: '30003' }` receiving the same-status
successful result `{ status: 'queued', sid, sentAt }` must clear `30003`; it must
also preserve the first SID and sent time. A duplicate terminal failed result
without an error code must continue to retain its terminal diagnostic. Derive the
condition from success/terminal semantics, not a narrow `sent` literal. The real
repository and shared webhook fake must agree.

Start with a focused failing DynamoDB Local test for this queued accepted shape,
then implement the minimum correction. Keep all prior 22 tests and add the new
case.

## Verification and commit

Run and report:

```
npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run aggregate gates/e2e. Differentiate an initial Vite cache EPERM before
test execution from red product proof and repeat in the allowed environment.
Read bare `git status` and `.git/MERGE_HEAD`, stage exact paths only, and commit:

`fix: clear queued transport retry errors`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Write proof and commit to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-3-fix-wave-2-report.md`.
