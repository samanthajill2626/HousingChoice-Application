# Slice 3 - authenticated relay caller display hydration

## Scope delivered

- Added `deleted_at` to the narrow shared `ContactDisplayItem` projection only.
- Added best-effort, page-local, ID-only caller-display hydration to the authenticated messages endpoint.
- Kept `GET /api/calls/:callId` a raw authenticated call response and corrected its privacy comment.
- Kept the strict fake display projection aligned with production.

## TDD evidence

The focused red command exited 1 with the expected missing deletion projection and
missing hydration failures:

```text
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/conversationHubApi.test.ts
3 failed, 40 passed
```

## Verification

```text
npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/conversationHubApi.test.ts
43 passed, 2 files passed, exit 0

npm run test -w @housingchoice/app -- test/contactsRepo.integration.test.ts test/conversationHubApi.test.ts test/voiceWebhook.test.ts test/repos.test.ts
103 passed, 4 files passed, exit 0

npm run typecheck -w @housingchoice/app
exit 0
```

The focused integration test ran against DynamoDB Local; no suite was skipped.

## Constraints checked

- Calls `contacts.getDisplaysByIds` once only when the current page has non-empty IDs.
- Does not phone-match on read or mutate repository-owned message rows.
- Ignores missing and soft-deleted display records; restored records hydrate again.
- Batch-read rejection logs only `conversationId` and request count, then returns an unhydrated HTTP 200 page.
