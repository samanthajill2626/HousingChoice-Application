# S3 report - retry-send adoption, plan Task 4 (the job on the record)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`1b2a3196` (S2's report). Scope: plan Task 4 (Steps 1-4) with build worklist
items 12-17 and item 24 (the planner's belt ruling). Task 5 (the route) NOT
started. Status: DONE. Line numbers below are at `4bf6e32a` (the code commit).

## Commits

| hash | subject |
|---|---|
| `4bf6e32a` | feat(jobs): messaging.retrySend claims a send-attempt record instead of the run-once marker - gates on the existing attempt, a manual child and the window before it claims; re-arms before the provider call; refuses, rejects, defers once, or hands an unknown outcome to send.reconcile with the promise refreshed (retry-send-adoption T4) |
| (this file) | docs commit, recorded by its own hash in git log |

One code commit: the new suite cannot be committed red on its own (it names
`RetrySendJobDeps` fields the old interface lacks, so typecheck would be red).
The red run is recorded below instead.

## The handler as built (`app/src/jobs/retrySend.ts`)

Registration `:313`, handler `:331` (through `defineJobHandler`, no run-once
marker). The deps grew at `:279-310` (`conversationsRepo`, `sendAttemptsRepo`,
`config`, `events`; the `now` doc now names every clock use). Lazy deps are
bound to consts at `:335-344`.

Before the claim (reads only; a throw fails the delivery and SQS redelivers):

1. The retried row, CONSISTENT (`getByProviderSidConsistent`, `:349`; plan
   deviation 3). Not found `:351` / not outbound `:355` -> WARN, return. A
   payload whose conversationId is not the row's -> WARN, return (`:360-366`,
   deviation D-a below). Then `resolveRetryRoot` `:367`, the window origin
   `:370-371`, the log context `:372`.
2. RSW D14 recorded recipient by id `:379-390` (a missing contact WARNs).
3. The thread `:395`; `conversationRetryDecline` + `retryRecipientKey`
   `:396-403` -> WARN `retrySend: conversation not retryable` with `reason`
   (`conversation_missing` | `group_text` | `not_one_to_one`), no record. The
   owner `:404-411` (conversationId, retriedTsMsgId, attempt, recipientKey,
   retryRoot); `octx` with the key through `safeRecipientKey` `:412`.
4. The shared gate `gateFor(attemptsRepo, owner, now())` `:421`:
   `taken_over` -> INFO + `handOff` exactly once `:422-426`; `defer` -> INFO
   `:427-430`; `skip` -> INFO `:431-434`; `proceed` falls through with
   `existing = gate.record` `:435`.
   - THE BELT (deviation 10, worklist item 24) `:436-450`: ONLY when
     `existing === undefined`, read `messagesRepo.getJobExecutionMarker(jobId)`
     with `jobId = getContext()?.jobId` (skipped when there is none); present
     -> INFO `retrySend: pre-adoption delivery already ran this job - not
     re-sent` with `jobId` and the owner context, return. Never written.
   - 4a manual child `:453-462`: ONE `listRetryChildrenConsistent` Query; a
     child with no `retryAttempt` -> `declineBeforeClaim(manual_retry_superseded)`
     then INFO.
   - 4b the strict window `:464-477`: no origin -> WARN fail-open; closed ->
     `declineBeforeClaim(retry_window_closed)` then ERROR (`retryDecision:
     'window_closed'`).
5. The claim `:479-507`: `planRetryMedia` `:483`, `pinnedSender(appConfig)`
   `:484`, the facts `:486-492`, `claim(owner, facts, nowIso())` `:493`;
   refused -> INFO with `state` and `fresh` `:494-501`; takeover -> `takeOver`
   then `handOff`, or INFO "takeover lost" `:502-507`. `ref`
   `:508`, `secondUnknownWouldClose` `:510`.

After the claim (one try/catch with `phase`, nothing throws):

6. PREPARE `:515` - `presignRetryMedia` (`:241-269`, the old media block fed
   by the plan).
