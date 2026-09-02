# Planner's adversarial code review, round 2 - the fix wave

Target: `git diff 5f224289..HEAD` in `W:\tmp\npm-test-soundness`. Read cold, as
new unreviewed code. Static reading, git and grep only; no suite, npm script,
vitest, playwright or Docker command was run.

Still plan-blind and spec-blind. The only process document opened was
`planner-fix-wave-adjudications.md`, as directed.

Code read in full at HEAD: `app/src/lib/dynamoAdmin.ts`,
`app/test/dynamoAdminRetry.test.ts`, `app/test/staticSmoke.test.ts`, plus
`eslint.config.mjs`, `app/scripts/db-create.ts`, `app/test/globalTeardown.ts`
for consumer sweep.

---

## Part 1 - what the fix wave introduced that nobody has reviewed

### 1. [MEDIUM] The reorder's load-bearing safety invariant is asserted by NO test, and the comment claiming it cites two cases that structurally cannot exercise it

`app/src/lib/dynamoAdmin.ts:300-304`:

```ts
// The endpoint gate stays AHEAD of the hook: against a non-local endpoint
// this module is inert, and an inert module must not spend a control-plane
// read either (cases 11 and 12 assert exactly zero extra sends).
local ??= await isLocalDynamoEndpoint(client);
if (!local) throw err;
```

The code is correct - I traced it: a non-local endpoint throws at `:304`, above
the `if (opts.verify)` block at `:305`, so a non-local client gets zero mutation
re-sends **and** zero verification reads. That is the property that makes the
whole plan override safe, and it is the property the adjudication (row 2) rests
on.

It is not tested, and the two cases the comment names cannot test it:

- Case 11 (`app/test/dynamoAdminRetry.test.ts:432-441`) and case 12 (`:443-452`)
  both call `ensureTable(stub.asClient(), NO_TTL, 'stub', LIVE_ENV, ...)`.
- `NO_TTL = getTableSpec('contacts')` (`:246`), which carries no `ttlAttribute`
  (`app/src/lib/tables.ts` - the contacts spec has none), so
  `ensureTable`'s `if (spec.ttlAttribute && !ttlDisabled)` guard is false and
  `enableTtlIfNeeded` never runs.
- `enableTtlIfNeeded` is the ONLY place `sendWithRetryVerified` is constructed
  inside `ensureTable`. So neither case ever builds a `verify` hook at all.
- Both assert only `count('CreateTable')`. Neither asserts
  `count('DescribeTimeToLive')`, and `ensureGsis` - the other hooked caller - is
  never driven with a non-local stub anywhere in the file.

Move the gate below the hook and **every one of the 25 cases still passes.** The
one safeguard whose failure mode is "an inert module spends a control-plane read
against real AWS" has no teeth.

Cheap fix: one case - non-local endpoint, `TTL_SPEC`, `UpdateTimeToLive` scripted
to fail once - asserting `count('UpdateTimeToLive') === 1` **and**
`count('DescribeTimeToLive') === 1` (the pre-send guard only, no hook read).

### 2. [MEDIUM] The `cause` chains the wave added to both poll errors are discarded by both production callers, so finding 12's fix is inert everywhere except a direct call

The wave added `{ cause: lastReadError }` to `TableNotActiveError`
(`dynamoAdmin.ts:466`) and `TableNotGoneError` (`:511`), each carrying the last
`DescribeTable` failure so "an operator reading `still unreadable after 10000ms`
can see WHY it was unreadable" (`:392-395`).

Both callers then throw the poll error away:

`ensureTable:569-577`
```ts
} catch (pollErr) {
  if (!(pollErr instanceof TableNotActiveError)) throw pollErr;
  err.message = `${err.message} (${pollErr.message})`;
  throw err;
}
```

`deleteTableIfExists:686-694` is byte-for-byte the same shape with
`TableNotGoneError`. In both, only `pollErr.message` survives; `pollErr` itself -
and therefore the `cause` just plumbed into it - is dropped, and the error the
operator actually receives is the original `ResourceInUseException` with no
cause at all.

So the operator the fix was written for still cannot see why the container was
unreadable. The `cause` is observable only from a direct
`pollUntilTableActive` / `pollUntilTableGone` call, which nothing in the product
does.

