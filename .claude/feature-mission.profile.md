# feature-mission project profile - HousingChoice (HC Application)

Read by the feature-mission planner skill and the build-orchestrator agent.
This file carries every repo-specific rule the generic pipeline needs. The
repo's always-loaded rules live in .claude/CLAUDE.md; where they overlap,
they agree - this file is the pipeline's operational digest.

## Design-process docs

documentation/FEATURE-DEVELOPMENT-WORKFLOW.md is the full pipeline doc
(lanes, spike checklist, review protocol). Brainstorm via
superpowers:brainstorming; plans via superpowers:writing-plans.

## Gates (bare, real exit codes - NEVER pipe a gate; redirect then grep)

- `npm run typecheck` - REQUIRED SEPARATE GATE. npm test and e2e run
  through esbuild/tsx which strip types WITHOUT checking; green tests
  prove nothing about types; typecheck also catches semantic merge seams.
- `npm test` - all workspaces.
- `timeout 1500 npm run e2e` - the outer cap is mandatory (the suite can
  wedge environmentally with zero output and no per-test timeout).
- e2e runs ONLY from the worktree (a root/stray playwright run silently
  targets the human's LIVE dev stack at :5174). `npm run e2e -- --flag`
  never reaches playwright (npm eats it) - full suite from the worktree,
  or a filtered run from the e2e/ workspace dir. Warm containers first
  (npm run db:start / s3:start); `npm run e2e:stop` for a fresh stack.
- Small-fix lane (bug fixes on main): typecheck + unit + live QA per
  change; bulk e2e at a checkpoint.
- e2e/.artifacts/session.pid is the session LAUNCHER pid - alive does not
  mean the suite is running. Stale lane schema: delete hc-local-<L>-*
  tables.

## Worktrees and branches

- One worktree per feature under w:\tmp: `git worktree add w:\tmp\<name>
  -b feat/<name> main`. NEVER move HEAD in the shared main checkout
  (concurrent agents). MEMORY.md "In flight" lists other agents' worktrees
  - never touch them.

## Artifact paths

- Specs: docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md
- Plans: docs/superpowers/plans/YYYY-MM-DD-<feature>.md
- Issues: docs/issues/<slug>.md (two tiers; copy _TEMPLATE.md; `npm run
  issues` regenerates the derived index - never hand-maintain a list).
  RUNBOOK.md is operational only - bugs/gaps go in docs/issues/.
- Orchestrator scratch: <worktree>/.superpowers/ (gitignored).

## Hard rules (every touched line)

- ASCII-only in specs, plans, prompts, issues, labels, comments, seed
  strings, test names: `tr -d '\11\12\15\40-\176' < FILE | wc -c` -> 0.
  On a pre-existing non-ASCII file only ADDED lines must be ASCII.
- NEVER rewrite source files with PowerShell Get-Content/-replace/
  Set-Content (BOM-less UTF-8 read as ANSI -> mojibake) - use the Edit
  tool.
- Commit discipline: a gating bare `git status` READ before EVERY commit
  (others' staged state can exist; check .git/MERGE_HEAD); stage EXPLICIT
  paths only, never `git add -A`; Co-Authored-By trailer naming the
  authoring model on every commit.
- New automated user-facing copy ONLY via the message catalog.
- New app runtime deps go in app/package.json (never root - the Docker
  runtime stage runs `npm ci --workspace app --omit=dev`); prove the
  linux/arm64 install (optional-dep binaries must be in the lockfile) per
  the spike checklist in the workflow doc.
- No infra ever without an explicit human ask: terraform plan/apply,
  secrets:push, SSM writes, deploy:*, real .env.* edits. Record owed ops
  in the handback + RUNBOOK.

## Live self-QA harness

- `npm run e2e:session` starts a persistent hermetic stack (it picks its
  own lane; lane 0 is the human's live stack - never touch it; note ports
  from the log). `POST /auth/dev-login` (or the dev-login button);
  `POST /__dev/reseed?profile=full` (full = demo world; lean = the
  byte-stable e2e world - never let full-profile work leak into lean);
  `GET /__dev/outbox` asserts would-be SMS. Backend changes need
  `npm run e2e:restart`. Reseed logs the browser out - dev-login again.
- Drive the REAL UI with the project Playwright MCP (--isolated: own
  ephemeral profile, starts logged out each launch). "Browser is already
  in use" = ANOTHER agent's browser - NEVER kill mcp-chrome; retry once,
  else document that automated e2e covers the flow and move on.
- Screenshots: prefix explicit filenames with `.playwright-mcp/` (bare
  names resolve at the repo ROOT). browser_find is the cheap assertion.
- Reviewers must NOT run test suites while a lane/self-QA session is live
  (shared DynamoDB contention).

## Known flakes (re-run full suite before blaming the change; report both)

- tour-reminders-panel-e2e-flake (docs/issues/)
- conversationdetail-members-mock-suite-flake (docs/issues/) - second
  sighting logged; passes solo.

## Child-model policy

- Implementers / reviewers / research: `model: opus`. Trivial mechanical
  sweeps: `model: sonnet`. NEVER fable on children (usage limits; a
  deliberate stated choice only). Orchestrator itself: fable/max via the
  agent definition (AUTO) or `/model` fable-or-opus (MANUAL).

## Memory contract

- Before handback: refresh the feature's memory topic file + its one-line
  MEMORY.md index entry (tight; mind the index size budget).

## Terminology

- The single leasable dwelling is ALWAYS `unit` in code/data; "home" to
  tenants, "property" to landlords/staff. See documentation/GLOSSARY.md;
  update it in the same change when adding a domain noun.
