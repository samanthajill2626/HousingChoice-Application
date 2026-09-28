# Share sent outcome (Branch B) - build slice 1 report (T1-T3)

Date: 2026-09-28. Implementer: slice-1 child (Claude Opus 5.5), dispatched by
the build orchestrator. Worktree `W:\tmp\share-sent-outcome`, branch
`feat/share-sent-outcome`, base `a8a75e8e` (the mission block). Plan:
`docs/superpowers/plans/2026-09-28-share-sent-outcome.md` v5, Tasks 1-3.

## Status

DONE - Tasks 1, 2 and 3 are committed, one commit per task, plus ONE follow-up
fix commit on Task 2 (a phone-keyed slot key in a WARN line, found in my own
self-review after the Task 3 commit - see Task 2). No STOP condition was hit:
no unnamed importer of a changed symbol, no type seam from the optional
`sentAt` beyond `toListingSendRow` and the harness double, no contract mismatch
with the tree, no red test outside the named pins.

| Commit | What |
|---|---|
| `ca55f3b3` | T1 - the attempt order key, the slot's `latestAttempt`, `applyAttemptOutcome`, `getByIds`, `retry_pending` opt-in, cap 1000 |
| `5ea5005f` | T2 - the D1 recipient state service |
| `3c885850` | T3 - the D7 ledger memory (repo, service, double, parity, readers filter, sparse note, seed guard) |
| `a9ed3ab3` | T2 fix - the record-read WARN logs a phone-keyed slot key redacted |

Gates NOT run, per the mission: the full `npm test`, `npm run e2e`,
`npm run smoke`. Every command below ran bare from the worktree; outputs were
redirected to `.superpowers/sdd/logs/s1-*.log` (gitignored) and read after.

## Task 1 - `ca55f3b3`

Files: created `app/src/lib/shareAttemptOrder.ts`,
`app/test/shareAttemptOrder.test.ts`,
`app/test/broadcastsRepoAttemptOutcome.integration.test.ts`; modified
`app/src/repos/broadcastsRepo.ts`, `app/test/helpers/twilioWebhookHarness.ts`,
`app/test/deriveBroadcastStats.test.ts`,
`app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`.

Runs (from `app/`):

- RED leaf: `npx vitest run test/shareAttemptOrder.test.ts` - "Test Files 1
  failed (1) / Tests no tests", `Cannot find module
  '../src/lib/shareAttemptOrder.js'`.
- GREEN leaf: same command - "Tests 5 passed (5)".
- RED repo/stats/parity: `npx vitest run
  test/broadcastsRepoAttemptOutcome.integration.test.ts
  test/deriveBroadcastStats.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts` - "Test Files 3
  failed (3) / Tests 15 failed | 25 passed (40)": `repo.applyAttemptOutcome is
  not a function` x7, `repo.getByIds is not a function` x5, and three
  deriveBroadcastStats assertions (`retry_pending` undefined; the
  `unconfirmedKeys` slot not moved; the option-supplied passthrough not a copy).
- GREEN: `npx vitest run test/shareAttemptOrder.test.ts
  test/broadcastsRepoAttemptOutcome.integration.test.ts
  test/deriveBroadcastStats.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts
  test/broadcastApi.test.ts` - "Test Files 5 passed (5) / Tests 112 passed
  (112)" (deriveBroadcastStats 10, shareAttemptOrder 5,
  broadcastsRepoAttemptOutcome 10, parity 20, broadcastApi 67). The identity
  pin `deriveBroadcastStats.test.ts:26` holds; `broadcastApi.test.ts:561` and
  `:985` stay green at 1000.
- `npm run typecheck` (repo root): EXIT=0.

Divergences from the plan's sketches (all deliberate):

1. Order: Step 9's three stats tests and Step 8's parity cases were written
   BEFORE Step 7's implementation, so they were watched red; the plan lists
   them after it.
2. The integration file adds three cases to the plan's seven: an apply whose
   `expect` names the recorded retry (the `recipients.#ck.#la = :pa` branch),
   an EMPTY delta (no ADD clause, no unused alias), and a 105-id `getByIds`
   (two BatchGet chunks, duplicate ids read once). The stats-projection case
   asserts the whole projected item with `toStrictEqual`.
3. Parity (`twilioWebhookHarnessRepoAdditions.integration.test.ts:864`): the
   plan's four `applyAttemptOutcome` cases, plus a missing slot, an apply over
   the recorded attempt it names, and a same-attempt carrier-instant write with
   an empty delta; plus a `getByIds` case (`:889`: full items, the `stats`
   projection, an empty list).
