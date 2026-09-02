# Design review R1 - reviewer A (adversarial)

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`
- Repo state: `W:\tmp\npm-test-soundness` @ `5ce9912f` (worktree otherwise clean;
  the spec is the only untracked file)
- Method: static reading and grep only. No suite, npm script or container was
  run. Byte-exact quotation is in
  `.superpowers/sdd/spec-r1-reviewer-a-code-reference.md`; this file cites
  `file:line`.

Three of the spec's own "corrections to the record" check out and are NOT
findings: there is no soak clause on the anchor (its closing bullet at
`docs/issues/npm-test-dynamodb-local-contention.md:394` is a reopen trigger);
`InternalFailure` / `InternalServerError` appear in exactly one executable
retry, `app/scripts/db-update-gsis.ts:116`, and `dynamoAdmin.ts` has no
control-plane retry; and the anchor's last entry
(`npm-test-dynamodb-local-contention.md:702-705`) does say the AGENTS numbers
have not been re-measured under tmpfs. Item 3(b) is genuinely new coverage -
`app/test/appIdentityAssets.test.ts` asserts icon BYTES, not the index.html link
tags, and `e2e/tests/dashboard-next/environment-identity.spec.ts:105-150`
asserts the runtime endpoints, not the HTML.

What follows is what does not hold.

---

## 1. [BLOCKING] The CreateTable retry-safety claim is false in exactly the case the retry exists for

**Spec section:** Item 1A, "Every one of the four is retry-safe by
construction", first bullet - "an accepted-but-unanswered attempt makes attempt
2 throw `ResourceInUseException`, which `ensureTable` ALREADY catches and
reports as `'exists'`. Correct outcome either way." And the closing sentence:
"So unlike the GSI create, none of these needs a bespoke re-read hook."

**Evidence:** `app/src/lib/dynamoAdmin.ts:87-93`. The `try` block contains TWO
statements: the `CreateTable` send AND
`waitUntilTableExists({ client, maxWaitTime: 60 }, ...)`. The `catch` only
inspects `ResourceInUseException`. So when attempt 2 throws `ResourceInUseException`,
control leaves the try block and **the waiter never runs**.

**What it implies:** In the pre-existing-table case that is harmless (the table
is already ACTIVE). In the accepted-but-unanswered case - the only case the
retry is being added for - attempt 1 genuinely created the table moments ago,
so it is very likely still `CREATING`. `ensureTable` then returns `'exists'`
without waiting for ACTIVE, and:

- `enableTtlIfNeeded` (`dynamoAdmin.ts:117-119`) fires immediately against a
  `CREATING` table on every non-vitest path;
- ~40 integration suites and `createAllTables` (`app/scripts/db-create.ts:31-51`)
  proceed straight to writes against a table that is not ready.

This is precisely the "did attempt N actually land?" hazard that
`db-update-gsis.ts:118-122` solves with a DescribeTable re-read, and the spec
explicitly forecloses that remedy for these four sends. The design as written
converts a loud `InternalFailure` into a quieter, later
`ResourceNotFoundException` on the first write - a worse failure for the same
gate. The build cannot proceed on this reasoning.

## 2. [HIGH] The DeleteTable retry-safety claim is false for a table in DELETING state

**Spec section:** Item 1A - "`DeleteTable` - attempt 2 throws
`ResourceNotFoundException`, which `deleteTableIfExists` ALREADY catches."

**Evidence:** `app/src/lib/dynamoAdmin.ts:146-149` catches
`ResourceNotFoundException` and nothing else. AWS's documented DeleteTable
semantics raise `ResourceInUseException`, not `ResourceNotFoundException`, when
the table is in `CREATING` / `UPDATING` / `DELETING` state - which is the state
an accepted-but-unanswered attempt 1 leaves behind. (DynamoDB Local's exact
behaviour here is UNVERIFIED - I did not run the container. But the spec asserts
the outcome as "correct either way" with no evidence, and the burden is the
spec's.)

**What it implies:** The retry can turn a successful delete into a thrown
`ResourceInUseException` out of `afterAll` teardown in ~40 suites - a new red
in the very gate the mission is fixing. If this claim is kept, it needs a
container-measured proof, not a construction argument.

## 3. [HIGH] The UpdateTimeToLive "re-sending is a no-op" claim is unsupported and probably wrong

**Spec section:** Item 1A - "`UpdateTimeToLive` - guarded by a status read that
returns early on `ENABLED` / `ENABLING`; re-sending an enable for an
already-enabled TTL is a no-op."

**Evidence:** The status read is at `dynamoAdmin.ts:128-131` and runs ONCE,
before the send - exactly the shape `db-update-gsis.ts:70-74` calls out as the
reason a bare re-send is unsafe ("`ensureGsis` reads `liveIndexNames` ONCE PER
TABLE, above the loop - so a bare re-send inside the loop asks for an index that
may already exist"). The retry would sit INSIDE that guard, so on attempt 2 the
guard's information is stale by construction. AWS documents UpdateTimeToLive as
raising a `ValidationException` when TTL is already enabled or being modified;
`enableTtlIfNeeded` catches nothing at all. (Container behaviour UNVERIFIED.)

**What it implies:** The one command in the set that has no idempotence catch is
being retried on the strength of an unevidenced "no-op". A `ValidationException`
would escape to `db:create` and every e2e lane bootstrap.

## 4. [HIGH] Two of the four "hot path of every integration suite" call sites never execute under `npm test`

**Spec section:** Item 1A table - the `DescribeTimeToLive` and `UpdateTimeToLive`
rows, under "it is on the hot path of every integration suite in the repo".

**Evidence:** `app/vitest.config.ts:119` sets `DYNAMO_DISABLE_TTL: '1'` for the
whole vitest run, and `app/src/lib/dynamoAdmin.ts:116-119` reads exactly that
flag and skips `enableTtlIfNeeded` entirely. So during `npm test` - gate 2, the
failure this mission exists to fix - those two sends are never issued.

**What it implies:** The two riskiest retry-safety claims (findings 3 and, in
part, 1) buy the mission's stated goal nothing, while adding new failure surface
to `db:create`, the e2e lane bootstrap and `npm run dev -- --local`. The spec's
own justification table misdescribes current behaviour, and a builder following
it will believe it is hardening the gate when it is only hardening paths outside
the gate. The honest scope is `CreateTable` + `DeleteTable`; if the TTL pair
stays, the spec must say which non-test path it is protecting and measure THAT.

## 5. [HIGH] The local-endpoint gate is not "three lines" of duplication, and the spec's own risk question is left unanswered

**Spec section:** Item 1A, "Local-endpoint gate, fail-closed" - "The localhost
predicate is defined INSIDE `dynamoAdmin.ts` rather than imported from
`app/scripts/db-create.ts` ... The duplication is three lines ... ACCEPTED
TRADE". Plus the Risks item: "what does `client.config.endpoint` resolve to when
it was never set, and does the predicate fail CLOSED?"

**Evidence:** `db-create.ts:22-29`'s `isLocalEndpoint` takes a **URL string** and
calls `new URL(endpoint).hostname`. What `dynamoAdmin` can see is
`client.config.endpoint`, typed `Provider<Endpoint> | undefined` -
an **async function** returning `{ protocol, hostname, port, path }` (see
`@smithy/core .../middleware-endpoint/resolveEndpointConfig.d.ts`,
`EndpointResolvedConfig.endpoint`, against `@aws-sdk/client-dynamodb` 3.1070.0).
It is not a string and it is not synchronous. `createDynamoClient`
(`app/src/lib/dynamo.ts:61-79`) only sets `endpoint` when one is configured, so
the unset case IS `undefined` and does fail closed - but by a different
mechanism than the one the spec describes, and via an `await` the spec's
"three lines" framing does not admit.

**What it implies:** The ACCEPTED TRADE is recorded against a false premise, so
it is not actually a decision anyone made. Worse, the alternative the spec
rejects on that premise is cheap and exact: `ensureTable` / `deleteTableIfExists`
are only ever reached from callers that already hold the endpoint string
(`db-create.ts:32`, `db-create.ts:59`, and ~40 test files calling
`createDynamoClient({ endpoint })`), so an explicit parameter would be
fail-closed with no predicate at all. The spec should re-decide with the real
shape on the table.

## 6. [BLOCKING] Nothing in the evidence protocol can verify item 1A

**Spec section:** Item 1D ("BASELINE ... The same run after the fix") and
Deliverable 1 ("The three code changes above, each with the measurement that
justifies it").

**Evidence:** 1A's mechanism fires only when DynamoDB Local answers a
control-plane call with `InternalFailure` / `InternalServerError`. The anchor
records that as intermittent and, in its own baseline
(`npm-test-dynamodb-local-contention.md:440-450`), "only A currently
reproduces" - i.e. the suite-B signature was not reproducing even then. A
before/after `npm test` pair therefore cannot distinguish "the retry works" from
"the fault did not occur". The spec specifies no unit test, no injected-failure
test, and no fault-injection seam for the new helper - and `dynamoAdmin.ts` has
no test file today (`app/test/` has `tables.test.ts` and `genTables.test.ts`
only).

**What it implies:** The mission's headline code change ships with zero
verification of its behaviour, in a mission whose entire thesis is "close on
numbers". A directly testable seam (inject a `send` that fails N times, assert
attempts, backoff, and the terminal rethrow) has to be in the design, not left
to the builder.

## 7. [HIGH] The evidence protocol specifies n=1 per arm; the Risks section forbids exactly that

**Spec section:** Item 1D ("1. BASELINE ... Full `npm test` ... 2. The same run
after the fix") versus Risks ("Single runs prove nothing about an intermittent
fault - the anchor's own record shows a green OLD arm 2 runs in 3 ... report run
counts, never a single observation").

**Evidence:** the two statements are in the same document and cannot both hold.
Item 1B, by contrast, correctly specifies 10 runs.

**What it implies:** As written, a builder can satisfy 1D literally with two
runs and then be told by the Risks section that the result is worthless. The
anchor's close/keep-open decision - Deliverable 2 - hangs on this number. Pick
one, and pick it before the build.

## 8. [BLOCKING] Item 1C's arms do not measure the claim they are used to rewrite

**Spec section:** Item 1C, the arm table, and Deliverable 4 ("`AGENTS.md`'s
paragraph rewritten to what item 1C proves - and only that").

**Evidence:** `AGENTS.md:159-164` (and its source,
`npm-test-dynamodb-local-contention.md:66-79`) compares a **residue-carrying
database** (worktree key `hctestij3dce`, 116 leaked tables) against an **empty
one**. The variable is residue. The spec's arm 2 is
`AWS_ACCESS_KEY_ID=hccleanrun001 npm test`, and
`app/test/setup/dynamoAccessKey.ts:118-120` makes an explicit key win for EVERY
test file - collapsing all ~50 per-file databases onto one. So arm 2's variable
is **the isolation model**, not residue: it reinstates the single `queueLock`
that `fix/dynamo-per-file-keys` removed, which
`app/test/setup/dynamoAccessKey.ts:26-35` measures at ~17x on ops throughput.

**What it implies:** Arm 2 will be slow and will probably fail files - for a
reason that has nothing to do with the residue claim. The mission would then
rewrite AGENTS.md's first-diagnostic paragraph on a confounded measurement,
which is the exact failure the spec says it is closing ("Guessing here would
re-create the exact problem this mission is closing"). To measure the actual
claim you need a residue arm and an empty arm under the SAME keying model -
e.g. plant residue under a throwaway key and compare it against a fresh
throwaway key.

There is also a real, code-supported finding hiding under this that the spec
never states: because `hccleanrun001` is a FIXED key, every interrupted run
under the recipe leaks its `hc-test-<uuid>-` / `hc-hist-<uuid>-` tables into
that one database (`app/test/globalTeardown.ts:59-79` lists the families
`dropAllTables` cannot see). The "clean key" self-degrades with use. Any rewrite
of that paragraph has to address it.

## 9. [HIGH] Item 1C's two arms are not the same scope, so the wall clocks are not comparable

**Spec section:** Item 1C arm table - arm 1 is `npm test`, arm 2 is
`AWS_ACCESS_KEY_ID=hccleanrun001 npm test` annotated "(app workspace)".

**Evidence:** root `npm test` is `npm run test --workspaces --if-present`
(`package.json:39`) across five workspaces (`package.json:9-15`). AGENTS' own
recipe is `cd app && AWS_ACCESS_KEY_ID=... npx vitest run` (`AGENTS.md:156`), and
the 607s/65s numbers are app-only
(`npm-test-dynamodb-local-contention.md:70-71`).

**What it implies:** One arm is five workspaces and the other is one. Neither is
comparable to the historical numbers the mission is re-measuring. Fix the
commands before the runs, not after.

## 10. [MEDIUM] Item 1C ignores `sweepLedgerResidue`, the mechanism most likely to have already killed the effect

**Spec section:** Item 1C ("Under per-file keys the residue mechanism they
describe may no longer exist at all") - which never names the actual sweep.

**Evidence:** `app/test/globalTeardown.ts:20-25` records that `globalSetup` runs
the same ledger sweep BEFORE the next run, specifically to clean residue left by
a hard-killed run, "so cleaning on the way IN is what bounds the damage to one
run". `app/test/globalTeardown.ts:59-79` names the three residue families and
quotes the 607s/65s measurement as its own justification.

**What it implies:** The most probable answer to "does the residue claim still
reproduce" is "no, because a sweep now removes it on the way in" - and that is a
CODE fact available without any measurement. The spec's measurement plan should
be designed to confirm or refute that specific mechanism, and the AGENTS rewrite
should name it. As designed, the mission may measure the right numbers and still
attribute them to the wrong cause.

## 11. [MEDIUM] Contention changes the residue-sweep MODE, so 1D's baseline and post-fix runs are not held constant

**Spec section:** Item 1D - "Three other missions share this machine and one
DynamoDB Local container tonight. That load is the condition the anchor exists
for, so it is the acceptance environment, not noise."

**Evidence:** `app/test/globalTeardown.ts:33-45` - when another vitest run is
live machine-wide, residue tables younger than `CONCURRENT_SPARE_MS` are
**spared**; when none is, every residue table is deleted immediately.

**What it implies:** Under the declared acceptance environment the cleanup
behaviour itself is load-dependent, so the baseline run and the post-fix run can
start from different residue states for reasons unrelated to the fix. This is a
confounder in the mission's primary comparison and it is unenumerated.

## 12. [MEDIUM] Arm 2 silently changes the TEST SET, not just the timings

**Spec section:** Item 1C ("Record wall clock, failing FILES, and exit code for
each") and 1D ("The clean-key comparison ... so the handback separates what was
FIXED from what the key merely hid").

**Evidence:** `app/test/setup/dynamoAccessKeyGuard.test.ts:308` -
`describe.skipIf(!reachable || explicitKey)`. Setting `AWS_ACCESS_KEY_ID`
disables that entire block.

**What it implies:** Failing-FILE comparison between the arms is not
like-for-like; at least one file runs fewer cases in arm 2. The handback must
say so or the comparison is misleading.

## 13. [HIGH] Item 2's proposed cut is on the wrong side of the budget it is trying to fix

**Spec section:** Item 2, Step 1 phase table (which itself labels
`ts.getPreEmitDiagnostics(program)` as "in the health test") and Step 2 ("cut the
dominant cost ... The prior suspicion ... is `ts.getPreEmitDiagnostics`"), plus
Step 3 ("The hook budget becomes at least 4x the new measured solo cost").

**Evidence:** `app/test/logCallSiteGuard.test.ts:140-143` is the `beforeAll`
(`buildProgram` + `scanProgram`, budget 180_000).
`app/test/logCallSiteGuard.test.ts:151` puts `ts.getPreEmitDiagnostics` inside
the health `it(...)`, which runs under `testTimeout` (`app/vitest.config.ts:60`,
60_000), not the hook budget.

**What it implies:** The named failure is `Hook timed out in 180000ms`
(`docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md:18`). Removing
work from the TEST cannot reduce the HOOK's cost by one millisecond. The spec's
worked remedy does not address its own stated mechanism.

## 14. [HIGH] And that phase cannot be the dominant cost - refutable by arithmetic on the spec's own numbers

**Spec section:** Item 2 Step 2, "The prior suspicion, to be confirmed or
refuted by step 1, is `ts.getPreEmitDiagnostics`, which type-checks the entire
program - substantially a second full run of gate 1".

**Evidence:** the issue measured "196.2s total with 179.1s in tests"
(`logcallsiteguard-hook-budget-equals-its-own-cost.md:15-16`). The three `it`
blocks (`logCallSiteGuard.test.ts:145`, `:159`, `:164`) carry no per-test
timeout, so each is bounded by `testTimeout: 60_000` and the file passes solo -
so the health test is under 60s. Therefore the hook is at least ~119s of the
179.1s, i.e. at least two thirds. `getPreEmitDiagnostics` cannot be dominant.

**What it implies:** Step 1's instrumentation is worth doing, but the spec
should stop advertising a candidate its own numbers already rule out - it steers
the builder to spend the mission on a phase that can save at most ~30% of a cost
that lives in a different budget. The dominant cost is `buildProgram` +
`scanProgram`, and `scanProgram` is where `checker.getTypeAtLocation` /
`checker.typeToString` are called (`logCallSiteGuard.test.ts:79-81`).

## 15. [HIGH] "sourceCount > 50 already catches 'resolves nothing'" is false, and cutting the probe on it hollows the guard

**Spec section:** Item 2 Step 2 - "the existing `sourceCount > 50` assertion
already catches 'resolves nothing'".

**Evidence:** `buildProgram` roots the program on `parsed.fileNames` from
`app/tsconfig.json` (`logCallSiteGuard.test.ts:44-58`), and that config is
`"include": ["src"]` (whole file). Every file under `app/src` is a ROOT name, so
it is in `program.getSourceFiles()` whether or not a single `import` specifier
resolves. `sourceCount` is therefore invariant to the exact failure the TS2307
probe guards - it only catches "tsconfig enumerated nothing".

**What it implies:** The replacement rationale is wrong on its first leg, so the
"much cheaper probe" is being justified by a check that does not do the job. The
spec's own Risks item demands proving a replacement "by breaking the program
deliberately, not by reasoning about it" - and then the design reasons about it.
The targeted module-resolution check (second leg) is the only real replacement
and must be spec'd as such.

## 16. [MEDIUM] Item 2 sets a hook budget and never mentions the 60s test budget the health case runs under

**Spec section:** Item 2 Step 3 and the fallback.

**Evidence:** `app/vitest.config.ts:60` (`testTimeout: 60_000`); no per-test
override anywhere in `logCallSiteGuard.test.ts`.

**What it implies:** If step 1 shows the diagnostics phase is large, the file has
a SECOND load-dependent red the spec does not budget for, on a different
timeout. "The budget ends up a multiple of the new measured cost" needs to cover
both budgets or the mission fixes one red and leaves its twin.

## 17. [MEDIUM] Item 2's fallback produces a ~10-minute hook budget inside a required gate, with no ceiling

**Spec section:** Item 2, "Explicit fallback" - "fall back to raising the budget
to >= 4x the measured cost".

**Evidence:** the hook is at least ~119s today (finding 14). 4x is ~480-720s.

**What it implies:** A gate whose complaint is "slow false reds that teach people
to re-run" would gain a file that can burn ten minutes before failing, on a
runner capped at `maxWorkers: 4` (`app/vitest.config.ts:44`). The spec states
"A justified large budget beats an unjustified small one" as a slogan and sets
no upper bound; it needs one, or an explicit acceptance that this file may
dominate gate 2's wall clock.

## 18. [HIGH] Item 3's guarantee is contradicted by its own mechanism: mtime IS untracked state

**Spec section:** Item 3(c) and "Why this kills the class" - "No outcome depends
on an untracked artifact: absent and stale both skip, and the only way to red is
a fresh build that genuinely disagrees with its own source - which is a real
signal, and identical on the branch and on main."

**Evidence:** the FAIL/SKIP boundary in the (c) table is "dist OLDER than
`dashboard/index.html`" vs "dist NOT older than source". Git does not record or
restore mtimes: `git worktree add`, a branch checkout, a `main` sync, or any
file-touching operation stamps `dashboard/index.html` with "now". The mission
itself does exactly this - the spec's Gates section mandates "one `main` sync at
pre-handback".

**What it implies:** The outcome still depends on untracked filesystem state, it
has just moved from the dist's CONTENT to a timestamp. Concretely: build a dist
that genuinely disagrees with source (a real Vite regression), then sync main -
`dashboard/index.html` becomes newer, the case flips FAIL to SKIP, and the real
signal is suppressed. The branch/main symmetry the spec claims is a property of
tracked content, and mtime is not tracked. The tie-breaker is defensible as a
pragmatic choice; the guarantee written over it is not, and the guarantee is
what the human is being asked to approve.

## 19. [HIGH] Item 3(a)'s fixture layout does not line up with the traversal probes it says it preserves

**Spec section:** Item 3(a) - "The traversal probes keep a real target. The
fixture is laid out as `<tmp>/fixture/dist/index.html` with a planted
`<tmp>/fixture/secret.json` containing `"version"` and `"private"` keys, so an
escape one level above the served root has something to find."

**Evidence:** the existing probes (`app/test/staticSmoke.test.ts:148-154`)
escape TWO levels (`/%2e%2e%2f%2e%2e%2fpackage.json`) and THREE
(`/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`), and name `package.json`,
because `dashboard/dist/../../package.json` is the repo root manifest on the
real tree (the test says so at `:144-147`). One level above `<tmp>/fixture/dist`
is `<tmp>/fixture`, which under the spec holds `secret.json` - a different depth
AND a different filename. The assertions themselves
(`staticSmoke.test.ts:161-162`) look for `"version"` / `"private"` in the
response body.

**What it implies:** Unless the probe STRINGS are rewritten - which the spec does
not say - every probe targets a path that does not exist under the fixture, and
"never leaks file contents" passes against a directory with nothing to leak.
That is exactly the tautology the spec's own Risks section names, produced by
the spec's own layout. Also note the precedent the spec cites does NOT have a
parent directory: `app/test/devGating.test.ts:249` and
`app/test/unitMediaServe.test.ts:170` both make the `mkdtemp` directory itself
the dist root, so "already do exactly this" will lead a builder to the wrong
shape.

## 20. [MEDIUM] Item 3(c) is never exercised by the mission's own gates

**Spec section:** Item 3(c) and Deliverable 1 ("each with the measurement that
justifies it").

**Evidence:** `dashboard/dist` does not exist in this worktree. Nothing in the
gate list builds it: `npm run smoke` is
`npm run build -w @housingchoice/app && node ... scripts/smoke-dist.mjs`
(`package.json:68`), and the e2e stack runs the Vite DEV server
(`dashboard/vite.config.ts` `configureServer`), not `vite build`. The spec never
instructs anyone to run `npm run build -w dashboard`.

**What it implies:** The whole point of item 3 is the third and fourth rows of
the (c) table, and every gate run on this branch will take the "absent -> SKIP"
row. The four-state table ships unverified unless the spec adds an explicit
build-and-check step (including a deliberately stale dist, which is the case the
issue is actually about).

## 21. [MEDIUM] Item 3(c) does not say which tags, and a Vite build adds tags that are not regressions

**Spec section:** Item 3(c) - "compare the identity tags it carries against the
tags parsed from `dashboard/index.html`. Vite copies those link tags through
untransformed, so they must agree."

**Evidence:** a Vite build rewrites `<script type="module" src="/src/main.tsx">`
(`dashboard/index.html:17`) into hashed asset references and injects a
stylesheet `<link>`; `dashboard/vite.config.ts`'s `commitStampPlugin` injects a
`<meta name="x-app-commit">` whenever `VITE_E2E_COMMIT` is set, and
`transformIndexHtml` runs at build as well as in dev.

**What it implies:** "the tags" needs a definition (the three identity `link`
tags, matched by `rel`), or a builder writing a tag-set equality will produce a
red on the stylesheet Vite is supposed to add. Low effort to fix, high chance of
being got wrong.

## 22. [MEDIUM] The spec cites constraints it never states, so it does not stand alone

**Spec section:** Item 1A - "the mission's file list forbids touching
`db-create.ts`"; Item 2 - "Out of scope: giving the guard its own vitest
project/lane. It was offered and not chosen."

**Evidence:** there is no file list anywhere in the spec, and no record of what
was offered. The "What this mission does NOT do" section lists five bullets,
none of which is a file list, and none of which mentions `db-create.ts`.

**What it implies:** The single load-bearing justification for duplicating the
localhost predicate (finding 5) is an unresolvable reference. A builder who has
not seen the conversation cannot tell whether the constraint is real, and the
reviewer cannot test the trade-off it justifies.

## 23. [MEDIUM] The spec does not say whether the shared helper's fail-closed gate applies to `db-update-gsis.ts`

**Spec section:** Item 1A - "`db-update-gsis.ts` imports the helper and keeps its
own index-status verification as the caller-supplied ... hook, so the two paths
cannot drift" combined with "The retry ACTIVATES only when the client's resolved
endpoint is a localhost DynamoDB Local endpoint."

**Evidence:** today `sendWithInternalFailureRetry`
(`app/scripts/db-update-gsis.ts:103-127`) has NO endpoint gate; the gate lives
in the CLI block (`:262-270`). `ensureGsis` is exported and called from
`app/test/unreadIndexRepo.integration.test.ts:764`, `:803`, `:812` - the suite-B
cases the anchor names.

**What it implies:** Moving the helper changes suite B's protection from
unconditional to conditional on `client.config.endpoint` resolving the way the
new predicate expects. That may be fine, but it is a behaviour change to the one
already-working mitigation in the anchor and the spec neither states it nor
asserts it. If the predicate is subtly wrong (finding 5), the failure mode is
silent: suite B's retry stops firing and the anchor's suite-B tail reappears
looking like a new bug.

## 24. [LOW] Item 1D's acceptance environment is defined by wall-clock circumstance

**Spec section:** Item 1D - "Three other missions share this machine and one
DynamoDB Local container tonight."

**What it implies:** A builder starting tomorrow cannot reproduce the declared
acceptance environment and the spec offers no operational definition of
"contended" (concurrent runs? load average? container uptime?). Given that the
mission's close/keep-open verdict is measured in that environment, it needs a
definition that outlives tonight.

## 25. [LOW] Measurement blockers the spec does not budget for

**Evidence:** this worktree has no `node_modules` (neither `./node_modules` nor
`app/node_modules`). Every measurement in 1C, 1D and item 2, and all five gates,
require an install first - which itself perturbs a "before any edit" baseline
and takes non-trivial time on a loaded box. Separately, item 1C's arm-2 command
is written in POSIX env-prefix form (`AWS_ACCESS_KEY_ID=... npm test`), which is
a parse error in PowerShell, the repo's stated primary shell.

**What it implies:** Small, but both are the kind of thing that turns "the
baseline run" into two hours of unplanned work in the middle of a shared-load
window the spec is trying to use as a control.
