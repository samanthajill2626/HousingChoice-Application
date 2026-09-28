# Reader A - the retry job path (findings)

Scope: spec `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`
rev 5, decisions R1, R2, R3, R7 (job side), R8, R9, R11, R12. Read at
`feat/retry-send-adoption@656d04a4` (code = `main@3dbb5740`). Byte-exact quotes
for every citation below are in the gitignored companion
`.superpowers/sdd/research/reader-a-reference.md` (headings carry file:line).
Findings only here; no code quoted beyond names.

## Q1. retrySend.ts today (352 lines)

- Imports: messagesRepo (`createMessagesRepo`, `mediaAttachmentsOf`,
  `MediaAttachment`, `MessagesRepo`) :15-20; contactsRepo (`createContactsRepo`,
  `ContactItem`, `ContactsRepo`) :21-25; sendMessage (`createSendMessageService`,
  `SendRefusedError`, `SendMessageService`) :26-30; `createMediaStore`/`MediaStore`
  :31; `getContext` :32 (used ONLY by the marker); retrySendWindow
  (`oneToOneRetryWindowOrigin`, `parseRetryWindowOrigin`, `withinRetrySendWindow`)
  :33-37; logger :38; jobs (`defineJobHandler`, `enqueue`) :39.
- Exports: `RETRY_SEND_JOB='messaging.retrySend'` :41, `RETRY_PRESIGN_TTL_SECONDS=3600`
  :48, `MAX_SEND_RETRY_ATTEMPTS=3` :51, `retryBackoffMs` :54-56 (60/120/240 s),
  `RetrySendPayload {providerSid, conversationId, attempt}` :58-64,
  `parseRetrySendPayload` :66-84 (rebuilds field by field, :83 - drops unknown
  fields), `resolveSendRetryBackoffMs` :110-117, `enqueueSendRetry(payload, runAt)`
  :127-129, `RetrySendJobDeps` :131-150 (sendMessage, messagesRepo, mediaStore,
  contactsRepo, now, logger - NO conversationsRepo, sendAttemptsRepo, config,
  events), `registerRetrySendJobHandler` :153-352.
- Handler flow: parse :166; lazy sendMessage/messages/mediaStore :167-172 (contacts
  lazily at :193 only when a recipient id exists); row by SID
  `messages.getByProviderSid` (EVENTUAL) :174; not found WARN :175-178; not
  outbound WARN :179-182; recorded recipient by id :190-201 (missing -> WARN
  :195-200); MARKER :203-227 (`getContext()?.jobId`, `putJobExecutionMarker(jobId,
  payload.conversationId)` :212, false -> INFO `duplicate delivery suppressed`
  :214-218, no jobId -> WARN :223-226); window :237-255 (origin :237-238,
  no origin -> WARN fail-open :239-243, closed -> ERROR with
  `retryDecision:'window_closed'` :244-255); media :267-301; send :317-328
  (args: conversationId, body?, mediaUrls?, attachments?, `automated:
  original.automated ?? true`, `author: 'ai'|'teammate'` :323, recipient?,
  `retryOf: original.tsMsgId`, `retryAttempt: payload.attempt`, retryWindowStart?);
  refusal -> WARN `send refused - retry chain stopped` (source has U+2014) return
  :330-338; ANY other error rethrown :339; success INFO `retrySend: message
  re-sent` :342-350.

## Q2. Signatures the job will call

- `SendMessageService = (input: SendMessageInput) => Promise<SendMessageOutcome>`
  sendMessage.ts:408; input :291-387 (`automated?`, `author?: 'teammate'|'ai'`,
  `from?`, `broadcastId?`, `retryOf?`, `retryAttempt?`, `retryWindowStart?`,
  `recipient?: ContactItem`, `beforeProviderSend?: () => Promise<boolean>`);
  outcome `{conversationId, providerSid, tsMsgId, status}` :389-394. No
  `retryRoot` yet (R7 adds it to input, NewMessage and the append at :663-665).
