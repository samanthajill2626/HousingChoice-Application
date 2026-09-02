# Task 1 fix wave 1 - incomplete rich-channel metadata

Read first:

- `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-1-review.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-1-domain-evidence-review-findings.md`
- `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-1-brief.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`

## Scope

Modify only `app/src/adapters/twilioMessageTransport.ts` and
`app/test/twilioMessageTransport.test.ts` unless typecheck proves a narrow related
change is unavoidable.

## Required red-green correction

First add table-driven authenticated and unauthenticated cases for valid, non-empty
`ChannelMetadata: '{}'` with a valid inbound SM or MM SID and E.164 endpoint. Run:

```powershell
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
```

The new authenticated test must fail because the current implementation returns
missing rather than conflict. Then make a minimal normalizer change: a non-empty
parsed metadata object with a missing or non-`rcs` type is unknown rich-channel
evidence, not absent metadata. Authenticated provider traffic returns a safe
conflict; unauthenticated fixture traffic follows the existing quiet missing path.

Do not infer transport from content, media, NumMedia, type, status or conversation
kind. Do not change MessageType, routing, delivery semantics or unrelated test cases.
All new lines ASCII.

## Verification and commit

After green, run the same focused test command and:

```powershell
npm run typecheck -w @housingchoice/app
```

Do not run aggregate test, smoke or e2e. Before commit read `git status --short
--branch` and check `MERGE_HEAD`. Stage only the two scoped paths. Commit:

```text
fix: classify incomplete channel metadata safely

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

Write the full report to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-1-fix-wave-1-report.md`
with red/green exit codes, commit, changed files and concerns. Do not write tracked
records, spawn agents, or touch unrelated work.
