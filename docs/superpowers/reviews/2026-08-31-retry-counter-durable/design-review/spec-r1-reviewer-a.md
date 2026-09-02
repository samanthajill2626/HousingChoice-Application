# Spec R1 - adversarial design review (reviewer A)

Spec under review: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md`
Repo state: worktree `W:\tmp\retry-counter-durable`, `831901c5` (spec commit) on top of `main@5ce9912f`.
Every claim about current behavior below cites a file:line I read in this tree.

Summary: the invariant in Sec 1 is right and the issue it comes from is real. The
MECHANISM in Sec 3-5 does not deliver it. The durable counter is erased by writers
the spec never enumerates, the "delivered wins" guarantee is refused by a state
machine the spec claims as an ally, one of the three named anchor defects already
ships fixed, and two of the spec's own acceptance tests cannot be written against
the seams that exist.

---

## 1. [BLOCKING] The durable `attempt` is erased on every pass by the existing whole-slot writers

**What is wrong.** Sec 3.1 puts `attempt` inside the per-recipient slot on both
repos. Both repos' slot writers REPLACE the entire slot, and both fan-outs call
them with a freshly built object that carries no prior fields. So the counter is
wiped before the next claim reads it, and it can never leave 1.

**Evidence.**

- `app/src/repos/broadcastsRepo.ts:615` - `UpdateExpression: 'SET recipients.#ck = :rec'`.
  Whole-slot replace, not a merge.
- `app/src/repos/messagesRepo.ts:2781` - `UpdateExpression: 'SET delivery_recipients.#mk = :d'`.
  Same shape. The file's own comment at `messagesRepo.ts:2814-2819` documents that
  this exact whole-slot form once silently discarded a concurrent `sid` write - the
  spec-15.2b lesson - and that only `updateRecipientDeliveryStatus` was converted to
  child-field writes. `setRecipientDelivery` was NOT.
- `app/src/jobs/broadcastFanOut.ts:451` writes `{ status: 'queued', errorCode: code }`
  on the transient-defer branch, via `recordRecipient` -> `setRecipient`
  (`broadcastFanOut.ts:535-542`). No spread of the prior slot. This runs for every
  deferred recipient on EVERY pass, immediately before the continuation block where
  Sec 3.3 wants the claim.
- `app/src/jobs/relayFanOut.ts:527` (`{ status: 'queued', errorCode: code }`) and
  `relayFanOut.ts:544` (`{ status, sid, sentAt }`) via `markRecipient`
  (`relayFanOut.ts:701-714`). Same erasure, and `:544` would also erase the Sec 4.2
  `attempts` lineage on a successful retry - the exact record the lineage exists to
  keep.
- The webhook rollup is a read-modify-write of the whole slot:
  `app/src/routes/webhooks/twilio.ts:2831-2836` (`{ ...slot, carrierSentAt }`) and
  `twilio.ts:2856-2865` (`{ ...slot, status: next }`). Read at `twilio.ts:2787`,
  written seconds later - a lost-update window against the atomic `ADD` in Sec 3.2.
  `broadcasts.setRecipient`'s `allowedPriorStatuses` guard conditions on `status`
  only, so it does NOT fence a concurrent `attempt` increment.
- `app/src/services/relayAnnouncements.ts:333` is a third caller of
  `setRecipientDelivery` the spec never names.

**Implies.** The feature is a no-op as specified: a dead queue still freezes the
count, because the count is deleted between claims. Sec 7 test 4 ("counter survives
a frozen envelope") fails on the shipped design, not just on `main`. Fixing this
means either converting both writers to child-field SETs (a change to two shared
repo primitives with five call sites, not "attempt claim on the recipient slot"),
or moving `attempt` out of the slot entirely. Neither is in Sec 2's scope list.

---

## 2. [BLOCKING] The forward-only machine cannot produce "a delivered attempt wins" - and the source issue says so

**What is wrong.** Sec 4.7 asserts two things that cannot both hold: (a) once any
attempt reaches `delivered` the effective status is `delivered`, and (b) "the
existing forward-only machine (`updateRecipientDeliveryStatus`) continues to guard
the effective status." The machine refuses that transition.

**Evidence.**

- `app/src/repos/messagesRepo.ts:120-129` - `ALLOWED_PRIOR`:
  `delivered: ['queued','sent']`, `sent: ['queued','queued_pending']`. `undelivered`
  is a predecessor of NOTHING.
- `app/src/repos/messagesRepo.ts:2805-2812` - a transition whose current status is
  not in `allowed` returns `false` and logs "transition skipped (would regress)".
- `app/src/routes/webhooks/twilio.ts:2360-2366` - the relay pointer branch calls
  `updateRecipientDeliveryStatus(..., mapped, ErrorCode)` UNCONDITIONALLY, before any
  retry decision. A 30003 maps to `undelivered`, so the effective slot is already
  terminal by the time Sec 4.7's rules would apply.
- The issue this spec is built from says it outright:
  `docs/issues/relay-30003-retry-lineage.md` - "The slot becomes `undelivered`; the
  forward-only delivery state machine then prevents that same slot from advancing to
  `delivered`." The spec has inverted the issue's diagnosis into a guarantee.

**Implies.** Attempt 2's `sent` write is refused, its `delivered` write is refused,
and the recipient row is permanently `Undelivered` no matter how the retry goes.
Sec 7 test 8 and E2E test 11 ("delivered-on-retry") are both unwritable. The spec
must decide and STATE what the effective status is while a retry is pending
(a `retrying` state? withholding the terminal write until the chain is exhausted?
adding `undelivered -> sent|delivered` to `ALLOWED_PRIOR` and accepting that
non-monotonicity?) and put `ALLOWED_PRIOR` in scope. Note that non-monotonic slots
also invalidate the documented safety argument of
`app/src/services/groupDelivery.ts:94-97` ("MONOTONIC BY CONSTRUCTION, which is what
makes it safe against the forward-only writer"), which the native group-text product
depends on and Sec 2 fences as must-not-change.

---

## 3. [BLOCKING] "broadcastFanOut's missing finalize()" already ships - the spec proposes a regression

**What is wrong.** Sec 3.5's table says the broadcast close must "call `finalize()` -
today the continuation returns without finalizing", and the section closes with
"`broadcastFanOut`'s missing `finalize()` is the single most user-visible defect in
the bundle and is a required part of the fix, not a side effect." The cap branch
already calls it.

**Evidence.**

- `app/src/jobs/broadcastFanOut.ts:480-494` - `if (nextAttempt > MAX_BROADCAST_ATTEMPTS)`
  marks the remaining recipients `transient_cap`, bumps stats, emits progress, and
  at `:493` calls `await finalize(...)` before returning.
- `git log -L 490,495:app/src/jobs/broadcastFanOut.ts` - that call has been present
  since `47791fe2` (2026-07-03); the only change since was threading `audit` into it.
- The path that returns unfinalized is `broadcastFanOut.ts:508-509`, the
  enqueue-SUCCESS return, and that is CORRECT: a continuation is genuinely pending.
  `docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md` describes it
  accurately; the spec has restated it as a defect in the cap branch.

**Implies.** A builder following Sec 3.5 literally adds a second `finalize()` to a
branch that already has one - a double `markSent`/`markFailed` plus a duplicate
`broadcast.updated` SSE - or restructures the continuation so it finalizes while a
retry is still in flight, terminating a broadcast that is still sending. The only
genuinely new close is the one in Sec 3.3's `catch`. Sec 3.5 needs to say that and
stop asserting a defect that does not exist.

---

## 4. [BLOCKING] One counter, two independent retry budgets - relay recipients silently lose their 30003 retries

**What is wrong.** Sec 3.1 puts the fan-out's durable count on
`delivery_recipients.<memberKey>.attempt`. Sec 4.2 puts the 30003 retry chain's
count on the SAME field of the SAME slot, and Sec 4.6 gives it cap 3. The fan-out
continuation cap is also 3. These are two unrelated budgets sharing one number.

**Evidence.**

- Spec Sec 3.1 (`messages.delivery_recipients.<memberKey> = { ..., attempt?: number }`)
  and Sec 4.2 (`attempt: number, // durable claim counter (Sec 3)`) - the same field.
