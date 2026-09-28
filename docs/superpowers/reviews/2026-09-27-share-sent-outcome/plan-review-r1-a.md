# Plan review r1-a - share-sent-outcome implementation plan revision 1

Reviewer: adversarial plan reviewer (read-only; nothing run, nothing edited
but this file). Plan: `docs/superpowers/plans/2026-09-28-share-sent-outcome.md`
rev 1 @31ea4e7b. Spec: `docs/superpowers/specs/2026-09-25-share-sent-outcome-design.md`
v5 + the 2026-09-28 restatement. Every `file:line` below was read at HEAD
31ea4e7b. The question asked: if a builder with no context executes the plan
LITERALLY, do they produce the spec?

Summary: no BLOCKING finding - every task can be built. Three HIGH findings
would ship a silent spec violation. Two of them pass every test the plan names:
the webhook reads a stale promise and a test double hides it, and the repair
rewrites every pair's `sentAt`. The third, the missing badge wiring, is caught
only by e2e (a). The MEDIUM findings are harness wiring the plan never names,
a legacy-row shape the ledger writer cannot write, unbounded serial reads on
the list/results routes, and spec-named tests that are missing or stubbed.

---

## 1. [HIGH] Task 5 reads the 30003 promise from the PRE-write row; the harness double hides it

What is wrong. Task 5 Interfaces says the webhook "re-reads after
`updateDeliveryStatus` - use the post-write row so `retry_due_at` is the value
the 30003 arm just wrote". It then asserts "`message.retry_due_at` on the
re-read row is right". The code does no such re-read. The sketch passes
`message.retry_due_at` to `rollIntoBroadcast` (the new `retryPending: 1` emit)
and to `outcomeOf` (the ledger `pending`/`failed` choice), on both the original
path and the retry path.

Evidence.
- `app/src/routes/webhooks/twilio.ts:3346` and `:3367`: `message` is read by
  `getByProviderSid` BEFORE the status write. These are the only two
  assignments to `message` in the file (grep `message = `).
- `:3448-3453`: `updateDeliveryStatus(...)` writes `retry_due_at` from
  `oneToOneRetry.runAt` in the same conditional write. It returns a boolean
  (`messagesRepo.ts:1369-1380`), not the row.
- `:3520-3540`: the rollup runs on that stale `message`. In production the
  DynamoDB read is a copy, so `message.retry_due_at` is undefined for a first
  30003 failure, and it holds the previous rung's value for a retry row.
- The harness double makes the bug invisible:
  `app/test/helpers/twilioWebhookHarness.ts:1181-1182` (`findBySid` returns
  the live array element) and `:1363-1374` (`updateDeliveryStatus` mutates
  that same object, including `existing.retry_due_at`). So `message.retry_due_at`
  IS fresh in every harness test. Task 5's own case ("an ORIGINAL row's 30003
  failure with a promise: ... retry_pending 1 ... the ledger entry is
  pending") goes GREEN against code that is broken in production.

