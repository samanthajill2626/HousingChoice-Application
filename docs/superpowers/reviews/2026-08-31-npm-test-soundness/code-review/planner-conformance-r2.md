# Planner conformance review, round 2 - the planner-review fix wave

- Branch `feat/npm-test-soundness`. Diff under review: `5f224289..HEAD`
  (`3d47e2c6`, `6b4d712e`, `51dc753d`, `2fdb0dd8`, `2d70563a`).
- Inputs: `code-review/planner-fix-wave-adjudications.md`,
  `code-review/planner-fix-wave.md`, and my round-1 report
  `code-review/planner-conformance.md`.
- Method: STATIC ONLY - reading, `git`, `grep`, and reads of `node_modules`
  source. **No suite, npm script, vitest, playwright or Docker command was
  run.** The orchestrator is re-running all five gates on this worktree.

**Verdict: 5 findings - 1 high, 3 medium, 1 low. 0 blocking.**

All five of my round-1 findings are closed **on the point, not the letter** -
I checked each specifically for that and none of them is a letter-fix (detail
in "Round-1 findings: closure verdicts"). Every new factual claim the wave
committed checks out against the repo and `node_modules`; I found **no new
wrong claim**, which was the risk flagged as worst.

What survives is four things nobody has looked at yet plus one recording gap:
the gate-4 exemption is **unsound** by direct reachability, the
verify-on-final-attempt deviation repeats the exact recording gap my finding 9
closed (now in the plan), and two of the new mechanisms - the GONE poll's
"only RNF proves gone" rule and the un-retried delete's hot path - are
**unfalsifiable by every case in the file**.

---

## FINDINGS

### 1. HIGH - the gate-4 exemption is unsound: `dynamoAdmin.ts` is ON the e2e lane's setup path

