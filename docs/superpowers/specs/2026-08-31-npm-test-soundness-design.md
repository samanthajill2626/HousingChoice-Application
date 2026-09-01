# npm test soundness (M7) - design

- Date: 2026-08-31
- Branch: `feat/npm-test-soundness`
- Worktree: `W:\tmp\npm-test-soundness`
- Bundle: M7 of `docs/issues/_CLUSTERS.md` (re-derived 2026-08-31 @ `5ce9912f`)
- Revision: **v3**, after adversarial rounds 1 (two independent reviewers)
  and 2 (one continued reviewer). Adjudications:
  `docs/superpowers/reviews/2026-08-31-npm-test-soundness/design-review/adjudications.md`
  and `adjudications-r2.md`.

## The class

Three issues, one failure class: **a required gate goes red when nothing is
wrong, or blames the wrong thing when something is.**

| sev | issue | one-line |
|---|---|---|
| high | `npm-test-dynamodb-local-contention` | anchor - an unprotected control-plane surface and two unverified claims |
| med | `logcallsiteguard-hook-budget-equals-its-own-cost` | a `beforeAll` budget smaller than the hook's own cost |
| med | `static-smoke-fails-on-stale-dashboard-dist` | a test whose colour depends on a gitignored artifact |

The cost is not the individual red. It is that a gate which reds in a
different unrelated file each run teaches people to re-run until green,
which is how a real regression ships.

## Corrections to the record, established before design

1. **There is no 7-day soak clause on the anchor issue.** Its status is
   `open` and its closing paragraph is a REOPEN trigger, not a waiting
   period.
2. **The `InternalFailure` RETRY exists in exactly one file**,
   `app/scripts/db-update-gsis.ts:103-127`. (The string appears in comments
   elsewhere; the retry does not.) `app/src/lib/dynamoAdmin.ts` has no
   retry on any control-plane send.
3. **`AGENTS.md`'s clean-key recipe no longer means what it says** - see
   item 1C. This is established by reading the code, not by measurement.

## Locked decisions (human, 2026-08-31)

1. **Do the remaining anchor work** - extend the retry, re-examine the
   `AGENTS.md` recipe, close on evidence. `groupCrossCheck` is MEASURED,
   not pre-emptively rewritten.
2. **logCallSiteGuard: measure, then cut the cost** - not a bare budget
   raise.
3. **staticSmoke: split it** - no test's colour may depend on
   `dashboard/dist`.

## Item 1A - retry the container's `InternalFailure` on the unprotected surface

### What this is, stated honestly

The anchor names its suite-B tail as `UpdateTable` `InternalFailure`.
**That call IS already retried** (`db-update-gsis.ts:103-127`, applied at
`:227`). This item does not close that tail; it closes the same failure
MODE on the surface that was never protected. No record shows
`dynamoAdmin.ts`'s sends failing by name - the justification is the class,
not a specific open sighting, and the spec says so rather than borrowing
suite B's evidence.

Under concurrent load DynamoDB Local answers control-plane calls with
`InternalFailure`, or with `InternalServerError: This action timed out
because it took too long waiting for a lock` - the container's own
per-table `tryLock(10s)` expiring. Neither is a rejected request; the AWS
SDK's retry policy covers neither.

### The control-plane surface

Enumerated by this command, which is reproducible and which the builder
must re-run rather than trust this table:

```
grep -rn "new \(CreateTable\|DeleteTable\|UpdateTable\|UpdateTimeToLive\|DescribeTimeToLive\|DescribeTable\|ListTables\)Command\|waitUntilTableExists(" --include=*.ts --include=*.mjs app e2e scripts | grep -v node_modules
```

It finds ~25 sends and 3 waiter sites across 11 files. The v2 spec claimed
"nine sends exist in the repo", which was command-type-limited and
presented as exhaustive - worse than an admitted sample.

**Disposition rule, applied to all of them:**

- **MUTATING sends in `dynamoAdmin.ts` are covered.** They are the shared
  path every integration suite reaches.
