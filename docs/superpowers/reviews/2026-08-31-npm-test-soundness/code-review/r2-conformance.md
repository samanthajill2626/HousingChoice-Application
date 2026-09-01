# R2 code review - SPEC/PLAN CONFORMANCE (fix wave + what round 1 missed)

- Branch `feat/npm-test-soundness`, worktree `W:\tmp\npm-test-soundness`,
  new tip `b783804a`, wave base `2876b205`, merge base `5ce9912f`.
- Inputs read: `r1-adjudications.md`, `r1-adversarial.md` (not seen at r1),
  `r1-fix-wave.md`, both r2 diff packages, and the LIVE tree.
- Method: every verdict below is read from the live tree, not from the wave
  record's description of it. Run bare and foreground from
  `W:\tmp\npm-test-soundness\app`:
  - `npx vitest run test/dynamoAdminRetry.test.ts` -> exit 0, **21/21**.
  - `npx vitest run test/setup/dynamoAccessKeyGuard.test.ts` -> exit 0,
    **15/15** (the A1 blocker is gone and the new rot-proof case is green).
  - `npx vitest run test/staticSmoke.test.ts` -> exit 0, **12/12, 0 skipped**
    (the (c) diagnostic took its PASS arm; `dashboard/dist` is present).
  - one THROWAWAY probe, since deleted, reproducing finding N1.
  - ASCII scan of every ADDED line in `2876b205..b783804a`: **zero** bytes
    above 0x7E, spec sentence included.
- `git status --short` shows one untracked file,
  `app/test/__review_adv2_gamed.test.ts`. **It is not mine** - it belongs to
  the adversarial reviewer working the same tip. I created and deleted only
  `app/test/__review_conf2_deadline.test.ts`; nothing of mine remains.
- Not run: full `npm test`, `npm run e2e`, `npm run smoke`. Container not
  restarted, `E2E_CHILD_LOG_DIR` never set, nothing left in the background.

---

# 1. NEW FINDINGS

Counts: **0 blocker, 0 must-fix, 2 should-fix, 5 note.**

The wave is sound in substance: every ACCEPT row landed, no DECLINE row was
touched, and the two must-fix behaviours (A2, A3) are genuinely fixed and
genuinely pinned. What follows is new.

**N1. should-fix - CONFIRMED - `app/test/dynamoAdminRetry.test.ts:569-593`
(assertion at `:590`).** Case 21 - the new deadline case - is load-fragile,
and it fails in exactly the condition this mission exists to remove. Each
attempt sleeps 30ms against a 50ms deadline, so the margin protecting the
`sends >= 2` lower bound is 20ms of timer accuracy. I reproduced the failure:
with the event loop blocked for 60ms during attempt 1 (what a saturated
vitest worker does to a `setTimeout`), the deadline fires before attempt 2 and
the send count is **1**, so `toBeGreaterThanOrEqual(2)` goes red. The upper
bound is safe; only the lower bound is exposed, and it is the half with the
teeth (without it, a deadline that disabled the retry entirely would pass).
Failure scenario: the branch's own acceptance suite reds intermittently under
a contended `npm test`, with no assertion text that explains why - a new false
red of the mission's own class, shipped by the fix for another one. Remedy:
make the deadline, not the timer, the binding constraint by a wide margin -
inject `attempts` well above what the deadline permits (say `attempts: 12`,
`delayMs: 20`, `deadlineMs: 200`) and assert `2 <= sends < attempts`.

