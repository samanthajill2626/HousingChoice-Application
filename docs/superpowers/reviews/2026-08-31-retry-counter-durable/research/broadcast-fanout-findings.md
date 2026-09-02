# Slice 2 research findings - broadcastFanOut + the jobs outbound-queue seam

Read-only pass over the LIVE tree at HEAD `8c8b7100` (main merged into
`feat/retry-counter-durable`). Scope: `app/src/jobs/broadcastFanOut.ts`,
`app/test/broadcastFanOut.test.ts`, `app/src/jobs/jobs.ts` and its adapter seam.

Only items where the tree contradicts, or is not covered by, the spec
(`docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`) or the
plan (`docs/superpowers/plans/2026-09-01-retry-counter-durable.md`, slice 2).
Byte-exact quotation lives in `.superpowers/sdd/research/broadcast-fanout-reference.md`.

**Anchors: all verified, all exact.** Every `main@5ce9912f` line number the plan
gives for slice 2 still lands on the named construct at this HEAD - recipient
derivation `250-256`, send loop `263`, lazy repo `189`/`198`, continuation block
`478-513`, cap-branch body `481-495`, false redelivery comment `456-458`.
Nothing below is an anchor drift.

---

## 1. BLOCKING - `runAt` never reaches an adapter, so the plan's backoff
## assertion cannot be written as specified

Plan slice 2d: "backoff delays asserted as LITERAL milliseconds (pass 1->2 =
10s, 2->3 = 20s), **read off the `runAt` passed to the capturing adapter**."

`jobs.enqueue` converts `runAt` to whole seconds at `app/src/jobs/jobs.ts:112-114`
and hands the adapter `{ delaySeconds }` at `app/src/jobs/jobs.ts:124`.
`OutboundQueueAdapter.enqueue` (`app/src/adapters/scheduler.ts:63-70`) accepts
only `EnqueueQueueOptions` (`scheduler.ts:54-61`), whose sole field is
`delaySeconds?: number`. `runAt` is forwarded ONLY on the EventBridge branch
(`jobs.ts:137-139`), which a 10s/20s continuation never takes
(`JOBS_SQS_MAX_DELAY_SECONDS = 720`, `jobs.ts:45`).

So no capturing adapter can observe `runAt` or milliseconds. The literals to
assert are the integers **10** and **20** on `delaySeconds`. The existing test
already does exactly this and is the model to copy
(`app/test/broadcastFanOut.test.ts:525-531`). The word "milliseconds" in the
plan should read "delaySeconds", and the values stay 10 / 20.

This matters beyond wording: a builder chasing `runAt` on the adapter will find
nothing and is likely to fall back to re-deriving from `broadcastBackoffMs(n)` -
precisely what plan 2d forbids.

## 2. BLOCKING - the throwing-adapter seam, installed as written, also kills the
## test's own job entry

Plan slice 2d: "Seam: `configureOutboundQueue` with an adapter whose `enqueue`
throws."

`configureOutboundQueue` sets ONE module-level binding (`jobs.ts:55`, `:77-79`),
and every job in this test file is started through it: each test calls
`enqueueImmediate(BROADCAST_SEND_JOB, ...)`
(`app/test/broadcastFanOut.test.ts:175`, `:218`, `:233`, and 13 more), which is
`enqueue` with no `runAt` -> `delaySeconds` 0 -> the SAME adapter (`jobs.ts:159-161`,
`:118-124`). An adapter that throws unconditionally throws on that entry call, so
the handler never runs and the assertion under test is never reached.

The seam must be delay-selective (throw only when `opts.delaySeconds > 0`,
delegating 0 to the existing `InProcessOutboundQueueAdapter`), or installed
after the entry `enqueueImmediate` has returned and before `outbound.settle()`.
Recommend the delay-selective form - it is order-independent. Concrete shape in
the reference file, section 2.7.

## 3. The existing rig is ALREADY the capturing adapter - but its drain helper
## erases what the plan wants to assert

