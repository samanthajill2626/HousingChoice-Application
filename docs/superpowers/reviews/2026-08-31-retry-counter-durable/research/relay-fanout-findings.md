# Slice 3 (relayFanOut) - what the tree holds that the spec/plan does not

Read-only research, subsystem `app/src/jobs/relayFanOut.ts` + `app/test/relayFanOut.test.ts`,
against worktree `W:\tmp\retry-counter-durable` at HEAD `8c8b7100` (main merged).

Byte-exact quotations, current line ranges, the enqueuer table and the test
skeletons are the SEPARATE reference artifact at
`.superpowers/sdd/research/relay-fanout-reference.md` (gitignored, per the
one-file-one-kind rule). This file carries only corrections and omissions.

Findings are ordered by how much they can cost the build.

---

## F1 (headline, and it is GOOD news). The merge changed NOTHING inside the fan-out handler. Every slice-3 anchor is correct, shifted +369 lines.

The mission brief and the plan both assume the +523-line merge invalidated slice
3's anchors. It did not. `git diff 5ce9912f 8c8b7100 --unified=1 -- app/src/jobs/relayFanOut.ts`
produces twelve hunks; the last one that precedes the `RELAY_FANOUT_JOB` handler
is `@@ -327,2 +656,42 @@` and the next is `@@ -633,4 +1002,7 @@`. Old lines
329..632 map to new 698..1001 as pure context. The whole handler (new
`relayFanOut.ts:697-967`) is BYTE-IDENTICAL to `main@5ce9912f`.

Verified by blob comparison, not by arithmetic alone:
`git show 5ce9912f:app/src/jobs/relayFanOut.ts | sed -n '434,438p'` returns the
same text as new `:803-807`.

**Offset = +369.** Plan slice 3's "~:434-438" -> `:803-807`. Slice 6's
`relayFanOut.ts:532-534` false comment -> `:901-903`. The plan's `let messages`
"~:321/:332" -> `:645` (declaration) and `:701` (the fan-out `??=`).

The +523 lines are, in full: imports (`:25-57`), the owner-routed composition
block (`:247-565`), four new optional repos on `RelayFanOutJobDeps`
(`:620-628`), the `resolveOwnerInputs` closure (`:665-695`), and edits inside the
`RELAY_INTRO_JOB` (`:977-1039`) and `RELAY_MEMBER_ADDED_JOB` (`:1048-1113`)
handlers.

The anchor "immediately after the recipient derivation, before the send loop" is
in the RIGHT place for every path that reaches this handler. There is no second
entry point, no second send loop, no second continuation, and no new early
return above the derivation.

## F2. Tour reminders never enter this handler, so "the recipient set" is unchanged. The plan does not say so, and a builder chasing the merge could look for a composed path that does not exist.

`jobs/tourReminders.ts` does not import `relayFanOut.ts` at all (the only
mentions are prose, `tourReminders.ts:173` and `:676`). It sends through
`sendRelayAnnouncement` (`tourReminders.ts:61` import, `:1506` call), which is
`services/relayAnnouncements.ts` - a DIFFERENT send path that seeds its own
`delivery_recipients` (`relayAnnouncements.ts:213-215, :227`) and never enqueues
`RELAY_FANOUT_JOB`.

`relayFanOut.ts` imports the same module (`:55`) and re-exports
`isMemberSuppressed` (`:61`) for historical callers. That re-export is the only
edge between the two files, and slice 3 does not touch it.

**Named shared helper**, since the brief asks: `services/relayAnnouncements.ts`
(both call it) and `messagesRepo.setRecipientDelivery` (both write slots through
it). Slice 3 only CALLS them. The one real cross-file obligation is slice 0/1
adding `claimFanoutPass` to the `MessagesRepo` interface - which
`relayAnnouncements.ts` and `groupReceipts.ts` inherit but never call.

## F3. There is NO existing relay cap test to rewrite. The plan says "slice 2's list adapted" and slice 2d's "the existing cap test WILL GO RED"; for relay there is nothing to go red, which means the cap-close shape ships today with ZERO coverage.