4. The double's `getByIds` (`twilioWebhookHarness.ts:3409`) mirrors the
   `stats` PROJECTION (the plan said "returns the found items"): a Task 11 test
   against the double would otherwise pass on attributes the real read never
   returns. The parity case holds it to the real repo.
5. The double's `applyAttemptOutcome` (`twilioWebhookHarness.ts:3390`) stores
   `next` without its undefined fields, as the document client does
   (`removeUndefinedValues: true`, `app/src/lib/dynamo.ts:87`).
6. The budget comment (`broadcastsRepo.ts:57-75`, ASCII) reads the plan's
   "about 230 B each" as the slot WITHOUT the pointer: ~230 B + a ~75 B
   pointer = ~305 KB at 1000 slots when every recipient was retried (the
   research map's figures), and names `seed_contact_ids` (the same cap bounds
   it). The old comment's non-ASCII glyphs are gone with it.

## Task 2 - `5ea5005f`, fix `a9ed3ab3`

Files: created `app/src/services/shareRecipientState.ts`,
`app/test/shareRecipientState.test.ts`.

Runs:

- RED: `npx vitest run test/shareRecipientState.test.ts` - "Test Files 1
  failed (1) / Tests no tests", `Cannot find module
  '../src/services/shareRecipientState.js'`.
- GREEN: same command - "Tests 18 passed (18)".
- `npm run typecheck`: first run EXIT=2 - 12 x TS2345 in the TEST: the fake
  `attempts.get(owner: { contactKey?: string })` is a weak type with no
  property in common with the `relay_leg` owner. Typed the fake's parameter
  `SendAttemptOwner` (reading `contactKey` on the `broadcast` kind); re-run
  EXIT=0, vitest 18/18.
- Fix commit `a9ed3ab3`: RED `npx vitest run test/shareRecipientState.test.ts`
  - "Tests 1 failed | 18 passed (19)" (the new phone-redaction case); GREEN
  "Tests 19 passed (19)"; `npm run typecheck` EXIT=0.

Divergences:

1. The sketch's read-bounds test ("with recordReads ... past the 30-day life")
   used `deps()`, `item()` and `recordReadCount` declared inside a LATER
   `describe` - out of scope. The fakes are hoisted to module scope.
2. The fake `listByUnit` pages return the real `BroadcastsPage` shape
   (`{ items, lastEvaluatedKey? }`, `broadcastsRepo.ts:240-243`), not
   `nextCursor: null`; the service pages on `lastEvaluatedKey`.
3. `Logger` is imported from `../lib/logger.js` (every service's idiom, it
   re-exports pino's type), not from `'pino'`.
4. `classifyRecipient` and `needsRecordRead` take `Pick<BroadcastItem,
   'status' | 'created_at' | 'updated_at'>` (the task text: "everywhere it
   appears in this task"); `unconfirmedByRow` takes `Pick<BroadcastItem,
   'recipients'>`. Both accept everything the block's narrower types accept.
5. THE FIX: the sketch's record-read WARN logged `contactKey` raw; a slot key
   can be `phone#<E164>`, and log lines carry no phone. It now logs
   `recipientKey: safeRecipientKey(contactKey)` (`shareRecipientState.ts:194`;
   the send sites' helper, `app/src/lib/sendFingerprint.ts:54`, an
   import-free lib). Test `shareRecipientState.test.ts:182`.
6. Extra tests: a row-less newest attempt reads the RETRIED row and the map
   carries the pointer (`:161`); reads peak at exactly 8 in flight (`:191`);
   `priorRecipientKeys` walks pages on `lastEvaluatedKey` (`:221`); a queued
   slot of a `sending` share reads in flight even with a null record.

## Task 3 - `3c885850`

Files: modified `app/src/repos/listingSendsRepo.ts`,
`app/test/helpers/twilioWebhookHarness.ts`, `app/src/lib/tables.ts`,
`README.md`, `app/src/lib/seed/history.ts`,
`app/test/twilioWebhookHarnessRepoAdditions.integration.test.ts`,
`app/test/tables.test.ts`, `app/test/listingSendsApi.test.ts`,
`app/test/seedHistory.test.ts`; created `app/src/services/shareLedger.ts`,
`app/test/listingSendsRepoShares.integration.test.ts`,
`app/test/shareLedger.test.ts`.

Runs:

- RED: `npx vitest run test/listingSendsRepoShares.integration.test.ts
  test/shareLedger.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts
  test/tables.test.ts test/listingSendsApi.test.ts test/seedHistory.test.ts` -
  "Test Files 6 failed (6) / Tests 12 failed | 97 passed (109)", plus
  `shareLedger.test.ts` failing to load (`Cannot find module
  '../src/services/shareLedger.js'`). The 12: `putShareMemory is not a
  function` x6 (real 5, double 1), `getByKeys` x2, `getByKeyConsistent` x2
  (real 1, double 1), the sparse pin (`expected undefined to be true`), the
  seed guard (`expected [ { ... } ] to deeply equal []`).
- GREEN: `npx vitest run test/listingSendsRepoShares.integration.test.ts
  test/shareLedger.test.ts
  test/twilioWebhookHarnessRepoAdditions.integration.test.ts
  test/tables.test.ts test/listingSendsApi.test.ts test/seedHistory.test.ts
  test/genTables.test.ts test/listingSendsRepo.integration.test.ts` - "Test
  Files 8 passed (8) / Tests 143 passed (143)" (tables 24, shareLedger 12,
  genTables 16, listingSendsRepoShares 6, listingSendsRepo 6 - the deprecated
  `recordSend` cases still pass - listingSendsApi 16, parity 23, seedHistory
  40).
- `npm run typecheck`: EXIT=0. The optional `sentAt` surfaced no seam beyond
  `toListingSendRow` and the double's `listByContact` sort, both rewritten
  here; the seed history reads raw records.
- Neighbors (not required; run once to catch a double regression early):
  `npx vitest run test/broadcastFanOut.test.ts test/sendReconcile.test.ts
  test/contactsBatchReads.test.ts test/broadcastsRepo.integration.test.ts
  test/twilioStatusWebhook.test.ts test/contactTimeline.test.ts
  test/unitsApiActivity.test.ts` - "Test Files 7 passed (7) / Tests 462
  passed (462)".

Divergences:

1. `putShareMemory` (`listingSendsRepo.ts:230`) ALIASES every attribute
   (`#shares`, `#counted`, `#op`, ...) where the sketch used raw names - no
   reserved-word exposure - and appends the REMOVE clause only when something
   is removed (the sketch trimmed an empty one with a regex).
2. Both readers apply ONE rule, `isListed` (`listingSendsRepo.ts:176`):
   `counted !== false` AND `sentAt` present - the plan's "treat an absent one
   as not listed"; the sketch filtered `counted` only. `toListingSendRow`
   throws on an absent `sentAt` (`:194`) as the plan says; the readers make it
   unreachable, so one bad row can never 500 a page.
3. New export `listingSendKey(unitId, contactId)` (`listingSendsRepo.ts:167`)
   - the `getByKeys` key, shared by the repo and the double.
4. `putShareMemory` logs INFO `listing send memory written` (ids, `counted`,
   `shareCount`), after `recordSend`'s INFO precedent.
5. `shareLedger.test.ts`: the sketch's test titles used SQL-style `''`
   escapes (a JS syntax error) - rewritten with double quotes. Added: a
   same-attempt counted-by-acceptance case (-> pending written; -> unconfirmed
   and -> acceptance refused), `ledgerEntryFor` shapes, and
   `ledgerEntryForSlot` (every status, the live-promise switch, the row-less
   marker, a slot with no attempt).
6. `listingSendsRepoShares.integration.test.ts` adds: a fresh token per write,
   the seeded row's `created_at` preserved, `getByKeys` chunking/dedupe/empty.
7. `listingSendsApi.test.ts:163` also asserts a COUNTED row beside the
   un-counted one IS listed on both routes (so the test cannot pass by
   listing nothing).
8. `app/test/seedHistory.test.ts:609` (named in the task's run step, not in
   its `git add` list) gained the guard's pin and is committed: the guard
   needed a failing test. The guard (`history.ts:1004`) also drops the old
   `created_at` fallback for a row with no `sentAt`, as the plan says; no seed
   row lacks `sentAt` (cast.ts and matrix.ts rows all carry it).
9. Parity (`twilioWebhookHarnessRepoAdditions.integration.test.ts:998`,
   `:1205`): three ledger cases - the plan's first three - with the file's
   table list extended to `listing_sends`; rows compare with their clocks and
   the random token reduced to presence.
10. `summarize` (`shareLedger.ts:99`) counts a pair only through counted
    entries that carry `countedAt` (as the sketch): `counted` is true exactly
    when `sentAt` is set, which is what keeps the reader rule and the index
    rule the same.