One line each: `if (err.cause === undefined) err.cause = pollErr;` before the
rethrow - the same guarded-assignment idiom the wave already used at `:316`.

### 3. [MEDIUM] None of the wave's new error-diagnostics code is covered, and neither poll's `unreadable` branch is reached by any case

`grep -n "cause\|unreadable\|TableNotGone\|pollUntilTableGone"
app/test/dynamoAdminRetry.test.ts` returns **two hits, both incidental** (the
words inside the two fault-message strings at `:222` and `:231`). Concretely
uncovered, all added by this wave:

- `dynamoAdmin.ts:316` - `if (err instanceof Error && err.cause === undefined) err.cause = hookErr;`.
  Case 7 (`:363-375`) drives that control path but asserts only
  `rejects.toMatchObject({ name: 'InternalFailure' })`; delete line 316 and case 7
  still passes.
- `:466` and `:511` - the poll `cause` arguments. No case constructs a poll error
  with a read failure behind it.
- `:462` and `:507` - the `observed = 'unreadable'` branches. Every poll case
  (2, 17, 19, 23, 24) scripts *readable* describes (`CREATING` / `DELETING` /
  `ResourceNotFoundException`), so no case ever makes a poll read throw a
  non-RNF error.
- `pollUntilTableGone` as a directly-called export. `pollUntilTableActive` has
  case 17 exercising it in isolation; the new GONE poll has no equivalent, so its
  own error class, message and ceiling behaviour are only ever seen through
  `deleteTableIfExists`.

Three of this wave's changes could be reverted with the suite still green. That
is the same "tests that cannot fail" standard the wave was written to satisfy.

### 4. [MEDIUM] `pollUntilTableGone` silently inherits a ceiling whose entire written justification is about an EMPTY, JUST-CREATED table - and on exhaustion it converts a delete that LANDED into a thrown conflict

`pollUntilTableGone:497` takes `DEFAULT_POLL_CEILING_MS` with no argument of its
own. That constant's justification block (`:195-219`) is written exclusively
about the ACTIVE poll:

- `:195-197` "a table that is still not ACTIVE after 10s locally is not going to
  become so inside the same test hook";
- `:202-206` "This one waits on a table THIS call just created - empty ... An
  empty table that is still not ACTIVE after 10s is stuck, not busy";
- `:217-219` "A DescribeTable that FAILS inside the poll counts as not-ACTIVE by
  design ... (see pollUntilTableActive)".

Nothing there argues 10s for a DELETE, and the object being waited on is not an
empty just-created table. `dropAllTables` (`app/scripts/db-create.ts:58-79`) is
reached by `db:create --reset` against the human's imported local dataset and by
`globalTeardown`'s `dropKeyedLocalTables` (`app/test/globalTeardown.ts:55`
imports `dropAllTables`) - populated tables in both cases.

**Answering the coordinator's question directly: yes, the "other read failures
count as maybe-still-there" rule turns a successful delete into a thrown error.**
Scenario: attempt 1 landed (table DELETING), attempt 2 drew the conflict, and the
container - which is by construction in the buckling state that got us here -
answers `DescribeTable` with `InternalFailure` for the whole ceiling.
`pollUntilTableGone` throws `TableNotGoneError`, `deleteTableIfExists:690-692`
rethrows the `ResourceInUseException` with "(table X is still unreadable after
10000ms)" appended, and a run whose delete SUCCEEDED fails, blaming a resource
conflict - which is verbatim the anti-pattern the module's own preamble says it
exists to remove (`:96-101`).

I do not think that makes the fix wrong: guessing "gone" from an unreadable
container is unrecoverable for the delete-then-create caller, and versus `main`
this is a slower failure rather than a lost success. But the risk is real, it is
carried by a constant with no argument written for this use, and the paragraph at
`:213-215` that reassures the reader ("A slower failure, not a lost success") is
scoped to the ACTIVE poll and was not extended. Give the GONE poll either its own
ceiling constant with its own two-sentence argument, or one sentence in the
`DEFAULT_POLL_CEILING_MS` block saying why 10s is also right for a drop.

### 5. [LOW] `pollUntilTableGone` computes an `'absent'` status it can never act on, and can therefore throw "table X is still absent after 10000ms"

`dynamoAdmin.ts:503-504`:

```ts
const { Table } = await client.send(new DescribeTableCommand({ TableName: physicalName }));
observed = Table?.TableStatus ?? 'absent';
```

