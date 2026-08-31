# Task 1 report - canonical AI contact-kind type

## Scope and files

- Changed and committed: `app/src/adapters/extraction.ts`
- Added exported `SuggestedContactKind` with exactly `tenant`, `landlord`,
  `property_manager`, and `partner`.
- Replaced only `ExtractionResult.typeSuggestion.value`'s inline union with the
  exported alias. No schema, parser, raw-operation parser, prompt, or runtime
  behavior changed.

## Test rationale and evidence

This compile-time-only task has no fabricated red test. The widened declaration is
proven by the app typecheck. Runtime activation remains absent: the live schema
still enumerates only `tenant`, `landlord`, and `none` at
`app/src/services/extraction/schema.ts:124`; `parseExtractionText` still folds
anything other than `tenant` or `landlord` to absent at `:245-251`.
`parseExtractionOps` deliberately exposes non-enum attempted values as failed
suggestions, as its existing focused test asserts; this behavior was untouched.

Commands and exit outcomes:

```text
npm run typecheck -w @housingchoice/app
exit 0

npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
first attempt: exit 1, sandbox EPERM creating node_modules/.vite-temp
rerun with required worktree write permission: exit 0
Test Files  2 passed (2)
Tests  41 passed (41)
```

## Commit and discipline

- `git status --short --branch` immediately before staging listed only
  `M app/src/adapters/extraction.ts`.
- `git rev-parse -q --verify MERGE_HEAD` produced no output.
- Staged only `app/src/adapters/extraction.ts`.
- Commit: `e8100f3e refactor: define AI contact kind union`
- Commit includes the required `Co-Authored-By: GPT-5.6 Codex <noreply@openai.com>`
  trailer.

## Concerns

None. The new union is intentionally compile-time scaffolding; production runtime
output remains Tenant/Landlord-only until the separately scoped activation task.
