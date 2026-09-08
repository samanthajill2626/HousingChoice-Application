# Server research findings - relay 30003 retry lineage

Read-only verification of the spec (revision 6) and the plan (revision 5)
against the LIVE tree at `600dcac5`, worktree
`W:\tmp\relay-30003-retry-lineage`. Byte-exact anchors for everything below are
in `.superpowers/sdd/worklist-server.md` (gitignored reference).

Twelve findings: 1 BLOCKING, 4 MUST-HANDLE, 7 NOTE.

---

## 1. BLOCKING - `sendOneRelayLeg`'s published adapter type cannot compile

**Plan** (Task 3, Interfaces) declares `adapter: MessagingAdapter` on
`sendOneRelayLeg`, and Task 11 step 3 has the retry job call
`adapter.classifyMessageTransport({ hasForwardableMedia })`.

**Tree.** The extracted body calls `adapter.prepareMessageSend`
(`app/src/jobs/relayFanOut.ts:1176`), `adapter.sendPreparedMessage` (`:1187`)
and `adapter.sendMessage` (`:1188`). Only the LAST of those is on
`MessagingAdapter` (`app/src/adapters/messaging.ts:150-198`, `sendMessage` at
`:151`). `classifyMessageTransport`, `prepareMessageSend` and
`sendPreparedMessage` are declared on a SEPARATE interface,
`CarrierMessageSender` (`app/src/adapters/messaging.ts:77-84`). The fan-out's
own dep type already spells the intersection:
`adapter: MessagingAdapter & CarrierMessageSender`
(`app/src/jobs/relayFanOut.ts:946`).

**Effect.** `npm run typecheck` (gate 1) fails on the extraction itself.

**Fix.** `adapter: MessagingAdapter & CarrierMessageSender` in
`sendOneRelayLeg`'s args and in `RelayRetryLegJobDeps`.

---

## 2. MUST-HANDLE - Task 11 step 6 re-closes a slot the extraction already closed, with a LESS specific code

**Plan** (Task 11 step 6): "`refused` / `filtered` / `suppressed` - close with
the matching code, log ERROR, stop." Task 3's own caveat says only that "the
extracted unit already writes the slot AND the `relaysid#` pointer
(`:1250-1267`)" - i.e. it names the SUCCESS path's writes.

**Tree.** All three non-success arms inside the extracted range write a
TERMINAL slot before their `continue`:
- suppressed: `relayFanOut.ts:1127-1130` -> `{ status:'failed', errorCode:'contact_opted_out' }`
- `SendRefusedError`: `:1191-1197` -> `{ status:'failed', errorCode: err.code }`
- 30007: `:1210-1216` -> `{ status:'failed', errorCode:'30007' }`

A second close by the job overwrites those. On the LEGACY path
`setRecipientDelivery` is an unguarded whole-slot SET
(`app/src/repos/messagesRepo.ts:3420-3441`, condition is only
`attribute_exists(tsMsgId)`). On the VERSIONED path `applyRecipientSendResult`
treats `failed -> failed` as `statusSame`, so `errorEligible` is true
(`messagesRepo.ts:3244-3257`) and the errorCode is rewritten too.

Two further gaps in the same instruction: D15 enumerates FOUR close codes and
they are all D9 GATE refusals - there is no code for `filtered` (a carrier
30007) or for a `SendRefusedError`; and `suppressed` is unreachable from the job
anyway, because D9's gate calls `isMemberSuppressed`
(`app/src/services/relayAnnouncements.ts:64-100`) and returns before
`sendOneRelayLeg` runs.

**Effect.** An operator loses the real reason - `Phone unreachable` /
`30007` / the refusal code - replaced by an app-invented token, which is
exactly the `INTERNAL_CODE_REASONS` defect D15 exists to prevent.

**Fix.** On `refused` / `filtered` / `suppressed` the retry job writes NOTHING
to the slot: it emits the D23 terminal ERROR and returns. Only the three
outcomes the extraction does NOT close - a D9 gate refusal (which happens
before the call), an enqueue failure, and the transient cap - are written by
the job.

---

