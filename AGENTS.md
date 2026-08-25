# HousingChoice Agent Guide

This is the canonical repository guidance for every coding agent. Client-specific
files may add runtime details, but they must not duplicate or redefine these shared
project rules:

- Claude Code overlay: `.claude/CLAUDE.md`
- Codex configuration: `.codex/config.toml`
- Claude feature-mission adapter: `.claude/feature-mission.profile.md`
- Codex feature-mission adapter: `.codex/feature-mission.profile.md`

If a client overlay conflicts with this file, follow this file unless the human gives
a direct instruction for the current task. Keep shared behavior here and keep model,
permission, tool, and client-path details in the appropriate overlay.

## Product vocabulary

One entity, three labels by audience. The "single dwelling a single household can
lease and move into" is always `unit` in code/data. Human-facing copy uses:

- Tenant: "home"
- Landlord: "property"
- Staff / navigator (dashboard): "property"
- Code / data / internal: `unit` (`unitId`, `unitsRepo`, `UnitItem`)

`unit` is the HUD/Section 8 term and is structure-agnostic: a house, townhome, or
apartment is all a dwelling unit. `property` is the blessed landlord/staff word for
this single-`unit` entity. If we ever model a multi-unit parent layer, name it
"building" or "parcel", never "property". Keep `listing_link` / "public listing"
(the external listing URL) and the JavaScript object-property sense of "property"
as-is.

Full rationale, the audience-to-noun table, and the future-AI mapping:
[`documentation/GLOSSARY.md`](documentation/GLOSSARY.md). Update it in the same
change whenever you add a domain noun or fix drift.

## Request lanes and feature workflow

Follow [`documentation/FEATURE-DEVELOPMENT-WORKFLOW.md`](documentation/FEATURE-DEVELOPMENT-WORKFLOW.md)
for every non-trivial feature or change.

- A feature or non-trivial change uses the full brainstorm, spec, plan, isolated
  build, independent review, and human-merge pipeline.
- A clear bug the human explicitly asks to fix is diagnosed to root cause first,
  then fixed on the human's go under the small-fix gates.
- A symptom report is an assessment: diagnose and propose; do not edit until the
  human authorizes the fix.
- Never run infrastructure mutations, deployments, secret pushes, SSM writes, or
  real `.env.*` edits without an explicit human request.
- Cleanup is separate work. Do not delete branches/worktrees or stamp historical
  docs without an explicit human request.

## UI testing and verification

This repo has a Playwright end-to-end harness that drives the real dashboard and API.
After changing any UI or user-facing flow, verify it with the harness before claiming
the work is done, and add or extend a spec for new behavior.

- Full suite: `npm run e2e` (boots a hermetic stack, runs, tears down).
- Interactive inner loop: `npm run e2e:session`, then drive the selected lane with
  the Playwright MCP. After a backend change run `npm run e2e:restart`; use
  `npm run e2e:reseed` for a clean slate and `npm run e2e:stop` to end.
- Dev-only, hermetic-local-only helpers (structurally absent in deployed envs):
  `POST /auth/dev-login`, `POST /__dev/reseed`, and
  `GET /__dev/ping`.
- Write specs with accessibility-first selectors (`getByRole` / `getByLabel`); see
  [`e2e/support/selectors.md`](e2e/support/selectors.md). Docker is required for
  DynamoDB Local.
- The project Playwright MCP configurations (`.mcp.json` for Claude and
  `.codex/config.toml` for Codex) use bundled Chromium with `--isolated`, so each
  session gets an ephemeral browser profile. It starts logged out; authenticate
  again with dev-login. Never kill shared MCP browser processes to solve a profile
  conflict; that can kill another agent's browser.
- Never test or investigate against the human's live dashboard/app ports (`:5174` /
  `:8080`), including raw API calls or dev-login. Use a hermetic `e2e:session` lane;
  if the problem depends on live-only data, ask the human for the relevant evidence.
- MCP artifacts belong in `.playwright-mcp/` (gitignored). Explicit screenshot
  filenames must be prefixed with `.playwright-mcp/`; unnamed artifacts already land
  there.
