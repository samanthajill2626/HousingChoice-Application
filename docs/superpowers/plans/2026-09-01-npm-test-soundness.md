# npm test soundness (M7) - implementation plan

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`
  (v5, TERMINAL after four adversarial rounds)
- Branch: `feat/npm-test-soundness`, worktree `W:\tmp\npm-test-soundness`,
  cut from `main` @ `5ce9912f`
- Records: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/`

**Read the spec first, in full.** This plan does not restate its reasoning.
Where the two disagree, the spec wins and the disagreement is a finding.

## Rules that apply to every slice

- **ASCII only** in new or touched lines of specs, plans, prompts, issues,
  comments, log strings and test names. Captured tool output is preserved
  verbatim as the exception, and noted as such.
- **Never rewrite source with PowerShell pipelines** (`Get-Content |
  -replace | Set-Content`). Use an edit tool.
- **Bare `git status` before every commit**; check `.git/MERGE_HEAD`; stage
  EXPLICIT PATHS only, never `git add -A`.
- Every commit carries `Co-Authored-By: Claude Opus 5 (1M context)
  <noreply@anthropic.com>`.
- **Gate commands run BARE** - never piped, never `;`-chained. A pipe hides
  the exit code.
- **Do NOT restart the DynamoDB Local container.** Other missions share it.
- **Do NOT set `E2E_CHILD_LOG_DIR`.** It changes the timings being measured.
- **Never run a full e2e suite and an interactive session at once from this
  worktree**, and confirm no orphaned listener on the lane's ports first.
- Mission records commit AS PRODUCED to the records path, not in a batch at
  the end. Findings cite code by `file:line`; byte-exact quotation goes to
  `.superpowers/sdd/` instead.

## Slice order, and why S0 cannot move

S0 is time-critical: the baseline is only worth taking while the
neighbouring missions are still running. Everything else can be done on a
quiet machine. **Do S0 first, before reading further into the code.**

| slice | what | depends on |
|---|---|---|
| S0 | install, warm-up, contended baseline | nothing - do it NOW |
| S1 | `dynamoAdmin` retry + acceptance suite | S0 |
| S2 | `logCallSiteGuard` measure and cut | S0 |
| S3 | `staticSmoke` split | S0 |
| S4 | `groupCrossCheck` measurement | S0 |
| S5 | the `AGENTS.md` clean-key measurement | S0 |
| S6 | issue registry, AGENTS.md, _CLUSTERS.md | S1-S5 |
| S7 | main sync, five gates, handback | S1-S6 |

S1, S2 and S3 are independent of each other and touch disjoint files.

---

## S0 - install, warm up, and take the contended baseline

**This slice produces evidence, not code. It cannot be redone later** - the
load it measures is tonight's.

1. `npm install` in the worktree. The baseline must not pay a cold install.
2. One full `npm test` run, DISCARDED. It warms the transform cache; its
   numbers are not evidence.
3. **Capture a contention snapshot immediately before and after every
   measured run** and record it with the run:
   - other live vitest runs, via `app/test/helpers/testRunRegistry.ts`;
   - node/playwright process count, filtered to other worktrees;
   - the DynamoDB Local container's CPU and RSS (`docker stats --no-stream`).
   A run whose snapshot shows no neighbours is labelled **QUIET**.
4. **3 full `npm test` runs at the base commit**, unedited tree. For each
   record: exit code, wall clock, and the NAME of every failing FILE (not
   failing cases). Also record which mode `sweepLedgerResidue` took
   (`globalTeardown.ts:33-45` - it spares young tables when a neighbour is
   live).
5. Note per-run labels. **Do not average across runs whose label changed.**

**Write to** `<records>/measurements/s0-baseline.md`. Commit it before
starting S1 - if this session dies, this is the artifact that cannot be
recreated.

**Observable pass/fail:** the file exists, carries 3 labelled runs with
failing-FILE lists, and the tree is still unedited (`git status` clean).

---

## S1 - retry the container's `InternalFailure` in `dynamoAdmin.ts`

Files: `app/src/lib/dynamoAdmin.ts`, `app/scripts/db-update-gsis.ts`, new
`app/test/dynamoAdminRetry.test.ts`.