## 3. MUST-HANDLE - D16's post-send bump rewrites the relay inbox preview BACKWARDS

**Plan** (Task 11 step 6, and its test at Task 11 step 3): the successful send
calls `touchLastActivityPreservingStatus(conversationId, row.body, now)` and
asserts `expect(bumpSpy.mock.calls[0][1]).toBe('the original text')`.
**Spec** D16 decides only the ORDERING half ("Last activity / inbox ordering:
fires after a SUCCESSFUL send") and the status half. Neither names the PREVIEW.

**Tree.** The relay inbox row reads the denormalized preview and nothing else:
`app/src/routes/inbox.ts:1164-1165` in `relayRowFor` -
`const preview = typeof conv.last_message_preview === 'string' ? conv.last_message_preview : '';`.
It never reads the message log (`latestMessageOf`, `inbox.ts:846-858`, is
called only from `buildContactRow` `:924`/`:957` and the unknown-row builders
`:1056`/`:1446`).

The retry lands 60-240s after the failure callback, and up to about seven
minutes after it on rung 3. Any message that arrived in the relay thread during
that window - a member's reply, a team send, an announcement - is already the
thread's newest row and already owns the preview. The bump then overwrites it
with the RETRIED message's older body while re-sorting the thread to the top of
the inbox. The operator sees a thread jump to the top showing text that is no
longer the last thing said in it.

**Fix, and it is one line.** `touchLastActivity`'s `previewText` is
`string | undefined`, and BOTH branches omit the preview SET when it is
undefined (`app/src/repos/conversationsRepo.ts:1540-1542` and `:1576-1578`,
via `toPreview` at `:1532`). Passing `undefined` bumps `last_activity_at`
without touching `last_message_preview` - which is the whole of what the
founder's ordering ruling asked for. If the raw body is kept deliberately,
D16 should say so and Sec 9 should record the stale-preview window; the current
plan makes it look like an unconsidered side effect of "preview the RAW body,
not the composed leg copy" (a rule that was about D12's two-strings problem,
not about which message owns the preview).

---

## 4. MUST-HANDLE - the claim's SSE is not delivered by the existing emit in two of the cases the plan tests

**Plan** (Task 12 step 9): "Emit `message.persisted` for the ROOT (D16)", with
Step 3 instructing "no `return` inside the claim logic - let control fall
through to the existing tail". **Spec** D16 cites `twilio.ts:2512` as the
existing emit.

**Tree.** `app/src/routes/webhooks/twilio.ts:2512-2521` is gated
`if (transitioned || transportUpdated)` and emits
`{ conversationId: ptr.conversationId, tsMsgId: ptr.tsMsgId, direction: 'inbound', deliveryStatus: mapped }`.
Two of the plan's own Task 12 tests fall outside what that delivers:

