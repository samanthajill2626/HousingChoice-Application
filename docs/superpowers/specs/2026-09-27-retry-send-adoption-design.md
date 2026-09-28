# Retry-send adoption (send-outcome Stage 1b) - design

Anchor issue: `retry-send-lost-under-job-marker` (med). Branch
`feat/retry-send-adoption`, cut from `main@3dbb5740`, 2026-09-27.
Revision 3 (after design review rounds 1 and 2 - adjudications in
`docs/superpowers/reviews/2026-09-27-retry-send-adoption/design-review/adjudications.md`
- and Branch B's refined requirement of 2026-09-27).

This is the ADDENDUM the send-outcome-reconcile design (SOR, revision 12,
`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`)
promised in its section 2a item 4. It reads on top of that spec AS BUILT
(SOR section 12, the errata): every SOR decision (D1-D23) applies to the
one-to-one 30003 retry unless a decision below restates it. Decision
numbers here are R1-R12. The retry window is `feat/retry-send-window`
(RSW, `docs/superpowers/specs/2026-09-24-retry-send-window-design.md`); its
relay to SOR, cited below as "RSW relay B1-B8", is
`docs/superpowers/reviews/2026-09-24-send-outcome-reconcile/handoffs/rsw-relay-2026-09-26.md`.

## 0. Two rows, two names

A 30003 chain is: the ROOT send (attempt 0 - a staff text, an automated text,
or a share's text to one tenant), then up to three automatic retries. The
status webhook schedules retry N against the row that just failed - the
ROOT for N = 1, the retry row N-1 for N = 2, 3 - and writes `retry_due_at`
on THAT row. `retrySend` reads that row by `payload.providerSid`
(`app/src/jobs/retrySend.ts:174`). The contact timeline collapses the chain
so only the newest row is a bubble.

Every rule below uses exactly two names:

- **the RETRIED ROW** - the row `payload.providerSid` names: the previous
  attempt, the row carrying the live `retry_due_at`, the bubble on screen,
  the row `retry_of` points to. The promise, the refresh, the withdrawal and
  `retry_outcome` are written HERE.
- **the ROOT** - the chain's first send, `retry_root` = the retried row's
  `retry_root` if it has one, else its `retry_of` (a pre-deploy retry row
  carries `retry_of` and no `retry_root`; one hop reaches the root), else
  the retried row's own `tsMsgId`. Branch B routes a retry's receipt by it;
  the record carries it as a fact (R1) but does NOT key on it: a manual
  Retry row starts a NEW automatic chain under the same root, and its
  attempts must never meet the earlier chain's records.

Cameron's rulings of 2026-09-27 (relayed from the share-skip Branch B
planner) bound this addendum:

- **The joint gap (Q1 = a):** a retry the reconcile rules `unresolved`
  leaves the retried row reading "retry not confirmed", with no "will retry"
  promise and NO Retry button; staff who want to reach the tenant compose a
  fresh message. Its `retry_due_at` is WITHDRAWN (`RETRY_PROMISE_WITHDRAWN_AT`),
  not merely expired, so the share row and the bubble stop promising for the
  same reason at the same instant. Branch B counts such a recipient as
  "already sent" on the review list (the safe flag, as `send_unconfirmed`)
  and not in the ledger.
- **The webhook fence (Q2 = a):** `app/src/routes/webhooks/twilio.ts` stays
  fenced except ONE log-level change (R7).
- **Branch B's refined requirement:** every retry row 1b appends -
  automatic, adopted, AND the manual Retry route's row - carries BOTH
  `broadcast_id` (copied from the retried row) and `retry_root`. 1b writes
  nothing to the share slot; B routes a retry's receipt by `broadcast_id` +
  `retry_root` and defines how a later attempt moves a `failed` slot. No
  other field is owed.
- **Kept as accepted (Cameron, 2026-09-26, `one-to-one-retry-promise-outlives-job-decline`
  = wontfix):** after a refusal, a rejection, a window close or a success,
  the retried row's promise EXPIRES on RSW's clock (`retry_due_at` + 2 min);
  nothing here withdraws it early. Only the new `unresolved` close
  withdraws.

## 1. The invariant, restated for the one-to-one retry

SOR section 1's two guarantees, for `messaging.retrySend`:

1. **The tenant is not texted twice by the retry.** Every provider call the
   job makes is preceded by a claim on the send-attempt record and a re-arm
   immediately before the call (SOR D8a as built); a redelivered job, a
   concurrent retry and a re-driven rung all meet the record and stop. The
   manual Retry route meets RSW's time guard AND the record (R6).
2. **Every retry attempt reaches a state staff can see.** The job never
   throws after its claim. A rejected or refused retry ends the chain (the
   promise expires; the retried row keeps its own failure). A deferred retry
   re-schedules itself once inside the 15-minute window with the promise
   refreshed. An unknown outcome goes to `send.reconcile`, which adopts the
   text it finds (a retry row appears), re-drives the attempt once when
   nothing was sent, or closes `unresolved` with the promise withdrawn and
   the retried row marked "retry not confirmed".

The retried row's `retry_due_at` is therefore live (a retry is scheduled or
pending), expired (the chain ended some other way - the accepted RSW
overhang), or withdrawn (unresolved). The attempt RECORD, not the row, is
what the manual Retry route trusts.

## 2. Scope

**In:**

- `app/src/jobs/retrySend.ts` - the adoption (R1-R3, R7); the run-once
  marker is removed from this job (R2).
