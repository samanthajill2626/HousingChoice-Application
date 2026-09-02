# r1 fix wave - raw evidence (gitignored)

Branch `feat/npm-test-soundness`, wave base `2876b205`. All commands from
`W:\tmp\npm-test-soundness\app` unless noted. Full captured output is in the
sibling `fw-*.log` files.

---

## F1. The guard, RED then GREEN

`fw-f1-red.log` (before any change), exit 1:

```
 x per-file DynamoDB Local access keys > every unmarked suite that CREATES
   container tables mints per-run random names   94ms
AssertionError: These suites create DynamoDB Local tables in a SHARED per-file
database without a per-run random component in their table names. ...
  expected [ 'app/test/dynamoadminretry.test.ts' ] to deeply equal []
 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
```

First attempt at the rot-proof case, with a bare-substring `CONTAINER_REACHING`
(exit 1) - the DECLARING comment tripped it:

```
 x a suite declared as touching NO container tables really cannot reach one
   + "app/test/dynamoadminretry.test.ts"
      Tests  1 failed | 14 passed (15)
```

Cause: the header comment that declares the marker explains what the suite is
exempt from and names `src/lib/dynamo.js`. Fixed by making every alternative
code-shaped (import clause / call / quoted prefix / object key).

`fw-f1-green.log`, exit 0:

```
 v test/setup/dynamoAccessKeyGuard.test.ts (15 tests) 583ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

Mutation probe of the new case (`fw-f1-probe.log`, exit 1). Throwaway
`app/test/__fixwave_none_probe.test.ts`: marker on a comment line +
`import { createDynamoClient } from '../src/lib/dynamo.js'` + a call.

```
+   "app/test/__fixwave_none_probe.test.ts",
      Tests  1 failed | 14 passed (15)
```

Deleted; `git status --short` clean of it.

`fw-f1-retry.log`: `npx vitest run test/dynamoAdminRetry.test.ts` -> 17 passed
(17), exit 0 (the marker comment alone changes nothing).

---

## F2. Case 18, RED then GREEN

`fw-f2-red.log`, exit 1:

```
 x case 18: an UN-RETRIED ResourceInUseException on DeleteTable still throws  8ms
   -> promise resolved "undefined" instead of rejecting
      Tests  1 failed | 17 skipped (18)
```

`fw-f2-green.log`, exit 0: `18 passed (18)` - case 4 (retried DeleteTable
conflict, tolerated) unchanged and green alongside it.

---

## F3. Probe resolution and the leaky-layer proof

Resolution measured with a real mkdtemp root
(`root = C:\Users\Cameron\AppData\Local\Temp\hc-probe-95QLWa`,
`distDir = <root>\site\dist`), resolver
`path.resolve(distDir, '.' + decodeURIComponent(probe))`:

```
/%2e%2e%2f%2e%2e%2fpackage.json                  -> <root>\package.json          inside=true
/%2e%2e/%2e%2e/package.json                      -> <root>\package.json          inside=true
/..%2f..%2fpackage.json                          -> <root>\package.json          inside=true
/..%5c..%5cpackage.json                          -> <root>\package.json          inside=true
/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json  -> <root>\package.json          inside=true
/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd         -> <tmpdir>\etc\passwd          inside=false
```

Leaky layer (`fw-f3-leaky.log`, throwaway
`app/test/__fixwave_leaky_static.test.ts`, since deleted), express app that
resolves the decoded path itself and serves the file if it exists, SPA shell
otherwise - the evidence-E3 shape - driven with the exact six probes and the
exact assertion block:

```
NEW FIXTURE (decoys inside root) failures: 4/6
  /%2e%2e%2f%2e%2e%2fpackage.json: expected '{"name":"static-smoke-decoy","version...' not to contain '"version"'
  /..%2f..%2fpackage.json: ... same
  /..%5c..%5cpackage.json: ... same
  /assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json: ... same
OLD FIXTURE (no target anywhere) failures: 0/6
```

Why 4 and not 5 - `req.path` as express actually receives it (bare express app
echoing `req.path`, driven by supertest, 2026-09-01):

```
/%2e%2e%2f%2e%2e%2fpackage.json                  -> /%2e%2e%2f%2e%2e%2fpackage.json
/%2e%2e/%2e%2e/package.json                      -> /package.json        <-- normalised by the CLIENT
/..%2f..%2fpackage.json                          -> /..%2f..%2fpackage.json
/..%5c..%5cpackage.json                          -> /..%5c..%5cpackage.json
/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json  -> /assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json
/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd         -> /%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd
```

The URL parser decodes `%2e` and collapses `..` only where the separators are
real `/` characters; the `%2f` / `%5c` spellings keep the whole thing one
segment, which is exactly why those survive to the server.

Real suite after the change (`fw-f3-static.log`), exit 0:

```
 v test/staticSmoke.test.ts (12 tests) 175ms
      Tests  12 passed (12)
```

Zero occurrences of "skip" in that log; `dashboard/dist/index.html` present, so
the (c) diagnostic PASSED. Nothing was built.

---

## F4. Case 21, RED then GREEN

`fw-f4-red.log`, exit 1:

```
 x case 21: the retry stops at its ELAPSED-TIME deadline, not just the attempt bound  192ms
   -> expected 4 to be less than or equal to 3
      Tests  1 failed | 18 skipped (19)
```

`fw-f4-green.log`, exit 0: `19 passed (19)`.

---

## F6. Case 20 teeth

Scratch mutation in `app/src/lib/dynamoAdmin.ts`: the `let retried = false;`
inside `ensureTable` removed, a module-level `let retried = false;` added.
`fw-f6-case20-probe.log`, exit 1:

```
 x case 20: a CONCURRENT plain conflict does not inherit the retried call flag  45ms
AssertionError: expected 1 to be +0 // Object.is equality
      Tests  1 failed | 20 skipped (21)
```

(The failing assertion is `plainStub.count('DescribeTable')` - the un-retried
concurrent call polled.)

Reverted; `grep -n "SCRATCH PROBE" app/src/lib/dynamoAdmin.ts` empty,
`grep -c "let retried = false;"` = 2. `fw-f6-restored.log`, exit 0:
`21 passed (21)`.

---

## Verify pass

```
dynamoAdminRetry.test.ts               EXIT=0   21 passed (21)
setup/dynamoAccessKeyGuard.test.ts     EXIT=0   15 passed (15)
staticSmoke.test.ts                    EXIT=0   12 passed (12)
dynamo.integration.test.ts             EXIT=0    2 passed (2)
globalSetupEnsure.test.ts              EXIT=0    5 passed (5)
dynamoKeyLedger.test.ts                EXIT=0    7 passed (7)
unreadIndexRepo.integration.test.ts    EXIT=0   23 passed (23)
todayUnmatchedNonRegression.test.ts    EXIT=0    1 passed (1)
importApply.integration.test.ts        EXIT=0   31 passed (31)
npm run typecheck (root)               EXIT=0
npx eslint <5 touched files> (root)    EXIT=0   (no output)
```

ASCII scan of every `+` line in `git diff 2876b205..HEAD`: `non-ascii added
lines: 0`.

## Throwaway cleanup

```
> rm -f app/test/__fixwave_none_probe.test.ts
> rm -f app/test/__fixwave_leaky_static.test.ts
> rm -f app/__fixwave_probe_path.mjs
> git status --short | grep fixwave   -> 0
> ls app/test/__fixwave*              -> none present
```