- **`db-update-gsis.ts:228` keeps its existing retry**, refactored onto the
  shared helper with its index-status check as the verification hook.
- **READS (`DescribeTable`, `ListTables`, `DescribeTimeToLive`) are NOT
  covered on their own.** A failed read is not a half-applied mutation:
  the caller either already tolerates it (`globalTeardown`, `devReset`) or
  wants to see it. The one exception is `DescribeTimeToLive` inside
  `enableTtlIfNeeded`, which is covered because it is the guard for a
  mutation in the same function, not a standalone read.
- **Test-owned sends are NOT covered**, each for a stated reason:
  - `globalTeardown.ts:144` (`DeleteTable`) - a failed residue drop is
    already tolerated and re-attempted on the next run's way in.
  - `dynamoAccessKeyGuard.test.ts:327/:342` - this suite asserts cross-key
    VISIBILITY, which no retry can mask; `:342` is already best-effort.
    (The v2 reason - "a retry could mask the failure it asserts" - was
    wrong, and a wrong reason for a right-looking decision is worse than
    none.)
  - `unreadIndexRepo.integration.test.ts:728` (`CreateTable`) - **v2
    proposed routing this through the helper; that is DROPPED.** The site
    has no `ResourceInUseException` catch of its own, so handing it a retry
    would recreate at that line the exact defect this item fixes in
    `ensureTable`.

### Live-ness: corrected, and it inverts v2

The v2 spec said `DYNAMO_DISABLE_TTL: '1'` (`vitest.config.ts:119`) made
the two TTL sends dead under `npm test`. **That is backwards.**
`app/test/globalSetup.ts:90-91` states in its own comment that "vitest
`test.env` applies to workers, not globalSetup", and it sets only the
credentials. So `globalSetup` -> `createAllTables` -> `ensureTable` ->
`enableTtlIfNeeded` runs for all ~23 shared `hc-local-` tables on **every
`npm test`**, before any test starts. `UpdateTimeToLive` is squarely on the
gate path.

**Second-order consequence, filed rather than fixed here:**
`DYNAMO_DISABLE_TTL=1` therefore does NOT immunise the shared `hc-local-`
tables - `globalSetup` re-enables the reaper on them every run. A future
suite that pins a past clock and uses the shared tables carries the same
time bomb `groupCrossCheck` did. A new Tier-2 issue records this; fixing it
is not in this mission's scope.

### Per-command retry safety - corrected

The v1 spec claimed all four sends were retry-safe by construction. Three
were wrong, all in one shape: **a guard read ONCE, outside the send, which
stops being true on attempt 2** - the identical defect
`db-update-gsis.ts:70-86` documents about its own earlier version.

| command | the hole | the fix |
|---|---|---|
| `CreateTable` | attempt 2 after an accepted-but-unanswered attempt 1 throws `ResourceInUseException`; `ensureTable`'s catch (`:87-93`) returns `'exists'` without waiting, handing back a still-CREATING table | wait for the table to become ACTIVE on the `ResourceInUseException` path. This is a real hole in TODAY's code, independent of the retry |
| `DeleteTable` | attempt 2 against a DELETING table throws `ResourceInUseException`, uncaught at `:146-149` | tolerate it - DELETING means the delete landed |
| `UpdateTimeToLive` | the ENABLED/ENABLING guard (`:128-131`) is outside the send | the status read becomes the retry's verification hook, re-read before each re-send |
| `DescribeTimeToLive` | none - read-only | - |

**The wait must NOT be `waitUntilTableExists`.** The SDK waiter's default
schedule makes its second poll a flat 20s and it throws at 60s - inside
`ensureTable` calls that sit in `beforeAll` hooks budgeted at 60s. Arming a
new false red while fixing an old one is this mission's own failure mode.
Use a bounded `DescribeTable` poll with a short interval (~100ms) and an
explicit ceiling well inside the caller's budget.

### The verification hook must fail CLOSED

