# Research findings: retry paths, message lineage and the send-attempt record

Branch B of share-skip-fix ("counted as sent", stub
`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`), planner
research, 2026-09-27. Read-only reader; repository `W:\tmp\share-sent-outcome`
at `main` @`d9cb5c04` (RSW and SOR Stage 1 both merged; Stage 1b not built).

Every claim cites the `file:line` it was read at, at that commit. Verbatim
excerpts are kept apart (one file, one kind) in the gitignored reference
`.superpowers/sdd/research-retry-lineage-reference.md` (blocks R1-R77).
UNVERIFIED marks what the code read here cannot settle. Section 8 lists them.

## 0. Top findings

- F1. The automatic retry carries NO share attribution. `retrySend` calls
  `sendMessage` with conversationId, body, media, `automated`, author,
  `recipient`, `retryOf`, `retryAttempt`, `retryWindowStart` - and no
  `broadcastId` (`app/src/jobs/retrySend.ts:317-328`). `broadcast_id` is written
  only when a caller passes `broadcastId` (`app/src/services/sendMessage.ts:655-658`
  -> `app/src/repos/messagesRepo.ts:2535`). The manual Retry route passes none
  either (`app/src/routes/api.ts:1676-1688`).
- F2. A retry's receipt therefore never reaches the share: the webhook rolls a
  transition into a broadcast only when the message row carries
  `broadcast_id` (`app/src/routes/webhooks/twilio.ts:3529`).
- F3. Stamping `broadcast_id` alone would NOT make it roll up. The rollup finds
  the slot by the message's `conversationId` AND `tsMsgId`
  (`twilio.ts:3887-3889`), and the slot's `tsMsgId` is the ORIGINAL send's
  (`app/src/jobs/broadcastFanOut.ts:941-947`). A miss sleeps
  `statusRetryDelayMs` (2500 ms default, `twilio.ts:322`, `:702`), re-reads the
  broadcast and WARNs "no matching recipient slot - ignored"
  (`twilio.ts:3890-3906`). And a `failed` slot is terminal: the rollup refuses
  any later transition (`twilio.ts:3840-3844`, `:3909-3913`). Whatever
  attribution B picks, it needs new slot routing AND a write rule for a later
  attempt on a failed slot (the issue says the same:
  `docs/issues/broadcast-30003-retry-never-updates-slot.md:46-53`).
- F4. One-to-one `retry_of` points at the PREVIOUS attempt, not the chain
  root: the job reads the row the payload SID names (`retrySend.ts:174`) and
  passes `retryOf: original.tsMsgId` (`:325`). The relay retry precedent is the
  opposite - every rung points at the ROOT (`twilio.ts:2797-2806`). Automatic
  chains are at most 3 hops (`retrySend.ts:51`,
  `app/src/services/oneToOneRetryDecision.ts:125-128`), but each staff Retry
  adds a hop and starts a fresh automatic chain (`api.ts:1561-1563`, `:1685`;
  `oneToOneRetryDecision.ts:125-131`), so a lineage walk is unbounded.
- F5. "Original -> its retries" has no index. The messages table is PK
  `conversationId`, SK `tsMsgId`, `gsis: []`
  (`infra/envs/prod/tables.auto.tfvars.json:326-339`); the repo pages a
  conversation newest-first with an exclusive `before` only
  (`messagesRepo.ts:1275-1279`, `:2234-2255`); nothing is keyed by `retry_of`
  or `broadcast_id`.
- F6. The promise for retry attempt n is stamped on the row of attempt n-1, in
  the same conditional write as that row's failure (`twilio.ts:3452-3467`,
  `messagesRepo.ts:2837-2869`). The share slot points only at attempt 0, so "a
  message read per failed 30003 row" is right for the FIRST failure only.
- F7. The share results row cannot see `retry_due_at` today: the slot has no
  such field (`app/src/repos/broadcastsRepo.ts:136-166`), the view copies a
  fixed field list (`dashboard/src/routes/broadcasts/broadcastFormat.ts:196-215`),
  the badge calls `deliveryReason(errorCode)` with no options (`:162-172`),
  and the page refetches only on `broadcast.updated`, polls only while the
  share is `sending`, and has no ticker
  (`dashboard/src/routes/broadcasts/useBroadcastResults.ts:121-157`).
- F8. The send-attempt record cannot answer "any attempt delivered": it has no
  delivery attribute (`app/src/repos/sendAttemptsRepo.ts:73-83`), the status
  webhook never touches it (no send-attempt reference anywhere under
  `app/src/routes`), a claim overwrites the attempt and REMOVEs `sid`,
  `outcome`, `cause` (`:257-259`), it has no one-to-one owner until Stage 1b
  (`:50-53`), the manual Retry route claims nothing (`api.ts:1567-1697`), and
  it expires after 30 days (`:47-48`).