7. SEND `:527-550` - the old arguments plus `retryRoot`, `broadcastId` (from
   the retried row) and `beforeProviderSend` re-arming the claim (`:541-549`;
   a lost re-arm sets `takenOver` and returns false).
8. RECORD `:559-567` - `finishAttempt(sent, sid)` through `guardWrite` with
   the fence captured; a lost fence WARNs `:564-566`; INFO `message re-sent`.

The catch `:568-637`: record phase -> ERROR `:572-575`; prepare -> deferral
`:576-580`; `SendRefusedError` -> refuse `:582-587`; `SendNotAttemptedError`
-> INFO when taken over, else deferral `:588-597`;
`SendAcceptedNotRecordedError` -> ERROR + `handToReconcile(sid)` `:598-606`;
classification `:608-609`: rejected (kill switch -> refuse, deviation 2)
`:610-631`; retryable -> deferral `:632-635`; unknown -> `onUnknown` `:636`.

The arms' helpers, function declarations at the END of the handler (hoisted;
every call happens after the consts they close over are bound): `finish`
`:647`, `refuse` `:669`, `declineBeforeClaim` `:680`, `deferOrEnd` `:704`,
`handOff` `:764`, `handToReconcile` `:795`, `onUnknown` `:815`. The one
self-enqueue is the deferral's `enqueueSendRetry(..., deferred: true)` (`:729`).

`app/src/jobs/registerHandlers.ts:61` registers with `{ sendAttemptsRepo:
deps.sendAttemptsRepo }`; its doc `:31-37` says four send handlers.

## The arms as built (R3)

