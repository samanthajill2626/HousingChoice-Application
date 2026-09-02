# r2 adversarial code review - feat/npm-test-soundness @b783804a

Round 2. Inputs: the r2 fix diff (`2876b205..b783804a`), the r2 full diff vs
merge base, `r1-adjudications.md`, `r1-fix-wave.md` and the repository. Spec,
plan and worklist remain withheld. Verbose evidence, transcripts and throwaway
reproductions are in the gitignored
`.superpowers/review/r2-adversarial-evidence.md`; this file cites `file:line`.

Headline: the wave closes A1, A2, A3 and A9 for real - I re-ran all three of my
round-1 reproductions against the new tip and each flipped. But the A4 deadline,
which was NEW code written to satisfy my own finding, reintroduces the exact
hazard the module was built around, and it does so on a path that fires earlier
than the bound it supplements.

---

## NEW FINDINGS

0 blocker / 1 must-fix / 4 should-fix / 4 note.

### N1. MUST-FIX - CONFIRMED - `app/src/lib/dynamoAdmin.ts:238`

**Claim.** The new elapsed-time deadline is checked BEFORE the verification
hook, so a deadline expiry throws the container fault without ever asking
whether the mutation landed. That is precisely the failure the module's header
comment (`:94-101`) says the whole design exists to eliminate: "the case the
retry exists for is the server ACCEPTING attempt 1 and only its RESPONSE
failing". The hook is one cheap read and cannot loop; there is no reason for the
deadline to skip it.

It is worse than the attempt bound it supplements, on two axes. It can fire on
attempt 2 of 4, so it reaches the blind spot EARLIER. And it fires preferentially
on the slow lock-timeout signature - the fault where the server spent ~10s doing
work and is therefore the MOST likely of the two to have accepted the request.

**Failure scenario.** `ensureGsis` (`app/scripts/db-update-gsis.ts:197-212`),
default `deadlineMs` 20_000, the ~10s-per-attempt lock timeout the module itself
prices at `app/src/lib/dynamoAdmin.ts:84-88`. t=0 attempt 1 sent; t=10.0s lock
timeout, 10000 < 20000 so continue, verify says the index is absent, re-send;
t=10.3s attempt 2 sent and the server ACCEPTS it, starting the backfill; t=20.4s
its response fails with `InternalFailure`; n=2 < 4, but 20400 >= 20000 -> throw,
hook never called. `ensureGsis` propagates, `scripts/e2e-session.mjs:690`'s
`runOnce('db-update-gsis')` fails and the lane start dies while the index is in
fact being created. The same shape in `enableTtlIfNeeded` (`:465-486`) fails a
`beforeAll` for a TTL that is enabling.

**Verified.** Throwaway stub, local endpoint, TTL spec, `deadlineMs: 20`, a
30ms `UpdateTimeToLive` that throws `InternalFailure`, and a
`DescribeTimeToLive` script whose SECOND read would report `ENABLED` (i.e. it
landed). Result: `ensureTable` rejected with `InternalFailure` and the
`DescribeTimeToLive` count stayed at 1 - the pre-send guard only. The hook never
ran. Evidence N1.

**Fix shape.** Move the `:238` check to after the verify block at `:241-253`
(or immediately before `onRetry` at `:254`). One line. Add an acceptance case:
deadline expired AND the hook would say landed -> resolves.

---

### N2. SHOULD-FIX - CONFIRMED - `app/test/setup/dynamoAccessKeyGuard.test.ts:105` (check at `:370-405`)

**Claim.** The new third marker's rot-proof check is text-only on the declaring
file and cannot see a helper that creates tables on that file's behalf, so the
marker is gameable in exactly the direction the check exists to prevent. The
adjudication's stated design ("a rot-proof check that a `none` suite does not
import `../src/lib/dynamo.js`, the only container-reaching client factory") rests
on a premise that is false: `app/scripts/db-create.ts:31` exports
`createAllTables`, which builds its own client and creates all 22 specs under
FIXED `tableName(spec.baseName)` names.

**Failure scenario.** A suite declares `// hc:dynamo-lane none`, imports
`createAllTables` from `../scripts/db-create.js`, and calls it. The
creates-tables guard is short-circuited by the marker at `:349`; the rot-proof
case at `:370` finds no `CONTAINER_REACHING` match, because the import specifier
ends `/db-create.js` not `/dynamo.js` and `createAllTables` is not one of the
three constructor names it lists. The suite then creates 22 fixed-name
`hc-local-` tables in a per-file database that is shared across worktrees - the
cross-worktree collision this guard was written for.

