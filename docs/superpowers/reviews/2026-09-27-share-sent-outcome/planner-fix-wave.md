# Share sent outcome - the planner's fix wave (implementer's report)

Date: 2026-09-28. Implementer: Claude Opus 5.5 (one child of the planner).
Branch `feat/share-sent-outcome`, worktree `W:\tmp\share-sent-outcome`.
Scope: `planner-review-adjudications.md` (binding), evidence from
`planner-review-conformance.md` and `planner-review-adversarial.md`. Base of
the wave: aa2f61d6. TDD per item: the test written first and seen red, then
the fix, then green.

## Commits (one per item)

| # | Item | Commit |
|---|---|---|
| 1 | Conformance 2 - the repair leaves an empty-chain failed-30003 slot's ledger row alone | 68cfde58 |
| 2 | Adversarial 2 - `no_slot` ERROR vs new `slot_unmatched` WARN; RUNBOOK re-run list + query | 72325cb3 |
| 3 | Adversarial 5 - the retry job's arms through `applyLaterAttemptBounded` | 8e061e5a |
| 4 | Adversarial 9 - the repair's stale-reconciling bound reads the LAST reconcile delay | 70e49441 |
| 5 | Docs - handback, spec D6/D7, RUNBOOK cap + cost | 9d8368e9 |

## What changed, per item

1. `app/scripts/repair-share-outcomes.ts`: `keepsLedgerRow` - the chain is
   EMPTY and the slot as step 4 leaves it (projected on a census) is `failed`
   30003 on the original itself (`latestAttempt ?? tsMsgId` = the original).
   For that slot step 5 forecasts no entry and writes none (an INFO line
   names it), after the `noContact` check (so `noContact` still counts).
   FOUND WHILE FIXING: a slot stuck `sent` over such a row still MOVES to
   failed 30003, and `applyLaterAttempt`'s own side effect would have written
   the `failed` entry anyway (proven: the moving half of the test is red with
   that line reverted). So the slot write for this class runs with a ledger
   dep that reads no row and writes nothing (`untouchedLedger`); the move
   itself is unchanged. Test (`repairShareOutcomes.test.ts`, b-22 failed /
   b-23 stuck sent, each over `seedListingSend` counted for its share): the
   row is `toStrictEqual` to the seeded one after a dry run AND an apply,
   `counted: true`, its `sentAt`; all six ledger counters 0; b-23 still moves
   (`slotsMoved: 1`). RUNBOOK step 1 (the `brokenLineage` bullet) names the
   class in one sentence.
2. `app/src/services/shareAttemptOutcome.ts`: `ApplyResult` gains
   `'slot_unmatched'`; `missOf` decides the miss. DEVIATION FROM THE LETTER,
   FOR ITS PURPOSE: the scope's WARN case is "a slot for that conversation
   exists but its tsMsgId differs or is absent (the fan-out's record phase
   pending ...)", but a queued slot carries NO `conversationId` in this code
   (`{ status: 'queued' }` from the routes, `broadcastFanOut.ts:541`; the
   record phase writes both pointer fields at once), so a conversationId-only
   test never sees the record-phase case. `missOf` therefore answers
   `'slot_unmatched'` for (a) any slot naming the row's conversation (another
   `tsMsgId` or none - a wrong or unstamped root), and (b) the retry's
   recipient's OWN slot (key = `recipientContactId`) when it is `queued` with
   no `conversationId` (the record phase pending); `'no_slot'` otherwise.
   Callers: the webhook (`rollRetryIntoBroadcast`) logs the scope's exact
   WARN text; both reconcile sites and `markShareUnconfirmed` log the same
   body under their own prefix (`send.reconcile:` / `retrySend:`) - one
   Logs Insights substring (`no matching original pointer`) matches all four.
   `'no_slot'` stays ERROR at all four. Two pre-existing pins moved with the
   rule: the service's `retryRoot: 'other'` case (same conversation) and the
   reconcile's `tsMsgId: 'another-row'` case (same conversation) are now the
   WARN; their ERROR cases were re-seeded on another conversation. Tests: the
   service's results (wrong root, no pointer, queued-by-recipient; `no_slot`
   with no or another recipient); the webhook's WARN for a slot with no
   `tsMsgId`, a wrong root and a queued slot (order and fields asserted, no
   routing-bug ERROR, nothing moves, no emit) and its ERROR for a row on
   another conversation; the reconcile adoption's WARN and ERROR; the job
   arm's WARN and ERROR. RUNBOOK "When to re-run it": the WARN, the
   routing-bug ERROR and `status callback for unknown provider SID after
   retry` (matched by prefix - the stored line carries an em dash) join the
   list and the query.
