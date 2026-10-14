# Plan research - inbound attribution area: findings

Scope: spec `2026-10-12-last-heard-from-follow-up-status-design.md` sections 5.1,
5.2, invariants I1 and I4, and section 8's app-side units for them. Tree read at
f6aba402 (main merged 2026-10-13). The main merge touched NO file in this area, so
every finding below applies to the spec base too. Only what the tree contradicts or
what a literal builder cannot implement unambiguously is listed. Citation drift that
is only a line or two is in the gitignored reference, not here.

## F1 (high) The email exception keys on the wrong field

The rule (5.1, "EXCEPT an email row with `author: 'unknown'`"), the call-site table
row 8 ("NO touch when the row's `author` is `'unknown'`") and backfill step 3 ("an
unknown-author email is skipped") all treat `author: 'unknown'` as "unverified
sender". The tree also writes `author: 'unknown'` for a VERIFIED sender whose contact
type is not tenant/landlord/partner - an auto-captured stub (`type: unknown`) or a
`team_member` - on both tier 5 and tier 6 (`app/src/services/inboundEmail.ts:381-383`,
`:867`, `:920`). Taken literally, the spec drops real replies from known contacts. The
live path, the backfill and the seed derivation would all agree, so the conformance
test cannot catch it. The row-level marker of an unverified address is
`email_new_address: true` (`inboundEmail.ts:729`, set from `!known` at `:871`). The
live path's equivalent is `threadContact === undefined` (`:872`). Recommend: "an email
row carrying `email_new_address: true` is not attributed", with the live touch gated
on `threadContact`.

## F2 (medium) The 1:1 fallbacks read thread fields, and empty contactIds are unspecified

`participant_phone` and `participant_email` are ConversationItem fields
(`app/src/repos/conversationsRepo.ts:122`, `:130`). MessageItem has neither
(`app/src/repos/messagesRepo.ts:1023-1252`). The rule should say
`thread.participant_phone` and `thread.participant_email` explicitly. A relay
thread's `participant_phone` is the synthetic pool number
(`conversationsRepo.ts:115-121`), so the thread-type branch must come first.
`participants[]` entries legitimately carry `contactId: ''` in three places:

- phone-only relay members (`messagesRepo.ts:196-200`, `app/src/routes/webhooks/twilio.ts:980`)
- imported group rosters (`app/src/lib/import/apply.ts:420`)
- the email-only 1:1 shape `{ contactId, phone: '' }` (`conversationsRepo.ts:1412`)

The rule must say that an empty contactId counts as absent and resolution falls
through to `lookup.byPhone`.

## F3 (medium) The echo-dedupe direction check has no input on five paths

5.1 says that on the deduped branch "the touch is skipped when the persisted row is
not inbound". AppendResult carries no direction (`messagesRepo.ts:1289-1301`). Only
two paths read the persisted row back:

- 1:1: `twilio.ts:2511`
- native group: `twilio.ts:2053`

These five do not:

- relay: `twilio.ts:913-939`
- closed late text: `twilio.ts:1288-1340`
- founder bridge: `app/src/routes/webhooks/voice.ts:779-812`
- masked refused: `voice.ts:1036-1065`
- masked bridged: `voice.ts:1112-1133`

The plan must pick one of two options:

- add a `getByProviderSid` read on those deduped branches, or
- state that echo dedupe cannot reach them and drop the check there. Voice drops a
  From equal to our own or a pool number at `voice.ts:574-584`, and relay legs are
  sent from the pool number.

A deduped row can also live on another conversation (`messagesRepo.ts:1294-1300`;
the 1:1 path adopts it at `twilio.ts:2523`). Attribution and the conformance test
must use the persisted thread, not the request's thread.

## F4 (medium) On the voice paths, `appended` only exists inside the try block

The founder bridge's `appended` is a const inside the try at `voice.ts:778-817`. The
masked paths are the same (`voice.ts:1035-1070`, `:1111-1136`). The touch must sit
inside each try after the append, or the result must be hoisted. The plan should say
which.

Two founder-path refusals return before any append: no holder or no business number
(`voice.ts:677-691`), and a self-call (`:704-711`). They leave no row and therefore get
no touch. G1's "inbound call (any outcome)" should say it excludes them.

## F5 (medium) The backfill's group early stop drops non-roster senders

Step 3 lets a group thread stop "until every roster member has a value". Inbound rows
from senders who are not on the current roster can sit below that stop point, and
their only inbound would then never be attributed. The live paths touch these
senders:

- relay non-members keyed `phone#From` (`twilio.ts:893`)
- staff texting a group from another org number (`twilio.ts:1943-1966`)
- refused non-member calls carrying external-caller fields (`voice.ts:1052-1056`)
- members later removed from the roster

This breaks G1's "SAME attribution rule" for history. Roster members with an empty
contactId, or whose contact was hard-deleted, can never "have a value", so the stop
rarely triggers anyway. Recommend: walk group partitions to exhaustion (the read is
already filtered to inbound, non-retry rows).

## F6 (medium) touchLastHeardFrom's boolean cannot feed the backfill report or the house abort rule

The spec has the writer never throw and return `false` both for "no row / already
later" and for "any other failure". The backfill report (5.2 step 5) needs three
counts: written, skipped, and failed. Ops scripts here abort on non-condition write
failures (`app/scripts/backfill-unread-flag.ts:485-494`,
`app/scripts/enable-conversation-automation.ts:245-261`). With the boolean, a throttled
write is reported as "skipped". Recommend a tri-state result (`written | skipped |
failed`) or a throwing variant for the script.

Logging ownership is also ambiguous. The repo is to "log at error", but the failure
posture quotes a caller-style line ("last_heard_from touch failed - message
persisted...") in the `touchPhoneLastSeen` shape, where the caller logs
(`twilio.ts:2572-2577`). If the repo never throws, a caller catch block is dead code.

## F7 (low-medium) `--env local` is the human's live stack

5.2 says "An agent runs it only with `--env local`". In stageClient, `--env local`
without `--lane` targets the live `npm run dev -- --local` database
(`app/scripts/lib/stageClient.ts:5-10`, `:140`). Agents may only use
`--env local --lane <L>` (`app/scripts/enable-conversation-automation.ts:63-65`; the
AGENTS.md live-stack rule).

## F8 (low-medium) The seed derivation's scope and mutation hazard

The spec says the derivation runs over "lean, or lean + cast". The full profile is
lean + cast + matrix, plus a history pass (`app/src/lib/seed/index.ts:125-144`), so the
hook must sit after the matrix merge (before `:146`). The values do not change: matrix
returns no `messages` table (`app/src/lib/seed/matrix.ts:1473-1488`), and `seedLive`
writes after the Put loop with no message rows.

`seedAll` copies the arrays but not the items (`index.ts:117-119`, `:127-131`). An
in-place stamp would mutate the shared SEED and cast literals that other code reads:

- `app/test/seedData.test.ts:18`
- `app/test/broadcastApi.test.ts:1170`
- `app/test/seedPersonaDrift.test.ts:33`
- `matrix.ts:1459`

The derivation must return copies. It must also:

- skip `phone#` claim rows in conversations
- skip the `sid#` pointer row in messages (`app/src/lib/seed/cast.ts:1168-1173`)
- never stamp the `phoneref#` contact row (`cast.ts:460-469`)

## F9 (low) attributeInbound cannot be both synchronous and asynchronous

The spec says the lookup is "async over contactsRepo for the live paths ...
synchronous over the seed's own contact items". One function cannot return `T` for a
synchronous lookup and `Promise<T>` for an async one without overloads. `seedAll` is
async, so an always-async `attributeInbound` whose lookup may return `T | Promise<T>`
is enough. The spec should state that.

## F10 (low) The dev seams need more than "call the touch too"

The transcript fixture:

- discards the append result
- holds only the messages and extraction repos (`app/src/routes/dev.ts:784-793`, `:851-863`)
- can append an outbound row (`:843`)

The message fixture has two write branches, and both must touch:

- an append (`dev.ts:1056-1092`)
- a direct PutCommand (`dev.ts:1094-1115`), which is outside the spec's cited range
  `:897-1060`

It also accepts an arbitrary `relaySenderKey` (`:904`, `:1074`, `:1104`), so it needs
the full rule over the conversation row.

DevRouterDeps (`dev.ts:106-145`) has no injection point for a contacts or
conversations repo. The only existing test stubs `doc`
(`app/test/devMessageTransportFixture.test.ts:7-23`), and no test drives the
transcript fixture.

## F11 (low) The importer stamp is under-specified

- `runApply` has no contactsRepo: it writes through raw `doc` calls and a
  `BatchWriter` (`app/src/lib/import/apply.ts:359`, `:439-486`, `:1584`). It needs
  `createContactsRepo({ doc, env })`.
- The stamp must run after `messageBatch.flush()` (`:486`) and must be skipped on
  `dryRun`.
- Calling `contactsRepo.findByPhone` right after `upsertContact` hits a GSI that is
  only eventually consistent. This is the exact hazard documented at
  `twilio.ts:1972-1986`. The importer's lookup should use the in-memory
  `contactIdByPhone` map (`apply.ts:297`, `:333`).
- `ApplyReport` (`apply.ts:183-223`) has no counter for stamps. The plan should say
  whether one is added and what a dry run reports.

## F12 (low) Phone-only relay members on paths 2, 6 and 7

Table rows 2, 6 and 7 name "the roster sender" or "the member's contactId from the
roster". A member whose contactId is empty writes `relay_sender_key` `phone#From`
(`messagesRepo.ts:196-200`; `voice.ts:1048`, `:1123`), and the relay path then has no
`senderContact` (`twilio.ts:897`). The touch must resolve through `findByPhone`, as
the rule says.

## F13 (low) Live answers that can differ from the rule

The conformance test ("each live path's touched id equals `attributeInbound` on the
row it wrote") fails in these reachable cases:

- (a) The 1:1 and closed-late-text paths resolve the sender by `findByPhone(From)`,
  but the rule uses `participants[0]`. The two differ when the number moved to another
  contact after the thread's link was written; captureContact keeps the old link
  (`app/src/services/contactCapture.ts:142-146`).
- (b) On the native group path, when the roster contactId has no row, the path falls
  back to `findByPhone` (`twilio.ts:2004-2005`), but the rule returns the roster id.
- (c) Email tier 6 appends into the claim arbiter's conversation
  (`inboundEmail.ts:902-907`). Its `participants[0]` can be a different contact from
  `findByEmail`'s.
- (d) On an email tier 5 thread with no participants, the rule tries
  `participant_phone` before `participant_email`, while the path uses
  `findByEmail(From)`.

Recommend: each live path computes its touch target by calling `attributeInbound`
itself, using the contacts it already holds as a lookup cache. Conformance is then
true by construction.

## F14 (low) I1's grep must also cover contact writers outside contactsRepo

I1 asks the plan to grep every UpdateExpression on the contacts table. Contact writes
also live in:

- `app/src/repos/suggestionResolutionRepo.ts:872-1069`
- `app/src/repos/extractionRepo.ts:792` (a ConditionCheck)
- `apply.ts:684-693`, `:798-804` and `:1181-1191`

All of them SET or REMOVE only named attributes today, and none touches the new field.
The plan should name them so the grep's scope is complete.