`db-update-gsis.ts:88-101`'s `indexStatus` catches everything and returns
`undefined`, falling through to a re-send. That is fail-OPEN and it is
tolerable there only because a re-sent GSI create is caught downstream.

**For `UpdateTimeToLive` it is not tolerable**: re-sending an enable for a
TTL that is already enabled can draw a `ValidationException`, converting a
transient container hiccup into a hard failure. So the shared helper's
contract is: **if the verification hook itself throws, rethrow the ORIGINAL
error rather than re-sending.** `db-update-gsis.ts` keeps its current
fail-open behaviour explicitly, as its own documented choice.

### The local-endpoint gate, specified concretely

The retry ACTIVATES only when the client's resolved endpoint is a localhost
DynamoDB Local endpoint. Everything else gets today's behaviour exactly.

`client.config.endpoint` is an async `Provider<Endpoint>` returning an
object with protocol / hostname / port - not a URL string. The gate awaits
it and treats `localhost`, `127.0.0.1`, `::1` **and `[::1]`** as local.
The bracketed form is the one `URL.hostname` actually yields, and
`db-create.ts:25` already accepts both; omitting it was a v2 defect.

**Fail closed.** No endpoint provider, a provider that throws, or a
non-local hostname all mean NOT LOCAL and therefore no retry.

The predicate lives in `dynamoAdmin.ts` rather than being imported from
`app/scripts/db-create.ts`, because `lib` importing from `scripts` inverts
the repo's dependency direction. It is not a copy: `isLocalEndpoint` takes
a URL string, this one takes a resolved endpoint object.

### Acceptance - this item MUST be able to fail

The v1 spec had no way to observe a retry; the item could have shipped
inert with five green gates. A new `app/test/dynamoAdminRetry.test.ts`
drives a STUB client with a programmable `send`, no container involved.

**Stub contract, specified because two rounds found ways to get it wrong:**

- it must throw **real exception INSTANCES** (`ResourceInUseException`,
  `ResourceNotFoundException` from `@aws-sdk/client-dynamodb`), because
  `dynamoAdmin` discriminates by `instanceof` (`:91`, `:148`) while the
  retry discriminates by `err.name`. A plain object would let a case pass
  for the wrong reason;
- it must answer `DescribeTable`, because the `ResourceInUseException` path
  now polls;
- it must expose a resolvable `config.endpoint` provider, settable per
  case.

Cases:

1. local endpoint, `CreateTable` throws `InternalFailure` twice then
   succeeds -> `ensureTable` returns, `send` called 3 times;
2. local, attempt 1 accepted-but-unanswered (`InternalFailure`, then
   `ResourceInUseException`) -> returns `'exists'` AND polled
   `DescribeTable` until ACTIVE before returning;
3. local, `DeleteTable` throws `InternalFailure` then
   `ResourceInUseException` -> resolves, does not throw;
4. local, `UpdateTimeToLive` retried -> status RE-READ between attempts;
   and a re-read that THROWS -> the original error is rethrown, no
   re-send;
5. **non-local endpoint, `InternalFailure` once -> throws immediately,
   `send` called exactly once.** This is the case that stops the gate
   shipping inert;
6. no endpoint provider at all -> same as (5);
7. `[::1]` and `127.0.0.1` -> treated as local (pins the v2 omission);
8. **`ensureGsis` still retries after the refactor** - a stub whose
   `UpdateTable` throws `InternalFailure` then succeeds. Without this the
   mission could silently disarm the only retry that exists today while
   adding one that never fires.

## Item 1B - groupCrossCheck: measure, do not pre-rewrite

The anchor lists suite A's remaining remedy as "make the ordering/window
assertions robust to latency", on evidence that it "FAILS ALONE,
sometimes". **That evidence predates two fixes now in the file**: the
injected `cleanupMs` - which is the ROOT CAUSE the issue itself identifies
for the solo failures, a TTL time bomb rather than latency - and the
`afterEach` partition drain.

