# Research 1b as built - what Stage 1b (retry-send adoption) built, for Branch B's plan

Date: 2026-09-28. Reader: read-only research child (no npm, no tests run).
Tree: `W:\tmp\share-sent-outcome`, branch `feat/share-sent-outcome`. Code
read at `cebc7d23` (= main `3f38bcc2` merged in); the planner's spec
restatement `92e6e2fc` landed during this research and changed only B's spec,
so every code citation holds at HEAD `92e6e2fc`. Every citation is
`path:line` on THIS tree. Exact signatures, key shapes and short excerpts are
in the gitignored companion `.superpowers/sdd/research-1b-as-built-reference.md`.

Question: what did 1b build, where, and where does it differ from Branch B
spec section 0's four facts (`docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md:56-94`,
as restated at `92e6e2fc`) and from 1b's own spec r5
(`docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`, errata
section 8 at `:765-925`).

## Headline: B's section 0 (at 92e6e2fc) against the code

The restatement already carries the four big deltas: the 16-hop legacy walk
(`app/src/services/retryChain.ts:31`), the silent `retry_of` rollup skip as
the interim (`app/src/routes/webhooks/twilio.ts:3529`, give-up WARN at
`:3904`), `retry_outcome` on a share's own root row (erratum 13), the
never-re-applied job-arm WITHDRAW (erratum 9) and `isBroadcastRowFor`
(`app/src/jobs/broadcastFanOut.ts:1303`). All four facts HOLD as built. What
section 0 still does not say, and a plan must:

1. The WITHDRAW runs only when the record close WON - at both job arms
   (`app/src/jobs/retrySend.ts:804-807`, `:862-865`) and in the reconcile
   (`app/src/jobs/sendReconcile.ts:1449-1455`). A lost or failed close writes
   neither the record outcome nor `retry_outcome`. In the reconcile a failed
   or lost WITHDRAW THROWS so the redelivery re-applies it
   (`sendReconcile.ts:1368-1370`).
2. Fact 2's "expire" list is longer as built: also the reconcile's
   `redrive_refused` (window closed at never_sent, `sendReconcile.ts:1594-1598`,
   `:1616-1636`), a re-drive enqueue failure `enqueue_failed`
   (`:1489-1504`), `refused` with `enqueue_failed` (deferral re-enqueue
   failed, `retrySend.ts:761-768`) and `refused` with `manual_retry_superseded`
   (`:487-490`). The promise they leave may have been REFRESHED first (up to
   about origin + 21 min, section G) - inside B's 24-minute bound.
3. A retry record `done`/`refused` with cause `already_sent` means the retry
   text EXISTS (errata 18/21; `retrySend.ts:279`, `:477-486`) - not a chain
   end. `never_sent` is in the outcome union but no writer stores it
   (`app/src/repos/sendAttemptsRepo.ts:78`).
4. The skip at `twilio.ts:3529` is SILENT (no read, no wait, no line), and
   the give-up line at `:3904` is main's original NON-ASCII text (U+2014):
   a B edit to that line must re-word it in ASCII.
5. The adoption site has a crash window 1b does not cover for B: the
   superseded exit re-applies nothing for `adopted` (section B, site 5).
6. Section 0 bullet "no receipt ever transitions an adopted row"
   (`share-sent-outcome-design.md:109`) is only half true: a receipt that
   arrives BEFORE the adoption's append is dropped at the webhook's
   unknown-SID path (`twilio.ts:3346-3370`, ERROR `:3419`), but one that
   arrives AFTER it finds the row by SID and transitions it like any row
   (and, after B, reaches the rollup). The adoption hook is still needed.

## A. The message-row fields at every retry append site

Three sites pass `retryOf`, and only these three (grep of `app/src`):

- Automatic retry, `retrySend.ts:557-579` (through `sendMessage`):
  `retryOf` = retried row's tsMsgId (`:565`), `retryAttempt` = payload attempt
  (`:566`), `retryWindowStart` = `oneToOneRetryWindowOrigin(retried)` when a
  string (`:381`, `:567`), `retryRoot` (`:568`), `broadcastId` =
  `retried.broadcast_id` when present (`:569`), `automated` =
  `retried.automated ?? true` (`:562`), `recipient` = the contact read by
  `retried.recipient_contact_id` (`:390-401`, `:564`).
  `recipient_contact_id` is then stamped by `sendMessage` only while that
  contact still holds the thread's number (`app/src/services/sendMessage.ts:494-505`,
  `:685`). `sendMessage` forwards `broadcastId`, `retryOf`, `retryRoot` to
  the append (`sendMessage.ts:671`, `:676`, `:680`).