3. `app/src/jobs/retrySend.ts` `markShareUnconfirmed`:
   `applyLaterAttemptBounded` inside `guardWrite` (the captured result type
   widened with `'threw'`; the docblock says so). Tests
   (`retrySendAttempt.test.ts`): a write that throws ONCE lands
   `send_unconfirmed` (rowless pointer, `unconfirmed: 1`) and the only ERROR
   is the arm's own close line; the pre-existing permanent-throw pin now
   expects three tries and ONE `share slot write failed after retries` ERROR
   (never the guard's `failure-arm write failed`). RUNBOOK: the
   `shareSlotUnconfirmed` label line is described as the guard's backstop.
   The service's bounded-variant docblock names its callers.
4. `STALE_RECONCILING_MS` = `RECONCILE_CHECK_DELAYS_MS[length - 1]` + grace.
   No test asserts the constant (none added: equal on today's schedule, so no
   test could be red).
5. `handback.md`: the issues sentence corrected (and the Issues section's
   "the human resolves at merge"); obligations gain the cap change;
   deviations 12 (e2e (a)'s "will retry" copy) and 13 (a share-id milestone
   with no entry takes the pair words), deviation 11 gains its ledger half
   (item 1); residuals gain the lost-callback class
   (`share-retry-rollup-lost-past-reread-bound`), the flag's record-read cost
   on a route-failed blast, tabs vs pills, the repair's per-slot paging. The
   spec: D7's writer bullet -> "`pending`"; ALSO its sibling sentence "a
   `pending` entry's due instant is read only by D6's words" (the same I5
   contradiction) -> "a `pending` entry's promise is read from its attempt's
   row (I5), only by D6's words"; D6 gains the fallback sentence. RUNBOOK:
   the repair section opens its body with the 1500 -> 1000 cap as a visible
   change Cameron approved (there is no general property-send section); the
   cost paragraph marks "minutes, not seconds" UNMEASURED and says to time
   the dev census (adjudication 8).

## Verification (bare commands, from the worktree; outputs captured, then read)

- `cd app; npx vitest run test/repairShareOutcomes.test.ts
  test/shareAttemptOutcome.test.ts test/twilioStatusWebhook.test.ts
  test/retrySendAttempt.test.ts test/sendReconcile.test.ts` -> `EXIT=0`,
  `Test Files 5 passed (5)`, `Tests 361 passed (361)`; no `[dynamoAdmin]` line.
- `npm run typecheck` -> `TYPECHECK_EXIT=0`.
- `npm run smoke` -> `SMOKE_EXIT=0`: `smoke-dist: OK - 1545 import
  specifier(s) across 268 emitted file(s) resolve under plain Node.`
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts'
  '*.tsx' '*.js' '*.mjs' '*.cjs')` -> `ESLINT_EXIT=0` over 72 files, empty
  output.
- Fence: `git diff aa2f61d6 HEAD -- app/src/jobs/jobs.ts
  app/src/adapters/sqsJobConsumer.ts app/src/services/oneToOneRetryDecision.ts
  app/src/jobs/registerHandlers.ts` is empty.
- ASCII: every added line of the wave strips to 0 bytes.
- NOT run (the planner's final battery): `npm test`, `npm run e2e`.

## For the planner

- Drift: `main` moved one commit past the merge base since the handback
  (`ea7777b8 docs: retire merged share-skip-fix branch`, docs only). Not
  synced (one sync per branch; the planner decides).
- Item 2's widening (b) above is the one place the wave departs from the
  scope's letter; the scope's own parenthetical (the record phase pending)
  is unreachable without it.
- Item 1's moving half (a slot stuck `sent` whose original failed 30003 with
  an empty chain) was not named by the scope; without the no-op ledger the
  slot move would still un-count the legacy row.