What it implies.
- In production the rollup never emits `retry_pending: 1` (spec D4: "so the
  list and results pages read Sending from the very event that starts the
  retry").
- The ledger entry for a 30003 failure with a live promise is written `failed`,
  not `pending` (spec D7). D6 then reads "Property text failed" during every
  retry backoff instead of "Property sent".
- The list page reads Not sent for the whole retry window. It never schedules
  the stats refetch, because its last count is 0.
- The e2e does not catch it: (a) checks Sending on the RESULTS page, where the
  route computes the count from its own row read, and (b) checks only the end
  state.
- The value to pass is `oneToOneRetry?.kind === 'retry' ? oneToOneRetry.runAt.toISOString() : undefined`,
  the same value the conditional write stamped. Add a test that fails when the
  rollup reads a snapshot taken before the status write. For example, the
  fake's `getByProviderSid` returns a copy for that case, or the test asserts
  on a real-repo integration.

## 2. [HIGH] The ledger restamps `sentAt` at write time: the D8 repair reorders every tenant's "Properties sent" and moves the tour-form default

What is wrong. `ledgerEntryFor` sets `countedAt: nowIso` for accepted and
delivered entries (Task 3 Step 5). `summarize` sets the row's `sentAt` to the
LATEST `countedAt` among counted entries. Task 13 writes every slot's
newest-attempt entry through `applyLaterAttempt`/`applyShareLedgerEntry`,
which pass `new Date(nowMs)` (Task 4 `writeLedger`).

Take a legacy row. It is seeded `{ <broadcastId>: !legacy, countedAt = sentAt }`.
The repair's entry for that share's real attempt (for example ROOT delivered)
is NEWER than `!legacy`, so it replaces the seed with `countedAt = repair
instant`. An older share of the same pair is added with `countedAt = repair
instant` as well. Every counted pair the repair touches ends with
`sentAt` = the moment the repair reached it.

Evidence.
- Plan Task 3 Step 5 `ledgerEntryFor` and `summarize`.
- Plan Task 4 `writeLedger`: `new Date(nowMs).toISOString()`.
- Plan Task 13 steps 3-4.
- `byContact` is keyed on `sentAt`, newest first
  (`app/src/lib/tables.ts:419-423`, `listingSendsRepo.ts:192-201`).
- The tour form's default property is `rows[0]`
  (`dashboard/src/routes/contact/ContactDetail.tsx:1159-1163`).

What it implies.
- After Cameron runs the repair on prod, every tenant's "Properties sent" is
  re-ordered by repair walk order.
- The tour form's pre-committed property becomes whichever pair the repair
  happened to touch last.
- Every legacy date shown on that card becomes the repair date.
- Live, a delivery receipt also moves `sentAt` forward by the receipt latency.
  That is harmless live, but it is the same defect.
- Spec D7 says `sentAt` describes the latest COUNTED share. The attempt's own
  instant (the provider timestamp in the attempt key, or the legacy row's own
  `sentAt` when the seed is superseded by the same share) is the right clock.
  The plan must choose one, and the repair must never stamp wall-clock time.

## 3. [HIGH] D3's "will retry" never reaches the results row: `DeliveryBadge` is not in Task 10

What is wrong. Task 10 gives `shareRecipientReason` an optional third argument
`{ retryDueAt, retryOutcome, serverNowMs }` and says RecipientRow "takes
serverNowMs ... hint per the rule". But the reason text is rendered by
`DeliveryBadge`, and that component is not in Task 10's files, its commit or
its tests.

Evidence.
- `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:37`:
  `const reason = shareRecipientReason(status, errorCode);`. This is the ONLY
  caller (grep: `broadcastFormat.ts` and `DeliveryBadge.tsx`).
- `DeliveryBadgeProps` (`:20-31`) carries no promise fields.
- `BroadcastResults.tsx:64-68` passes only status, carrierSentAt and errorCode.

What it implies. Built literally, the new argument is optional, so everything
type-checks. The badge keeps calling with two arguments, `retryScheduled` is
always false, and the row never says "will retry" or "retry not confirmed"
(spec D3; section 7 e2e (a) "the results row reading will retry in between").
Only e2e (a) would catch it. Add DeliveryBadge (props, call site, a unit test)
to Task 10 and thread the three fields from `BroadcastRecipientView`.

## 4. [MEDIUM] Harness wiring the plan never names: the webhook ledger, the milestone double, the retry job's repos

What is wrong. Several tasks assert on in-memory doubles that the plan never
wires or extends.

Evidence.
- Task 5 adds `listingSendsRepo?` to `TwilioWebhookDeps`, defaulting to a real
  `createListingSendsRepo`. `makeWebhookHarness` passes the webhook
  `broadcastsRepo: world.broadcastsRepo` but NO `listingSendsRepo`
  (`twilioWebhookHarness.ts:5110-5179`; compare the api block at `:5025`).
  Task 5's files are `twilio.ts` and `twilioStatusWebhook.test.ts` only. Its
  new cases assert `h.world.listingSendsRepo.getByKeyConsistent(...)` and
  cannot pass. Every other harness test with a share receipt would default to a
  real DynamoDB ledger repo and log an ERROR per receipt through `writeLedger`.
- Task 7 adds `broadcastId` to `RecordActivityEventInput`. The harness double's
  `record` builds the item field by field and drops unknown fields
  (`twilioWebhookHarness.ts:3057-3072`). Task 7's assertion
  `milestone ... broadcastId: 'b-1'` fails. Task 12's in-memory D6 tests never
  see a share id. Spec section 5 names "their harness doubles".
- Task 6 adds `broadcastsRepo?`/`listingSendsRepo?` to the retry job.
  `retrySendAttempt.test.ts:96-117` `wire()` passes neither. Its own comment
  says "a missing one would lazily build a REAL DynamoDB repo". Task 6's job
  tests assert on `world.broadcasts`.

What it implies. The builder hits reds that no task explains, and "read the
file first" does not tell them to edit the harness. Add
`listingSendsRepo: world.listingSendsRepo` to the harness `webhooks` block
(Task 5), the `broadcastId` passthrough to the activity double (Task 7), and
the two repos to `wire()` (Task 6).

## 5. [MEDIUM] `putShareMemory` treats "row exists, no `updated_at`" as "no row": those pairs can never be written

What is wrong. `putShareMemory`'s condition is `attribute_not_exists(unitId)`
when `expect.updatedAt` is undefined. `applyShareLedgerEntry` passes
`row?.updated_at`. A row that exists but lacks `updated_at` therefore takes
the create condition, fails it on every round, and ends `'lost'` with an
ERROR.

Evidence.
- Plan Task 3 Step 3 (`putShareMemory`) and Step 5 (`applyShareLedgerEntry`).
- The full-world seed's three matrix ledger rows carry `created_at` and no
  `updated_at` (`app/src/lib/seed/matrix.ts:1261-1286`). The spec section 5
  says those rows "read as counted" and need no seed change.
- `recordSend` always stamps `updated_at` (`listingSendsRepo.ts:144-149`), so
  prod rows written by it are fine. Whether any prod row predates that is
  UNVERIFIED.

What it implies. In the full demo world (self-QA, demos), any share of
`unit-mx-tourable-0[1-3]` to its seeded tenant logs an ERROR per write and
never updates the pair. The D8 repair cannot fix those rows either. Tell
"absent" apart from "tokenless": `attribute_exists(unitId) AND
attribute_not_exists(updated_at)` when the read found a row without a token.
Secondary, LOW: `updated_at` is millisecond ISO, so two writes in the same
millisecond produce the same token (an ABA window). A counter token would
close it.

## 6. [MEDIUM] Results, list and `?view=stats` pay for D1's record reads and read every slot serially

What is wrong. Task 9 runs `resolveRecipientStates` on the results route, on
every list row and on `?view=stats`. That service (Task 2) always performs
the record read (`attempts.get`) for every queued slot of a non-sending share
younger than 30 days. It also awaits every row and record read one at a time
in a for-loop.

Evidence.
- Plan Task 2 Step 3 (`resolveRecipientStates` loop).
- Plan Task 9 Step 3 and its note "a 50-row page of ordinary shares costs the
  same as today".

What it implies.
- The record read only separates in flight from stranded. That split feeds
  the composer flag alone: D4 files both under Not sent, and D3/D5 ignore it.
  So on these routes it buys nothing.
- A route-failed share (the route marks it failed on any enqueue throw, spec
  D1) with 1000 queued slots costs 1000 serial consistent reads on every list
  load, every results load and every debounced stats refetch.
- A carrier incident with hundreds of young 30003 slots costs hundreds of
  serial row reads per results refetch, and the page refetches after every
  receipt.
- Pass an option that skips record reads outside the composer flag, and batch
  or bound-parallelize the row reads.

## 7. [MEDIUM] D8 step 3's record check is ambiguous, and the spec's named D8 tests are missing or stubbed

What is wrong.
- Step 3 reads "the retry-owner records for the newest row's chain: for the
  retried row R (each row that has a `retry_of` child or none)". It does not
  say which R's record decides.
- The spec's trace is the record of retrying the NEWEST chain row (an attempt
  that left no row, spec D8 step 3). A builder who checks every R and lets any
  `done/unresolved` record override `decided` produces an `R~` key OLDER than
  the chain's real newest row. `applyLaterAttempt` then refuses it, or the
  census counts a move that never happens, so `slotsToMove` never converges to
  0 on re-runs.
