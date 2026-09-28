# S2 report - retry-send adoption, plan Tasks 2 and 3 (the reconcile's fourth owner, the lineage exclusion)

Implementer: Claude Opus 5.5 (1M context), 2026-09-28. Worktree
`W:\tmp\retry-send-adoption`, branch `feat/retry-send-adoption`, on top of
`802a36c3`. Scope: plan Task 2 (Steps 1-5) and Task 3 (Steps 1-3), with build
worklist items 4-11. Task 4 (the job) NOT started. Status: DONE. Line numbers
below are at `c506bd1c` (the last code commit).

## Commits

| hash | subject |
|---|---|
| `1dc83cf9` | feat(reconcile): the retry_send owner kind at every key, ref, parser and log site; every owner switch exhaustive (retry-send-adoption T2, steps 1-2) |
| `be8ea0aa` | feat(reconcile): the retry_send owner's reconcile - adopts the retry row with its lineage, root and share attribution; re-drives once inside the window with the promise refreshed; withdraws the promise on unresolved (retry-send-adoption T2, steps 3-4) |
| `c506bd1c` | feat(reconcile): a retry attempt's predecessors - the records that produced its retry_of ancestry and the share root's own record - are lineage, never siblings (retry-send-adoption T3) |
| (this file) | docs commit, recorded by its own hash in git log |

Every code commit left `npm run typecheck` at 0 and the listed suites green.
Worklist item 4 was taken literally: commit 1 wired the types, keys, parser,
logs, `resolve` and `currentPhone`, and stubbed the adoption / close /
afterClose / re-drive arms with a throw (no job produces the owner yet);
commit 2 replaced every stub. TDD per step: each new test was run RED first
(the log of each red run is in the gitignored `.superpowers/sdd/s2-*-red.log`).

## What was built, per plan step

**T2 Step 1 - failing key-shape and parser tests.**
- `app/test/sendAttemptsRepo.integration.test.ts:92` - the key case: `ownerKey`
  is `retry#conv-1#T#SMa#2`; `attemptKey` with a contact key and with a phone
  key (hash only); two owners differing only in `retryRoot` are ONE record;
  another attempt or another retried row is another record.
- `app/test/sendReconcile.test.ts:3872` - a `retry_send` reference round-trips
  through `toOwnerRef` -> JSON -> `parseSendReconcilePayload` (numeric attempt,
  root carried, key only as its hash, contact and phone keys); `:3898` - the
  parser refuses attempt 0, MAX+1, '1', 1.5, a missing attempt/root/id, an
  empty root or hash; `:3857` the phone-hash table gains the fourth kind.
- `app/test/sendReconcile.test.ts:3068` - `ownerLog` / `ownerRefLog` rendering,
  driven through real log lines (both helpers are module-private): the
  superseded line (ownerLog) and the not-found line (ownerRefLog) both carry
  `{ kind, conversationId, retriedTsMsgId, attempt: '2', retryRoot }`; a
  phone-keyed attempt logs `phone#redacted`; no line carries the phone or a
  `phonehash#`.

**T2 Step 2 - union, keys, ref, parser, logs, narrowings, ternaries.**
- `app/src/repos/sendAttemptsRepo.ts:64` the owner member (doc: keyed on the
  retried row + attempt, root is a fact); `:169` `ownerKey` arm `:177`
  (`retry#<conversationId>#<retriedTsMsgId>#<attempt>`) + never default `:182`;
  `:188` `recipientKeyOf` is now a switch, arm `:195`, never default `:198`.
- `app/src/jobs/sendReconcile.ts:138` the ref member; `:157` `RetrySendOwner`;
  `:165` `unhandledOwner(owner: never): never` (the never default every owner
  switch here ends with); `:177` `toOwnerRef` arm `:195`; `:236` `parseOwnerRef`
  arm `:257` (integer attempt in 1..MAX_SEND_RETRY_ATTEMPTS, imported from the
  leaf `../lib/retrySendWindow.js`); `:369` `RelayOwner` and `:372`
  `relayRowKey` narrowed to it; `:963` `adoptRelay`'s owner param narrowed to
  it; `:455` `ownerRefLog` arm `:463`; `:478` `ownerLog` arm `:486` (attempt
  stringified - the return type is `Record<string, string>`).
