# Slice A report - plan Tasks 1 and 2

Implementer record for the retry-lineage fields, the deterministic claim
identity, the media-pointer suppression, and the consistent source read.
Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `67f9abe3`.

## Commits

| hash | subject |
| --- | --- |
| `814f2997` | feat(relay): retry lineage fields and the deterministic claim identity |
| `6940a63d` | feat(relay): expose a consistent message read for the retry claim path |

`814f2997` was amended once, before any later work: the first `git commit` used
a PowerShell here-string through the Bash tool, so the literal `@'` / `'@`
markers landed as lines in the message. The tree was identical; only the message
changed. The discarded hash `25080da2` never left this worktree.

## Files touched

Commit 1 (`814f2997`), 4 files, +436 / -1:

- `app/src/lib/relayRetryClaim.ts` - NEW. `MAX_RELAY_RETRY_ATTEMPTS`,
  `relayRetryBackoffMs`, `relayRetryDigest`, `relayRetryProviderSid`, and the
  shared `RelayRetryClaimOutcome` union (11 values, D23 + adjudication S2a).
  Imports `node:crypto` only - no repo, no adapter.
- `app/src/repos/messagesRepo.ts` - six optional `relayRetry*` fields on
  `NewMessage` (beside `retryOf`), the six snake_case twins on `MessageItem`
  (beside `retry_attempt`), the persistence block in `append` (beside the
  `retry_of` conditional spread), and the D13 media-pointer guard.
- `app/test/relayRetryClaim.test.ts` - NEW.
- `app/test/messagesRepoRetryLineage.integration.test.ts` - NEW.

Commit 2 (`6940a63d`), 6 files, +90 / -0:

- `app/src/repos/messagesRepo.ts` - `getByTsMsgIdConsistent` on the
  `MessagesRepo` interface (immediately after `getByTsMsgId`) and on the factory
  return (immediately after the `getByTsMsgId` implementation).
- `app/test/helpers/twilioWebhookHarness.ts`,
  `app/test/scheduledSendSuppression.test.ts`, `app/test/sendMessage.test.ts` -
  the three typed `MessagesRepo` fakes of adjudication S9 / worklist B1.
- `app/test/repos.test.ts` - the `ConsistentRead` flag assertion.
- `app/test/messagesRepoRetryLineage.integration.test.ts` - the consistent-read
  round trip.

Nothing outside the slice's scope list was edited. `relayAnnouncements.ts`,
`tourReminders.ts`, `ALLOWED_PRIOR` and the 1:1 retry path are untouched.

## Test results

Task 1, both suites (`npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/relayRetryClaim.test.ts`):

```
 Test Files  2 passed (2)
      Tests  12 passed (12)
```

per file: `test/relayRetryClaim.test.ts` 5 tests,
`test/messagesRepoRetryLineage.integration.test.ts` 7 tests.

Task 2, three suites (`npx vitest run test/messagesRepoRetryLineage.integration.test.ts test/repos.test.ts test/relayRetryClaim.test.ts`):

```
 Test Files  3 passed (3)
      Tests  34 passed (34)
```

per file: `test/relayRetryClaim.test.ts` 5, `test/repos.test.ts` 21 (20 before
this slice, +1), `test/messagesRepoRetryLineage.integration.test.ts` 8 (7 + the
consistent-read round trip).

Regression check on the three suites whose typed fakes changed - the harness one
by proxy, since `twilioWebhookHarness.ts` is not itself a suite
(`npx vitest run test/sendMessage.test.ts test/scheduledSendSuppression.test.ts test/relayWebhook.test.ts`):

```
 Test Files  3 passed (3)
      Tests  83 passed (83)
```

per file: `scheduledSendSuppression` 23, `sendMessage` 33, `relayWebhook` 27.

Every suite was watched RED first for the right reason: the identity suite on
`Failed to load url ../src/lib/relayRetryClaim.js`; the persistence suite on
3 of 7 failing (lineage values read back `undefined`, pointers present, attempt
`undefined`); both consistent-read tests on
`getByTsMsgIdConsistent is not a function`.

## Gates

- `npm run typecheck`, run bare from the worktree root after EACH commit:
  **exit 0** both times. The Task 2 run is the proof that adjudication S9's
  three-file fake list is complete - no fourth file surfaced.
- `npx eslint` on the eight touched `.ts` files: **exit 0**, no output.
- `npm test`, `npm run smoke`, `npm run e2e` and Playwright deliberately NOT
  run; the orchestrator owns the battery.

## The `append` result field names the dedupe test relies on

`AppendResult` at `app/src/repos/messagesRepo.ts:1149-1154`:

- `deduped: boolean` - false = fresh write, true = this provider SID was already
  persisted.
