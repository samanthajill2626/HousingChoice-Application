# Plan review r4 (final round): share-sent-outcome implementation plan, revision 4

Reviewer: B, continued (read-only; nothing run). Date: 2026-09-28.
Plan: `docs/superpowers/plans/2026-09-28-share-sent-outcome.md` revision 4
(69661768). Also read: `plan-review-r3-adjudications.md` and the spec's
section 8 amendment. Code citations are `file:line` at HEAD 69661768; the app
code is unchanged since 31ea4e7b. Plan citations are `plan:NNN` in revision 4.

This is the hard cap, so anything left here ships to the build. There is one
MEDIUM finding: revision 4's replay fix covers only half of what it claims, and
its own test is red by construction. The other four findings are LOW.

---

## 1. [MEDIUM] Deviation 15 misses the replay path it names: after a throw, the bounded retry is refused before the already-applied check runs, and the new test is red

What is wrong. Deviation 15 (plan:39) and Task 4 step 6 (plan:1303) say a committed write whose response was lost is recognized as applied, "(the SDK's own retry, or `applyLaterAttemptBounded`'s)". The check lives only in the `!res.applied` branch after `applyAttemptOutcome` (plan:1565-1575). That branch is reached only when THIS call's write came back ConditionalCheckFailed. In practice that is the SDK's internal replay within the same call.

`applyLaterAttemptBounded`'s replay is different (plan:1885-1892). The first `applyLaterAttempt` call THREW, so the bounded helper makes a NEW call. That call re-reads the share at the top of its loop, finds the slot already holding the committed state, and `allowed()` refuses it:
- a `delivered` slot, or a same-attempt `failed` slot, is refused outright;
- a `sent` slot is refused unless the outcome gains a carrier instant.

So the call returns `'refused'` at plan:1559-1560, before any write, and the already-applied branch never runs. The ledger entry and the emit are skipped, which is exactly the round-3 defect on this path.

Evidence. Task 4's new test (plan:1427-1442) is this scenario:
- The first call's write commits and then throws, and the call returns `'threw'`.
- "the caller's bounded retry replays the same input" with a second call. That call re-reads a `delivered` slot and gets `'refused'` from `allowed()`, not the `'applied'` the test expects.
- `x.emitted.length` is 0, not 1.
- No ledger entry exists, because the first call threw before `writeLedger`.

The test cannot pass as written.

What it implies.
- Every thrown-after-commit write at the reconcile sites still drops its ledger entry and its emit. The same happens at the job's arms (`guardWrite` swallows the throw) and at the webhook (its try/catch). The fix repairs only the SDK-internal replay.
- The fix should move to where the refusal happens. At the top-of-loop refusal, when the slot already records THIS attempt's outcome (`latestAttempt === input.attemptKey`, and status/code equal to what the outcome implies, carrier instant aside), run the idempotent side effects and return `'applied'`.
- Duplicate side effects are safe: every duplicate ledger write is a refused no-op under `mayReplace` (see "checked" below, and finding 4 for the one exception), and a second emit is harmless.
- Keep the `!res.applied` branch for the SDK case.

## 2. [LOW] `seedListingSend`'s entry attempt key is still unnamed, and the b-4 uncount depends on it

The round-3 fix gave every fixture its own pair (plan:2509) and still defines `seedListingSend` as "calls `putShareMemory` with one counted entry" (plan:1956), with no attempt key.

The b-4 case (plan:2557-2559) expects the move to `failed` on ROOT (`2026-09-28T11:00:00.000Z#SMROOT`) to un-count the pair, both in the dry run (`pairsToUncount: 1`) and in the apply (`pairsUncounted: 1`). `mayReplace` replaces only a NEWER attempt (plan Task 3). The seed's `sentAt` is the same instant as ROOT (`2026-09-28T11:00:00.000Z`).

A natural key such as `${sentAt}#seed` compares greater than ROOT's key (`#s` (0x73) sorts after `#S` (0x53)). The failed ROOT entry is then OLDER, it is refused, and both assertions go red. Name the key: `LEGACY_ATTEMPT_KEY`, the shape a real legacy row seeds, which sorts before every real attempt.

## 3. [LOW] The refetch-only override now hides a FRESH pending count carried by an overlay until the refetch

Revision 4 clears the tick override only on a refetch (plan:2271). This fixes round 3's stale-count flash, but it creates the mirror case:
- a tick has recounted to 0 (a lapsed promise), and the pill reads Not sent;
- an SSE overlay then carries the rollup's own `retry_pending: 1` for ANOTHER recipient's fresh 30003;
- `tickCount` 0 still overrides it, so the page shows Not sent until the debounced refetch lands.

