# Reader B - the reconcile job and the repos (findings)

Read-only research for the implementation plan of
`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md` (revision 5).
Worktree `W:\tmp\retry-send-adoption` at `656d04a4`; code identical to
`main@3dbb5740`. Byte-exact quotes for everything cited here are in the
companion reference `.superpowers/sdd/research/reader-b-reference.md`
(gitignored; section numbers below match it). Every spec line number in R4
was checked and holds at HEAD.

## 0. Headline

- NO owner switch in `sendReconcile.ts` has a `never` default (not only
  `closeSlot`). Under `strict` (no `noImplicitReturns`) a missing `retry_send`
  arm fails typecheck only where the return type excludes `undefined`/`void`
  (`toOwnerRef`, `ownerRefLog`, `ownerLog`, `adopt`, repo `ownerKey`). It is
  SILENT in `resolve`, `currentPhone`, `closeSlot`, `afterClose`,
  `enqueueRedrive` and the `redriveRefusal` if-chain - `enqueueRedrive` would
  enqueue nothing after `markRedriven` committed (a stranded `redriven` record
  under a WARN saying "re-driven once").
- Sites the spec misses: `adoptRelay`'s `Exclude<..., broadcast>` param
  (`:654`), `heldBy`'s inline narrowing (`:584`), `recipientKeyOf`
  (`sendAttemptsRepo.ts:163-165`), the harness `attemptRecipientKey`
  (`twilioWebhookHarness.ts:4409-4410`) and three test ternaries
  (`sendAttemptsRepo.integration.test.ts:278`,
  `twilioWebhookHarnessSendAttempts.integration.test.ts:237`, `:534`) - all
  typecheck errors once the union grows (`app/tsconfig.test.json` includes
  `test`).
- `slotCloseOf` (`:922`) switches on the OUTCOME and takes no owner; the
  WITHDRAW belongs in `closeSlot`'s `retry_send` arm, keyed on the code.
- `append` returns `{ deduped: boolean; tsMsgId; conversationId }`
  (`messagesRepo.ts:1261-1273`), no fresh/skipped/other union.
- The `sid#` Put is CONDITIONAL and a dedupe cancels the whole transaction:
  nothing is "re-put". Message rows carry NO `expires_at`. A `retrychild#`
  item exists only from the winning append; pre-deploy rows have none.

## 1. Owner-dispatch sites (sendReconcile.ts unless noted)

Kinds today: `broadcast`, `relay_leg`, `relay_rung` (`sendAttemptsRepo.ts:50-53`,
ref twin `sendReconcile.ts:113-116`). "TS" = a missing arm is a typecheck
error; "SILENT" = it compiles and misbehaves.

