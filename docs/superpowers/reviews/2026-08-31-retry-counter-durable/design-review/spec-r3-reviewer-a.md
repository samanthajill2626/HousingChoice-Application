# Spec R3 - adversarial design review (reviewer A, continued)

Spec under review: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md` (round-3 revision).
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.

The pattern holds and is now the dominant source of defects: **every one of the
six blocking findings below is in material written for round 3**, and four of them
are in the three rewrites you named as least confident. Your three questions all
answer "no", and I have file:line for each.

Round 2's substance is otherwise closed. The counter home, the cap-semantics
statement, the announcement fence, the atomicity requirement and the region-scoped
disposition rule are all genuinely better. What has happened instead is that each
fix reached for a DynamoDB or rail-service capability without checking it exists.

---

# Part I - your three questions

## Q1: Does the attempt-record gate stay idempotent under a late callback for attempt `n`?

**Yes for that case - and that case is not where it breaks.** Trace it: attempt 1
resolves and claims 2; attempt 2 resolves and claims 3; a duplicate attempt-1
callback arrives, finds `retry_lineage.<mk>.1.resolvedAt` set, fails the condition,
claims nothing. Correct, and the per-`n` keying is genuinely the right shape - it
fixes R2-1 properly. **But the gate has two other holes, R3-2 and R3-5 below, and
both are fatal.**

## Q2: Is the single-write `resolveRetryDelivered` condition expressible as written?

**No.** See R3-1. A `ConditionExpression` is evaluated against the item as it exists
*before* the update, so a condition on the value the same write is setting can never
be true. As written the promotion never fires.

## Q3: Does "send but do not finalize coverage" correspond to anything the rail code can express?

**No.** See R3-3 and R3-4. The distinction is real and worth wanting, but the rail
service has exactly two terminal writes, both of which Sec 5.3 forbids, and the
"needs convergence" marker it posits does not exist in the schema - creating one
means editing a file Sec 2 hard-fences.

---

# Part II - new defects

## R3-1. [BLOCKING] Sec 4.7's single-write condition is unsatisfiable - the promotion can never fire

**What is wrong.** The new atomic form is:

```
UpdateExpression:  SET delivery_recipients.#mk.#st = :delivered, …#da = :now
ConditionExpression: delivery_recipients.#mk.#st IN (:undelivered, :failed)
                     AND retry_lineage.#mk.#n.#st = :delivered
```

The second clause requires attempt `n`'s lineage entry to ALREADY read `delivered`.
Nothing in the spec writes it. The only event that knows attempt `n` delivered is the
very callback performing this update, and a `ConditionExpression` is evaluated against
the pre-update item - so on the one write that matters, the clause is false.

**The dilemma is exhaustive.** Either

- the callback writes the lineage `status: 'delivered'` first and then runs this
  update - which is the two-write shape Sec 4.7 itself forbids three lines later
  ("Split into two writes, a crash between them strands the recipient permanently
  … One atomic write, or the guarantee is a slogan again"); or
- the update also sets the lineage status, in which case the condition cannot read it.

**The fix is available and the repo already shows the shape.** One write that SETs
both paths, with the lineage clause demoted to an EXISTENCE check on the pre-state:

```
SET delivery_recipients.#mk.#st = :delivered, delivery_recipients.#mk.#da = :now,
    retry_lineage.#mk.#n.#st = :delivered, retry_lineage.#mk.#n.#da = :now
