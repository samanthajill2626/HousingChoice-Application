# Retry send window build - Slice 3a report (Tasks 7-9)

Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, base `f4613e8e`.

## Commits

- `5345c9a1` feat(send): previewSendRefusal - a pure preview of the one-to-one send wrapper's refusals, with a parity test (retry-send-window D3a) - Task 7.
- `a9484249` feat(send): the send wrapper records automated, the recipient and the retry lineage at append (retry-send-window D6, D14) - Task 8.
- `e7797c88` feat(retry): one-to-one retry backoff lane seam and an explicit-runAt enqueue (retry-send-window D13, D7) - Task 9.

## Task 7

- Red: `cd app; npx vitest run test/sendRefusalPreview.test.ts test/sendMessage.test.ts` - 2 files failed to load (`Cannot find module '../src/services/sendRefusalPreview.js'`), no test ran - the plan's predicted reason.
- Green: `cd app; npx vitest run test/sendRefusalPreview.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts` - 3 files, 109 passed, 0 failed (`sendRefusalPreview` 26 = 24 table rows + 2; `sendMessage` 60 = 36 existing + 24 parity rows; `scheduledSendSuppression` 23 unchanged).
- `npm run typecheck`: exit 0 (the parity test's compile-time half included).

## Task 8

- Red: `cd app; npx vitest run test/sendMessage.test.ts` - 4 failed (the four new cases: the append carried no `automated`, no `recipientContactId`, no `retryAttempt` / `retryWindowStart`; the manual-Retry-shape case failed on the missing `automated`), 60 passed (64).
- Green: `cd app; npx vitest run test/sendMessage.test.ts test/twilioStatusWebhook.test.ts test/broadcastFanOut.test.ts test/broadcastApi.test.ts test/missedCallAutoText.test.ts test/tourReminders.test.ts test/placementNudges.test.ts test/twilioWebhookHarnessRetryFields.test.ts` - 8 files, 426 passed, 0 failed (`sendMessage` 64, `twilioStatusWebhook` 52, `broadcastFanOut` 37, `broadcastApi` 67, `missedCallAutoText` 18, `tourReminders` 143, `placementNudges` 39, `twilioWebhookHarnessRetryFields` 6). No suite pinned an exact appended-row shape.
- `npm run typecheck`: exit 0.

## Task 9

- Red: `cd app; npx vitest run test/retrySendBackoff.test.ts` - 11 failed of 11, each for the plan's predicted reason: the nine seam cases `TypeError: (0 , resolveSendRetryBackoffMs) is not a function`; the explicit-runAt case `expected 240 to be 37`; the webhook case `expected 60 to be 10`.
- Green: `cd app; npx vitest run test/retrySendBackoff.test.ts test/twilioStatusWebhook.test.ts` - 2 files, 63 passed (11 + 52), 0 failed. Confirmed by name (`--reporter=verbose`): '30003 (transient) enqueues EXACTLY ONE backed-off retry job through jobs.enqueue()' (still 60s) and 'END TO END: a 30003 callback schedules a job whose handler re-sends via the service (automated) and records retry lineage'.
- Conformance (Step 6): `node --check scripts/e2e-session.mjs` exit 0; `git grep -n --untracked "E2E_SEND_RETRY_BACKOFF_MS" -- ':!docs'` lists only `app/src/jobs/retrySend.ts`, `app/test/retrySendBackoff.test.ts`, `scripts/e2e-session.mjs`; `git grep -n --untracked "E2E_SEND_RETRY_BACKOFF_MS" -- '*.env*' 'infra'` prints nothing.
- `npm run typecheck`: exit 0.

No `[dynamoAdmin]` line in any run.

## Deviations from the plan

- None in code. Every plan block landed byte-exact: the three new Task 7 files and the new Task 9 test file were extracted from the plan by line range; every Edit block (Task 7 imports, Task 8 3a-3e, Task 9 Steps 3-5) and both appended describes were matched against the plan text by extraction afterwards (exactly one hit each).
- Anchors: the quoted old text matched the live file exactly once in every case. Shifted numbers only in `app/src/routes/webhooks/twilio.ts` (after Task 4): the `retrySend.js` import was at :120-123 (plan :119-122) and the call site at :3525-3529 (plan :3364-3368). Every other anchor sat on the plan's number (`sendMessage.ts` :207-212, :235-241, :249-252, :287, :450-451; `sendMessage.test.ts` :33-35 and end :922; `retrySend.ts` :72-77; `e2e-session.mjs` :272-273).
- Non-ASCII: Task 8's three replaced ranges in `app/src/services/sendMessage.ts` removed three pre-existing U+2014 dashes (old lines 208, 238, 450), as the plan intends (file non-ASCII bytes 162 -> 153). The old ranges were matched whole by the edit tool, so no retained text was retyped. 0 non-ASCII bytes in the four new files and in every added line; no other removed line carried non-ASCII.
- Commit trailers name `Claude Opus 5.5`, the session's attribution (the plan's text is the placeholder).

## Contract shipped for downstream slices