## For the orchestrator's eye (not blocking)

1. `app/test/broadcastApi.test.ts:575` and `:1003` COMMENTS still say 1500;
   the assertions pin the constant and pass. Not touched (outside T1's list).
2. `putShareMemory` stamps `via` only if absent, so a legacy
   `via: 'individual'` row that a share later counts keeps `individual` while
   `broadcastId` names the share (`recordSend` used to overwrite `via`). Only
   seeds write `individual` rows (research map F), so production rows are all
   `broadcast`.
3. The ledger double's `listByUnit` keeps INSERTION order (the real one is
   contactId order) - pre-existing, unchanged; the parity cases hold one row
   per unit.
4. Task 13's `ledgerWouldChange` must live in `shareLedger.ts`: `seeded`,
   `mayReplace` and `summarize` are file-private (`shareLedger.ts:69`, `:79`,
   `:99`).
5. The Global Constraints list `contactKey` among loggable ids, but a slot key
   can be `phone#<E164>`. Later slices' log lines that carry a SLOT key should
   log `safeRecipientKey(contactKey)` as Task 2 now does (the ledger's
   `contactId` is always a contact id).
6. `getByIds` / `getByKeys` retry unprocessed keys once, immediately (no
   backoff), as the plan specifies.
7. `needsRecordRead` treats an unparseable share timestamp as past the bound
   (`expired`, stranded without a read) - the plan's rule; every share has an
   ISO `created_at`.