### S1.0 - re-run the enumeration yourself

```
grep -rn "new \(CreateTable\|DeleteTable\|UpdateTable\|UpdateTimeToLive\|DescribeTimeToLive\|DescribeTable\|ListTables\)Command\|waitUntilTable\(Exists\|NotExists\)(" --include=*.ts --include=*.mjs app e2e scripts | grep -v node_modules
```

Work from ITS output. Confirm the spec's disposition rule covers every
line; anything it does not is a finding for the handback, not a silent
decision.

### S1.1 - TDD: write the acceptance suite FIRST, and watch it fail

`app/test/dynamoAdminRetry.test.ts`. No container, no network - a STUB
client only.

**Stub contract (three revisions found ways to get this wrong):**

- throws REAL exception INSTANCES from `@aws-sdk/client-dynamodb`
  (`ResourceInUseException`, `ResourceNotFoundException`), because
  `dynamoAdmin` discriminates by `instanceof` (`:91`, `:148`) while the
  retry discriminates by `err.name`. A plain object passes for the wrong
  reason;
- answers `DescribeTableCommand`, because the `ResourceInUseException` path
  now polls;
- exposes a settable, resolvable `config.endpoint` provider;
- counts calls per command type.

Cases, all of which must be RED before any edit to `dynamoAdmin.ts`:

| # | setup | asserts |
|---|---|---|
| 1 | local, `CreateTable` throws `InternalFailure` x2 then succeeds | `ensureTable` resolves; `CreateTable` sent 3 times |
| 2 | local, `CreateTable` throws `InternalFailure` then `ResourceInUseException` | returns `'exists'` AND polled `DescribeTable` until ACTIVE before returning |
| 3 | local, `DeleteTable` throws `InternalFailure` then `ResourceInUseException` | `deleteTableIfExists` resolves, does not throw |
| 4 | local, `UpdateTimeToLive` throws `InternalFailure` then succeeds | status RE-READ between attempts (hook called exactly once for that attempt) |
| 5 | local, `UpdateTimeToLive` throws `InternalFailure`, and the re-read THROWS | the ORIGINAL error is rethrown; NO re-send |
| 6 | **non-local endpoint**, `InternalFailure` once | throws immediately; `send` called exactly ONCE |
| 7 | no endpoint provider at all | same as 6 |
| 8 | endpoints `127.0.0.1`, `::1`, `[::1]`, `localhost` | all treated as local (predicate-level) |
| 9 | local, `ensureGsis` with `UpdateTable` throwing `InternalFailure` then succeeding | retries - the existing mitigation survives the refactor |
| 10 | local, `ensureGsis` where `DescribeTable` ALSO throws | still reaches a re-send - `ensureGsis` keeps FAIL-OPEN |
| 11 | local, `CreateTable` `InternalFailure` then `ResourceInUseException`, `DescribeTable` never ACTIVE | throws at the 10s ceiling, carrying the observed status |

**Cases 6 and 7 are the ones that stop this slice shipping inert. Case 8 is
their positive half** - a gate that refuses everything is exactly as
useless as one that refuses nothing.

### S1.2 - the shared helper

In `dynamoAdmin.ts`:

```
attempts: 4 (max), linear backoff attempt * 250ms
```

- **Endpoint gate, resolved LAZILY** - only on the first retryable error,
  so the happy path pays no `await`. `client.config.endpoint` is an async
  `Provider<Endpoint>` returning an object with `hostname`. Local means
  `localhost`, `127.0.0.1`, `::1` or `[::1]`. **Fail closed**: no provider,
  a throwing provider, or any other hostname means no retry.
- Retryable names: `InternalFailure`, `InternalServerError`.
- **Verification hook, ONE contract for every caller:**

  | hook outcome | helper does |
  |---|---|
  | returns `true` | return success, no re-send |
  | returns `false` | re-send, subject to the attempt bound |
  | throws | rethrow the ORIGINAL error, no re-send |
  | absent | re-send, subject to the attempt bound |

  Called **at most once per failed attempt** and never itself retried.