- `app/src/jobs/relayFanOut.ts:58` - `MAX_FANOUT_ATTEMPTS = 3`.
- `app/src/jobs/retrySend.ts:37` - `MAX_SEND_RETRY_ATTEMPTS = 3`, which Sec 4.6
  adopts verbatim for relay.
- Sec 3.1's defence ("per-recipient counts stay in lockstep with the batch counts
  they replace") reasons only about the fan-out continuation. It is silent about the
  second consumer the same spec introduces.

**Implies.** A recipient who burned two transient fan-out attempts (429/30022, a
routine carrier hiccup) arrives at its first 30003 with `attempt = 2` and gets ONE
retry instead of three. One who burned three gets zero: the first claim returns
`capped` and the chain closes terminal-undelivered without ever sending. The user-
visible retry depth becomes a function of unrelated earlier rate-limiting. Sec 4.6's
quiet-hours argument also silently assumes three retries. The spec must either give
the 30003 chain its own counter or state and justify the shared budget.

---

## 5. [BLOCKING] Sec 4.5 "changed destination - refuse" has nothing to compare against

**What is wrong.** The rule is "If the member's phone differs from the phone the
failed attempt was sent to, the retry is refused." Nothing durable records the phone
a failed attempt was sent to.

**Evidence.**

- `app/src/repos/messagesRepo.ts:142-149` - `RelayRecipientDelivery` is
  `{ status, sid?, errorCode?, sentAt?, deliveredAt? }`. No destination.
