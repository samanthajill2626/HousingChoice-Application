# Retry send window build - Slice 2 report (Tasks 3-6)

Branch `feat/retry-send-window`, worktree `W:\tmp\retry-send-window`, base `f6095e1e`.

## Commits

- `ff063dcd` feat(relay-retry): one gate evaluator for the retry job and the claim; the pool-number throw follows the gates (spec D3) - Task 3.
- `d0869276` feat(relay-retry): the claim decides at once - gate preview and send window (spec D2, D3, D5, D9) - Task 4.
- `03ed963c` feat(relay-retry): the retry job's send-window gate (spec D2, D4, D5, D9) - Task 5.
- `4ceeb3f4` feat(relay-retry): bound a retry rung's wait on the A2P meter by its send window (spec D4, D9) - Task 6.

## Task 3

- Red: `cd app; npx vitest run test/relayRetryGates.test.ts test/relayRetryLeg.test.ts` - 2 files failed: `relayRetryGates.test.ts` did not load (module not found); `relayRetryLeg.test.ts` 4 failed (the four new pool-less cases), 54 passed.
- Green: `cd app; npx vitest run test/relayRetryGates.test.ts test/relayRetryLeg.test.ts test/relayRetryClaim.webhook.test.ts` - 3 files, 104 passed, 0 failed.
- `npm run typecheck`: exit 0.

## Task 4

- Red: `cd app; npx vitest run test/relayRetryClaim.test.ts test/relayRetryClaim.webhook.test.ts` - 21 failed, 37 passed (58). Every new case failed except the open-rung duplicate pin; `relayRetryClaim.test.ts` passed at runtime.
- Green (Step 6): `cd app; npx vitest run test/relayRetryClaim.test.ts test/relayRetryClaim.webhook.test.ts test/twilioStatusWebhook.test.ts test/relayRetryLeg.test.ts test/relayRetryGates.test.ts` - 5 files, 183 passed, 0 failed.
- Step 6b: `cd app; npx vitest run test/relayRetryClaim.webhook.test.ts` - 1 file, 54 passed. The Step 6 set re-run with the pin: 5 files, 184 passed, 0 failed.
- `npm run typecheck`: exit 0.

## Task 5

- Red: `cd app; npx vitest run test/relayRetryLeg.test.ts` - 5 failed (window table row, versioned window shape, both D5 cases, transient past the window), 62 passed (67). The pins passed, the R2 pin included.
- Green: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayRetryClaim.webhook.test.ts test/relayRetryGates.test.ts` - 3 files, 136 passed, 0 failed.
- `npm run typecheck`: exit 0.

## Task 6

- Red: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayFanOut.test.ts` - 3 failed (both bounded-acquire cases, the in-window bound), 150 passed (153). The no-origin pin and the fan-out pin passed.
- Green: `cd app; npx vitest run test/relayRetryLeg.test.ts test/relayFanOut.test.ts test/relayRetryClaim.webhook.test.ts test/tokenBucket.test.ts` - 4 files, 221 passed, 0 failed.
- `npm run typecheck`: exit 0.

No `[dynamoAdmin]` line in any run.

## Deviations from the plan

- Worklist ruling R2 (planned addition). The plan's order stays: four gates -> no-pool-number throw -> window gate (step 4b) -> media ERROR. Step 4b's comment gains one paragraph saying the throw precedes the window gate on purpose (an open group with no pool number cannot send at all, and its throw after the execution marker strands the rung whatever the window says). One pin case added to `app/test/relayRetryLeg.test.ts`, after the opt-out-ahead-of-window pin: `retry-send-window D4 (pin): an OPEN group with NO pool number past the window still THROWS "has no pool number" - never retry_window_closed` (pool-less open group, `windowStart: minutesAgo(16)`; asserts the throw, the suppression read ran, nothing sent, slot still `queued` with no errorCode, no log line with `closeCode: 'retry_window_closed'` or `retryClaim: 'window_closed'`, no root emit). Green before and after step 4b, as a pin should be. Task 5's commit message carries one extra paragraph naming it.
- Otherwise none. Every plan New block was matched against the tree by extraction (exactly one hit each). `app/src/lib/tokenBucket.ts` untouched (the plan does not edit it). Commit trailers name `Claude Opus 5.5 (1M context)`, the session's attribution. ASCII: 0 non-ASCII bytes in both new files and in every added line; no removed line carried non-ASCII.

## Contract shipped for downstream slices

