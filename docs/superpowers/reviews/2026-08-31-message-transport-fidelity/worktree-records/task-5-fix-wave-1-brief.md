# Task 5 fix wave 1: continuation roster and suppressed exclusion semantics

## Scene

The Relay review found two connected v1 preflight errors. Correct the precise
roster/rejoin rules without touching the already-proven schema-absent legacy path,
provider send mechanics, or later announcement work.

## Required reading

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md` (sections 8.4, 8.5, 9.4)
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` (Task 5)
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-5-relay-review-findings.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-5-relay-review-adjudications.md`

## Scope

Own only `app/src/jobs/relayFanOut.ts` and
`app/test/relayFanOut.test.ts`. Do not change source creation, repository methods,
announcements, group flows, or direct callbacks.

## Accepted corrections

1. Calculate the sender-excluded current execution roster independently from the
   continuation-filtered send set. A continuation may send only Bob, but current
   Carol remains a current member and must not be reconciled to excluded. Use the
   full current roster for stale removed-member reconciliation; use continuation
   filter only for initialization and the job's send loop.
2. Reopen an excluded slot only for a never-attempted, non-suppressed
   removed-and-rejoined member. A `failed/contact_opted_out/excluded` slot remains
   excluded on redelivery/continuation; it retains request/status/error and never
   reaches provider handling. Preserve the valid excluded-to-planned rejoin rule.

Start with deterministic failing tests for each exact shape, retain all legacy
continuation/held-release tests, and do not change the hard schema-absent path.

## Verification and commit

Run and report:

```
npm run test -w @housingchoice/app -- test/relayFanOut.test.ts
npm run typecheck -w @housingchoice/app
```

No aggregate gates/e2e. Treat pre-start Vite `.vite-temp` EPERM as environmental
and obtain red/green proof in the allowed environment. Read bare `git status` and
`.git/MERGE_HEAD`, stage explicit paths only, and commit:

`fix: preserve Relay preflight exclusions`

with `Co-Authored-By: Codex GPT-5 <noreply@openai.com>`. Write report to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-5-fix-wave-1-report.md`.
