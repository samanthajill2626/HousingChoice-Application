# r2 adversarial review - raw evidence (gitignored)

Branch `feat/npm-test-soundness`, tip `b783804a`, fix wave `2876b205..b783804a`.
All commands from `W:\tmp\npm-test-soundness\app`.

---

## N1. The deadline exit skips the verification hook - CONFIRMED

Order inside the catch of `retryLocalControlPlane`
(`app/src/lib/dynamoAdmin.ts:233-252`):

1. not-retryable -> throw
2. `n >= attempts` -> throw
3. `Date.now() - startedAt >= deadlineMs` -> throw   <- NEW, added by the wave
4. resolve `local`; not local -> throw
5. `opts.verify` -> if landed, RETURN SUCCESS
6. `onRetry`, sleep, loop

Step 3 precedes step 5, so a deadline expiry throws the container fault without
ever asking whether the mutation landed.

Throwaway `app/test/__review_adv2_probe.test.ts` (deleted). Stub client, local
endpoint, `getTableSpec('messages')` (TTL spec), `deadlineMs: 20`,
`backoffMs: () => 0`. `UpdateTimeToLive` waits 30ms then throws `InternalFailure`.
The `DescribeTimeToLive` script answers `DISABLED` on read 1 (the pre-send guard)
and `ENABLED` on read 2 - i.e. the mutation LANDED and a hook call would say so.

```
N1 outcome: {"err":"InternalFailure"}
    log: ["CreateTable","other","DescribeTimeToLive","UpdateTimeToLive"]
```

`ttlReads === 1`. Only the pre-send guard ran; the verify hook was never called.
`ensureTable` rejected. The information that the mutation succeeded was one cheap
read away and was not read.

Same shape applies to the other hooked caller, `ensureGsis`
(`app/scripts/db-update-gsis.ts:197-212`). Real-world interleaving, default
`deadlineMs` 20_000 and the lock-timeout signature the module's own comment
(`app/src/lib/dynamoAdmin.ts:84-88`) prices at ~10s per attempt:

- t=0.0s  UpdateTable attempt 1 sent
- t=10.0s lock-timeout `InternalServerError`; 10000 < 20000 -> continue;
          verify says index absent -> re-send
- t=10.3s attempt 2 sent; the SERVER ACCEPTS it and starts the backfill
- t=20.4s its response fails with `InternalFailure`; n=2 < attempts=4;
          20400 >= 20000 -> THROW, hook never called
- `ensureGsis` propagates -> `scripts/e2e-session.mjs:690`'s
  `runOnce('db-update-gsis')` fails -> lane start fails, while the index IS
  being created.

The deadline can fire on attempt 2 of 4, i.e. EARLIER than the attempt bound, and
fires preferentially on the slow fault - the one where the server spent 10s
doing work and is therefore most likely to have accepted the request.

One-line remedy: move the step-3 check to after the step-5 verify block (or
immediately before `onRetry`). The hook is one read and cannot loop.

---

## N2. The `none` marker's rot-proof check is gameable - CONFIRMED

`CONTAINER_REACHING` (`app/test/setup/dynamoAccessKeyGuard.test.ts:105-112`)
matches four code shapes: an import specifier ending `/dynamo.js`, a call to
`createDynamoClient` / `createDocumentClient` / `getDocumentClient`, a quoted
`hc-local-` prefix, or a `TABLE_PREFIX:` key.

None of those covers a helper that creates tables on the file's behalf.
Throwaway `app/test/__review_adv2_gamed.test.ts` (deleted), carrying a bare
`// hc:dynamo-lane none` declaration line and:

```
import { createAllTables, dropAllTables } from '../scripts/db-create.js';
import { ensureTable } from '../src/lib/dynamoAdmin.js';
```

`createAllTables` is `app/scripts/db-create.ts:31`; it builds its own
`createDynamoClient` and calls `ensureTable` for all 22 specs under
`tableName(spec.baseName)` - FIXED names in the file's per-file database. That is
exactly the cross-worktree collision the creates-tables guard exists to prevent.

Guard run with that file present:

```
 v ... > a suite declared as touching NO container tables really cannot reach one   91ms
 x ... > every unmarked suite that CREATES container tables mints per-run random names
   + Received  [ "app/test/__review_conf2_deadline.test.ts" ]
```

The gamed file appears in NEITHER list: the marker exempted it from the
creates-tables guard, and the rot-proof case did not catch it. (The single
offender shown is a different reviewer's untracked scratch file - see N6.)

Note also that `dynamoAdminRetry.test.ts` already reaches `src/lib/dynamo.js`
transitively today: it imports `../scripts/db-update-gsis.js`
(`app/test/dynamoAdminRetry.test.ts:48`), which imports `createDynamoClient` at
`app/scripts/db-update-gsis.ts:34`, and which also imports `./db-create.js`.
Harmless now (both CLI blocks are argv-gated and no client is constructed), but
it shows the marker's comment - "the app's own client factory is the ONLY thing
that reaches the container, so importing that module ... is the reachable
definition" - is a statement about the file's SOURCE TEXT, not about its module
graph.

Cheapest hardening: add `\/db-create\.js|\/db-seed\.js` and
`\b(?:createAllTables|dropAllTables)\s*\(` to `CONTAINER_REACHING`, or resolve
the file's static imports one level.

---

## N3. The deadline comment's claimed bound - CONFIRMED

`app/src/lib/dynamoAdmin.ts:145-152` claims "a 22-table loop cannot lose more
than ~20s to any one contended table". Three ways that is exceeded:

(a) The deadline is checked BEFORE a re-send, never during one
(`:238`). An attempt started at t=19.9s that blocks ~10s returns at ~29.9s.
Bound is therefore `deadlineMs + one attempt`, not `deadlineMs`.

(b) One `ensureTable` on a TTL-bearing spec makes FOUR independent
`retryLocalControlPlane` calls, each with its OWN fresh `startedAt` (`:223`):
the CreateTable send (`:381`), the pre-send `ttlStatus` read (`:468`), the
`UpdateTimeToLive` send (`:470`), plus `pollUntilTableActive`'s own 10s ceiling
(`:409`). Up to ~70s for one table. (`DYNAMO_DISABLE_TTL` is set for `npm test`,
so the two TTL legs bind `db:create` and the e2e lanes rather than the unit
gate.)

(c) `waitUntilTableExists({ client, maxWaitTime: 60 })` at `:392` sits inside no
budget at all - see N4.

---

## N4. The SDK waiter the branch criticises is still on the common path - CONFIRMED

`app/src/lib/dynamoAdmin.ts:323-326` (the docblock introducing
`pollUntilTableActive`) argues against `waitUntilTableExists` because "the SDK
waiter's default schedule makes its second poll a flat 20s and it throws at 60s,
which is the whole budget of the beforeAll hooks that reach ensureTable. Arming a
new false red while fixing an old one is not a trade worth making."

`app/src/lib/dynamoAdmin.ts:392` still calls exactly that waiter, with
`maxWaitTime: 60`, on the SUCCESS path of `ensureTable` - the path taken by every
one of the ~50 test callers and by `app/scripts/db-create.ts:36` on every run.
The waiter was replaced only on the rare retried-conflict path (`:409`). Verified
by grep:

```
15:  waitUntilTableExists,
323: * NOT waitUntilTableExists: the SDK waiter's ...
392:    await waitUntilTableExists({ client, maxWaitTime: 60 }, ...);
409:        await pollUntilTableActive(client, physicalName, opts.poll);
```

Not a regression (the waiter predates the branch), but the comment now reads as
if the hazard were removed when it was only relocated.

---

## N5. Acceptance case 21 is timing-fragile - CONFIRMED

`app/test/dynamoAdminRetry.test.ts:569-591`: each scripted `CreateTable` takes
30ms (`delayMs: 30`) against `deadlineMs: 50`, and the case asserts the send
count is `>= 2` (`:590`) and `<= 3`.

Attempt 1 fails at t~30ms, `30 < 50` -> re-send. Attempt 2 fails at t~60ms,
`60 >= 50` -> throw. Count 2, the lower bound exactly. The margin on attempt 1 is
~20ms.

Throwaway with `delayMs: 60` and the same 50ms deadline:

```
N2 CreateTable sends: 1 (case 21 asserts >= 2)
```

One send - below the lower bound. So ~30ms of extra latency on the first send
(setTimeout skew plus scheduling, entirely ordinary under `maxWorkers: 4` on a
contended box - the condition this whole branch is about) flips case 21 red.
A fault-count-based assertion, or a deadline several multiples of the scripted
delay, would remove the dependence.

---

## N6. The guard reads untracked scratch files - CONFIRMED (live)

`allAppTestFiles(TEST_DIR)` walks `app/test` on disk. During this review a
DIFFERENT reviewer's untracked throwaway, `app/test/__review_conf2_deadline.test.ts`,
turned the creates-tables case red on this worktree:

```
 + Received  [ "app/test/__review_conf2_deadline.test.ts" ]
```

Pre-existing guard behaviour, not introduced by the wave - but the wave's whole
point is that a stub suite is now a legitimate shape, so more people will write
one, and a scratch file that names `ensureTable` reds gate 2 for a reason that has
nothing to do with the branch under test.

---

## R1 closure re-verification

### A1 - CLOSED

Clean tree (`git status --short` empty):

```
> npx vitest run test/setup/dynamoAccessKeyGuard.test.ts
 v test/setup/dynamoAccessKeyGuard.test.ts (15 tests) 558ms
 Test Files  1 passed (1)
      Tests  15 passed (15)
```

`dynamoAdminRetry.test.ts` no longer appears in any offender list. The
declaration-line regex (`:83-87`) correctly does NOT self-match the guard file's
own prose and string constant - the guard file was not flagged, which was the
stated risk.

### A2 - CLOSED

Throwaway re-run of the r1 E2 reproduction:

```
 v non-local endpoint, first-attempt ResourceInUseException -> THROWS now
   (rejects with the SAME object; sent === ['DeleteTable'])
 v a RETRIED conflict is still tolerated (local endpoint)
   (InternalServerError then ResourceInUseException -> resolves; 2 sends)
```

`app/src/lib/dynamoAdmin.ts:525` gates on `retried`, fed by the per-call
`onRetry` at `:503-505`. Case 18 (`:494-509`) pins the un-retried throw with an
identity assertion.

### A3 - CLOSED

Re-run of the r1 E3 leaky-layer reproduction, now over the wave's three-level
fixture (`<root>/site/dist`, decoys at `<root>/package.json` and
`<root>/site/package.json`):

```
E3 NEW-FIXTURE leaky failures:
["/%2e%2e%2f%2e%2e%2fpackage.json","/..%2f..%2fpackage.json",
 "/..%5c..%5cpackage.json","/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json"]
```

4 of 6 fail against a leaky resolver, versus 0 of 6 at `796b8632`. Exactly the
four the new comment names. Falsifiability restored, independently confirmed.

The real app stays green: `npx vitest run test/staticSmoke.test.ts` -> 12 passed.

### A9 - CLOSED

`app/test/staticSmoke.test.ts:82` declares `root: string | undefined`; `:99`
guards `if (root) rmSync(root, ...)`. Read the whole `beforeAll` (`:85-93`):
every write is `path.join(root, ...)` or under `distDir` (itself
`path.join(root,'site','dist')`). Nothing is written outside the mkdtemp root.

### Suites green at the new tip

```
> npx vitest run test/dynamoAdminRetry.test.ts test/staticSmoke.test.ts
 v test/dynamoAdminRetry.test.ts (21 tests) 378ms
 v test/staticSmoke.test.ts (12 tests) 185ms
 Test Files  2 passed (2)   Tests  33 passed (33)
```

### ASCII

```
app/src/lib/dynamoAdmin.ts                    non-ascii: 1  (em dash, line 1, pre-existing, untouched)
app/test/dynamoAdminRetry.test.ts             non-ascii: 0
app/test/staticSmoke.test.ts                  non-ascii: 0
app/test/setup/dynamoAccessKeyGuard.test.ts   non-ascii: 0
```

### Cleanup

```
> rm -f app/test/__review_adv2_probe.test.ts app/test/__review_adv2_gamed.test.ts
> git status --short
(no output)
```