- Reconcile adoption, `adoptRetry` `sendReconcile.ts:850-947`, append at
  `:882-903`: `retryOf` = owner's retriedTsMsgId (`:898`), `retryAttempt` =
  owner attempt (`:899`), `retryWindowStart` (`:881`, `:900`), `retryRoot` =
  the OWNER's `retryRoot` fact (`:901`), `broadcastId` =
  `retried.broadcast_id` (`:902`), `automated` = `retried.automated ?? true`
  (`:871`, `:896`), `recipientContactId` only when the owner key is a contact
  id and that contact exists undeleted and holds the thread number
  (`:873-880`, `:897`). `deliveryStatus` = `mapTwilioStatus(providerStatus)`
  (`:866`), `errorCode` only on failed/undelivered (`:867-868`),
  `providerTs` = provider creation time (`:885`).
- Manual Retry route, `app/src/routes/api.ts:1585-1781`, send at
  `:1755-1772`: `retryOf` (`:1764`), `retryRoot` (`:1768`), `broadcastId`
  from the pressed row (`:1769`), `automated: false` (`:1760`), `recipient`
  (`:1771`). NO `retryAttempt`, NO `retryWindowStart` (a manual row).
- The append writes the row fields at `app/src/repos/messagesRepo.ts:2611`
  (`broadcast_id`), `:2617` (`retry_of`), `:2619` (`retry_root`), `:2620`
  (`retry_attempt`), `:2621-2623` (`retry_window_start`), `:2627`
  (`automated`), `:2628-2630` (`recipient_contact_id`). `retry_outcome` and
  `retry_due_at` are NEVER written by append (`messagesRepo.ts:1073-1074`).

The root rule as built, `resolveRetryRoot` (`retryChain.ts:34-44`):
- the row's own `retry_root` when it carries one (`:37`) - every row 1b
  appends does, so post-1b rows return at hop 0;
- a row without `retry_of` is its own root (`:38`) - so attempt 1 on a
  share's own row gets `retry_root` = that row's tsMsgId = the slot's pointer;
- otherwise a consistent parent read up `retry_of` (`:39`); a broken link
  returns the last row read (`:40`); after 16 hops the last row read (`:43`).
- Bound: `RETRY_ROOT_WALK_MAX_HOPS = 16` (`:31`), raised from 12 by `3f38bcc2`;
  `automaticAncestry` keeps `MAX_SEND_RETRY_ATTEMPTS` = 3 (`:47-56`,
  `app/src/lib/retrySendWindow.ts:35`).
- Callers: the job on the retried row (`retrySend.ts:378`) and the manual
  route on the pressed row (`api.ts:1654`). The reconcile never walks: it
  carries the owner's `retryRoot` (`sendReconcile.ts:637`, `:901`).

