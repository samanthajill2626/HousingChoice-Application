# r1 adversarial code review - feat/npm-test-soundness @796b8632

Reviewer: adversarial, fresh eyes. Inputs: the r1 diff package and the repository
only. Merge base `5ce9912f`. Verbose evidence (transcripts, throwaway
reproductions) is in the gitignored
`.superpowers/review/r1-adversarial-evidence.md`; this file cites code by
`file:line`.

## Intended behaviour, as derived from the code

`npm test` cannot be trusted for two unrelated reasons, and the branch attacks
both.

1. Under concurrent load DynamoDB Local answers CONTROL-PLANE calls with
   `InternalFailure` or with an `InternalServerError` lock timeout. Neither is a
   rejected request and neither is covered by the SDK's retry policy, so both
   escape and fail whatever gate is running. `app/src/lib/dynamoAdmin.ts` grows
   one retry loop (`retryLocalControlPlane`, `:190`) with two public entry
   points: `sendWithRetry` (`:241`) for a send whose re-send is harmless, and
   `sendWithRetryVerified` (`:265`) for one whose re-send is not, which REQUIRES
   a hook answering "did the failed attempt land?" and fails CLOSED when that
   hook throws. The loop only ever fires against a localhost endpoint
   (`isLocalDynamoEndpoint`, `:163`), fail-closed, so real AWS is untouched.
   `ensureTable`, `deleteTableIfExists` and `db-update-gsis.ts`'s `ensureGsis`
   are moved onto it; `ensureGsis` keeps its own fail-OPEN tolerance inside its
   own hook. `pollUntilTableActive` (`:307`) replaces the SDK waiter for the
   accepted-but-unanswered CreateTable case. `test/dynamoAdminRetry.test.ts` is
   a 17-case, no-container acceptance suite that exists so the retry cannot ship
   inert.
2. `staticSmoke.test.ts`'s colour tracked a gitignored build artifact. It is
   re-split so app-serving behaviour runs against a temp fixture dist and never
   skips, the PWA identity contract asserts against the TRACKED
   `dashboard/index.html` and never skips, and the real-build check is a
   diagnostic that can only PASS or SKIP. The coverage that costs is filed as
   `docs/issues/built-dashboard-identity-tags-unasserted.md`.

`logCallSiteGuard.test.ts` is comments only: it records the measured 6.5s hook
cost against its 180s budget and argues the headroom is deliberate. No defect
found there; the reasoning is sound and the "solo cost is a LOWER bound" argument
is correct.

---

## FINDINGS

### 1. BLOCKER - CONFIRMED - `app/test/dynamoAdminRetry.test.ts:1` (whole file)

**Claim.** The branch's own new acceptance suite trips the repo's per-file
DynamoDB-key guard, so `npm test` is RED on this branch. On a mission whose
subject is `npm test` soundness, gate 2 does not pass.

**Failure scenario.** `app/test/setup/dynamoAccessKeyGuard.test.ts:277-293`
enumerates every app test file, flags any whose SOURCE TEXT matches
`ensureTable|CreateTableCommand|createAllTables|ensureKeyedLocalTables`, and
requires such a file to either carry the shared-tables marker, carry the
worktree-derived-keys marker, or build its table names with
`randomUUID`/`Math.random`. `dynamoAdminRetry.test.ts` imports `ensureTable`
(`:39`) and `CreateTableCommand` (`:24`), carries neither marker and uses neither
random source, so it is reported as the sole offender and the assertion at
`app/test/setup/dynamoAccessKeyGuard.test.ts:305` fails. Deterministic; needs no
container contention and no concurrency.

Substantively the guard is a false positive - the new suite is a pure stub suite
that sends nothing to any container - but the gate failure is real. Note the
guard file is NOT in the branch diff, and the offender list contains only the
branch's own new file, so attribution is unambiguous.

**Verified.** `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` from
`W:\tmp\npm-test-soundness\app`: 1 failed / 13 passed, offender
`app/test/dynamoadminretry.test.ts`. Full transcript in evidence E1.

**Fix shape.** Add the `hc:dynamo-lane worktree-derived-keys` (or shared) marker
declaration to the new file with a one-line comment saying it creates no
container tables at all - or, better, widen the guard's predicate so a suite that
never constructs a real client is not caught. Either way, re-run the guard file.

---