- F9. RSW's append-time list for Stage 1b's adoption (RSW #2) names
  `retry_of`, `retry_attempt`, `retry_window_start`, `automated`,
  `recipient_contact_id` - NOT `broadcast_id`
  (`docs/superpowers/specs/2026-09-24-retry-send-window-design.md:622-626`). If
  B stamps the share at append, 1b's adoption is one more writer that must
  carry it.
- F10. SOR's adoption of a share recipient writes `broadcast_id`, `automated`
  from `created_via`, `recipient_contact_id` only while the contact holds the
  number, and the property rows only on an adopted sent or delivered
  (`broadcastFanOut.ts:1359-1381`, `:1456-1463`); an adopted failure schedules
  no retry (`:1465-1477`). The ordinary pass records the property rows at
  provider acceptance and nothing retracts them (`:817-832`, `:949`).
- F11. Under a stamp, SOR's ownership predicate would call a stamped retry row
  this recipient's own message (`isBroadcastRowFor`,
  `broadcastFanOut.ts:1296-1306`; used by `heldBy`,
  `app/src/jobs/sendReconcile.ts:593-602`). A watch item for B's spec, low
  likelihood (section 7).
- F12. Recommendation (section 7): stamp the share on every retry row AT
  APPEND (option A), with a root pointer or slot repoint for routing; put the
  share row's promise on the slot in the rollup's own conditional write; add a
  server-clock ticker to the results page. Walking lineage at receipt time
  (B) taxes every one-to-one retry and cannot serve send-time writers; deriving
  at read time (C) has no index and breaks D6's direct lookup.

## 1. The automatic 30003 retry as built

### 1.1 Scheduling - the status webhook

- 1.1.1 The receipt resolves its row by SID, eventually consistent
  (`twilio.ts:3346`; pointer then row, `messagesRepo.ts:2151-2166`), and maps
  the status (`twilio.ts:3429`).
- 1.1.2 Only a `failed` / `undelivered` receipt carrying `ErrorCode` '30003'
  decides, and it decides BEFORE the status write
  (`twilio.ts:3452-3461`), via `decideOneToOneRetry`.
- 1.1.3 Decision order (`oneToOneRetryDecision.ts`): conversation read, a
  throw fails open (`:80-85`); missing -> decline `conversation_missing`, warn
  (`:88-90`); `group_text` -> decline, warn (`:91-93`); `relay_group` or no
  `participant_phone` -> `not_one_to_one`, warn (`:94-97`); then
  `findByPhone(participant_phone)` and `getById(recipient_contact_id)`, a throw
  fails open (`:99-110`); `previewSendRefusal` with `automated =
  message.automated ?? true`, a refusal -> decline with that code, warn
  (`:112-122`); cap: `retry_attempt >= 3` -> `cap_exhausted`, error
  (`:125-128`); window: origin = `retry_window_start ?? provider_ts`
  (`:131`, `app/src/lib/retrySendWindow.ts:65-70`), scheduled only if
  `now + backoff + 60 s <= origin + 15 min` (`retrySendWindow.ts:73-79`) else
  `window_closed`, error (`oneToOneRetryDecision.ts:132-134`); otherwise
  `retry` with `attempt = prior + 1` and `runAt = now +
  resolveSendRetryBackoffMs(attempt)` (`:129-142`). On a failed read every
  refusal preview is skipped, cap and window still apply (`:29-39`, `:112`).