- `app/src/repos/messagesRepo.ts:2889-2926` - the relaysid pointer stores only
  `ref_conversationId`, `ref_tsMsgId`, `ref_member_key`; `getRelaySidPointer` returns
  `{ conversationId, tsMsgId, memberKey }`. No destination.
- Spec Sec 4.2's `attempts[]` entries carry `n, sid, status, errorCode, sentAt,
  resolvedAt, deliveredAt` - no `to` either.
- `app/src/repos/messagesRepo.ts:157-161` - `relayMemberKey` returns `contactId` when
  present. For a contact-keyed member the key is STABLE across a phone change, so the
  key itself carries no evidence. (For a phone-keyed member the key changes, which
  orphans the old slot entirely - a different unhandled case.)

**Implies.** The rule the spec calls a hard refusal is unimplementable as written; a
build will either silently drop it or invent an undesigned field. Add `to` to the
per-attempt record and say so, or drop the rule and say why.

---

## 6. [BLOCKING] Sec 4.8's atomic-ADD mechanism does not prevent the duplicate text it promises

**What is wrong.** Row 3 of the idempotency matrix: "two concurrent 30003 callbacks
for the same recipient | atomic `ADD` lets exactly one claim attempt N". True and
irrelevant. The other caller claims N+1, which is also under cap, and also enqueues.
Two retries, two provider sends, two texts to a human.

**Evidence.**

- Sec 3.3's shape enqueues on ANY `claimed` outcome. Nothing in Sec 4 gates the relay
  30003 branch on a forward-only transition.
- The 1:1 path is protected by exactly such a gate:
  `app/src/routes/webhooks/twilio.ts:2546` - `if (transitioned && ErrorCode)`, where
  `transitioned` came from the forward-only `updateDeliveryStatus` at `twilio.ts:2471`.
  A redelivered callback is `false` and never reaches `enqueueSendRetry`. The comment
  at `twilio.ts:2467-2469` says this is deliberate.
- The relay branch does compute an equivalent: `transitioned` at
  `twilio.ts:2360`, but it is used only for the SSE emit and placement escalation
  (`twilio.ts:2389-2403`).
- The job execution marker is no help: it is keyed on the envelope `jobId`
  (`app/src/jobs/retrySend.ts:129-138`), and two claims produce two DIFFERENT
  envelopes.

**Implies.** As specified, a duplicated or raced 30003 callback double-texts a relay
member - the outcome row 1 of the same matrix forbids. The spec must state that the
relay retry decision is gated on the `transitioned` result of
`updateRecipientDeliveryStatus`, and Sec 4.8 must stop attributing that protection
to the `ADD`.

---

## 7. [BLOCKING] `retrySend.ts` is named in scope with no defined change, and Sec 1's claim about it is false

**What is wrong.** Sec 2 lists "`app/src/jobs/retrySend.ts` - the 1:1 chain,
claim-before-enqueue." That file contains no retry enqueue, and the 1:1 counter is
already durable.

**Evidence.**

- `app/src/jobs/retrySend.ts:103-239` - the handler sends and annotates. It never
  enqueues a successor.
- `app/src/jobs/retrySend.ts:73-77` - `enqueueSendRetry` is the producer, called from
  `app/src/routes/webhooks/twilio.ts:2567` in the APP process.
- `app/src/jobs/retrySend.ts:226-229` - the chain depth is stamped DURABLY on the new
  message row (`retryAttempt`), and `app/src/routes/webhooks/twilio.ts:2556` reads it
  back (`message.retry_attempt ?? 0`) for the cap. The envelope `attempt` is a copy of
  a persisted value, not the counter.
- So Sec 1's "The loop advances its attempt counter by writing `attempt + 1` into the
  envelope it enqueues" is FALSE for this site. The real 1:1 exposure is narrower and
  different: the counter advances only when a send SUCCEEDS and a new row is written,
  and `enqueueSendRetry` throwing leaves no close at all. The source issue rates it
  "exposure is lower" for exactly this reason.
- Neither repo primitive in Sec 2 (`claimRecipientAttempt` on the relay slot / the
  broadcast recipient slot) applies to a 1:1 message, which has no recipient slot.

**Implies.** A builder has no defined work item here and will either invent a third
claim surface or change nothing. State the 1:1 change explicitly (most likely: wrap
`enqueueSendRetry` at `twilio.ts:2567` in a try/catch that logs the chain terminal -
the `a755c6f8` stop-gap the issue names) and correct Sec 1.

---

## 8. [HIGH] The context-aware 30003 copy has neither the wire data nor a per-leg render site

**What is wrong.** Sec 8 says the 30003 reason becomes context-aware - "the retry
promise appears only when a retry was actually claimed and is pending" - and fences
every other dashboard change out. Both halves of what that needs are outside the
fence.

**Evidence.**

- No retry state reaches the dashboard. `dashboard/src/api/types.ts:1614-1618`
  (`RelayRecipientDelivery` = `status, sid?, errorCode?, sentAt?, ...`),
  `types.ts:2141-2145` and `types.ts:2321-2353` (timeline row: `delivery_status`,
  `error_code`, `retry_of`, `delivery_recipients`). Nothing carries `attempt`,
  `attempts`, or `retry_attempt`. Adding it means touching the app's serializers
  (`app/src/routes/contactTimeline.ts`, `app/src/routes/api.ts`) and the hand-mirrored
  dashboard types - neither named in Sec 2.
- The per-recipient ROW never renders a reason at all.
  `dashboard/src/routes/contact/deliveryStatus.ts:500-536` - `presentLegDelivery`
  returns `presentDeliveryStatus(slot.status)`, whose `STATUS_PRESENTATION` entries
  (`deliveryStatus.ts:29-47`) have no `reason` field. Rendered at
  `dashboard/src/routes/contact/Timeline.tsx:578` and `Timeline.tsx:1031`.
- "Phone unreachable ... will retry" reaches staff ONLY through the message-level
  rollup: `deliveryStatus.ts:408-432` collects `deliveryReason(s.errorCode, opts)` over
  every failed leg into a de-duplicated `reasons.join('; ')`, rendered at
  `Timeline.tsx:894` / `999-1003`.

**Implies.** Making the copy per-recipient-context-aware forces a change to the
rollup's reason contract: two 30003 legs in different retry states now yield TWO
distinct strings joined with "; " on one chip. That is chip taxonomy, which Sec 2
fences to `T-DELIVERY-CHIPS`. Either the fence or the promise has to move. As
written, the honest minimum this branch can ship is dropping "will retry" from the
static string - which then lies in the other direction on the 1:1 path, where a
retry usually IS claimed.

---

## 9. [HIGH] E2E test 11 cannot be written - there is no seam to shorten the 60s backoff

**What is wrong.** Sec 7's only E2E requires observing "retrying, then
delivered-on-retry". Sec 4.6 fixes the first backoff step at 60s and there is no way
to shorten it for a hermetic lane.

**Evidence.**

- `app/src/jobs/retrySend.ts:40-42` - `retryBackoffMs` is a module-level pure function
  (`60_000 * 2 ** (attempt - 1)`), not a dep and not config-driven.
- `app/src/jobs/retrySend.ts:73-77` - `enqueueSendRetry` computes
  `runAt: Date.now() + retryBackoffMs(...)` inline. No injection point.
- No environment override exists: nothing in `app/src/lib/config.ts` or the e2e
  harness references a retry backoff.
- For contrast, the fan-outs' 5/10/20s steps (`relayFanOut.ts:68-70`,
  `broadcastFanOut.ts:82-84`) are already inside a Playwright budget - which is
  probably why nobody has hit this before.

**Implies.** The e2e either waits >60s (against the 30s-class per-test budgets that
produced `placement-detail-bundle-fetch-stall`) or is quietly dropped, leaving the
one-bubble/one-row acceptance criterion - the thing the whole lineage model exists
for - unproven. The spec must add a backoff seam (a dep or a lane-only env override)
and put it in scope, or replace test 11 with an integration test and say so.

Verified NOT a blocker, for the record: the fake provider CAN drive a one-shot
30003 then a clean delivery. `fake-twilio/src/engine/engine.ts:458-459` consumes and
DELETES the profile (`nextProfile.delete(input.to)`), and
`fake-twilio/src/engine/types.ts:21-27` supports `kind:'fail'` with
`failState:'undelivered'` + `errorCode`.

---

## 10. [HIGH] Sec 4.3's sender-rename guarantee is not delivered by the mechanism it names

**What is wrong.** "`senderNameOverride` rides the payload exactly as it already does
on the fan-out continuation, so a sender rename between the original and the retry
cannot change the relayed text." `senderNameOverride` is only ever set for TEAM
messages. A member-authored relay - the normal case - re-resolves the name from the
live roster.

**Evidence.**

- `app/src/jobs/relayFanOut.ts:104-110` - the field's doc: "explicit sender-prefix
  label for a TEAM message ... Absent on a normal member-relayed message (the prefix
  comes from the sender member's name)."
- `app/src/jobs/relayFanOut.ts:400-405` - `senderMember` is looked up in the CURRENT
  roster at job time and `senderName = payload.senderNameOverride ?? senderMember?.name`.
- `app/src/jobs/relayFanOut.ts:78` + `410-411` - a sender who has since been REMOVED
  from the roster falls to `ANONYMOUS_SENDER_LABEL` ("A member").
- `app/src/jobs/relayFanOut.ts:416` - a media-only source composes via
  `resolveMessage('relay.media_only', { name: senderLabel })`, so the catalog is a
  second drift source.

**Implies.** A retry minutes later can send "Alice: ..." where the original said
"Alice Brown: ...", or "A member: ..." where the original named someone - two
different texts under one logical message and one delivery row, which is precisely
what Sec 4.2 exists to prevent. If the guarantee is wanted, the composed body (or the
resolved label) must be recorded per attempt. Say which.

---

## 11. [MEDIUM] Sec 5.2 and Sec 5.3 contradict each other on a member still unbound after the ladder

**What is wrong.** Sec 5.2's last bullet: "Members still unbound after the ladder are
logged at a level that does not feed the error alarm, with the propagation reason
named" - i.e. not a failure. Sec 5.3's last sentence: "A rail that is still short
after the ladder and after repair is still a failure." Both cannot hold for the
member that Sec 5.2 says was never refused by the create and therefore never enters
repair.

**Evidence.**

- `app/src/services/groupRail.ts:552-560` - the current terminal check: any residual
  `missing` records `rail_failed` and returns `{status:'failed'}`.
- `app/src/services/groupRail.ts:619-625` - `setTwilioConversation` stores
  `participantMap`. Storing a SHORT map makes `hasActiveGroupRail` true while
  `missingFromMap` (`groupRail.ts:264-267`, called at `groupRail.ts:325`) stays
  non-empty, so every later `ensureGroupRail` re-enters the claim path and re-reads
  Twilio - a permanent hot loop rather than a one-off warning.
- Spec 5.1's cited line range is correct: `buildParticipantMap` skipping
  address-less participants is `groupRail.ts:224-231`.

**Implies.** The two readings produce opposite code: one finalizes with a short map
and logs; the other records `rail_failed`. That decides whether the cutover gate sees
a failure and whether compose is enabled. Pick one and say what happens to the stored
map in that case.

---

## 12. [MEDIUM] relayFanOut's existing off-by-one backoff sits inside the edit and the spec does not decide it

**What is wrong.** Sec 3.3 keeps the envelope `attempt` "used for backoff selection"
without saying which value feeds it, on a line that already carries a known bug.

**Evidence.**

- `app/src/jobs/relayFanOut.ts:595` - `{ runAt: ... + fanOutBackoffMs(payload.attempt ?? 1) }`
  uses the CURRENT attempt.
- `app/src/jobs/broadcastFanOut.ts:503-506` - the twin site uses `nextAttempt` and its
  comment says why: "The continuation runs AS nextAttempt, so it waits ITS OWN backoff
  ... Using the current attempt's delay here would under-wait by one step."

**Implies.** The build either silently changes relay backoff (5s -> 10s on the first
continuation) or silently preserves the divergence, and either way nobody can tell
from the diff whether it was intended. Name the intended value.

---

## 13. [MEDIUM] relayFanOut's cap-close writes state and emits nothing

**What is wrong.** Sec 3.5's relay row is "mark remaining recipients
`failed`/`transient_cap`" - which is exactly today's behavior, including its missing
refresh event. Sec 4.7 separately requires "the existing message-refresh event ...
after each effective transition"; a cap-close IS a set of effective transitions.

**Evidence.**

- `app/src/jobs/relayFanOut.ts:571-581` - the cap branch loops `markRecipient(...
  'transient_cap')`, logs, and returns. No `events.emit('message.persisted', ...)`.
  `registerRelayFanOutJobHandler` does not even take an `events` dep
  (`relayFanOut.ts:300-314`).
- The twin does emit: `app/src/jobs/broadcastFanOut.ts:483-487`.
- The receipt path does emit for a per-recipient move:
  `app/src/routes/webhooks/twilio.ts:2392-2397`.

**Implies.** The relay thread's chip stays on "delivered 0/2" until a reload, which is
the same class of stale-UI complaint the broadcast half of this bundle is fixing.
Either state that the relay close deliberately has no emit and why, or add the dep.

---

## 14. [MEDIUM] `attempts` as a LIST defeats the child-field-write argument Sec 4.7 rests on

**What is wrong.** Sec 4.7: "Attempt-scoped writes are child-field writes under
`attempts`, so they cannot clobber a concurrent effective-status transition (the
lesson already encoded in that method's spec-15.2b comment)." The shape in Sec 4.2 is
a JSON array, and DynamoDB cannot address a list element except by index.

**Evidence.**

- Spec Sec 4.2 shows `attempts: [ { n: 1, ... }, { n: 2, ... } ]`.
- `app/src/repos/messagesRepo.ts:2814-2819` - the cited lesson is about child-field
  SETs on a MAP path (`delivery_recipients.#mk.#st`), which are addressable by name.