- **Measure both arms.** 10 consecutive SOLO runs of the file, AND its
  behaviour across the contended full runs of item 1D. The solo arm alone
  cannot settle a latency question, because it removes the latency by
  construction.
- **If neither arm fails: that is the deliverable.** Strike the remedy as
  superseded by the TTL fix, naming the evidence.
- **If either fails: diagnose to root cause before editing.** No widening
  of windows or timeouts as a first move.

## Item 1C - what `AWS_ACCESS_KEY_ID=hccleanrun001` actually does now

`AGENTS.md` opens its `npm test` guidance with "re-run under a clean access
key before blaming anything", citing 607s / 9 failures versus 65s / 0. The
mental model is "a fresh key means an empty database, free of residue".

**Under per-file keys that model is wrong.**
`accessKeyForTestFile` (`app/test/setup/dynamoAccessKey.ts:118-120`)
returns the explicit key for EVERY test file, so exporting
`AWS_ACCESS_KEY_ID` collapses all ~53 integration suites back onto ONE
database and one `queueLock`. That is not a clean-database arm - it is
**the OLD arm of the experiment that justified per-file keys**, the one
that measured 446-509s against 75-95s.

So the recipe now recommends the worse configuration while describing it as
the clean one. **This is established by reading the code.** The
measurement's only job is to date the claim to THIS container - the anchor
already ran the full experiment at its `:293-301`, and re-deriving a
settled result would be ceremony.

**Two arms, app workspace only** (matching AGENTS.md's own
`cd app && npx vitest run`, not the five-workspace root script), **2 runs
each**:

| arm | bash | PowerShell |
|---|---|---|
| default, per-file keys | `cd app && npx vitest run` | `cd app; npx vitest run` |
| explicit shared key | `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` | `cd app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run` |

Three confounds are recorded, not assumed away:

- **`sweepLedgerResidue` runs on the way IN** (`globalSetup.ts`, sweep at
  `globalTeardown.ts:20-25`) - the prime alternative explanation for the
  residue effect having already vanished. It must be named in the rewritten
  paragraph if the numbers no longer reproduce.
- **The sweep's MODE depends on concurrency** (`globalTeardown.ts:33-45`):
  under a live neighbour it spares young tables instead of dropping them.
  Record the mode per run.
- **Arm 2 changes the test SET**, not only timings:
  `dynamoAccessKeyGuard.test.ts:308` skips its per-file assertions when an
  explicit key is present. The skip-count delta is expected, not a failure.

## Item 1D - the evidence protocol

**The protocol must not become the load it is measuring.** v2 mandated ~12
full app runs; a reviewer correctly pointed out that this mission would
then be the dominant load source, invalidating its own contention
snapshots. Cut to the minimum that can carry a verdict:

| arm | runs |
|---|---|
| baseline, base commit, contended | 3 |
| post-fix, contended | 3 |
| item 1C, two arms | 2 each |

**Ordering is fixed: baseline FIRST**, while the neighbouring missions are
still live, because that is the only arm whose value depends on the
contention being real.

**"Contended" is operationally defined** and captured immediately before
and after every run: the count of other live vitest runs
(`app/test/helpers/testRunRegistry.ts` already tracks this), the
worktree-filtered node/playwright process count, and the DynamoDB Local
container's CPU and RSS. A run whose snapshot shows no neighbours is
labelled QUIET.

**Fallback, because the neighbours will finish.** If the post-fix arm can
only be run QUIET, say so plainly and report the comparison as
baseline-contended vs post-fix-quiet - clearly labelled as the weaker
comparison it is. **Do not fabricate load** to match the baseline, and do
not silently drop the label.

1. **Install first.** `npm install` in this worktree BEFORE the baseline,
   plus one discarded warm-up run - otherwise the baseline pays a cold
   install and cold transform cache and the wall-clock comparison is
   meaningless.
2. Single observations prove nothing about an intermittent fault. **Wall
   clock and failing FILE names are the durable signals; pass/fail on one
   run is not.**