- 1.1.4 `previewSendRefusal` mirrors the wrapper's gates in order: kill
  switch, opt-out (thread, phone-matched contact, held recipient), deleted,
  consent (person's send only), manual mode (automated only)
  (`app/src/services/sendRefusalPreview.ts:57-78`); a recipient counts only
  while it holds the thread's number (`:55-56`); the breaker is not previewed
  (`:18-20`).
- 1.1.5 The conditional write: `updateDeliveryStatus(MessageSid, mapped,
  ErrorCode, { retryDueAt: runAt ISO })` only for a `retry` verdict
  (`twilio.ts:3462-3467`). It pre-reads the row by SID
  (`messagesRepo.ts:2838`), then one UpdateItem SETs `delivery_status`,
  `error_code` and `retry_due_at`, conditioned on `delivery_status IN
  (allowed priors)` (`:2849-2869`); for `failed` / `undelivered` the priors
  are `queued`, `sent` (`:133-142`). A regression or redelivery fails the
  condition and writes nothing, returning false (`:2870-2877`).
- 1.1.6 Everything after is gated on the transition: `message.persisted`
  (`twilio.ts:3508-3518`); the broadcast rollup, only when the row carries
  `broadcast_id` (`:3520-3545`); the placement flag on a failure
  (`:3555-3557`); the 30003 arm, only when `transitioned && ErrorCode`
  (`:3560`) and a decision exists (`:3573`).
- 1.1.7 The 30003 arm: `cap_exhausted` -> ERROR "transient delivery failure
  exhausted retries" (`:3575-3584`); other declines -> one line at the
  verdict's level, "one-to-one 30003 retry not scheduled: <reason>"
  (`:3585-3601`); fail-open WARNs (`:3611-3621`);
  `enqueueSendRetry({ providerSid: MessageSid, conversationId, attempt },
  runAt)` (`:3622-3631`); on an enqueue throw, `annotateMessage(...,
  { retryDueAt: RETRY_PROMISE_WITHDRAWN_AT })` plus `message.persisted`, a
  failed withdrawal logs ERROR, then the enqueue error is rethrown
  (`:3632-3657`) into the arm's catch, which logs ERROR and the route still
  answers 200 (`:3820-3827`). The sentinel is `1970-01-01T00:00:00.000Z`
  (`retrySendWindow.ts:32`). `annotateMessage` SETs `retry_due_at`
  conditioned only on `attribute_exists(tsMsgId)` - not on status
  (`messagesRepo.ts:3210-3232`).
- 1.1.8 Order inside one receipt: the status write (`twilio.ts:3462`), then
  the rollup (`:3531`), then the enqueue (`:3624`). The decision is in scope
  at the rollup, but `rollIntoBroadcast` takes no retry parameter
  (`:3853-3863`).

### 1.2 The job - `messaging.retrySend`

- 1.2.1 Name `messaging.retrySend` (`retrySend.ts:41`); cap 3
  (`:51`); backoff 60/120/240 s (`:54-56`); payload = the FAILED message's
  provider SID, the conversation, the attempt (`:58-64`), validated, attempt
  above the cap throws (`:66-84`).
- 1.2.2 Lane seam `E2E_SEND_RETRY_BACKOFF_MS`: honored only when
  `JOBS_QUEUE_URL` is unset or empty and the value is a positive integer
  (`:92`, `:110-117`); the webhook computes the run time through the same
  function, so the stamp equals the schedule (`:106-108`, `:119-129`;
  `oneToOneRetryDecision.ts:130`, `:139`). Lane value 10000
  (`scripts/e2e-session.mjs:273-283`); the reconcile checks have their own lane
  seam, 2/4/8 s (`:284-296`).
- 1.2.3 Enqueue: `enqueue(RETRY_SEND_JOB, payload, { runAt })`
  (`retrySend.ts:127-129`).
- 1.2.4 Every exit, in order: payload parse throws (`:166`); original missing
  -> WARN, return (`:174-178`); original not outbound -> WARN, return
  (`:179-182`); the recorded recipient read by id BEFORE the marker, a throw
  fails the delivery so SQS redelivers, a missing contact WARNs and falls back
  to the phone lookup (`:190-201`); execution marker
  `putJobExecutionMarker(jobId, conversationId)`, a duplicate -> INFO
  "duplicate delivery suppressed", return (`:210-219`), no jobId -> WARN and
  proceed (`:220-227`); window AFTER the marker: no usable origin -> WARN and
  proceed (`:237-243`), outside `origin + 15 min` -> ERROR
  `retryDecision: 'window_closed'`, return (`:244-255`); presign per attempt,
  a throw lands after the marker (`:267-301`); the send (`:317-328`); a
  `SendRefusedError` -> WARN "retry chain stopped", return (`:330-337`); any
  other error rethrown (`:339`) - after the marker, so the redelivery is
  suppressed and the retry is lost
  (`docs/issues/retry-send-lost-under-job-marker.md:18-29`, `:129-145`);
  success -> INFO (`:342-350`).
- 1.2.5 No exit withdraws the original's promise (no `annotateMessage`, no
  emit in the job); accepted as wontfix
  (`docs/issues/one-to-one-retry-promise-outlives-job-decline.md:13-17`).
- 1.2.6 Fields written AT APPEND on the retry row (through `sendMessage` into
  `messagesRepo.append`): `retry_of` = the previous attempt's `tsMsgId`,
  `retry_attempt` = payload attempt, `retry_window_start` = the chain origin
  as a raw string (`retrySend.ts:237`, `:325-327`; `sendMessage.ts:659-665`;
  `messagesRepo.ts:2541-2545`); `automated` on every row, the original's value
  or true when absent (`retrySend.ts:322`; `sendMessage.ts:669`;
  `messagesRepo.ts:2549`); `recipient_contact_id` only when the named
  recipient still holds the thread's number (`sendMessage.ts:488-495`, `:670`;
  `messagesRepo.ts:2550-2552`). No `broadcast_id` (F1).
- 1.2.7 The retry goes into the same conversation as the failed row (the
  payload's conversation is `message.conversationId`, `twilio.ts:3627`;
  `retrySend.ts:318`) from the same sender as a share send (no `from`, so the
  business number, `sendMessage.ts:589`; the share claim digests the same
  number, `broadcastFanOut.ts:872-873`).

### 1.3 A receipt for a retry row

- 1.3.1 It resolves like any row (`twilio.ts:3346`); the retry row is the
  `message`.
- 1.3.2 The 30003 decision reads the retry row's `recipient_contact_id`,
  `automated`, `retry_attempt` and `retry_window_start`
  (`oneToOneRetryDecision.ts:103-105`, `:119`, `:125`, `:131`), so the chain
  continues at attempt + 1, windowed from the chain origin, and the new
  `retry_due_at` lands on the RETRY row (`twilio.ts:3462-3467`) - never on the
  original. Hence F6.
- 1.3.3 No `broadcast_id` -> no rollup (`:3529`); `message.persisted` still
  fires (`:3508-3518`) and the placement flag still runs (`:3555-3557`).
- 1.3.4 On the contact page the superseded row disappears: every row named by
  some row's `retry_of` is dropped, so only the chain's tail renders
  (`dashboard/src/routes/contact/Timeline.tsx:2060-2075`).

## 2. The staff manual Retry route

