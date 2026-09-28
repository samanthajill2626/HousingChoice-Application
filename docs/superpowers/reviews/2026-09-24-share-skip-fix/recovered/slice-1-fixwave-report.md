> Recovered during cleanup on 2026-09-28 from `.superpowers/sdd/slice-1-fixwave-report.md`. This is the original mission report; its run-state labels and findings describe that stage of the build. See the [closeout record](../README.md) for current status and source provenance. Only ellipsis and checkmark glyphs, where present, were converted to ASCII; the original bytes remain in the preserved artifact archive.

# Slice 1 fix wave - implementer report (run state, not committed)

Worktree W:\tmp\share-skip-fix, branch feat/share-skip-fix. Start HEAD 79641c09, end HEAD 5a85a01e,
base main@bbaad87d. Working tree clean at the end. Nothing ran against any environment: no
`--env local|dev|prod` invocation of either script, no `npm test` / e2e / e2e:session, no AWS
call. Every vitest run was ONE file, foreground, against DynamoDB Local (hc-test-<uuid>- prefixes).
Every commit: bare `git status` read first, MERGE_HEAD checked absent
(`git rev-parse --git-path MERGE_HEAD`), explicit paths only, trailer
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (the branch's existing line).

## Commits

| # | Commit | Subject | Items |
| --- | --- | --- | --- |
| 1 | f0a6fbc0 | fix(ops): the breaker's send counter is trip evidence (slice-1 review item 1) | 1 (code, header, tests) |
| 2 | 1ba49fc0 | fix(ops): switch + audit event in ONE transaction per row (slice-1 review items 2, 12) | 2, 12 |
| 3 | 9405d678 | fix(ops): parser + endpoint guards, pre-run failure wording, test hardening (slice-1 review items 3-11) | 3-11 |
| 4 | 5a85a01e | docs(runbook): automation switch - what the fix wave made true (slice-1 review items 1, 2, 12-14) | RUNBOOK for 1, 2, 12, 13, 14 |

Test paths below are app/test/...; line numbers are at HEAD 5a85a01e.

## Per adjudication item

1. **Send counter as trip evidence** - f0a6fbc0 (+ RUNBOOK 5a85a01e).
   Code: `hasBreakerSendCounter` + the invariant (census.ts:115-142, WP2 named);
   census classification census.ts:236 (evidence audit_event preferred, else send_counter,
   trippedAt = bucket); done line `breakerTrippedUnaudited` census.ts:339; `planRow` takes
   `hasSendCounter` enable.ts:133-142; evidence gathered in bulk only, logged on exclusion;
   bulk-without-include write adds `attribute_not_exists(outbound_minute_bucket)`
   enable.ts:198, :219 (single mode and the include flag do not). Header rewritten
   (enable.ts:15-41).
   Tests: seeded c-counter (manual + bucket '2026-09-25T11:59', no event)
   enableConversationAutomation.test.ts:90; dry run excludes it with `evidence: send_counter`
   :113-142; apply leaves it manual :167; include flag enables it :192-198; single mode
   resumes it :219-222; test (ii) clause test :310 (the breaker's REAL writes via the repo:
   after the Scan setMode auto -> incrementAutomatedSendCount -> setMode manual; the audit
   append lands right after the run's trip Query for that row) -> skippedOnCondition 1, row
   manual, events ['breaker_trip'] only; test (iii) renamed :238 ("a row switched ON
   elsewhere mid-run ..."). Census: c-counter conversationAutomationCensus.test.ts:88, listed
   `evidence: 'send_counter'` :163, breakerTrip 2, its rung under oneToOneBreakerTripped 2,
   done line :188.
   RED SEEN: enable file exit 1, "5 failed | 3 passed (8)"; the clause test:
   `- "enabled": 1, "planned": 2, "skippedOnCondition": 1` / `+ "enabled": 3, "planned": 3,
   "skippedOnCondition": 0` (c-import and c-counter switched back on). Census exit 1:
   `- "breakerTrip": 2 ... "other": 2` / `+ "breakerTrip": 1 ... "other": 3`.
2. **One transaction per row** - 1ba49fc0 (+ RUNBOOK 5a85a01e).
   auditRepo: private `buildItem` (auditRepo.ts:81) used by `append` (:109) and the new
   `transactPut` (:114) returning `{ TableName, Item, ConditionExpression:
   'attribute_not_exists(entityKey)' }`; see deviation D1 for where it lives. enable():
   ONE `TransactWriteCommand` (enable.ts:201), item 0 the conditional Update, item 1
   `audit.transactPut(...)`; `TransactionCanceledException` with
   `CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'` -> skippedOnCondition
   (enable.ts:243), anything else rethrows -> PARTIAL + abort; `conversation switched on`
   logged only after success. `auditFailed` removed from EnableResult and reportEnableRun
   (exit 1 only on failed > 0); RUNBOOK backfill recipe deleted (read-only audit Query kept).
   Tests: :353 NEW - DynamoDB Local itself refuses the audit half (Put condition rewritten to
   attribute_exists) -> TransactionCanceledException with reasons ['None',
   'ConditionalCheckFailed'], both rows still manual, only the seeded breaker_trip event, no
   "switched on" line, PARTIAL {planned 1, enabled 0}; :396 thrown non-cancel error from the
   transaction -> rejects 'transact-boom', rows manual, no mode_changed beyond the seed,
   PARTIAL logged (see D2); apply test pins the written item's `ts` format and no actorId
   (:183-184); dry-run test pins reportEnableRun exit 1 only on failed (:151-153).
   RED SEEN: exit 1, "3 failed | 5 passed (8)": :353 `expected +0 to be 1` (no transaction
   sent); :396 `promise resolved ... instead of rejecting`; plus item 12's red below.
   DynamoDB Local accepted the transaction shape and returned positional
   CancellationReasons (no stop condition hit).
3. **Repeated arguments** - 9405d678. stageClient.ts:182. Tests stageClient.test.ts:162-164
   (repeated --env, repeated --conversation, and a repeated flag - D4).
   RED SEEN: `expected { target: 'prod', ... } to deeply equal { usage: true }` and the same
   for the other two.
4. **AWS_ENDPOINT_URL*** - 9405d678. `ambientEndpointVariables` stageClient.ts:99 (keys
   compared case-insensitively), refusal before the guard :135. Test stageClient.test.ts:89
   (it.each over AWS_ENDPOINT_URL_DYNAMODB and AWS_ENDPOINT_URL; dev AND prod reject with
   the exact name, guardCalls 0, local lane unaffected; env restored in finally).
   RED SEEN: `promise resolved "{ ...(6) }" instead of rejecting` for both names.
5. **Test gaps a-e** - 9405d678.
   a. Dry run behind a command recorder + whole-table equality (conversations,
      audit_events): enableConversationAutomation.test.ts:113-151 (:148 the read-only
      assertion). Green on arrival (pins existing behavior). MUTATION SEEN: a dry run that
      writes `SET mutant_probe` -> `expected [ 'UpdateCommand', ...(3) ] to deeply equal []`.
   b. Census behind the recorder: only reads (:197) AND the set of tables touched equals all
      six (:198), plus before/after equality for all six tables (:199). Green on arrival; no
      separate mutation run (same recorder mechanism as 5a).
   c. Claimless imported one-to-one row c-import-noclaim; importedOneToOneRows 3 (:167),
      importClaimMismatches still 1. Green on arrival. MUTATION SEEN: counting a missing claim
      as a mismatch -> `expected 2 to be 1` at :168.
   d. :272 it.each 'turned into a group thread' / 'deleted' between the Scan and the write
      -> skippedOnCondition 1, row manual (group) / absent (deleted, never resurrected), no
      event. Green on arrival. MUTATION SEEN: type half admitting group_text -> the group
      case failed (enabled 2). The existence half cannot be isolated by a mutant
      (`ai_mode = :manual` also fails on a missing item), so that case pins the OUTCOME.
   e. bulk_enable events across the audit table == enabled (:186). Green on arrival; no
      mutation run.
6. **--lane with non-local --env; pre-run failure wording** - 9405d678. Parser
   stageClient.ts:194 (resolveStageClient keeps its throw). Both CLIs resolve the stage in
   their own step: census.ts:368 and enable.ts:386 log `FAILED before the run started`; the
   run's own failure keeps "see the PARTIAL report above" (fix script) / "FAILED (read-only:
   nothing was written)" (census). Tests stageClient.test.ts:166-167; the existing :53
   resolveStageClient throw test kept. RED SEEN: `expected { target: 'dev', lane: 3, ... }
   to deeply equal { usage: true }` (and prod). The CLI step itself is not unit-testable
   (A-7b deferred); CLI usage path smoke under tsx: both scripts exit 2 with usage.
7. **EnableOpts.now** - 9405d678. Removed; every `now:` argument to
   enableConversationAutomation removed from the tests (census keeps its `now`). No red
   possible (a removal); `npm run typecheck` 0 proves no caller passes it.
8. **--include-breaker-tripped with --conversation** - 9405d678. UsageError enable.ts:178-182;
   CLI usage refusal (exit 2) in the parse branch. Test
   enableConversationAutomation.test.ts:230-235. RED SEEN: `promise resolved "{ scanned: 1,
   ... }" instead of rejecting` - single mode had switched c-import ON with the flag ignored.
9. **Dev client signs with the injected identity** - 9405d678. stageClient.test.ts:83-85.
   Green on arrival (the code already did it). MUTATION SEEN: factory still called, client
   built from a static identity -> `expected 'MUTANT' to be 'AKIAFAKE'`.
10. **Unresolvable rungs** - 9405d678. Rung for 'tour-missing' + tenant ten-nophone (no
    phone) with a self_guided tour; `unresolvable: 2` (conversationAutomationCensus.test.ts:180).
    Green on arrival. MUTATION SEEN: no-phone bucketed as oneToOneSwitchedOff ->
    `- oneToOneSwitchedOff 2 / unresolvable 2` vs `+ 3 / 1`.
11. **Pointer prefixes** - 9405d678. `export` added at unreadFeed.ts:108 (nothing else in that
    file changed); census `isPointerRow` uses it (census.ts:114); the census's own
    POINTER_PREFIXES removed (no other importer; the fix script imports isPointerRow). No red
    (refactor); unreadFeed.test.ts 26/26.
12. **byType = actually switched on** - 1ba49fc0 (increment after the transaction succeeds;
    dry run counts would-be rows; interface doc says so). Tests
    enableConversationAutomation.test.ts:268 (race: `{ '(none)': 1 }` while planned 2) and
    the apply test (:160-161). RED SEEN: `expected { unknown_1to1: 1, '(none)': 1 } to deeply
    equal { '(none)': 1 }`.
13. **Import window per environment** - 5a85a01e, RUNBOOK step 5.
14. **Single-mode wording** - 5a85a01e, RUNBOOK resume paragraph (`alreadyOn` or `unset`).

## Verification at HEAD 5a85a01e (verbatim exit codes)

Vitest, one file per run (`cd app && npx vitest run <file>`):
- test/stageClient.test.ts EXIT=0, Tests 27 passed (27)
- test/conversationAutomationCensus.test.ts EXIT=0, Tests 1 passed (1)
- test/enableConversationAutomation.test.ts EXIT=0, Tests 10 passed (10)
- test/unreadFeed.test.ts EXIT=0, Tests 26 passed (26)
- test/setup/dynamoAccessKeyGuard.test.ts EXIT=0, Tests 15 passed (15)
- test/m14.integration.test.ts EXIT=0, Tests 11 passed (11) - run in place of
  `test/auditRepo*.test.ts`, which does not exist (`ls test | grep -i audit` is empty); this
  suite pins append's actorId hoist, which moved into buildItem.

Root gates (bare, output to a file, never piped):
- `npm run typecheck` EXIT=0
- `npm run smoke` EXIT=0 (`smoke-dist: OK - 1413 import specifier(s) across 248 emitted file(s) resolve under plain Node.`)
- `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`
  (11 files) EXIT=1, exactly the two pre-existing errors:
  ```
  W:\tmp\share-skip-fix\app\test\importApply.integration.test.ts
    745:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
    824:59  error  Unexpected any. Specify a different type  @typescript-eslint/no-explicit-any
  2 problems (2 errors, 0 warnings)
  ```
- CLI usage path under tsx: `enable-conversation-automation.ts --env staging` EXIT=2,
  `conversation-automation-census.ts` (no args) EXIT=2, usage printed, no env resolved.

ASCII (`git diff -U0 bbaad87d..HEAD -- <file> | grep '^+' | grep -v '^+++' | tr -d '\11\12\15\40-\176' | wc -c`):
0 for all nine touched files - census.ts, enable.ts, stageClient.ts, unreadFeed.ts,
auditRepo.ts, the three test files, RUNBOOK.md.

## Deviations from the adjudication / brief, and why

- D1. `transactPut` lives on `AuditRepoWithTransactPut extends AuditRepo` (what
  `createAuditRepo` now returns), not on the `AuditRepo` interface itself. Four test fakes
  declare `: AuditRepo` object literals (test/contactCapture.test.ts:243,
  test/helpers/twilioWebhookHarness.ts:2191, test/sendMessage.test.ts:310,
  test/scheduledSendSuppression.test.ts:351) and would each fail typecheck; AuditRepo is the
  injection seam for ~40 services, and a builder there would let a service depend on a fake's
  item shape. No `ReturnType<typeof createAuditRepo>` exists, so the wider return type
  touches no caller.
- D2. The brief's "replace the lost-audit test with a thrown non-cancel error" and "convert
  the WRITE-failure test to intercept TransactWriteCommand" had identical setups: they are
  ONE test (:396) carrying both sets of assertions. Added :353, where DynamoDB Local itself
  refuses the audit half - the only proof that the switch actually rolls back (a thrown JS
  error never reaches DynamoDB).
- D3. Item 1 test (ii) replays the breaker's real writes through the real repo (setMode auto
  elsewhere, incrementAutomatedSendCount, setMode manual; the audit append after the trip
  Query) rather than a bare counter stamp - satisfies the brief (counter stamped, row left
  manual) and the adjudication ("rebuilt from the breaker's real two writes").
- D4. Item 3: a third it.each case (a repeated FLAG) beside the two named ones.
- D5. Item 4: both variable names, both dev and prod; names matched case-insensitively
  (Windows env names are case-insensitive to the SDK too). The error names each variable.
- D6. `reportCensus` gained an optional `log` parameter (default: the module logger) so the
  done line's `breakerTrippedUnaudited` is testable.
- D7. auditRepo's moved M1.4 comment had two non-ASCII characters (a section sign and an em
  dash); moved lines count as added, so they became "section 9" and "-".