Hard constraints:

- **The shared container may NOT be restarted** while the other missions
  are live. If the database-count axis is the blocker, measure it, say so,
  and stop there.
- **Never run a full e2e suite and an interactive session at once from
  this worktree.** Confirm no orphaned listener on the lane's ports before
  each e2e run - `reuseExistingServer` adopts an orphaned stack on a commit
  match alone.
- **Do NOT set `E2E_CHILD_LOG_DIR`.** Piping a child's stdout makes
  `isTTY` false and block-buffers the stream, changing the timings being
  measured. A trace is the artifact.
- **Gates run BARE, under the DEFAULT per-file keys.** The clean-key run is
  EVIDENCE, never a gate.
- **Adjudicating a contended gate-2 red**: re-run the failing FILES alone,
  run the full suite at the merge base, compare failing FILES rather than
  failing cases, report both runs.

## Item 2 - logCallSiteGuard's self-defeating budget

`app/test/logCallSiteGuard.test.ts` does its work in one `beforeAll`
(`:140`) with a 180s budget (`:143`). Measured 2026-08-26 the file ran
196.2s ALONE on a clean key. Under load it fails as `Hook timed out in
180000ms` with zero assertion failures. It touches no database, so it is a
different mechanism from item 1 that presents identically.

### Where the cost is NOT

The v1 spec named `ts.getPreEmitDiagnostics` as the dominant cost and
proposed cutting it. **It is not in the hook** - it runs inside the first
`it` (`:152`). Cutting it would have removed exactly zero hook cost.
Arithmetic settles the rest without measuring: the three `it`s run under
`testTimeout: 60_000`, so against the 179.1s aggregate the **hook is at
least ~2/3 of the cost**. The hook is exactly `buildProgram(true)` plus
`scanProgram`.

### Step 1: split the hook

Instrument `buildProgram` versus `scanProgram` inside the hook - the split
that is genuinely unknown - and time the health `it` separately for step 4.
The instrumentation is a MEASUREMENT: recorded in the mission records,
removed before handback.

### Step 2: cut the measured dominant phase

- If **`scanProgram`** dominates: the cut is NOT reordering the
  `isCatchDeclared || isErrorTyped` test - **`:98` and `:106` already
  short-circuit**, which v2 missed. The real cost is the EAGER checker call
  at `:97`: `getShorthandAssignmentValueSymbol` runs before `legal` is
  consulted, so the checker is invoked even for a wired key that cannot
  produce a finding. Hoist the `legal` test above it. This changes no
  result.
- If **`buildProgram`** dominates: **no remedy is pre-committed.** v2
  proposed two that do not exist - `createCompilerHost` has no
  type-checking to remove, and `include: ["src"]` leaves no roots to
  narrow. Measure it, report it, and bring the remedy back as a decision.

### Step 3: the health probe may NOT be hollowed out

The v1 argument that `sourceCount > 50` already catches "resolved nothing"
is false: `app/tsconfig.json` is `"include": ["src"]`, so every file under
`app/src` is a program ROOT and is counted regardless of whether its
imports resolve. TS2307 covers a shape `sourceCount` structurally cannot.

The probe is load-bearing. Any cheaper replacement is validated by
**deliberately breaking module resolution and proving the probe still
fails** - not by reasoning. If none survives that test, it stays.

### Step 4: budget BOTH clocks

- Hook budget >= **4x** the new measured cost, **ceiling 600s**. Past that,
  a ten-minute hook in a required gate is its own problem and the item
  reports rather than ships it.
- **The health `it` has its own exposure**: it runs under
  `testTimeout: 60_000` and carries a whole-program type-check. If step 1
  measures it near 60s it gets an explicit per-test budget on the same 4x
  rule. Missing this would fix the hook and leave the next false red one
  line below it.
- Shipped budget comments cite **only what this mission measured
  directly**, with the date. The inherited 196.2s / 179.1s figures
  aggregate hook plus tests; they are context, not justification.