- 2.1 `POST /conversations/:conversationId/messages/:providerSid/retry`, behind
  the shared manual-send limiter (`api.ts:1567`).
- 2.2 Checks, in order: the row by SID (eventual), 404 if missing or in another
  conversation (`:1574-1578`); 400 not outbound (`:1579-1582`); 409
  `not_retryable` for email (`:1588-1591`); 409 `not_failed` unless `failed` or
  `undelivered` (`:1595-1598`); 409 `retry_pending` while
  `isRetryPromiseLive(original.retry_due_at, Date.now())` (`:1608-1611`), i.e.
  now before due + 120 s (`retrySendWindow.ts:29`, `:93-98`). The guard reads
  the PRESSED row only.
- 2.3 The recorded recipient read by id, WARN fallback (`api.ts:1619-1629`).
- 2.4 What it passes to `sendMessage` (`:1676-1688`): conversationId, body,
  media, `automated: false`, author, `retryOf: original.tsMsgId`, `recipient`.
  No `broadcastId`, no `retryAttempt`, no `retryWindowStart`.
- 2.5 Its row carries `retry_of` (the pressed row - the share original or any
  retry row), `automated` false, `recipient_contact_id` when held. With no
  `retry_attempt` and no `retry_window_start`, a 30003 on it starts a fresh
  chain at attempt 1 windowed from its own send (`oneToOneRetryDecision.ts:125-131`;
  `retrySendWindow.ts:65-70`). The route allows the same failed SID to be
  retried indefinitely (`api.ts:1561-1563`).
- 2.6 The dashboard maps `retry_pending` to "A retry is already scheduled for
  this message." (`Timeline.tsx:130-135`) and hides Retry while the promise is
  live (`:1423-1426`). The share results page has no Retry of its own; a failed
  row links to the contact with "open conversation to retry"
  (`dashboard/src/routes/broadcasts/BroadcastResults.tsx:9-11`, `:55-56`,
  `:71-75`).

## 3. The message row and what can enumerate a share's attempts

- 3.1 Keys: PK `conversationId`, SK `tsMsgId`, no GSI
  (`infra/envs/prod/tables.auto.tfvars.json:326-339`; also
  `messagesRepo.ts:714`, `:1776`). `tsMsgId = <providerTs>#<providerSid>`
  (`messagesRepo.ts:202-204`), `providerTs` = Twilio `dateCreated` as ISO
  (`app/src/adapters/messaging.ts:870`), so a retry sorts after its
  predecessor in the same partition.
- 3.2 Lineage and outcome fields on `MessageItem`: `provider_sid`,
  `provider_ts`, `delivery_status`, `error_code`, `created_at`
  (`messagesRepo.ts:1018-1025`); `retry_of` (`:1037-1038`); `retry_attempt`
  (`:1039-1040`); `retry_window_start` (`:1041-1042`); `retry_due_at`
  (`:1043-1052`); `automated` (`:1053-1054`); `recipient_contact_id`
  (`:1055-1056`); `broadcast_id` (`:1126-1131`); the relay twins are separate
  and unused by one-to-one rows (`:1057-1074`). `MessageItem` declares no
  delivered-at attribute for a one-to-one row (`:1010-1224` read; it ends in
  an open index signature, `:1223`).
- 3.3 Writers: lineage is written ONLY at append (`:2541-2552`); the
  annotations path carries only media and `retry_due_at` (`:1231-1243`,
  `:3210-3222`). Status is forward-only (`:133-142`).
- 3.4 Readers the repo offers: `listByConversation` and its consistent twin -
  newest-first, optional exclusive `before`, `Limit` default 50, no `after`
  and no filter (`:1275-1279`, `:1467-1477`, `:2008`, `:2234-2255`);
  `getByTsMsgId` / consistent point gets (`:1485`, `:1498`, `:3389-3399`,
  `:2257-2269`); `getManyByTsMsgIds`, ONE conversation, BatchGet in chunks of
  100 (`:1504`, `:3401-3416`); `getByProviderSid` / consistent, two Gets
  (`:1320`, `:1327`, `:2151-2166`). No read by `retry_of` or `broadcast_id`,
  no cross-conversation batch.
- 3.5 Walk costs:
  - retry -> original: `getByTsMsgId(row.conversationId, row.retry_of)`, one
    Get per hop in one partition (1.2.7, 2.4 keep every attempt in the
    original's conversation). Automatic hops <= 3 (F4); manual hops unbounded.
  - original -> share: the chain root's `broadcast_id` - today the only row
    that carries it is the share's own send (`sendMessage.ts:655-658` via
    `broadcastFanOut.ts:916`) or SOR's adoption of it (`:1378`).
  - original -> its retries: no index (F5). A forward range Query
    (`tsMsgId > original`) is not in the repo - new method - and costs a read
    of every row newer than the original in that conversation; a staff Retry
    may come any time later, so no time bound applies.
- 3.6 Pre-RSW rows: lineage was annotated after the send and could be missing
  (RSW spec `:133-135`); RSW removed that path (`messagesRepo.ts:1233-1236`).

## 4. The send-attempt record (SOR Stage 1, as built)

