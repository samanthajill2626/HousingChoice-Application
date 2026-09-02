# Slice 3 - relayFanOut: the durable claim and the three closes

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `3c0b90ee` (slice 2's build record; main already merged at
`8c8b7100`, no further sync performed).

Commits:

- `58764d87` feat(relay): claim the fan-out pass durably and close every exit
- (this report, committed separately)

Scope was exactly two files - `app/src/jobs/relayFanOut.ts` and
`app/test/relayFanOut.test.ts`. Nothing else was opened for edit; no fenced
file was touched.

Code and tests ship in ONE commit, as in slice 2. The reason is different here
and worth recording: relay had NO cap test to go red (research F3), so the
implementation alone would have been green-but-unproven, while the tests alone
are red. One commit keeps every point on the branch green and keeps the RED
evidence in the log rather than in history.

---

## 1. What shipped

### `app/src/jobs/relayFanOut.ts`

- `:53` - `import type { FanoutClaimResult } from '../repos/fanoutClaim.js';`
  (the only new import; type-only).
- `:77-84` - the `fanOutBackoffMs` docblock, rewritten from "5s, 10s, 20s" to
  state that the call site passes the CURRENT pass number and the live ladder
  is 5s then 10s only, the third rung being unreachable because the cap closes
  on pass 3. Comment-only ([RULING relay F5]); no timing change.
- `:822-823` - the two pins, immediately after the recipient derivation.
  `const repo = messages` is the plan's pin for the lazily-initialised repo;
  `const snapshot = sourceMessage` is slice 2's second pin, needed for exactly
  the reason its handback predicted (deviation 1).
- `:825-841` - the `closeRelay` docblock: three situations, one terminal shape,
  and an explicit statement of what this helper deliberately does NOT do
  (no finalize, no stats, no progress emit, no hub-status write) so a reader
  comparing it against `closeBroadcast` does not read the absence as an
  omission.
- `:842-861` - `closeRelay(memberKeys, code, cause?)`, defined INSIDE the
  handler closure: per key not already terminal in the pass snapshot ->
  `markRecipient({status:'failed', errorCode: code})`, then ONE operator
  `log.error`. That is the whole body - there is no third step, because
  nothing else exists on this path.
- `:863-895` - the claim, after the derivation and before the send loop,
  guarded by `pending` at `:870-872`. `let claim: FanoutClaimResult | undefined`
  at `:874` is in HANDLER scope. `missing` -> `log.warn` + return (`:881-887`);
  `capped` -> close B + return (`:888-893`), the call site mapping
  `pending.map(relayMemberKey)`.
- `:1022-1077` - the continuation block. The
  `nextAttempt > MAX_FANOUT_ATTEMPTS` test is GONE. `nextAttempt = claim.attempt + 1`
  survives and still feeds the enqueued payload (advisory). The block comment's
  "5/10/20s" claim is corrected in place.

### `app/test/relayFanOut.test.ts`

- `:93` - `seedSource` now seeds `delivery_recipients: {}`, matching production
  ([RULING relay F10]). Applied to the shared fixture rather than a variant:
  every inbound case in the file now exercises the shape the real repo would
  accept, and the file's existing map assertions are all `?? {}` / length-0
  forms, so none changed meaning.
- `:104-125` - `seedTeamSource`, the team-send shape (outbound, team sentinel,
  one `queued` slot per roster member) that close A drives.
- `:128` `TERMINAL_STATUSES`, `:136` `closeLines(capture)` (the close's single
  operator ERROR line, matched by message so an unrelated error cannot inflate
  the count), `:148` `neverSends()`, `:155` `alwaysRateLimits()` - the last two
  are `vi.fn` COUNTERS, because these tests replace the messaging adapter
  wholesale and `world.sent` therefore stays empty for a deferring recipient.
- `:586-645` close A, `:647-680` close B, `:682-723` close C, `:725-750` the
  all-terminal pass.
- `:504` / `:512` - the existing redelivery test also asserts the counter is 1
  before AND after the duplicate delivery.
- `:579` - the existing pass-1 continuation test (the file's only prior
  continuation test) also asserts `fanout_attempt === 1`.

Test count for the file: 65 -> 69.

## 2. The three closes and their triggers

| close | trigger | code | site |
|---|---|---|---|
| A | the pass that just ran WAS the last rung: `claim.attempt >= MAX_FANOUT_ATTEMPTS` with recipients still deferred | `transient_cap` | `relayFanOut.ts:1041-1045` |
| B | the pass BEGAN with the ladder spent: the claim returns `capped` | `transient_cap` | `relayFanOut.ts:888-892` |
| C | the continuation enqueue threw | `enqueue_failed` | `relayFanOut.ts:1066-1072` |

Both code strings are the literals slice 5b registered in
`INTERNAL_CODE_REASONS`, and the tests assert the literals: a misspelling would
silently regress to the raw-token defect D22 exists to fix, and nothing else in
the stack would catch it.