`broadcast_id` is copied ONE HOP from the retried (or pressed) row at all
three sites (`retrySend.ts:569`, `sendReconcile.ts:902`, `api.ts:1769`); it
is never read from the root. A post-1b retry of an unstamped pre-1b retry row
therefore carries no `broadcast_id` (B section 0's stated hole holds).

The `retrychild#` pointer family:
- Partition `retrychild#<conversationId>#<parentTsMsgId>` (`messagesRepo.ts:2102-2107`),
  sort key = the child's tsMsgId; item fields `provider_sid` and
  `retry_attempt` (absent on a manual child) (`:2785-2798`). No
  `expires_at` (erratum 14), no reaper.
- Written only by `append`, in the same transaction as the row, for every row
  carrying `retryOf` (`:2776-2799`); a dedupe cancels the whole transaction.
- Read by `listRetryChildrenConsistent(conversationId, parentTsMsgId)`
  (interface `:1544`, impl `:3359-3386`): one consistent paged Query, tsMsgId
  order, returns `RetryChildPointer[]` (`:2110-2114`). Pre-1b retry rows have
  no pointer (no backfill, `:1540-1543`).
- Readers: the job's step 4a (`retrySend.ts:477`), the reconcile's own-row
  proof (`sendReconcile.ts:1111`), the manual route's `superseded` refusal
  (`api.ts:1638-1642`).

`tsMsgId` = provider timestamp + `#` + SID (`messagesRepo.ts:203-205`), so
B's "attempt order = message id order" is the provider-time order as built.

## B. The four unresolved-end sites and the adoption site

Shared helpers: `withdrawRetryPromise` (`app/src/services/retryPromiseWrites.ts:76-107`)
writes sentinel + `retry_outcome` in one conditional write, retries once from
a fresh consistent read, is a NO-OP ('already', no emit) when both are there
(`:83`, `:93`), emits `message.persisted` for the retried row on 'written'
(`:85`, `:95`), never throws. `guardWrite` (`app/src/lib/guardWrite.ts:16-29`)
catches, logs ONE ERROR with a label, returns false - "true" means the write
resolved, not that its fence won.

(1) Reconcile unresolved close - `closeUnresolved`, `sendReconcile.ts:1441-1462`.
Order: record `closeFromReconcile(unresolved, cause)` FIRST (`:1449`); lost
close: INFO, nothing else (`:1450-1455`); ONE ERROR (`:1456-1459`);
`closeSlot(SEND_UNCONFIRMED_CODE)` (`:1460`); `afterClose` = the retried
row's `message.persisted` (`:1461`, `:1414-1427`). The WITHDRAW lives in
`closeSlot`'s `retry_send` arm (`:1347-1372`), keyed on the CODE, only when
`r.row` is present (`:1366-1371`); 'failed' or 'lost' throws (`:1368-1370`).
Reached from: the `unresolved` verdict (`:579-581`), a failed next-check
enqueue (`enqueueOrClose` `:1485-1487`), and `redrive`'s second_unknown
(`:1658-1661`). `r.row` is the RETRIED row read consistently (`:626`), which
carries `broadcast_id`; the root is `r.owner.retryRoot`.
B's insertion: inside `closeSlot`'s `retry_send` arm beside the WITHDRAW
(`:1366`). Record state there: `done` / `unresolved`. This one insertion also
serves site (2).

(2) Redelivery re-apply - the superseded exit, `runCheck` `sendReconcile.ts:518-533`.
A redelivered check finding the record `done` for its own `attemptedAt`
runs `slotCloseOf(record.outcome)` (`:529`; map `:1315-1326`: `unresolved`
to `SEND_UNCONFIRMED_CODE`, `redrive_refused` and `enqueue_failed` to their
codes, all else nothing) then `closeSlot` and `afterClose` (`:530-531`).
`slotCloseOf` takes no owner; for `retry_send` only the unresolved code
acts (`:1366`). Record state: `done` / `unresolved`.

(3) Job second-unknown arm - `onUnknown`, `retrySend.ts:851-880`, the branch
at `:859-877`. Order: `finish(unresolved, second_unknown)` (a `guardWrite`
around `finishAttempt`, `:860`, helper `:676-695`); close not 'won': ONE
ERROR, return, NO WITHDRAW (`:862-865`); else `withdrawRetryPromise`
(`:869`, which emits) then ONE ERROR stating the WITHDRAW's result
(`:870-875`). Trigger: `secondUnknownWouldClose = claim.record.redriveCount >= 1`
(`:539`). B's insertion: immediately before `:860`. Record state: `attempting`
(claimed by this run from `redriven`, re-armed before the provider call,
`:570-578`).

(4) Job enqueue-failed-after-handoff arm - `handOff`'s catch,
`retrySend.ts:792-828`, catch at `:798-819`. Order: `guardWrite` around
`closeFromReconcile(unresolved, enqueue_failed)` (`:800-802`); not written or
lost: ONE ERROR, return, no WITHDRAW (`:804-807`); else WITHDRAW (`:811`)
then ONE ERROR (`:812-817`). `handOff` has three callers: the gate's takeover
at step 4 (`:432-436`, BEFORE the claim and before 4a), the claim's takeover
(`:531-535`), and `handToReconcile` after it won (`:838-844`). B's insertion:
immediately before `:800`. Record state: `reconciling`, `check_no` 0
(`handToReconcile` / `takeOver`, `sendAttemptsRepo.ts:549-577`). A guard is
mandatory: nothing may throw here (the job's contract, `retrySend.ts:24-27`).

(5) Reconcile adoption of a retry - the append is `adoptRetry`
(`sendReconcile.ts:850-947`, append `:882-903`), called from `adopt`
(`:819-820`) via the known-SID path (`adoptKnown` `:1049-1061`) or the list
(`lookup` `:1263`). Idempotence: a dedupe onto THIS attempt's own row is
`skipped` (`:904-910`, `:946`); onto other lineage is `other` (`:910`).
Before any list, `lookup` answers from the attempt's own `retrychild#` row
(`ownRetryRow` `:1110-1123`, called first at `:1147-1150`): `found`,
adoption `skipped`, status = the stored row's `delivery_status`, no append.
The verdict lands in `runCheck`'s `found` arm (`:541-558`):
`closeFromReconcile(adopted, sid)` (`:542`), INFO, `afterClose` (`:557`) -
note `afterClose` runs even when the close lost (`:551`). No promise write
(the retried row's promise expires).
B's insertion options: (a) before `:542` - record `reconciling` with this
check recorded; a crash before the close leaves the record reconciling, and
the redelivered check re-finds the row through `ownRetryRow` and re-runs the
hook with adoption `skipped`; or (b) after `:542` - record `done/adopted`,
but then a crash has NO re-apply: the superseded exit re-applies nothing for
`adopted` (`slotCloseOf` `:1315-1326`), so B would have to add one there. Gate
the hook on `r.owner.kind === 'retry_send'` and `r.row.broadcast_id`.
Status mapping to copy for the slot: the share adoption's
(`app/src/jobs/broadcastFanOut.ts:1400`: failed/undelivered to failed,
delivered to delivered, else sent).

A redelivered `messaging.retrySend` job, step 4 as built (`retrySend.ts:432-465`,
gate `app/src/lib/sendAttemptGate.ts:30-39`):
- `done` with any outcome but `retryable`: INFO `this attempt is already
  resolved`, return (`retrySend.ts:442-445`).
- `reconciling`, or `attempting` younger than `SEND_CLAIM_TTL_MS` (30 s,
  `app/src/lib/sendOutcome.ts:29`): INFO `a concurrent delivery owns this
  attempt`, return (`retrySend.ts:438-441`) - one line for both, not a
  distinct reconciling line as r5 R2 step 4 reads.
- `attempting` older than the TTL: the gate takes it over and the job hands
  off (`:433-437`).
- absent, `done/retryable`, `redriven`: proceed to the pre-adoption marker
  belt (absent only, `:459-465`), step 4a (`:477-491`), 4b (`:497-506`), claim.

## C. The attempt records

Key format (`sendAttemptsRepo.ts:169-186`, `:188-201`, `:213-217`): partition
`sendattempt#` + ownerKey; sort key = `hashRecipientKey(recipientKey)`.
- retry owner: ownerKey `retry#<conversationId>#<retriedTsMsgId>#<attempt>`
  (`:179`); `retryRoot` is NOT in the key (only in the stored `owner` map).
- broadcast owner: ownerKey `broadcast#<broadcastId>` (`:172`); recipient key
  = the slot key (`contactKey`, `:191`) - derivable from the share alone.
- `hashRecipientKey`: a contact id is used as-is; `phone#...` becomes
  `phonehash#` + 32 hex of sha256 (`app/src/lib/sendFingerprint.ts:48-51`).

Retry recipient key: `retryRecipientKey(row, conversation)`
(`retryChain.ts:59-66`) = the RETRIED row's `recipient_contact_id`, else
`phone#` + the conversation's `participant_phone`. NOT derivable from a
broadcast slot key alone: it needs the retried row (the slot's `tsMsgId` row
for attempt 1; the previous retry row for attempts 2-3) and the thread
(slot `conversationId`, `app/src/repos/broadcastsRepo.ts:138`). A phone-keyed
slot can yield a contact-keyed retry record (the share send passes
`recipient: contact`, `broadcastFanOut.ts:915`), and a retry row's
`recipient_contact_id` is re-judged at each send, so the key can change down
a chain. The attempt number per retried row is exactly
`(retry_attempt ?? 0) + 1` (erratum 1/21; `api.ts:1655`, `retrySend.ts:370`).

Record fields as read (`toRecord`, `sendAttemptsRepo.ts:251-268`): `owner`,
`state` (`attempt_state`), `attemptNo`, `attemptedAt`, `redriveCount`,
`checkNo`, `sid?`, `outcome?`, `cause?`, plus the facts (`recipientDigest`,
`sender?`, `bodyHash`, `bodyShort`, `mediaCount`). Stored also: `expires_at`
(epoch seconds, attemptedAt + 30 days, set at claim and at every re-arm,
`:48`, `:224-226`, claim `:327`, rearm `:436`) and `last_op`. No
`created_at`; `toRecord` does not return `expires_at`.

Vocabularies (`sendAttemptsRepo.ts:71-81`): states `attempting`,
`reconciling`, `redriven`, `done`; outcomes `sent`, `rejected`, `retryable`,
`refused`, `adopted`, `never_sent` (never stored), `unresolved`,
`enqueue_failed`, `redrive_refused`.

"Text never went" for a RETRY record: `rejected`; `retryable` (deferred,
nothing out); `refused` EXCEPT cause `already_sent` (causes: a
`SendRefusedError` code, `sms_sending_disabled`, `deferral_cap`,
`retry_window_closed`, `enqueue_failed`, `manual_retry_superseded`,
`retrySend.ts:275-279`, `:699`, `:743`, `:748`, `:763`); `enqueue_failed`
(re-drive enqueue, `sendReconcile.ts:1489`); `redrive_refused`. Went:
`sent`, `adopted`, and `refused/already_sent`. May have gone: `unresolved`.
For the BROADCAST owner (B's D1 read), `refused` comes only from a send
refusal or a fence (`broadcastFanOut.ts:656`, `:1011`), so B's D1 list holds.

Reads: `get(owner)` - one consistent GetItem (`sendAttemptsRepo.ts:360-363`);
the whole owner object is passed but only kind, ids, attempt and
recipientKey form the key. `listByRecipient(sender, digest, sinceIso)`
(`:622-652`) - a consistent Query on the recipient index then one `get` per
item. No BatchGet, no query by owner or conversation.

## D. The status webhook

- Message read: `getByProviderSid` (eventual), one retry after the delay
  (`twilio.ts:3346-3370`); a still-unknown SID logs ERROR and acks
  (`:3419`). A receipt that outruns an ADOPTION append is dropped there.
- The 30003 promise: decided before the status write (`:3452-3460`) and
  written in the SAME conditional write as the failure
  (`updateDeliveryStatus` `:3462-3467`; repo `messagesRepo.ts:2947-2954`).
- The rollup gate, `twilio.ts:3529`: `broadcast_id` a non-empty string AND
  `retry_of === undefined`; only inside `if (transitioned)` (`:3520`). The
  `retry_of` clause is the ONE line 1b changed in this file (net diff from
  the cut point `3dbb5740`). The skip is silent: no log line, no read.
- `rollIntoBroadcast` (`:3853-3984`): maps status (`:3872-3878`; `sent` and
  terminal statuses only); `broadcasts.getById` (eventual, `:3880`); missing
  broadcast WARN (`:3882`); slot match by the slot's `conversationId` AND
  `tsMsgId` against the row's (`:3887-3889`); one re-read after
  `statusRetryDelayMs` (default `STATUS_UNKNOWN_SID_RETRY_DELAY_MS` = 2500,
  `:322`, `:702`, wait `:3898`); give-up WARN `:3904` (non-ASCII text,
  byte-identical to main).
- `broadcastSlotMayTransition` (`:3840-3844`): refuses `delivered`, `failed`,
  `skipped` - a failed slot never moves (`:3909`).
- `sent` branch: only a `sent` slot with no `carrierSentAt` (`:3923`);
  conditional `setRecipient(..., ['sent'])` (`:3924-3929`), re-read, emit
  (`:3933-3937`), INFO (`:3939`).
- terminal branch: conditional `setRecipient(..., ['queued','sent'])`
  (`:3949-3958`), THEN a separate `bumpStats` (`:3975`) - two writes, not
  the one-write shape B's I4 requires (that shape is
  `recordRecipientOutcome`, `broadcastsRepo.ts:462-468`); emit
  (`twilio.ts:3978-3982`); INFO (`:3983`).
- `broadcast.updated` payload: `{ broadcastId, status, stats:
  deriveBroadcastStats(item) }` (`:3933-3937`, `:3978-3982`); the same shape
  as `emitBroadcastProgress` (`broadcastFanOut.ts:226-232`).
- ORDER: the rollup runs BEFORE the 30003 arm (`twilio.ts:3529` vs
  `:3567-3660`), so at the original row's rollup the promise is on the row
  but no retry is enqueued yet. The enqueue is `:3624-3631`; on failure RSW
  withdraws with `annotateMessage` (sentinel only, NO `retry_outcome`,
  unconditional) and emits (`:3632-3656`), then rethrows. B's D7 `pending`
  written at the rollup can therefore precede a withdrawal.
- Other readers of `broadcast_id`: `isBroadcastRowFor` returns false for any
  row with `retry_of` (`broadcastFanOut.ts:1299-1310`, check `:1303`),
  used by the broadcast adoption's dedupe (`:1391`) and the reconcile's
  `rowIsMine` for a broadcast owner (`sendReconcile.ts:755-773`, `:759`);
  `heldBy` (`:723-743`) goes through `rowIsMine` and names holders with
  `rowHolder` (`:787-791`: a share's OWN row is `broadcast_id` and no
  `retry_of`); `predecessorMatchers` reads the retried row's `broadcast_id`
  to exclude the share's own record from siblings (`:1090-1093`).

## E. 1b spec section 8 errata against the code

1. Route reads ONE record at `(retry_attempt ?? 0) + 1` - matches (`api.ts:1655-1667`).
2. Open record blocks for `RETRY_SEND_WINDOW_MS` from attemptedAt - matches (`api.ts:1683-1690`).
3. Record guard holds for the 30-day `expires_at`; after it the row's `retry_outcome` belt - matches (`api.ts:1670-1675`; `sendAttemptsRepo.ts:48`).
4. Adapter kill switch takes the refused arm - matches (`retrySend.ts:640-644`).
5. Consistent step-1 read; conversationId-mismatch decline - matches (`retrySend.ts:351`, `:362-368`).
6. Read-only marker belt, absent record only, dated TODO - matches (`retrySend.ts:455-465`).
7. `guardWrite` = resolved; lost fences logged INFO by the caller; lost release refreshes nothing, thrown release refreshes + ERROR - matches (`retrySend.ts:676-695`, `:770-779`, `:846`).
8. Single deferral per payload - matches (`retrySend.ts:742`).
9. WITHDRAW re-apply is a no-op; the job's lost/failed WITHDRAW is never re-applied - matches (`retryPromiseWrites.ts:83`, `:93`; `retrySend.ts:811-817`, `:869-875`).
10. WITHDRAW map in `closeSlot`'s `retry_send` arm keyed on the code - matches (`sendReconcile.ts:1347-1372`).
11. Adoption reads `mediaCount` from the record - matches (`sendReconcile.ts:860-865`).
12. Phone-keyed attempt with a changed thread number is unaddressable - matches (`sendReconcile.ts:629-630`, `:500-509`).
13. `retry_outcome` can land on a share's own root row - matches (no guard in `withdrawRetryPromise`; `r.row`/`retried` is the share row at attempt 1).
14. Pointer carries no `expires_at` - matches (`messagesRepo.ts:2789-2795`).
15. Final ruling: rollup skipped for `retry_of` rows, give-up back at WARN; `isBroadcastRowFor` ignores `retry_of` - matches (`twilio.ts:3529`, `:3904`; `broadcastFanOut.ts:1303`). The erratum's first half ("re-worded in ASCII") is SUPERSEDED: the line is main's original non-ASCII text again.
16. In-flight manual residual wider - no code (a manual send ending unknown appends no row; the route has no record, `api.ts:1754-1780`).
17. E2E gate budget 1800 s - procedural; not in `e2e/playwright.config.ts`.
18. The attempt's own child declines before the claim, WARN, `already_sent` - matches (`retrySend.ts:477-486`, `:712-717`).
19. Reconcile lookup answers from the own row first, one WARN on an unreadable pointer - matches (`sendReconcile.ts:1110-1123`, `:1147-1150`).
20. Legacy walk bound 16 - matches (`retryChain.ts:31`); `automaticAncestry` keeps 3 (`:50`).
21. Attempt-invariant step-1 decline at WARN - matches (`retrySend.ts:369-377`).

Handback deviations (`docs/superpowers/reviews/2026-09-27-retry-send-adoption/handback.md:94-109`):
1 one record per press (`api.ts:1655`); 2 adapter kill switch refused
(`retrySend.ts:640-644`); 3 consistent step-1 read (`:351`); 4 fenced line
ASCII + INFO - SUPERSEDED by `3f38bcc2` (`twilio.ts:3529`, `:3904`);
5 WITHDRAW map in `closeSlot` (`sendReconcile.ts:1366`); 6 guardWrite
semantics (`retrySend.ts:676-695`); 7 `isBroadcastRowFor` ignores `retry_of`
(`broadcastFanOut.ts:1303`); 8 one staleness bound (`api.ts:1683-1690`);
9 adoption media from the record (`sendReconcile.ts:860`); 10 read-only
marker belt (`retrySend.ts:459-465`); 11 conversation-mismatch decline
(`:362-368`); 12 own-row belt in job and reconcile (`:477-486`;
`sendReconcile.ts:1147-1150`); 13 attempt invariant (`retrySend.ts:369-377`);
14 walk bound 12, now 16 (`retryChain.ts:31`). Wording notes C-7 / C-8.

Where a builder reading 1b r5 would be wrong:
- r5 R7 "the rollup ... finds no slot ... waits 2.5 s" and "give-up moves to
  INFO" - both gone; the rollup is skipped for retry rows (above).
- r5 section 0 "up to `MAX_SEND_RETRY_ATTEMPTS` hops" - 16.
- r5 R2 step 4a "an AUTOMATIC child does not trigger it" - an own-attempt
  child declines (`already_sent`), and a child of another attempt number is
  unreachable (erratum 18/21).
- r5 R6 "three gets" - one get.
- r5 R4 "Adopt ... its `media_attachments`" - only when the record's
  `mediaCount` > 0 (`sendReconcile.ts:860-865`).
- r5 R5 "never on broadcast rows" - it lands on a share's own row.
- r5 R2 step 4: `reconciling` logs the same INFO as a fresh `attempting`.

## F. Tests B will touch

Rewritten to the new rule:
- `app/test/twilioStatusWebhook.test.ts:374-424` "broadcast rollup: a receipt
  for a share-RETRY row (broadcast_id + retry_of) SKIPS the rollup - no
  broadcast read, no wait, no give-up line ..." (asserts `reads` 0, no
  give-up line, slot stays `failed`, no `broadcast.updated`).
- `e2e/tests/dashboard-next/send-outcome-reconcile.spec.ts:420-490`, the
  21211 hint pin at `:459-464` (B's D3; SOR's, not 1b's).
- `e2e/tests/dashboard-next/share-skip-fix.spec.ts` D5 interim pin (`:18`,
  `:280` onward) and the dashboard notes at
  `dashboard/src/routes/broadcasts/broadcastFormat.test.ts:185`,
  `StatChips.test.tsx:175` (Branch A's interim rule, which B replaces; the
  runtime rule is `broadcastsRepo.ts:717-731`).

Must stay green (B's inserted calls must not change their counts):
- `app/test/twilioStatusWebhook.test.ts:245` (original-row miss re-read),
  `:296` and `:344` (carrierSentAt on a share's own row).
- `app/test/retrySendAttempt.test.ts:374` (1c), `:399` (1d), `:1289` (FW1 C-5
  second unknown) and `:1336` (FW1 C-5 hand-off enqueue failure) - each pins
  ONE close ERROR line; `:1033` (7, share-root `broadcast_id`), `:1084` (8).
- `app/test/sendReconcile.test.ts` `retry_send owner` block (`:3015-4048`):
  `:3154` (10a - seeds a share row `bcast-9` with NO broadcast item, so a B
  hook must tolerate a missing broadcast), `:3266` (10d), `:3285` (10e),
  `:3505` (12, "one ERROR"), `:3617` (12c), `:3698` / `:3708` (C-2, "ONE
  unresolved ERROR in total"), `:3756` / `:3783` (own-row found), `:3885`
  (13a share root lineage), `:4007` and `:4015` (`isBroadcastRowFor` /
  holder naming for share-retry rows).
- `app/test/retryChain.test.ts` (the 16-hop pins added by `3f38bcc2`).
- `e2e/tests/dashboard-next/retry-send-adoption.spec.ts` cases 17 (`:353`),
  18 (`:441`), 19 (`:522`): all one-to-one, NONE touches a share; 17 and 18
  assert `broadcast_id` undefined (`:400`, `:484`).

## G. Other things a builder needs

- Promise helpers: `refreshRetryPromise(deps, row, retryDueAt, ctx)` returns
  boolean (`retryPromiseWrites.ts:44-70`); `withdrawRetryPromise(deps, row,
  ctx)` returns 'written' | 'already' | 'lost' | 'failed' (`:76-107`);
  "withdrawn" keys on sentinel AND outcome (`:72-73`). Deps type `:28-32`.
  Repo write: `annotateRetryPromise` (`messagesRepo.ts:1554-1559`,
  `:3388-3426`). Constants: `RETRY_PROMISE_WITHDRAWN_AT` (1970 epoch),
  `RETRY_OUTCOME_UNCONFIRMED`, `RETRY_PROMISE_GRACE_MS` 2 min,
  `RETRY_JOB_GRACE_MS` 1 min, `RETRY_SEND_WINDOW_MS` 15 min,
  `isRetryPromiseLive` (`app/src/lib/retrySendWindow.ts:15-38`, `:99-104`).
- Promise refresh values (for B's 24-minute bound): hand-off = attemptedAt +
  `reconcileCheckDelaysMs()[2]` + 2 min (`retrySend.ts:820-826`); re-drive =
  now + 1 min + 2 min, only inside the window (`sendReconcile.ts:1675-1682`,
  `:1594-1598`); deferral = the run time (`retrySend.ts:772`). Production
  check delays 5/30/240 s (`sendOutcome.ts:30`). The maximum stays within
  B's 15 + 4 + 2 + 2 + 1.
- Lane seams: `E2E_SEND_RETRY_BACKOFF_MS` (`retrySend.ts:163`, `:181-188`;
  `scripts/e2e-session.mjs:283`, 10000) and `E2E_SEND_RECONCILE_DELAYS_MS`
  (`sendReconcile.ts:210-215`; `e2e-session.mjs:296`, 2000,4000,8000), both
  ignored when `JOBS_QUEUE_URL` is set. On the lane jobs run in process and a
  delayed dispatch is never redelivered (`sendReconcile.ts:17-19`), so the
  redelivery re-apply paths are unit-test-only.
- Fake carrier 30003: `setDeliveryOutcome(request, { partyNumber, profile:
  { kind: 'fail', failState: 'undelivered', errorCode: '30003' } })`
  (`e2e/fixtures/fakeTwilio.ts:354-373`; route
  `fake-twilio/src/routes/control.ts:81`; engine
  `fake-twilio/src/engine/engine.ts:209-215`; used at
  `retry-send-adoption.spec.ts:367`). `failNextSend` modes and `failList`:
  `fakeTwilio.ts:400-428`.
- Harness twins B must extend: `world.sendAttemptsRepo`
  (`app/test/helpers/twilioWebhookHarness.ts:341-347`, `:4491`), the fake
  `listRetryChildrenConsistent` / `annotateRetryPromise` (`:1504`, `:1513`),
  `recordRecipientOutcome` / `closeRecipientIfQueued` (`:3175-3330`), the
  mirrored prior-recipients rule (`:3367`).
- Precedent for "slot first, then record" at a job arm: the broadcast
  fan-out's own hand-off enqueue failure closes the slot, then the record
  (`broadcastFanOut.ts:561-575`).
- TODO markers: NONE addressed to Branch B (no `TODO(broadcast-30003...`,
  no `share-sent-outcome` marker). Comments naming Branch B:
  `broadcastFanOut.ts:1297`, `sendReconcile.ts:832`, `messagesRepo.ts:756`,
  `api.ts:1767`, `retryChain.ts:29`, `broadcastsRepo.ts:726`. The only TODO
  in 1b's files is `TODO(retry-send-lost-under-job-marker)`
  (`retrySend.ts:455`). The issue note is
  `docs/issues/broadcast-30003-retry-never-updates-slot.md:62-113`; its
  bullet at `:77-84` (INFO give-up, 2.5 s cost) is superseded by `:101-106`.
