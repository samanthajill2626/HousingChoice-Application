# Plan draft B1 - findings (Tasks 2, 7, 8, 9)

Drafted 2026-09-25 against `feat/retry-send-window` @`fd38ba73` (spec draft 7,
skeleton `.superpowers/plan-drafts/skeleton.md`). Tasks are in
`.superpowers/plan-drafts/slice-B1.md`. Every code citation below was re-read at
that HEAD. Findings cite code by file:line and quote none of it.

## 1. Contract

- **No CONTRACT CHANGE.** Every name and type in the skeleton's Task 2, 7, 8 and
  9 contracts is used exactly as written: the five `NewMessage` fields and five
  `MessageItem` fields, `updateDeliveryStatus(sid, status, errorCode?, options?:
  { retryDueAt?: string })`, `MessageAnnotations.retryDueAt`, `SendRefusalCode`
  and `previewSendRefusal(args)`, `SendMessageInput.retryAttempt` /
  `retryWindowStart`, `resolveSendRetryBackoffMs(attempt)` and
  `enqueueSendRetry(payload, runAt)`.
- **One test-only interface beyond the contract, offered to B2:**
  `app/test/helpers/sendRefusalCases.ts` exports `SendRefusalCase`,
  `SEND_REFUSAL_CASES` (24 rows) and `LIVE_CONTACT`. It is the ONE table Task 7's
  unit test and parity test both run; Task 10's decision test can run the same
  rows to meet spec section 6 intention 4 ("one table drives both tests").
- **New test files beyond the skeleton's list** (app tests live under
  `app/test/`, not beside the source): `app/test/twilioWebhookHarnessRetryFields.test.ts`
  (Task 2, the harness-double pin, in the pattern of
  `app/test/twilioWebhookHarnessMediaIndex.test.ts`),
  `app/test/sendRefusalPreview.test.ts` and `app/test/helpers/sendRefusalCases.ts`
  (Task 7), `app/test/retrySendBackoff.test.ts` (Task 9, mirroring
  `app/test/relayRetryLeg.test.ts:1005-1151`).

## 2. Handoffs to other slices

- **B2 Task 10 - the fake's rows are LIVE objects (medium).** The harness
  `getByProviderSid` returns the stored object itself
  (`app/test/helpers/twilioWebhookHarness.ts:1077-1078`, `:1196-1198`), so once the
  fake `updateDeliveryStatus` sets `retry_due_at`, the `message` the webhook read
  at `app/src/routes/webhooks/twilio.ts:3151` shows it. The real repo's read is a
  pre-write snapshot (`app/src/repos/messagesRepo.ts:2541-2542`). An arm that
  re-reads `message.retry_due_at` after the write passes in the fake and sees
  `undefined` in production. Task 10 should enqueue with the decision's `runAt`
  and never read the stamp back from `message`. The harness already documents the
  same asymmetry for `updateCallStatus` (`twilioWebhookHarness.ts:1230-1235`).
- **B2 Task 10 - gate order differs from the send path (low).** `sendMessage`
  checks the kill switch (`app/src/services/sendMessage.ts:298`) BEFORE the channel
  guards (`:309-314`); the D3a contract order puts `group_text` / `relay_group` /
  no participant phone first and the preview (which starts with the kill switch)
  after. Both decline, only the reason differs (a `group_text` thread with the
  kill switch off). The parity table holds one-to-one threads only, so Task 10's
  own table test must add its channel rows itself.
- **B2 Task 10 - the call site Task 9 leaves.** Task 9 changes
  `twilio.ts:3364-3368` minimally to pass now plus
  `resolveSendRetryBackoffMs(priorAttempt + 1)` as the run time, and adds that
  function to the import at `:119-122`. Task 10 replaces the arm and passes the
  decision's `runAt` instead.
- **B2 Task 10 - the fixed-past fixture (spec D13).**
  `app/test/twilioStatusWebhook.test.ts:59` seeds `providerTs` at
  2026-06-12T10:00:00Z. Once Task 10's window check lands, every case that posts a
  30003 through `seedOutbound` becomes a window decline - the enqueue case at
  `:423-451`, the redelivery case at `:453-462` and the retrySend job cases from
  `:853` onward - unless that fixture moves to a realistic time. Task 9's own
  webhook-level test seeds `providerTs` = now and survives the window check.
- **B2 Task 11 - its D12 comments.** `app/src/jobs/retrySend.ts:9-10` and
  `:221-225` describe the annotate-after that Task 11 removes, so they are Task
  11's; Task 9 edits only `retrySend.ts:72-77` and leaves them.
- **B2 Task 11 - annotation fields go dead (info).** After Task 11,
  `MessageAnnotations.retryOf` / `retryAttempt` (`messagesRepo.ts:1175-1176`), their
  branches in `annotateMessage` (`:2912-2919`) and the harness copy
  (`twilioWebhookHarness.ts:1342-1343`) lose their only caller
  (`retrySend.ts:226-229`). Task 2 keeps them (the contract only adds
  `retryDueAt`); removal is optional cleanup for Task 11 or later. The backfill
  script annotates media only (`app/scripts/backfill-media-content-types.ts:603`).