`planner-fix-wave-adjudications.md:9-11` and `:29-30`, repeated in
`handback.md` addendum ("Gate 4 NOT re-run, per the planner's stated
exemption: no file outside `app/test/**`, `app/src/lib/dynamoAdmin.ts` and
`.md` documentation changed in this wave"), and again in the addendum's
closing line ("gate 4 green on `b4ba463a` and exempt for this wave").

The exemption reasons from file LOCATION. Reachability says otherwise, and the
chain is three greps long:

- `scripts/e2e-session.mjs:675` -
  `await runOnce('db-create', ['--import','tsx', path.join('app','scripts','db-create.ts')]);`
- `scripts/e2e-session.mjs:690` - then `db-update-gsis.ts`.
- `app/scripts/db-create.ts:16` -
  `import { ensureTable, deleteTableIfExists } from '../src/lib/dynamoAdmin.js';`
  called at `:36` (`ensureTable`), `:63` and `:75` (`deleteTableIfExists`).

So **every e2e lane boot runs the exact three functions this wave changed**,
against a real DynamoDB Local container. All three changes are behavioural, not
cosmetic:

1. `deleteTableIfExists` now runs a NEW `DescribeTable` poll (up to the default
   10s ceiling) on the retried-tolerated path - reached from
   `db-create.ts:63`/`:75`, which pass no `poll` options and therefore take the
   defaults.
2. Both polls gained exponential backoff (`dynamoAdmin.ts:268`).
3. The verification hook now runs on the final attempt - and the TTL leg that
   uses it is LIVE under e2e. The module's own comment, corrected by this very
   wave, says so: `dynamoAdmin.ts:187` now reads "globalSetup runs them on
   every `npm test` [...] **as do db:create and the e2e lanes**". `ensureGsis`'s
   hooked `UpdateTable` is reached from `e2e-session.mjs:690`.

Two specific interactions the exemption prevents anyone from seeing:

- `app/scripts/db-create.ts:58-66` (`dropAllTables`) does
  `deleteTableIfExists` and then `waitUntilTableNotExists({maxWaitTime: 60})`
  per table. On the exhaustion path `deleteTableIfExists` now THROWS
  (`TableNotGoneError` -> rethrown conflict) where before it returned - a new
  failure mode on the e2e lane's own teardown/setup path, and the spec already
  named this waiter a watch item (`spec:167-175`).
- `app/test/importApply.integration.test.ts:72-77` is a `beforeAll(..., 60_000)`
  that loops `TABLES` doing `deleteTableIfExists` then `ensureTable`. The wave
  adds a second potential 10s ceiling per table to a loop that already carries
  one, inside a 60s hook - the arithmetic `DEFAULT_POLL_CEILING_MS`'s own
  comment reasons about (`dynamoAdmin.ts:195-220`), which, per the implementer's
  "seen, not fixed" #2, was never extended to cover the GONE poll.

The wave is very likely fine - the poll only fires after a retried conflict,
which is rare. But "very likely fine" is what gate 4 exists to stop being the
answer, and the exemption as written is the wrong RULE: it will be reused, and
`app/src/lib/dynamoAdmin.ts` is precisely the file for which it is false.
Note also that `handback.md`'s "gate 4 green on `b4ba463a`" is now stale
evidence - `6b4d712e` changed the module after that run.

**Fix:** re-run gate 4 (already in progress), and correct the exemption's text
so it reads on reachability, not on directory: any change to
`app/src/lib/dynamoAdmin.ts`, `app/scripts/db-create.ts` or
`app/scripts/db-update-gsis.ts` is ON the e2e path and is never exempt.

---

### 2. MEDIUM - the verify-on-final-attempt deviation is unmarked in the plan, in the same wave that marked the decoy deviation in the spec

The deviation is well recorded in four places: the adjudication
(`planner-fix-wave-adjudications.md:16`, "recorded here as planner-overridden"),
the implementer record (`planner-fix-wave.md:39-52`), the handback addendum
(`handback.md:155`), and the code itself - the module preamble now says
"called EXACTLY once per failed attempt - the FINAL attempt included"
(`dynamoAdmin.ts:119-125`), the in-loop comment gives the reason
(`:321-330`), and case 10's title and interleave were updated.

It is not marked in the one live document that still asserts the old rule.
`docs/superpowers/plans/2026-09-01-npm-test-soundness.md` was **not touched by
this wave** (`git diff --name-only 5f224289..HEAD -- docs/superpowers/plans/`
is empty) and still says, twice:

- `plan:203` (the acceptance table, case 10) - "exactly **4** sends, then
  throws; **hook called 3 times, NOT on the final attempt** (the bound is
  checked first, matching `db-update-gsis.ts:117`)";
- `plan:263` - "Called at most once per failed attempt, never itself retried,
  and **not called at all on the final attempt** - the bound is checked first."

I swept for survivors: those two lines are the ONLY statements of the old rule
outside as-produced review records. The SPEC needs no note and correctly got
none - `spec:201` says only "at most ONCE per failed attempt", which the new
behaviour satisfies. So this is a plan-only gap, and it is the same gap my
finding 9 was about, created by the same commit that fixed it: `51dc753d`
added a bracketed supersession note to the spec's "No traversal decoys"
paragraph and a dated note to the S3 record, and left the plan's own
superseded row unmarked.

Why it matters here specifically: the plan's acceptance table is the canonical
case list this mission has been reviewed against for four rounds - every
record says "the plan's 17", and the adjudication itself calls this "the plan's
ratified row". A reader checking case 10 against `plan:203` finds a direct
contradiction with `plan:21`'s own instruction ("Where the two disagree, the
spec wins and the disagreement is a finding") giving no guidance, because the
disagreement is plan-vs-code.

**Fix:** two bracketed C1-style sentences, at `plan:203` and `plan:263`, naming
`6b4d712e`, the adjudication row, and case 25.

---

### 3. MEDIUM - `pollUntilTableGone`'s "only ResourceNotFoundException proves gone" rule is unfalsifiable

`dynamoAdmin.ts:491-515`. The docblock makes this the function's central
safety property, in bold terms:

> ONLY a ResourceNotFoundException from DescribeTable proves gone. Any OTHER
> read failure counts as "maybe still there" [...] this poll guards a caller
> that is about to re-create the name, so guessing "gone" from an unreadable
> container is **the one answer that cannot be recovered from**.

No case exercises it. The two cases that reach the poll drive it entirely
through successful reads plus one RNF:

- case 23 (`dynamoAdminRetry.test.ts:693-717`) scripts `DescribeTable` as
  `[ok DELETING, ok DELETING, fail resourceNotFound()]`;
- case 24 (`:719-740`) uses `.fallback('DescribeTable', { ok: DELETING })` -
  a successful read, never a throw.

So **no case ever makes `DescribeTable` throw a non-RNF error**. Replace
`if (readErr instanceof ResourceNotFoundException) return;` (`:506`) with a
bare `return;` - i.e. make ANY read failure mean "gone", the exact
unrecoverable answer the docblock forbids - and cases 23 and 24 both still
pass, because RNF is the only error either one throws. The `lastReadError` /
`cause` limb (`:508`, `:511`) is dead in every case for the same reason.

Two smaller gaps in the same shape:

- Neither `pollUntilTableGone` nor `TableNotGoneError` is imported by the
  acceptance suite (`dynamoAdminRetry.test.ts:51-57` imports only
  `deleteTableIfExists`, `ensureTable`, `isLocalDynamoEndpoint`,
  `pollUntilTableActive`, `TableNotActiveError`). The ACTIVE poll has a direct
  case (17) because `plan:210` demanded one; its mirror has none.
- Case 19 pins the ACTIVE side's error type negatively
  (`expect(failure).not.toBeInstanceOf(TableNotActiveError)`). Case 24 has no
  equivalent, so nothing pins that the GONE poll throws `TableNotGoneError` -
  which is what `deleteTableIfExists:700` discriminates on to decide whether to
  rethrow the original conflict or propagate.

This is the class this mission has caught four times already (the traversal
decoy, the `HousingChoice` tautology, case 6's early return, case 15's
fallthrough) and that `plan:766-770` warns about by name. It is new code, so
nobody has looked at it before.

**Fix:** one case - a stub whose `DescribeTable` throws a non-RNF error (an
`internalFailure()`) forever, asserting `deleteTableIfExists` rejects with the
original conflict rather than resolving; optionally a direct
`pollUntilTableGone` case asserting `TableNotGoneError` and its `cause`.

---

### 4. MEDIUM - case 18 does not pin the un-retried delete's hot path; removing the `retried` gate leaves it green

`planner-fix-wave.md:33-34` claims "The un-retried path is byte-identical to
before (case 18 unchanged and green)". The behaviour claim is TRUE - I checked
it against `git show main:app/src/lib/dynamoAdmin.ts` and the un-retried
branches match main exactly (RNF returns, everything else throws). But case 18
does not test the property that keeps it true.

Case 18 (`dynamoAdminRetry.test.ts:537-552`) asserts only
`rejects.toBe(conflict)` and `expect(stub.count('DeleteTable')).toBe(1)`.
Widen the guard at `dynamoAdmin.ts:695` from
`if (retried && err instanceof ResourceInUseException)` to
`if (err instanceof ResourceInUseException)` and trace it: the stub's default
`DescribeTable` answers `ok ACTIVE`, never RNF, so the poll spins to its
default 10s ceiling, throws `TableNotGoneError`, `deleteTableIfExists` catches
it, appends the message to the SAME `conflict` instance and rethrows it. Both
assertions still hold. **The case passes, ten seconds slower.**

The `ensureTable` side does not have this hole, and deliberately: case 3
(`:305-313`) asserts `expect(stub.count('DescribeTable')).toBe(0)`, and
`plan:762-763` calls that out as load-bearing ("Case 3 protects the hot path").
The delete side now has the same hot path - ~50 delete-then-create suites plus
`db-create.ts` - and no equivalent assertion. Compounding it, the wave's own
change to case 4 (`:315-330`) means, in the implementer's words
(`planner-fix-wave.md:144-145`), "case 4 no longer pins 'returns immediately';
nothing does, deliberately" - so the delete side lost its only other read-count
assertion in the same commit.

**Fix:** one line - `expect(stub.count('DescribeTable')).toBe(0);` in case 18.

---

### 5. LOW - the `cause` plumbing (finding 12's accepted half) has no assertion anywhere

`grep -n "cause" app/test/dynamoAdminRetry.test.ts` returns only two hits, both
inside error-message strings in the factories (`:222`, `:231`). Nothing asserts
any of the three `cause` behaviours the wave added:

- `dynamoAdmin.ts:316` - the verify hook's failure attached to the rethrown
  original, **and only when the original has no cause already**. That guard is a
  real branch and is untested in both directions. Case 7 (`:369-381`) drives the
  throwing-hook path but asserts only `rejects.toMatchObject({ name:
  'InternalFailure' })` and the send count.
- `TableNotActiveError` and `TableNotGoneError`'s `cause` (`:388-421`,
  constructed at `:466`, `:511`) - unreachable in every case, per finding 3.