- `app/src/repos/messagesRepo.ts:2865-2887` (`setRecipientDeliverySid`) shows the
  in-repo pattern for a safe nested write: a named path plus an
  `attribute_not_exists` condition. Neither is available for `attempts[i]` without a
  read to learn `i`, and `list_append` is not idempotent under a redelivered callback.

**Implies.** As drawn, a duplicate callback appends a duplicate attempt record, and a
concurrent write races on the index. The lineage should be a MAP keyed by `n`
(`attempts.#n = :entry`, conditioned on `attribute_not_exists`), which is what makes
the Sec 4.7 argument true. Change the shape or drop the claim.

---

## 15. [MEDIUM] Sec 8 misquotes the string it is changing, and the shipped copy is longer than the quote

**What is wrong.** Sec 8: "`ERROR_CODE_REASONS['30003']` is currently the
unconditional string `'Phone unreachable - will retry'`."

**Evidence.**

- `dashboard/src/routes/contact/deliveryStatus.ts:544` - the literal is
  `'Phone unreachable — will retry'` with an EM DASH, not a hyphen.
- `dashboard/src/routes/contact/deliveryStatus.ts:638-640` - `deliveryReason` wraps
  every mapped reason as `` `${mapped} (error ${errorCode})` ``. What staff actually
  read is "Phone unreachable — will retry (error 30003)".

