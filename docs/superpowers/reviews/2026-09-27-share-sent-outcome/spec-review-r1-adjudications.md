# Branch B spec review round 1 - adjudications

Date: 2026-09-27. Spec v1 (commit 6e99330d) -> spec v2 (this commit).
Reviewers: A (`spec-review-r1-a.md`, 19 findings: 1 blocking, 3 high, 9
medium, 6 low) and B (`spec-review-r1-b.md`, 20 findings: 2 blocking, 1 high,
11 medium, 6 low), independent, same brief. The two lists overlap heavily;
each item below names both numbers (A#/B#). Every finding is a claim:
ACCEPT (the spec changed), REJECT (with the reason), or DEFER (filed).
Severity labels are the reviewers'; whether a DECISION changed is the
planner's call.

Decisions changed this round: 8. Round 2 runs (reviewer B continued, with
A's report).

## Accepted - decision changed

1. **A1 / B2 (BLOCKING) - an unresolved retry had no slot state; section 0's
   "withdraw on unresolved" made D1 un-count a text that may have arrived,
   and D3 offer a Retry for it.** ACCEPT. v2: the reconcile's unresolved
   close of a retry is one of D2's three callers and writes the slot
   `failed` / `send_unconfirmed` (state unconfirmed - safe flag, no hint,
   never counted in the ledger). I7 now says the branch extends the two
   retry-owner reconcile paths with its own slot writer; the fence on 1b's
   record, claim and closes stands. Section 0 keeps the withdrawal (it only
   ends the promise; the slot state is what counts).
2. **A3 / B1 (HIGH / BLOCKING) - an adopted retry produces no transitioning
   receipt, so it never reached the slot or the ledger.** ACCEPT. v2: the
   reconcile's adoption of a retry is D2's second caller, mapping the adopted
   row's provider status as the share adoption does today.
3. **A2 (HIGH) - the slot's copy of the promise would drift from the message
   row RSW and 1b refresh and withdraw.** ACCEPT. v2: the promise is not
   copied; the results route and the preview route read it from the newest
   attempt's message row (the slot's new pointer names it), one read per
   30003 row. I5 restated as "one source".
4. **A4 / B3 (HIGH) - the ledger baked a time-bound fact ("30003 with a
   promise stays counted") into permanent state; a lapsed promise with no
   outcome stayed counted forever.** ACCEPT. v2 D7: only reached attempts
   count; a pending retry is recorded `pending` and counts nowhere in the
   ledger until it reaches (the pair leaves "Properties sent" during the
   backoff and returns when the retry delivers). I6 states it.
5. **A6 / B6 (MEDIUM) - "queued never counts" un-flagged a reconciling send
   and a mid-pass recipient whose text may be out - a regression from
   today.** ACCEPT (v1's D1 reversed). v2: a `queued` slot in a `sending`
   share is "in flight" and takes the safe flag; a `queued` slot in a share
   no longer `sending` is "stranded" and does not. The strand-while-sending
   case stays flagged until SOR's sweeper - the price Branch A already pays,
   named in D1 and section 8. This also keeps `broadcasts.spec.ts`'s
   immediate "Already sent" assertion valid (A7 / B18).
6. **B7 (MEDIUM) - SOR's status-only conditional primitive cannot order
   attempts: a delayed same-retry `sent` could overwrite that retry's
   `failed`, or a strict CAS could drop a delivery.** ACCEPT. v2 D2 is a NEW
   primitive whose condition names the recorded attempt: a newer attempt
   always applies; the same attempt only forward in the message machine's
   order; an older attempt never; with the stats delta in the same write.
7. **B8 / A12 (MEDIUM) - D7's read-modify-write had no conflict rule (a lost
   race in the one-shot rollup was never retried) and no statement that the
   callback must CREATE the entry when it lands first.** ACCEPT. v2 D7:
   bounded re-read-and-re-apply on a lost condition, ERROR with ids past the
   bound; a writer that finds no entry creates it, so callback-first refuses
   the pass's later same-attempt `counted` write; the repair is the re-runnable
   healer (section 8 names the residual).
8. **A10 / B14 (MEDIUM) - the item-size risk is certain at the 1500 cap with
   real attribute names, product-visible, and not at the gate; an over-limit
   write throws mid-pass.** ACCEPT. v2 removes the promise from the slot
   (one attribute, retried slots only), states that the crossing write throws,
   and puts the decision at the gate (section 9): lower the recipient cap to
   1000, with the legacy near-cap share as a named residual.

## Accepted - precision (no decision changed)

9. **A5 / B9 - I1 "one rule, every surface" was false by design.** ACCEPT:
   I1 and D1 now say ONE per-recipient state with exactly two readings (safe:
   the composer flag; strict: everything else), and name which surface takes
   which.
10. **A9 / B4 - `retry_pending` was undefined against finalize and the chip
    balance, and clock-dependent for seven callers.** ACCEPT: a SUB-bucket of
    `failed` (finalize, persisted counters and the balance unchanged), derived
    only on the results and list routes from D3's promise reads, zero
    elsewhere; chips show Failed minus pending plus a Retrying chip.
11. **A8 / B13 - the hint rule removed the hint from every synchronous
    rejection and contradicted a pinned SOR e2e.** ACCEPT: the hint shows only
    when the slot's newest attempt HAS a message row, is `failed` with no live
    promise, and is not "Not confirmed" - which is what the conversation
    offers. The 21211 pin is listed for rewrite in section 7 (a 21211
    rejection has no row and nothing to retry; today's hint there is wrong).
12. **A11 / B12 - old milestones carry no share id; D8 did not touch them;
    the "closes" claim held only for new shares.** ACCEPT: a milestone without
    a share id reads from the pair-level `counted` (an approximation, named);
    D6 says so.
13. **A13 / B10 - a legacy ledger row lost its pre-branch counted share on the
    first new write.** ACCEPT: the first write seeds the row's memory from its
    own `broadcastId` / `sentAt` (or an `individual` entry for a seeded row).
14. **B11 - the ledger's `unconfirmed` state had no writer for the share's
    own unresolved closes (three sites) and the words were unreachable.**
    ACCEPT: D7 lists the share's own unresolved closes for the original
    attempt as writers; D6's words follow.
15. **B5 / A2 (list staleness) - the list's "Sending" pill is never
    re-judged.** ACCEPT as a stated bound: a list row lags by one refetch; the
    results page ticks. Recorded in D4 and I5.
16. **A14 / B16 - I2's ledger clause was not delivered; "newest wins" and an
    older delivery.** ACCEPT the precision: I2 restated per share entry, with
    the reason a later attempt cannot follow a delivery (a retry follows only a
    failure); D2 refuses an older attempt's receipt by rule.
17. **A15 / B15 - I4 was false on day one (pre-existing blind writers).**
    ACCEPT: I4 now scopes to the writes this branch adds and names SOR's
    residue.
18. **A16 - `last_error` under a Sending or Not confirmed pill; the all-queued
    stored-failed share's tone.** ACCEPT: shown under Not sent and Not
    confirmed only; the route-failed all-queued share reads Not sent, danger.
19. **A17 / B17 - D2 misdescribed how an original's acceptance is learned.**
    ACCEPT: the pass writes `sent` at dispatch; a retry has no such writer, so
    the slot learns it from the carrier's confirmation or terminal receipt.
20. **A18 / B20 - D8 did not stand alone (Branch A's script shape by
    reference; the "in-flight chains" rationale; index membership; the
    two-line drift fix; stuck-`sent` slots unrepaired; phone-keyed pairs).**
    ACCEPT: D8 spells out the script conventions, why pre-1b rows must be
    stamped (1b copies attribution from the previous row), walks both share
    indexes, repairs a slot whose recorded attempt disagrees with its own row,
    fills a row the pass's swallowed write never created, and names the
    phone-key residual; section 8's drift fix names every append site.
21. **A19 - the harness ledger double was unenumerated.** ACCEPT: section 5
    names it and requires a parity test.
22. **B19 - between 1b's deploy and this branch's, every share-retry receipt
    stalls the webhook 2.5 s on the miss re-read.** ACCEPT as a stated interim
    cost in section 0 (a few receipts a day; only share texts that failed
    30003 have retries).

## Rejected

- **A12 (part) - "the unresolved writer is filed under the wrong bullet".**
  Moot: D7's writer list was rewritten (item 14).
- **B16 (part) - "an older overlapping attempt's delivery is refused".** No
  such attempt exists: the staff Retry route refuses anything but a failed or
  undelivered message, and the automatic retry follows a failure, so two
  attempts for one recipient never overlap in flight; D2's "older never
  applies" is the right rule for a late receipt of a superseded attempt.

## Deferred

None.

## Not a finding, recorded for round 2

- Both reviewers' surface sweeps (the three unresolved-close sites, the seven
  derivation callers, the harness doubles, the ledger routes) are carried
  into section 5 and are the round-2 baseline.
