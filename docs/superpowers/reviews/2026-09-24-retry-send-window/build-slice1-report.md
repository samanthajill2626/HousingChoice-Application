# Retry send window build - Slice 1 report (Tasks 1-2)

Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, base `21699632`.

## Commits

- `7eb2a13b` feat(retry-window): send-window constants and pure helpers (spec D1-D5, D10) - Task 1.
- `4809b5c2` feat(messages): retry lineage, window origin, send flags and retry_due_at on the message row (retry-send-window D2, D6, D7, D14) - Task 2.

## Task 1

- Red: `cd app; npx vitest run test/retrySendWindow.test.ts` - 1 suite failed (module not found), no test ran.
- Green: same command - 1 file, 27 passed, 0 failed.
- `npm run typecheck` (worktree root): exit 0.

## Task 2

- Red: `cd app; npx vitest run test/twilioWebhookHarnessRetryFields.test.ts test/messaging.integration.test.ts test/messagesRepoRetryLineage.integration.test.ts` - 11 failed, 28 passed (39). The two REGRESSING pins (harness and integration) passed, as the plan predicts.
- Green: `cd app; npx vitest run test/twilioWebhookHarnessRetryFields.test.ts test/messaging.integration.test.ts test/messagesRepoRetryLineage.integration.test.ts test/twilioWebhookHarnessMediaIndex.test.ts test/emailEvents.test.ts test/groupReceipts.test.ts test/sendEmailMessage.test.ts test/relayQueuedMessages.test.ts test/messagesRepo.email.test.ts test/twilioStatusWebhook.test.ts` - 10 files, 196 passed, 0 failed, 0 skipped; no `[dynamoAdmin]` line in any run.
- `npm run typecheck` (worktree root): exit 0 (every other `updateDeliveryStatus` caller and every `MessagesRepo` double compiles unchanged, F7 included).

## Deviations from the plan

- None in code. Every plan block landed byte-exact: both Task 1 files diff clean against the plan; all 17 Task 2 edit blocks and the two test insertions were matched against the plan text by extraction (one hit each; every replaced old string gone).
- Task 1 Step 0 skipped (the orchestrator had already run `npm ci` and `npm run db:start`).
- Commit trailers name `Claude Opus 5.5 (1M context)`, the session's attribution (the plan's text is the placeholder).
- ASCII: 0 non-ASCII bytes in both new files and in every added line. The 4h selection in `messagesRepo.ts` removed the one pre-existing U+2014 inside the replaced comment range, as intended (file non-ASCII bytes 194 -> 191); nothing else non-ASCII was touched. Only `messaging.integration.test.ts` of the two integration files carries older non-ASCII (the plan's Step 7 says both; the added-lines check covers either way).

## Contract shipped for downstream slices

- `app/src/lib/retrySendWindow.ts` (no imports): `RETRY_SEND_WINDOW_MS` = 900000, `RETRY_JOB_GRACE_MS` = 60000, `RETRY_PROMISE_GRACE_MS` = 120000, `RETRY_PROMISE_WITHDRAWN_AT` = `'1970-01-01T00:00:00.000Z'`; `parseRetryWindowOrigin(value: unknown): number | undefined` (non-string or unparseable -> undefined); `retryFitsSendWindow({ originMs, nowMs, backoffMs }): boolean` (now + backoff + job grace <= origin + window); `withinRetrySendWindow({ originMs, nowMs }): boolean` (now <= origin + window); `retrySendDeadlineMs(originMs): number` (origin + window); `isRetryPromiseLive(retryDueAt: string | undefined, nowMs: number): boolean` (now < due + promise grace; false when undefined or unparseable).
- `NewMessage` gains (all optional): `retryAttempt?: number`, `retryWindowStart?: string`, `automated?: boolean`, `recipientContactId?: string`, `relayRetryWindowStart?: string` (`retryOf?: string` pre-existing; its doc now says lineage is stamped at append). The real `append` writes them as `retry_attempt`, `retry_window_start`, `automated`, `recipient_contact_id`, `relay_retry_window_start`, each only when `!== undefined` (so `automated: false` IS stored).
- `MessageItem` gains (all optional): `retry_window_start?: string`, `retry_due_at?: string`, `automated?: boolean`, `recipient_contact_id?: string`, `relay_retry_window_start?: string` (`retry_attempt?: number` pre-existing).
- `MessagesRepo.updateDeliveryStatus(sid: string, status: DeliveryStatus, errorCode?: string, options?: { retryDueAt?: string }): Promise<boolean>`. When `options.retryDueAt` is defined, `retry_due_at = :r` joins the SAME conditional `UpdateCommand` as `delivery_status` (and `error_code` when given), under the unchanged forward-only condition; unknown SID, a refused transition (redelivery or regression) or a transition into `queued` returns false and writes neither. The `delivery status updated` log carries `retryDueAt` only when set. Callers passing no options behave exactly as before.
- `MessageAnnotations` gains `retryDueAt?: string`; `annotateMessage` SETs `retry_due_at` from it (condition `attribute_exists(tsMsgId)` unchanged) and logs it on `message annotated`.
- Harness (`app/test/helpers/twilioWebhookHarness.ts`, `createFakeWorld().messagesRepo`):
  - fake `append` allowlist now keeps `retry_attempt`, `retry_window_start`, `automated` (false included) and `recipient_contact_id` (beside `retry_of`), and `relay_retry_window_start` (after `relay_retry_leg_body`), each only when defined;
  - fake `updateDeliveryStatus(sid, status, errorCode, options)`: unknown SID -> false; prior status not in `allowedPriorStatuses(status)` -> false with nothing written; otherwise sets `delivery_status`, `error_code` when defined and `retry_due_at` when `options.retryDueAt` is defined, then returns true (the transition rule mirrors the real repo's one conditional write);
  - fake `annotateMessage` writes `retry_due_at` when `annotations.retryDueAt` is defined (still throws on an unknown message).
- Pinned by `app/test/twilioWebhookHarnessRetryFields.test.ts` (fake, 6 cases) and the new cases in `app/test/messaging.integration.test.ts` (6) and `app/test/messagesRepoRetryLineage.integration.test.ts` (1) against DynamoDB Local.