- The predicate is local to `dynamoAdmin.ts`. It is NOT a copy of
  `isLocalEndpoint` - that takes a URL string, this takes a resolved
  endpoint object. `lib` must not import from `scripts`.

### S1.3 - apply it, one call site at a time

- **`CreateTable`** - retried. On `ResourceInUseException` the catch now
  polls until ACTIVE before returning `'exists'`. **Not
  `waitUntilTableExists`**: its second poll is a flat 20s and it throws at
  60s. Use `DescribeTable`, **100ms interval, 10s ceiling**, and on
  exhaustion rethrow the original `ResourceInUseException` with the
  observed status appended. The poll's own reads are NOT retried - a failed
  read counts as "not ACTIVE yet". The success path keeps its existing
  `waitUntilTableExists` unchanged.
- **`DeleteTable`** - retried; the catch additionally tolerates
  `ResourceInUseException` (DELETING means the delete landed).
- **`DescribeTimeToLive`** - the PRE-SEND guard is retried like any other
  send. The hook invocation that re-reads status between attempts is not.
  Two call sites, not one rule contradicting itself.
- **`UpdateTimeToLive`** - retried, with the status re-read as its
  verification hook. **The TTL hook does NOT swallow** - a throwing re-read
  must reach the helper's fail-closed branch, because re-sending an enable
  for an already-enabled TTL can draw a `ValidationException` and turn a
  transient into a hard failure.

### S1.4 - refactor `db-update-gsis.ts` onto the helper

Replace `sendWithInternalFailureRetry`'s body with a call to the shared
helper, passing:

```
verify: async () => {
  const s = await indexStatus(client, physicalName, indexName);
  return s === 'CREATING' || s === 'ACTIVE';
}
```

`indexStatus` keeps its own `catch` returning `undefined`, so `verify`
returns `false` and the re-send happens - **`ensureGsis`'s fail-open
behaviour is unchanged**, and it is unchanged because the tolerance lives
in the caller's hook, which is where a caller's tolerance belongs. Add one
comment line saying so, so the next reader does not read the swallow as an
accident.

**Note what DOES change:** `ensureGsis` (`:200-242`) is ungated today - the
localhost guard is on the CLI at `:261-270`. Moving to the shared helper
puts it behind the endpoint gate for the first time. Intended, and a
tightening; case 9 pins it on a LOCAL endpoint so it cannot pass for the
wrong reason.

**Do NOT touch** `unreadIndexRepo.integration.test.ts:728`. The spec
considered routing it through the helper and dropped it: that site has no
`ResourceInUseException` catch, so a retry would recreate there the exact
defect this slice fixes in `ensureTable`.

### S1.5 - verify

`npx vitest run test/dynamoAdminRetry.test.ts` from `app/` - 11 cases
green. Then `npx vitest run test/unreadIndexRepo.integration.test.ts` -
unchanged.

**Commit.** Report to `<records>/s1-retry.md`.

---

## S2 - logCallSiteGuard: measure, then cut

File: `app/test/logCallSiteGuard.test.ts`.

### S2.1 - instrument and measure

The `beforeAll` (`:140-143`) contains exactly `buildProgram(true)` and
`scanProgram`. **`ts.getPreEmitDiagnostics` is NOT in it** - it runs in the
first `it` at `:152`, under the shared `testTimeout: 60_000`.

Time three things separately, on an otherwise-quiet machine, file alone,
3 runs: `buildProgram`, `scanProgram`, and the health `it`.

Record in `<records>/measurements/s2-guard-cost.md`. The instrumentation is
a measurement - it is REMOVED before handback.

### S2.2 - cut the measured dominant phase

- **If `scanProgram` dominates**: the cut is the EAGER checker call at
  `:97`. `getShorthandAssignmentValueSymbol` runs before `legal` is
  consulted, so the checker is invoked even for a wired key that cannot
  produce a finding. Hoist the `legal` test above it and skip the checker
  call when `legal` is true.

  **Do NOT "fix" the `||` ordering at `:98` or `:106` - they already
  short-circuit.** And in the PROPERTY-ASSIGNMENT branch (`:101-111`), the
  checker call is already inside `!legal &&`, so it needs no change - but
  the recursion into nested object literals at `:109` must still run
  REGARDLESS of `legal`, so do not `continue` early there. Only the
  shorthand branch gets the early skip.