Plan 2d speaks of "the capturing adapter" as something to add. It exists:
`InProcessOutboundQueueAdapter.delayed[]` records `{ envelope, delaySeconds }`
per delayed enqueue (`scheduler.ts:102-105`, `:179`) and is installed in
`beforeEach` (`app/test/broadcastFanOut.test.ts:160-161`).

Two mechanics the plan does not account for:

- **`deliverDelayed` drains transitively and empties the array.** It loops
  `while (this.delayed.length > 0)` and `shift()`s (`scheduler.ts:223-229`), so a
  continuation enqueued DURING the drain is drained in the same call. One
  `deliverDelayed(dispatchJob)` therefore runs passes 2 AND 3, and returns with
  `delayed[]` empty. A close-A test that drains and then reads `delayed` to
  assert both 10 and 20 will find an empty array. Snapshot
  `outbound.delayed.map((d) => d.delaySeconds)` before each drain, or drain one
  item at a time.
- **No test in this file has ever driven a second pass.** `deliverDelayed`
  appears nowhere in `app/test/broadcastFanOut.test.ts`; every continuation
  assertion today inspects `outbound.delayed` and stops (`:373-380`, `:525-531`).
  Plan 2d's close A ("drive the ladder for real - three passes") is new
  machinery for this file, not an edit to an existing pattern.

## 4. The send-count assertion cannot use `world.sent`

Plan 2d: "the send COUNT per deferred recipient equals `main`'s - three passes".

`world.sent` is appended inside the harness messaging adapter
(`app/test/helpers/twilioWebhookHarness.ts:3466`, declared `:258`). Every
transient-defer test REPLACES that adapter method wholesale with a throwing stub
(`app/test/broadcastFanOut.test.ts:388-390`, `:515-517`), so the push never runs
and `world.sent` stays empty for a recipient that defers on every pass. An
`expect(world.sent).toHaveLength(3)` would assert 0 and fail for the wrong
reason. The count must come from the stub's own invocation counter (a `vi.fn`,
as `:245-247` already does for the token bucket).

## 5. A close-C test placed on pass 2 or 3 will error instead of asserting

The enqueue throw propagates out of the handler and out of `dispatchJob`
(`jobs.ts:340`). On the IMMEDIATE path that is harmless -
`InProcessOutboundQueueAdapter.runDeferred` catches and logs it
(`scheduler.ts:198-203`), so `settle()` resolves and the test can assert the
stuck-on-`main` state. `deliverDelayed` has NO such catch (`scheduler.ts:223-229`):
a throw there rejects the drain call and fails the test as an unhandled error
rather than reaching the assertions.

Put the RED-ON-MAIN close-C case on pass 1 (`enqueueImmediate` + `settle`), or
wrap the drain.

## 6. Slice 0's "test-only way to SET the counter" is already satisfied for
## broadcasts - with one constraint the plan does not state

Plan slice 0, item 4 asks for a test-only setter "or have the harness fake
expose its map". For broadcasts the map is already public: `world.broadcasts` is
the live `Map<string, BroadcastItem>` (`twilioWebhookHarness.ts:2623`, exposed
`:3769`, declared `:303-305`), and `seedBroadcast` inserts and returns the SAME
object (`app/test/broadcastFanOut.test.ts:113-114`). `BroadcastItem` carries
`[key: string]: unknown` (`app/src/repos/broadcastsRepo.ts:172`), so
`world.broadcasts.get('bcast-1')!.fanout_attempt = 3` typechecks with no new hook.

The unstated constraint: this only works if the harness's new `claimFanoutPass`
reads and writes `broadcasts.get(broadcastId).fanout_attempt`. A fake that keeps
the counter in a private side Map would silently ignore the seed and make close B
pass vacuously - the same class of vacuous pass the plan warns about for
always-`claimed` fakes.

## 7. D8's "every exit" is not true of the unknown-error throw, and the plan's
## close-shape test does not cover it

Spec D8: "**Every exit** reaches a terminal state, with no recipient left
`queued`." The unknown-error `throw err` (`app/src/jobs/broadcastFanOut.ts:459`)
is an exit that leaves the current recipient `queued`, strands the rest of
`keys`, and leaves the broadcast `sending` - and D12 explicitly declines to fix
it. The two statements are consistent only if D8 is read as "every exit other
than the D12 throw".

