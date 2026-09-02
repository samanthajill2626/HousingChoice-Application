# R2 conformance review - verbose evidence (gitignored, not committed)

Tip `b783804a`, wave base `2876b205`.

## Commands (all bare, foreground, from `W:\tmp\npm-test-soundness\app`)

```
npx vitest run test/dynamoAdminRetry.test.ts
  -> 1 file passed, 21 passed (21), 385ms tests / 1.40s, exit 0

npx vitest run test/setup/dynamoAccessKeyGuard.test.ts
  -> 1 file passed, 15 passed (15), 578ms tests / 1.53s, exit 0
  (was 1 failed | 13 passed before the wave, per r1-adversarial finding 1)

npx vitest run test/staticSmoke.test.ts
  -> 1 file passed, 12 passed (12), 0 skipped, exit 0
  (the (c) diagnostic PASSED - dashboard/dist present and fresh)

npx vitest run test/__review_conf2_deadline.test.ts   (THROWAWAY, deleted)
  -> 2 passed (2)
```

ASCII scan, every ADDED line in `git diff 2876b205..b783804a`:
`added lines with chars >126: 0`.

`git status --short` after cleanup shows exactly one untracked file,
`app/test/__review_adv2_gamed.test.ts`, which belongs to the adversarial
reviewer on the same tip and was deliberately left alone. My own throwaway,
`app/test/__review_conf2_deadline.test.ts`, is deleted.

## N1 reproduction - case 21's lower bound under a blocked event loop

Throwaway `app/test/__review_conf2_deadline.test.ts` rebuilt case 21's exact
shape (stub `CreateTable` that sleeps 30ms then throws `InternalFailure`;
schedule `{ backoffMs: () => 0, deadlineMs: 50 }`) and ran it twice: once
undisturbed, once with the event loop blocked by a 60ms synchronous busy-wait
started immediately after `ensureTable` was called - which is what a saturated
vitest worker does to a pending `setTimeout`.

```
PROBE unloaded sends = 2
PROBE loaded sends   = 1   (case 21 asserts >= 2)
```

So the shipped assertion at `app/test/dynamoAdminRetry.test.ts:590`
(`toBeGreaterThanOrEqual(2)`) goes red whenever attempt 1's 30ms timer is
delayed past the 50ms deadline - a 20ms margin. The upper bound (`<= 3`) is
not at risk; only the lower one, which is the half with teeth.

Suggested reshape (deadline binding by a wide margin rather than by 20ms):
inject `attempts: 12`, `delayMs: 20`, `deadlineMs: 200`, then assert
`2 <= sends < 12`. A timer overrun of 2-3x still leaves the deadline, not the
attempt bound, as the thing that stopped the loop.

## N2 arithmetic - the deadline is per retry loop, not per ensureTable

Live anchors:

```
app/src/lib/dynamoAdmin.ts:223   startedAt = Date.now()   (inside retryLocalControlPlane)
app/src/lib/dynamoAdmin.ts:382   sendWithRetry(CreateTable, ...)          -> loop 1
app/src/lib/dynamoAdmin.ts:468   sendWithRetry(DescribeTimeToLive, ...)   -> loop 2
app/src/lib/dynamoAdmin.ts:470   sendWithRetryVerified(UpdateTimeToLive)  -> loop 3
app/src/lib/dynamoAdmin.ts:409   pollUntilTableActive (up to 10s)
```

Each `sendWithRetry` / `sendWithRetryVerified` call enters
`retryLocalControlPlane` fresh, so each gets its own 20s budget. One
`ensureTable` on a TTL-bearing spec (4 of 22, `app/src/lib/tables.ts:231`,
`:246`, `:615`, `:648`) can therefore spend 20 + 20 + 20 + 10 = ~70s. The
comment at `:145-152` asserts ~20s per table.

Under `npm test` the TTL half is off in workers (`app/vitest.config.ts:119`),
capping it at ~30s there; `globalSetup` does NOT receive `test.env` (this
mission's own item-1A finding), and `db:create` and the e2e lanes run with the
flag unset, so all three reach loops 2 and 3.

## N3 - the rot-proof check does not follow imports

```
app/test/dynamoAdminRetry.test.ts:35    import { ensureGsis } from '../scripts/db-update-gsis.js';
app/scripts/db-update-gsis.ts:34        import { createDynamoClient } from '../src/lib/dynamo.js';
```

`CONTAINER_REACHING` (`app/test/setup/dynamoAccessKeyGuard.test.ts:105-112`)
is applied only to the declaring file's own source
(`:388-390`), so the transitive import above is invisible to it. It is
harmless here because the only `createDynamoClient` call in
`db-update-gsis.ts` sits inside the CLI argv guard at `:240`, which never
matches under vitest - but the mechanism is one indirection deep, and the file
it was written for is already using that indirection.

## Line anchors verified against the live tree (post-wave numbering)

```
dynamoAdmin.ts   128 attempts?   135 deadlineMs?   144 DEFAULT_ATTEMPTS
                 145-151 deadline rationale        152 DEFAULT_DEADLINE_MS
                 153 poll interval  157-163 A5 comment  164 poll ceiling
                 219-221 attempts/backoff/deadline resolution   223 startedAt
                 233 attempt bound   238 deadline check   239 endpoint gate
                 241 verify hook     334 pollUntilTableActive
                 380 ensureTable retried   407 if (retried)   409 poll call
                 468 TTL pre-send   470 TTL verified send
                 492 deleteTableIfExists   499 its retried   525 gated tolerance
staticSmoke      82-83 root/distDir   85-93 beforeAll   95-100 guarded afterAll
                 104-114 fixtureApp   214 route loop   236-296 traversal case
                 308 / 323 CSP cases use fixtureApp   339 (b)   364 (c)
dynamoAdminRetry 24 marker line   494 case 18   511 case 19   538 case 20
                 569 case 21   590 the fragile lower bound
spec             528-530 the C1 supersession sentence
```

## Cross-checks

- Traversal probe list and all four assertions are byte-identical to the r1
  tip; the wave changed only the comment above them (confirmed by filtering
  the wave diff for the assertion text - no `+`/`-` line carries it).
- `for (const path of` no longer appears anywhere in `staticSmoke.test.ts`
  (C8).
- `pollUntilTableActive`'s body, case 2's `'exists'` expectation and the
  absence of a `CreateTable` verify hook are all unchanged, matching the wave
  record's claim that no DECLINE row was touched.
- `app/test/logCallSiteGuard.test.ts` and `app/scripts/db-update-gsis.ts` are
  absent from the wave diff, so S2 and S1.4 are untouched.
