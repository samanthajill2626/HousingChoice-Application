# Issue & TODO tracking

The single, in-repo way to record **bugs, known problems, things to fix, tech debt,
improvements, and deferred decisions**. There is no external issue tracker (the
remote is Azure DevOps; GitHub `gh` issues are unavailable), so this lives in the repo
as files + code comments. Designed to be read by **both humans and AI agents**.

Design rationale: [`docs/superpowers/specs/2026-06-18-issue-tracking-design.md`](../superpowers/specs/2026-06-18-issue-tracking-design.md).

## Two tiers — which do I use?

**Tier 1 — inline code markers.** For code-local notes that only make sense next to
the code and that live and die with it:

```ts
// TODO(area): short note               — lightweight; no registry entry needed
// FIXME(area): known-broken thing
// HACK(area): deliberate shortcut + why
// TODO(<issue-slug>): short note        — points at a Tier-2 registry item below
```

`area` is a free short tag (e.g. `media-serve`, `idempotency`, `dead-code`).

**Tier 2 — the registry (this folder).** One file per item: `docs/issues/<slug>.md`.
Use it for anything **important, cross-cutting, or that a human should triage**.

**Graduation rule:** the instant an inline TODO is important / cross-cutting /
triage-worthy, give it a registry file and (optionally) point at it inline with
`TODO(<slug>)`. Otherwise leave it as a plain inline marker. This keeps the registry
signal-rich and inline noise local.

## Creating an issue

1. Copy [`_TEMPLATE.md`](./_TEMPLATE.md) to `docs/issues/<slug>.md`.
2. The **filename (minus `.md`) IS the id** — pick a short, descriptive,
   kebab-case slug (e.g. `media-serve-stored-xss`). Slugs are the id everywhere:
   the filename, the `id:` field, and any inline `TODO(<slug>)` reference. They don't
   change when status changes.
3. Fill in the frontmatter + a prose body. Run `npm run issues` to refresh the index.

### Frontmatter schema

```yaml
---
id: media-serve-stored-xss     # REQUIRED — must equal the filename minus .md
title: One-line summary         # REQUIRED
type: security                  # REQUIRED — bug | security | debt | improvement | decision
severity: high                  # REQUIRED — high | med | low
status: open                    # REQUIRED — open | in-progress | deferred | resolved | wontfix
area: app/media-serve           # short free-text area/owner-surface
created: 2026-06-18             # YYYY-MM-DD
updated: 2026-06-18            # optional
resolved: 2026-06-18           # optional — set when status is resolved/wontfix
refs: app/src/routes/api.ts:805, app/src/lib/mediaTypes.ts   # optional, comma-separated
---
```

Below the frontmatter, write freely: the problem, repro, root cause, suggested fix,
and (once closed) a **Resolution** note. Link related issues with `[<slug>](./<slug>.md)`.

### Taxonomy (kept small on purpose)

- **type** — `bug` (defect) · `security` · `debt` (cleanup/refactor/dead code) ·
  `improvement` (enhancement / new capability) · `decision` (a deferred or parked choice).
- **severity** — `high` · `med` · `low`.
- **status** — `open` · `in-progress` · `deferred` · `resolved` · `wontfix`.

## Seeing the list

The top-level list is **derived, never hand-maintained** — so two agents adding
issues on different branches never conflict.

- **Humans:** `npm run issues` regenerates `docs/issues/INDEX.md` (gitignored — a
  local convenience artifact, never committed) and prints a summary. Open it to browse.
- **Agents:** just grep the frontmatter, no script needed. (`INDEX.md` is auto-skipped —
  it's gitignored; the globs drop the README/template so only real issue files match.)
  ```
  rg "^(id|title|type|severity|status):" docs/issues/ -g '!_*' -g '!README.md'  # the whole table
  rg -l "^status: open$" docs/issues/ -g '!_*'                                    # files with open issues
  rg -l "^status: open$" docs/issues/ -g '!_*' | xargs rg -l "^severity: high$"   # open + high
  ```

## Lifecycle

`open → in-progress → resolved` (or `deferred` / `wontfix`). When you close one, set
`status:` + `resolved:` and add a **Resolution** paragraph — **keep the file** for the
record. The index groups Open above Closed so the open list stays scannable.

## What does NOT belong here

- Operational *procedures* (how to deploy, rotate keys, run alarms) → `RUNBOOK.md`.
- Completed feature design/plan docs → `docs/superpowers/` (stamped historical when merged).
- Throwaway code-local notes → a plain inline `TODO(area)`; don't file an issue.