### 2. MUST-FIX - CONFIRMED - `app/src/lib/dynamoAdmin.ts:481`

**Claim.** `deleteTableIfExists` now swallows `ResourceInUseException`
UNCONDITIONALLY - on the very first attempt, with zero retries, on any endpoint
including a non-local one. The comment immediately above it (`:478-480`)
justifies the tolerance only for "A retried DeleteTable ... which means attempt 1
landed". The code does not encode that condition. This is a contract enforced by
comment, and it is the exact discipline `ensureTable` applies correctly two
functions earlier (`:353`, `:380` gate the poll on a per-call `retried` flag
fed by `onRetry`). `deleteTableIfExists` threads no such flag.

At the merge base the catch rethrew everything except
`ResourceNotFoundException`, so this is a behaviour change for every one of ~50
test callers plus `app/scripts/db-create.ts:63` and `:75`.

**Failure scenario.** `app/test/importApply.integration.test.ts:72-77` is a
`beforeAll` that, for all 22-23 specs, does `deleteTableIfExists` then
`ensureTable`. Interleaving: another worktree's `globalSetup` (or a
`db:update-gsis` GSI backfill on an e2e lane) leaves table `T` in CREATING or
UPDATING. `DeleteTable T` -> `ResourceInUseException` -> HEAD returns as if the
table were gone -> `ensureTable T` -> `CreateTable` -> `ResourceInUseException`
-> `retried` is false so no poll -> returns `'exists'` -> the suite proceeds
against a table still carrying the PREVIOUS run's rows. Base behaviour was to
throw out of the hook naming the resource conflict. The same swallow in
`dropAllTables` defers the failure to the `waitUntilTableNotExists({maxWaitTime:
60})` on the very next line, so `db:create --reset` now spends 60s and fails at
the waiter rather than immediately at the real cause.

**Verified.** Throwaway stub client with hostname
`dynamodb.us-east-1.amazonaws.com` whose first `send` throws
`ResourceInUseException`: `deleteTableIfExists` resolved after exactly one send.
Evidence E2.

**Why the acceptance suite cannot catch it.** Case 4
(`app/test/dynamoAdminRetry.test.ts:258-268`) scripts
`[internalFailure, resourceInUse]` - only the retried path. A correctly gated
implementation passes case 4 identically. There is no case for an un-retried
`ResourceInUseException`, which is precisely the case that changed.

**Fix shape.** Give `deleteTableIfExists` the same `onRetry` -> `retried` thread
`ensureTable` uses, and swallow `ResourceInUseException` only when `retried` is
true. Add the missing acceptance case (un-retried conflict must still throw).

---

### 3. MUST-FIX - CONFIRMED - `app/test/staticSmoke.test.ts:212-247` (comment at `:213-225`, fixture root at `:70`)

**Claim.** Moving the fixture dist to `mkdtempSync(os.tmpdir(), ...)` made the
six encoded path-traversal probes unfalsifiable. Every resolved target
(`<tmp>/../../package.json`, `<tmp>/../../etc/passwd`) is a path that does not
exist, so the three "must not contain" assertions hold no matter what the static
layer does. The comment at `:214-217` explicitly claims the probes are worth
keeping because "A future static-serving change could lose that property" - they
cannot observe that loss. That is a dead safeguard advertised as a live one, and
it is a REGRESSION: at the base the fixture root was the repo's `dashboard/dist`
and `../../package.json` was, in the base comment's own words, "the realistic
exfiltration target on this exact tree".

**Failure scenario.** Someone replaces `express.static` at
`app/src/app.ts:284` with a hand-rolled sender that resolves the decoded request
path itself (a realistic refactor - adding cache headers, a custom 404, an
asset-hash rewrite). The app now serves arbitrary files above the dist root. All
six probes still pass, because there is nothing to leak under `os.tmpdir()`.

**Verified.** Built exactly that leaky static layer in a throwaway file and ran
the EXACT probe list and assertion block from `:227-246` against it twice: rooted
at an mkdtemp dist, 0 assertion failures; rooted at `dashboard/dist` (the base's
root), 4 assertion failures. Evidence E3.

**Fix shape.** Either write a decoy file into the fixture at the depth the probes
target (`<distDir>/../../package.json`-shaped, created and removed by the same
`beforeAll`/`afterAll`), which restores falsifiability without depending on the
repo layout; or delete the probes and say plainly in the issue that this
composition is no longer pinned. Keeping them with the current comment is the one
option that misleads.

