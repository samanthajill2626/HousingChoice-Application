# r2 fix wave - raw evidence (gitignored)

Branch `feat/npm-test-soundness`, wave base `ad47aec1`. All commands run bare
and foreground from `W:\tmp\npm-test-soundness\app` unless noted; captured
output in the sibling `fw2-*.log` files.

---

## W1. Case 22, RED then GREEN

`fw2-w1-red.log` (case 22 written, `dynamoAdmin.ts` untouched), exit 1:

```
 FAIL  test/dynamoAdminRetry.test.ts > ... > case 22: an EXPIRED deadline still
 asks the hook whether the mutation landed
AssertionError: promise rejected "InternalFailure: The request processing h..."
instead of resolving
Caused by: InternalFailure: The request processing has failed because of an
unknown error, exception or failure.
      Tests  1 failed | 21 skipped (22)
```

The `DescribeTimeToLive` count assertion is never reached - the call rejects
first, which is the finding: the hook is pre-empted by the deadline.

`fw2-w1-green.log` after moving the deadline check to sit after the verify block
and immediately before `onRetry`, exit 0:

```
 v test/dynamoAdminRetry.test.ts (22 tests) 374ms
      Tests  22 passed (22)
```

Cases 7, 10 and 21 green in the same run (7 = verify throws -> rethrow original;
10 = the hook runs 3 times, never on the final attempt).

---

## W2. Case 21, GREEN then mutation-probed

`fw2-w2-green.log`, exit 0: `22 passed (22)` with the reworked case
(`attempts: 12`, `delayMs: 20`, `deadlineMs: 200`, `backoffMs: () => 0`;
asserts identity of the original fault and `2 <= sends < 12`).

Non-vacuity probe - scratch edit to `app/src/lib/dynamoAdmin.ts` replacing the
deadline check with `void startedAt; void deadlineMs;`
(`fw2-w2-probe.log`, exit 1):

```
 x case 21: the retry stops at its ELAPSED-TIME deadline, not just the attempt
   bound
AssertionError: expected 12 to be less than 12
      Tests  1 failed | 21 skipped (22)
```

Exactly 12 sends with no deadline - the upper bound is what proves the deadline
fired at all. Scratch edit reverted;
`Select-String "SCRATCH PROBE" app/src/lib/dynamoAdmin.ts` -> 0 hits.

The old shape's fragility (the finding): 30ms sends against a 50ms deadline left
20ms of timer slack on the `>= 2` lower bound. The new shape leaves ~180ms
(attempt 1 finishes at ~20ms against 200ms).

---

## W3. Case 20's interleaving pinned

`StubClient.recordInto(timeline, label)` pushes `<label>:<CommandName>` onto a
SHARED array. The push sits AFTER the scripted `delayMs`, i.e. it records when a
send ANSWERS, not when it is issued - `sent` / `count()` keep issue order and are
unchanged. Answer order is the ordering that matters: what decides whether a
concurrent caller could inherit another call's state is where its CATCH runs, and
the delayed send is issued long before that. (Issue-order recording would have
put `plain:CreateTable` first, since both `ensureTable` calls issue their first
send synchronously under `Promise.all`.)

Assertion added: `indexOf('plain:CreateTable')` >
`indexOf('retried:CreateTable', firstRetriedIdx + 1)`, with the whole timeline in
the failure message. `fw2-w3-green.log`, exit 0: `22 passed (22)`.

---

## W5. The guard's rot-proof case, probed by gaming it

Throwaway `app/test/__fixwave2_gamed.test.ts`: a bare `hc:dynamo-lane none`
declaration line plus `import { createAllTables } from '../scripts/db-create.js'`
and a reference to it. `fw2-w5-probe.log`, exit 1:

```
 x a suite declared as touching NO container tables really cannot reach one
   expected [ 'app/test/__fixwave2_gamed.test.ts' ] to deeply equal []
+   "app/test/__fixwave2_gamed.test.ts",
      Tests  1 failed | 14 passed (15)
```

The creates-tables case did NOT flag it (the marker exempts it, as designed) -
only the widened rot-proof case did, which is exactly the direction the finding
named. Under the pre-wave list the same file was in NEITHER offender list.

Throwaway deleted; `fw2-w5-green.log`, exit 0: `15 passed (15)`;
`git status --short` carries no `__fixwave2_*` entry.

The real `dynamoAdminRetry.test.ts` is still NOT an offender: it imports
`../scripts/db-update-gsis.js`, deliberately absent from the list (listing it
would flag the one legitimate `none` suite in the tree). That one-hop gap - the
module it imports does construct the client factory, behind its CLI argv guard -
is now written into the `CONTAINER_REACHING` docblock as the concrete measure of
what a one-file text scan cannot see.

---

## W6. staticSmoke fixture, and the leaky-layer re-run

`fw2-w6-green.log`, exit 0: `12 passed (12)`, zero occurrences of "skip" in the
log (the (c) diagnostic took its PASS arm).

Leaky-layer re-run against the TIDIED fixture (throwaway
`app/test/__fixwave2_leaky.test.ts`, since deleted): the wave-1 evidence-E3
shape - an express layer that decodes the path itself, `statSync().isFile()`,
serves the file, SPA shell otherwise - driven with the exact six probes and the
exact assertion block. `fw2-w6-leaky.log`, exit 0:

```
TIDIED FIXTURE leaky-layer failures: 4/6
  /%2e%2e%2f%2e%2e%2fpackage.json :: expected '{"name":"static-smoke-decoy","version...' not to contain '"version"'
  /..%2f..%2fpackage.json :: ... same
  /..%5c..%5cpackage.json :: ... same
  /assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json :: ... same
```

**4/6, unchanged from wave 1, and the SAME four probes** - which is the point:
removing `<root>/site/package.json` cost the fixture nothing, because no probe
ever resolved to it. Windows box (win32, this worktree).

Throwaway deleted; no `__fixwave2_*` file remains.

---

## Verify pass

```
test/dynamoAdminRetry.test.ts            EXIT=0   22 passed (22)
test/setup/dynamoAccessKeyGuard.test.ts  EXIT=0   15 passed (15)
test/staticSmoke.test.ts                 EXIT=0   12 passed (12)
test/dynamo.integration.test.ts          EXIT=0    2 passed (2)
test/globalSetupEnsure.test.ts           EXIT=0    5 passed (5)
test/unreadIndexRepo.integration.test.ts EXIT=0   23 passed (23)
npm run typecheck (root)                 EXIT=0
npx eslint <4 touched files> (root)      EXIT=0   (no output)
```

ASCII scan of every `+` line in `git diff` at wave end:
`non-ascii added lines: 0`.

Not run: full `npm test`, `npm run e2e`, `npm run smoke`. Container never
restarted, `E2E_CHILD_LOG_DIR` never set, nothing left in the background.

## Throwaway cleanup

```
> Remove-Item app/test/__fixwave2_gamed.test.ts
> Remove-Item app/test/__fixwave2_leaky.test.ts
> git status --short          -> only the 4 intended M entries
> ls app/test/__fixwave2*     -> none present
```