**N2. should-fix - CONFIRMED - `app/src/lib/dynamoAdmin.ts:145-152`.** The
`DEFAULT_DEADLINE_MS` comment claims "a 22-table loop cannot lose more than
~20s to any one contended table". The code does not enforce that. The deadline
is per `retryLocalControlPlane` CALL (`startedAt` at `:223`), and one
`ensureTable` on a TTL-bearing spec makes **three** independent retry loops -
`CreateTable` (`:382`), the pre-send `DescribeTimeToLive` (`:468`) and
`UpdateTimeToLive` (`:470-488`) - each with its own fresh 20s budget, plus up
to 10s in `pollUntilTableActive`. Worst case for one table is therefore ~70s,
not ~20s. Inside `npm test` workers the TTL half is disabled
(`app/vitest.config.ts:119`), which caps the reachable figure there at ~30s -
still not 20s - but `globalSetup`, `db:create` and the e2e lanes all reach the
TTL path, which is this mission's own item-1A finding. Failure scenario:
someone sizes a hook budget, an e2e lane timeout or a future deadline on the
comment's arithmetic and is wrong by 3.5x. Remedy: either state the real
per-call bound in the comment, or thread one deadline through the whole
`ensureTable` call so the claim becomes true.

**N3. note - CONFIRMED - `app/test/setup/dynamoAccessKeyGuard.test.ts:105-112`
and `:370-399`.** The rot-proof check behind the new `hc:dynamo-lane none`
marker is a single-file source-text scan; it never follows imports. The one
file it governs is already one hop from a false negative:
`app/test/dynamoAdminRetry.test.ts:35` imports `../scripts/db-update-gsis.js`,
and `app/scripts/db-update-gsis.ts:34` imports the container-reaching factory
the check is written against. Harmless today - that factory call sits behind
the CLI argv guard at `db-update-gsis.ts:240` and never runs under vitest -
but the check's own comment calls importing that module "the reachable
definition of opens a database", and one indirection defeats it. Failure
scenario: a stub suite declares `none`, imports a local test helper that
builds a real client, and the guard exempts it - reinstating the fixed-name
cross-worktree collision the guard exists to prevent, with a marker asserting
it cannot happen.

