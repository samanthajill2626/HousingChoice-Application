# Research findings - repos + DynamoDB Local conventions (slices 0 and 1)

Read-only pass over the LIVE tree at HEAD `8c8b7100` (main merged). Byte-exact
quotations, the full implementation list and the integration-test skeleton are
in `.superpowers/sdd/research/repos-reference.md`. This file records ONLY what
the tree contradicts, what the plan omits, or what changes a decision.

Verified correct and NOT repeated below: the plan's four hand-written repo
literals (confirmed exactly, no fifth); `retry_attempt` at
`app/src/repos/messagesRepo.ts:873`; both single-item getters eventually
consistent (`messagesRepo.ts:1236` / `:2740-2745`, `broadcastsRepo.ts:385-388`);
`ADD` needs no seeding step on a top-level scalar; D2 itself.

---

## F1 [med] The `UPDATED_NEW` precedent is misattributed, and the open "UNVERIFIED" question is answerable from this repo

`design-review/adjudications.md:609-610` and
`design-review/spec-r5-scalar-check.md:199-206` cite
`app/src/repos/conversationsRepo.ts:1814` and `:1631` as the in-repo precedent
and then flag `ReturnValues: 'UPDATED_NEW'` as "UNVERIFIED, asserted from the
AWS contract rather than executed here".

Both cited sites use `ReturnValues: 'ALL_NEW'`, not `'UPDATED_NEW'`
(`conversationsRepo.ts:1634`, `:1817`). They are valid precedent for `ADD` on an
absent top-level numeric and nothing more.

The precedent that actually covers the whole slice-1 primitive lives in the file
being edited: `app/src/repos/messagesRepo.ts:3131-3155` is a conditional `ADD`
on a top-level scalar with `ReturnValues: 'UPDATED_NEW'` (`:3148`), the new value
read straight off `Attributes` (`:3151`), and the refusal caught with
`instanceof ConditionalCheckFailedException` (`:3153`) and disambiguated by a
`ConsistentRead: true` Get (`:1800-1802`). Its twin is at `:1823-1860`. The
`UPDATED_NEW` shape is pinned by an existing unit test,
`app/test/groupCrossCheckClaims.test.ts:204`, and the
"throw if `UPDATED_NEW` returned nothing" guard has a precedent at
`app/src/repos/usersRepo.ts:543-546` and `:568-571`.

Consequence: the residual risk the adjudication left open is closed, AND the
implementer should copy `messagesRepo.ts:3131-3155` rather than the
`conversationsRepo` sites, which would hand back the whole item.

## F2 [med] There is no `messagesRepo` integration suite - and `broadcastsRepo.integration.test.ts` already covers BOTH repos and BOTH tables

The plan (slice 1) says the claim tests belong "in the integration suites",
implying one to mirror per repo. `app/test/*.integration.test.ts` has 33 files
and none is a messagesRepo suite.

`app/test/broadcastsRepo.integration.test.ts` is not a broadcasts-only file: it
declares `const bases = ['broadcasts', 'messages'] as const;` (`:57`), creates
both tables in one `beforeAll` (`:59-63`), and instantiates BOTH
`createBroadcastsRepo(repoDeps)` and `createMessagesRepo(repoDeps)` (`:54-55`).
Its existing cases at `:140-230` already exercise `messages.append` +
`setRecipientDelivery` + `updateRecipientDeliveryStatus` against real DynamoDB
Local. That is one file to extend, not two to write.

Its header comment (`:1-11`) scopes the file narrowly to nested-map
UpdateExpression semantics, and its describe title is
`'broadcast + relay repo UpdateExpressions against DynamoDB Local'` (`:47`).
Both need widening in the same change, or the added cases read as off-topic.

Note the file mints its own `hc-test-<uuid>-` prefix, so it must NOT carry the
`hc:dynamo-lane shared` marker (`app/test/setup/dynamoAccessKey.ts:68`, `:82`).

## F3 [med] Slice 0's item 4 ("add a test-only way to SET the counter") is already satisfied - and its one real trap is elsewhere

`FakeWorld` already exposes both stores: `messages: MessageItem[]`
(`app/test/helpers/twilioWebhookHarness.ts:208`, returned at `:3721`) and
`broadcasts: Map<string, BroadcastItem>` (`:304`). Both fan-out suites already
reach in - `app/test/broadcastFanOut.test.ts:380` uses
`world.broadcasts.get('bcast-1')!` and `app/test/relayFanOut.test.ts:90` pushes
straight onto `world.messages`. No new hook is needed for close B.

The trap the plan does not name: the broadcasts fake's `getById` returns a
SHALLOW COPY (`twilioWebhookHarness.ts:2688-2691`, `return b ? { ...b } : undefined;`).
Seeding `fanout_attempt` on a `getById` result is a silent no-op, and the fake's
`claimFanoutPass` must mutate `broadcasts.get(id)`. The messages fake has no
such copy - `getByTsMsgId` (`:1267-1269`) returns the stored object by
reference.