| site | line | shape / never default | missing arm today | retry_send must (spec R1/R4) |
|---|---|---|---|---|
| `toOwnerRef` | 126-145 | switch, no default | TS (returns `SendAttemptOwnerRef`) | `{kind, conversationId, retriedTsMsgId, attempt, retryRoot, recipientKeyHash: hashRecipientKey(owner.recipientKey)}` |
| `parseOwnerRef` | 174-198 | switch + `default: throw` (runtime) | throws "owner.kind is not a send-attempt owner" | `requiredText` for the three ids; `attempt` needs a NEW integer check (1..MAX_SEND_RETRY_ATTEMPTS) - `requiredText` is string-only |
| `parseContinuation` | 200-207 | none | n/a | unchanged |
| `relayRowKey` | 280-282 | ternary over `Exclude<SendAttemptOwner,{kind:'broadcast'}>` | TS (`retryTsMsgId`) | narrow the param to the two relay kinds |
| `adoptRelay` param (MISSED) | 651-656 | same `Exclude` | TS at `:657` | narrow likewise |
| `ownerRefLog` | 363-372 | switch, no default | TS | ids + retryRoot; return type is `Record<string,string>` - stringify `attempt` or widen |
| `ownerLog` | 375-384 | switch, no default | TS | same |
| `resolve` | 473-507 | switch, no default | SILENT: `undefined` -> INFO "owner recipient not found - left for the sweeper" | consistent read of the retried row (`getByTsMsgIdConsistent(conversationId, retriedTsMsgId)`); `conversations.getById` (eventual); derive key (`recipient_contact_id` else `phone#<participant_phone>`); compare `hashRecipientKey(key)` to the ref; fill `Resolved.row` + `.conversation` |
| `currentPhone` | 516-535 | switch, no default | SILENT: `undefined` -> `digest_mismatch` | `r.conversation.participant_phone` |
| `heldBy` | 577-611 | if-chain: relaysid branch `o.kind !== 'broadcast'` (:584); sid# row branch `r.owner.kind === 'broadcast'` (:595) | TS at :585 (`relayConversationId`); sid# branch SILENT -> `other` | relaysid branch: name the two relay kinds; sid# row branch: mine = `row.retry_of === retriedTsMsgId && row.retry_attempt === attempt` (suggest also `row.conversationId === owner.conversationId`) |
| `adopt` | 614-635 | switch, no default | TS | new `adoptRetry` (section 4) |
| `slotCloseOf` | 922-933 | switch on OUTCOME, `default` undefined | not owner-dispatched | leave; map in `closeSlot` (below) |
| `closeSlot` | 936-955 | switch, no default | SILENT no-op | code `SEND_UNCONFIRMED_CODE` -> WITHDRAW (conditional, retried once from a fresh read); `REDRIVE_REFUSED_CODE` / `ENQUEUE_FAILED_CODE` -> nothing |
| `afterClose` | 967-993 | switch, no default | SILENT | emit `message.persisted` `{conversationId, tsMsgId: retriedTsMsgId, direction: row.direction, deliveryStatus: row.delivery_status}`; no finalize, no root close |
| `closeUnresolved` | 1003-1024 | generic | - | order already fits R4: record close -> ERROR -> closeSlot (WITHDRAW) -> afterClose; note it passes `'failed'` to afterClose - use the row's own status |
| `enqueueRedrive` | 1078-1115 | switch, no default | SILENT: nothing enqueued after `markRedriven` | `enqueueSendRetry({ providerSid: r.row.provider_sid, conversationId, attempt }, new Date())` - no `deferred` |
| `redriveRefusal` | 1123-1130 | if-chain | SILENT WRONG: falls into the relay checks (status/roster/row) | window first: `retryFitsSendWindow({ originMs, nowMs, backoffMs: 0 })`, origin = `parseRetryWindowOrigin(oneToOneRetryWindowOrigin(r.row))`; outside -> `'retry_window_closed'` (spec silent on a missing origin; RSW D5 says fail open) |
| `closeRedriveRefused` | 1140-1160 | generic | - | logs WARN; R4/R9 want ONE ERROR for the window close |
| `redrive` | 1170-1195 | generic | - | `:1194` discards `enqueueOrClose`'s boolean; R4's REFRESH must run only on `true` |
| superseded exit | 415-419 | generic | - | `slotCloseOf` -> `closeSlot` -> `afterClose` re-applies the WITHDRAW on `unresolved` |
| `ownerKey` (repo) | SA 152-161 | switch, no default | TS | `retry#<conversationId>#<retriedTsMsgId>#<attempt>` |
| `recipientKeyOf` (repo, MISSED) | SA 163-165 | ternary | TS (`memberKey`) | `owner.recipientKey` |

`never` idiom to copy: `relayFanOut.ts:1432-1435`. `grep owner.kind` found no
other production site (the fan-outs only `Extract` their own kind).

## 2. The D13 lookup as built (`lookup`, :765-907)

- Window, two-sided, both edges inclusive: `[attemptedAt - 60 s, attemptedAt + 90 s]`
  (`RECONCILE_WINDOW_LEAD_MS` 60 000; `TRAIL` = `SEND_CLAIM_TTL_MS` 30 000 + LEAD;
  `:777-779`, filter `:847`).
- Match (`matches`, :552-554): `m.mediaCount === record.mediaCount &&
  bodyFingerprint(m.body).hash === record.bodyHash` for every body
  (`bodyShort` decides nothing).
- Siblings (:787-796): ONE `listByRecipient(sender, record.recipientDigest,
  attemptMs - SPAN)` (lower bound only - residue 17), filtered to
  `attemptKey(s.owner) !== self` and start within +-150 s
  (`RECONCILE_SIBLING_SPAN_MS` = 2*60 s + 30 s). Two effects: sibling SIDs are
  skipped as candidates (:863), and `never_sent` is withheld when
  `siblings.some(s => sameFingerprint(s, record) && (s.state !== 'done' ||
  s.outcome === 'adopted'))` (:903) -> `same_fingerprint_sibling`.
- Verdict order at the last check: list error -> `provider_unreachable`; cut ->
  `page_bound`; unmatched -> `unidentified_candidate`; sibling ->
  `same_fingerprint_sibling`; else `never_sent`. Before the last check any miss
  is `continue`.
