# Adversarial review, round 2 (blind) - fix wave FW2, 95edb0b6..56f1d757

Scope: `git diff 95edb0b6..56f1d757 -- . ':(exclude)docs'` - commits 1058d8da
(the job's step-4a own-row decline), 675a9100 (`ownRetryRow` as the first step
of the reconcile's `lookup` for a retry_send owner), 56f1d757 (the rendered
ASCII assertion) - plus a fresh sweep of the code around them. Plan-blind,
read-only, nothing executed (a gate e2e was running). Line numbers are the
worktree at 56f1d757.

Verdict in one line: the two own-row belts are CORRECT, not merely plausible -
I could not build an interleaving in which either adopts or declines on a row
that is not this attempt's text, strands a record, or double-closes one. What
is left is one contest I still hold (round 1's finding 2 has an option that
stays inside the fence), one weak contest (finding 5), and three LOWs, two of
them in the fix itself.

---

## 1. What did we all miss? (fresh sweep of the changed code)

### 1.1 [LOW] The job still never checks the payload's attempt against the retried row; the narrowed carve-out now sends beside an automatic retry of the same row, and a new test pins it

What is wrong. The whole FW2 argument rests on one invariant: a retried row has
exactly one automatic attempt number, `(row.retry_attempt ?? 0) + 1`
(services/oneToOneRetryDecision.ts:125-129; the route uses the same arithmetic,
routes/api.ts:1655). No code enforces it where the job runs.
`parseRetrySendPayload` accepts any attempt from 1 to MAX
(jobs/retrySend.ts:132-155), and the job never compares `payload.attempt` with
`retried.retry_attempt`. Step 4a now declines only on a child carrying
`payload.attempt` (retrySend.ts:469-477). An automatic child with ANY other
number is ignored (retrySend.ts:468 comment, 478-482), and the job goes on to
claim a record keyed on (row, payload.attempt) (sendAttemptsRepo.ts:177-179). That
record is a different record from the one the existing child's attempt used,
so the claim cannot dedupe against it.

