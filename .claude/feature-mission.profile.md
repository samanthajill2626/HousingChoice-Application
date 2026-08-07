# Claude Feature-Mission Adapter - HousingChoice

This file is read by the Claude feature-mission planner and build orchestrator. It
contains only Claude-specific mission behavior.

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

## Claude worktree setup

After the shared workflow creates `W:\tmp\<name>`, immediately copy the local Claude
permissions into it:

```powershell
copy .claude\settings.local.json W:\tmp\<name>\.claude\settings.local.json
```

The file is gitignored and does not follow a worktree. Without it, a background
Claude agent can stall on a permission prompt no one can answer.

## Claude child-model policy

- Implementers, explorers, researchers, and reviewers: explicit `model: opus`.
- Trivial mechanical sweeps: explicit `model: sonnet`.
- Fable children require a deliberate, stated exception; never inherit Fable by
  default.
- The orchestrator uses its configured Fable/Opus model as selected by the human or
  agent definition.

## Claude memory contract

Before touching a worktree, read the build-orchestrator project memory's current
in-flight worktree list, then verify it against `git worktree list --porcelain` and
the target worktree's current status. Memory is context, not authoritative live state;
do not interfere with another mission when the two disagree.

Before handback, refresh the feature's Claude project-memory topic and its concise
index entry. Keep feature state current and avoid growing the index with raw logs or
transient detail.

## Claude mission handback

Use the shared workflow's handback contract. Report bare gate exit codes, the live
Playwright result, reviewer findings and adjudications, current `main` drift, and any
owed operator action. Never merge, deploy, mutate infrastructure, or clean up the
worktree without explicit human approval.