- `app/src/lib/relayRetryGates.ts`:
  - `export type RelayRetryGateCode = 'retry_group_closed' | 'retry_member_removed' | 'retry_number_changed' | 'retry_opted_out';`
  - `export type RelayRetryGateResult = { refused: false; conversation: ConversationItem; member: ConversationParticipant } | { refused: true; code: RelayRetryGateCode };`
  - `export async function evaluateRelayRetryGates(args: { conversation: ConversationItem | undefined; memberKey: string; rootTsMsgId: string; destDigest: string; isSuppressed: (member: ConversationParticipant) => Promise<boolean> }): Promise<RelayRetryGateResult>` - order: group open (`status === 'open'`; absent = closed) -> roster match by `relayMemberKey` -> digest of the normalized current number -> `isSuppressed`; first refusal wins; its only read is `isSuppressed`, whose rejection propagates.
- `app/src/jobs/relayRetryLeg.ts`: `export type RelayRetryCloseCode = RelayRetryGateCode | 'enqueue_failed' | 'transient_cap' | 'retry_window_closed';`
- `app/src/lib/relayRetryClaim.ts`: `RelayRetryClaimOutcome` (14): `claimed`, `already_claimed`, `cap_exhausted`, `gate_refused`, `fenced_announcement`, `to_missing`, `to_malformed`, `source_unreadable`, `slot_ineligible`, `slot_settled`, `code_not_retryable`, `enqueue_failed`, `window_closed`, `claim_failed`.
- `app/src/routes/webhooks/twilio.ts` (module-private): `RelayRetryClaimResult.closeCode?: RelayRetryGateCode | 'retry_window_closed'`, set on `gate_refused` and `window_closed` only. A declined rung is appended closed in the claim's one append, never enqueued: legacy slot `{ status: 'failed', errorCode }`, versioned `{ status: 'failed', requestedTransport?, transportAggregationState: 'excluded', errorCode }`, row `delivery_status: 'queued'`. Every rung carries `relay_retry_window_start` (ISO) when the origin parses (rung 1 = root member slot `sentAt`; rungs 2-3 copy the previous rung row's value). `isTerminalRelayLegFailure`'s WARN set now also holds `gate_refused`.
- `app/src/jobs/relayFanOut.ts`: `sendOneRelayLeg(args: { ...; suppressionChecked?: boolean; sendDeadlineMs?: number })` (epoch ms). `RelayLegSendOutcome = { kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'transient' | 'deadline_exceeded'; providerSid?: string; errorCode?: string }`. `deadline_exceeded` carries neither field; it is returned only when a bucket is given and `sendDeadlineMs` is set and `acquire(1, { timeoutMs: Math.max(0, sendDeadlineMs - Date.now()) })` throws `TokenBucketBusyError` - after the terminal-slot skip and the suppression check, before the presign, the `attempted` write and the provider call; any other acquire error rethrows. Without `sendDeadlineMs` the acquire is `acquire(1)` as before.
- Log lines:
  - Claim (`twilio.ts`), the failure marker `event: 'delivery_failed'`, `relay: true`, `retryClaim`, `retryAttempt`, `closeCode`, message `twilio relay-recipient delivery failed (undelivered/failed)`: `retryClaim: 'gate_refused'` at WARN (`closeCode` = the gate code); `retryClaim: 'window_closed'` at ERROR (`closeCode: 'retry_window_closed'`). D5 gap: WARN, no `event`, `{ windowOrigin: 'missing' | 'unparseable', originField: 'sentAt' | 'relay_retry_window_start', attempt, retryTsMsgId, rootTsMsgId, memberKey }`, once per rung this claim created.
  - Job (`relayRetryLeg.ts`), `event: 'relay_retry_leg'`, `relay: true`: gate refusal WARN `{ retryClaim: 'gate_refused', closeCode: <gate code> }` (+ `status` on `retry_group_closed`). `retry_window_closed` closes, all ERROR `{ retryClaim: 'window_closed', closeCode: 'retry_window_closed', windowCheck }`: `windowCheck: 'gate'` (step 4b, `refuseGate`), `'send_deadline'` (`deadline_exceeded`, `refuseGate`), `'transient_reschedule'` (+ `errorCode`, `transientPass`; `closeTerminally`). Each close announces the root once. D5 gap: WARN `{ windowOrigin: 'missing' | 'unparseable' }`. Unchanged: the send-time `refused`/`suppressed` fall-through still logs `retryClaim: 'gate_refused'` at ERROR with `legOutcome`.
- Mid-build state left as the plan says: a rung closed `retry_window_closed` renders through the dashboard's relay join as an unmapped code until Tasks 15-16.
