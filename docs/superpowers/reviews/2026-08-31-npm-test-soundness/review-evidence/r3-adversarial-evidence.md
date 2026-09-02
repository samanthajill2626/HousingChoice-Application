# r3 adversarial review - raw evidence (gitignored)

Tip `1079bf05`, wave 2 = `ad47aec1..1079bf05`. All commands from
`W:\tmp\npm-test-soundness\app`.

## All three touched suites green at the new tip

```
> npx vitest run test/dynamoAdminRetry.test.ts test/staticSmoke.test.ts test/setup/dynamoAccessKeyGuard.test.ts
 v test/dynamoAdminRetry.test.ts (22 tests) 556ms
 v test/setup/dynamoAccessKeyGuard.test.ts (15 tests) 755ms
 v test/staticSmoke.test.ts (12 tests) 472ms
 Test Files  3 passed (3)   Tests  49 passed (49)
```

## N1 closure - the r2 reproduction flipped

Same throwaway as r2 evidence N1, byte for byte in its stub script: local
endpoint, TTL spec, `deadlineMs: 20`, a 30ms `UpdateTimeToLive` that throws
`InternalFailure`, `DescribeTimeToLive` answering DISABLED then ENABLED.

r2 (`b783804a`):  `{"err":"InternalFailure"}`, ttlReads 1 (hook never ran)
r3 (`1079bf05`):

```
N1-closure outcome: {"ok":"created"} ttlReads: 2
```

Two reads = the pre-send guard AND the hook. The deadline check now sits at
`app/src/lib/dynamoAdmin.ts:283`, after the verify block (`:263-275`) and before
`onRetry`. Case 22 (`app/test/dynamoAdminRetry.test.ts:636`) pins it.

Semantics not disturbed: no double-verify (one hook call per failed attempt,
then the deadline read); `onRetry` is correctly skipped on a deadline expiry
because no re-send happens, and the `retried` flag it feeds is only ever
consulted on a `ResourceInUseException`, which is non-retryable and exits at
`:257` long before the deadline read. Cases 7 (verify throws -> rethrow
original) and 10 (bound 4, hook 3x) are unchanged - verify still precedes the
deadline, and the default 20_000 deadline cannot fire in a millisecond-scale
test. Both green.

## N2 closure - the r2 gamed file is now caught

Recreated the exact r2 throwaway: a file carrying a bare `// hc:dynamo-lane none`
declaration line plus `import { createAllTables, dropAllTables } from
'../scripts/db-create.js'`.

r2: appeared in NEITHER guard list (marker exempted it; rot-proof case passed).
r3:

```
 x per-file DynamoDB Local access keys > a suite declared as touching NO container tables really cannot reach one
   + Received  [ "app/test/__review_adv3_gamed.test.ts" ]
```

Caught by the widened `CONTAINER_REACHING`
(`app/test/setup/dynamoAccessKeyGuard.test.ts:122-134`). No false positives: the
check applies only to `none` declarers, of which the tree has exactly one
(`app/test/dynamoAdminRetry.test.ts:24`), and the guard is 15/15 green on a
clean tree. The remaining one-hop import gap is now stated at `:109-116`.

## N5 closure - case 21's new shape measured

Shipped parameters (`app/test/dynamoAdminRetry.test.ts:628`): `attempts: 12`,
`delayMs: 20`, `deadlineMs: 200`, `backoffMs: () => 0`. Five runs of a
stand-alone replica:

```
case21 send counts: [5,5,5,5,5]   (the case asserts >= 2 and < 12)
```

Five, not the ~10 a naive 200/20 would predict - Windows timer granularity makes
each `delay(20)` cost ~40ms. Either way the band is wide on both sides: the
lower bound needs attempt 1 alone to exceed 200ms (~180ms of slack, versus the
~20ms of the r2 shape), and the upper bound is more than twice the observed
count. The r2 flake is gone.

## R1 - the elapsed bound also carries a VERIFY read

The wave moved the verify block inside the pre-deadline region, so a slow hook
read extends the wall clock past `deadlineMs` too. Stub with `deadlineMs: 10`, a
60ms `UpdateTimeToLive` attempt, and a 120ms hook `DescribeTimeToLive`:

```
elapsed with deadlineMs=10: 184 ms; ttlReads: 2
```

184ms against a comment (`app/src/lib/dynamoAdmin.ts:154-156`) that states "the
effective bound is deadlineMs PLUS one attempt" - i.e. ~70ms here. The
understatement is exactly the hook read the same wave moved. Comment-only; the
behaviour is the intended one.

## Fixture (N8, conformance N6)

`app/test/staticSmoke.test.ts:85-97`: one recursive `mkdirSync` of
`<root>/site/dist/assets` before any write, then three writes - two under
`distDir`, one at `<root>/package.json`. `<root>/site/package.json` is gone.
Nothing outside `root`; `afterAll` still guarded on `root`. 12/12 green.

## Case 20 (N9)

`app/test/dynamoAdminRetry.test.ts:575-604`: both stubs `recordInto` one shared
answer-ordered timeline; the case asserts `retriedSecond > -1` and
`plainFirst > retriedSecond`. If B's delayed send ever answered before A's
retry, that assertion FAILS rather than passing silently - the vacuity is
closed. Answer-order tracks catch-order to within a microtask, which is what the
per-call flag question turns on.

## Cleanup

```
> rm -f app/test/__review_adv3_probe.test.ts app/test/__review_adv3_gamed.test.ts
> git status --short
(no output)
```
