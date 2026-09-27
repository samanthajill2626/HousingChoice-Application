# S3a report - Task 10 (Slice C): the send.reconcile job

Dispatch S3a of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
It covers plan Task 10, `adoptBroadcastRecipient` (moved here from Task 7),
T10-3's `resolveContact`, and the carried legacy-adoption `errorCode` fix.
Worktree `W:\tmp\send-outcome-reconcile`, base 97af6e9b, HEAD 9db8fa22; tree
clean, nothing left running. No fenced file changed (twilio.ts, jobs.ts,
sqsJobConsumer.ts and retrySend.ts all have a 0-line diff); no run-once marker
is used. The byte-exact reference for S3b is the gitignored
`.superpowers/sdd/S3a-reference.md`.

Record note: the implementer returned this report as TEXT (the harness refuses
report-file writes from implementer subagents); the orchestrator landed it
here, with its own checkpoint verification and one adjudication appended, per
AGENTS.md.

## Commits

Each has the Co-Authored-By trailer and 0 non-ASCII added bytes; MERGE_HEAD
was absent each time.

- `346f0b74 fix(relay): a legacy adoption of a success status with no code clears a stale slot errorCode, as the versioned path does (carried from S1c)`
- `be53cc0e feat(jobs): send.reconcile - look an ambiguous send up at the provider and adopt it, re-drive it once, or close it unresolved (the broadcast owner; D11-D16a)`
- `942f5e5f feat(jobs): send.reconcile adopts, re-drives and closes the relay leg and the relay retry rung (D13, D15, D16, rulings A1, T10-2)`
- `f01b5c5a test(jobs): send.reconcile over the real repos - a redelivered adoption completes without duplicating a write, and never regresses a receipt (D11, D15)`
- `9db8fa22 fix(jobs): an adoption over a row the send wrapper already recorded writes no second audit row; a rung found whose slot did not move announces the slot as it is`

Files touched: `app/src/jobs/sendReconcile.ts`, `app/src/jobs/registerHandlers.ts`,
`app/src/jobs/broadcastFanOut.ts`, `app/src/repos/messagesRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`,
`app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`,
`app/test/registerHandlers.test.ts`, `app/test/broadcastFanOut.test.ts`, NEW
`app/test/sendReconcile.test.ts` (53 cases), NEW
`app/test/sendReconcile.integration.test.ts` (3 cases).

## The handler flow as built (sendReconcile.ts; `runCheck` at :369)

1. Parse the payload (`parseSendReconcilePayload` :205), field by field: the
   owner kind and its ids, `recipientKeyHash`, an ISO `attemptedAt`, an
   integer `checkNo` in 0..2, an optional `continuation.senderKey`. A malformed
   payload throws (a job failure: retry, then the DLQ on SQS).
2. Resolve the owner (`resolve` :447); the raw recipient key is found by
   `hashRecipientKey` equality. Broadcast: `broadcasts.getByIdConsistent`,
   then a key in `recipients`. Relay: `messages.getByTsMsgIdConsistent` of the
   source or retry row plus `conversations.getById`; the key comes from the
   rung's `relay_retry_member_key`, else a `delivery_recipients` key, else a
   roster member. A read that throws is a retry. No match: INFO `owner
   recipient not found`, return (the record is left for the sweeper).
3. Read the record (`attempts.get`, consistent). Absent, not `reconciling`,
   or another `attemptedAt`: INFO `superseded`, return. A7: a `done` record
   with the SAME attemptedAt runs `afterClose` first.
4. Record the check: `attempts.recordCheck(owner, attemptedAt, checkNo+1)`
   (conditional on reconciling, the attemptedAt, and checkNo n-1 or n). false:
   INFO `check already recorded`, return.
5. Known-SID path (`adoptKnown` :706) when the record has a SID: `heldBy`
   first (consistent `getSystemSidMarkerConsistent`,
   `getRelaySidPointerConsistent`, `getByProviderSidConsistent`, plus a
   consistent `resolveContact` for a broadcast). Held by a system send or
   another owner: `unresolved sid_held_elsewhere` with `heldBy`, no fetch.
   Otherwise `adapter.getMessage`; a throw propagates and an undefined result
   throws (genuine retries). Then `adopt`; if the adoption's own claim says
   `other`: `unresolved sid_held_elsewhere`.
