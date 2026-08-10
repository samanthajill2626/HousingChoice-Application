# Codex Feature-Mission Adapter - HousingChoice

This file is read by the Codex feature-mission planner and build orchestrator. It
contains only Codex-specific mission behavior.

Before planning, dispatching, editing, or reviewing, read these canonical shared
sources in order:

1. `../AGENTS.md`
2. `../documentation/FEATURE-DEVELOPMENT-WORKFLOW.md`
3. `../documentation/GLOSSARY.md`
4. `../e2e/README.md`

The shared files own the gates, worktree convention, artifact paths, hard rules,
self-QA workflow, issue registry, dependency safeguards, and terminology. If this
adapter conflicts with a shared rule, the shared rule wins unless the human gives a
direct task-specific instruction.

## Codex worktree setup

The tracked `.codex/config.toml` follows normal Git worktrees. Codex does not use a
project `.codex/settings.local.json`, so do not look for or copy one. Use the
permission mode selected for the parent Codex task; sub-agents inherit that mode.

The shared HousingChoice workflow deliberately creates a named feature branch and
worktree under `W:\tmp`. Do not substitute a detached Codex-managed worktree inside a
feature mission unless the human explicitly changes that workflow.

## Codex child-agent policy

- Prefer the built-in `explorer` role for read-only codebase mapping and `worker` for
  implementation or fixes.
- Routine child agents use the project default from `.codex/config.toml`.
- Use `gpt-5.6-sol` only when a high-risk or unusually subtle task justifies a
  deliberate override; do not multiply top-tier usage silently.
- Use the `build-orchestrator` role only for the approved mission handoff after the
  spec and plan are complete.
- Follow the active runtime's supported Codex model identifiers. Never use Claude
  identifiers such as `opus`, `sonnet`, or `fable` in Codex dispatches.

## Codex memory contract

Codex may read and maintain its own local memory during normal work, including
outside feature missions. When a feature produces durable context worth carrying
forward, refresh the relevant Codex memory before handback.

Claude memory may be consulted read-only as potentially stale handoff context, but
do not copy or synchronize Claude memory wholesale into Codex memory. Verify live
repository, branch, and worktree state before relying on either memory store.

Keep mandatory project guidance in tracked repository files rather than relying on
memory alone.

## Codex mission handback

Use the shared workflow's handback contract. Report bare gate exit codes, the live
Playwright result, reviewer findings and adjudications, current `main` drift, and any
owed operator action. Never merge, deploy, mutate infrastructure, or clean up the
worktree without explicit human approval.
