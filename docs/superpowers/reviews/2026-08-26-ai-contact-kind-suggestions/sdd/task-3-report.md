# Task 3 report - extraction-side type suggestion reconciliation

## Delivered

- Type suggestion puts carry `contactClassificationRevision`, treating an absent
  contact field as logical revision zero.
- A successful type put is reconciled against a consistent live contact read. It
  records a terminal drop only when this writer's guarded delete returns
  `deleted`; replacements, finalization markers, missing contacts, repository
  failures, and four exhausted contact-revision conflicts remain pending.
- Reconciliation distinguishes a classified contact (`type_already_classified`)
  from a newer Unknown epoch (`type_classification_changed`). It emits one
  `suggestion.updated` event even if its transient type row is retracted.
- The apply dependency contract now explicitly requires the consistent contact
  read and guarded type-delete primitives. Existing real worker and dev wiring
  already supplied complete repositories, so no production construction edit was
  needed.

## TDD evidence

- RED: `npm run test -w @housingchoice/app -- test/extractionApply.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts` exited 1. It ran 94 tests: 86 passed and 8 failed. The failures were the expected absent drop reason, source revision, live read, guarded cleanup, retry, and best-effort warning behavior.
- GREEN: the same command exited 0: 94 passed across 3 files.

## Verification

- `npm run test -w @housingchoice/app -- test/extractionApply.test.ts test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/extractionDecisions.test.ts test/extractionRunTypes.test.ts test/twilioSmsWebhook.test.ts` exited 0: 239 passed across 6 files.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `git diff --check` exited 0.
- Vite-backed tests were run through the elevated feature-worktree execution path after the known sandbox `node_modules/.vite-temp` EPERM. Both test runs completed normally with DynamoDB Local global setup and teardown.
- Focused lint exited 1 on two unchanged baseline imports: `beforeEach` in `extractionApply.test.ts` and `WINDOW_CHAR_BUDGET` in `extractionJob.test.ts`. Both imports are present on `main`; no new lint error was introduced by this slice.

## Commit

- `3f96cfa5 feat: retract stale AI type suggestions`

## Concerns

- No runtime schema, parser, or prompt activation was changed. Partner and Property Manager remain compile-time/persistence-ready only until the separately owned activation slice.
