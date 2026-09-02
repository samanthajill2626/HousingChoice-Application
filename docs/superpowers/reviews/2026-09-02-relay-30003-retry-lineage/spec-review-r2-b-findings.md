# Spec review R2-B (adversarial) - relay 30003 retry lineage, revision 2

Spec: `docs/superpowers/specs/2026-09-02-relay-30003-retry-lineage-design.md` (rev 2)
Adjudications read: `spec-r1-adjudications.md`. Reviewer A's R1 findings read.
Tree: `W:\tmp\relay-30003-retry-lineage`, code identical to base `bb54fdaa`.

Everything below was opened and read in this worktree. Findings 1-13 are NEW
material - defects in revision 2's own prose or surfaces all three of us missed.
Section "Contesting the adjudications" answers the three rejected remedies.
Section "Closed" records what revision 2 actually fixed, briefly.

---

## 1. [BLOCKING] An inbound relay source DOES render an accessible-name recital - Sec 2's new fence, and the founder's scope ruling, rest on a false statement

**What is wrong.** Sec 2's new hard fence states: "A member-originated relay
source is inbound (`twilio.ts:641`) and renders no rollup chip and **no
accessible-name recital** (`Timeline.tsx:837`, `:934-940`), so the dominant relay
case shows nothing about who received a message."

The second half is false. There is a THIRD `recipientSummaryName` call site,
built specifically for inbound relay sources.

**Evidence.**

- `dashboard/src/routes/contact/Timeline.tsx:993-1004`:
  `inboundRecipientName = showRecipients && !outbound && rosterKind === 'relay' ? recipientSummaryName(RECIPIENT_LIST_LABEL, recipientRows, rosterKind, messageAtMs, bubbleNowMs, isMms, ...) : undefined`.
  Its own comment at `:990-992` says why it exists: "Inbound Relay sources have no
  outbound delivery chip to own the collapsed recital ... expose the fan-out facts
  through a separate, visually hidden semantic group."
- Rendered at `Timeline.tsx:1068-1070` as
  `<div className={styles.srOnly} role="group" aria-label={inboundRecipientName} />`.
- `recipientSummaryName` recites each row through
  `presentLegDelivery(row.slot, ...)` and
  `deliveryReason(row.slot.errorCode, { media, relay: rosterKind === 'relay' })`
  (`Timeline.tsx:593-597`).
- The per-recipient ROWS also render on an inbound source
  (`Timeline.tsx:948-951`, rendered `:1092-1095`), which Sec 2 does concede.

So on a member-originated relay source, TWO of the three positions M5's D21 binds
together exist today: the per-recipient rows and an accessible-name recital. Only
the visible rollup chip is absent.

**What it implies.** Three consequences, and the first is why this is blocking.

