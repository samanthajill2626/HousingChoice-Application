# npm test soundness (M7) - implementation plan

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`
  (v5, TERMINAL after four adversarial rounds)
- Branch: `feat/npm-test-soundness`, worktree `W:\tmp\npm-test-soundness`
- **Base commit: `5ce9912f`** (`main` at cut time, and the merge base).
  Every later commit on this branch before S1 is DOCS ONLY and cannot move
  a test number, so "at the base commit" and "before any code edit" are the
  same measurement.
- Records: `docs/superpowers/reviews/2026-08-31-npm-test-soundness/`
- Revision: **v4**, after plan review round 1 (two independent reviewers,
  38 findings) and rounds 2-3 (one continued reviewer, 15 and 12
  findings). 65 findings, 65 accepted, 0 rejected. Adjudications:
  `<records>/design-review/plan-adjudications.md`,
  `plan-adjudications-r2.md`, `plan-adjudications-r3.md`.

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
- **Gate commands run BARE** - never piped, never `;`-chained.
- **Do NOT restart the DynamoDB Local container.** Other missions share it.
- **Do NOT set `E2E_CHILD_LOG_DIR`.** It changes the timings being measured.
- **Never run a full e2e suite and an interactive session at once**, and
  confirm no orphaned listener on the lane's ports first.
- **Never mutate machine-global state that other missions read.** In
  particular the test-run registry: LIST it, never prune it.
- Records commit AS PRODUCED. Findings cite code by `file:line`;
  byte-exact quotation goes to `.superpowers/sdd/`.

## Slice order

Round 1 found the original order circular - S4's loaded arm and S6's
closures both consumed S7's runs while S7 depended on S6. **All registry
and closure work now happens AFTER the gates.**

| slice | what | position |
|---|---|---|
| S0 | install, warm-up, contended baseline | FIRST - cannot move |
| S4 | `groupCrossCheck` solo arm | before S1, so its arms cannot straddle a code change |
| S1 | `dynamoAdmin` retry + acceptance suite | after S4 |
| S2 | `logCallSiteGuard` measure and cut | independent of S1/S3 |
| S3 | `staticSmoke` split | independent of S1/S2 |
| S5 | the clean-key measurement | after S1-S3, one named commit |
| S6 | main sync, five gates, post-fix runs | after all code |
| S7 | registry, AGENTS.md, _CLUSTERS.md, new issues | after S6 |
| S8 | handback | last |

**Docs-only commits land after the gated commit.** That is deliberate and
safe - S7 touches `.md` files and a gitignored index, which cannot affect
gates 1-4, and gate 5's file list gains nothing. **The handback names BOTH
SHAs**: the commit the gates ran on, and the final one.

---

## S0 - install, warm up, take the contended baseline

**Evidence, not code, and it cannot be redone later** - the load it
measures is tonight's.

1. `npm install` in the worktree.
2. One full `npm test` run, DISCARDED (warms the transform cache).
3. **Contention snapshot immediately before and after every measured run:**
   - other live vitest runs - **LIST the marker directory, do not prune
     it.** `otherLiveRuns()` in `app/test/helpers/testRunRegistry.ts`
     prunes as a side effect, and its directory (`RUN_REGISTRY_DIR`,
     `testRunRegistry.ts:41`) is machine-global - other missions read it.
     List the marker files, then **check each one's liveness yourself** -
     the filename IS the pid (`testRunRegistry.ts:66`), and dead markers
     are pruned only by `otherLiveRuns` (`:93-122`), which this plan
     forbids calling. A raw file count therefore OVER-counts neighbours,
     which would mislabel a QUIET run as contended - and that label is what
     the anchor's one use restriction turns on;
   - node/playwright process count, filtered to other worktrees;
   - the container's CPU and RSS (`docker stats --no-stream`).
   A run with no neighbours is labelled **QUIET**.
   **Derive the residue-sweep MODES from this snapshot** (other live runs
   > 0 implies spare-young mode). Plural: there are TWO sweeps per run -
   one on the way in from `globalSetup` and one at teardown - and each
   evaluates its mode independently, so a run can take different modes at
   its two ends. Record both. Do not try to read them from log output;
   `globalSetup` prints nothing when a sweep finds nothing.
4. **3 full `npm test` runs at the base commit.** Record exit code, wall
   clock, failing FILE names (not cases), and the label.
5. **Also record the SKIPPED count**, per workspace. S3 un-skips ~9 `it`s
   in `staticSmoke.test.ts`, so the S0/S6 pair does NOT compare the same
   work - see the confound note in S6.
6. **Scope label on every record**: `npm test` is five workspaces; `cd app
   && npx vitest run` is one. Never leave two scopes unlabelled side by
   side.

**Write to** `<records>/measurements/s0-baseline.md` and COMMIT it before
S4 - if this session dies, this is the artifact that cannot be recreated.

**Observable pass/fail:** the file exists with 3 labelled, scoped runs and
their failing-FILE lists, and `git status` shows **no changes under `app/`
or `dashboard/`** (the record commit is expected).

---

## S4 - groupCrossCheck: measure, do not pre-rewrite

**Runs BEFORE S1**, because S1 changes `ensureTable` and
`deleteTableIfExists`, which sit in this file's own setup path
(`groupCrossCheck.test.ts:75`, `:79`) - arms taken either side of that
change would not be comparable.

**Do not edit `app/test/groupCrossCheck.test.ts`.**

- 10 consecutive SOLO runs of the file, at the base commit.
- The LOADED arm comes from S0's baseline and S6's post-fix runs. The solo
  arm alone cannot settle a latency question - it removes the latency by
  construction.

**If neither arm fails:** that IS the deliverable. In S7 the anchor's
"latency-robust assertions" remedy may be struck - but **narrowly**. The
anchor records two specific failing cases (`a filing for a DIFFERENT author
does not clear this author event`, and `a would-be alarm whose classic
filing DID land is reconciled QUIETLY`), while the TTL fix was diagnosed
against a third (`a DUPLICATE redelivery ... is deduped`). **Strike only
what the evidence covers, and NAME the cases it does not.**

**If either arm fails:** diagnose to root cause and STOP - report before
editing. No widening of windows or timeouts as a first move.

Record: `<records>/measurements/s4-groupcrosscheck.md`.

---

## S1 - retry the container's `InternalFailure` in `dynamoAdmin.ts`

Files: `app/src/lib/dynamoAdmin.ts`, `app/scripts/db-update-gsis.ts`, new
`app/test/dynamoAdminRetry.test.ts`.

### S1.0 - re-run the enumeration yourself

```
grep -rn "new \(CreateTable\|DeleteTable\|UpdateTable\|UpdateTimeToLive\|DescribeTimeToLive\|DescribeTable\|ListTables\)Command\|waitUntilTable\(Exists\|NotExists\)(" --include=*.ts --include=*.mjs app e2e scripts | grep -v node_modules
```

Work from ITS output. Anything the spec's disposition rule does not cover
is a finding for the handback, not a silent decision.

### S1.1 - TDD: the acceptance suite FIRST, red before any edit

`app/test/dynamoAdminRetry.test.ts`. No container, no network.

**Stub contract - round 1 found two cases that could not have run:**

- **scripted per-command, per-call sequencing.** Case 16 needs
  `ensureGsis`'s FIRST `DescribeTable` (inside `liveIndexNames`,
  `db-update-gsis.ts:188-191`) to SUCCEED and only the VERIFICATION read to
  throw. A stub that throws on all `DescribeTable`s makes `liveIndexNames`
  throw before the retry is ever reached, and the case proves nothing;
- **counters must distinguish SENDS from HOOK CALLS.** Case 10 asserts
  "hook called 3 times across 4 attempts", which per-command send counters
  cannot express - the hook and the send may issue the same command;
- **the stub must also satisfy what `ensureGsis` does AFTER the send.**
  `db-update-gsis.ts:234` calls `waitUntilTableExists` and `:235`
  `waitUntilIndexActive`, whose default ceiling is **900s** (`:158`) and
  which `ensureGsis` calls with no override. A two-entry `[ok, throw]`
  script leaves both spinning past the 60s test timeout. Every
  `DescribeTable` the stub answers after the send must report the table
  ACTIVE and the index ACTIVE;
- throws REAL exception INSTANCES from `@aws-sdk/client-dynamodb`
  (`ResourceInUseException`, `ResourceNotFoundException`) - `dynamoAdmin`
  discriminates by `instanceof` (`:91`, `:148`), the retry by `err.name`;
- a settable, resolvable `config.endpoint` provider;
- per-command call counters.

| # | setup | asserts |
|---|---|---|
| 1 | local, `CreateTable` `InternalFailure` x2 then ok | `ensureTable` resolves; `CreateTable` sent 3x |
| 2 | local, `CreateTable` `InternalFailure` then `ResourceInUseException` | returns `'exists'` AND polled `DescribeTable` until ACTIVE |
| 3 | local, `CreateTable` throws `ResourceInUseException` on the FIRST attempt, no retryable error | returns `'exists'` with **ZERO `DescribeTable` calls** - the hot path is unchanged |
| 4 | local, `DeleteTable` `InternalFailure` then `ResourceInUseException` | resolves, does not throw |
| 5 | local, `UpdateTimeToLive` `InternalFailure` then ok | status RE-READ between attempts; hook called once for that attempt |
| 6 | local, `UpdateTimeToLive` `InternalFailure`, re-read reports **ENABLED** | helper returns WITHOUT re-sending. *Without this, a hook that always returns `false` passes every other case.* The stub's FIRST `DescribeTimeToLive` (the guard at `:131`) must report DISABLED, or `enableTtlIfNeeded` returns early and the case passes with ZERO `UpdateTimeToLive` sends - green, and proving nothing |
| 7 | local, `UpdateTimeToLive` `InternalFailure`, re-read THROWS | ORIGINAL error rethrown; NO re-send |
| 8 | local, **`CreateTable`** throws **`InternalServerError`** (the `waiting for a lock` signature) then ok | retried identically to `InternalFailure` |
| 9 | local, `DescribeTimeToLive` (the PRE-SEND read) `InternalFailure` then ok | retried |
| 10 | local, **`UpdateTimeToLive`** always `InternalFailure` | exactly **4** sends, then throws; **hook called 3 times, NOT on the final attempt** (the bound is checked first, matching `db-update-gsis.ts:117`). Must be a hook-bearing send, or the assertion is vacuous |
| 11 | **non-local** endpoint, `InternalFailure` once | throws immediately; `send` called ONCE |
| 12 | no endpoint provider | same as 11 |
| 13 | **REAL `DynamoDBClient`** with `{endpoint:'http://localhost:8000'}`, and a second region-only | the predicate says local / not-local. *Proves the `Provider<Endpoint>` assumption against the actual SDK, not against our own stub* |
| 14 | `127.0.0.1`, `::1`, `[::1]`, `localhost` | all local |
| 15 | local, `ensureGsis`, `UpdateTable` `InternalFailure` then ok | retries - the existing mitigation survives |
| 16 | local, `ensureGsis`, first `DescribeTable` ok, verification read throws | still re-sends - `ensureGsis` keeps FAIL-OPEN |
| 17 | the exported poll directly, injected interval/ceiling, never ACTIVE | throws at the ceiling carrying the observed status |

**11 and 12 stop the gate shipping inert; 13 and 14 are their positive
half; 3 protects the hot path; 6 is what makes the hook contract real.**

### S1.2 - the shared helper

- **4 attempts max, linear `attempt * 250ms`. The backoff is INJECTABLE**
  (like the poll's interval), or the acceptance suite spends ~4-5s of real
  `setTimeout` in a file specified as "no container, no network".
- **The endpoint predicate is EXPORTED**, so case 13 can reach it with a
  real client. An unexported predicate is unreachable under "no container,
  no network".
- **Endpoint gate, resolved LAZILY** - only on the first retryable error.
  `client.config.endpoint` is an async `Provider<Endpoint>` returning an
  object with `hostname`. Local means `localhost`, `127.0.0.1`, `::1`,
  `[::1]`. **Fail closed** on no provider, a throwing provider, or any
  other hostname.
- Retryable names: `InternalFailure`, `InternalServerError`.
- **TWO functions, so the constraint is enforced by the TYPE rather than
  by a comment.** A single function returning `TOut` cannot honour the
  hook-returned-true branch, which has no output; typing it
  `TOut | undefined` breaks `dynamoAdmin.ts:128-130`'s destructure under
  `strict`, and the cast that silences that makes the constraint
  unenforceable.

  | function | returns | hook |
  |---|---|---|
  | `sendWithRetry<TOut>` | `TOut` | NOT accepted |
  | `sendWithRetryVerified` | `void` | required |

- **Which send uses which - tabulated, because getting it wrong is
  silent.** A hook on `CreateTable` would make the helper return where
  `ensureTable` expects to fall into its catch, yielding `'created'` where
  today it returns `'exists'`, and it would still pass cases 2 and 3.

  | send | function | hook |
  |---|---|---|
  | `CreateTable` | `sendWithRetry` | none |
  | `DeleteTable` | `sendWithRetry` | none |
  | `DescribeTimeToLive` (pre-send read) | `sendWithRetry` | none - output consumed |
  | `UpdateTimeToLive` | `sendWithRetryVerified` | status re-read |
  | `UpdateTable` (`ensureGsis`) | `sendWithRetryVerified` | `indexStatus` |
- **Verification hook, ONE contract:**

  | hook outcome | helper does |
  |---|---|
  | returns `true` (the mutation landed) | return success, no re-send |
  | returns `false` | re-send, subject to the bound |
  | throws | rethrow the ORIGINAL error, no re-send |
  | absent | re-send, subject to the bound |

  Called **at most once per failed attempt**, never itself retried, and
  **not called at all on the final attempt** - the bound is checked first.
- The predicate is DEFINED in `dynamoAdmin.ts` and exported (see above);
  `lib` must not import from `scripts`. It is not a copy of
  `isLocalEndpoint` (URL string vs resolved object).

### S1.3 - apply it

- **`CreateTable`** - retried. **The ACTIVE poll runs ONLY when the
  `ResourceInUseException` followed a RETRIED attempt.** A plain
  pre-existing table takes today's path exactly: return `'exists'`, no
  `DescribeTable`, no new failure mode. This is not a detail - `ensureTable`
  is reached from ~75 call sites and `globalSetup` runs ~23 tables through
  it on every `npm test`; an unconditional poll would tax the commonest
  call and could throw where it used to return instantly.

  **The seam, because there is no obvious one and the obvious wrong answer
  passes every case.** The helper THROWS on this path, so no return value
  can carry "we retried". **Do NOT use a module-level flag**: `ensureTable`
  is called CONCURRENTLY (e.g. `todayUnmatchedNonRegression.test.ts:107`),
  so a shared flag set by one call would make another call poll - and all
  17 cases would still pass, because they are sequential.

  Use a PER-CALL local, passed as an `onRetry` callback:

  ```
  let retried = false;
  try {
    await sendWithRetry(client, () => new CreateTableCommand(...),
                        { onRetry: () => { retried = true; } });
    await waitUntilTableExists(...);          // unchanged
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
    result = 'exists';
    if (retried) await pollUntilActive(client, physicalName);
  }
  ```

  No shared state, correct under concurrency by construction.
  - The poll: `DescribeTable`, **100ms interval, 10s ceiling**, exported
    with injectable interval/ceiling so case 17 needs no 10s sleep. On
    exhaustion rethrow the original `ResourceInUseException` with the
    observed status. Its own reads are NOT retried - a failed read counts
    as "not ACTIVE yet".
  - **The poll needs no endpoint gate of its own.** It is reached only when
    `retried` is true, and `retried` can only be true on a local endpoint,
    so a second gate would be dead code that reads as a live safeguard.
    Case 17 calls it directly with a LOCAL client, which is the only way
    the exhaustion path can be exercised at all.
  - The success path keeps `waitUntilTableExists` unchanged.
  - **Record, do not fix:** a genuinely CREATING pre-existing table is
    still returned as `'exists'` without a wait, exactly as today. That
    hole predates this mission.
- **`DeleteTable`** - retried; the catch additionally tolerates
  `ResourceInUseException` (DELETING means the delete landed).
- **`DescribeTimeToLive`** - the PRE-SEND read is retried like any other
  send (case 9). The hook invocation that re-reads status between attempts
  is not. Two call sites, not one contradictory rule.
- **`UpdateTimeToLive`** - retried, with the status re-read as its hook.
  **Success condition: `TimeToLiveStatus === 'ENABLED' || 'ENABLING'`**
  (case 6). The hook does NOT swallow - a throwing re-read must reach the
  fail-closed branch, because re-sending an enable for an already-enabled
  TTL can draw a `ValidationException`.

### S1.4 - refactor `db-update-gsis.ts` onto the helper

```
verify: async () => {
  const s = await indexStatus(client, physicalName, indexName);
  return s === 'CREATING' || s === 'ACTIVE';
}
```

`indexStatus` keeps its own `catch` returning `undefined`, so `verify`
returns `false` and the re-send happens - `ensureGsis`'s FAIL-OPEN
behaviour is unchanged, and unchanged because the tolerance lives in the
caller's hook, which is where it belongs. Add one comment line saying so.

**What DOES change:** `ensureGsis` (`:200-242`) is ungated today - the
localhost guard is on the CLI (`:261-270`). Moving to the shared helper
puts it behind the endpoint gate for the first time. Intended, a
tightening; cases 15/16 use a LOCAL endpoint so they cannot pass wrongly.

**Do NOT touch** `unreadIndexRepo.integration.test.ts:728` - that site has
no `ResourceInUseException` catch, so a retry would recreate there the
defect this slice fixes in `ensureTable`.

### S1.5 - verify against the EXISTING tests of what you changed

From `app/`, each bare:

- `npx vitest run test/dynamoAdminRetry.test.ts` - all cases green
- `npx vitest run test/dynamo.integration.test.ts` - **the only existing
  test of the `ensureTable` branch S1.3 rewrites**; confirm it covers that
  branch and still passes
- `npx vitest run test/globalSetupEnsure.test.ts`
- `npx vitest run test/dynamoKeyLedger.test.ts`
- `npx vitest run test/unreadIndexRepo.integration.test.ts`

**Commit.** Report to `<records>/s1-retry.md`.

---

## S2 - logCallSiteGuard: measure, then cut

File: `app/test/logCallSiteGuard.test.ts`.

### S2.1 - instrument and measure

The `beforeAll` (`:140-143`) contains exactly `buildProgram(true)` and
`scanProgram`. **`ts.getPreEmitDiagnostics` is NOT in it** - it runs in the
first `it` at `:152` under `testTimeout: 60_000`.

Time `buildProgram`, `scanProgram` and the health `it` separately, **file
alone, 3 runs, on a machine whose state you RECORD** - the number becomes a
permanent budget, so a figure taken under unrecorded load is worse than no
figure. If the neighbours are still live, either wait or record the load
and treat the result as an upper bound.

Within `scanProgram`, instrument **the three sites that actually do checker
work**, because the two-way `buildProgram`/`scanProgram` split does not
partition the cost finely enough to choose a remedy:

- `:97` `checker.getShorthandAssignmentValueSymbol` (eager, even when
  `legal`);
- `:106` `checker.getSymbolAtLocation`;
- `:79-80` inside `isErrorTyped` - `getTypeAtLocation` AND
  `checker.typeToString`, which is a second, separately expensive call.

**Do not instrument `isCatchDeclared` (`:74-77`) as a cost centre** - it
reads `valueDeclaration` and node kinds and does no checker work at all.

Record: `<records>/measurements/s2-guard-cost.md`. The instrumentation is
REMOVED before handback.

### S2.2 - cut the measured dominant cost

- **If `:106`'s `getSymbolAtLocation` is material**: it is already inside
  `!legal &&`, so there is no ordering win - the remedy would have to
  reduce the number of candidate identifiers reaching it, and **no remedy
  is pre-committed**; report it as a decision. Naming a measurement site
  with no destination is how a measurement becomes ceremony.
- **If the eager symbol lookup at `:97` is material**: hoist the `legal`
  test above `getShorthandAssignmentValueSymbol` and skip the checker call
  when `legal` is true. **In the PROPERTY-ASSIGNMENT branch (`:101-111`)
  the checker call is already inside `!legal &&`** - it needs no change,
  and the recursion into nested object literals at `:109` must still run
  REGARDLESS of `legal`, so do not `continue` early there.
- **Do NOT "fix" the `||` short-circuits at `:98` / `:106`. They already
  short-circuit.** That is not the same as saying their cost is off-limits:
  if measurement shows `isErrorTyped`'s `getTypeAtLocation` dominates,
  that is a real target - but **no remedy for it is pre-committed**, and it
  returns to the planner as a decision. The obvious candidates all trade
  away what the guard proves, which is the one thing this slice may not do.
- **If `buildProgram` dominates**: **no remedy is pre-committed** either.
  Measure, report, return it as a decision. Two earlier proposals did not
  exist - `createCompilerHost` has no type-checking to remove, and
  `include: ["src"]` leaves no roots to narrow.

### S2.3 - the health probe may NOT be hollowed out

`app/tsconfig.json` is `"include": ["src"]`, so every `app/src` file is a
program ROOT regardless of whether its imports resolve. **`sourceCount > 50`
does NOT subsume the TS2307 check.** Any cheaper replacement is validated by
**deliberately breaking module resolution and proving it still fails.** If
none survives, leave it.

### S2.4 - budget both clocks

- Hook budget >= **4x** the new measured cost, **ceiling 600s**. If 4x
  exceeds the ceiling, stop and report.
- **The health `it` runs under `testTimeout: 60_000`** and carries a
  whole-program type-check. If S2.1 measures it near 60s, give it an
  explicit per-test budget on the same rule.
- Shipped comments cite **only what this mission measured**, with the date
  and the recorded machine state.

**Fallback:** if the cost will not come materially below ~196s, raise the
budget to >= 4x measured within the ceiling and record why.

### S2.5 - verify

File alone, 3 runs post-cut; confirm the new cost is a small fraction of
the new budget. Remove the instrumentation. **Commit.**

---

## S3 - staticSmoke: split by what each assertion proves

File: `app/test/staticSmoke.test.ts`. **Nine `it`s across two describes.
Every one is assigned below by line - round 1 caught an enumeration that
silently dropped two.**

| line | case | goes to |
|---|---|---|
| `:38` | serves index.html at / | **SPLIT** - status and content-type to (a), with `HousingChoice` REPLACED by the fixture marker per S3.1; the five identity assertions to (b)/(c) |
| `:50` | runtime identity before static + SPA fallback | (a) |
| `:88` | legacy `/manifest.webmanifest` redirect + its 403 origin-secret guard | (a) |
| `:105` | SPA fallback for unknown GETs | (a) |
| `:111` | reserved namespaces | (a) |
| `:120` | hardening headers | (a) |
| `:143` | path-traversal probes | (a) |
| `:189` | AWS bucket CSP shape | (a) |
| `:204` | MinIO endpoint CSP shape | (a) |

### S3.1 - (a) app-serving behaviour on a fixture. NEVER skips.

`mkdtemp` fixture, **file-scoped**. Both describes read `distDir` - the
first at `:29`, the second at `:182` - so a fixture scoped to one of them
leaves the other pointed at a path that may not exist. **Create it BEFORE
`buildApp`**: this file constructs the app in the DESCRIBE BODY at
collection time (`:29`), so only `unitMediaServe.test.ts:171-173`'s shape
(fixture in a `beforeAll`, app built inside it) is structurally
compatible - restructure THAT describe. The second (`:177-215`) already
builds its app per test (`:178-187`) and needs only the file-scoped
`distDir`, not restructuring. **Clean up with `rmSync`**, as both
precedents do.

**Fixture `index.html`, positive AND negative:**

- MUST contain `<div id="root">` (`:108`, `:165`, `:85`);
- the `HousingChoice` assertion (`:42`) becomes a TAUTOLOGY once we write
  the fixture ourselves - it asserts our own string back at us. Replace it
  with a DISTINCTIVE fixture marker, the way
  `unitMediaServe.test.ts:174` does, so the assertion proves the served
  bytes came from THIS fixture. The real `HousingChoice` string is covered
  by (b)/(c) against the tracked source;
- MUST NOT contain `"version"`, `"private"` or `root:`. Load-bearing now
  that no decoy exists: the traversal assertions read whatever the SPA
  fallback returns, which IS this fixture's `index.html`.

**Traversal probes: assertions carry over unchanged; the COMMENT does
not.** The comment at `:144-147` names `dashboard/dist/../../package.json`
as "the realistic exfiltration target on this exact tree" - untrue under a
temp fixture. Rewrite it to state what the probes now pin: that no encoded
`..` yields anything but the SPA shell or a 4xx, given this app's stack of
static serving, SPA fallback and reserved namespaces.

**No decoys.** `send` decodes the path and rejects any normalized `..`
segment before touching the filesystem (`node_modules/send`, `UP_PATH_REGEXP`;
**record the installed `send` version in the slice report**, since the
argument rests on a transitive dependency).

**Add the positive control the file lacks:** write a real asset into the
fixture dist, fetch it, **assert its BODY**. A status check alone passes
vacuously - an `express.static` miss falls through to a 200 SPA shell,
exactly what the regression this control catches would return.

### S3.2 - (b) the identity contract against tracked source. NEVER skips.

Assert against `dashboard/index.html`. Exactly five conditions:

- contains `href="/app-identity/manifest.webmanifest"`
- contains `rel="icon" href="/app-identity/icon-192.png"`
- contains `rel="apple-touch-icon" href="/app-identity/icon-192.png"`
- does NOT contain `href="/manifest.webmanifest"`
- does NOT contain `href="/icons/icon-192.png"`

### S3.3 - (c) the real build: PASS or SKIP, never FAIL

| dist state | outcome |
|---|---|
| absent | SKIP - "no built dashboard; run `npm run build -w dashboard`" |
| present, all five hold | PASS |
| present, any fails | SKIP with the message below |

"`dashboard/dist` disagrees with `dashboard/index.html`. Most likely the
dist is stale - run `npm run build -w dashboard`. If a fresh build still
reports this, the dashboard BUILD is dropping the identity tags, which is a
real regression - see `docs/issues/<slug>`." **A literal `<slug>` must not
reach the shipped string.**

**The slug must exist BEFORE this string is written, so S7.2's SECOND issue
(the built-dashboard coverage gap) is FILED HERE, in S3, not in S7.** It
depends on no measurement - it is a consequence of this slice's own design.
Deferring it to S7 would either ship a literal `<slug>` placeholder or
force an ungated `.ts` edit onto the branch tip after the gates, which
would falsify the docs-after-gates safety argument. S7.2's FIRST issue
still waits for S5's probe result, because that one does depend on
evidence.

**No mtime predicate of any kind.**

### S3.4 - observe both live branches

1. `npm run build -w dashboard` once, by hand;
2. run the file - record the PASS branch. **If a FRESH build does NOT
   satisfy the five conditions, STOP and report.** That is a discovery
   about the build, not a reason to tune the assertions to fit;
3. edit the built `dashboard/dist/index.html` in place to break one tag,
   run again - record the SKIP branch and its message;
4. restore by rebuilding. The file is gitignored.

**Commit.** Report to `<records>/s3-static-smoke.md`.

---

## S5 - what the clean-key recipe actually does now

The finding is established by READING
`app/test/setup/dynamoAccessKey.ts:118-120`: `accessKeyForTestFile` returns
the explicit key for EVERY file, so exporting `AWS_ACCESS_KEY_ID` collapses
all ~53 suites onto ONE database - the OLD arm of the experiment that
justified per-file keys, not a clean database.

The measurement only dates the claim to this container. **2 runs per arm,
app workspace only, BOTH ARMS AT ONE NAMED COMMIT** (record it - these
numbers go into `AGENTS.md`):

| arm | bash | PowerShell |
|---|---|---|
| default | `cd app && npx vitest run` | `cd app; npx vitest run` |
| explicit key | `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run` | `cd app; $env:AWS_ACCESS_KEY_ID='hccleanrun001'; npx vitest run` |

Confounds go in the record, not the conclusion:

- `sweepLedgerResidue` runs on the way IN - the prime alternative
  explanation if the old numbers no longer reproduce;
- the sweep's mode varies with concurrency (derive it from the snapshot);
- arm 2 changes the test SET - `dynamoAccessKeyGuard.test.ts:308` skips its
  per-file assertions under an explicit key. Expected, not a failure.

**Also run the TTL probe here.** It may NOT be done "after a run": vitest's
teardown, returned from `globalSetup` (`globalSetup.ts:214`), calls
`dropKeyedLocalTables` -> `dropAllTables` (`globalTeardown.ts:279`), so a
completed run leaves NO `hc-local-` table to describe - the probe would find
nothing and the claim would collapse back to the inference it exists to
replace.

Probe the mechanism directly instead, in a throwaway script (not a
committed test), against the LOCAL container, with **no restart and no new
access key** - use the worktree test key so no additional database is
created:

1. call the exported `ensureKeyedLocalTables()` (`globalSetup.ts`) in a
   process where `DYNAMO_DISABLE_TTL` is UNSET - which is exactly the
   condition `globalSetup` runs under, since `test.env` reaches workers
   only;
2. `DescribeTimeToLive` on one of the tables it created and record the
   status;
3. **DROP the tables (`dropKeyedLocalTables`) before the second arm.**
   Without a drop the contrast is FAKE: `ensureTable` short-circuits on
   `ResourceInUseException` and, with the flag set, skips
   `enableTtlIfNeeded` entirely (`dynamoAdmin.ts:116-119`) - so arm 2 would
   describe a table arm 1 already enabled TTL on, both arms would report
   ENABLED, and the issue would be filed on a false contrast;
4. repeat from a clean slate with `DYNAMO_DISABLE_TTL=1` set in the
   process;
5. drop what you created, leaving the container as found.

**Sequencing: run this AFTER S5's four full runs, not between them.** It
creates and drops this worktree's shared `hc-local-` tables, which a
concurrent run of its own would be using. The throwaway script itself is
run state - put it in `.superpowers/sdd/`, not in the committed tree.

**S7.2's first new issue is filed on THIS RESULT.** If the probe shows TTL
is NOT enabled, the claim is wrong, the issue is not filed, and that is a
finding for the handback.

Record: `<records>/measurements/s5-clean-key.md`.

---

## S6 - sync, gates, post-fix runs

1. **One `main` sync.** If `main` has advanced in a way that could conflict
   with active work, ASK before syncing.
2. **The five gates, BARE, on a QUIET TREE** - no child may be writing:
   1. `npm run typecheck`
   2. `npm test`
   3. `npm run smoke`
   4. `npm run e2e`
   5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

   Gate 5: no NEW lint errors in TOUCHED files, attributed by BASELINE
   COMPARISON at the merge base, never by line number. Empty list -> SKIP
   the gate (a bare `npx eslint` goes repo-wide and fails on 117
   pre-existing errors). The config lints `.ts`/`.tsx` only.
3. **3 post-fix `npm test` runs with contention snapshots**, to pair with
   S0. If the machine has gone QUIET, label the arm QUIET - **do not
   fabricate load**, and remember a mixed pair may NOT close the anchor.
4. **State BOTH confounds in the S0/S6 pair.**
   - This mission's own changes: S3 un-skips ~9 `it`s and S2 changes one
     file's cost, so the two arms do not run the same work. Report the
     skipped-count delta from S0 step 5 alongside the wall clock.
   - **The `main` sync in step 1.** S0 ran at `5ce9912f`; S6 runs at
     whatever `main` has become. Any test `main` added or changed lands
     between the arms. Name the synced SHA and the file-count delta.

   The same reasoning is why S4's solo arm moved before S1 and why S5's
   arms are pinned to one commit; applying it to S4 and S5 and not here
   would be inconsistent. Do not present the difference as a pure
   performance result.
5. **Adjudicating a red gate 2:** re-run the failing FILES alone, run the
   full suite at the merge base, compare failing FILES rather than cases,
   report both runs.

---

## S7 - registry, AGENTS.md, _CLUSTERS.md

### S7.1 - close what the evidence closes

Resolution stamps on `logcallsiteguard-hook-budget-equals-its-own-cost.md`
and `static-smoke-fails-on-stale-dashboard-dist.md`; and on
`npm-test-dynamodb-local-contention.md` **only if the measurements support
it**.

**Expected outcome: the anchor most likely stays OPEN.** S1 has no recorded
sighting to cure, and a mixed contended/quiet pair may not close it. If it
stays open, add the new numbers, apply S4's NARROW strike, and say plainly
what was and was not established.

**When deciding that strike, say this out loud:** S4's solo arm was moved
before S1 so it could not straddle a code change, but its LOADED arm
straddles S1 by construction - S0's runs are pre-change and S6's are
post-change. That is unavoidable given what the loaded arm is, and it is
exactly the hazard that moved the solo arm, so it belongs in the closure
text rather than being quietly relied on.

**The logCallSiteGuard closure must not overclaim.** That issue also names
`[vitest-worker]: Timeout calling "onTaskUpdate"`, which is birpc
coordinator starvation, not a hook budget. It is already addressed by
`maxWorkers: 4` (`vitest.config.ts:44`) under the RESOLVED issue
`npm-test-runner-rpc-starves-under-concurrent-e2e`. Say so; do not let the
closure read as though a budget raise fixed an RPC fault.

### S7.2 - file the ONE remaining new issue (copy `docs/issues/_TEMPLATE.md`)

**The built-dashboard coverage gap was already filed in S3.3** - it depends
on no measurement and its slug has to exist before S3's SKIP string is
written. Do not file it again here.

1. **`globalSetup` re-enables TTL on the shared `hc-local-` tables every
   run.** Lead with S5's PROBE RESULT. Mechanism: `globalSetup.ts:90-91`
   states that vitest `test.env` does not reach globalSetup and sets only
   the credentials, so `DYNAMO_DISABLE_TTL=1` never applies there and
   `createAllTables` -> `ensureTable` -> `enableTtlIfNeeded` turns the
   reaper on before any test runs. The immunity `vitest.config.ts:92-118`
   describes does not hold for shared-table suites.
2. **No gate asserts the BUILT dashboard's PWA identity tags.** Consequence
   of S3.3 being unable to fail. Name the remedy (`npm run build -w
   dashboard` in the app workspace's pretest or `globalSetup`) and its cost
   (~15-40s on every `npm test`, on every branch).

Also record the PRE-EXISTING observation that `db-create.ts:64` and `:76`
call `waitUntilTableNotExists({maxWaitTime:60})` after every delete,
carrying a flat-20s second tick on the `npm test` teardown path. Out of
scope; measured only if it shows in teardown timing.

### S7.3 - the clean-key recipe lives in THREE files

Fix all three. Fixing two would leave the wrong recipe in the issue that
documents it:

1. `AGENTS.md` - the paragraph beginning "**FIRST, if `npm test` is red on
   DynamoDB Local suites:**";
2. `docs/issues/npm-test-dynamodb-local-contention.md:100-106` - "First
   diagnostic for anyone who hits this";
3. `docs/issues/_CLUSTERS.md:235-237` - M7's "run its gates under a clean
   access key". **Also `:231`**, whose M7 row still lists suite B's retry
   as owed work.

Only what is proven. Guessing here re-creates the exact problem this
mission closes.

### S7.4 - `npm run issues`

Regenerates the gitignored `docs/issues/INDEX.md`. Never hand-maintain it.

---

## S8 - handback

`<records>/handback.md`: bare gate exit codes, the live Playwright result,
both measurement arms with labels and scopes, the S0/S6 confound stated,
what each issue closure claims and on what evidence, **both SHAs** (gated
commit and final), main drift, and anything owed.

**Never merge, deploy, mutate infrastructure, or clean up.**

## Watch items

- The endpoint gate is the only thing keeping the retry off a path that
  could reach real AWS. Cases 11/12 prove it refuses; 13/14 prove it still
  says yes. Both halves or neither.
- **Case 3 protects the hot path.** An unconditional ACTIVE poll would tax
  ~75 call sites and ~23 tables per run to fix a rare hole.
- Case 15 stops the refactor disarming the retry that already works.
- **A test can be tautological three revisions running.** The traversal
  decoy was, and so was its replacement. When an assertion needs
  scaffolding to be meaningful, check whether the mechanism under test
  makes the scaffolding unreachable.
- **These changes touch the harness every other mission is gated by.** A
  defect here fails other people's branches, not just this one.