Fix: clear the override when an overlay CARRIES a count (the rollup's lower bound is a fact, not a stale echo), and keep it when the overlay omits one.

## 4. [LOW] The already-applied branch can move a ledger entry from `pending` to `failed` when two writers reach the same slot state from different facts

`slotEquals` compares status, code, carrier instant and `latestAttempt` (plan:1536-1538), not the promise. Two writers can reach the same `{ failed, 30003, R }` slot:
- the webhook's retry-row receipt carries a live promise, giving a `pending` entry;
- the adoption hook's `mapAdopted` failure has no `retryDueAt` (plan Task 6), giving a `failed` entry.

If they race and the webhook wins the slot, the adoption's refused write finds an equal slot, runs its side effects, and writes `failed` for R. `mayReplace` allows the same attempt to go `pending` -> `failed` (plan Task 3). D6 then reads "Property text failed" while the promise is live.

This needs the adoption and a receipt for the same retry row to race, so it is rare. It is the one case where a "duplicate" side effect is not a no-op. It disappears if the already-applied branch is keyed on this call's own write, which is finding 1's placement.

## 5. [LOW] The deviation 16 wording is slightly off

Deviation 16 says "`markSending`, `markFailed` and every later write stamp `updated_at`" (plan:40). `setRecipient` - the fan-out's deferral and the rollup's two writes - does not stamp it (`app/src/repos/broadcastsRepo.ts:797-843`, `SET recipients.#ck = :rec` only).

The bound still holds: `markSending` stamps `updated_at` at the send start (`:747-773`), and nothing moves it backwards. So the rule is correct and only the sentence needs fixing, so a builder does not "fix" `setRecipient` to match it.

---

## Revision-4 material checked and found correct

- **The already-applied branch's ledger duplicates.** When another writer's equal slot state triggers the branch, the side effect is keyed on the same attempt, and `mayReplace` refuses a same-state duplicate:
  - counted-by-delivery is terminal;
  - counted-by-acceptance over counted-by-acceptance needs `by === 'delivery'`;
  - `pending` over `pending`, `failed` over `failed` and `unconfirmed` over `unconfirmed` are all refused.

  The one non-no-op is finding 4. A duplicate `broadcast.updated` is harmless.
- **The count-less withdrawal emit.**
  - List: the merge keeps the last count. A finished share with a count above 0 refetches its stats; a share still stored `sending` keeps its stored label and needs no count. The finalize emit, also count-less, triggers the refetch once the pass ends.
  - Results page: the overlay keeps the previous count, and the debounced refetch that follows every event replaces it with the route's truth; the tick override is untouched by an overlay.
  - The share is in scope on both paths: `rolled` is hoisted, and a retry row re-reads the share by id.
- **`updated_at` as the record bound.** A bump only turns an `'expired'` (no read) into a record READ. A read of an absent record gives `stranded`, the same answer. A read of a present record gives the record's own truth. The one lag is DynamoDB's TTL deletion, where a lingering record can read in flight; that errs to the safe side (flagged, never pre-checked).
  - A draft PATCH (`setSeedContactIds`, `broadcastsRepo.ts:775-795`) stamps `updated_at`, but a draft holds no slots: create seeds `recipients: {}` (`:667`), and only `markSending` writes them. So no case makes the flag wrong - at most costlier.
- **Task 13's gated projection** (plan:2638-2639). Only a move `wouldApply` admits is projected. A delivered slot with a lying newer row stands as it is, so its dry-run forecast agrees with the apply (the b-5 pins). The per-fixture units and contacts stop the cross-case ledger bleed, apart from finding 2's key. `seedTwoSlotShare` is now defined (plan:2509).
- **Task 10's ref-based interval.** `rowsRef` is kept current by an effect, and the interval reads it without re-arming, so the 60 s cadence is never reset by a refetch.
- **E2E (b)'s new order** (plan:2677). The list opens after the failure is stamped, when the stored-`sent` share exists and reads Sending from the route's count. The final failure's count-less emit then triggers the stats refetch on the mounted row. Expect the row to pass through Sent between each retry's carrier `sent` and its failure; that is spec D1 (a carrier-accepted slot is reached), and the test asserts only the end state.
- **`outcomeOf`'s export and unit pin**, and **`no_slot` at ERROR at the reconcile sites**: both as the round-3 adjudication states.
