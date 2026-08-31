# Feature Development Workflow

How we take a top-level issue from idea to merge-ready code. This is the
standardized process the human (Cameron) and the active orchestrator agent run
together, plus the learnings, best practices, and gotchas accumulated while running
it. Follow it for any non-trivial feature or change.

Companion docs: `AGENTS.md` (canonical cross-agent project rules),
`documentation/GLOSSARY.md` (domain nouns), `docs/issues/README.md` (issue registry),
and `e2e/README.md` (the self-QA harness). Client-specific runtime details live in
`.claude/CLAUDE.md`, `.claude/feature-mission.profile.md`, `.codex/config.toml`, and
`.codex/feature-mission.profile.md`; they must not duplicate shared behavior from
this file or `AGENTS.md`.

---

## 1. Roles

- **Human (Cameron):** hands over the top-level issue; makes the product/architecture
  decisions; launches the builder agent with the orchestrator prompt; merges. The only
  actor who moves `main` and who runs infra (terraform/secrets/deploys).
- **Orchestrator (active agent, main session):** runs the design conversation, writes the
  spec and the plan, cuts the worktree, hands over the orchestrator prompt, and later
  runs the independent review. Never merges; never runs infra without an explicit ask.
- **Builder (a separate agent):** executes the plan task-by-task in the isolated
  worktree, then hands back. Fresh context; the orchestrator prompt is self-contained.

Keeping "who builds" and "who reviews" as different agents is deliberate: the reviewer
is adversarial and independent, which catches what a builder rationalizes.

---

## 2. The three lanes (pick one at intake)

Before doing anything, classify the request:

- **Feature / non-trivial change** -> run the FULL pipeline (Section 3).
- **Clear bug on `main` the human says to fix** -> diagnose to ROOT CAUSE first
  (systematic-debugging), report it, then fix directly on `main` on the human's go
  under the small-fix gates (typecheck + unit suite + live QA now; bulk e2e at a
  checkpoint). Explicit-path commit.
- **Symptom report ("X is failing")** -> the deliverable is an ASSESSMENT: trace the
  root cause and report + propose the fix; apply only on the human's go. Do not start
  editing on a symptom.

When unsure which lane, ask. Most 12300-style "it's broken" reports start as lane 3
(assessment) and only become lane 1 (feature) once the human chooses a direction.

---

## 3. The feature pipeline

```
intake -> brainstorm -> (spike de-risk) -> spec -> user review
       -> plan -> orchestrator prompt -> [builder builds] -> independent review -> human merges -> post-merge ops
```

### 3.1 Brainstorm (skill: superpowers:brainstorming)

- Explore the actual code first (the send path, the existing patterns), then ask
  clarifying questions **one at a time**. Prefer multiple-choice. Recommend an option;
  do not dump an exhaustive survey.
- Offer 2-3 approaches with trade-offs and a recommendation for each real fork.
- **Offer the visual companion just-in-time** - only when a question is genuinely
  visual (a layout/mockup/diagram), as its own message. Not for conceptual choices.
- **De-risk dependencies with a real spike BEFORE committing to them** (see Section 4).
- Think one step past the current channel/scale (e.g. RCS-forward seams) but build
  only cheap seams now - YAGNI on the actual future feature.
- Push on non-functional concerns (memory, CPU, cost, concurrency) with EXACT numbers,
  not hand-waving. Align new code to existing proven patterns rather than inventing a
  parallel one (e.g. reuse the direct-to-S3 presign/confirm pattern).

### 3.2 Spec

- Write an ASCII spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
- Do it in a **fresh git worktree** cut from `main` (Section 5), and commit it there.
- Self-review: ASCII check, placeholder scan, internal consistency, scope.
- **User review gate:** ask the human to read the committed spec before proceeding.
  Revise on request; only continue when approved.

### 3.3 Plan (skill: superpowers:writing-plans)

