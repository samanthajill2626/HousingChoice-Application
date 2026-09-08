# Slice H report - plan Task 14 (the hermetic browser proof)

Implementer record for the browser half of the feature: the pinning spec renamed
and rewritten for the world Tasks 11-13 built, the lane's backoff override, and
the selector/copy register.

Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `de61b8c5` (slice G's report commit).

E2E + harness only. No `app/` or `dashboard/` source was touched.

## Commits

| hash | subject |
| --- | --- |
| `a97884f5` | test(e2e): prove one failed relay leg retries to delivered without duplicating |
| (this file) | docs(records): slice H report - the browser proof |

Bare `git status` was read before the commit and `.git/MERGE_HEAD` confirmed
absent. Explicit paths only; nothing amended; no commit while a run was in
flight.

## Files

- RENAME + REWRITE `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`
  -> `relay-30003-retry.spec.ts`, via `git mv`. See divergence 6 on how it
  presents in `git status`.
- MODIFY `scripts/e2e-session.mjs` - one entry in `childEnv`.
- MODIFY `e2e/support/selectors.md` - row 49.

`app/src/jobs/registerHandlers.ts` and `app/test/relayRetryLeg.test.ts` were NOT
touched: slice F already shipped the seam and it demonstrably takes effect in the
lane (measured below).

## BOTH runs, quoted from the logs

Three separate lane boots. Run 1 is the pre-`intervals` content (divergence 2);
runs 2 and 3 are the committed content, and are the two green-in-a-row.

```
run 1  .superpowers/sdd/e2e-sliceH-run1.log
  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:130:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (11.6s)
  2 passed (39.8s)

run 2  .superpowers/sdd/e2e-sliceH-run2.log
  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:130:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (11.7s)
  2 passed (39.4s)

run 3  .superpowers/sdd/e2e-sliceH-run3.log
  ok 1 [chromium] > tests\dashboard-next\relay-30003-retry.spec.ts:130:1 > a failed relay leg retries to delivered without duplicating: chip, accessible name, row and send counts (11.7s)
  2 passed (39.5s)
```

(The reporter's `>` is a U+203A in the log; rendered ASCII here. `2 passed`
because `--grep "relay leg"` also selects `relay-open-stop.spec.ts` - divergence
1. It was green in all three runs.)

Command, run FOREGROUND from the e2e workspace, never backgrounded, never from
the repo root, never bare `playwright`:

```
cd /w/tmp/relay-30003-retry-lineage/e2e && timeout 900 npm run e2e -- --grep "relay leg" > .../e2e-sliceH-run<N>.log 2>&1
```

Lane 9's ports (`e2e/.artifacts/lane.json`: 9901/9911/9921/9931) were confirmed
free BEFORE each run and after the last, so `reuseExistingServer` adopted
nothing. No background command is running now.

## The ladder, measured from the app's own log lines

The retry job runs in the APP process in this lane (adjudication E1), so its
lines are in the captured webServer output. Epoch ms, same clock:

| run | claim (`retryClaim: 'claimed'`, `retryAttempt: 1`) | `relayRetryLeg: retry leg sent` | retry leg `delivered` callback |
| --- | --- | --- | --- |
| 1 | 1788404694177 | 1788404697212 (+3035ms) | 1788404697515 (+3338ms) |
| 2 | 1788404814211 | 1788404817236 (+3025ms) | 1788404817551 (+3340ms) |
| 3 | 1788404871664 | 1788404874698 (+3034ms) | 1788404875014 (+3350ms) |

**The seam works end to end**: +3.03s is the lane's `E2E_RELAY_RETRY_BACKOFF_MS`
reaching rung 1, which the WEBHOOK enqueues with no deps object - i.e.
adjudication E2's module-scope resolution, proven in a real process rather than a
unit. Production's 60s would have put every one of these at +60s.

**Claim to settled chip is ~3.34s**, against assertion 2's 60s budget. The
budget is not the tight thing here - see "For the orchestrator".

## The send counts observed

The fake's minted SIDs for run 1's conversation (`conv-9e0cb21e`), in order:
`...f33`/`...f34` the two create-time intros, `...f35` the armed original leg
(`sent` -> `undelivered` + `ErrorCode=30003`), `...f36` the original leg to the
reachable member (`delivered`), `...f37` the retry (`queued` -> `sent` ->
`delivered`). Runs 2 and 3 are identical in shape.

So, filtered on the run's unique token, exactly what the spec asserts:

- reachable member: **1** outbound, state `delivered`;
- retried member: **2** outbound, states `['undelivered', 'delivered']`, the
  first carrying `errorCode: '30003'`.

No third leg, no re-fan-out, and the second leg is addressed to ONE handset.

## Gates

| gate | result |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.json` in `e2e/` (the workspace's own `typecheck`) | **exit 0** |
| `npm run typecheck` (bare, worktree root, all five workspaces) | **exit 0** |
| `npx eslint e2e/tests/dashboard-next/relay-30003-retry.spec.ts` | **exit 0**, no output, no baseline needed |
| ASCII on added lines, all three files | **0** non-ASCII bytes |
| `[dynamoAdmin]` lines in any run log | **0** |

`npm test`, `npm run smoke` and the full `npm run e2e` were deliberately NOT run;
the orchestrator owns the battery. `AWS_ACCESS_KEY_ID` was never exported.

**Gate 5 note for the handback:** this branch's file list now includes
`scripts/e2e-session.mjs`. `npx eslint` on it exits 0 having checked NOTHING -
the flat config has no base JS block (AGENTS.md's known hole). Do not read that
zero as a lint pass on the `.mjs`.

## What changed in `selectors.md`

Row 49 only (the per-recipient delivery-rows register). Its final sentence -
`A relay 30003 reads 'Undelivered - Phone unreachable (error 30003)' and must not
promise a retry` - was the pin this feature invalidates. It now records:

1. the four app-owned close codes and their prose, beside the two that were
   already there: `retry_group_closed` -> `Not retried - group closed`,
   `retry_member_removed` -> `Not retried - no longer in this group`,
   `retry_number_changed` -> `Not retried - number changed since`,
   `retry_opted_out` -> `Not retried - opted out`, with no `(error N)` tail, and
   the composed shape a reader will actually see
   (`Undelivered - Not retried - number changed since`);
2. the row's three states across the ladder: `Retrying - Phone unreachable (error
   30003)` while claimed, `Delivered on retry` once a rung delivers,
   `Undelivered - <reason>` only when capped or refused;
3. the post-D19 rule in place of "must not promise a retry": nothing on a relay
   bubble promises `will retry`, and `Retrying` is derived from a retry row that
   exists, never from the error code;
4. the two chip grammars above those rows - `delivered N/M - K retrying` and
   `delivered N/M - K on retry` - plus the retry bubble's own
   `delivered 1/1 on retry`.

**The native group-text clause is byte-identical** (`native Group MMS keeps its
existing 'will retry' promise`), as fenced. Nothing else in the file moved.

## What the spec keeps, verbatim

`createGroupOpen`, `INTRO_NEEDLE` and its docblock, BOTH `expectOutboxIncludes`
settle calls and their comment, `uniquePhone`'s uid-40 rationale, `reseedLean` in
`beforeEach` + `afterAll`, `devLogin`, `test.slow()`, the `xpath=..` bubble
resolution, the `role="img"` rationale, the reveal-ordering assertion
(`toHaveCount(0)` BEFORE the click), the control row, and all four
`will retry` negatives - now five, see divergence 4.

## Divergences, and why

1. **`--grep "relay leg"` selects TWO specs, not one.**
   `relay-open-stop.spec.ts:114`'s title is `open-path STOP suppresses relay
   legs; START resumes them (A2P parity)` - `relay legs` contains `relay leg`.
   The plan and the brief both name this phrase, and the sibling is the other
   relay spec sharing the fake's thread store and the uid allocator, so running
   it is a benefit rather than a cost (14.2s). It was green in all three runs.
   `--grep "failed relay leg"` would select this file alone if a future run
   needs it.
2. **The retrying-window assertions are ONE atomic `locator.evaluate` inside
   `expect.poll`, not two `expect` assertions.** The observable window is exactly
   the lane's backoff (measured 3.03s) minus the SSE round trip. Two polled
   assertions - the chip's text, then its accessible name - can straddle the
   retry landing and fail on a state that was genuinely observed a moment
   earlier. The evaluate returns `{ text, aria-label }` from one DOM instant; the
   name is read off `aria-label` because that is exactly where `rollupName` is
   put (`Timeline.tsx`, the `role="img"` span), so it IS the accessible name.
   `intervals: [250]` was added after run 1 for the same reason: the default
   schedule has widened to 1s by the time the claim lands, giving ~3 samples in
   the window; 250ms gives ~12 for ~120 cheap evaluates at the 30s ceiling.
3. **The `(error 30003)` check MOVED position rather than being deleted.** The
   old spec asserted the carrier code at all three positions. D19 legitimately
   removes it from the settled chip (`delivered 2/2 - 1 on retry` states no
   failure, so `presentRelayDelivery` attaches no reason) and from the settled
   row (`Delivered on retry`). The position that still owes one is the RECITAL
   WHILE THE RUNG IS IN FLIGHT, which reads
   `<member>: Retrying, Phone unreachable (error 30003)` - a comma, not a dash,
   because `speakDeliveryText` splits on ` - ` (slice E's note). That is asserted,
   from the same atomic read as divergence 2. Half of the old spec's point was
   that the code survives; it still does, and the spec still proves it.
4. **Five assertions beyond the brief's list**, all in the file's existing idiom
   and none weakening anything: `not.toContainText('will retry')` on the RETRY
   bubble (the brief's negatives were all scoped to the original);
   `not.toContainText('Undelivered')` on the retried row (Sec 7 intention 12's
   "must stop reciting Undelivered", which `toContainText('Delivered on retry')`
   alone does not say); `errorCode === '30003'` on the first leg; and the two
   send-count assertions written as `.map(m => m.state)` compared with `toEqual`
   rather than `toHaveLength`, which proves the count AND the outcome in one
   expression (`['undelivered', 'delivered']` is a strictly stronger statement
   than "length 2").
5. **The chip's `1 retrying` is asserted as a SUBSTRING of `delivered 1/2 - 1
   retrying`**, per the plan. The full string is not pinned there because the
   assertion's subject is D16's timing, not D19's arithmetic - which the unit
   suites own and assertion 2 pins in full anyway.
6. **`git status` shows the rename as `deleted` + `new file`, not `renamed`.**
   `git mv` was used (and `git status` DID show `R` until the rewrite landed);
   the rewrite drops similarity below git's rename-detection threshold. The
   load-bearing property was verified directly: `git ls-files --error-unmatch
   e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts` reports the old
   path is not known to git, so nothing stale is left tracked or running.
7. **Nothing in `app/` was touched.** The brief's STOP condition (the seam not
   taking effect in the lane) was not hit - the measured +3.03s rung is the
   proof. `app/test/relayRetryLeg.test.ts` still owns the seam's nine-case unit
   coverage.

## For the orchestrator

- **The tight budget is assertion 1's OBSERVATION WINDOW, not its 30s timeout.**
  The chip can only read `1 retrying` between the claim and the retry's delivery,
  and that window is 3.0s wide BY CONSTRUCTION - it is the lane backoff, minus
  however long the SSE plus the dashboard's debounced refetch take. Measured
  headroom was consistent across three runs, and `intervals: [250]` gives ~12
  samples in it. If a slower machine ever makes this flaky, the fix is to RAISE
  `E2E_RELAY_RETRY_BACKOFF_MS` in `scripts/e2e-session.mjs` (5000-8000 costs the
  suite seconds and the test budget is 180s under `test.slow()`), NOT to weaken
  or delete the assertion: without it the spec passes on a build that pushes
  nothing at claim time, which is the whole content of D16. Assertion 2's 60s
  budget, by contrast, absorbed a 3.34s reality and could absorb an order of
  magnitude more.
- **Run 1 logged two ERRORs in TEARDOWN that are not this branch's**:
  `relayFanOut: v1 preflight aggregation failed: missing` for
  `conv-f27c642d` (relay-open-stop's group), ~40ms after that spec's `afterAll`
  `POST /__dev/reseed` - a reseed racing an in-flight `relay.fanOut`, swallowed by
  the in-process adapter, after the test had already passed. It did NOT recur in
  runs 2 or 3, and cannot come from this slice (the only server-side change is an
  env var read by `relay.retryLeg`). Worth a line in the handback; not worth a
  fix wave.
- **Adjudication E6 stands, unchanged.** Nothing in the lane can redeliver a job,
  so a green run here is NOT evidence for D4's duplicate-DELIVERY marker; that
  stays unit-proven. A thrown retry handler would show as an ERROR line and a
  lost rung, not a crash - nothing of the sort appeared.
- **The full `npm run e2e` still owes a run.** This slice proved the rewritten
  spec and its neighbour; the rest of the suite has not been re-run since slice
  G, and slice G's handback flagged this file as the one expected-red spec. It is
  green now.
- **Gate 5's `.mjs` hole** (above) applies to this branch's file list for the
  first time.
