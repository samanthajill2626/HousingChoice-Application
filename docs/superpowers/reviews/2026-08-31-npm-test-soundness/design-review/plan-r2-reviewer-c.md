# Plan review R2 - reviewer C (adversarial)

- Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md` (v2, `f126def0`)
- Held: reviewer D's R1 report, the R1 adjudications (38 accept, 0 reject),
  my own R1 report.
- Repo read-only. `node_modules` still absent, so SDK / `send` internals stay
  **UNVERIFIED**. No suite, script or Docker command was run; no file edited.

## Verdict: NOT terminal

Not because the round-1 fixes were wrong - most are better than the findings
asked for - but because **two of them introduced new defects of the same class
they closed**, and a third is unexecutable against the code:

- **S5's TTL probe cannot run.** `globalSetup`'s teardown drops every
  `hc-local-` table, so "after a run" there is nothing to `DescribeTimeToLive`.
  D11's accept ("file the issue on the probe's result, not the inference")
  produced a step that structurally cannot produce a result.
- **The retried-only ACTIVE poll has no seam.** S1.2 enumerates the helper's
  entire interface and gives `ensureTable`'s catch no way to learn a retry
  happened - and the helper THROWS on that path, so there is no return value to
  carry it. Cases 2 and 3 pin behaviour the stated contract cannot express.
- **S3.3's shipped SKIP string names a slug S7.2 does not create until after
  the gates** - the one concrete hole in the docs-after-gates decision, and it
  falsifies that decision's own safety argument.

One more round is warranted. Every item below is a mechanical fix; none
reopens a decision.

---

## 1. [BLOCKING] S5's TTL probe is unexecutable - the tables it probes are dropped by the run's own teardown

**What is wrong.** S5: "**Also run the TTL probe here** (read-only, no restart):
after a run, `DescribeTimeToLive` on an `hc-local-` table under the worktree key
and record the status. **S7.2's first new issue is filed on THIS RESULT, not on
an inference from a comment.**"

There is no `hc-local-` table after a run.

**Evidence.**

- `app/test/globalSetup.ts:192-220` - `setup()` RETURNS the teardown, and that
  teardown's first statement is `await dropKeyedLocalTables();`
  (`globalSetup.ts:216`). Vitest has no separate `globalTeardown` option; the
  docblock at `:184-190` says so explicitly.
- `app/test/globalTeardown.ts:234-300` - `dropKeyedLocalTables` calls
  `dropAllTables(endpoint)` (`:279`) under the worktree key and logs
  `[globalTeardown] dropped hc-local- tables (key=...)` (`:294`).
- `app/scripts/db-create.ts:56-78` - `dropAllTables` loops every spec in
  `TABLES` through `deleteTableIfExists` + `waitUntilTableNotExists`.

So after `npx vitest run` completes, a `DescribeTimeToLive` on
`hc-local-<anything>` returns `ResourceNotFoundException`. The probe records
nothing, and the builder's cheapest recovery is to file S7.2 issue 1 on the
inference D11 objected to - with a probe line in the record implying otherwise,
which is worse than not probing at all.

**What it implies.** Specify a probe that can actually observe the state. The
seam exists: `ensureKeyedLocalTables` is exported (`globalSetup.ts:35`) and is
the same `createAllTables` -> `ensureTable` -> `enableTtlIfNeeded` path
`globalSetup` takes. A throwaway `tsx` script that calls it and then sends
`DescribeTimeToLiveCommand` for a TTL-bearing spec under the worktree key
reproduces the mechanism exactly and settles the claim. Note that such a probe
is a WRITE to the shared `hc-local-` tables, not the read-only observation S5
promises - so say that, and say it is scoped to this worktree's private key
(`globalTeardown.ts:260`, `testAccessKeyId()`), which is what makes it safe
while neighbours run. Alternatively probe mid-run, but nothing in the plan gives
that seam.

Also correct S5's parenthetical: the probe is not "read-only, no restart" under
any version that can succeed.

---

## 2. [BLOCKING] The retried-only poll condition has no seam in the specified helper contract, and a natural wrong implementation passes all 17 cases

The coordinator asked directly whether this is implementable as stated. **Yes -
with a seam the plan does not include**, and no restructuring of `ensureTable`'s
try/catch is required.

**What is wrong.** S1.3: "**The ACTIVE poll runs ONLY when the
`ResourceInUseException` followed a RETRIED attempt.**" S1.2 then enumerates the
helper's complete interface: attempt bound and backoff; the lazy endpoint gate;
the retryable name list; "**Return value: the command output**"; the four-row
hook table; the predicate's location. **Nothing reports whether a retry
occurred**, and on this path the helper does not return at all - it rethrows the
`ResourceInUseException`, because RIU is not in the retryable set.

**Evidence.** `app/src/lib/dynamoAdmin.ts:86-93` is where the decision has to be
made:

```
let result = 'created';
try { await client.send(new CreateTableCommand(...)); await waitUntilTableExists(...); }
catch (err) { if (!(err instanceof ResourceInUseException)) throw err; result = 'exists'; }
```

The catch sees an exception and nothing else. Case 2 (`InternalFailure` then
RIU) and case 3 (RIU on the first attempt, no retryable error) differ ONLY in
history, and the caught value is the same `ResourceInUseException` instance
shape in both.

**The minimal correct shape** - and the plan should state it, because it is one
line and there are worse ones:

```
let retried = false;
try {
  await sendWithRetry(client, () => new CreateTableCommand(...), { onRetry: () => { retried = true; } });
  await waitUntilTableExists(...);
} catch (err) {
  if (!(err instanceof ResourceInUseException)) throw err;
  if (retried) await pollUntilActive(client, physicalName);
  result = 'exists';
}
```

A per-call callback (or a per-call mutable context object) is required. **A
module-level flag is the wrong shape and no acceptance case would catch it**:
`ensureTable` is called concurrently in this repo -
`app/test/todayUnmatchedNonRegression.test.ts:107` builds an array of
`ensureTable(...)` calls, and `app/test/performanceSeed.integration.test.ts:247-248`
runs two namespaces through it - so a shared flag would leak one call's history
into another's. All 17 cases are single-call and sequential.

**What it implies.** Add the seam to S1.2's contract explicitly ("the helper
reports, per call, whether any re-send occurred - a callback or a caller-owned
context object, never module state"), and say why the module-level shortcut is
forbidden. Without it the builder invents an interface mid-slice, in the one
file the spec's non-goals allow touching.

**Recorded as SOUND, since it was the round's headline change:** the retried-only
SCOPING itself is correct. It closes exactly the hole the spec describes
("attempt 2 after an accepted-but-unanswered attempt 1", spec item 1A per-command
table) and leaves the cross-process race - two processes, one creating, the other
getting RIU on its first attempt - untouched, which the plan records honestly as
"a genuinely CREATING pre-existing table is still returned as `'exists'` without
a wait... That hole predates this mission." That is the right call and the right
disclosure. And gating the poll on the local endpoint (S1.3) closes D2's third
bullet.

---

## 3. [HIGH] Cases 15 and 16 still cannot run - the C3 fix covered `liveIndexNames` and not the two waiters on the success path

This is an accept implemented to the letter of my R1 finding while dropping half
of what it named.

**What is wrong.** S1.1's stub bullet 1 now says case 10 [now 16] "needs
`ensureGsis`'s FIRST `DescribeTable` (inside `liveIndexNames`,
`db-update-gsis.ts:188-191`) to SUCCEED and only the VERIFICATION read to
throw." Correct, and it is only the first of three `DescribeTable` consumers on
that path.

**Evidence.** `app/scripts/db-update-gsis.ts:226-238` - after
`sendWithInternalFailureRetry` returns, `ensureGsis` runs two more waiters
before the loop can finish:

- `:234` `await waitUntilTableExists({ client, maxWaitTime: 120 }, ...)` - the
  SDK waiter, which polls `DescribeTable` and terminates only on
  `Table.TableStatus === 'ACTIVE'`;
- `:235` `await waitUntilIndexActive(client, physicalName, gsi.indexName)` -
  `:148-174`, which polls `DescribeTable` at `:162` until
  `IndexStatus === 'ACTIVE'` with **`timeoutMs = opts.timeoutMs ?? 900_000`**
  (`:158`) and no opts passed at `:235`.

So a stub scripted `[ok, throw]` for `DescribeTable` - exactly what S1.1 now
describes - runs out of script at call 3 and, depending on what the builder made
the fallthrough do, either fails opaquely or **hangs**: `waitUntilIndexActive`
loops for 900s against a `testTimeout` of 60s (`app/vitest.config.ts:60`), so
the symptom is a bare test timeout with no assertion, in the acceptance suite
this mission wrote to prove such symptoms have causes. Case 15 has the same
requirement on its success path.

**What it implies.** State the full script for cases 15/16: `DescribeTable` #1
returns a table whose `GlobalSecondaryIndexes` lack the target index and whose
`TableStatus` is `ACTIVE`; #2 (the verification read, case 16 only) throws; #3
onward return `TableStatus: 'ACTIVE'` and the target index `IndexStatus:
'ACTIVE'`. Or pass `ensureGsis` a single-spec `specs` argument and note that the
two waiters must be satisfied, not just the retry. Either way the stub contract
must say that a scripted sequence needs a defined TERMINAL behaviour, not just
an ordered prefix.

---

## 4. [HIGH] The docs-after-gates decision has exactly one hole, and S3.3 is it

The coordinator asked whether moving registry work after the gates creates a
hole. For gates 1-5 the answer is **no, verified** (see "Checked and sound"
below) - with one exception, which the plan creates itself.

**What is wrong.** S3.3's shipped SKIP string ends "see
`docs/issues/<the slug filed in S7.2>`", followed by "**A literal `<slug>` must
not reach the shipped string.**" S3 ships in the gated commit. S7.2 files that
issue AFTER the gates.

**Evidence.** Plan S3.3 (the message) and the slice table - S3 is before S6
(gates), S7 after. S7.2 item 2 describes the issue but names no slug.

**What it implies.** Two executions, both bad:

- The builder patches the string in S7. That is an edit to
  `app/test/staticSmoke.test.ts` - a `.ts` file - after the gates ran, which
  directly falsifies the plan's own safety argument ("S7 touches `.md` files and
  a gitignored index, which cannot affect gates 1-4, and gate 5's file list
  gains nothing"). Gate 5's list would gain nothing only because that file is
  already in it - so the ungated edit is silently lint-attributed to a run that
  never saw it, and gates 2/4 never execute the changed file at all.
- The builder invents a slug in S3 and hopes S7.2 uses the same filename.
  Nothing instructs that.

Fix: name the slug NOW, in the plan (e.g.
`no-gate-asserts-built-dashboard-pwa-identity`), have S3.3 ship that literal
string, and have S7.2 create exactly that filename. Then the docs-after-gates
claim is true without qualification.

---

## 5. [HIGH] Case 13 requires calling a predicate the plan keeps unexported, while the poll next to it got an explicit export

**What is wrong.** Case 13: "**REAL `DynamoDBClient`** with
`{endpoint:'http://localhost:8000'}`, and a second region-only | the predicate
says local / not-local." S1.2's last bullet: "The predicate is local to
`dynamoAdmin.ts`". No export is mandated.

**Evidence.** S1.1 forbids a container and a network ("No container, no
network"), so case 13 cannot reach the predicate by driving `ensureTable` with a
real client - the first `client.send` would be a real request to
`http://localhost:8000`. The only writable form is a direct call, which needs
the predicate exported. The plan made exactly this move for the poll one bullet
earlier - "exported with injectable interval/ceiling so case 17 needs no 10s
sleep" - and did not for the predicate.

