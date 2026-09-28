# Planner review - independent spec conformance (retry-send adoption)

Reviewer: the planner's independent spec-conformance reviewer, 2026-09-28.
Branch `feat/retry-send-adoption` at `95edb0b6` (code final `1b5ddb01`;
`git diff --stat 1b5ddb01..HEAD -- . ':(exclude)docs'` is empty), merge base
`3dbb5740`, 0 behind `main`.

Contract: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`
revision 5, read on top of SOR revision 12 section 12. Plan revision 4 (nine
declared deviations); handback (eleven declared deviations plus wording notes
C-7 / C-8).

Method: READ-ONLY. Nothing was run - no npm, vitest, playwright, node script
or DynamoDB (a gate e2e was live on this worktree). Evidence is code
`file:line` at `95edb0b6`. A test is cited as "proven" when it exists in the
tree and, read, asserts the spec's claim; whether it passes is the handback's
claim and is UNVERIFIED here (one row). The ASCII check was done by
reading the diff text (a regex over the prepared package's added lines, all
41 code files), not by running `tr`.

## Verdict

No BLOCKING, no HIGH, no MEDIUM. The code delivers the spec decision by
decision; every departure is one of the eleven declared deviations or a
declared/filed residue, and each declared deviation is legitimate (none
changes what the spec promised to staff, to Branch B, or to the tenant).
Five LOW findings (section 5), none needing a change before merge; the
fourth is a set of spec-text errata the planner should stamp as-built.

## 1. Per-decision table

Legend: C = CONFORMS, DD = DEVIATES-DECLARED (deviation named), DU =
DEVIATES-UNDECLARED, M = MISSING, U = UNVERIFIED.

### Section 0 (the two names, the root rule, Cameron's rulings) and section 1

| id | decision | verdict | evidence (code) |
|---|---|---|---|
| S0-1 | Two names: the RETRIED ROW (named by the payload SID; promise, refresh, withdrawal and `retry_outcome` written there) vs the ROOT; the record keys on the retried row + attempt, root a fact | C | `app/src/repos/sendAttemptsRepo.ts:179`; `app/src/jobs/retrySend.ts:349`, `:404-411`; promise writes on `retried` only (`retrySend.ts:747`, `:786`, `:796`, `:844`; `sendReconcile.ts:1328`, `:1637`) |
| S0-2 | Root = the row's `retry_root`; else walk `retry_of` up to `MAX_SEND_RETRY_ATTEMPTS` consistent hops, a broken link stops at the last row read; else own `tsMsgId` | C | `app/src/services/retryChain.ts:23-33`; callers `retrySend.ts:367`, `app/src/routes/api.ts:1654` |
| S0-3a | Q1 main path: an `unresolved` close withdraws (`RETRY_PROMISE_WITHDRAWN_AT` + `retry_outcome: 'unconfirmed'` in ONE conditional write), the row reads "retry not confirmed", no Retry | C | `sendReconcile.ts:1402-1423`, `:1308-1333`; `app/src/services/retryPromiseWrites.ts:76-106`; `app/src/repos/messagesRepo.ts:3388-3428`; `dashboard/src/routes/contact/Timeline.tsx:1056`, `:1071`, `:1441`; `api.ts:1670-1676` |
| S0-3b | Q1 when the JOB's own `unresolved` close (second unknown; hand-off enqueue failure) cannot write its WITHDRAW | DD (C-2 job half, filed in `send-attempt-sweeper`) | `retrySend.ts:786-792`, `:844-850` - no re-apply path; the record still refuses the press (409 `retry_unresolved`). Finding 1 |
| S0-4 | Q2: `twilio.ts` fenced except ONE log-level line | DD (D4: re-worded to ASCII as well as re-leveled) | `app/src/routes/webhooks/twilio.ts:3904` is the only changed line (diff 1+/1-); `broadcastId` still carried |
| S0-5 | Branch B: every retry row 1b appends - automatic, adopted, manual - carries `broadcast_id` (copied from the retried row) and `retry_root` | C | automatic `retrySend.ts:543-544`; adopted `sendReconcile.ts:890-902` (inside `adoptRetry`, `:850`); manual `api.ts:1768-1769` |
| S0-6 | 1b writes nothing to the share slot | C | `closeSlot`'s `retry_send` arm writes no broadcast (`sendReconcile.ts:1308-1333`); `isBroadcastRowFor` refuses retry rows (`app/src/jobs/broadcastFanOut.ts:1303`) |
| S0-7 | Wontfix kept: no early withdrawal after a refusal, rejection, window close or success; the issue untouched | C | no promise write in `refuse` (`retrySend.ts:673-676`), rejected (`:614-634`), 4b (`:474-481`), success (`:563-571`), deferral terminals (`:717-744`), `redrive_refused` / `enqueue_failed` (`sendReconcile.ts:1308-1333`); `docs/issues/one-to-one-retry-promise-outlives-job-decline.md` has no diff |
| S1-1 | Invariant 1: the retry never texts twice - claim + re-arm before every provider call; the manual route meets RSW's time guard AND the record | C | `retrySend.ts:497`, `:545-553`; `api.ts:1626-1690`; named residuals only (Finding 2) |
| S1-2 | Invariant 2: every attempt reaches a visible state; nothing throws after the claim | C | every post-claim write is `guardWrite`-wrapped or try/caught: `retrySend.ts:517-641`, `:651-855`; `retryPromiseWrites.ts:49-68`, `:81-105` |

### Section 2 fences

| id | fence | verdict | evidence |
|---|---|---|---|
| F-1 | `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT`) untouched | C | `git diff --stat main...HEAD -- app/src/jobs/jobs.ts` empty |
| F-2 | `app/src/adapters/sqsJobConsumer.ts` untouched | C | diff empty |
| F-3 | `app/src/services/oneToOneRetryDecision.ts` untouched (R8) | C | diff empty; it still imports `MAX_SEND_RETRY_ATTEMPTS` through the re-export `retrySend.ts:110` |
| F-4 | The marker helper stays; `retrySend` never WRITES it | C | `putJobExecutionMarker` absent from `retrySend.ts` (removed call, old line 409 of the diff); only the read-only belt `getJobExecutionMarker` (`retrySend.ts:448-454`, D10); `messagesRepo.ts` marker functions unchanged |
| F-5 | `sendRefusalCases.ts` gets no row | C | not in the diff |

### R1 - the owner kind

| id | decision | verdict | evidence |
|---|---|---|---|
| R1-1 | `retry_send` owner shape (conversationId, retriedTsMsgId, attempt, recipientKey, retryRoot) | C | `sendAttemptsRepo.ts:63-70` |
| R1-2 | `ownerKey` = `retry#<conv>#<retried>#<attempt>`; root a fact (stored in the record's owner map) | C | `sendAttemptsRepo.ts:179`; owner persisted whole (`sendAttemptsRepo.ts:295-328` claim expression `#owner`) |
| R1-3 | `recipientKey` from immutable data (row's `recipient_contact_id`, else `phone#<participant_phone>`), never from a live check, never in the job payload | C | `retryChain.ts:47-54`; `retrySend.ts:399`; payload shape `retrySend.ts:117-130`, re-enqueues `:732-735`, `sendReconcile.ts:1521-1524` |
| R1-4 | Ref carries `recipientKeyHash`; the reconcile re-derives and compares; a mismatch is unaddressable (INFO, sweeper) | C | `sendReconcile.ts:619-640` (`:630`); `:500-509` |
| R1-5 | Facts: digest(sender from ONE shared helper, participant phone), body hash/short, `mediaCount` from the one media function the job, facts and adoption call | DD (D9: the adoption reads `record.mediaCount`) | `app/src/lib/outboundSender.ts:7-9`; `app/src/services/sendMessage.ts:601`; `retrySend.ts:487-496`, `:217-228`; adoption `sendReconcile.ts:860-865` |
| R1-6 | `SendAttemptOwnerRef` arm; `toOwnerRef`, parser, `ownerRefLog`, `ownerLog`; payload carries no phone | C | `sendReconcile.ts:141-152`, `:195-202`, `:257-270`, `:463-471`, `:486-493` |
| R1-7 | `RetrySendPayload.deferred?: true`, carried by the parser, set only by the deferral re-enqueue | C | `retrySend.ts:129`, `:153`, `:733`; re-drive omits it `sendReconcile.ts:1522` |

### R2 - the job's order and phases

| id | decision | verdict | evidence |
|---|---|---|---|
| R2-1 | Step 1: read the retried row; not found / not outbound -> WARN; root; window origin (fail-open) | DD (D3: consistent read; D11: a payload/row conversation mismatch is a third WARN decline) | `retrySend.ts:349-371` |
| R2-2 | Step 2: recorded recipient read by id before the claim | C | `retrySend.ts:379-390` |
| R2-3 | Step 3: conversation read; missing / group / relay / phone-less = designed WARN decline in the decision's vocabulary; derive `recipientKey` | C | `retrySend.ts:395-403`; `retryChain.ts:60-74` |
| R2-4 | Step 4: existing attempt resolved FIRST (stale attempting -> takeover -> reconcile; fresh attempting / reconciling -> INFO; terminal done -> INFO; absent / retryable / redriven proceed) | C | `retrySend.ts:421-435`; `app/src/lib/sendAttemptGate.ts:30-39` |
| R2-5 | Marker gone from the job | DD (D10: a read-only pre-adoption belt when no record exists, dated TODO) | `retrySend.ts:436-454` |
| R2-6 | 4a: a MANUAL child (retry_of, no retry_attempt) supersedes - ONE consistent Query on `retrychild#` | C | `retrySend.ts:461-466`; `messagesRepo.ts:3359-3385` |
| R2-7 | 4b: strict window, ERROR `retry window closed` | C | `retrySend.ts:472-481` |
| R2-8 | A decline on `redriven` closes `closeRedriven(refused, cause)`; on retryable / absent nothing written; a decline holds no claim; a thrown close fails the delivery (step 1-4 rule) | C | `retrySend.ts:687-692` (FW1 C-1) |
| R2-9 | Step 5: claim; refused fresh / !fresh INFO; takeover -> unknown path; `secondUnknownWouldClose` / `secondDeferralWouldClose` | C | `retrySend.ts:497-514`, `:717` |
| R2-10 | Step 6: presign; a throw is the prepare-phase deferral | C | `retrySend.ts:519`, `:580-584`, `:241-269` |
| R2-11 | Step 7: today's args + `retryRoot` + `broadcastId` + `beforeProviderSend` re-arm; a lost re-arm sends nothing, writes nothing | C | `retrySend.ts:532-554`, `:592-597` |
| R2-12 | Step 8: `finishAttempt(sent, sid)` through `guardWrite`; a lost fence WARNs (not sent_unrecorded); INFO `message re-sent`; no promise write | C | `retrySend.ts:563-571` |
| R2-13 | Registered WITHOUT the marker | C | `retrySend.ts:331`; `app/src/jobs/registerHandlers.ts:61` |
| R2-14 | Steps 1-4 may throw (redelivery, nothing sent); ONE try/catch over 6-8 with phases; nothing throws after the claim | C | `retrySend.ts:515-641` |

### R3 - the arms

| id | decision | verdict | evidence |
|---|---|---|---|
| R3-1 | NEW conditional `annotateRetryPromise` (absent expectation allowed; stale read loses) | C | `messagesRepo.ts:3388-3428` - four expression shapes, each listing exactly its aliases |
| R3-2 | REFRESH = conditional write then `message.persisted`; a lost REFRESH is dropped | C | `retryPromiseWrites.ts:43-69` |
| R3-3 | WITHDRAW = sentinel + outcome in one write, retried ONCE from a fresh read | C | `retryPromiseWrites.ts:76-106` |
| R3-4 | "Every guardWrite loss is logged at ERROR" | DD (D6: guardWrite logs THROWS at ERROR; a lost FENCE is logged by the site - INFO, or WARN where the spec says WARN) | `app/src/lib/guardWrite.ts`; `retrySend.ts:657-669`, `:568-570`, `:821` |
| R3-5 | Refused (incl. the kill switch) -> `done/refused` cause code, promise untouched, WARN | DD (D2: the ADAPTER's kill switch, classified rejected, also takes this arm) | `retrySend.ts:586-590`, `:615-619`, `:673-676` |
| R3-6 | Rejected -> `done/rejected` cause code or status, ERROR with the code, no row, promise untouched | C | `retrySend.ts:614-634` |
| R3-7 | Deferred: single deferral - ENQUEUE first (`deferred: true`, RSW backoff), release retryable, REFRESH to run time; terminal `refused` `deferral_cap` / `retry_window_closed` ERROR; enqueue throw -> `refused` `enqueue_failed` ERROR; promise untouched when terminal | C | `retrySend.ts:707-759` (see Finding 3 for "single") |
| R3-8 | Unknown: `handToReconcile` FIRST, enqueue check 0, REFRESH to attemptedAt + checks[2] + grace, INFO; second unknown -> `finishAttempt(unresolved, second_unknown)` + WITHDRAW + ERROR; enqueue throw -> `closeFromReconcile(unresolved, enqueue_failed)` + WITHDRAW + ERROR | C | `retrySend.ts:767-855` |
| R3-9 | Accepted-not-recorded -> reconciling WITH the SID, ERROR `sent_unrecorded`, REFRESH | C | `retrySend.ts:602-610`, `:806-823` |
| R3-10 | Taken over before the send -> untouched, INFO | C | `retrySend.ts:592-597` |
| R3-11 | Step-5 takeover = the unknown path with the taken-over attemptedAt, incl. REFRESH | C | `retrySend.ts:506-511` -> `handOff` `:767-803` |

### R4 - the reconcile's fourth owner

| id | decision | verdict | evidence |
|---|---|---|---|
| R4-1 | The owner at EVERY dispatch site; every owner `switch` ends in a `never` default | C | `unhandledOwner` `sendReconcile.ts:165-167`, used at 11 sites (`toOwnerRef`, `ownerRefLog`, `ownerLog`, `resolve`, `currentPhone`, `rowIsMine`, `adopt`, `closeSlot`, `afterClose`, `enqueueRedrive`, `redriveRefusal`); `parseOwnerRef` default throws; `relayRowKey` narrowed `:369-374`; repo switches `sendAttemptsRepo.ts:169-202` |
| R4-2 | Resolve: retried row consistently, conversation eventually; row missing -> INFO, sweeper | C | `sendReconcile.ts:619-640`, `:500-509` |
| R4-3 | Digest check; a changed participant phone -> `unresolved` `digest_mismatch` | DD (C-7: a PHONE-keyed owner whose number changed cannot be re-keyed, so it is unaddressable per R1 - INFO, sweeper; the contact-keyed owner follows this bullet) | `sendReconcile.ts:671-677`, `:1115-1118`, `:630` |
| R4-4 | Lookup: predecessors (producers of the automatic `retry_of` ancestry, attempt-matched; the share root's own broadcast record) are never siblings; same root is not lineage | C | `sendReconcile.ts:1080-1095`, `:1135-1149`; `retryChain.ts:36-45` |
| R4-5 | `heldBy`: a `sid#` row with this attempt's `retry_of` + `retry_attempt` is MINE; any other row `other`; `syssid#` `system` | C | `sendReconcile.ts:723-797` (`:776-778`) |
| R4-6 | Adopt through `messagesRepo.append` with the full field set, `recipientContactId` only when a contact key still exists and holds the number, dedupe `skipped` / `other`, audit once, preserving touch, emits, no promise write, terminal failure WARN | DD (D9: media from the record's `mediaCount`) | `sendReconcile.ts:850-947` |
| R4-7 | `never_sent`: window FIRST (backoff 0); inside: `markRedriven`, enqueue the payload without `deferred` at now, REFRESH now + job grace + promise grace; outside: `redrive_refused` / `retry_window_closed` while reconciling, ERROR, promise untouched; re-drive enqueue throw -> `enqueue_failed`, no `retry_outcome` | C | `sendReconcile.ts:1540-1565`, `:1577-1597`, `:1607-1644`, `:1513-1526`, `:1434-1468` |
| R4-8 | `unresolved`: record FIRST, then WITHDRAW, then the emit, ONE ERROR | C | `sendReconcile.ts:1402-1423`, `:1308-1333` |
| R4-9 | Crash safety: only `unresolved` maps to the WITHDRAW; the superseded exit re-applies idempotently; `afterClose` = the retried row's emit; no finalize / root close | DD (D5: the map lives in `closeSlot`'s arm keyed on the code) | `sendReconcile.ts:528-532`, `:1308-1333`, `:1375-1386`; FW1 C-2 throw `:1329-1331` makes a failed WITHDRAW reach the re-apply |

### R5 - "retry not confirmed"

| id | decision | verdict | evidence |
|---|---|---|---|
| R5-1 | `retry_outcome?: 'unconfirmed'` written only by the WITHDRAW, always with the sentinel | C | `messagesRepo.ts:1077`; `append` never writes it; only writer `annotateRetryPromise` (`:3395-3407`) via `withdrawRetryPromise` |
| R5-2 | Projected; dashboard type mirrors the app's literal | C | `app/src/routes/contactTimeline.ts:462`; `dashboard/src/api/types.ts:2527`; `dashboard/src/routes/contact/retryPromise.ts:33`; `retryPromiseMirror.test.ts` |
| R5-3 | `deliveryReason('30003', { retryUnconfirmed })` -> `Phone unreachable - retry not confirmed` (+ `(error 30003)`); outranks `retryScheduled`; `relay` outranks both; failure tone | C | `dashboard/src/routes/contact/deliveryStatus.ts:965-967`, `:1192-1197` |
| R5-4 | Retry hidden while the promise is live AND on `unconfirmed` | C | `Timeline.tsx:1441` |
| R5-5 | Readers: the one-to-one bubble only | C | only `Timeline.tsx:1056-1071` passes `retryUnconfirmed` |

### R6 - the manual Retry route

| id | decision | verdict | evidence |
|---|---|---|---|
| R6-1 | After RSW's `retry_pending`: ANY child -> 409 `superseded`, one consistent Query, no time bound | C | `api.ts:1626-1642` |
| R6-2 | Records read DIRECTLY by key (three gets) under R1's key; the row's `retry_outcome` as a belt | DD (D1: one get at `(retry_attempt ?? 0) + 1` - the only attempt the webhook can schedule against a row, `oneToOneRetryDecision.ts:125-129`) | `api.ts:1650-1666` |
| R6-3 | 409 `retry_unresolved` on a `done/unresolved` record or the row belt | C | `api.ts:1670-1676` |
| R6-4 | 409 `retry_pending` on an open record younger than `RETRY_SEND_WINDOW_MS`; other done outcomes never block | C | `api.ts:1683-1690` |
| R6-5 | The route's append carries `retryRoot` + `broadcastId` (pointer via `append`) | C | `api.ts:1765-1769` |
| R6-6 | Dashboard copy for 409 `superseded` and `retry_unresolved` | C | `Timeline.tsx:139-142` |
| R6-7 | The residual windows mapped in a dated note | C | `docs/issues/manual-retry-double-send-residual-windows.md` (2026-09-28 section) |

### R7 - attribution, the pointer family, the fenced line

| id | decision | verdict | evidence |
|---|---|---|---|
| R7-1 | `NewMessage.retryRoot` / `MessageItem.retry_root`; `sendMessage` passes it | C | `messagesRepo.ts:760`, `:1057`, `:2619`; `sendMessage.ts:370`, `:680` |
| R7-2 | `retrychild#` pointer in the SAME transaction for every row with `retryOf` (automatic, adopted, manual), carrying `retry_attempt` (absent for manual) and the SID; never updated | C | `messagesRepo.ts:2785-2799` (the row's `expires_at` clause is vacuous: message rows never set it, `app/src/lib/tables.ts:212-213`) |
| R7-3 | A parent's children = ONE consistent Query | C | `messagesRepo.ts:3359-3385` |
| R7-4 | Non-share root: `broadcast_id` absent, `retry_root` set | C | `retrySend.ts:543-544`; `api.ts:1768-1769`; `sendReconcile.ts` adoption |
| R7-5 | Read `isBroadcastRowFor` and state in the handback what it does with a `retry_of` row | DD (D7: a code change - a retry row is never the share recipient's own row) | `broadcastFanOut.ts:1299-1303`; handback section 3 item 7 |
| R7-6 | Cost until Branch B as stated: a share-retry receipt misses the slot, waits once, gives up, writes nothing | C | `twilio.ts:3529`, `:3885-3907` (unchanged but the level) |
| R7-7 | `send-attempt-sweeper` records the family | C | `docs/issues/send-attempt-sweeper.md:510-512` |

### R8 - R12

| id | decision | verdict | evidence |
|---|---|---|---|
| R8 | 30003 decision unchanged; the adoption writes `retry_attempt` / `retry_window_start` at append | C | F-3; `sendReconcile.ts:890-902` |
| R9 | Levels (refusals WARN; rejection, window close, second deferral, failed re-schedule, second unknown, unresolved close ONE ERROR; hand-offs / takeovers INFO); fields; no phone / body | C | `retrySend.ts:372`, `:412` (`safeRecipientKey`), arms above; `sendReconcile.ts:486-493`, `:1591-1594` |
| R10 | Branch B contract fields on every retry row; the unresolved pair on the retried row; the record kind | C | S0-5, R5-1, R1-1; `listByRecipient` unchanged |
| R11 | No new seam | C | `scripts/e2e-session.mjs` not in the diff; only the existing two seams used |
| R12 | SOR D8a TTL; record-first closes; no D16a finalize / root emits; lineage exclusion | C | `sendReconcile.ts:1402-1423`, `:1577-1597`, `:1375-1386`, `:1080-1095` |

### Section 4 - what must be proven (a named test in the tree for each)

| item | verdict | test (file :: name, abbreviated) |
|---|---|---|
| 1 | C | `app/test/retrySendAttempt.test.ts` :: "1 FAILS ON MAIN: an unknown provider error..." (+ "1b a phone-keyed attempt...") |
| 2 | C | `retrySendAttempt.test.ts` :: "2 a rejected retry (21211 with a 4xx status)..." |
| 3 | C | `retrySendAttempt.test.ts` :: "3 a refused retry (the contact opted out during the backoff)..." |
| 4 | C | `retrySendAttempt.test.ts` :: "4 a 429 is deferred ONCE...", "4-cap ...", "4-window ...", "4-redriven ...", "4-enqueue ...", "4-prepare ...", "4-lost ..."; parser pin in `app/test/twilioStatusWebhook.test.ts` :: "payload parsing rejects malformed payloads and the attempt cap" |
| 4b | C | `retrySendAttempt.test.ts` :: "4b records are per RETRIED ROW..." |
| 4c | C | `retrySendAttempt.test.ts` :: "4c a manual retry supersedes the chain..." (60 noise rows, no thread scan, automatic child does not trigger) |
| 4d | C | `retrySendAttempt.test.ts` :: "4d an existing attempt is resolved BEFORE the window..." |
| 4e | C | `retrySendAttempt.test.ts` :: "4e a conversation that is missing, a group text, a relay group, or a thread without a participant phone..." |
| 5 | C | `retrySendAttempt.test.ts` :: "5 accepted-not-recorded (the append throws)..." |
| 6 | C | `retrySendAttempt.test.ts` :: "6a", "6b", "6c", "6d" (+ "6e", "6f", "6g"); `twilioStatusWebhook.test.ts` :: "DUPLICATE GUARD: a redelivered job (same jobId) meets the record..." |
| 7 | C | `retrySendAttempt.test.ts` :: "7 a successful retry..."; the `annotates === 0` pin in `twilioStatusWebhook.test.ts` now also counts `annotateRetryPromise` |
| 8 | C | `retrySendAttempt.test.ts` :: "8 attempt 2: the retried row is the attempt-1 retry row..."; `app/test/retryChain.test.ts` |
| 9 | C | `retrySendAttempt.test.ts` :: "9 reads before the claim..." |
| 10 | C | `app/test/sendReconcile.test.ts` :: "10 a listed orphan adopts...", "10a", "10b", "10b2", "10c", "10c2", "10d", "10g", "10h" |
| 11 | C | `sendReconcile.test.ts` :: "11 never_sent inside the window re-drives ONCE...", "11a", "11b", "11c"; `retrySendAttempt.test.ts` :: "11 (second half)..."; `app/test/apiRoutes.test.ts` :: "R6: 201 on a STALE open record ... and on every done outcome but unresolved" (covers `enqueue_failed`) |
| 12 | C | `sendReconcile.test.ts` :: "12 unresolved (the list fails on every check)..." (+ "12a", "12a2", "12b", "12c", "FW1 C-2 (failed)", "FW1 C-2 (lost)") |
| 13 | C | `sendReconcile.test.ts` :: "13", "13a", "13a2", "13a3", "13b", "13c", "13d", "13e" (C-8: the attempt-match clause proven jointly with the walk's stop) |
| 14 | C | `sendReconcile.test.ts` :: "10e the known-SID path adopts ... as a repair (mine)... (spec 14)" |
| 15 | DD (D8: a 31 s `attempting` answers 409 by R6; "stale" tested at `RETRY_SEND_WINDOW_MS + 1 s`) | `apiRoutes.test.ts` :: the eleven "retry-send-adoption R6/R7 ..." cases incl. "409 retry_unresolved ... a 45-day-old record", "guard order", "... through the REAL send wrapper ... 60 newer rows ... ONE pointer Query" |
| 16 | C | `dashboard/src/routes/contact/deliveryStatus.test.ts` :: "R5: retryUnconfirmed reads..."; `Timeline.delivery.test.tsx` :: the three R5 cases; `Timeline.test.tsx` :: "R6: a 409 %s on the manual Retry reads its own sentence"; `app/test/contactTimeline.test.ts` :: "R5: projects retry_outcome..."; `retryPromiseMirror.test.ts` :: "the retry not confirmed outcome is the SAME literal on both sides" |
| Repo | C | `app/test/messagesRepoRetryLineage.integration.test.ts` :: the seven one-to-one lineage cases incl. both `annotateRetryPromise` cases; `app/test/sendAttemptsRepo.integration.test.ts` :: the two `retry_send` cases (claim / re-arm / hand-off; `listByRecipient` beside a broadcast attempt) |
| Harness parity | C | `twilioWebhookHarnessRetryFields.test.ts`, `twilioWebhookHarnessRepoAdditions.integration.test.ts`, `twilioWebhookHarnessSendAttempts.integration.test.ts` (diffs extend `messagesAgree`, `MSG_CASES`, the fourth owner kind) |
| 17 | C | `e2e/tests/dashboard-next/retry-send-adoption.spec.ts` :: "17 accept_then_drop..." (two carrier texts = original + ONE retry) |
| 18 | C | same file :: "18 drop_before_create..." (one never_sent WARN at check 2, one retry text) |
| 19 | C | same file :: "19 drop_before_create plus fail-list x3..." (WARN, WARN, ONE ERROR for the owner; 409 `retry_unresolved`; the original alone at the carrier; no Retry, with a positive control) |

### Section 5 - issues

| id | note | verdict | evidence |
|---|---|---|---|
| I-1 | `retry-send-lost-under-job-marker` - built, stays open for the human | C | `docs/issues/retry-send-lost-under-job-marker.md:154-` (status open) |
| I-2 | `accepted-send-lost-when-append-fails` piece 2 for this caller | C | `.md:107-` |
| I-3 | `manual-retry-double-send-residual-windows` gaps mapped | C | 2026-09-28 section |
| I-4 | `broadcast-30003-retry-never-updates-slot` attribution landed, matching is B's, the rollup cost | C | `.md:62-` |
| I-5 | `send-attempt-sweeper` the owner shape and strand cases | C | `.md:510-` and the dated note |
| I-6 | `send-reconcile-job-residues` the fourth owner inherits the residues | C | `.md:299-` |
| I-7 | `one-to-one-retry-promise-outlives-job-decline` untouched | C | no diff |
| I-8 | hosted-dev checks cover this owner | C | `send-reconcile-hosted-dev-checks.md:122-` |

### Plan Global Constraints that are contracts, and the gates

| id | contract | verdict | evidence |
|---|---|---|---|
| G-1 | ASCII on every added line | C | 0 added lines with a byte above 0x7F across the 41 code files (regex over the package's `+` lines); 14 removed non-ASCII lines were re-worded (e.g. `twilio.ts:3904`, `sendMessage.ts` comments) |
| G-2 | Every DynamoDB expression lists exactly the aliases it uses | C | `annotateRetryPromise` `messagesRepo.ts:3395-3407` (`#due` always used; `#ro`/`:ro` only on WITHDRAW; `:expected` only when expected); `listRetryChildrenConsistent` `:3366-3372` (`:p` only, no names) |
| G-3 | The `retrychild#` Put after the email pointer and the due row, before the media pointers; index 1 stays `sid#` | C | `messagesRepo.ts:2719-2730`, `:2737-2799`, `:2816-2820`; attribution reads `reasons[1]` `:2836` and the email index `:2873` |
| G-4 | No promise write on success, refusal, rejection, window close or deferral cap | C | S0-7 evidence |
| G-5 | Hop count: no self-enqueue beyond the plan's (worst case = `MAX_HOP_COUNT` 10) | C | enqueues: deferral `retrySend.ts:732`, check 0 `:769`, re-drive `sendReconcile.ts:1521`; `jobs.ts:166-167` (webhook enqueue = hop 1; worst chain webhook 1, deferral 2, checks 3-5, re-drive 6, deferral 7, accepted-not-recorded checks 8-10) |
| G-6 | Coordination reads consistent (retried row, pointer partition, attempt record, lineage walk); conversation eventual | C | `retrySend.ts:349`; `messagesRepo.ts:3371`; `sendAttemptGate.ts:31`; `retryChain.ts:28`, `:42`; `api.ts:1658` (the route's pressed-row read `api.ts:1592` is the pre-existing eventual read; it feeds only the belt and immutable fields) |
| G-7 | Import cycle: cross-module bindings used only inside functions | C | `retrySend.ts:90-96` used inside handler closures; `sendReconcile.ts:108` used only in `enqueueRedrive` |
| GATES | typecheck / npm test / smoke / e2e 300/300 / lint 0 new, as the handback reports | U | not run by charge (a gate e2e was live) |

## 2. The eleven declared deviations - judged

| # | deviation | judgement |
|---|---|---|
| 1 | R6 reads ONE record per pressed row | Legitimate. The webhook schedules exactly `(retry_attempt ?? 0) + 1` against a failed row (`oneToOneRetryDecision.ts:125-129`); the other two keys cannot exist. Same answer. Pinned by `apiRoutes.test.ts` "the record is read at attempt (retry_attempt ?? 0) + 1 only". |
| 2 | The adapter's kill switch takes the refused arm | Legitimate. It is the spec table's intent (the kill switch is a refusal); only the class differs. |
| 3 | The retried row is read consistently | Legitimate and stronger: the promise writes are conditioned on this read. |
| 4 | The fenced line re-worded to ASCII as well as re-leveled | Legitimate. One character; no alarm, metric filter, test or doc outside this branch matches the string (repo-wide search). |
| 5 | The WITHDRAW map in `closeSlot` keyed on the code | Legitimate. Observable rule identical: only `SEND_UNCONFIRMED_CODE` withdraws (`sendReconcile.ts:1327`), from the unresolved close and from the superseded exit's `slotCloseOf('unresolved')`. |
| 6 | Lost fences logged by the site, not at ERROR | Legitimate. The spec's premise about `guardWrite` was wrong (it logs throws); a lost fence is expected concurrency (a takeover owns the record) and INFO is the SOR idiom. |
| 7 | `isBroadcastRowFor` refuses `retry_of` rows | Legitimate, defensive. Pre-branch retry rows never carried `broadcast_id`, so no existing data changes meaning; without it a share-retry row could read as the share slot's own row (`mine`) in the broadcast adoption / `heldBy`. |
| 8 | "Stale" = older than `RETRY_SEND_WINDOW_MS` for every open state | Legitimate. It follows R6's decision text over item 15's leftover example; safer (a crashed attempt is still reconciled before a person re-sends). |
| 9 | The adoption reads `mediaCount` from the record | Legitimate. One source of truth (the job's plan at claim time); the rule is unchanged, and the reconcile gains no MediaStore dependency. Raw `mediaUrls` riding the adopted row are the retried row's own stored value, the same bytes the job replays. |
| 10 | Read-only marker belt for pre-deploy redeliveries | Legitimate as the planner's own ruling; it narrows sends only for envelopes the pre-adoption code already ran (which that code also suppressed), never writes a marker, and carries a dated removal TODO (`retrySend.ts:444-447`). Strictly it goes beyond R2's "the marker goes"; stamp it in the errata (Finding 4). |
| 11 | Payload/row conversation mismatch is a WARN decline | Legitimate. Unreachable from the webhook, a deferral or a re-drive; it keeps the owner addressable. |
| C-7 | Phone-keyed owner whose number changed follows R1 (unaddressable) | Legitimate; R1 and R4 disagree for that case and R1 is the only implementable reading (the key cannot be re-derived). Round 2 notes it is unreachable. |
| C-8 | Item 13's attempt-match proven jointly with the walk's stop | Acceptable; defense in depth. |

## 3. Notes that are not findings

- The branch's REFRESHES (unknown hand-off, re-drive) lengthen RSW's accepted
  overhang after a no-send close (up to about 4-5 minutes of "will retry" and
  409 `retry_pending`). This is the design the spec approved (R3 / R4 REFRESH;
  section 7's first risk) inside the wontfix class; the handback raises it for
  Cameron. Not a conformance defect.
- The rollup alternative (R2-7: guard the call site at `twilio.ts:3529` on
  `retry_of`) is a different fenced line from the one Cameron approved; the
  build correctly kept the approved one.
- FW1's two new throws (a re-driven record's pre-claim close, `retrySend.ts:689`;
  a failed/lost reconcile WITHDRAW, `sendReconcile.ts:1329-1331`) implement the
  spec's own recovery rules (steps 1-4 redeliver; the superseded exit
  re-applies). A persistent DynamoDB fault there now dead-letters after five
  receives - declared in the handback's deploy notes.

## 4. Findings

### Finding 1 - LOW - Q1's display half is not re-applied when the JOB's own unresolved close cannot write its WITHDRAW

- What is wrong: after the job closes an attempt `unresolved` itself (a
  second unknown on a re-driven attempt, or a check-0 enqueue that threw), a
  WITHDRAW that throws or loses twice is logged and dropped. Nothing
  re-applies it: no reconcile check exists for that attemptedAt. The row keeps
  its last promise, then (after it expires) reads the plain failure and
  offers Retry, against Q1's "reads retry not confirmed ... NO Retry button".
- Evidence: `app/src/jobs/retrySend.ts:786-792`, `:844-850`;
  `app/src/services/retryPromiseWrites.ts:98-105`.
- What it implies: display only, and only under a DynamoDB fault. The record
  (`done/unresolved`) still refuses every press with 409 `retry_unresolved`
  (`app/src/routes/api.ts:1670-1676`), so no second text. Declared (C-2 job
  half) and filed in `send-attempt-sweeper`.
- Fix if small: none needed for merge. (A later option: have the job's own
  unresolved close enqueue one idempotent re-apply, or teach the gate's
  `skip` on a `done/unresolved` record to re-apply the WITHDRAW - both new
  paths, correctly deferred.)

### Finding 2 - LOW - The in-flight residual is wider than spec R6 says (round 2 R2-6)

- What is wrong: R6 states the residual race "lasts the manual send's
  duration". When the manual press's OWN provider call ends unknown or
  accepted-not-recorded, the route returns 500 with NO manual row, so a late
  automatic job's step 4a never sees a manual child and claims and sends; the
  overlap then lasts until the automatic chain's window closes.
- Evidence: the route catches only `SendRefusedError`
  (`app/src/routes/api.ts:1774-1780`) and writes nothing the job contends on
  (`:1638-1690`); the job's check is `app/src/jobs/retrySend.ts:461-466`, its
  claim `:497`.
- What it implies: a possible double text (HIGH at most on Cameron's scale),
  but only on a compound rare path (a late or orphaned automatic job AND a
  manual press whose own outcome is unknown). Not introduced here - on `main`
  the late job has no supersession check at all - and filed with the
  reviewer's suggested fix (a route-side conditional write on the same record
  key), which carries a product trade-off.
- Fix if small: none on this branch; Cameron's call from the filed note.

### Finding 3 - LOW - "The attempt's SINGLE deferral" holds per payload, not per attempt

- What is wrong: the gate lets any delivery proceed over `done/retryable`
  (`app/src/lib/sendAttemptGate.ts:33`), and the terminal-deferral test reads
  only `payload.deferred` (`app/src/jobs/retrySend.ts:717`). An SQS
  redelivery of the ORIGINAL (non-deferred) envelope after that run released
  the record retryable therefore re-claims, may send ahead of the scheduled
  deferred run, or may take a SECOND deferral.
- Evidence: `retrySend.ts:421-435`, `:497`, `:707-759`.
- What it implies: no double text (the claim serializes the original's
  redelivery and the deferred run; the loser skips at the gate or is refused
  fresh) and the hop bound is unchanged (both deferrals are hop 2). It needs a
  failed SQS DeleteMessage after a normal return. Conforms to the spec's
  letter (R2 step 4 admits `done/retryable`); only R3's "single" wording
  overstates it.
- Fix if small: none; name it in the errata (Finding 4).

### Finding 4 - LOW - Spec text the planner should stamp as as-built errata (no code change)

- What is wrong: several spec sentences no longer describe the approved,
  built behavior:
  1. Section 4 item 15, "200 on a stale attempting (31 s)" - R6's bound makes
     it 409 (D8; `api.ts:1683-1690`).
  2. R6, "three consistent gets" - one get (D1; `api.ts:1653-1666`).
  3. R3, "every guardWrite loss is logged at ERROR" - throws at ERROR, lost
     fences at the site's level (D6).
  4. R4's digest bullet vs R1 for a PHONE-keyed owner (C-7;
     `sendReconcile.ts:630`).
  5. R2, "the run-once marker is removed from this job" - plus the read-only
     belt (D10; `retrySend.ts:436-454`).
  6. R5, "Never on relay or broadcast rows" - correct for the relay and
     broadcast OWNERS (their closes never write it), but a share's own
     one-to-one message row (it carries `broadcast_id`) DOES receive
     `retry_outcome` when it is the retried root of an unresolved attempt 1 -
     which Q1 and R10 require (`sendReconcile.ts:1327-1328` on `r.row`).
     Branch B should read the sentence that way.
  7. R3, "the attempt's SINGLE deferral" - per payload (Finding 3).
  8. R7, the pointer "carrying ... the row's expires_at if it has one" -
     vacuous: message rows never carry it (`app/src/lib/tables.ts:212-213`).
- What it implies: a reader of revision 5 (Branch B's planner, the next
  reviewer) could mistake built behavior for drift.
- Fix if small: an "Errata as built" section on the spec (the SOR section 12
  pattern) when the planner stamps the docs.

### Finding 5 - LOW - A replayed promise write skips its re-render emit (round 2 R2-1, filed)

- What is wrong: R3 defines REFRESH / WITHDRAW as the write "followed by
  message.persisted". If an SDK retry replays a write that already committed,
  the replay fails its own condition: the REFRESH reports "dropped" and the
  WITHDRAW answers `already` - neither emits.
- Evidence: `app/src/services/retryPromiseWrites.ts:57-59` (dropped, no
  emit), `:83`, `:93` (`already`, no emit);
  `app/src/repos/messagesRepo.ts:3411-3413` (a failed condition is `false`;
  no op token).
- What it implies: an open dashboard keeps a stale bubble until its next
  refetch after the JOB's own closes (the reconcile's `afterClose` emits
  anyway, `sendReconcile.ts:1375-1386`). Server state and the route stay
  correct. Filed as `retry-promise-write-replay-skips-rerender` (low).
- Fix if small: emit on the `already` / dropped exits too (a spurious emit is
  harmless); not needed for merge.

## 5. Counts

| verdict | rows |
|---|---|
| CONFORMS | 107 |
| DEVIATES-DECLARED | 13 |
| DEVIATES-UNDECLARED | 0 |
| MISSING | 0 |
| UNVERIFIED | 1 (the gates, not run by charge) |

Declared-deviation rows: S0-3b (C-2 job half), S0-4 (D4), R1-5 (D9), R2-1
(D3, D11), R2-5 (D10), R3-4 (D6), R3-5 (D2), R4-3 (C-7), R4-6 (D9), R4-9
(D5), R6-2 (D1), R7-5 (D7), item 15 (D8). All eleven numbered deviations
appear; every one is judged legitimate.