- `app/src/jobs/sendReconcile.ts:586` `resolve` arm `:619` (the retried row by a
  consistent read, the thread eventual, the recipient key RE-DERIVED with
  `retryRecipientKey` and its hash compared - a mismatch or an underivable key
  returns undefined); `:653` `currentPhone` arm `:671` (the thread's
  participant phone). Landed here, not in Step 4, because the Step 1
  log-rendering test needs `resolve` (see Deviations).
- Harness `app/test/helpers/twilioWebhookHarness.ts:4459` `attemptRecipientKey`
  is a switch with a never default (arm `:4466`), mirroring the repo.
- Test ternaries: `app/test/sendAttemptsRepo.integration.test.ts:301`,
  `app/test/twilioWebhookHarnessSendAttempts.integration.test.ts:238` and
  `:550` gain the `retry_send` branch.

**T2 Step 3 - failing reconcile tests** (`app/test/sendReconcile.test.ts`, a new
`describe('retry_send owner (retry-send-adoption R4)')` at `:3015` with the
plan's helpers `seedOneToOne` `:3023`, `seedRow` `:3036`, `rOwner` `:3055`,
`retryRow` `:3062`, `persistedFor` `:3064`, plus `notFoundLines` `:3066`):
10 `:3095`, 10a `:3154`, 10b `:3182`, 10b2 `:3203`, 10c `:3231`, 10c2 `:3247`,
10d `:3266`, 10e `:3285`, 10f `:3314`, 10g `:3331`, 10h `:3362`, 11 `:3393`,
11a `:3424`, 11b `:3460`, 11c `:3473`, 12 `:3505`, 12a `:3554`, 12a2 `:3577`,
12b `:3604`, 12c `:3617` (worklist item 8's case-20 recipe), the pure
`isBroadcastRowFor` guard `:3792`, and the heldBy holder-label pin
`:3800` (worklist item 10). DynamoDB Local: `sendAttemptsRepo.integration.test.ts:368`
(claim, re-arm, hand-off with a SID, listed beside a broadcast attempt to the
same digest and sender, the raw record's `owner` map carries exactly the six
fields, no phone in either key). Parity: the siblings case
`twilioWebhookHarnessSendAttempts.integration.test.ts:401` gains the fourth
owner and drives it through claim, re-arm, hand-off, a refused re-claim and
the unresolved close.

**T2 Step 4 - the reconcile's owner** (`app/src/jobs/sendReconcile.ts`):
- `heldBy` `:723`: the relaysid# branch names the two relay kinds; the sid#
  branch now asks `rowIsMine` `:755` (an exhaustive switch: broadcast ->
  `isBroadcastRowFor`, relay -> false, retry_send -> `isRetryRowOf` `:776` =
  same thread AND `retry_of === retriedTsMsgId` AND `retry_attempt === attempt`)
  and labels the holder with `rowHolder` `:787` (`broadcast#...` only for a row
  with `broadcast_id` and NO `retry_of`; else `message#<conv>#<ts>`).
- `adopt` `:799` (arm `:819`) -> `adoptRetry` `:850`: the plan's field set;
  media from the attempt's facts (`facts.mediaCount > 0`: attachments, else raw
  `mediaUrls`, else nothing); `recipient_contact_id` via `contactOf` +
  `isDeleted` + `contactHoldsPhone`; dedupe re-read -> `isRetryRowOf` ->
  `skipped` or `other`; audit only on a fresh append; status-preserving touch;
  `message.persisted` (+ `conversation.updated` when touched); WARN on an
  adopted terminal failure. No promise write.
- `closeSlot` `:1290` arm `:1308`: `withdrawRetryPromise` on
  `SEND_UNCONFIRMED_CODE` only (redrive_refused / enqueue_failed write nothing).
- `afterClose` `:1338` arm `:1363`: the retried row's `message.persisted` in its
  own direction and status.
- `enqueueRedrive` `:1465` arm `:1501`: `enqueueSendRetry({ providerSid:
  r.row.provider_sid, conversationId, attempt }, new Date())` - no `deferred`.
