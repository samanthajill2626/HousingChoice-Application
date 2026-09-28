# Retry-send adoption (Stage 1b) - design review round 2, reviewer B (adversarial)

Spec under review: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`,
REVISION 2 (commit 08a41dc7), read cold. Inputs: the round-1 adjudications
(`adjudications.md`, "Spec round 1") and reviewer A's round-1 report
(`spec-r1-reviewer-a.md`). Code read at main@3dbb5740 in
`W:\tmp\retry-send-adoption`. Read-only: no tests run, nothing staged. Every
claim about existing code cites a file:line I read; anything not verified is
marked UNVERIFIED.

Order: new defects first (most were introduced by revision 2 or by the Branch B
requirement it folded in), then contested adjudications, then smaller defects.
Contested round-1 rulings are flagged "CONTEST" with the finding ids they
answer.

---

## 1. [BLOCKING] Keying the record on the chain root collides a manual Retry's own 30003 ladder with the prior ladder's records

**What is wrong.** Revision 2 keys the attempt record on
`retry#<conversationId>#<retryRoot>#<attempt>` (R1). R7 then has the MANUAL Retry
route's row carry `retry_root` (section 0: the pressed row's `retry_root`, else its
own `tsMsgId`). But a manual Retry row restarts the attempt ladder:

- The route appends with `retryOf` only, with no `retryAttempt`
  (`app/src/routes/api.ts:1676-1688`).
- When that manual row M fails 30003, the webhook's decision computes
  `attempt = (message.retry_attempt ?? 0) + 1 = 1`
  (`app/src/services/oneToOneRetryDecision.ts:125-129`), measured from a new
  window (RSW D2: a manual Retry "starts a window of its own").
- So M's ladder runs attempts 1, 2, 3 with `retryRoot` = the ORIGINAL root O.
  Its owner key is identical to the original ladder's attempts 1, 2, 3 on O, and
  so is the recipient key (M records the same `recipient_contact_id` the route
  passed through).

Records live 30 days (`app/src/repos/sendAttemptsRepo.ts:48`). M's first claim
therefore meets the original ladder's attempt-1 record:

- If that record is `done`/`sent` (or `rejected`, `refused`, `adopted`,
  `unresolved`), the claim answers `refused`, `fresh: false`
  (`sendAttemptsRepo.ts:445`). R2 step 5 logs INFO and returns. The automatic
  retry of M is silently dropped, while the webhook has already stamped M with a
  live "will retry" promise that then expires.
- If that record is `done`/`retryable` (a terminal deferral), M claims it and
  inherits its `attemptNo` and its `redriveCount` (the claim never touches
  `redriveCount`, `sendAttemptsRepo.ts:259`). A stale `redriveCount = 1` makes
  M's first unknown close `unresolved` with no reconcile.

**A common trigger.** The tenant's phone is off. The whole ladder fails 30003 and
is exhausted. Staff press Retry later that day, the phone is still off, and M
fails 30003. M's entire automatic ladder vanishes behind an INFO line.

Revision 1 keyed on the row being retried, which is unique per attempt, so it
could not collide. The same conflation shows in R2 step 1's gloss, "RSW D2: the
root's `provider_ts`": for M's ladder the window origin is M's own `provider_ts`,
not the root's. The call `oneToOneRetryWindowOrigin(retriedRow)` is right; the
prose is wrong. A builder who follows the prose and reads the ROOT row, which R4
now resolves, puts every M-ladder re-drive outside the window.

**What it implies.** One field is being made to serve two purposes:

- Branch B's ROUTING root (which share slot a receipt belongs to): `retry_root`,
  which correctly survives a manual Retry.
- The LADDER identity (where attempt numbers restart): this must restart at
  every row that carries no `retry_attempt`.

The record needs the ladder identity in its key. For example, key on the retried
row plus the attempt (as revision 1 did), and carry `retryRoot` as a plain owner
or record field that Branch B and R6 filter on. If "the record keys on the chain
root" is a product-owner requirement taken literally, it needs to go back to him
with this collision.

---

## 2. [HIGH] CONTEST A7/B6: "recipientKey captured once" is false for every re-entry of the job itself

**What is wrong.** R1 says the recipient key is "captured ONCE, at claim time,
and carried on the owner ... Nothing re-derives it later; a contact edit after
the claim changes no key." But the job is entered afresh by:

- the deferral re-run (`{ ...payload, deferred: true }`);
- the reconcile's re-drive (`payload-without-deferred`);
- the SQS redelivery that R2 relies on for crash recovery.