Second, smaller: the broadcasts fake throws a synthesized
`ConditionalCheckFailedException` for a missing item on every mutating method
(helper at `:474-475`; used at `:2701`, `:2727`, `:2742`, `:2754`, `:2761`).
`claimFanoutPass` must break that pattern and RETURN `{ outcome: 'missing' }`,
or the "missing item" branch can never be exercised through the fake.

## F4 [med] The slot-survival test must use `setRecipientDelivery` / `setRecipient` - the other per-recipient write would NOT be red on main

D2 says both recipient slots "are rewritten WHOLESALE on every pass". True for
`setRecipientDelivery` (`app/src/repos/messagesRepo.ts:2781`,
`UpdateExpression: 'SET delivery_recipients.#mk = :d'`) and `setRecipient`
(`app/src/repos/broadcastsRepo.ts:615`, `UpdateExpression: 'SET recipients.#ck = :rec'`).

But `updateRecipientDeliveryStatus` (`messagesRepo.ts:2789-2863`) writes CHILD
FIELDS ONLY - `sets` is assembled at `:2820-2837` as
`delivery_recipients.#mk.#st = :s` plus optional `#ec`/`#da`/`#sid`, precisely so
a concurrent targeted write is not discarded (`:2814-2819`). A slot-resident
counter would SURVIVE that path.

The plan's test text says "claim, then `setRecipient` / `setRecipientDelivery`",
which is right, but it does not say why - and a reasonable implementer writing
the "status write" test through the callback path
(`updateRecipientDeliveryStatus`) would produce a test that is GREEN on main and
proves nothing. State the choice and its reason in the test.

Also worth stating: the wholesale rewrite is of the member SLOT, not the ITEM.
No write in either repo replaces the whole item, so a top-level `fanout_attempt`
is safe against every existing path.

## F5 [low] The plan's `ConditionExpression` omits the existence clause's in-repo form, and the attribute should be aliased

Slice 1 specifies `ConditionExpression: item exists AND (attribute_not_exists(fanout_attempt) OR fanout_attempt < :cap)`
without naming the existence predicate. The repos are not symmetric:

- messages uses `attribute_exists(tsMsgId)` - the SORT key, never
  `attribute_exists(conversationId)` (`messagesRepo.ts:2569`, `:2712`, `:2782`).
- broadcasts uses `attribute_exists(broadcastId)` (`broadcastsRepo.ts:595`, `:666`).

Second: every conditional-`ADD` precedent in `messagesRepo.ts` ALIASES the
counter name (`'#b': 'balance'`, `:3141`), which removes the reserved-word
question from the review entirely. Doing the same for `fanout_attempt` costs one
line and one fewer thing to argue about.

## F6 [low] `relayFanOut`'s payload field is `relayConversationId`, and it never calls `getByTsMsgId`

Slice 1 states the messages key as "`conversationId` + `tsMsgId`" and slice 3b as
"`conversationId` + `sourceTsMsgId`". The repo signature is right, but the
caller's fields are `payload.relayConversationId` and `payload.sourceTsMsgId`
(`app/src/jobs/relayFanOut.ts:111`, `:139-140`, `:159`).

More usefully: `relayFanOut` resolves the source message with a WINDOW query,
`listByConversation({ before: bumpKey(payload.sourceTsMsgId) })` at
`relayFanOut.ts:752-755`, not with `getByTsMsgId`. So the plan's "do not reuse
the existing getter" warning has no live tempting caller on the relay side. It
does on the broadcast side: `broadcastFanOut.ts:236` already calls
`broadcasts.getById(payload.broadcastId)` at the top of the handler, and
`:556` calls it again in the finalize path. That non-consistent read is the one
someone will reach for.

## F7 [low] `deriveBroadcastStats` recomputes stats from the recipients map, so "stats reconciled" is ambiguous in slice 2's assertion list

`app/src/repos/broadcastsRepo.ts:211-260`: when `recipients` is non-empty,
`deriveBroadcastStats` computes `audience/queued/sending/sent/delivered/failed/
skipped_*` FROM the slots and IGNORES the persisted counters entirely (`:214-216`
returns the persisted `stats` object only for an EMPTY map).

Slice 2c has `closeBroadcast` call `bumpStats({ failed: 1, queued: -1 })`, and
slice 2's assertion list asks for "stats reconciled (`queued` 0)". Those are two
different numbers: the PERSISTED counter that `bumpStats` moves, and the DERIVED
value every read surface actually shows. The existing cap test asserts the
persisted one (`app/test/broadcastFanOut.test.ts:399`, `bcast.stats.failed`).
Say which the new assertions mean; a close that leaves every slot terminal makes
the derived `queued` 0 regardless of whether the `bumpStats` deltas balance.
