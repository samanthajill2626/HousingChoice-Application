# Task 2 brief - immutable adapter intents and actual results

Read first:

- `W:\tmp\message-transport-fidelity\.codex\feature-mission.profile.md`
- `W:\tmp\message-transport-fidelity\AGENTS.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\specs\2026-08-31-message-transport-fidelity-design.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\plans\2026-09-01-message-transport-fidelity.md` Task 2
- `W:\tmp\message-transport-fidelity\.superpowers\sdd\phase1-live-worklist.md`
- `W:\tmp\message-transport-fidelity\docs\superpowers\reviews\2026-08-31-message-transport-fidelity\task-1-domain-evidence-slice-report.md`

## Delivered dependency contract

Task 1 exports `MessageTransport`, `MessageTransportIntent`, transition decisions
and `normalizeTwilioTransportEvidence` at the provider boundary. The normalizer is
pure, returns observed/missing/conflict data and never logs. It accepts provider
fields only at the adapter boundary. Preserve that ownership.

## Scope

Modify:

- `app/src/adapters/messaging.ts`
- `app/src/adapters/groupConversations.ts`
- `app/test/messaging.test.ts`
- `app/test/groupConversationsAdapter.test.ts`
- only adapter fakes the focused typecheck proves must implement the new carrier
  surface.

The required contract and test matrix are exact in plan Task 2. Write failing
adapter contract tests first, demonstrate red, then implement a serializable intent,
late preparation and send/post execution result. Preserve existing compatibility
wrappers for non-chip callers.

## Binding constraints

- The messaging adapter classifies text-only durable facts as SMS and forwardable
  media as MMS. The intent is immutable, plain and has no URL, closure or SDK object.
- `prepareMessageSend` receives fresh parameters but never reclassifies. Only
  `sendPreparedMessage` performs provider send and returns any normalized actual.
- Normalizer conflicts emit one safe adapter warning and leave actual absent.
- Console is its own provider boundary and returns requested as actual; it neither
  fabricates a Twilio SID nor calls the Twilio normalizer.
- Group Conversations adapter owns its authoritative Group MMS requested/actual MMS
  fact. A `ChannelMessageSid` only corroborates or conflicts; no service, webhook or
  dashboard infers MMS from type, media, conversation kind or SID.
- Add no dependency and do not change routing, delivery behavior, media refusal,
  participant behavior, send ordering or existing compatibility API.
- All new lines/comments/tests ASCII.

## Required focused proof

Run each command bare from the worktree:

```powershell
npm run test -w @housingchoice/app -- test/messaging.test.ts test/groupConversationsAdapter.test.ts
npm run typecheck -w @housingchoice/app
```

Do not run aggregate tests, smoke or e2e. Record the expected red and final green
results.

## Commit and report

Before commit read `git status --short --branch` and check `MERGE_HEAD`. Stage only
the files you changed; never `git add -A`. Commit:

```text
refactor: expose carrier transport intents

Co-Authored-By: Codex GPT-5 <noreply@openai.com>
```

Write full report to `W:\tmp\message-transport-fidelity\.superpowers\sdd\task-2-report.md`
with exact red/green commands and exits, changed files, commit, fakes adjusted and
concerns. Do not write tracked records, spawn agents, or touch unrelated work.