Related, and evidence that the comment at `:96-104` overstates: the declaring
suite already reaches `src/lib/dynamo.js` transitively today -
`app/test/dynamoAdminRetry.test.ts:48` imports `../scripts/db-update-gsis.js`,
which imports `createDynamoClient` at `app/scripts/db-update-gsis.ts:34`.
Harmless (both CLI blocks are argv-gated) but it shows the check is a statement
about source text, not about the module graph.

**Verified.** Throwaway file carrying a bare `// hc:dynamo-lane none`
declaration line plus imports of `createAllTables`/`dropAllTables`. The guard
run reports it in NEITHER list: the creates-tables case did not flag it, and the
rot-proof case passed. Evidence N2.

**Fix shape.** Add `\/db-create\.js|\/db-seed\.js` and
`\b(?:createAllTables|dropAllTables)\s*\(` to `CONTAINER_REACHING` at `:105`,
and soften the comment's "the ONLY thing that reaches the container".

---

### N3. SHOULD-FIX - CONFIRMED - `app/src/lib/dynamoAdmin.ts:145-152`

**Claim.** The `DEFAULT_DEADLINE_MS` comment claims "a 22-table loop cannot lose
more than ~20s to any one contended table". The code provides no such guarantee,
on three counts, and the comment is exactly the kind of arithmetic a future
maintainer will trust instead of re-deriving.

1. The deadline is checked before a re-send, never during one (`:238`). An
   attempt that starts at t=19.9s and blocks ~10s returns at ~29.9s. The real
   bound is `deadlineMs` plus one attempt.
2. One `ensureTable` on a TTL-bearing spec makes FOUR independent
   `retryLocalControlPlane` calls, each with its own fresh `startedAt` (`:223`):
   the CreateTable send (`:381`), the pre-send `ttlStatus` read (`:468`), the
   `UpdateTimeToLive` send (`:470`), plus `pollUntilTableActive`'s separate 10s
   ceiling (`:409`). Up to ~70s for a single table. (`DYNAMO_DISABLE_TTL` is set
   for `npm test`, so the two TTL legs bind `db:create` and the e2e lanes rather
   than the unit gate - but the comment does not say "per send".)
3. `waitUntilTableExists({ maxWaitTime: 60 })` at `:392` is outside every budget
   - see N4.

**Verified.** Code reading against the wave's own 10s-per-attempt figure at
`:84-88`. Evidence N3.

**Fix shape.** Either say "per retried SEND, not per ensureTable call" and drop
the 22-table arithmetic, or thread one deadline through the whole `ensureTable`.

---

### N4. SHOULD-FIX - CONFIRMED - `app/src/lib/dynamoAdmin.ts:392` vs `:323-326`

**Claim.** The docblock introducing `pollUntilTableActive` rejects
`waitUntilTableExists` because it "throws at 60s, which is the whole budget of
the beforeAll hooks that reach ensureTable. Arming a new false red while fixing
an old one is not a trade worth making." That waiter is still called at `:392`,
with `maxWaitTime: 60`, on the SUCCESS path of `ensureTable` - the path taken by
every one of the ~50 test callers and by `app/scripts/db-create.ts:36` on every
run. The bounded poll replaced it only on the rare retried-conflict path
(`:409`).

Not a regression - the waiter predates the branch - but the comment now reads as
if the hazard were removed when it was relocated, and a branch whose subject is
hook budgets left the largest single hook cost untouched while adding a comment
that argues against it.

**Verified.** Grep of `app/src/lib/dynamoAdmin.ts`: the waiter is imported at
`:15`, criticised at `:323`, and called at `:392`. Evidence N4.

**Fix shape.** Either use `pollUntilTableActive` on the success path too (with a
budget that suits a fresh create), or add a sentence at `:326` saying the success
path deliberately keeps the SDK waiter and why.

---

### N5. SHOULD-FIX - CONFIRMED - `app/test/dynamoAdminRetry.test.ts:590`

