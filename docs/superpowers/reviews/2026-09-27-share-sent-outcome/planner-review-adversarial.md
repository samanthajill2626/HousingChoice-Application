# share-sent-outcome - planner's plan-blind adversarial review

Reviewer: planner's independent adversarial reviewer (PLAN-BLIND: diff and
repository only; no spec, plan, docs/superpowers file or branch-added issue
was read). Scope: `git diff 3f38bcc2 e824a452 -- app dashboard e2e RUNBOOK.md
README.md`, code final e824a452. READ-ONLY: no npm, test, server or lane was
run. Every claim cites a `file:line` read at e824a452 unless marked
UNVERIFIED.

## 1. The behavior derived from the diff

1. A share recipient's later attempts now reach the ORIGINAL slot. A retry
   row (`retry_of` set, carrying `broadcast_id` + `retry_root`) is routed by
   the status webhook to the slot whose `conversationId` + `tsMsgId` equal the
   row's conversation + `retry_root` (app/src/routes/webhooks/twilio.ts:3559-3562,
   3941-3966), through one attempt-ordered conditional write
   (`applyLaterAttempt`, app/src/services/shareAttemptOutcome.ts:220-266;
   `broadcastsRepo.applyAttemptOutcome`, app/src/repos/broadcastsRepo.ts:951-988).
   The slot gains `latestAttempt` (the newest attempt's tsMsgId, or a row-less
   `<retried>~` marker for an unresolved chain end). Order = string order of
   the message id (app/src/lib/shareAttemptOrder.ts:1-38). Five inserted call
   sites: the webhook (retry rows), the reconcile's found arm and its
   unresolved close (app/src/jobs/sendReconcile.ts:580-582, 1457-1459), and the
   retry job's two unresolved arms (app/src/jobs/retrySend.ts:855, 919).
2. One per-recipient state (app/src/services/shareRecipientState.ts:67-91):
   reached / pending / unconfirmed / in_flight / stranded / failed / skipped.
   A failed-30003 slot reads its newest attempt ROW (promise, chain end) only
   while that attempt is younger than 24 minutes (:43, :111-116); past that the
   slot alone decides (:85). The composer's "Already sent" is the SAFE reading
   (`mayHaveReached`, :94) over every share of the unit (`priorRecipientKeys`,
   :249-270) and REPLACES the old rule that flagged every non-skipped slot,
   `failed` included (base app/src/repos/broadcastsRepo.ts:731 at 3f38bcc2).
3. The listing-send ledger follows the rule: per-share memory `shares`,
   `counted`, a CAS token `shares_op`; `sentAt`/`broadcastId` REMOVED while no
   entry counts, so `byContact` drops the pair and the base reader filters it
   (app/src/repos/listingSendsRepo.ts:155-158, 203-273, 308-333;
   app/src/services/shareLedger.ts). `recordSend` is gone; writers are the
   fan-out/adoption (acceptance or delivery), the webhook's original-row
   rollup (delivered/failed), and `applyLaterAttempt`'s side effects.
4. Read-time relabelling: the results/list routes carry a true
   `retry_pending` sub-bucket and re-bucket row-unconfirmed slots
   (app/src/routes/broadcasts.ts:251-256, 880-898, 944-947); a `?view=stats`
   variant; the share pill derives Sent / Sending / Not confirmed / Not sent
   from buckets (dashboard/src/routes/broadcasts/broadcastFormat.ts:108-120);
   landlord "Sent to N tenants" and unit-activity `tenantCount` recount reached
   slots (app/src/routes/contactTimeline.ts:1452-1484, app/src/routes/units.ts:1266-1294);
   a tenant's "Property sent" pin takes its words from the ledger entry of its
   share (app/src/routes/contactTimeline.ts:713-742, 1368-1402).
5. `MAX_BROADCAST_RECIPIENTS` 1500 -> 1000 (app/src/repos/broadcastsRepo.ts:75).
6. `app/scripts/repair-share-outcomes.ts`: dry-run-first census/apply that
   rebuilds each slot's retry chain from the thread, stamps
   `broadcast_id`/`retry_root`, re-applies the decided attempt through the
   live services, and rebuilds the ledger from the slot.

## 2. Findings (most severe first)

### F1 [HIGH] A share retry's ACCEPTANCE is never recorded on the slot - a retry whose receipts do not route leaves the slot `failed 30003`, which D1 reads as a FINAL failure after 24 minutes: the composer drops "Already sent" and re-includes a tenant the retry reached (a double text)

