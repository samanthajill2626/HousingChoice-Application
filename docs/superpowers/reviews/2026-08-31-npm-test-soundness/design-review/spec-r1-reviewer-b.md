# Design review R1 - reviewer B (adversarial)

- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md`
- Repo read-only at `W:\tmp\npm-test-soundness`
- Method: static reading and grep only. No suite, script or container was run.
  Anything I could not read is marked UNVERIFIED rather than asserted.
- Environment note that bounds several findings: this worktree has NO
  `node_modules` and NO `app/node_modules`, so SDK internals could not be
  consulted, and `dashboard/dist` does not exist here.

Findings are ordered by consequence if shipped unfixed.

---

## 1. BLOCKING - Item 2 puts `getPreEmitDiagnostics` inside the hook. It is not in the hook, so the named cut cannot reduce the hook cost at all

**What is wrong.** The spec's Step 1 table ("Instrument the hook into three
timed phases") lists `ts.getPreEmitDiagnostics(program)` as a phase of the
`beforeAll`, and Step 2 names it as "the prior suspicion" for the dominant cost
to be cut. It is not in the hook.

**Evidence.**

- The hook is `app/test/logCallSiteGuard.test.ts:140-143`. It does exactly two
  things: `buildProgram(true)` and `scanProgram(gp)`.
- `ts.getPreEmitDiagnostics` is called at `app/test/logCallSiteGuard.test.ts:152-153`,
  inside the first `it` ("the real program is healthy"), which is a separate
  vitest task with a separate budget.
- That `it` carries no per-test timeout, so it runs on the workspace default
  `testTimeout: 60_000` (`app/vitest.config.ts:60`).
- The issue records the file passing in isolation
  (`docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md:25-26`), so
  every `it` in it completed inside 60s.

**What it implies.** Arithmetic on the spec's own cited measurement (196.2s
total, 179.1s "in tests", same issue `:15-16`): the three `it`s can account for
at most ~60s of the 179.1s, so the hook is **at least ~119s** against its 180s
budget. Deleting `getPreEmitDiagnostics` entirely removes **zero** milliseconds
from the hook and at most ~33% of file wall clock, and leaves the hook at
~119s+ against 180s - still a load-dependent red, which is the entire defect.

Consequently locked decision 2 ("measure, then cut the cost - not a bare budget
raise") is very likely unreachable, and the spec's "explicit fallback" is the
actual path. There is no obvious cut left, either: the program is built from
`app/tsconfig.json`, whose `include` is `["src"]` only
(`app/tsconfig.json:7`) - there are no test files to exclude, so the usual
"narrow the program" lever does not exist here.

A builder following Step 1 as written will either instrument a phase that does
not run in the hook, or MOVE the diagnostics call into the hook to make the
table true - which makes the timeout strictly worse.

---

## 2. BLOCKING - Item 1C's two arms do not vary the variable the AGENTS.md claim is about, yet Deliverable 4 rewrites that paragraph from them

**What is wrong.** The claim being re-measured is a RESIDUE claim. The spec's
arms vary KEY SHARING. These are different experiments, and one of them is
already measured in the anchor with a known answer.

**Evidence.**

- The claim: `AGENTS.md:159-164` - "A degraded database - leaked `hc-test-*` /
  `hc-local-<lane>-*` / `hc-hist-*` tables from interrupted runs ... 607s and 9
  failures on a residue-carrying key, 65s and 0 failures on an empty one".
- Its source experiment: `docs/issues/npm-test-dynamodb-local-contention.md:61-78`
  - the two arms were a worktree key holding **116 leaked tables** versus a
  brand-new empty key. The independent variable is residue.
- The spec's arm 2 is `AWS_ACCESS_KEY_ID=hccleanrun001 npm test`. An explicit
  `AWS_ACCESS_KEY_ID` short-circuits per-file keys for EVERY file
  (`app/test/setup/dynamoAccessKey.ts:118-122`, and the config plumbs it at
  `app/vitest.config.ts:85-87`), so all files land on one database and one
  `queueLock`.
- That regime is already measured, on purpose, in the anchor: OLD (one explicit
  key) 446-509s versus NEW (per-file) 75-95s, 3 runs each
  (`docs/issues/npm-test-dynamodb-local-contention.md:296-301`).
- `hccleanrun001` is by construction the CONTROL arm of the original experiment
  (a clean key). Using the control as the treatment cannot re-derive the
  treatment's number.

**What it implies.** Arm 2 will be several times slower than arm 1 for LOCK
reasons that have nothing to do with residue. Deliverable 4 then rewrites
`AGENTS.md:152-165` "to what item 1C proves" - and what it proves is the
one-database penalty, not the degraded-database penalty. Either outcome is
wrong:

- slow arm 2 -> the paragraph keeps a residue warning justified by a lock
  measurement;
- fast arm 2 -> the paragraph loses a residue warning that was never tested,
  and the next person hitting a 116-table database has no recipe.

To actually test the claim the mission needs a residue-carrying arm (a key with
leaked `hc-test-*` / `hc-local-<lane>-*` / `hc-hist-*` tables) against a clean
one, at the same key-sharing setting. The spec's non-goals forbid table sweeps
outside this worktree's lane, which constrains how that arm can be produced -
that constraint is not reconciled anywhere in the spec.

---

## 3. BLOCKING - Item 1A has no acceptance criterion, and its fail-closed gate can ship inert with every gate green

**What is wrong.** The spec's gate is "the retry ACTIVATES only when the
client's resolved endpoint is a localhost DynamoDB Local endpoint", it names no
mechanism for reading that endpoint, and it prescribes no test that proves the
retry ever fires.

**Evidence.**

- `createDynamoClient` passes `endpoint` as a **string** to the v3 client
  constructor (`app/src/lib/dynamo.ts:71-78`). What `client.config.endpoint`
  then resolves to (a `Provider<Endpoint>` async function, versus `undefined`
  when unset) could not be checked here - there is no `node_modules` in this
  worktree. UNVERIFIED, and the spec does not settle it either; it asks a
  reviewer to.
- The spec's own risk list says exactly this ("what does `client.config.endpoint`
  resolve to when it was never set") and then leaves it open.
- The evidence protocol (item 1D) is a contended full-suite run before and
  after. The spec's own risk list says "Single runs prove nothing about an
  intermittent fault - the anchor's own record shows a green OLD arm 2 runs in
  3."

**What it implies.** A predicate that reads a provider function as if it were a
string yields "not local" always. The retry never activates, behaviour is
byte-identical to today, all five gates pass, the before/after runs are both
green-ish, and the mission reports the tail closed. This is the exact
"verify what you SHIPPED, not what you tested" shape.

The spec needs an explicit mechanism (and it should note the alternative that
avoids the async provider entirely - `dynamoAdmin` already receives the
endpoint decision from its callers) plus a direct unit test that a fake client
throwing `InternalFailure` is retried on a local endpoint and NOT retried on a
non-local one. Neither appears in Deliverables.

---

## 4. HIGH - 1A misidentifies the open tail: `UpdateTable InternalFailure` is already retried

**What is wrong.** The spec's "Corrections to the record" concludes "the tail
the issue names is genuinely open" from the fact that `dynamoAdmin.ts` has no
retry. The tail the record names is on a different command in a different file,
and it already has one.

**Evidence.**

- `AGENTS.md` (the `npm test` guidance) and `docs/issues/_CLUSTERS.md:220-222`
  both name the tail as "an `UpdateTable InternalFailure` tail".
- `_CLUSTERS.md:231` states suite B's remedy as "retry `UpdateTable` on
  `InternalFailure`".
- That retry exists and is applied: `app/scripts/db-update-gsis.ts:103-127`,
  used at `:227`.
- The anchor's "What is NOT fixed" section
  (`docs/issues/npm-test-dynamodb-local-contention.md:326-392`) lists three
  residuals - the unreproduced error string, the two shared-key suites, and the
  database-count resource shape. `dynamoAdmin.ts` is not among them.
- No entry anywhere in the anchor records `CreateTable`, `DeleteTable`,
  `DescribeTimeToLive` or `UpdateTimeToLive` failing with `InternalFailure`.
  The one code-level sighting is `UpdateTable` from `ensureGsis`
  (`docs/issues/npm-test-dynamodb-local-contention.md:645-647`).

**What it implies.** Item 1A is speculative hardening presented as the closure
of a named, evidenced tail. If the mission then stamps the anchor Resolved on
1A's strength (Deliverable 2), the genuinely named tail is closed without ever
being examined. Either the spec should say plainly that 1A is prophylactic and
that the named `UpdateTable` tail is already remedied, or it should investigate
why the record still calls that tail open despite the existing retry.

---

## 5. HIGH - The `UpdateTimeToLive` retry-safety claim is false, and it repeats verbatim the defect `db-update-gsis.ts` documents at length

**What is wrong.** The spec asserts `UpdateTimeToLive` is "guarded by a status
read that returns early on `ENABLED` / `ENABLING`; re-sending an enable for an
already-enabled TTL is a no-op." The guard is OUTSIDE the send, read once.

**Evidence.**

- `app/src/lib/dynamoAdmin.ts:128-131` - the `DescribeTimeToLive` read and the
  early return.
- `app/src/lib/dynamoAdmin.ts:132-137` - the `UpdateTimeToLive` send, after it.
- A retry wrapped around the send at `:132` re-sends against a TTL that attempt
  1 may have already moved to `ENABLING`. The guard cannot see that; it already
  ran.
- This is precisely the failure the existing helper's docblock spends 18 lines
  warning about: "`ensureGsis` reads `liveIndexNames` ONCE PER TABLE, above the
  `for (const gsi of missing)` loop - so a bare re-send inside the loop asks for
  an index that may already exist"
  (`app/scripts/db-update-gsis.ts:70-86`). That comment also records that the
  earlier version of it claimed a re-read its code never performed.

Whether DynamoDB Local answers a redundant enable with a `ValidationException`
rather than a no-op is UNVERIFIED here (no container, no SDK). The real AWS
contract for `UpdateTimeToLive` is that enabling an already-enabled TTL is an
error, not a no-op; I could not confirm DynamoDB Local's behaviour statically.

**What it implies.** The spec's per-command safety argument - the thing it
explicitly claims to have done "per command rather than in general" - is wrong
on one of its four commands, and wrong in the exact way the codebase already
learned once. Either the guard moves inside the retried unit, or this command
needs the caller-supplied re-read hook the spec says none of the four need.

---

## 6. HIGH - Retrying `CreateTable` silently drops `waitUntilTableExists`; "correct outcome either way" is not correct

**What is wrong.** The spec argues `CreateTable` is retry-safe because attempt
2's `ResourceInUseException` is "ALREADY caught and reported as `'exists'`".
That catch also skips the table waiter.

**Evidence.** `app/src/lib/dynamoAdmin.ts:87-93`:

- the `try` wraps BOTH `client.send(new CreateTableCommand(...))` (`:88`) and
  `waitUntilTableExists({ client, maxWaitTime: 60 }, ...)` (`:89`);
- the catch at `:90-93` swallows `ResourceInUseException` and sets
  `result = 'exists'` without ever waiting.

**What it implies.** Today the `'exists'` branch is safe because the table
pre-existed the call and is ACTIVE. The retry manufactures a new case: attempt
1 CREATED the table (response lost), attempt 2 throws `ResourceInUseException`,
`ensureTable` returns `'exists'`, and the caller proceeds to write to a table
that may still be `CREATING` - under exactly the contended container that
produced the lost response in the first place. That is a new intermittent
failure introduced by a fix for intermittent failures, in the highest-traffic
helper in the test suite (~50 call sites; see finding 8's list).

The retry has to keep the waiter on the path, or `ensureTable` has to wait
after an `'exists'` result. Neither is specified.

---

## 7. HIGH - Half of item 1A's four call sites are DEAD under `npm test`

**What is wrong.** The spec's table presents four unprotected sends and says
`dynamoAdmin.ts` "is on the hot path of every integration suite in the repo".
Two of the four never execute in `npm test`.

**Evidence.**

- `app/vitest.config.ts:119` sets `DYNAMO_DISABLE_TTL: '1'` for the whole test
  run.
- `app/src/lib/dynamoAdmin.ts:116-119` - when that flag is `'1'`,
  `enableTtlIfNeeded` is not called at all, so neither
  `DescribeTimeToLive` (`:128-130`) nor `UpdateTimeToLive` (`:132-137`) runs.
- Those two sends remain reachable from `globalSetup` (`app/test/globalSetup.ts:117`
  -> `createAllTables` -> `ensureTable`), because `test.env` does not reach
  globalSetup - the file says so itself at `app/test/globalSetup.ts:91-92` -
  and from `db:create` and the e2e lanes.

**What it implies.** For the gate the mission exists to stabilise, item 1A's
real delta is `CreateTable` and `DeleteTable` only. The spec's framing
overstates coverage by 2x and would let a handback claim four hardened sends
where two are unreachable in the failing environment. It also means finding 5's
hazard shows up in `globalSetup` and the e2e lanes rather than in unit runs -
a different blast radius than the spec assumes.

---

## 8. HIGH - Unenumerated control-plane surfaces, including suite B's own table creation

**What is wrong.** The spec enumerates 4 sends. The test path contains roughly
15 local control-plane sends, and the suite the anchor names creates its table
without `ensureTable` at all - so 1A does not cover the path that actually
failed.

**Evidence** (all reads, `new <Command>` sites):

| file:line | command | in the spec's table? |
|---|---|---|
| `app/test/unreadIndexRepo.integration.test.ts:728` | `CreateTable` (suite B's own `beforeAll`) | no |
| `app/test/unreadIndexRepo.integration.test.ts:729` | `waitUntilTableExists` | no (excluded) |
| `app/test/unreadIndexRepo.integration.test.ts:756,771` | `DescribeTable` | no |
| `app/test/globalTeardown.ts:119` | `ListTables` (paged) | no |
| `app/test/globalTeardown.ts:132` | `DescribeTable` | no |
| `app/test/globalTeardown.ts:144` | `DeleteTable` | no |
| `app/test/setup/dynamoAccessKeyGuard.test.ts:327,335,338,342` | `CreateTable`/`ListTables`/`DeleteTable` | no |
| `app/test/dynamoKeyLedger.test.ts:137,163,249` | `ListTables` | no |
| `app/test/globalSetupEnsure.test.ts:93,117,162` | `DescribeTable`/`ListTables` | no |
| `app/src/lib/devReset.ts:42` | `DescribeTable` (dev reseed, local endpoint) | no |
| `scripts/wipe-dev-data.mjs:170` | `DescribeTable` | no |

The `globalTeardown` sweep runs on the way IN as well as out
(`app/test/globalSetup.ts:211`, `:215`), i.e. at the moment 4 workers are about
to start hammering the container.

**What it implies.** Two things. First, the `unreadIndexRepo` rows: suite B is
the anchor's named `InternalFailure` suite, and 1A's only reach into it is the
`deleteTableIfExists` in its `afterAll` (`:749`). Its `beforeAll` `CreateTable`
at `:728` stays raw. Claiming the tail closed on 1A would be claiming it on a
path suite B does not use.

Second, the teardown sweep's `ListTables`/`DeleteTable` are best-effort
(wrapped, `app/test/globalTeardown.ts:143-148` and `app/test/globalSetup.ts:176-180`),
so they degrade to leaked tables rather than a red - which feeds finding 2's
residue mechanism. Whether that is in scope is a decision the spec should make
explicitly rather than by omission.

---

## 9. HIGH - `waitUntilTableExists` is excluded on a mechanism claim the spec does not establish

**What is wrong.** "Not covered: `waitUntilTableExists`. The SDK waiter has its
own retry and polling semantics; wrapping it would nest two retry policies."
The waiter's polling is for a table that is not yet ACTIVE; it is not a fault
retry, and a non-matching exception is not obviously survivable.

**Evidence.** UNVERIFIED - the generated waiter's `checkState` could not be
read (no `node_modules` here). What is verifiable is the exposure:
`waitUntilTableExists` is called at `app/src/lib/dynamoAdmin.ts:89`,
`app/scripts/db-update-gsis.ts:234`, `app/test/unreadIndexRepo.integration.test.ts:729`,
and `waitUntilTableNotExists` at `app/scripts/db-create.ts:64,76`. Each is a
DescribeTable poll loop, i.e. the most-repeated control-plane call in the run.

**What it implies.** If the waiter surfaces `InternalFailure` (rather than
treating it as another RETRY tick), the mission ships a retry on the four
cheapest sends and leaves the most frequent one open, then closes the issue on
it. The exclusion needs one line of evidence from the SDK source, not an
assertion.

---

## 10. MEDIUM - The traversal decoy is planted one directory too high; the assertions stay vacuous

**What is wrong.** The spec: "The fixture is laid out as
`<tmp>/fixture/dist/index.html` with a planted `<tmp>/fixture/secret.json` ...
so an escape one level above the served root has something to find."
No probe escapes one level.

**Evidence.** `app/test/staticSmoke.test.ts:148-154`, decoded:

| probe | normalises to, relative to the served root |
|---|---|
| `/%2e%2e%2f%2e%2e%2fpackage.json` | `../../package.json` - two levels up |
| `/%2e%2e/%2e%2e/package.json` | two levels up |
| `/..%2f..%2fpackage.json` | two levels up |
| `/..%5c..%5cpackage.json` | two levels up |
| `/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json` | `assets` then three up = two levels up |
| `/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd` | absolute-ish, unrelated |

With the root at `<tmp>/fixture/dist`, two levels up is `<tmp>` - not
`<tmp>/fixture`. The planted `secret.json` is unreachable by every probe.

**What it implies.** `expect(res.text).not.toContain('"version"')` passes
because nothing could have been served, exactly as it does today against a
directory with nothing to leak - the failure mode the spec's own risk item ("a
fixture can make an assertion tautological") is written to prevent. The plant
has to sit two levels above the served root, and the layout has to nest deep
enough that "two levels above the root" is still inside the mkdtemp sandbox and
not the shared OS temp directory (writing `package.json` into `os.tmpdir()`
would collide across concurrent runs).

---

## 11. MEDIUM - Locked decision 3 and case (c) cannot both hold, and (c) cannot be exercised in this worktree

**What is wrong.** Locked decision 3: "no test's colour may depend on
`dashboard/dist`." Case (c) has a FAIL row reachable only when
`dashboard/dist/index.html` is present. And the closing claim - the red is
"identical on the branch and on main" - is not delivered by the mechanism,
because dist presence is per-checkout by construction.

**Evidence.**

- The spec's own outcome table for (c): "present, tags differ, dist NOT older
  than source | FAIL".
- `dashboard/dist` does not exist in this worktree (checked: `dashboard/`
  contains `public/` with `icons` and `sw.js`; no `dist`). So (c) SKIPs here
  and the mission cannot observe its PASS or FAIL rows without building the
  dashboard - which no deliverable authorises and which the non-goals do not
  discuss.
- The mtime tie-break itself is sound for the reported sighting
  (`docs/issues/static-smoke-fails-on-stale-dashboard-dist.md:28-38`): git
  rewrites `dashboard/index.html` on a checkout that changes it, so a
  pre-`2210f671` dist is older and skips.

**What it implies.** The honest formulation is narrower than the spec's: "no
FALSE red depends on the artifact; real coverage of the build still does, and
only where someone built." The spec should say that, because as written it
promises an invariant its own table breaks, and because a builder reading
"NEVER skips" against three buckets may try to make (c) unconditional.

---

## 12. MEDIUM - The health-probe replacement argument is wrong about what `sourceCount > 50` covers

**What is wrong.** The spec justifies cutting `getPreEmitDiagnostics` partly
with "the existing `sourceCount > 50` assertion already catches 'resolves
nothing'". It catches a different shape than the one TS2307 covers.

**Evidence.**

- `app/test/logCallSiteGuard.test.ts:146-149` counts `program.getSourceFiles()`
  minus declaration files. Those files come from the tsconfig root names
  (`app/tsconfig.json:7`, `include: ["src"]`), so they are present whether or
  not their IMPORTS resolve.
- The TS2307 filter at `:152-156` is what covers "the modules do not resolve",
  and the comment at `:150-151` says so.
- With unresolved imports, `isErrorTyped` (`:78-81`) sees `any`/error types,
  returns false for every candidate, and the guard reports zero findings - a
  green run over a hollow program. Only the canary positive control
  (`:159-161`) would notice, and only if the canary's own `catch (err)` binding
  still resolves, which it would (no imports).

**What it implies.** The replacement probe (per-specifier module resolution) is
load-bearing, not a belt-and-braces addition, and the spec's risk item ("prove
it by breaking the program deliberately") is the only thing standing between
this and a hollowed guard. Fine as a requirement - but the stated justification
should not imply the coverage is already there, because a builder under time
pressure will read "already catches it" as permission to drop the probe.

---

## 13. MEDIUM - The spec never says which key the five required gates run under, and it conflicts with M7's own instruction

**What is wrong.** Item 1D declares a contended, default-key environment "the
acceptance environment". The bundle definition says the opposite for gates.

**Evidence.**

- `docs/issues/_CLUSTERS.md:235-237`: "Run its gates under a clean access key
  (`AWS_ACCESS_KEY_ID=hccleanrun001`) or the anchor's own symptom contaminates
  the verdict."
- The spec's Gates section lists the five bare commands with no key discussion,
  while item 1D requires the contended default-key runs.
- The spec's own risk item concedes the contended arm is unreliable: "the
  anchor's own record shows a green OLD arm 2 runs in 3".

**What it implies.** Gate 2 has a materially non-trivial chance of going red
for the exact reason the mission is investigating, and the spec supplies no
adjudication rule for that case beyond "compare failing FILES". It must state
(a) which arm is the GATE and which are MEASUREMENTS, and (b) what a contended
gate-2 red means for the handback verdict. Note also that setting an explicit
key for gates re-creates the one-database regime (finding 2), so "run gates
under the clean key" is not cost-free either - that trade needs deciding here,
not at 2am by the builder.

---

## 14. MEDIUM - The "196.2s ALONE ... the hook consumes its entire budget" premise is an inference presented as a measurement

**What is wrong.** The spec states as established Problem that the hook
consumes its whole 180s budget. The cited measurement does not decompose that
way.

**Evidence.** `docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md:15-16`
records "196.2s total with 179.1s in tests". Vitest's "tests" figure aggregates
the hook AND the file's three `it`s; nothing in the record attributes it to the
hook alone. See finding 1 for the bound that IS derivable (hook >= ~119s).

**What it implies.** Step 3 requires the new budget to "carry a comment naming
the measurement and its date". Anchoring 4x to a mis-attributed number puts a
wrong number in a permanent comment - the same failure the spec's own
"Corrections to the record" section exists to prevent. The instrumentation
should report the hook and the diagnostics `it` separately, which the current
phase table does not ask for.

---

## 15. MEDIUM - Baseline-versus-after wall clock is confounded by a cold worktree

**What is wrong.** Item 1D makes wall clock the durable signal and compares a
pre-edit baseline against a post-fix run in the same worktree. This worktree has
no `node_modules` at all (neither root nor `app/`), so the baseline pays a cold
dependency install and a cold vitest/esbuild transform cache while the later run
runs warm.

**Evidence.** No `node_modules` or `app/node_modules` exists here. That the
transform cache is real and per-worktree is visible in
`docs/issues/static-smoke-fails-on-stale-dashboard-dist.md:26-28`, which
recovers results from `app/node_modules/.vite/vitest/*/results.json`.

**What it implies.** The bias runs in the direction of the fix. The protocol
needs one discarded warm-up run before the baseline, or an explicit note that
the first run's wall clock is not comparable - otherwise the mission's headline
number is partly a cache.

---

## 16. MEDIUM - 1B's solo-run arm cannot support 1B's deliverable

**What is wrong.** "10 consecutive solo runs ... If it does not fail: that is
the deliverable. Record the runs and strike the 'latency-robust assertions'
remedy from the issue as superseded by the TTL fix."

**Evidence.** The remedy being struck was argued from FULL-SUITE behaviour with
a varying failing case and a 4x duration inflation under contention
(`docs/issues/npm-test-dynamodb-local-contention.md:449-461`), later reinforced
by the solo-failure observations at `:529-545`. The solo arm removes the
latency the remedy is about, by construction. The historical solo rate the
issue records is 1 in 10 (`:565-567`), against which 10 runs has roughly a
one-in-three chance of seeing nothing.

**What it implies.** Ten green solo runs are evidence that the TTL fix holds
(useful), not evidence that latency-dependent assertions are absent. The spec
already collects the right arm - "its behaviour inside the full contended
baseline and re-run runs of item 1D" - but the strike-the-remedy decision rule
is written against the solo arm. Make the full-suite arm the one that decides,
and state the run count needed.

---

## 17. LOW - Correction 2's stated grep result is false as written

**What is wrong.** "A repo-wide search for `InternalFailure` /
`InternalServerError` returns `app/scripts/db-update-gsis.ts` only."

**Evidence.** Over `*.{ts,tsx,mjs,js,cjs}` the same search also returns
`e2e/support/lane.mjs:202` and `app/test/setup/dynamoAccessKey.ts:9` (both
docblock references to the lock-timeout string).

**What it implies.** The conclusion survives - the retry itself exists in one
file - but a correction section whose whole purpose is precision should not
overstate its own search. It also matters slightly: those two docblocks are the
places a future reader looks for the lock story, and they are not covered by
the "the two paths cannot drift" claim.

---

## 18. LOW - The spec appeals to a "mission file list" it does not contain

**What is wrong.** The duplicated localhost predicate is justified by "the
mission's file list forbids touching `db-create.ts`". The spec has no file
list; a builder who never saw the conversation cannot check that constraint,
and a reviewer cannot check whether the trade was necessary.

**Evidence.** `app/scripts/db-create.ts:22-29` exports `isLocalEndpoint`, and
`app/test/globalSetup.ts:24` and `app/scripts/db-update-gsis.ts:37` already
import it from there. Adding a third definition in `lib` makes two definitions
for one predicate across three consumers.

**What it implies.** Either state the file list in the spec, or drop the appeal
and justify the duplication on its own merits (lib must not import from
scripts - which is true and sufficient on its own).

---

## 19. LOW - 1C's commands are written for the wrong shell and the wrong scope

**What is wrong.** `AWS_ACCESS_KEY_ID=hccleanrun001 npm test` is a bash inline
env prefix; PowerShell (this repo's primary shell) has no such form and will
fail to parse it. The arm is labelled "(app workspace)" but written as root
`npm test`.

**Evidence.** Root `npm test` is `npm run test --workspaces --if-present`
(`package.json:39`) - five workspaces, not the app suite. The recipe being
re-measured is `cd app && AWS_ACCESS_KEY_ID=hccleanrun001 npx vitest run`
(`AGENTS.md:156`).

**What it implies.** Arm 2 as written measures a different workload than the
607s/65s numbers it is compared against, and the wall clocks are not
comparable. Also worth noting for the record: the guard suite stands down two
assertions under an explicit key (`docs/issues/npm-test-dynamodb-local-contention.md:303-305`),
so the two arms do not run identical test counts - the handback should say so
rather than have a reader discover a 2-test delta and wonder.

---

## 20. LOW - Item 3 does not enumerate every assertion it is relocating

**What is wrong.** The split into (a)/(b)/(c) leaves several existing
assertions without a home, and they are the ones that become
fixture-content-about-fixture-content if moved carelessly.

**Evidence.** `app/test/staticSmoke.test.ts:42`
(`expect(res.text).toContain('HousingChoice')`), and the `<div id="root">`
assertions at `:85` (negative), `:99` (negative), `:108`, `:165`. Under (a)
these become assertions about whatever the fixture's `index.html` contains.

**What it implies.** The fixture's contents are now part of the contract and
must be specified: it needs `<div id="root">` for the SPA-fallback and
traversal-200 cases to mean anything, and it must NOT contain `"version"` /
`"private"` or the traversal assertions self-fail. "HousingChoice" belongs in
(b) against tracked source, not against a fixture. One sentence in the spec
prevents a builder from discovering this by trial and error.
