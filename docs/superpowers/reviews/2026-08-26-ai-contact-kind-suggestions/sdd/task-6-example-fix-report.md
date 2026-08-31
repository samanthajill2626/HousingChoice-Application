# Task 6 approved-example correction

## Scope

- Changed `app/src/services/extraction/prompt.ts` and
  `app/test/extractionSchema.test.ts` only.
- Preserved baseline commit `4072e978` and did not modify parser, schema,
  route, dashboard, E2E, config, infrastructure, flag, import, seed, or migration code.

## TDD evidence

- RED: `npm run test -w @housingchoice/app -- test/extractionSchema.test.ts`
  exited 1 with `1 failed | 34 passed`; the new represented-client assertion
  expected the outside-role qualification and received the unconditional
  `"I am calling about a client" -> none.` prompt line.
- GREEN: `npm run test -w @housingchoice/app -- test/extractionSchema.test.ts test/extractionOps.test.ts`
  exited 0: `Test Files 2 passed (2)`, `Tests 47 passed (47)`.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `npx eslint app/src/services/extraction/prompt.ts app/test/extractionSchema.test.ts`
  exited 0.

## Semantics pinned

`"I am calling about a client"` now maps to `none` unless other current-transcript
evidence clearly establishes an outside service, program, or navigation role. A
clear outside role remains Partner under the existing four-kind rules. The same
example-line prompt-contract assertion makes removal of that qualification fail.
Neutral client wire framing, the conditional mentioned-caseworker/none example,
the other D3 examples, and raw/applicable runtime behavior were not changed.

## Unresolved items

None within this correction's approved scope.