- `app/src/repos/sendAttemptsRepo.ts` - the `retry_send` owner kind (R1).
- `app/src/jobs/sendReconcile.ts` - the fourth owner at every dispatch site
  (R4), the lineage exclusion in the sibling rule (R4).
- `app/src/repos/messagesRepo.ts` - `NewMessage.retryRoot` and the
  `retry_root` row field (R7); `retry_outcome` (R5); the conditional
  `annotateRetryPromise` (R3).
- `app/src/services/sendMessage.ts` - passes `retryRoot` through to the
  append (R7). No new gate (`sendRefusalCases.ts` gets no row).
- `app/src/routes/api.ts` - the manual Retry route: the record guard (R6)
  and `retryRoot` + `broadcastId` on its append (R7).
- `app/src/routes/contactTimeline.ts`, `dashboard/src/api/types.ts` -
  `retry_outcome` on the projection (R5).
- `dashboard/src/routes/contact/deliveryStatus.ts`, `retryPromise.ts`,
  `Timeline.tsx` - the copy, the hidden Retry, the 409 `retry_unresolved`
  toast (R5, R6).
- `app/src/routes/webhooks/twilio.ts` - ONE line (R7).
- Tests, the webhook harness fakes, one e2e spec (section 4).

**Out - fences:**

- `twilio.ts` beyond R7's one line: the 30003 decision
  (`oneToOneRetryDecision.ts` behind it), the claim, the rollup's slot
  matching - Branch B's.
- `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT`), `app/src/adapters/sqsJobConsumer.ts`,
  the run-once marker HELPER (`putJobExecutionMarker` stays for its other
  callers; this job stops calling it).
- `broadcast-30003-retry-never-updates-slot`: the ATTRIBUTION half lands
  here (R7); the matching half is Branch B's. The issue stays open with a
  dated note.
- SOR's Stage 2 sites, the sweeper (D14), SOR's filed residues.
- RSW's promise expiry after a decline (the wontfix above).

## 3. Decisions

### R1 - the owner kind

`SendAttemptOwner` gains
`{ kind: 'retry_send'; conversationId: string; retriedTsMsgId: string; attempt: number; recipientKey: string; retryRoot: string }`.

- `ownerKey` = `retry#<conversationId>#<retriedTsMsgId>#<attempt>`: the
  webhook schedules attempt N against ONE specific failed row, so the pair
  (retried row, attempt) names exactly one scheduled retry. A manual Retry
  row that later fails 30003 is a new retried row and starts a fresh chain
  with fresh records; two chains under one root never collide (round 2
  finding 1). `retryRoot` rides the owner as a FACT (a plain attribute on
  the record and in the payload), not as part of the key.
- `recipientKey` is DERIVED FROM IMMUTABLE ROW DATA, not from a live check:
  the retried row's `recipient_contact_id` when the row has one (the send
  that appended it recorded the contact that held the number then), else
  `phone#<conversation.participant_phone>`. The FIRST run of an attempt
  derives it; every re-enqueue of that attempt (the deferral re-run, the
  re-drive) and the reconcile payload carry it verbatim
  (`payload.recipientKey`; the ref carries `recipientKeyHash`), and a crash
  redelivery re-derives the same value from the same row - so no contact
  edit can fork the chain into a second record (round 2 finding 2).
  `contactHoldsPhone` still decides GATING inside `sendMessage` (RSW relay
  B4); it no longer decides a key.
- `attemptKey` (owner + hashed recipient) is the record's identity, as built.
- The facts: `recipientDigest(sender, participantPhone)` where `sender` is
  the number the conversation sends from (the same derivation `sendMessage`
  makes - the build reads it from one shared helper, adding one if none is
  exported) and `participantPhone` is the conversation's `participant_phone`;
  `bodyHash` / `bodyShort` from the retried row's body; `mediaCount` = the
  length of the media list the retry WILL SEND, taken from the job's own
  media resolution (`retrySend.ts:267-301`, factored into one function the
  job, the facts and the adoption all call): attachments with a MediaStore
  -> the attachments' count; attachments with no store -> 0 (the job sends
  body only); no attachments and raw `mediaUrls` -> their count; else 0.
- `SendAttemptOwnerRef` gains
  `{ kind: 'retry_send'; conversationId; retriedTsMsgId; attempt; retryRoot; recipientKeyHash }`;
  `toOwnerRef`, the payload parser, `ownerRefLog` / `ownerLog` gain the arm.
  The payload carries no phone.
- `RetrySendPayload` gains two optional fields the parser CARRIES:
  `recipientKey` (set by the first run; copied by every re-enqueue) and
  `deferred: true` (set only by the deferral re-enqueue). The webhook's
  initial enqueue sets neither.

### R2 - the job's order and phases

`retrySend`'s handler, in this order:

1. Read the retried row by provider SID (as today; not found / not
   outbound -> WARN, return). Derive `retryRoot` (section 0) and the window
   origin `oneToOneRetryWindowOrigin(retriedRow)` (RSW D2: the root's
   `provider_ts`, carried as `retry_window_start`; absent or unparseable ->
   RSW D5 fail-open: the window checks below are skipped with the existing
   WARN).
2. RSW D14: read the recorded recipient by id (as today).
3. Read the conversation for `participant_phone` and resolve the sender
   number - the facts R1 needs. A missing conversation, a conversation that
   is not a one-to-one thread (`group_text`, a relay group), or one with no
   participant phone is a DESIGNED DECLINE, never a throw: WARN
   `retrySend: conversation not retryable` with the reason, return (the
   promise expires) - the same refusals the webhook's decision applies
   before scheduling (RSW D11, `oneToOneRetryDecision.ts`; the build reuses
   its vocabulary). Derive `recipientKey` (R1) unless the payload carries
   it.
