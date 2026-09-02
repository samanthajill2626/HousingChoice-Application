# Fix wave 1 brief (M7 npm test soundness)

Begin by using tools - do not reply until the work is committed.

You are the fix-wave implementer for the "npm test soundness" mission in
worktree `W:\tmp\npm-test-soundness` (branch `feat/npm-test-soundness`). Work
ONLY in that worktree; ABSOLUTE paths and an explicit
`cd W:\tmp\npm-test-soundness` (or `...\app`) in EVERY shell command. Never
touch `W:\AI Projects\Housing Choice\HC Application` or any other `W:\tmp\*`
worktree.

## Read first

1. `W:\tmp\npm-test-soundness\docs\superpowers\reviews\2026-08-31-npm-test-soundness\code-review\r1-adjudications.md`
   - the binding list of what to fix and what NOT to change (DECLINE rows are
   final for this wave).
2. The two review reports it adjudicates, in the same directory:
   `r1-adversarial.md` and `r1-conformance.md` (and the gitignored evidence
   `W:\tmp\npm-test-soundness\.superpowers\review\r1-adversarial-evidence.md`,
   whose E3 is the leaky-layer reproduction you must repeat).
3. The slice records for context: `..\s1-retry.md`, `..\s3-static-smoke.md`.
4. `W:\tmp\npm-test-soundness\AGENTS.md` (repo rules).
5. The live files you will change (read them in full before editing):
   `app/src/lib/dynamoAdmin.ts`, `app/test/dynamoAdminRetry.test.ts`,
   `app/test/setup/dynamoAccessKeyGuard.test.ts`,
   `app/test/setup/dynamoAccessKey.ts` (where `SHARED_LOCAL_TABLES_MARKER` /
   `optsIntoSharedLocalTables` live; find where `WORKTREE_DERIVED_KEYS_MARKER`
   is defined and follow that precedent), `app/test/staticSmoke.test.ts`.

## The work, in this order (STRICT TDD where a test can lead)

### F1 (A1, blocker) - the guard marker

- Find how `WORKTREE_DERIVED_KEYS_MARKER` is defined and documented (grep
  `hc:dynamo-lane` under `app/test`). Add a third marker constant
  `NO_CONTAINER_TABLES_MARKER = 'hc:dynamo-lane none'` beside it, with a
  docblock: "this suite never opens a DynamoDB Local database - it drives a
  stub client and creates no container tables; declared so the
  creates-tables guard does not read its imports as container writes".
