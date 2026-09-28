# Plan review r2: share-sent-outcome implementation plan, revision 2

Reviewer: B, continued (read-only; nothing run). Date: 2026-09-28.
Plan: `docs/superpowers/plans/2026-09-28-share-sent-outcome.md` revision 2
(8cab22a1). Inputs also read: `plan-review-r1-a.md`,
`plan-review-r1-adjudications.md`. Code citations are `file:line` at HEAD
8cab22a1 (the code is unchanged since 31ea4e7b); plan citations are
`plan:NNN` in revision 2.

Order of this report: new defects first, then defects in revision 2's own
fixes, then smaller items. At the end is a short list of rev-2 material I
checked and found correct.

Summary: two HIGH findings. (1) The "un-swallowed" reconcile writes now run
BEFORE 1b's WITHDRAW and cannot tell a transient error from a deterministic
one. A deterministic slot-write failure therefore blocks the WITHDRAW for good,
or leaves a retry record `reconciling` behind a DLQ page. (2) Task 2's code and
its own tests disagree on a queued slot whose record was not read. The tested
rule flags a stranded share's whole audience once the share passes 30 days.
Task 13 is still where most of the risk is: four MEDIUM findings on its
decision rule, its report counters, its lineage test and its test isolation.

---

## 1. [HIGH] Task 6's propagating reconcile writes break 1b's close on a deterministic failure (I7; spec section 8's size residual)

What is wrong. Deviation 11 (plan:36) and Task 6 (plan:1683-1684) make the
reconcile's two slot writes "NOT wrapped: a throw propagates". This fixes
round-1 B2 for a TRANSIENT error. It is wrong for a DETERMINISTIC one, and at
Sites 1/2 it is wrong in any case, because of where the write sits.

- Sites 1/2 put the slot write BEFORE the WITHDRAW in `closeSlot`'s
  `retry_send` arm (plan:1684, plan:1795-1802). If the write throws, the
  WITHDRAW never runs in that delivery. The redelivery takes the superseded
  exit (`sendReconcile.ts:528-532`), calls the same write first, throws again,
  and so on. After five failures the check lands in the DLQ
  (`sendReconcile.ts:16-18`). The retried row never gets `retry_outcome:
  'unconfirmed'` or the withdrawn sentinel (`sendReconcile.ts:1366-1370`).
- Site 5 (the adoption hook, plan:1683, plan:1782-1791) throws before
  `closeFromReconcile(adopted)`. With a deterministic error the record stays
  `reconciling` for good: nothing else closes it, and the retry job's gate
  defers on a `reconciling` record (`retrySend.ts:426-445`). A DLQ page follows.

Evidence that the deterministic case is real, not hypothetical. Spec section 8
names it: a share near the old 1500 cap that gains retried slots makes "the
write that crosses [400 KB] throw ... the D2 write fails, is logged, and the
slot keeps its recorded failure" (spec:752-760). DynamoDB answers such a write
with a ValidationException, not a ConditionalCheckFailed, so
`applyAttemptOutcome` rethrows it (plan:484-486). Spec I7: "this branch changes
nothing in the retry job's record, claim or close SEMANTICS" (spec:607-610).

What it implies. The spec's named residual becomes a stuck retry record and an
alarm at Site 5. At Sites 1/2 it becomes a lost WITHDRAW: the one-to-one bubble
keeps "will retry", then after the lapse offers Retry on a text the reconcile
ruled unresolved. That is the double-text path 1b's R5 withdraws the promise to
prevent. The fix, sketched:
- At Sites 1/2, run the WITHDRAW first (or in a `finally`), then rethrow the
  slot error.
- At both sites, propagate only errors a redelivery can fix. A deterministic
  error (ValidationException, item size) is logged at ERROR and the close
  proceeds, as spec section 8 says.

The Task 6 test "a slot write that throws at the unresolved close propagates"
(plan:1727-1731) stubs a throw that never stops. It asserts only the record, so
it passes while the WITHDRAW is never written.

## 2. [HIGH] Task 2's classifier contradicts its own tests, and the rule the tests pin flags a >30-day strand forever (D1)