- 4.1 Two item families in the messages table: the record,
  `sendattempt#<ownerKey>` / hashed recipient key; the recipient index,
  `sendattemptix#<sender or ->#<recipientDigest>` /
  `<attemptedAt>#<ownerKey>#<hashed key>` (`sendAttemptsRepo.ts:43-46`,
  `:176-185`, `:196-207`). Both carry `expires_at` = claim + 30 days and are
  reaped only by TTL (`:47-48`, `:187-189`; `app/src/lib/tables.ts:232-235`),
  which is best-effort and up to 48 h late (`messagesRepo.ts:1550-1556`).
- 4.2 Owners: `broadcast` (broadcastId, contactKey), `relay_leg`, `relay_rung`
  (`sendAttemptsRepo.ts:50-53`); `ownerKey` has no one-to-one case
  (`:152-161`). `retrySend` is not adopted (it has no send-attempt code;
  SOR spec `:93-94`; `retry-send-lost-under-job-marker.md:140-145`).
- 4.3 States `attempting | reconciling | redriven | done` (`:54`); outcomes
  `sent, rejected, retryable, refused, adopted, never_sent, unresolved,
  enqueue_failed, redrive_refused` (`:55-64`); facts: recipient digest,
  sender, body hash, short flag, media count (`:66-72`); the record adds
  owner, state, attemptNo, attemptedAt, redriveCount, checkNo, sid, outcome,
  cause (`:73-83`).
- 4.4 LATEST attempt only: a claim SETs a new attemptNo / attemptedAt and
  REMOVEs `sid`, `outcome`, `cause` (`:257-259`, `:286-316`); index items are
  write-once per claim or re-arm and carry no outcome (`:196-207`).
- 4.5 No delivery fact (F8): no delivery attribute on the record
  (`:73-83`, `:214-232`); the status webhook does not read or write it (SOR
  fenced `routes/webhooks/twilio.ts` entirely, SOR spec `:110-118`). `sent`
  means the provider accepted (`broadcastFanOut.ts:950`); `adopted` means the
  reconcile found the message in whatever status (`sendReconcile.ts:429`).
- 4.6 `listByRecipient(sender, digest, since)`: a consistent Query of one
  index partition from `since`, newest-first, 100 per page, then one
  consistent Get of the record per index item, one row per `attemptKey`
  (`sendAttemptsRepo.ts:585-615`). The digest is sha256 of `sender|E164`,
  first 32 hex (`app/src/lib/sendFingerprint.ts:43-44`) - per phone and
  sender, not per share. Share sends and one-to-one retries share the sender
  (1.2.7).
- 4.7 What B could derive from it: for a share recipient, the pass's latest
  attempt - accepted (`done`/`sent` + sid), rejected, refused, deferred
  (`retryable`), pending (`attempting`/`reconciling`/`redriven`) or unresolved.
  What it cannot: any delivery; any automatic 30003 retry (until 1b); any staff
  Retry (the route claims nothing, `api.ts:1567-1697`); any attempt older than
  the latest claim of its owner or older than 30 days; which share a retry
  belongs to (the record's owner for a future one-to-one retry is "the
  original message and the rung", SOR spec `:571-573`, `:723-726` - a share id
  is not in it; UNVERIFIED until 1b is specified).
- 4.8 `adoptBroadcastRecipient` (`broadcastFanOut.ts:1341-1479`): appends the
  row with `broadcastId`, `automated = created_via !== 'dashboard'`,
  `recipientContactId` only when the contact holds the thread's number,
  author `teammate`, and no retry fields (`:1359`, `:1366-1381`); a dedupe is
  read back consistently and judged by `isBroadcastRowFor` (`:1382-1393`);
  the slot moves from `queued` only, with its stats bump in the same write
  (`:1395-1416`); the audit row only for a fresh append (`:1423-1433`); the
  status-preserving inbox touch (`:1437-1448`); `message.persisted`
  (`:1449-1454`); `recordPropertySent` (the `listing_sent` milestone and the
  listing-send row) only when the slot status is not `failed`
  (`:1456-1463`); a failure flags 30005/30006 and WARNs "adopted terminal
  failure - webhook side effects skipped" (`:1465-1477`) - so an adopted
  30003 schedules no retry and carries no `retry_due_at`.
- 4.9 The pass's own success path records the property rows right after the
  accepted send (`afterSend`, `broadcastFanOut.ts:817-832`, called at `:949`),
  before any receipt; nothing retracts them on a later failure
  (`docs/issues/tenant-timeline-property-sent-milestone-after-failed-delivery.md:12-17`).
  The ledger row is an upsert keyed by unit and contact that refreshes
  `sentAt` / `via` / `broadcastId` (`app/src/repos/listingSendsRepo.ts:10-18`;
  `broadcastFanOut.ts:1233-1251`).

## 5. The dashboard's promise plumbing and the share results row

- 5.1 `RETRY_PROMISE_GRACE_MS` mirror = 120000 and `isRetryPromiseLive`
  (`dashboard/src/routes/contact/retryPromise.ts:19`, `:29-34`).
- 5.2 Server clock: every API response through `requestWithStatus` notes its
  `Date` header (`dashboard/src/api/client.ts:134`;
  `dashboard/src/api/serverClock.ts:38-49`); `getBroadcastResults` goes through
  it (`dashboard/src/api/endpoints.ts:1876-1884`), so the results page already
  feeds the same page-wide estimate.