Diagnostic-only code, so LOW. But it was shipped as a fix to a review finding
with zero pins, and the "only when the original has none" clause is exactly the
kind of conditional that rots silently.

---

## ROUND-1 FINDINGS: CLOSURE VERDICTS

I checked each against the point of the finding, not its wording. All five
close.

| # | verdict | evidence |
|---|---|---|
| 1 HIGH `AGENTS.md` | **CLOSED, on the point** | `AGENTS.md:163-167` now reads "in fact slightly FASTER (default 231/190s vs explicit 189/165s, app workspace) - tracking a declining e2e neighbour across the interleave, not the key scheme; the supersession rests on the code reading, not on wall clock". That is what `s5-clean-key.md:42-44` measured and what `:64-69` instructed. A letter-fix would have deleted the clause and left the reader with no reading of the numbers; this one states the reading and re-anchors the conclusion on the code. |
| 2 MED 31.5s provenance | **CLOSED, on the point** | `measurements/s2-guard-cost.md:233-262` addendum quotes the four raw per-file lines with their source logs and, crucially, reproduces `s0-baseline.md`'s own labels rather than paraphrasing: run 1 "CONTENDED at start: host CPU 100%, 1 other live vitest run [...] QUIET by the end" against `s0-baseline.md:45,53`; run 2 "CONTENDED by two live e2e suites, ZERO other vitest runs (host CPU 34%)" against `:70,78`; run 3 against `:97`. It also corrects the ratio's meaning ("180s budget / 31.5s, not a loaded-vs-quiet ratio"). 180/31.5 = 5.71. |
| 3 MED decoy recording | **CLOSED, both halves** | `spec:543-548` bracketed supersession naming `b81ceb23`, r1-adjudications A3 and the 4/6-vs-0/6 reproduction, and correctly preserving the half of the old text that is still true ("send rejects '..' before the filesystem"). `s3-static-smoke.md:116-120` dated note in the traversal section. Both are marked addenda, not rewrites, which is the right treatment for as-produced records. |
| 4 MED false provenance | **CLOSED** | `dynamoAdmin.ts:199-201` now reads "which predates this change (1448b130, 2026-08-16)". Verified: `git log -1 1448b130` is `Sun Aug 16 18:54:09 2026`, it is an ancestor of `main`, and `git show 1448b130 -- app/scripts/db-update-gsis.ts | grep -c sendWithInternalFailureRetry` returns 0, so the alternative charitable reading is also excluded. |
| 5 LOW ASCII | **CLOSED** | `plan-r3-reviewer-c.md:324,329,330` now read `OK`; the file is 0 bytes above 0x7F (byte-counted). The wave's own diff adds 0 non-ASCII lines across all 12 files. |