What is wrong. Revision 2 changed the rule for a queued slot in a finished share
whose record was NOT read. The interface text (plan:563, plan:570) and two tests
(plan:609, `classifyRecipient(share('failed'), q, {}, NOW)` must be
`in_flight`; plan:693-695, `noRecords.get('c3')` must be `in_flight`) say "not
read -> in_flight". The code block was not updated: `if (rec === null || rec ===
undefined) return 'stranded';` (plan:795). As written, Step 4 is red.

The builder can resolve it in two ways, and both are wrong:
- Keep the code. The tests fail, and deviation 12's statement that the routes
  read `in_flight` (plan:37) is false.
- Make "undefined -> in_flight", which is what the tests and the interface say.
  Then `priorRecipientKeys` (which reads records, plan:911) sees an undefined
  record for every queued slot of a share older than 30 days, because
  `needsRecordRead` refuses past `RECORD_READ_BOUND_MS` (plan:823-827). All of
  those slots read `in_flight`, so the composer flags them.

Evidence. Spec D1: "a queued slot in a share older than that (the share's own
timestamp) reads stranded without a read, which is right for the flag's
purpose" (spec:241-245). Also: "Without the record, a route send that truly
failed would keep its whole audience flagged for good" (spec:236-239). No Task 2
test classifies an old share with `recordReads: true`.

What it implies. A route-failed share's whole audience is flagged "Already sent"
on every later share of that property, from day 31 on. That is exactly the
outcome D1's record read exists to stop. The classifier needs three facts, not
two: not read because the caller opted out (`in_flight`, the safe side);
beyond the record's 30-day life (`stranded`); read (the table as specified). A
test must pin the >30-day case under `recordReads: true`.

## 3. [MEDIUM] Task 13 decides the newest row only and rebuilds the ledger from that decision even when the slot refuses it: a delivered recipient can be un-counted (D2's delivered exception, I2)

What is wrong. THE NEWEST ATTEMPT is "the chain row N with the greatest
`tsMsgId`" (plan:2367). THE LEDGER is then written from `decided` for every
walked slot (plan:2370, plan:2488-2490), whatever `applyLaterAttempt` did with
the slot.

Evidence.
- Spec D2's exception: "a DELIVERED receipt applies whatever its attempt's age
  ... this covers only what remains open: 1b's named two-child fork and pre-1b
  chains" (spec:294-304).
- Spec D8 step 3 applies "D2's transition" (spec:547-559).
- I2: "a recorded delivery is never erased" (spec:589-593).
- In a pre-1b fork (automatic R1 delivered, stale-view manual Rm failed, Rm
  newer), the repair decides `failed`. The slot never learned R1 (pre-1b retries
  do not route), so it stays failed. The ledger entry for the share becomes
  `failed` over a seeded `!legacy` counted-by-acceptance entry
  (`mayReplace` allows a newer key, plan:1200). The pair is un-counted although
  the tenant received the property.
- The plan's own fixture b-4 (a delivered slot whose row reads failed, "the slot
  wins", plan:2417) gets a `failed` ledger entry written for its share as well.

What it implies. The repair can remove a property from "Properties sent", drop
the "Already sent" flag and reword the milestone to "Property text failed" for
a text that was delivered. The decision should take any delivered row in the
chain first (D2's exception). The ledger entry should follow the slot's state
AFTER the move, not the decided outcome.

## 4. [MEDIUM] Task 13's report cannot count what it promises, the census previews nothing about the ledger, and re-runs do not converge

What is wrong.
- Apply calls `applyLaterAttempt(shareDeps(repos, log), ...)` (plan:2484). That
  function already writes the ledger entry for the moved slot (Task 4's
  `writeLedger`, plan:1503). `recountPair` then reads the "before" row AFTER
  that write (plan:2490), so for every moved slot it sees the pair already
  counted and its own write refused. `pairsRecounted` and `rowsCreated` stay 0.
  The plan's apply test expects `pairsRecounted: 1, rowsCreated: 1`
  (plan:2400), so it is red.
- The pair counters increment only "when the entry was written" (plan:2370). The
  census writes nothing, so a dry run always reports 0 pairs un-counted and 0
  re-counted. Spec D8 has Cameron run the census first to see these numbers
  (spec:525-532, spec:565-567). The number he most needs to see before
  `--apply` - how many properties vanish from "Properties sent" - is the one the
  dry run cannot show.
- A slot the D2 rule refuses (a delivered slot whose newest row disagrees, as
  b-4) is counted in `slotsToMove` on every run. The RUNBOOK text "a second run
  reports zeros" (plan:2501) is then false.
- `decideNewest` returning `undefined` for `noRecipientKey` skips the whole slot
  (plan:2479-2480). The definition says it only skips the record check
  (plan:2367).

What it implies. The Cameron-facing report is wrong in apply and silent in
census. The repair should pass a ledger-less deps object to `applyLaterAttempt`
and do the ledger step once, from the slot's final state, reading "before"
first. The census should compute the would-be entry with the D7 rule in memory.
`slotsToMove` should exclude slots the D2 rule will refuse.

## 5. [MEDIUM] Task 13's broken-link test marks the other slot of the same share in the same thread as a break

What is wrong. A row "CLAIMS this chain" when `retry_root === O.tsMsgId` OR
`broadcast_id === share.broadcastId`, and a claiming row that does not walk to O
makes the slot `brokenLineage` (plan:2366, plan:2497).

Evidence. One share can hold two slots in one conversation: two contacts on one
phone (`app/src/jobs/broadcastFanOut.ts:1289-1297`, the R2 #18 case). The newer
slot's original carries the same `broadcast_id` and no `retry_of`. Its post-1b
retries carry that `broadcast_id` and `retry_root` = its own original. All of
them "claim" the older slot's chain and none walk to its O, so the older slot
is always unjudgeable. The only rows the `broadcast_id` clause adds beyond the
`retry_root` clause are these false positives: 1b writes `retry_root` on every
retry row it appends, and pre-1b rows carry neither stamp.

What it implies. The spec-named housemate case is never repaired and is
reported as broken lineage. Claim by `retry_root === O.tsMsgId` only, or by
`broadcast_id` only for a row that also has `retry_of` and no `retry_root`.

## 6. [MEDIUM] Task 13's tests assert table-wide counts against one shared per-file database

What is wrong. The integration tests run on the file's database (plan:2361,
plan:2375) with no per-test reset. Several runs are table-wide (no
`--broadcast`).

Evidence.
- Test 4 (plan:2415-2423) runs table-wide after tests 1-3 have seeded b-1 and
  b-2. It expects `slotsWalked` 2; b-1, b-2, b-3 and b-4 make it 4.
- Test 6 (plan:2432-2440) expects `slotsToMove` 0 table-wide. b-4's delivered
  slot disagrees with its failed row on every run (finding 4), so it is at
  least 1.
- The `broadcastsRepo.integration.test.ts` precedent creates tables once in
  `beforeAll` (`:53-70`).

What it implies. Two tests are red by construction. The easy fix, scoping each
run with `--broadcast`, would also hide the non-convergence in finding 4.
Isolate per test (fresh prefix or `beforeEach` table reset) and keep one
table-wide convergence test that expects zeros.

## 7. [LOW] Task 7 deletes `recordSend` without listing ~21 test call sites

Task 7 deletes `recordSend` (plan:1843, plan:1916). Its files and commit list
name `listingSendsRepo.integration.test.ts` and `broadcastFanOut.test.ts` only
(plan:1844, plan:1924). The other callers are `app/test/listingSendsApi.test.ts`
(20 calls, e.g. `:42`, `:43`, `:67`, `:109`) and
`app/test/contactsBatchReads.test.ts:151`. These seed rows and assert on
`sentAt`-ordered reads. Task 3 also adds a case to `listingSendsApi.test.ts`.
The Step 4 grep (plan:1918) will surface them, but the commit leaves them out
and the reseeding needs explicit attempt instants.

## 8. [LOW] Task 9's list route omits `unconfirmedKeys`

The results route and `?view=stats` pass `unconfirmedKeys:
unconfirmedByRow(states, broadcast)` (plan:2061). The list route passes only
`retryPending` (plan:2075). A share whose only recipient's row says the chain
ended unresolved reads Not sent on the list and Not confirmed on its results
page. The list row flips to Not confirmed after its first stats refetch, which
goes through the stats view.

## 9. [LOW] Task 11's landlord relabel is not inside the try/catch the plan says it is

The relabel runs "after `const page = candidates.slice(0, limit)` (:1347)", "inside
the landlord branch's existing try/catch" (plan:2235-2238). That try/catch wraps
only the gather, inside `if (wantMilestone)` (`contactTimeline.ts:1309-1340`).
The merge and slice come after it (`:1344-1347`). As placed, a `getByIds` throw
500s the landlord timeline, and the relabel runs for every contact type unless
a landlord guard is added (the prose asks for one, plan:2251; the code has
none).

## 10. [LOW] Two Task 5/6 tests do not pin what they claim

- Task 6's "a later adoption supersedes the unconfirmed slot the job wrote"
  (plan:1756-1761) cannot happen as written. After the job's second-unknown
  arm the record is `done/unresolved`, so a reconcile check for that owner takes
  the superseded exit (`sendReconcile.ts:518-533`) and adopts nothing. The
  plan's fallback (a service-level case in Task 4) is the only real cover. A
  job-arm supersede needs a takeover (a lost `finish`) set up explicitly.
- Task 5's copy-read guard (plan:1577-1586) covers only the ORIGINAL path. The
  retry-row 30003 case (plan:1571-1576) runs against the harness double that
  mutates the live row in place (reviewer A, r1 finding 1). A retry path that
  read `message.retry_due_at` would stay green.

## 11. [LOW] Task 10's `liveStats` recount can disagree with the route's truth

`liveStats` recounts `retry_pending` from the rows on every render (plan:2109,
plan:2155), not just on the ticker.
- A row whose read failed is `pending` on the route (the safe side, plan:803)
  but has no `retryDueAt`, so the recount says 0 and the pill reads Not sent.
- Between an original-failure SSE overlay and the debounced refetch, the rows
  still show `sent`, so the pill flashes Not sent before Sending.

Using `max(route count, recount)` until the first tick, or recounting from the
route's per-row states, avoids both.

## 12. [LOW] A withdrawn promise after a failed enqueue leaves the list reading Sending

The rollup (and its `retry_pending: 1` emit and `pending` ledger entry) runs
before the 30003 arm enqueues the retry (`twilio.ts:3520-3545` vs `:3567-3655`).
If the enqueue then fails, the arm withdraws the promise and emits only
`message.persisted` (`twilio.ts:3631-3647`). No `broadcast.updated` follows, so a
mounted list keeps its count of 1 and reads Sending until reloaded. Spec D1
lists this case as failed (spec:216-218). D4 accepts list staleness only for a
lapse "with NO event at all ... the job never ran" (spec:405-410).

## 13. [LOW] Text drift the builder will trip on

- The shared-interfaces `originalRowLedgerWrite` (plan:194) has no `contactKey`
  and still picks `retry_due_at`; the task code (plan:1513-1518) takes
  `contactKey` and drops it.
- `ShareLedgerDeps.now` is in the block (plan:177) but not in the service
  (plan:1169).
- The work-map heading says "task ORDER = numbering" (plan:101) while Slice 2
  builds T4, T7, T5, T6 (plan:104).
- Task 5's `outcomeOf` bullet still reads "carrierSentAt: slot's or now? - the
  rollup today stamps nothing on delivered; pass none" (plan:1546): a note to
  self left in a contract.
- Task 13's `noRecipientKey`: skip the record check (plan:2367) or skip the slot
  (plan:2479-2480)?

---

## Checked in revision 2 and found correct

- Task 5's promise source. `oneToOneRetry` is a handler-scoped const at
  `twilio.ts:3452-3461`, in scope at the rollup (`:3520-3545`).
  `decideOneToOneRetry` runs for ANY failed-30003 one-to-one row, retry rows
  included (the cap reads `message.retry_attempt`,
  `oneToOneRetryDecision.ts:125-126`). `updateDeliveryStatus(MessageSid, ...)`
  stamps `runAt` on the row that received the callback (`twilio.ts:3462-3467`),
  so for a retry row `promisedAt` is that row's own `retry_due_at` - the row the
  slot's `latestAttempt` then names. The copy-read test works: the webhook calls
  the world repo through the object.
- Task 6's re-run premises. A redelivered check for a record still `reconciling`
  passes `recordCheck` (idempotent from n or n+1) and re-finds the adopted row
  through `ownRetryRow` (`sendReconcile.ts:1110-1123`, `:1147-1150`). A check
  whose record is `done/unresolved` for its own attempt re-enters `closeSlot`
  through `slotCloseOf('unresolved')` (`:528-532`, `:1315-1318`).
  `runCheck` in the test file propagates a handler throw
  (`sendReconcile.test.ts:244-251`); SQS redelivers handler failures
  (`jobs.ts:210-218`).
- `putShareMemory`'s expression. With nothing to remove, the template ends in
  " REMOVE " and `.replace(/ REMOVE $/, '')` strips it, so no empty clause is
  sent. With something to remove, the regex does not match. REMOVE of an absent
  attribute is legal. The `attribute_not_exists(shares_op)` create condition
  admits an absent row and a seeded row, and makes a concurrent first writer
  lose and re-read.
- The attempt-instant clock. Every key that reaches `ledgerEntryFor` with a
  counted outcome is a real `<ISO>#<SID>`. Provider instants are ISO from the
  adapter (`messaging.ts:632`, `:870`); a row-less marker only ever maps to
  `unconfirmed`; `!legacy` and `!individual` are seeded directly. The seed
  history generator reads raw seed rows, and the tour form's default and the
  `byContact` order use `sentAt` as "latest counted", which the attempt instant
  preserves.
- `mapLimit` is correct (single-threaded index hand-out; per-read failures are
  caught inside `fn`). `recordReads` has exactly one caller that needs records
  (`priorRecipientKeys`, plan:911), and it passes `true`.
- Task 4's `allowed()`/`nextSlot()`: FROM `failed`/`sent` only; a newer attempt
  never inherits `carrierSentAt`; the same attempt keeps it; `pairContact`
  prefers the slot's contact key.
- `getByIds`'s projection (`ProjectionExpression` plus the `#s` alias inside
  `RequestItems`) is a valid BatchGetItem shape. `reachedCount` needs only
  `recipients`.