- The lineage exclusion must be computed ASYNC before the sync `.filter` at
  :790 (the walk reads rows), and must match predecessor records by owner
  FIELDS (`kind === 'retry_send'`, `conversationId`, `retriedTsMsgId ===
  walkedRow.retry_of`, `attempt === walkedRow.retry_attempt`), never by
  `attemptKey` - the predecessor's recipient key is not known here and can
  differ (see trap 8).

## 3. Outcome vocabulary as built

- States `attempting | reconciling | redriven | done`; outcomes `sent,
  rejected, retryable, refused, adopted, never_sent (declared, never written),
  unresolved, enqueue_failed, redrive_refused`. `UnresolvedCause` (:291-300):
  `no_sender, digest_mismatch, provider_unreachable, page_bound,
  unidentified_candidate, same_fingerprint_sibling, sid_held_elsewhere,
  second_unknown, enqueue_failed`. Refusal causes (:1123-1130):
  `no_continuation, group_not_open, member_removed, source_not_found,
  retry_row_not_found`. Slot codes (`sendOutcome.ts:14-19`):
  `send_unconfirmed, redrive_refused, enqueue_failed`.
- Fences (every `transition` writes a fresh `last_op`, SA 453-482):
  `finishAttempt`/`handToReconcile`/`takeOver` on `attempting + no + at`;
  `recordCheck` on `reconciling + at + (ck = n-1 OR n)`; `markRedriven` on
  `reconciling + at + rc = 0`; `closeFromReconcile(owner, attemptedAt,
  {outcome: adopted|unresolved|enqueue_failed|redrive_refused; sid?; cause?})`
  on `reconciling + at`; `closeRedriven(owner, {outcome: refused|
  redrive_refused|enqueue_failed|unresolved; cause?})` on `redriven` only.
- `closeUnresolved`: record FIRST (lost -> INFO, nothing else); won -> ONE
  ERROR, `closeSlot(SEND_UNCONFIRMED_CODE,'unconfirmed')`, `afterClose('failed')`.
- `afterClose`: broadcast -> `finalize` (the flip winner emits
  `broadcast.updated` and writes the `broadcast_sent` unit audit); relay_leg ->
  nothing; relay_rung -> `message.persisted` for its ROOT. `retry_send`: none.

## 4. The broadcast adoption as built (`broadcastFanOut.ts:1341-1479`)

Conversation via `createOrGetByParticipantPhone`; `participantPhone =
conversation.participant_phone ?? contact.phone`. Append: `providerTs =
m.createdAt`, `type` mms iff mediaCount > 0, author `'teammate'`, the
provider's body, `mapTwilioStatus` status, `errorCode` only when
failed/undelivered, `transportSchemaVersion`, `requestedTransport`,
`broadcastId`, `automated`, `recipientContactId` iff `contactHoldsPhone(contact,
participantPhone)`. On `deduped`: consistent re-read by SID +
`isBroadcastRowFor`, else `other_owner`. Slot from `queued` only (`skipped` =
no follow-ups). Audit `('conversations#<id>', 'message_sent', {providerSid,
automated, author})` only when not deduped; touch
`touchLastActivityPreservingStatus(id, undefined, providerTs)` only when
`last_activity_at < providerTs`; emit `message.persisted` then
`conversation.updated` if touched.

`retry_send` deltas (R4): conversation = `owner.conversationId` (no phone
lookup - also avoids residue 2); body + `media_attachments` from the retried
row; ai-or-teammate author; `automated: row.automated ?? true`; `retryOf,
retryAttempt, retryWindowStart, retryRoot, broadcastId`; no slot/finalize.
Spec is ambiguous whether the touch/emit run on a `skipped` (deduped, mine)
adoption - sendMessage already did both for a row it appended; decide.

## 5. The never_sent path as built (`redrive`, :1170-1195)

`redriveRefusal` -> `closeRedriveRefused` (record FIRST, WARN, slot,
afterClose); else `markRedriven`; false with `redriveCount >= 1` ->
`closeUnresolved(second_unknown)`, else INFO; true -> WARN -> `enqueueOrClose(
..., 'redriven', enqueueRedrive)`, whose throw arm is `closeRedriven(
enqueue_failed)` -> ERROR -> `closeSlot(ENQUEUE_FAILED_CODE)` -> `afterClose`.
NO window check exists for any owner in the reconcile (the rung's own job
bounds its re-drive, :1071-1077). No injectable clock (`SendReconcileJobDeps`
has no `now`; `retrySend` has one). `enqueueSendRetry` with `runAt = now` is
`delaySeconds 0` (`jobs.ts:112-114`), an immediate enqueue `recordJobs` sees.

