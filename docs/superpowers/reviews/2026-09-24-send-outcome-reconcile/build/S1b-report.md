# S1b report - Task 5 (Slice A, part 2)

Dispatch S1b of the SOR Stage 1 build. Implementer: Claude Opus 5.5 (1M context).
Worktree `W:\tmp\send-outcome-reconcile`, branch `feat/send-outcome-reconcile`,
started at 6d5e936e. Scope: plan rev 4 Task 5 ONLY (Task 6 is the next
dispatch and was not started). Inputs: AGENTS.md, plan (Global Constraints,
Shared interfaces, Task 5), worklist section 0 (G1-G10) and "S1b" (the T5
bullet), findings T5-1..T5-7 and INV-1, the foundations reference sections
1, 2, 4, 5, 6, 7, the S1a report's contract, and spec D8a / D11.

Method: strict TDD (each test file seen failing before its code existed),
three commits, then one-line mutant spot-checks on every decision-bearing
condition in BOTH the real repo and the harness fake. Each mutant was an
exact textual edit, run, edited back at the same offset, and proven
byte-identical to a scratch copy with `cmp` (no git checkout / restore).

## Commits

- `349bfef1 feat(lib): guardWrite - a failure-arm write never throws out of the recipient unit (D7a)`
- `826a74a2 feat(repos): the per-recipient send-attempt record and its recipient index, every transition fenced on the attempt (D8a, D11)`
- `a206a7ce feat(send): sendAttemptsRepo deps fields on the three send handlers; the harness fake held to the real repo; every test registration wired (D8a)`
- this report (last commit).

## What was built

- `app/src/lib/guardWrite.ts` + `app/test/guardWrite.test.ts` (4 tests).
- `app/src/repos/sendAttemptsRepo.ts`: the record family (`sendattempt#`) and
  the recipient-index family (`sendattemptix#`) in the messages table; the
  claim is ONE TransactWrite (record Update + index Put); every other
  transition is a conditional Update fenced as the plan specifies; every
  expression lists exactly its aliases and values (proven on DynamoDB Local).