`app/test/relayFanOut.test.ts` has exactly one continuation test,
`:481-506`, and it drives a single pass. It asserts `payload.attempt === 2`
(`:503`), `payload.recipientKeys === ['c-bob']` (`:502`), and
`delaySeconds === 5` (`:505`). Nothing in the file seeds `attempt: 3` or reaches
`if (nextAttempt > MAX_FANOUT_ATTEMPTS)` (`relayFanOut.ts:940`).

Consequences the plan does not state:

- **Nothing in the relay test file goes red from the counter change.** The one
  continuation test still passes after slice 3: `nextAttempt = claim.attempt + 1
  = 2`, and `fanOutBackoffMs(claim.attempt = 1) = 5000`. Both assertions hold.
  The plan's slice-2d framing ("keep every existing assertion, do not weaken
  it") has no relay analogue.
- Slice 3's close A test is therefore not a REWRITE but a NEW test, and it is
  the only thing that will ever have covered `relayFanOut.ts:940-951`.
- There is also no assertion anywhere of the pass 2->3 delay (10s). Spec 7.5
  ("the backoff delays both equal main's, on BOTH ladders") is currently
  unmet for relay in either direction.

The plan's slice-3 table row `cap test | if (nextAttempt > MAX_FANOUT_ATTEMPTS) | deleted`
is accurate about the production line. It is the test-side sentence that is
imported from slice 2 and does not apply.

## F4. `payload.attempt` is NEVER undefined, so `payload.attempt ?? 1` is dead code - and `RelayFanOutPayload.attempt?: number` is a lie about the parsed value.

`parseRelayFanOutPayload` (`relayFanOut.ts:131-165`) computes `attempt` at
`:149-152` with an unconditional `: 1` fallback and spreads it unconditionally at
`:162`. Every handler entry is through that parser (`:698`).

So both `?? 1` sites - `:939` (`nextAttempt`) and `:964` (the backoff argument) -
are unreachable branches. This matters twice:

- The plan asks me to "confirm the backoff argument is `payload.attempt ?? 1`".
  Confirmed at `:964`, but the effective argument is simply `payload.attempt`.
- Slice 3 replaces it with `fanOutBackoffMs(claim.attempt)`. The claimed
  attempt and the envelope attempt agree on every path the ladder produces
  today, so this is a safe swap - but only because of the parser default, not
  because of the `??`.

## F5. `fanOutBackoffMs(3) = 20s` is unreachable on this ladder. Two comments say otherwise, and one of them sits inside the region slice 3 edits.

Because relay passes the CURRENT pass number rather than the next one, the
ladder is:

| pass | `nextAttempt` | cap test `> 3` | backoff arg | delay |
|---|---|---|---|---|
| 1 | 2 | false | 1 | **5000 ms** |
| 2 | 3 | false | 2 | **10000 ms** |
| 3 | 4 | **true** | - | cap-close, no enqueue |

`relayFanOut.ts:77` (`/** Exponential backoff ... : 5s, 10s, 20s. */`) and
`:935` (`(5/10/20s is well within the 12min cap)`) both describe a third rung
that never fires. `:935` is inside the continuation block slice 3 rewrites.

This is not a behavior bug and D7/D11 forbid changing the timing. It is a
comment that will mislead whoever verifies "the delays equal main's" - the
literals to assert are **5s and 10s only**, which is what the plan already says
("relay pass 1->2 = 5s, 2->3 = 10s"). Flagging so the 20s in the comment is not
mistaken for a third assertion to write.

## F6. The payload field is `relayConversationId`. There is no `conversationId` on it.

`RelayFanOutPayload` (`relayFanOut.ts:108-129`) declares
`relayConversationId: string` at `:109`. Plan slice 3b says the counter key is
"`conversationId` + `sourceTsMsgId`", and the brief's question 1 asks for a
`conversationId` field. The repo signature's first parameter is a conversation
id; the CALL SITE must pass `payload.relayConversationId`. `markRecipient`
already does exactly this (`:1124`).