---

### 4. SHOULD-FIX - PLAUSIBLE - `app/src/lib/dynamoAdmin.ts:190-230` (bound at `:139`, backoff at `:201`)

**Claim.** The retry bounds ATTEMPTS but not ELAPSED TIME, and one of the two
faults it retries is by construction expensive to produce. The module's own
comment (`:84-88`) identifies the second signature as DynamoDB Local's per-table
`tryLock(10s)` expiring, and `:141-144` reuses that same 10s figure. So each
attempt against that fault blocks the caller ~10s; four attempts plus 1.5s of
linear backoff is ~41.5s, before `pollUntilTableActive` can add up to 10s more.

**Failure scenario.** `hookTimeout` is 60_000 (`app/vitest.config.ts:71`). Hooks
that loop over the whole table manifest inside one budget are common -
`app/test/importApply.integration.test.ts:72-77` (22-23 specs, 60s),
`app/test/inbox.integration.test.ts:78`,
`app/test/messaging.integration.test.ts:75`,
`app/test/statusTransition.integration.test.ts:76`. One contended table is enough
to exhaust the hook, and the message becomes `Hook timed out in 60000ms`, which
names no cause. At base the same fault surfaced at ~10s naming
`InternalServerError`. The branch therefore trades a diagnosable red for an
undiagnosable one in exactly the contended condition it was written for - and
`app/test/logCallSiteGuard.test.ts:138-155` in this same diff argues at length
that a `Hook timed out` failure under load is the shape to design against.

**Verified.** By code and by the diff's own stated 10s figure; not measured
against the container (measuring it would require deliberately contending the
shared container, which is out of scope for a read-only review).

**Fix shape.** Add an overall deadline to `RetrySchedule` (e.g. `deadlineMs`,
default ~15s) checked before each re-send, so the loop gives up while the caller
can still report the real error. `sendWithRetry`/`sendWithRetryVerified` already
take a schedule, so this needs no caller change.

---

### 5. SHOULD-FIX - PLAUSIBLE - `app/src/lib/dynamoAdmin.ts:144` vs `app/scripts/db-update-gsis.ts:115`

**Claim.** The diff contains two contradictory statements about how long a local
table can legitimately stay non-ACTIVE, and the stricter one converts a
previously-successful path into a hard failure. `dynamoAdmin.ts:141-144` argues
"a table that is still not ACTIVE after 10s locally is not going to become so
inside the same test hook" and sets a 10s ceiling.
`db-update-gsis.ts:112-115`, in the same diff and about the same DynamoDB Local,
says a local index create "legitimately takes minutes" and budgets 900_000ms.

**Failure scenario.** `ensureTable` is called for a shared `hc-local-` table that
another worktree's `globalSetup` is concurrently creating, or that
`db:update-gsis` is backfilling a GSI on (`scripts/e2e-session.mjs:690` runs it
on every lane start). Attempt 1 draws `InternalFailure` -> `retried` = true ->
attempt 2 draws `ResourceInUseException` -> `ensureTable:380` polls -> the table
is genuinely CREATING/UPDATING for longer than 10s -> `TableNotActiveError` ->
`:387` rethrows the conflict with the poll message appended. At base this exact
interleaving returned `'exists'` and the suite ran. Note also that
`pollUntilTableActive:321` swallows every read error into `observed =
'unreadable'`, so a container that is still buckling burns the whole 10s and then
fails with a status that names nothing.

**Verified.** By code reading and by the two comments' mutual contradiction; not
reproduced against a container.

**Fix shape.** Reconcile the two figures, and treat "still CREATING at the
ceiling" as a reason to return `'exists'` (the base behaviour) rather than to
fail, or raise the ceiling to something that matches `db-update-gsis`'s own
account of local backfills.

---

### 6. SHOULD-FIX - PLAUSIBLE - `app/src/lib/dynamoAdmin.ts:355-364` with `:366-391`