- **The crash-recovery case** (plan test "RECOVERS a claim lost to a crash
  between the slot write and the claim"; spec Sec 7 intention 16). The slot is
  already terminal, so `updateRecipientDeliveryStatus` returns `false` at
  `app/src/repos/messagesRepo.ts:3459-3466`, and `transportUpdated` is false
  too. **The claim lands and NO SSE is emitted** - the chip reads `1 failed`
  until something else refreshes the thread, which is the state D16 exists to
  prevent, in the one path D8 was designed to recover.
- **Rungs 2 and 3.** The callback resolves through the RETRY row's
  `relaysid#` pointer, so `ptr.tsMsgId` is the retry row's key, not the root's.
  The existing emit therefore carries the retry row's `tsMsgId`, while the
  plan's test asserts
  `expect.objectContaining({ tsMsgId: rootTsMsgId })`.

**Fix.** The claim block emits its own `message.persisted` for the ROOT
(`source.relay_retry_of ?? source.tsMsgId`) whenever a claim succeeds,
independently of `transitioned`. Keep the existing emit as-is (it serves the
non-30003 traffic), and accept the duplicate on the ordinary rung-1 path - a
second `message.persisted` for the same conversation is already a routine shape
on this bus (`routes/api.ts:2521-2523` forwards verbatim with no dedupe).

---

## 5. MUST-HANDLE - `sendOneRelayLeg`'s parameter list is short of what the loop body captures

**Plan** (Task 3, Interfaces) lists: `messages`, `conversations`, `contacts`,
`adapter`, `mediaStore?`, `log`, `tokenBucket?`, `conversationId`,
`sourceTsMsgId`, `poolNumber`, `member`, `body`, `sourceMedia`, `transport`,
`currentSource`.

**Tree** (`app/src/jobs/relayFanOut.ts:1119-1268`). Four gaps, each of which
either fails to compile or silently changes behaviour:

1. **`payload`, not two scalars.** The body reaches the repo only through three
   module helpers that each take a whole `RelayFanOutPayload`:
   `setVersionedAggregationState` (`:1406-1412`, used `:1125`, `:1180`),
   `persistRelayRecipientResult` (`:1428-1434`, used `:1127`, `:1191`, `:1210`,
   `:1228`, `:1250`) and, through the latter, `markRecipient` (`:1450-1456`).
   `closeRelay` uses them the same way (`:1067`). Passing bare
   `conversationId` / `sourceTsMsgId` requires changing all three signatures -
   a fine choice, but it is not the "mechanical only" edit Task 3 Step 2
   authorises, and the retry job would then need a `RelayFanOutPayload`-shaped
   object anyway for the log lines (`:1143`, `:1151`, `:1200`, `:1219`,
   `:1238`, `:1241` read `payload.relayConversationId`; `:1241` reads
   `payload.attempt`).
2. **`hasMedia` (`:990`), used at `:1161`.** Derivable from
   `sourceMedia.length > 0`, but the guard is `hasMedia && mediaStore`, and the
   fan-out logs an ERROR for the media-without-store case OUTSIDE the loop
   (`:1008-1017`) - the retry job inherits neither the derivation nor the log
   unless this is decided explicitly.
3. **The two MUTATED outer bindings.** `transientRemaining.push(key)` at
   `:1235` and `sentCount += 1` at `:1268`. `RelayLegSendOutcome.kind` covers
   `transient`, so the caller can rebuild `transientRemaining`; nothing in the
   outcome type carries the fact of a send, and the fan-out's completion log
   reads `sentCount` at `:1276`. Add `sent`-ness to the caller's own
   accounting or the "behavior-preserving" claim fails on that log line.
4. **`body` is ambiguous and, read wrongly, silently double-prefixes.** The
   value sent is `relayBody` (`:1171`), the COMPOSED
   `composeRelayBody(senderName, source.body)` from `:998` - not `source.body`.
   D12 has the retry job pass `row.relay_retry_leg_body` here. Naming the
   parameter `body` invites a builder to pass the row's raw body and re-compose,
   which is precisely the "double-prefix" failure Sec 10 rejected
   `relay.fanOut` reuse for.

`RelayLegSendOutcome.kind`'s six values DO map cleanly onto the body's five
`continue`s plus the fall-through - `:1121` `skipped_terminal`, `:1156`
`suppressed`, `:1206` `refused`, `:1225` `filtered`, `:1245` `transient`,
`:1268` `sent` - and `:1247`'s `throw err` correctly stays a throw.

---

## 6. NOTE - D13's stated rationale is not true at the live tree

**Spec** D13: "`append` writes one UNCONDITIONED media-pointer row per
attachment ... and that index IS the 'Media from comms' gallery - so a
three-rung ladder would triple a photo in it."

**Tree.** `listMediaPointers` has exactly ONE reader,
`app/src/routes/contacts.ts:1386` (`GET /api/contacts/:id/media`), and that
reader excludes multi-party threads by name at `contacts.ts:1374-1379`:
`if (conv.type === 'relay_group' || conv.type === 'group_text') continue;`.
Retry-row pointers would land in `media#<relayConversationId>` and reach no
gallery today.

**Why this still does not change the decision.** The exclusion is BY NAME and
its own comment says so ("never by 'not relay_group'"), the pointer write is
unconditioned (`app/src/repos/messagesRepo.ts:2286-2290`), and three rows per
failed leg is durable garbage either way. Build the suppression. But do not
repeat the rationale as fact, and do not let a builder try to prove the
behaviour through the gallery endpoint - the Task 1 assertion has to be a
direct `listMediaPointers(conversationId, ...)` read, which is what the plan's
snippet effectively does.

---

## 7. NOTE - `mediaPointerCount(conversationId, tsMsgId)` does not exist

**Plan** Task 1 Step 5 writes
`await expect(mediaPointerCount(conversationId, res.tsMsgId)).resolves.toBe(0);`
and says to follow `app/test/mediaPointers.integration.test.ts`.

**Tree.** That file has no such helper. Its idiom is
`await messages.listMediaPointers(CONV, { limit: N })` followed by a filter or
`.some()` on `p.providerSid` - `mediaPointers.integration.test.ts:87`, `:107`,
`:121`, `:148`, `:161`, `:175`. For a retry row, filter on the deterministic
SID `relayretry-<digest>-1`.

---

## 8. NOTE - `messagesRepo.transport.test.ts` is not a mocked-client suite

**Plan** Task 2 Step 1: "in the mocked-client suite (follow
`app/test/messagesRepo.transport.test.ts` for the doc-client stub shape) ...
`expect(sentInput()).toMatchObject({ ConsistentRead: true })`".