What is wrong. The original send and the retry send fail in opposite
directions. The fan-out records the original slot `sent` AT ACCEPTANCE
(app/src/jobs/broadcastFanOut.ts:948-954), so a lost receipt leaves it
"reached" - the safe side. The retry job's success arm writes NOTHING to the
share slot: its record phase is `finishAttempt` + a log line
(app/src/jobs/retrySend.ts:595-610; the only share write in the job is
`markShareUnconfirmed`, :811-838, called only from the two unresolved arms,
:855 and :919). A retry reaches its slot ONLY through its own status receipts,
gated on the row's transition (app/src/routes/webhooks/twilio.ts:3545, 3561-3562).
Every way a receipt fails to route therefore strands the slot at the retried
attempt's `failed 30003`:
- a status callback that never reaches the app (a deploy restart or an origin
  5xx; Twilio's default status-callback policy does not redeliver a 5xx -
  UNVERIFIED for a refused connection);
- the unknown-SID race: the callback beats the retry row's append past the
  one re-look, and is dropped with ERROR "status callback for unknown provider
  SID after retry - delivery outcome dropped" (twilio.ts:3425-3438);
- `applyLaterAttemptBounded` giving up (shareAttemptOutcome.ts:274-289);
- a `no_slot` miss (F2).
Once the retried attempt is 24 minutes old, `needsRowRead` is false
(shareRecipientState.ts:111-116), `facts.row` stays undefined and the slot
reads `failed` (:85), `mayHaveReached` is false (:94), and the tenant is NOT
in `priorRecipientKeys` (:258-259). Before this branch the same slot flagged
(base broadcastsRepo.ts:731 skipped only `skipped`). The same stranding keeps
the ledger entry at `pending` (never counted), so the pair leaves "Properties
sent" / "Sent to tenants" for good and the tenant pin reads "Property text
failed" once past the bound (contactTimeline.ts:728-737) - for a text that
arrived.

Why it is not the documented residue. The RUNBOOK's re-run triggers
(RUNBOOK.md:397) are all write-failure lines. A callback that never arrives
logs nothing, and the unknown-SID ERROR is not on the list, so nothing tells
the operator to re-run the repair; nothing else re-drives it (there is no
sweeper for a row stuck `queued`). The repair itself WOULD count the stuck row
as reached (a `queued` newest row decides `{kind:'sent'}`,
app/scripts/repair-share-outcomes.ts:562-565) - the live code and the repair
disagree about an accepted retry.

Implies. Low frequency (both a retry's `sent` and `delivered` receipts must be
lost, or the append must stall past the re-look), but the consequence is the
product's double text and it recurs silently after every deploy window.

Suggested fix (small, contained). In the retry job's record phase, when
`retried.broadcast_id` is a string, apply the new attempt's ACCEPTANCE to the
original slot exactly as the fan-out does for an original: 
`applyLaterAttemptBounded({ broadcastId, conversationId, retryRoot, attemptKey:
sent.tsMsgId, outcome: { kind: 'sent' } })` inside `guardWrite`. The D2 order
rule already makes a receipt that landed first win (a same-attempt bare
`sent` over a carrier-confirmed or delivered slot is refused or read as a
replay) and makes a later receipt move it on. Then a lost receipt errs to
"Sending"/reached, as an original does. Add the unknown-SID line to the
RUNBOOK trigger list either way.

### F2 [MEDIUM] "no matching recipient slot ... a routing bug" is reachable without a routing bug, and neither it nor the unknown-SID drop is on the RUNBOOK's re-run list - the retry outcome is lost to the slot with no operator trigger

What is wrong. The four no-slot lines (twilio.ts:3963-3965;
sendReconcile.ts:1512-1517, 1536-1541; retrySend.ts:834-837) say "a routing
bug", but `applyLaterAttempt` matches on `s.tsMsgId === retryRoot`
(shareAttemptOutcome.ts:228). A slot still `queued` has no `tsMsgId`, and that
state is legitimate: when the fan-out's record-phase slot write throws after
the provider send, the slot stays `queued` and the record goes to the
takeover reconcile (broadcastFanOut.ts:938-966, the "record" phase), which
adopts the row only later (broadcastFanOut.ts:1432-1444). A 30003 failure of
that original schedules a one-to-one retry meanwhile; that retry's receipts
answer `no_slot`, and when the adoption later lands the slot at the original's
`failed 30003`, nothing re-applies the retry. Same end state as F1. None of
the no-slot lines, and not the unknown-SID line (twilio.ts:3436), is in
RUNBOOK.md:397's list or its Logs Insights filter.

Implies. An ERROR that reads as a code defect (so it is triaged as one) is in
fact "re-run the repair", and the runbook never says so.

Suggested fix. Add the five lines to the RUNBOOK's re-run list and query;
reword the no-slot ERROR to name the benign cause ("slot not recorded yet, or
a routing bug - re-run the repair"). F1's fix does not cover this case (the
acceptance write would also answer `no_slot`).