**The relay terminal shape is NARROWER than the broadcast one**, and each test
enumerates it rather than sharing a helper: every derived member slot terminal,
exactly one operator `log.error`, and no continuation left in `outbound.delayed`.
There is no finalize, no persisted stats and no row status to assert (F14) - so
slice 2's list does not transfer, and its absence is stated in the code's own
docblock so it is not read as an omission.

**Close C carries the cause.** `closeRelay` takes an optional third argument and
folds it into the SAME log line, rather than the catch logging its own error;
two lines would have made "one operator line per close" false for close C alone.
Same shape as slice 2.

A fourth CALL SITE of `closeRelay` exists at `:1029-1036` and is not a fourth
close - see deviation 2.

## 3. RED evidence for close C (and the rest)

Captured BEFORE any edit to `app/src/jobs/relayFanOut.ts`, by running the new
tests against the untouched job - `.superpowers/gates/s3-red-vitest.log`,
**exit code 1**:

```
 Test Files  1 failed (1)
      Tests  5 failed | 64 passed (69)
```

The close-C failure, quoted:

```
 FAIL  test/relayFanOut.test.ts > relay.fanOut (M1.7) > close C: a continuation the queue REFUSES closes the fan-out
instead of leaving a recipient queued
AssertionError: expected 'queued' to be 'failed' // Object.is equality

Expected: "failed"
Received: "queued"
```

That is the anchor bug verbatim on the relay ladder: with the queue refusing the
continuation, the pre-slice code leaves the recipient `queued` and nothing ever
comes back (the redelivery is suppressed at the job marker). The same log also
records the pre-slice handler's own escape route -
`in-process deferred dispatch failed (swallowed - SQS producer cannot observe
consumer failure)` carrying `Error: queue down` from `relayFanOut.ts:952` - i.e.
the throw that used to be the only outcome.

The other four failures in that run were: the pass-1 `fanout_attempt === 1`
assertion, the redelivery counter assertion, close A (`closeLines` empty - the
old cap branch's message is not the close message and, more to the point, the
old ladder never reached a cap in three real passes), and close B (`expected
"spy" to not be called at all, but actually been called 1 times` - the seeded
counter meant nothing to the pre-slice code). The all-terminal case PASSED
red-side, correctly: it asserts an ABSENT counter, which is also true of a tree
with no counter at all - it is a D6 guard, not a regression test.

The worklist's alternative proof (temporarily revert only the close-C
try/catch) was NOT needed: running the new tests against the untouched file is
the same evidence with no window in which the shipped source is deliberately
wrong.

## 4. Deviations and decisions