- `redriveRefusal` `:1528` (now a switch) arm `:1539`: the window first,
  `retryFitsSendWindow({ originMs, nowMs, backoffMs: 0 })`, fail-open on no
  origin; `retried_row_not_found` when the row is missing (unreachable:
  `resolve` fails first).
- `closeRedriveRefused` `:1565`: ERROR when the cause is
  `retry_window_closed` (`:1581`), WARN otherwise, same message text.
- `redrive` `:1595`: `refreshRetryPromise(..., now + RETRY_JOB_GRACE_MS +
  RETRY_PROMISE_GRACE_MS)` only when `enqueueOrClose` answered true (`:1619`).
- `app/src/jobs/broadcastFanOut.ts:1299` `isBroadcastRowFor`: `retry_of` joins
  the Pick and `:1303` returns false first (deviation 7).
- Imports (worklist item 6, all present): `toConversationUpdatedEvent`,
  `TRANSPORT_SCHEMA_VERSION`, the retrySendWindow leaf constants and helpers
  (MAX_SEND_RETRY_ATTEMPTS from the leaf, never `./retrySend.js`),
  `contactHoldsPhone`, `isDeleted`, `mediaAttachmentsOf`, `retryRecipientKey`,
  `automaticAncestry`, `refreshRetryPromise`, `withdrawRetryPromise`, and
  `enqueueSendRetry` from `./retrySend.js` (`:134`, used only inside
  `enqueueRedrive` - the header's import-cycle note `:45` now names it).

**T3 Steps 1-2 - the lineage exclusion.** `predecessorMatchers` `:1080` (the
plan's body: automatic-ancestry producers matched by owner fields, plus the
share root's own broadcast record for this recipient key; `[]` and no reads
for every other owner) and the filter in `lookup` (`:1136` computes the
matchers before the single sibling read, `:1139` filters). Tests: 13 `:3641`,
13a `:3670`, 13a2 `:3683`, 13a3 `:3697`, 13b `:3711`, 13c `:3729`, 13d `:3761`,
13e `:3774` (helpers `shareRecord` `:3662`, `manualChainAdopted` `:3747`).
The positives 13, 13a, 13c, 13d were red before the implementation; 13a2,
13a3, 13b, 13e are over-exclusion guards that assert BLOCKING, so they pass
before and after by construction.

## Owner-kind dispatch sites covered (complete)

`sendReconcile.ts`: the ref union `:138`; `toOwnerRef` `:177`; `parseOwnerRef`
`:236`; `relayRowKey` `:372` and `adoptRelay` `:963` (narrowed); `ownerRefLog`
`:455`; `ownerLog` `:478`; `resolve` `:586`; `currentPhone` `:653`; `heldBy`
`:723` (both branches) with `rowIsMine` `:755`; `adopt` `:799`; `closeSlot`
`:1290`; `afterClose` `:1338`; `enqueueRedrive` `:1465`; `redriveRefusal` `:1528`;
`closeRedriveRefused` `:1565`; `redrive` `:1595`; `lookup`'s sibling filter
`:1136-1150`. Generic and unchanged, verified: `slotCloseOf` (outcome-keyed,
takes no owner - deviation 5), `closeUnresolved` (record, ERROR, closeSlot,
afterClose - already R4's order), `enqueueOrClose`, the superseded exit `:529`,
`parseContinuation` (this owner carries none). `sendAttemptsRepo.ts`: the union
`:64`, `ownerKey` `:169`, `recipientKeyOf` `:188`. `broadcastFanOut.ts`:
`isBroadcastRowFor` `:1299`. Harness: `attemptRecipientKey` `:4459`. Tests:
the three ternaries above.

Every `switch` on the owner kind now ends in a never default: 11 in
`sendReconcile.ts` (via `unhandledOwner`), 2 in the repo, 1 in the harness.

Beyond the plan/research list:
- `redriveRefusal` was an if-chain the plan extended "before the relay
  checks"; it is now an exhaustive switch (the relay checks unchanged, in
  their order), so a fifth kind is a typecheck error there too.
- `heldBy`'s sid# branch silently returned `other` for any non-broadcast kind;
  it is now the exhaustive `rowIsMine`.
- `runCheck` `:539` and `adoptKnown` `:1049` changed only because `adopt` now
  takes the attempt's facts (Deviation 4); `contactOf` `:647` is reused by the
  adoption (doc updated).
- The HEAD sweep (grep `owner.kind`, `.kind ===`, `SendAttemptOwner`,
  `relay_rung` over the repo) found no other production dispatch:
  `broadcastFanOut` / `relayFanOut` / `relayRetryLeg` only use owners narrowed
  to their own kind, `lib/sendAttemptGate.ts` is kind-agnostic, and the
  remaining hits are test-local literals.

## Deviations from the plan / worklist (all deliberate)

1. The never default is ONE helper, `unhandledOwner(owner: never): never`
   (`sendReconcile.ts:165`), called as `default: return unhandledOwner(x)` in
   all 11 switches, instead of the inline `const unhandled: never = x; throw`
   repeated 11 times; the repo (2 sites) and the harness keep the inline form.
   Same compile-time guarantee (a missing arm makes the argument non-never:
   TS2345). Verified in a scratch compile: the literal
   `const unhandled: never = owner.kind` (the relayFanOut shape) does NOT
   compile when the switch narrows the owner object itself (TS2339), so every
   form here binds the owner and reads `.kind` through a cast for the message.
2. `redriveRefusal` became a switch (see above).
3. `heldBy`'s sid# branch factored into `rowIsMine` + `rowHolder` +
   `isRetryRowOf` (the adoption's dedupe check shares `isRetryRowOf`); the
   broadcast and relay behavior is unchanged (the existing broadcast and relay
   suites pass unmodified).
4. `adopt` threads the attempt's facts - `adopt(c, r, facts, m)`,
   `adoptKnown(c, r, facts, sid)` - instead of `adoptRetry` re-reading the
   record with `c.attempts.get(o)` (the plan sketch). Same value (an attempt's
   facts are written by its claim and never change while it reconciles; the
   lookup matched `m` against exactly these facts), one consistent read fewer.
5. The adoption's contact read is `contactOf(c, r)` -
   `getById(key, { consistentRead: true })`, cached on `r.contact` - not the
   sketch's uncached eventual `c.contacts.getById(r.key)`; it matches the
   broadcast adoption (pinned by case 1c) and is skipped for a phone key or a
   phone-less thread (neither can yield a recipient).
6. `closeRedriveRefused` logs the SAME message at both levels (ERROR for the
   window close, WARN otherwise); `cause` tells them apart, and a grep on the
   message still finds both.
7. Log shape: the adoption's own lines (audit / touch failures, the
   terminal-failure WARN) use the reconcile's nested convention
   (`event: 'send_reconcile'`, `owner: ownerLog(o)`, `recipientKey`, `sid`)
   rather than the sketch's flat `...ownerLog(o)`; the ctx handed to the two
   promise writes keeps the plan's flat `{ ...ownerLog(r.owner) }`.
8. Commit split per worklist item 4 (stubs in commit 1), with `resolve` and
   `currentPhone` wired in commit 1 rather than Step 4, because the Step 1
   log-rendering test drives both log helpers through `resolve`.
9. Tests beyond the plan's list, each pinning a rule the listed cases could
   not: the log-rendering case (Step 1 asked for the rendering; the helpers are
   private, so it goes through log lines); 10b2 (the media half of 10b, split
   out); 10c2 (10c alone cannot tell `free` from `other` - a free twin would
   dedupe onto the root and ALSO read as `other`; 10c2 gives the twin another
   fingerprint, where `free` would become `unidentified_candidate`); 10f (a
   known SID on another row: label + withdrawal); 10g (a dedupe onto another
   lineage writes nothing); 10h (adopted terminal failure WARN + a code-free
   success); 13a2 (the plan's 13a second half, split so the first half's
   `redriven` record cannot mask it); 13a3 (the same share's record for
   another contact on the number still blocks - pins the `contactKey`
   clause); 13d/13e (the manual-row stop as a positive + guard pair; the
   plan's 13c named it without a case); redelivered-verdict halves in 11, 11a,
   11c and a third "already withdrawn" delivery in 12.
10. Mutation checks (temporary edits, restored byte-identical with `cmp`):
    dropping `rowHolder`'s `retry_of` clause turns the worklist-10 pin red;
    dropping the share matcher's `contactKey` clause turns 13a3 red. Belts no
    valid data can reach are named, not tested: the `attempt` clause of
    `isRetryRowOf` and of the predecessor matcher (plan deviation 1: the
    webhook schedules one attempt number per retried row) and the
    `retried_row_not_found` refusal (`resolve` fails first).

## Verification (bare commands, from the worktree)

- Baseline before any edit, the 8 listed files: 602 passed.
- `cd app; npx vitest run test/sendReconcile.test.ts test/sendAttemptsRepo.integration.test.ts test/twilioWebhookHarnessSendAttempts.integration.test.ts test/broadcastFanOut.test.ts test/relayFanOut.test.ts test/relayRetryLeg.test.ts test/retryChain.test.ts test/retryPromiseWrites.test.ts`
  -> 8 files, 637 passed, 0 skipped (DynamoDB Local reached): sendReconcile
  151 (was 118, +33), sendAttemptsRepo 43 (+2), harness parity 15 (one case
  extended), broadcastFanOut 109, relayFanOut 152, relayRetryLeg 134,
  retryChain 22, retryPromiseWrites 11. After commit 1: 607; after commit 2:
  629.
- Neighbours (not required): `npx vitest run test/sendReconcile.integration.test.ts test/twilioStatusWebhook.test.ts test/registerHandlers.test.ts`
  -> 3 files, 85 passed.
- `npm run typecheck` -> exit 0 (after each commit).
- `npm run smoke` -> exit 0, "1496 import specifier(s) across 264 emitted
  file(s) resolve under plain Node" (the new `sendReconcile -> retrySend`
  edge). No module under `retrySend` imports `sendReconcile` yet, so the edge
  closes no cycle today; Task 4 closes it, and the use is inside a function.
- `npx eslint` on the 7 touched `.ts` files -> exit 0, no output (no
  pre-existing errors in them either).
- ASCII: the branch's added lines under `app/` since `802a36c3` carry 0
  non-ASCII bytes; this report prints 0 on the `tr` check.
- Fences: no diff in `twilio.ts`, `jobs.ts`, `sqsJobConsumer.ts`,
  `oneToOneRetryDecision.ts`; no +/- line names `putJobExecutionMarker`.
- NOT run (per the brief): the full `npm test`, `npm run e2e`, any e2e session.

## The contract Task 4 (the job) must honor

The owner (`sendAttemptsRepo.ts:64`, `RetrySendOwner` at `sendReconcile.ts:157`):
`{ kind: 'retry_send', conversationId, retriedTsMsgId, attempt, recipientKey, retryRoot }`.
- `retriedTsMsgId` = the row read by `payload.providerSid`; `conversationId`
  MUST equal that row's `conversationId` (the reconcile reads the row by
  `(ref.conversationId, ref.retriedTsMsgId)` and the thread by the same id -
  a mismatch is unaddressable and strands the record).
