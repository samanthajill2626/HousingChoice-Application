# Task 1 brief - domain and Twilio evidence normalizer

Read first:

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` Task 1
- `W:\tmp\message-transport-fidelity\.superpowers\sdd\phase1-live-worklist.md`

## Scope

Create exactly these Task 1 files unless typecheck proves a narrow test-only import
adjustment is necessary:

- `app/src/lib/messageTransport.ts`
- `app/src/adapters/twilioMessageTransport.ts`
- `app/test/messageTransport.test.ts`
- `app/test/twilioMessageTransport.test.ts`

Write table-driven tests first and run the focused command red before production
code. Implement the closed transport union, schema constant, actual-write decision,
aggregation transition classifier, and pure Twilio evidence normalizer described in
plan lines 222-330. Then run the focused test command and app typecheck green.

## Binding constraints

- Preserve `MessageType`; transport is additive.
- The pure domain module contains no Twilio vocabulary. The adapter normalizer returns
  data and does not log.
- Recognize only documented provider evidence. Do not treat media, NumMedia, content,
  message type, status or conversation kind as transport evidence.
- Precedence is explicit RCS evidence first; inbound SM/MM requires E.164 `To` and no
  channel field; SMS/MMS outbound can use valid SM/MM; RCS fallback needs E.164 `From`
  and no channel field; conflict or missing evidence stays absent.
- A channel prefix may expose only its scheme in safe facts. Non-provider fixture SIDs
  are missing, never warning-worthy evidence.
- Use the existing E.164 helper. The SID comment must cite the four plan references and
  state that SM/MM classify Message-resource creation, not general delivery transport.
- New lines, comments and tests must be ASCII only. No new dependency, routing or
  delivery behavior.

## Required verification

Run each command bare from `W:\tmp\message-transport-fidelity`:

```powershell
npm run test -w @housingchoice/app -- test/messageTransport.test.ts test/twilioMessageTransport.test.ts
npm run typecheck -w @housingchoice/app
```

The first focused test run must demonstrate expected red failure before production
modules exist; record its command and exit code. Do not run aggregate tests, smoke,
or e2e.

## Commit discipline

Before committing, read `git status --short --branch` and check `MERGE_HEAD`. Stage
only the four scoped files. Commit exactly:

```text
feat: add normalized message transport evidence

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

Write the full implementation report to
`W:\tmp\message-transport-fidelity\.superpowers\sdd\task-1-report.md`: red and green
proof, tests/counts, exact commit, changed files, decisions, and concerns. Do not
write tracked review records, spawn agents, run slow gates, or touch unrelated work.