Small, but `payload.conversationId` compiles to `undefined` under no error if
anyone spreads the payload into a loosely-typed helper, and the log fields in
this file are all named `conversationId:` while reading
`payload.relayConversationId` - which is the exact shape that makes the mistake
easy to miss on review.

## F7. Slice 3a's `pending` guard cannot be lifted from slice 2. `recipients` holds participant OBJECTS, and the terminal check lives inside the loop.

Slice 2a's guard is `keys.filter((k) => !isTerminal(broadcast.recipients?.[k]?.status))`.
In relay, `recipients` (`relayFanOut.ts:803-807`) is
`ConversationParticipant[]`, and the terminal test is done per-iteration at
`:813-817` against `sourceMessage.delivery_recipients?.[key]`. The guard must
map through `relayMemberKey(m)`:

```ts
const pending = recipients.filter(
  (m) => !isTerminal(sourceMessage.delivery_recipients?.[relayMemberKey(m)]?.status),
);
```

`sourceMessage` is bound at `:755` and is a single point-in-time read, so the
pre-loop guard and the in-loop skip read the SAME snapshot - which is what makes
them agree. Note the resulting `pending` is participants, but `closeRelay` wants
member KEYS; slice 3d's signature `closeRelay(memberKeys, code)` needs a
`.map(relayMemberKey)` at the call site.

Related, and worth stating rather than discovering: D6's "known bounded
deviation" is WIDER on relay than the plan's slice-2a paragraph admits. Relay's
in-loop skips include the opt-out suppression at `:824` (an async repo read per
member). A pass whose every recipient turns out suppressed still consumes a rung.
Same accepted trade, one extra reason.

## F8. `relayQueuedMessages.ts:93` - "never fanned out before" is CONFIRMED, and the plan's "confirm that by reading" is now discharged.

Chain, all four links verified:

1. `queued_pending` is written at exactly one site, `app/src/routes/api.ts:1711`,
   inside `if (conversation.status === 'connecting') {` (`api.ts:1692`). That
   branch returns at `api.ts:1743` and contains no `enqueueImmediate`; its
   docblock states it (`api.ts:1689`: "No provider send + NO fan-out enqueue
   happens here").
2. `ALLOWED_PRIOR.queued_pending = []` (`app/src/repos/messagesRepo.ts:121`).
   Nothing can transition INTO `queued_pending`; `messagesRepo.ts:110` calls it
   "the earliest state - forward-only".
3. `flushQueuedMessages` collects only rows still `queued_pending`
   (`relayQueuedMessages.ts:64`), flips to `queued` (`:89`), then enqueues
   (`:93`). A re-entry finds already-released rows excluded by the filter, so no
   message is enqueued twice - including via the crash-recovery re-flush at
   `app/src/jobs/relayNumberReady.ts:113`.
4. Belt and braces: a fan-out that somehow ran on a still-connecting group would
   hit early return #3 (`conversation.status !== 'open'`, `relayFanOut.ts:742`)
   before any claim anchor.

A flushed message's `fanout_attempt` is absent and claims at 1 (D4). **No
inherited-budget hazard.**

One adjacent hole noticed, NOT this branch's business and not proposed as work:
`relayQueuedMessages.ts:89` flips the status BEFORE `:93` enqueues, so a crash
between them strands the message (`queued`, never fanned out, and the re-flush
filter will not pick it up). Pre-existing, orthogonal to the counter.

## F9. The team-send hub message's `delivery_status` is not just "possibly masked by a rollup" - there is NO relay rollup at all, and a team-send hub sits at `queued` forever.

The slice-7 follow-up item says to file "whether `closeRelay` should also drive
the hub message's own `delivery_status` to terminal (verify first - the rollup
may already mask it)." Verified: there is no rollup on this path.

- The relay leg's webhook branch is `handleRelayRecipientStatus`
  (`app/src/routes/webhooks/twilio.ts:2353-2404`). It calls
  `messages.updateRecipientDeliveryStatus(...)` at `:2360` and nothing that
  touches the parent row's status.