1. **The second pin was required, exactly as slice 2 predicted.**
   `const sourceMessage` is narrowed by `if (!sourceMessage) return`, but
   `closeRelay` is a hoisted FUNCTION DECLARATION and does not inherit that
   narrowing. Pinned as `snapshot` rather than asserted. (It did not surface as
   a gate-1 error because the pin was written up front on slice 2's advice.)
2. **The continuation block opens with an unreachable-by-construction guard**
   (`:1029-1036`), copied from slice 2 deviation 2: `if (claim?.outcome !==
   'claimed')` closes with `transient_cap` and returns. `claim` is
   `FanoutClaimResult | undefined` in handler scope, so `claim.attempt` cannot
   be read without narrowing. Closing rather than falling through keeps D8 true
   if the impossible happens. It has no trigger, so it is not a fourth close.
3. **No `return` was added after a successful enqueue.** Broadcast keeps one
   because a trailing `finalize` follows; relay has nothing after the `if`
   block, so the handler falls off the end exactly as on main. Every existing
   return is kept and no seventh return was introduced (F12).
4. **The `pending` guard reads `snapshot`, not `sourceMessage`.** Same object,
   same point-in-time read; using the pin keeps the pre-loop guard and
   `closeRelay`'s re-check provably reading one snapshot.
5. **The operator log message changed**, mirroring slice 2. It was
   `'relayFanOut: transient retry cap reached - remaining recipients marked
   failed'` (with an em dash) and is now `'relayFanOut: fan-out closed -
   remaining recipients marked failed'`, with the reason in `closeCode`. Three
   closes share the line, so a cap-specific message would be false for two of
   them, and the rewritten line has to be ASCII. Nothing greps for the old
   string - slice 2 had already checked, and this was its only other
   occurrence.
6. **Close A is driven with TWO recipients, not one.** The worklist's sketch
   implies a single deferred recipient and "send count 3". The test uses a
   two-member roster on a team send where Alice succeeds on pass 1 and Bob
   rate-limits on every pass, so the assertion is
   `send.mock.calls.filter(to === BOB)` having length 3. This proves the same
   thing plus one more: a terminal slot is not re-sent by a later rung and is
   not rewritten by the close. Total adapter calls are 4.
7. **`delivery_recipients: {}` went into `seedSource` itself**, not a
   close-B-only variant. The RULING allows either; the shared fixture is the
   honest one, because production seeds it on EVERY inbound relay source and
   the harness fake's tolerance was hiding the difference from every test in
   the file, not only this one.
8. **`world.sent` is not used for any send count in the new tests** - the stubs
   replace the harness adapter, so `world.sent` would have asserted 0.
9. **`deliverDelayed` is never called** (slice 2 deviation 6, same reason): it
   drains transitively and would run passes 2 and 3 together, erasing both
   delays. Close A shifts one continuation at a time and dispatches it.

## 5. D8 / D12: the exit deliberately not closed

`relayFanOut.ts:904` (`throw err` on an unrecognised send error) is untouched,
and so is its false comment at `:901-903` claiming the redelivery gets a fresh
`jobId`. That exit leaves the current recipient `queued`, strands every later
member in the loop, and asks for a redelivery the job marker suppresses. D12
declines to fix it; it is filed as
`throw-for-redelivery-defeated-by-job-marker` (high), and slice 6 owns the
comment. Spec D8's "every exit" must be read as "every exit except that
throw".

## 6. Gates

Logs under the gitignored `.superpowers/gates/`. No command was piped; each
gate was redirected to a file and read afterwards. `npm test`, `npm run smoke`,
`npm run e2e` and eslint were NOT run - the orchestrator owns those.

**RED first (TDD)** - `.superpowers/gates/s3-red-vitest.log`, **exit code 1**:
`Tests 5 failed | 64 passed (69)`. Quoted in section 3.

**Gate 1** `npm run typecheck` from `W:\tmp\retry-counter-durable` -
`.superpowers/gates/s3-typecheck.log`, **exit code 0**, all five workspaces.
(Its first run was exit 2 on a single `TS2322` in the new test file: a `vi.fn`
send stub whose object literal widened `status` to `string`; fixed with
`as const`, not a cast of the mock.)

**Gate 2** `npx vitest run test/relayFanOut.test.ts test/broadcastFanOut.test.ts`
from `W:\tmp\retry-counter-durable\app` - `.superpowers/gates/s3-vitest.log`,
**exit code 0**. Per file, quoted:

```
 v test/broadcastFanOut.test.ts (28 tests) 129ms
 v test/relayFanOut.test.ts (69 tests) 224ms
 Test Files  2 passed (2)
      Tests  97 passed (97)
   Duration  10.27s
```

(Check marks ASCII-flattened.) Slice 2's suite is re-run unchanged, so the two
callers of the claim primitive are proven by one run.

ASCII: the added lines of the commit's diff were scanned for code points above
126 - zero hits. Pre-existing non-ASCII in both files (em dashes, arrows) is
untouched context, including inside the continuation block, where only the
lines carrying the false ladder claim were rewritten.

## 7. What slices 4, 6 and 7 must know

1. **Slice 6's comment sweep in this file has ONE item left, not two.** The
   `5/10/20s` comment at the old `:935` was inside the region slice 3 rewrote
   and is corrected here (with the `:77` docblock). What remains for slice 6 is
   the false redelivery comment now at `:901-903`, and it is untouched.
2. **For the slice-7 filing, the relay hub row: there is NO rollup (F9).** Not
   "the rollup may mask it" - `handleRelayRecipientStatus` never touches the
   parent row's status, and `deriveGroupDeliveryStatus` is native-group-text
   only. An inbound source is appended `delivery_status: 'delivered'` and never
   revisited; a TEAM-SEND source is appended `'queued'` (`routes/api.ts:1794`)
   and **no relay code path ever advances it - it sits at `queued` forever,
   even after every leg has failed**. `closeRelay` deliberately does not change
   that: `ALLOWED_PRIOR.failed = ['queued','sent']` would make
   `updateDeliveryStatus(..., 'failed', code)` a legal forward transition, but
   taking it would light up a FIFTH render position (`Timeline.tsx:849`) that
   this branch's dashboard slices do not cover. File it; do not fix it here.
3. **The claim is keyed on the SOURCE MESSAGE**, not the conversation:
   `claimFanoutPass(payload.relayConversationId, payload.sourceTsMsgId, cap)`.
   There is no `payload.conversationId` (F6) even though every log field in the
   file is named `conversationId`.
4. **Relay's rungs are 5s then 10s and are asserted as adapter-observed
   integers.** Anyone "normalising" the two fan-outs' backoff arguments later
   will now break a test rather than silently shift a ladder (D7/D11).
5. **`delivery_recipients: {}` is now in the shared inbound fixture.** A future
   test that wants the ABSENT-map shape has to opt out explicitly - which is
   the right way round, since the real repo rejects a child SET on an absent
   map and only the harness fake tolerated it.
6. **`repo` and `snapshot` are now pinned in the handler at `:822-823`.** Any
   later helper added to this handler should use them rather than re-capturing
   `messages` / `sourceMessage`, or it will hit the same narrowing loss.
