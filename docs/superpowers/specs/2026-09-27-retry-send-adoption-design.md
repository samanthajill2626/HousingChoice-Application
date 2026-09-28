# Retry-send adoption (send-outcome Stage 1b) - design

Anchor issue: `retry-send-lost-under-job-marker` (med). Branch
`feat/retry-send-adoption`, cut from `main@3dbb5740`, 2026-09-27.
Revision 1.

This is the ADDENDUM the send-outcome-reconcile design (SOR, revision 12,
`docs/superpowers/specs/2026-09-24-send-outcome-reconcile-design.md`)
promised in its section 2a item 4. It reads on top of that spec AS BUILT
(SOR section 12, the errata): every SOR decision (D1-D23) applies to the
one-to-one 30003 retry unless a decision below restates it. Decision
numbers here are R1-R12 so they never collide with SOR's.

Two rulings from Cameron on 2026-09-27 (relayed from the share-skip
Branch B planner) bound this addendum:

- **The joint gap (Q1 = a):** a one-to-one retry the reconcile rules
  `unresolved` leaves the ORIGINAL bubble reading "retry not confirmed",
  with no "will retry" promise and NO Retry button; staff who want to reach
  the tenant compose a fresh message. The unresolved retry must leave
  `retry_due_at` WITHDRAWN (the `RETRY_PROMISE_WITHDRAWN_AT` sentinel), not
  merely expired, so the share row and the bubble stop promising for the
  same reason at the same instant. Branch B counts such a recipient as
  "already sent" on the review list (the safe flag, as `send_unconfirmed`)
  and not in the ledger.