- 5.3 `deliveryReason(code, opts)`: internal-code map first
  (`dashboard/src/routes/contact/deliveryStatus.ts:1143-1144`); then "Phone
  unreachable - will retry" only when `retryScheduled && !relay`
  (`:1165-1168`, map `:947-949`); then media, relay, base "Phone unreachable"
  (`:888-899`); then the `(error N)` tail (`:1172-1174`). The options doc
  names the property-send results row as a position that omits
  `retryScheduled` (`:993-1000`).
- 5.4 Timeline: `showsRetryPromise` (`Timeline.tsx:791-795`) drives the chip
  (`:1044`, `:1058-1060`), hides Retry (`:1426`) and arms the ticker as clause 7
  (`:922`), judged on a server-clock snapshot taken where arming is decided
  (`:2203-2211`); the tick is 60 s (`:749`). `retry_due_at` reaches it through
  the contact-timeline projection (`app/src/routes/contactTimeline.ts:171-180`,
  `:449-452`; `dashboard/src/api/types.ts:2533-2547`).
- 5.5 The results row today: the slot type has no `retry_due_at`
  (`broadcastsRepo.ts:136-166`; `dashboard/src/api/types.ts:3005-3027`); the
  route spreads each slot and adds names (`app/src/routes/broadcasts.ts:223-258`,
  `:280-298`, `:786-797`), so a new slot attribute would reach the wire, but
  `toRecipientViews` copies only status, carrierSentAt, errorCode,
  conversationId (`broadcastFormat.ts:196-215`; view type
  `types.ts:3049-3065`); `DeliveryBadge` -> `shareRecipientReason(status,
  errorCode)` -> `deliveryReason(errorCode)` (`DeliveryBadge.tsx:34-43`;
  `broadcastFormat.ts:162-172`), so a 30003 reads "Phone unreachable (error
  30003)". The failed row always offers "open conversation to retry" unless
  `send_unconfirmed` (`BroadcastResults.tsx:55-56`). Live updates:
  `broadcast.updated` (status + stats only, `types.ts:3108-3112`) triggers a
  400 ms debounced refetch; polling runs only while `sending`; no ticker
  (`useBroadcastResults.ts:39-46`, `:121-157`). A `message.persisted` does not
  reach this page.