There is no `if (observed === 'absent') return;`. A successful `DescribeTable`
carrying no `Table` therefore polls to the ceiling and produces a
self-contradicting operator message - the poll refusing to accept as gone the one
status that means gone. Unreachable against real DynamoDB (a missing table throws
`ResourceNotFoundException`, which `:506` handles), reachable against a stub or
any nonstandard endpoint. Either drop the `?? 'absent'` fallback, or treat it as
proof of gone; carrying it as a status that the loop then ignores is the worst of
the three.

### 6. [LOW] The two polls now sit side by side and disagree about `ResourceNotFoundException`

`pollUntilTableGone:506` special-cases `ResourceNotFoundException` as decisive.
`pollUntilTableActive:461-463` still folds it into the bare `catch` as
`'unreadable'`, so if the table `ensureTable` just conflicted with turns out to be
absent, the ACTIVE poll burns its full ceiling and reports "still unreadable",
naming the wrong condition - now with the RNF attached as a `cause` that the
caller then drops (finding 2). Pre-existing from wave 1; the wave-2 diff put the
two loops adjacent and did not reconcile them, which is when a reader will next
notice and mis-diagnose it.

### 7. [LOW, UNVERIFIED] The whole retried-DELETING path's reachability against DynamoDB Local is unrecorded in either direction

The new poll is only reached when a re-sent `DeleteTable` draws
`ResourceInUseException` - i.e. only if DynamoDB Local exposes a DELETING window.
Nothing in the repo records a sighting of that, and if the container's
`DeleteTable` completes synchronously the re-send draws
`ResourceNotFoundException` instead, which returns at `deleteTableIfExists:669`
without ever reaching `pollUntilTableGone`. Cases 23/24 drive a stub, so they
cannot settle it (and I am not permitted to run Docker). The fix is correct if the
window exists and inert if it does not, so this is not a reason to hold it - but
the anchor issue's new "WHAT THE NEXT SIGHTING MUST RECORD" line
(`docs/issues/npm-test-dynamodb-local-contention.md`, the block added at `:50-55`)
should add the re-sent `DeleteTable`'s error class to the two `$metadata` fields
it already names. Same two-field cost, settles this too.

---

## Part 2 - contesting the adjudications

**Row 2 (my finding 2 / the ratified-plan override) - I attacked it as directed
and it holds. The reorder is safe. I do not contest it.**

The three specific hazards, each traced at HEAD:

- *Does it introduce a send after the bound?* Only a READ, and only one. The bound
  governs mutation re-sends: `opts.onRetry?.()` - and therefore `retried`, which
  gates both `ensureTable`'s and `deleteTableIfExists`'s new poll paths - still
  fires at `:333`, strictly after both `if (n >= attempts)` (`:331`) and the
  deadline (`:332`). A final-attempt verify can never set `retried`, can never
  cause a re-send, and can never change `sendWithRetry`'s behaviour (it passes no
  `verify`, `:363-368`).
- *Can it loop or double-count?* No. `:305-320` calls `opts.verify()` exactly once
  per iteration and then either `return`s (landed) or falls through. There is no
  path that re-enters the hook without a new mutation attempt first.
- *Can it run after the deadline has expired?* Yes - and that was already true
  before this wave (case 22 pins it), because the deadline was already read after
  the verify block. Critically, the reorder does **not** widen the documented
  wall-clock bound. The deadline is still read only after `attempt_n` and
  `verify_n`, so the worst case is still `deadlineMs - eps + one attempt + one
  verification read`, exactly as `:167-172` states, whether or not iteration `n`
  is the final one. The only cost is +1 control-plane read per hooked call: 2N
  instead of 2N-1 (8 instead of 7 at defaults).

Case 25 (`app/test/dynamoAdminRetry.test.ts:707-736`) is a real, falsifiable pin -
five scripted `DescribeTimeToLive` answers with `ENABLED` last, asserting 4
`UpdateTimeToLive` and 5 `DescribeTimeToLive` - and it rejects if the bound is
read first. Case 10's update (`:408-429`) correctly extends the interleave by one
trailing read. The only thing wrong with the override is finding 1: the invariant
that makes it safe is untested.

