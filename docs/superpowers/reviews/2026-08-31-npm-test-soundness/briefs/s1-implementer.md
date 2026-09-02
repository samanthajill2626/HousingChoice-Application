# S1 implementer brief - dynamoAdmin retry + acceptance suite (M7)

Begin by using tools - do not reply until the work is committed.

You are the implementer for slice S1 of the "npm test soundness" mission, in
worktree `W:\tmp\npm-test-soundness` (branch `feat/npm-test-soundness`). You
work ONLY in that worktree; use ABSOLUTE paths in every shell command (`cd
W:\tmp\npm-test-soundness` explicitly in EVERY command - the shell cwd resets
between calls). Never touch `W:\AI Projects\Housing Choice\HC Application` or
any other `W:\tmp\*` worktree.

## Read first, in this order (files, not summaries)

1. `W:\tmp\npm-test-soundness\AGENTS.md` (repo rules; the gates section and
   "Editing and commit discipline" are binding)
2. `W:\tmp\npm-test-soundness\docs\superpowers\specs\2026-08-31-npm-test-soundness-design.md`
   - section "Item 1A" in full
3. `W:\tmp\npm-test-soundness\docs\superpowers\plans\2026-09-01-npm-test-soundness.md`
   - "Rules that apply to every slice" and section "S1" in full (S1.0-S1.5)
4. `W:\tmp\npm-test-soundness\.superpowers\sdd\worklist.md` - sections 0
   (drift flags), 1, 2, 3, 6. This is the LIVE-TREE verification of the
   plan's anchors; where the plan's line numbers and the worklist disagree,
   the worklist is right (the plan drifted by a line or two in places).

The spec is a contract. If a spec point looks wrong, STOP and report it in
your return text; never silently deviate.

## Scope - exactly these files

- `app/src/lib/dynamoAdmin.ts` (modify)
- `app/scripts/db-update-gsis.ts` (modify - refactor onto the shared helper)
- `app/test/dynamoAdminRetry.test.ts` (NEW - the 17-case acceptance suite)
- `docs/superpowers/reviews/2026-08-31-npm-test-soundness/s1-retry.md` (NEW -
  the committed slice record; findings/decisions with `file:line` cites, no
  byte-exact code quotation)

Do NOT edit anything else. In particular do NOT touch
`app/test/unreadIndexRepo.integration.test.ts` (its `:728` CreateTable and
`:729` waiter stay exactly as they are), `app/test/groupCrossCheck.test.ts`,
`app/scripts/db-create.ts`, or any test other than the new one.

## Order of work - STRICT TDD

