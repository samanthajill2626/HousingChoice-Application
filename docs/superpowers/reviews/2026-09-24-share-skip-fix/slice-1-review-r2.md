# Slice 1 re-review (r2) after the fix wave - share-skip-fix, Branch A

- Date 2026-09-25. Branch `feat/share-skip-fix`, HEAD `5a85a01e`. Fix wave `79641c09..HEAD`. Base main@`bbaad87d`.
- Inputs: the fix-wave package, the adjudications, both first-pass reviews, the implementer
  report (D1-D10, N1-N7), and spec D1, D2, D9, I5-I7 and section 8.
- Method: read the whole diff, then swept the live tree. Throwaway files were written only
  under `app/test/zz-review-r2-*`, each run alone against DynamoDB Local, then deleted:
  - an endpoint probe (no network; a finalizeRequest middleware records the host and throws);
  - a mutant copy of the fix script plus a copy of its committed test, run under 6 settings;
  - a mutant copy of the census plus a copy of its committed test.
- No script was run with `--env`. No `npm test` or e2e was run. No tracked file was edited.
  `git status` is clean.
- Result: 0 MUST-FIX, 2 SHOULD-FIX, 7 NOTE.
- Paths: `census.ts` = `app/scripts/conversation-automation-census.ts`, `enable.ts` =
  `app/scripts/enable-conversation-automation.ts`, `stageClient.ts` =
  `app/scripts/lib/stageClient.ts`. Tests are under `app/test/`.

## 1. What the first pass missed (new findings)

### R2-1 SHOULD-FIX - no test covers which evidence wins when a row has both, and that is the shape every real trip has

- Every real trip carries the send counter: the breaker increments the counter before it
  calls setMode (`app/src/services/sendMessage.ts:350-352`).
- Both test fixtures seed the audited trip WITHOUT a counter
  (`conversationAutomationCensus.test.ts:83`, `enableConversationAutomation.test.ts:85`).
  That shape cannot occur in production. So no test covers a row with both an audit event
  and a counter.
- Proof: a census mutant reports any trip that has a counter as `send_counter`. It changes
  one line (`census.ts:240`: `trip !== undefined` becomes
  `trip !== undefined && !hasBreakerSendCounter(raw)`). The committed census test still
  passed against it (1/1).
- Effect in prod if that mutant shipped: EVERY trip would be listed with evidence
  `send_counter` and counted in `breakerTrippedUnaudited`. Each would carry a
  minute-bucket time instead of the event's time. RUNBOOK:355 would then tell Cameron that
  every trip's audit append was lost.
- The fix script has the same untested precedence at `enable.ts:274`.
- Fix: add `outbound_minute_bucket` and `outbound_minute_count` to `c-breaker` in both
  fixtures, and keep the `evidence: 'audit_event'` expectations (census :162, and the dry-run
  exclusion log in the enable test).

### R2-2 SHOULD-FIX - a DynamoDB endpoint in the shared AWS config file still redirects a prod run; the env-var refusal does not see it

This challenges adjudication item 4 (see section 3).

Probe: `resolveStageClient('prod')` with an injected guard and credentials. `AWS_CONFIG_FILE`
pointed at a scratch file, `AWS_PROFILE` unset, `ambientEndpointVariables()` returned `[]`.

| `[default]` in the config file | Request host | `describe` |
| --- | --- | --- |
| no endpoint (control) | `https://dynamodb.us-east-1.amazonaws.com` | AWS us-east-1 account 938565869261 (profile housingchoice) |
| `endpoint_url = http://127.0.0.1:9` | `http://127.0.0.1:9` | the same AWS text |
| `services` section, `dynamodb` only | `http://127.0.0.1:9` | the same AWS text |

- The client is built at `stageClient.ts:152` with only a region and credentials. The
  SDK therefore still reads configured endpoints from the default (or `AWS_PROFILE`)
  profile.
- The guard's STS client is built the same way (`scripts/lib/hcAws.mjs:40`):
  - A GLOBAL `endpoint_url` probably also sends STS to that host. The guard then fails, so
    the run is refused, but only by accident.
  - A `services` section that names only dynamodb leaves STS alone. The guard passes, and
    the census and the fix script read and write another database under a prod label.
    That is the same failure adversarial A-2 found for the environment variables.