4. **AN EXISTING ATTEMPT IS RESOLVED BEFORE THE WINDOW GATES A NEW ONE**
   (round 2 finding 6): read the R1 record. If it exists: `attempting`
   older than the TTL -> `takeOver`, hand off to reconcile (R3's unknown
   path), return; `attempting` fresh -> INFO `a concurrent delivery owns
   this attempt`, return; `reconciling` / `redriven` / `done` -> the claim
   rules below decide (a `redriven` record is this job's re-drive and
   proceeds to step 5; every other state returns at INFO). A crash
   redelivery in the last minutes of the window therefore still reaches
   the attempt that may have sent. If the record is ABSENT:
   a. **A MANUAL RETRY SUPERSEDES THE CHAIN** (round 2 finding 3): if the
      conversation already holds a row with `retry_of === retriedTsMsgId`
      and no `retry_attempt` (a staff Retry of this same failed row -
      `listByConversationConsistent` newest-first, bounded to the rows
      after the retried row), decline: INFO `retrySend: a manual retry
      superseded this attempt`, return. This is the job's half of the
      late-job and enqueue-threw gaps; the route's half is R6.
   b. RSW D4: the strict window check. Past the window -> ERROR
      `retry window closed` and return (as today; the promise expires).
5. **CLAIM** (SOR D8a) on the R1 owner - the duplicate guard this job now
   has instead of the run-once marker. `refused fresh` -> INFO, return.
   `refused !fresh` -> INFO, return. `takeover` -> as step 4. `claimed`
   (from absent, `done/retryable` or `redriven`) -> `ref`;
   `secondUnknownWouldClose = record.redriveCount >= 1`;
   `secondDeferralWouldClose = payload.deferred === true`.
6. PREPARE: the presign (as today). A throw here is the prepare-phase
   deferral (R3, "deferred").
7. SEND through `sendMessage` with today's arguments PLUS
   `retryRoot`, `broadcastId: retriedRow.broadcast_id` (R7) and SOR's
   `beforeProviderSend` hook, which RE-ARMS the claim as the last step before
   the provider call; a lost re-arm sends nothing and takes the taken-over
   path (nothing written, not carried).