Note case 14 (`127.0.0.1`, `::1`, `[::1]`, `localhost`) IS writable through a
stub client, the way cases 11/12 are, so the two positive-half cases have
different requirements and the plan treats them as one.

**What it implies.** One sentence: export the predicate. Without it, case 13 -
the case added specifically to test the `Provider<Endpoint>` assumption against
the real SDK, which no other case can do - is the one that gets quietly dropped
or downgraded to a shape assertion.

---

## 6. [HIGH] D8's accept answered the RETURN VALUE and dropped the SIGNATURE, and under `strict` the new CONSTRAINT is unexpressible as written

Contesting the adjudication. D8's finding was "The helper's **signature** and
RETURN value are unspecified". The adjudication (`plan-adjudications.md:48`)
resolves the return value and the caller constraint; the plan's S1.2 says
"**Return value: the command output**" and states the constraint in prose. The
signature is still unspecified, and it is not a formality.

**Evidence.**

- `tsconfig.base.json` - `"strict": true`, `"noUncheckedIndexedAccess": true`.
  `npm run typecheck` is gate 1.
- The hook-returns-true branch has no command output, so the honest return type
  is `TOut | undefined`.
- `app/src/lib/dynamoAdmin.ts:128-130` destructures the send result:
  `const { TimeToLiveDescription: ttl } = await client.send(new DescribeTimeToLiveCommand(...))`.
  Against `TOut | undefined` that is a compile error under `strict`.