- Run Playwright only through the e2e workspace (`npm run e2e`). A stray/root
  Playwright invocation can target the human's live lane.

`npm run perf:pages` is a sanctioned Playwright entry point: the root script
delegates directly into e2e-workspace code, so it satisfies the
e2e-workspace-only rule for its hermetic target. Its `-- local` and
`-- hosted-dev` targets are additionally human-invoked only: an agent may run
them only on the human's explicit per-run instruction naming the target, and
the local target requires an interactive TTY confirmation the runner
enforces.

- Do not run a full e2e suite and an interactive e2e session concurrently from the
  same worktree.
- The `full` reseed profile is the demo world; `lean` is the byte-stable e2e world.
  Never let full-profile assumptions leak into lean tests. Reseeding logs the browser
  out, so authenticate again afterward.
- `e2e/.artifacts/session.pid` identifies the session launcher, not proof that the
  suite or every child process is healthy.
- A stale lane can retain a pre-GSI schema. If evidence points to schema drift, remove
  only that lane's `hc-local-<L>-*` tables and let the harness recreate them.
- Review agents must not start competing test suites while an interactive lane/self-QA
  session is live in the worktree they are reviewing.

Full setup and lane details: [`e2e/README.md`](e2e/README.md).

**FIRST, if `npm test` is red on DynamoDB Local suites:** re-run under a clean
access key before blaming anything.

```
cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run
```

A degraded database - leaked `hc-test-*` / `hc-local-<lane>-*` / `hc-hist-*`
tables from interrupted runs, which `globalTeardown` does not drop - makes the
app suite ~9x slower and fails ~9 files on plain timeouts and SQLite write-lock
errors, with ZERO assertion failures. Measured 2026-08-23: 607s and 9 failures
on a residue-carrying key, 65s and 0 failures on an empty one, same commit. If
the clean-key run is green, the failure is environmental.
See [`npm-test-dynamodb-local-contention`](docs/issues/npm-test-dynamodb-local-contention.md).

**There is no longer a named-flake re-run list.** Both entries that stood here
are now closed, so a named-spec failure is a REGRESSION to diagnose, not
something to re-run and excuse:

- [`tour-reminders-panel-e2e-flake`](docs/issues/tour-reminders-panel-e2e-flake.md)
  - resolved 2026-08-24. A rare Reminders-panel rung-visibility timeout, last
  seen 2026-08-03, with zero recurrences across ~20 full gate runs since - the
  degraded-container era and the contention fixes included. Reopen only on that
  exact signature (a rung row invisible inside its 10s budget, on a branch with
  no tours intersection), and read the issue BODY first: its title long
  advertised a deterministic pre-08:00 failure that was closed separately by
  `150fbfa4`.
- [`conversationdetail-members-mock-suite-flake`](docs/issues/conversationdetail-members-mock-suite-flake.md)
  - fixed 2026-08-21. Its mocks were bare `vi.fn()`s returning `undefined` after
  `mockReset`, so the component died on `.then()` of undefined. Never a timing
  flake - a reachable-by-construction defect.

The re-run-and-compare discipline still applies to the ENVIRONMENTAL failure
above, which is not a named flake: re-run the failing FILES alone, run the full
suite at the branch's base commit, and compare failing FILES rather than failing
cases, reporting both runs. See
[`npm-test-dynamodb-local-contention`](docs/issues/npm-test-dynamodb-local-contention.md),
which is still open - the per-file-keys fix closed its reopened cause, but an
`UpdateTable` `InternalFailure` tail remains.

## Required completion gates

