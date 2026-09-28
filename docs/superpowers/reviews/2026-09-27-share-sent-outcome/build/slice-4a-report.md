# Share sent outcome (Branch B) - build slice 4a report (T13)

Date: 2026-09-28. Implementer: slice-4a child (Claude Opus 5.5), dispatched by
the build orchestrator. Worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, base `0150bcd8` (the slice-3 report). Plan:
`docs/superpowers/plans/2026-09-28-share-sent-outcome.md` v5, Task 13 only
(the D8 repair and its RUNBOOK section). Task 14 (the e2e) is not touched.

## Status

DONE - one feature commit, then this report. No STOP condition was hit:
`listByConversation` pages newest-first with an exclusive `before`
(`app/src/repos/messagesRepo.ts:2310-2331`), every record key forms from the
rows (`retryRecipientKey`, `app/src/services/retryChain.ts:59-66`), every
fixture was built with the real repos, the slice 1-3 contracts held, and no
red appeared outside the files this slice touched.

| Commit | What |
|---|---|
| `5005a606` | T13 - `repair-share-outcomes` (census by default, `--apply`), `messagesRepo.stampRetryAttribution` + its double, `ledgerWouldChange` (+ `ledgerRowCounted`, `ledgerEntryCounts`), the RUNBOOK section |

Not run, per the mission: the full `npm test`, `npm run e2e`, `npm run smoke`,
and the script against ANY stack (no lane was booted). Every gate ran bare
from the worktree with output redirected to `.superpowers/sdd/logs/s4a-*.log`
(gitignored) and read after. No `[dynamoAdmin]` line in any s4a log.

## Files touched (all in `5005a606`)

Created:
- `app/scripts/repair-share-outcomes.ts` - the script (header `:1-94`).
- `app/test/repairShareOutcomes.test.ts` - 15 cases against DynamoDB Local.

Modified (the plan's list):
- `app/src/repos/messagesRepo.ts` - `stampRetryAttribution` on the interface
  (`:1573`, doc `:1560-1572`) and the implementation (`:3442`).
- `app/src/services/shareLedger.ts` - `ledgerEntryCounts` (`:94`),
  `ledgerRowCounted` (`:103`), `ledgerWouldChange` (`:133`); `summarize` now
  calls `ledgerEntryCounts` (`:116`, the same rule, one copy).
- `app/test/helpers/twilioWebhookHarness.ts` - the messages double's
  `stampRetryAttribution` (`:1527`).
- `RUNBOOK.md` - "Share outcomes repair (2026-09-28)" (`:368`), right after
  the automation-switch section.

Modified beyond the plan's list (each named, each needed):
- `app/test/shareLedger.test.ts` - the `ledgerWouldChange` unit tests the
  mission names (`:141-205`, four cases incl. a case-by-case parity loop
  against `applyShareLedgerEntry`).
- `app/test/messagesRepoRetryLineage.integration.test.ts` - the real-repo pin
  for `stampRetryAttribution` (`:538`; `UpdateCommand` added to the import).
- `app/test/twilioWebhookHarnessRetryFields.test.ts` - the double's pin
  (`:275`).
- `app/test/scheduledSendSuppression.test.ts:304`,
  `app/test/sendMessage.test.ts:289` - both declare a FULL `MessagesRepo`
  literal, so the new interface method must be there to type-check (one line
  each, the 1b precedent for `annotateRetryPromise`).

In the plan's `git add` list but NOT modified: `app/src/services/shareAttemptOutcome.ts`
- `projectSlot` was already exported by slice 2 (`shareAttemptOutcome.ts:134`).

## Runs

From `app/` unless noted.

- Baseline at `0150bcd8`: `npx vitest run test/stageClient.test.ts
  test/messagesRepoRetryLineage.integration.test.ts test/shareLedger.test.ts
  test/shareAttemptOutcome.test.ts test/twilioWebhookHarnessRetryFields.test.ts`
  - "Test Files 5 passed (5) / Tests 95 passed (95)".
- RED: `npx vitest run test/repairShareOutcomes.test.ts
  test/messagesRepoRetryLineage.integration.test.ts test/shareLedger.test.ts
  test/twilioWebhookHarnessRetryFields.test.ts` - "Test Files 4 failed (4) /
  Tests 6 failed | 42 passed (48)": the repair suite could not load
  (`Cannot find module '../scripts/repair-share-outcomes.js'`); the four
  ledger cases (`ledgerWouldChange` / `ledgerRowCounted` is not a function);
  the real-repo and the double's stamp pins (`stampRetryAttribution` is not a
  function). Every red was the missing code; no pre-existing case went red.
