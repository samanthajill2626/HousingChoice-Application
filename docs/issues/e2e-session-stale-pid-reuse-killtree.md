---
id: e2e-session-stale-pid-reuse-killtree
title: The e2e session launcher's self-heal kills whatever process now holds a stale session.pid
type: bug
severity: med
status: open
area: e2e
created: 2026-10-21
refs: scripts/e2e-session.mjs:716-726, scripts/lib/killTree.mjs, e2e/playwright.config.ts:26-42, scripts/e2e-stop.mjs:45
---

**Problem.** Every Playwright-managed run (`npm run e2e`, or a spec subset
through the e2e workspace) boots its stack through the session launcher and
leaves `e2e/.artifacts/session.pid` behind after the launcher has exited
(a routing record, not liveness - see the build-orchestrator traps). The next
launcher start runs a SELF-HEAL (`scripts/e2e-session.mjs:716-726`): when that
file exists and the recorded pid is "alive" (`isAlive(oldPid)`, a signal-0
probe), it logs "reaping stale session launcher" and runs `killTree(oldPid)`.
Nothing checks that the live process is still a session launcher - not its
command line, not its start time, not the lane lease. Windows reuses pids
quickly, so a stale pid can name ANY process: another agent's browser or test
runner, the human's editor, or the new run's own process tree.

Sighting (2026-10-21, feat/flyer-leads FW3, `docs/superpowers/reviews/2026-10-21-flyer-leads/code-review/FW3-report.md`
"Risks and residuals"): a gate battery's launcher (pid 48356) had exited and
`tasklist` showed the pid dead; minutes later a spec-subset run found 48356
alive, its config reported "reusing the live e2e:session on lane 12"
(`liveSessionLane()`, `e2e/playwright.config.ts:26-42`, which ALSO requires a
held lane lease), and the launcher's log ended at "reaping stale session
launcher (pid=48356)" with no test run - consistent with the pid having been
reused inside the run's own tree. The run died; a re-run after
`npm run e2e:stop` (which deletes the stale file when the pid is dead,
`scripts/e2e-stop.mjs:45`) went green.

Why it matters: a kill of an unrelated process tree on a shared development
machine, triggered by an ordinary test run. Rare (it needs a reused pid), but
destructive and silent - AGENTS.md already warns that killing a process an
agent does not own (a shared MCP browser) can take down another agent's work.

**Suggested fix.** Before reaping, prove identity: store the launcher's start
time (or a random token) beside the pid and compare it with the live process
(e.g. its creation time via `wmic` / `Get-Process`, or a health probe on the
lane's own app port carrying the session's owner token); reap only on a
match, otherwise just delete the stale file. Optionally have the launcher
remove `session.pid` on a clean exit so the stale case is rare. Until then:
run `npm run e2e:stop` before any e2e run in a worktree whose last run left a
`session.pid` (it removes the file without killing when the pid is dead).