- **Slice D Task 19 - which send the e2e exercises.** No seed writes retry fields
  (spec section 4), so a seeded outbound row has no `automated` and its 30003 is
  retried as automated (D14's pre-deploy default); a row sent from the composer
  during the spec records `automated: false` and is retried as a person's send.
  Both work on `conv-0001` (auto), but the spec should say which it proves. If
  Task 19 sets a short `E2E_RETRY_SEND_WINDOW_MS`, D13's floor with Task 9's lane
  value is 10 s plus `RETRY_JOB_GRACE_MS` (60 s), with margin.

## 3. Sequencing

- **D12 corrections are forward-looking until Task 11 (low).** Task 2 rewrites
  `messagesRepo.ts:725-731` and `:2262-2265`, and Task 8 rewrites
  `sendMessage.ts:235-241`, to say the automatic 30003 retry passes `retryOf`,
  `retryAttempt` and `retryWindowStart` at append. Until Task 11 changes
  `retrySend.ts:200-229`, the job still annotates after the send, so for the
  commits between Task 8 and Task 11 those comments describe the branch's end
  state rather than its current one. Accepted inside one branch; if Task 11 were
  dropped, the comments would be wrong in the other direction.

## 4. Spec wording

- **"a soft-deleted recipient" (D3a step 2) is narrower than the gate it
  names.** The send path's deleted gate judges the recipient when one was named,
  else the phone-matched contact (`sendMessage.ts:322`, `:348`). The preview
  mirrors the gate - parity requires it - so a deleted phone-matched contact with
  no recorded recipient also declines. Consistent with "judged as D14 will send
  it"; just broader than the literal words.
- **"share one set of predicates, so they cannot drift" (D3a step 2).** The
  preview reuses the predicates the wrapper calls (`scheduledSendSuppression.ts:30-38`,
  `contactsRepo.ts:309-311`, `smsCompliance.ts:101-103`), but `sendMessage` keeps its
  inline gate chain (logging, typed errors, the breaker increment in between).
  Refactoring `sendMessage` to call the preview was not taken: its kill switch
  must stay ahead of the channel guards and the contact read (`sendMessage.ts:298-319`),
  and send-outcome-reconcile plans edits on that path (spec section 5). The
  parity test is the drift guard.

## 5. Risks

- **Every wrapper-appended row now carries `automated`** (and, from a share,
  `recipient_contact_id`). A sweep found no test that pins an exact appended row
  (`app/test/sendMessage.test.ts` asserts with `toMatchObject`; the exact-equality
  checks in `app/test/groupSend.test.ts:746` and neighbors pin empty arrays from a
  different service). Task 8's run step includes the harness-backed send suites to
  catch one.
- **The new fields reach the browser on the raw row.** `automated` and
  `recipient_contact_id` ride `GET /conversations/:id/messages`, which returns rows
  as-is (the note at `messagesRepo.ts:737-739`): a boolean and an internal contact
  id, no PII. The contact timeline projection is an allowlist
  (`app/src/routes/contactTimeline.ts:406-463`; among retry fields only `retry_of`,
  `:442`), and Task 13 adds only `retry_due_at`.
- **Lenient parse, inherited.** The lane seam uses `Number.parseInt`, so `10s`
  reads as 10 ms and `1e4` as 1 ms; the relay seam does the same
  (`app/src/jobs/relayRetryLeg.ts:193`). Lane-only behind `JOBS_QUEUE_URL`;
  mirrored on purpose so both seams behave alike.
- **Duplicated guard.** `resolveSendRetryBackoffMs` repeats the relay's topology
  guard (`relayRetryLeg.ts:190-196`) rather than sharing a helper; extracting one
  would widen this branch's footprint in `relayRetryLeg.ts`, which
  send-outcome-reconcile also edits (spec section 5).
- **The lane value is not pinned by a unit test.** No test reads the lane
  `childEnv` (`scripts/e2e-session.mjs:254-274`); the relay value is unpinned too.
  Task 9 pins the seam's in-process reach (a webhook-level case) and adds a
  git-grep conformance step; that the lane value ARRIVES is proven only by Task
  19's timing.

## 6. Plan-format notes

- **ASCII plan vs non-ASCII old lines.** Three regions the tasks must replace
  contain a non-ASCII dash: `messagesRepo.ts:2263`, `sendMessage.ts:238` and
  `sendMessage.ts:450`. Tasks 2 and 8 identify them by line range plus their ASCII
  first and last lines and tell the builder to select, not retype. Every other
  edit anchors on ASCII lines only: the interface's new doc is a parameter JSDoc,
  so the non-ASCII doc block at `messagesRepo.ts:1256-1260` stays untouched, and
  `MessageItem`'s new fields anchor on `:1000`, not the doc line `:999`. All 19
  quoted old blocks and 13 single-line anchors were checked mechanically to occur
  exactly once in their target file at the cited line.
- **DynamoDB Local for every app run.** `app/test/globalSetup.ts:50-80` fails any
  app vitest run when DynamoDB Local is unreachable (unless
  `ALLOW_SKIP_DYNAMO_TESTS=1`), including the pure unit files in Tasks 7 and 9.
  Task 2's run step says so; the builder should keep `npm run db:start` up for all
  four tasks.
- **A stale citation fixed in passing.** The harness relay comment cited
  `messagesRepo.ts:2218-2233` (`twilioWebhookHarness.ts:1134`); that block is now
  `:2266-2284`. Task 2 rewrites the comment because it edits the block.
