# Retry counters and the cap-and-close branch - implementation plan

Spec: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.

D1..D23 refer to spec decisions. Line numbers are from `main@5ce9912f` and are
**anchors to verify by reading, never facts to trust** - several defects in this
design's history came from a mechanism credited by name without tracing it from
the call site in question.

TDD per slice. Where a test is marked **RED-ON-MAIN**, confirm it actually fails
on the merge base before building the fix; a test that passes on `main` proves
nothing and will be trusted forever.

---

## Slice 0 - types and every implementation of the interface

Adding a method to a repo interface breaks typecheck until EVERY implementation
has it, and the hand-written test fake's semantics silently decide whether later
tests mean anything.

1. Declare the attribute on both item types:
   - `BroadcastItem.fanout_attempt?: number` (`repos/broadcastsRepo.ts`)
   - `MessageItem.fanout_attempt?: number` (`repos/messagesRepo.ts`), beside the
     1:1 ladder's existing `retry_attempt` (~:873) so the two ladders are
     visibly siblings. **`retry_attempt` exists only on `MessageItem`** - there
     is no such neighbour on `BroadcastItem`.
2. Add `claimFanoutPass` to both interfaces (signature in slice 1).
3. **Implement it in EVERY implementation, in this slice.** Re-grep
   `: MessagesRepo = {` / `: BroadcastsRepo = {` and `create*Repo` before
   writing code; as of `main`:
   - `createMessagesRepo`, `createBroadcastsRepo` - the real ones;
   - `app/test/helpers/twilioWebhookHarness.ts:1054` (messages) and `:2663`
     (broadcasts);
   - `app/test/scheduledSendSuppression.test.ts:261` (messages);
   - `app/test/sendMessage.test.ts:210` (messages).

   Miss any and **slice 0's own typecheck gate fails.**

   **Every fake must model the real semantics**: increment-and-return, refuse at
   `cap`, distinguish missing. A fake that always returns `claimed` makes every
   cap test in slices 2 and 3 pass vacuously. (Fakes in files that never
   exercise the ladder may throw `not implemented` instead - but they must have
   the property.)
4. Add a test-only way to SET the counter (or have the harness fake expose its
   map) - close B and the rewritten cap test both start from a capped item
   (slice 2d).

**Slice 0 and slice 1 are one build step, not two.** Slice 0 is the type and
implementation surface; slice 1 is the real bodies and their tests. Do not ship
a production stub between them.

**Gate:** `npm run typecheck` is green before moving on.

---

## Slice 1 - the claim primitive

**Files:** `repos/broadcastsRepo.ts`, `repos/messagesRepo.ts`.

```ts
claimFanoutPass(<key>, cap: number): Promise<
  | { outcome: 'claimed'; attempt: number }
  | { outcome: 'capped';  attempt: number }
  | { outcome: 'missing' }
>
```

**Keys - state them exactly** (D3):

- broadcasts: `broadcastId`.
- messages: **`conversationId` + `tsMsgId`** - the SOURCE MESSAGE, not the
  conversation. Keying a relay counter on `relayConversationId` alone would give
  an entire group ONE three-pass budget for its lifetime.

Implementation:

- `UpdateExpression: 'ADD fanout_attempt :one'`, `:one = 1`.
- `ConditionExpression`: item exists AND
  `(attribute_not_exists(fanout_attempt) OR fanout_attempt < :cap)`.
- `ReturnValues: 'UPDATED_NEW'` -> `{ fanout_attempt: N }`. **Do not re-read to
  learn the result** (D5).
- On `ConditionalCheckFailedException`, disambiguate `capped` from `missing`
  with a **`ConsistentRead: true`** get.

  **Both single-item getters already exist and BOTH are eventually
  consistent** - `messagesRepo.getByTsMsgId` (:1236 / :2740) and
  `broadcastsRepo.getById` (:385-388) issue a plain `GetCommand` with no
  `ConsistentRead`. Reusing either is the trap: it can report `missing` for an
  item that exists and skip a close. Issue a direct `GetCommand` with
  `ConsistentRead: true`, or add a consistent variant. Do not "reuse the
  existing getter" - it is exactly wrong here.

ADD creates the attribute from absent, so there is no seeding step (D4).

**Tests - these are DynamoDB Local INTEGRATION tests**, in the integration
suites, not unit tests against the fake. The atomicity property does not exist
in the fake, so a unit test of it passes vacuously.