**Row 3 (backoff) - correct, and it breaks no existing case.** I walked every
poll-touching case against `pollDelay(base, reads) = base * min(2**(reads-1), 8)`
(`dynamoAdmin.ts:261-269`):

- case 2 (`:288-305`) `intervalMs: 1`, script `[CREATING, CREATING, ACTIVE]`,
  sleeps 1ms then 2ms, `count === 3` - unchanged;
- case 17 (`:519-535`) `ceilingMs: 25` - reads at ~0/1/3/7/15/23ms, assertion is
  `toBeGreaterThan(0)` - unchanged;
- case 19 (`:554-579`) and case 20 (`:581-623`) assert no poll counts, or
  `toBeGreaterThanOrEqual(1)` / `toBe(0)` - unchanged.

One cosmetic consequence nobody noted: the deadline is read *before* the sleep, so
the ceiling now overshoots by up to one capped interval (800ms at defaults). The
message still says "after 10000ms" when ~10.8s of wall clock has passed.

**Row 11 (case 21 reshape) - correct, and genuinely deterministic in both
directions.** Send 1 at 5ms, send 2 at 2500ms, `deadlineMs: 2000`, `attempts: 12`:
the catch after send 2 always reads elapsed >= 2505 > 2000, so exactly 2 sends,
and the `.fallback` is a *different* `internalFailure()` instance so a third send
would break both the count and the `rejects.toBe(fault)` identity. Worth knowing:
the case now spends 2.505s of real timer time, against the file's own constraint
at `:243-244` ("this file must not spend ~4-5s in real setTimeout"). Still inside
it, with cases 20 and 22 adding ~55ms more.

**Row 12 partial decline (`db-update-gsis.ts:80`) - I accept the decline.** That
swallow leads to a re-send, not a throw; there is no surfaced error to hang a
cause on. Recording it in the adjudications is the right disposition.

**Row 5 ACCEPT-NARROW - the rewrite is accurate and correctly hedged.** The new
preamble (`:90-101`) now claims only the escape history, names the SDK's
5xx/3-attempt classification and the missing `$metadata.httpStatusCode` as an open
question, and `:174-180` carries the ~30s-vs-~10s consequence into the deadline
block with the "unverified in either direction" marker. The `maxAttempts` decline
is right on scope grounds: it is `app/src/lib/dynamo.ts` and would change every
local data-plane send.

**Row 10 (staticSmoke) - clean, and no gate-5 risk.** The two unreachable loops
are gone (`app/test/staticSmoke.test.ts:380-392`) and the guard is the test. The
resulting case has zero `expect()` calls; I checked `eslint.config.mjs` (92 lines)
and it registers no vitest/jest plugin, so there is no `expect-expect` rule to
fire. `IDENTITY_PRESENT` / `IDENTITY_ABSENT` remain used by `identityHolds` and by
describe (b), so no unused-binding error either.

---

## Part 3 - my seven round-1 findings, verified closed or accounted for

| r1 | status at HEAD |
|---|---|
| 1 (delete tolerance) | CLOSED. `deleteTableIfExists:684-694` polls; cases 23/24 pin both outcomes; the un-retried path (`:695`) is untouched and still pinned by case 18. The inaccurate "commonest caller" sentence was rewritten (`:679-690`) and now cites `importApply.integration.test.ts:72-77` by file:line. |
| 2 (SDK retry claim) | CLOSED-NARROW, correctly. See row 5 above. |
| 3 (final-attempt verify) | CLOSED. `:331` now sits below the verify block; case 25 pins it. |
| 4 (poll hammering) | CLOSED. `pollDelay` at `:261-269`; ~16 reads per 10s instead of ~100. |
| 5 (unreachable staticSmoke loops) | CLOSED. |
| 6 (case 21 wall-clock) | CLOSED, better than I proposed - equality instead of a wider ratio. |
| 7 (swallowed causes) | PARTIALLY EFFECTIVE. The code is there; findings 2 and 3 above are why it does not yet reach an operator or a test. |

Also re-checked and clean: 25 contiguous cases (1-25), matching the "25-case"
figure now in `AGENTS.md` and the anchor issue; zero non-ASCII characters on added
lines across `app/**`, `AGENTS.md` and `docs/issues/**`; the `AGENTS.md`
clean-key rewrite now states what its own numbers support (explicit arm slightly
faster, supersession resting on the code reading).