6. Lookup path (`lookup` :731) otherwise. No sender: `unresolved no_sender`.
   The current phone's digest differs: `unresolved digest_mismatch`.
   `attempts.listByRecipient(sender, digest, attemptedAt - 60 s)` read once;
   siblings compared by `attemptKey`, their SIDs excluded. The page walk
   `adapter.listMessages({ to, from: sender, pageSize: 1000, pageToken })`: a
   throw is this check's result (`continue` with a WARN carrying `err`, or
   `unresolved provider_unreachable` at check 2); a next page at page 5:
   `unresolved page_bound`. Candidates: `createdAt >= window start`, deduped by
   SID, oldest first; a SID a sibling holds is skipped, so is one held by a
   system send or another owner; a free candidate that does not match counts
   as unmatched; anything else goes to `adopt` and the first `found` wins; a
   `mine` candidate whose claim is lost: `unresolved sid_held_elsewhere`.
   Before check 2: `continue`. At check 2: any unmatched candidate
   `unresolved unidentified_candidate`; a same-fingerprint sibling open or
   adopted `unresolved same_fingerprint_sibling`; otherwise `never_sent`.
7. The verdict writes. `found`: `closeFromReconcile(adopted, sid)`
   (conditional on reconciling + attemptedAt), INFO, then `afterClose`.
   `continue`: `enqueueOrClose(enqueueSendReconcile({...payload, checkNo:
   n+1}, reconcileDelayMs(attemptedAt, n+1)))`; an enqueue throw is
   `closeUnresolved(enqueue_failed, err)`. `never_sent`: `redrive` (:1029); a
   relay refusal (:990) goes to `closeRedriveRefused`; otherwise
   `markRedriven` (conditional on reconciling + attemptedAt + redriveCount 0);
   false with redriveCount >= 1 is `closeUnresolved(second_unknown)`,
   otherwise INFO and return; true: WARN never_sent, then
   `enqueueOrClose(redriven, enqueueRedrive)`; a re-drive enqueue throw runs
   `closeRedriven(enqueue_failed)` FIRST (conditional on `redriven`) and only
   when it returned true the slot is closed `enqueue_failed`, one ERROR,
   `afterClose` (T10-14); false: a WARN and nothing else. `unresolved`:
   `closeUnresolved` (:878) - the slot first, then `closeFromReconcile
   (unresolved, cause)`, then ONE ERROR, then `afterClose`.
8. `afterClose` (:849). Broadcast: `finalize` (consistent read, defers while
   any slot is queued, conditional flip). Relay leg: nothing (its emits happen
   at the slot moves). Relay rung: re-read the retry row consistently and emit
   `message.persisted {conv, row.relay_retry_of, row.direction, status}`; the
   status is the one passed in, else the slot's current status, else `failed`.

Every write the job makes is one of four kinds: conditional on the record
(the check, close, redrive and redriven-close writes); a SID claim (the append
that dedupes on the SID, or `claimRelaySidPointer`); a slot write that can only
move forward (broadcast `recordRecipientOutcome` / `closeRecipientIfQueued`
from `queued` only; relay `adoptRelayRecipientIfUnsent` first-write-wins;
`closeRelayRecipientIfUnsent` only on an absent slot or a queued one with no
sid); best-effort (the audit row, the inbox touch, the milestone, the
listing-send row, the flag). A throw from any job-owned read or write
propagates.

## Verdict table per owner, in write order

**broadcast**
- found (`adoptBroadcastRecipient`, broadcastFanOut.ts:1279): (1) consistent
  broadcast read; (2) consistent `resolveContact`, then
  `createOrGetByParticipantPhone`; (3) `messages.append` - the row
  sendMessage would have made: `broadcast_id`; `automated = created_via !==
  'dashboard'`; `recipient_contact_id` only while `contactHoldsPhone`; the
  provider's status (mapTwilioStatus) and its error code for failures;
  `provider_ts` = the provider's createdAt; the body is the provider's stored
  body; (4) on a dedupe: `getByProviderSidConsistent` - not this recipient's
  row (`isBroadcastRowFor`) returns `other_owner` and the caller takes the next
  candidate; (5) `recordRecipientOutcome` with slot `{conversationId, tsMsgId,
  status, errorCode?, carrierSentAt?}` (carrierSentAt from date_sent), bump
  `{sent|delivered|failed: 1, queued: -1}`, from `['queued']` only (status
  mapping: accepted/queued/sending/sent -> `sent`, delivered/read ->
  `delivered`, undelivered/failed/canceled -> `failed` + code); not moved:
  `skipped`; (6) only when moved: a `broadcast.updated` tick with derived
  stats; the `message_sent` audit row, only for a freshly appended row; the
  status-preserving touch if it moves forward, with a `conversation.updated`;
  `message.persisted` for the 1:1 thread; sent/delivered: the listing_sent
  milestone and the listing-send row; failed: 30005/30006 sets
  `sms_unreachable`, plus WARN `adopted terminal failure - webhook side
  effects skipped`; (7) back in the job: `closeFromReconcile(adopted, sid)`,
  INFO found, `finalize`.
