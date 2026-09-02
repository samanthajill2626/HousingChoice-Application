# Spec review R1-A - adversarial - relay 30003 retry lineage

Spec under review: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md`
Worktree verified against: `W:\tmp\relay-30003-retry-lineage` @ `484059cb` (code
identical to base `bb54fdaa`; only docs commits since).

Every citation below was opened and read in this worktree. Anything I could not
establish is marked UNVERIFIED.

Scope discipline: I read Sec 2's non-goals and Sec 10's rejected alternatives
first. Nothing below re-argues in-place promotion, `relay.fanOut` reuse, the
member-key scheme, the reconciliation sweep, or the announcement fence. Findings
17 and 23 are corrections to facts the spec asserts about existing behaviour, not
proposals.

---

## 1. [BLOCKING] A duplicate JOB delivery is not covered by "the create is the claim"

**What is wrong.** D2 says "a duplicate callback, a duplicate queue delivery and
two concurrent callbacks all lose the create and return `deduped: true`", and
Sec 7 test 2 says "The claim is the create, so this is a test of the create
losing." That is true for the two CALLBACK cases and false for the queue case.
The claim (the `append`) happens in the webhook - Sec 9 says so explicitly: "A
crash between the claim and the enqueue strands a retry. The row exists, nothing
sends." The retry JOB therefore receives a payload and performs the SEND with no
`append` to lose. A redelivered SQS message re-sends the text.

**Evidence.** Sec 9 places the claim before the enqueue. D12 requires the same
ordering ("an enqueue failure closes the retry leg terminally" - only possible if
the leg exists first). The repo's actual duplicate-delivery guard for exactly
this shape is `messages.putJobExecutionMarker(jobId, conversationId)`, used by
every job that must not double-send:
`app/src/jobs/relayFanOut.ts:735` (fan-out), `:815` (relay.intro), `:886`
(relay.memberAdded), `app/src/jobs/retrySend.ts:131`. The spec never mentions
`putJobExecutionMarker`, `getContext()?.jobId`, or any job-level guard.

**What it implies.** The build ships a retry that double-sends on any queue
redelivery, and Sec 7 test 2 as written would be built to assert the wrong
mechanism (it would exercise a second `append` that the job never makes) and
would pass while the defect is live. Acceptance criterion 2 of the issue
("a duplicate callback or duplicate job delivery sends no duplicate text") is not
met by the stated design. The spec must name the job-level guard and say how it
interacts with the deterministic-SID claim, or move the claim into the job and
accept the consequences for D12.

---

## 2. [BLOCKING] The retry row's direction/author/transport shape is unspecified, and the only workable choice breaks the dominant relay case

**What is wrong.** The spec never states the retry row's `direction`, `author`,
`transport_schema_version`, `requested_transport`, or the seeded slot's
`transportAggregationState`. Three independent repo constraints force
`direction: 'outbound'` plus schema version 1 plus a `planned` slot - and
`outbound` is precisely what the dominant relay source is NOT.

**Evidence.**

- `assertTransportPersistenceShape` throws `inbound messages cannot request a
  transport` (`app/src/repos/messagesRepo.ts:913-915`), so an INBOUND retry row
  cannot carry `requestedTransport`.
- The extracted loop body D8 reuses calls `persistRelayRecipientResult`, which
  routes to `applyRecipientSendResult` and THROWS on `legacy_noop`
  (`app/src/jobs/relayFanOut.ts:1439-1447`), so the retry row must be a versioned
  (schema 1) row. It also calls
  `setVersionedAggregationState(..., 'attempted', ['attempted'])`
  (`relayFanOut.ts:1180`, definition `:1406-1426`), which only survives from a
  slot that already carries an aggregation state.
- The relay fan-out source for a MEMBER-originated message is INBOUND:
  `app/src/routes/webhooks/twilio.ts:636-650` appends `direction: 'inbound'` with
  an empty recipient map, and `:744-748` enqueues `RELAY_FANOUT_JOB` against that
  row's `tsMsgId`. That is the majority of relay traffic and the exact case the
  issue describes.
- On the dashboard, BOTH the rollup chip and the accessible-name recital are
  gated on `outbound`:
  `dashboard/src/routes/contact/Timeline.tsx:837` (`const outbound = msg.direction === 'outbound'`),
  `:934-940` (`deliveredSummary = outbound && msg.delivery_recipients && ... ? presentRelayDelivery(...) : null`),
  `:968-976` (`rollupName` is undefined when `deliveredSummary === null`). Only
  `showRecipients` (`:948-951`) admits an inbound relay source, and it renders the
  per-recipient ROWS alone.

**What it implies.** Two consequences, both blocking.

(a) Sec 5 says three positions move together (rollup chip, accessible-name
recital, per-recipient row), and D15's whole table is written in chip strings.
On a member-originated relay message, two of those three positions DO NOT EXIST
today. D15 is specified only for team sends and announcements - and announcements
are fenced out by D5. The spec never distinguishes the two source shapes. The
Sec 7 e2e will not catch this: `e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts`
drives a team send, which is outbound.

(b) An OUTBOUND retry row that "inherits the original's sender key" (D5) renders
on the outbound side of the thread, attributed by
`senderLabel(msg.relay_sender_key, roster, kind)`
(`dashboard/src/lib/memberAttribution.ts:105-131`, called at `Timeline.tsx:973`),
which returns the MEMBER's name for a member key. So the retry of a tenant's
message renders as an outbound bubble labelled with that tenant's name, opposite
the inbound original. D19 addresses only the orphan-ordering case, not the side
flip.

---

## 3. [HIGH] D16 deletes the only operator surface D9 and D12 exist to create

**What is wrong.** D9 requires a gate refusal to write "a terminal state on the
retry leg with a close code that says which gate refused". D12 requires an
enqueue failure to write "a close code distinct from cap-exhausted", justified as
"Reusing one code would tell an operator retries ran when none did". D16 then
says "A retry row renders ONLY when its leg delivered." Every one of those close
codes lands on a leg that did not deliver, i.e. on a bubble that never renders.

**Evidence.** D16 (spec Sec 5). D9 and D12 (spec Sec 3). The close codes would be
written into the retry row's own single-entry `delivery_recipients` slot (D1,
D14: `RelayRecipientDelivery` is not changed, and no per-leg retry state is
stored on the ORIGINAL's slot). The original's slot keeps its 30003, so the only
copy an operator can read is the original's
`Phone unreachable (error 30003)` -
`dashboard/src/routes/contact/deliveryStatus.ts:634-636` plus the
`(error <code>)` template at `:731-733`.

**What it implies.** D12's stated purpose is unachievable by D12's own mechanism.
Sec 7 test 5 ("a gate refusal ... leaves truthful copy") and test 6 (a distinct
close code) have no rendered surface to assert against; they can only assert
stored data, which is not what "truthful copy" means. An operator whose retry was
refused because the number changed sees exactly the same string as one whose cap
was exhausted. Either D16 needs an exception for refused/closed retry rows, or
D9/D12's close codes need to be projected onto the ORIGINAL's presentation.

---

## 4. [HIGH] D5's fence fails OPEN

**What is wrong.** D5 makes the fence a NEGATIVE test: `relay_sender_key` "must
not be `system`". The source row it reads is optional at that point in the
handler, so a missing or unreadable source passes the fence.

**Evidence.** `app/src/routes/webhooks/twilio.ts:2449`:
`const source = await messages.getByTsMsgId(ptr.conversationId, ptr.tsMsgId);` -
the repo signature is `getByTsMsgId(...): Promise<MessageItem | undefined>`
(`app/src/repos/messagesRepo.ts` interface). The handler already tolerates
`source === undefined` at `:2451` (`source?.delivery_recipients?.[...]`). With
`source` undefined, `source?.relay_sender_key !== 'system'` is TRUE.

**What it implies.** The spec's stated guarantee "announcements and tour-reminder
rungs cannot be reached" is not delivered by the mechanism. `sendRelayAnnouncement`
has four call sites - `relayFanOut.ts:852`, `relayFanOut.ts:916`,
`relayGroups.ts:635`, `tourReminders.ts:1646` - and all four write `relaysid#`
pointers through the single append at `relayAnnouncements.ts:229-242`. A
transient read miss on an announcement's source row is enough to claim a retry
against a tour-reminder rung, which is another mission's file. The fence must be
POSITIVE (claim only when the source is present AND its sender key is a known
non-system key), and Sec 7 test 4 must cover the missing-source case.

