# Code review round 1 - fix wave (M7 npm test soundness)

Branch `feat/npm-test-soundness`, wave base `2876b205`. Ten ACCEPT rows from
`r1-adjudications.md` (A1, A2, A3, A4, A5, A9, C1, C2, C3, C8, C9), delivered in
four commits. No DECLINE row was touched: there is still no verify hook on
`CreateTable`, the poll ceiling and its exhaustion behaviour are unchanged, and
case 2 still asserts `'exists'`.

Verbose command output: `.superpowers/review/r1-fix-wave-evidence.md`
(gitignored) and the `fw-*.log` files beside it.

## Commits

| hash | what |
|---|---|
| `43641296` | F1 - third dynamo-lane marker for suites that open no local database (A1) |
| `1bdb5f34` | F2/F4/F5/F6 - gate the DeleteTable conflict on `retried`, bound the retry in time (A2, A4, A5, C2, C3) |
| `b81ceb23` | F3/F7 - give the staticSmoke traversal probes a target again (A3, A9, C8, C9) |
| (this commit) | F8 - spec supersession sentence (C1) + this record |

## Per finding

### F1 (A1, blocker) - the guard marker

`app/test/setup/dynamoAccessKeyGuard.test.ts:73` defines
`NO_CONTAINER_TABLES_MARKER = 'hc:dynamo-lane none'` beside
`WORKTREE_DERIVED_KEYS_MARKER` (`:58`), with the docblock the adjudication
specified. `:349` exempts a declaring file from the creates-tables predicate,
and the failure message at `:359-367` names the third remedy. The acceptance
suite declares it at `app/test/dynamoAdminRetry.test.ts:24`, in a header comment
block that also states why case 13's two real `DynamoDBClient`s do not violate
the rot-proof rule.

**Deviation from the brief, deliberate.** The brief said to exempt "a file whose
source includes the new marker, exactly as it exempts `WORKTREE_DERIVED_KEYS_MARKER`
at `:290`" - i.e. a bare `.includes()`. That cannot work for this marker. The
guard file itself defines the constant AND imports the container-reaching client
factory, so under `.includes()` the guard file would count as a declaring suite
and the new rot-proof case would flag the guard file itself. The marker is
therefore matched as a DECLARATION LINE
(`NO_CONTAINER_TABLES_LINE`, `:83`, built from the constant so the text lives in
one place), which is the rule `optsIntoSharedLocalTables` already applies to the
shared marker and for the same recorded reason. `optsIntoSharedLocalTables`
itself is UNCHANGED, so the STOP condition was not reached: no other marker's
matching semantics moved.

Rot-proofing: a new case at `:370`, "a suite declared as touching NO container
tables really cannot reach one". A declaring file must not import the app client
factory module, call `createDynamoClient` / `createDocumentClient` /
`getDocumentClient`, or name a real table (`hc-local-`, `TABLE_PREFIX`).

**Second deviation, forced by measurement.** The first version of that check was
a bare-substring alternation and it FAILED on `dynamoAdminRetry.test.ts` - not
for reaching the container, but because the comment DECLARING the marker has to
explain what the file is exempt from, and it said the words "src/lib/dynamo.js".
`CONTAINER_REACHING` (`:105`) is therefore code-shaped throughout: an import
clause (`from '...dynamo.js'`), a call (`name(`), a quoted prefix
(`'hc-local-`), an object key (`TABLE_PREFIX:`). This is the same lesson the
file already records for the shared marker - prose about a marker must never
behave as the marker.

Guard offender line, before and after:

```
before: expected [ 'app/test/dynamoadminretry.test.ts' ] to deeply equal []
        (1 failed | 13 passed, 14 tests)
after:  15 passed (15) - offenders [] and the new rot-proof case green
```

Mutation probe of the NEW case: a throwaway `app/test/__fixwave_none_probe.test.ts`
carrying the marker and calling `createDynamoClient` made the case fail with
`+ "app/test/__fixwave_none_probe.test.ts"` (1 failed | 14 passed). Deleted; the
older guards in that file were mutation-probed when they were written.

### F2 (A2, must-fix) - `deleteTableIfExists` tolerance gated on `retried`

RED first. Case 18 (`app/test/dynamoAdminRetry.test.ts:494`): local endpoint, a
single `ResourceInUseException` on the first `DeleteTable`, expect a rejection
with that exact instance and one send.

