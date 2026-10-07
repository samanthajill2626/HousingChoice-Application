---
id: lint-backlog-repo-wide
title: 23 pre-existing react-hooks lint errors across 18 files keep `npm run lint` from being a bare completion gate
type: debt
severity: med
status: open
area: repo
created: 2026-08-24
refs: eslint.config.mjs, AGENTS.md
---

**Status 2026-10-07 (`fix/lint-cleanup`).** Down from 111 errors / 61 files
(plus 36 warnings) on `main` that day to **23 errors across 18 files, 0
warnings**. Every remaining error is a `react-hooks/*` rule in `dashboard/src`
(item 3 below) - deliberately PAUSED by Cameron, not forgotten. What closed:

- Item 1: all `no-unused-vars` fixed by hand. Each production-code hit was
  checked against history first; none was a lost caller (`nameFromContact`,
  the relay `resolveMessage` import and `useUnmatchedEmail`'s `PAGE_LIMIT`
  were all left behind by intentional refactors, and `PAGE_LIMIT` was never
  wired - the page has always used the server's default limit).
- Item 2: `no-explicit-any` is OFF in test files (`*.test.*`, `*.spec.*`,
  `test/**`) by Cameron's call. Shipped code keeps the rule.
- Item 4: Cameron's decision - the two import sources
  (`app/src/lib/import/{airtableSource,quoSource}.ts`) are exempt from the
  `readFileSync` ban. The import is a manual, operator-run process over small
  CSV exports, not a media path. The ban stands for the rest of `app/src`.
- The 36 unused `eslint-disable` directives were deleted. The stray
  `prefer-const` and the fake-twilio-web "rule not found" directive were fixed;
  the one `no-empty-object-type` hit (`app/test/performanceSeed.test.ts`) keeps
  `{}` on purpose and carries a commented disable.

The table and plan below are the 2026-08-24 snapshot, kept for history.

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

**Counts at filing.** On `main` as it stood, with the rule at its defaults, the
number was **187 errors across 106 files**. The table below is what remains
AFTER the `argsIgnorePattern` config fix described below, which removed 70 of
them in one line - so quote 117 only alongside that config, and 187 for `main`
before it.

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

**A hole in the coverage, not just the count:** `eslint.config.mjs` declares
rules for `**/*.ts` and `**/*.tsx` only. There is no base JS block, so
`npx eslint` on a `.mjs` / `.js` file exits 0 having checked NOTHING - no rules,
no warning, no "file ignored" notice. Everything under `scripts/` is currently
unlinted and silently so, which also makes AGENTS.md gate 5 vacuous for those
files. Adding a base JS config will surface a fresh error count nobody has seen;
do it as its own step, not folded into a burn-down of the TypeScript errors.

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
3. The 24 `react-hooks/*` errors are correctness-adjacent - `set-state-in-effect`,
   `refs`, `purity` and `immutability` are rules about state that changes when
   nobody expects it. Worth treating as bug triage rather than lint cleanup.

   **But do not oversell that.** An earlier draft of this file claimed these
   were "exactly the class" that produced
   [`call-inbox-unread-detached-node-flake`](./call-inbox-unread-detached-node-flake.md),
   and the adversarial review of the branch that fixed it checked: **no rule in
   this backlog would have caught that bug.** It was a stale closure over a
   `useCallback` plus a clearing effect with empty deps - `react-hooks/refs`
   does not apply, and `exhaustive-deps` would not have fired either, because
   the dep array was complete. Prioritise this group on the merits of the rules
   themselves, not on a resemblance nobody verified.
4. The 2 `no-restricted-syntax` are `fs.readFileSync` in
   `app/src/lib/import/{airtableSource,quoSource}.ts`, hitting the Phase 0
   stream.pipeline ban. Either they are genuine violations of a binding
   guideline or the ban needs an explicit, argued exemption for non-media
   import sources. That is a decision, not a fix.

When the count reaches zero, promote `AGENTS.md` gate 5 from the touched-files
form to a bare `npm run lint` and delete the paragraph explaining the scope.
