# Task 2 fix wave 1 report

## Delivered

- Made the webhook harness increment `classification_revision` on every supplied
  non-undefined `type` or `role` patch, including `role: null`.
- Added a harness regression for committed revisions 1 then 2 and an older
  guarded delete preserving a later-epoch type suggestion.
- Added real DynamoDB legacy guarded-delete coverage for no-run exact delete,
  absent-versus-present run ID, a revisioned replacement sharing legacy fields,
  and a later numeric contact-revision mismatch.
- Added a cancellation regression that rethrows the original cancellation when
  both consistent post-failure reads still satisfy the guard predicates.

## TDD and verification

- RED: `npm run test -w @housingchoice/app -- test/twilioSmsWebhook.test.ts`
  exited 1 with 61 passed and 1 failed. The new harness fence test observed
  `classification_revision` as `undefined` instead of 1.
- GREEN: the same command exited 0 with 62 passed.
- `npm run test -w @housingchoice/app -- test/extractionRepo.test.ts test/extractionRepo.integration.test.ts`
  exited 0 with 54 passed across 2 files. The integration test executed against
  DynamoDB Local and pins the production transaction legacy branches.
- `npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/extractionRepo.test.ts test/extractionRepo.integration.test.ts test/twilioSmsWebhook.test.ts`
  exited 0 with 131 passed across 4 files.
- `npm run typecheck -w @housingchoice/app` exited 0.
- `npx eslint app/test/helpers/twilioWebhookHarness.ts app/test/twilioSmsWebhook.test.ts app/test/extractionRepo.test.ts app/test/extractionRepo.integration.test.ts` exited 0.
- `git diff --check` exited 0 before commit.

## Commit and files

- `66db467d test: cover classification fence legacy guards`
- `app/test/helpers/twilioWebhookHarness.ts`
- `app/test/twilioSmsWebhook.test.ts`
- `app/test/extractionRepo.integration.test.ts`
- `app/test/extractionRepo.test.ts`

## Risks and scope

- The production transaction implementation was already correct; this wave adds
  executable coverage for its legacy and unexplained-cancellation branches.
- No runtime schema, parser, prompt, generic replacement policy, seed/import,
  dependency, or infrastructure code changed.