```
RED   case 18 -> AssertionError: promise resolved "undefined" instead of rejecting
GREEN 18 passed (18) after the fix
```

Fix: `app/src/lib/dynamoAdmin.ts:499` adds the per-call `retried` flag and
threads `onRetry` into the `sendWithRetry` call, exactly the `ensureTable`
shape; `:525` tolerates the conflict only when `retried`. The comment at
`:508-524` now says what the code does and names both pinning cases. Case 4 (the
retried path) is unchanged and green.

### F3 (A3, must-fix) - traversal decoys inside the temp root

`app/test/staticSmoke.test.ts:82-99`: `root = mkdtempSync(...)`,
`distDir = <root>/site/dist`, decoys at `<root>/package.json` and
`<root>/site/package.json`, each
`{"name":"static-smoke-decoy","version":"0.0.0","private":true}` - both leak
markers, nothing written outside `root`, and `afterAll` removes `root` whole.

Probe resolution table, measured (`node`, real mkdtemp root, resolver
`path.resolve(distDir, '.' + decodeURIComponent(p))`):

| probe | decoded | resolves to | in root? |
|---|---|---|---|
| `/%2e%2e%2f%2e%2e%2fpackage.json` | `/../../package.json` | `<root>/package.json` | yes |
| `/%2e%2e/%2e%2e/package.json` | `/../../package.json` | `<root>/package.json` | yes (but see below) |
| `/..%2f..%2fpackage.json` | `/../../package.json` | `<root>/package.json` | yes |
| `/..%5c..%5cpackage.json` | `/..\..\package.json` | `<root>/package.json` | yes |
| `/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json` | `/assets/../../../package.json` | `<root>/package.json` | yes |
| `/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd` | `/../../../etc/passwd` | `<tmpdir>/etc/passwd` | NO - shape probe only |

`<root>/site/package.json` is not hit by any of the six; it covers the remaining
in-root depth (one level above dist) for a future probe or a differently-rooted
dist.

**Leaky-layer proof.** Throwaway `app/test/__fixwave_leaky_static.test.ts` built
the evidence-E3 shape (resolve the decoded path itself; serve the file if it
exists, else the SPA shell), pointed it at the NEW fixture and at the OLD
target-less one, and ran the EXACT six probes with the EXACT assertion block
from the real suite:

```
NEW FIXTURE (decoys inside root) failures: 4/6
  /%2e%2e%2f%2e%2e%2fpackage.json                  -> served the decoy ("version")
  /..%2f..%2fpackage.json                          -> served the decoy
  /..%5c..%5cpackage.json                          -> served the decoy
  /assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json  -> served the decoy
OLD FIXTURE (no target anywhere) failures: 0/6
```

Then the REAL suite against the new fixture: `12 passed (12)`, exit 0, no skips
(the (c) diagnostic PASSED - `dashboard/dist/index.html` is present and fresh in
this worktree; nothing was built). Throwaway deleted;
`git status --short` shows no `__fixwave_*` file.

The traversal comment (`:236-274`) was rewritten to state all of this, including
the dated `send` version (C9).

### F4 (A4, should-fix) - elapsed-time deadline

