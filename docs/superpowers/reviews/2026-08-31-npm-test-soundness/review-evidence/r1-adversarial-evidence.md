# r1 adversarial review - raw evidence (gitignored)

Branch `feat/npm-test-soundness` tip `796b8632`, merge base `5ce9912f`.
All commands run from `W:\tmp\npm-test-soundness\app` unless noted.

---

## E1. `npm test` is RED: the new acceptance suite trips the repo's own guard

```
> npx vitest run test/setup/dynamoAccessKeyGuard.test.ts

 x per-file DynamoDB Local access keys > every unmarked suite that CREATES
   container tables mints per-run random names   94ms

AssertionError: These suites create DynamoDB Local tables in a SHARED per-file
database without a per-run random component in their table names. ...
  expected [ 'app/test/dynamoadminretry.test.ts' ] to deeply equal []

 Test Files  1 failed (1)
      Tests  1 failed | 13 passed (14)
```

The guard's predicate (`app/test/setup/dynamoAccessKeyGuard.test.ts:277-293`):

- `createsTables` = source matches `ensureTable|CreateTableCommand|createAllTables|ensureKeyedLocalTables`
  -> TRUE for the new file (it imports `ensureTable` and `CreateTableCommand`).
- not `optsIntoSharedLocalTables(f)` -> the file carries no `hc:dynamo-lane shared` marker.
- not `WORKTREE_DERIVED_KEYS_MARKER` -> absent.
- `!/randomUUID|Math\.random/` -> TRUE, the file has neither.

=> offender. The guard file is NOT in the branch diff (`git diff --stat 5ce9912f..796b8632`
lists only db-update-gsis.ts, dynamoAdmin.ts, dynamoAdminRetry.test.ts,
logCallSiteGuard.test.ts, staticSmoke.test.ts and docs), and the sole offender is
the branch's own new file, so attribution is unambiguous.

Substantively the guard is a false positive - `dynamoAdminRetry.test.ts` is a pure
stub suite with NO network and NO container tables - but it is a real, deterministic
gate failure that needs no container contention to reproduce.

Green control runs on the same worktree, same session:

```
> npx vitest run test/dynamoAdminRetry.test.ts     -> 17 passed
> npx vitest run test/staticSmoke.test.ts          -> 12 passed
```

---

## E2. `deleteTableIfExists` swallows ResourceInUseException ungated

Base (`git show 5ce9912f:app/src/lib/dynamoAdmin.ts`), the whole catch:

```
} catch (err) {
  if (!(err instanceof ResourceNotFoundException)) throw err;
}
```

Head (`app/src/lib/dynamoAdmin.ts:476-483`) adds `if (err instanceof
ResourceInUseException) return;` with a comment justifying it for "a retried
DeleteTable". There is no `retried` flag (unlike `ensureTable`, which threads
`onRetry` -> `retried` and gates its poll on it at line 380), and no endpoint gate.

Throwaway reproduction (`app/test/__review_adv_probe.test.ts`, since deleted):
a stub client whose endpoint hostname is `dynamodb.us-east-1.amazonaws.com` and
whose FIRST `send` throws `ResourceInUseException`:

```
 v ADV: deleteTableIfExists swallows ResourceInUse with ZERO retries, any endpoint
   > non-local endpoint, first-attempt ResourceInUseException -> resolves, one send
```

`deleteTableIfExists` resolved, and `sent` was exactly `['DeleteTable']` - one send,
no retry, non-local endpoint. So the tolerance applies on the very first attempt on
any endpoint, not only after a local retry.

Why the acceptance suite cannot see it: case 4
(`app/test/dynamoAdminRetry.test.ts:258-268`) scripts `[internalFailure,
resourceInUse]`, i.e. it only ever exercises the RETRIED path. A version of the
code that gated the swallow on `retried` would pass case 4 identically. There is no
case for an un-retried ResourceInUseException.

Consumers reached: `app/scripts/db-create.ts:63` and `:75` (dropAllTables, used by
`db:create --reset` and `--drop`, which `npm run dev -- --local` and
`scripts/e2e-stop.mjs` drive) plus ~50 test files. The sharpest test consumer is the
delete-then-create hook, e.g. `app/test/importApply.integration.test.ts:72-77`:

```
beforeAll(async () => {
  for (const t of TABLES) {
    await deleteTableIfExists(client, table(t));
    await ensureTable(client, getTableSpec(t), table(t));
  }
}, 60_000);
```

Interleaving: table `T` is CREATING or UPDATING (a concurrent worktree's
globalSetup, or a GSI backfill from `db:update-gsis` on an e2e lane).
`DeleteTable T` -> ResourceInUseException -> HEAD swallows -> `ensureTable T` ->
CreateTable -> ResourceInUseException -> `retried` is false -> returns `'exists'`
with no poll -> the suite runs against a table carrying the PREVIOUS run's rows.
At base the same interleaving threw out of the hook naming the resource conflict.

In `dropAllTables` the swallow instead defers the failure to
`waitUntilTableNotExists({maxWaitTime: 60})` on the next line, so `db:create --reset`
now burns 60s and fails at the waiter instead of failing immediately with the real
cause.

---

## E3. The staticSmoke traversal probes lost their target

Base (`git show 5ce9912f:app/test/staticSmoke.test.ts`):