**N4. note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:238` preceding `:241`.**
The plan's hook contract says the verification hook is not called on the final
attempt because "the bound is checked first". There are now two bounds, and
the new elapsed-time one also pre-empts the hook. Behaviourally consistent -
both throw the original error - but it narrows a contract eight review rounds
ratified: for the lock-timeout signature the deadline binds after roughly one
retry, so "did the mutation land?" is now asked at most **once** where the
attempt bound allowed three. A mutation that landed is then reported as
failed. Not a defect, but it is an unstated change to the hook contract and
belongs in the handback beside A4.

**N5. note - CONFIRMED - `app/test/staticSmoke.test.ts:92` with `:264-265`.**
`<root>/site/package.json` is a decoy that no probe reaches - the wave's own
measured resolution table says all four in-root probes land on
`<root>/package.json`. That is precisely the shape spec v5 (lines 536-539)
records as the v2 decoy mistake: "planted two at depths the probes do not
reach". Harmless, but it is dead scaffolding inside a deviation whose entire
justification is falsifiability, and the comment presents it as covering a
depth "for a future probe" - a decoy waiting for a test that does not exist.
Either add the probe that reaches it or drop the file.

**N6. note - CONFIRMED - `app/test/staticSmoke.test.ts:85-93`.** The fixture
writes are order-dependent in a way nothing states: `<root>/site` exists only
as a side effect of `mkdirSync` creating `<root>/site/dist/assets`
recursively at `:88`, and `:92` writes into it. Reordering those five lines -
an ordinary edit - fails the whole file with an ENOENT inside `beforeAll`. An
explicit `mkdirSync` for `<root>/site` would make it order-independent.

**N7. note - CONFIRMED - `app/src/lib/dynamoAdmin.ts:157-164`.** The new A5
comment justifies the 10s poll ceiling partly on the claim that the table
being polled is "not being created concurrently by anyone else (by the
per-worktree or per-run-random key scheme the access-key guard enforces)".
That holds ACROSS worktrees, not within one: shared-table suites resolve to a
single worktree-wide key (`app/test/setup/dynamoAccessKey.ts:121`), so two
processes in the same worktree address the same physical `hc-local-` tables.
AGENTS.md forbids running a full suite beside an interactive session from one
worktree, but nothing enforces it, and `scripts/e2e-session.mjs:690` runs
`db:update-gsis` against a lane on every start. The ceiling is still right;
the exclusion argument is stated more strongly than the key scheme supports.

---

# 2. RE-VERDICTS: requirements the wave could have disturbed

| requirement (plan / spec) | verdict | evidence | note |
|---|---|---|---|
| S1.2 "which send uses which": CreateTable -> `sendWithRetry`, no hook | CONFORMS | `dynamoAdmin.ts:382-392` unchanged by the wave | |
| ... DeleteTable -> `sendWithRetry`, no hook | CONFORMS | `dynamoAdmin.ts:499-509` | The wave added `onRetry`, which is a retry-observer, not a verification hook - the same seam plan S1.3 pre-commits for `CreateTable` |
| ... DescribeTimeToLive pre-send -> `sendWithRetry` | CONFORMS | `dynamoAdmin.ts:468` | untouched |
| ... UpdateTimeToLive -> `sendWithRetryVerified` | CONFORMS | `dynamoAdmin.ts:470-488` | untouched |
| ... UpdateTable -> `sendWithRetryVerified` + `indexStatus` | CONFORMS | `app/scripts/db-update-gsis.ts:197-212` | file not in the wave diff |
| S1.2 hook contract: true / false / throws / absent | CONFORMS | `dynamoAdmin.ts:241-252` | logic byte-identical; only the pre-empting bound above it changed |
| S1.2 hook not called on the final attempt (bound first) | CONFORMS, contract NARROWED | `dynamoAdmin.ts:233` then `:238` then `:241` | see N4 |
| S1.2 4 attempts max, linear backoff, injectable | CONFORMS | `dynamoAdmin.ts:128`, `:219-221` | the deadline can only REDUCE attempts, so the stated maximum still holds |
| S1.2 endpoint gate lazy, fail-closed, only on a retryable error | CONFORMS | `dynamoAdmin.ts:239-240` | the deadline check at `:238` sits before it and throws the same error, so no behaviour on the non-local path changed. Cases 11/12 green |
| S1.3 case 3's ZERO-DescribeTable hot path | CONFORMS | `dynamoAdmin.ts:407`; case 3 `dynamoAdminRetry.test.ts:248-256` | `ensureTable` was not touched by the wave; case 3 passes, and case 20 now pins it under concurrency too |
| S1.3 poll: 100ms / 10s, exported, injectable, own reads not retried | CONFORMS | `dynamoAdmin.ts:153`, `:164`, `:334-354` | body unchanged; only a comment was added above the constant |
| S1.3 exhaustion split (poll throws its own; `ensureTable` rethrows the ORIGINAL) | CONFORMS | `dynamoAdmin.ts:407-417`; case 19 `dynamoAdminRetry.test.ts:511-536` | now pinned by a committed case, which closes C2 |
| S1.3 DeleteTable tolerates `ResourceInUseException` | CONFORMS (tightened toward the spec) | `dynamoAdmin.ts:525`; cases 4 and 18 | the gate restores base behaviour for every un-retried caller - see challenge 2 |
| S1.3 per-call `retried`, never module-level | CONFORMS, now in TWO functions | `dynamoAdmin.ts:380` and `:499` | both per-call locals; case 20 pins `ensureTable`'s under `Promise.all` |
| S3.1 fixture positive constraint (`<div id="root">`) | CONFORMS | `staticSmoke.test.ts:63-65`, asserted at `:294` | fixture HTML unchanged |
| S3.1 fixture negative constraint (no `"version"` / `"private"` / `root:`) | CONFORMS | `staticSmoke.test.ts:56-65` | the decoys carry those markers but live in SEPARATE files that are never served; the served shell still carries none |
| S3.1 traversal assertions carried over UNCHANGED | CONFORMS | `staticSmoke.test.ts:277-296` | probe list and all four assertions byte-identical to the r1 tip; only the comment changed |
| S3.1 nothing written outside the temp root | CONFORMS | `staticSmoke.test.ts:86-92`, cleanup `:95-100` | five writes, all under `<root>`; `rmSync(root)` guarded |
| S3.1 "No decoys" (plan S3.1, spec item 3) | **DEVIATED - adjudicated, recorded, justified** | `staticSmoke.test.ts:67-70`, `:91-92` | see challenge 1 |
| S3.2 (b) five conditions vs tracked source, never skips | CONFORMS | `staticSmoke.test.ts:31-36`, `:339-349` | untouched |
| S3.3 (c) PASS or SKIP, never FAIL | CONFORMS | `staticSmoke.test.ts:364-382` | untouched; both skip branches still abort before any expect |
| S3.3 no mtime predicate | CONFORMS | no `statSync` / mtime anywhere in the file | |
| C1 spec supersession sentence: ASCII, touches nothing else | CONFORMS | spec `:528-530`; wave diff for that file is +3 lines | ASCII scan clean |
| Spec item 2 / plan S2 (logCallSiteGuard) | CONFORMS, untouched | file absent from the wave diff | |
| Spec "no runtime code other than dynamoAdmin.ts" | CONFORMS | wave touched `dynamoAdmin.ts` plus three TEST files and one spec line | the guard is test infrastructure; its container sends (`:327`/`:342`, the spec's not-covered sites) are unchanged |

---

# 3. ADJUDICATION CHALLENGES

**Challenge 1 - A3 (decoys inside the temp root): ACCEPT UPHELD.** The
deviation is justified and, with one exception, correctly bounded. The spec's
argument ("no decoy could ever be read, so no decoy could make those
assertions less vacuous") is true of TODAY's mechanism and irrelevant to the
probes' STATED purpose, which `staticSmoke.test.ts:237-239` says is to catch a
FUTURE static-serving change - and a probe with no target cannot. The
adversarial reproduction (4/6 failures with a target, 0/6 without) settles it
empirically, which four design rounds never did. Bounding: every write is
inside `<root>` (`:86-92`), `afterAll` removes the root whole and is now
guarded (`:95-100`), and the one probe that resolves outside the root is
explicitly kept as a shape probe and labelled as such (`:260-262`). The
exception is N5: `<root>/site/package.json` is a decoy no probe reaches, which
is the exact v2 mistake the spec records. Fix N5 and the deviation is clean.
It must reach the human in the handback as a spec deviation, per the
adjudication's own last line.

**Challenge 2 - A2 (gating a tolerance the plan's text made unconditional):
ACCEPT UPHELD, and stronger than the adjudication claims.** The adjudication
says both readings honour intent and the gated one is "strictly safer". It is
more than that: the SPEC's per-command table describes the hole as "attempt 2
against a DELETING table throws `ResourceInUseException`, uncaught" - i.e.
only a retried attempt - so the ungated version shipped at r1 was a deviation
FROM the spec, and `dynamoAdmin.ts:525` restores conformance rather than
merely improving on it. Where plan prose ("additionally tolerates") and the
spec table disagree, the plan's own rule says the spec wins. Case 18
(`:494-508`) pins the un-retried throw against the exact instance, and case 4
still pins the retried tolerate; the pair is non-vacuous in both directions.

**Challenge 3 - A4 (a 20s deadline the plan never specified): ACCEPT UPHELD
in mechanism, but it shipped with two defects and one silent contract
change.** The plan specifies "4 attempts MAX"; a deadline can only reduce the
attempt count, so it cannot violate that bound, and the spec's own reason for
bounding at all ("a retry loop that can outlive a test budget trades one false
red for another") is the deadline's whole argument. I would have accepted it
too. But: the comment's per-table arithmetic is wrong (N2, ~70s reachable, not
~20s); the acceptance case that makes it non-inert is itself load-fragile and
I reproduced it going red (N1); and the deadline now pre-empts the
verification hook, which narrows the ratified contract without saying so (N4).
None of the three needs a design decision - all three are edits.

**Challenge 4 - A5 (DECLINE the behaviour change, ACCEPT the comment): AGREE
with the DECLINE.** The adversarial alternative - return `'exists'` at the
ceiling - would restore the precise hole spec item 1A's `CreateTable` row
exists to close (handing back a still-CREATING table), and the two figures
really are measuring different things. But the comment shipped at `:157-164`
overstates the exclusion argument: the per-worktree key scheme excludes a
concurrent creator across worktrees, not within one, because shared-table
suites collapse onto a single worktree key (N7). Soften the sentence; do not
change the behaviour.

**Challenge 5 - A6 (DECLINE the CreateTable verify hook): AGREE with the
DECLINE for this branch, with one interaction the adjudication did not
weigh.** A hook on `CreateTable` contradicts a plan table row that eight
rounds ratified and would change the return value on that path, so it is not a
fix-wave change. However, A4's deadline makes A6's scenario MORE likely, not
less: the recovery path is only reached if some attempt happens to draw
`ResourceInUseException`, and the deadline cuts the number of attempts that
could draw it from three to roughly one for the slow lock-timeout signature.
The handback item for A6 should say that, so the human is not choosing between
"as before" and "fixed" when the branch actually moved the odds.

---

# 4. C1-C9 CLOSURE VERDICTS

| # | verdict | evidence |
|---|---|---|
| C1 (spec `HousingChoice` supersession) | **CLOSED** | spec `:528-530`, one bracketed ASCII sentence naming plan S3.1 and the adjudication; nothing else in the file changed |
| C2 (`ensureTable`'s exhaustion half untested) | **CLOSED** | case 19, `dynamoAdminRetry.test.ts:511-536`: asserts a `ResourceInUseException` INSTANCE, explicitly `not.toBeInstanceOf(TableNotActiveError)`, message carrying table and observed status |
| C3 (per-call `retried` untested under concurrency) | **CLOSED** | case 20, `:538-567`: two clients under one `Promise.all`, the plain one's send delayed past the other's retry, asserting ZERO `DescribeTable`. The wave measured it red under a module-scope mutation |
| C4 (`dropAllTables` waiter cost) | **DEFERRED as adjudicated (S7 record), and materially narrowed** | `dynamoAdmin.ts:525` - only a RETRIED delete can now reach the waiter's slow path; an un-retried conflict throws at the real cause. Still owed as an S7 observation |
| C5 (logCallSiteGuard closure wording) | **DEFERRED as adjudicated (S7)** | no issue file carries a Resolution stamp yet; `docs/issues/logcallsiteguard-hook-budget-equals-its-own-cost.md` untouched |
| C6 (two unclassified enumeration hits to the handback) | **DEFERRED as adjudicated (S8)** | `s1-retry.md:30-34` still the only record; no `handback.md` exists yet |
| C7 (second describe folded onto `fixtureApp`) | **CLOSED as RECORD** | `staticSmoke.test.ts:104-114`, `:308`, `:323`; assertions unchanged, benign, now recorded |
| C8 (`path` loop variable shadowing the import) | **CLOSED** | `staticSmoke.test.ts:212-233`: renamed to `route`, every `expect(..., route)` message updated; no `for (const path of` remains in the file |
| C9 (in-code `send` version) | **CLOSED** | `staticSmoke.test.ts:267-269`: dated, and labelled an observation about the pinned version rather than an invariant, with a pointer to the S3 record |

## Still outstanding for later slices (unchanged from r1)

S5, S6, S7 and S8 have not run. No issue carries a Resolution stamp,
`AGENTS.md` and `docs/issues/_CLUSTERS.md` are untouched, and there is no
handback. C4, C5 and C6 land there, along with the A3 spec deviation, A6/A8,
and N2/N4 from this round.
