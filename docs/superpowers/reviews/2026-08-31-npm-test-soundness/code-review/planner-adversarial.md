# Planner's adversarial code review - feat/npm-test-soundness

Plan-blind, spec-blind, docs/superpowers-blind. Static reading, git and grep
only; no suite, npm script, vitest, playwright or Docker command was run (the
planner is holding the gate lane).

Scope read: `git diff main...HEAD` for `app/**`, `AGENTS.md`, `docs/issues/**`,
plus the surrounding non-diff code needed to sweep consumers
(`app/scripts/db-create.ts`, `app/scripts/db-update-gsis.ts`,
`app/src/lib/dynamo.ts`, `app/test/globalSetup.ts`, `app/vitest.config.ts`,
`app/test/setup/dynamoAccessKey.ts`, `app/src/app.ts`, ~50 integration suites by
grep) and the pinned AWS SDK sources under `node_modules/`.

---

## 1. [HIGH] `deleteTableIfExists` tolerates a retried DELETING conflict without waiting, and `importApply.integration.test.ts` immediately re-creates the same table

`app/src/lib/dynamoAdmin.ts:565`

```ts
if (retried && err instanceof ResourceInUseException) return;
```

The justification directly above it (`:553-564`) is that a retried conflict
means "attempt 1 landed and only its response was lost, leaving the table
DELETING - tolerated for the same reason absence is: the caller asked for the
table to be gone, and it is going." That reasoning is fine for a caller that
either stops there or waits. It is not fine for a caller that creates the same
physical name next, and this branch left that half asymmetric:

- `ensureTable` DID add a wait for exactly this shape - a retried conflict polls
  `pollUntilTableActive` before returning (`dynamoAdmin.ts:447-457`), because
  "returning without waiting hands back a table the caller cannot yet write to."
- `deleteTableIfExists` returns with no wait at all. No `waitUntilTableNotExists`,
  no poll, nothing.

The exposed caller is named in the acceptance suite's own comment. `app/test/importApply.integration.test.ts:72-77` is delete-then-create with **no**
wait between:

```
72:  beforeAll(async () => {
74:      await deleteTableIfExists(client, table(t));
75:      await ensureTable(client, getTableSpec(t), table(t));
```

and the same pair repeats in-file at `:515-516`, `:537-538`, `:599-600`,
`:630-631`, `:671-672`, `:712-713`, `:774+`.

Failure chain under the exact contention this branch exists for:

1. `DeleteTable` attempt 1 draws `InternalFailure` but the delete landed. Table
   is `DELETING`.
2. Attempt 2 draws `ResourceInUseException`. `retried` is true, so
   `deleteTableIfExists` returns success (`:565`).
3. `ensureTable` fires `CreateTable` on the same name. DynamoDB rejects a create
   against a `DELETING` table with `ResourceInUseException`.
4. That conflict arrives on attempt 1, so `retried` is **false**, the poll at
   `:447` is skipped, and `ensureTable` returns `'exists'`
   (`dynamoAdmin.ts:434-436`).
5. The delete completes. The suite now runs against a table that does not exist.

Before this branch the same run failed at step 1 with the accurate string
`InternalFailure` on `DeleteTable`. After it, the run fails somewhere later with
`ResourceNotFoundException` on an unrelated write - i.e. this is a mission about
making `npm test` failures nameable that converts a named failure into an
unnamed one.

`app/scripts/db-create.ts:63-64` and `:75-76` are safe only by accident: they
follow every delete with `waitUntilTableNotExists({ maxWaitTime: 60 })`. Nothing
in `dynamoAdmin.ts` requires that of a caller, and no comment tells the next
caller to add it.

Acceptance case 4 (`app/test/dynamoAdminRetry.test.ts:306-316`) pins the
un-waited behaviour in: it asserts `resolves.toBeUndefined()` after exactly two
`DeleteTable` sends and asserts nothing about a subsequent absence check. So the
suite locks the hole rather than covering it.

