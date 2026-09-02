# Slice 2 - broadcastFanOut: the durable claim and the three closes

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `2e0c9589` (slice 5b's build record; main already merged at
`8c8b7100`, no further sync performed).

Commits:

- `c7d3b5f0` feat(broadcast): claim the fan-out pass durably and close every exit
- (this report, committed separately)

This is the anchor bug of mission M5. Scope was exactly two files -
`app/src/jobs/broadcastFanOut.ts` and `app/test/broadcastFanOut.test.ts`.
Nothing else was opened for edit; `relayFanOut.ts` (slice 3) is untouched.

The code and its tests ship in ONE commit deliberately. The rewritten cap test
and the implementation are two halves of the same behavior change: the old cap
test drives the cap by putting `attempt: 3` in the ENVELOPE, which the durable
counter makes advisory, so an implementation-only commit would have been red and
a test-only commit would have been red the other way. One commit keeps every
point on the branch green.

---

## 1. What shipped

### `app/src/jobs/broadcastFanOut.ts`

- `:57` - `import type { FanoutClaimResult } from '../repos/fanoutClaim.js';`
  (the only new import; type-only).
- `:248-249` - the two pins, immediately after the broadcast-not-found return.
  `const repo = broadcasts` is the plan's pin for the lazily-initialised repo.
  `const snapshot = broadcast` is a SECOND pin the plan did not anticipate; see
  deviation 1.
- `:251-262` - the `closeBroadcast` docblock, stating that the three closes are
  three situations sharing one terminal shape, and naming the D12 throw as the
  exit deliberately NOT closed.
- `:263-290` - `closeBroadcast(recipientKeys, code, cause?)`, defined INSIDE the
  handler closure. Body lifted from the old cap branch: per key not already
  terminal in the pass snapshot -> `recordRecipient({status:'failed',
  errorCode: code})`, `bumpStats({failed:1, queued:-1})`,
  `emitBroadcastProgress`; then ONE operator `log.error`; then `finalize` once.
- `:308-334` - the claim, after the recipient derivation (`keys`, `:300-306`)
  and before the send loop (`:341`), guarded by
  `pending = keys.filter((k) => !isTerminal(...))` at `:314`.
  `let claim: FanoutClaimResult | undefined` at `:316` is in HANDLER scope.
  `missing` -> `log.warn` + return (`:319-325`); `capped` -> close B + return
  (`:326-331`).
- `:556-598` - the continuation block. The `nextAttempt > MAX_BROADCAST_ATTEMPTS`
  test is GONE; `nextAttempt = claim.attempt + 1` (`:568`) survives and still
  feeds both the enqueued payload (advisory) and `broadcastBackoffMs(nextAttempt)`
  unchanged. The `return` after a successful enqueue is kept.

### `app/test/broadcastFanOut.test.ts`

- `:152-181` - four local helpers: `closeLines(capture)` (the close's single
  operator ERROR line, matched by message so an unrelated error cannot inflate
  the count), `capturingLogger()`, `neverSends()` and `alwaysRateLimits()` -
  the last two are `vi.fn` COUNTERS, because this file replaces the messaging
  adapter wholesale and `world.sent` therefore stays empty for a recipient that
  defers on every pass (research finding 4).
- `:426-467` - the REWRITTEN cap test, now close A driven for real.
- `:469-497` - close B.
- `:499-538` - close C, the RED-ON-MAIN regression test for the anchor bug.
- `:420` - the pass-1 continuation test also asserts `fanout_attempt === 1`.
- `:579`, `:587` - the redelivery test also asserts the counter is 1 before AND
  after the duplicate delivery.
- `:606-628` - a NEW all-terminal pass case: no send, counter still ABSENT,
  falls through to the trailing finalize.

Test count for the file: 25 -> 28.

## 2. The three closes and their triggers

| close | trigger | code | site |
|---|---|---|---|
| A | the pass that just ran WAS the last rung: `claim.attempt >= MAX_BROADCAST_ATTEMPTS` with recipients still deferred | `transient_cap` | `broadcastFanOut.ts:569-573` |
| B | the pass BEGAN with the ladder spent: the claim returns `capped` | `transient_cap` | `broadcastFanOut.ts:326-329` |
| C | the continuation enqueue threw | `enqueue_failed` | `broadcastFanOut.ts:588-594` |

Both code strings are the literals slice 5b registered in
`INTERNAL_CODE_REASONS`; the tests assert the literals, because a misspelling
would silently regress to the raw-token defect D22 exists to fix and nothing
else in the stack would catch it.