- Attempts repo (sendAttemptsRepo.ts:112-149): `claim(owner, facts, nowIso)`,
  `rearm(owner, ref, nowIso) -> AttemptRef|undefined`, `finishAttempt(owner, ref,
  {outcome, sid?, cause?})`, `handToReconcile(owner, ref, sid?)`,
  `takeOver(owner, record)`, `markRedriven(owner, attemptedAt)`,
  `closeFromReconcile(owner, attemptedAt, {outcome: adopted|unresolved|
  enqueue_failed|redrive_refused, sid?, cause?})`, `closeRedriven(owner,
  {outcome: refused|redrive_refused|enqueue_failed|unresolved, cause?})`,
  `get(owner)`, `listByRecipient(sender, digest, sinceIso)` - all Promise<boolean>
  except claim/rearm/get/list. Gate: `gateFor(attempts, owner, nowMs)`
  sendAttemptGate.ts:30-39.
- `enqueueSendRetry(payload: RetrySendPayload, runAt: Date)` retrySend.ts:127.
- `enqueueSendReconcile(payload: SendReconcilePayload, delayMs)`
  sendReconcile.ts:161; `reconcileDelayMs(attemptedAt, checkNo, nowMs)` :156;
  `reconcileCheckDelaysMs()` :148; `toOwnerRef(owner)` :126;
  payload `{owner, attemptedAt, checkNo, continuation?}` :118-123.
- `annotateMessage(conversationId, tsMsgId, {mediaAttachments?, retryDueAt?})`
  messagesRepo.ts:1506 / impl :3210-3232 (UNCONDITIONAL on retry_due_at; only
  `attribute_exists(tsMsgId)`). R3's conditional write is a NEW method.
- retrySendWindow.ts: `RETRY_SEND_WINDOW_MS` :15, `RETRY_JOB_GRACE_MS` :22,
  `RETRY_PROMISE_GRACE_MS` :29, `RETRY_PROMISE_WITHDRAWN_AT` :32,
  `RETRY_WINDOW_CLOSED_CODE='retry_window_closed'` :44, `parseRetryWindowOrigin`
  :48, `oneToOneRetryWindowOrigin({retry_window_start?, provider_ts?})` :65-70,
  `retryFitsSendWindow({originMs, nowMs, backoffMs})` :73-79,
  `withinRetrySendWindow({originMs, nowMs})` :82-84, `isRetryPromiseLive(due, nowMs)`
  :93-98.

## Q3. Typed send errors (sendMessage.ts) and classification

- `SendRefusedError extends Error` with `code` union :66-99; subclasses
  `SmsSendingDisabledError` :107, `ConversationNotFoundError` :113,
  `ContactOptedOutError` :120, `ContactDeletedError` :135, `ContactNoConsentError`
  :150, `CircuitBreakerOpenError` :160, `ManualModeError` :167,
  `RelaySendNotSupportedError` :179, `GroupTextSendNotSupportedError` :200.
- `SendNotAttemptedError extends Error {cause}` :217-225 (reads, breaker, transport
  prep, the hook returning false :615-617 or throwing - via `notAttempted` :425-432).
- `ProviderSendFailedError extends Error {classification, cause, facts,
  attemptedAt, code?, status?}` :232-259 (thrown at :624; attemptedAt taken AFTER
  the hook, :618).
- `SendAcceptedNotRecordedError extends Error {providerSid, providerTs, status,
  cause, facts}` :266-287 - carries NO attemptedAt.
- `classifySendFailure` sendOutcome.ts:94-113: adapter `SmsSendingDisabledError`
  -> rejected; code 30007/30005/30006 -> rejected; 429/30022 -> retryable; status
  >=500 -> unknown; code 20429 -> retryable; status 429 -> retryable; other 4xx ->
  rejected; ENOTFOUND/ECONNREFUSED/EAI_AGAIN -> retryable; else unknown.

## Q4. The sibling to transplant: broadcastFanOut.ts runRecipient :841-1060