- **The webhook fence (Q2 = a):** `app/src/routes/webhooks/twilio.ts` stays
  fenced except for ONE log-level change (R7). Stage 1b stamps
  `broadcast_id` on every retry row, sent or adopted, beside the lineage it
  already writes; Branch B teaches the rollup to match a retry to its slot
  (by the recipient, or by walking `retry_of` to the original's `tsMsgId`)
  and defines how a later attempt moves a `failed` slot. No extra field is
  owed to B.

## 1. The invariant, restated for the one-to-one retry

SOR section 1's two guarantees, for `messaging.retrySend`:

1. **The tenant is not texted twice by the retry.** Every provider call the
   job makes is preceded by a claim on the send-attempt record and a re-arm
   immediately before the call (SOR D8a as built); a redelivered job, a
   concurrent retry and a re-driven rung all meet the record and stop.
2. **Every retry rung reaches a terminal state that staff can see.** The job
   never throws after its claim. A rejected or refused retry ends the chain
   with the promise withdrawn; a deferred retry re-schedules itself inside
   the 15-minute window (RSW) with the promise refreshed; an unknown outcome
   goes to `send.reconcile`, which adopts the text it finds, re-drives the
   rung once when nothing was sent, or closes `unresolved` with the promise
   withdrawn and the original marked "retry not confirmed".

What "terminal" means for the ORIGINAL message: its `retry_due_at` is
either live (a retry is scheduled or pending) or withdrawn (the chain is
over: delivered by a retry row, ended by a rejection or refusal, closed
unresolved, or closed by the window). No third state.

## 2. Scope

**In:**

- `app/src/jobs/retrySend.ts` - the adoption (R1-R3, R7).
- `app/src/repos/sendAttemptsRepo.ts` - the `retry_send` owner kind (R1).
- `app/src/jobs/sendReconcile.ts` - the `retry_send` owner: resolve, adopt,
  re-drive, unresolved (R4).
- `app/src/repos/messagesRepo.ts` - `MessageAnnotations.retryOutcome` and
  the `retry_outcome` row field (R5); `annotateMessage` writes it with
  `retry_due_at` in ONE write.
- `app/src/routes/api.ts` - the manual Retry route reads the attempt record
  (R6).
- `app/src/routes/contactTimeline.ts` and `dashboard/src/api/types.ts` -
  `retry_outcome` on the projection (R5).
- `dashboard/src/routes/contact/deliveryStatus.ts`, `retryPromise.ts`,
  `Timeline.tsx` - the "retry not confirmed" copy and the hidden Retry
  button (R5).
- `app/src/routes/webhooks/twilio.ts` - ONE line (R7): the broadcast
  rollup's "no matching recipient slot" log moves from WARN to INFO and
  carries the broadcast id. Nothing else in the file.
- Tests, the webhook harness fakes, one e2e spec (section 4).

**Out - fences:**

- `app/src/routes/webhooks/twilio.ts` beyond R7's one line: the 30003
  decision (`oneToOneRetryDecision.ts` behind it), the claim, the rollup's
  slot matching - Branch B's.
- `app/src/jobs/jobs.ts` (incl. `MAX_HOP_COUNT`), `app/src/adapters/sqsJobConsumer.ts`,
  the run-once marker: unchanged. The marker STAYS in `retrySend` (R2) - it
  is cheap and the record makes it redundant, not wrong.
- `broadcast-30003-retry-never-updates-slot`: the ATTRIBUTION half lands
  here (R7); the slot-matching and failed-slot-transition half is Branch
  B's. The issue stays open with a dated note.
- SOR's Stage 2 sites, the sweeper (D14), the residues SOR filed: untouched.
- The manual Retry route's own send path (`api.ts`) beyond R6's guard: a
  staff Retry is a fresh person's send with its own SID and no attempt
  record (it is not automatic); SOR's Stage 2 list already names it.

## 3. Decisions

### R1 - the owner kind

`SendAttemptOwner` gains
`{ kind: 'retry_send'; conversationId: string; originalTsMsgId: string; attempt: number }`.

- `ownerKey` = `retry#<conversationId>#<originalTsMsgId>#<attempt>`. The
  record keys on the ORIGINAL message and the rung (SOR's stated rule), so
  attempt 1 and attempt 2 of one chain are two records, and two chains for
  two originals in one conversation never collide.
- The recipient key = the original's `recipient_contact_id` when that
  contact still holds the thread's number (`contactHoldsPhone`, RSW B4),
  otherwise `phone#<participantPhone>`; hashed in the sort key as every
  owner's is (SOR D12). `attemptKey` = owner + hashed recipient, as built.
- The facts: `recipientDigest(sender, participantPhone)` with `sender` the
  business number the conversation sends from (the same value `sendMessage`
  derives); `bodyHash`/`bodyShort` from the ORIGINAL's body; `mediaCount` =
  the number of attachments the retry will carry (re-presigned attachments,
  else the raw `mediaUrls` count, else 0).
- `SendAttemptOwnerRef` (the reconcile payload) gains
  `{ kind: 'retry_send'; conversationId; originalTsMsgId; attempt; recipientKeyHash }`;
  `toOwnerRef` and the parser gain the arm. The payload carries no phone.

### R2 - the job's order and phases

In `retrySend`'s handler, in this order (RSW's placements kept):

1. Read the original by provider SID (as today; not found / not outbound ->
   return, WARN).
2. RSW D14: read the recorded recipient by id BEFORE the marker (a throw
   here fails the delivery and SQS redelivers - as today, and correct: no
   marker, no claim, nothing sent).
3. The run-once marker (kept).
4. RSW D4: the strict window check. Past the window -> ERROR
   `retry window closed`, and NEW: withdraw the promise (R3's withdrawal
   write) so the bubble stops promising at the same instant the chain ends
   (today the promise merely expires 2 minutes later).
5. **CLAIM** (SOR D8a) on the R1 owner. `refused fresh` -> INFO, return
   (a concurrent delivery owns it). `refused !fresh` (done terminal or
   reconciling) -> INFO, return. `takeover` (a stale attempt) -> take over
   and hand off to reconcile (R3's unknown path), return. `claimed` ->
   `ref`; `secondUnknownWouldClose = record.redriveCount >= 1`;
   `secondDeferralWouldClose = record.attemptNo >= 2`.
6. PREPARE: the presign (as today). A throw here, after the claim, is the
   prepare-phase deferral (R3, "deferred").
7. SEND through `sendMessage` with today's arguments PLUS
   `broadcastId: original.broadcast_id` (R7) and SOR's
   `beforeProviderSend` hook, which RE-ARMS the claim as the last step
   before the provider call; a lost re-arm sends nothing and takes the
   taken-over path (nothing written, not carried: the takeover's reconcile
   owns the rung).
8. RECORD: `sendMessage` appended the retry row (lineage at append, RSW
   #2); `finishAttempt(sent, sid)`; withdraw the ORIGINAL's promise
   (`retry_due_at` -> `RETRY_PROMISE_WITHDRAWN_AT`) and emit
   `message.persisted` for the original: the retry row is now on screen
   with its own delivery status, and the original's "will retry" copy must
   stop (today it expires on its own 2 minutes later; RSW B5 accepts that,
   this addendum tightens it). INFO `message re-sent` as today.

One outer try/catch around steps 6-8 with SOR's phase tracking
(`prepare` / `sending` / `record`); every failure-arm write through
`guardWrite`; nothing throws after the claim. A throw in steps 1-4 keeps
today's behavior (the delivery fails; a throw before the marker is
redelivered; a throw after the marker is lost - the marker stands, and
steps 3-4 are one read and one pure check, so the exposure is negligible
and stated).

### R3 - the arms

Each arm names the record outcome, the ORIGINAL's promise, the log line and
what the job returns. "Withdraw" = `annotateMessage(original, { retryDueAt:
RETRY_PROMISE_WITHDRAWN_AT })` (ONE write, forward-only: never over a
`retry_due_at` that a LATER chain wrote - the write is conditioned on the
value the job read) followed by `message.persisted` for the original, so the
dashboard re-reads the promise. "Refresh to T" = the same write with
`retryDueAt: T` plus the emit (RSW #3).

| outcome | record | original's promise | log | notes |
|---|---|---|---|---|
| `SendRefusedError` (opt-out, manual mode on an automated original, breaker, consent, deleted) | `done` / `refused`, cause = the code | WITHDRAW | WARN `send refused - retry chain stopped` (as today) | Closes `one-to-one-retry-promise-outlives-job-decline`: the promise no longer outlives the decline by 2 minutes. |
| rejected (SOR D1: a Twilio 4xx, 30007/30005/30006 by code, the kill switch) | `done` / `rejected`, cause = code or status | WITHDRAW | ERROR `retry chain ended - provider rejected the retry` with the code | The original keeps its own 30003; nothing else is written to it. No retry row exists. |
| deferred: `SendNotAttemptedError`, a prepare-phase throw after the claim, or retryable (SOR D1: 429 / 20429 / 30022 / a connection that never opened) | `done` / `retryable`, cause = code or `send_retryable` | REFRESH to the new run time | WARN `retry deferred - re-scheduled` | The rung's SINGLE deferral: re-enqueue the SAME payload (same `attempt`) at `runAt = now + resolveSendRetryBackoffMs(attempt)` ONLY if `retryFitsSendWindow({ originMs, runAt })` (RSW #3); otherwise terminal: ERROR `retry window closed` + WITHDRAW. If `secondDeferralWouldClose` (this claim was already the re-claim after a deferral): terminal, ERROR `retry deferred twice - chain ended`, record `done` / `retryable` (the claim would accept a third pass; nothing schedules one), WITHDRAW. |
| unknown (SOR D2: 5xx, timeout, dropped socket, anything else) | `reconciling` (`handToReconcile`) | REFRESH to `attemptedAt + reconcileCheckDelaysMs()[2] + RETRY_PROMISE_GRACE_MS` (the promise covers the whole reconcile schedule, RSW #3) | INFO `retry outcome unknown - handed to reconcile` | Enqueue `send.reconcile` at check 0 with the R1 owner ref. If `secondUnknownWouldClose` (a re-driven rung came back unknown): SOR D13a - close `done` / `unresolved` cause `second_unknown`, WITHDRAW, mark the original `retry_outcome: 'unconfirmed'` (R5), ERROR. |
| `SendAcceptedNotRecordedError` (Twilio accepted, the append failed) | `reconciling` WITH the SID | REFRESH as for unknown | ERROR `sent_unrecorded` with the SID | The reconcile's known-SID path adopts it (R4). |
| a record-phase throw after a successful send (the `finishAttempt` or the withdrawal threw) | `reconciling` WITH the SID via `guardWrite`; a lost hand-off leaves `attempting` (stranded) | untouched | ERROR `sent_unrecorded` | The retry row exists (sendMessage appended it); adoption is a repair. A stranded rung is the sweeper's (SOR D8a rev 12 item 6). |
| taken over before the send (a lost re-arm) | untouched by this job | untouched | INFO | The takeover's reconcile resolves it. |

The enqueue of a deferral or a reconcile that itself throws (SOR D16's
`enqueueOrClose` shape): record `done` / `enqueue_failed` (`closeFromReconcile`
with that outcome, or `finishAttempt` when still attempting), WITHDRAW,
`retry_outcome: 'unconfirmed'` only when a send may have happened (the
unknown / accepted paths), ERROR.

### R4 - the reconcile's `retry_send` owner

`send.reconcile` gains the fourth owner kind. Per SOR D11-D16 as built, with
these owner specifics:

- **Resolve:** the ORIGINAL row by `(conversationId, originalTsMsgId)` with a
  consistent read; the conversation (for the participant phone; eventually
  consistent, as the relay owners accept); the recipient = the original's
  `recipient_contact_id` while it holds the number, else the phone key. Not
  found -> INFO, the record is left for the sweeper (as the other owners).
- **Digest check:** `recipientDigest(sender, participantPhone)` against the
  record; a conversation whose participant phone changed -> `unresolved`
  `digest_mismatch` (SOR D13).
- **Lookup:** SOR D13 as built (two-sided window from the re-armed
  `attemptedAt`, sibling records by `attemptKey`, body hash AND media count,
  complete walk on the last check). Siblings for a one-to-one recipient
  include every owner kind that texts the same number from the same sender
  (a share to the same tenant inside the window is a sibling - exactly the
  same-fingerprint case SOR already handles).
- **`heldBy` / mine:** a `sid#` pointer whose row has `retry_of ===
  originalTsMsgId` and `retry_attempt === attempt` is MINE (the retry row
  `sendMessage` appended before a record-phase throw: a repair); any other
  row is `other`; the `syssid#` marker is `system`.
- **Adopt** = append the retry row that `sendMessage` would have appended,
  through `messagesRepo.append`: `direction: 'outbound'`, the original's
  `body`, the attachments the record's `mediaCount` describes (the
  original's `media_attachments`; the adopted row carries no presigned
  URLs), `providerSid` / `providerTs` / `deliveryStatus` from the provider
  message (SOR's `statusFor`), `author` = the original's, `automated` =
  `original.automated ?? true` (RSW B4), `recipientContactId` only when the
  contact holds the number (RSW B4), **`retryOf: originalTsMsgId`,
  `retryAttempt: attempt`, `retryWindowStart: oneToOneRetryWindowOrigin(original)`
  (RSW #2 - lineage AT append, never annotated after), and
  `broadcastId: original.broadcast_id` (R7)**. A dedupe onto an existing row
  with the same lineage is `skipped` (idempotent); onto a row with other
  lineage is `other` (SOR's `sid_held_elsewhere`). Then the `message_sent`
  audit row (only when the append was fresh), the preserving inbox touch,
  the emits (`message.persisted` for the retry row AND for the original),
  and WITHDRAW the original's promise: the retry is on screen. An adopted
  terminal failure (`undelivered` / `failed` with a code) is recorded
  honestly and WARNed (SOR D15); the 30003 ladder does NOT continue from an
  adopted failure (the webhook's decision never ran for it) - stated, not
  worked around; the original reads the adopted retry's own failure.
- **`never_sent`:** re-drive the SAME rung once - `markRedriven`, then
  `enqueueSendRetry(payload, runAt = now)` if `retryFitsSendWindow({ originMs,
  runAt })`, REFRESH the promise to `runAt`; the re-driven job claims from
  `redriven` (SOR D8a) and runs R2 again. Outside the window, or when the
  original is gone / the conversation closed: `closeFromReconcile`
  `redrive_refused` (cause `window_closed` / `original_missing`), WITHDRAW,
  ERROR.
- **`unresolved`** (any SOR cause): `closeFromReconcile` `unresolved`;
  ONE `annotateMessage` on the original with BOTH `retryDueAt:
  RETRY_PROMISE_WITHDRAWN_AT` and `retryOutcome: 'unconfirmed'` (R5), then
  `message.persisted` for the original; ONE ERROR naming the cause (SOR
  D16). This is Cameron's Q1 ruling.
- `afterClose` for this owner = the original's `message.persisted` emit;
  there is no finalize and no root close.

### R5 - "retry not confirmed" on the original

- New optional row field `retry_outcome?: 'unconfirmed'` on the FAILED
  one-to-one original, written only by R3's second-unknown arm and R4's
  `unresolved` close, always in the same write as the withdrawal. Never on a
  retry row, never on relay or broadcast rows (those have their own slot
  codes). `MessageAnnotations.retryOutcome` carries it; `annotateMessage`
  writes it with `retry_due_at`.
- `contactTimeline.ts` projects it; `dashboard/src/api/types.ts` mirrors it.
- `deliveryReason('30003', { retryScheduled, retryUnconfirmed })`: with
  `retryUnconfirmed` and no `relay`, the copy is
  `Phone unreachable - retry not confirmed` (the `(error 30003)` tail as
  today's 30003 copy carries it); `retryUnconfirmed` outranks
  `retryScheduled` (a withdrawn promise is never live anyway); `relay` still
  outranks both. Tone `danger`, `isFailure: true` (the ORIGINAL did fail;
  it is the RETRY whose fate is unknown - different from SOR's
  `send_unconfirmed`, which is `isFailure: false` because the slot's own
  text may have gone out).
- The Retry button: hidden while the promise is live (as today) AND when
  `retry_outcome === 'unconfirmed'`. The manual Retry route mirrors it
  (R6).
- A one-to-one bubble is the only reader; the inbox row and the
  broadcast results row do not render 30003 copy from this field (the
  share row is Branch B's).

### R6 - the manual Retry route claims the same record

`POST /api/conversations/:conversationId/messages/:providerSid/retry`
gains two guards after RSW's `retry_pending`:

- `retry_outcome === 'unconfirmed'` on the original -> 409
  `{ error: 'retry_unresolved' }` (Q1: no Retry).
- Any `retry_send` attempt record for this original (attempts 1..3) in
  state `attempting`, `reconciling` or `redriven` -> 409
  `{ error: 'retry_pending' }` - the same error RSW's time guard answers, so
  the dashboard needs no new arm. This is the record-based guard
  `manual-retry-double-send-residual-windows` suggests: it closes that
  issue's gaps 1 (the job runs later than promised), 2 (a deferral) and 5
  (an enqueue that throws after SQS accepted) for the automatic retry, and
  gap 4 (the joint gap) by construction with R5. Gap 3 stays as filed.

The route reads three records at most (one `get` per attempt number); no
index.

### R7 - broadcast attribution and the one fenced line

- The direct send passes `broadcastId: original.broadcast_id` (when
  present) to `sendMessage`, which stamps `broadcast_id` on the retry row
  (`sendMessage.ts` already does this for the fan-out's argument); the
  adoption stamps the same field (R4). Beside `retry_of`, `retry_attempt`,
  `automated` and `recipient_contact_id`, that is everything Branch B asked
  for.
- Until Branch B teaches the rollup, a retry's receipt reaches
  `twilio.ts`'s broadcast rollup, finds no slot matching the retry's
  `tsMsgId`, and is ignored - as today, but now once per retried share
  text. That line (`broadcast delivery rollup: no matching recipient slot -
  ignored`) moves from WARN to INFO and logs the broadcast id it already
  carries. This is the ONLY edit in the fenced file, made on Cameron's
  explicit ask; the handback names it.

### R8 - the 30003 decision on a retry row is unchanged

A retry row that fails 30003 reaches the webhook's decision as today; it
reads `retry_attempt` and `retry_window_start` from the row (RSW D2/D6),
which the adoption writes at append (R4). No change to
`oneToOneRetryDecision.ts`.

### R9 - logging (SOR D18)

Refusals WARN; a rejection, a window close, a second deferral, a second
unknown and an unresolved close are ONE ERROR line each; unknown hand-offs
and takeovers are INFO. Lines carry `conversationId`, `originalTsMsgId`,
`attempt`, the record outcome and cause, and the SID when known - never a
phone or a body (the recipient key goes through `safeRecipientKey`).

### R10 - what Branch B reads (contract)

On every retry row, sent or adopted: `retry_of`, `retry_attempt`,
`retry_window_start`, `automated`, `recipient_contact_id` (while held),
`broadcast_id` (when the original carried one). On the original after the
chain ends: `retry_due_at` withdrawn (`RETRY_PROMISE_WITHDRAWN_AT`) and,
for an unresolved retry, `retry_outcome: 'unconfirmed'`. The attempt record
for a chain: owner kind `retry_send` with the fields in R1; `listByRecipient`
finds every attempt to a number inside a window across owner kinds.

### R11 - seams and the fake

No new seam. The lane reuses `E2E_SEND_RETRY_BACKOFF_MS` (RSW, 10 s) and
`E2E_SEND_RECONCILE_DELAYS_MS` (SOR, 2/4/8 s), both honored only with no
`JOBS_QUEUE_URL`; the fake's `fail-next-send` (`reject` /
`drop_before_create` / `accept_then_drop`), `fail-list` and the 30003
delivery profile (`setDeliveryOutcome`) drive every path end to end.

### R12 - declared deviations from SOR's text

- SOR D8a "the claim TTL is measured from the last re-arm" holds; the
  retry's ladder is RSW's (60 / 120 / 240 s backoff), longer than the 30 s
  TTL, so a stranded retry attempt IS taken over by the re-driven or
  re-scheduled rung's claim when one runs, and otherwise waits for the
  sweeper - stated, not changed.
- SOR D16a (finalize) and the root-close emits do not apply; the owner's
  `afterClose` is the original's `message.persisted` emit.

## 4. What must be proven

Unit (`app/test/retrySend.test.ts`, the fake world; the file's real
fixtures):

1. **Fails on main:** an unknown provider error (a dropped socket) on the
   retry rethrows today; after this branch the job returns, the record is
   `reconciling`, one `send.reconcile` envelope carries
   `{ kind: 'retry_send', conversationId, originalTsMsgId, attempt: 1, recipientKeyHash }`
   and no phone, the original's `retry_due_at` is refreshed to cover the
   schedule and `message.persisted` was emitted for the original.
2. A rejected retry (21211): record `done/rejected`, `retry_due_at`
   withdrawn, one ERROR, no retry row, the original's 30003 untouched.
3. A refused retry (opt-out during the backoff): record `done/refused`,
   `retry_due_at` withdrawn immediately (not after 2 minutes), WARN.
4. A deferral (429): record `done/retryable`, the same payload re-enqueued
   at the RSW backoff, `retry_due_at` refreshed to that run time, emitted;
   the re-claimed rung (attemptNo 2) sends once; a SECOND 429 ends the
   chain (ERROR, withdrawn, no third enqueue); a deferral whose run time
   falls past the 15-minute window ends the chain (`retry window closed`,
   withdrawn).
5. Accepted-not-recorded (the append throws): record `reconciling` with the
   SID, one envelope, one provider call.
6. A redelivered job (same jobId) is suppressed by the marker; a concurrent
   job with a different jobId is refused fresh by the claim; a lost re-arm
   sends nothing.
7. A successful retry: record `done/sent`, the retry row carries
   `retry_of`, `retry_attempt`, `retry_window_start`, `automated`,
   `recipient_contact_id` (only while held) and `broadcast_id` (only when
   the original carried one); the original's `retry_due_at` is withdrawn
   and its `message.persisted` emitted.
8. The window check runs BEFORE the claim (a closed window leaves no
   record) and now withdraws the promise.

Reconcile (`app/test/sendReconcile.test.ts`, extended):

9. Adoption of a found retry text writes the row with the full R4 field
   set, the audit row once, the two emits, and withdraws the original's
   promise; a second delivery of the same check is idempotent (one row,
   one audit row).
10. `never_sent` re-drives once inside the window (a `messaging.retrySend`
    envelope with the same payload, record `redriven`, promise refreshed)
    and the re-driven job claims from `redriven` and sends; outside the
    window it closes `redrive_refused` with the promise withdrawn.
11. `unresolved` (fail-list on all three checks) writes `retry_due_at`
    withdrawn AND `retry_outcome: 'unconfirmed'` in one write, one ERROR,
    no re-send; the manual Retry route then answers 409 `retry_unresolved`.
12. A sibling share to the same tenant inside the window with the same
    body makes the retry `unresolved` `same_fingerprint_sibling`, never a
    re-drive.
13. The known-SID path adopts the row `sendMessage` appended before a
    record-phase throw as a repair (`mine`), writing no second row.

Route and dashboard:

14. The manual Retry route: 409 `retry_pending` while a `retry_send` record
    is `attempting` / `reconciling` / `redriven`; 409 `retry_unresolved` on
    `retry_outcome: 'unconfirmed'`; 200 otherwise (RSW's cases unchanged).
15. `deliveryReason('30003', { retryUnconfirmed: true })` renders
    `Phone unreachable - retry not confirmed (error 30003)` and outranks
    `retryScheduled`; `relay` outranks both; the Timeline hides Retry for
    `retry_outcome: 'unconfirmed'`; the projection carries the field; a
    mirror test pins the withdrawn sentinel and the copy to the app
    constants.

Integration (DynamoDB Local): the `retry_send` owner's claim / re-arm /
transitions on the real repo (the parity table gains the kind); the
adoption twice writes one row.

E2E (`e2e/tests/dashboard-next/retry-send-adoption.spec.ts`, fresh lane,
never `contact-tenant-0002` / `conv-0002`):

16. A one-to-one text fails 30003 (the fake's profile); the automatic retry
    is armed `accept_then_drop`: within the lane's delays the retry bubble
    appears as Delivered, the original's "will retry" copy is gone, the
    tenant received exactly ONE retry text.
17. The retry is armed `drop_before_create`: `never_sent` at the third
    check, one re-drive, the retry bubble Delivered, one text.
18. `drop_before_create` plus `fail-list` x3: the original reads
    `Phone unreachable - retry not confirmed`, no Retry button, the API
    answers 409 `retry_unresolved`, exactly one ERROR in the worker log,
    no text sent.

## 5. Issues

Closes at merge (the human sets resolved): `retry-send-lost-under-job-marker`;
`one-to-one-retry-promise-outlives-job-decline` (the decline now withdraws
the promise); `manual-retry-double-send-residual-windows` gaps 1, 2, 4, 5
(gap 3 stays; a dated section says which). Piece 2 of
`accepted-send-lost-when-append-fails` for this caller.

Dated notes (open): `broadcast-30003-retry-never-updates-slot` (attribution
landed; matching is Branch B's); `send-attempt-sweeper` (the `retry_send`
owner shape and its strand cases); `send-reconcile-job-residues` (the
fourth owner inherits every listed residue).

Files if found: anything the build's reviews surface outside this scope.

## 6. Post-merge obligations

None on infrastructure. Branch B starts after this merges and reads R10.
The hosted-dev checks SOR owes (`send-reconcile-hosted-dev-checks`) cover
this owner too - a queued retry text the list does not show would be
re-driven exactly as a share text would.

## 7. Risks

- The window and the reconcile schedule: a retry that goes unknown at
  attempt 3 near the end of the 15-minute window has its reconcile chain
  (up to 240 s) run PAST the window; the reconcile may still adopt (the
  text went out inside the window) but never re-drives past it (R4). The
  promise is refreshed to cover the schedule, so the Retry button stays
  hidden while a text may be out - the same tradeoff RSW #3 states.
- `retry_outcome` is a new field on a hot row type; every writer of the
  original's row after the chain (the status webhook's later receipts, the
  suppression bookkeeping) must not clear it - they write named fields, and
  the build's reviewers sweep for a wholesale write.
- The e2e's timing rests on both lane seams; a lane must be booted fresh.