- D8. Item 12 is in commit 2 (it lives in the transaction's success path), not commit 3.
- D9. RUNBOOK beyond items 1/2/12-14: documented the new refusals (repeated arguments,
  `--lane` with dev/prod, `AWS_ENDPOINT_URL*`, "FAILED before the run started"), the census
  and dry-run `evidence` field, and moved the PS 5.1 temp-file note onto the surviving audit
  Query recipe (it pointed at "the same temp-file form as step 3", whose recipe was deleted).
- D10. The transaction path does not emit auditRepo's `audit event appended` line
  (transactPut builds only); `conversation switched on` after success is the record.

## Noticed, not changed

- N1. A `TransactionConflict` cancellation (another write to the same conversation row, e.g.
  an inbound message, in flight during the transaction) aborts the whole run (PARTIAL,
  re-run idempotent) - the brief's "any other failure aborts". No retry was added; on a busy
  prod table this could make an apply need a re-run.
- N2. A shared-config `endpoint_url` (the `[default]` profile, `AWS_PROFILE`'s profile, or a
  `services` section) can still redirect the dev/prod DynamoDB client; only the environment
  variables are refused. An explicit dev/prod `endpoint` (adversarial A-2's first option)
  would close it; not built (the adjudication chose the refusal).
- N3. app/scripts/backfill-unread-flag.ts:60 keeps its own POINTER_PREFIXES copy (out of
  scope; could now import POINTER_PARTITION_PREFIXES).
- N4. The census's third unresolvable branch (phone present, no one-to-one conversation) is
  still not reached by a fixture; the adjudication named two of the three.
- N5. Item 6's CLI step and item 8's CLI refusal need a valid `--env` to reach, so no run here
  exercised them; the Task 5 lane rehearsal is their first real run.
- N6. The census queries the audit partition even when the counter is present (to prefer
  `audit_event` evidence and its exact time): one extra Query per tripped row, harmless.
- N7. Pre-existing and filed at handback per the adjudication: the same ambient-endpoint
  exposure in import-apply.ts / rail-verify.ts.
