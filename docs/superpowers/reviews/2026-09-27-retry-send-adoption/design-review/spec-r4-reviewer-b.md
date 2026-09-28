# Retry-send adoption (Stage 1b) - design review round 4 (final), reviewer B

Spec under review: `docs/superpowers/specs/2026-09-27-retry-send-adoption-design.md`,
REVISION 4 (commit 8d072260). I reviewed the deltas from revision 3
(`git diff 687e53bd 8d072260`) cold, against main@3dbb5740 in
`W:\tmp\retry-send-adoption`. Round-3 adjudications: `adjudications.md`
("Spec round 3"). Read-only: no tests, nothing staged.

Per the brief, only findings that would change what gets built, a surface or
an invariant are listed. Precision and wording are labelled LOW.

---

## 1. [MEDIUM] CONTEST r3#3: the ancestry rule counts a MANUAL row's parent attempt as its producer, so a manual-retry chain again drops the original chain's protection

**What is wrong.** R4 now defines lineage like this:

- The predecessor rows are the `retry_of` path from the retried row up to the
  root.
- A sibling record is lineage when it is "a `retry_send` owner whose
  `retriedTsMsgId` is one of those rows' `retry_of` targets (i.e. the attempt
  that PRODUCED a predecessor row)".

For an automatic row that holds: R_k's `retry_of` is R_(k-1), and the attempt
that retried R_(k-1) produced R_k. It does not hold for a MANUAL row:

- The manual route produced M.
- M's `retry_of` names the row that was pressed, R.
- The rule therefore treats the attempt that retried R - the ORIGINAL chain's
  attempt N - as M's producer.

This is the concurrent case round 3 finding 3 was accepted to keep apart.
M-chain attempt 1 (retried row M) walks the rows [M, R, ...] and excludes the
record (R, N) as "lineage".

Interleaving, from round 3:

1. Attempt N (retried R) is `reconciling`.
2. Staff send M after the promise and the record bound have passed.
3. M fails 30003, and M-chain attempt 1 goes unknown too.
4. Suppose only M-chain's text X actually went out. N's lookup claims X (a
   free, matching candidate) and adopts it.
5. M-chain's lookup then finds X held by N (`other`), and N's open-or-adopted,
   same-fingerprint record is excluded as "lineage". It rules `never_sent` and
   RE-DRIVES, sending a second copy of a text the tenant already received.

Test 13's new clause ("a MANUAL-retry chain under the same root reconciling at
the same time still blocks") passes only if it is written from N's side.

**Fix.** Identify the producer exactly: a sibling is a predecessor's when
`owner.retriedTsMsgId === row.retry_of` AND `owner.attempt === row.retry_attempt`.
A manual row has no `retry_attempt`, so it matches nothing, and the walk stops
at the first row without one. This is a one-line predicate change, but it is
the invariant round 3 accepted.

## 2. [MEDIUM] The route's `superseded` scan has no time bound: a press on an old failed bubble pages through the whole thread since

**What is wrong.** R6 finds later rows by paging `listByConversationConsistent`
newest-first "bounded at the pressed row". Step 4a's identical scan is cheap
only because its retried row is at most about 15 minutes old. The ROUTE's
pressed row can be any failed bubble: the Timeline offers Retry on every failed
outbound bubble without a live promise (`dashboard/src/routes/contact/Timeline.tsx:1426`),
and staff do retry old texts.

A press on a message from last month walks every row after it, 50 per
consistent Query (`app/src/repos/messagesRepo.ts:2008`, `:2234-2255`). That is
tens of round trips on a busy thread, on the rate-limited interactive path.

The "chain's NEWEST row" forward walk is also dead weight. Any row with
`retry_of === pressed.tsMsgId` already means 409 `superseded`, so the route
only ever proceeds on the pressed row itself.

**Fix.** Decide the lookup, either:

- an O(1) `retry_of` pointer item written in the append transaction beside
  `sid#` (the same pointer family). Step 4a would use it too; or
- a stated scan bound (for example, stop after the chain window and treat
  "older than the window" as unsuperseded).

And reduce R6's walk to "has any direct child".

## 3. [LOW] After the named residual race, one row has two children and the two branches never see each other again

**What is wrong.** The residual race is a manual send in flight while the job
passes 4a and claims. It leaves the pressed row O with two children: R1
(automatic) and M (manual). A press on O is 409 `superseded`, which is correct.
But from then on:

- attempt 2's step 4a (retried row R1) looks only for manual children of R1;
- a press on M checks only M's children and M's records.