## 6. messagesRepo.append (`:2488-2835`)

- TransactItems: [0] the row, `attribute_not_exists(tsMsgId)`; [1] the SID
  pointer `{ conversationId: 'sid#<sid>', tsMsgId: 'ptr', ref_conversationId,
  ref_tsMsgId }`, `attribute_not_exists(tsMsgId)`; [2] the `emailmsgid#`
  pointer iff `rfcMessageIdPointer` (index 2 is HARD-CODED in the dedupe
  attribution, :2771); then the group due row (conditioned); LAST the media
  pointers (unconditioned; skipped for relay retry rows). No `expires_at` on
  any of them.
- Dedupe = `reasons[1]?.Code === 'ConditionalCheckFailed'` -> consistent
  `getSidPointer` -> `{deduped:true, tsMsgId: ptr.ref_tsMsgId, conversationId:
  ptr.ref_conversationId}`; a CCF elsewhere -> ERROR + rethrow;
  `TransactionInProgressException` retried (3 attempts, 25 ms x n).
- Reads: `getSidPointer` = GetItem `(sid#<sid>, 'ptr')` (consistent on
  request), then the row. Synthetic-partition QUERY idioms: `listMediaPointers`
  (:3263), `listDueRows` (:4260), `listParkedEmailEvents` (:3339), and the
  consistent, paged `sendAttemptsRepo.listByRecipient` (SA 585-615).
- `expires_at` is epoch SECONDS where it exists (`syssid#`, parked events, the
  send-attempt families); message rows and `sid#` pointers have none.

PROPOSAL (R7 pointer family; names are suggestions):

```ts
export function retryChildPk(conversationId: string, parentTsMsgId: string): string {
  return `retrychild#${conversationId}#${parentTsMsgId}`;
}
// in append's TransactItems AFTER the email pointer and the due row, BEFORE the
// media pointers (keeps index 1 = sid#, index 2 = emailmsgid#), UNCONDITIONED
// (the media-pointer precedent: a redelivery cancels on the sid# pointer first):
...(message.retryOf !== undefined
  ? [{ Put: { TableName: table, Item: {
      conversationId: retryChildPk(message.conversationId, message.retryOf),
      tsMsgId,                                   // the child row's SK
      provider_sid: message.providerSid,
      ...(message.retryAttempt !== undefined && { retry_attempt: message.retryAttempt }),
    } } }]
  : []),
// read: listRetryChildren(conversationId, parentTsMsgId) - QueryCommand
// { KeyConditionExpression: 'conversationId = :p',
//   ExpressionAttributeValues: { ':p': retryChildPk(conversationId, parentTsMsgId) },
//   ConsistentRead: true }, paged on LastEvaluatedKey (listByRecipient's loop),
// -> Array<{ tsMsgId: string; providerSid: string; retryAttempt?: number }>.
```

## 7. annotateMessage and the PROPOSAL for annotateRetryPromise

As built (`:3210-3255`): unaliased `SET media_attachments = ..., retry_due_at =
:retryDueAt`, `ConditionExpression: 'attribute_exists(tsMsgId)'`, no
`ExpressionAttributeNames`, UNCONDITIONAL on `retry_due_at`, a CCF (missing
row) is NOT caught (throws), INFO "message annotated". The fake throws a plain
`Error` on a missing row (HN :1469-1475).

PROPOSAL - four branches, each listing exactly the aliases/values it uses:

```ts
annotateRetryPromise(conversationId: string, tsMsgId: string,
  patch: { retryDueAt: string; retryOutcome?: 'unconfirmed' },
  expect: { retryDueAt: string | undefined }): Promise<boolean>;

const withdraw = patch.retryOutcome !== undefined;
const expected = expect.retryDueAt !== undefined;
UpdateExpression:          withdraw ? 'SET #due = :due, #ro = :ro' : 'SET #due = :due'
ConditionExpression:       expected
  ? 'attribute_exists(tsMsgId) AND #due = :expected'
  : 'attribute_exists(tsMsgId) AND attribute_not_exists(#due)'