- `attempt` = `payload.attempt`, an integer in 1..3 (the parser throws
  otherwise, `sendReconcile.ts:257`).
- `recipientKey` = `retryRecipientKey(retriedRow, conversation)` - the SAME
  function over the same rows: `resolve` re-derives it and compares hashes
  (`sendReconcile.ts:619`). Never carried in the retry payload.
- `retryRoot` = `resolveRetryRoot(messages, retriedRow)`; a fact, not a key.

The hand-off: `enqueueSendReconcile({ owner: toOwnerRef(owner), attemptedAt,
checkNo: 0 }, reconcileDelayMs(attemptedAt, 0, now))` with NO `continuation`.
The ref is `{ kind, conversationId, retriedTsMsgId, attempt, retryRoot,
recipientKeyHash }` (`sendReconcile.ts:195`). Import these from
`./sendReconcile.js` and use them only inside functions (the cycle rule).

The record's facts, as the reconcile reads them:
- `sender`: the number the provider call pins - `pinnedSender(config)` (what
  `sendMessage` pins for a one-to-one send). Absent -> every check closes
  `unresolved` / `no_sender` and WITHDRAWS (the unpinned-dev residue).
- `recipientDigest`: `recipientDigest(sender, conversation.participant_phone)`
  - the THREAD's number; `currentPhone` re-reads it (`sendReconcile.ts:671`).
