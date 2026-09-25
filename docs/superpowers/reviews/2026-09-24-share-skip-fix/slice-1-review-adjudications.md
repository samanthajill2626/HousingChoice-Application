# Slice 1 review - adjudications (share-skip-fix, Branch A)

Date: 2026-09-25. Build orchestrator. Reviewed HEAD `9a8021eb` (Tasks 1-4). Reviewers:
spec-conformance (`slice-1-review-conformance.md`: 0 MUST-FIX, 5 SHOULD-FIX, 6 NOTE) and
plan-blind adversarial (`slice-1-review-adversarial.md`: 0 MUST-FIX, 4 SHOULD-FIX, 4 NOTE).
Gates at that HEAD before the fix wave: `npm run typecheck` 0, `npm run smoke` 0,
`npm test` EXIT=0 (369/191/21/34/13 test files, no `[dynamoAdmin]` line), eslint on the
nine touched files = the two pre-existing `no-explicit-any` only.

Both reviewers converged on the same two mechanisms (the breaker race and the two-write
audit). Every item below is ACCEPT (fixed in the slice-1 fix wave), ACCEPT-WORDING,
DEFER (recorded, not built here) or REJECT with the reason. Cross-references: C = the
conformance report's F-numbers, A = the adversarial report's numbers.

## Accepted - code (fix wave, one fresh implementer)

1. **C-F1 / A-1 - a mid-run breaker trip cannot lose the conditional write; the RUNBOOK,
   the script header and a test claimed it does.** ACCEPT, beyond wording. Two facts
   make the adversarial reviewer's mitigation sound: `outbound_minute_bucket` is stamped
   on a conversation row only by `incrementAutomatedSendCount`, which runs only for an
   AUTOMATED send on an `auto` row (`sendMessage.ts:349-350`, the manual refusal
   precedes the counter); and the only runtime writer of `manual` is the breaker
   (`setMode`, called from `sendMessage.ts:352`; runtime creation writes `auto` for
   one-to-one rows; the import never changes an existing row). So a one-to-one row that
   is `manual` AND carries `outbound_minute_bucket` was tripped, whether or not the trip's
   audit event ever landed. CHANGES: (a) bulk planning treats such a row as
   breaker-tripped (`breakerTrippedExcluded`, named in the log) exactly like an audited
   trip; (b) the bulk write condition, when `--include-breaker-tripped` is NOT given,
   also requires `attribute_not_exists(outbound_minute_bucket)` - the last line of
   defense for a trip that lands between the Scan and the write; (c) the census counts
   those rows under `breakerTrip` and lists them with `evidence: 'send_counter'` (audited
   trips: `evidence: 'audit_event'`), and its done line reports the unaudited count;
   (d) the RUNBOOK step 3, the header and the test are rewritten to say what is true,
   and the test is rebuilt from the breaker's real two writes (setMode, then the audit
   append). Single mode (operator resume) is unchanged: it is the path FOR tripped rows.
   The header states the invariant this rests on (a future UI writer of `manual` - WP2 -
   would have to revisit it).
2. **C-F2 / A-4 - the switch write and the audit write are two operations; a kill
   between them leaves an unaudited switched-on row that a re-run reports `alreadyOn`;
   a systemic audit failure switches every planned row on with no event.** ACCEPT:
   ONE `TransactWriteCommand` per row - the conditional Update plus the audit Put with
   `attribute_not_exists(entityKey)` (precedent: `messagesRepo.ts`,
   `tourRemindersRepo.ts`). The audit item is built by a new exported `auditRepo`
   helper so the key/`ts` format stays in ONE place - which removes the objection the
   plan review recorded when it declined a transaction (`plan-review-r1-adjudications.md`
   item 5). A `TransactionCanceledException` whose first reason is `ConditionalCheckFailed`
   is `skippedOnCondition`; any other transaction failure ABORTS the run (PARTIAL report,
   re-run is safe). `auditFailed`, its test and the RUNBOOK backfill recipe go away; the
   RUNBOOK says the two writes are one transaction. Spec I6 ("audits every change") now
   holds by construction.