ExpressionAttributeNames:  { '#due': 'retry_due_at', ...(withdraw && { '#ro': 'retry_outcome' }) }
ExpressionAttributeValues: { ':due': patch.retryDueAt,
  ...(withdraw && { ':ro': patch.retryOutcome }),
  ...(expected && { ':expected': expect.retryDueAt }) }
// true = written; ConditionalCheckFailedException -> false (a moved promise OR a
// missing row); anything else throws. Optional belt (the op-token idea): on a
// CCF, re-read consistently and answer true when the row already holds the
// patch (an SDK replay of a committed write). INFO line with ids + values.
```

Fake twin: find the row (none -> `false`); `item.retry_due_at !==
expect.retryDueAt` -> `false`; else set both fields, `true`.
`MessageItem` gains `retry_root?: string` and `retry_outcome?: 'unconfirmed'`;
`NewMessage` gains `retryRoot?: string`; `append` writes `retry_root` beside
`retry_of` (:2541). `MessageAnnotations` must NOT gain lineage (its comment,
:1233-1236).

## 8. The harness fakes and the parity tests

- The fakes are typed `MessagesRepo` / `SendAttemptsRepo`, so they lack no
  method today; every new method must land in both or typecheck fails.
- Fake `append` (HN :1172-1310) is an explicit ALLOWLIST - `retry_root` must be
  added and pinned in `twilioWebhookHarnessRetryFields.test.ts`, or every
  `retry_root` assertion through the fake passes vacuously. It dedupes on
  `findBySid` alone and models no transaction.
- Fake media pointers are DERIVED from rows (HN :1481-1511). A derived
  `retrychild#` fake would also see rows a test pushes straight into
  `world.messages` (relay tests do), which production would not; a map
  written by `append` mirrors production. "One Query, not a scan" is provable
  only by spying the new method.
- `sendAttemptsRepo` parity (`...SendAttempts.integration.test.ts`): per step,
  the call's answer, `get()` per owner, the world map, WHEN an op token is
  written, `listByRecipient` for two senders x two bounds, and the raw index
  items. Case at :399-413 already mixes three owner kinds - the natural place
  for a `retry_send` owner.
- messages parity (`...RepoAdditions.integration.test.ts`): `messagesAgree`
  (:754-773) compares ONLY row existence, `delivery_recipients` and relay
  pointers - it must be extended for `retry_due_at`, `retry_outcome`,
  `retry_root` and the `retrychild#` partition.

## 9. sendReconcile.test.ts style

Real envelopes over `createFakeWorld()`; self-scheduled checks land in
`outbound.delayed`, re-drives are immediate and drained by `outbound.settle()`.
Helpers: `register`, `recordJobs`, `seedTenant`, `seedBroadcast`, `bOwner`,
`factsFor`, `reconciling(owner, facts, {at?, sid?})`, `payloadOf`, `plant`,
`runCheck`, `runNextCheck`, `runChain`, `scheduledChecks`, `lines(level)`,
`slotOf`, `recordOf` (relay: `seedRelay`, `seedSource`, `seedRetryRow`,
`legOwner`, `rungOwner`, `legFacts`, `legPayload`, `plantLeg`, `slotAt`,
`persisted`). Templates (quoted whole in reference section 8): adoption 2
(:349), repair 2a (:395); never_sent 11 (:1163), real handler 11b (:1186) and
15b (:2382, the model for a re-drive through the real `retrySend`); unresolved
12 (:1232), 5d (:548); siblings 5c/5e (:534/:585), 8/8b/8c (:2256-2306);
enqueue failure 17 (:1383); second_unknown 20 (:1464); A7 (:1336); parser and
toOwnerRef tables (:3007-3041).

## 10. Spec vs code discrepancies

1. R4 "(`closeSlot` has none today)" - no owner switch has a `never` default;
   five are silent under TS (section 0).
2. R4 "`slotCloseOf(outcome)` maps ... for this owner" - it takes no owner (:922).
3. R4's site list misses `adoptRelay` (:654), `heldBy`'s narrowing (:584),
   `recipientKeyOf` (SA :163), harness `attemptRecipientKey` (HN :4409), and
   three test ternaries.
4. R4 "(`sendReconcile.ts`'s status helper)" - it is `mapTwilioStatus`,
   `adapters/messaging.ts:665-681`, imported at `sendReconcile.ts:50`.
5. R4 "a dedupe ... is `skipped` ... other lineage is `other`" - `append` only
   reports `deduped`; the caller re-reads (`broadcastFanOut.ts:1382-1393`).