- `app/src/services/sendRefusalPreview.ts` (pure; imports `hasSmsConsent`, `isDeleted`, `ContactItem`, `ConversationItem`, and `isKillSwitchOff` / `isManualMode` / `isOptedOut` from `./scheduledSendSuppression.js`):
  - `export type SendRefusalCode = 'sms_sending_disabled' | 'contact_opted_out' | 'contact_deleted' | 'contact_no_consent' | 'manual_mode';`
  - `export function previewSendRefusal(args: { smsSendingEnabled: boolean | undefined; conversation: Pick<ConversationItem, 'sms_opt_out' | 'ai_mode'>; phoneContact: ContactItem | undefined; recipient: ContactItem | undefined; automated: boolean }): SendRefusalCode | undefined` - order: kill switch (explicit false only) -> opt-out (conversation flag, phone-matched contact's flag, OR `recipient.sms_opt_out === true`) -> deleted (`recipient ?? phoneContact`) -> JIT consent (person's send only, `recipient ?? phoneContact`, no contact = no gate) -> manual mode (automated only). No channel guards, no breaker, no `conversation_not_found`. Every code is assignable to `SendRefusedError['code']` (pinned at compile time by the parity test).
- Test-only, `app/test/helpers/sendRefusalCases.ts`: `export interface SendRefusalCase { name; smsSendingEnabled: boolean; conversation: { sms_opt_out?: boolean; ai_mode: ConversationMode }; phoneContact: ContactItem | undefined; recipient: ContactItem | undefined; automated: boolean; expected: SendRefusalCode | undefined }`, `export const LIVE_CONTACT: ContactItem` (`c-live`, `+15550100001`, `consent_method: 'inbound_text'`), `export const SEND_REFUSAL_CASES: readonly SendRefusalCase[]` (24 rows; every code plus the sent outcome). Task 10's decision test can run the same rows.
- `app/src/services/sendMessage.ts`, `SendMessageInput` gains `retryAttempt?: number` and `retryWindowStart?: string` (`retryOf?: string` and `recipient?: ContactItem` pre-existing; their docs and `automated`'s now say what D6/D14 make true). The destructure reads both. The append (`messages.append`) now passes, after `broadcastId`:
  - `retryOf`, `retryAttempt`, `retryWindowStart` - each only when `!== undefined` (the repo writes `retry_of`, `retry_attempt`, `retry_window_start`);
  - `automated` - ALWAYS, the input's default `false` included (written as `automated`);
  - `recipientContactId: recipient.contactId` - only when a `recipient` was passed (written as `recipient_contact_id`).
  No caller changed. Mid-build state until Task 11: the retry job (`app/src/jobs/retrySend.ts`) still passes `automated: true` and no lineage inputs, then annotates `retryOf` / `retryAttempt` after the send, so an automatic retry row is appended with `automated: true` and no `retry_window_start` exactly as before.
- `app/src/jobs/retrySend.ts`:
  - module-private `const SEND_RETRY_BACKOFF_ENV_KEY = 'E2E_SEND_RETRY_BACKOFF_MS';`
  - `export function resolveSendRetryBackoffMs(attempt: number): number` - when `process.env['JOBS_QUEUE_URL']` is not a non-empty string (unset or empty), returns `Number.parseInt(process.env['E2E_SEND_RETRY_BACKOFF_MS'] ?? '', 10)` if that is an integer > 0 (the SAME value for every attempt); otherwise `retryBackoffMs(attempt)` (60/120/240s). The same two guards as the relay seam (`laneBackoffOverride`, `relayRetryLeg.ts`), same parse.
  - `export async function enqueueSendRetry(payload: RetrySendPayload, runAt: Date): Promise<void>` - `enqueue(RETRY_SEND_JOB, payload, { runAt })`; `payload.attempt` no longer picks the delay.
  - Anchors below the change moved +38 lines: `RetrySendJobDeps` :117, `registerRetrySendJobHandler` :131, the job's `automated: true` :243, the `annotateMessage` call :264 (Task 11 anchors on quoted text).
- `app/src/routes/webhooks/twilio.ts` as Task 9 left it (the state worklist O2 describes for Task 10):
  - import, :120-124 (three names; `lib/retrySendWindow.js` is imported separately at :149 as `import { parseRetryWindowOrigin, retryFitsSendWindow } from '../../lib/retrySendWindow.js';`, from Task 4):

    ```ts
    import {
      enqueueSendRetry,
      MAX_SEND_RETRY_ATTEMPTS,
      resolveSendRetryBackoffMs,
    } from '../../jobs/retrySend.js';
    ```

  - the one call site, inside `case '30003':` after the exhausted-retries `break;`, :3526-3536:

    ```ts
                // The retry runs one resolved backoff from now (the lane seam,
                // retry-send-window D13); the job is scheduled at exactly that instant.
                await enqueueSendRetry(
                  {
                    providerSid: MessageSid,
                    conversationId: message.conversationId,
                    attempt: priorAttempt + 1,
                  },
                  new Date(Date.now() + resolveSendRetryBackoffMs(priorAttempt + 1)),
                );
                break;
    ```

  Behavior unchanged: 60/120/240s in production, the lane value in the lane; no window check and no `retry_due_at` yet (Task 10).
- `scripts/e2e-session.mjs`, the lane `childEnv` (module-level, built once), :282, after `E2E_RELAY_RETRY_BACKOFF_MS: '10000',` and its new nine-line comment: `  E2E_SEND_RETRY_BACKOFF_MS: '10000',`. A lane must be booted FRESH to pick it up (`npm run e2e:restart` keeps the launcher's old `childEnv`; plan:30, worklist O7).
- New test `app/test/retrySendBackoff.test.ts` (11 cases) pins the seam: default, five malformed values, the override for every attempt, production topology ignores it, an empty queue URL counts as unset, `enqueueSendRetry` schedules at exactly its `runAt` (37s, not attempt 3's 240s), and the status webhook's 30003 arm schedules on the lane value (10s).
