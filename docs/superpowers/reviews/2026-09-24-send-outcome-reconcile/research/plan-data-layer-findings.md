# Data + adapter layer - findings for the plan (plan-phase research, 2026-09-26, branch @a9f411f3)

Produced by a read-only researcher (opus) against spec revision 7. This file
holds FINDINGS only: what the spec gets wrong or leaves unsaid about the repo,
adapter and fake layers, and the risks. The byte-exact reference (signatures,
line numbers, idioms, SDK shapes, hook points) is a separate artifact at
`.superpowers/sdd/plan-data-layer-reference.md` (gitignored, by design: one
file, one kind). Citations are `file:line` at a9f411f3. Twilio SDK citations
are into the MAIN checkout's `node_modules/twilio` (6.0.2, pinned at
`package-lock.json:8287-8288`); the worktree has no `node_modules`.

Severity: HIGH = the plan cannot build the decision as written without new
data-layer work the spec does not name; MED = a named mechanism needs a
different shape than the spec implies, or a typecheck/test break; LOW = a
residue or trap to record.

## HIGH

### H1. D13's "another attempt for the same recipient and sender" is undiscoverable as specified
D13 (spec :502-507) rules `unresolved` instead of `never_sent` when ANOTHER
attempt for the same recipient + sender with the same fingerprint is open or
was adopted inside the window. The only recipient identity the record holds
is the D12 digest, which is keyed WITH THE OWNER REFERENCE (spec :464-466), so
two owners' digests for the same handset never match. The record is
per-owner-per-recipient (D8a, spec :339-341), the messages table has NO GSI
(`app/src/lib/tables.ts:208-211`, `gsis: []`), and D11 forbids coordination
reads through a GSI anyway (spec :443-449). The cross-owner case is exactly
the one D13 cares about (two relay source messages = two owners, same member,
same pool number). The plan must add an owner-INDEPENDENT lookup - e.g. a
second item family keyed by a hash of (sender, E.164) with one row per attempt
sorted by attempt time, written in the same transaction as the claim and read
with a ConsistentRead Query over [attemptStart - 60s, now] - or the spec must
narrow the rule to same-owner. Note the privacy rule (spec :342-345) then
applies to that key too; `relayRetryDigest` (`app/src/lib/relayRetryClaim.ts:25-30`)
is the hashing precedent.

### H2. Every coordination read the spec calls "strongly consistent" is eventually consistent today
D11 (spec :443-449) names the close gate, the continuation snapshot, finalize
and the SID-pointer checks. Current reads:
- `getByProviderSid` (`messagesRepo.ts:2052-2062`): pointer read via
  `getSidPointer` WITHOUT `consistent` (`:2053`, option exists privately at
  `:2035-2050` and is used only by the append dedupe `:2543`) and the item
  Get without ConsistentRead (`:2055-2060`).
- `getRelaySidPointer` (`:3808-3821`) - no ConsistentRead.
- `getSystemSidMarker` (`:3855-3861`) - no ConsistentRead.
- `broadcastsRepo.getById` (`broadcastsRepo.ts:454-457`) - no ConsistentRead;
  it is the pass snapshot (`broadcastFanOut.ts:259`) and finalize's read
  (`broadcastFanOut.ts:730`).
- Relay source snapshot: `listByConversation` (`messagesRepo.ts:3178-3194`,
  a Query with no ConsistentRead option) at `relayFanOut.ts:786`, and
  `readVersionedSource` via plain `getByTsMsgId` (`relayFanOut.ts:1595-1607`).
  The right replacement already exists: `getByTsMsgIdConsistent`
  (`messagesRepo.ts:1473`, `:3206`), used by `relayRetryLeg.ts:399`.
The webhook reads `getByProviderSid`/`getRelaySidPointer`/`getSystemSidMarker`
on EVERY status callback (`routes/webhooks/twilio.ts:3346-3352`), which is
fenced. Add consistent SECOND methods rather than flipping these, per the
precedent's own reasoning (`messagesRepo.ts:1462-1472`). No
`listByConversation` consistent option is needed if the relay snapshot moves
to `getByTsMsgIdConsistent`.

