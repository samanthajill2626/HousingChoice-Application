# Branch B plan review round 1 - adjudications

Date: 2026-09-28. Plan v1 (commit 31ea4e7b) -> plan v2 (this commit).
Reviewers: A (`plan-review-r1-a.md`, 16 findings: 3 high, 5 medium, 8 low)
and B (`plan-review-r1-b.md`, 21 findings: 1 high, 8 medium, 12 low),
independent, same brief. Heavy overlap; each item names both numbers. Every
finding is a claim: ACCEPT (the plan changed), REJECT (with the reason), or
DEFER (filed). Severity labels are the reviewers'; whether a DECISION changed
is the planner's call.

Decisions changed this round: 16. Round 2 runs (reviewer B continued, with
A's report - B's report went deeper into 1b's code and the crash windows).

## Accepted - decision changed

1. **A1 / B1 (HIGH) - the webhook read the 30003 promise from the PRE-write
   row image (no re-read exists after `updateDeliveryStatus`), so production
   never emitted `retry_pending: 1` and wrote `failed` where `pending` was
   meant; the harness double mutates the row in place and hid it.** ACCEPT.
   T5 takes the value from the retry DECISION (`oneToOneRetry.runAt`), the
   same value the conditional write stamped; a test makes the world's read
   return a COPY so a stale-image read goes red; the harness `webhooks` block
   gains the ledger repo.
2. **A2 (HIGH) - a counted entry's `countedAt` was the write instant, so the
   repair would have rewritten every pair's `sentAt` to the repair time and
   re-ordered "Properties sent" and the tour form's default.** ACCEPT.
   Deviation 9: `countedAt` is the ATTEMPT's provider instant (from its key);
   a legacy seed keeps the row's `sentAt`; a delivery does not move the date.
3. **A3 / B5 (HIGH / MEDIUM) - `DeliveryBadge` is the only caller of
   `shareRecipientReason` and was not in T10, so "will retry" never reached
   the row.** ACCEPT. T10 adds the badge's props, call and tests; the
   `StatChips.test.tsx:178` render test moves with it.
4. **B2 (MEDIUM) - T6 swallowed slot-write throws at the reconcile sites,
   defeating the redelivery re-apply the spec depends on.** ACCEPT. Deviation
   11: at the adoption hook and the unresolved-close arm a throw is logged and
   PROPAGATES (the check fails, the redelivery re-runs it); only the job's
   arms use `guardWrite`. Tests: a hook that throws once, then the redelivered
   check re-finds the row and re-runs it.
5. **A6 / B15 (MEDIUM / LOW) - the results, list and stats routes paid D1's
   record reads (which only the composer flag needs) and read every slot
   serially.** ACCEPT. Deviation 12: `resolveRecipientStates` reads records
   only with `recordReads: true` (the flag); reads run 8 at a time; a route
   test asserts zero record reads.
6. **B7 (MEDIUM) - the results page's pill and chips never re-judged the
   promise on the ticker.** ACCEPT. T10: on every tick the page recounts
   `retry_pending` from its rows' `retryDueAt` and the pill and chips read the
   recount (deviation 7 restated).
7. **A7 / B8 (MEDIUM) - D8's record check was ambiguous and `brokenLineage`
   undefined (a literal reading skipped healthy slots); tests stubbed.**
   ACCEPT. T13 defines the chain, a break (a row that CLAIMS the chain but
   does not walk to the original), the newest attempt, the ONE record check
   (the newest row's next attempt), the stamp rule (missing OR wrong), the
   report fields, and writes every test body incl. the wrong-account and
   unstamped-ancestor cases.
8. **B17 (LOW) - the pair's contact was taken from the retry row before the
   slot key, reversing D7's send-time-contact rule.** ACCEPT. T4: the slot key
   when a contact id, else the row's recipient contact; a test pins it.
9. **B21 (LOW, the Not confirmed label) - a slot whose row said its chain
   ended unresolved counted in `failed`, so the share read Not sent while D1
   calls it unconfirmed.** ACCEPT. `deriveBroadcastStats` takes
   `unconfirmedKeys` (T1); the routes pass `unconfirmedByRow(states)` (T9).
10. **A5 / B12 (MEDIUM / LOW) - `putShareMemory` conditioned on
    `attribute_not_exists(unitId)` for a row without `updated_at`, so the
    full-world seed rows could never be written; a millisecond token can
    ABA.** ACCEPT. Deviation 8: a random `shares_op` token; a row without one
    (absent or seeded) takes `attribute_not_exists(shares_op)`; a test seeds
    the matrix shape.
11. **A13 / B20 (LOW) - the `individual` hack leaked a fake share id onto
    the wire; `recordSend` survived as an unguarded upsert with no caller.**
    ACCEPT. Deviation 10: an individual-only pair keeps `broadcastId` absent;
    `recordSend` is deprecated in T3 and DELETED in T7 (its tests rewritten).
12. **B21 (the T5/T7 window) - between T5 and T7 the pass re-SET `sentAt` on
    an un-counted row.** ACCEPT. Slice 2 builds T4, T7, T5, T6 in that order.
13. **A11 / B16 / B21 (LOW) - `allowed()` admitted a move from `queued`; a
    newer delivered attempt kept the old attempt's `carrierSentAt`; the
    adoption hook dropped the provider's `date_sent`; a `queued` receipt was
    treated as carrier-sent; an invented failure code.** ACCEPT. T4: FROM
    `failed` or `sent` only; a newer attempt never inherits the carrier
    instant; `delivered` carries an optional `carrierSentAt`; T5's `outcomeOf`
    maps only sent / delivered / failed; T6's `mapAdopted` carries the
    provider's `date_sent` and the row's error code (fallback `unknown`).
14. **A12 / B11 (LOW) - the `Retrying` chip's tone did not type-check; Failed
    could go negative under a kept count.** ACCEPT. T10: `'progress'` joins
    `Chip.tone` with a CSS class; Failed clamps at 0.
15. **A16 / B21 (LOW) - `getByIds` was unguarded on the Activity route and not
    the projected read D5 asks for; dropped keys were silent.** ACCEPT. T1:
    `projection: 'stats'`, WARN on leftover unprocessed keys; T11 wraps the
    read (the route never 500s) and tests it.
16. **A4 / B4 (MEDIUM) - harness wiring never named: the webhook's ledger
    repo, the retry job test's `wire()`, the activity double's `broadcastId`.**
    ACCEPT (a surface the plan omitted): T5, T6 and T7 name the files and the
    edits and include them in their commits.

## Accepted - precision (no decision changed)

17. **B3** - T4's `originalRowLedgerWrite` test moved `pending -> delivered`
    for the same attempt (red by construction). Rewritten on separate rows.
18. **A9 / B10 / B6 / B14** - pins the plan broke without naming them:
    `deriveBroadcastStats.test.ts:26` (the identity pin - the function now
    returns `b.stats` itself without options), `broadcastApi.test.ts:1271`
    (rewritten with `retry_pending: 0`), the T8 deletion range (the whole
    describe block), `broadcastFormat.test.ts:224`, `:228`, `:242` (all three
    flip; the plan had told the builder to keep :224), the swallowed-ledger
    pin (`broadcastFanOut.test.ts:1054-1083`, re-stubbed on `putShareMemory`).
19. **A10 / B11** - API facts the sketches got wrong (`createLogCapture`'s
    shape, `zeroStats()`, `createFakeWorld` / `makeWebhookHarness`,
    `world.events`, no `seedBroadcast`, required `BroadcastItem` fields, no
    `doc` in the webhook, `sentAt` optional). A header block states them and
    every sketch uses them.
20. **A8 / B9 / B18** - tests the spec names that were missing or stubbed: a
    later adoption superseding the row-less marker (T4 and T6), D6's
    refreshed and withdrawn rows and the read bound (T12), the sparse index
    return (T3), the phone-keyed ledger landing (T4), call-order pins at the
    job's arms and the adoption (T6), the crash-before-close re-run (T6), the
    stats-refetch exercised on a mounted list (T14), the wrong-account and
    unstamped-ancestor repair cases (T13). All written out.
21. **A14** - the e2e helpers are file-local (copied, not imported); scenario
    (a)'s transient state is asserted through the API right after the failure
    is stamped, with the copy pinned by the badge's unit test.
22. **A15 / B19** - the spec's "first task verifies 1b's four facts": the
    header states it was done by the research record and where.
23. **B13** - `registerHandlers.ts` passes only `sendAttemptsRepo`; the T6
    edit there is dropped.
24. **B21 (Slice 1 wording)** - Slice 1 lowers the cap; the work map says so.

## Rejected

None.

## Deferred

None.

## Carried into round 2

- Both reviewers' "checked and sound" lists (the `applyAttemptOutcome`
  expression, the five insertion sites, the safe deletion of
  `priorRecipientContactIds`, the sparse index, the bridge) are the baseline.
- New material for round 2: the header's API-facts block and deviations
  8-12; T3's token and clock; T4's rule edits and the contact precedence;
  T5's promise source and the copy-read test; T6's propagating throws and the
  crash re-run test; T10's ticker recount and the badge; T13's definitions.
