# Retry-send adoption (Stage 1b) - design review round 3, reviewer B (adversarial)

Spec under review: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`,
REVISION 3 (commit 687e53bd), read cold against main@3dbb5740 in
`W:\tmp\retry-send-adoption`. Round-2 adjudications: `adjudications.md`
("Spec round 2"). Read-only: no tests, nothing staged. Every claim about
existing code cites a file:line I read; anything not verified is marked
UNVERIFIED.

The interleavings the coordinator asked for are walked against the NEW key
(retried row + attempt) and the NEW step order (R2 steps 1-5). New defects
come first; contests are marked CONTEST with the round-2 finding number.

---

## 1. [HIGH] CONTEST r2#6 / r2#3: step 4 runs the manual-supersession check (4a) and the window check (4b) ONLY when no record exists, so every deferral re-run and every re-drive skips both

**What is wrong.** R2 step 4 reads the record first, and only "If the record
is ABSENT" does it run 4a (a manual retry supersedes the chain) and 4b (RSW
D4's strict window check). For a record that exists:

- `reconciling`, `redriven` or `done` -> "the claim rules below decide (a
  `redriven` record is this job's re-drive and proceeds to step 5; every other
  state returns at INFO)".

The two entries of the job that continue an existing attempt ALWAYS find a
record:

- **The deferral re-run** (payload `deferred: true`) finds `done`/`retryable`,
  written by R3's deferral arm.
- **The re-drive** finds `redriven`, written by R4's `never_sent`.

Consequences, read literally:

- **Deferral re-runs and re-drives send past the 15-minute window.** RSW
  section 5 requirement 1: "a retry it re-drives later - a relay rung, or the
  one-to-one rung it re-enqueues once - runs the same job handler, so D4's
  job-time check bounds it" (RSW spec lines 619-621). The deferral was
  scheduled with `retryFitsSendWindow`'s 60 s grace, and the re-drive with
  `backoffMs: 0` plus the same grace. A re-run delayed more than 60 s past its
  `runAt` - a worker backlog, or SQS redelivery after a throw in steps 1-3 -
  reaches step 5 with no strict check and can send more than 15 minutes after
  the original. That is RSW's one invariant.
- **Double text after a manual press.** A manual press made while a deferral
  wait's refresh was lost, or after it expired because the re-run is late,
  passes the route: R6 does not block `done`/`retryable`, and test 15 expects
  200. The re-run then skips 4a, claims `done`/`retryable` and sends. The same
  applies to a re-drive after a manual press made while the attempt was
  `reconciling` past R6's bound (see finding 5). These are exactly the late-job
  and deferral gaps round 2's finding 3 was accepted to close.
- **Internal contradiction.** R4 and test 4c say "a re-driven job that
  declines BEFORE its claim (step 4b ... or step 4a ...) closes its `redriven`
  record" - which step 4's ABSENT-only structure never reaches.
- **The parenthetical kills every deferral.** "Every other state returns at
  INFO" includes `done`/`retryable`, so a literal build ends every deferral
  re-run at INFO. Step 5 ("claimed (from absent, `done/retryable` or
  `redriven`)") and test 4 contradict it.

**RSW #6** ("a decline never holds a claim") is not reopened, but only because
the window check is SKIPPED for these entries rather than moved after the
claim. The fix must keep 4a/4b BEFORE the claim for every entry that would
proceed to a claim:

- A `redriven` record that declines closes `refused` (`closeRedriven`,
  `sendAttemptsRepo.ts:577-584`, as R4 intends).
- A `done`/`retryable` record that declines stays claimable, because no
  transition leaves `done`/`retryable` except a claim
  (`sendAttemptsRepo.ts:428-433`). That is safe only because every later entry
  re-runs 4a/4b. State it.

Two further details of the same ordering:

- The designed declines in steps 1 and 3 (the row gone or not outbound; a
  conversation that is not a one-to-one thread) also return before step 4. A
  `redriven` record met there is never closed, and a stale `attempting` record
  is never taken over. Both are rare, and R6's bounds keep them from blocking.
- A redelivered PRE-deferral envelope (a DeleteMessage failure; no `deferred`
  flag) finds `done`/`retryable`, claims it ahead of the scheduled re-run, and
  can take a SECOND deferral. The claim still prevents a double send, but the
  "single deferral" is two.

---

## 2. [MEDIUM] CONTEST r2#3 / r2#4: R6 and step 4a look only at the pressed or retried row itself; a press on an EARLIER row of the chain bypasses both, and the named residual is the wrong case

**What is wrong.**

- **R6 reads only the pressed row's records**
  (`retry#<conv>#<pressedRow.tsMsgId>#1..3`) and that row's own
  `retry_outcome`.
