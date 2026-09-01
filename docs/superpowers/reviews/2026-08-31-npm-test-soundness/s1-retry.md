# S1 - dynamoAdmin control-plane retry + acceptance suite

Slice S1 of M7 "npm test soundness" (spec item 1A, plan S1.0-S1.5).
Branch `feat/npm-test-soundness`; slice base `ca9cc12f`, code commit `de7288e8`.

Files changed: `app/src/lib/dynamoAdmin.ts`, `app/scripts/db-update-gsis.ts`,
new `app/test/dynamoAdminRetry.test.ts`. Nothing else was touched.

## S1.0 - the enumeration, re-run live

The spec's command was re-run against this worktree. **31 hits: 30 under
`app/`, 1 under root `scripts/`, zero under `e2e/`.** The result matches the
worklist's table (`.superpowers/sdd/worklist.md` section 1) hit for hit,
including every line number, so the plan's dispositions were applied as
written. Six sends changed:

- COVERED and changed: `app/src/lib/dynamoAdmin.ts:88` (CreateTable),
  `:129` (DescribeTimeToLive pre-send guard), `:133` (UpdateTimeToLive),
  `:146` (DeleteTable), `app/scripts/db-update-gsis.ts:228` (UpdateTable).
  Those five are pre-change line numbers.
- Everything else: unchanged, per the READ / TEST rules.

**Disposition flags the rule does not reach - recorded, not fixed:**

| hit | site | why it is a flag |
|---|---|---|
| 3 | `app/src/lib/dynamoAdmin.ts:89` | SDK waiter, not a send. Plan S1.3 says "unchanged"; the spec's rule speaks only of sends and reads. Left unchanged. |
| 7, 8 | `app/scripts/db-create.ts:64`, `:76` | `waitUntilTableNotExists({maxWaitTime:60})` on the teardown path. The spec records these as pre-existing and out of scope. Untouched. |
| 13 | `app/scripts/db-update-gsis.ts:234` | SDK waiter; plan S1.4 leaves it. Untouched. |
| 28 | `app/test/unreadIndexRepo.integration.test.ts:729` | `waitUntilTableExists` right after the `:728` CreateTable the plan forbids touching. **Named nowhere in plan or spec.** Untouched, both lines. |
| 31 | `scripts/wipe-dev-data.mjs:170` | root `scripts/`, `.mjs`, targets the AMBIENT (human) dev env. The disposition rule never mentions root scripts at all. **Genuinely unclassified.** Untouched. |

28 and 31 are the two the orchestrator has to decide on; the rest are
pre-decided by plan or spec.

## S1.1 - the RED run (before any source edit)

`cd app; npx vitest run test/dynamoAdminRetry.test.ts` -> exit 1,
**11 failed / 6 passed of 17**, 540ms of test time.

| case | red result |
|---|---|
| 1 | FAIL - promise rejected InternalFailure instead of resolving |
| 2 | FAIL - promise rejected InternalFailure instead of resolving |
| 3 | pass - it asserts TODAY's hot path (exists, zero DescribeTable); it is a regression guard, and passing before the change is correct |
| 4 | FAIL - promise rejected InternalFailure instead of resolving |
| 5 | FAIL - promise rejected InternalFailure instead of resolving |
| 6 | FAIL - promise rejected InternalFailure instead of resolving |
| 7 | pass VACUOUSLY - with no retry the original error propagates and UpdateTimeToLive is sent once, which is what the case asserts |
| 8 | FAIL - promise rejected InternalServerError instead of resolving |
| 9 | FAIL - promise rejected InternalFailure instead of resolving |
| 10 | FAIL - expected 1 to be 4 (one send, no bound to observe) |
| 11 | pass VACUOUSLY - "no retry" and "today's behaviour" are the same run |
| 12 | pass VACUOUSLY - same |
| 13 | FAIL - `isLocalDynamoEndpoint is not a function` |
| 14 | FAIL - `isLocalDynamoEndpoint is not a function` |
| 15 | pass - the EXISTING `sendWithInternalFailureRetry` already satisfies it; that is the point of the case |
| 16 | pass - same |
| 17 | FAIL - `pollUntilTableActive is not a function` |

The six pre-existing passes are all accounted for and none of them is a case
whose behaviour this slice introduces. Cases 15/16 each took ~250ms in the red
run - the OLD retry's hard-coded `attempt * 250` backoff ignoring the injected
schedule - and drop to ~0ms once the seam is threaded, which is an incidental
but useful confirmation that `ensureGsis` really is on the shared helper now.

## S1.5 - verify

All six commands run BARE, foreground, one at a time, output captured.

| command | exit | result |
|---|---|---|
| `npx vitest run test/dynamoAdminRetry.test.ts` (app) | 0 | 1 file passed, **17 passed (17)**, 234ms tests / 1.34s |
| `npx vitest run test/dynamo.integration.test.ts` (app) | 0 | 1 file passed, 2 passed (2), 322ms / 1.27s |
| `npx vitest run test/globalSetupEnsure.test.ts` (app) | 0 | 1 file passed, 5 passed (5), 573ms / 1.52s |
| `npx vitest run test/dynamoKeyLedger.test.ts` (app) | 0 | 1 file passed, 7 passed (7), 351ms / 1.41s |
| `npx vitest run test/unreadIndexRepo.integration.test.ts` (app) | 0 | 1 file passed, 23 passed (23), 787ms / 1.95s |
| `npm run typecheck` (root, all workspaces) | 0 | clean |

