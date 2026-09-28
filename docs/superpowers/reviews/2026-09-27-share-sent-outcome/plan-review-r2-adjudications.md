# Branch B plan review round 2 - adjudications

Date: 2026-09-28. Plan v2 (commit 8cab22a1) -> plan v3 (this commit).
Reviewer: B continued (`plan-review-r2.md`, 13 findings: 2 high, 4 medium,
7 low). Every finding is a claim: ACCEPT (the plan changed), REJECT (with
the reason), or DEFER (filed). Severity labels are the reviewer's; whether a
DECISION changed is the planner's call.

Decisions changed this round: 6. Round 3 runs (reviewer B continued). Hard
cap 4.

## Accepted - decision changed

1. **F1 (HIGH) - the un-swallowed reconcile writes (round-1 B2's fix) would
   loop a PERMANENT slot-write failure (the item-size limit) through the
   queue: at the unresolved arm every redelivery threw before the WITHDRAW,
   so the promise was never withdrawn; at the adoption the record stayed
   `reconciling` for good and the check ended in the DLQ.** ACCEPT. Deviation
   11 rewritten: at both reconcile sites the slot write is BOUNDED
   (`applyLaterAttemptBounded`: retried twice, then ONE ERROR, never
   propagated); at the unresolved arm the WITHDRAW runs FIRST; the dropped
   write is the repair's residue at every site, and spec section 8 is amended
   to say so. A process crash between the adoption hook and the record close
   is still re-applied by the redelivered check (a test simulates it by
   failing the close once).
2. **F2 (HIGH) - Task 2's code said `stranded` for a record not read while
   its tests and interface said `in_flight`; following the tests would flag a
   route-failed share's whole audience "Already sent" once past 30 days.**
   ACCEPT. Deviation 12 restated: `facts.record` absent = the caller did not
   ask (routes) -> `in_flight`; `'expired'` = asked, past the 30-day life,
   not read -> `stranded` (spec D1); the classifier, the resolver and the
   tests agree, and a test pins the old route-failed share unflagged.
3. **F3 (MEDIUM) - T13 decided from the newest row only (ignoring a
   delivered older branch) and rebuilt the ledger from the decision even when
   the slot refused, so a delivered pair could be un-counted.** ACCEPT. T13:
   the latest DELIVERED row in the chain decides (D2's exception); the ledger
   follows the SLOT through `ledgerEntryForSlot` (Task 3), never the
   decision; a test pins the delivered-older-branch case.
4. **F4 (MEDIUM) - T13's counters could not work (the service already wrote
   the ledger; the dry run showed no pair changes; `slotsToMove` never reached
   0 for a delivered slot; `noRecipientKey` skipped the slot).** ACCEPT. T13:
   `wouldApply` (Task 4, exported) gates "to move"; the census forecasts the
   ledger with `ledgerWouldChange` (`rowsToCreate`, `pairsToRecount`,
   `pairsToUncount`) and the apply counts the past tense from the row before
   and after; `noRecipientKey` skips only the record check.
5. **F5 (MEDIUM) - a `broadcast_id === share` claim marked another slot's
   chain in the same thread (two contacts on one number) as broken.**
   ACCEPT. A claim is `retry_root === O.tsMsgId` only; a two-slot test pins
   it.
6. **F11 / F12 (LOW) - the results page's recount disagreed with the route
   for an unreadable row and flashed Not sent between an event and its
   refetch; a failed retry enqueue withdrew the promise with no
   `broadcast.updated`, leaving a list on Sending.** ACCEPT (deviations 13
   and 14): the route marks each pending recipient `retryPending: true`; the
   page recounts ONLY on a tick from `retryPending` rows whose due instant is
   absent or live, and a payload clears the override; RSW's withdrawal arm
   emits `broadcast.updated` with `retry_pending: 0` for a share row.

## Accepted - precision (no decision changed)

7. **F6 (MEDIUM)** - T13's tests asserted table-wide counts in one shared
   database: every case now runs in one-share mode (`broadcastId`).
8. **F7 (LOW)** - `listingSendsApi.test.ts` (20 calls) and
   `contactsBatchReads.test.ts:151` still used `recordSend`: T7 lists them
   and seeds through a new helper.
9. **F8 (LOW)** - the list route now passes `unconfirmedKeys` too.
10. **F9 (LOW)** - the landlord relabel is inside its own try/catch and a
    landlord-only guard.
11. **F10 (LOW)** - the impossible job test ("a later adoption supersedes the
    job's unconfirmed slot") is dropped with a note pointing at Task 4's
    service test; the retry-row 30003 webhook case also copies the row image.
12. **F13 (LOW)** - the shared block's `originalRowLedgerWrite` and
    `ShareLedgerDeps` signatures match the task code; the work map no longer
    says "ORDER = numbering"; the note-to-self in `outcomeOf`'s contract is
    gone.

## Rejected

None.

## Deferred

None.

## Carried into round 3

- The reviewer's "checked and correct" list (the promise source in scope and
  the retry row's own decision; the re-run paths; the REMOVE hack; the token;
  the attempt-instant clock; `mapLimit`; `allowed`/`nextSlot`; the BatchGet
  projection) is the baseline.
- New material for round 3: `applyLaterAttemptBounded` and the WITHDRAW-first
  order; the `'expired'` record fact; T13's decided attempt, `ledgerEntryForSlot`,
  `ledgerWouldChange`, `wouldApply`, `projectSlot`; the ticker override; the
  withdrawal emit; the spec section 8 amendment.