**Tree.** `app/test/messagesRepo.transport.test.ts:35-51` is a DynamoDB-Local
integration suite (`describe.skipIf(!reachable)`, real `createDocumentClient`,
`ensureTable`/`deleteTableIfExists`). Its two "stubs" (`:485-495`, `:531-535`)
are pass-through wrappers around the real client that force
`ConditionalCheckFailedException`s; there is no `sentInput()` and no pure mock.

The pure-stub precedent that CAN assert a command's `input` is
`app/test/repos.test.ts:98-115` and its `createAppendHarness()` at `:184-205`:
a `{ send: async (cmd) => ... } as unknown as DynamoDBDocumentClient` handed to
`createMessagesRepo({ doc: fakeDoc, env: { TABLE_PREFIX: 'hc-fake-' } as NodeJS.ProcessEnv, logger })`,
recording the commands it sees. Capture `GetCommand`s the same way and read
`cmd.input.ConsistentRead`.

---

## 9. NOTE - the typed-fake discovery command finds the wrong set for `ConversationsRepo`, and the exact lists are short

**Plan** Task 2 Step 3: `cd app; grep -rln "MessagesRepo" test/ | xargs grep -ln "getByTsMsgId"`.
Task 4 Step 3 says to reuse "the Task 2 Step 3 sweep, for `ConversationsRepo`" -
but `getByTsMsgId` is a MessagesRepo method, so the command returns nothing
useful there. It also over-reports for MessagesRepo, since a `as unknown as
MessagesRepo` cast mentions both strings and does not break.

**Tree.** A full sweep of `app/src`, `app/test`, `e2e` and `scripts` for
annotated literals (`: X = {`), `satisfies X` and `Partial<X> as X` gives the
complete break lists. No `satisfies` or `Partial` form exists for either
interface, and `app/src` builds no annotated literal for either.

`MessagesRepo` - THREE files break:
- `app/test/helpers/twilioWebhookHarness.ts:1061` (the shared FakeWorld; nine
  relay/webhook suites drive through it)
- `app/test/scheduledSendSuppression.test.ts:265`
- `app/test/sendMessage.test.ts:223`

`ConversationsRepo` - FOUR files break:
- `app/test/contactCapture.test.ts:146`
- `app/test/helpers/twilioWebhookHarness.ts:507`
- `app/test/scheduledSendSuppression.test.ts:154`
- `app/test/sendMessage.test.ts:102`

Everything else is a cast, a `Pick<>` or the real factory. Full itemisation in
the worklist, Part B.

---

## 10. NOTE - `enqueue`'s `runAt` is a `Date`, not milliseconds

