# Branch B spec review round 3 - adjudications

Date: 2026-09-27. Spec v3 (commit 1951d190) -> spec v4 (this commit).
Reviewer: B continued (`spec-review-r3.md`, 8 findings: 4 medium, 4 low; the
round-2 fix contest conceded). Every finding is a claim: ACCEPT (the spec
changed), REJECT (with the reason), or DEFER (filed). Severity labels are the
reviewer's; whether a DECISION changed is the planner's call.

New fact this round: Stage 1b's spec is FINAL - revision 5 @dad3fecb on
`feat/retry-send-adoption`, review loop closed - and differs from the r2/r3
drafts v3 was written against. v4 is written against r5 as the interface and
asks nothing more of 1b; the relay given to Cameron after round 2 (asking 1b
to walk `retry_root` and `broadcast_id`) is WITHDRAWN.

Decisions changed this round: 6. Round 4 runs (reviewer B continued) and is
the HARD CAP: if it still changes a decision, the open findings go to
Cameron as a decision with the gate.

## Accepted - decision changed

1. **F1 (MEDIUM) - the job's two unresolved-end arms have no re-apply to
   ride (r5: record first, WITHDRAW second, a redelivered job returns at INFO
   on a `done` record, post-claim writes are guarded and never throw), so a
   crash or a dropped write there loses 1b's WITHDRAW, its `retry_outcome`
   and this branch's slot write together, and D8 healed only from the row.**
   ACCEPT, both fixes. v4 D2: at those two arms this branch's slot write goes
   FIRST, before 1b closes the record - `send_unconfirmed` is the safe state,
   a crash after it leaves a record the redelivery or the sweeper resolves,
   and any later real outcome supersedes it under the order rule. v4 D8 step
   3 also reads the retry-owner attempt records by key while they live (30
   days): a `done` / `unresolved` record is the trace a dropped guarded write
   leaves. Section 0 fact 3 says the arms have no re-apply and that this
   branch asks for none; section 9 no longer calls a re-apply "welcome". I7
   states the placement. Not taken: a re-apply in the job's step-4 return -
   it would be a fifth site inside 1b's job for a case the two fixes already
   cover.
