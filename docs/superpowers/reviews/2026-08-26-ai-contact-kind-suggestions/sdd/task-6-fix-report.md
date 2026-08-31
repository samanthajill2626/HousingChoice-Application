# Task 6 prompt-contract fix report

Commit: `4072e978 fix: neutralize AI contact kind prompt`

## TDD proof

The new prompt-contract assertions were added before the prompt change and run
through the permitted worktree path:

```text
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
Test Files  1 failed | 1 passed (2)
Tests  1 failed | 46 passed (47)
exit 1
```

After the minimal prompt correction:

```text
npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts
Test Files  2 passed (2)
Tests  47 passed (47)
exit 0

npm run typecheck -w @housingchoice/app
exit 0

npx eslint app/src/services/extraction/prompt.ts app/test/extractionSchema.test.ts
exit 0
```

No sandbox Vite or Vitest invocation was made; focused tests used the permitted
worktree execution path.

## Prompt contract shipped

- The opening identifies the existing `client` wire label as the CURRENT
  external contact and does not assign that contact a housing-related role.
  The regression test positively pins the neutral label framing and negatively
  asserts the retired `person seeking housing help` wording is absent.
- The mentioned-caseworker example now says the mentioned caseworker is not the
  contact. It permits Tenant only when other current-transcript evidence shows
  the caller seeks housing for themselves or their household; the sentence
  alone yields `none`. The prompt-contract test pins both the condition and
  the `none` fallback without asserting an unconditional Tenant result.
- The existing six D3 examples, four mutually exclusive kind criteria,
  organization and ambiguous-word refusal, current transcript/client/
  speakerRoles terms, note reconciliation/stated-role guidance, and derived
  fingerprint behavior remain unchanged.

## Files and unresolved items

- Modified: `app/src/services/extraction/prompt.ts` and
  `app/test/extractionSchema.test.ts`.
- No parser, schema, persistence, dashboard, route, E2E, configuration, flag,
  import, seed, migration, or infrastructure file changed.
- No unresolved prompt-contract items. Slow feature gates, final review, sync,
  self-QA, and human merge remain owned by later mission phases.