### H3. The relay SID claim does not exist: `putRelaySidPointer` swallows the conflict
D11/D15 (spec :426-430, :560-562) need the `relaysid#` put to REPORT a lost
claim. It returns void and swallows `ConditionalCheckFailedException` at
`messagesRepo.ts:3803`. Two production callers ignore the result
(`relayFanOut.ts:1508`, `services/relayAnnouncements.ts:354`); the harness
mirror also silently keeps the first (`twilioWebhookHarness.ts:1626-1628`).
The claim needs three outcomes - created / already mine (same ref: an
idempotent re-run) / someone else's - which only a ConsistentRead of the
existing pointer after the CCF can separate (the `claimFanoutPass` idiom,
`messagesRepo.ts:3636-3651`). Prefer a NEW method and leave the announcement
caller's semantics alone.

### H4. `append`'s dedupe cannot tell "my earlier adoption" from "another attempt's message"
D11 (spec :426-430) makes the broadcast adoption's claim the `sid#` append
and branches on "lost to a DIFFERENT attempt". `AppendResult`
(`messagesRepo.ts:1259-1264`) returns only `deduped` and the pointer's
`ref_tsMsgId` (`:2543-2558`) - not `ref_conversationId`. And conversationId
would not suffice: two broadcasts (or a broadcast and a staff send) to the
same tenant land in the same 1:1 conversation. The discriminator is the
persisted row's `broadcast_id` (+ recipient), which requires a follow-up
`getByTsMsgIdConsistent` of the deduped row. The plan should add the pointer's
conversationId to `AppendResult` (additive; the harness append at
`twilioWebhookHarness.ts:1081-1087` must mirror) and define "mine" precisely.