3. **C-F3 / A-3 - a repeated argument silently takes the last value (`--env dev ...
   --env prod` targets prod; dev and prod share one account, so the guard cannot catch
   it).** ACCEPT: any value or flag seen twice is a usage refusal; two `it.each` cases.
4. **A-2 - `AWS_ENDPOINT_URL` / `AWS_ENDPOINT_URL_DYNAMODB` in the shell redirect a
   `--env prod` run to another endpoint while the target line still says AWS.** ACCEPT:
   for dev/prod, `resolveStageClient` REFUSES to start when any `AWS_ENDPOINT_URL*`
   variable is set (named in the error), before the guard; a stageClient test pins it.
   The same exposure in `import-apply.ts` / `rail-verify.ts` is pre-existing: filed at
   handback, not fixed here.
5. **C-F4 a-e - four spec clauses under-proved by the tests.** ACCEPT all five: (a) the
   dry run writes nothing = a command-recording client asserting only Scan/Query/Get, or
   whole-table equality of every table; (b) the census read-only test covers all six
   tables the same way; (c) an imported one-to-one row WITHOUT a phone claim in the
   census fixture (`importClaimMismatches` still 1, `importedOneToOneRows` asserted);
   (d) the conditional write's type half and existence half as committed cases (the
   reviewer's probes P3/P4); (e) `mode_changed`/`bulk_enable` events == `enabled`.
6. **C-F8 / A-8a - a pre-run refusal (account guard, STS, `--lane` with dev/prod) logs
   "see the PARTIAL report above" although no run started; `--lane` with dev/prod is a
   usage-class error.** ACCEPT: `parseStageArgs` refuses `--lane` with a non-local
   `--env` (usage, exit 2; `resolveStageClient` keeps its own throw as defense); the CLI
   resolves the stage in its own step and logs "FAILED before the run started" for that
   case.
7. **A-8b - `EnableOpts.now` is never read.** ACCEPT: removed (tests updated).
8. **A-8c - `--include-breaker-tripped` is silently ignored in single mode.** ACCEPT:
   combining it with `--conversation` is a usage refusal.
9. **A-7a - the dev credentials test would pass if the client ignored the injected
   provider.** ACCEPT: assert `await stage.doc.config.credentials()` yields the injected
   identity.
10. **A-7c / C-F9 (part) - the census's `unresolvable` branches are never reached.**
    ACCEPT: fixture rows for a rung whose tour is missing and a tenant with no phone;
    `unresolvable` asserted > 0 accordingly.
11. **A-5 (part) - the pointer-prefix list is a copy of `unreadFeed.ts`'s private
    list.** ACCEPT: export it from `unreadFeed.ts` and import it.
12. **C-F10 - `byType` counts planned rows, so on an apply with condition losses it
    overstates what changed.** ACCEPT (small): on an apply `byType` counts rows actually
    switched on; on a dry run, rows that would be. Documented on the interface.

## Accepted - wording only (same fix wave)

13. **C-F5** - the import-window rule is per environment: between THAT environment's
    apply and the merge, no `import:apply` from `main` into it.
14. **C-F7** - single mode "reports `alreadyOn` (or `unset`: no switch value, which
    already sends) when there is nothing to do".

## Deferred / recorded (not built on this branch)

- **A-5 (rest) / C-F9** - the census's one-to-one rung route copies the job's private
  `resolveReminderTarget` and the `as unknown as` cast hides `resolveUsableGroup`'s
  dependency type. Accepted for a one-time script (the plan's design); recorded in the
  handback as a maintainability note.
- **A-6** - the scripts' import closure (47 modules, via the reminder job) is why the
  pinned ops checkout exists; a leaf module for the three helpers would touch the job
  and is out of scope. Recorded.
- **A-7b** - no test drives argv -> exit code end to end. The Task 5 lane rehearsal is
  that proof for the hand-off SHA; a `main(argv, deps)` extraction is not taken now.
- **A-8d** - imported conversation ids are phone-derived uuidv5 pseudonyms. Spec D1 lists
  ids by design; noted so "never a phone" is not over-read.
- **C-F11** - the rehearsal precedes the hand-off SHA: yes, by construction of Task 5.

## Rejected

None.