---

## NEW CLAIMS VS FACTS - all verified, no new wrong claim

Every factual assertion this wave committed, checked against the repo:

| claim | where | verdict |
|---|---|---|
| `TRANSIENT_ERROR_STATUS_CODES = [500, 502, 503, 504]` | `dynamoAdmin.ts:96`, adjudications `:7-8` | **TRUE** - `node_modules/@smithy/core/dist-cjs/submodules/retry/index.js:35`, verbatim; used at `:65` against `error.$metadata?.httpStatusCode` |
| SDK "retries up to 3 attempts by default" | `dynamoAdmin.ts:96`, anchor issue `:53` | **TRUE** - `DEFAULT_MAX_ATTEMPTS = 3`, same file `:429` |
| "`InternalServerError` carries no `$retryable` trait, so classification hangs on `$metadata.httpStatusCode`" | `dynamoAdmin.ts:97` | **TRUE** - `$retryable` does not appear anywhere in `node_modules/@aws-sdk/client-dynamodb/dist-cjs/index.js`, so no DynamoDB exception declares it |
| the nesting question is UNKNOWN, not settled | `dynamoAdmin.ts:90-99` | **SOUND** - this is the narrowing I would have asked for; the preamble now claims only what the issue history proves ("both faults have repeatedly ESCAPED to callers") and labels the rest open in both directions |
| 900s predates this change (`1448b130`, 2026-08-16) | `dynamoAdmin.ts:199-201` | **TRUE** (above) |
| TTL legs: workers skip, globalSetup / db:create / e2e lanes run them | `dynamoAdmin.ts:187-191` | **TRUE** and it matches our own probe - `globalsetup-reenables-ttl-on-shared-tables.md:14-28`, `globalSetup.ts:90-92`, `vitest.config.ts:119` |
| `importApply.integration.test.ts:72-77` is a delete-then-create loop | `dynamoAdmin.ts:470-490`, case 23's comment | **TRUE** - `beforeAll` at `:72`, `deleteTableIfExists` then `ensureTable` per table, 60s budget |
| `pollDelay` gives 100 -> 200 -> 400 -> 800 -> 800, ~16 reads per 10s | `dynamoAdmin.ts:261-270` | **TRUE** - `baseMs * Math.min(2 ** (reads-1), 8)` with `reads` from 1; 100+200+400+800 = 1500, then 800 each, so 4 + 11 = ~15-16 reads inside 10s |
| acceptance suite is now 25 cases | `AGENTS.md:171`, anchor `:19`, handback addendum | **TRUE** - 25 `it('case N:` blocks, N = 1..25 contiguous |
| gate 2 "6439 tests, +3 for the new acceptance cases" | handback addendum | **CONSISTENT** - 6436 (round-1 handback `:32`) + 3 new cases = 6439. The run itself is UNVERIFIED (forbidden). |
| "the un-retried path is byte-identical to before" | `planner-fix-wave.md:33-34` | **TRUE as behaviour** - checked against `git show main:app/src/lib/dynamoAdmin.ts`; see finding 4 for the missing pin |