Claim with job-computed facts :866-879; `refused` :880-889 (fresh flag decides
carry); `takeover` -> `takeOver` then `handOff(attemptedAt)` :890-896; `ref` +
`secondUnknownWouldClose = redriveCount >= 1` :897-898; phase `sending` :907;
send with `beforeProviderSend` re-arm, `takenOver` flag :908-929 (hook :920-928);
phase `record` :940; `finishAttempt(sent, sid)` unguarded, false -> WARN fence
lost :950-957. Catch :960: prepare with ref -> `deferClaimed` :961-966; record
throw -> ERROR sent_unrecorded + `handToReconcile(sid)` :975-985; refusal ->
`finishAttempt(refused, cause=code)` :987-1016; `SendNotAttemptedError` +
`takenOver` -> INFO, nothing written :1017-1023, else defer :1024-1027;
`SendAcceptedNotRecordedError` -> `handToReconcile(err.providerSid)` :1029-1036;
classification :1038-1039; rejected -> `onRejected` (cause = code ?? String(status)
:769-772) :1040-1043; retryable -> `deferClaimed` :1044-1056; else `onUnknown`
:1057 (:782-814: second unknown -> `finishAttempt(unresolved, second_unknown)`
:803-805; else `handToReconcile` :813). `handToReconcile` :598-614 (guardWrite +
fence answer captured inside fn; won -> `handOff`); `handOff` :554-583 (enqueue
check 0 via `reconcileDelayMs(attemptedAt,0,now)`; throw ->
`closeFromReconcile(unresolved, enqueue_failed)`). relayRetryLeg.ts adds the
pre-claim decline idiom `closeUnlessOwned` :672-722 (gateFor, then
`closeRedriven(refused, code)` FIRST for a redriven record) and the transient
re-enqueue window idiom :994-1028 (`originMs !== undefined && !retryFitsSendWindow`).

## Q5. The attempt record (sendAttemptsRepo.ts)

- Owner union :50-53 (broadcast/relay_leg/relay_rung); `ownerKey` switch :152-161
  (`broadcast#<id>`, `relay#<conv>#<src>`, `rung#<conv>#<retry>`), no default;
  `recipientKeyOf` TERNARY :163-165; `attemptKey = ownerKey|hashRecipientKey(key)`
  :172-174; record key `{conversationId:'sendattempt#'+ownerKey, tsMsgId:hashed}`
  :176-181; index partition `sendattemptix#<sender or ->#<digest>` :183-185.
- Stored attributes (toRecord :214-232): `owner` (RAW map, phone key in clear),
  `attempt_state`, `attempt_no`, `attempted_at`, `redrive_count`, `check_no`,
  `sid`, `outcome`, `cause`, `recipient_digest`, `sender` (null when unset),
  `body_hash`, `body_short`, `media_count`, `expires_at`, `last_op`.
- States :54 `attempting|reconciling|redriven|done`; outcomes :55-64 `sent|rejected|
  retryable|refused|adopted|never_sent|unresolved|enqueue_failed|redrive_refused`;
  cause is a free string (constants sendOutcome.ts:14-19; `UnresolvedCause`
  sendReconcile.ts:291-300). `deferral_cap` exists nowhere yet.
- TTL `SEND_CLAIM_TTL_MS=30_000` sendOutcome.ts:29; cleanup 30 d :48. Claim keeps
  `redrive_count` (`if_not_exists`) and REWRITES facts and `owner` :257-259.
- `SendAttemptOwnerRef`, `toOwnerRef`, `parseOwnerRef`, `ownerRefLog`, `ownerLog`
  live in jobs/sendReconcile.ts :113-116, :126-145, :174-198, :363-384 (not the
  repo). A contact-id key hashes to itself; `phone#` -> `phonehash#<32hex>`
  (sendFingerprint.ts:48-51).

## Q6. Sender and conversation

