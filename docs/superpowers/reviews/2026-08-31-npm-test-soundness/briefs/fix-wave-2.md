# Fix wave 2 brief (M7 npm test soundness) - targeted

Begin by using tools - do not reply until the work is committed.

Worktree `W:\tmp\npm-test-soundness`, branch `feat/npm-test-soundness`. Work
ONLY there; ABSOLUTE paths and an explicit `cd W:\tmp\npm-test-soundness` (or
`...\app`) in EVERY shell command - the shell cwd resets between calls and a
bare `git` can land in another checkout.

## Read first

1. `W:\tmp\npm-test-soundness\docs\superpowers\reviews\2026-08-31-npm-test-soundness\code-review\r2-adjudications.md`
   (binding; DECLINE rows are final).
2. `...\code-review\r2-adversarial.md` and `...\code-review\r2-conformance.md`
   (the findings, with `file:line`), and the gitignored evidence
   `W:\tmp\npm-test-soundness\.superpowers\review\r2-adversarial-evidence.md`.
3. `W:\tmp\npm-test-soundness\AGENTS.md`.
4. The four files you will change, in full: `app/src/lib/dynamoAdmin.ts`,
   `app/test/dynamoAdminRetry.test.ts`,
   `app/test/setup/dynamoAccessKeyGuard.test.ts`, `app/test/staticSmoke.test.ts`.

## Work, in order (TDD where a test can lead)

### W1 - deadline AFTER the verify hook (adv N1, must-fix)

- Case 22 FIRST, in `dynamoAdminRetry.test.ts`: local endpoint, TTL spec;
  `UpdateTimeToLive` scripted to take ~30ms (`delayMs`) and throw
  `InternalFailure`; `DescribeTimeToLive` scripted `[DISABLED (pre-send guard),
  ENABLED (the hook re-read)]`; schedule `{ backoffMs: () => 0, deadlineMs: 1 }`
  -> `ensureTable` RESOLVES `'created'`, `UpdateTimeToLive` sent exactly once,
  `DescribeTimeToLive` sent exactly twice (the hook RAN despite the expired
  deadline). Confirm RED on the current code (today it rejects with
  `InternalFailure` and the count stays at 1).
- Then in `retryLocalControlPlane` move the deadline check from before the
  endpoint gate to AFTER the verify block and immediately BEFORE `onRetry`.
  Order becomes: retryable? -> attempt bound -> endpoint gate -> verify (true:
  return / throws: rethrow original / false: continue) -> DEADLINE -> onRetry
  -> sleep -> re-send. Update the comment: the deadline stops RE-SENDS only;
  every non-final failed attempt still asks whether it landed.
- Cases 7, 10, 21 must stay green.

### W2 - case 21 made load-robust (adv N5 / conf N1)

Rewrite case 21: `attempts: 12`, every `CreateTable` step `delayMs: 20` and
throws `InternalFailure` (use `fallback`), `backoffMs: () => 0`,
`deadlineMs: 200`. Assert: rejects with the ORIGINAL `InternalFailure`;
`2 <= count('CreateTable') < 12`. Comment: the lower bound has ~180ms of slack
(attempt 1 finishes at ~20ms against a 200ms budget); the upper bound is what
proves the deadline fired at all (without it there would be 12 sends).

### W3 - case 20 pins its interleaving (adv N9)

Give `StubClient` an optional shared `timeline: string[]` (constructor arg or
setter) that every `send` pushes `<clientLabel>:<CommandName>` onto. In case
20, share one timeline between the two stubs and assert the plain client's
FIRST `CreateTable` entry comes AFTER the retried client's SECOND `CreateTable`
entry (indexOf comparisons). Keep the existing zero-`DescribeTable` assertion.

### W4 - three comment corrections in `dynamoAdmin.ts` (adv N3/N4, conf N2/N7, A5 challenge)

- `DEFAULT_DEADLINE_MS`: it bounds each retried SEND, checked before a re-send
  (so the effective bound is deadline + one attempt); one `ensureTable` on a
  TTL-bearing spec runs up to THREE retried sends (CreateTable, the pre-send
  `DescribeTimeToLive`, `UpdateTimeToLive`) plus a 10s poll on the retried-
  conflict path, and the success path's SDK waiter (60s) is outside all of
  them; under `npm test` the TTL legs do not run (`DYNAMO_DISABLE_TTL`).
  DELETE the "22-table loop cannot lose more than ~20s" sentence. Keep the
  rationale for 20s (one full lock-timeout retry fits).