- **Step 4a looks only for a manual row with `retry_of === retriedTsMsgId`.**

So a press on an earlier, SUPERSEDED row of the same chain is invisible to both.
The live Timeline hides superseded rows (`dashboard/src/routes/contact/Timeline.tsx:2062-2075`),
but a tab whose SSE stream dropped, or a direct API call, still presents one.
Walk the root O while attempt 2, retried against R1, is pending or has closed
`unresolved`:

- The route reads O's records: (O, 1) is `done`/`sent` - not blocking. O's
  promise expired long ago. `retry_outcome` sits on R1, not O. The press is
  allowed, and a manual row M with `retry_of = O` is sent.
- If attempt 2 is pending, its job's 4a looks for `retry_of === R1`, does not
  see M, and sends: a double text.
- If attempt 2 closed `unresolved`, Cameron's Q1 ("NO Retry" while the retry's
  fate is unknown) is bypassed. R6's "enforced by the record, for good" holds
  only on the chain's tail.

Round 2's index lookup covered this case (for 30 minutes). Revision 3's
per-row key read dropped it.

R6's list of what "stays open by construction" names the wrong cases:

- **"The STALE-TAB press RSW already names (a tab that rendered Retry before the
  promise was written)" cannot happen.** RSW D7 writes the failure and
  `retry_due_at` in ONE conditional write, so "the screen never sees the
  failure without its decision" (RSW spec lines 293-300).
- **The real stale-tab gap is unnamed:** `manual-retry-double-send-residual-windows`
  gap 2, a tab that rendered BEFORE the row was superseded.
- **"A manual press and the job's claim inside the same instant" is wider than
  an instant.** The route reads the records, then spends the whole provider
  round trip (up to the 30 s timeout) before M's row is appended. A 4a read
  anywhere in that span misses M.

**What it implies.** One cheap guard closes most of this: the route refuses a
press on a row that is ALREADY SUPERSEDED (some row carries
`retry_of === pressed.tsMsgId`, from the same newest-first consistent read 4a
uses). That covers issue gap 2, the earlier-row bypass of Q1, and most of
manual-vs-manual. The remaining race is the route's own send latency, named
honestly.

---

## 3. [LOW] The lineage exclusion treats every record under the same root as a predecessor, but a manual-retry chain can run beside the original chain

**What is wrong.** R4: a sibling is lineage when it is "a `retry_send` owner
whose `retryRoot` fact equals this owner's". The soundness argument is: "A
predecessor's adoption happened before this attempt began." Revision 3
deliberately lets a manual Retry start a second chain under the same root
(section 0; R1), so equal roots no longer mean predecessor.

Interleaving:

1. Original attempt N (retried row R) goes unknown, then `reconciling`.
2. Its checks are delayed by throws (SQS redelivery after 120 s each,
   `app/src/adapters/sqsJobConsumer.ts:11-17`), past R6's `reconciling` bound
   (360 s) and the refreshed promise (+480 s).
3. Staff press Retry on R. M is sent and fails 30003, and M's chain attempt 1
   goes unknown with no row.