Also, the sentence the whole tolerance rule is argued from is not accurate:
`dynamoAdmin.ts:558-560` and `dynamoAdminRetry.test.ts:522-524` both say "the
commonest caller is a delete-then-create hook ... (importApply.integration.test.ts
and ~50 siblings)". Grepped: the ~50 siblings are `beforeAll ensureTable` /
`afterAll deleteTableIfExists` on a per-run random `hc-test-<uuid>-` prefix
(e.g. `contactsRepo.integration.test.ts:61-69`,
`activityEventsRepo.integration.test.ts:54`,
`broadcastsRepo.integration.test.ts:67`). `importApply` is the one true
delete-then-create suite - and it is the one this defect reaches.

**Fix shape:** make the tolerated retried-delete symmetric with the tolerated
retried-create - wait for absence (`waitUntilTableNotExists`, or a bounded poll
mirroring `pollUntilTableActive`) before returning - or drop the tolerance and
let the conflict surface.

---

## 2. [HIGH] "The AWS SDK's default retry policy covers neither code" is contradicted by the pinned SDK source, and the time arithmetic the module tells readers to size hook timeouts from is built on it

`app/src/lib/dynamoAdmin.ts:88-92`:

> The AWS SDK's default retry policy covers neither code, so both escape to the
> caller and fail whatever gate is running.

Read against `@aws-sdk/client-dynamodb@3.1070.0` and its bundled smithy core:

- `node_modules/@smithy/core/dist-es/submodules/retry/service-error-classification/service-error-classification.js`
  - `isTransientError` returns true when
    `TRANSIENT_ERROR_STATUS_CODES.includes(error.$metadata?.httpStatusCode)`.
- `.../service-error-classification/constants.js`
  - `TRANSIENT_ERROR_STATUS_CODES = [500, 502, 503, 504]`.
- `.../middleware-retry/retryMiddleware.js:85-92`
  - `getRetryErrorType` maps any transient error to `"TRANSIENT"`.
- `.../util-retry/StandardRetryStrategy.js` (`isRetryableError`)
  - `return errorType === "THROTTLING" || errorType === "TRANSIENT";`
- `.../util-retry/config.js:6`
  - `DEFAULT_MAX_ATTEMPTS = 3`.
- `app/src/lib/dynamo.ts:60-80` sets `region`, `endpoint` and `credentials` only.
  Repo-wide grep finds no `maxAttempts` / `retryMode` / `AWS_MAX_ATTEMPTS`
  override for the DynamoDB client.

`InternalServerError` carries no `$retryable` trait
(`node_modules/@aws-sdk/client-dynamodb/dist-es/models/errors.js:26-37`), so the
classification hangs entirely on the HTTP status. DynamoDB Local answers both
`InternalFailure` and `InternalServerError` with a 5xx (**UNVERIFIED here** - I
am not permitted to run Docker; but both are `$fault: "server"` conditions and
the SDK models `InternalServerError` as a server fault). If the status is 500,
the SDK **already** retries each of these up to 3 times with backoff before the
error ever reaches `retryLocalControlPlane`.

Two consequences, in order of cost:

**(a) The budget block is wrong by roughly 3x, and it is the block readers are
told to compute from.** `dynamoAdmin.ts:145-166` reasons that "the lock-timeout
signature above costs the caller ~10s of blocking per attempt", derives 20s from
that, and closes with "Size a hook timeout by adding these up, not by reading
this one number." If one `client.send` is already up to 3 SDK attempts, one
helper attempt under the lock signature is ~30s, not ~10s. The deadline is read
only *before a re-send*, and deliberately *after* the verification hook
(`:265-286`), so the worst case for a single `sendWithRetryVerified` becomes
~30s (attempt) + ~30s (verify read, itself a `client.send`) before the 20s
deadline is even consulted. That is ~60s inside a 60s `hookTimeout`
(`app/vitest.config.ts:71`). The change can therefore *produce* the
`Hook timed out in 60000ms` failure that `:147-151` cites as the thing it exists
to avoid, in the same scenario it targets.