- GREEN (first implementation, same four files): "Test Files 4 passed (4) /
  Tests 63 passed (63)".
- MUTATION CHECK (the suite passed first time, so it was made to bite): two
  deliberate faults in the script - (A) the ledger row read AFTER the slot
  write instead of before, (B) the broken-lineage check disabled - gave
  "Test Files 1 failed (1) / Tests 5 failed | 10 passed (15)" (the apply, the
  un-count, the phone-keyed, the bulk and the broken-lineage cases). The file
  was then restored from a scratchpad copy; sha1 `9b89d568...` identical
  before and after.
- THE MISSION'S GATE: `npx vitest run test/repairShareOutcomes.test.ts
  test/stageClient.test.ts test/messagesRepoRetryLineage.integration.test.ts
  test/shareLedger.test.ts test/shareAttemptOutcome.test.ts
  test/twilioWebhookHarnessRetryFields.test.ts` - "Test Files 6 passed (6) /
  Tests 116 passed (116)" (repair 15, stageClient 29, lineage 18 = 17 + 1,
  shareLedger 16 = 12 + 4, shareAttemptOutcome 24, harness retry fields 14 =
  13 + 1).
- Repo root: `npm run typecheck` - EXIT=0 (all five workspaces; the app's
  three configs incl. `tsconfig.scripts.json` and `tsconfig.test.json`).
- Neighbours of the touched fakes: `npx vitest run test/sendMessage.test.ts
  test/scheduledSendSuppression.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts` - "Test Files 3
  passed (3) / Tests 130 passed (130)".
- Informational (gate 5 stays the orchestrator's): `npx eslint` over the ten
  touched TypeScript files - EXIT=0.
- ASCII: 0 non-ASCII bytes in both new files; 0 in the added lines of every
  modified file (RUNBOOK.md included).
- CLI with NO stack (each exits before any client is built): no arguments,
  `--env dev --lane 3`, `--env local --bogus`, `--env prod --broadcast` (no
  value), `--env dev --apply --apply`, `--env staging` - each printed the
  usage line and exited 2.

## Divergences from the plan's sketches, and why

1. PER-FIXTURE MESSAGE KEYS. A provider SID is global (the `sid#` pointer
   dedupes it across conversations), so the sketch's shared `ROOT`/`R1`/`R2`
   constants would dedupe every fixture after the first into b-1's rows. The
   test mints them per share (`ids(id)`, `repairShareOutcomes.test.ts:72-82`,
   SIDs `SM<id>-root` etc.; timestamps as the sketch) and asserts every append
   is fresh. Units, contacts and conversations are per fixture as the plan
   says.