- `app/test/sendAttemptsRepo.integration.test.ts` (32 tests): 2 pure key
  tests, 6 stub-client tests for the T5-4 cancellation attribution, 24 cases
  on DynamoDB Local (the plan's 11, strengthened, plus 13 more).
- `app/src/lib/tables.ts`: the TTL comment lists `sendattempt#` and
  `sendattemptix#` (30 d) beside `syssid#` as TTL-only reapers (T5-6).
- `sendAttemptsRepo?: SendAttemptsRepo` on `BroadcastSendJobDeps`
  (broadcastFanOut.ts), `RelayFanOutJobDeps` (relayFanOut.ts),
  `RelayRetryLegJobDeps` (relayRetryLeg.ts) and `RegisterJobHandlersDeps`
  (registerHandlers.ts, T5-1 anchor); `registerAllJobHandlers` passes
  `sendAttemptsRepo: deps.sendAttemptsRepo` to the three registrations.
  Accepted and ignored: nothing reads the field yet. Production callers
  (`index.ts`, `worker.ts`) are unchanged.
- Harness (`app/test/helpers/twilioWebhookHarness.ts`): `sendAttempts`,
  `sendAttemptIndex`, `sendAttemptsRepo` declared on `interface FakeWorld`
  (:311, :318, :326; T5-3) and returned from `createFakeWorld()`; the fake
  itself at :4179.
- `app/test/twilioWebhookHarnessSendAttempts.integration.test.ts` (12 tests,
  T5-2 name and idiom): 12 scripted sequences run step by step through the
  real repo and a fresh fake world; after EVERY step it requires identical
  results, identical `get()` for every owner, `world.sendAttempts` equal to
  the real `get()`, identical `listByRecipient` for both partitions at two
  `since` bounds, and identical raw index items.
- 23 registration sites in 16 test files wired (listed under the contract).

## Deviations from the plan / worklist, and why

1. T5-7's count is wrong in the worklist and REF 7.1 ("25 call sites in 15
   files"): the REF 7.1 table itself lists 23 sites in 16 files, and a fresh
   grep agrees. All 23 are wired (23 matching lines verified by grep); the
   two named exclusions are untouched. The field is the FIRST property of
   each object literal, so in `relayRetryLeg.test.ts`'s `register(overrides)`
   the `...overrides` spread still wins.
2. `claim()` never returns an undefined record on ANY path (T5-4 asked for
   the post-failure read; the post-success read-back now throws too, through
   one `mustGet`). `writeClaim` has no `ConditionalCheckFailedException` arm
   (T5-4: dead for TransactWriteItems) - only an index-0
   `ConditionalCheckFailed` cancellation is a lost claim.
3. `claimExpr` takes `prevAttemptNo: number` (0 when absent) instead of an
   optional `prev` record, so no `:prevNo` value can ever be `undefined` (the
   DocumentClient would drop it and DynamoDB would reject the expression).
   Module-private; no interface change.
4. The fake's index write REPLACES an entry with the same partition and sort
   key instead of always pushing: a same-instant re-claim of one owner
   overwrites its index item in DynamoDB (same key Put), and the parity test
   compares raw index items. Sort and `since` comparisons use UTF-8 byte
   order (DynamoDB's order for a string range key).
5. The parity test adds a `seed` step (writes a state no API call produces
   into both stores, the way a downstream test seeds `world.sendAttempts`)
   and a seeded-state case. Reason: mutant F35 (takeOver not resetting
   `checkNo`) survived the API-only scripts because every API-reachable
   `attempting` record already has `checkNo` 0; a downstream test that seeds
   could still see the difference. With the seed case F35, F36, R37 and R38
   are all killed.
6. `guardWrite.test.ts` passes `level: 'info'` (G2) and adds two cases (a
   closure that RESOLVES `false` still returns `true` - G5; the `label`
   argument wins over a context key named `label`) and an assertion that the
   error travels under the wired `err` key (G3).
7. The whole app suite ran once, after the wiring and before deviation 5's
   parity case was added. That case touched only the new parity file; after
   it, `npm run typecheck` and the three T5 files were re-run green.

No plan/worklist contradiction with the live code was found; no unexpected
importer or cycle appeared (the four source files import only the TYPE; the
repo imports config, dynamo, sendFingerprint, sendOutcome and a type from
conversationsRepo); no test outside the T5 files went red.

## Red -> green evidence

- guardWrite: RED `Error: Cannot find module '../src/lib/guardWrite.js'`
  (0 tests); GREEN 4 passed.
- repo: RED `Error: Cannot find module '../src/repos/sendAttemptsRepo.js'`;
  GREEN 32 passed, no `[dynamoAdmin]` line, nothing skipped.
- parity: RED 11 failed, every one
  `TypeError: Cannot read properties of undefined (reading 'get')`
  (`world.sendAttemptsRepo` / `world.sendAttempts` not there yet); GREEN 11
  passed on the first run of the fake, 12 after the seeded-state case.

## Mutants (all KILLED; every file restored byte-identical, `cmp` clean)

Real repo (`app/src/repos/sendAttemptsRepo.ts`), run against
`sendAttemptsRepo.integration.test.ts` - the killing test named is the first
failure reported:

| id | mutant | killed by |
|---|---|---|
| R01 | absent-claim condition always true | "creates and claims an absent record; a second claim inside the TTL is refused fresh" |
| R02 | claim dispatch `outcome === 'retryable'` flipped | "a record holding a SID refuses every later claim ..." |
| R03 | retryable claim condition `#no <> :prevNo` | "done/retryable and redriven are claimable ..." |
| R04 | retryable claim condition `#oc <> :retryable` | "done/retryable and redriven are claimable ..." |
| R05 | claim dispatch `redriven` -> `reconciling` | "done/retryable and redriven are claimable ..." |
| R06 | redriven claim condition `#no <> :prevNo` | "done/retryable and redriven are claimable ..." |
| R07 | TTL `>` -> `>=` | "the TTL boundary: exactly SEND_CLAIM_TTL_MS old is still fresh ..." |
| R08 | fresh attempting refused `fresh: false` | stub "the record's own condition failure is decided from a consistent re-read" |
| R09 | terminal refusal `fresh: true` | "a record holding a SID refuses every later claim ..." |
| R10-R12 | finishAttempt fence: `#at <>`, `#no <>`, `#st <>` | "finishAttempt is fenced on attemptNo AND attemptedAt, and only from attempting" |
| R13-R15 | handToReconcile fence: `#at <>`, `#no <>`, `#st <>` | "done/retryable and redriven are claimable ..." (9 cases fail) |
| R16-R17 | takeOver fence: `#at <>`, `#no <>` | "a stale attempting record ... is a takeover ..." |
| R18 | recordCheck `:prev = checkNo - 2` | "recordCheck tolerates its own duplicate ..." |
| R19 | recordCheck `(#ck = :prev OR #ck = :prev)` (no duplicate) | same |
| R20 | recordCheck `#ck >= :ck` (step back allowed) | same |
| R21 | recordCheck `#at <> :at` | same |
| R22 | markRedriven `#rc >= :zero` | "one re-drive per recipient ..." |
| R23-R24 | markRedriven fence: `#st <>`, `#at <>` | "done/retryable and redriven are claimable ..." |
| R25-R26 | closeFromReconcile fence: `#st <>`, `#at <>` | "one re-drive per recipient ..." |
| R27 | closeRedriven `#st <> :redriven` | "closeRedriven accepts refused, redrive_refused, enqueue_failed and unresolved, once" |
| R28 | T5-4: ANY TransactionCanceledException read as lost | stub "a TransactionConflict on the record is rethrown ..." |
| R29 | T5-4: `CancellationReasons[1]` instead of `[0]` | stub "a condition failure on the INDEX item (index 1) ... rethrown" (13 fail) |
| R30 | T5-4: undefined record not thrown | stub "a lost record condition whose re-read finds NO record throws ..." |
| R31 | T5-5: dedupe removed | "listByRecipient returns a re-claimed record ONCE ..." |
| R32 | `ScanIndexForward: true` | "listByRecipient reads the index partition consistently, newest first ..." |
| R33 | first page only (`startKey = undefined`) | "listByRecipient pages past the Query limit ..." |
| R34 | claim resets `redrive_count` (`#rc = :zero`) | "done/retryable and redriven are claimable ..." |
| R35 | sender-less stored as `'-'` not null | "a sender-less record indexes under the "-" partition ..." |
| R36 | recipient key not hashed in the sort key | "hashes a phone-bearing recipient key into the sort key ..." |
| R37 | takeOver keeps `check_no` (`if_not_exists`) | parity "from a SEEDED record: ..." |
| R38 | handToReconcile keeps `check_no` | parity "from a SEEDED record: ..." |

Harness fake (`app/test/helpers/twilioWebhookHarness.ts`), run against the
parity test:

| id | mutant | killed by |
|---|---|---|
| F01 | claim dispatch `outcome !== 'retryable'` | "fresh claim; refused fresh inside the TTL and AT it; ..." (8 fail) |
| F02 | claim dispatch `redriven` -> `reconciling` | same |
| F03 | TTL `>` -> `>=` | same |
| F04 | fresh attempting refused `fresh: false` | same |
| F05 | terminal refusal `fresh: true` | same (5 fail) |
| F06 | claim attemptNo `+ 2` | same (10 fail) |
| F07 | claim resets redriveCount | "the redriven claim and the one-re-drive rule" |
| F08 | sender held as `null` | "re-claims after retryable, with new facts and without a sender, then list (T5-5)" |
| F09-F11 | finishAttempt fence dropped: attemptedAt / attemptNo / state | "the finishAttempt and handToReconcile fences; ..." / "fresh claim ..." |
| F12-F14 | handToReconcile fence dropped: attemptedAt / attemptNo / state | "the finishAttempt and handToReconcile fences; ..." / "refused terminal ..." |
| F15-F17 | takeOver fence dropped: attemptNo / attemptedAt / state | "a stale takeover of a re-claimed attempt keeps ITS attemptedAt; ..." / "fresh claim ..." |
| F18 | recordCheck `checkNo - 2` | "fresh claim ..." |
| F19 | recordCheck duplicate not tolerated | same |
| F20 | recordCheck attemptedAt fence dropped | same |
| F21 | markRedriven `redriveCount > 1` | "the redriven claim and the one-re-drive rule" |
| F22 | markRedriven attemptedAt fence dropped | same |
| F23-F24 | closeFromReconcile fence dropped: attemptedAt / state | "a stale takeover ..." / "fresh claim ..." |
| F25 | closeRedriven state fence dropped | "refused terminal: a sent record refuses every later claim" |
| F26 | T5-5 dedupe removed | "re-claims after retryable, ..., then list (T5-5)" |
| F27 | list oldest first | "the finishAttempt and handToReconcile fences; ..." |
| F28 | list ignores `since` | "fresh claim ..." (10 fail) |
| F29-F31 | get / claim result / list rows alias the store (no copy) | "returned records are snapshots: scribbling on them changes nothing stored" |
| F32 | same-key index item pushed twice | "a same-instant re-claim rewrites its index item in place" |
| F33 | sender-less partition `none` | "re-claims after retryable, ..." |
| F34 | handToReconcile drops the SID | "the finishAttempt and handToReconcile fences; ..." |
| F35-F36 | takeOver / handToReconcile keep checkNo | parity "from a SEEDED record: ..." (survived before deviation 5) |

guardWrite: G1 catch returns `true` and G2 no ERROR line -> "returns false when
the write throws, ..."; G3 `{ err, label, ...ctx }` -> "the label always wins
over a context key of the same name".

## Gates (exit codes)

- T5 files: `npx vitest run test/guardWrite.test.ts test/sendAttemptsRepo.integration.test.ts test/twilioWebhookHarnessSendAttempts.integration.test.ts`
  -> exit 0, 3 files, 48 passed (final state; 47 before the seeded case).
- `npm run typecheck` (root) -> exit 0 (run after commit 2's files, after the
  wiring, and after the final parity edit).
- Whole app workspace, foreground, `timeout 900 npx vitest run` -> EXIT=0,
  `Test Files  380 passed (380)`, `Tests  7281 passed | 1 skipped (7282)`,
  `Duration  151.00s`. No `[dynamoAdmin]` line in the log (nor in any mutant
  run's log). The one skip is environmental (`staticSmoke.test.ts`
  `ctx.skip` when no dashboard build is present).
- Lint preview (gate 5 is the orchestrator's): `npx eslint` on all 27
  touched .ts files -> 2 errors, BOTH pre-existing by baseline comparison
  (HEAD content linted through `--stdin --stdin-filename`):
  `app/test/relayOwner.integration.test.ts:74` unused `poolNumbers`, and
  `app/test/rosterActionsPoll.test.ts:200` unused `addActionId` (:199 at
  HEAD; moved one line by the wiring insert). Nothing new.

## Contract for downstream

`app/src/repos/sendAttemptsRepo.ts` - exports, exactly as the plan's shared
block plus the three constants:

- `SEND_ATTEMPT_PARTITION_PREFIX = 'sendattempt#'`,
  `SEND_ATTEMPT_INDEX_PREFIX = 'sendattemptix#'`,
  `SEND_ATTEMPT_CLEANUP_MS = 30 * 24 * 60 * 60 * 1000`.
- Types `SendAttemptOwner`, `SendAttemptState`, `SendAttemptOutcome`,
  `SendAttemptFacts` (`sender?` absent when unset), `SendAttemptRecord`,
  `AttemptRef`, `ClaimResult`, `SendAttemptsRepo` - names and member
  signatures exactly as the plan's shared-interfaces block.
- `ownerKey(owner)`: `broadcast#<broadcastId>` | `relay#<relayConversationId>#<sourceTsMsgId>`
  | `rung#<relayConversationId>#<retryTsMsgId>` (no recipient).
- `attemptKey(owner)`: `${ownerKey(owner)}|${hashRecipientKey(recipientKey)}`
  (recipientKey = `contactKey` or `memberKey`) - the RECORD identity; never
  carries a phone.
- `createSendAttemptsRepo(deps?: RepoDeps): SendAttemptsRepo` (the
  `RepoDeps` of conversationsRepo; `doc` and `env` honored, `logger` unused).

Storage: record key `conversationId = 'sendattempt#' + ownerKey`, `tsMsgId =
hashRecipientKey(recipientKey)`; attributes `attempt_state`, `attempt_no`,
`attempted_at`, `redrive_count`, `check_no`, `sid?`, `outcome?`, `cause?`,
`recipient_digest`, `sender` (null when unset), `body_hash`, `body_short`,
`media_count`, `owner` (the RAW owner map - the key is hashed, the map keeps
the real recipient key so a reconcile can address the slot), `expires_at`
(epoch s, the LATEST claim's `nowIso` + 30 d; only claims set it). Index
item: `conversationId = 'sendattemptix#' + (sender ?? '-') + '#' +
recipientDigest`, `tsMsgId = attemptedAt + '#' + ownerKey + '#' +
hashedRecipientKey`, attributes `owner`, `attempted_at`, `body_hash`,
`body_short`, `media_count`, `expires_at`; written with each claim, never
updated.

`claim(owner, facts, nowIso)` per starting state (age =
`Date.parse(nowIso) - Date.parse(record.attemptedAt)`):

| record state | result | written |
|---|---|---|
| absent | `claimed`: attempting, attemptNo 1, attemptedAt = nowIso, redriveCount 0, checkNo 0, THIS attempt's facts | record + index item |
| done / retryable | `claimed`: attemptNo + 1, new attemptedAt, redriveCount UNCHANGED, checkNo 0, sid/outcome/cause removed, facts replaced (sender removed when unset) | record + index item (under THIS attempt's sender) |
| redriven | `claimed`: same as above (redriveCount stays 1) | record + index item |
| attempting, age <= 30 000 ms (exactly 30 000 is fresh) | `refused`, `fresh: true`, the live record | nothing |
| attempting, age > 30 000 ms | `takeover`, the stale record UNCHANGED - the caller runs `takeOver(owner, result.record)` and hands off; `takeOver` does not re-check the TTL | nothing |
| reconciling | `refused`, `fresh: false` | nothing |
| done / any other outcome | `refused`, `fresh: false` | nothing |
| lost race on the retryable / redriven conditional claim | `refused`, `fresh: true`, the re-read live record (whatever it now is) | nothing |

`claim` THROWS on any cancellation that is not an index-0
`ConditionalCheckFailed` (TransactionConflict, throttling, validation), on
any other DynamoDB error, and if a record it must read back is absent.

Transitions (each returns `true` = written, `false` = its condition failed,
including on an absent record; any other error throws):
- `finishAttempt(owner, ref, { outcome, sid?, cause? })`: attempting AND
  attemptNo = ref.attemptNo AND attemptedAt = ref.attemptedAt -> done +
  outcome (+ sid / cause when given; never removed).
- `handToReconcile(owner, ref, sid?)`: the same fence -> reconciling,
  checkNo 0 (+ sid).
- `takeOver(owner, record)`: attempting AND the record's attemptNo AND
  attemptedAt -> reconciling, checkNo 0, attemptedAt KEPT.
- `recordCheck(owner, attemptedAt, n)`: reconciling AND attemptedAt AND
  checkNo in {n - 1, n} -> checkNo n.
- `markRedriven(owner, attemptedAt)`: reconciling AND attemptedAt AND
  redriveCount 0 -> redriven, redriveCount 1 (so at most one re-drive per
  record, ever: a claim never resets it).
- `closeFromReconcile(owner, attemptedAt, { outcome, sid?, cause? })`:
  reconciling AND attemptedAt -> done + outcome (+ sid / cause).
- `closeRedriven(owner, { outcome, cause? })`: redriven (any attempt) -> done
  + outcome (+ cause).
- `get(owner)`: strongly consistent; `undefined` when absent.
- `listByRecipient(sender, recipientDigest, sinceIso)`: pass `'-'` for a
  sender-less partition. Consistent Query, sort key >= sinceIso (INCLUSIVE),
  newest first (ties at one instant: descending by `ownerKey`), 100 items a
  page, one `get` per index item, rows are the LIVE records, ONE row per
  `attemptKey` (the newest index item's position), absent records skipped.
  The caller's own record is included (Task 10 filters by `attemptKey`).

`app/src/lib/guardWrite.ts`:
`guardWrite(log: { error: (obj: Record<string, unknown>, msg: string) => void }, ctx: Record<string, unknown>, label: string, fn: () => Promise<unknown>): Promise<boolean>`
- `true` = `fn` RESOLVED (whatever it resolved to, `false` included - G5);
  `false` = it threw: one ERROR line `{ err, ...ctx, label }`, msg
  `failure-arm write failed (best-effort); the attempt record decides`.
  Never throws. `label` wins over a ctx key `label`; do not put `err` in
  `ctx` (it would replace the error). A pino `Logger` satisfies `log`.

Harness (`createFakeWorld()`):
- `world.sendAttempts: Map<string, SendAttemptRecord>`, keyed by
  `attemptKey(owner)`; the stored value is exactly what `get()` returns (no
  `expires_at`); the fake reads it LIVE on every call.
- `world.sendAttemptIndex: Array<{ partition; sortKey; owner }>` - one entry
  per claim (same key -> replaced), formats as the real index item.
- `world.sendAttemptsRepo: SendAttemptsRepo` - parity-tested; records go in
  and come out as copies.
- To SEED a state: preferably through the repo - claim at a chosen `nowIso`
  (a stale attempting record = `claim(owner, facts, new Date(Date.now() - 31_000).toISOString())`),
  then `handToReconcile` / `takeOver` / `markRedriven` / `finishAttempt`. Or
  set `world.sendAttempts.set(attemptKey(owner), record)` directly (any
  state; the parity test's seed step proves the fake answers like DynamoDB
  from a seeded record) - a direct set adds NO index entry, so
  `listByRecipient` will not see it unless an entry is pushed too.
- To INSPECT: `await world.sendAttemptsRepo.get(owner)` or
  `world.sendAttempts.get(attemptKey(owner))`.
- To make ONE call fail: `vi.spyOn(world.sendAttemptsRepo, 'handToReconcile').mockRejectedValueOnce(new Error('dynamo blip'))`
  (the object is a plain literal; the code under test must call through the
  object, not a destructured method). The fake's methods never call each
  other through the object, so a spy on `get` does not affect `claim` - the
  same as the real repo.
- There is no fake clock: staleness is decided from the `nowIso` argument.

Registration sites wired (post-edit line of the inserted
`sendAttemptsRepo: world.sendAttemptsRepo,`): broadcastApi.test.ts:94,
broadcastFanOut.test.ts:138, devRelayReplay.test.ts:243,
inboundMessagePush.test.ts:167, mmsMedia.test.ts:174, placementsApi.test.ts:785,
placementsRelay.test.ts:182, relayApi.test.ts:226, relayFanOut.test.ts:199,
:1577, :2158, :2341, relayOwner.integration.test.ts:355,
relayQueuedMessages.test.ts:136, :233, relayRetryClaim.webhook.test.ts:117,
relayRetryLeg.test.ts:251 (inside `register()`, before `...overrides`),
relayWebhook.test.ts:92, :351, :685, rosterActionsPoll.test.ts:112,
toursApi.test.ts:2560, :4121. Not wired (by instruction):
registerHandlers.test.ts:17, relayRetryLeg.test.ts:1396.

## Concerns for the orchestrator

1. A re-claim with a DIFFERENT sender leaves the first attempt's index item
   in the old sender partition, still resolving to the live record (now
   carrying the new sender, or none). `listByRecipient(oldSender, ...)`
   therefore returns a record whose `sender` differs from the partition
   queried (pinned by the "re-claim writes THIS attempt's facts" case). Task
   10's sibling scan should not assume `row.sender === sender`.
2. The `owner` map on BOTH families holds the raw recipient key
   (`phone#<E164>` for a contact-less recipient). Spec D8a hashes the KEY
   only and the reconcile needs the raw key to address the slot, so this is
   by design; recorded because the index item is a second at-rest copy.
3. The worklist's T5-7 count (25 / 15) is wrong; 23 / 16 is the real set
   (deviation 1). Anyone re-deriving the list should grep, not trust the
   count.
4. `claim` does N reads after a lost create (one `get`, plus one more after a
   lost retryable/redriven claim) and `listByRecipient` does one `get` per
   index item - as planned; noted for the sweeper / cost review.
5. No background process is left running. Mutant scripts, logs and pristine
   copies live only in the session scratchpad (`...\scratchpad\S1b\`).
   Nothing was written to `.superpowers/` (no byte-exact material was needed
   beyond the file:line anchors above).
