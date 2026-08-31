# Task 7 resolved-issue history correction report

## Scope and commit intent

- Sole source change: `docs/issues/caseworker-contact-type.md`.
- Commit: `6edd776e646715c1f823d7a180173669b8194c0d` -
  `docs: clarify resolved caseworker classification history`.
- No app, dashboard, prompt, schema, adapter, test, E2E, server, config, or infra
  file changed. No Vite, Vitest, or E2E command was run because source behavior did
  not change and the recovery budget was exhausted.
- The documentation diff is 48 insertions and 43 deletions. `git diff --check`
  exited 0, and added documentation lines contain no non-ASCII characters.

## Current versus historical language proof

- The notice at lines 23-24 says that the body through Related is a
  pre-resolution 2026-08-18 historical snapshot and that Resolution records
  current behavior.
- Historical labels are exact: `Historical problem as of 2026-08-18`, `Four places
  pinned it shut then`, `What was not blocked then`, `Suggested fix at the time`,
  and `Decision that remained at the time and was resolved 2026-08-26`.
- Former present-tense claims now describe the historical state in past tense. The
  existing resolved dates, related issue references, and forward-only/no-backfill
  Resolution are retained.
- Former stale frontmatter and body references now use
  `buildExtractionSystemPrompt`,
  `EXTRACTION_SCHEMA.properties.typeSuggestion`, `SuggestedContactKind`, and
  `UnknownFile`; the remaining numeric source references were updated to current
  anchors where applicable.

## Issue index verification

```text
npm run issues
exit 0
[issues] 254 open, 153 closed, 407 total -> docs/issues/INDEX.md
[issues] open by severity: 9 high - 109 med - 136 low
[issues] 1 warning(s):
  - perf-selfqa-route-contract-drift.md: unknown severity "medium"
```

- The generated index lists `caseworker-contact-type` as `med | decision |
  resolved` at line 329.
- `docs/issues/INDEX.md` is ignored by `.gitignore:62`, and `git status --short`
  shows only `M docs/issues/caseworker-contact-type.md`; the index is unstaged.
- After the commit, `git status --short` is clean; `git show --check HEAD` exits 0,
  and the commit contains only the issue document.

## Unresolved items

None in this documentation-only correction scope. The unrelated existing issue
severity warning is reported above and was not changed.