RED first. Case 21 (`:569`): every `CreateTable` attempt takes ~30ms
(`delayMs`, a new optional field on the stub's `Step`, `:67` and `:183`) and
throws `InternalFailure`; schedule `{ backoffMs: () => 0, deadlineMs: 50 }`.

```
RED   case 21 -> AssertionError: expected 4 to be less than or equal to 3
GREEN 19 passed (19) after the fix, with 2 <= sends <= 3
```

Fix: `deadlineMs` on `RetrySchedule` (`app/src/lib/dynamoAdmin.ts:135`),
`DEFAULT_DEADLINE_MS = 20_000` with its rationale at `:144-152`, `startedAt`
before attempt 1 (`:223`) and the check at `:238` - inside the catch, after the
retryable test and the attempt bound, before the endpoint gate. The hot path
never reads the clock. Case 10 (four zero-backoff sends) stays green; it
completes in milliseconds.

### F5 (A5) - comment only

`app/src/lib/dynamoAdmin.ts:155-164`: why 10s here is not `db-update-gsis`'s
900s. No behaviour change.

### F6 (C2, C3) - cases 19 and 20

Case 19 (`:511`): `CreateTable` `InternalFailure` then `ResourceInUseException`,
`DescribeTable` always CREATING, poll `{ intervalMs: 1, ceilingMs: 20 }`. The
rejection is a `ResourceInUseException` instance (not `TableNotActiveError`)
whose message carries both halves - the physical name `stub-c19` and the
observed `CREATING`.

Case 20 (`:538`): two stub clients under one `Promise.all`. A is
`[InternalFailure, ResourceInUse]` with `DescribeTable` ACTIVE; B is a single
`ResourceInUse` whose send is delayed 25ms, so it lands after A's retry has
fired. A polls (`DescribeTable >= 1`); B issues ZERO.

**Teeth, measured, not reasoned.** A scratch mutation hoisted `retried` to
module scope in `dynamoAdmin.ts` (local declaration removed, module-level `let`
added). Case 20 failed:

```
AssertionError: expected 1 to be +0 // Object.is equality
```

- the plain concurrent call inherited A's flag and polled. The mutation was
reverted (`grep 'SCRATCH PROBE'` empty, two `let retried = false;` in place) and
the suite re-run: `21 passed (21)`.

### F7 (A9, C8)

`afterAll` at `app/test/staticSmoke.test.ts:99` is guarded on `root` having been
created. The hardening-headers loop variable is `route` (`:214-234`), including
every `expect(..., route)` message argument; nothing else in that block changed.

### F8 (C1)

One bracketed ASCII sentence appended to the "Fixture contents are specified"
paragraph in `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`.
Nothing else in the spec was touched.

## Verify

All run bare and foreground from `W:\tmp\npm-test-soundness\app` unless noted,
one at a time, output captured to a file and read.

| command | exit | result |
|---|---|---|
| `npx vitest run test/dynamoAdminRetry.test.ts` | 0 | 21 passed (21) |
| `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` | 0 | 15 passed (15) |
| `npx vitest run test/staticSmoke.test.ts` | 0 | 12 passed (12), 0 skipped |
| `npx vitest run test/dynamo.integration.test.ts` | 0 | 2 passed (2) |
| `npx vitest run test/globalSetupEnsure.test.ts` | 0 | 5 passed (5) |
| `npx vitest run test/dynamoKeyLedger.test.ts` | 0 | 7 passed (7) |
| `npx vitest run test/unreadIndexRepo.integration.test.ts` | 0 | 23 passed (23) |
| `npx vitest run test/todayUnmatchedNonRegression.test.ts` | 0 | 1 passed (1) |
| `npx vitest run test/importApply.integration.test.ts` | 0 | 31 passed (31) |
| `npm run typecheck` (repo root) | 0 | clean |
| `npx eslint <the five touched files>` (repo root) | 0 | no output |

ASCII: every added line across `2876b205..HEAD` scanned for `charCode > 126` -
zero hits.

No full `npm test`, `npm run e2e` or `npm run smoke` was run; the DynamoDB Local
container was not restarted; `E2E_CHILD_LOG_DIR` was never set.

## Seen and NOT fixed - for the orchestrator

1. **One traversal probe never reaches the server as traversal.**
   `/%2e%2e/%2e%2e/package.json` arrives at express as plain `/package.json`:
   the HTTP client's URL parser decodes `%2e` and collapses the resulting `..`
   segments (measured 2026-09-01 - a bare express app echoing `req.path` under
   supertest returns `/package.json` for that probe and the raw string for the
   other five). It is why the leaky layer leaks 4 of 6 rather than 5 of 6. The
   probe still exercises the no-such-file path, and a raw socket would not
   normalise it, so it was kept and the comment now says so - but it is not a
   traversal assertion and nobody should count it as one.
2. **The guard file exempts itself from its own creates-tables case**, and
   always has: it contains `CreateTableCommand` and no `randomUUID`, and its own
   `const WORKTREE_DERIVED_KEYS_MARKER = '...'` line satisfies the `.includes()`
   exemption at `:340`. Harmless today (its one container table is
   `hc-guard-${Date.now().toString(36)}`, which is per-run-varying in practice),
   but it is an accident, not a decision. Untouched: outside this wave's scope.
3. **A6/A8 remain open** exactly as adjudicated (a create that lands on attempt 1
   followed by three more `InternalFailure`s is still lost; the retried path
   still returns `'exists'` for a table it created). Nothing in this wave moved
   either.
