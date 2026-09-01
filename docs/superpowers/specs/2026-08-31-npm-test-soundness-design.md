# npm test soundness (M7) - design

- Date: 2026-08-31
- Branch: `feat/npm-test-soundness`
- Worktree: `W:\tmp\npm-test-soundness`
- Bundle: M7 of `docs/issues/_CLUSTERS.md` (re-derived 2026-08-31 @ `5ce9912f`)
- Revision: v2, after adversarial round 1 (two independent reviewers;
  adjudications at
  `docs/superpowers/reviews/2026-08-31-npm-test-soundness/design-review/adjudications.md`)

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

Two beliefs were checked and are wrong. Both were re-checked by two
adversarial reviewers and stand.

1. **There is no 7-day soak clause on the anchor issue.** Its status is
   `open` and its closing paragraph is a REOPEN trigger ("reopen if a full
   `npm test` fails a DynamoDB suite that mints its own throwaway prefix,
   on an otherwise-idle box, twice"), not a waiting period.
2. **The `InternalFailure` RETRY exists in exactly one file.**
   `app/scripts/db-update-gsis.ts:103-127`. (The string itself also appears
   in comments elsewhere; the retry does not.) `app/src/lib/dynamoAdmin.ts`
   has no retry on any of its control-plane sends.

A third claim is unverified rather than wrong: the anchor's own last entry
says the degraded-key numbers quoted in `AGENTS.md` have NOT been
re-measured since `-inMemory` was replaced with SQLite on tmpfs, and "do
that before citing those numbers again".

## Locked decisions (human, 2026-08-31)

1. **Do the remaining anchor work** - extend the retry, re-examine the
   `AGENTS.md` recipe, close on evidence. `groupCrossCheck` is MEASURED,
   not pre-emptively rewritten.
2. **logCallSiteGuard: measure, then cut the cost** - not a bare budget
   raise. The budget ends up a multiple of the new measured cost.
3. **staticSmoke: split it** - no test's colour may depend on
   `dashboard/dist`.

## Item 1A - retry the container's `InternalFailure` on the unprotected surface

### What this is, stated honestly

The anchor names its suite-B tail as `UpdateTable` `InternalFailure`.
**That specific call IS already retried** (`db-update-gsis.ts:103-127`,
applied at `:227`). This item does not close that tail; it closes the
same failure MODE on the surface that was never protected. No record shows
`dynamoAdmin.ts`'s sends failing by name - the justification is the class,
not a specific open sighting, and the spec says so rather than borrowing
suite B's evidence.

Under concurrent load DynamoDB Local answers control-plane calls with
`InternalFailure`, or with `InternalServerError: This action timed out
because it took too long waiting for a lock` - the container's own
per-table `tryLock(10s)` expiring. Neither is a rejected request. The AWS
SDK's default retry policy covers neither, so both escape to the caller
and fail whatever gate is running.

### The full control-plane surface (enumerated, not sampled)

Nine local control-plane sends exist in the repo:

| site | command | disposition |
|---|---|---|
| `dynamoAdmin.ts:88` | `CreateTable` | COVERED |
| `dynamoAdmin.ts:129` | `DescribeTimeToLive` | COVERED |
| `dynamoAdmin.ts:133` | `UpdateTimeToLive` | COVERED |
| `dynamoAdmin.ts:146` | `DeleteTable` | COVERED |
| `db-update-gsis.ts:228` | `UpdateTable` | already retried; unchanged |
| `unreadIndexRepo.integration.test.ts:728` | `CreateTable` | COVERED - routed through the exported helper. This is suite B's OWN fixture setup |
| `globalTeardown.ts:144` | `DeleteTable` | NOT covered - a failed residue drop is already tolerated and retried on the next run's way in |
| `dynamoAccessKeyGuard.test.ts:327` | `CreateTable` | NOT covered - deliberate: this suite exists to prove the keying scheme, and a retry here could mask the very failure it asserts |
| `dynamoAccessKeyGuard.test.ts:342` | `DeleteTable` | NOT covered - same reason |

Every exclusion is a decision with a reason, not an omission.

**Live-ness note.** `DYNAMO_DISABLE_TTL: '1'` (`vitest.config.ts:119`)
means `enableTtlIfNeeded` never runs under `npm test`, so the two TTL sends
are dead on the gate path and live only under `db:create` and the e2e
lanes. They are covered anyway - they are the same class - but no claim is
made that they protect `npm test`.

### Per-command retry safety - corrected

The v1 spec claimed all four were retry-safe by construction. **Three of
those claims were wrong**, each in the same shape: a guard that is read
ONCE, outside the send, and therefore stops being true on attempt 2. That
is the identical defect `db-update-gsis.ts:70-86` documents about its own
earlier version.

| command | the hole | the fix |
|---|---|---|
| `CreateTable` | attempt 2 after an accepted-but-unanswered attempt 1 throws `ResourceInUseException`; `ensureTable`'s catch (`:87-93`) returns `'exists'` WITHOUT `waitUntilTableExists`, handing back a still-CREATING table | the `ResourceInUseException` path waits for the table to exist before returning. This is a real hole in TODAY's code, independent of the retry |
| `DeleteTable` | attempt 2 against a DELETING table throws `ResourceInUseException`, which `deleteTableIfExists` (`:146-149`) does not catch | tolerate it - a DELETING table means the delete landed |
| `UpdateTimeToLive` | the ENABLED/ENABLING guard (`:128-131`) is outside the send, so a retry re-sends an enable whose status was read before attempt 1 | the status read becomes the retry's verification hook, re-read before each re-send |
| `DescribeTimeToLive` | none - read-only | - |

### Mechanism

`dynamoAdmin.ts` exports one bounded retry helper taking an optional
"did attempt N already land?" verification hook. `db-update-gsis.ts`
imports it and supplies its existing index-status check as that hook, so
the two paths cannot drift. `ensureGsis`'s own behaviour is otherwise
unchanged - its CLI is already hard-gated to a localhost endpoint
(`db-update-gsis.ts:262-270`), so the new gate is additive there, never a
loosening.

Bounds: at most 4 attempts, linear backoff (`attempt * 250ms`), matching
the existing helper. A retry loop that can outlive a test budget trades one
false red for another.

**`waitUntilTableExists` is excluded**, on the reasoning that the SDK
waiter carries its own retry and polling policy and its failure mode is a
timeout rather than an escaping `InternalFailure`. That reasoning is
UNVERIFIED - reviewer B flagged it and could not check it either. It is a
BUILD-TIME TASK to read the installed waiter and record the answer; if the
waiter does let `InternalFailure` escape, the exclusion is revisited.

### The local-endpoint gate, specified concretely

The retry ACTIVATES only when the client's resolved endpoint is a
localhost DynamoDB Local endpoint. Everything else gets today's behaviour
exactly - no retry, no possibility of masking a real AWS fault.

**`client.config.endpoint` is an async `Provider<Endpoint>`, not a URL
string** - the v1 spec assumed otherwise and built a false "three lines of
duplication" argument on it. It resolves to an object carrying
protocol / hostname / port. The gate therefore awaits the provider,
reads `hostname`, and treats `localhost`, `127.0.0.1` and `::1` as local.

**Fail closed.** No endpoint provider, a provider that throws, or a
non-local hostname all mean NOT LOCAL and therefore no retry.

The predicate is defined inside `dynamoAdmin.ts` rather than imported from
`app/scripts/db-create.ts`, because `lib` importing from `scripts` inverts
the dependency direction the repo already keeps. It is not a copy of
`isLocalEndpoint` - that one takes a URL string and this one takes a
resolved endpoint object - so this is a sibling predicate, not duplication.

### Acceptance - this item MUST be able to fail

The v1 spec had no way to observe a retry: the only proposed evidence was
a before/after `npm test`, which cannot see one. **The whole item could
have shipped inert with five green gates.** So:

A new `app/test/dynamoAdminRetry.test.ts` drives a STUB client whose
`send` is programmable, with no container involved:

1. a local-endpoint client whose `CreateTable` throws `InternalFailure`
   twice then succeeds -> `ensureTable` returns, and `send` was called 3
   times;
2. the same, but attempt 1 is accepted-but-unanswered (throw
   `InternalFailure`, then `ResourceInUseException`) -> returns `'exists'`
   AND waits for the table before returning;
3. `DeleteTable` throwing `InternalFailure` then `ResourceInUseException`
   -> resolves, does not throw;
4. `UpdateTimeToLive` retried -> the status is RE-READ between attempts;
5. **a NON-local endpoint client throwing `InternalFailure` once -> throws
   immediately, `send` called exactly once.** This is the test that stops
   the gate shipping inert;
6. no endpoint provider at all -> same as (5).

## Item 1B - groupCrossCheck: measure, do not pre-rewrite

The anchor lists suite A's remaining remedy as "make the ordering/window
assertions robust to latency", on evidence that it "FAILS ALONE,
sometimes". **That evidence predates two fixes now in that file**: the
injected `cleanupMs` - which is the ROOT CAUSE the issue itself identifies
for the solo failures, a TTL time bomb rather than latency - and the
`afterEach` partition drain. The file also mints a unique rail per test and
filters every assertion to it.

- **Measure both arms.** 10 consecutive SOLO runs of
  `app/test/groupCrossCheck.test.ts`, AND its behaviour across the three
  contended full runs of item 1D. The solo arm alone cannot settle a
  latency question, because it removes the latency by construction.
- **If neither arm fails: that is the deliverable.** Record the runs and
  strike the "latency-robust assertions" remedy as superseded by the TTL
  fix, naming the evidence.
- **If either fails: diagnose to root cause before editing.** No widening
  of windows or timeouts as a first move - the anchor's history is a record
  of that lever being pulled and the symptom returning under a new name.

## Item 1C - what `AWS_ACCESS_KEY_ID=hccleanrun001` actually does now

**This item inverted under review, and the inversion is the finding.**

`AGENTS.md` opens its `npm test` guidance with "re-run under a clean access
key before blaming anything", citing 607s / 9 failures versus 65s / 0. The
mental model is "a fresh key means an empty database, free of residue".

Under per-file keys that model is wrong.
`accessKeyForTestFile` (`app/test/setup/dynamoAccessKey.ts:118-120`)
returns the explicit key for EVERY test file, so exporting
`AWS_ACCESS_KEY_ID` collapses all ~53 integration suites back onto ONE
database and one `queueLock`. That is not a clean-database arm - **it is
precisely the OLD arm of the experiment that justified per-file keys**, the
one that measured 446-509s against 75-95s.

So the recipe now recommends the worse configuration while describing it as
the clean one. Its 65s figure came from a regime where a fresh key really
did mean a fresh single database; today the default path is already
per-file, and the explicit key undoes it.

**This is established by reading the code, not by measurement.** The
measurement's job is only to quantify the current gap, so the rewritten
paragraph carries a number from this container rather than from the
`-inMemory` era.

### The measurement

Two arms, app workspace only (matching AGENTS.md's own `cd app && npx
vitest run`, not the five-workspace root script), **3 runs each**:

| arm | bash | PowerShell |
|---|---|---|
| default, per-file keys | `cd app && npx vitest run` | `cd app; npx vitest run` |
| explicit shared key | `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` | `cd app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run` |

Record per run: wall clock, exit code, failing FILE names, and the
contention snapshot defined in 1D.

Three confounds are recorded rather than assumed away:

- **`sweepLedgerResidue` runs on the way IN** (`globalSetup.ts`, sweep in
  `globalTeardown.ts:20-25`). It is the prime alternative explanation for
  the residue effect having already vanished, and must be named in the
  rewritten paragraph if the numbers no longer reproduce.
- **The sweep's MODE depends on concurrency** (`globalTeardown.ts:33-45`):
  under a live neighbour it spares young tables instead of dropping them.
  Record which mode each run took - baseline and post-fix runs are
  otherwise not held constant.
- **Arm 2 changes the test SET**, not only timings:
  `dynamoAccessKeyGuard.test.ts:308` skips its per-file assertions when an
  explicit key is present. The skip-count delta is expected; it is not a
  failure.

## Item 1D - the evidence protocol

Three other missions share this machine and one DynamoDB Local container
tonight. That load is the condition the anchor exists for, so it is the
acceptance environment.

**"Contended" is operationally defined** and captured immediately before
and after every run in the record: the count of other live vitest runs
(`app/test/helpers/testRunRegistry.ts` already tracks this), the
worktree-filtered node/playwright process count, and the DynamoDB Local
container's CPU and RSS. A run whose snapshot shows no neighbours is
labelled QUIET and cannot stand as contended evidence.

1. **Install first.** `npm install` in this worktree BEFORE the baseline,
   plus one discarded warm-up run - otherwise the baseline pays a cold
   install and a cold transform cache and the wall-clock comparison is
   meaningless.
2. **BASELINE at the base commit, contended.** 3 full `npm test` runs from
   this worktree before any edit. Exit code, wall clock, failing FILES.
3. **The same 3 runs after the fix**, under a recorded contention
   snapshot. Both sets appear in the handback.
4. **The 1C comparison** as its own pair of 3-run arms.

Single observations prove nothing about an intermittent fault - the
anchor's own record has a green OLD arm 2 runs in 3. **Wall clock and
failing FILE names are the durable signals; pass/fail on one run is not.**

Hard constraints:

- **The shared container may NOT be restarted** while the other three
  missions are live. If the database-count axis is the blocker, measure it,
  say so, and stop there.
- **Never run a full e2e suite and an interactive session at once from
  this worktree.** Confirm no orphaned listener on the lane's ports before
  each e2e run - `reuseExistingServer` adopts an orphaned stack on a commit
  match alone.
- **Do NOT set `E2E_CHILD_LOG_DIR`.** These are timing-sensitive symptoms;
  piping a child's stdout makes `isTTY` false and block-buffers the stream,
  changing the timings being measured. A trace is the artifact.
- **Gates run BARE, under the DEFAULT per-file keys.** The clean-key run is
  EVIDENCE, never a gate. `_CLUSTERS.md:235-237` suggests running M7's
  gates under the clean key; that advice is superseded by item 1C's
  finding and the supersession is recorded there.
- **Adjudicating a contended gate-2 red**: re-run the failing FILES alone,
  run the full suite at the merge base, compare failing FILES rather than
  failing cases, and report both runs.

## Item 2 - logCallSiteGuard's self-defeating budget

**Problem.** `app/test/logCallSiteGuard.test.ts` does its work in one
`beforeAll` (`:140`) with a 180s budget (`:143`). Measured 2026-08-26 the
file ran 196.2s ALONE on a clean key. Under any load it fails as
`Hook timed out in 180000ms` with zero assertion failures. It touches no
database, so it is a different mechanism from item 1 that presents
identically.

### Correction: where the cost is NOT

The v1 spec named `ts.getPreEmitDiagnostics` as the likely dominant cost
and proposed cutting it. **It is not in the hook.** It runs inside the
first `it` (`:152`), not the `beforeAll` (`:140-143`). Cutting it would
remove exactly zero hook cost and would not have moved the failing
timeout at all.

Two independent reviewers caught this, and the arithmetic settles it
without a measurement: the three `it`s run under `testTimeout: 60_000`
(`vitest.config.ts:60`), so against the reported 179.1s aggregate the
**hook is at least ~2/3 of the cost**. The hook contains exactly
`buildProgram(true)` and `scanProgram`.

### Step 1: split the hook

Instrument the two phases INSIDE the hook - `buildProgram` versus
`scanProgram` - which is the split that is genuinely unknown. Also time
the health `it` separately, because of step 4. The instrumentation is a
MEASUREMENT: it is recorded in the mission records and removed before
handback.

### Step 2: cut the measured dominant phase

The remedy follows the measurement rather than preceding it.

- If **`buildProgram`** dominates: the program is built over the real
  `app/tsconfig.json` with a full `createCompilerHost`. Options are a
  cheaper host (no type-checking services the scan does not use) or
  narrowing the program's roots - constrained by the guard's own stated
  requirement that it scan the REAL program, not a toy one.
- If **`scanProgram`** dominates: the cost is in `checker` calls -
  `isErrorTyped` calls `getTypeAtLocation` on every candidate node.
  `isCatchDeclared` is purely syntactic and carries most of the guard's
  value; ordering the cheap syntactic test first and short-circuiting is
  the obvious cut, and it changes no result because the two are OR'd.

### Step 3: the health probe may NOT be hollowed out

The v1 spec argued the existing `sourceCount > 50` assertion already
catches "the program resolved nothing". **It does not.**
`app/tsconfig.json` is `"include": ["src"]`, so every file under `app/src`
is a program ROOT and is counted regardless of whether its imports
resolve. TS2307 covers a shape `sourceCount` structurally cannot see.

So the TS2307 probe is load-bearing. If it is replaced with something
cheaper, **the replacement is validated by deliberately breaking module
resolution and proving the probe still fails** - not by reasoning about
it. If no cheaper probe survives that test, it stays as it is.

### Step 4: budget BOTH clocks

- The hook budget becomes at least **4x** the new measured cost, with a
  **ceiling of 600s** - past that, a 10-minute hook in a required gate is
  its own problem and the item reports rather than ships it.
- **The health `it` has its own exposure**: it runs under the shared
  `testTimeout: 60_000` and carries `getPreEmitDiagnostics`, a whole-program
  type-check. If step 1 measures it anywhere near 60s it gets an explicit
  per-test budget on the same 4x rule. Missing this would fix the hook and
  leave the next false red one line below it.
- Every shipped budget comment cites **only what this mission measured
  directly**, with its date. The 196.2s / 179.1s figures are inherited and
  aggregate hook plus tests; they are context, not the justification.

**Fallback.** If the cost cannot be brought materially below ~196s, raise
the budget to >= 4x measured (within the ceiling) and record why the cut
failed. A justified large budget beats an unjustified small one.

**Out of scope:** giving the guard its own vitest project or lane.

## Item 3 - staticSmoke must not depend on a gitignored artifact

**Problem, in the human's framing:** a branch is green because the
dashboard happened to be built in that worktree, and the same code reds on
main where the build is stale. The colour tracks an untracked artifact, so
neither green nor red carries information.

Today the guard checks existence only (`:19`, `:28`). Absent dist -> clean
skip. STALE dist -> the suite runs and fails, naming the manifest path, so
the natural first move is to read PWA code that is fine.

`npm run smoke` cannot fix this: it builds the APP workspace
(`package.json:68`), not the dashboard, and it runs AFTER `npm test`.

### (a) App-serving behaviour -> a fixture the test writes. NEVER skips.

The SPA fallback, reserved namespaces, hardening headers, both CSP
media-bucket shapes, the runtime `/app-identity/*` endpoints and the
path-traversal probes are APP behaviour. They need SOME `index.html`.
`devGating.test.ts:249-251` and `unitMediaServe.test.ts:171-173` already
use a `mkdtemp` fixture for exactly this.

This is a coverage GAIN: today every one of those cases silently skips on
any checkout where nobody built the dashboard - including this worktree.

**Fixture contents are specified, not left to the builder.** The fixture
`index.html` must carry `HousingChoice` and `<div id="root">`, because
existing assertions at `:41`, `:108`, `:165` and `:85` depend on them.

**The traversal decoy is placed against the actual probe strings.** The
probes at `:148-154` escape TWO levels (`/%2e%2e%2f%2e%2e%2fpackage.json`)
and THREE (`/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json`) above the
served root. The v1 spec planted one decoy one level up, which would have
left every "no leak" assertion vacuous - the exact tautology it claimed to
prevent. So the fixture is nested `<tmp>/x/y/dist/` with a decoy
`package.json` containing `"version"` and `"private"` at BOTH `<tmp>/x/y/`
and `<tmp>/x/`, so each probe depth has something real to find.

### (b) The PWA identity contract -> tracked source. NEVER skips.

`dashboard/index.html` is version-controlled, identical in every worktree,
and is the file `2210f671` actually changed. The contract asserted there is
the exact set:

- contains `href="/app-identity/manifest.webmanifest"`
- contains `rel="icon" href="/app-identity/icon-192.png"`
- contains `rel="apple-touch-icon" href="/app-identity/icon-192.png"`
- does NOT contain `href="/manifest.webmanifest"`
- does NOT contain `href="/icons/icon-192.png"`

### (c) The real build -> a diagnostic that can PASS or SKIP, never FAIL.

When `dashboard/dist/index.html` exists, compare the five identity
conditions above against it. Vite copies those link tags through
untransformed. Only those five are compared - a Vite build also injects
hashed asset tags and, under e2e, an `x-app-commit` meta, none of which are
part of the contract.

**The mtime tie-breaker from v1 is deleted.** Git does not preserve
mtimes, so a fresh clone, a new worktree, or the mission's own mandated
`main` sync would rewrite `dashboard/index.html`'s mtime and silently flip
a genuine failure into a skip. A predicate that the required workflow
itself defeats is worse than no predicate.

Without it the test cannot distinguish a stale build from a Vite
regression - so it says so instead of guessing:

| dist state | outcome |
|---|---|
| absent | SKIP - "no built dashboard; run `npm run build -w dashboard`" |
| present, all five conditions hold | PASS |
| present, any condition fails | SKIP - "your `dashboard/dist` disagrees with `dashboard/index.html`: it is either stale or the dashboard build dropped the identity tags. Run `npm run build -w dashboard` and re-run." |

**Nothing in the gate chain builds `dashboard/dist`, and this worktree has
none**, so (c)'s live branches would otherwise never execute. The mission
therefore runs `npm run build -w dashboard` ONCE, by hand, and records
both branches observed: the PASS on a current build, and the SKIP-with-
message after mutating a copy of the built `index.html`.

**Why this kills the class.** No outcome depends on an untracked artifact.
Absent and disagreeing both skip; the only red left in this file comes from
(a) or (b), which read tracked files identical on the branch and on main.

## What this mission does NOT do

- No changes to app runtime code other than `app/src/lib/dynamoAdmin.ts`.
- No container restart, no `db:stop` / `db:start`, no table sweeps outside
  this worktree's own lane.
- No e2e harness changes; no new vitest project or lane.
- No timeout or budget changes in `seedLive`, `seedProfile.integration` or
  `unreadIndexRepo.integration` beyond routing the raw `CreateTable` at
  `unreadIndexRepo.integration.test.ts:728` through the retry helper. C and
  D are fixed per the record (per-test budgets); they are WATCH-ONLY, and
  any further edit is a separate decision.
- No merge, no deploy, no infrastructure, no cleanup.

## Deliverables

1. The three code changes, each with the measurement that justifies it.
2. `docs/issues/` closures: Resolution stamps on all three files, written
   against measured evidence. **The anchor closes only if its measurements
   support it**; if the class survives, it stays open with the new numbers
   and the mission says so.
3. `npm run issues` re-run (regenerates the gitignored `INDEX.md`).
4. **`AGENTS.md`'s "FIRST, if `npm test` is red on DynamoDB Local suites"
   paragraph rewritten to what item 1C establishes** - that an explicit
   `AWS_ACCESS_KEY_ID` collapses per-file isolation rather than providing a
   clean database - and to the numbers this container actually produces.
   Only what is proven. Guessing here would re-create the exact problem
   this mission closes.
5. Mission records committed to
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
`.ts`/`.tsx` only, so a green result on a `.mjs` path checked nothing.

## Risks and watch items

- **Retrying can mask.** The local-endpoint gate is the only thing keeping
  the retry out of any path that could reach real AWS, and test (5) is the
  only thing proving the gate is not inert. Attack both.
- **Cutting the health probe can hollow the guard.** Any replacement must
  be proven by deliberately breaking module resolution.
- **A fixture can make an assertion tautological.** This already happened
  once in v1 with the traversal decoy. Anything a fixture-based assertion
  would only be asserting back at itself belongs in (b).
- **Measurement under shared load is noisy**, and the mission's own edits
  change the machine's load. Report run counts and contention snapshots,
  never a single observation.
- **`groupCrossCheck` has been misdiagnosed three times.** Do not add a
  fourth explanation without evidence that survives isolation AND load.
- **This mission's changes touch the harness every other mission is being
  gated by.** A defect here fails other people's branches, not just this
  one. That is the argument for test (5) and for the enumerated
  covered/not-covered table rather than a blanket retry.