8. Informational: `npx eslint $(git diff --name-only --diff-filter=d
   a8a75e8e..HEAD -- '*.ts' '*.tsx' '*.js' '*.mjs' '*.cjs')` EXIT=0 over the
   17 touched TypeScript files (gate 5 stays the orchestrator's).

## The contract shipped (what Slices 2-4 consume)

`app/src/lib/shareAttemptOrder.ts` (import-free leaf):
`ROWLESS_ATTEMPT_SUFFIX = '~'`; `LEGACY_ATTEMPT_KEY = '!legacy'`;
`INDIVIDUAL_ATTEMPT_KEY = '!individual'`;
`rowlessAttemptKey(retriedTsMsgId: string): string`;
`isRowlessAttemptKey(key: string): boolean`;
`retriedOfRowless(key: string): string`;
`compareAttemptKeys(a: string, b: string): -1 | 0 | 1`;
`attemptKeyTimestampMs(key: string): number | undefined`.

`app/src/repos/broadcastsRepo.ts`:
`BroadcastRecipient.latestAttempt?: string` (`:188`);
`BroadcastStats.retry_pending?: number` (`:147`);
`MAX_BROADCAST_RECIPIENTS = 1000` (`:75`);
`interface AttemptOutcomeExpect { status: BroadcastRecipient['status']; latestAttempt: string | undefined }` (`:579`);
`deriveBroadcastStats(b: Pick<BroadcastItem, 'recipients' | 'stats'>, opts?: { retryPending?: number; unconfirmedKeys?: ReadonlySet<string> }): BroadcastStats` (`:305`);
`BroadcastsRepo.applyAttemptOutcome(broadcastId: string, contactKey: string, expect: AttemptOutcomeExpect, next: BroadcastRecipient, statsDelta: Partial<BroadcastStats>): Promise<{ applied: boolean; item?: BroadcastItem }>` (`:519`, impl `:1006`);
`BroadcastsRepo.getByIds(broadcastIds: string[], opts?: { projection?: 'stats' }): Promise<Map<string, BroadcastItem>>` (`:533`, impl `:1046`).

`app/src/services/shareRecipientState.ts`:
`type RecipientState = 'reached' | 'pending' | 'unconfirmed' | 'in_flight' | 'stranded' | 'failed' | 'skipped'`;
`RETRY_ROW_READ_BOUND_MS` (24 min); `RECORD_READ_BOUND_MS` (30 d);
`interface RecipientFacts { row?: { retryDueAt?: string; retryOutcome?: string } | 'unreadable'; record?: SendAttemptRecord | null | 'unreadable' | 'expired' }`;
`interface ClassifiedRecipient { state: RecipientState; retryDueAt?: string; retryOutcome?: string; latestAttempt?: string }`;
`classifyRecipient(share: Pick<BroadcastItem, 'status' | 'created_at' | 'updated_at'>, slot: BroadcastRecipient, facts: RecipientFacts, nowMs: number): RecipientState`;
`mayHaveReached(state): boolean`; `hasReached(state): boolean`;
`needsRowRead(slot, nowMs): boolean`;
`needsRecordRead(share: Pick<BroadcastItem, 'status' | 'created_at' | 'updated_at'>, slot, nowMs): boolean`;
`interface RecipientStateDeps { messages: Pick<MessagesRepo, 'getByTsMsgIdConsistent'>; attempts: Pick<SendAttemptsRepo, 'get'>; now?: () => number; log: Logger }`;
`resolveRecipientStates(deps: RecipientStateDeps, share: BroadcastItem, opts?: { recordReads?: boolean }): Promise<Map<string, ClassifiedRecipient>>` (keyed by contactKey; record reads only with `recordReads: true`; 8 reads in flight);
`retryPendingCount(states): number`;
`unconfirmedByRow(states, share: Pick<BroadcastItem, 'recipients'>): Set<string>`;
`reachedCount(share: Pick<BroadcastItem, 'recipients' | 'stats'>): number`;
`priorRecipientKeys(deps: RecipientStateDeps & { broadcasts: Pick<BroadcastsRepo, 'listByUnit'> }, unitId: string): Promise<Set<string>>` (never throws).

`app/src/repos/listingSendsRepo.ts`:
`type ShareLedgerState = 'counted' | 'pending' | 'unconfirmed' | 'failed'`;
`interface ShareLedgerEntry { attempt: string; conversationId?: string; state: ShareLedgerState; by?: 'acceptance' | 'delivery'; countedAt?: string }`;
`interface ShareMemoryWrite { shares: Record<string, ShareLedgerEntry>; counted: boolean; sentAt: string | undefined; broadcastId: string | undefined }`;
`ListingSendItem`: `sentAt?: string` (now optional), `counted?: boolean`, `shares?: Record<string, ShareLedgerEntry>`, `shares_op?: string`;
`ListingSendsRepo.getByKeyConsistent(unitId: string, contactId: string): Promise<ListingSendItem | undefined>`;
`ListingSendsRepo.putShareMemory(unitId: string, contactId: string, next: ShareMemoryWrite, expect: { token: string | undefined }): Promise<boolean>`;
`ListingSendsRepo.getByKeys(pairs: Array<{ unitId: string; contactId: string }>): Promise<Map<string, ListingSendItem>>` (key `${unitId}|${contactId}`);
`listingSendKey(unitId: string, contactId: string): string`;
`listByUnit` / `listByContact` drop a row with `counted === false` or no `sentAt`;
`recordSend` KEPT, `@deprecated share-sent-outcome T7 retires it`.

`app/src/services/shareLedger.ts`:
`type ShareLedgerOutcome = { kind: 'accepted' } | { kind: 'delivered' } | { kind: 'pending' } | { kind: 'failed' } | { kind: 'unconfirmed' }`;
`interface ShareLedgerDeps { listingSends: Pick<ListingSendsRepo, 'getByKeyConsistent' | 'putShareMemory'>; log: Logger }`;
`ledgerEntryFor(attempt: string, conversationId: string | undefined, outcome: ShareLedgerOutcome): ShareLedgerEntry`;
`ledgerEntryForSlot(slot: BroadcastRecipient, conversationId: string, promiseLive: boolean): ShareLedgerEntry | undefined`;
`applyShareLedgerEntry(deps: ShareLedgerDeps, args: { unitId: string; contactId: string; broadcastId: string; entry: ShareLedgerEntry }): Promise<'written' | 'refused' | 'lost'>` (1 + 3 re-read writes, then ONE ERROR).

Harness doubles (`app/test/helpers/twilioWebhookHarness.ts`): broadcasts
`applyAttemptOutcome` `:3390`, `getByIds` `:3409`; ledger
`getByKeyConsistent` `:3129`, `putShareMemory` `:3140`, `getByKeys` `:3161`,
filtered `listByUnit` / `listByContact` `:3172` / `:3177`. The
prior-recipients mirror and `priorRecipientContactIds` are untouched (Task 8
deletes them).

Where the shipped names differ from the plan's shared-interfaces block:
`recordSend` is KEPT and deprecated (the mission's instruction; the block says
removed - Task 7 removes it); `listingSendKey` is an extra export; the
`classifyRecipient` share parameter adds `updated_at` (the task text's form);
`unconfirmedByRow` takes `Pick<BroadcastItem, 'recipients'>` rather than
`BroadcastItem`. Everything else matches the block by name and shape.