2. **F3 (MEDIUM) - the merge rule left a finished share reading "Sending"
   after its last pending recipient's chain ended in a failure receipt
   (exhaustion, a retry's 30007): that arm omits the count and `failed` does
   not shrink, so the clamp kept the stale count - the ordinary end of a
   failed one-to-one share.** ACCEPT. v4 D4: a page merging a payload that
   omits the count keeps a zero as zero and keeps a positive value only until
   a debounced refetch of THAT row's stats from the route (the true count)
   replaces it; both hooks change from wholesale replacement to this merge;
   the clamp is gone. The only staleness left is a promise lapsing with no
   event at all. Section 7's e2e (b) now checks the list too.
3. **F4 (MEDIUM) - "in flight whatever the stored status" flagged every
   recipient of a GENUINELY failed route send forever (Branch A excludes
   failed shares, so the price was new, not Branch A's), outside the
   sweeper's `sending`-only nomination, so the recovery share would start its
   whole audience unchecked.** ACCEPT. v4 D1 tells in flight from a new
   `stranded` state by the send-attempt RECORD, never the stored status:
   `queued` in a `sending` share is in flight; `queued` in a non-`sending`
   share is in flight only when the recipient's record exists and does not
   say the text never went (`never_sent`, `refused`, `rejected`,
   `enqueue_failed`, `redrive_refused`); no record, or such a record, is
   stranded (never texted: a route enqueue that truly failed, a draft), and
   counts for neither reading. One keyed read per queued slot of a
   non-sending share (strands only); the double mirrors it; a record older
   than 30 days reads stranded, which is right for the flag. This is the
   sweeper's own "no record = never claimed = never sent" rule. Section 7
   restates the `priorRecipientContactIds` pins: queued-in-sending kept, the
   DRAFT exclusion holds as a stranded case, the FAILED exclusion becomes
   slot-and-record cases.
4. **F5 (LOW) - D7 had no counterpart to D2's delivered-at-any-age clause, so
   the slot could read Delivered while the ledger kept a newer attempt's
   `failed`; which pointer the slot keeps was unstated.** ACCEPT. v4 D7: an
   older attempt's delivery applies too, the entry becomes `counted` by
   delivery (terminal). v4 D2: the slot records the delivered attempt as its
   newest; a delivered slot is terminal, so the pointer's ordering role ends
   there (D8 step 3 then sees no disagreement). D2 also notes that r5's "any
   child supersedes" confines the case to 1b's two-child fork and pre-1b
   chains.
5. **F6 (LOW) - D6 judged a `pending` entry by a due instant COPIED into the
   ledger at write time, which 1b's refreshes (deferral, unknown, re-drive)
   never update - a second source of the promise, against I5.** ACCEPT. v4
   D6: a `pending` entry is judged the way D1 judges pending - the entry names
   its attempt, so within D1's bound the timeline reads that attempt's row
   (live promise, `retry_outcome`); "Property sent" while live, "Property sent
   - not confirmed" when the row says unresolved, "Property text failed" once
   lapsed or past the bound with no later entry write. D7's memory drops the
   promise copy. Section 7 tests a pending entry against a live, a refreshed,
   a withdrawn and a lapsed row.
6. **F7 (LOW) - three incompatible root rules; v3's requirement 1 asked 1b to
   walk both fields while r5 (final) walks `retry_root` up to the attempt cap
   and copies `broadcast_id` one hop; section 6 still had 1b "receiving the
   refined requirements"; unit-less pre-backfill shares keep an unattributed
   chain for good.** ACCEPT, by adapting to r5 rather than asking 1b to
   change: v4 section 0 states r5's two rules as facts 1 and 4, names the
   one-hop hole (a post-1b retry of an unstamped pre-1b retry row carries no
   `broadcast_id` and never enters the rollup) and closes it with D8's
   stamping, bounding the deploy-to-repair window (automatic chains end inside
   the 15-minute window; a staff Retry of an old childless failed retry row is
   the other case). Section 6 and section 9: nothing is relayed; the plan's
   first task verifies 1b as built against the four facts (section 8's drift
   bullet). The unit-less residual is stated in section 2's non-goal.

## Accepted - precision (no decision changed)

7. **F2 (MEDIUM) - the read bound was three minutes short: window 15 + 1b's
   unknown-outcome refresh (240 s + 120 s) + liveness grace 2 min = 23
   minutes, not "about twenty".** ACCEPT: v4 D1 defines the bound as a
   derived constant (`RETRY_SEND_WINDOW_MS` + the reconcile's last check
   delay + `RETRY_PROMISE_GRACE_MS` for the refresh + `RETRY_PROMISE_GRACE_MS`
   for liveness + a one-minute clock-skew margin; 24 minutes today), never a
   figure. The bounded-read decision itself stands.
8. **F8 (LOW) - "the slot is authoritative past the bound" also fails when a
   retry's receipt rollup is lost (the webhook answers 200; nothing
   redelivers; D2 gives up after its bound).** ACCEPT: v4 section 8 names the
   lost retry rollup beside the original's stuck-`sent` class, healed only by
   a re-run of D8; D1's residue list and D8 step 3 name it.

Also folded, from the reviewer's direct answers: the two-child fork's
row-less-end ordering wrinkle is named in section 8 as accepted with 1b's own
residual (two texts may go out).

## Rejected

None.

## Deferred

None.

## Contests

- Round 2 item 1's fix (row as the durable record): the reviewer conceded -
  the crash that loses the slot write at a job-side arm loses the row's
  `retry_outcome` in the same window, so the row design would not have
  healed F1 either.

## Carried into round 4

- Baseline: the reviewer's "checked and holding" list (D2's lost-condition
  re-read, the results route returning `retry_due_at` and `retry_outcome`,
  the adoption hook on a de-duplicated re-adoption, D7's seeding and
  create-on-first-write, the 1000 cap, the sparse GSI).
- New material: the `stranded` state and the record read (D1); the
  slot-first order at the job's arms and D8 reading the retry records (D2,
  D8, I7); the derived bound (D1); the row refetch merge (D4); D6 reading the
  row for a `pending` entry; D7's older-delivery clause; the section 0
  rewrite against r5 and the withdrawn relay.
