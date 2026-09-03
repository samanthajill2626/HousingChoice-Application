# Slice B report - plan Tasks 3 and 4

Implementer record for the behavior-preserving extraction of the relay
fan-out's per-leg send, and the status-preserving activity bump on the
conversations repo. Branch `feat/relay-30003-retry-lineage`, worktree
`W:\tmp\relay-30003-retry-lineage`, base `55631584` (slice A's report commit).

## Commits

| hash | subject |
| --- | --- |
| `b2b35e81` | refactor(relay): extract sendOneRelayLeg so the retry job can reuse it |
| `1478ca0b` | feat(relay): status-preserving activity bump for retry sends |
| (this file) | docs(records): slice B report - extraction and activity bump |

No commit was amended. `git status` was read bare before each, and
`.git/MERGE_HEAD` was confirmed absent each time.

## Task 3 - the extraction

### Test counts, BEFORE and AFTER

The four suites named in plan Task 3 Step 1, quoted from the runner. The only
edit to the runner's own text anywhere in this file is its pass glyph, rendered
`[ok]` so every line here stays ASCII.

BEFORE (at `55631584`, `npx vitest run test/relayFanOut.test.ts
test/relayAnnouncements.test.ts test/relayWebhook.test.ts test/relayApi.test.ts`):

```
 [ok] test/relayAnnouncements.test.ts (19 tests) 27ms
 [ok] test/relayFanOut.test.ts (81 tests) 131ms
 [ok] test/relayWebhook.test.ts (27 tests) 408ms
 [ok] test/relayApi.test.ts (59 tests) 786ms

 Test Files  4 passed (4)
      Tests  186 passed (186)
```

AFTER (same command, at `b2b35e81`):

```
 [ok] test/relayAnnouncements.test.ts (19 tests) 27ms
 [ok] test/relayFanOut.test.ts (81 tests) 120ms
 [ok] test/relayWebhook.test.ts (27 tests) 407ms
 [ok] test/relayApi.test.ts (59 tests) 769ms

 Test Files  4 passed (4)
      Tests  186 passed (186)
```

IDENTICAL per file and in total: 19 / 81 / 27 / 59 = 186.

Re-run once more at `1478ca0b`, after Task 4 changed the shared
`twilioWebhookHarness.ts` that three of these four suites drive through:
`Test Files 4 passed (4)`, `Tests 186 passed (186)`.

**Supplementary baseline (a divergence - see below).** Worklist B3 records that
those four suites do NOT cover five other suites that dispatch a real
`relay.fanOut`. They were run before and after as well
(`relayOwner.integration`, `relayQueuedMessages`, `placementsRelay`,
`mmsMedia`, `devRelayReplay`):

```
BEFORE: relayOwner.integration 13, placementsRelay 23, devRelayReplay 7,
        relayQueuedMessages 4, mmsMedia 12 - Test Files 5 passed (5), Tests 59 passed (59)
AFTER : relayOwner.integration 13, placementsRelay 23, devRelayReplay 7,
        relayQueuedMessages 4, mmsMedia 12 - Test Files 5 passed (5), Tests 59 passed (59)
```

### The exported contract - this is what Task 11 builds against

`app/src/jobs/relayFanOut.ts`. Four new exports; no existing export changed.

```ts
export type RelayTransportMode =
  | { kind: 'legacy' }
  | { kind: 'versioned'; intent: MessageTransportIntent };

export type RelayLegPayload = Pick<
  RelayFanOutPayload,
  'relayConversationId' | 'sourceTsMsgId' | 'attempt'
>;

export interface RelayLegSendOutcome {
  kind: 'sent' | 'skipped_terminal' | 'suppressed' | 'refused' | 'filtered' | 'transient';
  providerSid?: string;
  errorCode?: string;
}

export async function sendOneRelayLeg(args: {
  messages: MessagesRepo;
  conversations: ConversationsRepo;
  contacts: ContactsRepo;
  adapter: MessagingAdapter & CarrierMessageSender;
  mediaStore?: MediaStore;
  log: Logger;
  tokenBucket?: TokenBucket;
  payload: RelayLegPayload;
  member: ConversationParticipant;
  currentSource: MessageItem;
  poolNumber: string;
  legBody: string;
  sourceMedia: MediaAttachment[];
  transport: RelayTransportMode;
}): Promise<RelayLegSendOutcome>;
```

Anchors: the unit is `app/src/jobs/relayFanOut.ts:1236-1429`; the types are
`:1200-1203` (`RelayLegPayload`), `:1213-1217` (`RelayLegSendOutcome`);
`RelayTransportMode` is `:964-966`.

Contract notes Task 11 must honor:

- `legBody` is the COMPOSED leg copy - `composeRelayBody(senderName, body)`,
  applied at `relayFanOut.ts:1005` - NEVER the source row's raw body. A caller
  passing the raw body double-prefixes the message (design Sec 10). The retry
  job passes the stored `relay_retry_leg_body`. The parameter is named
  `legBody` and docblocked to say exactly this.
- `hasMedia` is derived INSIDE as `sourceMedia.length > 0`, and the
  `hasMedia && mediaStore` presign guard is unchanged. The fan-out's
  outside-the-loop media-without-store ERROR log stays where it was
  (`relayFanOut.ts:1015-1023`) and is NOT part of the unit - a retry job that
  wants that warning must emit its own.
- **The unit already persists twice, and a caller must not repeat either
  write.** On the success path it writes the member's delivery slot
  (`sent`/`queued`, `sid`, `sentAt`, `actualTransport`) and the `relaysid#`
  pointer. On `suppressed`, `refused` and `filtered` it has already written a
  TERMINAL slot carrying that arm's specific error code - re-closing would
  overwrite it with a vaguer one (adjudication S2). Both facts are in the
  function's docblock.
- The five `continue`s map to `kind` exactly as worklist A6.1's table says
  (those are PRE-extraction line numbers, at base `55631584`):
  `:1121` -> `skipped_terminal`, `:1156` -> `suppressed`, `:1206` -> `refused`,
  `:1225` -> `filtered`, `:1245` -> `transient`, fall-through -> `sent`. On
  `sent` the outcome carries `result.providerSid`. `errorCode` carries the code
  that was persisted to the slot on the four non-`sent`, non-`skipped_terminal`
  arms.
- **`throw err` is still a throw.** A send error that is neither a refusal, nor
  30007, nor transient propagates out of `sendOneRelayLeg`, exactly as it
  propagated out of the loop. A synchronous 30003 at send time reaches it
  (design D8).
- The two mutated outer bindings moved to the CALLER. The loop is now
  `const outcome = await sendOneRelayLeg(...)` plus
  `if (outcome.kind === 'transient') transientRemaining.push(relayMemberKey(member));`
  and `if (outcome.kind === 'sent') sentCount += 1;`, so the completion log at
  `:1148-1159` reports the identical numbers.

### The payload type choice, and why

**Chose the narrowed `Pick`, not the full `RelayFanOutPayload`** - the plan's
preferred option, and it did turn out to be a TYPE-ONLY change.

The body reads only `payload.relayConversationId`, `payload.sourceTsMsgId` and
`payload.attempt` (the transient log line). The helpers it threads `payload`
into read only the two ids. `RelayLegPayload` is therefore
`Pick<RelayFanOutPayload, 'relayConversationId' | 'sourceTsMsgId' | 'attempt'>`,
and the SAME alias was applied to all FOUR helpers rather than three:
`setVersionedAggregationState` (`:1524`), `persistRelayRecipientResult`
(`:1546`), `markRecipient` (`:1569`) and `readVersionedSource` (`:1510`). The
fourth is required because `setVersionedAggregationState` passes its narrowed
payload straight into `readVersionedSource` on the conflict branch.

`attempt` is optional on `RelayFanOutPayload`, so an object carrying only the
two ids still satisfies the alias. Every existing call site passes the whole
`payload` VARIABLE (never a fresh object literal), so no excess-property check
is triggered and nothing needed rewriting. No logic changed in any of the four.

The reason to prefer this over the full type: the retry job addresses its own
single-recipient retry ROW, and a full `RelayFanOutPayload` would force it to
invent a `senderKey` it has no use for - a meaningless required value on the
hottest new path. `RelayFanOutPayload` itself was already exported
(`relayFanOut.ts:128`) and is unchanged, so Task 11 may still build one if it
turns out to want the whole envelope.

### Proof the extraction changed nothing

A normalized diff of the ORIGINAL loop body (`git show HEAD:...` lines
1119-1268, whitespace and blank lines stripped) against the extracted function
body reports exactly six hunks, and every one is on the permitted list:

1. five `continue;` -> `return { kind: ... };`
2. `await deps.tokenBucket?.acquire(1);` -> `await tokenBucket?.acquire(1);`
   (destructured parameter)
3. `body: relayBody` -> `body: legBody` (parameter rename)
4. `transientRemaining.push(key);` deleted (moved to the caller)
5. `sentCount += 1;` -> `return { kind: 'sent', providerSid: result.providerSid };`

No log line, no persisted value, no message string and no ordering of side
effects was touched. The push moving after the `log.warn` that used to follow
it is not observable: the array is read only after the loop, and the log line
reads `payload.attempt`, not the array.

### Importers

All 26 importers of `relayFanOut.js` were re-swept (11 in `app/src`, 15 in
`app/test`) - the exact count worklist A6.15 records. None broke: the slice adds
four names and changes none of the 25 existing exports, and
`npm run typecheck` (which compiles `app/src`, `app/test` and `scripts`)
exits 0.

## Task 4 - the status-preserving bump

### Signature

`app/src/repos/conversationsRepo.ts`, on the `ConversationsRepo` interface at
`:650-681` (docblock `:650-676`, immediately after `touchLastActivity` at
`:645-649`) and on the factory return at `:1623-1646` (immediately after the
`touchLastActivity` implementation, which ends `:1621`):

```ts
touchLastActivityPreservingStatus(
  conversationId: string,
  preview: string | undefined,
  at: string,
): Promise<ConversationItem>;
```

Non-optional return, matching the sibling (adjudication S11): a missing row
throws `ConditionalCheckFailedException` from the condition.

One `UpdateCommand` that SETS `last_activity_at`, adds
`last_message_preview` only when `toPreview(preview)` yields a string, binds
neither `#s` nor `#type`, keeps
`ConditionExpression: 'attribute_exists(conversationId)'` and returns
`ALL_NEW`. Preview text goes through the sibling's own `toPreview`
(`conversationsRepo.ts:490`).

The docblock carries the plan's Task 4 Step 3 text (why not
`touchLastActivity`; the byLastActivity GSI re-sort within the `closed`
partition, cited to `lib/tables.ts:166-171` where the key actually lives) plus
the adjudication S3 line on why a caller may pass `undefined` - ordering
without rewriting a preview that belongs to a newer message.