- `DynamoDBClient.send`'s own typing is conditional over
  `ServiceInputTypes`/`ServiceOutputTypes`, so a generic pass-through wrapper is
  not a one-liner. **UNVERIFIED** in detail - `node_modules` is absent.

**What it implies.** The path of least resistance is a cast
(`return undefined as TOut`), which compiles, satisfies every one of the 17
cases, and makes the CONSTRAINT the adjudication introduced pure documentation -
a future caller can hand a hook to an output-consuming send and get `undefined`
at runtime. That is the letter of D8's accept without its point.

Express the constraint in the TYPE, not in prose: two functions -
`sendWithRetry(client, build)` returning the output and taking no hook, and
`sendWithRetryVerified(client, build, verify)` returning `void` - or one
function with two overloads keyed on the presence of `verify`. Then
`DescribeTimeToLive` cannot be given a hook by construction and
`enableTtlIfNeeded`'s destructure typechecks. State whichever shape is chosen.

---

## 7. [HIGH] Cases 8 and 10 name no command, and case 10's hook assertion is vacuous on four of the five candidates

**What is wrong.** Case 10: "local, always `InternalFailure` | exactly **4**
sends, then throws; **no hook call on the final attempt** (the bound is checked
first, matching `db-update-gsis.ts:117`)". Case 8: "local,
**`InternalServerError`** ... | retried identically to `InternalFailure`".
Neither names the command under test.

