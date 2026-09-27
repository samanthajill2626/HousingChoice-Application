# Build research R1 (foundations) - live-tree drift findings for Tasks 1, 2, 4, 5, 6

Date: 2026-09-26. Reader: R1 "foundations" (read-only). Plan: revision 4
(`docs/superpowers/plans/2026-09-26-send-outcome-reconcile.md`). Tree: HEAD
1280058f; `git diff --stat a9f411f3 HEAD -- app dashboard fake-twilio e2e scripts`
is empty, so every plan anchor was checked against the code the plan was written
on. Byte-exact quotes for the implementers are in the gitignored reference
`.superpowers/sdd/build-foundations-reference.md` (sections cited as REF n).

Severity: BLOCKING = the step cannot be executed as written or fails its gate;
FIX = wrong name / anchor / pin / omission the implementer must be told;
NOTE = risk or awareness.

Counts: 1 BLOCKING, 11 FIX, 10 NOTE.

Verified correct (no finding): every import the Task 5 repo uses (`tableName`
from `lib/config.js` :512, `getDocumentClient` from `lib/dynamo.js` :98,
`type RepoDeps` from `repos/conversationsRepo.js` :530-536,
`ConditionalCheckFailedException` / `TransactionCanceledException` from
`@aws-sdk/client-dynamodb`); `createLogCapture().lines` are parsed objects and
`.stream` exists; the driver deps (`accountSid`, `apiKeySid`, `apiKeySecret`,
`messagingServiceSid`, `appEnv` required; `client`, `logger` optional);
`SEND_THROTTLE_CODES` at `messaging.ts:543`; `MessageMediaResource` at
:529-533; `mapTwilioStatus` :558; the forward-only helper IS named
`allowedPriorStatuses` (`messagesRepo.ts:144`); `legacy_noop` returned at
:3481; `getSidPointer(sid, { consistent?: boolean })` :2035; every Task 4
typed MessagingAdapter fake is listed (the list is complete); every DynamoDB
expression in Tasks 5 and 6 lists exactly the names and values it uses, per
branch (the claim's `absent` branch uses only the 11 base values; `#sid`,
`#oc`, `#ca` are used by CLAIM_SET's REMOVE); a TransactWriteItems Update+Put
on one table with different keys is legal; REMOVE of absent attributes is
legal. Task 2 has no findings (the NFKC / Smart-Encoding expectations hold).
tsconfig: `strict` + `noUncheckedIndexedAccess` only (REF 1); the plan's
`false` spreads, element-access narrowing and exhaustive switches typecheck
(checked with the repo's tsc 5.9.3); pino's `Logger` is assignable to the
plan's `ErrorLogger` shape.

---

## Task 1

**T1-1 NOTE - two classes are named `SmsSendingDisabledError`.**
Adapter kill switch `app/src/adapters/messaging.ts:383`; the send wrapper's
refusal `app/src/services/sendMessage.ts:91` (`extends SendRefusedError`).
Instruction: `sendOutcome.ts` and `sendOutcome.test.ts` import ONLY the leaf
(`../adapters/messagingErrors.js`), as the plan says; never the service class
(D3: refusals are never classified). `groupSend.ts:58` and
`groupConversations.ts:30` import the adapter class through `messaging.js`;
the re-export keeps them working. Move the class JSDoc (`messaging.ts:375-382`)
with it.

**T1-2 NOTE - capture tests depend on the ambient LOG_LEVEL; `atLevel` is exact.**
`createLogger` defaults to `process.env.LOG_LEVEL ?? 'info'`
(`app/src/lib/logger.ts:180`); an exported `LOG_LEVEL=error` empties the
Task 1 step 4 / Task 4 WARN captures. The sibling tests pin it
(`app/test/messaging.test.ts:376`: `logger: createLogger({ level: 'info', destination: capture.stream }),`).
Instruction: pass `level: 'info'` in every new capture-based test (T1 step 4,
T4 "page size differs", T5 guardWrite). `atLevel(n)` is an EXACT match
(`app/test/helpers/logCapture.ts:36`), not "at or above" as its doc says.

**T1-3 NOTE - touched throttle lines carry U+2014.**
The marker message `messaging.ts:704` contains an em dash, and the doc comment
:535-542 names only 429/30022. If either is edited to mention 20429, reword it
in ASCII (Global Constraints). Changing only :543 needs neither.

## Task 4

**T4-1 FIX - do not add a call signature to `TwilioClientLike`.**
The plan says `TwilioClientLike.messages` gains "the callable `(sid) => { fetch }`
(intersection ...)". `messages` is a plain object (`messaging.ts:424-432`), and
eight literals typed `: TwilioClientLike` in `app/test/messaging.test.ts`
(:57, :175, :228, :686, :742, :912, :984, :1080) are not callable, so
`tsc -p tsconfig.test.json` fails (TS2322).
Instruction: keep the callable view OUT of `TwilioClientLike`: declare a local
interface beside `MessageMediaResource` (:529-533) and assert it at the call
site, which is what the plan's own `getMessage` block already does with
`as unknown as`. Optional `page?` / `getPage?` members on `messages` are
harmless but not needed (the `listMessages` block casts too).

**T4-2 FIX - the new world fields must be declared, and `listPageSize` needs a get/set bridge.**
`createFakeWorld(): FakeWorld` (`app/test/helpers/twilioWebhookHarness.ts:414`)
returns an object literal (:4039), so a field missing from
`interface FakeWorld` (:213-406) is TS2353 there and TS2339 at every
`world.<field>` use. A test's `world.listPageSize = 2` never reaches the
adapter closure through a plain property.
Instruction: add `sentDetails`, `providerMessages`, `listPageSize` to
`FakeWorld`; implement `listPageSize` as a local `let listPageSize = 1000;`
plus `get listPageSize()` / `set listPageSize(n)` in the returned literal (the
`failNextSetUnread` idiom, :4054-4062). The two arrays share a reference and
need no accessor.

**T4-3 NOTE - the harness has two send methods.**
Both `sendPreparedMessage` (:3775) and `sendMessage` (:3784) push to `sent`;
the plan adds `sentDetails` to the first only, so a direct `adapter.sendMessage`
is invisible to `listMessages` / `getMessage`. Instruction: hoist the SID and
`providerTs` to locals and push `{ params, sid, providerTs }` in BOTH; keep
`world.sent` byte-identical (`twilioStatusWebhook.test.ts:1275`).

**T4-4 NOTE - the timeout pin is inert on the hermetic lane.**
twilio-node applies the `timeout` ClientOpt only to the default client it
builds (`node_modules/twilio/lib/base/BaseTwilio.js:98-101`). With
`apiBaseUrl` set, the driver injects `createRedirectingHttpClient`, which is
`new RequestClient()` (`app/src/adapters/twilioHttpClient.ts:32`), so the
option is ignored there. Its default is also 30000
(`RequestClient.js:47`), so the value matches today. No planned test proves
that `twilio()` receives `timeout`: the test only compares two constants. If
the pin must hold on the lane, pass `{ timeout }` into that `RequestClient`.

## Task 5

**T5-1 FIX - wrong anchor for `RegisterJobHandlersDeps`.**
It is `app/src/jobs/registerHandlers.ts:26-29` (only `tokenBucket`), not
:46-73. :46-74 is the `registerAllJobHandlers` body; the three registrations
are at :48, :60 and :61.

**T5-2 FIX - wrong parity idiom named.**
`app/test/twilioWebhookHarnessRetryFields.test.ts` is FAKE-ONLY: it imports
only `createFakeWorld`, and its header (:10-13) says the real repo is covered
elsewhere. The fake-vs-real idiom the step describes is
`app/test/unreadIndexFakeMirror.integration.test.ts`. It runs the same inputs
through the real repo on DynamoDB Local and through the fake and requires the
same answer, using an endpoint probe, a fresh `hc-test-...-<uuid>-` table and
an afterAll drop (REF 5).
Instruction: follow that file. Name the new file
`twilioWebhookHarnessSendAttempts.integration.test.ts`: it opens DynamoDB
Local, and that is the repo's naming convention. Update the Step 5 run
command and Step 7's `git add` to match.

**T5-3 FIX - the fake's three fields must be on `FakeWorld`.**
The mechanics are the same as T4-2. Declare `sendAttempts`,
`sendAttemptIndex` and `sendAttemptsRepo` in `interface FakeWorld`
(`twilioWebhookHarness.ts:213-406`), not only in the returned literal.
Otherwise every Step 6 site that passes `world.sendAttemptsRepo` fails
typecheck.

**T5-4 FIX - `writeClaim` reads any cancellation as a lost condition and can return an undefined record.**
The house idiom attributes a cancellation by item index
(`app/src/repos/messagesRepo.ts:2525-2535`,
`tourRemindersRepo.ts:549-552`). The plan catches every
`TransactionCanceledException`. A `TransactionConflict` cancellation, which
is the concurrent-claim race this record exists to decide, then returns
`false` with the record possibly absent. `claim()` then returns
`{ outcome: 'refused', record: (await get(owner))!, fresh: true }` with an
undefined record, and every caller that reads `record.*` throws. The comment
"lost a create race" is wrong: after a real condition failure on
`attribute_not_exists(tsMsgId)` the record exists.
Instruction: in `writeClaim`, return `false` only when
`err.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed'` (index 0 is
the record Update) and rethrow anything else; a claim throw is a
prepare-phase throw. In `claim()`, if `get()` is undefined after a `false`,
throw; never return an undefined record. A `ConditionalCheckFailedException`
never comes out of TransactWriteItems, so that arm of the catch is dead but
harmless.

**T5-5 NOTE - `listByRecipient` can return the same record twice.**
Each claim (`absent`, `retryable` or `redriven`) Puts a NEW index item whose
sort key starts with that claim's `nowIso`. The loop then re-reads the live
record once per index item, so an owner claimed twice inside the window
appears twice. Task 10's sibling scan would double-count it, and no planned
case re-claims before listing.
Instruction: de-duplicate by `attemptKey(rec.owner)` (first hit, newest) in
the repo and in the harness fake, and add a case: claim, then finishAttempt as
retryable, then claim again, then list, which should return one row.

**T5-6 NOTE - the TTL comment's classification.**
The `tables.ts` comment (:213-229) says TTL'd families have "their own
authoritative consume step", with `syssid#` as the stated exception. The
attempt record and its index have no consume step either. Instruction: list
`sendattempt#` and `sendattemptix#` (30 d) with `syssid#` as TTL-only reapers.

**T5-7 NOTE - the Step 6 grep result.**
It returns 17 files (table in REF 7.1). 25 call sites in 15 files take
`sendAttemptsRepo: world.sendAttemptsRepo`, and all of them name the world
`world`. Two matches have no world and run no send, so leave them alone:
`app/test/registerHandlers.test.ts:17` and `app/test/relayRetryLeg.test.ts:1396`
(`registerThroughTheSeam()` only enqueues).

## Task 6

**T6-1 BLOCKING - `relayRepos.integration.test.ts` cannot host Step 1.**
The file has no messages repo, no messages table
(`const bases = ['conversations', 'pool_numbers'] as const;` at :49) and no
relay source-row fixtures. Its only "legacy" is a legacy GROUP (:154). The
sketch's `messages`, `legacySource`, `versionedSource`, `legacyTs`,
`versionedTs` and `row` do not exist, so Step 1 fails before any assertion.
Instruction:
- Host the `send-outcome additions` describe in
  `app/test/broadcastsRepo.integration.test.ts`. It already has
  `const messages = createMessagesRepo(repoDeps);` (:62) and the messages
  table (:64).
- Build the LEGACY source inline as in :177-195: a per-case
  `conv-relay-${randomUUID().slice(0, 8)}` id, a unique `providerSid`,
  `deliveryRecipients: {}`, no `transportSchemaVersion`.
- Build the VERSIONED source the same way plus `transportSchemaVersion: 1`.
  Append rejects slot transport fields without it (`messagesRepo.ts:976`).
- Use the returned `tsMsgId` and per-case ids in place of
  `'conv-1'`/`legacyTs`/`versionedTs`, and per-case unique pointer SIDs in
  place of `'SM1'`: the file's table is shared by every case and never reset.
- Put "append reports the conversation of a deduped row" in
  `app/test/messaging.integration.test.ts` next to the pins at :133-156,
  using its `outbound(conversationId, sid, ts, body)` helper (:45).
- In Steps 1, 2, 5 and 6, replace `test/relayRepos.integration.test.ts` with
  these two files.
- Alternative host: `app/test/messagesRepo.transport.test.ts` (repo variable
  `repo`; helpers `nextMessage` / `append` / `read`, REF 9).

**T6-2 FIX - there is no seeded `b-1` / `b-legacy` broadcast.**
Every case in `app/test/broadcastsRepo.integration.test.ts` builds its own:
`broadcasts.create({...})` then
`broadcasts.markSending(created.broadcastId, { 'c-1': { status: 'queued' } })`
(:148-153). Use `created.broadcastId`. After this task `create` persists
`unconfirmed: 0` (`zeroStats()`, `broadcastsRepo.ts:530`), so the "legacy
stats map" case must first run the file's raw
`UpdateCommand({ ..., UpdateExpression: 'REMOVE stats.unconfirmed' })` (idiom
at :154-161). `finalizeStatus` needs the row in `sending`, so run
`markSending` first.

**T6-3 FIX - `append` has THREE return sites; the plan names two and mislabels :2598.**
- `messagesRepo.ts:2558`: SID-pointer dedupe; return `ptr.ref_conversationId`.
- `:2598`: RFC Message-ID email-pointer dedupe. The plan's ":2598-2632 fresh"
  conflates it.
- `:2631`: fresh; return `message.conversationId`.

The email pointer item stores `ref_conversationId` (written at :2468), but the
read casts only `{ ref_tsMsgId?: string }` (:2588).
Instruction: widen that cast and return
`conversationId: ptr.ref_conversationId ?? message.conversationId` at :2598.

**T6-4 FIX - an unlisted typecheck red: `groupSend.test.ts`.**
`app/test/groupSend.test.ts:257` returns `{ deduped: false, tsMsgId: ... }`
from a fake typed as `Pick<MessagesRepo, 'append'>`
(`app/src/services/groupSend.ts:224`), so a required `conversationId` is
TS2741.
Instruction: add `conversationId: message.conversationId` there, and add the
file to Step 6's `git add`. The other old-shape returners are cast
`as unknown as` and stay green: `emailEvents.test.ts:389`,
`inboundEmail.test.ts:232-234`, `sendEmailMessage.test.ts:78-81` and
`apiRoutes.test.ts:314-320`. The typed ones are the harness (:1087, :1213),
`sendMessage.test.ts:236` and `scheduledSendSuppression.test.ts:276`.

**T6-5 FIX - the harness fake's dedupe must report the STORED row's conversation.**
`twilioWebhookHarness.ts:1087` is
`if (existing) return { deduped: true, tsMsgId: existing.tsMsgId };`.
Instruction: return `conversationId: existing.conversationId`, not the input's.
That mirrors the real pointer read, and the new dedupe test (a second append
under another conversation) asserts exactly this.

**T6-6 FIX - wrong `updateRecipientDeliveryStatus` call shape in the sketch.**
The signature is
`(conversationId, tsMsgId, memberKey, status, errorCode?, opts?)`
(`messagesRepo.ts:1624-1631`). The sketch's 5th argument `T1` would be
written as an errorCode.
Instruction: call `updateRecipientDeliveryStatus(<conv>, <ts>, 'c-9', 'delivered')`
(the file's own shape, `broadcastsRepo.integration.test.ts:211-216`).

**T6-7 NOTE - a stats helper that omits the new bucket.**
`bucketsSumToAudience` (`app/test/broadcastFanOut.test.ts:1117-1129`) sums
buckets without `unconfirmed`. It stays green in this task and goes red as
soon as Task 7 produces a `send_unconfirmed` slot.
Instruction: add `(s.unconfirmed ?? 0)` when this task adds the bucket.

## Invariant sweep (messages-table readers vs `sendattempt#` / `sendattemptix#`)

**INV-1 NOTE - no reader breaks; a reseed clears both families.**
- `resetLocalData` Scans and deletes every item of every table
  (`app/src/lib/devReset.ts:35-62`, :101-104). It sits behind `/__dev/reseed`
  (`routes/dev.ts:323`), `scripts/e2e-reseed.mjs` and the perf reset
  (`performanceSeed.ts:250`), so a lane reseed leaves no stale attempt record
  to refuse a later claim.
- `scripts/wipe-dev-data.mjs` deletes every item.
- The media backfills filter on `media_attachments` / `media_s3_keys`.
- Every other Scan reads another table.
- The messages stream has no consumer (only an ARN output,
  `infra/modules/dynamodb/outputs.tf:11-15`).
- All repo reads are exact-partition.

Residual, for Tasks 10 and 12: an e2e spec that does NOT reseed inherits
earlier specs' index items for the same sender and recipient digest. Owners
are unique per broadcast, source or rung, so no claim is refused, but the
reconcile's recipient-index scan can see those older siblings. Full table in
REF 11.