**(b) The acceptance suite structurally cannot see any of this.** Every case
drives `StubClient.send` (`dynamoAdminRetry.test.ts:199-209`), which bypasses the
entire middleware stack, and both fault factories omit the field the classifier
reads: `internalFailure()` (`:219-224`) is a bare `Error` with a `name`, and
`lockTimeout()` (`:227-232`) passes `$metadata: {}` - no `httpStatusCode`. So the
suite proves the helper retries and proves nothing about whether the SDK already
did. The escaped error even records the answer: `retryMiddleware.js:46-49` writes
`lastError.$metadata.attempts` on exhaustion, and nothing in this diff reads it.

**Fix shape:** either measure `$metadata.attempts` / `httpStatusCode` on a real
escaped fault and correct the comment and the deadline arithmetic, or set an
explicit `maxAttempts` on the local client so the two retry layers are not
multiplying silently. At minimum, do not ship a load-bearing negative claim about
SDK behaviour that the branch's own suite cannot test.

---

## 3. [MEDIUM] The verification hook is skipped on the final attempt, so a mutation that lands on the last try is still reported as failed

`app/src/lib/dynamoAdmin.ts:256-291`:

```ts
if (!isRetryableContainerFault(err)) throw err;
if (n >= attempts) throw err;          // :262 - final attempt exits HERE
local ??= await isLocalDynamoEndpoint(client);
if (!local) throw err;
if (opts.verify) { ... }               // :265
```