- `deriveGroupDeliveryStatus` (`app/src/services/groupDelivery.ts:98`) has two
  callers: `services/groupReceipts.ts:348` (inside `rollUpAggregate`) and
  `services/groupSend.ts:617`. `groupReceipts` is imported only by
  `routes/webhooks/twilioConversations.ts:35`, `services/groupSend.ts:79` and
  `services/groupSendStaleness.ts:46` - the NATIVE group-text path, not relay.

So:

- an inbound relay source is appended `delivery_status: 'delivered'` and never
  revisited;
- a team-send relay source is appended `delivery_status: 'queued'`
  (`app/src/routes/api.ts:1794`) and **no relay code path ever advances it** -
  it stays `queued` even after every leg has failed.

`ALLOWED_PRIOR.failed = ['queued', 'sent']` (`messagesRepo.ts:131`), so a
`closeRelay` that also called `updateDeliveryStatus(provider_sid, 'failed',
code)` would be a legal forward-only transition on a team-send hub. The
follow-up filing should say "there is no rollup", not "the rollup may mask it".

## F10. The test fixture seeds `delivery_recipients` ABSENT, but production seeds it `{}`. The harness fake papers over the difference, so spec 7.4's "seeded EMPTY" case is not what the existing fixture builds.

Spec 7.4 and plan slice 3 both require close B on "a relay INBOUND source
message whose `delivery_recipients` is seeded EMPTY". Production does exactly
that: `app/src/routes/webhooks/twilio.ts:598` appends `deliveryRecipients: {}`,
and the comment at `:585-590` explains that the empty parent exists precisely so
the fan-out's child-only SET has something to write into.

The test fixture does not. `seedSource` (`app/test/relayFanOut.test.ts:74-92`)
omits `delivery_recipients` entirely, as does the media describe's
`seedMediaSource` (`:932-956`).

That divergence is invisible today only because the harness fake tolerates it:

```
app/test/helpers/twilioWebhookHarness.ts:1340
      item.delivery_recipients = { ...(item.delivery_recipients ?? {}), [memberKey]: delivery };
```

The real repo does not - `messagesRepo.ts:2781` is
`UpdateExpression: 'SET delivery_recipients.#mk = :d'` with only
`attribute_exists(tsMsgId)` as its condition, and DynamoDB rejects a SET on a
child of an absent map.

Add `delivery_recipients: {}` to the inbound fixture (or a variant) so the close
B test exercises the shape production actually produces. Otherwise the "would
pass vacuously" trap the spec warns about is replaced by a subtler one: a test
that passes against a shape the database would refuse.

## F11. D2's premise is true for relay, but its blanket phrasing is not - one of the two slot writers is child-only.

The spec says "Both per-recipient slots are rewritten WHOLESALE on every pass
(`setRecipientDelivery`, `setRecipient`)". For the fan-out's own writer that is
correct: `setRecipientDelivery` is a blind whole-slot SET
(`messagesRepo.ts:2781`; interface docblock `:1310-1317` says "A blind SET on the
nested map slot").

But the OTHER writer on this map, `updateRecipientDeliveryStatus`
(`messagesRepo.ts:2815-2860`), writes CHILD FIELDS only - its docblock at
`:1330` says "WRITES CHILD FIELDS, never the whole slot (spec 15.2b)". It would
NOT erase a slot-resident counter.

D2's DECISION is unaffected (the fan-out never uses that writer, so a
slot-resident counter would still read 1 forever). Recording it because D2 is
called "the single most important constraint in the document" and a reviewer who
checks it against `updateRecipientDeliveryStatus` will find the stated reason
false and may conclude the decision is wrong.

## F12. Six early returns, not five.

The brief says "there were five pre-merge; count them now." There are SIX, and
because the handler is byte-identical there were six pre-merge too. In order,
all above the recipient derivation at `:803`:

