# Task 2 report - contact classification revision persistence

## Delivered

- Added optional `ContactItem.classification_revision` plus logical-zero helper
  `contactClassificationRevision`.
- Made `ContactsRepo.update` atomically increment the persisted revision in its
  existing UpdateCommand only when a supplied `type` or `role` changes, including
  `role: null` and `type: 'unknown'`.
- Added optional suggestion source revision, revision-first identity comparison,
  consistent suggestion point reads, and guarded two-table type-suggestion delete.
- The guarded delete uses the required zero predicate
  `attribute_not_exists(classification_revision) OR classification_revision = 0`,
  diagnoses transaction cancellation with consistent reads in contact-revision
  priority, and preserves generic replacement behavior.
- Updated every listed concrete ExtractionRepo fake, including a faithful harness
  implementation that checks both contact revision and exact suggestion identity.

## TDD evidence

- RED: `npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts`
  exited 1 with 13 passed and 2 failed. Both failures were the expected missing
  revisions: type update returned `undefined` instead of 1, and concurrent
  updates returned `[undefined, undefined]` instead of `[1, 2]`.
- GREEN: the same test exited 0 with 15 passed.
- RED: `npm run test -w @housingchoice/app -- test/extractionRepo.test.ts test/extractionRepo.integration.test.ts`
  exited 1 with 47 passed and 5 failed. Failures were the expected missing source
  revision, consistent read, identity helper, and guarded-delete method.
- GREEN: `npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/extractionRepo.test.ts test/extractionRepo.integration.test.ts`
  exited 0 with 67 passed across 3 files.

## Verification

- `npm run test -w @housingchoice/app -- test/extractionJob.test.ts test/extractionJobDraftGuard.test.ts test/twilioSmsWebhook.test.ts` exited 0: 140 passed across 3 files.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `git diff --check` exited 0 before commit.

## Commit

- `fcf65dda feat: fence contact kind revisions`

## Deviation and concerns

- `npm run db:start` exited 1 because Docker reported its daemon unavailable.
  Vitest global setup nevertheless reached the existing DynamoDB Local service and
  executed the real integration tests; no integration test was skipped.
- No runtime extraction schema, parser, prompt, seed, import, migration, backfill,
  dependency, or infrastructure activation changed in this slice.