**Implies.** A search for the spec's string does not find the line. More usefully:
the "(error 30003)" tail is what Sec 8's "the final error code stays exposed"
requirement is already satisfied by, so the change really is only to the mapped half
- worth stating, because a builder who does not know that may add a second code tail.
Any rewritten line must be ASCII per the repo rule, so the em dash goes.

---

## 16. [LOW] Sec 1's "every capped retry loop answers NO" is false, and Sec 1 and Sec 2 disagree on the site count

**Evidence.**

- `app/src/jobs/voiceTranscript.ts:271-276` already models the terminal form
  ("Only 'not-completed' is non-terminal"), as the spec itself says in Sec 6.
- `docs/issues/retry-counter-in-envelope-makes-caps-unreachable.md` names
  `groupRail.ts:101` as the correct in-repo precedent.
- `app/src/jobs/tourReminders.ts` is fenced out by Sec 2, so at least one site
  remains unfixed by this branch either way.
- Sec 1 says "the same shape is still live at three sites"; Sec 2 lists four job
  files (three existing plus one new).

**Implies.** Cosmetic, but Sec 1 is the section a builder reads for the mental model,
and an overstated blast radius is how scope creeps into a bundle with four hard
fences.

---

## 17. [LOW] The new relay job is pointed at a 1:1 module's presign constant