`RetrySendPayload` carries `{ providerSid, conversationId, attempt }` only
(`app/src/jobs/retrySend.ts:58-64`, plus the new `deferred`). None of these
entries has the captured key. Each one recomputes it at R2 step 3 from the
retried row's `recipient_contact_id` and a LIVE `contactHoldsPhone`
(`app/src/repos/contactsRepo.ts:376-378`) - the re-derivation the adjudication
said was removed.

If the answer changes between the first claim and a re-entry (the contact's
phone is edited or the contact is removed), the re-entry addresses a different
record, finds it ABSENT and claims it fresh:

- **Crash redelivery.** The dead run claimed K1 and may have sent. The
  redelivery claims K2 and SENDS: a double text. This defeats exactly the
  takeover R2 says motivates removing the marker.
- **Re-drive.** The fresh record has `redriveCount = 0`, so a second unknown
  goes back to reconcile and can be re-driven again (SOR D13a allows at most
  one). The real `redriven` record is left behind.
- **Re-driven job's window decline.** `closeRedriven` (R4) targets the wrong,
  absent record.

On the reconcile side, the payload carries only `recipientKeyHash`, and the spec
never says how Resolve rebuilds the raw key that the owner - and so every
`get`/transition - needs (`recordKey` hashes the raw key,
`sendAttemptsRepo.ts:176-181`). Hash-matching the candidates (the retried row's
`recipient_contact_id`, and `phone#<participant_phone>`) with no
`contactHoldsPhone` works, but the spec has to say so.

The trigger is rare: a contact edit inside a ~2-minute crash or re-drive window.
But the consequence is a second text, and the guarantee stated in R1 is false.

**What it implies.** Carry the captured key in `RetrySendPayload` (it is hashed
nowhere, and a contact id is not a phone; for a `phone#` key, carry the hash and
hash-match). Or use a recipient key that cannot drift: a one-to-one conversation
has exactly one recipient, so a constant works. State Resolve's recovery rule.

---

## 3. [HIGH] CONTEST A2/B2: R6 still pre-maps closures its mechanism does not deliver

**What is wrong.** R6 now says RSW's time guard "covers the window between the
webhook's schedule and the job's claim (no record exists yet)". Its closing
paragraph lists what the build will record as closed - "the job running later
than promised, a deferral, an outcome pending past the promise, the joint gap" -
and what stays: "a manual press racing a manual press". Checked against
`docs/issues/manual-retry-double-send-residual-windows.md`:

- **Gap 1, the job running later than promised.** By definition the promise has
  expired, and before the job's claim there is no record. Both guards are off:
  the press sends, then the job claims an absent record and sends. NOT closed.
  The record guard covers only the slice after the claim.
- **Gap 5, an enqueue that threw after SQS accepted.** The webhook rewrites the
  promise to the withdrawn sentinel at once (`app/src/routes/webhooks/twilio.ts:3638-3647`),
  and the job has not claimed. Both guards are off; the double text stands.
  R6's premise that the time guard covers the scheduled-not-yet-run window is
  false exactly here.
- **Gap 2, a stale tab retrying a row an automatic retry already replaced.**
  After R2 step 8 the record is `done`/`sent`, which test 15 answers 200. So
  this gap stays open (unchanged from today, now that the success withdrawal is
  gone), and it is not "a manual press racing a manual press".
- **"A deferral."** During the deferral wait the record is `done`/`retryable`,
  which test 15 also answers 200. Only the best-effort REFRESH covers the wait.
  If that write is lost, or the re-run is late, the press passes, and the re-run
  then claims `done`/`retryable` and sends.