- `tsMsgId: string` - on a dedupe, the FIRST write's key, which can differ from
  this call's `providerTs`.

The test asserts `first.deduped === false`, `second.deduped === true` and
`second.tsMsgId === first.tsMsgId`, with two explicit, DIFFERENT `providerTs`
values five seconds apart. That difference matters: it makes item 0 of the
transaction a key that would have succeeded, so the dedupe can only be coming
from the index-1 SID pointer - which is exactly D3's claim mechanism.

## Divergences from the plan and the adjudications

1. **`mediaPointerCount` does not exist** (adjudication S7, worklist D4). The
   no-pointer test reads `messages.listMediaPointers(CONV, { limit: 50 })` and
   filters on the deterministic SID.
2. **Added a positive control to that same test**, beyond the plan: a non-retry
   outbound MMS appended into the same conversation, asserted PRESENT in the
   pointer list immediately before the retry SID is asserted ABSENT. Without it
   a broken read and a working suppression are the same green.
3. **The D13 comment does not say "would triple a photo in the gallery"**
   (adjudication S6). It states the corrected rationale: the pointer write is
   unconditioned, three rungs add three index rows per failed leg, and the one
   reader today excludes relay threads BY NAME at
   `app/src/routes/contacts.ts:1374-1379` - by name, hence reversibly.
4. **The `ConsistentRead` assertion is not in `messagesRepo.transport.test.ts`**
   (adjudication S8, worklist D6): that file is a DynamoDB integration suite
   with no `sentInput()`. It went into `app/test/repos.test.ts` using the pure
   doc-client stub idiom of `app/test/repos.test.ts:98-115` / `:184-205`. A new
   local `createGetHarness()` was written beside `createAppendHarness()` rather
   than extending the latter, because `createAppendHarness` throws on anything
   that is not a `TransactWriteCommand`.
5. **The union test is a `Record<RelayRetryClaimOutcome, true>`.** A bare array
   typed as the union would catch an invalid member but not a MISSING one; the
   Record is exhaustive in both directions at compile time, and the test then
   asserts the runtime key set. Mission-directed addition to the plan's four.
6. **Extra test: "round-trips the attachments a retry row re-presigns from"**
   (mission-directed) - two attachments including a `filename`, on a rung-2 row.
7. **`[1, 2, 3].map(relayRetryBackoffMs)` was written as
   `.map((n) => relayRetryBackoffMs(n))`.** Identical today; it stops `map`'s
   index and array arguments reaching the helper if its signature ever grows a
   second parameter.
8. **`getByTsMsgIdConsistent: getMessageConsistent`** is a direct binding on the
   factory return, not an `async` wrapper. Plan Task 2 Step 3 says reuse the
   existing closure and write no second `GetCommand`; a binding is the literal
   form of that.
9. **The consistent-read integration test also asserts `undefined` for an absent
   key.** D7's whole point is that after this change an absent row means
   genuinely absent, so the undefined arm is worth pinning, not assumed.
10. **`MessageItem`'s new field block carries a one-line warning that a retry row
    must NOT carry `retry_of`** (D20, and the dashboard Part C hazard at
    `Timeline.tsx:1791-1797`): stamping it would add the ORIGINAL to
    `supersededIds` and delete the bubble the retry is meant to render beside.
    Comment only, no behaviour.

## For the orchestrator

- **`relay_retry_of` is the suppression discriminator.** `append` decides
  `isRelayRetryRow` from `message.relayRetryOf !== undefined` alone. Task 12's
  row builder must set it on EVERY rung, including rungs 2 and 3, or the D13
  suppression silently lapses for those rows. The same field is the join key, so
  a rung missing it is broken twice over.
- **Rungs 2 and 3 chain to the ROOT.** Nothing in this slice enforces that -
  `relayRetryOf` is a plain string. It is the row builder's obligation (plan
  Task 6's `indexRelayRetries` test asserts the consequence).
- **`MessageItem` already had an index signature** at `messagesRepo.ts:1119`, so
  the stored `relay_retry_*` values read back even before this slice, typed
  `unknown`. They are now declared, so a reader gets the real type. No migration
  and no backfill: every field is optional and absent on every existing row.
- **The dedupe path was not re-proven against a `dueRow` or an
  `emailmsgid#` pointer**, because a retry row carries neither - which is what
  keeps the SID pointer at transaction index 1 and makes D3's claim attribution
  exact. If a later task ever gives a retry row a due row, that index assumption
  moves and the dedupe stops being attributable.
- **No phone number is written anywhere by this slice.** The digest is stored;
  the raw destination is not. The one residual is pre-existing and named in D5:
  `relayMemberKey` falls back to `phone#<E164>` for a contact-less member, so
  `relay_retry_member_key` can carry a handset on those - unchanged by this
  slice, and already true of `delivery_recipients`.