6. R7 "the `sid#` family's idempotence rule (a dedupe re-puts the same item)"
   - false: the `sid#` Put is conditional (:2650) and a dedupe cancels the
   transaction; only `recordProviderSidAlias` (:2887-2901) re-puts a `sid#`
   item. No retry row appended before deploy has a `retrychild#` item (no
   backfill in the spec), so step 4a and R6 miss pre-deploy children
   (pre-branch behavior - state it). R7's "the row's `expires_at` if it has
   one": message rows never do.
7. R3 "Every `guardWrite` loss is logged at ERROR (that is what `guardWrite`
   does)" - it returns true when the write RESOLVED and logs ERROR only on a
   THROW (`guardWrite.ts:8-10, 21-28`); a fence returning false is silent.
   R2 step 8's "fence LOSES" WARN must be explicit, the boolean captured in `fn`.
8. R4/R9 window close "ERROR" vs `closeRedriveRefused`'s WARN (:1154-1157).
9. R4 "The recipient key is the OWNER's (never re-derived)" vs R1 "the
   reconcile re-derives the raw key ... confirms the hash" - `resolve` MUST
   derive (the payload carries only the hash).
10. R4 never_sent REFRESH after the enqueue - `redrive` ignores whether the
    enqueue went out (:1194).
11. The anchor issue has no "Resolution"/"Expected" section; its requirements
    sit under "Suggested fix" (`retry-send-lost-under-job-marker.md:69-111`).
12. R4 "that contact ... still exists": `getById` returns soft-deleted
    contacts (`getByIdImpl`, :816-823) and `contactHoldsPhone` ignores
    `deleted_at`; the broadcast adoption checks neither. Test 10 needs an
    explicit `isDeleted` (:324) or a hard-absent contact - pin which.
13. (Asked for) `manual-retry-double-send-residual-windows` gaps: (1) a late
    job after the promise expired; (2) a stale tab retrying a replaced
    original after expiry; (3) an outcome pending past `retry_due_at`; (4) an
    `unresolved` retry leaves Retry live; (5) an enqueue that throws after SQS
    accepted (kept, ruling 4). It assigns gaps 3 and 4 to this adoption.

## 11. Traps for the builder

1. Append index attribution: keep `sid#` at 1 and `emailmsgid#` at 2; put the
   `retrychild#` Put unconditioned before the media pointers.
2. Import cycle: `sendReconcile` will import `enqueueSendRetry` /
   `MAX_SEND_RETRY_ATTEMPTS` from `retrySend`, which will import
   `enqueueSendReconcile` / `toOwnerRef` back; use them only inside functions
   (the existing note, :43-47); `npm run smoke` proves it.
3. `parseRetrySendPayload` returns only its three fields (`retrySend.ts:66-84`);
   `deferred` is dropped unless it is extended. The re-drive payload is BUILT
   from the retried row, never copied.
4. `MAX_HOP_COUNT` is 10; the longest one-attempt chain (job, deferral, three
   checks, re-drive, its deferral) is 7 hops.
5. Unpinned dev (`BUSINESS_PHONE_NUMBER` unset): the record has no `sender`,
   so every unknown retry closes `unresolved` / `no_sender` at check 0 and is
   WITHDRAWN.
6. `isBroadcastRowFor` (both reconcile call sites, :597 and
   `broadcastFanOut.ts:1387`) will call a share-RETRY row carrying
   `broadcast_id` "this recipient's" - the spec asks the handback to state
   what it does; a `row.retry_of === undefined` guard is the obvious option.
7. WITHDRAW's first `expect` is `r.row.retry_due_at` from `resolve`'s
   consistent read; the one retry re-reads with `getByTsMsgIdConsistent`.
8. Share-root predecessor match (`contactKey === this recipient key`) can
   miss on attempt 2+ when `recipient_contact_id` was dropped (the contact
   moved off the number) and the key fell back to `phone#`; with the lane's
   10 s backoff the root is inside the 150 s span.
9. The adopted row's `media_attachments`: when the job would have sent body
   only (no MediaStore), `record.mediaCount` is 0 but the retried row has
   attachments - attach them only when the facts say media went. Copy
   `transportSchemaVersion` + `requestedTransport` (both writers set them).
10. The lineage walk adds up to `MAX_SEND_RETRY_ATTEMPTS` consistent reads per
    check, on top of residue 17's unbounded sibling read.