**Fallback.** If the cost cannot come materially below ~196s, raise the
budget to >= 4x measured within the ceiling and record why the cut failed.

**Out of scope:** a separate vitest project or lane for the guard.

## Item 3 - staticSmoke must not depend on a gitignored artifact

A branch is green because the dashboard happened to be built in that
worktree, and the same code reds on main where the build is stale. The
colour tracks an untracked artifact, so neither colour carries information.

Today the guard checks existence only (`:19`, `:28`). Absent -> clean skip.
STALE -> the suite runs and fails, naming the manifest path, so the natural
first move is to read PWA code that is fine.

`npm run smoke` cannot fix it: it builds the APP workspace
(`package.json:68`), not the dashboard, and runs AFTER `npm test`.

### (a) App-serving behaviour -> a fixture the test writes. NEVER skips.

SPA fallback, reserved namespaces, hardening headers, both CSP
media-bucket shapes, the runtime `/app-identity/*` endpoints and the
path-traversal probes are APP behaviour needing SOME `index.html`.
`devGating.test.ts:249-251` and `unitMediaServe.test.ts:171-173` already do
this with `mkdtemp`.

A coverage GAIN: today all of those silently skip on any checkout where
nobody built the dashboard - including this worktree.

**Fixture contents are specified.** The fixture `index.html` must carry
`HousingChoice` and `<div id="root">`, because assertions at `:41`, `:108`,
`:165` and `:85` depend on them.

**Traversal decoys are placed against the actual probe strings.** The
probes at `:148-154` escape TWO levels
(`/%2e%2e%2f%2e%2e%2fpackage.json`); the `/assets/...` probe at `:153`
prefixes a path segment that `express.static` resolves within the same
root, so it reaches the same depth rather than a third level. v2's single
decoy one level up would have left every "no leak" assertion vacuous - the
exact tautology it claimed to prevent. The builder places a decoy
`package.json` containing `"version"` and `"private"` at **each depth the
probe strings actually reach**, verified by asserting the decoy IS readable
from disk at that path before asserting the server does not serve it. A
decoy nobody can reach proves nothing.

### (b) The PWA identity contract -> tracked source. NEVER skips.

`dashboard/index.html` is version-controlled, identical in every worktree,
and is the file `2210f671` changed. The contract is exactly:

- contains `href="/app-identity/manifest.webmanifest"`
- contains `rel="icon" href="/app-identity/icon-192.png"`
- contains `rel="apple-touch-icon" href="/app-identity/icon-192.png"`
- does NOT contain `href="/manifest.webmanifest"`
- does NOT contain `href="/icons/icon-192.png"`

### (c) The real build -> a diagnostic that can PASS or SKIP, never FAIL.

When `dashboard/dist/index.html` exists, compare those five conditions
against it. Vite copies the link tags through untransformed; only those
five are compared, since a build also injects hashed asset tags and, under
e2e, an `x-app-commit` meta.

**v2's mtime tie-breaker is deleted.** Git does not preserve mtimes, so a
fresh clone, a new worktree, or this mission's own mandated `main` sync
would rewrite `dashboard/index.html`'s mtime and silently flip a genuine
failure into a skip. A predicate the required workflow itself defeats is
worse than none.

| dist state | outcome |
|---|---|
| absent | SKIP - "no built dashboard; run `npm run build -w dashboard`" |
| present, all five hold | PASS |
| present, any fails | SKIP - see the message below |

**The SKIP message must not send an operator round a loop.** If the
dashboard build itself drops the tags, rebuilding reproduces the same skip
forever. So the message says both causes and what distinguishes them:
"`dashboard/dist` disagrees with `dashboard/index.html`. Most likely the
dist is stale - run `npm run build -w dashboard`. **If a fresh build still
reports this, the dashboard BUILD is dropping the identity tags, which is a
real regression** - see `docs/issues/<slug>.md`."