- The likelihood is low: it needs such an entry in Cameron's default profile.
- The fix is one line and closes the whole class: pass
  `endpoint: 'https://dynamodb.us-east-1.amazonaws.com'` for dev/prod at
  `stageClient.ts:152`. An explicit client endpoint outranks both the environment and the
  config file. A-2's probe already showed it outranks `AWS_ENDPOINT_URL_DYNAMODB`.
  - Put the endpoint in `describe`.
  - Keep or drop the env refusal.
  - Pin it with this middleware probe as a committed test.
- The implementer's N2 saw this gap, but it was not probed.

### R2-3 NOTE - the new per-row transaction can make the app's own writes to that row fail

AWS documents that a PutItem, UpdateItem or DeleteItem on an item that is part of an
in-flight TransactWriteItems fails with `TransactionConflictException`. The SDK does not
retry that code. Its retry lists include `TransactionInProgressException` but not
`TransactionConflictException`
(`node_modules/@smithy/core/dist-es/submodules/retry/service-error-classification/constants.js`).

Interleaving:
1. The apply sends the transaction for row R (`enable.ts:200`).
2. While it is in flight, the app writes R. Examples: `incrementAutomatedSendCount`
   (`app/src/repos/conversationsRepo.ts:1867`), which catches only
   ConditionalCheckFailed, or an inbound text's conversation update.
3. The app's write is rejected and not retried: that send or that handler errors.

- Before the fix wave, the script's plain UpdateItem could not fail an app write.
- The exposure is tiny: one transaction's latency per row, over mostly idle imported rows.
- DynamoDB Local cannot show it (it serializes requests), so this is not proven here.
- Fix: none required. Optionally add one RUNBOOK line: run the apply in a quiet hour, and
  read a `TransactionConflictException` in the app's error log during the apply window as
  this.

### R2-4 NOTE - RUNBOOK:362 "The `mode_changed` item is the trip" is ambiguous from step 3 on

- After the apply, every enabled conversation's partition also holds a `mode_changed` item
  with `reason: bulk_enable` (to auto). Resumes add `operator_resume` items.
- So a trip investigation on a bulk-enabled row shows two or more `mode_changed` items.
- Fix: "the `mode_changed` item with `payload.reason = breaker_trip` is the trip".

### R2-5 NOTE - an older audited trip hides a later unaudited one

`findBreakerTrip` returns the newest `breaker_trip` event, even when a later resume
exists (`census.ts:161`). Sequence:
1. Row R trips; its event E1 lands.
2. R is resumed (`operator_resume`).
3. R trips again, and that trip's audit append fails.

- Both scripts then report evidence `audit_event` with E1's time.
- `breakerTrippedUnaudited` does not count it.
- The partition's newest `mode_changed` says `to: auto` while the row is manual.
- R is still excluded, so the classification is right; only the evidence and the time are
  wrong.
- Optional fix: read the newest `mode_changed` of any reason. If it is not a
  `breaker_trip`, but the row is manual and has a counter, report `send_counter`.

### R2-6 NOTE - "manual plus counter = tripped" also breaks under a hand rollback, not only under WP2

- There is no rollback tool. A hand `SET ai_mode = manual` (AWS CLI) on rows that sent
  automated texts after the apply would make both scripts read those rows as breaker
  trips, permanently.
- The census would then report their audit event as missing.
- The invariant comment (`census.ts:118-139`) names only WP2.
- Fix: name "any hand switch-off" in that comment and in the RUNBOOK. R2-5's
  newest-event rule would also make such a rollback distinguishable, if it writes an
  event with its own reason.

### Sweeps that found nothing new

- **Writers of `ai_mode` and of the counter.**
  - Only `sendMessage.ts:350` stamps `outbound_minute_bucket`. It runs after the manual
    refusal at :349, in that order since the first breaker commit `590c47be`.
  - Nothing removes the counter.
  - At runtime only the breaker writes `manual` (`conversationsRepo.ts:1832`, called from
    `sendMessage.ts:352`).
  - One-to-one creation writes `auto` (`conversationsRepo.ts:1273`, :1383). Conversation
    ids are `conv-<uuid>`, created under `attribute_not_exists`, so no create overwrites
    an existing row.
  - Group creation writes `manual` (:1941, :2385). The only type conversion is
    relay_group to group_text (:2607).
  - The import:
    - Its one-to-one ids are uuidv5 of the phone.
    - It sets the switch only through `if_not_exists` (`app/src/lib/import/apply.ts:1093`).
    - It has done so since its first commit, `39b736b5`.
  - The seeds write `manual` with no counter. No seed, `app/scripts`, root `scripts`, e2e
    or infra file writes either attribute.
  - The test fakes are in memory.
  - No DynamoDB stream consumer exists.
  - The rule holds at HEAD.