One imprecision, not worth a finding: `planner-fix-wave.md:194` says case 21's
2.5s is "well inside the 5s default per-test timeout". Vitest's stock default
is 5s but this workspace configures `testTimeout: 60_000`
(`app/vitest.config.ts:60`, cited by `logCallSiteGuard.test.ts:169`). The
conclusion holds under either number.

---

## COVERAGE OF THE FIX WAVE ITSELF

Every case does assert what the adjudications say it asserts. Traced by hand
against the new control flow (`dynamoAdmin.ts:299-334`: retryable -> endpoint
gate -> verify -> attempt bound -> deadline -> onRetry -> sleep):

- **case 23** (`:693`) - `DeleteTable [IF, RIU]`, `DescribeTable [DELETING,
  DELETING, RNF]`; asserts resolves, 2 `DeleteTable`, **3** `DescribeTable`.
  Has teeth: delete the `pollUntilTableGone` call and it reads 0.
- **case 24** (`:719`) - asserts `failure` is the `conflict` **by identity**
  (`toBe`), `instanceof ResourceInUseException`, message carries `stub-c24` and
  `DELETING`. Traced: `resourceInUse()`'s message is "Table already exists:
  stub", so `stub-c24` can only come from the appended poll message - the
  assertion is not satisfiable by the original error alone.