- Sender: sendMessage.ts:589 `const sender = from ?? config.businessPhoneNumber;`
  inline, NOT exported; broadcastFanOut.ts:388 duplicates it. Facts :607-614
  (`recipientDigest(sender, participantPhone)`, `mediaCount: mediaUrls?.length ??
  attachments?.length ?? 0`). `businessPhoneNumber` = trimmed env or undefined
  (config.ts:1168-1169). No shared helper exists: the build adds one.
- `ConversationItem` (conversationsRepo.ts:112-171): `participant_phone?` :122,
  `type: ConversationType` :155 (`tenant_1to1|landlord_1to1|partner_1to1|
  unknown_1to1|relay_group|group_text` :44-50), `pool_number?` (relay only) :164,
  no `kind` field. `getById` is eventually consistent (:1099-1102).

## Q7. The run-once marker

`MessagesRepo.putJobExecutionMarker(jobId, conversationId): Promise<boolean>`
messagesRepo.ts:1530 / impl :3289-3304 (Put `{conversationId:'job#'+jobId,
tsMsgId:'ran'}` conditional). NOT in sqsJobConsumer.ts. Other callers stay:
broadcastFanOut.ts:353, relayFanOut.ts:831/922/993, relayRetryLeg.ts:452,
missedCallAutoText.ts:175, inboundEmail.ts:445. Harness fake :1512-1517 fills
`world.jobExecutionMarkers`. Tests asserting it for this job:
twilioStatusWebhook.test.ts:1437-1476 (keys === [jobId] :1464; the
`duplicate delivery suppressed` line :1471-1475 - both FAIL), :1478-1505 (marker
throw propagates - FAILS and, registered with only messagesRepo, would reach a
REAL conversations repo), :1602 (`size === 1` - FAILS), :1777 (`size === 0` -
stays green, vacuous). Removing the call also orphans the `getContext` import.

## Q8. The harness

- `createFakeWorld()` twilioWebhookHarness.ts:494; attempts twin
  `world.sendAttemptsRepo` :4428-4610 over `world.sendAttempts` (Map keyed by
  attemptKey), `sendAttemptIndex`, `sendAttemptOps` (FakeWorld :308-337); fail one
  call with `vi.spyOn(world.sendAttemptsRepo, '<m>')` (call through the object).
  Its own ternary `attemptRecipientKey` :4409-4410.
- Fake `append(NewMessage)` :1173-1310: dedupe by provider_sid :1178-1183; an
  explicit field ALLOWLIST (retry fields :1226-1243 - add `retryRoot` there and to
  twilioWebhookHarnessRetryFields.test.ts); no `sid#`/`retrychild#` pointers
  modeled. Fake `annotateMessage` :1469-1475 (throws on a missing row).
  `getByProviderSid` returns the LIVE stored object :1311-1313.
- `world.sent: SendMessageParams[]` = `{to, body?, mediaUrls?, from?}` pushed by
  the fake adapter :4085-4096 (`sentDetails` adds `SMfake-out-N` + providerTs); an
  overridden `sendPreparedMessage` records nothing (count sends in the override,
  broadcastFanOut.test.ts:1238-1248 idiom).
- Registrations of `registerRetrySendJobHandler(` in twilioStatusWebhook.test.ts
  (the only test file): 1271, 1330, 1371, 1397, 1429, 1459, 1493, 1517, 1586,
  1622 (inside `it.each`, 2 rows), 1650, 1670, 1695, 1728, 1759, 1804, 1837, 1877
  = 18 sites / 19 executions.
- Threading idiom: broadcastFanOut.test.ts:130-163 (`sendAttemptsRepo:
  world.sendAttemptsRepo`, same `config` to service and job, `events:
  world.events`); reconcile over the fakes sendReconcile.test.ts:99-113; helpers
  `factsFor`/`reconciling`/`runCheck`/`runChain` :184-262; marker-never-called
  spy :268-290.