So R1's automatic ladder and M's manual line run side by side, each able to
send. That is not one extra text but a forked chain for up to 15 minutes.

**Fix (optional).** Key both checks on the chain rather than the parent: "a
later row with this `retry_root` and no `retry_attempt`" for 4a; "a later row
with this `retry_root`" for `superseded`. Both are served by the same scan or
pointer as finding 2. If not adopted, name the fork in the residual.

## 4. [LOW] The adopted row records `recipient_contact_id` from the derived key even when that contact no longer holds the number, or was deleted

R4 adopts with `recipientContactId` = the owner's contact-id key. That key is now
the retried row's recorded contact, taken unconditionally (R1). `sendMessage`
records a recipient only when it `contactHoldsPhone`
(`app/src/services/sendMessage.ts:488-495`, `:670`), and RSW relay B4 says "an
adopted row should likewise record `recipient_contact_id` only for a recipient
that held the number". R10 now documents the divergence rather than avoiding it.

For the legacy-deleted-contact case the coordinator asked about:

- The KEY stays stable (the id is immutable), and the direct send falls back
  to the phone-matched contact (`app/src/jobs/retrySend.ts:192-200`) - fine.
- The adopted row, however, names a contact that no longer exists or no longer
  holds the number. `isBroadcastRowFor` and Branch B read that field.

**Fix.** One contact read plus `contactHoldsPhone` in the adoption, the way the
broadcast adoption already does (`app/src/jobs/broadcastFanOut.ts:1380`).

## 5. [LOW] Precision

- **"A mismatch -> `unresolved` `digest_mismatch`" (R1) cannot be executed.** A
  record whose raw key's hash does not match cannot be addressed to close.
  Under the stated immutability it never happens; say "unaddressable -> left for
  the sweeper".
- **Test 15's "the older attempt's record cannot be pending: it produced the
  newer row" is false.** A record-phase failure leaves the producing attempt
  `reconciling` or `attempting` after its row exists. It is harmless (its
  reconcile repairs by `mine` and sends nothing), but the claim should go.
- **The lineage exclusion reads "the root's `broadcast_id`".** On a deep chain
  that runs through a manual row, the root may lie beyond the 3-read walk. Use
  the retried row's copied `broadcast_id` (R7).
- **Section 4 names `app/test/api.test.ts`.** The manual Retry route's cases
  are in `app/test/apiRoutes.test.ts:430-760`. Their fake `messagesRepo` has
  only `getByProviderSid`, and they inject no conversations repo and no
  attempts repo. With the new route reads, a lazily defaulted repo would be a
  real DynamoDB one (`app/src/routes/api.ts:565-569`), so name the fakes to add.
- **Test 16's "the copy string to the app's constants"**: there is no app
  constant for that copy.

---

## The coordinator's four interleavings

| Interleaving | Result |
|---|---|
| 4a vs 5 on a `done/retryable` re-run | They disagree only if a manual row appears between 4a's scan and the claim. That is exactly the stated residual (the manual send's duration). Nothing else can change in between, because the window check and the claim are milliseconds apart, as today. |
| Root with both an automatic attempt-1 row and a manual row | A press on the root is 409 `superseded`, correctly. The branches are uncoupled afterwards (finding 3). |
| Legacy chain with a broken `retry_of` | Both walks stop at the last row read. Cost is at most `MAX_SEND_RETRY_ATTEMPTS` consistent reads per job run or check. A missed predecessor falls back to SOR's rule and fails safe to `unresolved`. The correctness defect in the walk is the manual row (finding 1), not a broken link. |
| Legacy retried row naming a since-deleted contact | The key is stable. The direct send falls back to phone gating. The adopted row records the dead id (finding 4). |

## Checked and holding

- **r3#1** - both gates now run for absent, `done`/`retryable` and `redriven`
  records. The decline rules per state are right: close `redriven`, write
  nothing on `done`/`retryable`, never hold a claim. RSW #1 is restored (test
  4d).
- **r3#2** - `superseded` closes the earlier-row bypass of Q1 and issue gap 2.
  The residual is now named correctly.
- **r3#4** - paging with a `tsMsgId` bound is correct for 4a (ISO-leading keys,
  `messagesRepo.ts:202-209`).
- **r3#5** - one 15-minute bound.
- **r3#6** - no key in the queue payload.
- **r3#7** - the root walk, the recorded root-keying reason, and the lost-fence
  wording.
