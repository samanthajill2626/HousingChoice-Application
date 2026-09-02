# Plan review R1 - reviewer D (adversarial, plan-only)

- Plan: `docs/superpowers/plans/2026-09-01-npm-test-soundness.md`
- Spec: `docs/superpowers/specs/2026-08-31-npm-test-soundness-design.md` (v5, terminal)
- Repo state read: worktree `W:\tmp\npm-test-soundness` @ `aaad90d4`, no
  `node_modules` present (S0's install has not run). READ-ONLY review: no
  edits, no suites, no Docker.
- Question answered: if a builder with NO context executes this plan
  LITERALLY, do they produce the spec?

Verdict: **no, not without guessing.** Two findings block correct execution
(one is a plan-internal circular dependency, one is a behaviour change that
arms a new false red on the very gate this mission protects). Five more are
high. Byte-exact reference material, where I accumulated any, is not pasted
here; every claim below cites `file:line` I actually read.

---

## BLOCKING

### 1. S4, S6 and S7 are circularly ordered; the issue closures are written before their evidence exists

The slice table (plan lines 39-48) states `S6` depends on `S1-S5` and `S7`
depends on `S1-S6`. But:

- `S4` (plan:381-383) requires `groupCrossCheck`'s behaviour "across S0's
  baseline and **S7's post-fix runs** (the LOADED arm)". S7 has not run.
- `S6.1` (plan:434-443) decides the anchor's closure on whether "the
  measurements support it" and explicitly reasons about "a mixed
  contended/quiet pair **from S7**". S7 has not run.
- `S6.1` also instructs "strike the superseded suite-A remedy **per S4**" -
  and S4's verdict is not obtainable until S7 has produced its loaded arm.

So S6 consumes S7's output, S7 depends on S6, and S4 sits inside the loop.
There is no "return to S6 after S7" step anywhere; S7.5's handback
(plan:512-515) lists "what each issue closure claims and on what evidence"
as a reporting item, not as a step that may still CHANGE a closure.

**Implication.** A literal builder stamps
`npm-test-dynamodb-local-contention.md`,
`logcallsiteguard-hook-budget-equals-its-own-cost.md` and
`static-smoke-fails-on-stale-dashboard-dist.md` in S6 on baseline evidence
alone, then discovers in S7 that the post-fix arm is QUIET and the anchor
may not close - with the stamp already committed. Or the builder stalls,
because S4's stated deliverable is unreachable. Either way the deliverable
the spec cares most about (Deliverable 2, spec:638-651) is produced from
evidence that does not exist yet.

**Fix shape:** split S6 into S6-pre (the two new issue files, `_CLUSTERS.md`,
`npm run issues`) and S6-post (all three resolution stamps + the AGENTS.md
rewrite), with S6-post AFTER S7's measurement step and BEFORE the handback;
and move S4's verdict into S6-post.

### 2. The new ACTIVE poll fires on the ALREADY-EXISTS path, on every run, and is not gated on either "we retried" or "the endpoint is local"

`ensureTable`'s catch is `dynamoAdmin.ts:90-93`: any `ResourceInUseException`
means `result = 'exists'` and the function returns immediately. That is not
an exotic path - it is the **dominant** one. `createAllTables`
(`db-create.ts:31-51`) loops all ~23 specs through `ensureTable`, and
`globalSetup.ts:117` calls `createAllTables` on **every `npm test`**; the
success line it prints counts `created` vs `existed` (`globalSetup.ts:122-128`)
precisely because "already exists" is the steady state.

The plan (S1.3, plan:166-173) and the spec (spec:137) both state the poll
unconditionally: "On `ResourceInUseException` the catch now polls until
ACTIVE before returning `'exists'`." Nothing scopes it to "an
`InternalFailure` retry actually happened on this call".

Three consequences the plan does not acknowledge:

- **New per-run cost on the gate path.** Every already-existing table now
  issues at least one extra `DescribeTable` in `globalSetup`, ~23 per run,
  against the shared container this mission is measuring.
- **A new way for `ensureTable` to THROW where it used to succeed.** Per
  plan:172-173 the poll's own reads are NOT retried and "a failed read counts
  as 'not ACTIVE yet'", and on exhaustion it rethrows. So a container
  answering `DescribeTable` with `InternalFailure` for 10 seconds - exactly
  the contended condition this mission exists for - converts a previously
  instant success into a hard failure inside `globalSetup`, i.e. a red gate
  for every branch on the machine. That is the mission's own stated failure
  mode ("Arming a new false red while fixing an old one is this mission's own
  failure mode", spec:144-145).
- **It is outside the local-endpoint gate.** The gate (plan:145-148) covers
  the RETRY helper. The poll lives in `ensureTable`'s catch, not in the
  helper, so it also runs against a non-local endpoint - where a table
  legitimately takes far longer than 10s to become ACTIVE. The plan's watch
  item claims "the endpoint gate is the only thing keeping the retry off a
  path that could reach real AWS" (plan:520-521); that is true of the retry
  and false of the poll. No acceptance case covers a non-local
  `ResourceInUseException` - cases 6 and 7 (plan:125-126) are `InternalFailure`
  only.

**Implication.** As written the plan makes the common, previously
zero-cost path slower and newly failable, on the shared harness every other
mission is gated by. The poll must be conditional on "this call retried",
and the acceptance suite needs a case proving the no-retry path still returns
`'exists'` with zero `DescribeTable` sends.

---

## HIGH

### 3. The clean-key recipe lives in THREE files; the plan corrects two

S6.3 rewrites `AGENTS.md` (the paragraph at `AGENTS.md:152-163`) and S6.4
edits `docs/issues/_CLUSTERS.md:235-237`. The identical advice also stands in
the anchor issue itself:

- `docs/issues/npm-test-dynamodb-local-contention.md:100-106` - "**First
  diagnostic for anyone who hits this:** re-run under a clean key. ... If that
  is green, the failure is database residue, not your change."

That is the file S6.1 is stamping. Leaving the recipe intact inside the issue
the mission closes reproduces the exact defect item 1C describes
(spec:322-341), in the document a future reader is most likely to reach for.
Neither spec nor plan names it.

Lower-priority same-class instances exist in prior mission plans
(`docs/superpowers/plans/2026-08-24-error-surface-detail.md:2100`,
`2026-08-26-tour-reminder-ladder.md:60-61,3201-3202`,
`2026-08-27-mms-image-viewer.md:1544`,
`2026-08-28-relay-inbound-caller-identity.md:775-779`). Those are historical
records and are correctly left alone; the ANCHOR is not.

### 4. S3.1's enumeration omits two of the seven `it`s in `staticSmoke.test.ts`

The file has seven cases in the first describe plus two in the second:
`:38`, `:50`, `:88`, `:105`, `:111`, `:120`, `:143`, and `:189`, `:204`.

S3.1 (plan:300-303) enumerates what moves to the fixture: "SPA fallback,
reserved namespaces, hardening headers, both CSP media-bucket shapes, the
runtime `/app-identity/*` endpoints, and the path-traversal probes" - that is
`:105`, `:111`, `:120`, `:189`, `:204`, `:50`, `:143`. **Missing:**

- `:38` `serves index.html at /` - its identity half moves to S3.2's (b), but
  its app-serving half (200, `text/html`, body contains `HousingChoice`) has
  no home in the plan.
- `:88` `redirects the legacy root manifest to the runtime manifest without
  caching` - asserts a 307 to `/app-identity/manifest.webmanifest`, a
  `no-store` header, a non-HTML content type, that the body is not the SPA
  shell, AND a 403 when the origin secret is missing (`:101-102`). It is not
  an `/app-identity/*` endpoint and is not named anywhere in S3.

**Implication.** A literal builder either drops both (silently losing the
legacy-manifest redirect coverage and its origin-secret guard - live app
behaviour, unrelated to the dist problem) or guesses where they go. Note
this is a coverage LOSS the spec's own honest-cost accounting (spec:604-612)
does not mention, because that paragraph only accounts for the BUILT
dashboard's tags.

### 5. The baseline/post-fix pairing is confounded by the mission's own change to the test set - and the plan enumerates confounds only for S5

S5 (plan:417-422) carefully records three confounds for its two arms,
including "arm 2 changes the test SET". The arms that actually gate the
anchor closure - S0's 3 baseline runs (plan:70-73) and S7's 3 post-fix runs
(plan:506-508) - get only the QUIET/CONTENDED label.

But the mission changes the test set between those two arms:

- Today both `staticSmoke` describes are `describe.skipIf(!built)`
  (`staticSmoke.test.ts:28`, `:177`) and the plan states this worktree has no
  `dashboard/dist` (plan:365). So the S0 baseline runs those ~9 cases as
  SKIPS. After S3 they "NEVER skip" (plan:299, :328) - the spec calls this a
  coverage GAIN (spec:522-524). The post-fix arm therefore runs strictly more
  work.
- S3.4 (plan:366-369) leaves a built `dashboard/dist` in the worktree, so
  S3.3's (c) branch also executes in the post-fix arm and did not exist in
  the baseline.
- S2 changes `logCallSiteGuard`'s cost, which is a ~200s single-file
  contributor to the same wall clock (`logcallsiteguard-...md:14-16`).

**Implication.** The wall clock the plan calls "the durable signal"
(spec:410-412) is being compared across two different workloads. Any anchor
verdict drawn from that pair inherits an unnamed bias, on top of the
contended/quiet bias the plan does name. At minimum this belongs in the
record next to the QUIET label; better, S7 should also report a
per-FILE delta so the added staticSmoke work is visible and subtractable.

### 6. S2's only pre-committed cut targets a cost that cannot plausibly dominate, and S6.1 stamps the issue closed regardless

S2.2 (plan:243-254) pre-commits exactly one remedy, for the "scanProgram
dominates" branch: hoist the `legal` test above the eager
`checker.getShorthandAssignmentValueSymbol` call at
`logCallSiteGuard.test.ts:97`. `legal` is `depth === 0 && WIRED.has(keyName)`
(`:96`), so the saving is **one symbol lookup per top-level WIRED shorthand
key in a logger payload** - and only those. Every other checker call in the
scan is `isErrorTyped` -> `checker.getTypeAtLocation` (`:79`), which fires
for every non-legal identifier-valued property in both branches (`:98`,
`:106`) and is the expensive checker operation. The plan explicitly forbids
touching that ("Do NOT 'fix' the `||` ordering at `:98` or `:106` - they
already short-circuit", plan:249-250) - which is a correct observation about
ORDERING but is offered as if it closed the question of whether that call is
NEEDED.

Meanwhile the "buildProgram dominates" branch pre-commits **nothing**
(plan:256-259) and routes back to the planner as an out-of-band decision.
`ts.createProgram` over `app/tsconfig.json`'s `"include": ["src"]`
(verified: `app/tsconfig.json:7`) is the phase most likely to dominate.

So S2's two live branches are (a) a cut with no stated expected saving, and
(b) no cut at all. Yet S6.1 (plan:434-436) lists a resolution stamp on
`logcallsiteguard-hook-budget-equals-its-own-cost.md` **unconditionally** -
the only conditional stamp is the anchor's.

**Implication.** The spec's locked decision 2 is "measure, then cut the cost
- **not a bare budget raise**" (spec:46-47). The plan's most probable
execution path delivers a bare budget raise plus a stop-and-ask, and then
stamps the issue resolved anyway. The stamp for item 2 must carry the same
"only if the measurements support it" condition the anchor has.

### 7. Acceptance case 11 has no injection seam, so it costs >= 10 real seconds inside `npm test` - or requires a design the plan never states

Plan:170-172 fixes the poll at "100ms interval, 10s ceiling" as constants,
and case 11 (plan:130) asserts `ensureTable` "throws at the 10s ceiling,
carrying the observed status". `ensureTable`'s signature is
`(client, spec, physicalName, env)` (`dynamoAdmin.ts:80-85`) - there is no
options parameter, and the plan never adds one. Combined with the helper's
own linear backoff (250/500/750ms, plan:141) the case is a >=10s
wall-clock sleep in a file the plan describes as needing "no container, no
network" (plan:101).

Either the builder adds a timing seam to `ensureTable` (an unenumerated
signature change to the one runtime file the spec's non-goals allow touching,
spec:624) or writes a fake-timer test against real `await`s - a shape the
plan does not specify and which interacts badly with the SDK exception
instances the stub contract mandates (plan:106-109).

**Implication.** The single most expensive acceptance case is
under-specified in exactly the dimension that decides whether it is writable
at all. Specify the seam (e.g. an optional `{ pollMs, ceilingMs }` on
`ensureTable`, defaulted) or specify the fake-timer protocol.

---

## MEDIUM

### 8. The shared helper's signature and RETURN value are unspecified, and one caller consumes the send result

The hook contract table (plan:151-158, spec:210-216) says "returns `true` ->
**return success**, no re-send". For `CreateTable`, `DeleteTable` and
`UpdateTimeToLive` the send result is discarded, so "success" is a bare
resolve. But `DescribeTimeToLive` at `dynamoAdmin.ts:128-130` destructures
`TimeToLiveDescription` off the response, and S1.3 (plan:175-178) puts that
send through the helper too. In the hook-returned-true branch there IS no
response object to return.

Nothing states whether the helper is generic over the command output, whether
it returns `T | undefined`, or how `enableTtlIfNeeded` handles `undefined`.
Three revisions of this spec were spent nailing the hook's INPUT semantics;
its output type is still a guess.

### 9. Two specified behaviours have no acceptance case

- **`DescribeTimeToLive`'s pre-send retry.** S1.3 bullet 3 (plan:175-178)
  says the pre-send guard "is retried like any other send", and the spec's
  own per-command table (spec:140) marks `DescribeTimeToLive` as "none -
  read-only / -". Nothing in the 11 cases exercises it. A builder can ship
  this half of the design inert.
- **The attempt bound.** `attempts: 4` (plan:141) is asserted by no case.
  Case 1 uses two failures then success; case 11 exercises the POLL ceiling,
  not the retry ceiling. Nothing pins that a 4th consecutive `InternalFailure`
  throws rather than loops, nor the exact `send` count on exhaustion - the
  classic off-by-one in `attempt >= attempts` (the existing form is
  `db-update-gsis.ts:117`).

### 10. "Record which mode `sweepLedgerResidue` took" is not observable

S0.4 (plan:72-73) and S5 (plan:414-415) both require recording the sweep's
mode per run. The only emission is `globalSetup.ts:166-175`, and it is
guarded by `if (swept.tables > 0 || swept.spared > 0)`. On a clean machine -
the normal case, and the case the plan expects for the QUIET arm - **nothing
is printed at all**, so mode is indistinguishable from "sweep found nothing".
The decision itself is at `globalTeardown.ts:205-206` and is never logged.

S0 additionally requires the tree stay unedited (plan:80), so the builder
cannot add the log line. This is a step with no observable outcome.

### 11. The `globalSetup` TTL re-enable is filed as fact but verified by nobody

S6.2 item 1 (plan:447-457) files a Tier-2 issue asserting that
`DYNAMO_DISABLE_TTL=1` never reaches `globalSetup`, so `enableTtlIfNeeded`
turns the reaper on for ~23 shared tables every run. The evidence offered is
`globalSetup.ts:90-92`'s comment - which is about `AWS_ACCESS_KEY_ID`, not
about `DYNAMO_DISABLE_TTL`. The generalisation is plausible (`vitest.config.ts:72-120`
sets both in the same `test.env` block; `ensureTable` defaults `env` to
`process.env` at `dynamoAdmin.ts:84`) but it is an INFERENCE, and no task in
the plan checks it.

This is not cosmetic: the same claim is what makes item 1A's `UpdateTimeToLive`
/ `DescribeTimeToLive` work non-inert on the `npm test` path (spec:110-119).
If it is false, two of the four call sites S1 covers are dead code under the
gate, and a new Tier-2 issue asserts something untrue. One `console.log` in a
throwaway probe settles it; the plan should require the check before filing.

### 12. S2.1's "otherwise-quiet machine" precondition contradicts S0's premise, and the dependency table hides it

S2.1 (plan:235-236) requires timing "on an otherwise-quiet machine, file
alone, 3 runs". S0's whole justification is that the neighbouring missions
are still running and "the baseline is only worth taking while [they] are"
(plan:35-37). The table (plan:39-48) says S2 depends on S0 and that "S1, S2
and S3 are independent of each other" - which reads as "S2 may start as soon
as S0 finishes", i.e. while the machine is still loud.

The plan never sequences the quiet requirement, never says what to do if the
machine is still contended, and S2.4's budget arithmetic (>=4x measured,
ceiling 600s) is sensitive to exactly that: a contended measurement near 150s
pushes 4x past the ceiling and triggers the plan's "stop and report" branch
for the wrong reason.

### 13. S4's solo arm straddles S1's change to `groupCrossCheck`'s own setup path

S4 says "Do not edit `app/test/groupCrossCheck.test.ts` in this slice"
(plan:379) and depends only on S0. But that file imports and uses
`ensureTable` and `deleteTableIfExists` (`groupCrossCheck.test.ts:30`), both
of which S1 changes. The plan does not say whether the 10 solo runs happen
before or after S1, and the loaded arm necessarily comes from S7 (post-S1).
Two arms of one question, potentially against two different code states, with
the ordering left to the builder.

### 14. The issue's SECOND named failure mode is untouched by a budget raise

`logcallsiteguard-hook-budget-equals-its-own-cost.md:18-19` names the failure
as `Hook timed out in 180000ms` "usually accompanied by
`[vitest-worker]: Timeout calling "onTaskUpdate"`". The second string is
birpc's 60s coordinator timeout, documented in this repo at
`vitest.config.ts:16-22` as producing a NON-ZERO exit with ZERO failing
tests. Raising a `beforeAll` budget cannot address a CPU-bound file starving
the coordinator; that is why `maxWorkers: 4` exists.

Neither spec nor plan mentions it, yet S6.1 stamps the issue resolved. If the
cut does not materially reduce the file's CPU time (see finding 6), the
accompanying symptom survives the "fix".

### 15. The fixture cannot be written in a `beforeAll` given `staticSmoke`'s current shape, and cleanup is never mentioned

`staticSmoke.test.ts:29-36` calls `buildApp`/`loadConfig` in the DESCRIBE
BODY, i.e. at collection, before any `beforeAll` runs. Of the two precedents
the plan cites (plan:300-301), only `unitMediaServe.test.ts:171-178` is
compatible - it writes the fixture in `beforeAll` and builds the app lazily
per test via `fullApp()`. `devGating.test.ts:249-251` writes the fixture
INSIDE the single `it`. Neither shape drops in without restructuring
`staticSmoke`'s app construction, and the plan names both as if
interchangeable.

Both precedents also clean up (`devGating.test.ts:274`,
`unitMediaServe.test.ts:177-179`). The plan mandates writing a fixture dir
plus a real asset into it (plan:321-325) and never mentions `rmSync` - so a
literal execution leaks an `os.tmpdir()` directory on every `npm test`, on
every branch, forever.

---

## LOW

### 16. Several citations point at prose, not code

- `globalTeardown.ts:20-25` (plan:419, spec:353) is cited for
  "`sweepLedgerResidue` runs on the way IN". Lines 20-25 are a comment
  paragraph. The call is `globalSetup.ts:211`; the function is
  `globalTeardown.ts:189-226`.
- `globalTeardown.ts:33-45` (plan:73, plan:420, spec:357) is cited for the
  mode decision. Lines 34-46 are the CONCURRENCY comment; the decision is
  `globalTeardown.ts:205-206`.
- Plan:311 says the `HousingChoice` assertion is at `:41`. `:41` is the
  content-type check; `HousingChoice` is `:42`.
- The anchor issue's own `dynamoAdmin.ts:153` (`npm-test-...contention.md:472`)
  is stale - that file is 151 lines and contains no `UpdateTableCommand`. If
  S6.1 is editing the file anyway, worth correcting.

These do not change any decision, but a plan whose whole method is
"cite what you read" should not send the builder to comment text.

### 17. S0's pass criterion contradicts S0's own instruction

S0 requires writing `<records>/measurements/s0-baseline.md` and committing it
(plan:76-78), then states the observable pass/fail as "the file exists ...
and the tree is still unedited (`git status` clean)" (plan:79-80). Only true
if read as "clean AFTER the commit". Say so.

### 18. "the base commit" is undefined

Plan:5-6 says the branch is cut from `main` @ `5ce9912f`; the worktree HEAD
is `aaad90d4` (`docs(m7): implementation plan...`). S0.4 says "3 full
`npm test` runs at the base commit, unedited tree" without saying which, and
S7.4 says "run the full suite at the merge base". They are code-identical
today, but the handback pairing should name one.

### 19. The "no decoys" argument rests on an unpinned transitive dependency

Plan:315-318 and spec:541-545 settle the traversal-decoy question on
`node_modules/send/index.js:61` and its test at `:431`. This worktree has no
`node_modules`, so I could not verify either line - **UNVERIFIED**. `send` is
a transitive dep of `express`; the reasoning is sound in the abstract, but if
the shipped comment cites those line numbers it will rot on the next
`send` bump. Cite the behaviour, not the line.

### 20. `_CLUSTERS.md`'s M7 row also goes stale, and S6.4 only fixes the clean-key sentence

`docs/issues/_CLUSTERS.md:231` still describes the anchor as "suite A
latency-robust assertions, suite B retry `UpdateTable` on `InternalFailure`".
The spec establishes that suite B's retry already exists (spec:32-36,
verified at `db-update-gsis.ts:103-127` applied at `:227`), and S4 may strike
suite A's remedy. S6.4 (plan:478-482) only supersedes the clean-key advice at
`:235-237`.

### 21. The contention snapshot mutates the shared registry it reads

Plan:64-65 has the builder read live vitest runs "via
`app/test/helpers/testRunRegistry.ts`". `otherLiveRuns()` PRUNES dead markers
as a side effect (`testRunRegistry.ts:116-122`), so an out-of-band snapshot
writes to a machine-global directory (`RUN_REGISTRY_DIR`, `:41`) that the
other missions' sweeps read. Harmless (pruning a dead marker is what any run
does) but worth knowing, and the plan gives no invocation seam - the file
exports functions, not a CLI. A plain listing of
`os.tmpdir()/hc-vitest-runs` is the read-only equivalent.