**Claim.** `ensureTable`'s recovery for "the server accepted attempt 1 and only
its response was lost" works ONLY when the FINAL error of the retry loop is
`ResourceInUseException`. `CreateTable` deliberately uses `sendWithRetry` with no
verification hook, so the loop itself never asks whether the create landed; the
knowledge lives entirely in the downstream `instanceof ResourceInUseException`
catch. If attempts 2-4 also return `InternalFailure` - the very fault being
retried, on a container that is buckling for more than a moment - the loop throws
`InternalFailure`, the catch at `:367` rethrows it, and a run whose table WAS
created fails anyway. That is the same class of outcome the module comment at
`:94-101` says the design exists to eliminate; it is eliminated for
`UpdateTimeToLive` and `UpdateTable` (both hooked) but not for `CreateTable`.

**Failure scenario.** Local endpoint, contended container. CreateTable attempt 1
-> `InternalFailure`, request accepted. Attempts 2, 3, 4 -> `InternalFailure`
(the container is still buckling; nothing makes attempt 2 return
`ResourceInUseException` rather than another `InternalFailure`). `ensureTable`
throws, the hook fails, and the table is sitting there ACTIVE.

**Verified.** By code reading. Not a regression against the base (the base failed
on the first `InternalFailure`), but it is coverage the comments claim.

**Fix shape.** Give the CreateTable send a verification hook - a `DescribeTable`
answering "does this table now exist in CREATING/ACTIVE?" - which is exactly what
`sendWithRetryVerified` is for, and then keep the `ResourceInUseException` catch
for the plainly-pre-existing case. Add an acceptance case where every attempt
fails with `InternalFailure` and the table nevertheless exists.

---

### 7. NOTE - CONFIRMED - `docs/issues/static-smoke-fails-on-stale-dashboard-dist.md:6`

**Claim.** That issue is still `status: open` and untouched by the branch, but
its stated defect ("Absent dist -> clean skip ... Stale dist -> the suite runs
and fails") is exactly what this branch removes; the branch's own commit message
for `a9b7124d` describes fixing it. The new issue file
`docs/issues/built-dashboard-identity-tags-unasserted.md:56` links it only as
"Related". A reader hitting the open issue will re-diagnose a fixed bug.

**Verified.** Read both issue files; the stale-dist file is absent from
`git diff --stat 5ce9912f..796b8632`.

**Fix shape.** Close it (or set it to resolved with a pointer to this branch and
to the new issue) in the same change.

---

### 8. NOTE - CONFIRMED - `app/src/lib/dynamoAdmin.ts:349` / `:369`

**Claim.** On the retried-and-it-landed path, `ensureTable` returns `'exists'`
for a table THIS call in fact created. The comment at `:371-375` acknowledges the
conflict means "still CREATING" from our own accepted attempt 1, yet `result` was
already set to `'exists'` at `:369`. `app/scripts/db-create.ts:43-46` then prints
`exists - skipped` for a table it just created, and
`app/test/dynamo.integration.test.ts:47` reads the same value. Cosmetic today,
but it makes the return value unreliable for anything that branches on it.

**Verified.** Code reading; acceptance case 2
(`app/test/dynamoAdminRetry.test.ts:243`) pins the current value, so a fix has to
change that expectation deliberately.

---

### 9. NOTE - CONFIRMED - `app/test/staticSmoke.test.ts:76-78`

**Claim.** `afterAll` calls `rmSync(distDir, ...)` unguarded. If `mkdtempSync` at
`:70` throws (a full or read-only temp volume), `distDir` is `undefined` and
`rmSync` throws a TypeError from the teardown, adding a second, louder failure
that buries the real one. Also, nothing cleans the temp directory if the vitest
worker is killed - a tree-kill teardown leaves `hc-static-smoke-*` directories in
`os.tmpdir()` indefinitely.

**Verified.** Code reading. The happy path is clean: the file ran 12/12 green and
left no residue.

**Fix shape.** Guard the `rmSync` on `distDir` being set.

---

## Consumers swept

Grepped the WHOLE repo (excluding `node_modules` and `docs/superpowers`), not
just the diff.

- **`ensureTable`** - 1 product caller (`app/scripts/db-create.ts:36`) and ~50
  test callers across `app/test/`. All pass 4 or fewer arguments, so the new 5th
  `opts` parameter is backward compatible. CLEAN except as reported in findings
  2, 4, 5, 6 and 8. The concurrent caller the code comment names
  (`app/test/todayUnmatchedNonRegression.test.ts:105-109`, `Promise.all` over
  several specs) is correctly served by the PER-CALL `retried` flag - I checked
  for module-level state and there is none.
- **`deleteTableIfExists`** - `app/scripts/db-create.ts:63` and `:75` plus ~50
  test files. Behaviour changed for all of them; see finding 2.
- **`ensureGsis`** - callers are the CLI block at `app/scripts/db-update-gsis.ts:253`
  (4 args) and `app/test/dynamoAdminRetry.test.ts:423`/`:443` (5 args). The new
  5th parameter is backward compatible. The e2e lane driver invokes it as a
  script (`scripts/e2e-session.mjs:690`), which goes through the CLI endpoint
  gate first, so the newly added local-endpoint gate inside `ensureGsis` cannot
  change lane behaviour. The old code's fail-OPEN tolerance (a describe that
  itself fails means re-send) is preserved inside `indexStatus`
  (`app/scripts/db-update-gsis.ts:71-84`) and pinned by acceptance case 16 - I
  checked that the move to a fail-CLOSED helper did not swallow it. CLEAN.