- never_sent: `markRedriven`, WARN, then `enqueue(broadcast.send,
  {broadcastId, recipientKeys:[key], attempt: fanout_attempt+1, redrive:
  true})`. If the enqueue throws: `closeRedriven(enqueue_failed)`, slot
  `failed`/`enqueue_failed` (failed bucket) with a tick, ERROR, `finalize`.
- unresolved: slot `failed`/`send_unconfirmed` (bucket `unconfirmed`) with a
  tick, then record `done`/`unresolved` with the cause, then ONE ERROR, then
  `finalize`. Causes: no_sender, digest_mismatch, provider_unreachable,
  page_bound, unidentified_candidate, same_fingerprint_sibling,
  sid_held_elsewhere, second_unknown, enqueue_failed.

**relay_leg**
- found: `claimRelaySidPointer(sid, {conv, sourceTs, memberKey})` (`other` ->
  next candidate); `adoptRelayRecipientIfUnsent` with status =
  mapTwilioStatus, sid, `sentAt` = date_sent else createdAt, and the code for
  failures (a missing row or slot throws); if adopted: `message.persisted
  {conv, sourceTs, source.direction, status}` (A1); a failure also WARNs, no
  flag; then `closeFromReconcile`, INFO.
- never_sent: refused (no_continuation, group_not_open, member_removed,
  source_not_found): `closeRelayRecipientIfUnsent(redrive_refused)` (an emit
  if it closed), then record `done`/`redrive_refused`, then a WARN. Otherwise
  `markRedriven`, WARN, `enqueue(relay.fanOut, {relayConversationId,
  sourceTsMsgId, senderKey, senderNameOverride?, recipientKeys:[memberKey],
  attempt: fanout_attempt+1, redrive: true})`. If the enqueue throws:
  `closeRedriven` FIRST, then slot `enqueue_failed` with an emit, then ERROR.
- unresolved: slot `send_unconfirmed` (an emit if it closed), then the
  record, then ONE ERROR.

**relay_rung** (the same writes, on the RETRY row)
- found: the claim, then the adoption; if adopted, the status-preserving
  touch (forward only) and a WARN on a failure; then the record, INFO, and the
  root emit carrying the adopted status (or the slot's current status when the
  adoption was skipped).
- never_sent refused (group_not_open, member_removed, retry_row_not_found):
  the `redrive_refused` close, then the record, a WARN, and the root emit with
  `failed`. Otherwise `markRedriven`, WARN, then plain `enqueue(relay.retryLeg,
  {relayConversationId, retryTsMsgId, redrive: true})`. If the enqueue throws:
  `closeRedriven` FIRST, then slot `enqueue_failed`, ERROR, and the root emit
  `failed`.
- unresolved: slot, then record, ONE ERROR, root emit `failed`.

## Deviations (from the plan, worklist or spec) and why

1. The match rule is stricter than the plan (`matches` :518, `sameFingerprint`
   :530): the media count must match for EVERY body, not only short ones; a
   short record only matches a short candidate; the same-fingerprint sibling
   test is the exact mirror of the match rule. Why: the plan's rule lets an
   emoji-only text with no media adopt Twilio's STOP auto-reply, and lets a
   text and an MMS with the same caption adopt each other and then re-drive
   (a double text). Both changes can only move an outcome toward
   `unresolved`, never toward adoption or a re-send.
2. The broadcast adoption writes the `message_sent` audit row only for a row
   it appended itself; a row that was already there (the pass's slot write
   threw after sendMessage had appended and audited it) already has its audit
   row.