1. `:717` duplicate delivery (`!first` on `putJobExecutionMarker`, `:714`)
2. `:729` conversation not found
3. `:742` **AF-2 status gate** - `conversation.status !== 'open'`
4. `:747` no pool number
5. `:758` source message not found
6. `:792` source has neither text nor media

The easily-missed one is #3, the AF-2 gate (`:731-743`). It is also the one that
makes F8's link 4 hold.

There is no seventh return for an empty recipient set: if `recipients` is empty
the loop does not run, `transientRemaining` stays empty, the continuation `if`
at `:938` is skipped, and the handler falls off the end at `:967`. A `pending`
guard that returns early on an empty set would therefore CHANGE nothing
observable - which is worth knowing before someone adds a return and a log line
that fires on every all-terminal continuation.

## F13. Slice 0's fake enumeration is exact post-merge - but the relay tests' runtime exposure is wider than the four files it names.

`grep -rn ": MessagesRepo = {" app/test` -> three: `helpers/twilioWebhookHarness.ts:1054`,
`scheduledSendSuppression.test.ts:261`, `sendMessage.test.ts:210`.
`: BroadcastsRepo = {` -> one: `helpers/twilioWebhookHarness.ts:2663`. Exactly
the plan's list. Typecheck surface confirmed unchanged by the merge.

The RUNTIME surface is larger and the plan does not mention it: thirteen test
files call `registerRelayFanOutJobHandler` (`devRelayReplay`,
`inboundMessagePush`, `mmsMedia`, `placementsApi`, `placementsRelay`, `relayApi`,
`relayFanOut`, `relayOwner.integration`, `relayQueuedMessages`, `relayWebhook`,
`rosterActionsPoll`, `toursApi`, plus `relayProvisioning` which imports the
constants only). All of them wire `world.messagesRepo` from `createFakeWorld()`,
so the single harness fake covers all thirteen - which is good news, and is
exactly why the plan's warning that the harness fake "must model the real
semantics" is the load-bearing sentence in slice 0.

Separately, `as unknown as MessagesRepo` casts exist at
`emailEvents.test.ts:101,365,393`, `rateLimit.test.ts:350`,
`relayProvisioning.test.ts:367,518`, `sendEmailMessage.test.ts:115`. These do not
break typecheck and none exercises the fan-out handler, so they need nothing -
but a builder grepping for `MessagesRepo` will hit them and should not
"fix" them.

## F14. Nil results, recorded.

- **No merge-added test touches the continuation/cap region.** The
  `relay.fanOut (M1.7)` describe's only merge hunks land at new `:634-711` (the
  relay.intro / relay.memberAdded tests); the `+567` block lands at new `:1052`,
  after the media describe. `git diff 5ce9912f 8c8b7100 --unified=0 -- app/test/relayFanOut.test.ts`.
- **No new payload fields.** `RelayFanOutPayload` is unchanged by the merge.
- **No second send loop and no second continuation** anywhere in the file.
- **`configureOutboundQueue` is already the seam**, used at
  `relayFanOut.test.ts:118`, `:925` and `:1473`. The plan's slice-2 instruction
  ("not `vi.mock('./jobs.js')`") transfers to relay verbatim - the file never
  mocks the jobs module.
- **`finalize` / `bumpStats` / progress emit / `sending` do not exist in
  `relayFanOut.ts`.** Slice 3d is correct: `grep -n "finalize|bumpStats|emitBroadcastProgress"`
  over the file returns nothing.
- **The plan's other repo anchors survived the merge unchanged**:
  `MessageItem.retry_attempt` at `messagesRepo.ts:873`; `getByTsMsgId` interface
  `:1236` / impl `:2740`, and the impl is a bare `GetCommand` with no
  `ConsistentRead` (`:2741-2743`) - the plan's "do not reuse the existing
  getter" trap is real.
- **`routes/webhooks/twilio.ts:695`** (enqueuer #1) is inside the file spec Sec 2
  fences in its entirety, and needs no change: it passes neither `attempt` nor
  `recipientKeys`.
