# Design review R2 - reviewer A (adversarial)

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v2, `cfd1a0b4`)
- Repo read-only at `W:\tmp\npm-test-soundness` @ `5ce9912f`
- Method: static reading and grep only. No suite, npm script or container was
  run. SDK internals were read from the MAIN checkout's `node_modules`
  (`W:\AI Projects\Housing Choice\HC Application`, `@aws-sdk/client-dynamodb`
  3.1070.0) because this worktree has none - both round-1 reviewers had to mark
  those UNVERIFIED and I no longer do.
- Byte-exact quotation: `.superpowers/sdd/spec-r2-reviewer-a-code-reference.md`.

Findings 1-16 are NEW. 17-18 contest the adjudication. Ordered by consequence.

---

## 1. [BLOCKING] The new "Live-ness note" is false. `DYNAMO_DISABLE_TTL` does not reach globalSetup, so `enableTtlIfNeeded` DOES run under `npm test`

**Spec section:** Item 1A, "Live-ness note" - "`DYNAMO_DISABLE_TTL: '1'`
(`vitest.config.ts:119`) means `enableTtlIfNeeded` never runs under `npm test`,
so the two TTL sends are dead on the gate path and live only under `db:create`
and the e2e lanes."

**Evidence.** `DYNAMO_DISABLE_TTL` is set under `test.env`
(`app/vitest.config.ts:119`), and this repo already knows `test.env` does not
reach globalSetup - it says so in a comment and works around it for the access
key: "vitest test.env applies to workers, not globalSetup, so we must set
process.env ourselves here" (`app/test/globalSetup.ts:90-91`). No equivalent
workaround exists for `DYNAMO_DISABLE_TTL`. globalSetup then calls
`createAllTables(endpoint)` (`app/test/globalSetup.ts:117`), which calls
`ensureTable(client, spec, physicalName)` with THREE arguments
(`app/scripts/db-create.ts:36`), so `env` falls back to
`process.env` (`app/src/lib/dynamoAdmin.ts:84`) - where the flag is unset. Four
specs carry `ttlAttribute: 'expires_at'` (`app/src/lib/tables.ts:231`, `:246`,
`:615`, `:648`).

**What it implies.** Every `npm test` run issues `DescribeTimeToLive` and, on a
fresh key, `UpdateTimeToLive` from globalSetup - on the gate path, at the moment
the container is about to take four workers. So:

- The correction accepted as A4/B7 has been over-applied. The claim that
  needed correcting was "hot path of every integration suite"; the replacement
  claim ("dead on the gate path") is equally wrong in the other direction.
- The `UpdateTimeToLive` retry hazard (finding 3, and the accepted A3/B5) is
  **on** the gate path, not off it. The spec's risk weighting for the one
  command with no idempotence catch is built on this false premise.
- It also means `vitest.config.ts:103-107`'s own caveat ("this flag does not
  DISABLE TTL, it declines to ENABLE it... the immunity is real for a fresh
  table and NOT retroactive") has a hole the config does not know about:
  globalSetup ENABLES TTL on the shared `hc-local-` tables every run. Whether
  to close that is out of this mission's scope, but the spec must not assert
  the opposite.

A builder acting on the Live-ness note will de-prioritise exactly the send that
most needs care.

## 2. [HIGH] "Nine local control-plane sends exist in the repo" is false, and the omissions are not exclusions

**Spec section:** Item 1A, "The full control-plane surface (enumerated, not
sampled)" and "Every exclusion is a decision with a reason, not an omission."

**Evidence.** There are **26** explicit control-plane `new *Command` sends
across 9 files, plus 5 waiter call sites that are themselves DescribeTable poll
loops. The full inventory is in the reference file. The spec's table lists 9 and
silently omits all 17 `DescribeTable` / `ListTables` reads, including:

- `app/scripts/db-update-gsis.ts:94` - `indexStatus`, the retry's OWN
  verification hook (see finding 3);
- `app/test/globalTeardown.ts:119` and `:132` - the residue sweep's `ListTables`
  and `DescribeTable`, which run on the way IN as well as out
  (`app/test/globalSetup.ts:209`) and which feed the residue mechanism item 1C
  is about;
- `app/src/lib/devReset.ts:42` - a local-endpoint `DescribeTable` on the dev
  reseed path.