### H5. Finalize has no conditional flip and no "did I win" signal
D16a (spec :616-627) flips `status` only from `sending` and lets the winner
alone write the audit row and emit. `flipStatus` is conditioned only on
`attribute_exists(broadcastId)` (`broadcastsRepo.ts:497-523`, condition at
`:515`); `markSent`/`markFailed` (`:803-809`) return the item or throw.
N callers today = N flips + N audit rows (`broadcastFanOut.ts:723-771`). A new
method conditioned `#s = :sending` returning won/lost is needed; keep
`markFailed` for its other caller (`routes/broadcasts.ts:769`, the send
route's enqueue failure, which is not a finalize). The harness
`markSent`/`markFailed` (`twilioWebhookHarness.ts:3014-3028`) are
unconditional too.

### H6. There is no "slot + stats bump in one conditional write", and the broadcast slot has no SID
- D7a's RECORD phase (spec :307) and Sec 8 item 4 (spec :729-730) require the
  slot write and the stats bump as ONE conditional write. Today they are two
  UpdateCommands: `setRecipient` (`broadcastsRepo.ts:671-717`) then
  `bumpStats` (`:760-801`), called back to back at `broadcastFanOut.ts:480-492`.
  A single `SET recipients.#ck = :rec ... ADD stats.#k :v` is legal (disjoint
  document paths); it needs a new method returning ALL_NEW for the SSE emit.
- D8's close condition "the slot must still be `queued` and carry no SID"
  (spec :330-332) is relay vocabulary. `BroadcastRecipient`
  (`broadcastsRepo.ts:128-158`) has no `sid`; its send evidence is
  `conversationId`+`tsMsgId` (the tsMsgId embeds the SID). The broadcast form
  of that condition is on `recipients.#ck.tsMsgId`.
- Today's closes are BLIND: `closeBroadcast` writes via `setRecipient` without
  prior statuses (`broadcastFanOut.ts:296`, `:709-716`); the legacy relay
  close goes through `setRecipientDelivery`, a blind whole-slot SET
  (`messagesRepo.ts:3661-3682`); the versioned relay close goes through
  `applyRecipientSendResult` (`:3473-3613`), forward-only but with no "no SID"
  clause. Both repos need a conditional close method.

## MEDIUM

### M1. Nothing writes `attemptedAt` onto a slot, and a legacy relay slot may not exist yet
D8a (spec :386-389) and D20a need `attemptedAt` on both slot types.
`RecipientSendResultPatch` (`messagesRepo.ts:179-185`) has no such field and
`applyRecipientSendResult` writes only status/sid/sentAt/actualTransport/
errorCode; `setRecipientDelivery` and broadcast `setRecipient` are wholesale.
A targeted child SET is needed, conditioned on `attribute_exists(<slot>)` -
the idiom that turns a dangling document path into a CCF instead of a
ValidationException (`messagesRepo.ts:3767-3772`). Sec 8 item 5's "legacy
relay slot absent at first claim is created and claimed" (spec :736-737)
needs a create-if-absent step first: on a legacy row the slot does not exist
until the first `markRecipient`, and `initializeRecipientDelivery` refuses
unversioned rows (`:3311-3312` requires `#v = :v`, returns `legacy_noop`
`:3328`). Types to extend: `RelayRecipientDelivery` (`messagesRepo.ts:159-169`),
its dashboard mirror (`dashboard/src/api/types.ts:1764`),
`BroadcastRecipient` (`broadcastsRepo.ts:128-158`). The relay map reaches the
dashboard verbatim (`routes/contactTimeline.ts:453`).

### M2. The repo's batch-read idiom silently drops unprocessed keys - D8 forbids exactly that
`getManyByTsMsgIds` (`messagesRepo.ts:3208-3223`) retries `UnprocessedKeys`
four times, then returns WITHOUT them (absent = missing), and reads
eventually. D8 (spec :322-324) says an unprocessed key must be re-read, never
treated as absent. Do not copy it. If the record family is partitioned by
OWNER (sort key = recipient), a ConsistentRead Query over the owner partition
returns every record with no unprocessed-key class at all - the
`claimOldestCrossCheckPending` idiom (`messagesRepo.ts:4243-4262`), paged on
`LastEvaluatedKey`. A broadcast has up to 1500 recipients
(`broadcastsRepo.ts:67`).

### M3. Adding port/repo methods breaks typed test fakes
Required (non-optional) additions break `npm run typecheck` in every typed
literal:
- `MessagingAdapter`: `app/test/helpers/twilioWebhookHarness.ts:3766`,
  `app/test/scheduledSendSuppression.test.ts:355`,
  `app/test/sendMessage.test.ts:318`, `app/test/tourReminders.test.ts:2579`,
  `app/test/poolNumbers.test.ts:213` (FakeAdapter), `app/test/relayWarm.test.ts:59`.
- `MessagesRepo`: `twilioWebhookHarness.ts:1080`,
  `scheduledSendSuppression.test.ts:273`, `sendMessage.test.ts:233`.
- `BroadcastsRepo`: `twilioWebhookHarness.ts:2902` only.
The harness fakes must MODEL the new conditions (the `claimFanoutPass`
precedent refuses rubber stamps, `twilioWebhookHarness.ts:1560-1575`,
`:2982-3001`), and the harness adapter records only params in `sent`
(`:3775-3783`) - a list/fetch fake needs sid, timestamp, from and status too.
Parity tests exist as a pattern (`app/test/twilioWebhookHarnessRetryFields.test.ts`,
`app/test/twilioWebhookHarnessMediaIndex.test.ts`).

### M4. D17's seam shape does not match the SDK or the existing seam
- `TwilioClientLike.messages` is a plain object with only `create`
  (`adapters/messaging.ts:423-432`); `messages(sid).fetch()` cannot be added
  to it without breaking every message-only fake. The established idiom is a
  narrow interface asserted at the call site plus a
  `typeof this.client.messages !== 'function'` guard
  (`messaging.ts:522-533`, `:1010-1017`) and a callable test client
  (`app/test/messaging.test.ts:1202-1208`).
- "One page plus a token for the next" maps to the SDK's `messages.page(...)`
  and `messages.getPage(nextPageUrl)` (twilio `message.d.ts:585-586`, `:540`;
  `message.js:462-509`), NOT `messages.list` (auto-walks pages up to `limit`,
  `base/Version.js:356-370`). The token is an ABSOLUTE URL
  (`base/Page.js`, `getNextPageUrl`): keep it in memory within one check, never
  in a job payload. The redirecting dev client rewrites any absolute URL's
  origin (`adapters/twilioHttpClient.ts:37-41`), so a fake `next_page_uri`
  path round-trips.
- The page size is readable only as `page._payload.page_size` (typed public
  on `base/Page.d.ts`); that is the "asserts the size it asked for" hook.
- twilio-node 6 throws `TwilioServiceException` (not `RestException`) for an
  RFC-9457 body (`base/Version.js:31-51`); it also carries `status` and
  `code`, but `code` defaults to 0 (`base/TwilioServiceException.js`). The D1
  classifier must treat code 0 as absent.
- The SDK deserializers return the RAW input when parsing fails
  (`base/deserialize.js:62-75`): `dateCreated` can be a string and
  `errorCode` a non-number. Guard both in the driver mapping.

### M5. The console driver keeps no send log, and there are many driver instances per process
D17 says the console driver answers from what it sent in-process (spec
:639-640). `ConsoleMessagingDriver.sendPreparedMessage`
(`messaging.ts:1157-1176`) records nothing, and `createMessagingAdapter` is
called independently at ~18 sites (e.g. `services/sendMessage.ts:308`,
`jobs/relayFanOut.ts:734`, `jobs/relayRetryLeg.ts:354`, `worker.ts:338`), so a
per-INSTANCE store would never see another instance's sends. It must be a
module-level (bounded) store.

### M6. fake-twilio: storage, timestamps and seam keying
- `ConversationStore` has a private `bySid` map but no public getter
  (`fake-twilio/src/engine/store.ts:5-39`); fetch needs one.
- `ThreadMessage.body` (`engine/types.ts:36-51`) is what the fake-phones UI
  and the e2e proof-of-send read (`e2e/fixtures/fakeTwilio.ts:201-211`). Smart
  Encoding (D19) must be applied ONLY when serializing list/fetch responses,
  never to the stored body: 26 files under `e2e/tests` contain curly quotes,
  em dashes or ellipses.
- The create response mints its own `date_created`
  (`routes/rest.ts:67`) separately from the stored `createdAt`
  (`engine/engine.ts:429`); a second boundary between them gives one message
  two creation times. Derive list/fetch `date_created` from the stored value
  (RFC 2822, second resolution) and preferably make create use it too.
- There is no `date_sent` in the store; derive it from `updatedAt` once the
  state reached `sent`, else null.
- Key the fail-next-send seam by PARTY NUMBER, like the delivery profile
  (`engine/engine.ts:166-172`, consumed per `to` at `:463-464`;
  `e2e/fixtures/fakeTwilio.ts:354-373`). Parallel Playwright workers share one
  fake per lane; a global "next send" is racy.
- `reject` must neither record the message nor consume the armed delivery
  profile; `accept_then_drop` records (and so consumes the profile and
  schedules callbacks at 150/300 ms - `engine/delivery.ts:29-30`,
  `engine.ts:471-536`) before destroying the socket.
- The router has only the POST (`routes/rest.ts:33`); the GET list on the same
  path and GET `.../Messages/:sid.json` are new (Express 5 accepts the
  `:sid.json` shape - `routes/voiceRest.ts:184`). The fetch URI the SDK calls
  is `/Accounts/{AccountSid}/Messages/{Sid}.json` (twilio `message.js:38`); an
  unknown SID should answer 404 with `code: 20404`.

## LOW / RECORD

- **L1. Native group-text legs are unidentifiable candidates.** Their SMxx is
  stored only inside the group row's slot (`messagesRepo.ts:3728-3731`,
  `:3760-3782`), with no `sid#`/`relaysid#`/`syssid#` pointer, and the fake
  keeps them in the same party thread (`engine.ts:332-355`) from the business
  number. A broadcast lookup (To = tenant, From = business number) during a
  group text sees them as unmatched candidates, so a genuinely unsent recipient
  ends `unresolved` at check 3 instead of `never_sent`. Safe direction; name it
  among D16's causes.
