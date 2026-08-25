---
id: lint-backlog-repo-wide
title: 117 pre-existing lint errors across 65 files keep `npm run lint` from being a bare completion gate
type: debt
severity: med
status: open
area: repo
created: 2026-08-24
refs: eslint.config.mjs, AGENTS.md
---

**Problem.** `npm run lint` has been red on `main` for long enough that nobody
reads it. Found on 2026-08-24 while a mission touched
`app/src/routes/inbox.ts`: the file reported an unused-import error that had
nothing to do with the branch, which is the tell that the signal had stopped
being actionable.

That is the real cost. A permanently red lint run is worse than no lint run,
because the one time it reports something new it looks exactly like the
background noise. The unused import that surfaced this had been sitting there
unnoticed; so had 186 others.

`AGENTS.md` gate 5 was added the same day, scoped to TOUCHED FILES rather than
the repo, precisely so the rule could be enforced from day one instead of
waiting on this backlog. This issue is that backlog.

**Counts at filing** (after the `argsIgnorePattern` config fix below, which
removed 70 of them in one line):

| rule | errors |
|---|---|
| `@typescript-eslint/no-unused-vars` | 56 |
| `@typescript-eslint/no-explicit-any` | 33 |
| `react-hooks/set-state-in-effect` | 15 |
| `react-hooks/refs` | 4 |
| `no-restricted-syntax` | 2 |
| `react-hooks/purity` | 2 |
| `react-hooks/immutability` | 2 |
| `@typescript-eslint/no-empty-object-type` | 1 |
| `prefer-const` | 1 |
| `react-hooks/exhaustive-deps` | 1 |
| **total** | **117 across 65 files** |

Plus 37 warnings, most of them unused `eslint-disable` directives - suppressions
for problems that no longer exist, which are worth deleting on sight.

**Already done, 2026-08-24.** The rule was running with its defaults, so it knew
nothing about the `_`-prefix convention this codebase uses to mark a
deliberately unused binding. 70 of the original 126 unused-var errors were
reporting names that already SAID "unused on purpose"
(`_input`, `_conversationSid`, `_staleName`). `eslint.config.mjs` now sets
`argsIgnorePattern` / `varsIgnorePattern` / `caughtErrorsIgnorePattern` /
`destructuredArrayIgnorePattern` to `^_`. That took the count from 187 to 117
without suppressing a single real finding: every name that does not opt out is
still an error.

**Suggested fix.** Burn down by rule, not by file - each rule is a different
kind of judgement and mixing them makes review impossible:

1. The remaining 56 `no-unused-vars` are mostly dead imports and dead locals.
   Nearly mechanical, but each one deserves a glance: an unused import can mean
   the code that used it was deleted by mistake, which is a bug, not a tidy-up.
2. The 33 `no-explicit-any` need real types and are the only genuinely
   expensive group.
3. The 26 `react-hooks/*` errors are correctness-adjacent - `set-state-in-effect`
   and `refs` are exactly the class that produced
   [`schedule-tour-form-test-flake`](./schedule-tour-form-test-flake.md) and the
   stale-ref bug in
   [`call-inbox-unread-detached-node-flake`](./call-inbox-unread-detached-node-flake.md).
   Treat these as bug triage, not lint cleanup, and do them first.
4. The 2 `no-restricted-syntax` are `fs.readFileSync` in
   `app/src/lib/import/{airtableSource,quoSource}.ts`, hitting the Phase 0
   stream.pipeline ban. Either they are genuine violations of a binding
   guideline or the ban needs an explicit, argued exemption for non-media
   import sources. That is a decision, not a fix.

When the count reaches zero, promote `AGENTS.md` gate 5 from the touched-files
form to a bare `npm run lint` and delete the paragraph explaining the scope.