**Evidence.** Under S1.3 and S1.4, only two of the five retried sends supply a
verification hook: `UpdateTimeToLive` (the TTL status re-read) and `ensureGsis`'s
`UpdateTable` (`indexStatus`). `CreateTable`, `DeleteTable` and
`DescribeTimeToLive` supply none - `DescribeTimeToLive` cannot, by S1.2's own
CONSTRAINT. If a builder writes case 10 against `CreateTable`, "no hook call on
the final attempt" asserts that a hook that does not exist was not called: green,
and it proves nothing about the bound-before-hook ordering it was added to pin.

**What it implies.** Pin the command: case 10 must drive `UpdateTimeToLive` (or
`ensureGsis`) so the hook counter is meaningful, and the "exactly 4 sends" half
should additionally be asserted on an unhooked send so the two halves are not
entangled. Case 8's command matters less but should still be named, since
`InternalServerError` is the signature actually sighted in this issue's history
and a builder should not be free to exercise it on the one send that would be
easiest.

---

## 8. [MEDIUM] The S0/S6 pair straddles a `main` sync as well as this mission's changes, and S6.4 names only the mission's confound

**What is wrong.** S6 step 1 is "One `main` sync"; steps 2-3 (gates and the
three post-fix runs) happen after it. S0's baseline is at `5ce9912f`. Step 4
carefully names the confound this mission created - S3's ~9 un-skipped `it`s and
S2's cost change - and says nothing about the drift the sync imports.

**Evidence.** Plan lines 6-9 pin the base commit and note that "Every later
commit **on this branch** before S1 is DOCS ONLY" - which is true of the branch
and says nothing about `main`. Plan S6 step 1. `main` at `5ce9912f` is dated
2026-08-31; the sync happens at least a day later.

**What it implies.** The plan applied exactly this reasoning to move S4's solo
arm before S1 ("arms taken either side of that change would not be comparable")
and to pin S5's two arms to one named commit, then left the mission's headline
before/after pair straddling an unbounded external change. Record the sync's
merge SHA and `git diff --stat 5ce9912f..<merge> -- app/ dashboard/ e2e/` in the
S6 record, and state that if `main` brought test or harness changes the pair is
void for wall clock and usable only for failing-FILE comparison.

---

## 9. [MEDIUM] S4's loaded arm still straddles S1 by construction, and the plan does not say so

**What is wrong.** S4 was moved before S1 because "S1 changes `ensureTable` and
`deleteTableIfExists`, which sit in this file's own setup path
(`groupCrossCheck.test.ts:75`, `:79`)". Verified: `:75` is
`await ensureTable(client, getTableSpec('messages'), table)` and `:79` is
`await deleteTableIfExists(client, table)`. But the very next line says "The
LOADED arm comes from S0's baseline and S6's post-fix runs" - and S6 is after
S1, after S2/S3, and after the `main` sync.

**What it implies.** D13's accept fixed the solo arm and left the loaded arm
with the identical defect, unavoidably. That is fine, but it must be stated,
because S7.1's NARROW strike is drawn from these arms: the S0-vs-S6 comparison
for this file is not a controlled pair, it is one run before and one after a
change to its own `beforeAll`. Say so where the strike is decided, not only
where the solo arm is sequenced.

