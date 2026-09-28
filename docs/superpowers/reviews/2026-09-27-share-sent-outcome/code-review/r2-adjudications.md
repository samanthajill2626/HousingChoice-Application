# Share sent outcome (Branch B) - code review round 2 adjudications

Date: 2026-09-28. Adjudicator: the build orchestrator (Claude Fable 5.1). Tree
`feat/share-sent-outcome` @fa42bf1d (the round-2 record @6916a971). Input:
`review-r2.md` (fresh reviewer: 1 new LOW, 3 LOW fix-diff defects, 1
challenge; every fix-wave-1 fix proven real by revert).

Round 2 found nothing above LOW and no adjudication of round 1 is overturned.
The remaining items are precision; they go into ONE small second wave (a
fresh child), whose delta the orchestrator reviews itself - a third reviewer
round is not warranted for LOW-only precision on a branch whose two rounds
found no HIGH the spec had not already named. That judgment is recorded here
so the handback can be held to it.

| # | Sev | Adjudication |
|---|---|---|
| R2-1 the results route reads the share eventually-consistently, so the list's `?view=stats` refetch at a chain end (and the results page's post-event refetch) can lock in a stale pill with no later event | LOW | FIX: the results route reads the share with `getByIdConsistent` for BOTH views (one item, twice the read units; the 2 s poll while sending pays it too - acceptable for a per-share read). Test: the route calls the consistent read, never the eventual one (spy on the world's repo). |
| R2-F1 the RUNBOOK's binding-order paragraph omits the `slotsFailed` slots, has no rule for an apply that ends `COMPLETED WITH FAILURES`, overstates "the unjudgeable counters" (only `originalMissing` and `brokenLineage` leave a slot), and lists the ledger row among the reads that abort | LOW | FIX (docs): the under-flagged list names the `slotsFailed` slots (permanent causes stay under-flagged on every re-run); an apply that exits 1 closes the window for every slot EXCEPT the ones its ERROR lines name - decide the next blast with that list in hand; `noContact` / `noRecipientKey` slots ARE judged and moved; the consistent reads inside the two write services fail per slot. |
| R2-F2 the repair's per-slot catch treats every write throw alike: no transient retry; a systemic write fault (a missing grant, sustained throttling, rotated credentials) is caught per slot and the walk reads on through every share | LOW | FIX: the slot write goes through `applyLaterAttemptBounded` (two retries on a transient fault, as every other site); a per-slot write failure whose error class the reminder sweep treats as SYSTEMIC (read the sweep's own rule - `RUNBOOK.md:324` names it: rotated credentials, a missing UpdateItem grant, a wrong prefix, sustained throttling - and mirror its error-name set from its script) ABORTS the run with the PARTIAL report and exit 1; every other write failure (the 400 KB `ValidationException`, a `lost` condition) stays per slot. The "left as it is" ERROR text becomes accurate for a committed-then-thrown write (say the slot is re-checked on the next run). Tests: a `ValidationException` on one share continues (existing); an `AccessDeniedException` aborts with the partial report and names the share. |
| R2-F3 deviation 15's replay check misfires in the repair: a pointer-less slot the ORIGINAL row's own rollup wrote equals the repair's ROOT-keyed `next`, so `slotsMoved` counts a move the repair did not make (stats right either way) | LOW | FIX (counter honesty): `slotsMoved` increments only when the re-read slot differs from the census's slot (status, code, carrier instant, pointer); an `applied` that changed nothing logs INFO `already recorded by a live writer` and counts nothing. Test: the reviewer's interleaving (the slot moved by the rollup between the census read and the apply) reports `slotsMoved 0`. |
| C-1 ADV-3: the REJECT stands (D6 governs the milestone's words), but `shareRecipientState.ts:6` and `:94` claim the STRICT reading serves the milestone, which the code does not do | LOW | FIX (comments only): the two comments say the milestone takes D6's words - a live pending entry reads "Property sent" - and that the STRICT reading serves the labels, the counts and the ledger. The handback names the D1/D6 wording conflict for Cameron (the spec's D1 lists "the milestone" among the STRICT readers; D6, the specific rule, reads a live pending entry as sent; the code follows D6). |
| ADV-1 rationale correction (the declined alternative is blocked by D1's un-flagging of final failures, not by I1) | - | ACCEPTED as stated; the handback's ADV-1 line carries the corrected reason. |
| Found-while-fixing 1: the repair never heals a bare-`sent` original whose row reads `sent` (`slotRecords` ignores the carrier instant ADV-5's decision now carries) | LOW | FIX (one clause + a test): `slotRecords` is false when the decision carries a carrier instant and the slot has none; the move carries no stats delta (the persisted buckets do not split `sending`). |
| Found-while-fixing 4: the results page clears `rowsBehindRef` on the fetch's resolve, before the passive effect syncs the ticker's rows, so a tick in that frame recounts from the pre-fetch rows and overrides the route's fresh count for up to 60 s | LOW | FIX (the ADV-7 pattern, contained): the hook keeps its own latest `results` in a ref set synchronously where `setResults` is called, and `recountRetryPending(nowMs)` computes the count from that ref's recipients (`pendingRetryCount` moves into the hook); the component's `rowsRef` and its passive effect go. Behavior otherwise identical; the existing ticker pins must stay green unchanged. If the change grows beyond the hook, the component and their tests, STOP and file instead. |
| Found-while-fixing 2, 3, 5 | LOW | ACCEPT (the reviewer's verdicts): the `PreviewResponse` doc one interface down (fold into G7's file in this wave since it is open anyway - comment only); the other `'30003'` copies are distinct concepts or fenced; the conservative `slotsFailed` after a moved slot converges. |

## The second wave (ONE fresh child, in this order)

1. RUNBOOK (R2-F1, R2-F2's abort rule and the corrected ERROR wording).
2. `app/scripts/repair-share-outcomes.ts` + its test (R2-F2 bounded + systemic abort; R2-F3 honest `slotsMoved`; FWF-1 `slotRecords` instant clause).
3. `app/src/routes/broadcasts.ts` + `broadcastApi.test.ts` (R2-1 consistent read).
4. `app/src/services/shareRecipientState.ts` comments (C-1); `dashboard/src/api/types.ts` `PreviewResponse` doc (FWF-2).
5. `dashboard/src/routes/broadcasts/useBroadcastResults.ts` + `BroadcastResults.tsx` + tests (FWF-4).

Then the orchestrator reads the delta, runs the touched suites, typecheck and smoke, and proceeds to the live self-QA and the final gate battery on the final commit.