3. A rung `found` whose adoption was skipped (a receipt had already advanced
   the slot) announces the slot's current status at the root. A1 says "the
   adopted status".
4. The refusal cause strings are the implementer's: the plan named only
   `no_continuation`; added `group_not_open`, `member_removed`,
   `source_not_found` and `retry_row_not_found`.
5. The ERROR for a failed re-drive enqueue logs `verdict: 'never_sent',
   cause: 'enqueue_failed'`, because the record's outcome is `enqueue_failed`,
   not `unresolved`.
6. The `heldBy` holder for a broadcast row is
   `broadcast#<id>#<recipient_contact_id or ->`; for a row with no broadcast it
   is `message#<conv>#<ts>`.
7. Relay owner resolution falls back to the roster even when the row is
   missing, so a missing source row still reaches the `redrive_refused` record
   close.
8. A contact member no longer on the roster is `unresolved digest_mismatch`
   (the plan's formula: the roster member's phone, or a phone# key's own
   number); it is not looked up by contact.
9. `adoptBroadcastRecipient` throws on a missing broadcast or a contact with
   no phone; neither is reachable by construction.
10. `recordPropertySent` is a shared helper; the pass's `afterSend` now calls
    it (identical log text).
11. The legacy fix follows the versioned rule: the `errorCode` is REMOVEd only
    for a success status (queued, sent, delivered) with no code; a failure
    with no code keeps the slot's code.

## Red to green (one failing line per increment)

- (a) RED `expected { errorCode: 'send_retryable' } to match object { errorCode: null }`. GREEN 3 files, 81 passed.
- (b) RED 36 x `(0 , registerSendReconcileJobHandler) is not a function`,
  plus `expected [ 'broadcast.send', ...(12) ] to deeply equal [ ..., ...(13) ]`.
  GREEN 3 files, 128 passed.
- (c) RED 15 relay cases on `sendReconcile: the relay_leg owner is not handled
  yet` (13) and `relay_rung ... not handled yet` (2). GREEN 51 passed; 6
  fast-gate files, 423 passed.
- (d) The integration test was written after the implementation, so it passed
  on its first run; two throwaway mutants show it catches regressions (both
  restored and verified byte-identical with cmp): broadcast adoption priors
  `['queued','delivered']` -> `expected { unconfirmed: +0, ...(9) } to match
  object { delivered: 1, queued: +0 }`; the legacy REMOVE dropped ->
  `expected { errorCode: 'send_retryable', ...(3) } to deeply equal { status:
  'sent', ...(2) }`.
- (e) Self-review fixes. RED `expected [ {...}, {...} ] to have a length of 1
  but got 2` (audit rows) and `"deliveryStatus": "sent"` against
  `"delivered"`. GREEN.

## Gates

- Fast gates (sendReconcile, sendReconcile.integration, broadcastFanOut,
  relayFanOut, relayRetryLeg, registerHandlers,
  twilioWebhookHarnessRepoAdditions.integration): EXIT=0, 7 files, 428 passed.
- typecheck: EXIT=0 with 0 `error TS` lines after every commit.
- smoke: EXIT=0, `smoke-dist: OK - 1477 import specifier(s) across 258
  emitted file(s)`; each compiled cycle entry (sendReconcile,
  registerHandlers, broadcastFanOut, relayFanOut, relayRetryLeg) also
  evaluates under plain node.
- Whole app workspace (`timeout 590 npx vitest run`): EXIT=0, 383 files
  passed, 7550 passed, 1 skipped (the environmental staticSmoke case; the old
  `it.skip` now runs), 187.91 s, 0 `[dynamoAdmin]` lines.
- eslint on all 10 touched .ts files: EXIT=0, nothing reported.

## Contract for downstream

- Job name `send.reconcile` (`SEND_RECONCILE_JOB`), registered in
  `registerAllJobHandlers` (registerHandlers.ts:77), so both the app's
  in-process path and the worker carry it. `registerSendReconcileJobHandler
  (deps)`; every dep optional and built lazily: config (feeds the adapter
  only), adapter, messagesRepo, broadcastsRepo, contactsRepo,
  conversationsRepo, sendAttemptsRepo, activityEventsRepo, listingSendsRepo,
  auditRepo, events, logger. Also exported: `parseSendReconcilePayload`, and
  from broadcastFanOut `adoptBroadcastRecipient`, `AdoptDeps`,
  `AdoptBroadcastArgs`, `isBroadcastRowFor`, `resolveContact`,
  `emitBroadcastProgress`.