---

## 5. [HIGH] D18 requires editing a shared staleness helper that Sec 2 fences off, and does not say so

**What is wrong.** D18 says a retry that never reaches `sent` "falls to
not-confirmed, aged from the retry row's own creation time", and cites
`deliveryStatus.ts:216-222` as the rule it is overriding. That rule lives in
`stalenessClockMs`, which is shared by relay legs AND native group-text legs, and
whose refusal to age a `queued` leg is deliberate and documented at length.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:206-233`
(`stalenessClockMs`; `case 'queued': return legClock;` at `:217-218`, i.e.
`slot.sentAt` only, no message-clock fallback). Its docblock at `:191-201`
states the reason: a released connect-when-ready hold and a fan-out that never
ran are byte-identical, "so one answer must serve both, and the decided answer is
silence". Both `isStaleLeg` (`:247-255`) and `canEverGoStale` (`:329-342`) route
through it, and `presentLegDelivery` takes a `rosterKind: 'relay' | 'group_text'`
(`:508-513`), so group-text legs use the same clock. Sec 2 fences out "Native
group-text receipts".

**What it implies.** Implementing D18 by relaxing the `queued` case changes
native group-text staleness - a fence violation with no test in the spec to catch
it. Implementing it any other way requires a row-scoped input the spec does not
define (a "this row is a retry, its creation IS its dispatch" flag threaded into
`stalenessClockMs` or a bypass in the caller). The spec names neither the
function nor the scoping mechanism, and D18 is load-bearing: it is the only thing
that stops the crash-strand case in Sec 9 reading "retrying" for ever.

---

## 6. [HIGH] D15 rows 2 and 4 require cross-row arithmetic the spec never specifies

**What is wrong.** `presentRelayDelivery` computes `delivered`, `failed`, `total`
and `stale` purely from the source message's OWN slots. D1 forbids ever rewriting
the failed slot. So on the original bubble:

- Row 2 (`delivered 4/4 - 1 on retry`) requires the delivered retry to be ADDED
  to `delivered` and REMOVED from `failed`.
- Row 4 (`delivered 3/4 - 1 not confirmed`) requires the failed slot to be
  removed from `failed` AND the retry row's own staleness to be counted into
  `stale` on the original's chip.

D17 states only ONE of these subtractions: "A leg awaiting a retry must also be
subtracted from the failed count". It says nothing about promoting a DELIVERED
retry into the numerator, nothing about removing a terminally-refused leg, and
nothing about importing staleness across rows.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:407-456`. Note
`:416` - `if (failed > 0)` is the FIRST branch, so an unsubtracted failed slot
wins over both the stale branch (`:442`) and the all-delivered branch (`:453`).
With the original's slot left at `undelivered` (D1), rows 2 and 4 are unreachable
without the unstated arithmetic; the chip would read
`delivered 3/4 - 1 failed - Phone unreachable (error 30003)` in all four
situations of D15's table.

