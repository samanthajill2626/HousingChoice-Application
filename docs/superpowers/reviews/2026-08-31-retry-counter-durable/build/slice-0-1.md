# Slice 0+1 - the durable fan-out claim primitive

Branch `feat/retry-counter-durable`, worktree `W:\tmp\retry-counter-durable`.
Base for this step: `5cf1da0b` (main already merged at `8c8b7100`; no further
sync performed).

Commits:

- `1dd28853` feat(repos): durable fan-out pass claim (claimFanoutPass) on both repos
- `18e4a00b` test(repos): DynamoDB Local cases for claimFanoutPass, both repos
- (this report, committed separately)

Nothing calls the primitive yet; the fan-out jobs are slices 2 and 3.

---

## 1. What shipped

### New file

- `app/src/repos/fanoutClaim.ts` - `FanoutClaimResult` at `:29`. Type-only
  module, per the worklist RULING: neither repo imports the other, so a shared
  union has nowhere else to live without duplication.

### `app/src/repos/messagesRepo.ts`

- `:33` `import type { FanoutClaimResult } from './fanoutClaim.js';`
- `:880` `fanout_attempt?: number` on `MessageItem`, directly under
  `retry_attempt` (`:874`), with the comment stating it is the fan-out
  CONTINUATION ladder's counter, a sibling of the 1:1 retry ladder and never
  shared with it.
- `:1332` interface declaration, in the Relay groups (M1.7) block above
  `setRecipientDelivery`.
- `:2789-2834` implementation, first method of the Relay groups block in the
  factory literal.

### `app/src/repos/broadcastsRepo.ts`

- `:36` the same type import.
- `:174` `fanout_attempt?: number` on `BroadcastItem` (no `retry_attempt`
  sibling exists on this type, as the plan said).
- `:373` interface declaration, above `bumpStats`.
- `:650-689` implementation, above `bumpStats` in the factory literal.

### Fakes (all four hand-written literals)

- `app/test/helpers/twilioWebhookHarness.ts:1337-1352` (messages) and
  `:2758-2777` (broadcasts) - full semantic models.
- `app/test/sendMessage.test.ts:239-241` and
  `app/test/scheduledSendSuppression.test.ts:288-291` - throwing stubs, matching
  the local `'<method>: not used in this suite'` idiom rather than inventing a
  `'not implemented'` string.

### Tests

- `app/test/broadcastsRepo.integration.test.ts` - header comment widened
  (`:9-13`), describe title widened (`:54`), ten new cases at `:470-598` behind
  four local helpers - `seedBroadcast` (`:413`), `seedSourceMessage` (`:423`),
  `setStoredFanoutAttempt` (`:443`), `readStoredFanoutAttempt` (`:460`) - under
  the block comment at `:401-411`. Two table-name consts at `:65-66`.

---

## 2. The exact contract shipped

Signatures (both as the worklist specified them):

- `BroadcastsRepo.claimFanoutPass(broadcastId: string, cap: number): Promise<FanoutClaimResult>`
- `MessagesRepo.claimFanoutPass(conversationId: string, tsMsgId: string, cap: number): Promise<FanoutClaimResult>`
  keyed on the SOURCE MESSAGE. The relay caller passes
  `payload.relayConversationId` + `payload.sourceTsMsgId`; there is no
  `payload.conversationId`.

The union, verbatim as shipped:

- `{ outcome: 'claimed'; attempt: number }` - `attempt` is the POST-increment
  value, i.e. the pass number just taken.
- `{ outcome: 'capped'; attempt: number }` - `attempt` is the UNCHANGED stored
  count.
- `{ outcome: 'missing' }` - no `attempt` field at all.

Persisted attribute name: `fanout_attempt` (top-level scalar on both item
types). Aliased as `#fa` in every expression.

Wire behavior, identical in both repos:

- `UpdateExpression: 'ADD #fa :one'`, `:one = 1`, `ReturnValues: 'UPDATED_NEW'`.
- `ConditionExpression: '<existence> AND (attribute_not_exists(#fa) OR #fa < :cap)'`,
  where `<existence>` is `attribute_exists(tsMsgId)` for messages (the RANGE key,
  this file's idiom) and `attribute_exists(broadcastId)` for broadcasts. NOT
  symmetric, per repos F5.
- On `ConditionalCheckFailedException` (matched with `instanceof`, never a name
  string): a direct `GetCommand` with `ConsistentRead: true`. Item absent ->
  `missing`; item present -> `capped` with `attempt: <stored> ?? 0`. Neither
  `getByTsMsgId` nor `getById` is reused - both are eventually consistent and
  could report a live item missing, skipping a close.
- If `UPDATED_NEW` returns no `fanout_attempt`, the method THROWS
  (`usersRepo.ts:543-546` precedent). It does not silently default to 1.
- Any non-CCF error is rethrown untouched.
- `cap` is a parameter, never an import: the two cap constants live in `jobs/`
  and a repo must not import from there.

Fake semantics (the harness fakes, both):

- item absent -> `{ outcome: 'missing' }`. The broadcasts fake deliberately
  does NOT throw the synthesized `ConditionalCheckFailedException` that its
  neighbouring mutators throw; otherwise the missing branch would be
  unreachable through the fake.
- `(item.fanout_attempt ?? 0) >= cap` -> `{ outcome: 'capped', attempt: current }`,
  counter untouched.
- otherwise increment IN PLACE on the STORED object and return
  `{ outcome: 'claimed', attempt: next }`.
- The broadcasts fake reads and writes `broadcasts.get(id)` (the Map entry),
  never a `getById` result - `getById` returns a shallow copy, so a
  copy-based claim would silently ignore a seeded counter. The messages fake
  works on the object stored by reference in `world.messages[]`.

---

## 3. Deviations from the plan / worklist

1. **The plan's slice-0 item 4 ("add a test-only way to SET the counter") was
   not built.** Already satisfied: `FakeWorld` exposes both stores
   (`messages: MessageItem[]`, `broadcasts: Map<string, BroadcastItem>`), and
   both fan-out suites already reach in. Repos F3 called this; recorded here so
   the next slice does not go looking for a hook.
2. **Two imports were added to the integration test file** (`GetCommand`,
   `UpdateCommand` from `@aws-sdk/lib-dynamodb`, `:19`). The reference listed
   the file's existing imports and neither was among them; the first typecheck
   run caught it (`TS2304` x2 plus a `TS2339` on `ServiceOutputTypes`). No other
   surprise.
3. **Seeding an exact counter value uses a raw `UpdateCommand`
   (`SET #fa = :n`), not the `PutCommand` idiom** the reference offered. A Put
   would have to reconstruct a whole valid item; an Update on a repo-created row
   plants exactly one attribute and nothing else.
4. **The `throw` on a missing `UPDATED_NEW` value is placed AFTER the
   try/catch**, not inside the `try`. Inside, it would fall into the same
   `catch`, be re-thrown by the non-CCF guard, and read as if the guard were
   dead code. Same shape as the `let balance: number; try {...} catch {...}`
   precedent.
5. The describe title reads `'broadcast + relay repo UpdateExpressions and
   fan-out pass claims against DynamoDB Local'` - a one-line call kept, so the
   body's indentation (and therefore the diff) is unchanged.

No deviation from any `[RULING]`. Nothing outside the named file list was
touched; no job, route, or fenced file was opened for edit.

---

## 4. Gates

Logs under the gitignored `.superpowers/gates/`.

**RED first (TDD), before the primitive existed** -
`.superpowers/gates/s01-red-vitest.log`, exit code 1:

```
 Test Files  1 failed (1)
      Tests  10 failed | 9 passed (19)
```

Every one of the 10 failures was
`TypeError: broadcasts.claimFanoutPass is not a function` /
`TypeError: messages.claimFanoutPass is not a function`. The 9 passes are the
suite's pre-existing cases.

**Gate 1** `npm run typecheck` from `W:\tmp\retry-counter-durable` -
`.superpowers/gates/s01-typecheck.log`, **exit code 0**. All five workspaces
(app x3 tsconfigs, dashboard, e2e, fake-twilio, fake-twilio-web) clean.

**Gate 2** `npx vitest run test/broadcastsRepo.integration.test.ts
test/broadcastFanOut.test.ts test/relayFanOut.test.ts
test/scheduledSendSuppression.test.ts test/sendMessage.test.ts` from
`W:\tmp\retry-counter-durable\app` - `.superpowers/gates/s01-vitest.log`,
**exit code 0**. Per file, quoted:

```
 v test/broadcastsRepo.integration.test.ts (19 tests) 692ms
 v test/scheduledSendSuppression.test.ts (23 tests) 17ms
 v test/sendMessage.test.ts (30 tests) 56ms
 v test/broadcastFanOut.test.ts (25 tests) 114ms
 v test/relayFanOut.test.ts (65 tests) 176ms
 Test Files  5 passed (5)
      Tests  162 passed (162)
   Duration  23.98s
```

(The check marks are ASCII-flattened here.) The integration suite ran against
the live DynamoDB Local on `:8000` - it did not self-skip; the 10 new cases are
part of the 19.

Not run, by instruction: `npm test`, `npm run smoke`, `npm run e2e`, eslint.
No command was piped; every gate wrote to a file read afterwards.

ASCII: the added lines of the full diff (including the new file) were byte-
scanned for code points > 126. Zero hits. The pre-existing non-ASCII in
`messagesRepo.ts` (a section sign in the `retry_attempt` comment) and in the
test file's older titles is untouched context.

---

## 5. What slice 2 and slice 3 must know

1. **Seeding the counter needs no new hook.** For close B, seed the STORED
   object:
   - broadcasts: `world.broadcasts.get('bcast-1')!.fanout_attempt = 3;`
     (precedent `broadcastFanOut.test.ts:380`). Never seed a `getById` result -
     it is a shallow copy.
   - messages: set `fanout_attempt` on the item pushed into `world.messages`
     (precedent `relayFanOut.test.ts:90`), or on the object returned by the
     fake's `getByTsMsgId`, which IS the stored object.
2. **A capped claim returns the count, not the cap.** `capped.attempt` is
   whatever is stored, so a close branch reading `claim.attempt` gets 3 on a
   seeded-at-3 item and would get 5 on a hand-seeded 5. Do not treat it as
   "== cap".
3. **`missing` carries no `attempt`.** TypeScript narrows on `outcome`; a
   `claim.attempt` read must be guarded or the file will not typecheck.
4. **The claim is NOT idempotent per job delivery.** It advances on every call,
   which is exactly why D6 puts it after the job-execution marker and after the
   job has decided it will send. A duplicate delivery that reaches the claim
   consumes a pass.
5. **The fakes refuse at cap for real.** A slice-2/3 test that expects three
   passes must give the ladder a cap of at least three; the fake will not hand
   out a fourth.
6. **Nothing imports the cap constants into the repos.** `MAX_BROADCAST_ATTEMPTS`
   / `MAX_FANOUT_ATTEMPTS` stay in `jobs/` and are passed as `cap`.
7. **Both jobs still compile and pass unchanged** (25 + 65 tests green), so any
   later red in those files is the new call site, not this primitive.