- **L2. `touchLastActivityPreservingStatus` has no monotonic guard.** It SETs
  `last_activity_at` unconditionally (`app/src/repos/conversationsRepo.ts:1623-1645`).
  D15's "never moves last_activity_at backwards" (spec :575-576) holds only
  because the relay retry job passes `now` (`relayRetryLeg.ts:662-666`).
  Adoption must pass `now`, never the provider's date.
- **L3. The sender can be absent.** `sendMessage` pins
  `from ?? config.businessPhoneNumber` (`services/sendMessage.ts:464-473`);
  an unset BUSINESS_PHONE_NUMBER is WARN-only outside production
  (`lib/config.ts:1186-1201`). A record with no sender cannot be listed by
  To+From; decide the verdict for that dev-only case.
- **L4. Status fidelity on adoption.** `mapTwilioStatus`
  (`messaging.ts:558-574`) folds accepted/scheduled/sending into `queued`; the
  D17 port should carry Twilio's RAW status so each owner's D15 mapping is
  expressible. The relay success path writes `sentAt = providerTs`
  (= date_created, `relayFanOut.ts:1495-1507`) while D15 says date_sent (null
  for a queued message). `applyRecipientSendResult` never writes `deliveredAt`
  (only `updateRecipientDeliveryStatus` does, `messagesRepo.ts:3723-3727`), and
  the timeline prefers it (`dashboard/src/routes/contact/Timeline.tsx:524`):
  an adopted-delivered leg shows its sent time.
