# Task 7: authoritative native Group MMS propagation

Read the profile, AGENTS, approved spec, Task 7 plan, and the Task 2, 3, and 4 contracts.

## Owned files

- `app/src/services/groupSend.ts`
- `app/src/services/groupReceipts.ts`
- `app/src/routes/webhooks/twilio.ts` only required native-group branches
- `app/test/groupSend.test.ts`
- `app/test/groupReceipts.test.ts`
- `app/test/groupConversationsWebhook.test.ts`
- `app/test/groupSendRepo.integration.test.ts`

Use only adapter-owned group intent/prepared-post/result facts. A text-only group send keeps legacy `type:'sms'`, but writes v1 requested/actual MMS. Nonsuppressed slots carry requested/actual with attempted state; suppressed slots retain request/excluded/no actual. Do not infer rail facts from generic logic, type, OtherRecipients, or media.

Inbound native rows write adapter actual only/no request. Receipts may corroborate/conflict-log with a channel SID but never originate/overwrite authoritative MMS. Status and actual writes remain independent; SSE fires for either mutation and not two noops. Preserve provisioning, participant matching, audit, sender attribution, delivery, and existing unsupported-media behavior.

Write tests red first, then run:

```
npm run test -w @housingchoice/app -- test/groupSend.test.ts test/groupReceipts.test.ts test/groupConversationsWebhook.test.ts test/groupSendRepo.integration.test.ts
npm run typecheck -w @housingchoice/app
```

No broad gates/e2e. Report prestart Vite EPERM separately. Stage explicit paths, commit `feat: record native group MMS transport` with the Codex trailer, and report to `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-7-report.md`.