**The honest cost, and it is filed rather than hidden.** With (c) unable to
fail, **nothing anywhere asserts the BUILT dashboard's identity tags** - a
`vite build` regression would go undetected indefinitely. That coverage
cannot be recovered without building the dashboard inside a gate, which was
considered and not chosen. So a Tier-2 issue records the gap, names the
remedy (`npm run build -w dashboard` wired into the app workspace's pretest
or `globalSetup`) and its cost (~15-40s on every `npm test`, on every
branch, including the many that never touch the dashboard). An invisible
gap becomes a tracked one.

**(c)'s live branches must be observed, not assumed.** Nothing in the gate
chain builds `dashboard/dist` and this worktree has none, so the mission
runs `npm run build -w dashboard` ONCE by hand and records both branches:
the PASS on a current build, and the SKIP-with-message after editing the
built `dashboard/dist/index.html` in place (then restoring it). `distDir`
is a fixed path at `:18`, so in-place mutation is the only available seam -
the file is gitignored, so nothing is at risk.

## What this mission does NOT do

- No changes to app runtime code other than `app/src/lib/dynamoAdmin.ts`.
- No container restart, no `db:stop` / `db:start`, no table sweeps outside
  this worktree's own lane.
- No e2e harness changes; no new vitest project or lane.
- No changes to `seedLive`, `seedProfile.integration` or
  `unreadIndexRepo.integration`. They are WATCH-ONLY; any edit is a
  separate decision.
- No fix for the `globalSetup` TTL re-enable or the built-dashboard
  coverage gap - both are FILED, not built.
- No merge, no deploy, no infrastructure, no cleanup.

## Deliverables

1. The three code changes, each with the measurement that justifies it.
2. `docs/issues/` closures: Resolution stamps on all three files, written
   against measured evidence. **The anchor closes only if its measurements
   support it**; if the class survives it stays open with the new numbers.
3. **Two NEW Tier-2 issue files**, from `docs/issues/_TEMPLATE.md`:
   - `globalSetup` re-enables TTL on the shared `hc-local-` tables every
     run, defeating `DYNAMO_DISABLE_TTL` for those suites;
   - no gate asserts the BUILT dashboard's PWA identity tags.
4. **An edit to `docs/issues/_CLUSTERS.md`'s M7 entry** superseding its
   "run its gates under a clean access key" advice, which item 1C shows
   recommends the worse configuration. Asserting the supersession in a
   review record is not a deliverable; changing the file is.
5. `npm run issues` re-run (regenerates the gitignored `INDEX.md`).
6. **`AGENTS.md`'s "FIRST, if `npm test` is red on DynamoDB Local suites"
   paragraph rewritten** to what item 1C establishes, and to the numbers
   this container actually produces. Only what is proven.
7. Mission records committed to
   `docs/superpowers/reviews/2026-08-31-npm-test-soundness/` as produced.

## Gates

Bare, from `W:\tmp\npm-test-soundness`, after one `main` sync at
pre-handback:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Gate 5 is no NEW lint errors in TOUCHED files, attributed by baseline
comparison at the merge base - never by line number. The config lints
`.ts`/`.tsx` only.

## Risks and watch items

- **Retrying can mask.** The local-endpoint gate is the only thing keeping
  the retry off any path that could reach real AWS, and acceptance cases 5
  and 6 are the only things proving the gate is not inert.
- **The refactor can disarm the working retry.** Case 8 exists solely for
  that, and it is the difference between improving the harness and
  quietly regressing it.
- **A fixture can make an assertion tautological.** This has already
  happened twice in this document - v1's traversal decoy and v2's
  replacement. Verify the decoy is reachable before asserting it is not
  served.
- **Measurement under shared load is noisy, and this mission is part of the
  load.** Report run counts and contention snapshots; label a QUIET arm as
  QUIET.
- **`groupCrossCheck` has been misdiagnosed three times.** Do not add a
  fourth explanation without evidence surviving isolation AND load.
- **These changes touch the harness every other mission is gated by.** A
  defect here fails other people's branches, not just this one.