Plus two checks not on the list:

- `npx eslint app/src/lib/dynamoAdmin.ts app/scripts/db-update-gsis.ts app/test/dynamoAdminRetry.test.ts`
  -> exit 0, no output. No baseline comparison was needed because nothing was
  reported.
- `npx vitest run test/todayUnmatchedNonRegression.test.ts` -> exit 0, 1 passed
  (1). Run because `:105-109` is the ONLY concurrent `ensureTable` call site and
  therefore the live exercise of the per-call `retried` local.

`dynamo.integration.test.ts` does cover the branch S1.3 rewrote: `:60-65` is
the `ResourceInUseException` -> `'exists'` case, reached with no retry, so
`retried` is false and the poll does not run (the live guardrail for case 3).
Its `beforeAll` at `:45-50` additionally asserts `'created'` 22 times on fresh
tables, which is the guardrail against hooking `CreateTable`.

No suite failed, so no re-run-and-compare was required.

## Design decisions the plan left open

- **Injection seam.** An optional trailing `opts` on each public entry point,
  as the brief recommended: `ensureTable(client, spec, name, env, opts)` with
  `{ retry?, poll? }` (`dynamoAdmin.ts` `EnsureTableOptions`),
  `deleteTableIfExists(client, name, { retry? })`, and
  `ensureGsis(client, specs, env, log, { retry? })`. No module-level mutable
  state anywhere. `enableTtlIfNeeded` receives the schedule as a plain
  parameter because it is private.
- **`RetrySchedule` shape**: `{ attempts?, backoffMs?(attempt) }`. A function
  rather than a number so a test can inject zero delay without also changing
  the ATTEMPT count, which is what case 10 measures.
- **Predicate name `isLocalDynamoEndpoint`**, exported from `dynamoAdmin.ts`.
  Deliberately not `isLocalEndpoint`: `db-create.ts:22-29` already owns that
  name for a URL-STRING predicate, and these two must not be mistaken for each
  other. Takes the CLIENT (not a resolved endpoint) so case 13 can point it at
  a real `DynamoDBClient` without sending anything.
- **Poll error type `TableNotActiveError`**, exported, carrying `tableName` and
  `observedStatus` as fields as well as in the message. `ensureTable` catches
  it by `instanceof` and rethrows the ORIGINAL `ResourceInUseException` with
  the poll's message appended - the poll never sees the conflict, so it cannot
  rethrow it itself.
- **The retry core is ONE private loop** (`retryLocalControlPlane`, returns
  `void`) that both public functions delegate to; `sendWithRetry` captures the
  output in a closure and returns it. That avoids either duplicating the loop
  or casting away the `verified` branch, and the two PUBLIC signatures still
  carry the constraint the plan asked for as types.
- **How the suite tells a HOOK CALL from a SEND.** The TTL hook re-reads the
  same command type as the pre-send guard, so nothing on the wire distinguishes
  them and a per-command counter cannot express "hook called 3 times across 4
  attempts". The stub therefore keeps an ORDERED log of every command it was
  asked to send, and cases 5-10 assert the exact sequence; a hook read is
  identified by POSITION (it falls between two mutation sends). Case 10's
  expectation is the literal 8-element interleave. This is strictly stronger
  than two counters, which could not have caught a hook that fired on the final
  attempt.
- **Case 15 vs case 16 needed different DescribeTable scripts.** Both drive
  `ensureGsis`, but 15's verification read must SUCCEED-and-report-absent
  (so the hook returns false honestly) while 16's must THROW (so `indexStatus`
  swallows it). If 15's second read had fallen through to the stub's
  index-ACTIVE default, the hook would have returned true and the case would
  have gone green with ONE send - passing while proving the opposite of its
  name.

## Record, do not fix

- **A genuinely CREATING pre-existing table is still returned as `'exists'`
  without a wait when no retry happened.** `dynamoAdmin.ts`'s
  `ResourceInUseException` catch polls only when `retried` is true, by design
  (the poll must not tax the ~71 call sites and the ~22-table `globalSetup`
  loop). A table another process is mid-creating therefore still comes back as
  ready when it is not. That hole predates this mission and is unchanged by it.
  Called out in a comment at the catch site.

## Other things seen, not fixed

- `app/test/dynamo.integration.test.ts:8` header comment says "all 9 tables";
  `TABLES` has 22. Stale comment, unrelated to this slice.
- Drift flag 16 in the worklist stands after the change: a region-only client
  and an `AWS_ENDPOINT_URL`-configured one both present
  `config.endpoint === undefined` at retry time, so case 12 cannot tell them
  apart. Fail-closed handles both correctly, which is why this is a note and
  not a defect.
- `waitUntilIndexActive` (`db-update-gsis.ts:158`) still defaults to a 900s
  ceiling and `ensureGsis` still calls it with no override. Untouched by this
  slice, and out of its scope, but it is the longest unbounded wait on that
  path.