- Write to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`.
- Assume the builder has zero context: exact file paths, complete runnable code in
  every step, exact commands with expected output, TDD steps (write failing test ->
  run red -> implement -> run green -> commit), right-sized tasks, frequent commits.
- Include a Global Constraints block copying the spec's hard values verbatim.
- No placeholders ("TBD", "add error handling", "similar to Task N"). Repeat code
  rather than cross-reference; the builder may read tasks out of order.
- Self-review against the spec: every spec section maps to a task; type/name
  consistency across tasks; fix inline.

### 3.4 Orchestrator prompt

- Hand the human a **fenced code block** (Section 6) that a fresh builder agent can run
  with no other context: worktree/branch, the plan + spec paths, the execution method
  (executing-plans / subagent-driven-development), the hard rules, the T-ordering watch
  items, and the handback contract (run bare gates, report real exit codes, do not
  merge, stop for review).

### 3.5 Independent review (on builder handback)

Run every time; do not shortcut because the builder said "green":

1. Verify the builder is STOPPED, then scope the diff:
   `git -C <worktree> diff main...HEAD --stat`, `git rev-list --count HEAD..main`.
2. Run your OWN gates, BARE, from the worktree: `npm run typecheck`, `npm test`,
   `timeout 1500 npm run e2e`. Quote the real exit codes.
3. When the active client supports parallel agents, dispatch two independent
   reviewers: a spec-conformance reviewer and an adversarial reviewer. Make the
   adversarial reviewer security-focused when the surface warrants it (for example,
   a browser-to-S3 write grant). Let the client-specific overlay/configuration choose
   supported models; never put client model identifiers in this shared workflow.
4. Read the riskiest diffs yourself.
5. Live Playwright-MCP pass: drive the real dashboard and prove the behavior end to
   end (not just that tests pass).
6. Fix small must-fixes YOURSELF with proof + regression tests; file low-severity
   findings as `docs/issues/<slug>.md`.
7. Deliver a verdict with quoted exit codes and a single-line PowerShell merge command.
   The human merges.

### 3.6 Post-merge

- The human merges and runs any owed infra (terraform apply / npm install / dev-stack
  restart+reseed). Record what is owed in the verdict and in `RUNBOOK.md`.
- Cleanup (branch + worktree deletion, spec HISTORICAL stamping) happens ONLY on an
  explicit go - never as a silent follow-up.

---

## 4. Spike / de-risk dependencies (a load-bearing habit)

Before a design commits to a library or toolchain, prove it actually works - in a
throwaway project in the scratchpad, with real inputs. This has repeatedly saved a
mid-build blowup.

Check, in order:

1. **License.** Reject copyleft that encumbers a proprietary SaaS. (MuPDF/Ghostscript
   are AGPL, Poppler is GPL; the permissive PDF renderers are Mozilla pdf.js (Apache)
   and Google PDFium (BSD/Apache). `sharp` is Apache-2.0, `@hyzyla/pdfium` is MIT.)
2. **Platform.** The runtime is `linux/arm64` on `node:24-slim` (glibc). Confirm a
   prebuilt exists for that triple, or that the lib is pure WASM (arch-independent).
   Remember dev is `win32/x64` - passing locally does NOT prove the deploy target.
3. **The REAL API, not the docs.** Run it. The pdfium docs advertised
   `render: 'sharp'` returning PNG; the real 2.1.13 API only has `render: 'bitmap'`
   returning a RAW RGBA buffer. The type default claimed BGRA (red/blue swap); reality
   was RGBA. Assert the surprising behaviors (e.g. a color-accuracy pixel check) so a
   future version bump that regresses them fails CI.
4. **Prove the runtime install.** New runtime deps go in `app/package.json` (never
   root - the Dockerfile runtime stage runs `npm ci --workspace app --omit=dev`).
   `sharp`'s arm64 binary is an OPTIONAL dependency; the lockfile must actually contain
   `@img/sharp-linux-arm64` or `npm ci` in the arm64 build skips it and prod
   boot-crashes. Prove with a real arm64 `npm ci` in a `node:24-slim` container.

The spike is throwaway (scratchpad, session-isolated). Its VALUE is the learnings,
which get pinned into the spec and the plan.

---

## 5. Worktrees

- One worktree per feature under `w:\tmp`: `git worktree add w:\tmp\<name> -b feat/<name> main`.
- Never move `HEAD` in the shared `main` checkout - other agents run concurrently there.
- Run all gates for a feature FROM its worktree.
- Sync `main` into the branch exactly ONCE (the builder's final step before handback);
  note later drift in the verdict, do not chase it with repeated re-merges.

---

## 6. Handover formatting

- **Prompts the human will paste** (orchestrator prompts, agent prompts) go in a fenced
  code block. Use a 4-backtick fence if the content itself contains triple backticks.
- **Commands for the human** are Windows PowerShell, single-line (or backtick-continued).
- File references in chat use clickable markdown links, but remember a worktree path is
  NOT under the human's main checkout - give the absolute `w:\tmp\...` path when the
  file lives in a worktree.

---

## 7. Hard rules / gotchas (the accumulated checklist)

Process:

- **ASCII only** in specs, plans, prompts, and new code/comments/test strings. Verify:
  `tr -d '\11\12\15\40-\176' < FILE | wc -c` must print 0.
- **Never mojibake source with PowerShell rewrites.** Do not
  `Get-Content | -replace | Set-Content` on source (BOM-less UTF-8 read as ANSI ->
  em-dash mojibake + a spurious BOM). Use the Edit tool.
- **Prompts as fenced blocks; commands as single-line PowerShell** (Section 6).

Gates:

- Run gates **BARE** - never pipe them (a pipe returns the tail command's exit code,
  hiding a real failure). Filter output only after the run.
- **Typecheck is a separate REQUIRED gate.** `npm test` / e2e run through esbuild/tsx,
  which strip types WITHOUT checking them - a red `tsc` passes the runtime suites and
  breaks every later branch. Always run `npm run typecheck` too.
- Run **e2e / Playwright ONLY from the e2e workspace** (via `npm run e2e`), under
  `timeout 1500`. A root/stray run falls back to `:5174` = the human's LIVE stack.
- `npm` eats args after `--` in some scripts (e.g. `npm run e2e -- --flag` never reaches
  playwright). Configure via the workspace, not passthrough flags.

Sub-agents:

- Follow the active client's overlay and configuration for supported roles, models,
  reasoning effort, permissions, and concurrency. Keep those identifiers out of this
  shared document. Use independent reviewers for spec conformance and adversarial
  review; reserve any top-tier child-model override for a deliberate, stated reason.

Git:

- A gating `git status` is a SEPARATE read before EVERY commit. Commit EXPLICIT paths
  only (the shared checkout may hold other agents' work). Check `.git/MERGE_HEAD`.
- Bash cwd silently drifts back to the main repo between calls - `cd` explicitly every
  command; `pwd` before trusting a surprising git/status output.

Infra & cleanup:

- **No infra without an explicit ask:** never terraform apply / secrets:push / SSM
  writes / deploys unless the human asks.
- New app runtime deps: `app/package.json` only; prove the arm64 `npm ci` (Section 4).
- **Cleanup only on an explicit go:** branch/worktree deletion, spec HISTORICAL
  stamping, and post-merge housekeeping happen when asked, not as a silent follow-up.
  A status update or standing offer is NOT a go.

Playwright MCP (live QA):

- The MCP runs `--isolated` (its own ephemeral profile) so concurrent agents can drive
  browsers side by side. It starts logged OUT each launch - `POST /auth/dev-login`
  again. NEVER kill mcp-chrome processes (that is another agent's browser).
- Auto-named snapshots/screenshots land in `.playwright-mcp/` (gitignored). A named
  screenshot resolves against the repo ROOT - prefix it `.playwright-mcp/<name>.png`.
- File uploads must come from an allowed root (under the repo's `.playwright-mcp`);
  clean up QA fixtures after.

Dev-stack self-QA:

- Reseed + reset the fake BEFORE diagnosing mock SMS/MMS; backend changes need
  `npm run e2e:restart`. Lane tables can keep pre-GSI schemas - delete `hc-local-<L>-*`
  tables if a lane shows a stale schema.

---

## 8. Where artifacts live

- Specs: `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- Plans: `docs/superpowers/plans/YYYY-MM-DD-<feature>.md`
- **Mission records (TRACKED): `docs/superpowers/reviews/YYYY-MM-DD-<branch>/`**
- Issues (two tiers - inline `TODO(area):` markers + a registry): `docs/issues/`
- Worktrees: `w:\tmp\<name>`
- Orchestrator run state (IGNORED): `<worktree>/.superpowers/`
- Throwaway spikes: the session scratchpad (never the repo)
- Operational runbook (deploy/ops only; NOT bugs): `RUNBOOK.md`