4. Both chains now reconcile concurrently with the same fingerprint (M resends
   R's body) and the same root. Each excludes the other as "lineage", so SOR's
   protection - "the message we would have found may be the one the other
   attempt claimed" (SOR D13) - is lost. N can adopt M-chain's orphan as its own.
   M-chain then rules `never_sent` and re-drives: an extra text.

Rare (it needs delayed checks and a press after the promise).

**What it implies.** Restrict the lineage to what the argument covers: a
same-root record is lineage only when it is `done`, or has a known SID (a
predecessor's known-SID reconcile claims only its own SID). An OPEN, SID-less
same-root record is a concurrent chain and keeps SOR's rule.

## 4. [LOW] Step 4a's "bounded to the rows after the retried row" has no API behind it

`listByConversationConsistent` takes only `limit` (default 50) and `before`, an
exclusive UPPER bound. It returns ONE newest-first page, with no lower bound
and no `LastEvaluatedKey` loop (`app/src/repos/messagesRepo.ts:1275-1279`,
`:2234-2255`, `:2008`). More than 50 rows since the retried row (a busy thread,
or a relay-free contact with inbound chatter) pushes a manual row off the page,
4a misses it, and the job double-sends. The build needs a paging loop that stops
at the retried row's `tsMsgId`. The spec should say so.

## 5. [LOW] R6's `reconciling` bound is shorter than the reconcile's own retry budget

R6 stops blocking a `reconciling` record after `delays[2] + GRACE` (240 s +
120 s). A check that throws is redelivered after the 120 s visibility timeout,
up to five times (`sqsJobConsumer.ts:11-17`; SOR D11), so a legitimately
pending reconcile can still adopt or re-drive well after 360 s. The refreshed
promise (+480 s) covers part of that; after it, a press is allowed while the
verdict is pending. If the verdict is "adopt", the tenant already has the retry
and now also M. Either bound `reconciling` by the check schedule plus the
redelivery budget, or name the residue.

## 6. [LOW] The recipient key: "immutable row data" is partly conversation data; carrying it puts a phone in the job payload; the reconcile's raw-key recovery is unstated

- **The `phone#` key comes from `conversation.participant_phone`, not the row.**
  It is stable only because a one-to-one conversation is found and created by
  its participant phone (`app/src/repos/conversationsRepo.ts:1259-1269`) and no
  writer changes it for a live one-to-one thread. The import sets it at
  creation (`app/src/lib/import/apply.ts:1130-1134`). State that dependency.
  Under it, the "changed participant phone -> `digest_mismatch`" case in R4 is
  unreachable.
- **`RetrySendPayload.recipientKey` carries a raw `phone#<E164>`** whenever the
  retried row has no `recipient_contact_id`. The job's own contract is "the
  payload carries IDs only" (`retrySend.ts:7-8`), and SOR D12 says "never a
  body or a recipient phone". There is a precedent - SOR's continuation
  payloads carry raw keys, "plan deviation 4" (`sendReconcile.ts:1072-1075`) -
  but the carriage is REDUNDANT here: R1 itself says a redelivery re-derives
  the same value from immutable data. Drop it, or carry the hash.
- **R4's "the recipient key is the OWNER's (never re-derived)" has no
  mechanism.** The reconcile ref carries only `recipientKeyHash`, and every
  repo transition hashes a RAW key (`sendAttemptsRepo.ts:176-181`). Say that
  Resolve rebuilds it by R1's derivation from the retried row and the
  conversation, and checks it against the hash. Or read the single record by a
  Query on its partition, whose key excludes the recipient.

## 7. [LOW] Smaller defects in revision 3

- **Section 0's "one hop reaches the root" is false for pre-deploy attempt-2/3
  rows.** RSW D2: "`retry_of` points only at the previous attempt". One hop from
  R2 reaches R1. The exposure is chains straddling the deploy (15 minutes).
- **Branch B's "the attempt record keys on the chain root" is dropped without a
  recorded ruling.** The coordinator's round-2 brief named it as part of the
  product owner's requirement. Revision 3 reverses it; the adjudication records
  the reason but not Cameron's consent. R10 should say B finds a root's
  attempts via `listByRecipient` plus an `owner.retryRoot` filter, within a
  window.
- **R2 step 8's "a lost fence leaves the record `attempting`" is wrong for a
  lost fence.** A `false` from `finishAttempt` means the attempt was taken over
  - the record is `reconciling`, and its reconcile repairs it. Only a THROWN
  write (the `guardWrite` ERROR) leaves `attempting`.
- **Test 16 pins a dashboard "copy of the withdrawn sentinel" in
  `retryPromise.ts` that does not exist and is not needed.** The epoch already
  reads as expired (`dashboard/src/routes/contact/retryPromise.ts:24-34`). The
  values the dashboard actually keys on are `'unconfirmed'` and
  `'retry_unresolved'`.

---

## Interleavings the coordinator asked for (against the new key and order)

| Interleaving | Result |
|---|---|
| Crash redelivery BEFORE the claim | Steps 1-4 re-run, find no record, then 4a/4b, then the claim. Correct. |
| Crash redelivery AFTER the claim | Step 3 re-derives the same key (immutable data, finding 6); step 4 takes over a stale `attempting` record regardless of the window. Correct - round 2's finding 6 is fixed for this entry. |
| Deferral re-run vs a manual press | Correct while the refresh stands (RSW 409). With the refresh lost or the re-run late, the route answers 200 on `done`/`retryable` and the re-run skips 4a: a double text (finding 1). |
| Re-drive of an attempt whose retried row was since manually retried | The re-driven job finds `redriven`, skips 4a per step 4's structure, and sends: a double text (finding 1). R4 and test 4c say otherwise. |
| Two chains under one root: records | Disjoint (per-retried-row key). Round 2's finding 1 is fixed. |
| Two chains under one root: siblings | Mutually excluded as "lineage" even when concurrent (finding 3). |
| Two chains under one root: `retry_outcome` | Written on each chain's own retried row. They do not collide; an original-chain WITHDRAW lands on a row the manual chain has hidden. Harmless. |
| Immutable key with no `recipient_contact_id` AND a changed participant phone | Would fork the key (a redelivery claims a different, absent record and can double-send), but no writer changes a live one-to-one thread's participant phone. State the dependency (finding 6). |
| Step 4 vs RSW #6 | #6 holds (no decline holds a claim), but RSW #1/D4 is lost for deferral re-runs and re-drives (finding 1). |

## Contested round-2 rulings (summary)

- **r2#6** (existing attempt before the window): it fixed the crash takeover but
  moved 4a/4b behind an ABSENT-only gate - finding 1.
- **r2#3** (the job's half via 4a): it does not run for deferral re-runs or
  re-drives (finding 1), and it cannot see a press on an earlier row (finding 2).
- **r2#4** (Q1 "for good"): it holds for the chain's tail only (finding 2).

## Checked and holding

- **r2#1** - the per-retried-row key removes the cross-chain record collision.
  Test 4b pins it.
- **r2#2** - the key is stable across re-entries under the one-to-one
  participant-phone invariant (finding 6 notes).
- **r2#5** - terminal deferrals close `done`/`refused`, which the claim refuses
  (`sendAttemptsRepo.ts:445`).
- **r2#7** - the `enqueue_failed` split is consistent across R3, R4, `slotCloseOf`
  and R6.
- **r2#8** - designed declines at WARN, apart from the step-4 ordering noted in
  finding 1.
- **r2#9** - the dispatch-site list matches the code at 3dbb5740.
- **r2#10** - the router is correctly `twilio.ts:3529`.
- **r2#11** - one media function.
- **r2#12** - `finishAttempt(unresolved)` from `attempting`, the parser carries
  `deferred`, the scoped test 19, and tests 6a-6d replacing the marker pins.