- Log lines: every line carries `event: 'send_reconcile'`, `owner: {kind,
  broadcastId | relayConversationId + sourceTsMsgId | retryTsMsgId}`,
  `recipientKey` (safeRecipientKey) and `checkNo`. INFO `verdict: 'found'`
  with `path` (`known_sid` | `lookup`), `sid`, `adoption` (`adopted` |
  `skipped`), `deliveryStatus` (T16-2). INFO `verdict: 'continue'` with
  `reason` and `nextCheck`. WARN with `err` when a provider error hits an
  intermediate check. WARN `verdict: 'never_sent'` (re-driven, or refused with
  a `cause`). ERROR `verdict: 'unresolved'`, one per close, with `cause` and
  optionally `sid`/`heldBy`, `unmatched`, `pages` or `err`; text
  `send.reconcile: unresolved - the platform cannot tell whether this text
  went out; closed send_unconfirmed, never re-sent`. ERROR `verdict:
  'never_sent', cause: 'enqueue_failed'` when a re-drive enqueue fails. WARN
  `... adopted terminal failure - webhook side effects skipped` with
  `errorCode` and `deliveryStatus` (the relay line has the `send.reconcile: `
  prefix; the broadcast line has the `broadcastFanOut: ` prefix and also
  carries broadcastId and providerSid).
- Lane seam: `E2E_SEND_RECONCILE_DELAYS_MS='a,b,c'` (three finite ints, each
  0 or more), only when JOBS_QUEUE_URL is unset or empty. Check k runs at
  attemptedAt + delays[k], never before now.
- What Task 12 can rely on (lane at 2000,4000,8000): spec 1 (relay
  accept_then_drop): the check at 2 s lists To=member From=pool and adopts
  with the provider's CURRENT status; the slot gets status, sid and sentAt,
  and the adoption emits `message.persisted` on the source row, so the open
  thread updates without a reload. Spec 2 (broadcast drop_before_create):
  `never_sent` at the 8 s check; the re-drive is one `broadcast.send` with
  `redrive:true`; its pass claims the record from `redriven` (attemptNo 2) and
  sends once; the share finalizes `sent`. Spec 4 (fail-list three times):
  WARN, WARN, then `unresolved provider_unreachable`; slot
  `failed`/`send_unconfirmed`, `stats.unconfirmed` 1, finalize `failed` with
  "Couldn't confirm any text went out". Spec 3 is the pass's `rejected` arm,
  not the reconcile. A throw inside the job is never redelivered on the lane
  (T10-11).

## Residues for the issue registry (line numbers at 9db8fa22)

1. Lost audit row: an adoption that dies between the row append and the slot
   write loses the `message_sent` audit row (the redelivery dedupes, and the
   audit row is written only for a fresh append; broadcastFanOut.ts:1361).
2. Legacy relay re-runs report `adopted`: the legacy statement cannot tell a
   same-status write from a move, so a redelivered adoption re-emits and
   re-WARNs; harmless (sendReconcile.ts:642; the legacy statement at
   messagesRepo.ts:4016-4075).
3. Wrong conversation after a phone change: a known-SID broadcast adoption
   whose row was never appended (SendAcceptedNotRecordedError) files the row
   by the contact's CURRENT phone (broadcastFanOut.ts:1295); a number change
   between the send and the adoption would put it in the new number's
   conversation.
4. Record left for the sweeper when the owner cannot be resolved
   (sendReconcile.ts:371-377).
5. `markRedriven` then death before the enqueue leaves the record `redriven`
   with no re-drive (the D14 class; sendReconcile.ts:1041-1052); a
   redelivered check exits superseded.
6. A relay adoption with its row or slot gone throws (sendReconcile.ts:639):
   it retries on SQS and dies on the lane with the record still `reconciling`.
7. A contact member off the roster is ruled `digest_mismatch`, the
   conservative choice (sendReconcile.ts:497-502).