All three leave the SAME terminal shape, and each test enumerates it
separately rather than sharing an assertion helper: every recipient terminal,
persisted `stats.queued === 0`, the row finalized (asserted both as
`toBe('failed')` and as `not.toBe('sending')`), and exactly one operator
`log.error`.

Close A is the only close with a production trigger once the counter is
durable; close B can only be constructed (seeded at the cap), which is why the
plan required both and why close A is driven through three real passes rather
than seeded.

**Close C carries the cause.** `closeBroadcast` takes an optional third
argument and folds it into the SAME log line as `err`, rather than the catch
logging its own error. Two error lines would have made "one operator line per
close" false for close C alone.

## 3. RED evidence for close C

Captured BEFORE any edit to `app/src/jobs/broadcastFanOut.ts`, by running the
new tests against the untouched job -
`.superpowers/gates/s2-red-vitest.log`, **exit code 1**:

```
 Test Files  1 failed (1)
      Tests  5 failed | 23 passed (28)
```

The close-C failure, quoted:

```
 FAIL  test/broadcastFanOut.test.ts > broadcast.send (M1.8a) > close C: a continuation the queue REFUSES closes the
broadcast instead of leaving it sending
AssertionError: expected 'queued' to be 'failed' // Object.is equality

Expected: "failed"
Received: "queued"
```

That is the anchor bug verbatim: with the queue refusing the continuation, the
pre-slice code leaves the recipient `queued`, the broadcast `sending`, and
nothing ever comes back (the redelivery is suppressed at the job marker). The
same run's other four failures were the pass-1 `fanout_attempt === 1`
assertion, close A's log line, close B (the send stub was called - the seeded
counter meant nothing), and the redelivery counter assertion. The all-terminal
case PASSED red-side, correctly: it asserts an ABSENT counter, which is also
true of a tree with no counter at all - it is a D6 guard, not a regression test.

The worklist's alternative proof (temporarily comment out the close-C
try/catch, observe red, restore) was NOT needed: running the new test against
the untouched file is the same evidence with no window in which the shipped
source is deliberately wrong.

## 4. Deviations and decisions

1. **A second pin was required: `const snapshot = broadcast` (`:249`).** The
   plan anticipated the pin for the reassignable `let broadcasts`, and that was
   necessary. It did NOT anticipate that `closeBroadcast`, being a hoisted
   FUNCTION DECLARATION, also does not inherit the `if (!broadcast) return`
   narrowing of the `const broadcast`. Gate 1 caught it exactly as the plan
   predicted it would, as `TS18048: 'broadcast' is possibly 'undefined'` at the
   terminal re-check. Pinned rather than asserted, per "narrow explicitly,
   never assert".
2. **The continuation block opens with an unreachable-by-construction guard**
   (`:557-565`): `if (claim?.outcome !== 'claimed')` closes with `transient_cap`
   and returns. `claim` is `FanoutClaimResult | undefined` in handler scope, so
   `claim.attempt` cannot be read without narrowing, and the plan's snippet
   (`if (claim.attempt >= MAX...)`) does not compile as written. A key can only
   reach `transientRemaining` from inside the send loop, which only runs for a
   non-terminal slot, so `pending` was non-empty and the claim was `claimed`.
   Closing rather than falling through keeps D8 true even if the impossible
   happens; falling through would finalize a broadcast with recipients still
   queued, which is the exact failure this slice removes. It is a fourth CALL
   SITE of `closeBroadcast`, not a fourth close: it has no trigger.