- **If `buildProgram` dominates**: **no remedy is pre-committed.** Measure
  it, report it, and bring the remedy back to the planner as a decision.
  Two remedies were proposed in an earlier draft and neither exists -
  `createCompilerHost` has no type-checking to remove, and
  `include: ["src"]` leaves no roots to narrow.

### S2.3 - the health probe may NOT be hollowed out

`app/tsconfig.json` is `"include": ["src"]`, so every file under `app/src`
is a program ROOT and is counted regardless of whether its imports resolve.
**`sourceCount > 50` therefore does NOT subsume the TS2307 check.**

If you replace the TS2307 probe with something cheaper, validate it by
**deliberately breaking module resolution and proving the replacement still
fails**. If none survives that test, leave the probe alone.

### S2.4 - budget both clocks

- Hook budget >= **4x** the new measured cost, **ceiling 600s**. If 4x
  would exceed the ceiling, stop and report rather than shipping a
  ten-minute hook in a required gate.
- **The health `it` has its own exposure** under `testTimeout: 60_000`. If
  S2.1 measures it anywhere near 60s, give it an explicit per-test budget
  on the same 4x rule. Fixing the hook and leaving the next false red one
  line below it is not a fix.
- Shipped comments cite **only what this mission measured**, with the date.
  The inherited 196.2s / 179.1s figures aggregate hook plus tests - context,
  not justification.

**Fallback:** if the cost will not come materially below ~196s, raise the
budget to >= 4x measured within the ceiling and record why the cut failed.

### S2.5 - verify

File alone, 3 runs, post-cut: record the new solo cost and confirm it is a
small fraction of the new budget. Remove the instrumentation. **Commit.**

---

## S3 - staticSmoke: split by what each assertion proves

File: `app/test/staticSmoke.test.ts`.

### S3.1 - (a) app-serving behaviour on a self-written fixture. NEVER skips.

Move to a `mkdtemp` fixture, as `devGating.test.ts:249-251` and
`unitMediaServe.test.ts:171-173` already do. All of these move here and
lose their `skipIf`: SPA fallback, reserved namespaces, hardening headers,
both CSP media-bucket shapes, the runtime `/app-identity/*` endpoints, and
the path-traversal probes.

**Fixture `index.html` contents, positive AND negative:**

- MUST contain `HousingChoice` and `<div id="root">` (assertions at `:41`,
  `:108`, `:165`, `:85` depend on them);
- MUST NOT contain `"version"`, `"private"` or `root:`. This is
  load-bearing now that no decoy exists: the traversal assertions read
  whatever the SPA fallback returns, which IS this fixture's `index.html`.

**Traversal probes carry over UNCHANGED, and there are NO decoys.** `send`
decodes the path and tests it with `UP_PATH_REGEXP`
(`node_modules/send/index.js:61`, tested `:431`), so no probe reaches the
filesystem at any depth - a decoy is unreadable by construction. What the
probes pin is OUR composition (no encoded `..` yields anything but the SPA
shell or a 4xx), which is why they stay.

**Add the positive control the file lacks:** write a real asset into the
fixture dist, fetch it, and **assert its BODY**. A status check alone
passes vacuously - an `express.static` miss falls through to a 200 SPA
shell, which is exactly what the regression this control exists to catch
would return.

### S3.2 - (b) the PWA identity contract, against tracked source. NEVER skips.

Assert against `dashboard/index.html` - version-controlled, identical in
every worktree, and the file `2210f671` changed. Exactly five conditions:

- contains `href="/app-identity/manifest.webmanifest"`
- contains `rel="icon" href="/app-identity/icon-192.png"`
- contains `rel="apple-touch-icon" href="/app-identity/icon-192.png"`
- does NOT contain `href="/manifest.webmanifest"`
- does NOT contain `href="/icons/icon-192.png"`

### S3.3 - (c) the real build: PASS or SKIP, never FAIL

When `dashboard/dist/index.html` exists, compare those five conditions
against it. **Only those five** - a build also injects hashed asset tags
and, under e2e, an `x-app-commit` meta.