The definition is also inconsistent: `DescribeTimeToLive`
(`dynamoAdmin.ts:129`) is listed as a control-plane send and marked COVERED,
while every `DescribeTable` is treated as not existing. Both are reads; both are
control plane.

**What it implies.** The section's headline promise - "enumerated, not sampled" -
is the thing that was supposed to close B8, and it is not delivered. A reader
cannot tell whether a missing site was considered and excluded or never seen,
which is precisely the state B8 objected to. Either widen the table to the real
inventory with a disposition each, or narrow the claim to "the four MUTATING
sends plus the two test-owned raw sends" and say the reads are out of scope with
one reason.

## 3. [HIGH] The retry's verification hook is itself an unprotected control-plane read that fails OPEN - and the spec now extends it to `UpdateTimeToLive`

**Spec section:** Item 1A, "Mechanism" ("`db-update-gsis.ts` ... supplies its
existing index-status check as that hook") and the corrected `UpdateTimeToLive`
row ("the status read becomes the retry's verification hook, re-read before each
re-send").

**Evidence.** `app/scripts/db-update-gsis.ts:88-101` - `indexStatus` wraps its
`DescribeTable` in `try { ... } catch { return undefined; }`, with the comment
"A describe that itself fails tells us nothing; fall through to the retry". At
`:121-122` the caller returns early only on `CREATING` / `ACTIVE`; `undefined`
means re-send.

**What it implies.** The hook fails OPEN. Under the container contention the
retry exists for, the hook's own `DescribeTable` is as likely to answer
`InternalFailure` as the send that just failed - and precisely then the retry
re-sends as if attempt 1 had not landed. For `UpdateTable` that produces the
`ResourceInUseException` the docblock at `:70-86` was written about; the retry
only narrows the window, it does not close it. That is tolerable for a
one-shot CLI script.

It is NOT obviously tolerable once the same hook shape becomes the fix for
`UpdateTimeToLive`, where a failed re-read means re-sending an enable - the
exact `ValidationException` risk that finding A3/B5 was accepted to prevent. The
spec's corrected row says "re-read before each re-send" and stops there. It must
say what happens when the re-read FAILS. Fail-open re-creates the bug; fail-closed
(treat unknown as "assume it landed", i.e. return) is the safer default for an
idempotent enable, and is a decision the spec should make, not the builder at
2am.

Note this also gives finding 2 teeth: the hook is one of the 17 sends the
enumeration omits, and it is the single most load-bearing one in the design.

## 4. [HIGH] Routing suite B's raw `CreateTable` through the retry re-introduces the A1 defect at a site with no catch at all

**Spec section:** Item 1A table, row
`unreadIndexRepo.integration.test.ts:728 | CreateTable | COVERED - routed
through the exported helper. This is suite B's OWN fixture setup`, and the
matching non-goal at the end of the spec.

**Evidence.** `app/test/unreadIndexRepo.integration.test.ts:728-729`:

```
    await client.send(new CreateTableCommand(input));
    await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: physicalName });
```

This is a bare send inside `beforeAll`. There is no `try`, and no
`ResourceInUseException` handling anywhere in the file. It cannot use
`ensureTable`, because the whole point of the fixture is a hand-mutated
`CreateTableCommandInput` with one GSI removed (`:715-727`).

**What it implies.** Wrapping this send in the retry manufactures the A1 case at
a site strictly worse than `ensureTable`'s: an accepted-but-unanswered attempt 1
makes attempt 2 throw `ResourceInUseException`, which nothing catches, and suite
B's `beforeAll` fails - in the one suite the anchor names, on a branch whose
purpose is to stop that suite failing. The spec specifies no verification hook
for this site and no `ResourceInUseException` handling. "COVERED" is doing a lot
of work for a change that, as written, can only make this site fail in a new
way.

Either specify the hook and the catch for this site, or leave it raw and say so
- it is a test fixture whose failure is loud and attributable, which is a
defensible exclusion.

## 5. [HIGH] Nothing anywhere asserts the BUILT dashboard's identity tags once 3(c) can only PASS or SKIP - the regression class the issue is named for becomes undetectable forever

**Spec section:** Item 3(c) and "Why this kills the class" - "the only red left
in this file comes from (a) or (b)".

**Evidence.** `DASHBOARD_DIST_DIR` is consumed by `app/src/app.ts:234`,
`app/src/lib/config.ts:1323`, `infra/modules/cloudfront/main.tf:184`, and three
tests - `devGating.test.ts:256` and `unitMediaServe.test.ts:186` (both mkdtemp
fixtures) and `staticSmoke.test.ts:33`/`:183`. No e2e lane sets it:
`dashboard/vite.config.ts` runs a dev server (`configureServer`), and
`e2e/tests/dashboard-next/environment-identity.spec.ts:105-150` asserts the
runtime `/app-identity/*` ENDPOINTS, never `dashboard/dist/index.html`.
`npm run smoke` builds only `@housingchoice/app` (`package.json:68`).

**What it implies.** After this change the only automated reader of
`dashboard/dist/index.html` is a case that is structurally incapable of failing.
So a `vite build` regression that drops the identity link tags - the exact
content mismatch the issue
(`static-smoke-fails-on-stale-dashboard-dist.md:31-34`) is about - produces a
permanent SKIP on every branch, on main, and in CI, and ships broken PWA
identity in the Docker image behind five green gates. (a) is blind to it by
construction: it reads a fixture. (b) is blind to it by construction: it reads
the SOURCE the build is diverging from.

Worse, the SKIP message the spec dictates - "it is either stale or the dashboard
build dropped the identity tags. Run `npm run build -w dashboard` and re-run" -
is actively misdirecting in the regression case: rebuilding reproduces the same
disagreement and the same SKIP, forever. An operator following the message will
conclude their build is stale no matter how many times they build.

**Answering the question directly:** yes, deleting the mtime tie-breaker leaves
a real dashboard build regression undetected forever, and (a) plus (b) do not
cover it. That is a genuine loss, not a bookkeeping one. It may still be the
right trade - my finding A18 against mtime stands and the tie-breaker was
unsound - but the spec must STATE the hole rather than claim the class is
killed. Three honest options, none of which the spec considers:

- accept the hole explicitly and record it as a new issue in `docs/issues/`;
- move the assertion to where a build definitely happens (the Docker image
  build, or a `dashboard` workspace test that runs after `vite build`);
- make (c) fail on a mismatch but key the skip on something git DOES preserve -
  e.g. compare the dist against a tracked expectation and let a rebuild be the
  operator's job.

## 6. [HIGH] Item 2's `scanProgram` remedy is already implemented; the real available cut is one line above it and is not named

**Spec section:** Item 2 Step 2 - "If `scanProgram` dominates: ...
`isCatchDeclared` is purely syntactic and carries most of the guard's value;
ordering the cheap syntactic test first and short-circuiting is the obvious cut,
and it changes no result because the two are OR'd."

**Evidence.** `app/test/logCallSiteGuard.test.ts:98` and `:106` ALREADY read
`isCatchDeclared(...) || isErrorTyped(...)`, in that order, and JavaScript `||`
already short-circuits. The proposed cut is a no-op against today's code.

And `isCatchDeclared` is not free. Its BODY is syntactic (`:74-77`), but its
ARGUMENT is a checker call at both call sites -
`checker.getShorthandAssignmentValueSymbol(prop)` (`:97`) and
`checker.getSymbolAtLocation(value)` (`:106`). So "the cheap syntactic test" is
a checker call in both branches.

The genuine unclaimed cut is at `:94-98`: `valueSym` is computed EAGERLY on
`:97`, before `legal` is consulted on `:98`. Every wired key - `err`, and the
whole `LOG_SERIALIZER_KEYS` set, i.e. the common case in a log-heavy codebase -
pays a `getShorthandAssignmentValueSymbol` it can never use. Moving that call
inside the `!legal` branch is a real reduction and changes no result.

**What it implies.** Step 2's `scanProgram` branch is written from a reading of
the code that does not match the code. A builder who measures `scanProgram` as
dominant will "apply" the spec's remedy, observe no change, and have no
fallback. The one-line fix that would help is not mentioned.

## 7. [HIGH] The accepted A1 fix adds a waiter whose SDK default makes its second poll a flat 20 seconds, inside 60-second hooks

**Spec section:** Item 1A, per-command table, `CreateTable` row - "the
`ResourceInUseException` path waits for the table to exist before returning",
and "Bounds: at most 4 attempts, linear backoff (`attempt * 250ms`) ... A retry
loop that can outlive a test budget trades one false red for another."

**Evidence** (read from the installed SDK, quoted in the reference file).
`waitUntilTableExists` sets `serviceDefaults = { minDelay: 20, maxDelay: 120 }`
seconds and spreads caller params over it. `app/src/lib/dynamoAdmin.ts:89`
passes only `{ client, maxWaitTime: 60 }`, so `minDelay` stays 20. In
`poller.js`, attempt 1 is immediate; for attempt 2
`exponentialBackoffWithJitter` computes `delay = 20000 * 2**0 = 20000`,
`capped = min(20000, 120000) = 20000`, `waitFor = randomInRange(20000, 20000)` -
**exactly 20,000 ms**. With `maxWaitTime: 60` the call affords roughly three
polls, then returns `TIMEOUT`, and `checkExceptions` throws a `TimeoutError`
(`util-waiter/waiter.js`).

`app/vitest.config.ts:71` sets `hookTimeout: 60_000`. Four `ensureTable`-bearing
hooks run on that default rather than an override:
`groupConvert.integration.test.ts:124`, `importApply.integration.test.ts:77`,
`dynamoKeyLedger.test.ts:128`, `dynamoAccessKeyGuard.test.ts:349` - and
`importApply` and `groupConvert` both call `ensureTable` in a LOOP over table
specs.

**What it implies.** The Bounds paragraph reasons about 1.5s of retry backoff
and never mentions that the fix it mandates puts a 20-second minimum on the
failure path, capped by a 60-second throw. On the retry path - the only path
where the table is genuinely still `CREATING`, which is exactly when poll 1
misses - one `ensureTable` can consume a whole default hook budget, and a
looping hook is gone after the first table. The mission would trade an
`InternalFailure` red for a `Hook timed out in 60000ms` red, which is item 2's
failure mode arriving through item 1's fix.

The remedy is one parameter the spec should name: pass `minDelay: 1` (the waiter
honours caller params) on the calls this mission touches. Note the exposure is
partly pre-existing at `:89`; what is new is putting a second waiter call on a
path that is reached precisely when the first poll will miss.

## 8. [HIGH] The measurement protocol makes the mission the dominant load source, invalidating its own contention snapshots and the neighbours' measurements

**Spec section:** Item 1D (3 baseline + 3 post-fix full `npm test`, plus one
discarded warm-up), Item 1C (3 + 3 app-workspace runs), Item 1B (10 solo runs),
Item 3 (one `npm run build -w dashboard` plus a mutate/observe cycle), and the
five gates - against "Three other missions share this machine and one DynamoDB
Local container tonight."

**Evidence.** Root `npm test` is five workspaces (`package.json:39`). Using the
anchor's own measured durations for the two arms
(`npm-test-dynamodb-local-contention.md:293-301`): arm 2 is 446-509s per run, so
1C alone is ~25 minutes of arm-2 plus ~5 of arm-1; 1D's seven root runs are each
larger than an app-only run. That is many hours of continuous suite execution,
concurrent with three other missions, on the shared DynamoDB Local container the
spec forbids restarting.

**What it implies.** Two self-defeating consequences, neither addressed:

- The mission becomes the largest contributor to the contention it is
  measuring. Its own "contention snapshot" will mostly be measuring itself, and
  the baseline and post-fix arms will sit under different amounts of
  self-inflicted load. That is the same held-constant failure the spec fixed for
  the sweep MODE (A11) and re-introduces at a larger scale.
- The neighbours finish. The spec's own rule - "A run whose snapshot shows no
  neighbours is labelled QUIET and cannot stand as contended evidence" - then
  disqualifies the later runs, with no stated fallback and no ordering that puts
  the arms that must be compared adjacent in time. As written the protocol can
  run out of valid arms halfway through and the spec has no answer.

At minimum the spec needs a run ORDER that interleaves the arms (so drift in
ambient load hits both equally), a stated total-runtime budget, and a rule for
what to do when the box goes quiet. It should also say plainly that this
mission's measurement load is visible to the other three missions, which the
review brief for this very round treats as a hard constraint.

## 9. [MEDIUM] The local-hostname list omits `[::1]`, which is the form the SDK actually produces

**Spec section:** Item 1A, "The local-endpoint gate, specified concretely" - the
gate "reads `hostname`, and treats `localhost`, `127.0.0.1` and `::1` as local."

**Evidence.** `parseUrl` (`@smithy/core/.../transport/parseUrl.js`) returns
`new URL(url).hostname` verbatim, and Node's `URL.hostname` for an IPv6
authority keeps the brackets - measured on the installed Node:
`new URL('http://[::1]:8000').hostname === '[::1]'`. The bare `::1` never
appears from this path. This repo already knows that: `db-create.ts:25` tests
BOTH `'[::1]'` and `'::1'`, and `e2e/performance/config.ts:210` and
`e2e/performance/targets.ts:79` both test `'[::1]'`.

**What it implies.** The spec's list keeps the form that cannot occur and drops
the one that can, so an IPv6 loopback endpoint would fail closed - no retry, no
error, no signal. That is the ship-inert failure the acceptance suite exists to
prevent, and cases (5) and (6) cannot see it: they test a NON-local endpoint and
a MISSING provider, not a local endpoint spelled differently. Latent today
(`LOCAL_DEFAULT_ENDPOINT` is `http://localhost:8000` and the e2e lanes use
`127.0.0.1`), but `e2e/support/urls.ts:9` records that `localhost` resolves to
`::1` on this machine, so it is one config change away.

Fix the list to match `db-create.ts:25`, and add an acceptance case for it.

## 10. [MEDIUM] The `dynamoAccessKeyGuard` exclusion is justified by a reason that does not hold, and it leaves a live flake source on the gate path

**Spec section:** Item 1A table, rows `dynamoAccessKeyGuard.test.ts:327` and
`:342` - "NOT covered - deliberate: this suite exists to prove the keying
scheme, and a retry here could mask the very failure it asserts."

**Evidence.** `app/test/setup/dynamoAccessKeyGuard.test.ts:326-348`. The
assertions are `expect(here.TableNames).toContain(name)` and
`expect(there.TableNames).not.toContain(name)` - a statement about which
DATABASE a table lands in. A control-plane retry cannot affect either: retrying
a `CreateTable` that failed with `InternalFailure` changes only whether the
table gets created at all, never which key's database it lands in. And the
`DeleteTable` at `:342` is already inside `try { ... } catch { /* best effort */ }`,
so a retry there could not mask anything even in principle.

**What it implies.** The exclusion may still be the right call - a guard suite
arguably should use the rawest possible primitives - but the stated reason is
false, and it is the only reason given. Meanwhile the `CreateTable` at `:327` is
a bare send with no catch in a suite that runs on every `npm test`, i.e. exactly
the live flake source the mission is trying to remove, excluded on reasoning
that does not survive reading the assertions. Give the real reason (primitive
purity in a guard suite) or cover it.

## 11. [MEDIUM] The acceptance suite cannot see the one regression the refactor most plausibly causes

**Spec section:** Item 1A, "Acceptance - this item MUST be able to fail", cases
1-6, and "Mechanism" ("`ensureGsis`'s own behaviour is otherwise unchanged ...
the new gate is additive there, never a loosening").

**Evidence.** `ensureGsis` currently retries UNCONDITIONALLY at the function
level - `sendWithInternalFailureRetry` (`db-update-gsis.ts:103-127`) has no
endpoint gate; only the CLI does (`:262-270`). After the refactor its retry runs
through a helper that is gated on `client.config.endpoint`. Its callers include
`app/test/unreadIndexRepo.integration.test.ts:764`, `:803`, `:812` - suite B.
Those tests assert only that the GSI is added; they cannot observe whether the
retry is armed.

All six acceptance cases exercise `dynamoAdmin`'s own entry points. None
exercises `ensureGsis`.

**What it implies.** The refactor can silently DISARM the anchor's one
already-working mitigation and every test in the repo stays green - the same
ship-inert shape case (5) exists to prevent, one function over. Add a case: a
local-endpoint stub whose `UpdateTable` throws `InternalFailure` then succeeds,
driven through `ensureGsis`, asserting the send count. "Never a loosening" is a
claim, and this mission's own standard is that claims about the retry get a
test.

## 12. [MEDIUM] Acceptance case 2 drives the SDK waiter through a stub, which the spec does not account for

**Spec section:** Item 1A acceptance case 2 - "attempt 1 is
accepted-but-unanswered ... -> returns `'exists'` AND waits for the table before
returning."

**Evidence.** `waitUntilTableExists` is not a client method; it issues its own
`client.send(new DescribeTableCommand(...))` per poll
(`waitForTableExists.js`), it treats any unexpected response as `RETRY`, and
with the default `minDelay: 20` its second poll is 20s away (finding 7).

**What it implies.** A stub programmed only for `CreateTable` will make the
waiter poll, get something it cannot read as `TableStatus === 'ACTIVE'`, sleep
20s, poll again, and eventually throw `TimeoutError` at `maxWaitTime` - so case
2 as written either takes 60s and fails, or blows the file's own
`testTimeout: 60_000`. The stub must also answer `DescribeTable` with
`{ Table: { TableStatus: 'ACTIVE' } }`. One sentence in the spec prevents a
builder from discovering this by watching a test hang.

## 13. [MEDIUM] The acceptance suite straddles two incompatible error-discrimination styles, so cases 2 and 3 can pass vacuously

**Spec section:** Item 1A acceptance cases 2 and 3, which require the stub to
throw `ResourceInUseException` and have `ensureTable` / `deleteTableIfExists`
handle it.

**Evidence.** `dynamoAdmin.ts` discriminates by CLASS -
`err instanceof ResourceInUseException` (`:91`) and
`err instanceof ResourceNotFoundException` (`:148`). The retry helper
discriminates by STRING - `const name = (err as { name?: string }).name ?? ''`
(`db-update-gsis.ts:115-116`).

**What it implies.** A stub that throws `{ name: 'ResourceInUseException' }` - the
obvious thing to write, and the thing that satisfies the retry's check - does
NOT satisfy `instanceof`, so `ensureTable` rethrows and case 2 fails for a
reason unrelated to the code under test. Conversely a builder who "fixes" that
by loosening `:91` to a name check has quietly changed production error
handling. The stub must construct real
`ResourceInUseException` / `ResourceNotFoundException` instances from
`@aws-sdk/client-dynamodb` (which need `$metadata` and `message`), and the spec
should say so - or the design should settle on one discrimination style.

## 14. [MEDIUM] Item 2's `buildProgram` branch pre-commits two remedies that do not exist

**Spec section:** Item 2 Step 2 - "If `buildProgram` dominates: ... Options are
a cheaper host (no type-checking services the scan does not use) or narrowing
the program's roots".

**Evidence.** `buildProgram` (`logCallSiteGuard.test.ts:43-68`) is
`getParsedCommandLineOfConfigFile` + `createCompilerHost` + `createProgram` +
`getTypeChecker`. `ts.createCompilerHost` provides file IO and module
resolution; it provides no type-checking services to remove - the checker comes
from `program.getTypeChecker()`, which the scan genuinely uses (`:79`, `:97`,
`:106`). And `app/tsconfig.json` is `"include": ["src"]`, so the roots are
already exactly the files the guard must scan; there is nothing to narrow
without violating the guard's own stated requirement, which the same paragraph
restates.

**What it implies.** If the measurement lands on `buildProgram` - which finding
6 makes more likely, since the `scanProgram` remedy is a no-op - the spec offers
two levers that do not exist, and locked decision 2 ("measure, then cut - not a
bare budget raise") is unreachable. That is fine, because the spec has an
explicit fallback; what is not fine is presenting unavailable options as the
plan, because a builder will spend the round discovering it. Say plainly that
the `buildProgram` branch most likely lands on the fallback, and what "materially
below ~196s" would even mean there.

## 15. [MEDIUM] Two mandated actions have no deliverable and no seam

**Spec sections:** Item 1D ("`_CLUSTERS.md:235-237` suggests running M7's gates
under the clean key; that advice is superseded ... and the supersession is
recorded there") and Item 3(c) ("records both branches observed: the PASS on a
current build, and the SKIP-with-message after mutating a copy of the built
`index.html`").

**Evidence.** The Deliverables list has five entries - issue closures,
`npm run issues`, the `AGENTS.md` paragraph, mission records, and the code
changes. `docs/issues/_CLUSTERS.md` appears in none of them, and the spec's
non-goals do not authorise editing it either. Separately,
`staticSmoke.test.ts:18` resolves the dist path as a module-level constant
(`path.resolve(import.meta.dirname, '../../dashboard/dist')`) with no
override; a "copy" of the built `index.html` is unreadable by the test.

**What it implies.** The `_CLUSTERS.md` supersession is asserted as already
recorded when nothing records it - and it is the instruction that would
otherwise send the NEXT mission to run its gates under the very key item 1C
proves is the wrong one. And observing 3(c)'s SKIP branch requires either
mutating the real `dashboard/dist/index.html` (say so - it is gitignored, so
that is fine) or adding a path seam to the test (say that instead). As written,
neither is possible.

## 16. [LOW] Three residual inaccuracies in the rewritten prose

- **The traversal decoy at `<tmp>/x/y/` is unreachable.** Item 3(a) says the
  decoys sit at BOTH `<tmp>/x/y/` and `<tmp>/x/` "so each probe depth has
  something real to find". Every one of the five `package.json` probes at
  `staticSmoke.test.ts:148-153` normalises to two levels above the served root
  (`/assets/../../../` is `assets` then three ups, which is also two above the
  root). There is one probe depth, not two. The `<tmp>/x/` decoy is the load-
  bearing one; the other is harmless but the reasoning is loose in the same way
  v1's was.
- **B11's accepted narrowing was not applied.** Line 458 still asserts "No
  outcome depends on an untracked artifact." PASS versus SKIP in 3(c) is decided
  entirely by whether an untracked `dashboard/dist` exists and agrees. The true
  and adjudicated statement is B11's: no FALSE RED depends on the artifact.
  Given finding 5, the absolute form is the sentence that hides the coverage
  hole.
- **Item 1C re-runs an experiment the anchor already ran.**
  `npm-test-dynamodb-local-contention.md:293-301` records exactly these two arms
  - explicit shared key versus per-file - 3 runs each, under concurrent load,
  446-509s vs 75-95s. The only genuinely new variable is the tmpfs container
  (2026-08-24). The spec cites those numbers without noting that its measurement
  is a refresh rather than a new experiment, which matters for finding 8's
  budget.

---

## 17. Contesting the adjudication: the single REJECT

**Verdict: concede the substance, contest the attribution.**

The rejected item is described as "A13's implied remedy - instrument anyway and
let the numbers decide". I did not propose that. A13 as filed was
*"Item 2's proposed cut is on the wrong side of the budget it is trying to
fix"* - a phase-boundary finding, adjudicated ACCEPT in the Item 2 table as
B1/A13 BOTH. A14 was the arithmetic bound. Neither asked for a measurement round
to re-derive the boundary; A14 explicitly said the arithmetic "narrows the search
before a single measurement is taken", which is the same conclusion the rejection
reaches.

On the merits I concede fully: instrumenting to re-establish `:140-143` versus
`:152` would be ceremony, the boundary is settled by reading, and confining the
instrumentation to `buildProgram` versus `scanProgram` is right. One correction
to the record: the rejection should not be attributed to A13, because the record
of this review is what the next person reads.

## 18. Contesting the adjudication: B9 (`waitUntilTableExists`) - it can be settled NOW, not at build time

**Verdict: the exclusion is CORRECT, and the build-time task should be closed as
already answered.**

Both round-1 reviewers marked this UNVERIFIED for lack of `node_modules`. The
main checkout has them. From
`node_modules/@aws-sdk/client-dynamodb/dist-es/waiters/waitForTableExists.js`:

```js
    catch (exception) {
        reason = exception;
        if (exception.name === "ResourceNotFoundException") {
            return { state: WaiterState.RETRY, reason };
        }
    }
    return { state: WaiterState.RETRY, reason };
```

The `catch` block has no rethrow. `ResourceNotFoundException` gets an explicit
`RETRY`, and **every other exception falls through to the same `RETRY`**. An
`InternalFailure` or `InternalServerError` raised by the waiter's own
`DescribeTable` therefore cannot escape - it becomes another poll tick, and the
only way out is `SUCCESS` or `TIMEOUT` (`checkExceptions` throwing a
`TimeoutError`).

So the spec's reasoning was right for the right reason, and the ACCEPT-MODIFIED
can be upgraded: delete the "BUILD-TIME TASK ... UNVERIFIED" paragraph at spec
lines 127-132 and record the verification instead. This matters beyond
bookkeeping - leaving it open invites the builder to reopen the exclusion, and
finding 7 shows the waiter needs attention for a completely different reason
(its 20-second `minDelay`) that an "is it retry-safe?" investigation would not
surface.

I do not contest any other adjudication. A22's presentation fix, A7's run
counts, A8/B2's inversion, A18's mtime deletion and A15/B12's health-probe
protection are all correctly applied in v2 - with the caveats above.