The module's stated purpose is that "the case the retry exists for is the server
ACCEPTING attempt 1 and only its RESPONSE failing" (`:96-98`), and a whole fix
wave moved the *deadline* check to sit **after** the verify block for precisely
this reason (`:277-285`: "skipping that read would report a mutation the server
ACCEPTED as failed, which is the one failure this whole module exists to
remove"). The attempt bound was left in front of it, so the same blind spot
survives on attempt 4 of 4 - the attempt after the container has been failing
longest and has therefore done the most work.

Case 10 (`dynamoAdminRetry.test.ts:393-410`) pins the hole rather than closing
it: its title is "the bound is 4 sends and the hook runs 3 times, never on the
final attempt", and its `ttlLog()` assertion has no trailing `DescribeTimeToLive`.

The cost of closing it is one read that "cannot loop", by the module's own
argument at `:283`. The asymmetry between the two bounds is not explained
anywhere.

---

## 4. [MEDIUM] `pollUntilTableActive` has no backoff and treats every read failure as "not ACTIVE", so a retried conflict can issue ~100 control-plane reads in 10s against a container that is already buckling

`app/src/lib/dynamoAdmin.ts:374-394`, with `DEFAULT_POLL_INTERVAL_MS = 100`
(`:168`) and `DEFAULT_POLL_CEILING_MS = 10_000` (`:193`).

```ts
} catch {
  observed = 'unreadable';
}
if (Date.now() >= deadline) throw new TableNotActiveError(...);
await sleep(intervalMs);
```

This path is only reached after a retried `CreateTable` conflict - i.e. only when
the container has *already* answered a control-plane call with `InternalFailure`
or a lock timeout. A `DescribeTable` that fails is counted as "not ACTIVE yet"
and immediately retried 100ms later, so a persistently unreadable container gets
up to ~100 additional `DescribeTable` calls per stuck caller within the ceiling.
With `maxWorkers: 4` and 22 specs per bootstrap that is a meaningful load
amplifier aimed at the failure mode it is reacting to.

The docblock at `:369-372` argues the reads are deliberately un-retried, which is
a different question from whether they should back off. A flat 100ms is also not
argued anywhere; only the 10s ceiling is.

---

## 5. [LOW] The `built dashboard identity tags` diagnostic's assertions are unreachable dead code

`app/test/staticSmoke.test.ts:379-397`:

```ts
if (!existsSync(BUILT_INDEX)) ctx.skip(...);
const html = readFileSync(BUILT_INDEX, 'utf8');
if (!identityHolds(html)) ctx.skip(STALE_OR_BROKEN_DIST_NOTE);
for (const needle of IDENTITY_PRESENT) expect(html, needle).toContain(needle);
for (const needle of IDENTITY_ABSENT) expect(html, needle).not.toContain(needle);
```

`identityHolds` (`:159-161`) is defined as exactly
`IDENTITY_PRESENT.every(includes) && IDENTITY_ABSENT.every(!includes)` - the
conjunction of the two loops below it - and `ctx.skip()` throws, so control never
reaches them unless every assertion is already known to hold. The two `for` loops
are provably unfalsifiable.

The pass-or-skip property is deliberate and the coverage cost is honestly filed
(`docs/issues/built-dashboard-identity-tags-unasserted.md`), so this is not a
disputed design. But the block reads as five assertions and is two `if`s; a
reader scanning for what covers the built dist will misjudge it. Either delete
the loops and let the guard be the whole test, or leave one comment saying the
loops are unreachable by construction.

---

## 6. [LOW] Acceptance case 21's lower bound is wall-clock-sensitive, in the one suite whose subject is load-sensitive reds

`app/test/dynamoAdminRetry.test.ts:605-634`. Each stubbed send costs
`delayMs: 20` against `deadlineMs: 200`, and the case asserts
`count('CreateTable') >= 2`. Attempt 1 answers at ~20ms, so the assertion holds
only while the process does not lose ~180ms of wall clock between `startedAt`
(`dynamoAdmin.ts:252`) and the deadline read (`:286`).

The case's own comment argues this is a wide margin, and the upper bound
(`< 12`) is safe (11 x 20ms = 220ms > 200ms). But 180ms of event-loop stall on a
saturated 4-worker Windows box running the full gate is not obviously out of
reach, and a false red here would be reported *as* the flake class this mission
closed. A deadline-vs-delay ratio an order of magnitude wider (e.g. 5ms sends
against a 2000ms budget) buys the same proof with no clock sensitivity.

Everything else in the suite is deterministic; case 20's interleaving
(`:561-603`) is pinned by a shared answer-ordered timeline and is fine, and case
22 (`:636-665`) only needs `elapsed >= 1ms`, which is unfalsifiable in the safe
direction.

---

## 7. [LOW] Three catch blocks discard the underlying error entirely, so a persistently failing verification read is invisible

- `app/src/lib/dynamoAdmin.ts:270-275` - the fail-closed verify branch rethrows
  the ORIGINAL container fault and drops the verification error with no `cause`
  and no log.
- `app/src/lib/dynamoAdmin.ts:388-390` - `pollUntilTableActive` collapses every
  `DescribeTable` failure to the string `'unreadable'`.
- `app/scripts/db-update-gsis.ts:80-83` - `indexStatus` returns `undefined` for
  both "index absent" and "the read blew up", which the docblock at `:59-60`
  acknowledges.

Individually each is defensible. Together they mean that when
`ensureTable`/`ensureGsis` finally fails, the operator sees one container fault
and has no way to tell whether the verification path was also broken - which is
the first thing anyone diagnosing a re-send decision would want. Attaching the
swallowed error as `{ cause }` costs nothing and changes no control flow.

---

## Checked and clean

Recording these so the next reviewer does not re-walk them:

- **Endpoint gate fails closed.** `isLocalDynamoEndpoint`
  (`dynamoAdmin.ts:212-221`) requires `config.endpoint` to be a function AND to
  resolve to one of four localhost spellings; missing provider, throwing
  provider and any other hostname all return `false`. `createDynamoClient`
  (`app/src/lib/dynamo.ts:63-66`) passes no `endpoint` when `DYNAMODB_ENDPOINT`
  is unset, which is every deployed path. Cases 11-14 are real falsifiable
  assertions - case 11 would fail if the gate failed open. The bracketed IPv6
  form is correctly covered (`URL.hostname` yields `[::1]`).
- **No product/request path reaches the changed helpers.** Repo-wide grep for
  `ensureTable|deleteTableIfExists|ensureGsis|sendWithRetry` finds only
  `app/scripts/db-create.ts`, `app/scripts/db-update-gsis.ts`, ~53 test suites,
  `app/test/globalSetup.ts` and `scripts/e2e-session.mjs`. Nothing under
  `app/src` outside `dynamoAdmin.ts` itself.
- **The new `ensureGsis` local-endpoint tightening breaks neither caller.** The
  CLI builds its client from an endpoint it has already checked with
  `isLocalEndpoint` (`db-update-gsis.ts:241-250`), and the one integration
  caller, `app/test/unreadIndexRepo.integration.test.ts:764/803/812`, uses a
  client built from `DYNAMODB_ENDPOINT ?? http://localhost:8000`. The e2e lane
  reaches it as a CLI child with `DYNAMODB_ENDPOINT` defaulting to
  `scripts/db.mjs:42` = `http://localhost:8000`.
- **Both new optional parameters are appended.** `ensureTable`'s `opts` is 5th
  after `env`, `ensureGsis`'s is 5th after `log`; no existing call site shifts.
- **`retried` really is per call.** Case 20 would fail if the flag were
  module-level (`plainStub.count('DescribeTable')` would be 1, not 0). The
  concurrent call site the comment cites is real:
  `app/test/todayUnmatchedNonRegression.test.ts:104-109` runs `ensureTable`
  under `Promise.all`.
- **`TableNotActiveError` `instanceof` is sound** - `tsconfig.base.json:6` sets
  `target: ES2023`, so the Error subclass needs no `setPrototypeOf`.
- **Acceptance cases 5, 6, 7, 9, 10, 15, 16, 17, 19, 20, 22 are falsifiable.**
  Each would change colour if the behaviour it names were removed or inverted. I
  found no stub that answers everything and no assertion on a value the test
  itself wrote (case 19's `not.toBeInstanceOf(TableNotActiveError)` is trivially
  true, but it sits beside two real message assertions).
- **`TTL_SPEC = getTableSpec('messages')` really carries `ttlAttribute`**
  (`app/src/lib/tables.ts:231`), so the TTL cases exercise the path they name;
  and the cases assert `ttlLog()` contents, so a spec drift would red loudly.
- **The `hc:dynamo-lane none` marker and its rot-proof case hold today.**
  `dynamoAdminRetry.test.ts` imports `../src/lib/dynamoAdmin.js`, which does not
  match `[^'"]*\/dynamo\.js`; the one-hop gap through
  `scripts/db-update-gsis.js` is real, documented at
  `dynamoAccessKeyGuard.test.ts:96-101`, and harmless (that module's client
  construction sits behind the argv guard at `db-update-gsis.ts:240`, which is
  false under vitest). AGENTS.md's "stands down 2 `dynamoAccessKeyGuard`
  assertions" is accurate (`:174` and the single `it` inside `:434`), and its
  `dynamoAccessKey.ts:120` citation lands exactly on the explicit-key branch.
- **`app/dist/lib/dynamoAdmin.js` is gitignored** (`.gitignore:3`) and untracked;
  no build artifact was committed.
- **New/touched lines are ASCII-only** across `app/**`, `AGENTS.md` and
  `docs/issues/**` (scripted scan of `+` lines, 0 hits).
- **Issue frontmatter is schema-valid.** `status: resolved` and a `resolved:`
  date are both documented in `docs/issues/_TEMPLATE.md:16-27` and accepted by
  `scripts/issues.mjs:15/52`.
- **`globalSetup` re-enabling TTL on shared tables is pre-existing, not caused
  here.** `app/vitest.config.ts:119` sets `DYNAMO_DISABLE_TTL` in `test.env`,
  which reaches workers only; `globalSetup.ts:90-117` sets credentials and not
  that flag. The branch does not change that code and files it as
  `docs/issues/globalsetup-reenables-ttl-on-shared-tables.md`. The retry does not
  make it worse: `enableTtlIfNeeded` short-circuits on an already-`ENABLED`
  table (`dynamoAdmin.ts:508-509`).
- **`waitUntilTableExists` is left unwrapped deliberately and correctly** - the
  SDK waiter's `checkState` maps every exception to `RETRY`, so an
  `InternalFailure` inside it never escapes; it only costs the 60s waiter budget.
  Pre-existing.