- **L5. RECORD-phase order differs from the code.** D7a (spec :307) says the
  relay SID pointer is written before the slot; `sendOneRelayLeg` writes the
  slot first (`relayFanOut.ts:1495-1507`) and the pointer second
  (`:1508-1512`), and the webhook's unknown-SID comment describes that order
  (`routes/webhooks/twilio.ts:3359-3362`). The plan must reorder deliberately.
- **L6. Reserved words.** `state` and `status` are DynamoDB reserved words;
  alias every record attribute with `#` names, as the file does throughout.
- **L7. Fence on `attemptNo` as well as `attemptedAt`.** Every later write is
  conditioned on `attemptedAt` equality (spec :383-386); two claims inside one
  millisecond would share it. `attemptNo` is monotonic and costs nothing to add.
- **L8. Stage 2 discoverability.** Per-owner partitions cannot be enumerated
  without a Scan (no GSI). The existing discovery mechanism is a
  deadline-prefixed due partition (`MessageDueRow`, `messagesRepo.ts:303-309`;
  `listDueRows`, `:3863-3898`). Either write one with the claim or record the
  Scan cost for the Stage 2 sweeper.
- **L9. TTL documentation.** `lib/tables.ts:213-230` enumerates every family
  that sets `expires_at` and says TTL is only a backstop behind a consume step.
  The record has no consume step, like `syssid#` (`messagesRepo.ts:3830-3835`);
  add it to that list as a stated exception. `expires_at` is epoch SECONDS
  (`:3836`; `services/groupSend.ts:684` for the 30-day due-row horizon,
  `GROUP_DUE_CLEANUP_MS` at `messagesRepo.ts:384`).
- **L10. Item-size headroom.** The recipients map lives on the broadcast item,
  capped at 1500 slots budgeted at 150-200 bytes each (`broadcastsRepo.ts:55-67`).
  `attemptedAt` adds ~35 bytes per slot (~52 KB at the cap) toward the 400 KB
  item limit.
- **L11. `ReturnValuesOnConditionCheckFailure` gives raw AttributeValues.**
  The one precedent (`app/src/repos/poolNumbersRepo.ts:564-590`) only tests
  `err.Item === undefined`; reading fields from it needs `unmarshall`, and
  `@aws-sdk/util-dynamodb` is not a direct dependency of `app/package.json`.
  Prefer the file's CCF-then-ConsistentRead idiom.

## INFO (no correction; the plan relies on these)

- **In-process queue never redelivers.** An immediate dispatch failure is
  caught and logged (`adapters/scheduler.ts:193-204`); a delayed one fires via
  `void this.deps.dispatch(wire)` (`:180-184`), so a throwing reconcile check
  on the lane logs `job failed` (`jobs/jobs.ts:330-341`) plus an
  `unhandledRejection` ERROR (`lib/errors.ts:128-131`) and is never retried.
  In unit tests `deliverDelayed` (`scheduler.ts:223-229`) re-reads the queue
  each loop, so a check that enqueues its successor runs the whole chain in
  one call.
- **Enqueue failure surface.** Only the SQS producer's `SendMessage` throws to
  the caller (`scheduler.ts:349-367`); in-process enqueue throws only from
  `buildEnvelope`'s hop guard (`jobs/jobs.ts:164-171`) or an unconfigured
  adapter (`:119-123`).
- **Lane seams.** `E2E_RELAY_RETRY_BACKOFF_MS: '10000'`
  (`scripts/e2e-session.mjs:272`), `E2E_SEND_RETRY_BACKOFF_MS: '10000'`
  (`:282`; its comment already names this branch as a reuser). The topology
  guard is the `process.env['JOBS_QUEUE_URL']` presence test inside each job
  module (`jobs/relayRetryLeg.ts:206-212`, `jobs/retrySend.ts:110-117`);
  `lib/config.ts` holds only the production fail-fast on the jobs wiring
  (`:1103-1114`).
- **The brief's "already sent" cite moved.** `priorRecipientContactIds` is at
  `broadcastsRepo.ts:576-619`; it counts `failed` slots, so a `failed` +
  `send_unconfirmed` slot counts as already sent - as Sec 2a states.
- **Messages-table stream.** `stream: 'NEW_AND_OLD_IMAGES'`
  (`lib/tables.ts:211`) has no consumer in `app/src` or `infra`
  (only the `stream_arns` output, `infra/modules/dynamodb/outputs.tf:11-14`);
  a new item family is inert there.