**Claim.** New acceptance case 21 (`:569-591`) is timing-fragile in the exact
way this mission exists to eliminate. Each scripted send takes 30ms
(`delayMs: 30`) against `deadlineMs: 50`, so attempt 1 has ~20ms of slack before
the deadline swallows the second send and the `>= 2` lower bound at `:590`
fails.

**Failure scenario.** `maxWorkers: 4` on a box under the cross-worktree load this
branch is about. `setTimeout(30)` plus scheduling returns at 55ms; the first
deadline check reads `55 >= 50` and throws with a single send; `>= 2` fails.
An intermittent red in the suite whose subject is `npm test` soundness, and one
that would be read as a retry regression rather than a test-budget artefact.

**Verified.** Same shape with `delayMs: 60` against the same 50ms deadline:
`CreateTable` sends = 1, below the asserted lower bound. Evidence N5.

**Fix shape.** Make the deadline several multiples of the scripted delay (e.g.
10ms sends against a 200ms deadline, asserting `< 4`), so the bound depends on
the deadline firing at all rather than on where it lands.

---

### N6. NOTE - CONFIRMED - `app/test/setup/dynamoAccessKeyGuard.test.ts:115` (`allAppTestFiles`)

**Claim.** The guard walks `app/test` on disk, so any UNTRACKED scratch file
that names `ensureTable` reds gate 2 for a reason unrelated to the branch. The
wave makes this likelier, because it establishes the stub suite as a legitimate
shape. Observed live during this review: a different reviewer's untracked
throwaway `app/test/__review_conf2_deadline.test.ts` was the sole offender on an
otherwise clean run of the branch.

**Verified.** Guard run transcript, evidence N6. The same run on a clean tree is
15/15 green.

**Fix shape.** Skip basenames beginning `__`, or skip files git does not track.

---

### N7. NOTE - PLAUSIBLE - `app/test/staticSmoke.test.ts:246-252` (probe list at `:281`)