- Spec section 7 lists "it refuses the wrong account" and "it stamps a chain
  with an unstamped ancestor" as D8 tests. Task 13's list has neither.
- Five of Task 13's seven cases are `/* ... */` stubs, including the hardest
  one (the done/unresolved record).
- The first case's title says "reports 2 stamps needed" and its assertion says
  `stampsNeeded: 1`.
- Spec D8's report splits "pairs un-counted and re-counted" and "a pre-RSW
  retry whose lineage was never written". The plan has one `pairsRecounted`
  and no way to detect the latter.

What it implies. The Cameron-run prod script is the least-specified task. State
that only the newest chain row's next-attempt record is read, add the two
spec-named tests, and write the stubbed bodies.

## 8. [MEDIUM] Other spec section 7 cases missing or stubbed; Review Focus 1's ledger half is never exercised

What is wrong.
- No test applies a later real attempt over a row-less marker ("a later
  adoption supersedes the unconfirmed slot", spec section 7). Deviation 3's
  `~` key rests on it. Task 1's leaf compare is the only cover.
- D6 "a pending entry read from ... a refreshed, a withdrawn" row: Task 12
  tests only live and lapsed.
- The sparse index "and its return": Task 3 tests only the drop.
- Review Focus 1 claims Task 4's phone-keyed test shows "the ledger entry lands
  on the row's `recipient_contact_id`". The second call in that test is refused
  at the delivered slot, so the ledger is never reached with a contact id.
- Tasks 8, 9, 11, 12 and 13 carry several test bodies that are only comments.

What it implies. The plan's statement that every test a task needs is "IN
that task" does not hold. A builder can write trivially green tests for the
riskiest rules.

## 9. [LOW] Pins the plan breaks without naming them

- `app/test/deriveBroadcastStats.test.ts:22-26` pins `expect(out).toBe(persisted)`
  (the empty-map passthrough returns the same object). Task 1's
  `return { ...b.stats, ...pending }` always spreads, so this pin goes red,
  while Step 10 says PASS. Return `b.stats` when no count is supplied.
- `app/test/broadcastApi.test.ts:1271-1282` pins the results stats with
  `toEqual`. After Task 9 they always carry `retry_pending: 0`, so the pin goes
  red, and Task 9 does not list it.
- Task 8 deletes `broadcastsRepo.integration.test.ts` :298-370. The third
  `priorRecipientContactIds` case starts at :359 and runs past :370.

## 10. [LOW] Test sketches name APIs that do not exist as written

- `capture.logger` (Tasks 2, 3, 4): `createLogCapture()` returns
  `{ stream, lines, atLevel }` (`app/test/helpers/logCapture.ts:6-12`). Tests
  build the logger with `createLogger({ level: 'info', destination: capture.stream })`
  (for example `broadcastFanOut.test.ts:181`). `atLevel` is an exact-level
  match, not "at or above" (`:35-37`).
- `zeroStats(1)` / `zeroStats(0)` (Tasks 1, 4): `zeroStats()` takes no
  argument (`broadcastsRepo.ts:328`).
- `createTwilioWebhookHarness()`, `h.events.on`: the exports are
  `makeWebhookHarness` / `createFakeWorld`, and the bus is `world.events`
  (`twilioWebhookHarness.ts:504`, `:4932`, `:302`).
- `seedBroadcast`: no such helper in `broadcastsRepo.integration.test.ts`.
- BroadcastItem literals in Task 4 omit the required `created_by`,
  `audience_filter` and `body_template`. That fails `tsconfig.test.json`.

## 11. [LOW] Two `applyLaterAttempt` details deviate from D2

- `allowed()` refuses only `delivered`/`skipped`, so a move FROM `queued` is
  admitted. Spec D2 and I3 say "FROM failed (any code) or sent".
- `nextSlot` keeps the OLD attempt's `carrierSentAt` on a newer attempt's
  `delivered`. Spec D2 says "A NEWER attempt ... replaces status, code, carrier
  instant". Keeping it is right only for the same attempt.

## 12. [LOW] StatChips: the Retrying chip's tone does not type-check, and Failed can go negative

- `Chip.tone` is `'success' | 'danger'` (`StatChips.tsx:24-28`). The plan
  gives the Retrying chip `tone: 'progress'`, which has no type and no CSS
  class.
- With the merge's "keep the last `retry_pending`", an event that shrinks
  `failed` below the kept count renders `Failed = failed - retry_pending < 0`
  until the refetch lands. Clamp it at 0.

## 13. [LOW] The `individual` hack and the surviving `recordSend`

- The Task 3 note tells the builder to write `broadcastId: 'individual'` on
  counted individual-only rows. That string then rides the C4 wire shape
  (`toListingSendRow`, `listingSendsRepo.ts:104-118`) as a share id.
- The plan says `recordSend` stays because "seeds and individual sends still
  use it". Its only runtime caller is the fan-out (`broadcastFanOut.ts:1239`);
  the seeds write raw items. After Task 7 it is an unguarded upsert that
  bypasses `shares`/`counted`, and nothing uses it. Say so, or retire it.
- `ListingSendItem.sentAt` stays typed `string` although it is now removable.

## 14. [LOW] e2e helper reuse and a transient assertion

- The helpers Task 14 "consumes" (`createUnitViaApi`, `shareViaApi`,
  `openReviewRow`, `createConsentedTenant`, `pollRow`, `expectCreateLanded`,
  ...) are file-local functions, not exports
  (`share-skip-fix.spec.ts:42-144`, `send-outcome-reconcile.spec.ts:91-212`,
  `retry-send-adoption.spec.ts:97-235`). Importing a spec file would register
  its tests, so the helpers must be copied. The plan does not say so.
- Scenario (a) asserts Sending and "will retry". That state lasts about 10 s
  (the lane backoff), and the plan gives no ordering guard (open the results
  page before the failure lands). The lane has no flake allowance (AGENTS.md).

## 15. [LOW] The spec's "first task verifies 1b" has no task

Spec sections 0, 6.1 and 8 ("Stage 1b drift") say the plan's FIRST task
verifies the four facts and corrects a mismatch before anything else. The plan
has no such task. The verification exists in
`research-1b-as-built-findings.md` ("All four facts HOLD as built"), which
the plan cites only as a research map. State that it was done and where, or
add a Task 0.

## 16. [LOW] D5 recount robustness

- The units Activity sketch calls `broadcasts.getByIds` unguarded. A BatchGet
  throw 500s the property Activity route, whose enrichment posture is "NEVER
  500s" (`units.ts:1255-1266`).
- `getByIds` retries unprocessed keys once and then treats them as missing, so
  the row silently shows the stored count. The 16 MB BatchGet response cap is
  reachable with 50 large shares.
- The spec says "projected batch read"; the plan reads whole share items.

---

## Checked and found sound (no finding)

- `applyAttemptOutcome`'s expression: every alias and value it names is used.
  The `#la` path is valid on a phone-keyed slot.
- Every insertion site in Task 6 exists as cited: the reconcile's found arm,
  `closeSlot`'s `retry_send` arm, the superseded re-apply through
  `slotCloseOf(unresolved)`, and the job's `onUnknown` and `handOff` catch.
  `recordCheck` is idempotent (`sendAttemptsRepo.ts:582`), so a redelivered
  check reaches the adoption hook again.
- Deleting `priorRecipientContactIds` in Task 8 is safe. Its callers are only
  `routes/broadcasts.ts:523`, the harness mirror and tests. The dashboard's
  field of the same name is a wire field and stays.
- `byContact` projection is ALL (`tables.ts:14`). REMOVE of `sentAt` drops the
  row from the index as D7 intends.
- The event bridge validates only the event NAME, so `retry_pending` crosses
  it.
- Every other writer of a slot (the fan-out, the reconcile's closes, finalize)
  and every reader of the ledger (`contacts.ts:1168`, `units.ts:946`, the tour
  form, seed history) is either covered by a task or unaffected.