### Mission records are version-controlled on purpose

A mission's durable value is its DECISIONS - what a review found, what was
accepted or rejected and why, what the tree turned out to hold that the plan got
wrong. Git has the diff already; it has none of that. **Commit each record AS IT
IS PRODUCED, not batched at handback**, so a mission that dies mid-flight still
leaves its reasoning behind and the commit order reads as an account of how the
design moved.

Split by KIND, never by file extension:

| | where | what |
|---|---|---|
| Records | `docs/superpowers/reviews/<date>-<branch>/`, **tracked** | design + code review rounds, adjudications, findings lists, drift/delta worklists, per-slice and fix-wave reports, self-QA, handback |
| Run state | `<worktree>/.superpowers/`, **ignored** | `sdd/progress.md` ledger, `live.log`, gate logs, `*.exit`, `*.pid`, raw diff packages |

Do not commit what git can regenerate: a raw diff, or byte-exact quotation of
code the record already cites by commit. Where a summary file is the DELTA or
adjudication of a bigger raw one, the summary is the record and the raw file is
run state. **Preserve captured tool output VERBATIM** - the ASCII-only rule in
`AGENTS.md` governs newly authored text, and rewriting a gate transcript to
satisfy it falsifies the record; note the exception instead.

### One file, one kind - split at authorship