**Evidence.** Sec 4.3 says media is "re-presigned fresh per attempt (never replaying a
stored presigned URL; the `retrySend` rule at `RETRY_PRESIGN_TTL_SECONDS`)".
`app/src/jobs/retrySend.ts:34` is `RETRY_PRESIGN_TTL_SECONDS = 3600`;
`app/src/jobs/relayFanOut.ts:65` is `RELAY_PRESIGN_TTL_SECONDS = 3600`, documented as
the per-leg relay rule. Same value, so nothing breaks; but a relay job importing the
1:1 constant makes the two silently coupled for the next person who changes one.

---

## 18. [LOW] Sec 3.2's `ReturnValues: 'UPDATED_NEW'` does not return the scalar it implies

**Evidence.** The update path is nested (`recipients.<ck>.attempt` /
`delivery_recipients.<mk>.attempt`). DynamoDB's `UPDATED_NEW` returns the enclosing
TOP-LEVEL attribute, i.e. the whole `recipients` / `delivery_recipients` map, not the
incremented number; the claim value has to be dug out and the response scales with
roster size. The nested `ADD` itself is fine and has in-repo precedent -
`app/src/repos/broadcastsRepo.ts:646` (`ADD stats.#sk0 :sv0`) with the note at
`:632-635` that it is safe on a nested numeric attribute.