- 5.6 Paths for the row to read a live promise:
  - (i) STAMP ON THE SLOT at the webhook's 30003 write. For the FIRST
    failure, the rollup's slot write (`twilio.ts:3949-3958`, conditioned on
    `queued | sent`) is the same transition, and the decision is in scope
    (1.1.8), so the promise can ride that write exactly as RSW D7 does on the
    message; the enqueue-failure withdrawal (`:3632-3657`) needs a matching
    slot write. For attempts 2 and 3 the slot is already `failed` and
    unreachable (F2, F3): needs attribution plus a write allowed from
    `failed`. Zero extra reads on the results route; the rollup already emits
    `broadcast.updated` (`:3978-3982`).
  - (ii) A MESSAGE READ PER FAILED 30003 ROW at the results route:
    `getByTsMsgId(slot.conversationId, slot.tsMsgId)` returns the ORIGINAL's
    stamp - right for the first failure only (F6); later promises live on
    rows the slot does not name. Cost: one Get per such row, each in its own
    partition (the repo's batch read is single-conversation, 3.4), up to
    `MAX_BROADCAST_RECIPIENTS` = 1500 (`broadcastsRepo.ts:68`), on a page that
    refetches on every `broadcast.updated` and every 2 s while sending
    (`useBroadcastResults.ts:46`, `:121-157`); a withdrawal emits only
    `message.persisted` (`twilio.ts:3642-3647`), which this page never hears.
  - Either path needs a results-page ticker on the server clock: nothing
    fires when a promise expires, and the page stops polling once the share is
    terminal (`useBroadcastResults.ts:152-157`); Timeline's clause 7 is the
    precedent (5.4). While a promise is live, the "open conversation to retry"
    hint invites a press the server refuses with 409 (2.2).
  - Smallest HONEST path: (i), because B must make the slot learn later
    attempts anyway (the stub's newest attempt, `share-sent-outcome-design.md:26-35`),
    and (ii) is honest only for attempt 1 while costing a read per row. If B
    ships without per-attempt slot writes, (ii) under-promises on attempts 2-3
    (RSW D8 calls under-promising acceptable, RSW spec `:353-359`) but still
    needs the ticker.
- 5.7 Slot byte budget: the recipients map lives on the broadcast item; the
  code budgets about 150-200 bytes per slot, 1500 slots at about 300 KB of the
  400 KB item limit (`broadcastsRepo.ts:56-68`). Every per-slot field B adds
  spends that headroom (actual sizes UNVERIFIED).

## 6. What Stage 1b will change (so B can be planned after it)

Sources: SOR spec sec 2a item 4 (`:199-208`), D12 note (`:571-573`), D16 note
(`:721-726`), sec 9 (`:961-967`), errata 1 (`:1053-1063`); RSW section 5 #1-#4,
#6 (`retry-send-window-design.md:619-654`);
`retry-send-lost-under-job-marker.md:69-116`;
`manual-retry-double-send-residual-windows.md:67-80`. 1b is unbuilt; the
function list below is what those texts require of the code as it stands.

- 6.1 `app/src/repos/sendAttemptsRepo.ts`: the owner union (`:50-53`),
  `ownerKey` (`:152-161`), `recipientKeyOf` (`:163-165`) - a new owner "keyed on
  the original message and the retry rung" (SOR `:571-573`). Whether "original"
  means the chain root or the previous attempt (what `retrySend` calls
  `original`, `retrySend.ts:174`) is UNVERIFIED.
- 6.2 `app/src/jobs/retrySend.ts` `registerRetrySendJobHandler` (`:153-352`):
  the claim, placed after the window check (RSW #6, RSW spec `:648-651`); the re-arm
  through `sendMessage`'s `beforeProviderSend` (`sendMessage.ts:386`,
  `:615-617`; errata 1); typed-error handling replacing the blanket rethrow at
  `retrySend.ts:339` (unknown -> reconcile; retryable -> the single deferral,
  re-scheduled through the same handler and re-windowed, RSW #1, #3);
  refreshing the promise while pending (RSW #3: re-write `retry_due_at` and
  emit `message.persisted`, RSW spec `:627-633`; the primitive is
  `annotateMessage`, `messagesRepo.ts:3210-3232`); the sendMessage call at
  `retrySend.ts:317-328` - the line B would extend - is inside this handler.
- 6.3 `app/src/jobs/sendReconcile.ts`: every owner-kind switch - the payload
  ref type (`:113-116`), `toOwnerRef` (`:126-145`), `parseOwnerRef`
  (`:174-198`), `ownerRefLog` (`:363-372`), `ownerLog` (`:375-384`), `resolve`
  (`:473-507`), `currentPhone` (`:516-535`), `heldBy` (`:577-611`), `adopt`
  (`:614-635` - a new adoption that appends the retry row with RSW #2's
  lineage, `retry-send-window-design.md:622-626`), `closeSlot` (`:936-955`),
  `afterClose` (`:967-993`), `enqueueRedrive` (`:1078-1115`), `redriveRefusal`
  (`:1123-1130`).
- 6.4 The manual Retry route (`api.ts:1567-1697`) if 1b closes the joint gap
  the way the issue suggests - the route claiming the same record
  (`manual-retry-double-send-residual-windows.md:75-80`); UNVERIFIED that 1b
  will.
- 6.5 Not required of 1b by any text read: `routes/webhooks/twilio.ts` (fenced
  for Stage 1, SOR `:110-118`; 1b's fence unstated), the broadcast rollup, the
  results route, the slot shape. Those stay B's.
- 6.6 Consequence for B: if B stamps the share at append, the write sites are
  `retrySend`'s send call and the manual route's send call as 1b leaves them,
  plus 1b's new adoption append in `sendReconcile.ts` (F9) - ask 1b to carry
  `broadcast_id` (and any root pointer) there, or edit it after.

## 7. Attribution: how a retry's receipt reaches its share

Constraints every option inherits (F3): the rollup routes by the slot's
`tsMsgId` (`twilio.ts:3887-3889`) and refuses a `failed` slot
(`:3840-3844`, `:3909-3913`); stats move with the slot in the same write
(`:3949-3982`; `broadcastsRepo.ts:537-579`).

### Option A - stamp `broadcast_id` on every retry row at append

- Sites: `retrySend.ts:317-328` (the previous attempt's row is already in hand
  at `:174`, so `broadcastId: original.broadcast_id` costs nothing);
  `api.ts:1676-1688` (row in hand at `:1574`); 1b's adoption append (F9).
  `sendMessage` already takes `broadcastId` (`sendMessage.ts:336`, `:443`,
  `:655-658`); the repo writes it (`messagesRepo.ts:2535`); the webhook
  harness's fake append already copies it
  (`app/test/helpers/twilioWebhookHarness.ts:1225`). The stamp propagates by
  induction only if every writer copies it.
- Receipt cost: zero extra message reads (the row is read anyway,
  `twilio.ts:3346`); one broadcast read plus one conditional slot write per
  transitioned sent/terminal receipt of a share retry - what an original costs
  today (`:3880-3982`). Non-share retries pay nothing (gate at `:3529`).
- Slot routing it still needs (pick one):
  - A1, repoint: move the slot's `conversationId` / `tsMsgId` to the newest
    attempt when it is sent, so today's match works. A post-send write by a
    second slot writer - SOR warns that the slot already has six writers, two
    wholesale (SOR spec `:1024-1027`); the pass has the same receipt-before-slot
    window and covers it with the rollup's re-read (`twilio.ts:3890-3902`).
  - A2, root pointer: also stamp the chain root's `tsMsgId` (= the slot's
    `tsMsgId`, `broadcastFanOut.ts:944`, `:1407-1408`) on each retry row, as
    the relay ladder stamps `relay_retry_of` at the root (`twilio.ts:2797-2806`,
    `messagesRepo.ts:773`); the rollup matches on it with its existing scan.
    `retry_of` itself cannot be re-pointed: the timeline collapse depends on it
    naming the previous attempt (`Timeline.tsx:2060-2075`).
  - A3, key by contact: `recipients[row.recipient_contact_id]` is not total -
    absent when the named recipient no longer holds the number
    (`sendMessage.ts:488-495`, `:670`), and a `phone#` slot key differs from the
    phone-matched contact id (`broadcastFanOut.ts:1196-1198`); the code also
    says two contacts on one phone in one share share a conversation
    (`:1288-1291`), so a conversation scan is ambiguous.
- Failure modes: rows written before B carry no stamp (the D6 repair must walk
  lineage, 3.5); one writer that forgets the stamp breaks it for every later
  attempt; `isBroadcastRowFor` / `heldBy` would treat a stamped retry row as the
  recipient's own message (F11) - for that to bite, a share attempt must be in
  the reconcile LOOKUP path while its original row exists (a takeover) and the
  retry must fall in its window (`sendReconcile.ts:777-779`; trail 90 s,
  `app/src/lib/sendOutcome.ts:29-41`); candidates are tried oldest-first
  (`sendReconcile.ts:860`), so the original is adopted before the retry; doc
  comments that call `broadcast_id` "absent on 1:1" become false
  (`sendMessage.ts:329-336`, `messagesRepo.ts:1126-1130`).

### Option B - the webhook follows `retry_of` at receipt time

- Sites: the rollup gate (`twilio.ts:3520-3545`): when a row has no
  `broadcast_id` but has `retry_of`, `getByTsMsgId(row.conversationId,
  row.retry_of)` (`messagesRepo.ts:1485`, `:3389-3394`) until a row with
  `broadcast_id` or without `retry_of`; then route by the root's `tsMsgId`.
- Cost: one Get per hop on EVERY transitioned receipt of EVERY row carrying
  `retry_of`, share or not (tour reminders, missed-call texts and staff
  Retries included); 1-3 hops for automatic chains, unbounded with staff
  Retries (F4).
- Failure modes: a missing or unreadable ancestor (a pre-RSW row with lost
  lineage, RSW spec `:133-135`) drops attribution silently; the walk runs
  inside the webhook's latency budget; it serves ONLY receipts - the stub's
  send-time rules (a "newest attempt queued ... or handed to the carrier" counts,
  a newly sent attempt re-counts the ledger:
  `share-sent-outcome-design.md:26-35`, `:53-60`) need the share at the
  retry's acceptance in `retrySend` and the manual route, which would each walk
  too. 1b's adoption is covered for free only if it writes `retry_of` (RSW #2).

### Option C - derive at read time

- Sites: the results route (`broadcasts.ts:786-797`) and every other reader of
  a share's counted state (the stub's list label, "already sent", ledger,
  property count; `share-sent-outcome-design.md:36-60`).
- Cost: needs original -> retries, which has no index (F5): a new forward
  range Query per failed slot per fetch, on a page that refetches on each
  `broadcast.updated` and every 2 s while sending, up to 1500 slots (5.6 (ii));
  a staff Retry can come any time later, so the scan has no time bound.
- Failure modes: contradicts D6's "direct lookup, no per-row join"
  (`share-sent-outcome-design.md:58-59`); the ledger is written at acceptance
  (4.9), so un-counting still needs a writer; nothing is recorded at receipt,
  so every surface re-derives.

### Recommendation

Option A, with a root pointer (A2) for routing - or a repoint (A1) if the
planner prefers no second new field. Reasons: both writers already hold the
previous attempt's full row, so the stamp is free and atomic with the append
(the RSW D6 precedent, RSW spec `:286-291`); receipts route with zero extra
reads and only share retries pay; the same stamp serves the send-time writes
the stub's D5/D6 need (acceptance of a retry, the ledger re-count), which a
webhook-only walk cannot; and it mirrors the relay ladder's root-pointing
lineage. The rollup then needs its write rule for a later attempt on a
`failed` slot (the stub's I9, `share-sent-outcome-design.md:66-68`), and the
share promise rides that write as in 5.6 (i). Costs to state in the spec: the
1b adoption must carry the stamp (F9); the D6 repair walks lineage for rows
written before B; F11 as a named watch item.

## 8. UNVERIFIED and open

- Stage 1b's owner key: "the original message and the rung" - chain root or
  previous attempt (SOR spec `:571-573`, `:723-726`); and whether 1b edits the
  manual route or the webhook (its addendum is unwritten, SOR `:207-208`).
- Whether Twilio posts a status callback for `queued` / `accepted` on a retry,
  which decides whether the slot could learn a retry's acceptance from receipts
  alone (live provider behavior; the rollup ignores `queued` anyway,
  `twilio.ts:3872-3878`).
- Whether audience resolution can put two contacts with one phone in one share
  (the code comment says so, `broadcastFanOut.ts:1288-1291`; no dedupe found
  by search in `app/src/services/audienceResolution.ts` or
  `app/src/routes/broadcasts.ts`).
- Actual per-slot byte size against the 400 KB item limit (estimate only,
  `broadcastsRepo.ts:59-63`).
- Whether `activityEvents.record` for `listing_sent` is idempotent on a re-run
  (not read).
