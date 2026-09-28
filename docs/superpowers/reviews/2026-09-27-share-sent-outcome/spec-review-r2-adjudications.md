# Branch B spec review round 2 - adjudications

Date: 2026-09-27. Spec v2 (commit 82bdd304) -> spec v3 (this commit).
Reviewer: B continued (`spec-review-r2.md`, 14 findings: 1 high, 5 medium,
8 low; two adjudication contests). Every finding is a claim: ACCEPT (the spec
changed), REJECT (with the reason), or DEFER (filed). Severity labels are the
reviewer's; whether a DECISION changed is the planner's call.

Decisions changed this round: 9. Round 3 runs (reviewer B continued). Hard
cap 4.

## Accepted - decision changed

1. **F1 (HIGH) - two of 1b's unresolved-retry ends live inside the retry
   job, fenced by I7, so a re-driven retry that comes back unknown never
   reached the slot; the durable `retry_outcome` 1b writes on the retried row
   was ignored.** ACCEPT, with a different fix from the one proposed. The
   reviewer's fix (read `retry_outcome` from the row, keep the reconcile
   write as an accelerator) makes the row the durable record of an unresolved
   end, which forces the row read on EVERY failed-30003 slot forever (F5's
   cost). v3 instead makes the SLOT the complete durable record: this branch
   calls its own slot writer at all FOUR unresolved-end sites (the reconcile's
   close and its re-apply, the job's second-unknown and enqueue-failed arms),
   after 1b merges, riding whatever re-apply 1b gives its own WITHDRAW; the
   row's `retry_outcome` is read only within D1's time bound (where the row is
   read anyway for the promise) as the fallback for a fresh end whose slot
   write has not landed; the double fault (a crash between 1b's close and the
   slot write, with no re-apply) is named in section 8 and healed by D8, which
   now stamps a slot from its row's `retry_outcome`. I7 is restated: this
   branch changes nothing in the record, claim or close SEMANTICS; it only
   calls its slot writer from those sites. Section 0's requirement 2 on 1b
   is narrowed to what 1b already does (the `retry_outcome` written at
   WITHDRAW); chain ends that leave the promise to expire need nothing - the
   lapse is the signal. D1's failed bullet now lists those ends by mechanism.
2. **F2 (MEDIUM) - D2 had no lost-condition rule; a retry's `failed` that
   loses to its own `sent` left the slot reached.** ACCEPT. v3 D2: a lost
   condition re-reads consistently and re-applies under the same rule up to a
   small bound; WARN with ids past it. Section 7 tests it.
3. **F4 (MEDIUM) - `retry_pending` was zero in every SSE payload and both
   pages replace stats from the payload, so the list read "Not sent" from the
   very failure that starts a retry.** ACCEPT. v3 D4: the count is OPTIONAL
   in the stats shape; the rollup that just wrote a 30003-with-promise emits
   it as a lower bound (its own recipient); every other emitter OMITS it; a
   page merging a payload without it keeps the row's last value clamped to
   the payload's `failed`; the results page recomputes on its debounced
   refetch. The list's residual staleness (a lapsed promise, a second pending
   recipient the lower bound did not count) is stated and accepted.
4. **F5 (MEDIUM) - the promise read had no time bound (a wholesale 30003
   outage makes every later preview and list page pay one read per failed
   recipient forever), and a read failure inside the preview's catch-all
   emptied the "Already sent" set.** ACCEPT. v3 D1: rows are read only for a
   failed-30003 slot whose newest attempt is younger than the window plus the
   longest refresh and grace (about twenty minutes, from the message id's
   provider timestamp); an older slot is judged from the slot alone, which is
   authoritative by item 1; a failed read leaves the recipient PENDING (safe)
   and is logged. Section 7 tests the bound and the failed read.
5. **F6 (MEDIUM) - D6 read a `pending` ledger entry as "Property sent"
   forever when the chain ended without a retry row.** ACCEPT. v3 D6: a
   `pending` entry records the promise's due instant; the words read "Property
   sent" while it is live and "Property text failed" once it has lapsed (a
   pending entry that never hears a retry outcome is a failure by RSW's own
   clock). An unresolved end reaches the ledger as `unconfirmed` through the
   D2 callers (item 1 gives every end a writer), so "Property sent - not
   confirmed" is reachable without a row read. D7's forward list gains
   `pending -> failed` for the repair.