### F3 [LOW] The list page keeps a stale `retry_pending` when a promise lapses silently - a finished share reads "Sending" until reload

What is wrong. The retry job's declines (conversation not retryable, window
closed, manual-retry superseded, own child present, deferral cap - e.g.
retrySend.ts:420-428, 491-520, 756-766) and a lost retry job end a chain with
no `broadcast.updated` emit: the promise just expires ("the retried row's
retry_due_at expires on RSW's clock", retrySend.ts:600-601). The list hook
keeps the last count when an event omits it and only refetches on a LATER
event of a finished share (dashboard/src/routes/broadcasts/useBroadcastsList.ts:208-231);
it has no ticker (only the results page does,
dashboard/src/routes/broadcasts/BroadcastResults.tsx:153-178). So a finished
share whose only non-failed signal was that promise keeps the "Sending" pill
(broadcastFormat.ts:114) on an open list indefinitely. A wrong label only; a
reload corrects it (the route recomputes, broadcasts.ts:944-947).

Suggested fix. Give the list the results page's 60 s visibility-gated tick:
refetch `?view=stats` for rows whose kept `retry_pending > 0`.

### F4 [LOW] The composer flag reads one send-attempt record per QUEUED slot of every finished share of the unit, on every preview, for 30 days - up to 1000 GetItems for a share that failed at enqueue, each answering "never claimed"

What is wrong. `resolveRecipientStates(..., { recordReads: true })` reads a
record for each queued slot of a share not `sending`
(shareRecipientState.ts:190-208), for 30 days (:124-128). A share the send
route marks failed after `markSending` has every slot `queued`
(app/src/routes/broadcasts.ts:818-826, 840-853) - up to the 1000 cap - and no
record was ever written, so every read answers null ("stranded"). The preview
pays that per composer open of the unit (8 in flight, :153). Cost/latency,
not correctness.

Suggested fix. Short-circuit: a share stored `failed` whose `last_error` is
the route's "enqueue failed" never claimed a record - classify its queued
slots `stranded` without reads.

### F5 [LOW] The retry job's unresolved-arm slot write is single-try and runs before its record close

What is wrong. `markShareUnconfirmed` calls the UNBOUNDED `applyLaterAttempt`
(retrySend.ts:825) inside `guardWrite`, while the webhook and both reconcile
sites use `applyLaterAttemptBounded` (three tries). One transient DynamoDB
fault leaves the slot `failed 30003` for a chain whose outcome is UNKNOWN (the
text may have gone out); past 24 minutes D1 reads it final (F1's mechanism).
It is on the RUNBOOK list (label `shareSlotUnconfirmed`), so this is the
documented residue class, but the asymmetry is gratuitous. Separately, it runs
BEFORE `closeFromReconcile`/`finish` (retrySend.ts:855-863, 919-925): when that
close is LOST, the slot already reads Not confirmed even if the record's owner
later proves `never_sent` and refuses the re-drive (closeSlot writes nothing
for `redrive_refused`, sendReconcile.ts:1438-1446) - safe side, wrong label.

Suggested fix. Use `applyLaterAttemptBounded` there too.

### F6 [LOW] Webhook emits and route stats disagree for a slot whose ROW says the chain ended unresolved; the list pill can flip to "Not sent" and stay

What is wrong. Only the routes pass `unconfirmedKeys`
(broadcasts.ts:251-256); every emit derives without it (twilio.ts:4067, 4116;
shareAttemptOutcome.ts:206-210; broadcastFanOut.ts:228). On the list, an
emit for that share replaces the row's stats (useBroadcastsList.ts:208-219)
and refetches only when a kept `retry_pending > 0` (:229), so a row-unconfirmed
recipient moves from "Not confirmed" back to "failed" and the pill can read
"Not sent" until reload. Reachable only for residue (a slot write that failed
at an unresolved arm, or pre-repair history). Wrong label.

### F7 [LOW] Tabs contradict pills

The filter tabs list by STORED status (BroadcastsList.tsx:20-26) while the
pill derives from buckets for stored `sent` and `failed`
(broadcastFormat.ts:112-117): the "Failed" tab can hold "Sent" pills (a retry
that delivered after finalize flipped the share `failed`,
broadcastFanOut.ts:1569-1573), the "Sent" tab "Not sent" pills, and a finished
share reading "Sending" is not under the "Sending" tab. The code calls it
presentation-only; the operator sees a contradiction.

### F8 [LOW] Repair cost: every slot re-reads its thread from the original to the newest row, with no per-conversation reuse

`rebuildChain` pages `listByConversation` 100 at a time until it passes O
(repair-share-outcomes.ts:496-505), per slot; a tenant in K shares has the
same thread read K times, and a long-lived thread is paged in full each time.
The RUNBOOK's "On prod expect minutes, not seconds" (RUNBOOK.md:399) is an
unmeasured estimate. Cache the collected rows per conversation for the run.

### F9 [LOW] Maintainability: "the ONE copy" constants are not the one copy

`RETRIED_ERROR_CODE` claims to be the one copy (app/src/lib/retrySendWindow.ts:36-43),
but the retry DECISION still keys on the literal `'30003'`
(twilio.ts:3470, also :371, :389, :3606): change one and D1 / the ledger
stop agreeing with the decision. `STALE_RECONCILING_MS` hard-indexes
`RECONCILE_CHECK_DELAYS_MS[2]` (repair-share-outcomes.ts:163) while the
service uses the last element (shareRecipientState.ts:43-44).

### F10 [LOW] The 1500 -> 1000 cap is an operator-visible change with no release note

A filter blast of 1001-1500 tenants that sent before the deploy is now
refused `audience_too_large` (broadcasts.ts:759-766, 802-811) and the preview
slices candidates at 1000 (:606). The only mention outside code is inside the
repair section (RUNBOOK.md:393, "the recipient cap fell from 1500 to
1000"); the README deviation row (README.md:45) covers only the sparse index.

## 3. What I checked and found sound

- DynamoDB expressions: `putShareMemory` binds `:sentAt`/`:bid`/`:tok` only when
  used, always uses `#sentAt`/`#bid` in SET or REMOVE, and emits REMOVE only
  when non-empty (listingSendsRepo.ts:210-263); `applyAttemptOutcome` uses
  `#la`/`#status` in both condition branches, `:pa` only when named, ADD only
  for non-zero buckets (broadcastsRepo.ts:955-988); `stampRetryAttribution`
  two aliases, two values, existence-conditioned (messagesRepo.ts:3442-3466);
  the `getByIds` projection aliases `status` (broadcastsRepo.ts:995-998); the
  repair's Scan filter alias is used (repair-share-outcomes.ts:469-477). No
  unsatisfiable condition found.
- IAM grants `dynamodb:BatchGetItem` (infra/modules/ec2/main.tf:53);
  `gen-tables` emits no `sparse` (app/src/lib/tables.ts:48-53 is doc-only), so
  no Terraform drift; all GSIs project ALL (tables.ts:14), so the byUnit and
  byCreated items carry `recipients`/`updated_at` for D1.
- Every reader of a listing-send row filters through `isListed`, so
  `toListingSendRow`'s new throw is unreachable (contacts.ts:1168-1188,
  units.ts:954-989); the seeds' milestone guard is consistent
  (lib/seed/history.ts:1001-1004). No caller of `recordSend` or
  `priorRecipientContactIds` remains (grep of app, dashboard, e2e, scripts).
- Races on the order rule: an early failure receipt vs the fan-out's later
  acceptance entry (the same attempt only moves forward, shareLedger.ts:78-90);
  the reconcile's found arm vs the webhook (replay detection,
  shareAttemptOutcome.ts:236-240, 251-256, and the no-promise ledger skip,
  :199); a row-less marker vs a later found row (`~` sorts after the SID,
  a later attempt's ISO wins); the ledger's token CAS on a legacy row
  (`attribute_not_exists(shares_op)`, listingSendsRepo.ts:250-253).
- The message state machine forbids failed -> delivered
  (messagesRepo.ts:134-143), so D2's "older attempt applies as a delivery" arm
  is reachable only from the repair; the original rollup's unconditioned
  `{...slot}` spread (twilio.ts:4080-4089) cannot clobber a `latestAttempt`
  because a later attempt exists only after the original is terminal.
- The Retry route refuses a press on a row that already has a child
  (api.ts:1653-1657) and on an unresolved chain (:1685-1691), so the results
  page's "open conversation to retry" hint cannot lead to a manual double.
- PII: every new log line carries ids/counts; slot keys go through
  `safeRecipientKey` (shareAttemptOutcome.ts:226-261, shareRecipientState.ts:203-206,
  sendReconcile.ts:1536-1541); the pair key never holds a phone
  (`pairContactId`, shareAttemptOutcome.ts:161-163).
- The repair: a dry run performs no write (stamps, slot moves and the ledger
  step all short-circuit on `!apply`, repair-share-outcomes.ts:709-712,
  739-741, 797); dev/prod resolve through the pre-existing account guard
  (app/scripts/lib/stageClient.ts:112-154); every write is conditional; every
  read is paged or keyed; the messages table has no stream consumer, so the
  stamps trigger nothing downstream.
- Known and documented, not re-reported: the deploy -> apply exposure window
  (RUNBOOK.md:372) and stored status vs derived label
  (broadcastFormat.ts:92-107).