- claim on an item with no attribute -> `claimed`/1;
- at `cap - 1` -> `claimed`; at `cap` -> `capped`; missing item -> `missing`;
- **concurrent claims yield distinct numbers** (fire N in parallel; assert no
  duplicates in the returned set) - spec 7.2;
- **the counter survives a status write**: claim, then `setRecipient` /
  `setRecipientDelivery`, re-read, counter intact. **RED-ON-MAIN against any
  slot-resident counter** (D2, spec 7.1).

---

## Slice 2 - broadcastFanOut

**File:** `jobs/broadcastFanOut.ts`.

### 2a. The claim

Anchor: **immediately after the recipient-set derivation** (`const keys = ...`,
~:250-256), **before the send loop** (~:263). Below every early return by
construction.

**Claim only when this pass will actually attempt a send** (D6):

```ts
const pending = keys.filter((k) => !isTerminal(broadcast.recipients?.[k]?.status));
let claim: ClaimResult | undefined;              // NOT block-scoped - 2b uses it
if (pending.length > 0) {
  claim = await broadcasts.claimFanoutPass(payload.broadcastId, MAX_BROADCAST_ATTEMPTS);
  if (claim.outcome === 'missing') { log.warn(...); return; }
  if (claim.outcome === 'capped')  { await closeBroadcast(pending, 'transient_cap'); return; }
}
// pending.length === 0 -> nothing to send; fall through to the trailing finalize
```

`claim` must be declared in the HANDLER scope, not inside the branch - slice 2b
reads `claim.attempt` in the continuation block. (A `const` inside an `else`
does not compile there.) In 2b, `pending.length > 0` is implied by
`transientRemaining.length > 0`, so `claim` is defined on every path that uses
it; narrow it explicitly rather than asserting.

The `pending` guard is what delivers D6. Without it a pass whose recipients are
ALL already terminal - reachable via a continuation that raced - consumes a rung
while sending nothing.

**Known bounded deviation from D6:** a pass whose recipients are all
non-terminal but all turn out to be SKIPPED inside the loop (opted out, no
consent) still consumes a rung. Predicting that before the loop would duplicate
the loop's own skip logic, and the consequence is a shortened ladder for a
broadcast that was sending to nobody. Accepted and stated rather than hidden.

### 2b. The continuation block (~:478-513)