2. THE LEDGER ROW IS READ BEFORE THE SLOT STEP (`repair-share-outcomes.ts:535`).
   `applyLaterAttempt` writes the ledger itself when the slot moves, so a
   read placed after the slot step (the sketch's `recountPair` position) sees
   that write and counts 0 rows created / 0 re-counted - the plan's own
   "the counters read the row, not the service's return" needs the earlier
   read. Mutation (A) above proves the tests catch the late read.
3. THE APPLY RE-READS THE SLOT AFTER ANY ATTEMPTED MOVE (`:563`), not only on
   `'applied'`: a move the rule refuses on the fresh read (a newer attempt
   landed after the census) then ledgers the slot as it NOW stands; a share or
   slot that vanished leaves the ledger alone with one WARN (`:588-591`).
4. THE FORECAST vs THE WRITE. On an apply the `*To*` ledger counters still
   come from the PROJECTED slot's entry against the before-row (what a dry run
   would say, `:573-586`); the entry written comes from the re-read slot and
   the past-tense counters from the before/after rows (`:592-608`). A created
   row that counts also counts in `pairsToRecount` / `pairsRecounted` (the
   plan's b-1 case expects rowsToCreate 1 AND pairsToRecount 1), which is why
   `ledgerEntryCounts` is exported (`shareLedger.ts:94`).
5. EXTRA EXPORTS in `shareLedger.ts`: `ledgerRowCounted` (the readers' listed
   rule - `counted` not false and a `sentAt`, an absent row not counting; the
   repo's `isListed` is file-private) and `ledgerEntryCounts` (the summary's
   rule, now used by `summarize` itself). `ledgerWouldChange` returns
   `'none'` exactly when `applyShareLedgerEntry` would answer `'refused'`,
   pinned case by case (`shareLedger.test.ts:171`).
6. THE ROW'S OWN `retry_outcome` IS CHECKED BEFORE THE RECORD READ
   (`repair-share-outcomes.ts:460`): the same decision, one fewer read. The
   conversation is read only when the newest row names no contact (only then
   does `retryRecipientKey` need the thread number) and is cached per share
   (`:442-447`, `:462`).
7. A `sent` / `queued` row maps to `{ kind: 'sent' }` with NO carrier instant:
   a message row stores none (slice 2's finding); a failed row without an
   `error_code` maps to `'unknown'`, the live writers' own mapping
   (`twilio.ts` `outcomeOf`, `sendReconcile.ts` `mapAdopted`) (`:417-432`).
8. AN UNKNOWN `--broadcast` ID IS A USAGE ERROR (exit 2, nothing walked),
   following `enable-conversation-automation.ts`'s unknown `--conversation`
   precedent (`repair-share-outcomes.ts:334-336`); a unit-less share given by
   id is walked 0 with an INFO line (the plan's b-11).
9. A CONDITIONAL WRITE LOST PAST ITS RE-READ BOUND ABORTS THE RUN (`:556`,
   `:595`): `applyLaterAttempt` or `applyShareLedgerEntry` answering `'lost'`
   (4 consecutive condition losses to a live writer) throws, so the PARTIAL
   report is logged and the run exits 1 - the plan's "1 on any read/write
   error". A refused move (the rule kept a newer attempt) is NOT an error.
10. THE BULK SCAN IS `ConsistentRead` with an aliased filter
    (`attribute_exists(#unit)`, `:346-354`), so the census reads the same
    truth the apply's consistent reads will; `scanLimit` is the page `Limit`.
11. `RepairOptions` adds `logger?` (the tests capture; the entrypoint uses the
    default); `parseRepairArgs` is exported for the CLI test;
    `resolveTargetForRepair(target, deps, opts)` is a thin named seam over
    `resolveStageClient` (`:626-632`).
12. Test titles with apostrophes use double quotes (the sketch's `''`
    escapes are a syntax error - slice 1's finding).
13. Cases beyond the plan's nine: the reconciling-record triggers (a record
    past the schedule moves the slot, a young one does not) and the row's
    `retry_outcome` trigger with no record at all (`:372`); a phone-keyed slot
    matched by conversation + original with its ledger on the row's recorded
    contact, and a phone-keyed slot on a phone-less thread counting
    `noContact` and `noRecipientKey` while no log line carries the number
    (`:432`); the unknown-id usage error and `reportRepair`'s line (`:454`);
    the PARTIAL report on an injected read failure, nothing written (`:467`);
    bulk mode on a second table prefix with `scanLimit: 1` (paging and the
    unit filter, then an apply and a clean re-census) (`:488`); the CLI
    contract (`:514`). The account-guard case also spies the SEND of both SDK
    client classes' prototypes, not only the test's own doc (`:526`).
14. Review Focus 5 (the case the plan says Task 13 owns): the b-8 fixture
    seeds a ledger row for its own pair, and after `--apply` both the slot and
    that row are `toStrictEqual` to their reads before the run (the row's
    change token included) (`:395-406`).

## The CLI contract as built

`npx tsx app/scripts/repair-share-outcomes.ts --env local|dev|prod [--lane <L>] [--broadcast <id>] [--apply]`

- `--env` required; `--lane <L>` with `local` only (a positive integer: the
  lane's prefix AND its DynamoDB Local key); `--broadcast <id>` walks one
  share; `--apply` writes. Dry run (the census) is the default. Unknown or
  repeated arguments are refused (`parseStageArgs`).
- Target first: `resolveTargetForRepair` runs before any table is read; for
  dev/prod the account guard refuses any account but housingchoice's before
  a client is built, and an ambient `AWS_ENDPOINT_URL*` refuses the run.
- Exit codes: 0 the run completed (dry run or apply); 1 a read or write
  failed, or a conditional write kept losing (PARTIAL report at ERROR first,
  then `FAILED (see the PARTIAL report above)`), or the target could not be
  resolved (`FAILED before the run started (no table was read or written)`);
  2 usage (bad arguments, or an unknown `--broadcast` id). `stage.doc.destroy()`
  runs in `finally`.
- The report (`RepairReport`, `repair-share-outcomes.ts:138-174`):
  `sharesWalked` (unit-targeted shares read), `slotsWalked` (slots not skipped
  and carrying conversationId + tsMsgId), `stampsNeeded` / `stampsWritten`
  (chain rows whose broadcast_id or retry_root is missing or wrong / stamped),
  `slotsToMove` / `slotsMoved` (the D2 rule admits the decided attempt and the
  slot does not already record it / moved), `rowsToCreate` / `rowsCreated`
  (pairs with no ledger row that get one - counted or not), `pairsToRecount` /
  `pairsRecounted` (pairs whose counted flag turns on, a created counted row
  included), `pairsToUncount` / `pairsUncounted` (turns off), and
  `unjudgeable.{originalMissing, brokenLineage, noContact, noRecipientKey}`.
  The `*To*` counters are the census's forecast (printed on an apply too);
  the past-tense ones are the apply's (always 0 on a dry run).
- Logs: ids and counts only; every would-be write logs one INFO line on a dry
  run (`DRY RUN: would stamp ...`, `would move the slot ...`, `would write the
  pair's ledger entry`), with the slot key through `safeRecipientKey`. An
  example final line (from `reportRepair` with sample counters):
  `{"level":30,...,"sharesWalked":3,"slotsWalked":7,"stampsNeeded":2,"stampsWritten":0,"slotsToMove":2,"slotsMoved":0,"rowsToCreate":1,"rowsCreated":0,"pairsToRecount":1,"pairsRecounted":0,"pairsToUncount":1,"pairsUncounted":0,"unjudgeable":{"originalMissing":1,"brokenLineage":0,"noContact":0,"noRecipientKey":0},"apply":false,"msg":"repair-share-outcomes - done (DRY RUN - nothing written; the *To* counters forecast an apply)"}`

## The rehearsal for the orchestrator (on ITS self-QA lane only)

From the worktree root, against a lane the orchestrator booted (never a bare
`--env local`, never dev/prod):

1. `npx tsx app/scripts/repair-share-outcomes.ts --env local --lane <L>`
2. `npx tsx app/scripts/repair-share-outcomes.ts --env local --lane <L> --apply`
3. the census again.

Expected: the first log line `repair-share-outcomes - starting` names
`DynamoDB Local http://localhost:8000 database hclane<L> (e2e lane <L>)` and
prefix `hc-local-<L>-`; each run ends with the `done` line and exits 0. On a
FRESHLY RESEEDED lean lane every counter is 0 (`sharesWalked` 0: the lean
world holds no shares and no ledger rows). After specs have shared under this
branch's code, `sharesWalked` / `slotsWalked` count those shares and every
`*To*` counter should still be 0 - the live writers already keep slots, rows
and the ledger in line (1b stamps every retry row; the webhook, the adoption
and the four unresolved-end sites write the slot and the ledger) - so the
apply writes nothing (every past-tense counter 0). A non-zero `*To*` counter on
such a lane is a live-writer gap worth a look: its ids are on the INFO lines.
`unjudgeable` counts, if any, name their ids too. A `--broadcast <id>` run on a
spec's share reads the same way for one share.

## Sub-threshold worries (for the orchestrator's eye)

1. ROWS FOR UN-COUNTED PAIRS. The plan's rule (and its b-7 case) creates a
   ledger row for every walked failed / pending / unconfirmed slot that has
   none - `rowsToCreate` is not limited to reached recipients, while spec D8
   step 4 names only "a row the pass's swallowed write never created, for a
   reached recipient". Built to the plan. Such rows are `counted: false` with
   no `sentAt`: both readers filter them and the `byContact` index skips them;
   they give D6's milestone its memory. On prod the first apply may create
   many of them - expected, not a fault.
2. A SLOT FAILED AT ITS OWN ATTEMPT WHOSE ROW READS DELIVERED STAYS FAILED.
   The D2 rule treats `failed` as terminal for the SAME attempt; the delivered
   exception covers only OLDER attempts. The message machine cannot move a row
   from failed to delivered, so this needs a slot written failed while its row
   delivered (e.g. an internal-code close racing the send). The census shows
   it as not-to-move with a `failed` ledger entry. Not changed (the rule is
   binding); flagged.
3. THE RECORD CHECK RUNS FOR EVERY NON-DELIVERED NEWEST ROW (the plan's "ONE
   record check"), though only a failed 30003 row can have a next-attempt
   record: one keyed read per such slot, harmless.
4. THE STALE-RECONCILING THRESHOLD IS PRODUCTION'S (4 min + 2 min,
   `repair-share-outcomes.ts:133`). On a lane (2/4/8 s delays) a reconciling
   record under 6 minutes old is not judged unresolved - conservative.
5. WHAT THE CENSUS CANNOT SEE: a retry that went out but never got a row (the
   live adoption closes that gap); `queued` slots (the D2 rule never moves
   from queued - the sweeper's population); unit-less shares (not walked);
   a number that moved to another contact (the ledger lands on the newest
   row's recorded contact - spec D7's named residual). `listByConversation` is
   eventually consistent (the plan's read), so a row appended in the last
   instant can be missed - the live writers own new rows.
6. COST SHAPE: two slots of one share on one thread each page that thread
   (no cross-slot listing cache); a slot whose thread grew long after the
   share pages through all newer rows (100 per Query). The RUNBOOK says
   minutes on prod.
7. `reportRepair` always returns 0: every failure path throws first and exits
   1 from the entrypoint. The `number` return is the plan's contract shape.

## The contract shipped (what T14/T15 consume)

- `app/scripts/repair-share-outcomes.ts`: `SCRIPT_NAME`, `CHAIN_PAGE_LIMIT`
  (100), `STALE_RECONCILING_MS`, `UsageError`, `RepairReport`,
  `RepairOptions` (`doc`, `env`, `apply`, `now?`, `scanLimit?`,
  `broadcastId?`, `logger?`), `runRepairShareOutcomes(opts):
  Promise<RepairReport>`, `reportRepair(report, apply, log?): number`,
  `resolveTargetForRepair(target, deps?, opts?): Promise<StageClient>`,
  `parseRepairArgs(argv)`.
- `MessagesRepo.stampRetryAttribution(conversationId, tsMsgId, { broadcastId,
  retryRoot }): Promise<boolean>` - true written, false no such row (never
  created), anything else throws; mirrored by the harness double.
- `app/src/services/shareLedger.ts`: `ledgerWouldChange(row, broadcastId,
  entry): 'create' | 'recount' | 'uncount' | 'update' | 'none'`,
  `ledgerRowCounted(row): boolean`, `ledgerEntryCounts(entry)` (a type guard).
- RUNBOOK "Share outcomes repair (2026-09-28)" (`RUNBOOK.md:368`) - marked NOT
  YET RUN, owed on dev and prod after the deploy; the agent line is there.
