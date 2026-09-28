# S1 report - retry-send adoption, plan Task 1 (foundations, no behavior change)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`845f44cc`. Scope: plan Task 1 Steps 1-9 plus build worklist items 1-3.
Status: DONE. Line numbers below are at `baf315cf` (the last code commit).

## Commits

| hash | subject |
|---|---|
| `5880d09c` | feat(retry): the leaf retry constants, the one-to-one sender pin, the retry media plan and the carried deferred flag (retry-send-adoption T1, steps 1 and 7) |
| `c706e6ff` | feat(messages): retry_root and retry_outcome on the row, the retrychild# pointer family, the conditional annotateRetryPromise; the fakes and their parity (retry-send-adoption T1, steps 2-4 and 8) |
| `baf315cf` | feat(retry): the chain helpers and the two promise writes (retry-send-adoption T1, steps 5 and 6) |
| (this file) | docs commit, recorded by its own hash in git log |

Each code commit left typecheck, the listed suites and gate 5 green. TDD was
followed per step: every new or extended test was run RED first (missing
module / missing method / missing field), then implemented to green.

## What was built, per plan step

**Step 1 - leaf constants and the sender pin.**
- `app/src/lib/retrySendWindow.ts:35` `MAX_SEND_RETRY_ATTEMPTS` (moved here),
  `:37` `RETRY_OUTCOME_UNCONFIRMED`, `:38` `RetryOutcome`. The module stays
  import-free (the dashboard's `retryPromiseMirror.test.ts` imports it).
- `app/src/jobs/retrySend.ts:35` imports the constant from the leaf (the
  parser at `:91-92` reads it); `:55` `export { MAX_SEND_RETRY_ATTEMPTS };`
  keeps every importer resolving through the job (the fenced
  `oneToOneRetryDecision.ts:43`, `oneToOneRetryDecision.test.ts:6`,
  `twilioStatusWebhook.test.ts:20`). `npm run smoke` proves the compiled
  re-export resolves under plain Node.
- `app/src/lib/outboundSender.ts:7` `pinnedSender` (new, import-free);
  `app/src/services/sendMessage.ts:601` reads it (import at `:35`).

**Step 2 - failing repo tests (DynamoDB Local).**
`app/test/messagesRepoRetryLineage.integration.test.ts:289` - a nested
`describe('one-to-one retry lineage (retry-send-adoption)')` with the plan's
file-local `appendOutbound` helper, over the file's real `messages` repo and
`doc` client. Eight cases (the plan's five plus three, see Deviations).

**Step 3 - the repo** (`app/src/repos/messagesRepo.ts`).
- `:44` `import type { RetryOutcome }` from the leaf (type-only, no cycle).
- `:760` `NewMessage.retryRoot` (beside `retryWindowStart`, which is at
  `:751` now; the plan's `:754` was already stale, worklist item 2).
- `:1057` `MessageItem.retry_root`; `:1077` `MessageItem.retry_outcome`
  (beside `retry_due_at`).
- `:2619` `append`'s item writes `retry_root` beside `retry_of`.
- `:2785-2799` the `retrychild#` Put in `append`'s TransactItems, UNCONDITIONED,
  placed after the email pointer and the due row (`:2761`) and before the
  media pointers (`:2800`). Verified order: [0] row, [1] `sid#`, [2]
  `emailmsgid#` (optional), due row (optional), `retrychild#` (optional),
  media pointers - index 1 and 2 are unchanged, so the dedupe attribution
  reads them by position as before.
- `:2102` `RETRY_CHILD_PARTITION_PREFIX`, `:2105` `retryChildPk`, `:2110`
  `RetryChildPointer`, beside the other pointer key helpers.
- Interface: `:1544` `listRetryChildrenConsistent`, `:1554`
  `annotateRetryPromise`. Object: `:3359` `listRetryChildrenConsistent` (one
  consistent Query on the partition, paged on LastEvaluatedKey like
  `sendAttemptsRepo.listByRecipient`), `:3388` `annotateRetryPromise` (the
  plan's four per-branch expression shapes, each listing exactly its aliases;
  `ConditionalCheckFailedException` -> false; INFO `retry promise annotated`).
- `MessageAnnotations` and `annotateMessage` are untouched (verified: no
  +/- line in the branch diff names either).

**Step 4 - the fakes and their pins.**
- `app/test/helpers/twilioWebhookHarness.ts:254` `FakeWorld.retryChildren`
  (built `:517`, returned `:4667`); fake `append` allowlist carries
  `retry_root` (`:1258`) and writes the pointer after the dedupe check and the
  row push (`:1327`), a map written by append only; fake
  `listRetryChildrenConsistent` (`:1504`) answers sorted by `utf8Order`
  (`:4461`, the attempts twin's comparator - worklist item 1) as copies; fake
  `annotateRetryPromise` (`:1513`) mirrors the real condition.
- `app/test/twilioWebhookHarnessRetryFields.test.ts:145` - seven new pins.
- `app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`:
  `MsgCtx.retryParents`; step helpers `appendOneToOne` (`:262`), `children`
  (`:293`), `promise` (`:303`); the new `MSG_CASES` script (`:572`, 14 steps);
  `retryState` (`:856`) and the pointer comparison (`:894`) inside
  `messagesAgree`.

**Step 5 - `app/src/services/retryChain.ts`** (new): `:18` `LineageReader`,
`:23` `resolveRetryRoot`, `:36` `automaticAncestry`, `:48`
`retryRecipientKey`, `:58` `ConversationRetryDecline`, `:61`
`conversationRetryDecline` - the plan's bodies, with the worklist-2 type
imports. Tests: `app/test/retryChain.test.ts` (22 cases) over
`createFakeWorld()` with real lineage appended through the fake.

**Step 6 - `app/src/services/retryPromiseWrites.ts`** (new): `:28`
`RetryPromiseDeps`, `:44` `refreshRetryPromise`, `:76` `withdrawRetryPromise`
- the plan's bodies; the failure-arm ERROR line is guardWrite's exact message.
Tests: `app/test/retryPromiseWrites.test.ts` (11 cases) over the fake world
and `createLogCapture`.

**Step 7 - `planRetryMedia` and `deferred`** (`app/src/jobs/retrySend.ts`):
`:19` `type MessageItem` import (worklist item 2); `:154` `RetryMediaPlan`;
`:162` `planRetryMedia` (the job's media rule as built; the job's own
`:301-345` media code is untouched - T4 swaps it); `:74`
`RetrySendPayload.deferred?: true`; `:98` the parser carries `true` only.
Tests: `app/test/retrySendMedia.test.ts` (7 cases);
`app/test/twilioStatusWebhook.test.ts:1233` (the parse case). The
`retrySendBackoff.test.ts:105` exact-payload pin stays green.

**Step 8 - `sendMessage` passes `retryRoot`** (`app/src/services/sendMessage.ts`):
`:370` `SendMessageInput.retryRoot`, `:458` destructured, `:680` on the append
input beside `retryWindowStart`. Test: `app/test/sendMessage.test.ts:1100`
(extended both halves). The full-literal fakes gain stubs:
`app/test/sendMessage.test.ts:286-287`,
`app/test/scheduledSendSuppression.test.ts:301-302`.

**Worklist item 3 - the doc comments.** Reworded in ASCII:
`sendMessage.ts:329-339` (the `broadcastId` input doc; its U+2014 and arrows
removed), `messagesRepo.ts:722-729` (`NewMessage.broadcastId`) and
`:1151-1158` (`MessageItem.broadcast_id`). The fenced
`twilio.ts:3520-3528` comment is NOT edited - the handback must name it.

## Deviations from the plan / worklist (all deliberate)

1. Fake `listRetryChildrenConsistent` sorts by `utf8Order` instead of
   returning "a copy of the map entry" - worklist item 1 (it wins over the plan).
2. `messagesAgree` compares each parent's children AS ANSWERED (no re-sort),
   which is stricter than the plan's "sorted by tsMsgId" and is what forces
   the fake to hold the real Query's order; it also compares `retry_of` and
   `retry_attempt` beside the plan's three fields. A mutation check (the fake's
   sort removed) turned both the fake pin and the parity case red; restored.
3. Extra integration cases beyond the plan's five: the pointer rides the
   transaction (a retry append cancelled by a colliding due row writes neither
   the row nor the pointer), sort-key order vs append order, the fourth
   expression shape (a WITHDRAW with no promise expected, plus a stale
   withdraw that writes neither field), and the raw pointer item's exact
   shape. The dedupe case re-appends under a DIFFERENT providerTs so a
   pointer written outside the cancelled transaction would be visible; the
   "no retryOf writes none" half is proven with a table Scan for pointers
   naming the root.
4. Extra fake pins: answers are copies; a row pushed straight into
   `world.messages` has no pointer; `retry_outcome` is never stored by
   `append` even when a caller smuggles one in. The fake's same-key pointer
   Put replaces its entry (the real Put's semantics; unreachable in practice).
5. `pinnedSender` got a unit test (`sendMessage.test.ts:925`); the plan listed
   none. `retrySendMedia.test.ts` also pins that `jobs/retrySend.ts`
   re-exports the SAME value the leaf owns, plus two more shapes (legacy
   `media_s3_keys`, an empty raw `mediaUrls` list carried as stored).
6. Extra `retryPromiseWrites` cases: the sentinel ALONE (RSW's enqueue-failure
   withdrawal) is not 'already' - the WITHDRAW adds the outcome (pins "keys on
   retry_outcome, never the sentinel alone"); a throwing re-read -> 'failed'.
7. `SendMessageInput.retryRoot`'s doc says the automatic retry and the manual
   route pass it and the reconcile's adoption appends it through
   `messagesRepo.append` directly - the plan's text ("the adoption ... pass
   it") is wrong for this input, since R4's adoption never calls sendMessage.
8. A FOURTH `broadcast_id` comment reworded: `sendMessage.ts:667-670` (the
   append stamp, "absent on 1:1 / relay sends", with a U+2014) - the same
   contradiction as worklist item 3's three.
9. Doc additions not in the plan: `MessageItem.retry_due_at`
   (`messagesRepo.ts:1066-1067`) now says the job and the reconcile move it
   only through `annotateRetryPromise`; the parity file's header lists the new
   state it compares.
10. The sendMessage case at `:1100` is renamed to name `retryRoot`
    ("passes retryOf, retryAttempt, retryWindowStart and retryRoot into the
    append, ...").
11. `listRetryChildrenConsistent` sets no `Limit` (one page in practice; the
    loop still pages) - the plan did not name one; `listByRecipient` uses 100.
12. The fake's fourth parameter is named `expected` (the real one keeps the
    plan's `expect`).
13. Kept verbatim from the plan, a forward reference: the
    `RETRY_OUTCOME_UNCONFIRMED` doc (`retrySendWindow.ts:36`) names the
    dashboard hand copy and its `retryPromiseMirror.test.ts` pin, which land
    in Task 6.

## Verification (all commands bare, from the worktree)

- Baseline before any edit, the 8 pre-existing files of the list: 263 passed.
- `cd app; npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/twilioWebhookHarnessRetryFields.test.ts test/twilioWebhookHarnessRepoAdditions.integration.test.ts test/retryChain.test.ts test/retryPromiseWrites.test.ts test/retrySendMedia.test.ts test/retrySendWindow.test.ts test/retrySendBackoff.test.ts test/twilioStatusWebhook.test.ts test/sendMessage.test.ts test/scheduledSendSuppression.test.ts`
  -> 11 files, 321 passed, 0 skipped (DynamoDB Local reached): lineage 17,
  sendMessage 84, retryPromiseWrites 11, retrySendBackoff 11,
  twilioStatusWebhook 80, scheduledSendSuppression 23, retrySendWindow 35,
  retrySendMedia 7, RetryFields 13, RepoAdditions 18, retryChain 22.
- Neighbour regression run after the repo commit (not required):
  `messaging.integration`, `contactTimeline`, `apiRoutes`, `sendReconcile`,
  `broadcastFanOut`, `relayRetryLeg`, `relayFanOut`, `oneToOneRetryDecision`
  -> 8 files, 694 passed.
- `npm run typecheck` -> exit 0 (after each code commit).
- Gate 5: `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  -> 18 files, exit 0, no output. No pre-existing errors in these files.
- `npm run smoke` -> OK (1491 specifiers across 264 emitted files).
- ASCII: every new file prints 0; the branch's added lines under `app/` print
  0 non-ASCII bytes.
- Fences: no diff in `twilio.ts`, `jobs.ts`, `sqsJobConsumer.ts`,
  `oneToOneRetryDecision.ts`; no +/- line names `putJobExecutionMarker`,
  `annotateMessage` or `MessageAnnotations`.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e session.

## For the next slice (Task 2, the reconcile's `retry_send` owner)

- Import `MAX_SEND_RETRY_ATTEMPTS` from `../lib/retrySendWindow.js`, never
  from `./retrySend.js` (worklist item 6); `retryRecipientKey` and
  `automaticAncestry` from `../services/retryChain.js`; `refreshRetryPromise`
  and `withdrawRetryPromise` from `../services/retryPromiseWrites.js`.
- `RetryPromiseDeps` is `{ messages, events, log }`; the reconcile's full
  `MessagesRepo`, bus and logger satisfy it. Pass the retried row AS READ by
  `resolve` (consistent): its `retry_due_at` is the WITHDRAW's first
  condition value (reader B trap 7). `withdrawRetryPromise` never throws and
  answers 'written' | 'already' | 'lost' | 'failed'; 'already' (the
  superseded exit's re-apply) writes and emits nothing. A written promise
  already emits `message.persisted` for the retried row.
- `automaticAncestry(messages, retriedRow)` returns the walked AUTOMATIC rows
  with the retried row FIRST when it is automatic, `[]` for a root or a
  manual row. The T3 predecessor match is `(record.retriedTsMsgId,
  record.attempt) === (walked.retry_of, walked.retry_attempt)`.
- The adoption appends through `messagesRepo.append` with `retryOf`,
  `retryAttempt`, `retryWindowStart`, `retryRoot`, `broadcastId`: the
  `retrychild#` pointer is then written by the same transaction - nothing to
  add. A dedupe cancels it with the row.
- `parseRetrySendPayload` keeps only `providerSid`, `conversationId`,
  `attempt` and a `true` `deferred`; a re-drive payload must be BUILT from the
  retried row (reader B trap 3) and must not carry `deferred`.
- Harness: the fake reads return the LIVE stored row (worklist item 11); a
  lost-condition case needs a copy or a spy. `world.retryChildren` is written
  by the fake `append` only, so seed children through `append`.
- Pre-deploy retry rows have no `retrychild#` pointer and no `retry_root`
  (no backfill); `resolveRetryRoot` walks `retry_of` for the latter.
- Owed elsewhere (not T1): R7's "send-attempt-sweeper records the family
  beside the others" is an issue note (Task 9); the fenced `twilio.ts`
  broadcast comment is a handback line.
