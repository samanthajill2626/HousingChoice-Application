# Share sent outcome (Branch B) - build slice 2 report (T4, T7, T5, T6)

Date: 2026-09-28. Implementer: slice-2 child (Claude Opus 5.5), dispatched by
the build orchestrator. Worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, base `26d52f43` (the slice-1 report). Plan:
`docs/superpowers/plans/2026-09-28-share-sent-outcome.md` v5, Tasks 4, 7, 5,
6 in that build order.

## Status

DONE - four task commits, one per task, in the build order. No STOP
condition was hit: no importer the plan does not name (one comment-only e2e
line had to change for the empty-grep condition - see Task 7), every 1b site
matched research section B, no Found widening broke a 1b pin, the slice-1
contract held, and no red appeared outside the named pins.

| Commit | What |
|---|---|
| `71a57f58` | T4 - `applyLaterAttempt` (D2), `wouldApply`, `projectSlot`, `applyLaterAttemptBounded`, `originalRowLedgerWrite` |
| `3a68c164` | T7 - `recordPropertySent` writes a ledger ENTRY and a milestone carrying its share id; `recordSend` retired |
| `7a23711e` | T5 - the webhook routes share-retry rows, writes the original row's ledger entry, puts the promise on the emit, re-emits on a withdrawal |
| `ad45ef4a` | T6 - the five 1b sites (the adoption hook, the reconcile's unresolved close and its re-apply, the job's two arms) |

Gates NOT run, per the mission: the full `npm test`, `npm run e2e`. Every
command ran bare from the worktree, output redirected to
`.superpowers/sdd/logs/s2-*.log` (gitignored) and read after. No
`[dynamoAdmin]` line appeared in any slice-2 log.

## Task 4 - `71a57f58`

Files: created `app/src/services/shareAttemptOutcome.ts`,
`app/test/shareAttemptOutcome.test.ts`.

Runs (from `app/`):