- **The `AuditRepo` return type widened.** Nothing reads it as `ReturnType`/`typeof`
  `createAuditRepo`, and no test mocks `auditRepo`. Services still depend on `AuditRepo`.
- **The `unreadFeed.ts` export.** No `export *` re-export and no name collision. The one
  new importer is the census.
- **Pointer prefixes.** The conversations table holds only `phone#`, `email#` and
  `token#` pointers (`conversationsRepo.ts:510-526`).
- **GSI projection.** It is ALL (`app/src/lib/dynamoAdmin.ts:57`,
  `infra/modules/dynamodb/main.tf:57`), so the census's `findByParticipantPhone` rows
  carry `ai_mode`.
- **Paged Scans.** Keys are never rewritten, so no row is repeated. Rows created
  mid-scan are covered by the re-run and import-window rules. A stale read is either
  counted `alreadyOn` or refused by the condition.
- **Transaction limits.** A transaction has 2 small items, far under 25 items and 4 MB.

## 2. The fix diff, reviewed cold

The transaction:
- **Shape (`enable.ts:201-240`).** Correct. Every value and name is used in both guard
  variants, so there is no unused-value ValidationException. Item 0 is the Update and item
  1 is the Put, as the comment says.
- **Cancellation handling (`enable.ts:243`).** Correct: only `reasons[0] ==
  ConditionalCheckFailed` counts as `skippedOnCondition`. A mutant that skips on ANY
  cancellation is killed by the `:353` test (`rewritten` went to 2 instead of aborting).
- **Idempotency of a retried transaction.** The SDK fills `ClientRequestToken` itself: the
  trait is `[0, 4]` at `client-dynamodb/dist-cjs/schemas/schemas_0.js:2094`, and
  `JsonShapeSerializer` calls `generateIdempotencyToken`. Serialization happens once,
  before the retry step, so SDK-level retries resend the same token. A retried commit
  returns success, never a false `ConditionalCheckFailed`.
- **The ambiguous leftover (NOTE R2-7).** A timeout or 5xx that outlasts the retries aborts
  the run with PARTIAL. That row may still have committed, atomically with its event.
  RUNBOOK:347 "Nothing was written for the row that failed" overclaims for that case. It
  is harmless: a re-run reports the row `alreadyOn`.
- **DynamoDB Local vs real.** Positional CancellationReasons behave the same in both.
  Local models neither TransactionConflict nor token idempotency, so no test can cover
  those two.

The send-counter guard:
- **`planRow` with `hasSendCounter` (`enable.ts:133-142`, :270-279).** Correct in all three
  paths:

  | Path | Excluded at planning | Counter clause on the write |
  | --- | --- | --- |
  | bulk, no flag | yes | yes |
  | bulk with `--include-breaker-tripped` | no | no |
  | single mode | no | no |

  A mutant that ignores the counter at planning fails 6 tests.
- **The bulk condition clause.** A mutant that removes it fails the `:310` test (enabled 2
  instead of 1).
- **With the include flag (NOTE R2-8).**
  - The clause is dropped. A trip that lands DURING the run is therefore switched back on,
    although it was never on the list Cameron reviewed. Spec section 8 accepts that risk.
  - But RUNBOOK:347 says "the bulk write also requires the counter to be absent" without
    "unless `--include-breaker-tripped`".
  - Fix: add that qualifier to RUNBOOK:347.
  - Optional hardening, stronger than the wording fix: guard every enable on the counter
    being UNCHANGED since the read. Use `attribute_not_exists(outbound_minute_bucket)` when
    the read saw none; otherwise require `outbound_minute_bucket = :seen AND
    outbound_minute_count = :seenCount`. That also covers the include flag and single
    mode.

Counters and the CLI:
- **`byType` after the transaction.** Correct. A mutant that counts it before the
  transaction is killed by the `:238` test.