Before declaring a branch done or requesting review/merge, sync the latest `main`
into the branch (merge or rebase), preserve both sides' intent, and run these bare
commands from the feature worktree:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`

`npm run typecheck` is a separate required gate. Vitest and Playwright run through
esbuild/tsx, which strip types without checking them. Never pipe a gate command; a
pipe can hide the real exit code. Use a hard outer timeout for a suite that can wedge,
then inspect/filter its captured output after the command finishes.

`npm run smoke` is a separate required gate for the same reason, one layer down:
tsx/esbuild resolve imports like a BUNDLER, while production runs the real `tsc`
output under plain `node dist/`, whose ESM loader is stricter. Nothing in gates
1, 2 or 4 can see that gap - the email channel once shipped a directory import
that passed every suite and crash-looped the deploy. The smoke builds the app
workspace and proves every import in the COMPILED output resolves the way Node
will. It needs no Docker, no ports and no network, and takes about a second.

`npm test` requires DynamoDB Local (`npm run db:start`) and now FAILS rather than
skipping without it: 46 suites self-skip on an unreachable endpoint, so a
Docker-less run used to omit ~631 tests and still exit 0. Use
`ALLOW_SKIP_DYNAMO_TESTS=1` only for a deliberate unit-only pass - it is not a
completion gate.

If `main` has advanced and syncing could conflict with active work, ask before doing
the sync. Never merge a feature branch into `main` without explicit human approval.

## Worktrees and concurrent work

- One isolated worktree per feature under `W:\tmp`, normally
  `git worktree add W:\tmp\<name> -b feat/<name> main`.
- Never move `HEAD` in the shared `main` checkout; multiple agents may be using it.
- Run all feature gates from the feature worktree.
- Sync `main` into the branch once, at the final pre-handback step. Report later
  drift rather than repeatedly chasing it.
- After creating a worktree, follow the active client's overlay for any
  client-specific setup. Do not copy or invent another client's settings files.
- Before touching an existing worktree, inspect live Git state with
  `git worktree list --porcelain` and the worktree's current status. Agent memory and
  status notes are useful context, but they can lag the repository and are never the
  authority for branch ownership or in-flight work.
- Treat other worktrees and unrelated dirty files as someone else's work. Never
  revert, move, stage, or delete them.

## Editing and commit discipline

- New/touched lines in specs, plans, prompts, issues, labels, comments, seed strings,
  and test names are ASCII-only. On a pre-existing non-ASCII file, only added lines
  must be ASCII.
- Never rewrite source with encoding-lossy PowerShell pipelines such as
  `Get-Content | -replace | Set-Content`; they can mojibake BOM-less UTF-8. Use a
  patch/edit tool.
- Read bare `git status` before every commit and check `.git/MERGE_HEAD`.
- Stage and commit explicit paths only; never use `git add -A` in this shared repo.
- Add a `Co-Authored-By` trailer naming the authoring model to agent-authored commits.
- New automated user-facing copy goes through the message catalog.
- New app runtime dependencies go in `app/package.json`, never the root package.
  Prove the Linux ARM64 install, including optional native dependencies represented
  in the lockfile.

## Issue, TODO, and known-problem tracking

There is no external issue tracker used for engineering work. Issues live in-repo in
two tiers; see [`docs/issues/README.md`](docs/issues/README.md).

- Tier 1: code-local `TODO(area):`, `FIXME(area):`, and `HACK(area):` markers.
- Tier 2: `docs/issues/<slug>.md` for anything important, cross-cutting, or
  triage-worthy. Copy `docs/issues/_TEMPLATE.md`.
- Reference a registry item inline with `TODO(<issue-slug>):`.
- Run `npm run issues` to regenerate the gitignored `docs/issues/INDEX.md`; never
  hand-maintain that index.
- `RUNBOOK.md` is operational only. Bugs, gaps, debt, and deferrals go in
  `docs/issues/`.

## Dependency and infrastructure safeguards

- Before committing to a new dependency, prove its license, Windows development
  behavior, Linux ARM64 production behavior, real API behavior, and runtime install.
- Vendor SDK imports belong in `app/src/adapters`; services and jobs depend on
  interfaces rather than vendor SDKs.
- All job traffic goes through `jobs.enqueue()` / `defineJobHandler()` so correlation
  and trace context are preserved.
- Preserve the locked Express middleware order: correlation ID, redacted light
  logger, CloudFront origin-secret validator, body parsers with raw-body capture,
  then routes.
- Media movement uses streams (`stream.pipeline`); whole-file buffers are forbidden.
- Tracing and metrics use OpenTelemetry, not the EOL X-Ray SDK.