Section 1 guarantee 1 ("The manual Retry route meets RSW's time guard AND the
record") reads as protection it does not give against a manual press racing an
automatic send.

**What it implies.** Either R6 CLAIMS (reviewer A's round-1 suggestion: the route
closes the ladder's next record `done`/`refused` cause `manual_retry` before it
sends, so the job's later claim is refused), or the spec and the issue note must
say that gaps 1, 2 and 5 stay open, and that "a deferral" is covered by the
refresh alone.

---

## 4. [MEDIUM] CONTEST A4/B8: "enforced by the record, for good" lasts 30 minutes

**What is wrong.** R6 finds a ladder's records through
`listByRecipient(sender, digest, since = now - 30 min)`, and that Query is bounded
by the index item's time (`sendAttemptsRepo.ts:585-599`,
`tsMsgId >= :since`). A `done`/`unresolved` record whose last claim or re-arm is
older than 30 minutes is not returned. The 409 `retry_unresolved` "for good" -
the reason the adjudication made the record authoritative instead of the
best-effort `retry_outcome` - therefore ends after 30 minutes.

R6 never reads the pressed row's `retry_outcome` either. After 30 minutes:

- a stale tab passes the route on an unresolved row;
- if the WITHDRAW + `unconfirmed` annotate was lost (the case A4 exists for),
  the bubble also shows Retry and the route passes. That is the Q1 joint gap
  again, after a text that may have gone out.

**What it implies.** For `done`/`unresolved`, look back as far as the record can
exist, or refuse on the row's `retry_outcome` as well (belt and braces), or both.

---

## 5. [MEDIUM] Terminal deferral ends leave a claimable record, and without the marker a duplicate envelope resurrects the chain

**What is wrong.** R3 ends a ladder that cannot defer again - `deferred` twice,
the window closed at re-schedule, or the enqueue threw - with
`finishAttempt(retryable)`, noting "the claim would accept a further pass;
nothing schedules one". With the run-once marker gone (R2), something can:

- SQS redelivers a successfully completed job when its delete fails
  (`app/src/adapters/sqsJobConsumer.ts:11-17`, at-least-once).
- A standard-queue SendMessage retried by the SDK after a lost response is two
  messages carrying the same envelope. UNVERIFIED that the SDK retries
  SendMessage; standard queues document duplicates either way.

Before, both were suppressed by the same-`jobId` marker. Now either reaches the
claim, finds `done`/`retryable`, and claims.

- **Chain-ended case.** The ERROR said the chain ended. If the promise has
  expired and staff pressed Retry (R6 answers 200 on `done`/`retryable`), the
  resurrected run sends a second text.
- **Normal deferral.** A duplicate of the PRE-deferral envelope (no `deferred`)
  claims ahead of the scheduled re-run. It sends earlier than the refreshed
  promise said, or it takes a second deferral: the "SINGLE deferral" becomes
  two.

**What it implies.** A terminal deferral end must close the record with an
outcome the claim refuses (for example `done`/`refused` with a
`deferral_exhausted` / `window_closed` / `enqueue_failed` cause). The claim then
answers `!fresh`, the route answers 200 (nothing was sent), and no duplicate can
resurrect it.

---

## 6. [MEDIUM] The window check precedes the claim, so a crash redelivery near the window end never takes over

**What is wrong.** R2 puts the strict window check (step 4) before the claim
(step 5), and R12 says a stranded `attempting` record "is taken over by the
redelivery of ITS OWN job". The redelivery arrives about 120 s after receipt
(`sqsJobConsumer.ts:11-12`), and scheduling allows a run as late as the window
end minus 60 s (`retryFitsSendWindow`, `app/src/lib/retrySendWindow.ts:74-80`).
So a run that claims in the last two minutes of its window and then dies is
redelivered after the window closed.

Step 4 then logs ERROR "retry window closed" and returns, and the takeover at
step 5 never happens. The attempt may have sent, the record stays `attempting`,
and no reconcile ever resolves it. The promise expires, R6 lets a press through
after 30 s, and a text that may be out gets a second one - the joint-gap shape
this addendum exists to close.

R4 already requires step 4 to read the record in one case (a `redriven` record
closes `refused`).

**What it implies.** On a window decline, read the record. `redriven` -> close it
`refused` (as R4 says). `attempting` older than the TTL -> take it over into
reconcile, whose adoption does not depend on the window. Only then log the
window close.

---

## 7. [MEDIUM] CONTEST B14/A4: mapping `enqueue_failed` to WITHDRAW + `unconfirmed` marks a retry that provably never went out

**What is wrong.** R4's crash-safety bullet maps this owner's `slotCloseOf` outcomes
`unresolved` and `enqueue_failed` to "the WITHDRAW annotate", which is
`retry_due_at` = sentinel plus `retry_outcome: 'unconfirmed'` (R3, R5).

- An `unresolved` outcome from an enqueue failure is already written as
  `unresolved`/cause `enqueue_failed` (R3's unknown arm), and is covered by the
  `unresolved` entry.
- The only record whose OUTCOME is `enqueue_failed` is R4's never_sent re-drive
  whose enqueue threw: `closeRedriven(enqueue_failed)`, "promise untouched
  (nothing sent)", matching SOR D13a's "the Retry offer stays: we know nothing
  went out".
- The existing code calls `closeSlot` on that NORMAL path, not only on the
  re-apply (`app/src/jobs/sendReconcile.ts:1060-1066`). So once `closeSlot` for
  this owner implements the mapping, a retry that was never sent reads "retry
  not confirmed" and loses its Retry button for good.

R6's matching clause - "`enqueue_failed` reached from the unknown / accepted
paths (cause `enqueue_failed` on a record that was `reconciling`)" - cannot be
evaluated. The stored record does not remember its prior state, and no record
from those paths has outcome `enqueue_failed`. If the clause is implemented as
"outcome or cause `enqueue_failed`", it refuses the same nothing-sent case.

**What it implies.** Drop `enqueue_failed` from the WITHDRAW mapping and from
R6's refusal. The `unresolved` outcome already covers every may-have-sent case.
Specify this owner's `closeSlot` per CODE: `send_unconfirmed` -> WITHDRAW +
unconfirmed; `redrive_refused` and `enqueue_failed` -> nothing.

---

## 8. [MEDIUM] Step 3's new pre-claim conversation read has no rule for a conversation the send path would refuse

**What is wrong.** R2 step 3 reads the conversation and its `participant_phone`
before the claim, to build the facts, and says any throw in steps 1-4 "fails the
delivery and SQS redelivers". It never says what the job does when:

- the conversation is gone;
- the conversation is a `group_text` or `relay_group`;
- `participant_phone` is absent.

These are designed paths, not faults. RSW D11: when the webhook's conversation
read fails, the decision fails OPEN and "the job's `sendMessage` refuses the
`group_text` send" (RSW spec section 3, D11). Today those cases end in a
`SendRefusedError` WARN (`app/src/services/sendMessage.ts:452-476`). Now they
reach the facts computation first. A builder who throws gets five deliveries, a
dead letter and a `jobs-dlq-depth` page for a by-design refusal. One who
computes a digest from `undefined` gets whatever `recipientDigest` does with
it.

R6 has the same gap: it computes `recipientDigest(sender, participantPhone)`
before `sendMessage` would refuse.

**What it implies.** State each case as a pre-claim refusal: WARN, return, no
record, and the same code the send path would use.

---

## 9. [LOW] The new continuation shape fails the existing parser; R4's "every site" list misses three places

- `SendReconcilePayload.continuation` is `{ senderKey: string; senderNameOverride?: string }`
  (`sendReconcile.ts:122`). `parseContinuation` requires `senderKey`
  (`:200-207`). A `{ retriedTsMsgId }` continuation throws at parse, so every
  `retry_send` check would dead-letter.
- R4's "EVERY owner-dispatch site" list omits:
  - `parseContinuation`;
  - `slotCloseOf` (`:922`), which switches on OUTCOME, so a `never` default
    cannot catch it, and R4 needs it owner-aware;
  - `afterClose`'s own switch (`:967-968`). The cited ":674, :951" are
    `announceLeg` call sites inside `adoptRelay` and `closeSlot`.
- Widening the continuation to a union also forces narrowing at the relay-leg
  reads (`:1092-1097`, `:1125`).

## 10. [LOW] CONTEST A13/B12: R7's stated cost misnames the reader and still omits what it does

R7 says "`isBroadcastRowFor` is the reader that routes it there". The router is the
webhook's `message.broadcast_id` check (`twilio.ts:3529-3545`).
`isBroadcastRowFor` (`app/src/jobs/broadcastFanOut.ts:1296-1306`) is the
BROADCAST reconcile's ownership test, used in `heldBy` (`sendReconcile.ts:595-603`)
and in the adoption's dedupe check (`broadcastFanOut.ts:1382-1393`). It calls any
row carrying the share's `broadcast_id` and no `recipient_contact_id` "mine" for
every recipient of that share on that conversation. Revision 2 widens that set
to manual Retry rows too. The actual hazard is unstated: it needs two contacts
on one phone in one share, inside a reconcile window.

The rest of the cost statement checks out against `twilio.ts:3872-3906` and
`:322`: only `sent` and terminal transitions proceed, and each miss reads, waits
2.5 s and reads again. The 15 s Twilio budget is UNVERIFIED in-repo.

## 11. [LOW] CONTEST A15/B18: R1's media-count rule is still not "exactly the job's own media rule"

The job's rule (`retrySend.ts:267-301`):

- attachments AND a store -> `attachments.length`;
- attachments and NO store -> 0 (media dropped);
- no attachments -> the raw `mediaUrls` count.

R1's wording - "`media_attachments` count when a MediaStore exists, else its raw
`mediaUrls` count, else 0" - gets two of these wrong:

- attachments with no store -> R1 gives the stored `mediaUrls` count; the job
  sends 0.
- raw `mediaUrls` with a store -> R1 gives 0 attachments; the job sends N.

Either mismatch means the reconcile can never adopt that retry and rules it
`unresolved`. `sendMessage`'s own count is `mediaUrls?.length ?? attachments?.length ?? 0`
(`sendMessage.ts:613`), which follows from the job's rule.

## 12. [LOW] Smaller defects in revision 2

- **Resolve requires the ROOT row** ("Root or retried row not found -> ... the
  sweeper"). Nothing needs it: the retried row carries `broadcast_id`, and the
  window origin comes from the retried row. It adds a strand path.
- **Legacy retry rows have no `retry_root`.** For them, section 0's
  `retry_root ?? tsMsgId` names the retry row itself as the root.
  `twilioStatusWebhook.test.ts:1866-1890` seeds exactly this shape. The effect
  is a mis-routed root for chains that straddle the deploy (15-minute exposure).
- **R3's second competitor cannot exist.** R3 names "the webhook's write of a
  NEW `retry_due_at` for a later 30003 on an adopted row" as a competitor. That
  write lands on the ADOPTED row, not the retried row, which fails only once
  (`messagesRepo.ts:133-142`).
- **R3's second-unknown arm** calls `closeFromReconcile`, which is fenced on
  `reconciling` (`sendAttemptsRepo.ts:557-560`). That works only if
  `handToReconcile` ran first. The broadcast analog uses
  `finishAttempt(unresolved)` (`broadcastFanOut.ts:803-805`). Say which.
- **The lineage exclusion identifies the share root's record by recipient key.**
  The retry's key becomes `phone#...` when the contact no longer holds the
  number, and a broadcast key is a contact id (`app/src/routes/broadcasts.ts:273`),
  so the exclusion misses and fails safe to `unresolved`. The broadcast record's
  `sid` equal to the root row's `provider_sid` is the exact identity. "Applies
  to every owner" is vacuous for broadcast and relay owners, which never
  reconcile concurrently with their own retry lineage.
- **`parseRetrySendPayload` returns only three fields** (`retrySend.ts:83`), so
  `deferred` is stripped unless the parser changes. Section 4 does not say so.
- **The existing marker pins must be rewritten or deleted:**
  `twilioStatusWebhook.test.ts:1437-1476` ("duplicate delivery suppressed",
  marker keys), `:1478-1505` (marker write failure propagates) and `:1602`
  (marker size after a window close). Section 4 names only the 19
  registrations.
- **R2 step 8 says WARN**, but `guardWrite` itself logs ERROR on a thrown write
  (`app/src/lib/guardWrite.ts:25-27`).
- **Test 16's mirror** pins `RETRY_PROMISE_WITHDRAWN_AT` and "the copy string to
  the app constants". There is no app constant for that copy, and the dashboard
  needs no sentinel. The values the dashboard mirrors are `'unconfirmed'` and
  `'retry_unresolved'`.
- **`retryFitsSendWindow` with no usable origin** (RSW D5 fail-open) is still
  unstated for the deferral and the re-drive.
- **Test 19's "exactly one ERROR in the app log"** needs the log read scoped the
  way the SOR e2e scopes it
  (`e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:540-560`).

---

## Checked and holding

- **B3** (no promise write on success): holds. RSW's 409 keeps the stale-tab
  refusal for two minutes, and the `annotates === 0` pin
  (`twilioStatusWebhook.test.ts:1855-1897`) stays green.
- **A10/B17** (the wontfix respected): holds.
- **A6/B9** (window before `markRedriven`): holds, as far as it goes. Findings 2
  and 6 cover the remaining pre-claim cases.
- **A8/B10** (the `deferred` flag): holds, subject to the parser (finding 12) and
  the duplicate-envelope case (finding 5).
- **B16/A12** (record phase is `finishAttempt` alone): holds.
- **B11/A15** (the lineage exclusion): sound for the chain's own retry records.
  A predecessor's row exists before this attempt is scheduled, because the
  webhook can act only on a row that exists, so the predecessor cannot hold
  this attempt's message. Its SID stays excluded through its row's `sid#`
  pointer. The identity nit is in finding 12.
- **Conditional `annotateRetryPromise` with one fresh-read retry for terminal
  writes**: closes round 1's race (the re-driven job's WITHDRAW against the
  reconcile's post-enqueue REFRESH). A losing REFRESH is non-terminal and
  harmless.