6. **F7 (LOW) - "stranded - never texted" was false for the route's
   ambiguous enqueue failure: the fan-out never reads the stored status, so
   recipients being texted in that pass were un-flagged.** ACCEPT, and the
   stored-status split is removed rather than patched: v3 D1 reads EVERY
   `queued` slot as in flight (safe flag), whatever the share's stored status,
   because a slot has no clock to tell a strand from a pass. The price (a
   route-failed strand keeps its untexted recipients flagged until the
   sweeper) is the one Branch A already pays, named in D1 and section 8. D4's
   label for that share stays Not sent, danger.
7. **F8 (LOW) - contest of B16 (part): a stale-tab Retry of a superseded
   failed row is accepted once its promise lapses (RSW gap 2), so a later
   attempt can follow a delivery, and an overlapping older attempt's delivery
   was refused.** CONCEDED - the round-1 rejection rested on a false premise
   (the route checks only the pressed row, `api.ts:1595-1611`). v3 D2: a
   DELIVERED receipt applies whatever its attempt's age; D7 / I2: an entry
   counted by a delivery is TERMINAL for that share, so no later attempt can
   un-count it. Section 7 tests the older delivered receipt.
8. **F10 (LOW) - D7's writer for the share's own unresolved closes wrote an
   entry nothing reads and added a ledger write to four SOR close sites.**
   ACCEPT. Writer removed; v3 D7 says the original's unresolved close writes
   nothing (no milestone exists for a never-accepted text; the pair never
   counted from it). "Not confirmed" words are reached through the retry path.
9. **F11 (LOW) - three incompatible `retry_root` rules across v2 and the two
   1b revisions; D8 stamped only pre-1b rows, so a post-1b retry of an
   unstamped ancestor stayed unattributed; unit-less pre-backfill shares are
   in neither index.** ACCEPT. v3 section 0 requirement 1: `broadcast_id` and
   `retry_root` are DERIVED by walking `retry_of` to a stamped row or the
   chain's first send, never a one-hop copy; D8 step 2 stamps any chain row
   lacking them, whenever written; section 8's drift bullet covers a one-hop
   1b; the unit-less pre-backfill share is a named residual (no ledger row,
   milestone keeps today's words, not walked). Section 9 carries the relay.

## Accepted - precision (no decision changed)

10. **F3 (MEDIUM) - ordering was defined only over message ids; three writes
    had none.** ACCEPT: D2 orders a row-less attempt immediately after the
    attempt it retried; D7 orders a seeded legacy entry before every real
    attempt and spells out the forward list; the original's unresolved writer
    is gone (item 8), so its id-less write no longer exists.
11. **F9 (LOW) - between a late retry's send and its first receipt, a lapsed
    promise reads as a final failure with a hint the thread does not offer.**
    ACCEPT as a named residual (section 8, RSW's gap), inherited and bounded
    by receipt latency.
12. **F12 (LOW) - 1b's INFO downgrade of the rollup's miss line would
    outlive the interim.** ACCEPT: section 0 says that once this branch lands
    a miss for a row without `retry_root` logs WARN (the lost-rollup class D8
    repairs) and a miss for a retry row logs ERROR (a routing bug).
13. **F13 (LOW) - D3's boolean cannot be re-judged on a ticker; a "Not
    confirmed" pill could sit over the stored "all recipients failed"
    alert.** ACCEPT: D3 returns `retry_due_at` (and `retry_outcome`) and the
    page judges liveness on the server clock; D4 shows `last_error` under Not
    sent only.
14. **F14 (LOW) - section 7's lapse assertion was unobservable in a scenario
    whose retry delivers at ten seconds.** ACCEPT: the lapse is pinned by a
    hermetic test with a fake clock (D1's state table); the e2e scenarios
    assert "will retry" while the promise is live and its disappearance when
    the chain ENDS (exhaustion), which the lane's backoff makes observable.

## Rejected

None outright. Item 1 rejects the reviewer's PROPOSED fix (row as the
durable record) in favor of the slot as the durable record, for F5's cost
reason; the finding itself is accepted.

## Deferred

None.

## Contests

- B16 (part), round 1: conceded (item 7).
- A12 (part), round 1: the reviewer conceded; stands as rejected (moot).

## Carried into round 3

- The reviewer's "checked and holding" list (D1's in-flight reading, the
  adoption hook on a de-duplicated re-adoption - now in D2 -, the sub-bucket
  balance, the sparse GSI, the 1000 cap arithmetic, `sendMessage`'s three
  `broadcast_id` readers) is the round-3 baseline.
- New material for round 3: the four-site slot writer and its re-apply story
  (D2, section 0, I7, section 8); the time bound and "slot authoritative past
  it" (D1); the optional `retry_pending` and its merge rule (D4); the
  delivered-at-any-age clause (D2, I2); D7's forward list; D6's lapse words.