The prior reference map (`.superpowers/research-server-reference.md:644`)
records `enqueue(RETRY_SEND_JOB, payload, { runAt: Date.now() + retryBackoffMs(...) })`.
**Tree:** `app/src/jobs/jobs.ts:91-93` declares `EnqueueOptions { runAt?: Date }`
and `:112-113` calls `opts.runAt.getTime()`. Both live callers wrap:
`app/src/jobs/retrySend.ts:74-76` and `app/src/jobs/relayFanOut.ts:1306`
(`{ runAt: new Date(Date.now() + fanOutBackoffMs(claim.attempt)) }`).
A bare number is a type error, so this is self-correcting - noted only because
the reference map a builder was told to start from states it wrongly.

Also worth knowing at the same seam: `defineJobHandler`
(`app/src/jobs/jobs.ts:199-204`) THROWS on a second registration of the same
job name, so a test that registers the retry handler twice needs
`_resetForTests()` between.

---

## 11. NOTE - `touchLastActivityPreservingStatus`'s declared return type diverges from its sibling

**Plan** Task 4: `...): Promise<ConversationItem | undefined>`.
**Tree:** `touchLastActivity` is `Promise<ConversationItem>`
(`app/src/repos/conversationsRepo.ts:645-649`); both of its branches require
`attribute_exists(conversationId)` (`:1549`, `:1579`) and a missing row throws
`ConditionalCheckFailedException` from either, which the docblock states at
`:641-643`. Nothing in Task 11 branches on `undefined`. Matching the sibling
(`Promise<ConversationItem>`) keeps one contract for the pair.

---

## 12. NOTE - citation drift (six anchors, none behaviour-changing)

Recorded so a builder does not lose time reconciling them; the byte-exact
values are in the worklist.