**What it implies.** Three of the four states in the approved display contract
are not derivable from the design as written. A builder will have to invent the
rule, and D20 (which only threads "recipient ENTRIES and the referencing retry
rows" into the presenter) does not say what the presenter does with them.

---

## 7. [MEDIUM] D2 cites the wrong half of the append transaction, and leaves `providerTs` undefined

**What is wrong.** D2 says "`append` writes the row under
`attribute_not_exists(tsMsgId)` inside a transaction (`:2220`)" and treats that
condition as the claim. That condition is NOT the dedupe. `append` attributes a
dedupe strictly to the SID-pointer item at index 1; a failure of the message
row's own key without the pointer failing is logged at ERROR and RETHROWN.

**Evidence.** `app/src/repos/messagesRepo.ts:2210-2233` (transaction: index 0 is
the message row, index 1 is the `sid#<providerSid>` pointer),
`:2296-2328` ("index 1 is ALWAYS the SID pointer ... the one and only item whose
condition failing means 'this provider message is already persisted'", returning
`{ deduped: true, tsMsgId: ptr.ref_tsMsgId }`), and `:2374-2388` (any other
ConditionalCheckFailed is logged ERROR and rethrown).

The design works ANYWAY, because a deterministic `providerSid` collides the index-1
pointer whatever `providerTs` is - but only by accident of a mechanism the spec
did not describe. And the spec never says what `providerTs` is:
`buildTsMsgId(providerTs, providerSid)` (`messagesRepo.ts:196-198`) takes both
halves, `providerTs` orders the row in the thread
(`dashboard/src/routes/conversation/useRelayThread.ts:41-45` derives `at` from
`provider_ts` or the SK prefix), and the fan-out's source re-read is a five-row
window keyed off the source SK (`app/src/jobs/relayFanOut.ts:771-779`, whose
`bumpKey` docblock at `:1465-1473` explicitly assumes "relay sources are inbound,
one at a time").

**What it implies.** A builder told "the row's creation IS the atomic claim,
`:2220`" may reasonably make `providerTs` deterministic from the root - which puts
the retry row adjacent to the source in the SK order and inside that five-row
window. Or may reasonably write the row with a direct Put rather than `append`,
losing the claim entirely. Specify `providerTs`, and attribute the dedupe to the
`sid#` pointer.

---

## 8. [MEDIUM] Nothing forbids stamping `retry_of` on the retry row, and doing so hides the ORIGINAL

**What is wrong.** D16 says the new render predicate "is NOT a reuse of
`retry_of`" and correctly explains that the existing collapse hides the
PREDECESSOR. It never says the retry row must NOT CARRY `retry_of`. It is the
natural field to stamp: `append` supports it, the 1:1 auto-retry twin uses it,
and it is already projected into the relay thread's wire shape.

**Evidence.** `app/src/repos/messagesRepo.ts:2158-2161` (`retryOf` stamped at
append); `dashboard/src/routes/conversation/useRelayThread.ts:101,124`
(`retry_of` is already projected by the RELAY projector);
`dashboard/src/routes/contact/Timeline.tsx:1787-1799` (the `visible` memo adds
every `retry_of` target to `supersededIds` and filters those items out).

**What it implies.** One stamped field silently deletes the original relay bubble
from the thread - the inversion D16 names but does not prohibit. The spec must
state the prohibition, and Sec 7 item 10 must assert the original still renders
beside the retry.

---

## 9. [MEDIUM] D22 preserves a justification the repo already proves false for native group text

**What is wrong.** D22: "The shared `TRANSIENT_RETRYING_DELIVERY_CODES` set keeps
its current meaning for the 1:1 and native-group-text paths, which this branch
does not touch." Its "current meaning" is the comment "a transient code we're
still auto-retrying (not yet terminal)". For native group text that is false and
the repo says so.

**Evidence.** `app/src/services/sendMessage.ts:294-296` throws
`GroupTextSendNotSupportedError` for `conversation.type === 'group_text'`, and
`retrySend` catches `SendRefusedError` and stops. This is written up in
`dashboard/src/routes/contact/deliveryStatus.ts` (the `RELAY_ERROR_CODE_REASONS`
docblock, roughly `:608-622`): "a native group-text leg promises a retry that
never sends, exactly as a relay leg does ... now PROVEN rather than suspected",
tracked as `group-text-30003-leg-retry-promise-unverified`. The issue this spec
closes (`docs/issues/relay-30003-classified-transient-retrying.md`, last
paragraph) asserts the opposite - "the 30003 arm carries no `group_text` guard,
so a group text retries like a 1:1" - and D22 inherits that disproven premise.

**What it implies.** The branch that fixes the relay half of the contradiction
leaves an identical, already-proven contradiction standing under a comment it
just rewrote, and records "keeps its current meaning" as if that were true. At
minimum the rewritten comment must name the group-text exception and point at
`group-text-30003-leg-retry-promise-unverified`; the spec should not claim the
shared set is correct for group text.

---

## 10. [MEDIUM] D13's inbox bump can REOPEN a closed relay group

**What is wrong.** D13 places a `touchLastActivity` after a successful retry
send. `touchLastActivity` writes `status = 'open'` on any non-`group_text`
conversation. D9's open-group gate runs before the SEND; the bump runs after it,
60 to 240 seconds after the callback that started the chain.

**Evidence.** `app/src/repos/conversationsRepo.ts:1531-1560`, update expression
`SET #s = :open, last_activity_at = :ts, last_message_preview = :preview` with
`:open = 'open'`, guarded only against `group_text`. The rest of the relay stack
treats `status` as the authoritative closed gate precisely because
`pool_number` is kept on close - `app/src/jobs/relayFanOut.ts:751-763` and
`app/src/services/relayAnnouncements.ts:189-206`.

**What it implies.** A relay group closed during a retry's backoff window is
resurrected to `open` by the retry's own bump, contradicting the already-sent
"This group chat is now closed" final message and re-arming every open-gated
path. The spec must either re-check status immediately before the bump or use a
bump that does not write status.

---

## 11. [MEDIUM] The chip reads "1 failed" for the whole first backoff interval

**What is wrong.** The relay branch emits `message.persisted` immediately after
the slot transition to `undelivered`. D13 places the only other live-surface call
after the SEND, which is at least one backoff interval later (D4: 60s). Nothing
in the design emits anything when the CLAIM lands.

**Evidence.** `app/src/routes/webhooks/twilio.ts:2500-2521` - the failure marker
and then `if (transitioned || transportUpdated) events.emit('message.persisted', ...)`.
D13 (spec Sec 3): "the bump is placed after a successful send ... A claimed retry
that is refused at a gate bumps nothing."

**What it implies.** The dashboard refreshes on the failure event, computes D17's
"retrying" predicate against a thread that does not yet contain the retry row
(the claim may not even have run yet - it happens later in the same handler), and
renders `1 failed - Phone unreachable (error 30003)`. It then stays wrong until
the retry sends. That is a 60-second-minimum false terminal state on the surface
this whole feature exists to make truthful, and it is invisible to any unit test
that inspects state after both writes.

---

## 12. [MEDIUM] D7 says four lineage fields, D14 says three reach the wire; the spec never says which is dropped

**What is wrong.** D7: "The retry row carries four lineage fields: the root
message id, the member key of the leg being retried, the destination E164, and
the attempt number ... Both are needed; they are not redundant." D14: "Three
lineage fields are added to `TimelineMessage` and to the relay projector." Four
minus three is one unnamed field.

**Evidence.** Spec Sec 3 (D7) and Sec 4 (D14).

**What it implies.** If the destination E164 is the dropped one, that is a PII
decision the spec makes by omission - and it is the right one, but nobody can
tell whether it was decided or overlooked. If it is NOT dropped, a raw handset
number goes onto the wire and into the client, on a branch whose own D2 already
rules that "a phone number must never enter a sort key" and whose server-side
neighbours redact member phones from logs specifically
(`app/src/services/relayAnnouncements.ts:157-161`, `logSafeMemberKey`). Name the
three.

---

## 13. [MEDIUM] An MMS retry duplicates the media-gallery index rows

**What is wrong.** If the retry row carries `mediaAttachments` (required for D11
to re-presign from durable s3Keys), `append` writes one media-pointer row per
attachment, keyed by the RETRY row's `tsMsgId`, with no condition. The "Media
from comms" gallery is that pointer index.

**Evidence.** `app/src/repos/messagesRepo.ts:261-279` (`mediaPointerItems`, keyed
`mediaPointerPk(conversationId)` / `mediaPointerSk(tsMsgId, index)`) and
`:2286-2290` (written into the append transaction, "No condition"). The pointer
docblock at `:211-231` states the gallery is assembled from these rows.

**What it implies.** One extra gallery tile per attachment per retry attempt - up
to three duplicates of the same photo for one failed leg. Each resolves (the
retry row's synthetic SID has its own `sid#` pointer), so nothing errors; the
gallery just quietly triples. Not enumerated anywhere in the spec, and Sec 8
("No infrastructure, dependency, environment or migration work ... Every new
field is optional and self-creating") reads as though nothing else is written.

---

## 14. [MEDIUM] Sec 2's file list omits surfaces the design demonstrably requires

**What is wrong.** Sec 2 presents an explicit "In" list of nine paths. The design
needs at least these in addition, none named:

- A dev/lane seam for the backoff override that Sec 7's e2e depends on ("gated
  exactly as the other dev seams are and structurally absent in deployed
  environments"). The other dev seams live in `app/src/routes/dev.ts` (see
  `:817-1041`, which also happens to be an unlisted WRITER of
  `delivery_recipients` and `relay_sender_key`) plus the e2e lane env.
- `app/src/worker.ts` - a new job handler must be registered (cf. `:331` for the
  announcement wiring); `jobs/jobs.ts` for the job name/enqueue path.
- `app/src/repos/conversationsRepo.ts` or whichever caller performs D13's bump -
  D13 explicitly places a `touchLastActivity` call somewhere new.
- `dashboard/src/routes/contact/MessageBubble`/`StreamItem` prop plumbing, which
  D20 says must be threaded but Sec 2 covers only as "Timeline.tsx".

**Evidence.** Spec Sec 2 vs D8, D12, D13, D20, Sec 7's e2e paragraph.

**What it implies.** The In-list is used as the scope contract for the build and
for conflict checks against other worktrees. An understated list produces either
a build that stops at the fence or an unreviewed spill.

---

## 15. [MEDIUM] D10's stored composed body makes the retry bubble and the inbox preview disagree with the original

**What is wrong.** D10 stores the composed outbound body - "sender prefix
included" - on the retry row and sends it as stored. The ORIGINAL row stores the
raw body, not the prefixed one.

**Evidence.** For a member-originated source, `twilio.ts:648` persists the raw
inbound `Body`; the prefix is applied only per fan-out at
`app/src/jobs/relayFanOut.ts:996-998` (`composeRelayBody`) and never persisted.
For a team send, `api.ts:1820` persists `bodyText` and the label is applied at
fan-out via `senderNameOverride`. D13's bump calls `touchLastActivity(conversationId, body, ...)`
which writes `last_message_preview` (`conversationsRepo.ts:1541`).

**What it implies.** Where a retry bubble renders (D15 row 2), the thread shows
the same message twice with DIFFERENT text - "hello" on the original and
"Sam: hello" on the retry - which is exactly the "phantom second send" reading
D19 says the `on retry` suffix exists to prevent, arriving by a route D19 does
not cover. And the inbox row's preview is rewritten to the prefixed variant of a
message the operator already read.

---

## 16. [MEDIUM] Hidden retry rows dilute thread pages and corrupt the has-older heuristic

**What is wrong.** Every retry attempt appends a real row to the relay
conversation. D16 renders none of them unless the leg delivered. Thread history
pages by ROW COUNT, and "is there more" is a full-page heuristic.

**Evidence.** `dashboard/src/routes/shared/threadPaging.ts:30`
(`THREAD_PAGE_SIZE = 50`); `dashboard/src/routes/conversation/useRelayThread.ts:167-186`
(`hasOlder` is "a FULL page is read as 'there is probably more'", the server
returns a bare array with no `hasMore`).

**What it implies.** A group with several unreachable handsets can fill a 50-row
page mostly with rows that render nothing, so "Load older" fetches a page and the
transcript barely grows. Worst case per message per failed leg is three hidden
rows. Not fatal, but it is a direct consequence of D1 + D16 and the spec does not
mention it.

---

## 17. [LOW] Sec 1's stated reason `retrySend` is unusable is factually wrong

**What is wrong.** Sec 1: "`retrySend` is also unusable directly: it re-sends
through `sendMessage` to the conversation's `participant_phone`, which on a relay
group is the pool number, not a member." It never gets that far -
`sendMessage` refuses a relay conversation outright.

**Evidence.** `app/src/services/sendMessage.ts:293`:
`if (conversation.type === 'relay_group') throw new RelaySendNotSupportedError(conversationId);`
- the guard is BEFORE `participant_phone` is narrowed (see the comment at
`:291-292`: "the guard also narrows participant_phone to a definite string
below").

**What it implies.** The conclusion (do not reuse `retrySend`) is right; the model
is wrong. A builder reasoning from "it sends to the wrong number" may conclude the
fix is to pass the right number. The true fact is stronger and worth stating: the
1:1 send service structurally refuses relay groups.

---

## 18. [LOW] D15's success strings collide with a shared label the branch is fenced away from

**What is wrong.** D15 proposes `delivered 4/4 - 1 on retry` (original) and
`delivered 1/1 on retry` (retry bubble). The existing all-delivered label is
`Delivered ${total}/${total}` - capital D, success tone - and it is produced by
the same function that serves native group text and the broadcasts routes.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:453-455`; the module
is imported by the broadcasts routes (noted at `:459-465`) and takes a
`LegRosterKind` of `'relay' | 'group_text'`.

**What it implies.** Sec 5 says only "The exhausted string is today's,
unchanged", implying the others change - but changing the success branch touches
a fenced-off product. The spec must say how the new strings are scoped (a
retry-aware option on `RelayDeliveryOptions`, presumably) rather than leaving the
label edit to be discovered.

---

## 19. [LOW] The new close codes need copy entries or they render as carrier errors

**What is wrong.** D9 and D12 introduce app-invented close codes (which gate
refused; enqueue-failed-distinct-from-cap). Unmapped codes fall through
`deliveryReason` to `Delivery failed (error <code>)` - i.e. an app-internal token
printed as if it were a lookup-able carrier error number, which is the exact
defect `INTERNAL_CODE_REASONS` was created to fix.

**Evidence.** `dashboard/src/routes/contact/deliveryStatus.ts:709-733`
(`deliveryReason`, `INTERNAL_CODE_REASONS` consulted first, else
`` `Delivery failed (error ${errorCode})` ``); the map itself holds only
`contact_opted_out`, `transient_cap`, `enqueue_failed` (roughly `:683-687`), with
a docblock explaining why internal codes deliberately get no `(error N)` tail.

**What it implies.** Minor because finding 3 means these never render anyway -
but if finding 3 is fixed, this becomes live. Enumerate the new codes and their
copy.

---

## 20. [LOW] The retry row's own message-level `delivery_status` is never advanced

**What is wrong.** The relay branch writes SLOTS only - it never calls
`updateDeliveryStatus`. So a retry row appended `queued` stays `queued` at the
message level for ever, while its single slot runs to `delivered`.

**Evidence.** `app/src/routes/webhooks/twilio.ts:2466-2472` (slot update only;
the message-level `updateDeliveryStatus` is on the generic path at `:2612`).
`dashboard/src/routes/contact/Timeline.tsx:871-873` renders a message-level chip
for every outbound bubble from `msg.delivery_status`.

**What it implies.** An outbound retry bubble carries a stuck message-level chip
beside its `delivered 1/1 on retry` rollup. This is arguably pre-existing for
relay team sends (which also never advance their message-level status), so it is
LOW - but the retry bubble is a NEW bubble, D15 specifies its copy exactly, and
the spec does not say what the message-level chip on it reads.

---

## 21. [LOW] The digest width is unspecified

**What is wrong.** D2: "`relayretry-<digest>-<n>`, where `<digest>` is a short hex
digest of the root `tsMsgId` and the destination E164". "Short" is not a
specification, and the digest is load-bearing: it is the entire claim identity.

**Evidence.** Spec Sec 3 D2.

**What it implies.** A collision between two ladders does not error - it dedupes,
so the second ladder's retry is silently never sent and is reported as
claim-lost. Fix the width (and the hash) in the spec so the plan cannot pick
something like 6 hex chars.

---

## 22. [LOW] Several citations are stale or point at the wrong line

**What is wrong.** Most citations check out (I verified twilio.ts:2457, 2711;
relayFanOut.ts:757, 771-779, 992-998, 1019, 1060, 1118-1269, 1160-1167, 1168;
messagesRepo.ts:196-198, 204-209, 2220, 3543-3565; relayAnnouncements.ts:169-171,
228, 239, 248; api.ts:1803; contactTimeline.ts:406-464 and :1232;
useContactTimeline.ts:191-196; useRelayThread.ts:69-135; Timeline.tsx:937 and
:1788-1800; deliveryStatus.ts:351; threadPaging.ts:30;
fake-twilio/src/engine/engine.ts:500-501). These do not:

- Sec 1: `TRANSIENT_RETRYING_DELIVERY_CODES` at `twilio.ts:286`. Actual: `:301`
  (`isTerminalDeliveryFailure` at `:310`). The stale number is inherited verbatim
  from `docs/issues/relay-30003-classified-transient-retrying.md` frontmatter and
  body, which predate the 2026-09-02 merge; the spec did not re-verify it.
- Sec 1: `:2590` for "a path that requires a persisted message row". `:2590` is
  `mergeContext(...)`; the gate is `:2574-2589`.
- D5: "imported by `jobs/tourReminders.ts:1646`". `:1646` is a CALL site; the
  import is `tourReminders.ts:69`.
- D11: `retrySend.ts:148`. `:148` closes the jobId guard; the presign block is
  roughly `:149-176`.

**What it implies.** Individually trivial. Collectively they say the spec's
citation set was not re-walked after the 2026-09-02 merge, which is exactly the
thing the base-commit line at the top of the spec asserts it was.

---

## 23. [LOW] D3 says `To` "is discarded today"; the line it cites shows the opposite

**What is wrong.** D3: "`params['To']` is in scope at the relay branch
(`twilio.ts:2457`), is the member's own handset for this send path
(`relayFanOut.ts:1168` through `adapters/messaging.ts:677`), and is discarded
today."

**Evidence.** `app/src/routes/webhooks/twilio.ts:2457` is
`...(params['To'] !== undefined && { to: params['To'] }),` inside the
`normalizeTransportEvidence({...})` call at `:2452-2465`. It is consumed, not
discarded. (The two supporting claims ARE correct: `relayFanOut.ts:1169` sets
`to: member.phone`; the adapter reference at `adapters/messaging.ts:677` is
UNVERIFIED - I did not open it.)

**What it implies.** The intended claim ("`To` is not used for lineage today") is
true and adequate. As written the sentence is contradicted by its own citation,
which is the kind of thing that makes a reviewer distrust the surrounding
citations.

---

## Guarantees tested against their mechanism - summary

| Spec guarantee | Verdict |
|---|---|
| A duplicate callback cannot produce a duplicate send | HOLDS for callbacks (the `sid#` pointer at `messagesRepo.ts:2227-2233` loses the create). FAILS for a duplicate QUEUE delivery - finding 1. |
| A late callback cannot regress a delivered retry | HOLDS. Each attempt owns its own row and slot; an older attempt's SID resolves to its own `relaysid#` pointer, so `ALLOWED_PRIOR` (`messagesRepo.ts:129-138`) is never asked to un-fail the delivered leg. |
| Announcements and tour-reminder rungs cannot be reached | FAILS OPEN on a missing source row - finding 4. |
| No nested-map seeding arises anywhere | HOLDS, conditional on the retry row's `append` seeding its single-entry map (D1). Every later write is a child-only SET onto an existing parent (`relayFanOut.ts:1428-1463`). |
| The display can never promise a retry indefinitely | HOLDS only if D18 is implemented, which finding 5 shows requires an unscoped edit to a fenced-off shared helper. And the display holds the OPPOSITE falsehood (`1 failed`) for at least one backoff interval - finding 11. |