3. **The operator log message changed.** It was
   `'broadcastFanOut: transient retry cap reached - remaining recipients marked
   failed'` (with an em dash) and is now
   `'broadcastFanOut: fan-out closed - remaining recipients marked failed'`,
   with the reason carried in the `closeCode` binding. Three closes share the
   line, so a cap-specific message would have been false for two of them, and
   the rewritten line has to be ASCII. Nothing in the repo greps for the old
   string (checked: the only other occurrence is `relayFanOut.ts:948`, slice
   3's to change).
4. **The block comment above the continuation (`:553-554`) was left untouched**,
   including its "Beyond the cap" wording, now more precisely "at the cap". It
   is pre-existing non-ASCII and slice 6 owns the comment sweep in this region.
5. **`world.sent` is not used for any send count in the new tests** - see the
   helper note above. `expect(world.sent).toHaveLength(3)` would have asserted 0
   and failed for the wrong reason.
6. **`deliverDelayed` is never called.** It drains TRANSITIVELY and empties
   `delayed[]`, so one call would run passes 2 and 3 together and erase both
   delays. Close A shifts one continuation at a time, records its
   `delaySeconds`, and dispatches it. No test in this file had driven a second
   pass before.

## 5. D8 / D12: the fourth exit, deliberately not closed

`broadcastFanOut.ts:537` still throws on an unrecognised send error. That exit
leaves the current recipient `queued`, strands every later key in the loop, and
leaves the broadcast `sending` - and because the redelivery it is asking for is
suppressed by the job-execution marker, nothing comes back. It is NOT closed
here: D12 declines it and it is filed as
`throw-for-redelivery-defeated-by-job-marker` (high). Spec D8's "every exit"
must be read as "every exit except that throw"; the slice's three closes are
not an exhaustive enumeration of the handler's exits.

The false comment above that throw (`:534-536`, claiming a redelivery gets a
fresh `jobId`) was left exactly as found. Slice 6 owns that correction.

## 6. Gates

Logs under the gitignored `.superpowers/gates/`. No command was piped; each
gate was redirected to a file and read afterwards. `npm test`, `npm run smoke`,
`npm run e2e` and eslint were NOT run - the orchestrator owns those.

**RED first (TDD)**, new tests against the untouched job -
`.superpowers/gates/s2-red-vitest.log`, **exit code 1**: `Tests 5 failed | 23
passed (28)`. Quoted in section 3.

**Gate 1** `npm run typecheck` from `W:\tmp\retry-counter-durable` -
`.superpowers/gates/s2-typecheck.log`, **exit code 0**, all five workspaces.
(Its first run was exit 2 on the single `TS18048` of deviation 1.)

**Gate 2** `npx vitest run test/broadcastFanOut.test.ts
test/broadcastsRepo.integration.test.ts` from
`W:\tmp\retry-counter-durable\app` - `.superpowers/gates/s2-vitest.log`,
**exit code 0**. Per file, quoted:

```
 v test/broadcastsRepo.integration.test.ts (19 tests) 406ms
 v test/broadcastFanOut.test.ts (28 tests) 92ms
 Test Files  2 passed (2)
      Tests  47 passed (47)
   Duration  5.33s
```

(Check marks ASCII-flattened.) The integration suite ran against the live
DynamoDB Local on `:8000` - it did not self-skip, so slice 0+1's claim
primitive is still proven by the same run that proves its first caller.

ASCII: the added lines of the commit's diff were byte-scanned for code points
above 126 - zero hits. Pre-existing non-ASCII in both files (em dashes, arrows)
is untouched context.

## 7. What slice 3 must know

1. **The narrowing problem has TWO halves, not one.** The repo pin the plan
   names is necessary but not sufficient: any point-in-time item the close
   helper re-checks needs its own pin if the helper is a function declaration.
   In `relayFanOut.ts` that is `sourceMessage`. Expect the same `TS18048`.
2. **`claim` cannot be read without an explicit narrow.** Plan on writing the
   guard of deviation 2 (or making the close helper's call site prove
   `claimed`); the plan's snippet does not compile against
   `FanoutClaimResult | undefined`.
3. **`closeRelay` is NOT this helper.** No `finalize`, no `bumpStats`, no
   progress emit, no `sending` status exists on the relay path - only
   `markRecipient` plus the existing `log.error`. Slice 2's terminal-shape
   assertion list does not transfer wholesale; the relay's shape is "every
   pending member slot terminal" and nothing else.
4. **The delay-selective throwing adapter is the only workable close-C seam**,
   and close C must sit on PASS 1. `runDeferred` catches a handler throw so
   `settle()` resolves; `deliverDelayed` does not, so a close-C case on pass 2
   or 3 fails as an unhandled error before reaching its assertions.
5. **Relay's rungs are 5s then 10s, not 10s then 20s** - `fanOutBackoffMs` is
   passed the CURRENT pass, not the next one (D7/D11: preserved, not
   normalised). Assert the adapter-observed integer `delaySeconds`, never a
   re-derivation from the backoff function.
6. **A capped claim's `attempt` is the STORED count, not the cap**, and
   `missing` has no `attempt` at all. Close B asserts the counter is UNCHANGED
   at 3 after a capped pass; the relay equivalent should too.
7. The relay inbound-source close-B fixture must seed `delivery_recipients: {}`
   (worklist RULING relay F10). Broadcasts needed no equivalent: `recipients`
   is non-optional on `BroadcastItem` and `seedBroadcast` always populates it.