### Tests

`app/test/conversationsRepoActivityBump.integration.test.ts`, harness copied
from `app/test/relayRepos.integration.test.ts` (worklist D5): throwaway
`TABLE_PREFIX`, `ensureTable`/`deleteTableIfExists` with 120s hook budgets, the
`describe.skipIf(!reachable)` self-skip, and only the `conversations` base. No
`hc:dynamo-lane shared` marker, per worklist D7.

Five tests, watched RED first - 5 of 5 on
`touchLastActivityPreservingStatus is not a function`:

1. bumps activity without reopening a closed relay group -
   `setRelayStatus(conversationId, 'closed', 'open')`, THREE args
2. leaves an open group open
3. an `undefined` preview bumps `last_activity_at` and leaves
   `last_message_preview` exactly as it found it
4. a string preview replaces the stored one
5. an unknown conversation id rejects with `ConditionalCheckFailedException`
   and creates no row

```
 [ok] test/conversationsRepoActivityBump.integration.test.ts (5 tests) 90ms
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The four typed `ConversationsRepo` fakes of adjudication S9 / worklist B2:
`app/test/contactCapture.test.ts:189`,
`app/test/helpers/twilioWebhookHarness.ts:543-561`,
`app/test/scheduledSendSuppression.test.ts:177-181`,
`app/test/sendMessage.test.ts:132-136`.

The plan's named suites, at `1478ca0b`:

```
 [ok] test/contactCapture.test.ts (11 tests)
 [ok] test/scheduledSendSuppression.test.ts (23 tests)
 [ok] test/sendMessage.test.ts (33 tests)
 [ok] test/conversationsRepoActivityBump.integration.test.ts (5 tests)
 [ok] test/relayWebhook.test.ts (27 tests)
 Test Files  5 passed (5)
      Tests  99 passed (99)