- **`gsiInput` / `toCreateTableInput` / `gsiAttributeDefinitions`** - unchanged
  bodies; importers are `db-update-gsis.ts` and
  `app/test/unreadIndexRepo.integration.test.ts:27`. CLEAN.
- **DynamoDB client construction** - `app/src/lib/dynamo.ts:61-79` is the only
  factory. It passes an explicit `endpoint` string whenever
  `config.dynamodbEndpoint` is set and omits it entirely otherwise, which is what
  makes `isLocalDynamoEndpoint` (`app/src/lib/dynamoAdmin.ts:163`) decide
  correctly in both directions; acceptance case 13 pins that against a REAL
  `DynamoDBClient`. The predicate fails closed on a missing provider, a throwing
  provider and any other hostname (case 14), and it is only consulted AFTER a
  retryable fault, so the no-fault hot path never resolves the endpoint. No path
  I could find lets the retry reach a real AWS endpoint. CLEAN.
- **Security of the new local-only surface** - the retry adds only re-sends of
  the same control-plane command to the same client; it opens no new endpoint, no
  new credential path, and `app/src/lib/dynamo.ts`'s dummy-credential branch is
  untouched. CLEAN. (The one ungated widening is a SWALLOW, not a send - finding
  2.)
- **`DASHBOARD_DIST_DIR` / `dashboard/dist`** - other readers are
  `app/src/app.ts:234`, `app/src/lib/config.ts:1323`,
  `app/test/devGating.test.ts:256` and `app/test/unitMediaServe.test.ts:186`
  (both of which build their own temp dist and are unaffected), `Dockerfile:30-67`
  and `infra/modules/cloudfront/main.tf:184`. Nothing depends on the old
  `staticSmoke` shape or on its removed `describe.skipIf` guard. The `app.ts:284-296`
  claim the new comment at `staticSmoke.test.ts:51-54` makes (an
  `express.static` miss falls through to a 200 SPA shell) is accurate. CLEAN
  except finding 3.
- **Meta-guards that read the test tree** - only one exists,
  `app/test/setup/dynamoAccessKeyGuard.test.ts`; it is the blocker in finding 1.
  I checked for others (`allAppTestFiles`, directory walks over the test dir) and
  found none.
- **Acceptance-suite vacuity** - I probed each case for a mutation it would not
  catch. Cases 2, 3, 11, 12, 15, 16 and 17 are all non-vacuous (removing the
  poll, the `retried` gate, the endpoint gate, or the caller-side tolerance makes
  each fail). The one genuine gap is case 4, which cannot distinguish a gated
  from an ungated `ResourceInUseException` tolerance - see finding 2. Note also
  that `app/vitest.config.ts` disables the TTL reaper for the whole run, so cases
  5-10 exercise a path no real `npm test` caller reaches; that is fine (they test
  the helper, and `db:create` and the e2e lanes do reach it) but worth knowing.
- **`logCallSiteGuard.test.ts`** - comments only, verified against the diff. The
  added claim that `sourceCount` is not redundant with the TS2307 check is
  correct: `app/tsconfig.json` includes `src`, so every file is a program root
  and is counted regardless of whether its imports resolve. CLEAN.
- **ASCII / AGENTS.md editing rules** - scanned all six changed source and issue
  files for characters above 0x7E. The only hit is a pre-existing em dash on
  `app/src/lib/dynamoAdmin.ts:1`, which is not on an added line, so the
  added-lines-only ratchet holds. CLEAN.