1. The founder's scope ruling ("the visible contract lands only where
   per-recipient delivery is rendered today") was taken on the premise that
   inbound sources render nothing about recipients. They render two of three
   positions, one of which is the ONLY delivery information a screen-reader user
   ever gets from that bubble (the reveal is a div `onClick` with no keyboard
   path - `recipientSummaryName`'s docblock, `Timeline.tsx:566-570`). The ruling
   should be re-taken against the real surface.
2. Under revision 2 as written, a member-originated relay leg whose retry
   DELIVERED continues to recite `Undelivered - Phone unreachable (error 30003)`
   at both positions, for ever - because the original's slot is never rewritten
   (D1) and D20 hides the retry row on inbound sources. That is a reader that
   actively disagrees with the new rule, on the surface with the fewest other
   cues. It is strictly worse than today, where the recital at least matches
   reality.
3. Sec 5's opening ("The rollup chip, its accessible-name recital and the
   per-recipient row move together (M5's D21)") and Sec 2's fence now contradict
   each other: the fence says the recital does not exist where D21 says it must
   move with the chip.

Either the join must reach `inboundRecipientName` and the inbound rows too, or
the fence must say plainly that a known-stale recital is being shipped on the
dominant case and that the filed issue covers it.

---

## 2. [BLOCKING] D18's `unconfirmed` has no clock driver - the display can promise a retry indefinitely again

**What is wrong.** D18 invents a time-derived state ("a rung that has not reached
`sent` within the budget, measured from the RETRY ROW's own `at`") and, correctly,
routes it around `stalenessClockMs`. But `stalenessClockMs` is also the entire
basis of the only mechanism that makes a time-derived state APPEAR without a
refetch. Divorcing from the helper divorces from the clock.

**Evidence.**

- The ticker is armed from the RENDERED set, through the staleness predicates
  only: `Timeline.tsx:1851-1854`
  (`tickerArmed = visible.some(i => i.kind === 'message' && hasTickableLeg(i, tickNow))`),
  and `hasTickableLeg` (`:798-812`) is `canEverGoStale(...) && !isStaleLeg(...)`,
  both of which route through `stalenessClockMs` (`deliveryStatus.ts:206-233`,
  `:329-342`, `:247-255`).
- The ORIGINAL's failed leg is terminal, and `stalenessClockMs` returns undefined
  for `failed`/`undelivered` (`deliveryStatus.ts:219-223`), so it can never arm
  the ticker.
- The RETRY row is hidden by D20, so it is not in `visible` and cannot arm the
  ticker either - even though its `queued` slot is exactly the shape D18 wants to
  age. (And a `queued` slot with no `sentAt` returns undefined from
  `stalenessClockMs` anyway, `:217-218`.)
- The only other clock advance is `useEffect(() => setTickNow(...), [visible])`
  at `Timeline.tsx:1844-1849`, which fires when the RENDERED SET CHANGES - i.e.
  when some other item arrives.

**What it implies.** In the exact scenario D18 exists for - Sec 9's stranded
claim, where the row was created and nothing sent - no SSE arrives, no item
changes, no leg is tickable, and `tickNow` is frozen at mount. `retrying` is
computed once and never recomputed. Sec 9's "The leg renders `unconfirmed` rather
than a permanent `retrying`, so the display stays honest" is not delivered by the
mechanism, and the indefinite promise M5 removed is reintroduced one level down -
which is the exact failure this branch's own issue file (item 5) names.

It is not "never": if some UNRELATED leg on the same thread happens to be
ageing, the ticker runs and the retry state re-derives with it. Depending on an
unrelated coincidence is not a mechanism.

Secondary: D18 says "within the budget" and never names one. `STALE_SENT_AFTER_MS`
is the only budget in the module, and D18 has just declared independence from the
module that owns it.

---

## 3. [BLOCKING] D2 still does not state the seeded slot's shape, and the aggregation-state machine requires `planned` - the first retry send throws

**What is wrong.** Adjudication 2 accepts that "the seeded slot's transport
shape" was unstated and says the decision fixes it. Revision 2's D2 states the
ROW's `direction`, `author`, `relay_sender_key`, `transportSchemaVersion`,
`requestedTransport`, `type` and message-level `delivery_status`. It says nothing
about the single-entry slot D1 requires the row to seed: not its `status`, not
its `requestedTransport`, not its `transportAggregationState`.

**Evidence.** The extracted loop body D10 reuses calls
`setVersionedAggregationState(messages, payload, key, 'attempted', ['attempted'])`
at `relayFanOut.ts:1180` before every send. That routes to
`messagesRepo.ts:3091`, whose `attempted` branch has a HARD prior:

- `messagesRepo.ts:3112-3114`: `writable = '#dr.#mk.#state = :planned'`, with
  `:planned = 'planned'`.
- Full condition at `:3126`:
  `#v = :v AND attribute_exists(#dr.#mk) AND #dr.#mk.#state = :planned`.
- On failure it re-reads and returns `conflict`/`missing`/`legacy_noop`
  (`:3136-3151`), and `setVersionedAggregationState` throws
  `relayFanOut: v1 preflight aggregation failed` unless the current state is in
  `['attempted']` (`relayFanOut.ts:1418-1424`).

So a retry row seeded with `{ status: 'queued' }` and no
`transportAggregationState` throws on its very first send. The fan-out never hits
this because `preflightVersionedRecipients` (`relayFanOut.ts:1326-1339`) seeds
`{ status: 'queued', requestedTransport, transportAggregationState: 'planned' }`
first - and the preflight is OUTSIDE the extracted range D10 names (1118-1269).

**What it implies.** The plan must either seed the slot
`{ status: 'queued', requestedTransport: <intent>, transportAggregationState: 'planned' }`
at append, or run the preflight. Note the interaction with D2's "an inbound row
carries NO `requestedTransport`": that prohibition is on the MESSAGE
(`messagesRepo.ts:913-915` tests `message.requestedTransport`), not on the slot -
`assertTransportPersistenceShape` validates slot transports at `:922-928` without
barring them on an inbound row. So an inbound retry row's SLOT may and must carry
`requestedTransport`. That distinction is exactly the kind a builder gets wrong,
and D2's current sentence reads as if it forbids both.

---

## 4. [HIGH] D8's necessity argument is factually wrong - neither case it names can ever produce a callback

**What is wrong.** D8 justifies the new transition gate: "it is also necessary: it
is what stops a late 30003 callback claiming a retry for a leg the fan-out already
closed for a different cause - a 30007 marked failed synchronously
(`relayFanOut.ts:1209-1216`) or an opted-out leg (`:1127-1130`)." Adjudication 7
records the same reasoning as the basis for changing the decision.

Both cited legs were never sent, so no provider SID exists, so no `relaysid#`
pointer exists, so no callback can ever resolve to those slots.

**Evidence.** `putRelaySidPointer` is called exactly once on the fan-out path -
`relayFanOut.ts:1263-1267`, on the SUCCESS branch, after
`persistRelayRecipientResult` records the send. Every failure arm returns via
`continue` without it: the refusal arm `:1191-1206`, the 30007 arm `:1210-1225`,
the transient arm `:1228-1245`, and the opt-out skip `:1127-1156`. The relay
branch of `/status` is reachable only through `messages.getRelaySidPointer`
(`twilio.ts:2534`, `:2555`).

**What it implies.** The gate may still be worth having - it does close a
contradictory-duplicate case (a leg that sent, received a terminal `failed`/30007
DLR, and then a second 30003 DLR), and it is a cheap second dedup layer beside
D3's create. But the reason recorded in the spec and in the adjudication is not a
reachable scenario, and a later reader who checks it will conclude the gate is
unmotivated and remove it. State the reachable justification or drop the claim.

---

## 5. [HIGH] The transition gate creates a second crash window, and unlike the one Sec 9 records this one is unrecoverable

**What is wrong.** Sec 9 records exactly one hole: "A crash between the claim and
the enqueue strands a retry." D8's new gate creates an earlier one, and makes it
permanent.

**Evidence.** `handleRelayRecipientStatus` writes the slot transition at
`twilio.ts:2466-2472` and the claim must follow it (D8 gates on `transitioned`).
If the process dies between those two, the slot is already `undelivered` and no
retry row exists. Twilio redelivers the callback; `updateRecipientDeliveryStatus`
now finds a slot whose status is `undelivered`, and `ALLOWED_PRIOR`
(`messagesRepo.ts:129-138`) admits `undelivered` only from `queued`/`sent`, so
the update fails its condition and `transitioned` is false
(`messagesRepo.ts:2440-2452` shows the same forward-only pattern for the message
twin; the recipient twin is the analogous conditional update). D8 then refuses to
claim.

Before the gate, that redelivery would have reached the create, won it (no row
exists), and recovered the retry.

**What it implies.** Accepting adjudication 7 traded a RECOVERABLE loss for an
UNRECOVERABLE one, and neither the spec nor the adjudication records the trade.
It is arguably the right trade - the window is small and the display stays honest
(`1 failed`, which is true) - but it belongs in Sec 9 beside its sibling, and the
"a duplicate callback claims nothing" line in D3 now has a second meaning nobody
has stated: a duplicate callback also cannot RECOVER a lost claim.

---

## 6. [HIGH] D19's close-code projection has five independent derivation sites, not one join

**What is wrong.** D19: the close code's copy is "projected onto the ORIGINAL's
presentation through the same join". Singular. The original's failure reason is
derived independently in five places, three of which read `row.slot.errorCode`
directly and one of which decides whether a reason renders at all.

**Evidence.**

1. The rollup chip's `reason`: `deliveryStatus.ts:420-427` builds it from
   `fanned.filter(failed).map(s => deliveryReason(s.errorCode, opts))`, i.e. from
   the ORIGINAL's slots, inside `presentRelayDelivery`.
2. The rollup chip's accessible name: `recipientSummaryName` at
   `Timeline.tsx:959-968`, which recomputes per row at `:593-597`
   (`deliveryReason(row.slot.errorCode, ...)`).
3. The message-level chip's accessible name (branch 0): `recipientSummaryName` at
   `Timeline.tsx:978-989`.
4. The inbound recital: `recipientSummaryName` at `Timeline.tsx:993-1004` (see
   finding 1).
5. The per-recipient row: `Timeline.tsx:1112-1115`,
   `legReason = leg?.isFailure === true ? deliveryReason(row.slot.errorCode, ...) : undefined`.

All of 2-5 take `rows: RecipientRow[]` from `orderRecipientRows(recipientEntries, relayRoster)`
(`Timeline.tsx:520-534`, called `:941`), whose `slot` is the raw original slot.
And the reason renders only when `presentLegDelivery(row.slot, ...)` returns
`isFailure: true` (`deliveryStatus.ts:508-545`) - so a projected code needs BOTH
the code and the failure-ness substituted, and for the `delivered-on-retry` and
`retrying` states the failure-ness must be substituted the other way.

**What it implies.** "Through the same join" understates the work by a factor of
five, and the three positions M5's D21 binds together are computed by three
different functions that share only their INPUT. The clean shape is to project
onto the ENTRIES once - producing an effective `{status, errorCode}` per member
key - and feed that single derived set to `presentRelayDelivery`,
`orderRecipientRows` and every `recipientSummaryName` call, so nothing downstream
reads a raw slot. The spec should say that; as written a build will patch the
rollup and leave the recital and the row saying `Undelivered - Phone unreachable
(error 30003)`, which is D21's exact prohibited outcome.

---

## 7. [HIGH] D20 and D22 contradict: the render predicate needs the original's direction, and D22 says the original may not be loaded

**What is wrong.** D20: "A retry row renders ONLY when its leg delivered AND its
original is outbound." D22: "Thread history pages 50 newest-first
(`threadPaging.ts:30`), so a retry can render before its original has loaded."
The predicate cannot be evaluated in the case D22 describes, and neither default
is safe.

**Evidence.** The retry row's lineage fields (D11) carry the root message ID, the
member key and the attempt number - not the original's `direction`. Nothing else
on the wire supplies it: `useRelayThread.toTimelineMessage` projects a fixed list
(`:69-135`) and there is no per-message lookup. `buildRelayItems` (`:139-151`)
maps every returned row into an item; the only item-level filter in the render
path is `Timeline.tsx:1787-1799`'s `visible` memo, which D20 forbids reusing via
`retry_of`.

**What it implies.**

- Default-RENDER on an unresolvable predicate: an inbound retry row appears as a
  second bubble carrying the same raw body (D12 stores the RAW body) and the same
  `relay_sender_key` and `author` as the member's original (D2), i.e. exactly the
  "duplicate member message" D20 claims its predicate prevents.
- Default-HIDE: a delivered OUTBOUND retry vanishes until the operator pages back
  far enough to load its original, and D19's `delivered 1/1 on retry` bubble -
  half the approved display contract - is missing on first load of a busy thread.

D22 addresses the orphan only for the `on retry` SUFFIX copy, which is a
different problem. The spec must either carry the original's direction onto the
retry row as a fifth stored value, or state the fallback and accept it. It should
also name WHERE the filter lives: the only point all three hosts converge is
Timeline's `visible` memo, and the tour host feeds it a milestone-merged list
(Sec 2 notes this for the sibling set but not for the filter).

---

## 8. [HIGH] Revision 2 DELETED the per-row and recital copy that revision 1 specified, while Sec 5 still asserts three positions move together

**What is wrong.** Revision 1 stated the row/recital grammar explicitly:
"Per-recipient rows and the accessible name recite the same fact in their own
grammar (`Retrying - Phone unreachable (error 30003)`, `Delivered on retry`)."
Revision 2 has no equivalent. D19's table has columns "Retry state | Counted as |
Original bubble | Retry bubble" - chip strings only - while Sec 5's opening still
says "The rollup chip, its accessible-name recital and the per-recipient row move
together (M5's D21)".

**Evidence.** Spec Sec 5 (D19 table) versus the same section's opening sentence.
The row's own copy comes from `presentLegDelivery` + `deliveryReason`
(`Timeline.tsx:1095`, `:1112-1115`) and the recital's from the same pair inside
`recipientSummaryName` (`:593-597`); neither has any input that could express
`retrying` or `on retry` today - `presentDeliveryStatus` is exhaustive over
`DeliveryStatus` (`deliveryStatus.ts:139-141`, `STATUS_PRESENTATION`).

**What it implies.** A build derived from revision 2 satisfies D19's table with
the chip alone and leaves the other two positions unchanged - the D21 violation
finding 6 describes, arriving by a second route. Test intention 12 says "all four
states of D19 at all three positions", but D19 only defines one position, so the
test has nothing to assert at the other two. This is a regression against
revision 1, introduced by the rewrite.

---

## 9. [MEDIUM] D11's "no handset number is among them" is false, and for a contact-less member the digest hides nothing

**What is wrong.** D11: "The three fields that reach the wire are the root id, the
member key and the attempt number; no handset number is among them." The member
key IS a handset number for a contact-less member.

**Evidence.** `relayMemberKey` returns `member.contactId` when present, ELSE
`phone#<E164>` (`messagesRepo.ts:189-193`). Contact-less relay members are the
normal shape in this repo's own fixtures and seeds: the e2e for this very feature
builds two contactless `{phone, name}` participants
(`e2e/tests/dashboard-next/relay-30003-no-retry-promise.spec.ts:110-116`), and
the seeds write `relay_sender_key: \`phone#${GROUP_A_MEMBERS[0]}\``
(`app/src/lib/seed/cast.ts:1424`, `:1445`, `:1478`). `logSafeMemberKey`
(`relayAnnouncements.ts:152-161`) exists precisely because "NOT relayMemberKey() -
its `phone#<E164>` fallback for contact-less members would put a raw phone number
in the log line."

**What it implies.** Two things.

1. D11's stated guarantee is wrong as written and should be corrected, even
   though the exposure is PRE-EXISTING (`delivery_recipients` is keyed by member
   key and is already forwarded to the client at `useRelayThread.ts:125`). I am
   not proposing to fix the pre-existing exposure; I am saying the spec must not
   claim it does not exist.
2. More usefully: for a contact-less member the member key equals
   `phone#<destination>`. So the retry row publishes the destination in the field
   next to the digest, and D5's digest buys nothing on exactly the member shape
   this feature's own e2e uses. The digest is still right for contact-keyed
   members; the spec should say the protection is partial rather than absolute.

---

## 10. [MEDIUM] D23's alarm-volume estimate omits the legs this design fences OUT

**What is wrong.** D23 asks the founder to approve an alarm increase described as
"a terminally undelivered relay leg begins reaching `hc-<env>-error-logs`". Under
"WARN while a retry is actually claimed, and ERROR once the chain is terminal",
every leg for which NO retry is ever claimed is terminal on its first callback -
including every leg D7 deliberately fences out.

**Evidence.** D7 blocks announcements by their `relay_sender_key`, and
`sendRelayAnnouncement` has four call sites (`relayFanOut.ts:852` relay.intro,
`:916` relay.memberAdded, `relayGroups.ts:635` group-closed,
`tourReminders.ts:1646` group reminder rungs). All four write `relaysid#`
pointers through the single append at `relayAnnouncements.ts:229-242` and
`:354-358`, so all four reach the same relay severity site
(`twilio.ts:2500-2511`). Today all of them log WARN, because 30003 is in
`TRANSIENT_RETRYING_DELIVERY_CODES` (`:301`). Revision 1's D22 said the ERROR set
included "no retry was claimed at all"; revision 2's D23 dropped that phrase
without replacing it, so the fenced case is now simply undecided.

**What it implies.** Either every tour-reminder and intro leg that 30003s becomes
an alarm - a volume the founder was not shown, on a mission whose Sec 2 fences
that file out - or the fenced legs keep WARN and the spec must say so, in which
case the "nothing else will surface it" argument does not cover them. Decide it
explicitly; it is the same class of omission as the 21610 carve-out D23 just
fixed.

---

## 11. [MEDIUM] D10 introduces a second backoff ladder in the retry job, and never says who claims the budget or what happens when it caps

**What is wrong.** D10's transient self-continuation is "bounded by the retry
row's own `claimFanoutPass` budget". Both the claim and the cap handling live
outside the range D10 extracts.

**Evidence.**

- The extraction is `relayFanOut.ts:1118-1269`. `claimFanoutPass` is called at
  `:1097-1114`, the cap close at `:1284-1291`, and the re-enqueue at
  `:1292-1310` - all outside it.
- `closeRelay` is a nested closure at `:1060-1089` and D14 already concedes it is
  not reusable.
- The continuation's backoff is `fanOutBackoffMs(claim.attempt)` = 5s then 10s
  (`relayFanOut.ts:91-100`, whose docblock records that pass 3 caps and the 20s
  rung is unreachable). The retry ladder's backoff is 60/120/240 (D6). These are
  different ladders with different budgets in one job.
- Sec 7's injection paragraph names ONE backoff seam ("the backoff is injected
  through the retry job's existing deps object"), for the 60/120/240 ladder. The
  e2e in Sec 7 does not mention the transient path at all, and test intention 9
  asserts the re-enqueue without naming a timing seam.

**What it implies.** Unstated: who calls `claimFanoutPass`, what the job does on
`capped` (`closeRelay(..., 'transient_cap')` is the fan-out's answer and is
unreachable from outside), which backoff the transient re-enqueue uses, and
whether the transient seam is injectable for the e2e. The budget claim itself is
sound - I checked M5's constraint 5 and the retry row is a different message, so
no continuation budget is shared - but "bounded by" is the only thing the spec
says about a second ladder it just created.

---

## 12. [MEDIUM] Sec 2 omits `conversationsRepo.ts`, where D16's status-free bump must be built, and points at the wrong decision

**What is wrong.** Sec 2's In-list says "The conversation bump caller for D13".
D13 in revision 2 is the media-pointer decision; the bump is D16. And the bump
needs more than a caller: there is no status-free bump method to call.

**Evidence.** `touchLastActivity` is the only public bump and it writes
`status = 'open'` unconditionally in its primary branch
(`app/src/repos/conversationsRepo.ts:1531-1560`, `SET #s = :open, last_activity_at = :ts, last_message_preview = :preview`).
Its status-free variant at `:1577-1578` is the CATCH-branch fallback, reached only
when the condition fails (a `group_text` thread or a missing row) - not callable
for an open relay group. So D16's "not through a call that writes `status`"
requires a NEW repo method in `conversationsRepo.ts`, which Sec 2 does not list at
all.

**What it implies.** The In-list is the build's scope contract and the input to
worktree conflict checks. As written it points a builder at "the caller" of a
method that does not exist, in a file that is out of scope.

Note the byLastActivity GSI is `(status, last_activity_at)`
(`conversationsRepo.ts:632`, `:699`), so a status-free bump on an already-closed
group re-sorts it within the `closed` partition. That is the correct behaviour and
worth a sentence, because it is the observable difference from doing nothing.

---

## 13. [LOW] Two smaller items in revision 2's new prose

**(a) A delivered outbound MMS retry renders its attachments twice in the
thread.** D13 suppresses the media-POINTER rows, which is the gallery index
(`messagesRepo.ts:261-279`, `:2286-2290`) - correct, and it closes A13. But the
bubble's own gallery renders `msg.media_attachments` per row
(`Timeline.tsx:1036`, `<AttachmentGallery msg={msg} />`), and D20 renders the
delivered outbound retry as a real bubble. So the same photo appears in two
bubbles in the transcript while appearing once in the gallery. Probably correct -
a retry IS a second send - but it is a visible consequence of D13 + D20 that the
spec does not state, and "adds no rows to the media gallery" (test 10) will pass
while a reviewer looking at the thread sees a duplicate.

**(b) D3's wall-clock rationale is right for a reason it does not give.** D3 says
a wall-clock `providerTs` "keeps it out of the fan-out's five-row source-read
window". The window is `listByConversation(..., { before: bumpKey(sourceTsMsgId), limit: 5 })`
(`relayFanOut.ts:771-774`), and `bumpKey` appends U+FFFF so the bound INCLUDES the
target and excludes everything sorting after it (`relayFanOut.ts:1465-1473`). A
newer row is excluded by the bound regardless of how `providerTs` was chosen, and
the source is always the newest row at or below the bound, so it can never be
pushed out. The real hazard a derived `providerTs` would create is different: at
an identical timestamp, `<ts>#relayretry-...` sorts BELOW `<ts>#team-...` and
`<ts>#system-...` (ASCII `r` < `s`,`t`) and would land inside the window. The
decision is right; the stated reason is not the operative one, and the docblock's
standing assumption ("relay sources are inbound, one at a time") is now weakened
by a design that appends relay-source-shaped rows on a timer.

---

## Contesting the adjudications

**Adjudication 2 (retry row shape - "A2's forced-outbound sub-claim is WRONG").**
CONCEDE the ruling; it is correct and I verified it independently.
`assertTransportPersistenceShape` bars only `message.requestedTransport` on an
inbound row (`messagesRepo.ts:913-915`); schema 1 is not barred (`:907-911` only
requires schema 1 WHEN transport fields are present), and slot transports are
validated but not barred (`:922-937`). Today's inbound relay source is appended
with `transportSchemaVersion: TRANSPORT_SCHEMA_VERSION` (`twilio.ts:644`) and the
fan-out drives it through `applyRecipientSendResult` and
`setRecipientTransportAggregationState` every day. An inbound retry row is viable.
**But the half of finding 2 about the SEEDED SLOT is not closed** - see finding 3
above, which is a hard throw on the first send.

**Adjudication 10 (D18 - rejected my "no per-slot clock" remedy, replaced with a
derived retry state).** I DEFEND the finding and accept that the new mechanism
removes the problem I named. It introduces a different one: severing from
`stalenessClockMs` also severs from the ticker, which is the only clock advance.
See finding 2. The remedy is right in shape; it needs a re-render driver, and the
cheapest honest one is to let the retry state itself arm the ticker (extend
`hasTickableLeg` with a retry-state clause) rather than to re-enter
`stalenessClockMs`.

**Adjudication 11 (close codes - rejected A3's D16 exception, chose projection
onto the original).** I DEFEND my R1 finding and agree the projection is the
better branch: it preserves the founder's one-bubble-on-failure contract, which
A3's exception would have broken. But "through the same join" is not a
specification - see finding 6. Five sites, three of them reading a raw slot, and
the failure-ness has to move in both directions.

**The founder scope ruling recorded above adjudication 1.** I contest the PREMISE,
not the founder's authority: it was taken on "two of those three positions DO NOT
EXIST today" (A2(a)) and my own R1 finding 2, which said the same. Both of us were
wrong about the recital. See finding 1.

---

## Closed since round 1 (verified, not re-argued)

R1-B findings 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 and 21
are addressed in revision 2 by, respectively: Sec 2's three-host list; D3's
sid-pointer attribution; D4's job-execution marker; D11's digest-only destination;
D23's 21610 carve-out; D23's "emitted by whoever observes the terminal state";
D15's enumerated codes; D19's arithmetic and the `RelayDeliveryOptions` scoping;
D12's raw-body split; Sec 1's corrected `sendMessage` refusal; D16's four named
effects; Sec 7's honest "this is configuration, not structural absence"; D10's
transient owner; D8's stated transition gate; D11's four-stored/three-on-wire
reconciliation; D7's positive fence testing the value; and D5's
normalise-or-do-not-claim rule. My R1 findings 1 and 2 are resolved by D2 and by
the founder's scope ruling respectively, subject to findings 1, 3 and 7 above.

Guarantees I re-tested against revision 2's mechanism:

| Guarantee | Verdict |
|---|---|
| A duplicate CALLBACK cannot produce a duplicate send | HOLDS - now doubly: D8's transition gate stops it before the create, and D3's `sid#` pointer (`messagesRepo.ts:2295-2306`) stops it at the create. |
| A duplicate QUEUE DELIVERY cannot produce a duplicate send | HOLDS - D4's marker, plus the extracted body's own terminal-slot skip (`relayFanOut.ts:1120-1121`, `isTerminal` counts `sent` at `:188-190`). |
| A late callback cannot regress a delivered retry | HOLDS - each rung owns its own row and slot; an older attempt's SID resolves to its own `relaysid#` pointer. |
| Announcements and tour-reminder rungs cannot be reached | HOLDS under D7's positive fence. Every relay source that can carry a pointer does carry a `relay_sender_key` (`twilio.ts:646`, `api.ts:1726`/`:1818`, `relayAnnouncements.ts:239`), so the positive test does not over-fence. |
| No nested-map seeding arises | HOLDS, conditional on finding 3 being fixed - the seed must include the aggregation state, not just the map. |
| The display can never promise a retry indefinitely | FAILS - finding 2. |
| The retry's close code is legible to an operator | FAILS as specified - finding 6, and on inbound sources finding 1. |