A file that carries findings AND reference together has no good disposal:
dropping it whole loses the findings, keeping it whole commits the waste, and
bisecting it later means re-reading it to hunt the seam. So any child that
produces both writes TWO artifacts, and its brief says so:

- `docs/superpowers/reviews/<date>-<branch>/<area>-findings.md` - what the tree
  turned out to hold that the plan or spec got WRONG: contradictions,
  corrections, risks. Cite code by `file:line`; do not paste it.
- `<worktree>/.superpowers/sdd/<area>-reference.md` - the byte-exact quotation
  backing those citations. Ignored, dies with the worktree.

Measured on the 2026-08-25 inbox-unread-cluster mission, the three research
files were **10%, 11% and 0% findings** - one was 83KB of pure quotation with no
findings at all - so ~94% of 190KB was reference. **A researcher with nothing to
correct writes no findings file, and that is a valid result** - do not pad one.

Worked example, including what was deliberately dropped and why:
[`docs/superpowers/reviews/2026-08-25-inbox-unread-cluster/README.md`](../docs/superpowers/reviews/2026-08-25-inbox-unread-cluster/README.md).

**Why this rule exists.** These records used to live only under the worktree's
gitignored `.superpowers/`. `git status --porcelain` cannot see ignored files, so
a worktree full of review history reports perfectly clean - and a 2026-08-21
cleanup sweep of 16 worktrees destroyed every handback and adversarial review
they held, unrecoverably, on exactly that false signal.

---

## 9. One-screen checklist

- [ ] Classify the lane (feature / bug-fix / assessment).
- [ ] Brainstorm: one question at a time, 2-3 approaches, recommend.
- [ ] Spike-verify any new dependency (license / platform / real API / arm64 install).
- [ ] Write the ASCII spec in a fresh worktree; self-review; get user review.
- [ ] Write the TDD plan (complete code, exact commands, no placeholders); self-review.
- [ ] Hand over a self-contained orchestrator prompt (fenced block).
- [ ] On handback: scope the diff, run bare gates, 2 independent reviewers, read risky diffs,
      live Playwright pass, fix small must-fixes with tests, file the rest.
- [ ] Verdict with quoted exit codes + PowerShell merge command. Human merges.
- [ ] Record owed post-merge ops (infra / npm install / restart+reseed) in RUNBOOK.
- [ ] Cleanup only on an explicit go.
