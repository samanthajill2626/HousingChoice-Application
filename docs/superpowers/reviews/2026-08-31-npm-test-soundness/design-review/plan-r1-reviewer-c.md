# Plan review R1 - reviewer C (adversarial, plan-under-review)

- Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md`
- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v5, TERMINAL)
- Repo state read: worktree `W:\tmp\npm-test-soundness`, base `5ce9912f`.
  `node_modules` is NOT installed here, so every claim about SDK or `send`
  internals is marked UNVERIFIED rather than asserted.
- Method: read the plan and spec in full, then re-derived every load-bearing
  citation from source. Ran the spec's own enumeration grep. No suite, script,
  Docker command or npm script was run. No repository file was edited.

The question answered here is not "is this a good plan" but: **if a builder with
no context executes it literally, do they produce the spec?**

---

## 1. [BLOCKING] The unconditional ACTIVE poll turns the commonest `ensureTable` path into a new false red

**What is wrong.** S1.3 bullet 1 makes the poll unconditional: "On
`ResourceInUseException` the catch now polls until ACTIVE before returning
`'exists'`", with a 10s ceiling, the poll's own reads explicitly NOT retried
("a failed read counts as 'not ACTIVE yet'"), and on exhaustion a THROW - pinned
by acceptance case 11. The spec agrees (item 1A, per-command table, `CreateTable`
row) and calls it "a real hole in TODAY's code, independent of the retry".

The hole is real. The remedy's blast radius is not examined anywhere in either
document.

**Evidence.**

- `app/src/lib/dynamoAdmin.ts:87-93` - today the `ResourceInUseException` path is
  a single immediate `result = 'exists'`. It cannot throw and it costs one
  round trip.
- The `ResourceInUseException` branch is not the exceptional path, it is the
  NORMAL one. `ensureTable` is called from ~75 sites across ~50 suites
  (enumerated by `grep -rn "ensureTable(" --include=*.ts app e2e scripts`);
  representative loops: `app/test/importApply.integration.test.ts:75`, `:516`,
  `:538`, `:600`, `:631`, `:672`, `:713`, `:775`, `:853`, `:897`, `:943`,
  `:975`, `:1002`; `app/test/groupConvert.integration.test.ts:122`;
  `app/test/todayUnmatchedNonRegression.test.ts:107`;
  `app/test/performanceSeed.integration.test.ts:247-248`. Most of these run
  against tables that already exist.
- `app/test/globalSetup.ts:117` -> `app/scripts/db-create.ts:31-49`
  (`createAllTables`) -> `ensureTable` for every spec in `TABLES` on **every**
  `npm test`, before any test runs.
- `app/vitest.config.ts:60` `testTimeout: 60_000` and `:71` `hookTimeout: 60_000`
  are the budgets these callers sit in.
- `app/test/dynamo.integration.test.ts:60-64` asserts `ensureTable` on an
  existing table "resolves to 'exists'" - the direct behavioural test of the
  branch being changed.

**What it implies.** Two costs, neither acknowledged:

1. *Steady state.* Every already-exists call gains a `DescribeTable` round trip.
   That is several hundred extra control-plane reads per `npm test`, added to the
   exact container whose control-plane saturation this mission exists to survive.
   The mission increases the load it is measuring.
2. *Under the stress the mission targets.* The container answers control-plane
   calls with `InternalFailure` / `InternalServerError` (spec item 1A). Those are
   the poll's own reads, which S1.3 forbids retrying and reinterprets as "not
   ACTIVE yet". So a stressed container converts a call that today returns
   `'exists'` in milliseconds into a 10s spin ending in a **thrown**
   `ResourceInUseException`. In `globalSetup`'s loop over ~23 tables the worst
   case is ~230s of pure polling before any test starts; in a suite `beforeAll`
   it blows the 60s budget from `vitest.config.ts:71` after two tables.

A mission whose stated failure class is "a required gate goes red when nothing is
wrong" (spec, "The class") is shipping a new mechanism for exactly that, on the
hottest path in the harness, and gating it to local endpoints so the exposure is
*only* on the gate path.

The fix is cheap and the plan should pre-commit it rather than leave it to the
builder: either (a) poll only when a retry actually occurred - thread a flag out
of the helper so the accepted-but-unanswered case polls and the ordinary
already-exists case does not; or (b) keep the poll unconditional but make
exhaustion degrade to today's behaviour (return `'exists'`, optionally log)
rather than throw. Option (b) contradicts acceptance case 11 as written, so this
is a decision the plan must make, not a note.

Secondary, same bullet: "rethrow the original `ResourceInUseException` with the
observed status appended" is under-specified. Mutating `.message` on an SDK
exception instance and constructing a fresh `Error` are different for any caller
doing `instanceof` (`dynamoAdmin.ts:91`, `:148` both do), and the plan does not
say which.

---

## 2. [BLOCKING] S4 cannot complete before S6 or S7 - the plan's own dependency table is circular

**What is wrong.** The slice table (plan, "Slice order") states S6 depends on
S1-S5 and S7 depends on S1-S6. S4 cannot satisfy that.

**Evidence.**

- Plan S4, bullet 2: the second measurement arm is "Its behaviour across S0's
  baseline and **S7's post-fix runs** (the LOADED arm - the solo arm removes by
  construction the latency the remedy is about)".
- Plan S4, "If either fails: diagnose to root cause and **STOP** - report to the
  planner before editing." That stop condition can only fire after S7 step 3,
  i.e. after the `main` sync and after all five gates.
- Plan S6.1 requires, before S7: "strike the anchor's 'latency-robust
  assertions' remedy as superseded by the `cleanupMs` TTL fix, **naming this
  evidence**."
- Spec item 1B says the same thing ("AND its behaviour across the contended full
  runs of item 1D"), so this is inherited, not introduced by the plan - but the
  plan is where the ordering is asserted and it asserts an impossible one.

**What it implies.** A literal builder either (a) writes S6.1's registry edit on
half the evidence and then discovers a S4 failure after the gates have run, or
(b) deadlocks waiting for S7 while S7 waits for S6. There is no ordering here
that both slices can satisfy. The plan needs S4 split - S4a (10 solo runs, before
S6) and S4b (read the loaded arm out of S0's and S7's recorded failing-FILE
lists, after S7 step 3) - with S6.1's strike-or-not decision explicitly deferred
to a post-S7 amendment, or S6 explicitly re-ordered after S7 step 3.

---

## 3. [HIGH] Acceptance cases 9 and 10 cannot exercise `ensureGsis` as written - the stub never reaches the retry

**What is wrong.** Plan S1.1 case 10: "local, `ensureGsis` where `DescribeTable`
ALSO throws | still reaches a re-send - `ensureGsis` keeps FAIL-OPEN". Executed
literally against the real `ensureGsis`, control never gets near the retry.

**Evidence.**

- `app/scripts/db-update-gsis.ts:210` - `ensureGsis` calls `liveIndexNames`
  FIRST, per table, before any `UpdateTable`.
- `app/scripts/db-update-gsis.ts:182` - `liveIndexNames` sends
  `DescribeTableCommand`; `:188-191` rethrows anything that is not
  `ResourceNotFoundException`. A stub whose `DescribeTable` "ALSO throws"
  therefore throws out of `ensureGsis` before `sendWithInternalFailureRetry`
  (`:227`) is ever called.
- The other obvious stub shape is worse: a `DescribeTable` that throws
  `ResourceNotFoundException` returns `undefined`, takes the `missingTables`
  branch at `:211-215` and `continue`s - also never reaching the retry.
- After a successful re-send the code calls `waitUntilTableExists` (`:234`, SDK
  waiter, needs `Table.TableStatus === 'ACTIVE'`) and then `waitUntilIndexActive`
  (`:148-174`, polls `DescribeTable` at `:162` until `IndexStatus === 'ACTIVE'`,
  900s ceiling, `:158`). A stub that keeps throwing `DescribeTable` hangs to that
  ceiling; a stub that answers it uniformly cannot produce case 10's premise.
- Same problem, milder, for case 9 (`ensureGsis` `UpdateTable` retries): the stub
  must answer `DescribeTable` three different ways across three phases.

The plan's stub contract (S1.1, four bullets) covers "answers
`DescribeTableCommand`" and "counts calls per command type". It says nothing
about programming a per-command-type SEQUENCE, which is what cases 9, 10 and 11
all require.

**What it implies.** A builder writing case 10 from the plan's one-line
description gets a test that goes green on a throw from `liveIndexNames` - a
green test that proves nothing about fail-open, in the slice whose own watch item
says "The refactor can disarm the retry that already works." The plan must
specify the phased stub: `DescribeTable` #1 returns a table with the index
absent; `DescribeTable` #2 (inside `indexStatus`) throws; `DescribeTable` #3+
report table ACTIVE and index ACTIVE so the two waiters terminate. Alternatively,
have cases 9/10 drive `sendWithInternalFailureRetry`'s replacement directly and
add one thin integration case for `ensureGsis` - but that has to be a stated
decision, not a builder's improvisation.

---

## 4. [HIGH] The TTL verification hook's success condition is never stated, and no case pins it

**What is wrong.** The plan specifies the GSI hook's predicate verbatim (S1.4:
`return s === 'CREATING' || s === 'ACTIVE'`) and leaves the TTL hook's predicate
entirely unstated. S1.3 says only "retried, with the status re-read as its
verification hook".

**Evidence.**

- Plan S1.3, `UpdateTimeToLive` bullet - no return mapping given.
- Plan S1.1 case 4 asserts only "status RE-READ between attempts (hook called
  exactly once for that attempt)". Case 5 asserts the throwing branch. **No case
  asserts that a re-read reporting `ENABLED`/`ENABLING` returns success WITHOUT a
  re-send.**
- That is the entire reason the hook exists: spec item 1A, "The verification
  hook" - "re-sending an enable for a TTL that is already enabled can draw a
  `ValidationException`, converting a transient container hiccup into a hard
  failure."
- The guard being replaced is `app/src/lib/dynamoAdmin.ts:131`
  (`ENABLED || ENABLING` -> return), so the mapping is knowable; it just is not
  written down.

**What it implies.** A builder can write `verify: async () => { await
describeTtl(); return false; }`, satisfy every listed sentence and every one of
the 11 cases, and ship the precise defect the design exists to prevent. This is
the same class of gap the spec claims to have closed for the generic return
contract ("its RETURN contract, which three revisions left unstated"); it is
still open for the one caller the argument was built around. Fix: state
`ENABLED || ENABLING -> true` in S1.3, and add a case whose re-read reports
`ENABLED` and asserts `UpdateTimeToLive` was sent exactly ONCE.

---

## 5. [HIGH] `DescribeTimeToLive` retry and `InternalServerError` are both unfalsifiable - either can ship inert

**What is wrong.** Two specified behaviours have no acceptance case.

**Evidence.**

- Plan S1.2: "Retryable names: `InternalFailure`, `InternalServerError`." Spec
  item 1A names `InternalServerError: This action timed out because it took too
  long waiting for a lock` as the container's `tryLock(10s)` shape - a
  distinct, separately-motivated error. **Every one of the plan's 11 cases uses
  `InternalFailure`.** An implementation that matches only `InternalFailure`
  passes the whole suite. The existing code at
  `app/scripts/db-update-gsis.ts:116` does handle both, so this is a regression
  risk in the refactor, not just an omission.
- Plan S1.3: "`DescribeTimeToLive` - the PRE-SEND guard is retried like any other
  send." That is `app/src/lib/dynamoAdmin.ts:128-130`. **No case makes
  `DescribeTimeToLive` fail.** Cases 4 and 5 fail `UpdateTimeToLive` only.

**What it implies.** The plan's own framing (S1.1: "Cases 6 and 7 are the ones
that stop this slice shipping inert") is about the endpoint gate. Two other
pieces of this slice can ship inert and cases 6/7 do not touch them. Add: one
case using `InternalServerError` on any covered send, and one where
`DescribeTimeToLive` throws `InternalFailure` then succeeds and
`enableTtlIfNeeded` still completes.

---

## 6. [HIGH] S3.1's enumeration is incomplete - two of eight `it`s in `staticSmoke.test.ts` are unassigned

**What is wrong.** S3.1 lists what moves onto the fixture: "SPA fallback,
reserved namespaces, hardening headers, both CSP media-bucket shapes, the runtime
`/app-identity/*` endpoints, and the path-traversal probes." The file has eight
`it`s. Two are named nowhere in S3, and both are currently `skipIf(!built)`-gated
and would silently vanish in a rewrite.

**Evidence.** `app/test/staticSmoke.test.ts`:

| `it` | line | S3 assignment |
|---|---|---|
| serves runtime identity before static files and the SPA fallback | `:50` | (a) - "runtime `/app-identity/*` endpoints" |
| SPA-falls back to index.html for unknown GET paths | `:105` | (a) |
| never swallows the reserved namespaces | `:111` | (a) |
| browser-hardening headers | `:120` | (a) |
| encoded path-traversal attempts | `:143` | (a) |
| real AWS shape: virtual-hosted bucket origin | `:189` | (a) - "both CSP shapes" |
| local MinIO shape | `:204` | (a) |
| **serves index.html at /** | **`:38-48`** | **UNASSIGNED** |
| **redirects the legacy root manifest to the runtime manifest** | **`:88-103`** | **UNASSIGNED** |

`:38-48` is not a clean move either way: `:40-42` are app-serving assertions
(status 200, `text/html`, body contains `HousingChoice`) while `:43-47` are the
five PWA identity assertions S3.2 relocates to tracked source. It must be SPLIT.
And S3.1's own fixture requirement contradicts its enumeration: "MUST contain
`HousingChoice` ... (assertions at `:41` ... depend on them)" presupposes that
test survives on the fixture, while the list of what moves omits it.

`:88-103` is pure app behaviour - `/manifest.webmanifest` 307s to
`/app-identity/manifest.webmanifest` with `no-store` (`app/src/app.ts:198`), and
403s without the origin secret (`:101-102`). Nothing about it depends on a built
dashboard, and it is exactly the coverage the (a)/(b)/(c) split is supposed to
rescue.

**What it implies.** A slice sold as a coverage GAIN ("today all of those
silently skip on any checkout where nobody built the dashboard", spec item 3(a))
loses two tests, one of them the only assertion that `/` serves HTML at all.
Enumerate all eight, and state explicitly that `:38-48` splits: app-serving half
to (a) on the fixture, identity half to (b) on `dashboard/index.html`.

---

## 7. [HIGH] S2's only pre-committed cut targets the cheapest checker call and cannot plausibly move the number

**What is wrong.** S2.2's `scanProgram`-dominates branch commits to exactly one
remedy: skip the eager `checker.getShorthandAssignmentValueSymbol` when `legal`
is true. That helps a small subset of nodes and leaves the dominant checker cost
untouched - and the plan forbids touching it.

**Evidence.** `app/test/logCallSiteGuard.test.ts`:

- `:96` - `legal` is ALREADY computed above the checker call, so "hoist the
  `legal` test above it" describes something already true; what is meant is
  guarding `:97`.
- `:97` - `getShorthandAssignmentValueSymbol` is eager. Skipping it when `legal`
  is true saves the checker only for SHORTHAND properties whose key is in
  `LOG_SERIALIZER_KEYS` (`:29`) at `depth === 0` - by construction the minority
  of payload keys, since a wired key is the legal case.
- `:98` and `:106` - for every NON-legal property (the majority), the guard still
  runs `isCatchDeclared` and then `isErrorTyped`, and `isErrorTyped` (`:78-81`)
  calls `checker.getTypeAtLocation` plus possibly `checker.typeToString`. S2.2
  explicitly forbids changing these ("Do NOT 'fix' the `||` ordering at `:98` or
  `:106` - they already short-circuit"). That is correct about ordering and
  irrelevant to cost: short-circuiting only skips `isErrorTyped` when
  `isCatchDeclared` already returned true, i.e. on findings.
- `:67` - `program.getTypeChecker()` is lazy. The whole-program bind-and-check
  work is therefore billed to `scanProgram`'s FIRST `getTypeAtLocation`, not to
  `buildProgram`.

**What it implies.** Two things. First, S2.2's binary branch ("scanProgram
dominates" vs "buildProgram dominates") does not partition the actual cost -
the likeliest true answer is "the type checker dominates, and it is charged to
`scanProgram`", for which the plan pre-commits a near-inert remedy and forbids
the relevant one. Second, the plan therefore very likely lands on S2.4's fallback
("raise the budget to >= 4x measured") after three instrumented measurement runs
and a cut that moves nothing - which is a legitimate outcome, but the plan should
say so and add a third S2.2 branch ("checker-dominated: no cheap cut exists;
report and take the budget fallback") rather than letting a builder conclude the
cut failed because they implemented it wrong.

---

## 8. [HIGH] The S0-vs-S7 comparison compares different test sets, and the plan names every other confound but this one

**What is wrong.** S0 takes 3 baseline `npm test` runs on the unedited base
tree; S7 step 3 takes 3 post-fix runs to pair with them. Between them, S3 changes
how many tests run and S2 changes how long one file takes - so the pair is not
comparable on wall clock, and wall clock is what the plan calls a durable signal.

**Evidence.**

- `app/test/staticSmoke.test.ts:19` `const built = existsSync(...)`, `:28`
  `describe.skipIf(!built)` and `:177` `describe.skipIf(!built)`. There is no
  `dashboard/dist` in this worktree, so today all eight `it`s skip. After S3 they
  all execute (S3.1: "NEVER skips"). The post-fix arm runs strictly more work.
- S2 deliberately changes `logCallSiteGuard.test.ts`'s runtime, and
  `maxWorkers: 4` (`app/vitest.config.ts:44`) means one file's cost is not
  additive - it changes scheduling for the whole run.
- The plan is meticulous about the analogous confound elsewhere: S5 records "arm
  2 changes the test SET - `dynamoAccessKeyGuard.test.ts:308` skips its per-file
  assertions under an explicit key. The skip-count delta is expected, not a
  failure." Nothing equivalent appears for S0 vs S7.
- Spec item 1D and plan S6.1 both make this pair the evidence that might close or
  fail to close the anchor issue.

**What it implies.** Add pass/fail/skip COUNTS to the S0 and S7 record schema
alongside wall clock and failing-FILE names, and state in S7 step 3 that the
post-fix arm executes a superset of the baseline's tests so a wall-clock
regression of that size is expected and attributable. Otherwise the mission's
central comparison carries a systematic bias in the direction opposite the one
the mixed contended/quiet caveat already guards against.

---

## 9. [MEDIUM] The endpoint gate is specified against an SDK shape nobody has verified, and all 11 stub cases would pass if it were wrong

**What is wrong.** S1.2 says "`client.config.endpoint` is an async
`Provider<Endpoint>` returning an object with `hostname`". Every acceptance case
supplies that provider from the stub. If the real client's `config.endpoint` is
not that shape, the fail-closed rule disarms every retry - including the one that
works today - and the suite stays green.

**Evidence.**

- `app/src/lib/dynamo.ts:61-79` - `createDynamoClient` passes `endpoint` as a
  STRING to `new DynamoDBClient({...})` when one is configured, and passes NO
  endpoint at all on the AWS path (`:64-66`). The AWS path's behaviour under the
  gate is exactly what fail-closed depends on.
- The plan's stub contract (S1.1): "exposes a settable, resolvable
  `config.endpoint` provider" - the stub supplies the shape the implementation
  expects, so the cases are circular with respect to it.
- I could not check `@smithy/middleware-endpoint`'s `resolveEndpointConfig` -
  `node_modules` is not installed in this worktree. **UNVERIFIED.** The same
  applies to the spec's `node_modules/send/index.js:61` / `:431` citation
  underpinning S3.1's "no decoys" argument.

**What it implies.** Add one non-stub assertion to S1.1: construct a real
`createDynamoClient({ endpoint: 'http://127.0.0.1:8000' })` (no container needed
- resolving the endpoint provider makes no network call) and assert the
predicate reports local; and one on a client built with no endpoint, asserting it
reports non-local. That is the only case in the set that could catch a wrong
assumption about the SDK's shape.

---

## 10. [MEDIUM] Whether the verification hook runs on the FINAL failed attempt is unspecified, and the two readings differ from today's behaviour

**What is wrong.** The helper contract (S1.2) says the hook is "Called **at most
once per failed attempt**" and that the attempt bound governs re-sends. It does
not say whether the bound is checked BEFORE or AFTER the hook on the last
attempt.

**Evidence.** `app/scripts/db-update-gsis.ts:110-126` - today the order is
explicit: `:117` `if (!retryable || attempt >= attempts) throw err;` runs BEFORE
`:121` `const status = await indexStatus(...)`. So on attempt 4 the index status
is never consulted and the error escapes even if the index landed. A helper that
calls the hook first and returns success on `true` is a behaviour CHANGE
(arguably an improvement) that plan case 9 - "retries - the existing mitigation
survives the refactor" - cannot distinguish.

**What it implies.** State the order in S1.2's table, and if the change is
intended, say so in S1.4 next to the `ensureGsis`-gating note, which is the only
place the plan currently admits a deliberate behaviour change in that file.

---

## 11. [MEDIUM] S5's arms are not pinned to a tree state, and `AGENTS.md` is rewritten from their numbers

**What is wrong.** The slice table says S5 depends on S0 only. S5 therefore may
run on the unedited base tree or after S1-S3 have landed. The two are not the
same measurement: S1 changes the shared `ensureTable` path taken ~75 times per
run (see finding 1) and S3 changes the executed test set (finding 8).

**Evidence.** Plan slice table ("S5 | the `AGENTS.md` clean-key measurement |
S0"); S5's two arms; plan S6.3 / spec Deliverable 6 - "rewritten ... to the
numbers this container actually produced. **Only what is proven.**"

**What it implies.** A number lands in `AGENTS.md` - the file every agent reads
first - with no recorded commit, so nobody can reproduce or age it. Pin S5 to the
BASE commit (it is a claim about the recipe, not about this branch's changes) and
record the commit SHA in `s5-clean-key.md`.

---

## 12. [MEDIUM] S3.4's PASS branch is assumed rather than conditioned

**What is wrong.** S3.4 step 2 instructs "run the file - record the PASS branch"
after a hand build. If the build does not produce the five byte-exact substrings,
step 2 SKIPs and the plan gives no branch for that outcome.

**Evidence.**

- The five conditions (S3.2) are attribute-order-exact substrings, e.g.
  `rel="icon" href="/app-identity/icon-192.png"`. They hold in the tracked source
  - verified in `dashboard/index.html:11-13`, and the two negative conditions
  hold there too.
- Whether Vite emits them unchanged in `dashboard/dist/index.html` is asserted by
  the spec ("Vite copies the link tags through untransformed") and is
  **UNVERIFIED** here: no `dashboard/dist` exists in this worktree and
  `node_modules` is not installed. Attribute reordering, self-closing-tag
  normalisation or an injected `crossorigin` would each break a substring while
  the built page is perfectly correct.
- If step 2 skips, (c) becomes a permanently-skipping test whose message accuses
  the operator's dist of being stale - the exact "round a loop" failure S3.3's
  message was written to avoid.

**What it implies.** Add the branch: if a FRESH build skips, the five conditions
are wrong for the built artifact and must be corrected (or relaxed to a
normalised comparison) before (c) ships. Do not ship a diagnostic whose PASS
branch has never been observed.

---

## 13. [MEDIUM] S1.5's verification set omits the only existing test of the branch S1.3 changes

**What is wrong.** S1.5 verifies with `dynamoAdminRetry.test.ts` and
`unreadIndexRepo.integration.test.ts`. Neither exercises `ensureTable`'s
`ResourceInUseException` branch against a real container.

**Evidence.**

- `app/test/dynamo.integration.test.ts:60-64` - "ensureTable is idempotent
  (re-run reports exists, no error)", asserting `resolves.toBe('exists')`. This
  is the direct behavioural test of the branch S1.3 rewrites.
- `app/test/globalSetupEnsure.test.ts:93`, `:117`, `:162` - exercises the
  globalSetup ensure loop.
- `app/test/dynamoKeyLedger.test.ts:136`, `:200`, `:264` - `ensureTable` on probe
  clients.
- Spec non-goals name `seedLive` (`app/test/seedLive.test.ts:138`) and
  `seedProfile.integration` (`:69`) as WATCH-ONLY; both call `ensureTable` and
  are therefore affected by finding 1 without being touched.

**What it implies.** Gate 2 in S7 will catch a break, but by then the branch has
been synced with `main` and four other gates are in flight. Name
`dynamo.integration.test.ts`, `globalSetupEnsure.test.ts` and
`dynamoKeyLedger.test.ts` in S1.5 so a regression in the changed branch is
diagnosed in the slice that caused it.

---

## 14. [MEDIUM] The traversal probes' shipped comment becomes false on the fixture, and S3.1 says the probes carry over "UNCHANGED"

**What is wrong.** `app/test/staticSmoke.test.ts:144-147` justifies the probe set
by naming the target: "dashboard/dist/../../package.json IS the repo-root
package.json - the realistic exfiltration target on this exact tree (and
../package.json is the dashboard workspace manifest)."

Under a `mkdtemp` fixture (S3.1) `distDir` is under the OS temp directory, so
neither of those files is at either relative path. S3.1 says the probes "carry
over UNCHANGED"; if the comment carries over with them it documents a target that
does not exist.

**What it implies.** Small, but this is a mission whose stated purpose is that no
test's colour or rationale may be a lie, and whose own watch item is "A test can
be tautological three revisions running." Instruct S3.1 to rewrite `:144-147` to
the composition rationale the spec actually argues (no encoded `..` yields
anything but the SPA shell or a 4xx, given OUR stack) and to drop the
tree-specific target claim.

---

## 15. [LOW] S4 authorises striking a documented remedy on evidence that addresses different failing cases

**What is wrong.** S4 / S6.1 let 10 clean solo runs plus a loaded arm "strike the
anchor's 'latency-robust assertions' remedy as superseded by the `cleanupMs` TTL
fix". The recorded failures and the TTL fix are about different cases.

**Evidence.**

- `docs/issues/npm-test-dynamodb-local-contention.md:519-531` records suite A
  failing on `matching, in both delivery orders > a filing for a DIFFERENT author
  does not clear this author event` and `the grace deadline and the alarm > a
  would-be alarm whose classic filing DID land is reconciled QUIETLY, not
  alarmed`, plus one solo FAIL immediately followed by one solo PASS.
- `app/src/lib/dynamoAdmin.ts:105-107` names the TTL-reaped case as `"a DUPLICATE
  redelivery is deduped"` - not either of the above.
- The `cleanupMs` injection is real (`app/test/groupCrossCheck.test.ts:195`) and
  so is the `afterEach` drain (`:127`), so the spec's premise that two fixes have
  landed holds. The inference that they supersede remedy 1 does not follow from
  the recorded case names.
- Ten clean runs bound the failure rate at roughly <30% (rule of three), which is
  not obviously below the rate the anchor's 4 observations suggest.

**What it implies.** Have S6.1 record "not reproduced in N solo runs and M loaded
runs; bounds the rate at X" rather than "superseded", unless S4 also shows the
two named failing cases specifically. The plan's own instruction elsewhere -
"say plainly what was and was not established" - is the right standard here too.

---

## 16. [LOW] Citation drift a literal builder will trip over

- `staticSmoke.test.ts:41` is the `content-type` assertion; the `HousingChoice`
  assertion is `:42`. Plan S3.1 and spec item 3(a) both cite `:41`.
- `dynamoAccessKeyGuard.test.ts` lives at `app/test/setup/`, not `app/test/`.
  Plan S5 and spec item 1C give a bare filename; the sibling citations
  (`globalTeardown.ts`, `globalSetup.ts`) are unqualified too and resolve to
  `app/test/`. Line numbers `:308`, `:327`, `:342` are correct in that file.
- `globalTeardown.ts:20-25` and `:33-45` are prose COMMENT, not the sweep. The
  function is `sweepLedgerResidue` at `globalTeardown.ts:189`, its mode predicate
  (`otherLiveRuns() > 0 ? CONCURRENT_SPARE_MS : 0`) at `:206`, and the call on
  the way IN is `globalSetup.ts:165`. Plan S0.4 and S5 both point a builder at
  comments when they mean code.
- Plan S2.1 says `ts.getPreEmitDiagnostics` "runs in the first `it` at `:152`" -
  the `it` begins at `:145`; `:152` is the call.
- Plan S6.2 issue 1 cites the "immunity `vitest.config.ts:92-118` describes".
  That comment ALREADY concedes the scope limit at `:103-110` ("this flag does
  not DISABLE TTL, it declines to ENABLE it ... the immunity is real for a fresh
  table and NOT retroactive"). The NEW claim - that `globalSetup` actively
  re-ENABLES TTL on the ~23 shared tables every run - is correct and verified
  (`globalSetup.ts:90-101` sets only the credentials; `createAllTables` ->
  `ensureTable(env = process.env)` -> `dynamoAdmin.ts:116-119` sees no
  `DYNAMO_DISABLE_TTL` -> `enableTtlIfNeeded`), but the issue must lead with that
  rather than re-litigating what the comment says.

---

## 17. [LOW] `npm test` and `npx vitest run` are different scopes and the records will sit side by side unlabelled

`package.json:39` - `"test": "npm run test --workspaces --if-present"`. S0 and S7
measure all workspaces; S5 measures `cd app && npx vitest run` (deliberately, per
spec item 1C, to match `AGENTS.md`'s own recipe). The plan puts both sets of wall
clocks in adjacent `measurements/` files with no scope label, and the `AGENTS.md`
paragraph being rewritten opens on `npm test`. Label the scope in each record and
in the rewritten paragraph.

---

## Coverage walk (spec decision -> delivering task)

Every spec decision has a task. Gaps are behavioural, not missing slices.

| spec decision | task | verdict |
|---|---|---|
| 1A retry helper, endpoint gate, one hook contract | S1.2 | delivered; gate shape unverified (9) |
| 1A enumeration re-run | S1.0 | delivered - I ran the grep; the disposition rule does cover all 31 hits by category |
| 1A `CreateTable` ACTIVE poll | S1.3 | delivered, and wrong (1) |
| 1A `DeleteTable` tolerate RIU | S1.3 | delivered |
| 1A `UpdateTimeToLive` hook | S1.3 | success predicate missing (4) |
| 1A `DescribeTimeToLive` pre-send retry | S1.3 | unfalsifiable (5) |
| 1A `db-update-gsis` refactor + fail-open | S1.4 | delivered; cases unbuildable (3), final-attempt order open (10) |
| 1A `unreadIndexRepo:728` untouched | S1.4 | delivered |
| 1B groupCrossCheck measure-only | S4 | circular ordering (2), inference overreach (15) |
| 1C clean-key measurement | S5 | tree state unpinned (11) |
| 1D evidence protocol | S0, S7 | test-set confound unnamed (8) |
| 2 measure/cut/budget both clocks | S2 | cut near-inert (7) |
| 3(a) fixture, never skips, positive control | S3.1 | two `it`s unassigned (6), comment stale (14) |
| 3(b) tracked-source identity contract | S3.2 | delivered; verified satisfiable against `dashboard/index.html:11-13` |
| 3(c) PASS-or-SKIP diagnostic | S3.3, S3.4 | PASS branch assumed (12) |
| Deliverable 2 closures | S6.1 | delivered |
| Deliverable 3 two new issues | S6.2 | delivered; framing note (16) |
| Deliverable 4 `_CLUSTERS.md` M7 | S6.4 | delivered - the clean-key advice is real, `_CLUSTERS.md:235-237` |
| Deliverable 5 `npm run issues` | S6.5 | delivered (`package.json:38`) |
| Deliverable 6 `AGENTS.md` rewrite | S6.3 | delivered; numbers unpinned (11) |
| Deliverable 7 records as produced | plan rules | delivered |

## Non-goals checked

Nothing in this review proposes work the spec's "What this mission does NOT do"
section excludes. Finding 1's remedy is a narrowing of a change the plan already
makes to `dynamoAdmin.ts`, not an addition. Findings 3, 4, 5 and 9 add acceptance
cases to a suite the spec mandates. Findings 6 and 14 concern files S3 already
rewrites.