Test 4c2 sub-case (4) (app/test/retrySendAttempt.test.ts, the "automatic child
of ANOTHER attempt number ... claims and sends once" block) seeds a row with no
retry_attempt, gives it an automatic child with attempt 2, runs attempt 1 and
asserts one provider call. In words: a second automatic retry of a row that
already has one is the pinned, intended behavior.

Reachability: no current producer builds a mismatched attempt. The webhook, the
deferral (retrySend.ts:748-751) and the re-drive (sendReconcile.ts:1552-1564)
all carry a consistent attempt, so the state is unreachable today. The state
can only arise from a producer bug, and in that case the carve-out is exactly
the path that turns the bug into a double text.

Fix (small): in step 4a, decline on ANY automatic child (every automatic child
of this row is a sent retry of it), or refuse a payload whose attempt is not
`(retried.retry_attempt ?? 0) + 1` before the gate. Flip sub-case (4).

### 1.2 [LOW] The already_sent decline records `refused` for an attempt whose text exists

What is wrong. For a `redriven` record the job's decline calls
`closeRedriven(owner, { outcome: 'refused', cause: 'already_sent' })`
(retrySend.ts:471 -> declineBeforeClaim, retrySend.ts:703-708;
sendAttemptsRepo.ts:615-621). `closeRedriven`'s outcome union has no sent-like
member (sendAttemptsRepo.ts:159-162) and it takes no sid. The attempt's text
DID go out: the child row exists and carries the SID, which the WARN logs as
`childProviderSid`. So the record now says "refused, no sid" about a delivered
retry.

Today no reader is misled, and I checked each one:
- The route answers 409 superseded before it reads the record
  (api.ts:1638-1642).
- `slotCloseOf('refused')` is undefined (sendReconcile.ts:1315-1326).
- The sibling rule treats `refused` like `sent` (sendReconcile.ts:1296), and the
  child's SID is held by its own row, so heldBy skips it anyway.
- Nothing reads `record.cause`. A grep for `.cause` over app/src finds only the
  writers in sendAttemptsRepo.ts and the job's log line, and the dashboard
  reads no records.

The cost comes later: a sweeper, a report, or Branch B reading outcomes would
count a delivered retry as refused and find no SID on it.

Fix (small): record the truth. Give closeRedriven an `adopted` outcome that
carries the child's `providerSid`, or add a sibling write for this one case.

### 1.3 Swept and holding (fresh eyes)

- Anomaly branch consistency: when a pointer exists but its row cannot be read,
  the reconcile WARNs and goes on (sendReconcile.ts:1112-1120), which can end
  in never_sent, a re-drive and a promise refresh. The job, on the same bare
  pointer, declines already_sent. The net result is safe: the re-drive is a
  no-op close. The state is unreachable in app code, because no path deletes
  message rows; every DeleteCommand in messagesRepo.ts targets a pointer or
  bookkeeping partition. Holds.
- No new enqueue, so MAX_HOP_COUNT is unchanged.
- The WARN lines carry ids only: tsMsgId, SID, the owner and the redacted key.
- No reader of `already_sent` exists outside logs and the test.
- The e2e lane is unaffected. Item 17's unknown send appends no row, so check 0
  finds no pointer and the list path adopts as before.
- A stale `attempting` record that already has its own row, left behind when
  finishAttempt throws after the send (retrySend.ts:579-595), is now resolved
  properly on any later delivery. The gate takes it over, and ownRetryRow
  answers found at check 0. FW2 improves that residual as a side effect.

---

## 2. The fix diff, walked

### 2.1 ownRetryRow ahead of the sender and digest checks (sendReconcile.ts:1110-1150; lookup at 1139)

Can it adopt a row that is NOT this attempt's?
- **Replayed check for an older attemptedAt.** No. `lookup` runs only after
  runCheck has proven the record is `reconciling` with this payload's
  attemptedAt (sendReconcile.ts:517-534), and after recordCheck.
  - A record re-claimed from `redriven` or `retryable` gets a fresh attemptedAt
    (sendAttemptsRepo.ts:294-296), so an old chain always takes the superseded
    exit.
- **Forked chain.** No.
  - A manual child carries no retryAttempt and never matches.
  - A manual row's own automatic chain lives in its own partition
    (retrychild#conv#M).
  - An adopted row always carries the owner's attempt, since adoptRetry appends
    `retryAttempt: o.attempt` (sendReconcile.ts:899).
  - Two automatic children with the owner's number exist only after a double
    send has already happened (the in-flight residual in 2.3). Either child is
    this attempt's text, and `found` then prevents a third.
- **Different recipient key.** Harmless. Two records for one (row, attempt)
  would need the key derivation to change between runs, and that derivation
  comes from immutable data plus the thread phone (retryChain.ts:48-55).
  - If it did happen, both records would find the same own row. That answer is
    right: the question is whether this attempt's text exists, not which number
    it went to.
  - FW2's job side now also stops a second-key run from sending at all, because
    its step 4a sees the child.
- **Ahead of no_sender and digest.** Correct. Those checks guard the PROVIDER
  list, which is scoped by number and sender. The pointer is local and scoped
  to (conversation, retried row, attempt), so neither check says anything about
  it.
  - Placing it first removes the round-1 hazard that a no_sender or digest
    close would WITHDRAW beside an existing row.
- **Found shape.** `{ found, sid: row.provider_sid, adoption: 'skipped',
  status: row.delivery_status, path: 'lookup' }` feeds runCheck's found arm
  (sendReconcile.ts:541-558).
  - That arm writes `closeFromReconcile(adopted, sid)`.
  - afterClose re-renders the retried row. There is no promise write and no
    append. provider_sid is a required string (messagesRepo.ts:1031).
  - An own row whose status is failed (the retry itself hit a 30003) is still
    `found`. That is right: the webhook already ran the next rung's decision
    for that row.
- **Can it lose a send?** No. An own child row exists only after a provider
  acceptance (sendMessage appends after the call, sendMessage.ts:630-698) or
  after an adoption of a provider-held message. `found` is never a claim that
  something was sent when it was not.

### 2.2 Step 4a's own-row decline (retrySend.ts:456-477)

- **Placement.** The decline sits after the gate. Attempting and reconciling
  records defer, stale ones are taken over into reconcile (and ownRetryRow then
  answers found), and terminal ones skip. So it sees only absent, done/retryable
  and redriven records, and all three are safe:
  - Absent and done/retryable write nothing. Both are unreachable with an own
    child: the first needs a claim that never happened, and a retryable release
    happens only when nothing was sent.
  - Redriven closes once through a conditional `closeRedriven`
    (`#st = :redriven`), so it cannot double-close.
  - A throwing close fails the delivery, and the redelivery re-runs the
    idempotent decline.
  - If a concurrent pass re-claimed the record, the close is false and logged
    at INFO. That pass runs the same step 4a.
- **No strand.** The chain is over, the promise the reconcile refreshed covers
  a retried row the collapse hides (it now has a child), and the route answers
  superseded.
- **Order.** Own row before manual supersession: with both present the cause
  reads already_sent, which is harmless.

### 2.3 What remains (named in the handback, and confirmed here)

The only own-row double text left is an append by the first run that lands
AFTER the re-driven run's step-4a Query, i.e. a provider call still in flight
more than about 240 s after its re-arm. Both belts cover every append that
lands earlier. Nothing cheaper exists: the call cannot be recalled.

### 2.4 Are the new tests red without the fix, for the right reason?

- **4c2 sub-cases (1)-(3)**: without the decline the job claims and calls the
  provider, so `calls not called` goes red. That is the right reason.
  Sub-case (4) passes either way (see 1.1).
- **Reconcile "FW2 A1"**: without ownRetryRow the lookup calls the provider
  list, so `list not called` goes red, and the chain then re-drives, so `got`
  is non-empty. Right reason.
  - The child is seeded as a row and never as a provider message, so the
    "outside the window" wording in the helper is not what the test exercises.
  - What it pins is that the pointer is consulted before any list call, which
    is the property that matters.
- **Reconcile "own-row proof wins"**: the three cases were provider_unreachable,
  no_sender and digest_mismatch, all unresolved before the fix. They now go red
  on unresolved and WITHDRAW. Right reason.
- **Control and anomaly**: these are regression guards, green either way,
  except the anomaly's new WARN.
- **Dashboard**: `alert.textContent` is the rendered alert, so appending a
  non-ASCII character to the production copy turns it red. It is no longer
  vacuous.

---

## 3. The rulings, contested where I still can

### 3.1 [MEDIUM] Round 1 finding 2 "deferred to the human (a fence decision)": the fence is not the only way out

Contest. The deferral treats the fix as "edit twilio.ts or not". But the
rollup reacts to exactly one field, `message.broadcast_id`
(routes/webhooks/twilio.ts:3529), and this branch chose to put the share stamp
on retry rows in that same field. It does so from three writers:
- the job (retrySend.ts:544),
- the adoption (sendReconcile.ts:902),
- the route (api.ts:1769).

The branch's own readers of the stamp on retry rows are all inside the
branch:
- predecessorMatchers (sendReconcile.ts:1090), which could read the root's
  broadcast_id via retry_root instead;
- rowHolder (sendReconcile.ts:788);
- the new `retry_of` guard in isBroadcastRowFor (broadcastFanOut.ts:1303),
  which exists ONLY because of the stamp.

Carrying the attribution under a field the fenced webhook does not read (or
reading it through retry_root) keeps twilio.ts untouched. It removes every
cost in finding 2:
- the 2.5 s sleep and two broadcast reads per share-retry callback
  (twilio.ts:322, 3887-3906);
- the next rung's enqueue held behind the sleep (twilio.ts:3622-3631 after
  3531);
- the need for the INFO downgrade at twilio.ts:3904;
- the isBroadcastRowFor exception.

Branch B can read whichever field it is given. Until this is decided, every
share-retry receipt in prod pays the sleep, starting at merge.

If Cameron's ruling was specifically "retry rows carry broadcast_id", the
ruling stands and this is a cost to show him, not a defect. Otherwise the
branch can fix it now without crossing the fence.

### 3.2 [LOW] Round 1 finding 5 "filed rather than fixed": a weak contest

The wrong root is written at append and never updated. It also PROPAGATES:
`resolveRetryRoot` returns a stored retry_root at hop 0 (retryChain.ts:26), so
every later row of the new chain inherits it. And the manual route computes a
root for a legacy pressed row of ANY age (api.ts:1654, 1768), not just rows
inside the 15-minute window.

The population is small (legacy chains deeper than three rows through a manual
retry). But each wrong value is permanent and costs a backfill later, against a
one-constant fix now. I would fix it before merge. If it stays filed, the issue
should say that the defect writes durable data.

### 3.3 Round 1 finding 6 "recorded as a note": no contest

It is a divergence risk with a safe failure direction (never a re-send), not a
live defect.

---

## 4. Are the fixes correct, or merely plausible?

- **Correct.** Both sides key on a fact only this attempt can produce: a child
  of this retried row carrying this attempt number, read from a
  strongly-consistent pointer written in the row's own transaction.
  - The reconcile answers from the row and writes nothing new.
  - The job declines before any claim, through the same idempotent decline path
    the manual and window declines use.
  - Neither can create a send, lose one, strand a record, or double-close one.
    The one remaining double-text path is the named in-flight residual (2.3).
- **The dashboard test fix is correct.**
- **The two LOWs in section 1 are hardening**, not reasons to reopen the fix
  wave. Of the two, 1.1 has the better cost-benefit ratio (one predicate and
  one flipped sub-case).