---

## What I checked and found SOUND

Recorded so a later round does not re-derive it:

- The mandated enumeration grep (plan:92) returns 31 sites; I ran it. Every
  one is dispositioned by the spec's rule (spec:84-108) - the reads in
  `devReset.ts:42`, `dynamoKeyLedger.test.ts`, `globalSetupEnsure.test.ts`,
  `globalTeardown.ts:119/132`, `unreadIndexRepo.integration.test.ts:756/771`
  and `scripts/wipe-dev-data.mjs:170` all fall under "reads not covered"; the
  three test-owned mutating sites are the three the spec names. No orphan.
- The five PWA conditions in S3.2 all hold against `dashboard/index.html:11-13`
  as written, including both negatives (`href="/app-identity/manifest.webmanifest"`
  does not contain `href="/manifest.webmanifest"` as a substring).
- S2.3's argument is correct: `app/tsconfig.json:7` is `"include": ["src"]`,
  so `sourceCount > 50` (`logCallSiteGuard.test.ts:149`) genuinely cannot
  subsume the TS2307 probe.
- S2.1's read of the hook is correct: `beforeAll` at `:140-143` is exactly
  `buildProgram(true)` + `scanProgram`; `ts.getPreEmitDiagnostics` is at
  `:152`, inside the first `it`.
- S2.2's warning about `:109` is correct - the nested-object recursion is
  outside the `!legal` guard and must stay that way; and the shorthand branch
  has no recursion, so the early skip there is safe.
- `express.static(distDir)` is mounted at the root (`app/src/app.ts:284`), so
  S3.1's positive-control asset can live anywhere under the fixture.
- `npm run smoke` does build only the app workspace (`package.json:68`), so
  spec:512-513's claim that it cannot fix the dist problem holds.
</content>
</invoke>