- RED: `npx vitest run test/shareAttemptOutcome.test.ts` - "Test Files 1
  failed (1) / Tests no tests", `Failed to load url
  ../src/services/shareAttemptOutcome.js`.
- GREEN: same command - "Tests 24 passed (24)".
- `npm run typecheck` (repo root): EXIT=0. `npx eslint` on the two files:
  EXIT=0. ASCII check on both new files: 0 and 0.

Divergences from the plan's sketch:

1. THE ONE SKETCH LINE THAT CONTRADICTED DEVIATION 15. The sketch test
   expected a re-applied row-less marker to return `'refused'`, while the
   sketch's own implementation (and binding deviation 15) answers a call
   whose slot ALREADY records the write's `next` as `'applied'` from the
   top-of-loop check. The two cannot both hold - a re-applied marker is
   exactly "a fresh call over a slot that already records it". I followed
   deviation 15 and rewrote that assertion
   (`shareAttemptOutcome.test.ts:73`): the re-apply answers `'applied'`,
   makes NO slot write (a spy pins one write in total) and moves no stats.
   The T6 texts that say "a refused no-op" hold in substance: no write, no
   delta; the side effects (a refused ledger write, one emit) re-run.
2. Test titles with apostrophes use double quotes (the sketch's `''`
   escapes are a JS syntax error, the slice-1 finding).
3. Every log line that carries a SLOT key logs `recipientKey:
   safeRecipientKey(contactKey)` (`shareAttemptOutcome.ts:195`, `:225`,
   `:231`, `:248`, `:253`), never the raw key - slice 1's item 5. Pinned by the
   phone-keyed case (`shareAttemptOutcome.test.ts:122`: no line carries the
   number).
4. Exports beyond the block, as the mission asked: `projectSlot`
   (`shareAttemptOutcome.ts:134`, sameAttempt derived from the key compare)
   and `applyLaterAttemptBounded` (`:268`, shipped here rather than in T6;
   T6's commit does not touch the service).
5. Tests added to the sketch's: a lapsed promise (ledger `failed`, count
   unset), a unit-less share (slot moves, no ledger), the lost-condition
   bound (4 writes then ONE WARN with the ids), the SDK-replay path (the
   second, post-refusal already-applied check), the bounded helper (transient
   retried, permanent: 3 tries then ONE ERROR and `'threw'`, a non-throwing
   answer passed through), `wouldApply` / `projectSlot` pins, the original
   row's 30007 `failed` entry, a phone-keyed original row landing on the
   row's recipient contact, and a throwing ledger write (ONE ERROR, never
   propagated). Refusals also pin "no emit, no ledger row".

## Task 7 - `3a68c164`

Files: `app/src/repos/activityEventsRepo.ts` (`broadcastId?` on the input
`:99` and the item `:85`; stored at `:147`), `app/src/jobs/broadcastFanOut.ts`
(`recordPropertySent` `:1222`; `afterSend` passes the record phase's
appended row `:956` -> `:837`; the adoption passes the adopted row with
`delivered` / `accepted` `:1496`; the ledger repo types narrowed to the memory
write `:294`, `:333`, `:1291`), `app/src/repos/listingSendsRepo.ts`
(`recordSend` and `RecordSendInput` deleted, header comment rewritten),
`app/test/helpers/twilioWebhookHarness.ts` (the activity double stores
`broadcastId` `:3073`; the ledger double's `recordSend` deleted), NEW
`app/test/helpers/listingSendSeed.ts` (`seedListingSend` `:14`),
`app/test/broadcastFanOut.test.ts`, `app/test/listingSendsRepo.integration.test.ts`,
`app/test/listingSendsApi.test.ts`, `app/test/contactsBatchReads.test.ts`,
plus three files outside the plan's list, all named here:
`app/test/sendReconcile.test.ts` (the adoption's ledger cases, tests 2 and
2a), `app/test/activityEventsRepo.integration.test.ts` (a real-repo pin for
the stored share id), `e2e/tests/dashboard-next/listing-activity.spec.ts:195`
(a COMMENT that named the retired writer; the task's own condition is an
empty `grep -rn recordSend app dashboard e2e`).

Runs (from `app/`):

- RED: `npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts`
  - "Test Files 2 failed (2) / Tests 8 failed | 260 passed (268)": the
  milestone share id (`:979`), the two new ledger cases, the ledger pin
  (`:1061`), the swallowed-write pin (`:1111`), ADV-6 (`:2567`), and the
  adoption's tests 2 (`:359`) and 2a (`:411`).
- GREEN: `npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts
  test/listingSendsApi.test.ts test/listingSendsRepo.integration.test.ts
  test/seedHistory.test.ts test/contactsBatchReads.test.ts
  test/activityEventsRepo.integration.test.ts
  test/listingSendsRepoShares.integration.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts
  test/contactTimeline.test.ts` - "Test Files 10 passed (10) / Tests 431
  passed (431)" (fan-out 111, reconcile 157, listingSendsApi 16,
  listingSendsRepo.integration 6, seedHistory 40, contactsBatchReads 10,
  activity-events 4 then 5 with the new pin, ledger shares 6, parity 23,
  contactTimeline 58).
- `npm run typecheck`: EXIT=0 (run twice - after the fan-out and after the
  activity pin). `npx eslint` on the 12 touched TypeScript files: EXIT=0.
  `grep -rn recordSend app dashboard e2e`: no output (exit 1). Added lines
  ASCII: 0 in every file.

Divergences:

1. The adoption case the plan sketched into `broadcastFanOut.test.ts` lives
   in `sendReconcile.test.ts` tests 2 and 2a (`:359`, `:411`), where the
   adoption fixtures are: a delivered adoption counts by delivery at the
   adopted row's instant with the milestone's share id; a sent one counts by
   acceptance; test 3 (failed) already pins "no property rows".
2. The "failure callback landed first" case plants the failed entry for the
   slot's own attempt from inside the milestone write (the call just before
   the ledger write) - the attempt key does not exist before the pass runs
   (`broadcastFanOut.test.ts:1018`).
3. `seedListingSend` requires `sentAt` (the plan's signature) and MERGES a
   second seed on the same pair through the row's token (latest counted
   entry wins sentAt/broadcastId, as the service's summary does); a refused
   write throws. `putShareMemory` stamps `via` 'broadcast' if absent, so a
   seeded individual row reads `via: 'broadcast'` - no test asserted
   `individual` on the wire.
4. `listingSendsApi.test.ts`'s old upsert-semantics describe became "a later
   counted share refreshes the attribution and preserves created_at"
   (`:358`); the integration suite's upsert cases became putShareMemory
   create/refresh cases (`listingSendsRepo.integration.test.ts:60`, `:77`).
5. The sendReconcile property-row pins (`:385-387`, `:429-430`, `:456-457`,
   `:1826-1827`, `:1844-1854`, `:1898-1899` at the research cut) count rows;
   none pinned "now", so none changed. `2d` uses `objectContaining`, so the
   milestone's new attribute does not break it.
6. My own comments were reworded so the retired writer's name appears nowhere
   (the grep condition is literal).

## Task 5 - `7a23711e`

Files: `app/src/routes/webhooks/twilio.ts`,
`app/test/helpers/twilioWebhookHarness.ts` (`makeWebhookHarness`'s webhooks
block gains `listingSendsRepo` `:5193`), `app/test/twilioStatusWebhook.test.ts`.

Placement in `twilio.ts`: deps field `:278`; repo `:581`; `shareOutcomeDeps`
`:594`; `promisedAt` from the retry decision right after the status write
`:3488` (never `message.retry_due_at`); `let rolled` hoisted `:3491`, before
the `if (transitioned)` block; the gate `:3558` without its `retry_of`
clause, the retry path `:3561`, the original path `:3563` then
`originalRowLedgerWrite` for a delivered/failed transition `:3577`; the
withdrawal emit `:3676`-`:3717` (deviation 13); `outcomeOf` exported `:3918`;
`rollRetryIntoBroadcast` `:3935` (ONE ERROR `unrouted` for a missing
`retry_root`, ONE ERROR for `no_slot`); `rollIntoBroadcast` `:3975` returns
`{ item, contactKey }` when the slot moved and takes `promisedAt`; the
give-up line `:4029` re-worded in ASCII at WARN; the terminal emit's
`retry_pending: 1` `:4106`.

Runs (from `app/`):

- RED: `npx vitest run test/twilioStatusWebhook.test.ts` - the 12 new cases
  red, every pre-existing case green (`:245`, `:296`, `:344` included).
- GREEN: same command - "Tests 92 passed (92)" (81 before: the skip pin
  removed, 12 cases added).
- Step 4: `npx vitest run test/twilioStatusWebhook.test.ts
  test/twilioWebhookHarnessRetryFields.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts
  test/broadcastApi.test.ts test/sendReconcile.integration.test.ts
  test/shareAttemptOutcome.test.ts` - "Test Files 6 passed (6) / Tests 223
  passed (223)".
- `npm run typecheck`: EXIT=0. `npx eslint` on the three files: EXIT=0.
  Added lines ASCII: 0 in all three.

Divergences:

1. The withdrawal emit fires only when the WITHDRAW itself succeeded (`let
   withdrawn` `:3676`): if the annotate throws, the promise stands until it
   expires, which is what the rollup's count already said. The share read
   for a retry row is guarded on its own (WARN, best-effort) so a failed
   re-read can never be logged as "promise NOT withdrawn".
2. The rollup's catch line (pre-existing, U+2014) is unchanged - it is not a
   touched line; the sketch's re-wording was not needed.
3. `outcomeOf` is pinned with `queued` and `queued_pending`: `accepted` and
   `sending` are not `DeliveryStatus` values (`mapTwilioStatus` folds them into
   `queued`, `app/src/adapters/messaging.ts:665`), so the sketch's
   `outcomeOf('sending', ...)` would not type-check.
4. Fixtures: the test file's share/row builders are the file's own
   (`seedOutbound` with `provider_ts` set so the retry row orders AFTER the
   root - both rows otherwise share a millisecond and order by SID); one
   `seedShares(slot)` builder (`twilioStatusWebhook.test.ts:380` block) seeds
   share b-1, the retry, the orphan (no `retry_root`), the stray root, and
   share b-2 with a phone-keyed slot. Added cases beyond the sketch: a retry
   row's carrier `sent` then `delivered` on the same attempt; an original
   row's 30007 (ledger `failed`, count unset); the original row's give-up
   line at WARN in ASCII; a retry row's enqueue-failure withdrawal (the share
   re-read). The copy-read cases pin the promise's source for both paths.

## Task 6 - `ad45ef4a`

Files: `app/src/jobs/sendReconcile.ts`, `app/src/jobs/retrySend.ts`,
`app/test/sendReconcile.test.ts`, `app/test/retrySendAttempt.test.ts`.
`shareAttemptOutcome.ts` did not change (the bounded helper shipped in T4).

The five insertions (HEAD lines):

- Site 5, the adoption: `sendReconcile.ts:580`, inside `runCheck`'s found arm,
  gated on the retry owner, a string `r.row.broadcast_id` and a found
  `tsMsgId`; it is the arm's FIRST statement and precedes
  `closeFromReconcile(adopted)` at `:582`. Helper `adoptedShareRetry` `:1484`
  (bounded; `no_slot` -> ONE ERROR with the check's `base`); `mapAdopted`
  `:1463`. `Found` gains `tsMsgId?`, `errorCode?`, `carrierSentAt?`,
  `recipientContactId?` (`:414`), set by `adoptRetry` (`:991`-`:1004`: the
  persisted row's key - on a dedupe the first write's -, the provider code,
  `date_sent` as the carrier instant, the send-time contact; on a repair the
  stored row's contact) and by `ownRetryRow` (`:1180`-`:1190`: the row's key,
  code and contact; a stored row keeps no carrier instant).
- Sites 1 and 2, the reconcile's unresolved close and its superseded-exit
  re-apply (`:560` -> `closeSlot`): `sendReconcile.ts:1446`, inside
  `closeSlot`'s `retry_send` arm, AFTER the WITHDRAW at `:1435` and its
  throw-on-failed/lost (unchanged), gated on a string `broadcast_id`; helper
  `unresolvedShareRetry` `:1515` (row-less key, bounded, `no_slot` -> ONE
  ERROR).
- Site 3, the job's second unknown: `retrySend.ts:919`, the first statement
  of `onUnknown`'s `secondUnknownWouldClose` branch (`:916`), before
  `finish(unresolved, second_unknown)` at `:920`.
- Site 4, the job's hand-off enqueue failure: `retrySend.ts:855`, the first
  statement of `handOff`'s catch (`:852`), before
  `guardWrite(closeFromReconcile)` at `:857`.
- Both job sites call `markShareUnconfirmed` (`retrySend.ts:811`): a no-op
  without a share id; `applyLaterAttempt` inside `guardWrite` (label
  `shareSlotUnconfirmed`); repos built lazily (`:337`-`:338` lets, the
  `contactsRepo` idiom).

Ctx gains `listingSends` (`sendReconcile.ts:341`), ONE instance shared with
`adopt.listingSends`; `shareDeps(c)` `:346`. Fence proof:
`git diff --stat 26d52f43 HEAD -- app/src/jobs/jobs.ts
app/src/adapters/sqsJobConsumer.ts app/src/services/oneToOneRetryDecision.ts
app/src/jobs/registerHandlers.ts` prints nothing; `MAX_HOP_COUNT` appears in
no line of the branch diff.

Runs (from `app/`):

- RED: `npx vitest run test/sendReconcile.test.ts test/retrySendAttempt.test.ts`
  - "Test Files 2 failed (2) / Tests 11 failed | 201 passed (212)" - every new
  case except the non-share guard (a regression pin, green before the change
  by construction).
- GREEN: `npx vitest run test/sendReconcile.test.ts test/retrySendAttempt.test.ts
  test/retryChain.test.ts` - "Test Files 3 passed (3) / Tests 237 passed
  (237)" (reconcile 165 = 157 + 8, retrySendAttempt 47 = 43 + 4, retryChain
  25). The must-stay-green pins all pass unchanged: `retrySendAttempt` 1c,
  1d, FW1 C-5 (second unknown), FW1 C-5 (hand-off), 7, 8; the reconcile's
  10a, 10d, 10e, 12, 12c, C-2 (failed/lost), FW2 A1 own-row, 13a, the
  isBroadcastRowFor and holder-naming pins.
- `npm run typecheck`: EXIT=0. `npm run smoke`: EXIT=0 - "smoke-dist: OK -
  1535 import specifier(s) across 268 emitted file(s) resolve under plain
  Node." `npx eslint` on the four files: EXIT=0. Added lines ASCII: 0.

Divergences:

1. `no_broadcast` at the reconcile sites logs ONE line - the transition's own
   WARN (`shareAttemptOutcome.ts:219`) - not a second reconcile WARN beside it
   (the sketch added one). The 10a case pins exactly one
   `broadcast not found` WARN.
2. The job arms ALSO log `no_slot` at ERROR (`retrySend.ts:836`); the sketch
   discarded the job's result. Every other site logs a routing bug at ERROR;
   the ONE-close-ERROR pins use non-share rows and are unaffected.
3. The plan's combined "transient then permanent" adoption case is two cases
   (`sendReconcile.test.ts:4067`, `:4090`): a second share root in the same
   thread would meet the first adoption inside the sibling span.
4. The crash case pins that the re-run hook makes NO slot write (a spy), the
   deviation-15 path, and that the second verdict is the own-row proof
   (`adoption: 'skipped'`, `path: 'lookup'`).
5. Added: the unresolved close's WITHDRAW-before-slot call order (annotate vs
   the slot write), the adoption's `no_slot` ERROR, a hand-off enqueue failure
   whose slot write succeeds (slot before `closeFromReconcile`), and the
   non-share guard at BOTH arms.

## Final verification (after T6)

`npx vitest run` over the 23 suites this slice touched or leans on
(shareAttemptOutcome, broadcastFanOut, sendReconcile, listingSendsApi,
listingSendsRepo.integration, seedHistory, contactsBatchReads,
activityEventsRepo.integration, twilioStatusWebhook,
twilioWebhookHarnessRetryFields, twilioWebhookHarnessRepoAdditions.integration,
retrySendAttempt, retryChain, listingSendsRepoShares.integration, shareLedger,
shareRecipientState, broadcastApi, sendReconcile.integration, contactTimeline,
unitsApiActivity, broadcastsRepoAttemptOutcome.integration, shareAttemptOrder,
deriveBroadcastStats) - "Test Files 23 passed (23) / Tests 776 passed (776)".

## The contract shipped (what Slices 3-4 consume)

`app/src/services/shareAttemptOutcome.ts` (imports repos and libs only):
`type AttemptOutcome` (`:44`); `interface LaterAttempt` (`:57`);
`interface ShareAttemptOutcomeDeps` (`:66`, `broadcasts: Pick<BroadcastsRepo,
'getByIdConsistent' | 'applyAttemptOutcome'>`, `ledger: ShareLedgerDeps`,
`events`, `log`, `now?`); `type ApplyResult` (`:74`); `wouldApply(slot,
{ attemptKey, outcome }): boolean` (`:129`); `projectSlot(slot, { attemptKey,
outcome }): BroadcastRecipient` (`:134` - the slot the transition leaves,
sameAttempt from the key compare; meaningful only where `wouldApply` holds);
`applyLaterAttempt(deps, input): Promise<ApplyResult>` (`:214`);
`applyLaterAttemptBounded(deps, input): Promise<ApplyResult | 'threw'>`
(`:268`); `originalRowLedgerWrite(deps, { share, contactKey, row, outcome }):
Promise<void>` (`:291`). Names and shapes match the plan's block.

`app/src/routes/webhooks/twilio.ts`: `export function outcomeOf(status:
DeliveryStatus, errorCode: string | undefined, promisedAt: string |
undefined): AttemptOutcome | undefined` (`:3918`); `TwilioWebhookDeps.listingSendsRepo?`.

`app/src/jobs/broadcastFanOut.ts`: `recordPropertySent` (file-private)
`args.attempt: { tsMsgId: string; conversationId: string; outcome: 'accepted'
| 'delivered' }`; `AdoptDeps.listingSends` and
`BroadcastSendJobDeps.listingSendsRepo` are `ShareLedgerDeps['listingSends']`
(the memory write only).

`app/src/repos/activityEventsRepo.ts`: `RecordActivityEventInput.broadcastId?`,
`ActivityEventItem.broadcastId?` (stored as a plain attribute).

`app/src/jobs/sendReconcile.ts`: `SendReconcileJobDeps` unchanged in shape
(its `listingSendsRepo` now also feeds the slot write). `app/src/jobs/retrySend.ts`:
`RetrySendJobDeps.broadcastsRepo?`, `listingSendsRepo?`.

`app/test/helpers/listingSendSeed.ts`: `seedListingSend(repo: Pick<ListingSendsRepo,
'getByKeyConsistent' | 'putShareMemory'>, { unitId, contactId, sentAt,
broadcastId? }): Promise<void>`.

Retired: `ListingSendsRepo.recordSend`, `RecordSendInput`, the double's
`recordSend`.

## For the orchestrator's eye (not blocking)

1. Deviation 15 makes every "re-applied" write answer `'applied'` and re-run
   its side effects: a redelivered reconcile check (or a replayed webhook
   post that reaches the rollup) re-emits one `broadcast.updated` and makes
   one refused ledger read. Harmless, but T13's census should count "to move"
   through `wouldApply` + its own `slotRecords`, never through a return of
   `'refused'` (the plan already says so).
2. The job's two arms write the slot even when the record close then LOSES
   (a concurrent writer owns the record) - the spec's "slot first" at arms
   with no re-apply; a later real outcome supersedes the row-less marker
   under the order rule. Stated, as built.
3. An adopted share retry maps a provider `queued`/`accepted`/`sending` to a
   bare acceptance (slot `sent`, no carrier; ledger counted by acceptance) -
   the share adoption's own mapping; receipts then walk the same attempt
   forward through the webhook.
4. `ownRetryRow`'s verdict has no carrier instant (a message row stores
   none), so a re-found delivered row applies `delivered` without one; the
   same-attempt rule keeps the slot's.
5. The webhook's retry path runs `applyLaterAttempt` unbounded: a throw is the
   rollup's existing catch-and-ERROR (spec section 8's named "lost retry
   rollup" residue), as the plan specifies.
6. The rollup catch line (`twilio.ts`, the `broadcast delivery rollup failed`
   ERROR) still carries a pre-existing U+2014; it is untouched context, not a
   touched line.
