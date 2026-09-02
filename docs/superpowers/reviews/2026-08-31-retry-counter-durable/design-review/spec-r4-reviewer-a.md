# Spec R4 - adversarial design review (reviewer A, final round)

Spec under review: `docs/superpowers/specs/2026-08-31-retry-counter-durable-design.md` (post-rescope rewrite).
Repo: `W:\tmp\retry-counter-durable`, read-only. No suites, no Playwright.
Read cold and in full, as a new document.

**The rescope is the right call and the document is much stronger for it.** Section
numbering is clean for the first time, three false "fixes for existing behavior" are
now recorded as corrections in Sec 1, and Sec 3.4's "Known limit, stated rather than
hidden" is the kind of honesty a builder can act on.

**The pattern nonetheless holds, and one round-3 fix inverted itself.** Sec 3.2's
`if_not_exists` seed - written to replace the exception-name detection I flagged in
R3-9 - is the one UpdateExpression shape this repo rejects, documented verbatim in
three places including both files this branch edits. And the rescope broke two things:
the counter's seeding site for relay messages lives inside the file the rescope just
fenced in its entirety, and the rail fix's "inline path UNCHANGED" promise is not
expressible by a service that has no caller identity.

Answering your direct question on Sec 6 last, because the answer is "you read the two
functions you looked at correctly, and there are two more callers you did not."

---

## R4-1. [BLOCKING] Sec 3.2/3.3's `if_not_exists` seed is the one UpdateExpression shape this repo documents as rejected - three times, in both files being edited

**What is wrong.** Sec 3.2: "the seeding write is `SET <field> = if_not_exists(<field>,
:empty)` **performed as part of the same update**, so the parent is created when
missing and untouched when present. **No exception-name detection**, no second round
trip." Sec 3.3 restates it: an `ADD fanout_attempts.#k :one` "combined with the
`if_not_exists` parent seed from Sec 3.2."

That single expression SETs a map (`fanout_attempts`) and ADDs a child of that same
map (`fanout_attempts.#k`). DynamoDB rejects it.

**Evidence - the repo says so three times, in its own words.**

- `app/src/repos/broadcastsRepo.ts:588-591` - "DynamoDB rejects an UpdateExpression
  that SETs both a map and a child of that map in one statement (overlapping document
  paths), so we must NOT also seed the parent here."
- `app/src/repos/messagesRepo.ts:2771-2774` - the identical ruling, in the other file
  this branch edits.
- `app/src/repos/conversationsRepo.ts:2175-2182` - "DynamoDB rejects a single SET that
  both seeds the parent map AND writes a child of it (overlapping document paths - the
  same constraint messagesRepo.setRecipientDelivery documents) … **So: try the
  child-only SET first** … if the map is absent the path SET fails its implicit
  parent-exists precondition, **so we seed the whole (merged) map in a second write.**"

That last one is the repo's actual pattern for exactly this case - a sibling map that
is not pre-seeded - and it is **two writes**. Sec 3.2 cites "the repo's own pattern
for this case" while specifying the inverse of it and explicitly ruling out the second
round trip the pattern requires.

**A second, independent reason it fails even setting the overlap aside.** Every clause
of one UpdateExpression is evaluated against the same pre-image; SET does not "run
first" so that ADD can see its result. So the `ADD` would still address an absent
parent.

**Implies.** The primitive as specified throws on every claim against a pre-branch
item - which is precisely the DLQ loop Sec 3.2 opens by describing, and which test 7
was added to catch. The fix is the two-write form already written at
`conversationsRepo.ts:2189-2214`: put `attribute_exists(fanout_attempts)` in the
claim's `ConditionExpression` so an absent parent surfaces as a modeled
`ConditionalCheckFailedException` (not a name-matched `ValidationException`, so R3-9
stays fixed), and seed the map in a second conditional write before retrying the ADD.
State that it is two round trips on the cold path only.

---

## R4-2. [BLOCKING] "Inline send backstop - UNCHANGED" is not expressible: `ensureGroupRail` has no caller identity, and Sec 4.3's rules are shared code paths