---

## 19. [LOW] The slot type is shared with the native group-text product and hand-mirrored in the dashboard; neither is named

**Evidence.** `RelayRecipientDelivery` (`app/src/repos/messagesRepo.ts:142-149`) is
also the native group-text slot: written via `app/src/services/groupSend.ts:582` and
`app/src/services/groupReceipts.ts:467`, aggregated by
`app/src/services/groupDelivery.ts:98-120`. It is duplicated by hand at
`dashboard/src/api/types.ts:1614` with an explicit "the dashboard can't import from
app/, so keep it in sync by hand" note. Adding optional `attempt`/`attempts` is inert
for those consumers TODAY, so Sec 10's "no schema migration" holds - but Sec 2's fence
("Native Twilio group-text receipts ... must not change") should name the shared type
so the next reader knows the coupling was considered rather than missed. (Both group
writers use child-field SETs - `updateRecipientDeliveryStatus`,
`setRecipientDeliverySid` - so they do NOT have finding 1's erasure problem.)

---

## Not findings - verified and clean

- Sec 4.1: the relay pointer branch does return before the generic 30003 branch.
  `app/src/routes/webhooks/twilio.ts:2433-2437` vs `:2546-2573`. Sec 9's warning not
  to remove that early return is right.
- Sec 4.6: the 1:1 policy really is 60/120/240 with cap 3.
  `app/src/jobs/retrySend.ts:37`, `:40-42`.
- Sec 5.1: `buildParticipantMap` really does skip address-less participants -
  `app/src/services/groupRail.ts:224-231` - and `createConversationWithParticipants`
  really does already return per-member `failures`, currently read only for the
  business number (`groupRail.ts:456-464`).
- Sec 6: `grep -rn "!== 'success'" app/src` returns zero hits, and
  `app/src/jobs/voiceTranscript.ts:271-276` models the correct terminal form. Both
  claims true.
- Sec 9's ordering trap is real: `putRelaySidPointer` is written after the send
  (`app/src/jobs/relayFanOut.ts:545-549`) and the single-retry lookup window at
  `app/src/routes/webhooks/twilio.ts:2415-2432` is what covers it.
- The 2026-08-13 migration numbers in Sec 5.1 (81 warnings, 178 refusals, 2 false
  `rail_failed`) match `docs/issues/rail-binding-propagation-retry.md` verbatim.
  UNVERIFIED against any log in this tree - taken from the issue.
- `enqueue` genuinely throws on an unconfigured queue (`app/src/jobs/jobs.ts:119-123`),
  which is the prod voicemail mechanism Sec 1 cites. It also throws on
  `MAX_HOP_COUNT = 10` (`jobs.ts:37`, `:167-171`) - not a problem at cap 3, but it
  means Sec 3.3's `catch` will also fire on a runaway-loop guard, which is the right
  outcome and worth a sentence.