8. The accepted A10 residues: R1 the read-then-write inbox touches
   (broadcastFanOut.ts:1381, sendReconcile.ts:688); R2 the receipt window
   between `claimRelaySidPointer` and `adoptRelayRecipientIfUnsent`
   (sendReconcile.ts:628-638); R3 the eventually consistent roster read
   (sendReconcile.ts:458).
9. Duplicate chains, duplicate ERRORs: two duplicate chains that both pass
   the state check can each log their own unresolved ERROR
   (sendReconcile.ts:886-893).
10. A malformed payload is not deleted as poison: it retries 5 times and then
    goes to the DLQ (sendReconcile.ts:205-217), the same as the other
    handlers' parse throws.

## Decision-bearing lines for the mutant pass (at 9db8fa22)

sendReconcile.ts: :213 checkNo range; :386 superseded; :393 A7; :396
recordCheck; :400 known SID vs lookup; :418 the status afterClose receives on
found; :451, :467 key by hash; :502 the phone# fallback; :519, :521 matches;
:531, :532 sameFingerprint; :547 syssid; :555-556 relay pointer mine; :564 a
sid# row is mine only for a broadcast owner; :629 relay claim other; :631
failures carry codes; :639 missing throws; :642-643 emit/touch/WARN only when
adopted; :688 rung touch forward-only; :708 held elsewhere -> no fetch; :712
undefined throws; :732 last check; :734 no_sender; :736 digest; :739 60 s
lead; :745 attemptKey identity; :758 page size; :768 window filter; :771 page
bound; :776 oldest first; :779 sibling SIDs; :781 holders excluded; :782
unmatched only when free; :788 mine but lost; :799 continue; :800
unidentified_candidate; :804 same_fingerprint_sibling; :833 leg emits only
when closed; :870 root emit status; :886 slot before record; :916 reconciling
vs redriven; :920-921, :928 T10-14; :952, :966 re-drive attempt; :992-995
refusals; :1012 redrive_refused slot first; :1041-1042 second_unknown.
broadcastFanOut.ts: :1137 consistentRead; :1238, :1240 isBroadcastRowFor;
:1297 automated; :1299 failure statuses; :1318 recipient_contact_id; :1320,
:1330 dedupe -> other_owner; :1334 slot mapping; :1349 carrierSentAt; :1352,
:1354 queued prior / not moved -> skipped; :1361 audit only on a fresh
append; :1381 forward-only touch; :1394 property-sent rows; :1403 30005/30006
flag. The carried fix: messagesRepo.ts:4052 and harness :1726.

## Concerns

1. Deviation 1 (the stricter match rule and its mirror) changes D13's text.
   It is safe-direction only, but the planner should adjudicate it.
2. Residue 3 is the only wrong-conversation risk seen; it needs a phone
   change within seconds of a send that landed unrecorded.
3. S2c concern 2 has a reconcile twin: an `unresolved` close over a relay slot
   that already holds a sid leaves the slot `queued`+sid while the record
   reads `unresolved`. The close is correctly refused; only the record's
   outcome word is off.
4. The integration test uses the harness's in-memory audit, activity and
   listing-send repos; only the messages, broadcasts, contacts, conversations
   and send-attempts repos are real.

## Orchestrator checkpoint and adjudication

Verified at 9db8fa22: protected files untouched; 0 non-ASCII bytes in the
added lines; no `putJobExecutionMarker` call in `sendReconcile.ts` (a comment
only); `npm run typecheck` EXIT=0 with 0 `error TS`; `npm run smoke` EXIT=0
(1477 specifiers across 258 files); whole app workspace EXIT=0 (383 files,
7550 passed, 1 skipped, 0 `[dynamoAdmin]`). Read in full: `runCheck`,
`resolve`, `currentPhone`, `matches`, `sameFingerprint`, `heldBy`, `adopt`,
`adoptRelay`, `adoptKnown`, `lookup`, `closeSlot`, `afterClose`.

Adjudication of deviation 1: ACCEPTED. The spec's own short-body rule ("the
media count must match instead") would adopt Twilio's STOP auto-reply for an
emoji-only text with no media (media count 0 = 0) - exactly the adoption D13
and Sec 11 forbid - and a caption shared by a text and an MMS would let the
two adopt each other and one re-drive. Requiring the media count for every
body, and a short record to match only a short candidate, moves outcomes only
toward `unresolved`; recorded as a spec-text deviation for the handback.
Concern 3 joins S2c concern 2 as review item R-c2.