```
const distDir = path.resolve(import.meta.dirname, '../../dashboard/dist');
...
// dashboard/dist/../../package.json IS the repo-root package.json - the
// realistic exfiltration target on this exact tree ...
```

Head (`app/test/staticSmoke.test.ts:70`) roots the fixture at
`mkdtempSync(path.join(os.tmpdir(), 'hc-static-smoke-'))`.

Resolved probe targets on this box:

```
> node -e "..."
C:\Users\Cameron\AppData\Local\package.json    false
C:\Users\Cameron\AppData\package.json          false
C:\Users\Cameron\AppData\Local\etc\passwd      false
```

Throwaway reproduction: a DELIBERATELY LEAKY static layer (resolves
`path.resolve(distDir, '.' + decodeURIComponent(req.path))` itself and serves the
file if it exists, SPA shell otherwise), driven with the EXACT six probes and the
EXACT assertion block from `staticSmoke.test.ts:227-246`:

```
TMPDIR-ROOTED LEAKY APP failures: []
OLD-DIST-ROOTED LEAKY APP failures: [
  "/%2e%2e%2f%2e%2e%2fpackage.json: expected '{\n  \"name\": \"housingchoice\", \"ver...' not to contain ...",
  "/..%2f..%2fpackage.json: ...",
  "/..%5c..%5cpackage.json: ...",
  "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json: ..."
]
```

Same leaky app, same probes, same assertions: 0 failures rooted at the new mkdtemp
dist, 4 failures rooted at the old `dashboard/dist`. The probes at HEAD are
unfalsifiable by construction.

That contradicts the head comment at `app/test/staticSmoke.test.ts:213-217`, which
claims the probes pin "OUR COMPOSITION" and are "worth keeping" because "a future
static-serving change could lose that property". They cannot observe that loss.

---

## E4. ctx.skip DOES abort - the (c) diagnostic claim holds

Throwaway case: `ctx.skip('deliberate')` followed by an unconditional
`readFileSync` of a nonexistent path and `expect(true).toBe(false)`.

```
 v test/__review_adv_probe.test.ts (4 tests | 1 skipped)
   -> ADV: ctx.skip aborts the rest of the body > code after ctx.skip does not run [deliberate]
```

Skipped, not failed. Vitest 3.2.6. No finding.

---

## E5. Retry elapsed-time arithmetic (no measurement, code + its own comments)

`app/src/lib/dynamoAdmin.ts:84-88` names one of the two retried faults as
DynamoDB Local's "per-table tryLock(10s) expiring", and `:141-144` reuses the same
10s figure to justify `DEFAULT_POLL_CEILING_MS`. So producing that error costs the
caller ~10s of blocking per attempt.

`DEFAULT_ATTEMPTS = 4` (`:139`), linear backoff `n * 250` (`:201`) = 250+500+750 =
1.5s. Worst case for ONE `ensureTable` call under the lock-timeout signature:
4 x ~10s + 1.5s = ~41.5s, plus up to 10s of `pollUntilTableActive`.

`hookTimeout` is 60_000 (`app/vitest.config.ts:71`). Hooks that loop over the whole
manifest (22-23 specs) exist, e.g. `importApply.integration.test.ts:72-77` (60s),
`inbox.integration.test.ts:78`, `messaging.integration.test.ts:75`,
`statusTransition.integration.test.ts:76`. One contended table is enough to blow the
budget, and the resulting message is `Hook timed out in 60000ms`, which names
nothing. At base the same fault surfaced at ~10s naming `InternalServerError`.

`retryLocalControlPlane` (`:190-230`) bounds ATTEMPTS only; there is no deadline
parameter and no caller can impose one.

---

## E6. Internal contradiction on how long a local table can stay non-ACTIVE

`app/src/lib/dynamoAdmin.ts:141-144`: "a table that is still not ACTIVE after 10s
locally is not going to become so inside the same test hook" -> ceiling 10s.

`app/scripts/db-update-gsis.ts:112-115` in the SAME diff: "a GSI create BACKFILLS
the whole table, so on a local table with real imported data - or on a busy
DynamoDB Local shared with other work - this legitimately takes minutes" ->
timeout 900_000ms.

Both describe DynamoDB Local. Whenever the second is true, `ensureTable`'s new
retried-conflict poll gives up at 10s and rethrows a conflict that the base code
absorbed as `'exists'`.

---

## E7. ASCII / AGENTS.md editing rules

```
> node -e "<scan for charCode > 126>"
app/src/lib/dynamoAdmin.ts                                non-ascii: 1  "-" (em dash)
app/scripts/db-update-gsis.ts                             non-ascii: 0
app/test/dynamoAdminRetry.test.ts                         non-ascii: 0
app/test/staticSmoke.test.ts                              non-ascii: 0
app/test/logCallSiteGuard.test.ts                         non-ascii: 0
docs/issues/built-dashboard-identity-tags-unasserted.md   non-ascii: 0
```

The single em dash is `app/src/lib/dynamoAdmin.ts:1`, pre-existing (it is in the
base file) and not on an added line - `git diff 5ce9912f..796b8632 --
app/src/lib/dynamoAdmin.ts | grep '^+.*<em dash>'` returns nothing. The
"only added lines must be ASCII" ratchet is satisfied. No finding.

---

## E8. Throwaway cleanup

```
> rm -f app/test/__review_adv_probe.test.ts
> git status --short
(no output)
```