- In `dynamoAccessKeyGuard.test.ts`'s `every unmarked suite that CREATES
  container tables mints per-run random names` case (`:264-306`), exempt a
  file whose source includes the new marker, exactly as it exempts
  `WORKTREE_DERIVED_KEYS_MARKER` at `:290`. Extend the failure MESSAGE to
  name the third remedy.
- Rot-proofing, one new `it` in the guard file: every app test file carrying
  `NO_CONTAINER_TABLES_MARKER` must NOT import `../src/lib/dynamo.js` /
  `createDynamoClient` / `createDocumentClient` / `getDocumentClient` (the
  container-reaching factory), and must not mention `hc-local-` /
  `TABLE_PREFIX`. Message says why.
- Declare the marker in `app/test/dynamoAdminRetry.test.ts`'s header comment
  (a comment line, the same shape the other markers use - check
  `optsIntoSharedLocalTables`' matching rules in `dynamoAccessKey.ts` so the
  form is one the detector accepts: it must be the marker text in a comment,
  not in a string literal). Case 13 constructs two REAL `DynamoDBClient`s
  directly from the SDK and never sends; that does not import the factory,
  so the rot-proof check holds. Say so in the comment.
- Verify: `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` green
  (14+ tests), and `npx vitest run test/dynamoAdminRetry.test.ts` green.
  Run the guard file RED first (before adding the marker) to record the
  offender line, then green after.

### F2 (A2, must-fix) - gate deleteTableIfExists's tolerance on `retried`

- Write acceptance case 18 FIRST: local endpoint, `DeleteTable` throws
  `ResourceInUseException` on the FIRST attempt (no retryable error) ->
  `deleteTableIfExists` REJECTS with that `ResourceInUseException` instance
  and exactly one send. Confirm RED.
- Then in `dynamoAdmin.ts` thread `onRetry: () => { retried = true; }` into
  `deleteTableIfExists`'s `sendWithRetry` call (per-call local, exactly the
  `ensureTable` shape) and tolerate `ResourceInUseException` only when
  `retried`; otherwise rethrow. Fix the comment so it says what the code
  does. Case 4 (retried path) must stay green.

### F3 (A3, must-fix) - traversal decoys INSIDE the temp root

- Restructure the fixture: `root = mkdtempSync(os.tmpdir()/'hc-static-smoke-')`,
  `distDir = path.join(root, 'site', 'dist')` (mkdir recursive). Write the
  fixture `index.html` and the positive-control asset into `distDir` as now.
  Write decoys, INSIDE the root only: `path.join(root, 'package.json')` and
  `path.join(root, 'site', 'package.json')`, each
  `{"name":"static-smoke-decoy","version":"0.0.0","private":true}` (this
  carries both leak markers `"version"` and `"private"`). Never write outside
  `root`. `afterAll` removes `root` (guarded: only if it was created - that
  is A9).
- Confirm by hand which probe resolves where: `/%2e%2e%2f%2e%2e%2fpackage.json`
  -> `dist/../../package.json` = `root/package.json`; `/..%2f..%2fpackage.json`
  and `/..%5c..%5cpackage.json` -> same; `/%2e%2e/%2e%2e/package.json` -> same;
  `/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json` -> `dist/assets/../../../package.json`
  = `root/package.json`; `/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd` -> outside
  the root, stays a SHAPE probe (the `root:` marker cannot be planted without
  leaving the temp root - say so in the comment). Record the resolution table
  in the wave record.
- Rewrite the traversal comment (ASCII) to state: decoys exist inside the temp
  root at exactly the depths the probes resolve to; `send` (installed 1.2.1
  when this was written, 2026-09-01) rejects any normalized `..` segment
  before touching the filesystem, so today they are never read; their job is
  to make a FUTURE leaky static layer OBSERVABLE - proven by a review
  reproduction on 2026-09-01 in which a hand-rolled resolver leaked 4 of 6
  probes only when a target file existed at the probed depth. (This also
  covers C9 - the version is dated.)
- PROVE IT, and put the proof in the wave record: write a THROWAWAY test
  `app/test/__fixwave_leaky_static.test.ts` that builds a deliberately leaky
  static layer (resolve `path.resolve(distDir, '.' + decodeURIComponent(req.path))`
  and serve the file if it exists, else the SPA shell - the shape in evidence
  E3), points it at the NEW fixture (root + decoys), runs the EXACT six probes
  with the EXACT assertion block, and shows FAILURES (expect at least 4 of 6
  to fail). Then run the real `staticSmoke.test.ts` and show it PASSES. Delete
  the throwaway file afterwards and confirm `git status --short` shows no
  `__fixwave_*` file.

### F4 (A4, should-fix) - an elapsed-time deadline on the retry

- Case 21 FIRST: local endpoint, a stub `CreateTable` whose every attempt
  takes ~30ms (await a timer inside the scripted step - extend the stub's
  `Step` with an optional `delayMs`) and throws `InternalFailure`; retry
  schedule `{ backoffMs: () => 0, deadlineMs: 50 }` -> rejects with the
  ORIGINAL `InternalFailure` after FEWER than 4 sends (assert `count <= 3`
  and `>= 2`). Confirm RED (today it sends 4).
- Then add `deadlineMs?: number` to `RetrySchedule` (default 20_000), record
  `startedAt` before attempt 1, and check `Date.now() - startedAt >= deadlineMs`
  BEFORE each re-send (after the retryable check and the attempt bound; before
  the endpoint gate is fine either way - keep the hot path free of clock reads
  by checking only in the catch). Document the default: one full DynamoDB
  Local lock-timeout retry (~10s + backoff) fits, several fast
  `InternalFailure` retries fit, and a 22-table hook loop cannot lose more
  than ~20s to one contended table. Case 10 (4 sends with zero backoff) must
  stay green - it completes in milliseconds, far under 20s.

### F5 (A5 comment only)

One or two comment lines at `DEFAULT_POLL_CEILING_MS`: the poll waits only on
a table THIS call just created (empty; per-worktree or per-run-random keys
mean no other process is creating the same table in the same database), which
is why 10s here is not `db-update-gsis`'s 900s (a GSI backfill on a populated
local table). No behaviour change.

### F6 (C2, C3) - two more acceptance cases

- Case 19: local, `CreateTable` `InternalFailure` then `ResourceInUseException`,
  `DescribeTable` always CREATING, poll `{ intervalMs: 1, ceilingMs: 20 }` ->
  `ensureTable` REJECTS with an error that is `instanceof ResourceInUseException`
  (NOT `TableNotActiveError`) whose message contains the table name and
  `CREATING`.
- Case 20: two stub clients; A scripted `CreateTable` [InternalFailure,
  ResourceInUse] with `DescribeTable` ACTIVE; B scripted `CreateTable`
  [ResourceInUse] but with its first send DELAYED (use the same `delayMs`
  step extension) so it lands after A's retry fired; `await Promise.all([
  ensureTable(A...), ensureTable(B...) ])`; assert A polled (`DescribeTable`
  >= 1) and B issued ZERO `DescribeTable`. Prove the case has teeth in the
  record: temporarily hoist `retried` to module scope in a scratch copy or
  reason it through concretely - a module-level flag set by A would make B
  poll.

### F7 (A9, C8) - staticSmoke tidy-ups

- `afterAll`: `if (root) rmSync(root, ...)`.
- Rename the hardening-headers loop variable `path` -> `route` (and its
  `expect(..., route)` message args). No other change in that block.

### F8 (C1) - one sentence in the spec

In `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`, at the
paragraph beginning "**Fixture contents are specified, positively and
negatively.** The fixture `index.html` must carry `HousingChoice`", append one
bracketed ASCII sentence: "[Superseded by plan S3.1 after plan review round 1:
the fixture carries a distinctive marker instead; `HousingChoice` is asserted
in (b)/(c) against the tracked source. Recorded in code-review/r1-adjudications.md C1.]"
Touch nothing else in the spec.

## Verify (from `W:\tmp\npm-test-soundness\app`, bare, foreground, output to a
## file then read; one at a time)

- `npx vitest run test/dynamoAdminRetry.test.ts` - 21 cases green
- `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` - green
- `npx vitest run test/staticSmoke.test.ts` - green (dist is present and
  fresh, so (c) PASSES; if you find it absent, do NOT build it - say so)
- `npx vitest run test/dynamo.integration.test.ts`
- `npx vitest run test/globalSetupEnsure.test.ts`
- `npx vitest run test/dynamoKeyLedger.test.ts`
- `npx vitest run test/unreadIndexRepo.integration.test.ts`
- `npx vitest run test/todayUnmatchedNonRegression.test.ts`
- `npx vitest run test/importApply.integration.test.ts` (delete-then-create
  hook, the caller A2's gating protects)
- from the root: `npm run typecheck`; and
  `npx eslint app/src/lib/dynamoAdmin.ts app/test/dynamoAdminRetry.test.ts app/test/setup/dynamoAccessKeyGuard.test.ts app/test/setup/dynamoAccessKey.ts app/test/staticSmoke.test.ts`
  (fix only errors YOU introduced; the four pre-existing files were clean at
  the merge base).

DO NOT run the full `npm test`, `npm run e2e`, `npm run smoke`. Do NOT restart
the DynamoDB Local container. Do NOT set `E2E_CHILD_LOG_DIR`. Never end your
turn with a background command running. Do NOT change anything a DECLINE row
covers (no verify hook on CreateTable, no change to the poll ceiling or its
exhaustion behaviour, no change to case 2's `'exists'`).

## Rules

- ASCII only on every added/touched line; no PowerShell rewrite pipelines;
  use the Edit tool.
- Bare `git status` before EVERY commit; `.git/MERGE_HEAD` absent; explicit
  paths only, never `git add -A`; leave nothing of yours uncommitted.
- Commit in small steps (at least: F1; F2+F4+F5+F6; F3+F7; F8 + record).
  Trailer on every commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- The record: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/code-review/r1-fix-wave.md`
  (ASCII): per finding, what changed (`file:line`), the RED-then-GREEN
  evidence for each new case, the guard offender line before/after, the
  probe-resolution table and the leaky-layer proof (failures with the new
  fixture; pass with the real app), verify results with exit codes, anything
  you saw that looks wrong (not fixed). No byte-exact code quotation; verbose
  output to `W:\tmp\npm-test-soundness\.superpowers\review\r1-fix-wave-evidence.md`
  (gitignored).

## STOP conditions

- The marker form the detector accepts cannot be made to work without
  changing `optsIntoSharedLocalTables`' matching semantics for the OTHER
  markers - stop and report.
- The leaky-layer proof does NOT show failures with the new fixture - stop;
  do not ship a decoy that does not bite.
- Any existing suite in the verify list fails with an assertion failure (not
  a timeout) - stop, report both runs.
- Low on context: commit what is green, report the next step.

## Return

ONLY: commit hashes + one-liners; per-finding one-line status (F1-F8);
the guard offender line before/after; the leaky-layer proof numbers; the
verify table (command, exit, counts); the record path; open findings for
the orchestrator (one line each). No narration.