---

## 10. [MEDIUM] S2.1's new instrumentation names a pair that does not split the checker cost

**What is wrong.** S2.1: "Within `scanProgram`, also count and time
`isCatchDeclared` versus `isErrorTyped` calls". `isCatchDeclared` does no
checker work at all.

**Evidence.** `app/test/logCallSiteGuard.test.ts:74-77` - `isCatchDeclared` is
`sym?.valueDeclaration` plus `ts.isVariableDeclaration` and `ts.isCatchClause`.
Pure AST. The three checker calls in the scan are:

- `:97` `checker.getShorthandAssignmentValueSymbol(prop)` - eager, shorthand
  branch;
- `:106` `checker.getSymbolAtLocation(value)` - property-assignment branch,
  inside `!legal &&`;
- `:79-80` `checker.getTypeAtLocation(node)` and, whenever the symbol name is
  not literally `Error`, `checker.typeToString(type)` - reached from both `:98`
  and `:106`.

**What it implies.** A builder who instruments the named pair measures an AST
predicate against a checker predicate, concludes the obvious, and never
separates the symbol lookups from `getTypeAtLocation` from `typeToString`. Name
the three call sites by line. `typeToString` in particular is worth its own
counter - it runs on the majority of non-legal properties and is a formatting
operation over a resolved type, not a lookup.

---

## 11. [MEDIUM] The S3 fixture has to serve BOTH describes, and the restructuring note addresses only the first

**What is wrong.** S3.1: "**Create it BEFORE `buildApp`** - this file constructs
the app in the DESCRIBE BODY at collection time (`:29`), so only
`unitMediaServe.test.ts:171-173`'s shape ... is structurally compatible;
restructure accordingly."

**Evidence.** That is correct for the first describe
(`staticSmoke.test.ts:28-36`, app built at `:29`). The second describe
(`:177-215`) does NOT build at collection - it defines `buildWith` at `:178-187`
and calls it inside each `it` (`:190`, `:205`) - but it reads the same
module-level `distDir` (`:182`). The S3 assignment table sends `:189` and `:204`
to (a), so both describes need the fixture path.

**What it implies.** A builder who creates the fixture in the FIRST describe's
`beforeAll` leaves the second describe's `DASHBOARD_DIST_DIR` unset or stale, and
its two CSP tests then assert against an app with no dist configured - where
`app/src/app.ts:234` (`if (config.dashboardDistDir)`) skips static serving
entirely and `GET /` would not return 200. State that the fixture is file-scoped:
a module-level `beforeAll`/`afterAll` pair with a module-level `let distDir`,
shared by both describes, with the first describe's app construction moved out of
its body.

---

## 12. [MEDIUM] Which sends carry a verification hook is never tabulated, and a hook on `CreateTable` would change `ensureTable`'s return value while passing cases 2 and 3

**What is wrong.** S1.2's hook table has an "absent" row, and S1.3/S1.4 assign
hooks to `UpdateTimeToLive` and `UpdateTable`. `CreateTable` and `DeleteTable`
are simply not mentioned either way.

**Evidence.** If a builder gives `CreateTable` a `DescribeTable`-based hook
("did the table appear?"), the hook-returns-true branch returns SUCCESS from the
helper, so `ensureTable` never enters its catch and returns `'created'` where
today it returns `'exists'`. Case 2 still passes (it asserts `'exists'` on a
path where the hook would return... whatever the stub says) and case 3 still
passes (no retryable error, so no hook call). The regression surfaces at
`app/test/dynamo.integration.test.ts:62`
(`resolves.toBe('exists')`) - which S1.5 now runs, so it would be caught, but as
a mystery rather than as a specified decision.

**What it implies.** One row per retried send in S1.3: hook / no hook. Five
sends, five explicit answers.

---

## 13. [LOW] The retry backoff is not injectable while the poll is

Case 17 exists because the poll's 10s ceiling was too expensive to run for real,
and the poll was exported with injectable interval/ceiling. The retry's linear
`attempt * 250ms` (S1.2) got no such seam. Cases 1, 5, 6, 7, 8, 9, 15 and 16 each
pay 250ms or more, and case 10 - four attempts - pays 250+500+750 = 1.5s. Roughly
4-5s of pure `setTimeout` in a file the plan describes as needing "no container,
no network". Well inside `testTimeout: 60_000`
(`app/vitest.config.ts:60`), so it ships either way; but the same injection the
poll got would cost one parameter and make the suite instant.

---