- Other suites: retrySendBackoff.test.ts (seam guards; `enqueueSendRetry` pins the
  payload EXACTLY at :105 - the webhook path must never add `deferred`);
  retrySendWindow.test.ts (pure helpers, fixed ORIGIN_ISO); sendAttemptsRepo.
  integration.test.ts (key shapes :70-91 no DB; stub-client attribution; DynamoDB
  Local suite :249+ with per-case `b-${seq}` owner, SENDER '+15550009999',
  PHONE_KEY 'phone#+16175550100', `rawRecord` ternary :278);
  twilioWebhookHarnessSendAttempts.integration.test.ts (script-table parity, real
  vs fresh fake per step; `broadcastOwner` :259; three-kind case :400-412;
  ternaries :237, :534).

## Q9. Lane seams

- `E2E_SEND_RETRY_BACKOFF_MS`: read in `resolveSendRetryBackoffMs`
  retrySend.ts:110-117; honored only when `JOBS_QUEUE_URL` unset or empty and the
  value is a positive integer; default `retryBackoffMs` 60/120/240 s.
- `E2E_SEND_RECONCILE_DELAYS_MS`: `reconcileCheckDelaysMs` sendReconcile.ts:148-153;
  honored only when `JOBS_QUEUE_URL` is '' or unset and exactly three
  non-negative integers; default `RECONCILE_CHECK_DELAYS_MS` [5000,30000,240000]
  (sendOutcome.ts:30).
- Launcher childEnv: scripts/e2e-session.mjs:283 `'10000'`, :296
  `'2000,4000,8000'`; reach only a freshly booted lane (:292-295).

## Spec vs code discrepancies

1. Sec 4 "19 handler registrations - each gains `sendAttemptsRepo`": 18 sites (19
   runs). And `sendAttemptsRepo` alone is not enough: step 3's unconditional
   conversation read needs a NEW `conversationsRepo` dep, the facts need `config`
   (sender), the REFRESH needs `events`, and the step 4a Query / conditional
   annotate are new messagesRepo methods the fake must grow. A registration
   missing any lazily builds a REAL DynamoDB-backed repo.
2. R3 "Every `guardWrite` loss is logged at ERROR": guardWrite logs only a THROW
   (guardWrite.ts:22-27); a lost fence returns true silently (:8-10). The caller
   must capture and log the fence answer (broadcast :598-614).
3. R2 step 4's terminal list omits `never_sent` and `redrive_refused`; `gateFor`
   (sendAttemptGate.ts:30-39) already IS step 4 (absent/done-retryable/redriven ->
   proceed; other done -> skip; fresh attempting or reconciling -> defer; stale ->
   it calls `takeOver` itself -> taken_over). Use it; hand off exactly once.
4. R3 "`SendRefusedError` - incl. the kill switch": true for the wrapper's class
   (:107), but the ADAPTER's same-named class (messagingErrors.ts:19) classifies
   `rejected` code `sms_sending_disabled` (sendOutcome.ts:95) -> the rejected arm.
5. Case 2 "rejected (21211)": 21211 is not a known code; it classifies rejected
   only WITH a 4xx `status` (sendOutcome.ts:107-110); code-only -> unknown.
6. R1/R3 imply the job reads config, events, conversations - RetrySendJobDeps
   (:131-150) has none; registerHandlers.ts:59 registers with no deps (its doc
   :31-36 says the repo goes to "three" send handlers).
7. R3 unknown/SANR REFRESH "attemptedAt": SANR has no attemptedAt and PSFE's is
   post-hook (:618); use the held (re-armed) ref's attemptedAt - the value the
   record and reconcile key on. `reconcileCheckDelaysMs()[2]` needs `!`
   (noUncheckedIndexedAccess). The live window is then +2 min grace twice
   (`isRetryPromiseLive` adds it again).
8. R2 step 8 diverges from the sibling (declared, but easy to miss): broadcast's
   record-phase throw hands the SID to reconcile (:975-985); the spec wraps
   `finishAttempt(sent)` in guardWrite and leaves `attempting` for the sweeper.
9. R4 re-drive via `enqueueSendRetry` needs `providerSid`, which the owner ref
   lacks: `splitTsMsgId(retriedTsMsgId).providerSid` (messagesRepo.ts:210-216) or
   the resolved row. Siblings' re-drive payloads carry `redrive: true`
   (sendReconcile.ts:1086/1100/1109); the retry parser would drop it.
