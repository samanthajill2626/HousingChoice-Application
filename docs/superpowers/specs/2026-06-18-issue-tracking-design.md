# Issue / TODO / improvement tracking — Design & rationale

- **Date:** 2026-06-18
- **Status:** Approved (design); implemented in the same change.
- **Owner:** Cameron Abt
- **Authored with:** Claude Code (brainstorming skill)

## Problem

There was no consistent way to record issues, known problems, TODOs, things to
fix, or deferred decisions. In practice four disconnected conventions had grown up:

1. `docs/KNOWN_ISSUES.md` — a curated registry of bugs/findings.
2. Inline code comments — `TODO(M1.4):`, `TODO(dead-code):`, `FIXME`, `HACK`,
   `DEPRECATED` (a good latent convention, but informal and unlinked).
3. `RUNBOOK.md` "Security / hardening backlog" + scattered "tracked in the backlog
   below" notes — operational/infra items mixed into the ops doc.
4. Design-spec callouts ("PRE-EXISTING BUG surfaced…") buried in docs.

No rule said which to use, and there was no way to see all open work at once. The
hard constraint: **there is no external issue tracker** — the `origin` remote is
Azure DevOps and GitHub `gh` issues are unavailable, so everything must live
in-repo as files + comments. A further constraint specific to this repo:
**concurrent AI agents** frequently work in parallel, so any shared, hand-edited
file is a merge-conflict magnet.

## Goals

- One obvious place and format for anything worth tracking.
- **Both** future AI agents *and* humans are first-class consumers: greppable and
  machine-parseable, yet readable for triage.
- Minimal process. No external tooling. Conflict-resistant under concurrent agents.

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Tiers | **Two tiers.** Inline markers for code-local notes; a registry for anything cross-cutting/important/non-code. |
| D2 | Registry shape | **One file per issue** under `docs/issues/`, not a single shared file (avoids the concurrent-agent merge magnet; scales as phases pile up). |
| D3 | Top-level list | **Derived, never hand-maintained.** A small generator (`npm run issues`) reads every issue file's frontmatter and writes a **gitignored** `docs/issues/INDEX.md`; agents can also just `rg` the frontmatter. Because the list is computed, two branches that each add an issue never conflict. |
| D4 | IDs | **Slug-only** (`media-serve-stored-xss`). No central counter to contend over, self-describing in the filename and in inline references, never renamed when status changes. The generated index sorts by severity/date, so sequential numbering buys nothing. |
| D5 | Item format | **YAML frontmatter (machine layer) + markdown prose (human layer)** — the same shape the project's `.claude` memory files already use. |
| D6 | RUNBOOK | Goes back to being **purely operational**. Its backlog/issue rows migrate into `docs/issues/`; genuine operational *procedures* (e.g. key-rotation cadence) stay. |

### Why not the alternatives

- **One unified registry file** — forces code-local notes far from the code (people
  write inline TODOs anyway → drift returns) and is a merge magnet under concurrent
  agents.
- **Connected "lanes" across the existing 4 docs** — more convention to remember and
  still no single view of open work.
- **A committed generated index** — reintroduces the merge conflict the per-file
  design exists to avoid. Keeping the index gitignored/derived is the whole point.

## The two tiers

**Tier 1 — inline markers** (code-local, live and die with the code, greppable):

```
// TODO(area): note            — lightweight, no registry entry
// FIXME(area): known-broken
// HACK(area): deliberate shortcut + why
// TODO(<issue-slug>): note     — references a Tier-2 registry item
```

**Graduation rule:** an inline TODO earns a registry entry (a `docs/issues/<slug>.md`
file) the moment it is **important, cross-cutting, or something a human should
triage** — otherwise it stays a plain inline note. This keeps the registry
signal-rich and inline noise local.

**Tier 2 — the registry** (`docs/issues/<slug>.md`, one file per issue). Schema,
marker grammar, lifecycle, and commands live in
[`docs/issues/README.md`](../../issues/README.md) — the operational reference. This
spec records *why*; the README records *how*.

## Components

- `docs/issues/README.md` — the convention reference (schema + rules + commands).
- `docs/issues/_TEMPLATE.md` — copy-to-create template (leading `_` → generator skips it).
- `docs/issues/<slug>.md` — one file per tracked item (the source of truth).
- `docs/issues/INDEX.md` — **generated, gitignored** list (never committed).
- `scripts/issues.mjs` — dependency-free generator: globs the issue files, parses
  frontmatter, validates, writes `INDEX.md`, prints a summary. Wired as `npm run issues`.
- `.claude/CLAUDE.md` — a short section so every agent session learns the convention.

## Lifecycle

`status` moves `open → in-progress → resolved` (or `deferred` / `wontfix`). Resolved
items **keep their file** (with a resolution note + date) for the historical record;
the generated index groups Open above Closed so the open list stays scannable.

## Testing / verification

`npm run issues` runs clean against the migrated set and the generated `INDEX.md`
lists every issue under the right group. Malformed frontmatter is reported, not
silently dropped.