## 14. [LOW] `(a)`'s `HousingChoice` assertion becomes a tautology once the fixture is self-written

S3.1 requires the fixture `index.html` to contain `HousingChoice` "(`:42`)". On
the real `dashboard/dist`, `staticSmoke.test.ts:42` proved the served page was
the dashboard. On a fixture the test writes, it proves the test can read back
what it just wrote. The information is not lost - what `:38`'s (a) half now
proves is that `/` serves the configured dist's `index.html` - but the assertion
should say that with a distinctive marker, the way
`app/test/unitMediaServe.test.ts:174` uses a `MARKER` constant, rather than by
carrying over a product string that no longer means anything here.

---

## 15. [LOW] Snapshot and sweep-mode details the plan leaves to the builder

- S0 step 3 says to LIST the registry rather than prune it (correct - `otherLiveRuns`
  prunes) but does not name the directory. It is
  `app/test/helpers/testRunRegistry.ts:41`:
  `RUN_REGISTRY_DIR = path.join(os.tmpdir(), 'hc-vitest-runs')`. Both
  `RUN_REGISTRY_DIR` and `otherLiveRuns` are exported (`:41`, `:93`), so the
  "if no read-only seam exists" hedge can be replaced with the actual path.
- S0 step 3 and S5 speak of "the sweep's mode" in the singular. There are TWO
  sweeps per run - `sweepPerFileResidue('globalSetup')` on the way in
  (`globalSetup.ts:207`) and `sweepPerFileResidue('globalTeardown')` on the way
  out (`globalSetup.ts:217`) - and the mode is evaluated independently at each
  (`globalTeardown.ts:206`). A run that starts contended and ends quiet has two
  different modes. Record both, or say the entry sweep is the one that matters
  (it is - it is the one that decides what residue this run inherits).

---

## Checked this round and found SOUND

Recorded so round 3, if there is one, does not re-derive it.

- **S7.3's "THREE files" is COMPLETE.** `grep -rn "hccleanrun001"` over all
  tracked files returns exactly `AGENTS.md:156`,
  `docs/issues/npm-test-dynamodb-local-contention.md:103` and
  `docs/issues/_CLUSTERS.md:236` (plus two hits inside `.superpowers/sdd/`
  reference material, which is gitignored records). There is no fourth site.
  D3's finding is fully discharged.
- **Docs-after-gates is otherwise safe.** No test or e2e spec reads a `.md` file
  from disk (`grep -rn "readFileSync|readFile(" app/test e2e` filtered to
  `.md`/`AGENTS`/`docs` returns nothing). `scripts/issues.mjs:88` writes exactly
  one file, `docs/issues/INDEX.md`, which is gitignored at `.gitignore:62`.
  Gate 5's command filters to `'*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs'`, so S7's
  `.md` edits cannot change its file list. The only breach is finding 4.
- **The retried-only scoping is the right fix and is honestly bounded** - see
  finding 2's closing note.
- **Case 17's design is a better answer than D7 asked for.** Exporting the poll
  with injectable interval/ceiling tests the exhaustion path directly and avoids
  adding an options parameter to `ensureTable` - which would have been a
  signature change to the one runtime file the spec's non-goals allow touching.
- **S3's nine-case assignment table is complete and correct.** Seven `it`s in
  the first describe (`:38`, `:50`, `:88`, `:105`, `:111`, `:120`, `:143`) and
  two in the second (`:189`, `:204`); the `:38` SPLIT is the right call.
- **S4's re-sequencing citation is correct.** `groupCrossCheck.test.ts:75` is
  `ensureTable`, `:79` is `deleteTableIfExists`.
- **S1.5's expanded verification set is right.** `dynamo.integration.test.ts:62`
  does assert `resolves.toBe('exists')` on the branch S1.3 rewrites.
- **S7.1's logCallSiteGuard caveat is well-founded.** `vitest.config.ts:44` is
  `maxWorkers: 4`, and the `onTaskUpdate` symptom belongs to the separate RPC
  issue, exactly as the plan now says.
- **The base-commit definition holds.** `5ce9912f` is the merge base and the
  intervening branch commits are docs; S0 and S4 both anchor there consistently.

## Scope check

Nothing above proposes work the spec's "What this mission does NOT do" section
excludes. Findings 2, 5, 6, 7 and 12 tighten specifications for code the plan
already writes; findings 3 and 11 concern test scaffolding the plan already
mandates; findings 1, 8, 9 and 15 concern measurement records; finding 4 is a
naming decision, not new work.