1. S1.0: re-run the enumeration (the worklist section 1 already did, live -
   confirm it, do not trust the plan's table). Anything the spec's disposition
   rule does not cover goes in `s1-retry.md` as a handback finding, not a
   silent decision. The worklist pre-classified these: hits 3/13 (SDK waiters
   in `dynamoAdmin.ts:89` and `db-update-gsis.ts:234`) are UNCHANGED per the
   plan; hits 7/8 (`db-create.ts` waiters) are recorded by the spec as
   pre-existing/out of scope; hit 28 (`unreadIndexRepo.integration.test.ts:729`
   waiter) and hit 31 (`scripts/wipe-dev-data.mjs:170`, root scripts, ambient
   env) are unclassified by the rule -> record both as findings, change
   neither.
2. S1.1: write `app/test/dynamoAdminRetry.test.ts` FIRST with all 17 cases
   from the plan's table. Run it and confirm it is RED against the unmodified
   code (record which cases fail and how - that is the proof the suite can
   fail). Commit the red suite? NO - commit the suite together with the
   implementation once green, but keep the red-run output in your report.
3. S1.2 + S1.3: the shared helper and its application in `dynamoAdmin.ts`.
4. S1.4: refactor `db-update-gsis.ts` onto the helper.
5. S1.5: verify (below). Commit. Write the record. Commit.

## Binding design constraints (verbatim from the plan - do not reinterpret)

- Retryable names: `InternalFailure`, `InternalServerError`. The retry
  discriminates by `err.name`; `dynamoAdmin` keeps discriminating
  `ResourceInUseException` / `ResourceNotFoundException` by `instanceof`.
- **4 attempts max, linear `attempt * 250ms`. The backoff is INJECTABLE**, so
  the acceptance suite does not spend ~4-5s in real `setTimeout`. Recommended
  seam: an optional trailing `opts` parameter on the public entry points
  (`ensureTable`, `deleteTableIfExists`, `ensureGsis`) carrying the retry
  schedule, threaded to the helper. NO module-level mutable state for
  anything that affects behaviour.
- **TWO functions, so the constraint is enforced by the TYPE**:
  `sendWithRetry<TOut>` returns `TOut`, accepts NO verification hook (an
  `onRetry` callback IS allowed - see CreateTable); `sendWithRetryVerified`
  returns `void`, hook REQUIRED.
- Which send uses which:
  | send | function | hook |
  |---|---|---|
  | `CreateTable` | `sendWithRetry` | none (+ `onRetry` sets a PER-CALL `retried` local) |
  | `DeleteTable` | `sendWithRetry` | none |
  | `DescribeTimeToLive` (pre-send read in `enableTtlIfNeeded`) | `sendWithRetry` | none - output consumed |
  | `UpdateTimeToLive` | `sendWithRetryVerified` | status re-read |
  | `UpdateTable` (`ensureGsis`) | `sendWithRetryVerified` | `indexStatus` |
  A hook on `CreateTable` would return `'created'` where today's code returns
  `'exists'` and would still pass cases 2 and 3 - that is why it is forbidden.
- Verification hook, ONE contract for every caller:
  | hook outcome | helper does |
  |---|---|
  | returns `true` | return success, no re-send |
  | returns `false` | re-send, subject to the bound |
  | throws | rethrow the ORIGINAL error, no re-send |
  | absent (`sendWithRetry`) | re-send, subject to the bound |
  Called at most once per failed attempt, never itself retried, and NOT
  called on the final attempt - the attempt bound is checked FIRST, exactly as
  `db-update-gsis.ts:117` does today.
- **Endpoint gate, resolved LAZILY** - only on the first retryable error, never
  on the hot path. `client.config.endpoint` is `Provider<Endpoint> | undefined`
  (worklist section 3 proves this against the installed SDK 3.1070.0); the
  resolved object has `hostname`. Local means `localhost`, `127.0.0.1`,
  `::1`, `[::1]`. **Fail closed**: no provider, a throwing provider, or any
  other hostname -> NOT local -> no retry (today's behaviour exactly; the
  original error propagates on the FIRST failure).
- **The predicate is EXPORTED** from `dynamoAdmin.ts` (case 13 reaches it with
  a REAL `DynamoDBClient`). It is DEFINED in `dynamoAdmin.ts`; `lib` must not
  import from `scripts`. It is not a copy of `db-create.ts`'s
  `isLocalEndpoint` (URL string vs resolved endpoint object).
- `CreateTable`: the ACTIVE poll runs ONLY when the `ResourceInUseException`
  followed a RETRIED attempt. Use the plan's per-call local + `onRetry`
  callback shape (plan S1.3 code block). A plain pre-existing table takes
  today's path exactly: `'exists'`, ZERO `DescribeTable`. `ensureTable` is
  called CONCURRENTLY at `app/test/todayUnmatchedNonRegression.test.ts:105-109`,
  which is why a module-level flag is forbidden.
- The poll: `DescribeTable`, **100ms interval, 10s ceiling**, EXPORTED with
  injectable interval/ceiling (case 17). Its own reads are NOT retried; a
  failed read counts as "not ACTIVE yet". On exhaustion it throws ITS OWN
  error type naming the table and the observed status (it never sees the
  `ResourceInUseException`); `ensureTable` catches that and rethrows the
  ORIGINAL `ResourceInUseException` with the observed status appended to its
  message. No endpoint gate inside the poll (dead code that reads as a live
  safeguard).
- The success path keeps `waitUntilTableExists({ client, maxWaitTime: 60 }, ...)`
  UNCHANGED (`dynamoAdmin.ts:89`).
- `DeleteTable`: retried; the catch additionally tolerates
  `ResourceInUseException` (DELETING means the delete landed).
- `UpdateTimeToLive`: hook = status re-read; success iff `TimeToLiveStatus`
  is `'ENABLED'` or `'ENABLING'`; the hook does NOT swallow - a throwing
  re-read reaches the fail-closed branch.
- `db-update-gsis.ts`: `verify: async () => { const s = await indexStatus(...);
  return s === 'CREATING' || s === 'ACTIVE'; }`. `indexStatus` keeps its own
  `catch` returning `undefined` (fail-open lives in the CALLER's hook). Add ONE
  comment line saying so. `ensureGsis` goes behind the endpoint gate for the
  first time - intended tightening; cases 15/16 use a LOCAL endpoint. Delete
  the now-redundant `sendWithInternalFailureRetry` (its docblock's WHY belongs
  with the shared helper - move the reasoning, do not lose it).
- **Record, do not fix:** a genuinely CREATING pre-existing table is still
  returned as `'exists'` without a wait when no retry happened. Say so in the
  record.
- `app/test/dynamo.integration.test.ts:45-50` asserts `'created'` for all 22
  fresh tables and `:60-65` asserts `'exists'` for a re-run. Both must keep
  passing untouched.

## Stub contract for the acceptance suite (plan S1.1; worklist section 3)

- No container, no network. A stub client object cast to `DynamoDBClient`,
  with a programmable `send` scripted PER COMMAND TYPE, PER CALL (an ordered
  script of `ok(output) | throw(err)` per command name), plus a settable
  `config.endpoint` provider (`undefined`, throwing, or resolving to
  `{ protocol, hostname, port, path }`).
- Counters distinguish SENDS from HOOK CALLS (case 10: "hook called 3 times
  across 4 attempts").
- Throw REAL instances: `new ResourceInUseException({ $metadata: {}, message })`,
  `new ResourceNotFoundException(...)`, and for case 8 the REAL
  `new InternalServerError({ $metadata: {}, message: 'This action timed out because it took too long waiting for a lock' })`
  (the SDK exports it). **`InternalFailure` has NO SDK class** - synthesise it:
  `Object.assign(new Error('The request processing has failed because of an unknown error, exception or failure.'), { name: 'InternalFailure' })`.
- Every `DescribeTable` the stub answers AFTER an `ensureGsis` send must report
  `Table.TableStatus: 'ACTIVE'` and the index `IndexStatus: 'ACTIVE'`, or
  `waitUntilTableExists` / `waitUntilIndexActive` (900s default ceiling) spin
  past the test timeout. Case 16 needs the FIRST `DescribeTable` (inside
  `liveIndexNames`, the send at `db-update-gsis.ts:182`) to SUCCEED with the
  index ABSENT, and only the verification read (inside `indexStatus`) to
  throw; subsequent reads report ACTIVE.
- Cases 6 and 10: the stub's FIRST `DescribeTimeToLive` (the pre-send guard)
  must report `DISABLED`, or `enableTtlIfNeeded` returns early and the case
  passes with zero `UpdateTimeToLive` sends. Case 6's re-read (the hook)
  reports `ENABLED` -> helper returns without re-sending.
- Case 13 uses REAL clients: `new DynamoDBClient({ region: 'us-east-1', endpoint: 'http://localhost:8000' })`
  -> local; `new DynamoDBClient({ region: 'us-east-1' })` -> not local. Never
  `send` on them. Destroy them afterwards.
- Case 14: `127.0.0.1`, `::1`, `[::1]`, `localhost` all local (stub providers).
- Case 17: call the exported poll DIRECTLY with a LOCAL stub client, tiny
  interval/ceiling, `DescribeTable` never ACTIVE -> throws the POLL's own
  error type naming the table and the observed status.
- Whole file should run in well under 10s with the injected backoff.

## Lint / encoding rules

- New and touched lines ASCII-only (`dynamoAdmin.ts:1` already carries an em
  dash - leave that line alone; everything you ADD is ASCII).
- `eslint.config.mjs:74-91` bans `readFileSync` in `app/src/**/*.ts`.
- Never rewrite a source file with a PowerShell `Get-Content | -replace |
  Set-Content` pipeline. Use the Edit tool.
- Run `cd W:\tmp\npm-test-soundness; npx eslint app/src/lib/dynamoAdmin.ts app/scripts/db-update-gsis.ts app/test/dynamoAdminRetry.test.ts`
  and fix any error YOU introduced (attribute by comparing against the same
  command at the merge base if anything pre-existing shows up; report, do not
  fix, pre-existing ones).

## Verify (S1.5) - from `W:\tmp\npm-test-soundness\app`, each command BARE and
## alone on its line, one at a time, foreground, output to a file then read

- `npx vitest run test/dynamoAdminRetry.test.ts` - all 17 green
- `npx vitest run test/dynamo.integration.test.ts` - the only existing test of
  the `ensureTable` branch S1.3 rewrites; confirm it covers that branch
  (`:60-65`) and still passes
- `npx vitest run test/globalSetupEnsure.test.ts`
- `npx vitest run test/dynamoKeyLedger.test.ts`
- `npx vitest run test/unreadIndexRepo.integration.test.ts`
- `cd W:\tmp\npm-test-soundness; npm run typecheck` (root; all workspaces)

The box is CONTENDED right now (other missions' e2e + vitest are live and
DynamoDB Local is hot). The integration files above may run slowly; do not
run two at once, do not raise any timeout, and if one fails, re-run that one
file alone once and report BOTH results verbatim rather than adjusting
anything. DO NOT run the full `npm test`, `npm run e2e`, or `npm run smoke` -
the orchestrator runs those later. Do NOT restart the DynamoDB Local
container. Do NOT set `E2E_CHILD_LOG_DIR`. Never end your turn with a
background command running - run verifies in the foreground.

## Commit discipline (verbatim repo rules)

- Read bare `git status` before EVERY commit and check `.git/MERGE_HEAD` is
  absent. Stage EXPLICIT PATHS only - never `git add -A`.
- Small commits: at minimum one for the code + acceptance suite, one for the
  record. Message shape: `test(dynamo): ...` / `fix(dynamo-admin): ...`.
- Every commit ends with the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Leave `git status` clean of anything under `app/` when you finish.

## The record - `docs/superpowers/reviews/2026-08-31-npm-test-soundness/s1-retry.md`

ASCII only. Contents: the enumeration result and the disposition flags; the
RED run (which cases failed before the change, one line each); the GREEN run
counts; each verify command's result (exit code + counts, quoted); design
decisions you had to make that the plan left open (the injection seam, error
class name, predicate name) with one line of rationale each; the "record, do
not fix" item; anything you saw that looks wrong elsewhere (do not fix it).
Cite code by `file:line`; put NO byte-exact code quotation in this file - if
you need to keep verbose evidence, put it in
`W:\tmp\npm-test-soundness\.superpowers\sdd\reports\s1-retry-evidence.md`
(gitignored).

## STOP conditions - report instead of forcing

- An importer or a type contract you did not expect (worklist section 2 lists
  every importer - if the tree disagrees, stop).
- Case 13 cannot be made to pass with the real SDK client (the predicate
  assumption would be wrong - report what `config.endpoint` actually is).
- Any of the four existing suites in S1.5 fails in a way that is not plainly
  contention (assertion failures, not timeouts) - stop, report both runs.
- You run low on context: COMMIT what is green, and report the exact next
  step.

## Return

Reply with ONLY: commit hashes + one-liners; the red-run summary (N of 17
failing before); the green counts for all six verify commands with exit
codes; the record path; the list of open decisions/findings for the
orchestrator (one line each). No narration.
