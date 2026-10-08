# Branch B build execution - 2026-10-08

## Authorization and scope

Cameron authorized this top-level manual build after the mission was restated.
The contract is revision 15 of the clean-org-names-and-caseworkers spec, branch B
only, and the 2026-10-07 caseworkers plan. Sections 0-3, the slice assembly notes,
and the closed design/plan adjudications are binding. The planner session owns
the final independent handback review; the builder performs its own prescribed
review and live self-QA before that handback.

Starting branch: feat/caseworkers at 1c2264d2c02ea30e6b8a5c241fe65057a0ebb437.
Live git status was clean. Main was d874915873a61864f6d051a0a9af3f0bb8e7e6e2,
one docs-only commit ahead. The existing c1530f9d and 54e7b0d0 main merges remain
part of the approved starting state. Task 10.14 owns any final main sync.

## Codex execution adaptation

The human explicitly mapped the mission's model roles:
- Opus: gpt-6-astra with xhigh reasoning.
- Sonnet: gpt-6.1-sol with xhigh reasoning, trivial mechanical work only.
Every child dispatch supplies both fields. The parent runs as the current Codex
session; no claim is made that the Claude manual's frontmatter changes its model.

The named Claude profile delegates shared behavior to AGENTS.md and the canonical
workflow. The tracked Codex adapter supplies client setup and tool conventions.
No Claude settings or memory are copied or edited.

The runtime exposes asynchronous collaboration children rather than the Claude
manual's foreground Agent call. Children are owned and awaited in this active
turn, with progress checks and no orphaned build or suite. Read-only research and
review may run concurrently. There is exactly one source-writing implementer
per sequential slice. Researchers return findings and reference separately; the
orchestrator persists durable findings and ignored reference separately.

## Setup evidence and recovery

npm ci exited 0, installing 641 packages without tracked changes. Node is
v24.21.0 and npm is 11.19.0. The shared hc-dynamodb-local container was already
running; no start, restart, stop, or remove was performed.

Ordinary sandboxed execution failed before launching commands with
'helper_unknown_error: setup refresh had errors'. Approved elevated execution
works. This is one infrastructure correction, not a child recovery. Child
recovery budget remains zero at setup.

## Verification ownership

This is the full feature lane. Each plan task uses its targeted tests plus real
typecheck; S6 and S9 close with full typecheck and npm test checkpoints. Task
10.14 syncs main if needed, then runs the five bare gates: typecheck, npm test,
smoke, e2e under a 2700-second hard timeout, and lint on a nonempty branch file
list against the explicit merge base. New lint errors are attributed by baseline.
The builder then completes the prescribed independent children, any fix wave,
affected re-verification, and its own hermetic live self-QA. No claim of green
completion is made by this setup record.

No deployment, infrastructure mutation, real environment edit, merge into main,
worktree cleanup, or Improvements Tracker write is authorized by this mission.

Initial baseline: npm run typecheck exited 0 across app, dashboard, e2e,
fake-twilio, and fake-twilio-web before source implementation.