**What is wrong.** Sec 4.2's table promises the inline path is UNCHANGED and calls it
"a hard constraint, not a preference"; test 8 pins it as "byte-identical in behavior
to `main`". Sec 4.3 then changes rules that live on the single shared code path every
caller runs.

**Evidence.**

- `app/src/services/groupRail.ts:118-122` - `GroupRailRequest` is
  `{ conversationId, members }`. No caller identity, no options, no mode.
- All three callers pass that same shape: `app/src/services/groupSend.ts:381` and
  `:425`, `app/src/jobs/groupRail.ts:59`, and
  `app/src/lib/import/convertGroups.ts:598` (`rail.ensureGroupRail(request)`).
- The rules Sec 4.3 changes are single blocks inside one function:
  repair entry at `app/src/services/groupRail.ts:517` (`if (missing.length > 0)`),
  and the `rail_failed` write at `:552-559`.

So only the **ladder** bullet is caller-scopable at all (it is new code). The other
four - "repair only for members the create refused", "`rail_failed` requires a repair
refusal", "50386/50437 are success-pending-re-read", "still-unbound is logged and the
rail proceeds" - all rewrite `:517` and `:552`, and therefore change what the inline
`groupSend` backstop does.

**And making the promise true costs three out-of-scope files.** Threading a mode flag
means editing `GroupRailRequest` (in scope) **plus** `groupSend.ts`, `jobs/groupRail.ts`
and `lib/import/convertGroups.ts` to pass it. Sec 2's in-scope list names only
`app/src/services/groupRail.ts`.

**Implies.** Either Sec 4.2's table is wrong and should say "the inline path inherits
the rule changes but takes no ladder" - which is defensible, since fewer false
`rail_failed` is an improvement there too, and it keeps the claim lifecycle untouched
so R3-3 stays closed - or Sec 2 must admit the three call sites. Test 8's
byte-identical clause has to go either way; as written it pins an outcome the design
cannot produce.

---

## R4-3. [BLOCKING] Sec 6 fixes the rollup chip and leaves the recipient row beneath it saying "will retry" - and the code comments say those two must never disagree

**You asked whether you read `deliveryStatus.ts` wrong. The two functions you cite are
read correctly. There are two more `deliveryReason` callers that never go through
`presentRelayDelivery`.**

**Evidence.**

- Correct as you have it: `deliveryReason` selects `MMS_ERROR_CODE_REASONS` over
  `ERROR_CODE_REASONS` from `opts.media` -
  `dashboard/src/routes/contact/deliveryStatus.ts:635-637`. And
  `presentRelayDelivery` does pass its opts through - `:416`,
  `.map((s) => deliveryReason(s.errorCode, opts))`.
- **But the per-leg row calls it directly.**
  `dashboard/src/routes/contact/Timeline.tsx:1044-1046` -
  `deliveryReason(row.slot.errorCode, { media: isMms })`, rendered per recipient row
  at `:1047-1052`. A fresh options object; nothing from `presentRelayDelivery`
  reaches it.
- **And so does the accessible recital.** `Timeline.tsx:582` -
  `deliveryReason(row.slot.errorCode, { media })`, per row, feeding the spoken summary.
- The other two callers are message-level and correctly unaffected: `Timeline.tsx:849`
  and `:1390` (both `msg.error_code`), plus
  `dashboard/src/routes/broadcasts/DeliveryBadge.tsx:31` (`deliveryReason(errorCode)`,
  no opts) - so Sec 6's table rows for the 1:1 bubble and the broadcast badge are
  right.

**After Sec 6, one relay bubble shows three different answers:**

| surface | source | copy |
|---|---|---|
| rollup chip | `presentRelayDelivery` -> `deliveryStatus.ts:416` | `Phone unreachable (error 30003)` |
| recipient row, directly beneath it | `Timeline.tsx:1044-1046` | `Phone unreachable - will retry (error 30003)` |
| screen-reader recital | `Timeline.tsx:582` | `…will retry…` |

**The codebase has already had this exact bug and wrote the invariant down.**
`Timeline.tsx:1037-1042`: "`{ media: isMms }` is REQUIRED, not decorative. Without it a
30005 on an attachment leg reads 'Number is invalid' beside a named member … so this
NEW surface would contradict the message-level chip directly above it. **One `isMms`
feeds the rollup, this row and the accessible name, so the three cannot disagree.**"
Sec 6 introduces a second such option and feeds it to exactly one of the three.