- **PARTIAL arithmetic (NOTE R2-9).** `planned` is incremented before the write
  (`enable.ts:306`). In a PARTIAL report, `planned - enabled` is therefore
  `skippedOnCondition + 1` (test `:393` pins `planned 1, enabled 0, skippedOnCondition 0`).
  RUNBOOK:347 says "the difference is `skippedOnCondition`". That is true only for a run
  that completes.
- **The CLI split and its exit codes** (`enable.ts:362-412`; the census's twin):

  | Case | Exit | What is logged |
  | --- | --- | --- |
  | usage error | 2 | the usage text |
  | pre-run refusal | 1 | "FAILED before the run started" |
  | `UsageError` inside the run | 2 | its message |
  | run failure | 1 | the PARTIAL report above |
  | `failed > 0` | 1 | COMPLETED WITH FAILURES |

  `stage.doc.destroy()` runs in `finally` on every path. No test reaches this code
  (A-7b, deferred).
- **The `--include-breaker-tripped` + `--conversation` refusal.** It is in the CLI (:369)
  and in the function (:178). The function's refusal is proven: a mutant that removes it
  is killed by the `:201` test.
- **The `reportCensus(log)` seam.** Fine.

The audit repo and the tests:
- **The auditRepo refactor.** `buildItem` is byte-for-byte the old `append` item.
  `transactPut`'s `attribute_not_exists(entityKey)` is checked against the item with the
  same FULL key (entityKey, ts). So it guards only an exact collision (the same
  millisecond plus the same 8-hex suffix): "never overwrite", which is what its comment
  says. "One event per enable" comes from the Update's condition, not from this. It is
  correct and effectively inert.
- **The tests' command recorder.**
  - It sees every `doc.send`, including those from repos and `queryAll`.
  - `constructor.name` survives tsx: the dry-run test asserts `toContain('ScanCommand')`
    (:148 region), so the non-read filter is not vacuous.
  - The racing docs use `instanceof` on the same lib-dynamodb classes, and `raced` is
    asserted.
- **The stage resolver's case-insensitive prefix match.** It can refuse a harmless
  variable (`AWS_ENDPOINT_URL_S3`, or an empty variable set in Git Bash). That is the safe
  direction, and the error names the variable. What it misses is R2-2.

## 3. Adjudication challenges

- **Item 4: refuse the env vars rather than pin the endpoint. CHALLENGED** (R2-2, proven).
  The refusal leaves the configured-endpoint path open, and `describe` can still lie. Pinning
  the endpoint is one line, closes the environment AND the config file, and makes the
  target line true by construction.
- **Item 1: the counter is trip evidence. AGREED.** The sweep in section 1 finds no other
  writer at HEAD. Three caveats:
  - The realistic both-evidence shape is untested (R2-1).
  - The evidence can be stale (R2-5).
  - A hand rollback breaks the rule (R2-6).
  - Also worth knowing: every real trip has a counter, so the counter alone classifies
    every trip. The audit Query now only supplies the evidence label and the time (N6).
- **Deferred A-7b (no test from argv to exit code). AGREED**, but items 6 and 8 therefore
  close only on reading the code. The Task 5 lane rehearsal should include:
  - `--env local --lane <L> --env local` (a repeated argument; expect exit 2);
  - `--env local --lane <L> --conversation x --include-breaker-tripped` (expect exit 2).

  The "FAILED before the run started" branch can only be reached through dev/prod, so its
  first real run will be Cameron's.
- **N1 (a TransactionConflict aborts the run). AGREED** for the script side; R2-3 adds the
  app side.
- **A-5, A-6, A-8d and C-F11 (deferred). AGREED.**

## 4. Closure of items 1-14, and the RUNBOOK truth check

Where a mutant was run, the mutated copy was run against a copy of the committed test.

| # | Item | Proving test (`app/test/`) | Mutant result | Verdict |
| --- | --- | --- | --- | --- |
| 1 | send counter = trip evidence | `enableConversationAutomation.test.ts:310` (write clause), :113 (planning + evidence), `conversationAutomationCensus.test.ts:162`, :188 | clause removed: :310 FAILS; planning ignores counter: 6 FAIL | PROVEN (gap R2-1) |
| 2 | one transaction per row | `enableConversationAutomation.test.ts:353` (Local rolls both back), :396 (abort + PARTIAL), :156 (item `ts`, no actorId) | skip on any cancellation: :353 FAILS | PROVEN |
| 3 | repeated args refused | `stageClient.test.ts:162-164` (it.each :148-168) | not re-run; implementer RED | PROVEN |
| 4 | `AWS_ENDPOINT_URL*` refused | `stageClient.test.ts:89` | not re-run; implementer RED | PROVEN for env vars; config gap R2-2 |
| 5a | dry run writes nothing | `enableConversationAutomation.test.ts:113` (recorder + both tables) | implementer mutant | PROVEN |
| 5b | census read-only, 6 tables | `conversationAutomationCensus.test.ts:197-199` | - | PROVEN |
| 5c | claimless import row | `conversationAutomationCensus.test.ts:167` | implementer mutant | PROVEN |
| 5d | type and existence halves | `enableConversationAutomation.test.ts:272` | implementer mutant (type half) | PROVEN |
| 5e | events == enabled | `enableConversationAutomation.test.ts:186` | - | PROVEN |
| 6 | `--lane` with dev/prod; pre-run wording | `stageClient.test.ts:166-167` (parser) | - | parser PROVEN; CLI wording PLAUSIBLE (`enable.ts:383-389`) |
| 7 | `EnableOpts.now` removed | typecheck (implementer); `enable.ts:113-125` has no `now` | - | PROVEN |
| 8 | include + conversation refused | `enableConversationAutomation.test.ts:201` | function refusal removed: :201 FAILS | function PROVEN; CLI half PLAUSIBLE (`enable.ts:369`) |
| 9 | dev client signs with the injected identity | `stageClient.test.ts:69-86` | implementer mutant | PROVEN |
| 10 | unresolvable branches reached | `conversationAutomationCensus.test.ts:180` | implementer mutant | PROVEN |
| 11 | pointer prefixes imported | census `pointerRows` 3; `unreadFeed.test.ts` | refactor | PROVEN |
| 12 | `byType` = actually switched on | `enableConversationAutomation.test.ts:238` | count before the write: :238 FAILS | PROVEN |
| 13 | import window per environment | RUNBOOK:349 | - | TRUE |
| 14 | single-mode `alreadyOn`/`unset` wording | RUNBOOK:364 vs `enable.ts:139-140` | - | TRUE |

Count: 12 proven (1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14), 2 whose CLI half is only
plausible (6, 8), 0 not closed. Item 4 closes what it claimed, but its adjudication is
challenged (R2-2).

### The RUNBOOK section, read as Cameron will read it

Checked against HEAD. These sentences are not wholly true:

- **RUNBOOK:343.** "resolve the tables AND the credentials themselves" is true. The
  endpoint can still come from the shared config file (R2-2).
- **RUNBOOK:347, the counter sentence.** "the bulk write also requires the counter to be
  absent": true only without `--include-breaker-tripped` (R2-8).
- **RUNBOOK:347, "the difference is `skippedOnCondition`".** False in a PARTIAL report,
  where the aborted row is in `planned` (R2-9).
- **RUNBOOK:347, "Nothing was written for the row that failed".** True for a cancellation.
  After a timeout or 5xx the row may be on, with its event (R2-7).
- **RUNBOOK:355, "the trip's own audit append was lost".** A trip whose append is still
  in flight also shows `send_counter` for a moment. R2-5 is the case where a lost append
  is reported as `audit_event`.
- **RUNBOOK:362.** Ambiguous once `bulk_enable` and `operator_resume` events exist (R2-4).

Everything else was checked against the code and is true:
- the flags, including the repeated-argument, `--lane` and `AWS_ENDPOINT_URL*` refusals;
- the exit codes;
- the counter names, `evidence` and `breakerTrippedUnaudited`;
- the one-transaction guarantee;
- the per-environment import window;
- the single-mode wording.

PowerShell 5.1:
- The census and fix-script commands can be typed as written. The `<id>` and `<env>`
  placeholders must be replaced, because a literal `<` is a redirection token.
- The surviving audit-Query recipe is unchanged from the form the first review executed in
  5.1. `ConvertTo-Json`'s default depth (2) covers `{':e':{S:...}}`, `WriteAllText` writes
  no BOM, and `file://C:\...` is accepted by aws.exe.
