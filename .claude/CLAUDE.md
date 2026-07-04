## Claude Code

## Sub-agent model selection — use Fable SPARINGLY (usage limits)

We are hitting usage limits on the Fable model. Sub-agents spawned via the Agent
tool (and Workflow `agent()` calls) **inherit the parent session's model unless
overridden** — when the main session runs on Fable, every un-pinned sub-agent
silently multiplies Fable usage.

- **Pass an explicit `model` on every sub-agent.** Default to **`opus`** for
  the routine fan-outs (Explore sweeps, spec-conformance + adversarial reviewers,
  audits, searches); use **`sonnet`** for trivial mechanical sweeps.
- **Reserve Fable** for orchestrator-level work and tasks explicitly deemed
  high-importance (e.g. a subtle security-critical review or debugging session
  where the extra capability genuinely earns its cost). Using Fable on a
  sub-agent must be a deliberate, stated choice — never the silent default.

One entity, three labels by audience. The "single dwelling a single household can
lease and move into" is **always `unit` in code/data**. Human-facing copy uses:

- **Tenant →** "home"
- **Landlord →** "property"
- **Staff / navigator (dashboard) →** "property"
- **Code / data / internal →** "unit" (`unitId`, `unitsRepo`, `UnitItem`)

`unit` is the HUD/Section 8 term and is **structure-agnostic** (a house, townhome,
or apartment is all a "dwelling unit") — it is not apartment-specific. **`property`
is the blessed landlord/staff word for this single-`unit` entity** (its everyday,
no-advertisement-connotation name). If we ever model a multi-unit *parent* layer,
name it **"building"** or **"parcel"** — never "property" — so the leaf word
(`property` = one `unit`) and the parent word never collide.
Keep `listing_link` / "public listing" (the external listing URL) and the
JS object-property sense of "property" as-is.

Full rationale, the audience→noun table, and the future-AI mapping:
[documentation/GLOSSARY.md](../documentation/GLOSSARY.md). Update it in the same
change whenever you add a domain noun or fix drift.

## UI testing & verification (self-QA UI changes — don't hand them to the human)

This repo has a Playwright end-to-end harness so you can drive the real dashboard
and API yourself. **After changing any UI or user-facing flow, verify it with the
harness before claiming the work is done** — and add/extend a spec for new behavior.

- **Full suite** (boots a hermetic stack, runs, tears down): `npm run e2e`.
- **Interactive inner loop:** `npm run e2e:session` (persistent stack) + the
  Playwright **MCP** to navigate/click/snapshot/screenshot the live UI. After a
  backend change run `npm run e2e:restart` (app+worker only; the browser keeps its
  page); `npm run e2e:reseed` for a clean slate; `npm run e2e:stop` to end.
- **Dev-only, hermetic-LOCAL-only helpers** the harness exposes (gated OFF in every
  deployed env — never reachable in prod): `POST /auth/dev-login` (log in as seeded
  `va@example.com`, no Google), `GET /__dev/outbox` (assert what SMS *would* have
  been sent), `POST /__dev/reseed`, `GET /__dev/ping`.
- Write specs with accessibility-first selectors (`getByRole`/`getByLabel`) — see
  [e2e/support/selectors.md](../e2e/support/selectors.md). Requires Docker (DynamoDB Local).
- Interactive MCP browser: this repo's [.mcp.json](../.mcp.json) uses bundled
  chromium (no admin). If your client's *plugin* Playwright MCP errors with
  `Chromium distribution 'chrome' is not found`, a one-time **Administrator**
  `npx playwright install chrome` fixes it (see [e2e/README.md](../e2e/README.md)
  → Setup). The suite and `--headed`/`--ui` runs need no admin.
- **MCP artifacts go in `.playwright-mcp/` (gitignored).** Auto-named files —
  page snapshots and screenshots taken with NO `filename` — land there for both
  servers: the project server is pinned via `--output-dir` in
  [.mcp.json](../.mcp.json), and `PLAYWRIGHT_MCP_OUTPUT_DIR` in
  [settings.json](settings.json) `env` (passed to every spawned MCP) plus the
  tool's own `<cwd>/.playwright-mcp` default cover the plugin server.
  **Caveat (verified):** `browser_take_screenshot` with an explicit `filename`
  resolves it against the repo ROOT, not the output dir — output-dir is bypassed
  for named files *by design* (a named file means "save into my workspace"). So
  when you name a screenshot, **prefix it**: `filename: ".playwright-mcp/foo.png"`
  — or just omit `filename` and let it auto-name into the dir. We deliberately do
  NOT blanket-ignore root images, so real images can still live at the root.

Full workflow, modes, and how to add tests: **[e2e/README.md](../e2e/README.md)**.

## Issue, TODO & known-problem tracking (one consistent way)

There is no external issue tracker (the remote is Azure DevOps; `gh` issues are
unavailable), so issues live in-repo, in **two tiers**. Full reference:
[docs/issues/README.md](../docs/issues/README.md).

- **Tier 1 — inline markers** for code-local notes: `TODO(area):`, `FIXME(area):`,
  `HACK(area):`. Reference a registry item with `TODO(<issue-slug>):`.
- **Tier 2 — the registry** `docs/issues/<slug>.md` (one file per issue, slug = id =
  filename) for anything **important, cross-cutting, or triage-worthy**. Frontmatter
  (`type`/`severity`/`status`/…) + prose. Copy `docs/issues/_TEMPLATE.md`.
- **Graduation rule:** the moment an inline TODO is important/cross-cutting/triage-worthy,
  give it a registry file. Otherwise leave it inline.
- **See all issues:** `npm run issues` (writes the gitignored `docs/issues/INDEX.md`), or
  agents grep directly: `rg -l "^status: open$" docs/issues/ -g '!_*'`. Never hand-maintain a list —
  it's derived, which is what keeps concurrent issue-filing conflict-free.
- **RUNBOOK.md is operational only** — bugs/gaps/deferrals go in `docs/issues/`, not there.

## Branch hygiene — sync with `main` before declaring done

`main` moves fast: multiple agents merge in parallel, so a branch cut a day ago is
often several features behind. A branch that is green on a **stale base** can conflict
with — or silently revert — work that landed on `main` after you branched (this has
bitten us at review time more than once).

- **Before declaring a branch done / requesting review or merge:** merge the latest
  `main` into your branch (`git merge main`, or rebase), resolve any conflicts keeping
  BOTH sides' intent, then re-run the full gates — **`npm run typecheck` + `npm test` +
  `npm run e2e`** — green on the updated base. "Green" only counts against current `main`.
- **`npm run typecheck` is a REQUIRED gate — do not skip it.** `npm test` and `npm run
  e2e` run through esbuild/tsx, which strips types WITHOUT type-checking, so a red
  `tsc` (e.g. a strict `noUncheckedIndexedAccess` `ev[0]` nit in a test file) passes the
  runtime suites and slips onto `main`, breaking every later branch's typecheck. Running
  the tests green is NOT proof the types check. Always run `npm run typecheck` too.
- **If that surfaces conflicts, or you're unsure whether to sync mid-build, ASK first** —
  e.g. "`main` has advanced N commits since I branched; should I merge it in before I
  continue / before I finish?" Don't silently finish on a stale base.
- Never merge your branch INTO `main` without explicit human approval.