- `DEFAULT_POLL_CEILING_MS` (the A5 comment): narrow the exclusivity claim -
  it holds for the vitest key scheme across worktrees (per-run-random or
  worktree keys), NOT for `app/scripts/db-create.ts` on the human's ambient
  database or an e2e lane mid-`db:update-gsis`, where a table can be UPDATING
  for minutes; in that case a RETRIED conflict now fails after 10s naming the
  status, where the base code failed immediately on the `InternalFailure` (a
  base failure, not a base success); and say that reads failing inside the poll
  count as not-ACTIVE by design and are not retried.
- `pollUntilTableActive` docblock: add one sentence - the SUCCESS path of
  `ensureTable` deliberately keeps `waitUntilTableExists` unchanged (its first
  poll is immediate, so a fresh empty table normally returns on the first
  check; the flat-20s second tick bites only when the create itself is slow);
  this mission changed only the retried-conflict path.

### W5 - guard rot-proof widened (adv N2, conf N3)

In `dynamoAccessKeyGuard.test.ts` `CONTAINER_REACHING`: add import specifiers
ending `/db-create.js`, `/db-seed.js`, `/globalSetup.js`, `/globalTeardown.js`
(same `from\s+['"][^'"]*` shape) and calls to
`createAllTables|dropAllTables|ensureKeyedLocalTables|dropKeyedLocalTables`.
Rewrite the docblock: it is a ONE-FILE source scan that does not follow imports
(a helper module that builds a client on the suite's behalf is invisible to
it); it names the app's client factory AND the table-creating script/setup
entry points; "the ONLY thing" wording goes. Prove it bites: a throwaway
`app/test/__fixwave2_gamed.test.ts` carrying the `none` declaration line and
importing `createAllTables` from `../scripts/db-create.js` must now appear in
the rot-proof case's offender list (record the line), then delete it and
confirm the guard is green and `git status --short` clean. Confirm the real
`dynamoAdminRetry.test.ts` is still NOT an offender (it imports
`../scripts/db-update-gsis.js`, which is not in the list - say in the comment
that this is the known one-hop gap: that file's client construction is behind
its CLI argv guard).

### W6 - staticSmoke fixture tidy (adv N7/N8, conf N5/N6)

- Remove the `<root>/site/package.json` decoy write and the comment lines
  about it ("covers the remaining in-root depth ... for a future probe").
- One explicit `mkdirSync(path.join(distDir, 'assets'), { recursive: true })`
  as the FIRST statement after `mkdtempSync`, before every write, and a
  comment that the fixture is order-independent because of it.
- Traversal comment + the inline `// backslash separators` note: the `..%5c`
  probe's decoy target exists on Windows only (on POSIX the backslashes are
  one filename inside dist and it degrades to a shape probe), so falsifiability
  is 4 of 6 on Windows and 3 of 6 on Linux.
- Re-run the leaky-layer throwaway from wave 1's evidence
  (`W:\tmp\npm-test-soundness\.superpowers\review\r1-fix-wave-evidence.md`)
  against the changed fixture and confirm it still leaks 4/6 on this Windows
  box; then delete the throwaway.

## Verify (from `W:\tmp\npm-test-soundness\app`, bare, foreground, output to a file then read)

- `npx vitest run test/dynamoAdminRetry.test.ts` - 22 cases green
- `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` - green
- `npx vitest run test/staticSmoke.test.ts` - 12 green
- `npx vitest run test/dynamo.integration.test.ts`
- `npx vitest run test/globalSetupEnsure.test.ts`
- `npx vitest run test/unreadIndexRepo.integration.test.ts`
- root: `npm run typecheck`;
  `npx eslint app/src/lib/dynamoAdmin.ts app/test/dynamoAdminRetry.test.ts app/test/setup/dynamoAccessKeyGuard.test.ts app/test/staticSmoke.test.ts`

No full `npm test`/e2e/smoke; no container restart; no `E2E_CHILD_LOG_DIR`;
nothing left in the background; delete every `__fixwave2_*` file and confirm
`git status --short` is clean of them. Do NOT touch anything a DECLINE row
covers (no single deadline threaded through `ensureTable`, no waiter
replacement on the success path, no poll behaviour change, no `__` basename
exemption in the guard).

## Rules

ASCII on every added/touched line; Edit tool only; bare `git status` before
every commit; `.git/MERGE_HEAD` absent; explicit paths, never `git add -A`;
two commits minimum (code; record). Trailer:
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
Record: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/code-review/r2-fix-wave.md`
(ASCII; per item what changed `file:line`; RED-then-GREEN for cases 21/22 and
the guard gaming probe; the leaky-layer re-run figure; verify table; anything
seen and not fixed). No byte-exact code; verbose output to
`W:\tmp\npm-test-soundness\.superpowers\review\r2-fix-wave-evidence.md`.

## Return

ONLY: commit hashes + one-liners; W1-W6 one-line status each; RED/GREEN
evidence lines for cases 21/22 and the guard probe; verify table; record path;
open findings (one line each).