- **Plan Task 12**: `handleRelayRecipientStatus` is `twilio.ts:2442-2529`
  (the function's `};` is at `:2529`). `:2561` is the ROUTE's `return`, 32
  lines after the closure ends; the caller is `:2558-2562`.
- **Plan Task 2**: "`MessagesRepo` interface `:1339`" - the interface STARTS at
  `messagesRepo.ts:1197`; `:1339` is `getByTsMsgId` inside it (a fine insertion
  point, wrongly labelled).
- **Spec D16**: "the `byLastActivity` GSI is keyed `(status, last_activity_at)`
  (`conversationsRepo.ts:632`, `:699`)". Those two lines are DOCBLOCKS. The key
  definition is `app/src/lib/tables.ts:166-171` (hashKey `status`, rangeKey
  `last_activity_at`) - which confirms the decision, at the index itself.
- **Spec Sec 2**: the announcements-never-retried comment is
  `relayAnnouncements.ts:168-170`, not `:169-171`.
- **Spec D2 / plan Task 11**: `setVersionedAggregationState` throws at
  `relayFanOut.ts:1425` (the spec's `:1418-1424` is the signature plus the
  acceptance logic); `persistRelayRecipientResult`'s versioned throw is at
  `:1446` and its legacy branch at `:1435-1438` (the plan's `:1436-1439`);
  `markRecipient` is `:1450-1463` (the spec's `:1436-1463` spans both).
- **Spec D23**: `sendMessage.ts` throws `RelaySendNotSupportedError` at `:297`
  and `GroupTextSendNotSupportedError` at `:298-300` (the spec cites
  `:294-297` for the group-text one).

Everything else the spec and plan cite in `twilio.ts`, `messagesRepo.ts`,
`relayFanOut.ts`, `retrySend.ts`, `adapters/messaging.ts` and `api.ts` verified
EXACT, including `twilio.ts:301`, `:310`, `:2449`, `:2457`, `:2466-2472`,
`:2500-2511`, `:2512`, `:2526`, `:2711`; `messagesRepo.ts:189-193`, `:204-209`,
`:913-915`, `:922-937`, `:1885`, `:2085`, `:2158-2161`, `:2286-2290`,
`:2295-2306`, `:2374-2388`, `:2960-2965`, `:3112-3114`, `:3126`, `:3459-3466`,
`:3543-3565`; `relayFanOut.ts:91-100`, `:192-196`, `:957-959`, `:974-978`,
`:998`, `:1060`, `:1097-1114`, `:1118-1269`, `:1263-1267`, `:1326-1339`,
`:1471-1473`; `retrySend.ts:37`, `:39-42`, `:129-146`, `:209-217`;
`adapters/messaging.ts:567-569`; `api.ts:2148-2199`.

---

## Part C sweep - what came back CLEAN

Recorded so the surfaces below are not re-audited. Each was checked against a
retry row that mirrors an INBOUND original (the harder direction).

- **AI fact extraction cannot see a retry row.** Extraction is scheduled only
  for `tenant_1to1` / `unknown_1to1` (`twilio.ts:2391-2400`), voice
  (`services/voiceTranscripts.ts:236`, `routes/dev.ts:803`), triage
  (`routes/contacts.ts:1789`) and email (`services/inboundEmail.ts:820`). No
  path schedules a relay_group, so `jobs/extraction.ts:504-506`'s
  `m.direction === 'inbound'` window and `toUtterances`'s speaker split
  (`:183-228`) never see one. No transcript duplication.
- **The unread-feed resurfacing probe cannot see one.** `lib/unreadFeed.ts:596-605`
  returns for every non-1:1 bucket (`isOneToOneBucket` `:295-297`) before
  `threadResurfaces` (`:568-593`) can read `latest.direction === 'inbound'`.
  The same is true of the inbox's own `isFreshInbound` (`routes/inbox.ts:938-963`,
  inside `buildContactRow`).
- **Unread counts are untouched.** Every `incrementUnread` caller is a
  fresh-inbound webhook persist (`twilio.ts:758`, `:1070`, `:1841`, `:2347`;
  `voice.ts:443`; `inboundEmail.ts:749`). The retry job calls none.
- **The queued-message flush ignores retry rows** - it selects
  `direction === 'outbound' && delivery_status === 'queued_pending'`
  (`services/relayQueuedMessages.ts:64`); a retry row is seeded `queued`.
- **The fan-out's five-row window cannot pick one up.** The bound is
  `bumpKey(sourceTsMsgId)` (`relayFanOut.ts:772`, `:1471-1473`) and a
  wall-clock `providerTs` puts every retry row strictly above it. D3's
  sort-order argument also checks out against ASCII: at an identical
  `providerTs`, `relayretry-` (0x72) sorts below `system-` (0x73) and `team-`
  (0x74) and above `SM...` (0x53).
- **`retry_of`'s only server reader is fenced out.** `routes/contactTimeline.ts:173`
  / `:442` project it, and `:1232` excludes `relay_group` and `group_text` from
  that timeline. `twilio.ts:2714`'s `retry_attempt` read is downstream of the
  `!message` gate at `:2574`, unreachable from the relay branch.
- **`relay_sender_key` has no server reader that branches on it.** The only
  server read is `messagesRepo.ts:872`, inside
  `assertRelayExternalCallerShape`, which applies to `type:'call'` refusal rows
  only. D7's fence is sound: `relayAnnouncements.ts:229-242` is the single
  append behind all four announcement callers, so `!== 'system'` excludes every
  one of them including tour rungs.
- **`delivery_recipients`' other readers are out of reach.**
  `services/groupReceipts.ts:344`/`:530` runs on Conversations-rail receipts
  (group_text only); `services/groupSendStaleness.ts:166` discovers work only
  from `GROUP_SEND_DUE_PARTITION` (`:218`, kind-guarded `:223`) and only
  `groupSend` writes a `dueRow`.
- **The escalation discriminator is correct.** `flagPlacementAttention` has
  exactly two call sites (`twilio.ts:2526` relay, `:2700` 1:1). Skipping when
  `source?.relay_retry_of` is set escalates once on the root's callback, never
  on a rung, and still escalates a second member's first failure - and a read
  miss leaves `source` undefined, so it fails OPEN toward escalating.
- **`GET /api/conversations/:id/messages` really does return rows as-is**
  (`routes/api.ts:2160-2198`); the single mutation adds
  `relay_external_caller_display_name` to call rows. D11's "anything on the row
  reaches every browser" is exact.
- No digest/summary job, search path or export reads relay message rows;
  `routes/today.ts` and `services/relayGroupDuplicates.ts` read conversation
  rows only.
