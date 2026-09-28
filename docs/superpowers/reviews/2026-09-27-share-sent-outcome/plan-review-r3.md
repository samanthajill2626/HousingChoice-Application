# Plan review r3: share-sent-outcome implementation plan, revision 3

Reviewer: B, continued (read-only; nothing run). Date: 2026-09-28.

- Plan: `docs/superpowers/plans/2026-09-28-share-sent-outcome.md` revision 3 (0fe8e525).
- Also read: `plan-review-r2-adjudications.md` and the spec section 8 amendment.
- Citations: code is `file:line` at HEAD 0fe8e525 (app code unchanged since 31ea4e7b); the plan is `plan:NNN` in revision 3.

Summary: no HIGH finding. There are five MEDIUM findings:
- The D2 writer mistakes its own committed-then-replayed write for a refusal, so the ledger entry and the emit are silently skipped. This affects every caller, including the new bounded retry.
- The new withdrawal emit sends `retry_pending: 0`. That breaks spec D4's "every other emitter leaves the count unset" and is wrong for a share whose other recipients are still pending.
- E2E scenario (b) opens the share list before the share exists. The list never adds a row from SSE, so the assertion cannot pass. This has been in the plan since revision 2 and all three reviews missed it.
- Task 13's one-share test mode still shares one ledger pair across every fixture, so the `pairsUncounted` case is red by construction.
- Task 13's dry run forecasts ledger changes for slots the D2 rule will refuse.

The rest are LOW.

---

## 1. [MEDIUM] A replayed committed slot write reads as a refusal: the ledger entry and the emit are skipped silently (every D2 caller, and the new bounded retry)

