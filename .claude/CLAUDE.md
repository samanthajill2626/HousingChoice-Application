# Claude Code Project Overlay

Before doing any work, read and follow [`../AGENTS.md`](../AGENTS.md). It is the
canonical source for HousingChoice product language, engineering constraints,
verification gates, worktree behavior, issue tracking, and safety rules.

Claude Code does not discover AGENTS.md on its own; it loads only CLAUDE.md and
.claude/CLAUDE.md. The bare line below is a Claude Code import, which pulls the
canonical file into context at session start so the shared rules are always
loaded rather than merely referenced. Keep it unquoted and outside code fences -
an import inside backticks or a fenced block is ignored.

@../AGENTS.md

This file contains Claude Code-specific runtime guidance only. If duplicated guidance
ever appears here, move the shared rule to `../AGENTS.md` and leave only the
Claude-specific delta here.

## Sub-agent model selection

Fable usage is constrained. Sub-agents spawned through the Agent tool or Workflow
`agent()` inherit the parent model unless explicitly overridden.

- Pass an explicit model on every Claude sub-agent dispatch.
- Use `opus` for routine explores, implementation fan-outs, audits, and independent
  reviewers.
- Use `sonnet` for trivial mechanical sweeps.
- Reserve Fable for the orchestrator or a deliberately identified high-importance
  child task. Never let a child inherit Fable silently.

These are Claude model identifiers. Never copy them into Codex configuration or
Codex agent prompts.

## Claude settings and permissions

Claude permission rules are honored from user settings or the gitignored
`.claude/settings.local.json`, not from the committed `.claude/settings.json`.
The committed file remains the home for shared environment variables, hooks, and
plugin/MCP configuration.

Every manually created Claude feature worktree therefore needs the local settings
copied in immediately after `git worktree add`:

```powershell
copy .claude\settings.local.json W:\tmp\<name>\.claude\settings.local.json
```

A missing local settings file can leave a background Claude agent waiting on a
permission prompt that no one is present to answer.

Claude rule syntax:

- Exact command: `Bash(npm run test)`
- Prefix wildcard: `Bash(git *)`
- Tool-wide: `Bash`
- `Bash(*)`, `Read(*)`, and similar parenthesized stars match nothing.
- MCP rules use `mcp__<server>` or `mcp__<server>__<tool>`; there is no MCP
  wildcard form.
- `allow` entries merge across settings layers. `ask` outranks `allow`, and `deny`
  outranks both, so use those lists when a broader rule needs a narrower prompt or
  refusal.

Claude settings are re-read live. If a rule does not work, check that it is in the
local file and uses a valid form; do not assume a restart is required.

The project Playwright MCP in `../.mcp.json` uses bundled Chromium. A separately
installed Claude Playwright plugin may instead expect the Chrome channel; if it reports
that the `chrome` distribution is missing, follow `../e2e/README.md` for the one-time
administrator install. Do not change the shared project MCP to work around that
client-plugin difference.

## Claude worktree shell behavior

Claude shell calls can lose the intended working directory between calls. Use an
explicit worktree path for commands and verify the current directory before trusting
surprising Git or test output.

## Claude feature missions

Claude feature missions use
[`feature-mission.profile.md`](feature-mission.profile.md). That file is a thin
Claude adapter; the shared mission process remains in `../AGENTS.md` and
`../documentation/FEATURE-DEVELOPMENT-WORKFLOW.md`.