ConditionExpression: delivery_recipients.#mk.#st IN (:undelivered, :failed)
                     AND attribute_exists(retry_lineage.#mk.#n)
```

`app/src/repos/messagesRepo.ts:2820-2850` is the in-repo precedent for exactly this
hand-assembled multi-clause child-field SET under one condition. The two top-level
attributes are disjoint, so there is no overlapping-document-path problem.

**Implies.** As specified, `resolveRetryDelivered` is dead code: the guarantee it
exists to deliver ("a delivered attempt wins permanently") reverts to unreachable for
the second time in three rounds, now by a different mechanism. Sec 7 test 8 and test
11f would both fail. **UNVERIFIED**: I did not execute this against DynamoDB Local
(read-only mission); the pre-update evaluation semantics of `ConditionExpression` are
asserted from the AWS contract, not from a run here. The dilemma above holds either
way, because the two-write branch is forbidden by the spec's own text.

---

## R3-2. [BLOCKING] Sec 4.8's `resolveAttemptAndClaimNext` has no cap clause and no outcome clause - it claims past the cap, forever, on any callback

**What is wrong.** The new gate is specified as a single conditional write:

```
resolveAttemptAndClaimNext(conversationId, tsMsgId, memberKey, n, outcome, cap)
  ConditionExpression:
    attribute_exists(retry_lineage.#mk.#n)
    AND attribute_not_exists(retry_lineage.#mk.#n.resolvedAt)
```

Two things the previous primitive had are gone.

1. **No cap guard.** `claimAttempt` (Sec 3.3) conditions on "the count is below
   `cap`". This condition has no clause referencing `retry_attempts` at all, yet
   `cap` is in the signature. So the write always advances the counter, and
   `retry_attempts.<memberKey>` runs to 4, 5, 6… Sec 4.9's "reaching 3 means three
   retries have been claimed and the next callback closes the chain terminally" is
   enforced by nothing. Checking the cap in a second write reintroduces the race the
   atomic `ADD` exists to remove - the very argument Sec 3.3 makes.
2. **No outcome guard.** `outcome` is a parameter of the signature and appears
   nowhere in the condition or the prose, which says flatly "One conditional write
   resolves attempt `n` and advances the counter." Read literally, a **`delivered`**
   callback for attempt `n` resolves it and claims attempt `n+1` - scheduling a
   retry of a message that just arrived. The 1:1 path is explicit about this gate
   (`app/src/routes/webhooks/twilio.ts:2546`, `if (transitioned && ErrorCode)`, then
   `case '30003':` at `:2553`); the relay replacement dropped it and put the
   discriminator in an unexplained parameter.

**Implies.** The method needs three more clauses and a stated return contract - what
it returns when the cap is hit (the `capped` outcome that drives `close()` in
Sec 3.4 has no source here), and when it declines to claim because the outcome was
not a retryable failure. As written, the ladder is uncapped and fires on success.
This is the second consecutive round in which the relay idempotency gate has been
wrong in a way that only a multi-rung test would catch - test 11b was added for
exactly that and would catch the cap half, but nothing tests a delivered callback's
non-claim.

---

## R3-3. [BLOCKING] Sec 5.3 leaks the `rail_creating` claim - only the two writes it forbids release it

**What is wrong.** Sec 5.3 now says the inline backstop must not finalize the map and
must not write `rail_failed`. Those are the only two operations that release the
claim.

**Evidence.**

- `app/src/services/groupRail.ts:364-371` - every non-fast-path `ensureGroupRail`
  takes a claim via `conversations.claimRailCreation`.
- `app/src/repos/conversationsRepo.ts:2513-2515` - `setTwilioConversation`'s
  expression ends `REMOVE #rc, rail_failed`, and its comment says "the claim is
  cleared in the same write so the rail is never 'done' while still marked
  in-flight."
- `app/src/repos/conversationsRepo.ts:2441` - `recordRailFailure` is
  `SET rail_failed = :failed REMOVE #rc`.
- There is no third writer of `rail_creating` other than `claimRailCreation` itself
  (`:2409-2424`).

So the inline path takes a claim and returns without releasing it. It clears only by
expiry: `RAIL_CLAIM_EXPIRY_MS = 5 * 60 * 1000` (`app/src/services/groupRail.ts:198`).

**And the leak blocks the convergence Sec 5.3 relies on.** Sec 5.3's whole
justification is "the job path converges the rail afterwards." For up to five
minutes it cannot:

- `app/src/services/groupRail.ts:372-385` - a caller that loses the claim and finds
  no active rail returns `{status:'failed', reason:'another rail creation is already
  in flight'}`.
- `app/src/jobs/groupRail.ts:60-80` - the job logs `group_rail_job_incomplete` at
  WARN and **returns**. No re-enqueue, no retry, no backoff.
- `app/src/services/groupRail.ts:15-17` - the only re-arm is "ANY group inbound filed
  onto a thread with no active rail (re-)enqueues this seam." If no member replies,
  the rail never converges.

**Implies.** The inline backstop converts a transient binding delay into a thread
that is permanently un-finalized unless a member happens to text in. That is strictly
worse than today, where the inline path finalizes a short map and at least stamps a
sid. If the split is kept, the inline path must release the claim explicitly - which
needs a repo method that does not exist, and see R3-4 for where that method would
have to live.

---

## R3-4. [BLOCKING] "The rail stays marked as needing convergence" has no representation, and creating one edits a Sec 2 hard-fenced file

**What is wrong.** Sec 5.3's third bullet posits a rail state that is neither
finalized nor failed. The schema has no such state, and every write that could
express one is in `conversationsRepo.ts`.

**Evidence.**

- The rail's entire local state is three attributes written from one file:
  `claimRailCreation` (`app/src/repos/conversationsRepo.ts:2409`),
  `recordRailFailure` (`:2436`), `setTwilioConversation` (`:2484`).
- `rail_creating` is a CLAIM with a 5-minute expiry, not a marker - reusing it as one
  is what causes R3-3.
- "Active" is defined solely by the sid: `app/src/services/groupRail.ts:81-85`,
  `hasActiveGroupRail` is `typeof twilio_conversation_sid === 'string' && length > 0`.
  There is no third value.
- **Sec 2's hard fences: "Bundle M1's files: `routes/contacts.ts`, `routes/today.ts`,
  `rosterResolution.ts`, `conversationsRepo.ts`."**

**Implies.** Sec 5.3's distinction - "send this message now" vs "declare this rail's
roster coverage settled" - is a good distinction that this branch is not entitled to
build. Either admit `conversationsRepo.ts` to scope (and coordinate with M1), or
choose one of the two states that already exist. The honest third option, given
Sec 5.2 already rules that a short map on a fresh create is propagation and not
damage, is to finalize normally and accept that receipts for an unbound member fall
back to the thread map - which, per `app/src/services/groupReceipts.ts:254-262`,
they DO once the map converges, because `resolveMemberKey` falls through from the
message snapshot to the conversation's current map. That fallback is the thing that
makes R2-10's hazard survivable, and Sec 5.3 does not mention it.

---

## R3-5. [BLOCKING] The new gate makes the lineage entry a hard precondition, reviving the write-after-send race Sec 9 already names - and conflates it with a duplicate

**What is wrong.** `attribute_exists(retry_lineage.#mk.#n)` is now a precondition for
claiming anything. That entry can only be written after the provider send returns
with a SID - the same window Sec 9 already flags for the pointer.

**Evidence.**

- Sec 9's own watch item: "`putRelaySidPointer` is written AFTER the provider send
  returns, so a fast callback can outrun it … a new attempt's pointer has the same
  race." `app/src/jobs/relayFanOut.ts:544-549` shows the order (send ->
  `markRecipient` -> `putRelaySidPointer`). The lineage entry needs the SID too, so
  it lands in or after that same window.
- The existing mitigation covers the POINTER only:
  `app/src/routes/webhooks/twilio.ts:2415-2432` re-looks-up `getByProviderSid` /
  `getRelaySidPointer` / `getSystemSidMarker` after `statusRetryDelayMs`. Nothing
  re-evaluates a condition on `retry_lineage`.
- `app/src/adapters` fake provider fires the first callback at +150ms
  (`app/src/routes/webhooks/twilio.ts:2422-2424` records this: "fake-twilio fires
  'sent' at +150ms; real Twilio can be just as fast").

**And the two failures are indistinguishable.** A condition failure means either
(a) `resolvedAt` is already set - a duplicate, correctly a no-op - or (b) the entry
does not exist yet - a lost callback that needs a retry or a close. Sec 4.8 gives one
response ("it claims nothing") to both. In case (b) the leg is left `undelivered`
with no retry scheduled and no terminal close: precisely the stuck non-terminal state
this bundle exists to remove, reintroduced by the fix for the fix.

**Implies.** The condition must distinguish the two - `attribute_exists` failing and
`resolvedAt` existing need separate handling, which means the disambiguating
consistent read Sec 3.3 already specifies for `claimAttempt` has to exist here too -
and the lineage entry for attempt `n` must be written BEFORE the provider send (with
the SID patched in after), or the race has to be covered by the same delayed-retry
window the pointer uses.

---

## R3-6. [BLOCKING] Duplicate section number recurs, and the stale idempotency matrix re-asserts the gate Sec 4.8 just disproved

**What is wrong.** Two defects in the same place, both from the round-3 edit.

1. **Two sections numbered 4.9.** Line 519 `### 4.9 Cap semantics, stated exactly`;
   line 536 `### 4.9 Idempotency matrix`. This is the identical defect as R2-3 (the
   duplicated `### 3.4`), one round later, in the section added to close R2-4.
2. **The matrix was not updated when Sec 4.8 was rewritten.** Line 540, row 1:
   "duplicate Twilio callback … | **the slot does not transition, so Sec 4.8's gate
   claims nothing**". That IS the slot-transition gate, which Sec 4.8 (lines 485-500)
   spends fifteen lines proving caps the ladder at one retry. The matrix now cites
   Sec 4.8 for the mechanism Sec 4.8 rejects.
3. **The test inherits the stale mechanism.** Sec 7 test 5, line 707-709: "a
   duplicate callback **transitions nothing and so claims nothing** (Sec 4.8)". A
   builder writes the test against the broken gate, it passes trivially, and test 11b
   (the multi-rung regression added for exactly this) is the only thing standing
   against it.

**Implies.** Renumber, and rewrite matrix row 1 and test 5 in terms of the attempt
record: "a duplicate callback for attempt `n` finds `resolvedAt` set, so the
conditional write fails and nothing is claimed." As it stands the spec describes two
mutually exclusive gates and names both "Sec 4.8".

---

## R3-7. [HIGH] Sec 8's relay scoping cannot be expressed at the call site, and hits native group text - the F12 defect, one product over

**What is wrong.** Sec 8 says the scoping "needs no new wire field - only that the
shared table stop being consulted blindly for the relay case", and calls it "a
one-parameter change inside the one dashboard file Sec 2 allows". The rollup
presenter that produces the string cannot tell relay from native group text.

**Evidence.**

- `dashboard/src/routes/contact/Timeline.tsx:894-897` - the only caller that produces
  a 30003 reason for a multi-party message:
  `presentRelayDelivery(recipientEntries.map(…), { media: isMms, messageAtMs, nowMs: bubbleNowMs })`.
  **`rosterKind` is not passed**, though it is in scope in that component
  (`Timeline.tsx:796` default, used at `:1077` and `:2274` to branch on `group_text`).
- `presentRelayDelivery` serves BOTH products. `Timeline.tsx:854-858`: "The CODE
  alone, matching presentRelayDelivery: relay writes `failed` on a suppressed leg,
  the group-text receipts path writes Twilio's own `undelivered`."
- The sibling per-leg presenter already takes the discriminator -
  `dashboard/src/routes/contact/deliveryStatus.ts:500-505`,
  `presentLegDelivery(slot, rosterKind: LegRosterKind, …)` - which is direct evidence
  that this layer needs it and that `presentRelayDelivery` was deliberately left
  without it.
- Sec 2's fence: "**Native Twilio group-text receipts** … must not change merely
  because the dashboard presenter is shared."

**Implies.** Adding a `relay: true` to the options bag strips "will retry" from
native group-text rollups too - the same fence violation F12 identified for the 1:1
path, committed by F12's own fix. Doing it correctly means threading `rosterKind`
into `presentRelayDelivery`, which changes a presenter with a documented "ONE OPTIONS
BAG, not positional arguments" convention (`deliveryStatus.ts:378-385`) **and** edits
`Timeline.tsx`, which is not in Sec 2's in-scope list. Either admit `Timeline.tsx` to
scope, or accept that the honest minimum inside the current fence is no dashboard
change at all and hand the whole chip to `T-DELIVERY-CHIPS`.

---

## R3-8. [HIGH] R2-4 is only half fixed - the fan-out ladder's cap is still self-contradictory and still unnamed

**What is wrong.** Sec 4.9 states the RETRY ladder numerically and correctly ("at most
3 RETRIES after the original send: 4 provider sends maximum"). The same paragraph then
says of the other ladder: "`MAX_FANOUT_ATTEMPTS = 3` continues to mean what it means
today - the pass count, unchanged." Sec 3.2 says the fan-out ladder is "cap 3". Those
cannot both be satisfied.

**Evidence.**

- Today's semantics: `app/src/jobs/broadcastFanOut.ts:479-480` -
  `nextAttempt = (payload.attempt ?? 1) + 1; if (nextAttempt > 3)`. Three send passes
  per recipient. Same at `app/src/jobs/relayFanOut.ts:570-571`.
- The durable claim counts ENQUEUES. With the condition "count below `cap`" and
  `cap = 3`: claims 0->1, 1->2, 2->3 are three enqueues = **four** passes. To preserve
  three passes the literal must be **2**.
- Neither Sec 3.2 nor Sec 4.9 states the literal passed to `claimAttempt` at the
  fan-out sites, which is exactly what R2-4 asked for and what Sec 4.9's own opening
  sentence says is being fixed ("This is stated numerically because …").

**Implies.** Test 11d ("total provider sends are pinned … the fan-out ladder's count
unchanged from `main`") will fail on a build that reads Sec 3.2's "cap 3" literally,
which is the natural reading. State the literal: `claimAttempt(..., cap = 2)` for both
fan-outs, or redefine the condition as `count < cap - 1` and say so once.

---

## R3-9. [HIGH] Sec 3.5's defensive seed detects `ValidationException` by name, where the repo's own pattern for this exact case avoids the exception entirely

**What is wrong.** "on `ValidationException` it seeds the map with
`attribute_not_exists` and retries the `ADD` once." That is the fragile branch of two
in-repo options, and the repo has already documented why.

**Evidence.**

- `app/src/repos/aiRunsRepo.ts:129-134` - "DynamoDB's ValidationException is **NOT a
  modeled exception class** in [the SDK] … `name` is 'ValidationException'. Same
  detection as suggestionResolutionRepo." So detection is a string compare, not
  `instanceof`. (`app/src/repos/suggestionResolutionRepo.ts:467` is the twin.)
- The repo's established pattern for *this specific situation* - a sibling map that
  is not pre-seeded - does not use the exception at all:
  `app/src/repos/conversationsRepo.ts:2189-2214` puts
  `attribute_exists(relay_opted_out_members)` INTO the condition, so an absent parent
  surfaces as a `ConditionalCheckFailedException` (a modeled class), caught by
  `instanceof`, and the second write seeds the map. `:2218-2226` explains the
  underlying rule.

**Implies.** Two costs. First, a genuine expression bug - a typo'd attribute name, a
reserved word, a malformed value - also throws `ValidationException`, so the
defensive path would seed a map and silently retry a broken write instead of
surfacing it. Second, the spec is prescribing a shape the repo deliberately rejected,
in a file whose neighbours use the other one. Specify the
`attribute_exists(<field>)`-in-the-condition form and the same two-write fallback;
it is strictly safer and it is already written down 200 lines away.

---

## R3-10. [HIGH] Sec 8's table names a surface that never renders the string

**What is wrong.** The new table's third row is "**relay recipient row** →
`Phone unreachable`". The recipient row never shows a reason at all.

**Evidence.**

- `dashboard/src/routes/contact/deliveryStatus.ts:500-536` - `presentLegDelivery`
  returns either one of its two stale presentations, the opted-out label, or
  `presentDeliveryStatus(slot.status)`. Every one of those is a `STATUS_PRESENTATION`
  entry (`:29-47`) with **no `reason` field**.
- The reason renders from the message-level rollup only:
  `dashboard/src/routes/contact/Timeline.tsx:999-1003` renders
  `deliveredSummary.reason`, where `deliveredSummary` is `presentRelayDelivery(...)`
  (`:894`), which builds `reasons` by mapping `deliveryReason` over the failed legs
  and joining with `'; '` (`deliveryStatus.ts:412-419`).
- The per-leg rows are rendered separately at `Timeline.tsx:1031` via
  `presentLegDelivery`.

**Implies.** Test 11g ("only the relay row's copy changes") pins a surface with no
copy to change, and would pass against a build that changed nothing. The scoping also
has to be applied per-leg INSIDE the rollup's `reasons` map, so a relay message with
one 30003 leg and one 30005 leg yields two distinct strings joined by `'; '` - a
composed-output shape the spec should state, since it is the thing an operator
actually reads.

---

## R3-11. [MEDIUM] Two competing claim primitives, and Sec 3.4's handler shape still shows the wrong one

**What is wrong.** Sec 3.3 defines `claimAttempt(keys, key, field, cap)`; Sec 4.8
defines `resolveAttemptAndClaimNext(conversationId, tsMsgId, memberKey, n, outcome,
cap)`. Both claim `retry_attempts`. Sec 3.4's canonical handler shape (lines 173-181)
calls `claimAttempt` and branches on its three outcomes, and Sec 3.7's close table
routes `relayRetrySend` through that shape. Nothing says which primitive the relay
30003 path uses, or how `resolveAttemptAndClaimNext` produces the `capped` outcome
Sec 3.4 needs to run `close()`.

**Implies.** A builder either writes both and picks arbitrarily at the call site, or
writes one and silently drops the other's guarantees. Given R3-2, the answer is
probably that `resolveAttemptAndClaimNext` must return the same three-outcome union
as `claimAttempt` and simply carry two extra condition clauses. Say so.

---

## R3-12. [MEDIUM] The inline backstop re-enters `ensureGroupRail` on every send, taking a fresh claim each time

**What is wrong.** A consequence of R3-3 worth stating separately because it makes
the leak recurrent rather than one-off.

**Evidence.** `app/src/services/groupSend.ts:372-390` - the guard is
`if (!hasActiveGroupRail(conversation) || !railAuthorVerified(...))`, and
`hasActiveGroupRail` reads `twilio_conversation_sid`
(`app/src/services/groupRail.ts:81-85`). Under Sec 5.3 the inline path never stamps
it, so the guard is true on every subsequent send, and each one calls
`ensureGroupRail` again, which claims again (`groupRail.ts:364-371`) and again does
not release.

**Implies.** A busy thread whose bindings are slow holds a rolling claim that never
lets the job path in. The send itself still works - `groupSend.ts:388-390` uses
`ensured.twilioConversationSid` from the return value, not a re-read - so the failure
is invisible from the operator's side and shows up only as a rail that never
converges and a thread that re-runs adopt-by-UniqueName on every message.

---

## R3-13. [MEDIUM] Sec 4.3a's structural fence is stated as a predicate the data cannot answer

**What is wrong.** The fence is right and I raised it, but its enforcement clause is:
"The retry claim runs only when the pointer resolves to a source message that carries
the member's `delivery_recipients` slot **AND the leg was written by the fan-out**."
Nothing distinguishes the two writers.

**Evidence.** Both write the identical pointer shape
(`app/src/repos/messagesRepo.ts:2889-2903`: `ref_conversationId`, `ref_tsMsgId`,
`ref_member_key`) and the identical slot shape via the same
`setRecipientDelivery`: `app/src/jobs/relayFanOut.ts:544-549` for the fan-out,
`app/src/services/relayAnnouncements.ts:284-293` for announcements. The first clause
of the predicate is therefore satisfied by both.

**A discriminator does exist and the spec should name it.** The source message's
`relay_sender_key`: announcements are persisted with the `'system'` sentinel and team
sends with `'team'` (documented at `dashboard/src/api/types.ts:2354-2357`: "a member's
key … the `'team'` sentinel … or the `'system'` sentinel (an app announcement: group
intro / tour reminder rung)"). "Retryable iff `relay_sender_key` is a member key or
`'team'`" is checkable; "written by the fan-out" is not.

**Implies.** Test 11c would be written against a predicate the builder has to invent,
and the natural invention ("the slot exists") admits exactly the tour-reminder legs
the fence exists to exclude.

---

## R3-14. [MEDIUM] A Sec 4.4 refusal burns a rung, so the claim counter and the pinned send count diverge

**What is wrong.** Sec 3.4's shape claims BEFORE the enqueue, and the retry job runs
the Sec 4.4 pre-send gates AFTER it is dequeued. A refusal ends the chain "without
sending", but `retry_attempts` has already advanced and no lineage entry for that
attempt is ever created (there is no SID).

**Implies.** Three small inconsistencies the spec should resolve in one sentence.
`retry_attempts` counts CLAIMS while Sec 4.9 describes it as retries and test 11d
pins provider SENDS - safe (sends are fewer), but the two numbers are not the same
number. And the counter now permanently exceeds the highest lineage key, which is the
precondition R3-5's gate depends on: a later callback for attempt `n` would resolve,
claim `n+1`, and `retry_lineage.<mk>.<n+1>` will never exist. State that a refusal
closes the chain terminally so no further claim is possible.

---

## R3-15. [MEDIUM] The promotion's `:failed` predecessor is unjustified, and a promoted slot keeps a stale `errorCode`

**Evidence.** `resolveRetryDelivered`'s condition accepts `failed` as a predecessor.
On a relay slot, `failed` is written for `contact_opted_out`
(`app/src/jobs/relayFanOut.ts:456-459`), `SendRefusedError` (`:513`), 30007 carrier
filtering (`:520`) and `transient_cap` (`:575`) - none of which has a retry ladder, so
no lineage entry should exist for them. Admitting `failed` is either dead breadth or
an unstated intent. Separately, nothing clears the slot's `errorCode` on promotion, so
a `delivered` leg carries `errorCode: '30003'` forever.

**Implies.** Harmless in today's renderers - `presentRelayDelivery` filters only on
`contact_opted_out` (`deliveryStatus.ts:400`) and counts on `status` - but
`T-DELIVERY-CHIPS` is being handed this record as its input and Sec 10 promises it
"the lineage this branch produces". Say whether the promotion clears `errorCode`, and
drop `:failed` or justify it.

---

## R3-16. [LOW] `ReturnValues: 'UPDATED_NEW'` is reinstated with its cost unstated

**What is wrong.** Sec 3.3 now says the return "is the enclosing counter map and the
claimed value is read from it by key". Correct, and the reasoning about not re-reading
is right. But that means every claim returns the whole map.

**Evidence.** `app/src/repos/broadcastsRepo.ts:54-66` caps a broadcast at
`MAX_BROADCAST_RECIPIENTS = 1500`. A late-continuation claim therefore returns up to
1500 entries to learn one integer.

**Implies.** One sentence accepting the cost, or `ReturnValuesOnConditionCheckFailure`
plus a targeted projection. Not a correctness issue - flagging it because the clause
was reinstated specifically in response to A18 and the payload question it raised was
never answered.

---

# Part III - contesting the round-2 adjudications

You asked whether the region rule and the `ReturnValues` clause close A18/B18 or just
move them.

## B18 - region-scoped disposition. **CLOSED, correctly.**

Sec 6 lines 675-682 now reads "inside **the regions of M5's anchor files this branch
already edits** … By REGION, not by filename … `twilio.ts` is an anchor file but Sec 2
fences all of it except the status-callback branch, so a filename-scoped rule would
authorize edits the fences forbid." That is exactly the fix and it names the failure
mode. No residue.

## A18 - `ReturnValues`. **Half closed.** The clause is restored and the "never re-read
to learn your own result" reasoning is a genuine improvement over both prior
revisions. The payload-size half is unaddressed - see R3-16, downgraded to LOW.

## A17, B17, R2-3, R2-5 - **all correctly closed**, and the round-3 text on each is
better than what I asked for: Sec 4.3 now cites `relayFanOut.ts:65` and `:498`
directly; Sec 5.2 states the all-or-nothing premise explicitly and adds test 11a to
pin it; the duplicated `### 3.4` is gone; Sec 4.3a is a structural fence rather than a
comment (its predicate needs work - R3-13 - but the shape is right).

---

# Verified-correct in this revision

- Sec 4.8's per-attempt keying genuinely fixes R2-1. The late-callback case in your
  Q1 is handled correctly, and the diagnosis of why the 1:1 gate does not transfer
  ("each 1:1 retry creates a NEW message row with its own fresh `delivery_status`;
  the relay slot is reused across attempts") is exactly right - confirmed at
  `app/src/jobs/retrySend.ts:200-229`.
- Sec 3.6's retraction is correct: the switch is wrapped at
  `app/src/routes/webhooks/twilio.ts:2551` and caught at `:2727-2731`, and dropping
  the 1:1 site from code scope is the right call.
- Sec 3.6's correction of the redelivery justification is right and better-reasoned
  than my finding: Twilio does redeliver, and the accurate reason is that the
  redelivery no-ops at the status transition.
- Sec 3.5's diagnosis of the missing-parent problem is correct
  (`app/src/repos/conversationsRepo.ts:2218-2226`); only the detection mechanism is
  wrong (R3-9).
- Sec 4.9's numeric statement of the retry ladder (3 retries, 4 sends) is the right
  form. Only the fan-out half is unresolved (R3-8).
- Test 11b is the correct regression for R2-1 and its rationale ("a test that
  exercises only one retry passes against the broken gate, which is how that defect
  survived a full review round") is the right lesson to have drawn.
- `app/src/services/groupReceipts.ts:254-262` - `resolveMemberKey` falls back from the
  message's frozen snapshot to the conversation's CURRENT participant map. This is
  load-bearing for R2-10/R3-4 and is worth writing into Sec 5: it is what makes a
  short map at send time recoverable, and it is the strongest argument for finalizing
  normally on the inline path rather than inventing a third rail state.