`claim.attempt` is the current pass number (= today's `payload.attempt ?? 1`).
Keep `const nextAttempt = claim.attempt + 1`.

| use | today | after |
|---|---|---|
| cap test | `if (nextAttempt > MAX_BROADCAST_ATTEMPTS)` | **deleted** - close A trigger below |
| backoff | `broadcastBackoffMs(nextAttempt)` | **unchanged** |
| enqueued payload | `attempt: nextAttempt` | **unchanged** (advisory) |

```ts
if (transientRemaining.length > 0) {
  if (claim.attempt >= MAX_BROADCAST_ATTEMPTS) {          // close A
    await closeBroadcast(transientRemaining, 'transient_cap');
    return;
  }
  try {
    await enqueue(BROADCAST_SEND_JOB, {...}, { runAt: ...broadcastBackoffMs(nextAttempt) });
  } catch (err) {                                          // close C (D9)
    await closeBroadcast(transientRemaining, 'enqueue_failed');
    return;
  }
  return;   // KEEP - main:509 "A continuation is still pending - do NOT finalize yet"
}
await finalize(...);
```

All three `return`s are load-bearing; dropping the last finalizes the broadcast
as Sent on pass 1 with a continuation in flight.

### 2c. `closeBroadcast`

**Define it INSIDE the handler closure**, and **pin the lazily-initialised repos
to `const` first**:

```ts
broadcasts ??= createBroadcastsRepo(...);   // existing lazy init (~:189/:198)
const repo = broadcasts;                    // pin - capture THIS, not the `let`
async function closeBroadcast(recipientKeys: string[], code: string) { ... }
```

A module-level helper would need 7-8 arguments. But the narrowing problem is
**not about placement**: capturing the reassignable `let broadcasts`
(broadcastFanOut.ts ~:189/:198) - or `let messages` in relayFanOut (~:321/:332) -
inside ANY nested function loses TS's narrowing wherever that function sits,
because the compiler cannot prove the binding is still non-undefined when the
closure runs. The fix is the pinned `const`, and gate 1 is what catches getting
it wrong.

Body, lifted from the existing cap branch (~:481-495): per key
`recordRecipient({ status: 'failed', errorCode: code })`, `bumpStats({ failed:
1, queued: -1 })`, `emitBroadcastProgress`, skipping keys already terminal; then
`finalize(...)` once. **Keep the existing operator `log.error`**, parameterised
by the reason - closes A, B and C must each leave a log line.

### 2d. The existing cap test WILL GO RED - rewrite it, do not weaken it

`app/test/broadcastFanOut.test.ts:383-400` drives the cap by putting
`attempt: 3` in the ENVELOPE. Once the counter is durable that envelope field is
advisory, the claim returns 1, and the test's cap expectation fails.

**It is the only test pinning the cap-close shape.** Keep every existing
assertion (`failed`, `transient_cap`, stats, terminal status). Do not delete it,
do not relax it.

**Two tests are required, not one - "either" would leave close A untested.**

- **Close A** (the only close with a production trigger): drive the ladder for
  real - three passes, each deferring the recipient - so the cap is reached the
  way production reaches it. This is the rewrite of the existing test.
- **Close B**: seed `fanout_attempt` at the cap via slice 0's hook and dispatch
  one envelope. Close B has no production trigger once close A exists, so it can
  only be constructed.

Writing only the seeded variant would leave the one close that actually fires in
production with no coverage at all.

**Tests (spec 7.3-7.8):**
- **RED-ON-MAIN:** with enqueueing broken, the broadcast finalizes, no recipient
  left `queued`, row no longer `sending`.
  **Seam: `configureOutboundQueue` with an adapter whose `enqueue` throws** -
  NOT `vi.mock('./jobs.js')`, which fights the harness both fan-outs and both
  test files already use.
- closes A, B and C each leave the same terminal shape - enumerated as: every
  recipient terminal, stats reconciled (`queued` 0), row finalized, one log line.
- **backoff delays asserted as LITERAL milliseconds** (pass 1->2 = 10s,
  2->3 = 20s), read off the `runAt` passed to the capturing adapter.
  **Do not assert `broadcastBackoffMs(n)`** - that re-derives from the function
  under test and passes against a shifted ladder, which is exactly what D7/D11
  exist to prevent.
- **the send COUNT per deferred recipient equals `main`'s** - three passes, not
  two and not four (spec 7.5 has two halves; delays alone do not pin the count,
  and the count alone does not pin the delays).
- a pass that enqueues successfully leaves the broadcast `sending`.
- a same-`jobId` redelivery claims nothing; an all-terminal pass claims nothing.

---

## Slice 3 - relayFanOut

**File:** `jobs/relayFanOut.ts`. Same shape as slice 2; four differences.

**3a. Anchor** - immediately after the recipient derivation (`let recipients =
roster.filter(...)` + the `recipientKeys` narrowing, ~:434-438). Same `pending`
guard against already-terminal slots.

**3b. Counter key** - `conversationId` + `sourceTsMsgId` (slice 1).

**3c. Backoff differs and is preserved** (D7, D11):

| use | today | after |
|---|---|---|
| cap test | `if (nextAttempt > MAX_FANOUT_ATTEMPTS)` | deleted |
| backoff | `fanOutBackoffMs(payload.attempt ?? 1)` | `fanOutBackoffMs(claim.attempt)` - same value |
| payload | `attempt: nextAttempt` | unchanged |

Broadcast waits the NEXT step, relay the CURRENT one. **Do not normalise.**
Assert literal delays: relay pass 1->2 = 5s, 2->3 = 10s.

**3d. `closeRelay(memberKeys, code)`** - `markRecipient({ status: 'failed',
errorCode: code })` per non-terminal key, plus the existing `log.error`.
**No `finalize()`, no `bumpStats`, no progress emit, no `sending` status** -
none exist in this file. One helper per file; slice 2's assertion list does NOT
transfer wholesale.

**Third enqueuer:** `services/relayQueuedMessages.ts:93` also enqueues
`RELAY_FANOUT_JOB`, with no `recipientKeys` and no `attempt`. It releases
`queued_pending` messages that have never been fanned out, so their counter is
absent and they claim at 1. **Confirm that by reading before relying on it**; if
a flushed message can already carry a counter, it inherits an exhausted budget.

**Tests:** slice 2's list adapted (no finalize/stats assertions), plus close B
on a **relay INBOUND source message** whose `delivery_recipients` is seeded
EMPTY - the shape where a row-derived recipient set marks nothing and a
team-send fixture would pass vacuously (spec 7.4). Include the RED-ON-MAIN
enqueue-failure test here too.

---

## Slice 4 - group rail propagation ladder

**Files:** `services/groupRail.ts` + three callers.

**4a. Deps and flag.**
- Add `sleep?: (ms: number) => Promise<void>` to `GroupRailServiceDeps`,
  defaulting to a real timer - matching the eight existing `sleep?:` injection
  points in this repo (`lib/tokenBucket.ts`, `services/mediaMirror.ts`,
  `services/groupIdentityFingerprint.ts`, `lib/import/convertGroups.ts`, ...).
  **Without it slice 4's tests cannot be written as specified** and would add
  2s of real sleeping per case.
- Add a named optional boolean to `GroupRailRequest` (pick the name in the
  build; it is a public-ish shape, so name it for what it does, e.g.
  `awaitBindingPropagation`).

**4b. Callers.** Pass the flag from `jobs/groupRail.ts:59`,
`app/scripts/rail-verify.ts:198`, and the import path - note
`convertGroups.ts:598` is a pass-through wrapper (`ensureRail`); the request
object is built at **~:429**, which is where the flag belongs. **Do not touch
`groupSend.ts:381` or `healRail` :425** (D16).

**4c. The ladder.** Given a re-read function and the current `missing` set,
re-read up to 2 more times at 500ms then 1500ms, stopping when `missing` empties.

Apply at both points that can conclude damage (D14), each gated on the flag AND
on `!wasAdopted`:

1. the validation read after create - the post-create list arrives INSIDE the
   adapter's return, so this is a NEW `fetchParticipants` call;
2. the existing post-repair `fetchParticipants` (~:538).

**4d. The ladder MUST sit inside the enclosing try/catch.** A throwing
`fetchParticipants` outside one escapes `ensureGroupRail` and leaks the
`rail_creating` claim for its ~5-minute expiry - the precise failure D16 used to
reject changing the `groupSend` paths. Verify the placement lands inside the
existing handler; if ladder point 1 needs its own wrapper, **the catch must
behave like the existing participant-read failure path**: record the rail
failure and return, exactly as the current `fetchParticipants` catch does.

**Do NOT swallow and continue with the previously-read list.** That leaks
nothing but silently substitutes a STALE `participants` value for an
authoritative read - which is precisely what D15 forbids, and it would store a
map that does not describe the rail. A ladder re-read that throws is a failed
read, not a reason to trust older data.

**4e. State the coupling.** The ladder REASSIGNS `participants`, which also
feeds the author-verification block (~:578-584) and the stored participant map
(~:619-625). That is intended - the author block's own comment says the
propagation issue applies to the projected address too - but it is a behavior
change beyond "the map is now complete", and its test must assert the author
path still behaves.

Nothing else changes: the re-read stays authoritative (D15), no 50386/50437
handling (D18).

**Tests (spec 7.9):** propagation resolves without repair; a genuinely unbound
member still repairs; the post-repair read ladders; **the adopt path ladders on
neither read**; both `groupSend` callers pass no flag AND with the flag absent
neither read ladders (assert the flag path, not just `wasAdopted`); the author
block still behaves.

**Fixture warning:** the headline case only means something if
`createConversationWithParticipants` is made to return the SHORT participant
list on the first read and the full one after. A fixture that returns the full
list immediately passes against no ladder at all.

---

## Slice 5 - dashboard copy. **5b runs BEFORE slices 2-3 ship.**

`enqueue_failed` is introduced by slice 2. Until 5b registers it, it prints as
`Delivery failed (error enqueue_failed)` - the exact D22 defect. 5b is a
prerequisite, not an independent slice.

**5b (first). Internal codes.** Register `transient_cap` and `enqueue_failed` in
`INTERNAL_CODE_REASONS` with plain operator copy and **no `(error <code>)`
tail**. Copy must read correctly BOTH as an aggregate summary and on one
recipient's row - unlike `contact_opted_out`, these get no per-position
interception. `DeliveryBadge.tsx:31` is where a broadcast's codes surface, so
this changes that badge.

**5a. Relay 30003 override** (D19-D21). A relay-scoped map consulted the way
`media` already selects `MMS_ERROR_CODE_REASONS`. `presentLegDelivery` already
takes `rosterKind`; `presentRelayDelivery` gains it from its caller.

**The override KEEPS the `(error 30003)` tail** - it is a real carrier code an
operator can look up; only the retry promise is removed. (This differs from 5b's
codes, which are ours and get no tail.)

Six call sites:

| site | change |
|---|---|
| `deliveryStatus.ts:416` (relay/group rollup) | override when relay |
| `Timeline.tsx:582` (per-leg reason) | override when relay |
| `Timeline.tsx:1045` (per-recipient row) | override when relay |
| `Timeline.tsx:849` (1:1 bubble) | none |
| `Timeline.tsx:1390` (EmailCard) | none |
| `DeliveryBadge.tsx:31` (broadcast badge) | none for 30003 |

`rosterKind` **DEFAULTS to `'relay'`** (~Timeline.tsx:796), so the group-text
exclusion holds only because one site opts out - pin it explicitly.

**ASCII gate:** the live 30003 string contains an EM DASH. Leave the 1:1 entry
byte-identical; **do not copy that character into any new line** - added lines
are ASCII-only.

**Tests (spec 7.10, 7.11):** relay 30003 copy at all three relay positions with
the tail intact; group-text pinned by passing `rosterKind: 'group_text'`
explicitly; 1:1, email and badge unchanged; both internal codes render as prose
in all three positions with no tail.

---

## Slice 6 - the provider-status sweep (AFTER 2, 3 AND 4)

Read-only audit (spec Sec 9). Its in-region fixes land in files slices 2, 3 and
4 edit, so it is last, not free. `groupRail.ts:259-262` (`isDeadRailState`) is a
live sweep hit whose fix-here-vs-file disposition flips depending on whether
slice 4 has landed.

Enumerate every `app/src` site branching on a provider status string; record
`file:line` and whether the unenumerated default is terminal. Fix in-region;
file the rest as one issue.

**`routes/webhooks/twilio.ts` is fenced in its ENTIRETY** (spec Sec 2) and is
the repo's densest provider-status file. Audit it - it is in `app/src` - but
every finding there is FILED, never fixed, regardless of how small.

The unknown-error `throw` in the two fan-outs is the other named in-region
exception - filed, not fixed (D12).

**While in those two regions, correct the two false comments**
(`broadcastFanOut.ts:456-458`, `relayFanOut.ts:532-534`) that claim a redelivery
gets a fresh `jobId`. `jobs.ts:189` proves otherwise, `retrySend.ts:122-128`
states it correctly, and they sit inside edited code. Comment-only.

Output: `docs/superpowers/reviews/2026-08-31-retry-counter-durable/provider-status-sweep.md`.
A nil result is still committed.

---

## Slice 7 - e2e + closure

- E2E: a relay leg that failed 30003 shows no retry promise. **Arm with
  `setDeliveryOutcome` (fake-twilio), not seed data** - no seed profile carries
  a `delivery_recipients` map, so a seeded fixture asserts against an empty list
  and passes while proving nothing.
- Stamp Resolutions:
  - `retry-counter-in-envelope-makes-caps-unreachable` - **note that its third
    named site, `retrySend.ts:74`, needed no change**: already handled at
    `twilio.ts:~2727-2731`. Do not imply it was fixed here.
  - `rail-binding-propagation-retry` - **partial**; name the two uncovered
    `groupSend` callers.
- File follow-ups: adopt-path exposure (D17), refusal log noise (D18), and
  whether `closeRelay` should also drive the hub message's own
  `delivery_status` to terminal (verify first - the rollup may already mask it).
- **Update `relay-30003-retry-lineage` with the five design facts spec Sec 8
  obligation 5 names** - the forward-only transition problem, the
  slot-transition gate capping the ladder at one retry, the
  `relayAnnouncements` pointer fence, the two-level map's seeding problem, and
  the chip copy needing revisiting. This is a task, not a note: three review
  rounds bought those facts and the follow-on mission should not re-buy them.
- Amend `_CLUSTERS.md` M5.
- `npm run issues`.

---

## Gates

From the worktree, bare, after one `main` sync:

1. `npm run typecheck`
2. `npm test`
3. `npm run smoke`
4. `npm run e2e`
5. `npx eslint $(git diff --name-only --diff-filter=d main...HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')`

Never pipe a gate. A red `npm test` is not a regression until re-run under
`AWS_ACCESS_KEY_ID=hccleanrun001` and compared against the merge base by failing
FILE - three other missions share this machine and one DynamoDB Local container.
Confirm no orphaned listener on the lane's ports before each e2e run.

## Ordering

**0+1 -> 5b -> 2 -> 3 -> 4 -> 6 -> 7.** Slices 0 and 1 are one build step.
Slice 4 is independent of 1-3 and may run any time after 0, but must precede 6.

Stopping points: after any slice the branch typechecks and every stated
guarantee holds. The one ordering trap is 5b before 2 - shipping
`enqueue_failed` without its copy prints a raw token at an operator.