- `bodyHash` / `bodyShort`: `bodyFingerprint(retriedRow.body)`.
- `mediaCount`: `planRetryMedia(retriedRow, hasStore).mediaCount` - the lookup
  matches only `m.mediaCount === record.mediaCount`, and the adoption attaches
  media only when it is > 0 (deviation 9).
- `sid`: via `handToReconcile(owner, ref, sid)` ONLY for
  `SendAcceptedNotRecordedError` (known-SID path: a free SID is fetched and
  adopted fresh).

What the job's own send must stamp so a takeover's reconcile repairs it: the
row `sendMessage` appends needs `retry_of = retriedRow.tsMsgId` and
`retry_attempt = payload.attempt` in the owner's conversation - `isRetryRowOf`
(`sendReconcile.ts:776`) is the whole `mine` test; any other row is `other`.

What the reconcile writes back:
- found: record `done/adopted` + sid; a fresh retry row (lineage, root,
  share attribution, audit, touch, emits); NO promise write.
- never_sent inside the window: `markRedriven`, then ONE immediate
  `messaging.retrySend` `{ providerSid: retriedRow.provider_sid,
  conversationId, attempt }` (no `deferred`), then REFRESH the retried row to
  `now + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS` (only if the enqueue
  went out) with its `message.persisted`.
