# Task 6 - runtime activation report

Commit: `cddac44d feat: activate four AI contact kinds`

## TDD proof

Red was run first through the permitted worktree execution path:

```text
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
Test Files  1 failed | 1 passed (2)
Tests  5 failed | 42 passed (47)
exit 1
```

The five intended failures were the old three-value schema enum, parser rejection
of `partner`, parser rejection of `property_manager`, absence of the current
external-contact prompt contract, and absence of its current-transcript/role-note
rule. The existing raw `caseworker` off-enum diagnostic remained green in that
red run, proving raw operation preservation was not accidentally made red.

After the minimal schema, parser, prompt, and test changes:

```text
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
Test Files  2 passed (2)
Tests  47 passed (47)
exit 0

npm run typecheck -w @housingchoice/app
exit 0

npx eslint app/src/services/extraction/schema.ts app/src/services/extraction/prompt.ts app/test/extractionSchema.test.ts app/test/extractionOps.test.ts
exit 0
```

No sandbox Vite/Vitest attempt was made; every Vite-backed run used the permitted
worktree execution path because recovery was already 2/2.

## Shipped contract

- `EXTRACTION_SCHEMA` now has exactly `tenant`, `landlord`,
  `property_manager`, `partner`, and `none` for nested type suggestions.
- `parseExtractionText` accepts only the four `SuggestedContactKind` values from
  `adapters/extraction.ts`; `none`, `caseworker`, and all other unsupported
  values fold to no applicable suggestion.
- `parseExtractionOps` was not narrowed. It retains both canonical new kinds and
  nonempty off-enum `caseworker` as raw attempted `suggest` diagnostics; `none`
  remains the sole declined type sentinel.
- The prompt retains `client` and `speakerRoles` wire labels and note
  reconciliation. It classifies only the CURRENT external contact, states four
  exclusive role criteria, refuses organization/ambiguous-word guessing, emits
  `none` when unclear, includes all six D3 examples, and requests concise
  stated-fact Partner/Property Manager notes. There is no literal fingerprint
  expectation; the existing fingerprint test derives it from prompt plus schema.

## Contract/import and activation sweep

- `rg SuggestedContactKind` confirms the sole union declaration remains
  `app/src/adapters/extraction.ts`; schema imports that union rather than
  redeclaring it. Existing consumers are `contactKinds.ts`, extraction apply,
  and the contact route.
- The commit diff is limited to the two runtime contract files and their two
  tests. It has no persistence, route, dashboard, fake-driver, seed, import,
  migration, config, feature-flag, infrastructure, or deployment change.
- Activation began only after `.superpowers/sdd/progress.md` recorded S5 complete
  at `d4fb6f2c` and explicitly stated that S2-S5 focused gates satisfied the S6
  activation precondition. `git diff --name-only d4fb6f2c..cddac44d` contains
  only this S6 scope.

## Files and unresolved items

- Modified: `app/src/services/extraction/schema.ts`,
  `app/src/services/extraction/prompt.ts`, `app/test/extractionSchema.test.ts`,
  `app/test/extractionOps.test.ts`.
- Commit delta: 123 insertions, 9 deletions.
- No unresolved items in S6 scope. Full final gates, review, E2E, self-QA, sync,
  and human merge remain owned by later mission phases.