- **case 25** (`:742`) - `UpdateTimeToLive` always fails; `DescribeTimeToLive`
  scripted DISABLED x4 then ENABLED. Traced: guard read, then one hook read per
  failed attempt, the 4th returning ENABLED -> `landed` -> `return`. 4 sends, 5
  reads, resolves `'created'`. Reverting the reorder makes attempt 4 throw
  before its read, so the case has teeth in the right direction; the
  implementer's RED log says exactly that.
- **case 10** (`:408`) - title and interleave updated to 9 elements ending on
  `DescribeTimeToLive`; the trailing read is the whole content of the change,
  and the send count stays 4, which is what still pins the attempt bound.
- **case 21** (`:625`) - reshaped to an equality. Traced: send 1 fails at ~5ms
  (elapsed far below the 2000ms deadline, so it cannot stop early); send 2
  fails at ~2500ms (elapsed >= 2505 > 2000 when its catch runs, so it cannot
  fail to stop). Exactly 2 sends, and `rejects.toBe(fault)` gives it a second
  set of teeth because the fallback throws a DIFFERENT instance. Genuinely
  deterministic in both directions - a real improvement on the ratio.
- **case 4** (`:315`) - correctly adapted, and the loss of its
  "returns immediately" meaning is disclosed rather than glossed
  (`planner-fix-wave.md:135-145`). See finding 4 for what that leaves unpinned.
- **cases 11/12** - unaffected by the reorder, because the endpoint gate stayed
  ahead of the hook (`dynamoAdmin.ts:301-304`). I checked this rather than
  taking the implementer's STOP-condition note: a non-local client throws at
  `:304` before `opts.verify` is consulted, so the zero-extra-sends property
  holds.
- **staticSmoke (c)** (`:378-392`) - the two unreachable loops are gone;
  `identityHolds` is the conjunction and `ctx.skip` throws, so the guard is the
  assertion. Correct, and the comment now says why a failing condition must SKIP.

`pollUntilTableGone` IS pinned by cases 23 and 24 in the sense that deleting it
breaks both - but its distinguishing internal rule is not, which is finding 3.

---

## ALSO CHECKED, CLEAN

- **The catch reorder is safe for every other contract clause.** `local ??=`
  still resolves at most once; `isRetryableContainerFault` is still first, so a
  non-retryable error never reaches the gate or the hook; the hook is still
  called at most once per attempt inside a single `if (opts.verify)` block with
  no loop; `throws -> rethrow the ORIGINAL` is unchanged apart from the added
  `cause`; the deadline still stops re-sends only.
- **`err.message` / `err.cause` mutation of SDK instances** (`:316`, `:687`,
  and pre-existing at `ensureTable`) - consistent with the pattern already
  shipped and required by cases 19 and 24's identity assertions.
- **`deleteTableIfExists`'s new `poll?: PollOptions`** is optional; no product
  caller passes it (`db-create.ts:63`, `:75` take defaults), so no signature
  break.
- **`git status` is clean** apart from my own report files; the wave staged
  explicit paths and every code commit carries the Opus trailer.
- **ASCII**: 0 added non-ASCII lines across the wave; `plan-r3-reviewer-c.md`
  is 0 bytes above 0x7F.

## UNVERIFIED

The gate results asserted in the handback addendum (gates 1/2/3/5 on
`2fdb0dd8`, and the five gates on `91c831d6`), the RED/GREEN logs under
`.superpowers/sdd/reports/`, and the implementer's per-file verify table. All
are runtime claims; running anything was forbidden. Nothing I read statically
contradicts any of them. Gate 4 is the subject of finding 1.