| dist state | outcome |
|---|---|
| absent | SKIP - "no built dashboard; run `npm run build -w dashboard`" |
| present, all five hold | PASS |
| present, any fails | SKIP with the message below |

The SKIP message must not send an operator round a loop: "`dashboard/dist`
disagrees with `dashboard/index.html`. Most likely the dist is stale - run
`npm run build -w dashboard`. If a fresh build still reports this, the
dashboard BUILD is dropping the identity tags, which is a real regression -
see `docs/issues/<the slug filed in S6.2>`." **A literal `<slug>` must not
reach the shipped string.**

**No mtime predicate of any kind.** Git does not preserve mtimes, so the
mandated `main` sync alone would flip a genuine failure into a skip.

### S3.4 - observe both live branches of (c)

Nothing in the gate chain builds `dashboard/dist` and this worktree has
none, so:

1. `npm run build -w dashboard` once, by hand;
2. run the file - record the PASS branch;
3. edit the built `dashboard/dist/index.html` in place to break one
   identity tag, run again - record the SKIP branch and its message;
4. restore it (rebuild). The file is gitignored; nothing is at risk.

`distDir` is a fixed path at `:18`, so in-place mutation is the only seam.

**Commit.** Report to `<records>/s3-static-smoke.md`.

---

## S4 - groupCrossCheck: measure, do not pre-rewrite

**Do not edit `app/test/groupCrossCheck.test.ts` in this slice.**

- 10 consecutive SOLO runs of the file.
- Its behaviour across S0's baseline and S7's post-fix runs (the LOADED
  arm - the solo arm removes by construction the latency the remedy is
  about).

**If neither arm fails:** that IS the deliverable. Record it and, in S6,
strike the anchor's "latency-robust assertions" remedy as superseded by the
`cleanupMs` TTL fix, naming this evidence.

**If either fails:** diagnose to root cause and STOP - report to the
planner before editing. No widening of windows or timeouts as a first move;
that lever has been pulled before and the symptom returned under a new name.

Record in `<records>/measurements/s4-groupcrosscheck.md`.

---

## S5 - what the clean-key recipe actually does now

The finding is established by READING `app/test/setup/dynamoAccessKey.ts:118-120`:
`accessKeyForTestFile` returns the explicit key for EVERY file, so
exporting `AWS_ACCESS_KEY_ID` collapses all ~53 suites onto ONE database.
That is the OLD arm of the experiment that justified per-file keys, not a
clean database.

The measurement only dates the claim to THIS container. **2 runs per arm,
app workspace only:**

| arm | bash | PowerShell |
|---|---|---|
| default | `cd app && npx vitest run` | `cd app; npx vitest run` |
| explicit key | `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` | `cd app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run` |

Record wall clock, exit code, failing FILES, contention snapshot and sweep
mode. Three confounds go in the record, not into the conclusion:

- `sweepLedgerResidue` runs on the way IN (`globalTeardown.ts:20-25`) - the
  prime alternative explanation if the old numbers no longer reproduce;
- the sweep's MODE varies with concurrency (`:33-45`);
- arm 2 changes the test SET - `dynamoAccessKeyGuard.test.ts:308` skips its
  per-file assertions under an explicit key. The skip-count delta is
  expected, not a failure.

Record in `<records>/measurements/s5-clean-key.md`.

---

## S6 - the registry, AGENTS.md, and _CLUSTERS.md

### S6.1 - close what the evidence closes

Resolution stamps on:

- `docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md`
- `docs/issues/static-smoke-fails-on-stale-dashboard-dist.md`
- `docs/issues/npm-test-dynamodb-local-contention.md` - **only if the
  measurements support it.**

**Expected outcome, stated in the spec and repeated here so it is not a
surprise: the anchor most likely stays OPEN.** S1 has no recorded sighting
to cure, and a mixed contended/quiet pair from S7 may NOT close it. If it
stays open, add the new numbers, strike the superseded suite-A remedy per
S4, and say plainly what was and was not established.

### S6.2 - file two NEW issues (copy `docs/issues/_TEMPLATE.md`)

