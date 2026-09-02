# Task 3 fix wave 1: persistence race and diagnostic preservation

## Scene

Task 3's repository mutation API is committed, but its independent review found
three in-scope correctness gaps. Fix only those gaps and their focused tests,
without extending into the later caller/service slices.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md` (sections 8.5-8.6)
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 3)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-3-persistence-review-findings.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-3-persistence-review-adjudications.md`
- Current Task 3 report: `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-3-report.md`

## Exact scope

Own only:

- `app/src/repos/messagesRepo.ts`
- `app/test/messagesRepo.transport.test.ts`
- `app/test/helpers/twilioWebhookHarness.ts`, only to keep the shared fake's
  documented state-machine behavior aligned with the real repository.

Do not change production callers, routes, services, dashboard code, seeds, or
the earlier adapter/domain contract.

## Accepted requirements

1. A duplicate terminal result without `errorCode` must preserve a retained
   terminal provider diagnostic. Error removal is only for a successful result
   clearing stale transient data. Retain same-status success cleanup plus first
   SID/time preservation.
2. After the last conditional write failure, perform a consistent re-read and
   classify the now-durable state as updated/idempotent/stale/conflict according
   to the pure Task 1 transition rules. Do not return bare `conflict` just because
   retry budget ended. Preserve independent status and actual transport writes.
3. When a requested-RCS later callback is stale after durable SMS/MMS fallback,
   emit a safe debug/info structured event (safe IDs/enums only) and return
   `stale`; never warn for this expected ordering. Preserve warning-only genuine
   conflicts. Match the harness state behavior if it models the same path.

Tests must first demonstrate each error on the pre-fix code. Include the terminal
failed duplicate, successful same-status cleanup, final conditional race
classification with a deterministic seam, and stale RCS observability/behavior.

## Verification

Run and report:

```
npm run test -w @housingchoice/app -- test/messagesRepo.transport.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run aggregate gates/e2e. If sandbox cache EPERM occurs before test
execution, record it separately and repeat from the allowed environment.

## Commit/report

Read bare `git status` and `.git/MERGE_HEAD`; stage only explicit scope paths.
Commit exactly:

`fix: preserve concurrent transport evidence`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Write results, test
counts, commit, and any deviation to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-3-fix-wave-1-report.md`.
Do not commit that raw report. Stop and report unexpected scope/contract issues.