Worth an explicit carve-out in the branch's own wording, because plan 2d
enumerates "closes A, B and C each leave the same terminal shape" as if that
enumerated every exit. It does not - there is a fourth.

## 8. Smaller corrections

- **Cap-test line range.** Plan 2d cites `app/test/broadcastFanOut.test.ts:383-400`;
  the `it(...)` block is `:383-401`. Its assertion set is exactly four:
  recipient `status === 'failed'`, `errorCode === 'transient_cap'`,
  `stats.failed === 1`, `status === 'failed'`. It asserts nothing about
  `outbound.delayed`, nothing about `stats.queued`, and nothing about logs - so
  "keep every existing assertion" is a low bar; the rewrite should ADD the
  no-continuation-enqueued and `queued === 0` assertions D8 actually needs.
- **One listed test already exists.** Plan 2d's "a pass that enqueues a
  continuation leaves the broadcast `sending`" is already asserted at
  `app/test/broadcastFanOut.test.ts:380`. Extend it rather than add a second.
- **`payload.attempt ?? 1` is already dead.** `parseBroadcastSendPayload`
  defaults `attempt` to `1` (`broadcastFanOut.ts:109-110`), so the `?? 1` at
  `:479` never fires. Harmless, but the plan's 2b table implies the envelope
  value can be absent at that point; it cannot.
- **`enqueue_failed` will not mean only "the queue is down".** `jobs.enqueue`
  can also throw before touching an adapter, from the `MAX_HOP_COUNT` runaway
  guard in `buildEnvelope` (`jobs.ts:167-171`) and from the
  "no OutboundQueueAdapter configured" guard (`jobs.ts:119-123`). Both land in
  close C. D10 only asks that the code distinguish "retries exhausted" from
  "never scheduled", which it still does - but the slice 5b operator copy should
  not promise a specific cause.
- **The plan's slice-0 implementation list is complete for broadcasts.** Exactly
  two `BroadcastsRepo` implementations exist: `createBroadcastsRepo`
  (`app/src/repos/broadcastsRepo.ts:380`) and the harness fake
  (`app/test/helpers/twilioWebhookHarness.ts:2663`). No third.

## 9. Confirmed, not defects (recorded so they are not re-litigated)

- **D2 holds, proven from the write.** The real `setRecipient` is a child-only
  `SET recipients.#ck = :rec` (`app/src/repos/broadcastsRepo.ts:615`) - the slot
  is replaced wholesale, a top-level attribute is untouched.
- **D9's marker facts all hold.** `jobId` is minted once, at enqueue, in
  `buildEnvelope` (`app/src/jobs/jobs.ts:188`); `dispatchJob` returns the parsed
  body verbatim as the envelope (`jobs.ts:262`) and puts that same `jobId` into
  the context (`jobs.ts:307`) which the handler reads
  (`broadcastFanOut.ts:222`); the SQS consumer redelivers the identical body
  (`app/src/adapters/sqsJobConsumer.ts:138`, `:158`); and the marker item writes
  no `expires_at`, so despite TTL being enabled on the messages table it never
  expires (`app/src/repos/messagesRepo.ts:2630-2649`).
- **The claim anchor is below every early return.** There are exactly two
  returns before the loop - the duplicate-delivery marker
  (`broadcastFanOut.ts:228`) and broadcast-not-found (`:239`). The unit read at
  `:244-248` can throw but never returns, which is the desired behavior (a throw
  consumes no pass).
- **No API leak.** `fanout_attempt` as a top-level attribute cannot surface in a
  dashboard response: both projections are explicit field lists
  (`app/src/routes/broadcasts.ts:280-315`).
- **`broadcastsRepo.getById` is eventually consistent** - a plain `GetCommand`
  with no `ConsistentRead` (`app/src/repos/broadcastsRepo.ts:385-388`), exactly
  as plan slice 1 warns.