- never_sent outside the window: `done/redrive_refused`, cause
  `retry_window_closed`, ONE ERROR, no promise write.
- the re-drive enqueue throws: `closeRedriven(enqueue_failed)`, ONE ERROR, no
  promise write, no `retry_outcome`.
- unresolved (any cause, including `second_unknown` when a `redriveCount 1`
  attempt comes back to `never_sent`): record FIRST, ONE ERROR, then the
  WITHDRAW (sentinel + `retry_outcome: 'unconfirmed'`, one conditional write,
  retried once), then the retried row's emit; a redelivered check re-applies
  the WITHDRAW idempotently.
- unaddressable (row gone, key underivable or hash mismatch): INFO, record
  untouched (the sweeper's).

What the reconcile assumes of the re-driven job: it claims from `redriven`
(attemptNo + 1, `redriveCount` stays 1, so its `secondUnknownWouldClose` is
true); a decline BEFORE its claim (a manual child, the window closed at job
time) must `closeRedriven(refused, cause)` - the reconcile never revisits a
`redriven` record (Review Focus 5); the reconcile's REFRESH and the re-driven
job's own REFRESH may race - one conditional write loses and is dropped at
INFO (worklist item 26). In a test that drives the real re-drive, register the
REAL job handler (not `recordJobs`) - the re-drive is an immediate enqueue.

Log shape the job and T8 can rely on: every reconcile line for this owner has
`event: 'send_reconcile'` and `owner: { kind: 'retry_send', conversationId,
retriedTsMsgId, attempt: '<n>' (a STRING), retryRoot }`, `recipientKey`
redacted, `checkNo`; the promise-write lines from the reconcile carry the flat
`ownerLog` fields. `SendReconcileJobDeps` gained nothing.

## Notes for later tasks (not S2's to fix)

- T5: a `done/redrive_refused` record (the window close) is `done` and not
  `unresolved`, so R6's guards let the press through - consistent with "Retry
  stays available"; R6's text lists `refused` but not `redrive_refused`.
- T9 / handback: `closeUnresolved`'s shared ERROR text says "closed
  send_unconfirmed"; for this owner that means the promise was withdrawn (there
  is no slot). Not reworded (shared by every owner). Worklist item 25's
  rollback hazard stands as written and is unchanged by this slice: the
  pre-branch `recipientKeyOf` answers undefined for a `retry_send` owner (so
  `hashRecipientKey` throws) and the pre-branch `parseOwnerRef` rejects the
  kind - drain `send.reconcile` before a rollback.