1. **`globalSetup` re-enables TTL on the shared `hc-local-` tables every
   run.** `app/test/globalSetup.ts:90-91` says in its own comment that
   vitest `test.env` does not reach globalSetup, and it sets only the
   credentials - so `DYNAMO_DISABLE_TTL=1` never applies there and
   `createAllTables` -> `ensureTable` -> `enableTtlIfNeeded` turns the
   reaper on for ~23 tables before any test runs. The immunity
   `vitest.config.ts:92-118` describes does not hold for shared-table
   suites, and a future suite pinning a past clock has the same time bomb
   `groupCrossCheck` had.
2. **No gate asserts the BUILT dashboard's PWA identity tags.** Consequence
   of S3.3 being unable to fail. Name the remedy (`npm run build -w
   dashboard` wired into the app workspace's pretest or `globalSetup`) and
   its cost (~15-40s on every `npm test`, on every branch, including the
   many that never touch the dashboard).

Also record, in the anchor or as a note, the PRE-EXISTING observation that
`db-create.ts:64` and `:76` call `waitUntilTableNotExists({maxWaitTime:60})`
after every delete, carrying the same flat-20s second tick on the
`npm test` teardown path. Out of scope to fix; measured only if it shows up
in teardown timing.

### S6.3 - rewrite AGENTS.md's first-diagnostic paragraph

The paragraph beginning "**FIRST, if `npm test` is red on DynamoDB Local
suites:**". Rewrite it to what S5 establishes - that an explicit
`AWS_ACCESS_KEY_ID` collapses per-file isolation rather than providing a
clean database - and to the numbers this container actually produced.
**Only what is proven.** Guessing here re-creates the exact problem this
mission closes.

### S6.4 - supersede the M7 advice in `_CLUSTERS.md`

Its M7 entry says to run the gates under a clean access key. S5 shows that
recommends the worse configuration. Edit the file. Asserting the
supersession in a review record is not a deliverable; changing the file is.

### S6.5 - `npm run issues`

Regenerates the gitignored `docs/issues/INDEX.md`. Never hand-maintain it.

---

## S7 - sync, gates, handback

1. **One `main` sync**, here and nowhere earlier. If `main` has advanced in
   a way that could conflict with active work, ASK before syncing.
2. **The five gates, BARE, from the worktree, on a QUIET TREE** - no child
   may be writing while they run:
   1. `npm run typecheck`
   2. `npm test`
   3. `npm run smoke`
   4. `npm run e2e`
   5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

   Gate 5: no NEW lint errors in TOUCHED files, attributed by BASELINE
   COMPARISON at the merge base - never by line number. If the file list is
   empty, SKIP the gate; a bare `npx eslint` goes repo-wide and fails on
   117 pre-existing errors. The config lints `.ts`/`.tsx` only, so a green
   result on a `.mjs` path checked nothing.
3. **3 post-fix `npm test` runs with contention snapshots**, to pair with
   S0. If the machine has gone QUIET, label the arm QUIET and say so - **do
   not fabricate load**, and remember a mixed pair may not close the anchor.
4. **Adjudicating a red gate 2:** re-run the failing FILES alone, run the
   full suite at the merge base, compare failing FILES rather than failing
   cases, report both runs.
5. **Handback** to `<records>/handback.md`: bare gate exit codes, the live
   Playwright result, both measurement arms with labels, what each issue
   closure claims and on what evidence, main drift, and anything owed.

**Never merge, deploy, mutate infrastructure, or clean up.**

## Watch items

- The endpoint gate is the only thing keeping the retry off a path that
  could reach real AWS. Cases 6/7 prove it refuses; case 8 proves it still
  says yes. Both halves or neither.
- The refactor can disarm the retry that already works. That is case 9,
  and it is the difference between improving the harness and quietly
  regressing it.
- **A test can be tautological three revisions running.** The traversal
  decoy was, and so was its replacement until round 4. When an assertion
  needs scaffolding to be meaningful, check first whether the mechanism
  under test makes the scaffolding unreachable.
- **These changes touch the harness every other mission is gated by.** A
  defect here fails other people's branches, not just this one.