| outcome | record | retried row's promise | log (level, msg) |
|---|---|---|---|
| success | done/sent, sid | none | INFO `retrySend: message re-sent` (`newProviderSid`, `outcome: 'sent'`) |
| success, fence lost | untouched by this job (the takeover's reconcile adopts the row as `mine`) | none | WARN `retrySend: attempt fence lost after a recorded send; the takeover reconcile repairs` |
| refusal (wrapper `SendRefusedError`, incl. its kill switch) | done/refused, cause = code | none | WARN `retrySend: send refused - retry chain stopped` (`refusal`, `cause`) |
| adapter kill switch (rejected, `sms_sending_disabled`) | done/refused, cause `sms_sending_disabled` | none | WARN, same line (deviation 2) |
| rejected (4xx; 30005/6/7) | done/rejected, cause = code or status | none | ERROR `retrySend: retry chain ended - provider rejected the retry` (`errorCode`, `status`, `cause`; no `err`) |
| deferred (retryable, `SendNotAttemptedError`, prepare throw) | done/retryable, cause = code or `send_retryable` | REFRESH to runAt (after the release WON or THREW) | WARN `retrySend: retry deferred - re-scheduled` (`cause`, `runAt`) |
| deferral, release LOST | untouched by this job (a takeover owns it); the deferred job is already queued | none | INFO `retrySend: attempt close lost its fence - the takeover owns the record` |
| deferral, release THREW | may still be attempting | REFRESH to runAt | ERROR (guardWrite) + ERROR `retrySend: retry re-scheduled but its record release threw - ...` |
| second deferral (`deferred: true` payload) | done/refused, cause `deferral_cap` | none | ERROR `retrySend: retry deferred twice - chain ended` |
| deferral past the window | done/refused, cause `retry_window_closed` | none | ERROR `retrySend: a deferred re-run would land past the window - chain ended` |
| deferral enqueue throws | done/refused, cause `enqueue_failed` | none | ERROR `retrySend: retry re-schedule failed - chain ended` |
| unknown | reconciling (handToReconcile first), then check 0 enqueued | REFRESH to attemptedAt + reconcileCheckDelaysMs()[2] + 120 s | INFO `retrySend: unknown send outcome - handing the attempt to reconcile`, then INFO `retrySend: retry outcome unknown - handed to reconcile` |
| unknown on a re-driven attempt (redriveCount >= 1) | done/unresolved, cause `second_unknown` | WITHDRAW (sentinel + `retry_outcome: 'unconfirmed'`) when the close won | ONE ERROR `retrySend: unknown send outcome after a re-drive - attempt closed unresolved; the retry promise is withdrawn` |
| accepted-not-recorded | reconciling WITH the sid, then check 0 | REFRESH as unknown | ERROR `retrySend: sent_unrecorded - the retry was sent but not recorded; its SID goes to reconcile` (`sid`) |
| hand-off enqueue throws | done/unresolved, cause `enqueue_failed` | WITHDRAW when the close won | ERROR `retrySend: reconcile enqueue failed - attempt closed unresolved; the retry promise is withdrawn` |
| hand-off fence lost | the takeover's | none | INFO `retrySend: hand-off fence lost - the takeover owns the record` |
| takeover (gate or claim) | reconciling (takeOver), check 0 enqueued | REFRESH as unknown | INFO `retrySend: a stale attempt was taken over into reconcile` (gate path) + the hand-off INFO |
| lost re-arm | untouched (attempting, the takeover's) | none | INFO `retrySend: attempt taken over before the send - not sent; the takeover owns it` |
| 4a manual child | none; a REDRIVEN record closed done/refused `manual_retry_superseded` | none | INFO `retrySend: a manual retry superseded this attempt` |
| 4b window closed | none; a REDRIVEN record closed done/refused `retry_window_closed` | none | ERROR `retrySend: retry window closed - retry chain ended without sending` |
| step 1/3 declines, gate defer/skip, the belt | none | none | WARN (declines) / INFO (gate, belt) |

Every line the job writes carries `providerSid`, `conversationId`, `attempt`
(a number) and - from step 1 on - `retriedTsMsgId`, `retryRoot`; from step 3
on `recipientKey` (redacted `phone#redacted` for a phone key). Never a phone,
a body or a `phonehash#` (case R9).

## Deviations (plan deviations 2, 3, 6 and 10 are implemented as declared)

- D-a (new belt, S2's contract): step 1 refuses a payload whose
  `conversationId` is not the retried row's (WARN, no record,
  `retrySend.ts:360-366`). The webhook and the re-drive always pass the row's
  own, so it is unreachable from them; without it a hand-built payload would
  key an owner the reconcile cannot resolve (S2 report: "MUST equal").
- D-b: `presignRetryMedia` also takes the retried row, only so the
  dropped-media WARN keeps the old line's `attachmentCount` / `s3Keys` (the
  plan's `RetryMediaPlan` carries no attachments when there is no store).
- D-c: the arms' helpers are declared after the try/catch (hoisted) rather
  than between steps 3 and 4, so the handler reads top to bottom; they keep
  the plan's signatures.
- D-d: `onUnknown`'s second-unknown close goes through `finish()` (a lost
  fence logs its INFO), and both it and `handOff`'s enqueue-failure line say
  honestly whether the unresolved close won (two message texts each); the
  plan's second-unknown text claimed the withdrawal unconditionally.
- D-e: step 3's decline also tests `participantPhone` / `recipientKey`
  undefined (unreachable once `conversationRetryDecline` passed; it narrows
  the types without non-null assertions).
- D-f: refusal, rejection and deferral lines carry `cause` (R9); the
  rejection line carries NO `err`, because a Twilio 21211 message quotes the
  destination number.
- D-g: the hand-off REFRESH reads `reconcileCheckDelaysMs()[2] ?? 0`
  (lint-free) instead of `[2]!`; same value.
- D-h: the legacy-row exact pin (the case at `twilioStatusWebhook.test.ts:1702-1741`)
  is re-pinned as `toMatchObject` + `typeof beforeProviderSend` + no
  `broadcastId` + the EXACT key set (`Object.keys(...).sort()`), so it stays
  an exact pin, not a weakened one.
- D-i: the throwing-recipient case's title and its throw text say "before the
  claim" (the marker is gone); the describe's `afterEach` gains
  `vi.restoreAllMocks()` for the new spies.
- D-j: cases beyond the plan's list, each pinning an R3 arm the list does not
  name: 1c (second unknown -> withdraw), 1d (hand-off enqueue failure ->
  unresolved + withdraw), 4-enqueue (deferral enqueue failure), 4-prepare
  (a presign throw and a `SendNotAttemptedError` both defer, and the claim
  records the planned mediaCount), 6g (the claim-time takeover), 7b (a record
  fence lost after the send is WARN, never sent_unrecorded). Case 9 (b) also
  redelivers the failed envelope and proves it then sends exactly once.
- Plan-faithful, worth a reviewer's eye: `declineBeforeClaim` wraps
  `closeRedriven` in `guardWrite`, as the plan's code does, so a THROWN close
  of a redriven record is one ERROR and a sweeper strand rather than a failed
  delivery that SQS would retry (the decline is idempotent, so letting it
  throw would also be safe). Not changed.

## Proof that test 1 was red

Run against the old job with the new suite and the rewired suite in place
(`cd app; npx vitest run test/retrySendAttempt.test.ts
test/twilioStatusWebhook.test.ts`, log `.superpowers/sdd/s3-red.log`): 2
files failed, 32 failed | 77 passed (109). Case 1 failed at
`retrySendAttempt.test.ts:307` with `AssertionError: expected undefined to
match object { state: 'reconciling', ... }` - the old job claims nothing and
rethrows the unknown error. All 29 new cases were red, plus the 3 rewired
existing ones (the DUPLICATE GUARD case, the throwing-record-read case, the
legacy re-pin).

Mutation checks after green (each a temporary edit of `retrySend.ts`,
restored byte-identical and verified with `cmp`): withdraw removed from the
second-unknown arm -> 1c red; from the hand-off failure -> 1d red; the belt
read forced false -> the belt case (a) red; `declineBeforeClaim` never closes
-> 4c and 11 red; a LOST release refreshing anyway -> 4-lost red; the
deferral cap disabled -> 4-cap red; the kill-switch refusal disabled -> 2a red.

## Verification (bare, from the worktree; DynamoDB Local `hc-dynamodb-local` up)

- Baseline before any edit, the listed files plus retrySendMedia: 7 files,
  339 passed.
- `cd /w/tmp/retry-send-adoption/app && npx vitest run
  test/retrySendAttempt.test.ts test/twilioStatusWebhook.test.ts
  test/retrySendBackoff.test.ts test/retrySendWindow.test.ts
  test/sendReconcile.test.ts test/registerHandlers.test.ts
  test/oneToOneRetryDecision.test.ts` -> exit 0, 7 files, 366 passed:
  retrySendAttempt 34 (new), twilioStatusWebhook 80, sendReconcile 151,
  oneToOneRetryDecision 54, retrySendWindow 35, retrySendBackoff 11,
  registerHandlers 1 (the registration pin is `test/registerHandlers.test.ts`).
- Neighbours (the module graph changed): `npx vitest run
  test/retrySendMedia.test.ts test/retryChain.test.ts
  test/retryPromiseWrites.test.ts test/relayRetryLeg.test.ts
  test/broadcastFanOut.test.ts test/relayFanOut.test.ts
  test/sendReconcile.integration.test.ts test/apiRoutes.test.ts` -> exit 0,
  8 files, 483 passed.
- `npm run typecheck` -> exit 0 (all workspaces).
- `npm run smoke` -> exit 0, "1508 import specifier(s) across 264 emitted
  file(s) resolve under plain Node". Smoke checks RESOLUTION only, so the
  closed retrySend <-> sendReconcile cycle was also EVALUATED: each of
  `jobs/retrySend.js`, `jobs/sendReconcile.js`, `routes/webhooks/twilio.js`,
  `jobs/registerHandlers.js`, `services/oneToOneRetryDecision.js`,
  `jobs/broadcastFanOut.js` imported FIRST in a fresh plain-node process
  from `app/dist` -> every binding defined, exit 0 (no entrypoint imported).
- `npx eslint app/src/jobs/retrySend.ts app/src/jobs/registerHandlers.ts
  app/test/retrySendAttempt.test.ts app/test/twilioStatusWebhook.test.ts` ->
  exit 0, no output (no pre-existing errors in these files either).
- ASCII: `tr -d '\11\12\15\40-\176' < app/test/retrySendAttempt.test.ts |
  wc -c` -> 0; the same over the diff's added lines in the three modified
  files -> 0 (their pre-existing U+2014 lines were left untouched).
- Fences: no diff in `twilio.ts`, `jobs.ts`, `sqsJobConsumer.ts`,
  `oneToOneRetryDecision.ts`, `messagesRepo.ts`; the only marker lines in the
  source diff are the REMOVED `putJobExecutionMarker` call and the belt's
  `getJobExecutionMarker` read.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e session.

## What Task 5 (the manual Retry route) must know

- The job keys the record exactly as R6 reads it: `{ kind: 'retry_send',
  conversationId, retriedTsMsgId: <the retried row's tsMsgId>, attempt:
  <payload.attempt>, recipientKey: retryRecipientKey(row, conversation),
  retryRoot }` (`retrySend.ts:399-411`); the root is not in the key, so the
  route may pass any root value to `sendAttempts.get`.
- What the job leaves on the record: done/sent; done/refused (a refusal, the
  adapter kill switch, `deferral_cap`, a deferral past the window, a deferral
  `enqueue_failed`, and a redriven record closed `manual_retry_superseded` or
  `retry_window_closed`); done/rejected; done/retryable (a deferred re-run IS
  queued, at the promise's refreshed `retry_due_at`); reconciling (unknown,
  accepted-not-recorded, takeover); attempting (in flight, or a strand);
  done/unresolved (`second_unknown`, or a hand-off `enqueue_failed` after a
  possible send) - the only two job arms that WITHDRAW (sentinel +
  `retry_outcome: 'unconfirmed'`).
- A press during a deferral: the job refreshed the promise to the run time,
  so RSW's time guard answers `retry_pending` first; a press that lands anyway
  appends a manual child, and the deferred run's step 4a declines on it
  without writing (done/retryable stays) - the two halves compose.
- The job's 4a sees a manual row only through the `retrychild#` pointer its
  append writes: the route's append must keep passing `retryOf` (it does), and
  now `retryRoot` and `broadcastId` (R7).
- Declines at steps 1 and 3 write no record (the route reads absent).

## What Task 8 (the e2e) must know

- Every e2e attempt is PHONE-keyed (the API send records no recipient): job
  lines carry `recipientKey: 'phone#redacted'`, the hand-off carries
  `recipientKeyHash: 'phonehash#...'`.
- The unknown hand-off is INFO (both lines), invisible to the WARN+ logtail:
  item 17's seam proof is the retried row's REFRESHED `retry_due_at` =
  attemptedAt + 8 s (the lane's last check) + 120 s, versus the failure's
  +10 s stamp.
- The job's lines have NO `event` field (only send.reconcile's lines carry
  `event: 'send_reconcile'`), so item 19's "exactly one send_reconcile ERROR"
  is unaffected by the job; the job itself logs no ERROR on the unknown path.
  If a RE-DRIVEN send also comes back unknown, the job - not the reconcile -
  closes `unresolved` / `second_unknown`, withdraws, and logs ONE ERROR
  `retrySend: unknown send outcome after a re-drive - ...`.
- Item 18: the re-drive is an immediate `messaging.retrySend` with no
  `deferred`; the job claims from `redriven` (attemptNo 2, redriveCount 1) and
  sends; the reconcile refreshes the promise after enqueueing it, and a
  refresh racing the job's own is dropped at INFO (worklist item 26).
- The lane's 10 s deferral backoff is under the 30 s claim TTL: a deferred
  run that meets a still-`attempting` record (only after a THROWN release) is
  deferred by the gate and strands for the sweeper - not reachable with the
  fake's normal seams.
- Hop budget unchanged: the job adds exactly one self-enqueue (the deferral).

## For the handback (orchestrator)

- Deviation 10 (the belt) as built: read-only, only with no record, never
  written; test 6d still pins `putJobExecutionMarker` never called. The dated
  deploy note in `retry-send-lost-under-job-marker` (worklist item 24) stays
  owed by Task 9.
- D-a above (the conversation-mismatch refusal) is a new designed decline to
  name in the handback's conformance table.