What is wrong.
- `applyAttemptOutcome` returns `{ applied: false }` on ConditionalCheckFailed (plan:489).
- `applyLaterAttempt` then re-reads the slot and re-decides (plan:1543, Task 4's loop). It writes the ledger and emits `broadcast.updated` only when a write APPLIED.
- Suppose a write commits but its response is lost: a socket reset, or a timeout after the commit. Two things then replay it:
  - the SDK's standard retry (the client sets no retry option, so it uses the SDK default of three attempts; `app/src/lib/dynamo.ts:61-89`);
  - revision 3's `applyLaterAttemptBounded`, which retries on a throw twice (plan:1853-1860).
- Either replay meets its own write and fails the condition. The re-read then finds the slot already holding `next`. `allowed()` refuses that as the same attempt (a `delivered` slot, or a `failed`/`sent` slot with nothing forward to take), so the call returns `'refused'`.
- No ledger entry is written, no emit is sent, and nothing is logged above INFO.

Evidence. The codebase names this exact hazard and fixed it for the finalize flip: "the SDK's replay of a flip that COMMITTED fails its own condition, and only the token on the read-back tells that winner from a genuine loser" (`app/src/repos/broadcastsRepo.ts:937-983`, the `finalize_op` token). `applyAttemptOutcome` has no such token. Deviation 11 adds a second replay layer on top of the SDK's (plan:36, plan:1853-1860).

What it implies.
- The slot is right, but the D7 ledger entry is missing. A retry that delivered is never counted, so the property is absent from "Properties sent". D6 keeps reading an earlier `pending` entry, so the milestone says "Property text failed".
- A list that turned Sending gets no event, and nothing heals any of this until the repair is re-run.
- The fix is small and needs no token. On a re-read that finds the slot already equal to the `next` this call computed (same status, code and `latestAttempt`), treat the write as applied and run the side effects. They are idempotent: the D7 rule refuses a duplicate entry, and a second emit is harmless.

## 2. [MEDIUM] The withdrawal emit's `retry_pending: 0` breaks spec D4 and is wrong for a share with other pending recipients

What is wrong.
- Deviation 13 (plan:38) and Task 5 (plan:1588) make RSW's enqueue-failure arm emit `broadcast.updated` with `deriveBroadcastStats(share, { retryPending: 0 })`. The Task 5 test pins that 0 (plan:1648).
- A payload that carries a count replaces the list row's count outright, with no refetch (the list merge, plan Task 10).

Evidence.
- Spec D4: "every other emitter (the fan-out, the reconcile, the other rollup arms, including the arm that ends a chain with a final failure) leaves the count UNSET - nothing has to learn to omit anything" (spec:385-389).
- The rollup's own count is allowed only as a LOWER bound (spec:381-384). Zero is not a lower bound; it is a claim that nobody is pending.
- A share with two recipients, one of them still pending: this recipient's enqueue fails and the arm emits 0. The list row reads none reached, pending 0, so Not sent, and never refetches.

What it implies. For every multi-recipient share with another retry in flight, the list shows Not sent while a retry is pending, until a reload. Emitting with the count UNSET gives the list what deviation 13 wants: a finished row whose last count was above 0 then refetches its stats (plan Task 10's rule) and turns Not sent only when that is true. For the original path, also say that `rolled` has to be hoisted out of the rollup's `else` block; as sketched (plan:1677) it is a block-scoped const that the arm at `:3632` cannot see.

## 3. [MEDIUM] E2E scenario (b) opens the list before the share exists, so the row the test watches is never on it

What is wrong. Scenario (b) says to "OPEN THE SHARE LIST FIRST (so the SSE events reach a mounted list); arm 30003, share, then ... expect on the STILL-OPEN list that the row's pill reads Not sent ... WITHOUT a reload" (plan:2638).

Evidence. The list hook only patches rows it already holds: "A row not on the current page is ignored (it'll be correct on the next fetch / Load more)" (`dashboard/src/routes/broadcasts/useBroadcastsList.ts:111-124`). The hook neither polls nor refetches on focus (it has one load effect, `:66`). A share created through the API after the list mounted is never added.

What it implies. The assertion cannot pass without a reload, and a reload defeats the SSE-merge-and-refetch path the scenario exists to cover. A builder under time pressure is likely to add the reload. The correct order: create the share, open the list while the first retry is pending (the row loads with the route's `retry_pending: 1`), and keep it open through the fourth failure. This has been in the plan since revision 2; none of the three reviews caught it.

## 4. [MEDIUM] Task 13's fixtures all share one ledger pair: the `pairsUncounted` case is red by construction

What is wrong. Revision 3 runs every case in one-share mode (plan:2460). That keeps the share counts separate, but every `seedShareWithChain` fixture uses unit `u-1` and contact `c-1`, so the same ledger row `(u-1, c-1)` collects entries across the whole file.

Evidence.
- By the b-4 case (plan:2521-2524), earlier cases have written counted entries for b-1 (delivered) and b-3 (delivered) onto that row.
- The b-4 slot's move to `failed` adds a failed b-4 entry, but `counted` stays true, so `pairsUncounted: 1` cannot hold.
- The case's `seedListingSend` makes this worse. It "calls `putShareMemory` with one counted entry" (plan:1922). The row already carries a `shares_op` token, so the tokenless write fails its `attribute_not_exists(shares_op)` condition (plan:1063-1064) and the seed silently does not happen.

What it implies. The case is red, and the natural fix (a fresh unit per fixture) has to be stated. `seedListingSend` should check its `putShareMemory` result, and its entry's attempt key should be named: `!legacy`, or an ISO key older than the fixture's ROOT, or the uncount rule cannot fire. `seedTwoSlotShare` (plan:2546) is named but never defined. The two-slot case depends on the order of the two originals (an older O2 falls outside c-1's collection, a newer one inside it), and the helper should pin that.

## 5. [MEDIUM] Task 13's dry run projects slots the D2 rule will refuse, so its ledger forecast disagrees with the apply

What is wrong. The census builds the ledger entry from `projectedSlot(slot, decided)` (plan:2600) for every walked slot. The "to move" gate (`wouldApply && !slotRecords`, plan:2590) is not applied to the projection. For a slot the D2 rule refuses - a delivered slot whose newest row reads failed, or a slot already recording a newer attempt - the census projects the move anyway.

Evidence. The b-5 fixture (a delivered slot with a failed newest row) runs only with `apply: true` (plan:2525-2527). There the ledger follows `current` (delivered), so `pairsToUncount` is 0. In a dry run the same slot projects to `failed`, and `ledgerWouldChange` reports an uncount the apply never performs.

What it implies. The dry run is Cameron's go/no-go read (spec D8). It would over-report pairs about to leave "Properties sent" wherever the D2 rule protects a delivery - the fork cases I2 exists for. Project only when the slot is "to move"; otherwise use the slot as it stands. Add a dry-run assertion to b-5.

## 6. [LOW] The reconcile sites log nothing for `'no_slot'`

The webhook logs a retry row whose root matches no slot as ERROR, "a routing bug" (plan Task 5). The two reconcile sites handle only `'no_broadcast'` (a WARN at Site 5) and otherwise ignore `applyLaterAttemptBounded`'s result (plan:1861-1880). The same wrong-root case (a legacy chain past the 16-hop walk) is therefore silent when it arrives through an adoption or an unresolved close. Log `'no_slot'` at ERROR at both sites, as the webhook does.

## 7. [LOW] The `'expired'` record fact measures from the draft's creation, not from the send

`needsRecordRead` tests `share.created_at` (plan:841-845), and revision 3 turns that into `'expired'` -> stranded (plan:574, plan:881). A share's `created_at` is when the draft was created (`broadcastsRepo.ts:654-667`). `markSending` does not change it (`:747-773`). The send-attempt records live 30 days from their own writes (`sendAttemptsRepo.ts:47-48`).

Take a draft created 20 days before it was sent. Its queued slots read stranded 10 days after the send, while their records - which may say "attempting" or "reconciling", i.e. the text may be out - still exist. Those tenants go unflagged early. The spec's own wording, "the share's own timestamp" (spec:241-243), invites this. Measuring from the send is the safer reading, and it is one extra field at `markSending`. If the spec wording stands, file it as a named residual.

## 8. [LOW] Task 10's override is cleared by an overlay that brings back a stale count; the tick handler reads `rows` from a closure

- The trace, with a promise lapsed and no events:
  - A tick sets `tickCount` to 0, and the pill reads Not sent.
  - Any later SSE overlay without a count (another recipient's receipt) merges the PREVIOUS `stats.retry_pending`, which is the route's stale 1.
  - The results effect clears the override (plan:2236), so the pill flips back to Sending until the debounced refetch lands.
- The interval callback calls `setTickCount(rows.filter(...))` (plan:2235). Unless `rows` is read through a ref, the interval sees the rows of its first render. If the effect is instead re-armed on every `rows` change, each refetch restarts the 60 s countdown. Say which.

## 9. [LOW] Task 5's "queued / accepted on a retry row" test never reaches the code it names

The test posts `MessageStatus: 'accepted'` on the retry row (plan:1637-1642). `accepted` maps to `queued` (`app/src/adapters/messaging.ts:677-679`), and `queued`'s only allowed prior is `queued_pending` (`app/src/repos/messagesRepo.ts:138`). The row therefore does not transition, the rollup never runs, and `outcomeOf`'s undefined branch is never exercised. The test is green whatever that branch does. Either drop the test or drive `outcomeOf` directly.

## 10. [LOW] The WITHDRAW-first order: one caveat worth writing down

The coordinator asked whether the order is safe; it is (see below), with one caveat. The redelivery reaches the slot write only after a WITHDRAW that succeeds. A WITHDRAW that keeps losing ("a concurrent writer keeps moving the promise", the 1b pin at `app/test/sendReconcile.test.ts:3703-3715`) sends the check to the DLQ after five tries (`sendReconcile.ts:16-18`), and the slot write never runs. Task 13's record check covers it: the record is `done/unresolved`, so the repair decides `unresolved`. The spec section 8 amendment should name this path too.

---

## Revision-3 material checked and found correct

- **WITHDRAW first, then the bounded slot write** (plan:1873-1880). A thrown or lost WITHDRAW fails the check after the record closed `done/unresolved`. The redelivery takes the superseded exit, because the record is `done` with the same `attemptedAt` (`sendReconcile.ts:518-532`). `slotCloseOf('unresolved')` maps to the SEND_UNCONFIRMED close (`:1315-1318`), which re-enters `closeSlot`'s `retry_send` arm: the WITHDRAW again (`'already'` is a no-op), then the slot write. The only gap is finding 10.
- **`applyLaterAttemptBounded` against a write that committed before the throw.** The slot and the stats are never double-applied: the replay's condition names the pre-write `status`/`latestAttempt`, which the committed write changed, so it is refused. What goes wrong is the side effects, not the state (finding 1). A `'lost'` result (a refused condition past the re-read bound) already logs its WARN inside `applyLaterAttempt` and is D2's accepted residue; it needs no extra retry.
- **The `'expired'` branch** (plan:879-890) fires only for `queued` slots of a non-sending share, and only when the caller asked for records. `priorRecipientKeys` is the only caller that asks (plan:933). The union excludes `stranded`, and the new test pins an old route-failed share unflagged. The composer flag no longer flags a >30-day strand (modulo finding 7's clock).
- **Task 13's chain separation.** A chain is the set of rows whose `retry_of` walk reaches THIS slot's original. The other slot's original has no `retry_of`, and the other slot's retries walk to it. So the delivered exception (the latest delivered row among `[O, ...rows]`) can only pick a row of this slot's own chain. The claim test (`retry_root === O.tsMsgId` only) no longer confuses the two slots.
- **`ledgerEntryForSlot` and `wouldApply`** follow the slot and the D2 rule as intended in apply mode. A delivered slot keeps its counted-by-delivery entry (I2).
- **The landlord relabel** (plan Task 11) now has its own try/catch and a landlord guard after the merge.
- **The list route** passes `unconfirmedKeys` like the results route.
- **The per-recipient `retryPending` flag** carries the read-failure case to the page's tick recount.