**Claim.** The new comment lists `/..%5c..%5cpackage.json` among the four probes
that "land on `<root>/package.json`". That holds on Windows only. On POSIX - the
Linux ARM64 deploy target, and any Linux CI - `\` is a legal filename character,
so `decodeURIComponent` yields `..\..\package.json` and `path.resolve` treats it
as ONE filename inside dist, where no decoy exists. The probe silently degrades
to a shape probe there, so the falsifiability the wave restored is 4/6 on
Windows and 3/6 on Linux. The inline note at `:281` still says only "meaningful
on Windows hosts", which is about the attack, not about the decoy.

**Verified.** Reasoned from `path.resolve` POSIX semantics; the Windows half was
measured (evidence A3 re-run, 4/6). Not executed on POSIX.

**Fix shape.** One clause in the comment, or a second decoy written at the
literal POSIX filename.

---

### N8. NOTE - CONFIRMED - `app/test/staticSmoke.test.ts:92`

**Claim.** `<root>/site/package.json` is written but no probe in the list at
`:279-286` resolves to it; the comment at `:262-263` admits it is "for a future
probe or a differently-rooted dist". Dead fixture state that reads as coverage.

**Verified.** Walked all six probes against `distDir = <root>/site/dist`; four
resolve to `<root>/package.json`, one is normalised to `/package.json` by the
client, one leaves the root. Evidence A3.

---

### N9. NOTE - CONFIRMED - `app/test/dynamoAdminRetry.test.ts:538-567`

**Claim.** New case 20 asserts the OUTCOME (`plainStub` issued zero
`DescribeTable`) but nothing asserts that the intended INTERLEAVING happened. If
B's 25ms delayed send ever resolves before A's retry fires, the case passes
without exercising the per-call flag at all, and no one is told. Its whole value
is the ordering its comment describes.

**Verified.** Read the case; the delay is 25ms against a `backoffMs: () => 0`
retry that fires within microtasks, so the ordering holds comfortably today -
but nothing pins it.

**Fix shape.** Have the stub record a global send sequence and assert B's send
index falls after A's second `CreateTable`.

---

## ADJUDICATION CHALLENGES

### Challenge to A6 (DECLINE) - the wave changed the risk it was declined on

The DECLINE reasons were "not a regression" and "too large a design change for a
fix wave". Both were fair at `796b8632`. They are no longer, because A4 - landed
in the SAME wave - added a SECOND early exit that also skips the landed-check
(`app/src/lib/dynamoAdmin.ts:238`), one that fires earlier than the attempt bound
and preferentially on the slow fault most likely to have landed. The exposure
that was judged acceptable was materially widened by the fix for A4.

Two things follow. First, N1's remedy is a one-line reorder, not the design
change the DECLINE refused - it needs no hook on `CreateTable` and contradicts no
plan row. It should land in this wave. Second, with N1 fixed, A6's residue is
only the `CreateTable`-with-no-hook path, and carrying THAT to the human is
reasonable. Without N1, deferring A6 defers a hazard the branch just enlarged.

### Challenge to A5 (DECLINE) - the declining reason does not cover the callers

The DECLINE rests on the poll waiting "only on a table THIS call just created -
empty, and (by the per-worktree or per-run-random key scheme the access-key guard
enforces) not being created concurrently by anyone else", now written into the
code at `app/src/lib/dynamoAdmin.ts:148-152`. Two gaps.

1. **The key scheme governs test suites, not scripts.**
   `app/scripts/db-create.ts:36` calls `ensureTable` against the HUMAN's local
   database, with ambient `tableName(spec.baseName)` names, on tables that are
   neither empty nor exclusively this call's. `scripts/e2e-session.mjs:675-690`
   runs `db-create` and then `db-update-gsis` over the same lane tables. So a
   table CAN legitimately be UPDATING for the minutes that
   `app/scripts/db-update-gsis.ts:112-115` - the same diff - budgets 900_000ms
   for. The comment at `:148-152` denies exactly that situation for a caller that
   is in the tree.
2. **The DECLINE addresses exclusivity, not readability.**
   `pollUntilTableActive:346-350` folds every read failure into
   `observed = 'unreadable'`, and its reads are deliberately un-retried (`:330-333`).
   Under the very container fault the retry exists for, a run of failing
   `DescribeTable`s for 10s turns a create that SUCCEEDED into a hard failure at
   `:414`, where the base code returned `'exists'`. Nothing in the adjudication
   weighs that path.

I am not asking for the behaviour change the DECLINE refused. The minimum is to
narrow the new comment's claim to the vitest callers it is true of, and to say
what happens when the poll cannot READ - because as written the comment will be
read as covering `db:create`, which is its most exposed caller.

### Challenge to A3 (ACCEPT) - agreed, with two details

The ACCEPT is right and the fix works: my leaky-layer reproduction now fails 4 of
6 probes where it failed 0 of 6 before. Two details of the accepted shape are
weaker than the comment says - the Windows-only target for the `..%5c` probe
(N7) and the currently unreachable `<root>/site/package.json` decoy (N8). Neither
undermines the deviation; both belong in the comment the wave rewrote, since that
comment is now the only record of what these probes can and cannot see.

---

## ROUND-1 CLOSURE VERDICTS

| # | verdict | evidence |
|---|---|---|
| A1 | **CLOSED** | Clean tree, `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` -> 15/15 green; `dynamoAdminRetry.test.ts` in no offender list. The declaration-line regex at `:83-87` correctly does not self-match the guard file's own prose - the stated risk. Mechanism gameable (N2) and scratch-file-sensitive (N6), but the blocker itself is gone. |
| A2 | **CLOSED** | `:525` gates on `retried`, fed by the per-call `onRetry` at `:503-505`. Re-ran my r1 E2 reproduction: non-local first-attempt `ResourceInUseException` now rejects with the same object after one send; a retried conflict still resolves after two. Case 18 (`:494-509`) pins it with an identity assertion. |
| A3 | **CLOSED** | Re-ran my r1 E3 leaky layer over the new three-level fixture: 4 of 6 probes now fail (`/..%2f..%2f`, `/%2e%2e%2f%2e%2e%2f`, `/..%5c..%5c`, `/assets/...`), versus 0 of 6 at `796b8632`. Real app still green (12/12). Details N7, N8. |
| A4 | **PARTIALLY** | The deadline exists, is threaded through `opts`, and does cut the loop (case 21 passes). But it is ordered before the verify hook (N1, must-fix), its comment claims a bound the code does not provide (N3), and its acceptance case is timing-fragile (N5). |
| A5 | **NOT CLOSED (declined)** | The one-line comment landed at `:148-152`. I challenge the reasoning above: it is false for `app/scripts/db-create.ts:36` and does not address the unreadable-poll path. |
| A6 | **NOT CLOSED (declined)** | Declined as too large for the wave. I challenge: A4 widened the exposure this was declined on, and N1's one-line reorder removes most of it without the design change the DECLINE refused. |
| A7 | **RECORD, unchanged** | `docs/issues/static-smoke-fails-on-stale-dashboard-dist.md:6` is still `status: open`, as adjudicated (deferred to S7). No objection. |
| A8 | **RECORD, unchanged** | `ensureTable` still returns `'exists'` for a table it created on the retried path (`:369`); case 2 still pins it. Carried to the handback beside A6, as adjudicated. No objection. |
| A9 | **CLOSED** | `app/test/staticSmoke.test.ts:82` declares `root` as possibly undefined and `:99` guards the `rmSync`. Read the whole `beforeAll` (`:85-93`): every write is under `root`. Nothing is written outside the mkdtemp tree. |

---

## Consumers swept

Swept the whole tree, not the diff.

- **`retryLocalControlPlane` entry points** - `sendWithRetry` reaches
  `CreateTable` (`:381`), `DeleteTable` (`:513`) and the pre-send `ttlStatus`
  read (`:468`); `sendWithRetryVerified` reaches `UpdateTimeToLive` (`:470`) and
  `ensureGsis`'s `UpdateTable` (`app/scripts/db-update-gsis.ts:197`). The new
  `deadlineMs` applies to all five, per call, with an independent clock each -
  N1 and N3.
- **`deleteTableIfExists`** - `app/scripts/db-create.ts:63` and `:75`
  (`dropAllTables`) plus ~50 suites. With A2's gate, an un-retried conflict once
  again throws before `waitUntilTableNotExists`, so C4's slow-waiter path is
  reachable only after a retry, as the adjudication says. The delete-then-create
  hooks (`app/test/importApply.integration.test.ts:72-77` and siblings) are back
  on base behaviour. CLEAN.
- **`ensureTable`** - unchanged arity; the added `retried`-gated poll is per call
  and now pinned concurrently by case 20 (with the vacuity caveat N9). Its
  success path still carries the 60s SDK waiter - N4.
- **`ensureGsis` / `db-update-gsis`** - no change in the wave. Its caller
  `scripts/e2e-session.mjs:690` inherits N1's deadline-before-verify exposure.
- **The three dynamo-lane markers** - grepped the whole test tree: `none` is
  declared by exactly one suite (`app/test/dynamoAdminRetry.test.ts:24`); the
  guard file itself holds it only as a string constant and prose, and is
  correctly NOT matched by the declaration-line regex. No file carries two
  markers. The guard does not check for a contradictory pair - not worth a
  finding today, but worth knowing if a fourth answer is ever added. Gameability
  is N2.
- **`staticSmoke` fixture tree** - read every write in `beforeAll` (`:85-93`):
  `<root>/site/dist/index.html`, `<root>/site/dist/assets/app-fixture.js`,
  `<root>/package.json`, `<root>/site/package.json`. Nothing outside `root`;
  `mkdirSync` is `recursive`; `afterAll` guarded. `DASHBOARD_DIST_DIR` consumers
  elsewhere (`app/test/devGating.test.ts:256`,
  `app/test/unitMediaServe.test.ts:186`, `Dockerfile:67`) build their own dists
  and are untouched. CLEAN apart from N7/N8.
- **New acceptance cases 18-21, probed for vacuity** - 18 is non-vacuous (an
  ungated tolerance resolves instead of rejecting). 19 is non-vacuous on the
  instance and message assertions, though its
  `not.toBeInstanceOf(TableNotActiveError)` is trivially true and adds nothing.
  20's outcome assertion is non-vacuous but its interleaving is unpinned (N9).
  21 is non-vacuous (removing the deadline gives 4 sends, failing `<= 3`) but
  timing-fragile (N5).
- **ASCII / AGENTS.md editing rules** - scanned all four changed source files:
  the only character above 0x7E is the pre-existing em dash at
  `app/src/lib/dynamoAdmin.ts:1`, untouched by the wave. CLEAN.
- **Suites re-run at `b783804a`** - `dynamoAdminRetry` 21/21,
  `staticSmoke` 12/12, `dynamoAccessKeyGuard` 15/15, all green on a clean tree.