**Implies.** Sec 6's stated goal - "stop the chip lying" - is not achieved on the
surface an operator reads most directly, and the branch would ship a self-contradicting
bubble. Test 10 ("a relay/group 30003 leg renders `Phone unreachable`") does not name a
surface, so it passes on the rollup while the row is wrong. Fixing it means passing the
new opt at `Timeline.tsx:582` and `:1044-1046` - which Sec 2 fences ("Delivery-chip
rendering beyond the one copy fix - `T-DELIVERY-CHIPS`") and does not list in scope.
Admit those two call sites to scope (it is three lines and the precedent for threading
one option to all three is already in the file), or drop Sec 6 entirely and hand the
whole chip to `T-DELIVERY-CHIPS` - which Sec 2.1 already concedes is where the
retry-aware variant belongs.

---

## R4-4. [BLOCKING] The rescope fenced the file that seeds the relay counter map

**What is wrong.** Sec 3.2: "**Seed at creation** - `fanout_attempts` is seeded as an
empty map wherever its sibling map is seeded today (broadcast `markSending`, message
append, **the relay inbound path**)." The relay inbound path's seeding site is inside
`routes/webhooks/twilio.ts`, which Sec 2 now fences **"in its entirety"** and Sec 8
restates as "Do not touch `twilio.ts`."

**Evidence.** The sibling map is seeded by the CALLER passing `deliveryRecipients` into
`messages.append`, at five sites - and only one is in Sec 2's in-scope list:

- `app/src/routes/webhooks/twilio.ts:598` - `deliveryRecipients: {}`, the relay inbound
  append. **Hard-fenced.** This is the source message for every relay fan-out, i.e. the
  exact item `relayFanOut`'s claim writes to.
- `app/src/routes/api.ts:1710` and `:1768` - team-send seeds. Not in scope.
- `app/src/services/groupSend.ts:595` - native group text. Not in scope.
- `app/src/services/relayAnnouncements.ts:191` - announcements. Not in scope.
- `app/src/repos/broadcastsRepo.ts` `markSending` - the broadcast half. **In scope.**

**Implies.** Following Sec 3.2 literally sends a builder straight into the file the
rescope exists to stay out of. The instruction is also unnecessary: `messagesRepo.append`
(in scope) can seed `fanout_attempts: {}` unconditionally on the item it is already
writing, with no caller changes at all - which is strictly better, because it also
covers the four other seed sites and any future one. Rewrite the bullet to name
`messagesRepo.append` and `broadcastsRepo.markSending` as the two seeding sites, and
delete "the relay inbound path". Note this does not remove the need for R4-1's
tolerate-absent-parent path, which still covers every item written before this branch.

---

## R4-5. [HIGH] Sec 3.5 asserts an equivalence that is false, in the section written to state the number exactly

**What is wrong.** Sec 3.5 says `MAX_FANOUT_ATTEMPTS` / `MAX_BROADCAST_ATTEMPTS` "keep
their current values and their current meaning: the total number of send passes per
recipient is unchanged from `main`", justified by "The claim is taken where the old code
computed `nextAttempt`, so the counter reaches the cap on exactly the pass the old
comparison closed on." Combined with Sec 3.3's condition - "the count is below `cap`" -
that is arithmetically wrong by one.

**Evidence.**

- Today: `app/src/jobs/broadcastFanOut.ts:479-480` -
  `nextAttempt = (payload.attempt ?? 1) + 1; if (nextAttempt > MAX_BROADCAST_ATTEMPTS)`,
  with `MAX_BROADCAST_ATTEMPTS = 3` (`:79`). Pass 1 enqueues 2, pass 2 enqueues 3, pass
  3 computes 4 > 3 and closes. **Three passes.** Same shape at
  `app/src/jobs/relayFanOut.ts:570-571` against `MAX_FANOUT_ATTEMPTS = 3` (`:58`).
- New, with `cap = 3` and "count below cap": claim 0->1 (enqueue pass 2), 1->2 (enqueue
  pass 3), 2->3 (**enqueue pass 4**), then 3 < 3 is false -> capped on pass 4.
  **Four passes.**

To preserve three passes the literal passed to `claimFanoutAttempt` must be
`MAX_* - 1`, i.e. **2**. Sec 3.5 promises the values are kept and never names the
literal - which is what R3-8 asked for and what this section's own opening sentence
says it is providing ("the literal is stated rather than implied").

**Implies.** A builder reading Sec 3.3 and Sec 3.5 together writes `cap = MAX_*` and
ships a fourth provider send per deferred recipient. Test 6 pins the total and would
catch it, so the consequence is a build-and-debug cycle rather than a shipped defect -
but the spec's stated number is wrong, and the whole point of Sec 3.5 is to be the
place the number is right. Write `claimFanoutAttempt(keys, key, MAX_* - 1)` explicitly,
or change Sec 3.3's condition to `count < cap - 1` and say so once.

---

## R4-6. [HIGH] Sec 6's justification for widening to native group text is unproven, and the 30003 arm has no group guard where its siblings do

**What is wrong.** Sec 6's key move - widening from "relay only" to "everything
`presentRelayDelivery` renders" - rests on one factual claim: "**neither gets a
retry**, so both want the same corrected copy". For relay that is verified. For native
group text it is asserted without evidence, and the code points the other way.

**Evidence.**

- The 1:1 30003 arm enqueues a retry unconditionally on any resolved message row:
  `app/src/routes/webhooks/twilio.ts:2553-2572` - reads `message.retry_attempt`, then
  `await enqueueSendRetry({ providerSid, conversationId: message.conversationId, … })`.
  There is **no `group_text` guard**.
- Its sibling arms in the same switch DO guard: `:2633-2641` (30005/30006 -
  "NATIVE GROUP TEXTS ARE REACHABLE HERE … `if (conversation?.type === 'group_text')`
  … `break`") and `:2670-2680` (21610, same shape).
- Those two comments are direct evidence that classic status callbacks for group legs
  reach this switch: "A classic status callback for a group leg in the pre-marker
  window resolves to the GROUP thread".

**Status: the consequence is UNVERIFIED.** I did not trace whether a native group leg
that fails 30003 in the pre-marker window reliably resolves a message row at
`twilio.ts:2408`, and `twilio.ts` is now fenced so nothing here proposes changing it.
What is verified is that the 30003 arm lacks the guard its siblings have, so "no retry
is scheduled for native group-text legs" is not established.

**Implies.** If a group leg can get a retry, Sec 6 removes a true promise from that
surface - the same defect the round-3 revision introduced for 1:1 and this revision
fixed. Either prove the claim (the group-leg 30003 path either resolves no message row
or is unreachable) and cite it, or scope the override to relay legs only. Note that
scoping to relay is now HARDER than it looks, because `presentRelayDelivery` still has
no `rosterKind` parameter (`deliveryStatus.ts:387-391`), while its per-leg sibling
`presentLegDelivery` does (`:500-505`).

---

## R4-7. [HIGH] Sec 9's obligation does not carry the deferred mission's design knowledge, and omits the copy debt this branch creates

You asked whether Sec 9 covers what a reader needs six months out. It does not, in two
specific ways.

**1. The chip copy this branch bakes in is a forward obligation on the deferred
mission, and Sec 9 does not say so.** `relay-30003-retry-lineage`'s own desired
behavior includes "The dashboard shows the recipient as retrying while a new attempt is
pending" and "Keep the shared 30003 copy context-aware: only say `will retry` or
`retrying` when a retry was actually claimed." After Sec 6, the relay override says
`Phone unreachable` unconditionally - so the lineage mission must **undo** it, not
merely extend it. Sec 9's bullet 3 ("the dashboard no longer promises the retry it was
reporting as a lie") reads as a closed item rather than a debt.

**2. Three rounds of lineage design analysis exist only in the review artifacts, and
nothing links them from the issue.** The deferred mission will otherwise re-derive, at
minimum:

- `ALLOWED_PRIOR.delivered = ['queued','sent']` (`app/src/repos/messagesRepo.ts:126`)
  forbids `undelivered -> delivered`, so "a delivered attempt wins" needs a scoped
  transition, not the existing machine;
- **announcement legs carry relaysid pointers** (`app/src/services/relayAnnouncements.ts:289`),
  including **tour-reminder rungs** (`app/src/jobs/tourReminders.ts:1267`), so a
  pointer-keyed retry path reaches into a hard-fenced file and would re-compose an
  app-authored announcement through `composeRelayBody`. `relay_sender_key`'s `system`
  / `team` sentinels are the checkable discriminator;
- per-attempt idempotency cannot be gated on the slot transition (it caps the ladder at
  one retry), and the lineage entry's write-after-send race has no covering retry
  window today.

Each of those cost a full review round to find. Sec 9 should require the issue update to
link `docs/superpowers/reviews/2026-08-31-retry-counter-durable/design-review/` and name
these traps inline, not just record that the mission was split.

---

## R4-8. [MEDIUM] Sec 2.1 overstates what the deferred mission inherits

**What is wrong.** "This branch lands exactly that substrate - a durable,
claim-before-enqueue per-recipient attempt counter with a reachable cap - so the lineage
mission starts from a built foundation instead of building one."

What ships is `fanout_attempts` and `claimFanoutAttempt`: the **fan-out continuation
ladder's** counter, named for it. The lineage mission needs a *second* counter on the
same item, because a design round already established that sharing one is a defect -
the two ladders have different caps (3 passes vs 3 retries) and different backoffs
(5/10/20s vs 60/120/240s), and a continuation would silently consume the retry chain's
budget. It also needs `retry_lineage`, which is not a counter at all.

**Implies.** What genuinely transfers is the seeding pattern, the primitive's shape, the
`ReturnValues` decision, and the whole-slot-writer finding that dictates a sibling map -
which is real and worth stating, but is "a proven pattern and a settled trap", not "the
substrate, built". Rewrite the sentence to say what actually transfers. The distinction
matters because it is the load-bearing justification for calling the split safe.

---

## R4-9. [MEDIUM] E2E test 11 has no injection seam

**What is wrong.** Test 11 requires "a broadcast whose continuation cannot enqueue" with
"the failure … injected, not timed". Nothing in the hermetic stack can make
`jobs.enqueue` throw.

**Evidence.** `app/src/routes/dev.ts` exposes ping, logtail, logtail/clear, reseed, and
a family of `/__dev/<poller>/tick` seams - none of which touches the outbound queue. The
only way `enqueue` throws today is an unconfigured `outboundQueue`
(`app/src/jobs/jobs.ts:119-123`) or the `MAX_HOP_COUNT` guard (`:37`, `:167-171`),
neither controllable per-test. `routes/dev.ts` is not in Sec 2's in-scope list.

**Implies.** Test 11 either needs a new dev seam (a new surface Sec 2 must admit) or
should be demoted to the integration tier, where test 3 already stubs `enqueue` to throw
and asserts the same outcome on the row. Given tests 3 and 4 already cover the anchor
bug end-to-end at the data layer, dropping the E2E and saying why is the cheaper honest
answer.

---

## R4-10. [MEDIUM] Sec 3.3's payload note answers the response-size question and leaves the item-size one open

**What is wrong.** The note reasons about the returned map and concludes it is "well
inside the 400KB item limit that the recipients map already lives within". Response size
and item size are different questions, and it is the second one that has a documented
budget.

**Evidence.** `app/src/repos/broadcastsRepo.ts:54-66` sizes
`MAX_BROADCAST_RECIPIENTS = 1500` deliberately: "1500 slots x ~200B ~= 300KB, leaving
comfortable headroom under 400KB for the rest of the item". `fanout_attempts` re-pays
the contactKey (~40B, and a contactId key is longer) for every deferred recipient - so
roughly 60-90KB against ~100KB of stated headroom.

**And the worst case is exactly the case the claim exists for.** A mass 429/30022 event
defers every recipient, so the map is largest precisely when the counter matters most -
and an item that crosses 400KB fails the claim's `UpdateCommand`, which under Sec 3.4's
throw rule DLQs the broadcast. One sentence either bounding it (only deferred recipients
get an entry; N deferred is bounded by the audience) or reducing the key cost would
close it.

---

## R4-11. [MEDIUM] Sec 4.2 cites the wrong line range for `recordRailFailure`

**Evidence.** Sec 4.2 reason 2 cites "(conversationsRepo.ts:1001-1008)" for the claim
that the `rail_creating` claim is released only by `setTwilioConversation` or
`recordRailFailure`. That range is the **interface docblock for
`setTwilioConversation`** (`app/src/repos/conversationsRepo.ts:999-1010`), not
`recordRailFailure`. The implementations are `recordRailFailure` at `:2436-2441`
(`SET rail_failed = :failed REMOVE #rc`) and `setTwilioConversation` at `:2484`
(`… REMOVE #rc, rail_failed` at `:2513`).

**Implies.** The finding it supports is correct and I verified it independently - this
is a citation error, not a reasoning error. Flagging it because this spec's credibility
now rests on its citations, and a reader who checks the one cited range finds the wrong
method and may discard a constraint that is load-bearing for the whole shape of Sec 4.

---

## R4-12. [LOW] Test 8's "byte-identical in behavior to `main`" is not a testable assertion

Folded into R4-2, noted separately because it is the line a builder will try to write.
Behavioral identity of a shared function across one of three callers cannot be asserted
directly; the testable form is a named list ("the inline path takes no ladder, performs
no delayed re-read, and its claim lifecycle is unchanged"). Say which properties are
being pinned.

---

# Did the rescope break anything else? (systematic sweep)

Checked, and clean:

- **No orphaned lineage dependency.** `retry_attempts`, `retry_lineage`,
  `resolveRetryDelivered`, `relayRetrySend`, the per-attempt gate, the `sentTo` /
  `senderLabel` fields and the pointer `n` are all gone. Sec 3.1's diagram shows only
  `fanout_attempts`, and Sec 3.3's primitive is `claimFanoutAttempt`. Nothing in the
  reduced scope reads any of it.
- **The `isTerminal` change is correctly gone.** Round 3 required `relayFanOut` to treat
  `undelivered` as terminal so a redelivered envelope could not double-send a member
  with a retry in flight (`app/src/jobs/relayFanOut.ts:158-160`). With no retry there is
  no second sender, so leaving it is right - and silence is correct here, since changing
  it would have been a behavior change with no issue asking for it.
- **Section numbering is complete and unique** (1-9, no duplicates) for the first time
  across four rounds.
- **Sec 2's in-scope list correctly dropped `jobs/retrySend.ts`**, matching Sec 1's
  finding that both its halves already ship.
- **Sec 1's citation of `twilio.ts:2727-2731` is not a fence violation** - it is
  evidence for why the file needs no edit, which is the opposite.
- **Sec 5's disposition rule stays region-scoped** and keeps the reasoning that makes it
  correct.
- **Sec 3.7 correctly preserves `relayFanOut`'s backoff off-by-one** rather than
  silently fixing it, and says why.

Verified correct in the new material:

- Sec 4.2 reason 1: `ensureGroupRail` is reached from the send route -
  `app/src/routes/api.ts:1360-1366` calls `groupSend(...)`, which calls
  `rail.ensureGroupRail` at `app/src/services/groupSend.ts:381`.
- Sec 4.2 reason 2's substance (not its citation - see R4-11): the claim is released by
  exactly those two writes and no others.
- Sec 4.3's bulk-create premise: `app/src/adapters/groupConversations.ts:486` returns
  `failures: []` unconditionally, and the all-or-nothing property is documented at
  `:503-506`. Pinning it with test 9 is the right treatment.
- Sec 6's two cited mechanisms, as far as they go: `deliveryStatus.ts:635-637` and
  `:416`. The gap is the two callers outside them (R4-3).
- Sec 3.4's "Known limit" paragraph accurately describes the unknown-error `throw` at
  `app/src/jobs/broadcastFanOut.ts:456-459` and
  `app/src/jobs/relayFanOut.ts:531-535` never reaching the claim. Owning it in the spec
  is the right call.
- Sec 3.3's `ReturnValues: 'UPDATED_NEW'` reasoning ("never re-reads the item to learn
  its own result") is correct and the payload note is a genuine improvement; only the
  item-size half is open (R4-10).