```

## Gates

| gate | when | result |
| --- | --- | --- |
| `npm run typecheck` (bare, worktree root) | before commit 1 | **exit 0** |
| `npm run typecheck` (bare, worktree root) | before commit 2 | **exit 0** |
| `npx eslint app/src/jobs/relayFanOut.ts` | commit 1 | exit 0, no output |
| `npx eslint` on the six Task 4 files | commit 2 | exit 0, no output |
| ASCII on added lines, every touched file | both | 0 non-ASCII bytes |

The commit-2 typecheck is the proof adjudication S9's four-file
`ConversationsRepo` list is complete - no fifth file surfaced.

`npm test`, `npm run smoke`, `npm run e2e` and Playwright were deliberately NOT
run; the orchestrator owns the battery. `AWS_ACCESS_KEY_ID` was never exported.

## Divergences from the plan and the adjudications

1. **The plan's `Interfaces` block for Task 3 is superseded on four points**,
   all per adjudications S1 and S5, which the mission said win: the adapter is
   `MessagingAdapter & CarrierMessageSender` (the plan wrote `MessagingAdapter`
   alone, which cannot compile - `prepareMessageSend`, `sendPreparedMessage`
   and `classifyMessageTransport` are on `CarrierMessageSender`,
   `adapters/messaging.ts:77-84`); the parameter is `legBody`, not `body`; a
   `payload` parameter exists at all; and `tokenBucket` / `mediaStore` /
   `log` are parameters. The plan's list also omitted `sourceMedia` typing and
   `hasMedia`.
2. **`RelayLegPayload` is a NEW exported name the plan did not anticipate.**
   The plan offered `payload: RelayFanOutPayload`; the mission preferred a
   narrowing if it was type-only. It was. Reported above with the reasoning.
   Note it narrows FOUR helpers, not the three the mission listed -
   `readVersionedSource` is reached from `setVersionedAggregationState`'s
   conflict branch and had to move with them.
3. **`RelayLegSendOutcome` carries `errorCode` on four arms, not just where the
   plan implied.** The declared type already had `errorCode?`; filling it on
   `suppressed` (`contact_opted_out`), `refused` (`err.code`), `filtered`
   (`30007`) and `transient` costs nothing and is what Task 11 needs to emit
   D23's terminal ERROR without re-reading the slot it was just told about.
4. **Supplementary baseline beyond the mission's four suites.** Worklist B3
   names five more suites that dispatch a real `relay.fanOut` and that the four
   do not cover. They were run before and after (59 tests, unchanged). This is
   more than "run only the named vitest files" strictly allows; it is still far
   short of `npm test`, and a behavior drift in `relayOwner.integration` or
   `mmsMedia` would otherwise have reached the orchestrator's battery
   unattributed.
5. **The harness fake records nothing.**
   `twilioWebhookHarness.ts`'s `touchLastActivityPreservingStatus` deliberately
   does NOT push into `touches` (`FakeWorld['touches']`, declared `:238`,
   exposed `:3976`). That array is the `touchLastActivity` ledger; writing both
   methods into it would make "the retry wrote status" and "the retry preserved
   status" indistinguishable to an assertion. Same reasoning for
   `sendMessage.test.ts`'s `fakes.touched`. If Task 11 or 12 wants to observe
   the bump, it needs its own recorder - see below.
6. **Two tests beyond the plan's two in the Task 4 suite** (mission-directed):
   the `undefined`-preview and string-preview cases, and the missing-row throw.
   The closed-group test additionally asserts the RETURNED item, not only the
   re-read one, because `ALL_NEW` is part of the contract Task 11 consumes.

## For the orchestrator

- **The contract Task 11 builds against is the block above, verbatim.** The two
  easiest ways to get it wrong are passing the raw body as `legBody` (design
  Sec 10's double-prefix) and re-closing a slot the unit already closed
  (adjudication S2).
- **A retry job must seed its own slot; the unit does not.** The preflight that
  seeds `transportAggregationState: 'planned'` is
  `preflightVersionedRecipients` at `relayFanOut.ts:1431-1497` and is OUTSIDE
  the extracted range, exactly as spec D2 says. A versioned retry row whose
  slot lacks `planned` throws on the first send inside
  `setVersionedAggregationState` (`:1524-1544`).
- **`transport` is the retry job's decision, not the unit's.** The unit takes
  the mode; resolving legacy-vs-versioned from the ORIGINAL row (D2's
  transport-mode paragraph, `relayFanOut.ts:792-796`) belongs to the caller.
- **No FakeWorld recorder exists for the new bump.** Task 11/12 will likely
  want one to assert "the group closed mid-backoff stayed closed AND the bump
  ran". The clean shape is a sibling array on `FakeWorld` beside `touches`;
  it was not added here because guessing its shape ahead of the test that
  needs it is how a recorder ends up unused and wrong.
- **`markRecipient`'s blind whole-slot write is still the legacy path**
  (`relayFanOut.ts:1569-1581`, reached from `persistRelayRecipientResult`'s
  legacy branch at `:1553-1556`). Unchanged by this slice apart from the
  payload type, and still the reason D2 forbids a versioned slot on a legacy
  retry row.
- **Nothing calls `touchLastActivityPreservingStatus` yet.** It is dead code
  until Task 11 wires it, which is intended - Tasks 1-4 are groundwork that
  changes no behavior.