8. RECORD: `sendMessage` appended the retry row (lineage at append, RSW
   relay B1 #2); `finishAttempt(sent, sid)` through `guardWrite` - a lost
   fence leaves the record `attempting` for the sweeper and logs WARN
   `fence write failed after a recorded send` (never a `sent_unrecorded`
   ERROR: the row exists). INFO `message re-sent` as today. No promise
   write: the retried row's `retry_due_at` expires on RSW's clock, which
   keeps RSW's 409 stale-tab guard up for those two minutes, and the
   collapse already hides the retried row behind the new bubble.

Steps 1-4 run BEFORE the claim: a throw in any of them fails the delivery
and SQS redelivers it, and nothing was claimed or sent - the correct
outcome (today the marker made a post-marker throw a silent loss; that is
this issue). A redelivery that arrives before the claim re-runs the reads
and the checks once more - reads only, no send. One outer try/catch around steps 6-8 with SOR's phase tracking
(`prepare` / `sending` / `record`); every failure-arm write through
`guardWrite`; nothing throws after the claim.

Why the marker goes: a run that dies after its claim leaves the record
`attempting`; the redelivery of that same job (same `jobId`) is the only
thing that reaches this attempt again, and it must be allowed to meet the
record - fresh -> refused (no double send), stale -> takeover -> reconcile.
Behind the marker it would be suppressed and the attempt stranded until the
sweeper. The marker's own duplicate-suppression job is done by the claim,
which is stronger (it also stops a concurrent retry with a different
`jobId`).

### R3 - the arms

Each arm names the record outcome, the promise on the RETRIED ROW, the log
line and the exit. Promise writes go through a NEW conditional
`messagesRepo.annotateRetryPromise(conversationId, tsMsgId, patch: { retryDueAt: string; retryOutcome?: 'unconfirmed' }, expect: { retryDueAt: string | undefined })`
- a child-field write conditioned on `retry_due_at` still holding the value
the job read (absent allowed), so a writer holding a stale read loses;
"REFRESH to T" = that write with `retryDueAt: T` followed by
`message.persisted` for the retried row (RSW #3); "WITHDRAW" = the same
with `retryDueAt: RETRY_PROMISE_WITHDRAWN_AT` and `retryOutcome:
'unconfirmed'`. The only competing writer is this owner's own earlier
refresh (a redelivered check racing its successor), so a WITHDRAW that
loses its condition is retried ONCE from a fresh read and then wins; a
REFRESH that loses is dropped (the newer value stands). Every `guardWrite`
loss is logged at ERROR (that is what `guardWrite` does).

| outcome | record | retried row's promise | log | notes |
|---|---|---|---|---|
| `SendRefusedError` - incl. the kill switch, which `sendMessage` throws as a refusal (`SmsSendingDisabledError extends SendRefusedError`, `sendMessage.ts:107`) | `done` / `refused`, cause = the code | untouched (expires) | WARN `send refused - retry chain stopped` (as today) | |
| rejected (SOR D1: a Twilio 4xx, 30007 / 30005 / 30006 by code) | `done` / `rejected`, cause = code or status | untouched (expires) | ERROR `retry chain ended - provider rejected the retry`, with the code | The retried row keeps its own 30003. No retry row exists. |
| deferred: `SendNotAttemptedError`, a prepare-phase throw after the claim, or retryable (SOR D1: 429 / 20429 / 30022 / a connection that never opened) | `done` / `retryable` when re-scheduled; `done` / `refused` (cause `deferral_cap` or `retry_window_closed`) when terminal | REFRESH to the new run time; untouched when terminal | WARN `retry deferred - re-scheduled`; ERROR when terminal | The attempt's SINGLE deferral: `backoffMs = resolveSendRetryBackoffMs(attempt)`, `runAt = now + backoffMs`; if not `secondDeferralWouldClose` and `retryFitsSendWindow({ originMs, nowMs: now, backoffMs })`: ENQUEUE FIRST (`enqueueSendRetry({ ...payload, recipientKey, deferred: true }, runAt)`), then `finishAttempt(retryable)`, then REFRESH; the re-claimed run (from `done/retryable`) reads `payload.deferred` and treats its next deferral as terminal. Otherwise TERMINAL: `finishAttempt(refused, cause)` - a terminal, non-claimable outcome, so a later redelivery or duplicate cannot restart a chain the spec says ended (round 2 finding 5) - ERROR `retry deferred twice - chain ended` / `retry window closed`, promise untouched (expires). An enqueue that throws: `finishAttempt(refused, enqueue_failed)`, ERROR `retry re-schedule failed - chain ended`, promise untouched; nothing was sent. |
| unknown (SOR D2: 5xx, timeout, dropped socket, anything else) | `reconciling` (`handToReconcile` FIRST), then the enqueue | REFRESH to `attemptedAt + reconcileCheckDelaysMs()[2] + RETRY_PROMISE_GRACE_MS` | INFO `retry outcome unknown - handed to reconcile` | Enqueue `send.reconcile` at check 0 with the R1 owner ref. If `secondUnknownWouldClose` (a re-driven attempt came back unknown): SOR D13a - the record is still `attempting` here, so `finishAttempt(unresolved, second_unknown)`, then WITHDRAW, ERROR. An enqueue that throws after `handToReconcile`: `closeFromReconcile(unresolved, enqueue_failed)` then WITHDRAW, ERROR (a send may have happened). |
| `SendAcceptedNotRecordedError` (Twilio accepted, the append failed) | `reconciling` WITH the SID, then the enqueue | REFRESH as for unknown | ERROR `sent_unrecorded` with the SID | The reconcile's known-SID path adopts it (R4). Enqueue failure as for unknown. |
| taken over before the send (a lost re-arm) | untouched by this job | untouched | INFO | The takeover's reconcile resolves it. |

The stale-claim `takeover` at step 5 is the unknown path with the taken-over
record's `attemptedAt` (SOR D8, as the fan-outs do), including the REFRESH.

### R4 - the reconcile's `retry_send` owner

`send.reconcile` gains the fourth owner kind at EVERY owner-dispatch site
in `app/src/jobs/sendReconcile.ts` (lines at 3dbb5740): `toOwnerRef` (:127),
`parseOwnerRef` (:174-196) and `parseContinuation` (:200 - unchanged: this
owner sends no continuation), `relayRowKey`'s exclusion type (:281), the
log helpers (:363, :375), `resolve` (:473), `currentPhone` (:516), `heldBy`
(:577), `adopt` (:614), `afterClose` (:967), `slotCloseOf` (:922),
`closeSlot` (:936), `redriveRefusal` (:1123), `enqueueRedrive` (:1078),
`closeRedriveRefused` (:1140) and `redrive` (:1170). Every `switch` on the
owner kind gains a `never` default so a missed site is a typecheck error,
not a silent no-op (`closeSlot` has none today); the build greps
`owner.kind` once more at its HEAD and adds any site this list missed.

Owner specifics (SOR D11-D16 as built otherwise):

- **Resolve:** the RETRIED ROW by `(conversationId, retriedTsMsgId)` with a
  consistent read - the owner names it directly; the root is not read (its
  id is a fact on the owner). The conversation is read for
  `participant_phone` (eventually consistent, as the relay owners accept).
  The recipient key is the OWNER's (never re-derived). Retried row not
  found -> INFO, the record is left for the sweeper (as the other owners).
- **Digest check:** `recipientDigest(sender, participantPhone)` against the
  record; a changed participant phone -> `unresolved` `digest_mismatch`.
- **Lookup:** SOR D13 as built, with ONE refinement to the sibling rule that
  applies to every owner: the chain's OWN LINEAGE is never a sibling. A
  sibling record is lineage when it is a `retry_send` owner whose
  `retryRoot` fact equals this owner's, or the root send's own owner record
  when the root was a share text (a `broadcast` owner whose `broadcastId`
  equals the retried row's `broadcast_id` and whose `contactKey` equals
  this recipient key) - both computable from the sibling record's `owner`
  and this owner alone, no extra read. A predecessor's adoption happened
  before this attempt began (its 30003 is what scheduled this attempt), so
  it cannot hold this attempt's message; without the exclusion every
  multi-rung chain in the lane would read `unresolved`. Other siblings
  (another share to the same tenant, another chain) keep SOR's rule.
- **`heldBy` / mine:** a `sid#` pointer whose row has `retry_of ===
  retriedTsMsgId` and `retry_attempt === attempt` is MINE (the retry row
  `sendMessage` appended before a record-phase failure: a repair); any other
  row is `other`; the `syssid#` marker is `system`.
- **Adopt** = append the retry row `sendMessage` would have appended,
  through `messagesRepo.append`: `direction: 'outbound'`, the retried row's
  `body`, its `media_attachments` (the adopted row carries no presigned
  URLs), `providerSid` / `providerTs` / `deliveryStatus` from the provider
  message through SOR D15's status mapping as built (`sendReconcile.ts`'s
  status helper), `author` = the retried row's `author` (`'ai'` stays
  `'ai'`, anything else `'teammate'` - the job's own rule,
  `retrySend.ts:323`), `automated: retriedRow.automated ?? true` (RSW relay
  B4), `recipientContactId` = the owner's `recipientKey` when it is a contact
  id (captured at claim; RSW relay B4), **`retryOf: retriedTsMsgId`,
  `retryAttempt: attempt`, `retryWindowStart: oneToOneRetryWindowOrigin(retriedRow)`,
  `retryRoot`, `broadcastId: retriedRow.broadcast_id`** (RSW relay B1 #2 -
  lineage AT append; Branch B's fields). A dedupe onto a row with the same
  `retry_of` + `retry_attempt` is `skipped` (idempotent); onto other
  lineage is `other` (SOR `sid_held_elsewhere`). Then the `message_sent`
  audit row (only when the append was fresh), the preserving inbox touch,
  `message.persisted` for the retry row. No promise write: the retried row's
  `retry_due_at` expires (as on a direct success). An adopted terminal
  failure (`undelivered` / `failed` with a code) is recorded honestly and
  WARNed (SOR D15); the 30003 ladder does not continue from an adopted
  failure (the webhook's decision never ran for it) - stated, not worked
  around.
- **`never_sent`:** window FIRST - `retryFitsSendWindow({ originMs, nowMs:
  now, backoffMs: 0 })`; inside it: `markRedriven`, then
  `enqueueSendRetry(payload-without-deferred, runAt = now)`, then REFRESH
  to `now + RETRY_JOB_GRACE_MS + RETRY_PROMISE_GRACE_MS`; the re-driven job
  claims from `redriven` (SOR D8a) and runs R2 again. Outside the window:
  `closeFromReconcile(redrive_refused, retry_window_closed)` while the
  record is still `reconciling` (the fence holds), ERROR, promise untouched
  (expires). A re-driven job that declines BEFORE its claim (step 4b finds
  the window closed at job time, or step 4a finds a manual retry) closes
  its `redriven` record through `closeRedriven(refused, <cause>)` (SOR D8
  revision 11) and logs the line. An enqueue that throws after
  `markRedriven`: `closeRedriven(enqueue_failed)`, ERROR, promise untouched
  and NO `retry_outcome` - nothing was sent, and Retry stays available
  (round 2 finding 7).
- **`unresolved`** (any SOR cause): `closeFromReconcile(unresolved, cause)`
  FIRST, then WITHDRAW on the retried row (R3's conditional write, retried
  once), then `message.persisted` for the retried row; ONE ERROR naming the
  cause (SOR D16). This is Cameron's Q1 ruling.
- **Crash safety (the superseded exit):** for this owner `slotCloseOf(outcome)`
  maps `unresolved` - and ONLY `unresolved` (an enqueue failure after a
  possible send is recorded as `unresolved` with cause `enqueue_failed`,
  SOR's as-built shape; a never-sent re-drive's enqueue failure is
  `enqueue_failed` and maps to nothing) - to "the WITHDRAW annotate"; a
  redelivered check that finds the record `done` for its own attempt
  re-applies it (idempotent: a no-op when `retry_due_at` is already the
  sentinel). `afterClose` for this
  owner = the retried row's `message.persisted` emit; there is no finalize
  and no root close.

### R5 - "retry not confirmed" on the retried row

- New optional row field `retry_outcome?: 'unconfirmed'`, written only by
  the WITHDRAW write (R3's second-unknown and enqueue-failed arms, R4's
  `unresolved` close and its re-apply), always together with
  `retry_due_at = RETRY_PROMISE_WITHDRAWN_AT`. It can appear on the ROOT
  (attempt 1 unresolved) or on a RETRY ROW (attempt 2 or 3 unresolved) -
  whichever row was retried. Never on relay or broadcast rows. It is DISPLAY:
  the attempt record is what the route trusts (R6).
- `contactTimeline.ts` projects it; `dashboard/src/api/types.ts` mirrors
  it (`RetryOutcome = 'unconfirmed'`).
- `deliveryReason('30003', { retryScheduled, retryUnconfirmed })`: with
  `retryUnconfirmed` and no `relay`, the copy is
  `Phone unreachable - retry not confirmed` (the `(error 30003)` tail as
  today's 30003 copy); `retryUnconfirmed` outranks `retryScheduled`; `relay`
  outranks both. Tone `danger`, `isFailure: true` (the retried row DID fail;
  it is the RETRY whose fate is unknown - unlike SOR's `send_unconfirmed`).
- The Retry button is hidden while the promise is live (as today) AND when
  `retry_outcome === 'unconfirmed'`. A press that reaches the API anyway (a
  stale tab, a lost annotate) meets R6.
- Readers: the one-to-one bubble only. The inbox row and the share results
  row do not render this field (the share row is Branch B's).

### R6 - the manual Retry route reads the record

`POST /api/conversations/:conversationId/messages/:providerSid/retry`
(`app/src/routes/api.ts:1567`) keeps RSW's guards and adds, after
`retry_pending`:

- Read the pressed row's attempt records DIRECTLY by key: the pressed row is
  the retried row of any automatic attempt scheduled against it, so its
  records are `retry#<conversationId>#<pressedRow.tsMsgId>#<1..MAX_SEND_RETRY_ATTEMPTS>`
  with the R1 recipient key derived from the same immutable row data (three
  consistent `get`s; no index, no time bound). The row's own
  `retry_outcome` is read as a belt.
- 409 `{ error: 'retry_unresolved' }` when any of them is `done` with
  outcome `unresolved` (the ONLY outcome that means "a text may be out and
  nobody knows"), or the row carries `retry_outcome: 'unconfirmed'` - the
  Q1 ruling, enforced by the record, for good.
- 409 `{ error: 'retry_pending' }` (RSW's error, so the dashboard's existing
  arm answers) when any of them is OPEN and not stale: `attempting` within
  `SEND_CLAIM_TTL_MS` of its `attemptedAt`; `reconciling` within
  `reconcileCheckDelaysMs()[2] + RETRY_PROMISE_GRACE_MS` of its
  `attemptedAt`; `redriven` within `RETRY_SEND_WINDOW_MS` of the chain's
  origin. Older open records are the sweeper's and do NOT block a person's
  decision. `done` with `refused`, `rejected`, `retryable`, `sent`,
  `adopted` or `enqueue_failed` never blocks.
- Otherwise the route proceeds as today, and its append gains `retryRoot`
  and `broadcastId` (R7).

The two halves together: BEFORE the job's claim - the webhook's promise
(RSW's time guard) covers the scheduled window, and if the job runs LATE
(after the promise expired) or was enqueued by a webhook whose enqueue
threw after SQS accepted, the job itself declines when a manual retry row
already exists (R2 step 4a); AFTER the claim - the record covers a running
attempt, a pending reconcile and the unresolved close. What stays open, by
construction: a manual press and the job's claim inside the same instant
(both read "nothing yet"); the STALE-TAB press RSW already names (a tab
that rendered Retry before the promise was written); and a manual press
racing a manual press. The build maps these onto
`manual-retry-double-send-residual-windows`'s numbered gaps in a dated
note, closing the automatic-retry gaps and leaving the rest as filed.

The dashboard adds copy for 409 `retry_unresolved` beside `retry_pending`
(`Timeline.tsx:134`): "This retry couldn't be confirmed - send a new message
instead."

### R7 - broadcast attribution, the root pointer and the one fenced line

- `NewMessage` / `MessageItem` gain `retryRoot` / `retry_root`; `sendMessage`
  passes it through to the append beside `retryOf` / `retryAttempt` /
  `retryWindowStart`.
- Every retry row this branch appends carries `retry_root` (section 0's
  rule) and `broadcast_id` copied from the retried row: the automatic send
  (R2 step 7), the adoption (R4), and the manual Retry route's append
  (`api.ts:1685`). For a chain whose root was a share text the fields
  propagate attempt to attempt; for any other root `broadcast_id` is absent
  and `retry_root` is set.
- Cost until Branch B, stated: a transitioned receipt for a share-retry
  row (automatic OR manual, now that both carry `broadcast_id`) is routed
  into the broadcast rollup by the `message.broadcast_id` check at
  `twilio.ts:3529`; the rollup reads the broadcast, finds no slot for the
  retry's `tsMsgId`, waits `STATUS_UNKNOWN_SID_RETRY_DELAY_MS` (2.5 s,
  `twilio.ts:322`) and reads again before it gives up - inside Twilio's
  15 s webhook budget, once per receipt of a retried share text. The
  build reads `isBroadcastRowFor` (a second reader of `broadcast_id`) and
  states in the handback what it does with a row that also carries
  `retry_of`. Branch B removes the miss when it teaches the rollup.
- The ONE fenced-file edit: that give-up line
  (`broadcast delivery rollup: no matching recipient slot - ignored`,
  `twilio.ts:3904`) moves from WARN to INFO and carries `broadcastId` (it
  already does) - Cameron's explicit ask, so a retried share text is not a
  prod warning line until B lands. The handback names it.

### R8 - the 30003 decision on a retry row is unchanged

A retry row that fails 30003 reaches the webhook's decision as today; it
reads `retry_attempt` and `retry_window_start` from the row (RSW D2/D6),
which the adoption writes at append (R4). No change to
`oneToOneRetryDecision.ts`.

### R9 - logging (SOR D18)

Refusals WARN; a rejection, a window close, a second deferral, a failed
re-schedule, a second unknown and an unresolved close are ONE ERROR line
each; unknown hand-offs and takeovers are INFO. Lines carry
`conversationId`, `retryRoot`, `attempt`, the record outcome and cause, and
the SID when known - never a phone or a body (`safeRecipientKey`).

### R10 - what Branch B reads (contract)

On every retry row this branch appends (automatic, adopted, manual):
`retry_of`, `retry_attempt`, `retry_window_start` (automatic and adopted
only, as RSW defines), `retry_root`, `automated`, `recipient_contact_id`
(when the contact held the number at send time - `sendMessage`'s rule; on an
adopted row, when the owner's recipient key is a contact id), `broadcast_id`
(when the chain root carried one). On the RETRIED ROW after an unresolved retry:
`retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` and `retry_outcome: 'unconfirmed'`
in one write. The attempt record: kind `retry_send`, the R1 fields;
`listByRecipient(sender, digest, since)` finds every attempt to a number in
a window across owner kinds.

### R11 - seams and the fake

No new seam. The lane reuses `E2E_SEND_RETRY_BACKOFF_MS` (RSW, 10 s) and
`E2E_SEND_RECONCILE_DELAYS_MS` (SOR, 2/4/8 s), both honored only with no
`JOBS_QUEUE_URL`; the fake's `fail-next-send` (`reject` /
`drop_before_create` / `accept_then_drop`), `fail-list` and the 30003
delivery profile (`setDeliveryOutcome`) drive every path end to end. In the
lane jobs run in-process (`JOBS_QUEUE_URL` unset), so "the worker log" is
the app's log.

### R12 - declared deviations from SOR's text

- SOR D8a "the claim TTL is measured from the last re-arm" holds. A retry
  attempt stranded `attempting` is taken over by the redelivery of ITS OWN
  job (R2 - the marker no longer suppresses it) or, failing that, waits for
  the sweeper: other attempts of the chain are other records and never
  touch it.
- SOR D8 "the reconcile job's own closes write the record first" applies
  (R4); D16a (finalize) and the root-close emits do not; `afterClose` is
  the retried row's `message.persisted`.
- SOR D13's sibling rule gains the lineage exclusion (R4) for every owner.

## 4. What must be proven

The real suites: `app/test/twilioStatusWebhook.test.ts` (the retry job's
existing cases, 19 handler registrations - each gains
`sendAttemptsRepo: world.sendAttemptsRepo`), `app/test/retrySendBackoff.test.ts`,
`app/test/retrySendWindow.test.ts`, `app/test/sendReconcile.test.ts`,
`app/test/api.test.ts` (or the file that holds the manual Retry route's
cases), `app/test/sendAttemptsRepo.integration.test.ts`, the harness parity
test (`twilioWebhookHarnessSendAttempts.integration.test.ts`), and the
dashboard suites under `src/routes/contact`. The webhook harness's fakes
(`append`, `annotateMessage`, the new `annotateRetryPromise`, the attempts
repo) carry the new fields and conditions.

Job:

1. **Fails on main:** an unknown provider error (a dropped socket) on the
   retry rethrows today; after this branch the job returns, the record is
   `reconciling`, one `send.reconcile` envelope carries
   `{ kind: 'retry_send', conversationId, retriedTsMsgId, attempt: 1, retryRoot, recipientKeyHash }`,
   no phone anywhere in it, the retried row's `retry_due_at` is refreshed
   to cover the schedule and `message.persisted` was emitted for it.
2. A rejected retry (21211): record `done/rejected`, no retry row, the
   retried row's 30003 and `retry_due_at` untouched, one ERROR.
3. A refused retry (opt-out during the backoff): record `done/refused`,
   promise untouched, WARN - as today plus the record.
4. A deferral (429): the same payload re-enqueued with `deferred: true` and
   `recipientKey` at the RSW backoff (the parser carries both), record
   `done/retryable`, `retry_due_at` refreshed to the run time, emitted; the
   re-claimed run (attemptNo 2) sends once; a 429 on a `deferred` payload
   ends the chain with the record `done/refused` cause `deferral_cap`
   (ERROR, no third enqueue, promise untouched), and a redelivery of that
   job afterwards is refused by the record and sends nothing; a deferral
   whose run time falls past the window ends the chain `done/refused`
   cause `retry_window_closed`; a re-DRIVEN run's first 429 still gets its
   deferral (the re-drive payload carries no `deferred`).
4b. Records are per retried row: a manual Retry row that fails 30003 starts
   a chain whose attempt 1 record is under the manual row's `tsMsgId` and
   is `claimed`, not refused, although the root's own chain already ran
   three attempts.
4c. A manual retry supersedes the chain: with a manual Retry row of the
   retried row already appended, the job declines at INFO before claiming
   (no record, no send); a re-driven job in the same situation closes its
   `redriven` record `refused`.
4d. An existing attempt is resolved before the window: a stale `attempting`
   record with the window already closed is taken over into reconcile, not
   logged "window closed".
4e. A conversation that is missing, not one-to-one, or without a
   participant phone is a WARN decline with no record and no throw.
5. Accepted-not-recorded (the append throws): record `reconciling` with the
   SID, one envelope, one provider call.
6. Duplicate guard (replaces the marker's three cases): (a) the same
   envelope dispatched twice makes one provider call - the second claim is
   refused fresh; (b) a stale `attempting` record (31 s) is taken over into
   reconcile by the redelivered job, with the same `recipientKey` derived
   again; (c) a lost re-arm sends nothing; (d) `putJobExecutionMarker` is
   never called by this job.
7. A successful retry: record `done/sent`; the retry row carries `retry_of`
   (the retried row), `retry_attempt`, `retry_window_start` (the root's
   send), `retry_root`, `automated`, `recipient_contact_id` (only while
   held) and `broadcast_id` (only when the root carried one); the retried
   row's `retry_due_at` is NOT written (the existing `annotates === 0` pin,
   `twilioStatusWebhook.test.ts:1855-1897`, stays green).
8. Attempt 2: the retried row is the attempt-1 retry row; the record keys
   on THAT row with `attempt: 2`; `retry_root` on the new row equals the
   root's `tsMsgId`; a pre-deploy retried row with `retry_of` and no
   `retry_root` yields the root through `retry_of`.
9. Window and reads before the claim: a closed window with no existing
   record leaves no record; a conversation read that throws leaves no
   record and rethrows (SQS redelivers); a no-origin row fails open (no
   window check, the existing WARN).

Reconcile:

10. Adoption of a found retry text writes the row with the full R4 field
    set, the audit row once, the emit, no promise write; a second delivery
    of the same check is idempotent.
11. `never_sent` inside the window re-drives once (a `messaging.retrySend`
    envelope with the same payload and no `deferred`, record `redriven`,
    promise refreshed) and the re-driven job claims from `redriven` and
    sends; outside the window it closes `redrive_refused` while
    `reconciling` and the promise is untouched; a re-driven job whose
    window closed at job time closes its `redriven` record `refused`; a
    re-drive enqueue that throws closes `enqueue_failed` with NO
    `retry_outcome`, and the route then allows Retry.
12. `unresolved` (fail-list on all three checks): record closed first, then
    ONE write sets `retry_due_at = RETRY_PROMISE_WITHDRAWN_AT` and
    `retry_outcome: 'unconfirmed'` on the retried row, one ERROR, no
    re-send; a redelivered check re-applies the write when it was lost.
13. Lineage exclusion: attempt 1 adopted, then attempt 2 `never_sent` inside
    150 s -> re-driven, NOT `same_fingerprint_sibling`; a share root adopted
    inside the span likewise; an unrelated share to the same tenant inside
    the span still blocks.
14. The known-SID path adopts the row `sendMessage` appended before a
    record-phase failure as a repair (`mine`), writing no second row.

Route and dashboard:

15. The manual Retry route: 409 `retry_unresolved` on a `done/unresolved`
    record read by KEY (with or without `retry_outcome` on the row), also
    when that record is 45 days old (no time bound); 409 `retry_pending` on
    a fresh `attempting`, a pending `reconciling`, an in-window `redriven`;
    200 on a stale `attempting` (31 s), a `done/sent`, a `done/retryable`,
    a `done/refused` and a `done/enqueue_failed`; RSW's cases unchanged; the
    route's append carries `retry_root` and `broadcast_id`.
16. `deliveryReason('30003', { retryUnconfirmed: true })` renders
    `Phone unreachable - retry not confirmed (error 30003)` and outranks
    `retryScheduled`; `relay` outranks both; the Timeline hides Retry for
    `retry_outcome: 'unconfirmed'` and shows the `retry_unresolved` toast
    copy; the projection carries the field; a mirror test pins the
    dashboard's copy of the withdrawn sentinel (`retryPromise.ts`) to the
    app's `RETRY_PROMISE_WITHDRAWN_AT` (`app/src/lib/retrySendWindow.ts`)
    and the `RetryOutcome` literal to the app's.

Repo (DynamoDB Local): the `retry_send` owner's claim / re-arm / transitions
and `listByRecipient` across owner kinds; `annotateRetryPromise` writes
under its condition and refuses over a changed `retry_due_at`; the harness
fake matches the real repo on both.

E2E (`e2e/tests/dashboard-next/retry-send-adoption.spec.ts`, fresh lane,
never `contact-tenant-0002` / `conv-0002`):

17. A one-to-one text fails 30003 (the fake's profile); the automatic retry
    is armed `accept_then_drop`: within the lane's delays the retry bubble
    appears Delivered, the tenant received exactly ONE retry text.
18. The retry is armed `drop_before_create`: `never_sent` at the third
    check, one re-drive, the retry bubble Delivered, one text.
19. `drop_before_create` plus `fail-list` x3: the retried row reads
    `Phone unreachable - retry not confirmed`, no Retry button, the API
    answers 409 `retry_unresolved`, exactly one `send_reconcile` ERROR for
    that owner in the app log, no text sent.

## 5. Issues

Closes at merge (the human sets resolved): `retry-send-lost-under-job-marker`;
piece 2 of `accepted-send-lost-when-append-fails` for this caller.
`manual-retry-double-send-residual-windows`: a dated section maps its
numbered gaps to what R6 closes and what stays.

Dated notes (open): `broadcast-30003-retry-never-updates-slot` (attribution
and the root pointer landed; matching is Branch B's; the interim rollup
cost); `send-attempt-sweeper` (the `retry_send` owner shape and its strand
cases); `send-reconcile-job-residues` (the fourth owner inherits every
listed residue); `one-to-one-retry-promise-outlives-job-decline` stays
wontfix, untouched.

Files if found: anything the build's reviews surface outside this scope.

## 6. Post-merge obligations

None on infrastructure. Branch B starts after this merges and reads R10.
The hosted-dev checks SOR owes (`send-reconcile-hosted-dev-checks`) cover
this owner too.

## 7. Risks

- A retry that goes unknown near the end of the 15-minute window has its
  reconcile chain (up to 240 s) run past the window; the reconcile may still
  adopt (the text went out inside the window) but never re-drives past it
  (R4). The refreshed promise keeps Retry hidden meanwhile - RSW #3's
  tradeoff.
- `retry_outcome` and `retry_root` are new fields on the message row; every
  later writer of that row (the status webhook's receipts, suppression
  bookkeeping, annotations) writes named fields, and the build's reviewers
  sweep for a wholesale write.
- The e2e's timing rests on both lane seams; a lane must be booted fresh.
- Removing the marker from this job changes its behavior on a redelivery
  BEFORE the claim (steps 1-4): the redelivered job runs the reads and the
  window check again and then claims - one extra pass of reads, no send.