10. R2 step 1 "as today" = `getByProviderSid`, EVENTUAL (messagesRepo.ts:2164-2166);
   the R3 condition's `expect.retryDueAt` then comes from an eventual read.
   `getByProviderSidConsistent` exists (:1327).
11. Brief locations (not spec text): MAX_SEND_RETRY_ATTEMPTS, RetrySendPayload,
   enqueueSendRetry, resolveSendRetryBackoffMs are in retrySend.ts; the window
   constants in lib/retrySendWindow.ts; reconcileCheckDelaysMs in
   jobs/sendReconcile.ts; the marker in messagesRepo.ts; oneToOneRetryDecision.ts
   in services/. jobs.ts holds only the envelope - its fence costs nothing.
12. Spec quotes log text in ASCII; source lines :176, :180, :225, :335 carry
   U+2014. Tests match by substring, so ASCII rewrites stay green.

## Traps for the builder

- Owner-kind TERNARIES typecheck will flag (good): sendAttemptsRepo.ts:164,
  harness :4409-4410, sendAttemptsRepo.integration.test.ts:278, parity :237/:534;
  `ownerKey` has no default but TS2366 fires via its annotated return type.
- No `noUnusedLocals` (tsconfig.base.json): the orphaned `getContext` import is
  typecheck-green and lint-red (gate 5).
- Clocks: tests inject `now` = fixed PAST `JOB_NOW` (twilioStatusWebhook.test.ts:
  1539). A deferral `runAt` computed from it is in the past -> jobs.enqueue
  delaySeconds 0 (jobs.ts:112-114) -> IMMEDIATE in-process dispatch that
  `settle()` drains. Claim/rearm/gateFor on the wall clock (siblings) vs `now()`:
  choose one per judgment and seed stale records against that clock.
- `deliverDelayed` drains everything, including envelopes enqueued while
  draining (scheduler.ts:222-228); an unregistered `send.reconcile` makes
  dispatchJob throw `MalformedJobEnvelopeError` (jobs.ts:257-261).
- Sender: existing job tests build the service from a config WITHOUT
  BUSINESS_PHONE_NUMBER -> record `sender` absent -> any reconcile closes
  `unresolved/no_sender` (sendReconcile.ts:767-768). Use OUR_NUMBER
  '+15550009999' for job AND service.
- mediaCount is needed at CLAIM (step 5) but the presign is step 6: the factored
  media function must give the plan/count synchronously and presign later.
- Deferral order (enqueue, then `finishAttempt(retryable)`): a lost/thrown finish
  leaves `attempting`; the lane backoff (10 s) is below the 30 s TTL, so the
  re-run is refused fresh and the chain ends quietly.
- A failure-arm write that throws strands `attempting` and the job still succeeds
  (no redelivery) - sweeper only. The lane has NO redelivery at all (in-process
  dispatch swallows errors, scheduler.ts:193-202; sendReconcile.ts:17).
- MAX_HOP_COUNT=10 (jobs.ts:37, fenced): webhook hop 1 -> deferral 2 -> checks
  3-5 -> re-drive 6 -> deferral 7 -> SANR checks 8-10. Zero headroom: never add
  another self-enqueue to the chain.
- Import cycle retrySend <-> sendReconcile (plus oneToOneRetryDecision -> retrySend):
  keep every imported use inside functions (sendReconcile.ts:43-47); smoke proves.
- Step 4a sees only `retrychild#` pointers: children appended before deploy are
  invisible (chains straddling the deploy, 15 min at most).
- Spec leaves the 4a decline cause `<cause>` unnamed; `deferral_cap` is new.
- Extend the must-not-annotate pin (:1873-1876 spies `annotateMessage` only) to
  the new `annotateRetryPromise`.
- `participant_phone` stability: import apply.ts:1133 SETs it on a 1:1 row (same
  phone in practice).
